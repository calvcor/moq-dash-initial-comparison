import React, { useEffect, useRef, useState } from 'react';
import { FullscreenButton, toggleFullscreen } from './FullscreenButton';
import { GlassMeter, RateWindow, grabFromVideo, DEFAULT_TIMECODE, WATCHDOG_MS, WATCHDOG_GRACE_MS } from '../lib/glass';
import { meters } from '../lib/qoe';
import { RtcTracer } from '../lib/trace';
import { serverNowMs } from '../lib/clock';
import type { PlayerMetrics, PlayerPreset, TimecodeLayout } from '../types';

interface RtcPlayerProps {
  isStreaming: boolean;
  withAudio: boolean; // la rama lleva audio (opción rtc_audio del servidor): se pide también la pista de audio
  audible: boolean; // sonido activado (selector de sonido del dashboard)
  streamStartedMs: number; // hora del servidor (ms epoch) a la que arrancó el empaquetador WebRTC (stream_ids.rtc)
  timecodes?: TimecodeLayout[];
  preset?: PlayerPreset; // ajustes de una prueba de campaña (WebRTC no tiene calidades: se ignora quality)
  onMetricsUpdate: (metrics: Partial<PlayerMetrics>) => void;
}

// Señalización WHEP de MediaMTX, a través del punto de entrada. El vídeo va después directo por UDP.
const WHEP_URL = '/rtc/live/whep';

// Tras un reinicio de la emisión no se conecta hasta que esta lleva unos segundos publicada. Una conexión
// abierta en los primeros segundos recibe de golpe el último segundo de media y, con audio, el navegador
// deja el vídeo sincronizado 45-55 ms por encima de lo que queda una conexión abierta más tarde, durante
// toda la sesión (medido el 22-10-2026: README, sección 3.4b). Sin esta espera, aplicar un cambio sin
// recargar la página medía ese caso y recargarla, el otro. El empaquetador tarda 1-2 s en publicar
// (keyframe y sondeo de la entrada); desde ahí, 6 s bastan.
const JOIN_AFTER_START_MS = 8000;

export const RtcPlayer: React.FC<RtcPlayerProps> = ({ isStreaming, withAudio, audible, streamStartedMs, timecodes, preset, onMetricsUpdate }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null); // zona de vídeo, la que pasa a pantalla completa

  // El atributo muted del <video> solo vale al montarlo: después se cambia la propiedad
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !audible;
  }, [audible]);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'playing' | 'error'>('idle');
  // Búfer de jitter que se le pide al navegador (RTCRtpReceiver.jitterBufferTarget). 0 = no pedir nada
  // y dejar el comportamiento por defecto del navegador, que lo ajusta solo.
  const [targetMs, setTargetMs] = useState<number>(preset?.targetMs ?? 0);
  const targetRef = useRef(preset?.targetMs ?? 0);
  const receiverRef = useRef<RTCRtpReceiver | null>(null);

  // El medidor vive lo que el componente, no lo que cada intento de reproducción: así los congelados
  // se siguen contando mientras la vigilancia recrea el reproductor.
  const meterRef = useRef<GlassMeter | null>(null);
  const timecodesRef = useRef<TimecodeLayout[]>([DEFAULT_TIMECODE]);
  if (timecodes?.length) timecodesRef.current = timecodes;
  const restartsRef = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [joinWaitS, setJoinWaitS] = useState<number | null>(null); // espera antes de conectar tras un reinicio

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
    meters.rtc = glassMeter;
    return () => {
      glassMeter.close();
      if (meters.rtc === glassMeter) delete meters.rtc;
    };
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
    let joinTimer: any = null;
    const meter = meterRef.current!;
    const rate = new RateWindow();
    const networkRate = new RateWindow();
    const connection = new RTCPeerConnection();
    const transceiver = connection.addTransceiver('video', { direction: 'recvonly' });
    receiverRef.current = transceiver.receiver;
    applyTarget(transceiver.receiver, targetRef.current);
    // Con audio, el navegador sincroniza las dos pistas (mismo MediaStream) y puede retrasar el vídeo
    if (withAudio) connection.addTransceiver('audio', { direction: 'recvonly' });

    // Las dos pistas en el mismo MediaStream del <video>, lleguen en el orden que lleguen
    connection.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) {
        if (video.srcObject !== stream) video.srcObject = stream;
      } else {
        const current = video.srcObject instanceof MediaStream ? video.srcObject : new MediaStream();
        current.addTrack(event.track);
        video.srcObject = current;
      }
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
    const now = serverNowMs() ?? Date.now();
    const joinWait = Math.max(0, streamStartedMs + JOIN_AFTER_START_MS - now);
    setJoinWaitS(joinWait > 0 ? Math.ceil(joinWait / 1000) : null);
    joinTimer = setTimeout(() => {
      setJoinWaitS(null);
      negotiate();
    }, joinWait);

    // Vigilancia: si no hay imagen nueva durante WATCHDOG_MS (emisión reiniciada, conexión muerta),
    // se recrea la conexión en vez de esperar a que alguien recargue la pestaña.
    const startedAt = performance.now() + joinWait;
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
          frameTimeSdMs: glass.frameTimeSdMs,
          frameTimeP95Ms: glass.frameTimeP95Ms,
          frameTimeMaxMs: glass.frameTimeMaxMs,
          frameTimes: glass.frameTimes,
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
      clearTimeout(joinTimer);
      clearInterval(interval);
      clearInterval(watchdog);
      tracer.close();
      receiverRef.current = null;
      connection.close();
      video.srcObject = null;
    };
  }, [isStreaming, attempt, withAudio, streamStartedMs]);

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800/80 border-b border-slate-700/50">
        <div className="flex items-center space-x-2">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
          <h3 className="font-semibold text-sm text-slate-200">WebRTC (WHEP)</h3>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-amber-900/50 text-amber-300 border border-amber-700/40 font-mono">SRTP / UDP 8189</span>
      </div>

      <div
        ref={screenRef}
        data-player="rtc"
        onDoubleClick={() => toggleFullscreen(screenRef.current)}
        className="group relative aspect-video bg-black flex items-center justify-center"
      >
        <FullscreenButton target={screenRef} />
        <video ref={videoRef} className="w-full h-full object-contain" muted autoPlay playsInline />

        {status === 'connecting' && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center space-y-2">
            <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-slate-400">
              {joinWaitS !== null ? `Esperando a que la emisión lleve unos segundos publicada (~${joinWaitS} s)...` : 'Negociando sesión WebRTC...'}
            </span>
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
        className="px-4 py-2.5 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs"
        title="Búfer de jitter que se pide al navegador (RTCRtpReceiver.jitterBufferTarget). En auto no se pide nada y el navegador lo ajusta solo según la red."
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
          <span className="text-slate-400 font-medium whitespace-nowrap">Búfer objetivo:</span>
          <span className="font-mono text-amber-400 font-semibold whitespace-nowrap">{targetMs === 0 ? 'auto (navegador)' : `${targetMs}ms`}</span>
        </div>
        <div className="flex items-center space-x-3 flex-1 min-w-[10rem] max-w-xs ml-auto">
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

      <div className="px-4 py-2 bg-slate-950/60 border-t border-slate-800/60 text-[11px] text-slate-500 flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono">
        <span>MediaMTX · {WHEP_URL}</span>
        <span>RTCPeerConnection + &lt;video&gt;</span>
      </div>
    </div>
  );
};
