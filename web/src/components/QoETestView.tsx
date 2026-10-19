import React, { useState, useRef, useEffect } from 'react';
import { Award, Play, Square, RefreshCw, Download, ArrowLeft, AlertCircle } from 'lucide-react';
import type { ServerStatus, QoEEvaluationResponse, QoESecondTimeline } from '../types';
import { QoERunner } from '../lib/qoe';
import { grabFromVideo } from '../lib/glass';
import * as Watch from '@moq/watch';
import * as Net from '@moq/net';
import { Signal } from '@moq/signals';

interface QoETestViewProps {
  status: ServerStatus | null;
  onClose: () => void;
}

export const QoETestView: React.FC<QoETestViewProps> = ({ status, onClose }) => {
  const [protocol, setProtocol] = useState<'dash' | 'moq' | 'rtc'>('dash');
  const [durationS, setDurationS] = useState<number>(30);
  const [state, setState] = useState<'idle' | 'preparing' | 'running' | 'completed' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [progress, setProgress] = useState<{ elapsedS: number; remainingS: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [result, setResult] = useState<QoEEvaluationResponse | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runnerRef = useRef<QoERunner | null>(null);

  const dashPlayerRef = useRef<any>(null);
  const moqPlayerRef = useRef<Watch.Player | null>(null);
  const moqConnRef = useRef<Net.Connection | null>(null);
  const rtcPcRef = useRef<RTCPeerConnection | null>(null);

  const cleanupPlayers = () => {
    if (dashPlayerRef.current) {
      try {
        dashPlayerRef.current.reset();
      } catch (_) {}
      dashPlayerRef.current = null;
    }
    if (moqPlayerRef.current) {
      try {
        moqPlayerRef.current.close();
      } catch (_) {}
      moqPlayerRef.current = null;
    }
    if (moqConnRef.current) {
      try {
        moqConnRef.current.close();
      } catch (_) {}
      moqConnRef.current = null;
    }
    if (rtcPcRef.current) {
      try {
        rtcPcRef.current.close();
      } catch (_) {}
      rtcPcRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      cleanupPlayers();
      if (runnerRef.current) runnerRef.current.stop();
    };
  }, []);

  const handleStart = async () => {
    setErrorMsg('');
    setResult(null);
    setState('preparing');
    cleanupPlayers();

    try {
      // 1. Asegurar que la emisión está activa en el servidor
      setStatusMessage('Verificando emisión en servidor...');
      const statusRes = await fetch('/api/status');
      const currentServer = statusRes.ok ? await statusRes.json() : null;

      if (currentServer?.status !== 'running') {
        setStatusMessage('Iniciando emisión en servidor (POST /api/start)...');
        const startRes = await fetch('/api/start', { method: 'POST' });
        if (!startRes.ok) {
          throw new Error(`No se pudo arrancar la emisión: ${await startRes.text()}`);
        }
        // Margen de 2 segundos para que los empaquetadores generen los primeros fragmentos
        await new Promise((r) => setTimeout(r, 2000));
      }

      // 2. Conectar el reproductor correspondiente
      setStatusMessage(`Conectando reproductor ${protocol.toUpperCase()}...`);
      let grabber: () => VideoFrame | null = () => null;
      let getPlaybackRate: () => number = () => 1.0;
      let getRenditionHeight: () => number = () => 1080;

      if (protocol === 'dash') {
        const video = videoRef.current;
        if (!video) throw new Error('Elemento <video> no disponible');

        const dashjs = (window as any).dashjs;
        if (!dashjs) throw new Error('Librería dash.js no cargada');

        const player = dashjs.MediaPlayer().create();
        dashPlayerRef.current = player;
        const manifestUrl = status?.dash_url || '/media/dash/manifest.mpd';
        player.initialize(video, manifestUrl, true);
        player.updateSettings({
          streaming: {
            lowLatencyEnabled: true,
            delay: { liveDelay: 1.0 },
            liveCatchup: { enabled: true, maxDrift: 0.5, playbackRate: { min: -0.15, max: 0.15 } },
          },
        });

        grabber = () => grabFromVideo(video);
        getPlaybackRate = () => video.playbackRate || 1.0;
        getRenditionHeight = () => {
          try {
            const q = player.getQualityFor('video');
            const list = player.getBitrateInfoListFor('video');
            return list && list[q] ? list[q].height : 1080;
          } catch (_) {
            return 1080;
          }
        };
      } else if (protocol === 'moq') {
        const canvas = canvasRef.current;
        if (!canvas) throw new Error('Elemento <canvas> no disponible');

        let hexFingerprint = '';
        try {
          const res = await fetch('/certificate.sha256', { cache: 'no-store' });
          if (res.ok) hexFingerprint = (await res.text()).trim();
        } catch (_) {}

        const host = status?.moq_host || window.location.hostname;
        const port = status?.moq_port || 4433;
        const targetUrl = new URL(`https://${host}:${port}/anon`);

        const conn = new Net.Connection({
          url: targetUrl,
          enabled: true,
          webtransport: hexFingerprint
            ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: hexFingerprint }] }
            : undefined,
        });
        moqConnRef.current = conn;

        const delaySignal = new Signal<any>('auto');
        const targetSignal = new Signal<Watch.Video.Target | undefined>(undefined);
        const player = new Watch.Player({
          origin: conn.origin,
          probe: conn.probe,
          name: Net.Path.from('live.hang'),
          announced: true,
          visible: 'always',
          canvas,
          muted: new Signal(true),
          delay: delaySignal,
          target: targetSignal,
        });
        moqPlayerRef.current = player;

        grabber = () => {
          try {
            return player.renderer.out.frame.peek()?.clone() ?? null;
          } catch (_) {
            return null;
          }
        };
        getPlaybackRate = () => 1.0;
        getRenditionHeight = () => {
          try {
            const f = player.renderer.out.frame.peek();
            return f ? f.displayHeight : 1080;
          } catch (_) {
            return 1080;
          }
        };
      } else if (protocol === 'rtc') {
        const video = videoRef.current;
        if (!video) throw new Error('Elemento <video> no disponible');

        const pc = new RTCPeerConnection();
        rtcPcRef.current = pc;
        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.ontrack = (ev) => {
          if (ev.track.kind === 'video' && video) {
            video.srcObject = ev.streams[0];
            video.play().catch(() => {});
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const whepRes = await fetch('/rtc/whep', {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: offer.sdp,
        });
        if (!whepRes.ok) throw new Error(`Fallo WHEP: ${whepRes.statusText}`);
        const answerSdp = await whepRes.text();
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

        grabber = () => grabFromVideo(video);
        getPlaybackRate = () => 1.0;
        getRenditionHeight = () => (video.videoHeight > 0 ? video.videoHeight : 1080);
      }

      // Tiempo de estabilización para sincronizar el buffer
      setStatusMessage('Estabilizando reproducción...');
      await new Promise((r) => setTimeout(r, 1500));

      setState('running');
      setStatusMessage('');

      const runner = new QoERunner({
        protocol,
        durationS,
        grab: grabber,
        getLayouts: () => status?.timecodes ?? [],
        getPlaybackRate,
        getRenditionHeight,
        onProgress: (elapsed, remaining) => {
          setProgress({ elapsedS: elapsed, remainingS: remaining });
        },
      });
      runnerRef.current = runner;

      const evalResult = await runner.start();
      setResult(evalResult);
      setState('completed');
    } catch (err: any) {
      console.error('[QoE] Error en prueba:', err);
      setErrorMsg(err.message || String(err));
      setState('error');
    } finally {
      cleanupPlayers();
    }
  };

  const handleCancel = () => {
    if (runnerRef.current) runnerRef.current.stop();
    cleanupPlayers();
    setState('idle');
    setProgress(null);
  };

  const exportJSON = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qoe_eval_${result.protocol}_${result.duration_s}s.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Contenedores multimedia ocultos pero SIEMPRE montados en el DOM */}
      <div className={`relative w-full max-w-4xl mx-auto aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 shadow-2xl ${state === 'running' ? 'block' : 'hidden'}`}>
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          className={`w-full h-full object-contain ${protocol === 'moq' ? 'hidden' : 'block'}`}
        />
        <canvas
          ref={canvasRef}
          className={`w-full h-full object-contain ${protocol === 'moq' ? 'block' : 'hidden'}`}
        />
      </div>

      {/* Cabecera del Panel */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-indigo-900/60 border border-indigo-700/50 rounded-lg text-indigo-400">
            <Award className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-200">
              Evaluador de Calidad de Experiencia (QoE) para Baja Latencia
            </h3>
            <p className="text-xs text-slate-400">
              Medida objetiva con la formulación de LL-GABR (Raman et al., 2024) y alineación por timecode
            </p>
          </div>
        </div>

        <button
          onClick={onClose}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Volver al Monitor</span>
        </button>
      </div>

      {/* Panel de Configuración Inicial */}
      {state === 'idle' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Selector de Protocolo */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Protocolo a Evaluar
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['dash', 'moq', 'rtc'] as const).map((p) => {
                  const active = protocol === p;
                  return (
                    <button
                      key={p}
                      onClick={() => setProtocol(p)}
                      className={`px-3 py-2.5 rounded-lg border text-xs font-mono font-bold transition-all cursor-pointer ${
                        active
                          ? 'border-indigo-500 bg-indigo-900/40 text-indigo-200 shadow-md'
                          : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {p === 'dash' ? 'LL-DASH' : p === 'moq' ? 'MoQ (QUIC)' : 'WebRTC'}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Selector de Duración */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Duración de la Prueba
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[15, 30, 60].map((dur) => {
                  const active = durationS === dur;
                  return (
                    <button
                      key={dur}
                      onClick={() => setDurationS(dur)}
                      className={`px-3 py-2.5 rounded-lg border text-xs font-mono font-bold transition-all cursor-pointer ${
                        active
                          ? 'border-emerald-500 bg-emerald-900/40 text-emerald-200 shadow-md'
                          : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {dur} segundos
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
            <p className="text-xs text-slate-400">
              La prueba evaluará exclusivamente el protocolo seleccionado en régimen aislado.
            </p>
            <button
              onClick={handleStart}
              className="flex items-center space-x-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs tracking-wide uppercase transition-colors shadow-lg cursor-pointer"
            >
              <Play className="w-4 h-4 fill-white" />
              <span>Iniciar Evaluación</span>
            </button>
          </div>
        </div>
      )}

      {/* Fase de Preparación */}
      {state === 'preparing' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 shadow-lg text-center space-y-4">
          <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin mx-auto" />
          <div className="font-semibold text-slate-200">{statusMessage}</div>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Configurando el canal de streaming y estabilizando el jitter buffer del reproductor...
          </p>
        </div>
      )}

      {/* Fase de Ejecución */}
      {state === 'running' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <span className="w-3 h-3 rounded-full bg-rose-500 animate-ping" />
              <span className="font-bold text-sm text-slate-100 uppercase tracking-wide">
                Evaluando {protocol === 'dash' ? 'LL-DASH' : protocol === 'moq' ? 'MoQ' : 'WebRTC'}
              </span>
            </div>
            <div className="font-mono text-xs text-slate-400">
              Tiempo: <strong className="text-emerald-400">{progress?.elapsedS ?? 0}s</strong> / {durationS}s
            </div>
          </div>

          {/* Barra de progreso */}
          <div className="h-2 w-full bg-slate-950 rounded-full overflow-hidden border border-slate-800">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-200"
              style={{ width: `${Math.min(100, (((progress?.elapsedS ?? 0) / durationS) * 100))}%` }}
            />
          </div>

          <div className="flex justify-center pt-2">
            <button
              onClick={handleCancel}
              className="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white font-medium text-xs transition-colors cursor-pointer"
            >
              <Square className="w-3.5 h-3.5 fill-white" />
              <span>Cancelar Prueba</span>
            </button>
          </div>
        </div>
      )}

      {/* Mensaje de Error */}
      {state === 'error' && (
        <div className="bg-rose-950/40 border border-rose-800/80 rounded-xl p-4 text-rose-200 space-y-3">
          <div className="flex items-center space-x-2">
            <AlertCircle className="w-5 h-5 text-rose-400" />
            <span className="font-semibold text-sm">Error durante la prueba de evaluación:</span>
          </div>
          <p className="text-xs font-mono bg-rose-950/80 p-2.5 rounded border border-rose-900 text-rose-300">
            {errorMsg}
          </p>
          <button
            onClick={() => setState('idle')}
            className="px-3 py-1.5 rounded-lg bg-rose-800 hover:bg-rose-700 text-white font-medium text-xs transition-colors cursor-pointer"
          >
            Volver a intentar
          </button>
        </div>
      )}

      {/* Resultados Completos */}
      {state === 'completed' && result && (
        <div className="space-y-6">
          {/* Tarjetas de Métricas Principales */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* QoE Global */}
            <div className="bg-slate-900 p-4 rounded-xl border border-indigo-500/40 shadow-lg">
              <span className="text-xs text-slate-400 block mb-1 uppercase font-semibold">QoE Global (LL-GABR)</span>
              <div className="flex items-baseline space-x-1.5">
                <span className="text-3xl font-extrabold text-indigo-400">{result.qoe_score.toFixed(2)}</span>
                <span className="text-xs text-slate-500 font-mono">/ 5.0</span>
              </div>
            </div>

            {/* VMAF Medio */}
            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-lg">
              <span className="text-xs text-slate-400 block mb-1 uppercase font-semibold">VMAF Medio</span>
              <div className="flex items-baseline space-x-1.5">
                <span className="text-3xl font-extrabold text-emerald-400">{result.vmaf_mean.toFixed(1)}</span>
                <span className="text-xs text-slate-500 font-mono">/ 100</span>
              </div>
            </div>

            {/* Latencia Media */}
            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-lg">
              <span className="text-xs text-slate-400 block mb-1 uppercase font-semibold">Latencia Media</span>
              <div className="flex items-baseline space-x-1.5">
                <span className="text-3xl font-extrabold text-amber-400">{result.avg_latency_s.toFixed(2)}</span>
                <span className="text-xs text-slate-500 font-mono">s</span>
              </div>
            </div>

            {/* Parones */}
            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-lg">
              <span className="text-xs text-slate-400 block mb-1 uppercase font-semibold">Tiempo Congelado</span>
              <div className="flex items-baseline space-x-1.5">
                <span className={`text-3xl font-extrabold ${result.stalls_count > 0 ? 'text-rose-400' : 'text-slate-200'}`}>
                  {result.total_freeze_s.toFixed(2)}
                </span>
                <span className="text-xs text-slate-500 font-mono">s ({result.stalls_count} cortes)</span>
              </div>
            </div>
          </div>

          {/* Desglose de Factores LL-GABR */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg space-y-3">
            <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Desglose de Términos de la Ecuación LL-GABR
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-xs font-mono">
              <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                <span className="text-slate-400 block mb-1">Calidad Visual (+)</span>
                <span className="text-emerald-400 font-bold">+{result.penalties.visual_quality_score.toFixed(2)}</span>
              </div>
              <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                <span className="text-slate-400 block mb-1">Parones (-)</span>
                <span className="text-rose-400 font-bold">-{result.penalties.freeze_penalty.toFixed(2)}</span>
              </div>
              <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                <span className="text-slate-400 block mb-1">Nº Cortes (-)</span>
                <span className="text-rose-400 font-bold">-{result.penalties.stall_count_penalty.toFixed(2)}</span>
              </div>
              <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                <span className="text-slate-400 block mb-1">Latencia (-)</span>
                <span className="text-amber-400 font-bold">-{result.penalties.latency_penalty.toFixed(2)}</span>
              </div>
              <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                <span className="text-slate-400 block mb-1">Catch-up (-)</span>
                <span className="text-slate-200 font-bold">-{result.penalties.catchup_penalty.toFixed(2)}</span>
              </div>
              <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                <span className="text-slate-400 block mb-1">Fluctuación (-)</span>
                <span className="text-slate-200 font-bold">-{result.penalties.smoothness_penalty.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Gráfica Temporal por Segundo */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg space-y-3">
            <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Evolución Temporal Segundo a Segundo (T = {result.duration_s} s)
            </h4>
            <div className="w-full h-48 relative pt-2">
              <svg width="100%" height="100%" viewBox={`0 0 ${result.timeline.length * 20 + 40} 150`} preserveAspectRatio="none">
                {/* Cuadrículas */}
                <line x1="30" y1="15" x2={result.timeline.length * 20 + 30} y2="15" stroke="#1e293b" strokeDasharray="3" />
                <line x1="30" y1="65" x2={result.timeline.length * 20 + 30} y2="65" stroke="#1e293b" strokeDasharray="3" />
                <line x1="30" y1="115" x2={result.timeline.length * 20 + 30} y2="115" stroke="#334155" />

                <text x="25" y="18" fill="#64748b" fontSize="8" textAnchor="end">100</text>
                <text x="25" y="68" fill="#64748b" fontSize="8" textAnchor="end">50</text>
                <text x="25" y="118" fill="#64748b" fontSize="8" textAnchor="end">0</text>

                {/* Parones en rojo */}
                {result.timeline.map((s: QoESecondTimeline, idx: number) => {
                  const x = 30 + idx * 20;
                  if (s.freeze_s > 0) {
                    return (
                      <rect
                        key={`f-${s.sec}`}
                        x={x}
                        y="15"
                        width="18"
                        height="100"
                        fill="rgba(244, 63, 94, 0.25)"
                        stroke="#f43f5e"
                        strokeWidth="1"
                      />
                    );
                  }
                  return null;
                })}

                {/* Curva VMAF */}
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="2.5"
                  points={result.timeline
                    .map((s: QoESecondTimeline, idx: number) => {
                      const x = 39 + idx * 20;
                      const y = 115 - (s.vmaf / 100) * 100;
                      return `${x},${y}`;
                    })
                    .join(' ')}
                />

                {/* Curva Latencia */}
                <polyline
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="2"
                  strokeDasharray="4 2"
                  points={result.timeline
                    .map((s: QoESecondTimeline, idx: number) => {
                      const x = 39 + idx * 20;
                      const clamped = Math.min(5.0, s.latency_s);
                      const y = 115 - (clamped / 5.0) * 100;
                      return `${x},${y}`;
                    })
                    .join(' ')}
                />
              </svg>
            </div>

            <div className="flex items-center justify-center space-x-6 text-[11px] font-mono text-slate-400 pt-2 border-t border-slate-800">
              <span className="flex items-center space-x-1.5">
                <span className="w-3 h-0.5 bg-emerald-500" />
                <span>VMAF (0–100)</span>
              </span>
              <span className="flex items-center space-x-1.5">
                <span className="w-3 h-0.5 bg-amber-500 border-t border-dashed" />
                <span>Latencia (0–5 s)</span>
              </span>
              <span className="flex items-center space-x-1.5">
                <span className="w-2.5 h-2.5 bg-rose-500/40 border border-rose-500" />
                <span>Congelación</span>
              </span>
            </div>
          </div>

          {/* Acciones */}
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setState('idle')}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs transition-colors cursor-pointer"
            >
              Configurar Nueva Prueba
            </button>
            <button
              onClick={exportJSON}
              className="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs transition-colors cursor-pointer shadow-md"
            >
              <Download className="w-4 h-4" />
              <span>Descargar Informe JSON</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
