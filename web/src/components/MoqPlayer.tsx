import React, { useEffect, useRef, useState } from 'react';
import * as Watch from '@moq/watch';
import * as Net from '@moq/net';
import { Signal } from '@moq/signals';
import { GlassMeter, RateWindow, DEFAULT_TIMECODE, WATCHDOG_MS, WATCHDOG_GRACE_MS } from '../lib/glass';
import { MoqBufferMeter, MoqTracer } from '../lib/trace';
import type { PlayerMetrics, Rendition, TimecodeLayout } from '../types';

interface MoqPlayerProps {
  url: string;
  spkiFingerprint?: string;
  isStreaming: boolean;
  timecodes?: TimecodeLayout[];
  renditions?: Rendition[];
  onMetricsUpdate: (metrics: Partial<PlayerMetrics>) => void;
}

export const MoqPlayer: React.FC<MoqPlayerProps> = ({
  url,
  spkiFingerprint: _spkiFingerprint,
  isStreaming,
  timecodes,
  renditions,
  onMetricsUpdate,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'playing' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  // 0 = auto: no se fija nada y @moq/watch dimensiona el búfer con el RTT que le comunica el relay
  const [targetLatencyMs, setTargetLatencyMs] = useState<number>(0);
  const [resolvedDelayMs, setResolvedDelayMs] = useState<number | null>(null);
  const toDelay = (ms: number) => (ms > 0 ? Net.Time.Milli(ms) : 'auto');
  const playerRef = useRef<Watch.Player | null>(null);
  const connectionRef = useRef<Net.Connection | null>(null);
  const delaySignalRef = useRef<Signal<any> | null>(null);

  const handleLatencyChange = (newMs: number) => {
    setTargetLatencyMs(newMs);
    if (delaySignalRef.current) {
      delaySignalRef.current.set(toDelay(newMs));
    }
  };

  // El medidor vive lo que el componente, no lo que cada intento de reproducción: así los congelados
  // se siguen contando mientras la vigilancia recrea el reproductor.
  const meterRef = useRef<GlassMeter | null>(null);
  const ladderRef = useRef(renditions);
  ladderRef.current = renditions;
  const timecodesRef = useRef<TimecodeLayout[]>([DEFAULT_TIMECODE]);
  if (timecodes?.length) timecodesRef.current = timecodes;
  const restartsRef = useRef(0);
  const [attempt, setAttempt] = useState(0);

  // Calidad: 'auto' deja toda la decisión a @moq/watch, sin intervenir; un número fija la rendition con
  // esa altura. Se aplica en el muestreo, cuando el catálogo ya la anuncia.
  const [quality, setQuality] = useState<number | 'auto'>('auto');
  const qualityRef = useRef<number | 'auto'>('auto');
  const switchesRef = useRef(0);
  const lastTrackRef = useRef<string | null>(null);

  const handleQualityChange = (value: number | 'auto') => {
    setQuality(value);
    qualityRef.current = value;
  };

  useEffect(() => {
    onMetricsUpdate({ targetLatencyMs: targetLatencyMs > 0 ? targetLatencyMs : null });
  }, [targetLatencyMs]);

  useEffect(() => {
    // El frame que el reproductor acaba de dibujar en el canvas. Se clona porque el reproductor cierra el
    // suyo en cuanto dibuja el siguiente.
    const grab = () => {
      try {
        return playerRef.current?.renderer.out.frame.peek()?.clone() ?? null;
      } catch (_) {
        return null;
      }
    };
    const glassMeter = new GlassMeter(grab, () => timecodesRef.current);
    meterRef.current = glassMeter;
    return () => glassMeter.close();
  }, []);

  useEffect(() => {
    if (!isStreaming) {
      if (playerRef.current) {
        try {
          playerRef.current.close();
        } catch (_) {}
        playerRef.current = null;
      }
      if (connectionRef.current) {
        try {
          connectionRef.current.close();
        } catch (_) {}
        connectionRef.current = null;
      }
      setStatus('idle');
      return;
    }

    if (!('WebTransport' in window)) {
      setStatus('error');
      setErrorMsg('WebTransport no está soportado en este navegador. Usa Chrome o Edge.');
      onMetricsUpdate({ status: 'error', errorMessage: 'WebTransport no soportado' });
      return;
    }

    setStatus('connecting');
    let isAborted = false;
    let retryTimer: any = null;
    let metricsInterval: any = null;
    let tracer: MoqTracer | null = null;
    let bufferMeter: MoqBufferMeter | null = null;
    const rate = new RateWindow();
    const networkRate = new RateWindow();
    let networkSource: PlayerMetrics['networkSource'];
    const meter = meterRef.current!;

    // Vigilancia: si no hay imagen nueva durante WATCHDOG_MS (suscripción rechazada, emisión reiniciada, conexión muerta),
    // se recrea el reproductor en vez de esperar a que alguien recargue la pestaña.
    const startedAt = performance.now();
    const watchdog = setInterval(() => {
      const frozen = meter.frozenMs();
      if (frozen !== null && frozen > WATCHDOG_MS && performance.now() - startedAt > WATCHDOG_GRACE_MS) {
        console.warn(`[MoQ] ${Math.round(frozen / 1000)} s sin imagen nueva: se recrea el reproductor`);
        restartsRef.current++;
        setAttempt((a) => a + 1);
      }
    }, 1000);

    async function initMoQ() {
      try {
        // 1. Obtener certificado SHA-256 generado dinámicamente por moq-relay
        let hexFingerprint = '';
        try {
          const res = await fetch('/certificate.sha256', { cache: 'no-store' });
          if (res.ok) {
            hexFingerprint = (await res.text()).trim();
            console.log('[MoQ] Fingerprint de moq-relay obtenido:', hexFingerprint);
          }
        } catch (e) {
          console.warn('[MoQ] No se pudo obtener fingerprint de moq-relay:', e);
        }

        if (isAborted) return;

        // 2. Conexión segura QUIC con pinning SHA-256
        const targetUrl = new URL(url);
        const connection = new Net.Connection({
          url: targetUrl,
          enabled: true,
          webtransport: hexFingerprint
            ? {
                serverCertificateHashes: [{ algorithm: 'sha-256', value: hexFingerprint }],
              }
            : undefined,
        });
        connectionRef.current = connection;

        // 3. Instanciar el reproductor oficial @moq/watch con jitter buffer y control reactivo
        const delaySignal = new Signal<Watch.Delay>(toDelay(targetLatencyMs));
        delaySignalRef.current = delaySignal;

        const targetSignal = new Signal<Watch.Video.Target | undefined>(undefined);
        const player = new Watch.Player({
          origin: connection.origin,
          probe: connection.probe,
          name: Net.Path.from('live.hang'),
          // Esperar al anuncio de la emisión antes de suscribirse: justo tras un reinicio del publicador
          // todavía no existe y una suscripción a ciegas se rechaza sin reintento.
          announced: true,
          // Por defecto @moq/watch deja de descargar el vídeo cuando el canvas sale de la vista (al hacer
          // scroll hasta las métricas, por ejemplo). Aquí debe seguir, como hacen los otros dos reproductores,
          // o la medida se interrumpe cada vez que se mira otra parte de la página.
          visible: 'always',
          canvas: canvasRef.current || undefined,
          muted: new Signal(true),
          // `buffer` se deja en su valor por defecto (0): tolera media adelantada sin recolocarse hacia el
          // directo, y con un valor mayor la latencia real queda por encima de la que marca el slider.
          delay: delaySignal,
          target: targetSignal,
        });
        playerRef.current = player;
        // Acceso desde la consola del navegador para depurar
        (window as any).moqPlayer = player;

        // Seguimiento de frames concretos por las etapas del recorrido
        tracer = new MoqTracer(
          player,
          meter,
          () => (ladderRef.current ?? []).findIndex((r) => r.height === player.renderer.out.frame.peek()?.displayHeight),
          (stages) => onMetricsUpdate({ stages }),
        );

        bufferMeter = new MoqBufferMeter(player);

        if (isAborted) return;
        setStatus('playing');
        console.log('[MoQ] Reproductor @moq/watch inicializado con éxito en live.hang');

        // 4. Muestreo de métricas cada 500 ms
        metricsInterval = setInterval(() => {
          if (isAborted || !playerRef.current) return;
          try {
            const syncDelay = player.sync.out.delay.peek();
            if (typeof syncDelay === 'number') setResolvedDelayMs(Math.round(syncDelay));
            const held = bufferMeter?.take() ?? null;
            const videoStats = player.video.out.stats.peek();
            if (videoStats) rate.push(videoStats.bytesReceived);
            // Descarga total: bytes recibidos por la conexión WebTransport (todas las pistas y la señalización).
            // Chrome no implementa WebTransport.getStats(): en ese caso se suma la carga útil de las pistas.
            if (networkSource !== 'payload') {
              connection.stats().then((stats) => {
                if (stats?.bytesReceived === undefined) {
                  networkSource = 'payload';
                } else {
                  networkSource = 'transport';
                  networkRate.push(stats.bytesReceived);
                }
              }, () => {});
            } else if (videoStats) {
              networkRate.push(videoStats.bytesReceived + (player.audio.out.stats.peek()?.bytesReceived ?? 0));
            }
            const glass = meter.snapshot();

            // Calidad. En auto no se interviene: decide @moq/watch con su propia lógica (ancho de banda que
            // estima el relay y marcas "stalled" del catálogo). Solo al fijar una a mano se pide por nombre.
            const available = player.video.source.out.available.peek();
            const wanted =
              qualityRef.current === 'auto'
                ? undefined
                : Object.keys(available).find((name) => available[name].codedHeight === qualityRef.current);
            if (targetSignal.peek()?.name !== wanted) targetSignal.set(wanted ? { name: wanted } : undefined);
            const estimate = connection.probe.peek()?.estimatedRecvRate;

            const track = player.video.source.out.track.peek() ?? null;
            const rendition = player.video.source.out.config.peek();
            if (track && lastTrackRef.current && track !== lastTrackRef.current) switchesRef.current++;
            if (track) lastTrackRef.current = track;

            onMetricsUpdate({
              protocol: 'Media over QUIC',
              latencyMs: glass.latencyMs,
              // Retardo del playhead respecto al live edge según el búfer de sincronización
              reportedLatencyMs: typeof syncDelay === 'number' ? Math.round(syncDelay) : null,
              bitrateKbps: rate.kbps(),
              networkKbps: networkRate.kbps(),
              networkSource,
              fps: glass.fps,
              // Tiempo medio que los frames entregados desde la última muestra pasaron retenidos en el reproductor
              bufferLengthSec: held === null ? null : Number(held.toFixed(3)),
              stalls: glass.stalls,
              stallMs: glass.stallMs,
              restarts: restartsRef.current,
              // Altura del frame que de verdad se está pintando y, aparte, la rendition seleccionada: la
              // librería cambia sin corte y mientras dura el cambio (que puede no completarse) no coinciden
              renditionHeight: player.video.out.frame.peek()?.displayHeight ?? rendition?.codedHeight ?? null,
              selectedHeight: rendition?.codedHeight ?? null,
              renditionKbps: rendition?.bitrate ? Math.round(rendition.bitrate / 1000) : null,
              qualitySwitches: switchesRef.current,
              // Tasa de recepción que estima el relay con su control de congestión (mensajes PROBE)
              bandwidthEstimateKbps: estimate ? Math.round(estimate / 1000) : null,
              qualityMode: qualityRef.current === 'auto' ? 'auto' : 'manual',
              status: 'playing',
            });
          } catch (_) {}
        }, 500);
      } catch (err: any) {
        if (isAborted) return;
        console.warn('[MoQ Watch Error - reintentando]:', err);
        setStatus('connecting');
        retryTimer = setTimeout(() => {
          if (!isAborted && isStreaming) {
            initMoQ();
          }
        }, 1200);
      }
    }

    initMoQ();

    return () => {
      isAborted = true;
      clearTimeout(retryTimer);
      clearInterval(metricsInterval);
      clearInterval(watchdog);
      tracer?.close();
      bufferMeter?.close();
      if (playerRef.current) {
        try {
          playerRef.current.close();
        } catch (_) {}
        playerRef.current = null;
      }
      if (connectionRef.current) {
        try {
          connectionRef.current.close();
        } catch (_) {}
        connectionRef.current = null;
      }
    };
  }, [url, isStreaming, attempt]);

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800/80 border-b border-slate-700/50">
        <div className="flex items-center space-x-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <h3 className="font-semibold text-sm text-slate-200">Media over QUIC (MoQ / WebTransport)</h3>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-emerald-900/50 text-emerald-300 border border-emerald-700/40 font-mono">
          HTTP/3 QUIC (UDP 4433)
        </span>
      </div>

      <div className="relative aspect-video bg-black flex items-center justify-center">
        <canvas
          ref={canvasRef}
          width={1920}
          height={1080}
          className="w-full h-full object-contain"
        />

        {status === 'connecting' && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center space-y-2">
            <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-slate-400">Negociando sesión WebTransport QUIC...</span>
          </div>
        )}

        {status === 'idle' && (
          <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center text-slate-500 space-y-1">
            <p className="text-sm font-medium">Stream detenido</p>
            <p className="text-xs text-slate-600">Inicia el pipeline desde el panel de control</p>
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 bg-red-950/80 flex flex-col items-center justify-center text-red-300 p-4 text-center">
            <p className="text-sm font-semibold">Error de Conexión MoQ</p>
            <p className="text-xs text-red-400 mt-1 max-w-sm">{errorMsg}</p>
          </div>
        )}
      </div>

      {/* Control de Latencia Objetivo en Vivo */}
      <div
        className="px-4 py-2.5 bg-slate-900 border-t border-slate-800 flex items-center justify-between text-xs"
        title="Búfer de jitter de @moq/watch (opción delay). En auto, que es el valor por defecto de la librería, lo calcula con el RTT que le comunica el relay: 1,25 veces el RTT mínimo, con un suelo de 20 ms. En ambos casos la librería le suma el jitter que el catálogo declara para las pistas; el valor resultante es el que se muestra entre paréntesis."
      >
        <div className="flex items-center space-x-2">
          <span className="text-slate-400 font-medium">Latencia objetivo:</span>
          <span className="font-mono text-emerald-400 font-semibold">
            {targetLatencyMs === 0 ? 'auto (RTT)' : `${targetLatencyMs}ms`}
            {resolvedDelayMs !== null && ` (efectiva ${resolvedDelayMs}ms)`}
          </span>
        </div>
        <div className="flex items-center space-x-3 w-1/2 max-w-xs">
          <span className="text-[10px] text-slate-500 font-mono">auto</span>
          <input
            type="range"
            min={0}
            max={2000}
            step={50}
            value={targetLatencyMs}
            onChange={(e) => handleLatencyChange(parseInt(e.target.value, 10))}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
          <span className="text-[10px] text-slate-500 font-mono">2000ms</span>
        </div>
      </div>

      <div className="px-4 py-2 bg-slate-950/60 border-t border-slate-800/60 text-[11px] text-slate-500 flex justify-between font-mono">
        <span>Relay: {url}/live.hang</span>
        <label className="flex items-center space-x-1.5" title="Auto deja decidir al algoritmo de adaptación del reproductor; fijar una calidad lo desactiva.">
          <span>Calidad:</span>
          <select
            value={quality}
            onChange={(e) => handleQualityChange(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
            className="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-emerald-500"
          >
            <option value="auto">Auto</option>
            {(renditions ?? []).map((r) => (
              <option key={`${r.height}-${r.bitrate_kbps}`} value={r.height}>
                {r.height}p · {r.bitrate_kbps} kbps
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
};
