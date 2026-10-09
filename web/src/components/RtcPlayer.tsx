import React, { useEffect, useRef, useState } from 'react';
import { GlassMeter, RateWindow, grabFromVideo, DEFAULT_TIMECODE, WATCHDOG_MS, WATCHDOG_GRACE_MS } from '../lib/glass';
import { RtcTracer } from '../lib/trace';
import type { PlayerMetrics, TimecodeLayout } from '../types';

interface RtcPlayerProps {
  isStreaming: boolean;
  timecodes?: TimecodeLayout[];
  onMetricsUpdate: (metrics: Partial<PlayerMetrics>) => void;
}

// Señalización WHEP de MediaMTX, a través del punto de entrada. El vídeo va después directo por UDP.
const WHEP_URL = '/rtc/live/whep';

export const RtcPlayer: React.FC<RtcPlayerProps> = ({ isStreaming, timecodes, onMetricsUpdate }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'playing' | 'error'>('idle');
  // Búfer de jitter que se le pide al navegador (RTCRtpReceiver.jitterBufferTarget). 0 = no pedir nada
  // y dejar el comportamiento por defecto del navegador, que lo ajusta solo.
  const [targetMs, setTargetMs] = useState<number>(0);
  const targetRef = useRef(0);
  const receiverRef = useRef<RTCRtpReceiver | null>(null);

  // El medidor vive lo que el componente, no lo que cada intento de reproducción: así los congelados
  // se siguen contando mientras la vigilancia recrea el reproductor.
  const meterRef = useRef<GlassMeter | null>(null);
  const timecodesRef = useRef<TimecodeLayout[]>([DEFAULT_TIMECODE]);
  if (timecodes?.length) timecodesRef.current = timecodes;
  const restartsRef = useRef(0);
  const [attempt, setAttempt] = useState(0);

  const applyTarget = (receiver: RTCRtpReceiver | null, ms: number) => {
    if (receiver && 'jitterBufferTarget' in receiver) (receiver as any).jitterBufferTarget = ms > 0 ? ms : null;
  };

  const handleTargetChange = (ms: number) => {
    setTargetMs(ms);
    targetRef.current = ms;
    applyTarget(receiverRef.current, ms);
  };

  useEffect(() => {
    onMetricsUpdate({ targetLatencyMs: targetMs > 0 ? targetMs : null });
  }, [targetMs]);

  useEffect(() => {
    onMetricsUpdate({ status });
  }, [status]);

  useEffect(() => {
    const glassMeter = new GlassMeter(() => grabFromVideo(videoRef.current), () => timecodesRef.current);
    meterRef.current = glassMeter;
    return () => glassMeter.close();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!isStreaming || !video) {
      setStatus('idle');
      return;
    }

    setStatus('connecting');
    let isAborted = false;
    let retryTimer: any = null;
    const meter = meterRef.current!;
    const rate = new RateWindow();
    const networkRate = new RateWindow();
    const connection = new RTCPeerConnection();
    const transceiver = connection.addTransceiver('video', { direction: 'recvonly' });
    receiverRef.current = transceiver.receiver;
    applyTarget(transceiver.receiver, targetRef.current);

    connection.ontrack = (event) => {
      video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      video.play().catch(() => {});
    };
    connection.onconnectionstatechange = () => {
      if (isAborted) return;
      if (connection.connectionState === 'connected') setStatus('playing');
      if (connection.connectionState === 'failed') setStatus('connecting');
    };

    async function negotiate() {
      try {
        await connection.setLocalDescription(await connection.createOffer());
        // WHEP sin trickle: la oferta se envía con todos los candidatos ya reunidos
        await new Promise<void>((resolve) => {
          if (connection.iceGatheringState === 'complete') return resolve();
          const done = () => connection.iceGatheringState === 'complete' && resolve();
          connection.addEventListener('icegatheringstatechange', done);
          setTimeout(resolve, 2000);
        });
        if (isAborted) return;
        const res = await fetch(WHEP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: connection.localDescription!.sdp,
        });
        if (!res.ok) throw new Error(`WHEP ${res.status}`);
        const answer = await res.text();
        if (isAborted) return;
        await connection.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch (err) {
        if (isAborted) return;
        // Lo habitual justo tras un arranque: MediaMTX aún no tiene la emisión publicada
        console.warn('[WebRTC] negociación fallida, reintentando:', err);
        retryTimer = setTimeout(() => !isAborted && setAttempt((a) => a + 1), 1500);
      }
    }
    negotiate();

    // Vigilancia: si no hay imagen nueva durante WATCHDOG_MS (emisión reiniciada, conexión muerta),
    // se recrea la conexión en vez de esperar a que alguien recargue la pestaña.
    const startedAt = performance.now();
    const watchdog = setInterval(() => {
      const frozen = meter.frozenMs();
      if (frozen !== null && frozen > WATCHDOG_MS && performance.now() - startedAt > WATCHDOG_GRACE_MS) {
        console.warn(`[WebRTC] ${Math.round(frozen / 1000)} s sin imagen nueva: se recrea el reproductor`);
        restartsRef.current++;
        setAttempt((a) => a + 1);
      }
    }, 1000);

    // Seguimiento de frames concretos por las etapas del recorrido
    const tracer = new RtcTracer(video, meter, (stages) => onMetricsUpdate({ stages }));

    // Muestreo de métricas cada 500 ms, de las estadísticas del propio navegador (getStats)
    let lastBuffer = { delay: 0, emitted: 0 };
    const interval = setInterval(async () => {
      if (isAborted || connection.connectionState !== 'connected') return;
      try {
        const report = await connection.getStats();
        let inbound: any = null;
        let transport: any = null;
        report.forEach((entry: any) => {
          if (entry.type === 'inbound-rtp' && entry.kind === 'video') inbound = entry;
          if (entry.type === 'transport') transport = entry;
        });
        if (!inbound || isAborted) return;
        rate.push(inbound.bytesReceived);
        if (transport?.bytesReceived !== undefined) networkRate.push(transport.bytesReceived);

        // Tiempo medio que los frames emitidos desde la última muestra pasaron en el búfer de jitter
        const emitted = inbound.jitterBufferEmittedCount - lastBuffer.emitted;
        const bufferSec = emitted > 0 ? (inbound.jitterBufferDelay - lastBuffer.delay) / emitted : null;
        lastBuffer = { delay: inbound.jitterBufferDelay, emitted: inbound.jitterBufferEmittedCount };

        const glass = meter.snapshot();
        onMetricsUpdate({
          protocol: 'WebRTC',
          latencyMs: glass.latencyMs,
          // WebRTC no declara una latencia respecto al directo: no hay equivalente a la de los otros dos
          reportedLatencyMs: null,
          bitrateKbps: rate.kbps(),
          networkKbps: networkRate.kbps(),
          networkSource: 'transport',
          fps: glass.fps,
          bufferLengthSec: bufferSec === null ? null : Number(bufferSec.toFixed(3)),
          stalls: glass.stalls,
          stallMs: glass.stallMs,
          restarts: restartsRef.current,
          renditionHeight: inbound.frameHeight ?? null,
          renditionKbps: null,
          qualitySwitches: 0,
          bandwidthEstimateKbps: null,
          qualityMode: 'manual',
          packetsLost: inbound.packetsLost ?? null,
        });
      } catch (_) {
        // La conexión se está cerrando
      }
    }, 500);

    return () => {
      isAborted = true;
      clearTimeout(retryTimer);
      clearInterval(interval);
      clearInterval(watchdog);
      tracer.close();
      receiverRef.current = null;
      connection.close();
      video.srcObject = null;
    };
  }, [isStreaming, attempt]);

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800/80 border-b border-slate-700/50">
        <div className="flex items-center space-x-2">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
          <h3 className="font-semibold text-sm text-slate-200">WebRTC (WHEP)</h3>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-amber-900/50 text-amber-300 border border-amber-700/40 font-mono">SRTP / UDP 8189</span>
      </div>

      <div className="relative aspect-video bg-black flex items-center justify-center">
        <video ref={videoRef} className="w-full h-full object-contain" muted autoPlay playsInline />

        {status === 'connecting' && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center space-y-2">
            <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-slate-400">Negociando sesión WebRTC...</span>
          </div>
        )}

        {status === 'idle' && (
          <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center text-slate-500 space-y-1">
            <p className="text-sm font-medium">Stream detenido</p>
            <p className="text-xs text-slate-600">Inicia el pipeline desde el panel de control</p>
          </div>
        )}
      </div>

      {/* Búfer de jitter objetivo */}
      <div
        className="px-4 py-2.5 bg-slate-900 border-t border-slate-800 flex items-center justify-between text-xs"
        title="Búfer de jitter que se pide al navegador (RTCRtpReceiver.jitterBufferTarget). En auto no se pide nada y el navegador lo ajusta solo según la red."
      >
        <div className="flex items-center space-x-2">
          <span className="text-slate-400 font-medium">Búfer objetivo:</span>
          <span className="font-mono text-amber-400 font-semibold">{targetMs === 0 ? 'auto (navegador)' : `${targetMs}ms`}</span>
        </div>
        <div className="flex items-center space-x-3 w-1/2 max-w-xs">
          <span className="text-[10px] text-slate-500 font-mono">auto</span>
          <input
            type="range"
            min={0}
            max={2000}
            step={50}
            value={targetMs}
            onChange={(e) => handleTargetChange(parseInt(e.target.value, 10))}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500"
          />
          <span className="text-[10px] text-slate-500 font-mono">2000ms</span>
        </div>
      </div>

      <div className="px-4 py-2 bg-slate-950/60 border-t border-slate-800/60 text-[11px] text-slate-500 flex justify-between font-mono">
        <span>MediaMTX · {WHEP_URL}</span>
        <span>RTCPeerConnection + &lt;video&gt;</span>
      </div>
    </div>
  );
};
