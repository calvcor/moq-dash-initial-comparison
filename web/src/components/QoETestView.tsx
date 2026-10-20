import React, { useState, useRef, useEffect } from 'react';
import {
  Award,
  Play,
  Square,
  RefreshCw,
  Download,
  ArrowLeft,
  AlertCircle,
  Sliders,
  Network,
  Settings2,
  Check,
  Layers,
  Gauge,
  Wifi,
} from 'lucide-react';
import type {
  ServerStatus,
  StreamConfig,
  NetworkProfile,
  LinkProfile,
  QoEEvaluationResponse,
  QoESecondTimeline,
} from '../types';
import { QoERunner } from '../lib/qoe';
import { grabFromVideo } from '../lib/glass';
import * as Watch from '@moq/watch';
import * as Net from '@moq/net';
import { Signal } from '@moq/signals';

interface QoETestViewProps {
  status: ServerStatus | null;
  config: StreamConfig;
  isLoading: boolean;
  onConfigChange: (newConfig: StreamConfig) => void;
  onApplyConfig: () => Promise<void>;
  onApplyNetwork: (profile: NetworkProfile) => Promise<void>;
  onClose: () => void;
}

const CLEAR: LinkProfile = { rate_kbit: null, delay_ms: 0, jitter_ms: 0, loss_pct: 0, queue_ms: 100 };

const NETWORK_PRESETS: { label: string; desc: string; profile: NetworkProfile }[] = [
  {
    label: 'Sin restricción',
    desc: 'Red ideal sin pérdidas ni retardo',
    profile: { down: CLEAR, up: CLEAR },
  },
  {
    label: 'RTT 100 ms',
    desc: '50ms retardo por sentido',
    profile: { down: { ...CLEAR, delay_ms: 50 }, up: { ...CLEAR, delay_ms: 50 } },
  },
  {
    label: 'Pérdida 1 %',
    desc: 'RTT 40ms y 1% de paquetes descartados',
    profile: { down: { ...CLEAR, delay_ms: 20, loss_pct: 1 }, up: { ...CLEAR, delay_ms: 20, loss_pct: 1 } },
  },
  {
    label: 'Pérdida 3 %',
    desc: 'RTT 50ms y 3% de pérdida agresiva',
    profile: { down: { ...CLEAR, delay_ms: 25, loss_pct: 3 }, up: { ...CLEAR, delay_ms: 25, loss_pct: 3 } },
  },
  {
    label: 'Móvil 4G',
    desc: '10 Mbps down / 5 Mbps up, 60ms RTT, 5ms jitter',
    profile: {
      down: { rate_kbit: 10000, delay_ms: 30, jitter_ms: 5, loss_pct: 0.2, queue_ms: 200 },
      up: { rate_kbit: 5000, delay_ms: 30, jitter_ms: 5, loss_pct: 0.2, queue_ms: 200 },
    },
  },
  {
    label: 'Enlace saturado (3 Mbit)',
    desc: 'Cuello de botella de 3 Mbps con cola de 200ms',
    profile: { down: { ...CLEAR, rate_kbit: 3000, delay_ms: 30, queue_ms: 200 }, up: { ...CLEAR, delay_ms: 30 } },
  },
];

const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

export const QoETestView: React.FC<QoETestViewProps> = ({
  status,
  config,
  isLoading,
  onConfigChange,
  onApplyConfig,
  onApplyNetwork,
  onClose,
}) => {
  const [protocol, setProtocol] = useState<'dash' | 'moq' | 'rtc'>('dash');
  const [durationS, setDurationS] = useState<number>(30);
  const [state, setState] = useState<'idle' | 'preparing' | 'running' | 'completed' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [progress, setProgress] = useState<{ elapsedS: number; remainingS: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [result, setResult] = useState<QoEEvaluationResponse | null>(null);

  // Pestaña activa en el configurador pre-test
  const [configTab, setConfigTab] = useState<'player' | 'network' | 'stream'>('player');

  // Ajustes del reproductor
  const [targetLatencyMs, setTargetLatencyMs] = useState<number>(1000); // 1000ms = 1.0s
  const [quality, setQuality] = useState<number | 'auto'>('auto');
  const [maxDrift, setMaxDrift] = useState<number>(1.5); // Solo para DASH

  // Borrador de emulación de red
  const [networkDraft, setNetworkDraft] = useState<NetworkProfile>(status?.network?.profile ?? { down: CLEAR, up: CLEAR });
  const [isApplyingNet, setIsApplyingNet] = useState<boolean>(false);
  const [isApplyingStream, setIsApplyingStream] = useState<boolean>(false);

  // Sincronizar borrador de red cuando status cambie si no hay cambios locales
  useEffect(() => {
    if (status?.network?.profile) {
      setNetworkDraft(status.network.profile);
    }
  }, [status?.network?.profile]);

  // Metadatos congelados del experimento para el informe final
  const testMetadataRef = useRef<any>(null);

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

  // Comparación de cambios pendientes
  const networkPending = Boolean(status?.network?.profile && !same(status.network.profile, networkDraft));
  const streamPending = Boolean(
    status?.config &&
      (config.gop_size !== status.config.gop_size ||
        config.seg_duration !== status.config.seg_duration ||
        config.frag_duration !== status.config.frag_duration ||
        !same(config.renditions, status.config.renditions))
  );

  const handleApplyNetworkProfile = async (prof: NetworkProfile) => {
    setNetworkDraft(prof);
    setIsApplyingNet(true);
    try {
      await onApplyNetwork(prof);
    } finally {
      setIsApplyingNet(false);
    }
  };

  const handleApplyStreamSettings = async () => {
    setIsApplyingStream(true);
    try {
      await onApplyConfig();
    } finally {
      setIsApplyingStream(false);
    }
  };

  const handleStart = async () => {
    setErrorMsg('');
    setResult(null);
    setState('preparing');
    cleanupPlayers();

    // Guardar fotografía exacta de la configuración experimental
    testMetadataRef.current = {
      protocol,
      duration_s: durationS,
      target_latency_ms: targetLatencyMs,
      quality_selection: quality,
      max_drift_s: protocol === 'dash' ? maxDrift : undefined,
      network: status?.network?.profile ?? null,
      stream: status?.config ?? null,
      timestamp: new Date().toISOString(),
    };

    try {
      // 1. Asegurar que la emisión está activa en el servidor
      setStatusMessage('Verificando emisión en servidor...');
      const statusRes = await fetch('/api/status');
      const currentServer: ServerStatus = statusRes.ok ? await statusRes.json() : null;

      if (currentServer?.status !== 'running') {
        setStatusMessage('Iniciando emisión en servidor (POST /api/start)...');
        const startRes = await fetch('/api/start', { method: 'POST' });
        if (!startRes.ok) {
          throw new Error(`No se pudo arrancar la emisión: ${await startRes.text()}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      // 2. Conectar el reproductor correspondiente con sus ajustes específicos
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

        const targetSec = targetLatencyMs > 0 ? targetLatencyMs / 1000 : 1.0;
        player.updateSettings({
          streaming: {
            lowLatencyEnabled: true,
            delay: { liveDelay: targetSec },
            liveCatchup: {
              enabled: true,
              maxDrift,
              playbackRate: { min: -0.15, max: 0.15 },
              mode: 'liveCatchupModeLoLp',
            },
            abr: {
              autoSwitchBitrate: { video: quality === 'auto' },
            },
          },
        });

        if (quality !== 'auto') {
          player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
            const rep = player.getRepresentationsByType('video').find((r: any) => r.height === quality);
            if (rep) player.setRepresentationForTypeById('video', rep.id, true);
          });
        }

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

        const delaySignal = new Signal<any>(targetLatencyMs > 0 ? Net.Time.Milli(targetLatencyMs) : 'auto');
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

        if (quality !== 'auto') {
          player.video.source.out.available.subscribe((available) => {
            if (!available) return;
            const wanted = Object.keys(available).find((name) => available[name].codedHeight === quality);
            if (wanted && targetSignal.peek()?.name !== wanted) {
              targetSignal.set({ name: wanted });
            }
          });
        }

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
        targetLatencyMs: targetLatencyMs > 0 ? targetLatencyMs : 1000,
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
    const exportData = {
      experiment_metadata: testMetadataRef.current,
      evaluation: result,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qoe_eval_${result.protocol}_${result.duration_s}s.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renditionsList = status?.config?.renditions ?? config.renditions ?? [];

  return (
    <div className="space-y-6">
      {/* Contenedores multimedia ocultos pero SIEMPRE montados en el DOM */}
      <div
        className={`relative w-full max-w-4xl mx-auto aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 shadow-2xl ${
          state === 'running' ? 'block' : 'hidden'
        }`}
      >
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
              Medida objetiva con la formulación de LL-GABR (Raman et al., 2024), alineación por timecode y VMAF
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

      {/* Panel de Configuración Pre-Vuelo */}
      {state === 'idle' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-6">
          {/* Fila 1: Selección Rápida de Protocolo y Duración */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pb-5 border-b border-slate-800">
            {/* Protocolo */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                1. Protocolo a Evaluar
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
                          ? 'border-indigo-500 bg-indigo-900/40 text-indigo-200 shadow-md ring-1 ring-indigo-500'
                          : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {p === 'dash' ? 'LL-DASH' : p === 'moq' ? 'MoQ (QUIC)' : 'WebRTC'}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Duración */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                2. Duración de la Prueba
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
                          ? 'border-emerald-500 bg-emerald-900/40 text-emerald-200 shadow-md ring-1 ring-emerald-500'
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

          {/* Fila 2: Pestañas de Ajustes Avanzados (Reproductor, Red, Emisión) */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-800 pb-2">
              <button
                onClick={() => setConfigTab('player')}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  configTab === 'player'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Sliders className="w-3.5 h-3.5" />
                <span>Ajustes del Reproductor</span>
              </button>

              <button
                onClick={() => setConfigTab('network')}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer relative ${
                  configTab === 'network'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Network className="w-3.5 h-3.5" />
                <span>Escenario de Red (tc)</span>
                {networkPending && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 ring-2 ring-slate-900" />
                )}
              </button>

              <button
                onClick={() => setConfigTab('stream')}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer relative ${
                  configTab === 'stream'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Settings2 className="w-3.5 h-3.5" />
                <span>Emisión y Encoder (GOP/CMAF)</span>
                {streamPending && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 ring-2 ring-slate-900" />
                )}
              </button>
            </div>

            {/* TAB: Ajustes del Reproductor */}
            {configTab === 'player' && (
              <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800 space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Latencia Objetivo */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-slate-300 flex items-center space-x-1.5">
                        <Gauge className="w-4 h-4 text-indigo-400" />
                        <span>Latencia Objetivo deseada:</span>
                      </label>
                      <span className="text-xs font-mono font-bold text-indigo-400">
                        {targetLatencyMs === 0 ? 'Auto / Live directo' : `${targetLatencyMs} ms (${(targetLatencyMs / 1000).toFixed(1)} s)`}
                      </span>
                    </div>

                    {/* Presets Rápidos */}
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        { label: '300 ms', val: 300 },
                        { label: '1.0 s', val: 1000 },
                        { label: '2.0 s', val: 2000 },
                        { label: 'Auto (0ms)', val: 0 },
                      ].map((p) => (
                        <button
                          key={p.val}
                          onClick={() => setTargetLatencyMs(p.val)}
                          className={`py-1 px-1.5 rounded text-[11px] font-mono border text-center transition-colors cursor-pointer ${
                            targetLatencyMs === p.val
                              ? 'border-indigo-500 bg-indigo-900/50 text-indigo-200'
                              : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    {/* Slider fino */}
                    <input
                      type="range"
                      min={0}
                      max={4000}
                      step={100}
                      value={targetLatencyMs}
                      onChange={(e) => setTargetLatencyMs(Number(e.target.value))}
                      className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                    <p className="text-[11px] text-slate-500">
                      En DASH y MoQ el reproductor calibrará su playout buffer contra este objetivo. WebRTC siempre opera en tiempo real.
                    </p>
                  </div>

                  {/* Selección de Calidad */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-slate-300 flex items-center space-x-1.5">
                        <Layers className="w-4 h-4 text-emerald-400" />
                        <span>Calidad de Vídeo:</span>
                      </label>
                      <span className="text-xs font-mono font-bold text-emerald-400">
                        {quality === 'auto' ? 'Adaptación Dinámica (Auto ABR)' : `${quality}p`}
                      </span>
                    </div>

                    <select
                      value={quality}
                      onChange={(e) => setQuality(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 text-slate-200 rounded-lg p-2.5 text-xs font-mono focus:outline-none focus:border-indigo-500 cursor-pointer"
                    >
                      <option value="auto">Auto (Algoritmo de adaptación ABR)</option>
                      {renditionsList.map((r) => (
                        <option key={r.height} value={r.height}>
                          {r.height}p · {r.bitrate_kbps} kbps (Forzar escalón fijo)
                        </option>
                      ))}
                    </select>

                    {/* Parámetro de Deriva para DASH */}
                    {protocol === 'dash' && (
                      <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
                        <span className="text-slate-400">Deriva máxima (maxDrift):</span>
                        <div className="flex items-center space-x-2">
                          {[0.5, 1.0, 1.5, 2.0].map((d) => (
                            <button
                              key={d}
                              onClick={() => setMaxDrift(d)}
                              className={`px-2 py-0.5 rounded text-[11px] font-mono border cursor-pointer ${
                                maxDrift === d
                                  ? 'border-indigo-500 bg-indigo-900/50 text-indigo-200'
                                  : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {d}s
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB: Escenario de Red (Emulación tc) */}
            {configTab === 'network' && (
              <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Wifi className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-semibold text-slate-300">
                      Perfiles de Red Preconfigurados (Router tc)
                    </span>
                  </div>

                  {networkPending && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      Perfil sin aplicar
                    </span>
                  )}
                </div>

                {/* Grid de Presets */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {NETWORK_PRESETS.map((p) => {
                    const active = same(networkDraft, p.profile);
                    return (
                      <button
                        key={p.label}
                        onClick={() => handleApplyNetworkProfile(p.profile)}
                        disabled={isLoading || isApplyingNet}
                        className={`p-2.5 rounded-lg border text-left transition-all cursor-pointer ${
                          active
                            ? 'border-indigo-500 bg-indigo-950/80 shadow-md ring-1 ring-indigo-500/50'
                            : 'border-slate-800 bg-slate-900/60 hover:bg-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-200">{p.label}</span>
                          {active && <Check className="w-3.5 h-3.5 text-indigo-400" />}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5 leading-tight">{p.desc}</p>
                      </button>
                    );
                  })}
                </div>

                {/* Parámetros Numéricos Actuales */}
                <div className="pt-2 border-t border-slate-800 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
                  <div className="bg-slate-900 p-2 rounded border border-slate-800">
                    <span className="text-slate-500 block text-[10px] uppercase">Retardo (RTT total)</span>
                    <span className="text-slate-200 font-bold">{(networkDraft.down.delay_ms + networkDraft.up.delay_ms)} ms</span>
                  </div>
                  <div className="bg-slate-900 p-2 rounded border border-slate-800">
                    <span className="text-slate-500 block text-[10px] uppercase">Pérdida de Paquetes</span>
                    <span className="text-slate-200 font-bold">{networkDraft.down.loss_pct} %</span>
                  </div>
                  <div className="bg-slate-900 p-2 rounded border border-slate-800">
                    <span className="text-slate-500 block text-[10px] uppercase">Ancho de Banda (Down)</span>
                    <span className="text-slate-200 font-bold">
                      {networkDraft.down.rate_kbit ? `${networkDraft.down.rate_kbit} kbps` : 'Sin límite'}
                    </span>
                  </div>
                  <div className="bg-slate-900 p-2 rounded border border-slate-800">
                    <span className="text-slate-500 block text-[10px] uppercase">Jitter</span>
                    <span className="text-slate-200 font-bold">{networkDraft.down.jitter_ms} ms</span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: Emisión y Encoder (GOP/CMAF) */}
            {configTab === 'stream' && (
              <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">
                    Parámetros de Codificación de la Fuente FFmpeg
                  </span>
                  {streamPending && (
                    <button
                      onClick={handleApplyStreamSettings}
                      disabled={isLoading || isApplyingStream}
                      className="flex items-center space-x-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-semibold transition cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isApplyingStream ? 'animate-spin' : ''}`} />
                      <span>Aplicar al Servidor</span>
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                  {/* GOP Size */}
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">GOP Size (frames a 60 fps):</label>
                    <div className="grid grid-cols-3 gap-1">
                      {[30, 60, 120].map((g) => (
                        <button
                          key={g}
                          onClick={() => onConfigChange({ ...config, gop_size: g })}
                          className={`py-1.5 rounded font-mono border cursor-pointer ${
                            config.gop_size === g
                              ? 'border-indigo-500 bg-indigo-900/50 text-indigo-200'
                              : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {g} ({(g / config.fps).toFixed(1)}s)
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Segment Duration */}
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">Duración de Segmento:</label>
                    <div className="grid grid-cols-3 gap-1">
                      {[1.0, 2.0, 4.0].map((s) => (
                        <button
                          key={s}
                          onClick={() => onConfigChange({ ...config, seg_duration: s })}
                          className={`py-1.5 rounded font-mono border cursor-pointer ${
                            config.seg_duration === s
                              ? 'border-indigo-500 bg-indigo-900/50 text-indigo-200'
                              : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {s} s
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Fragment CMAF Duration */}
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">Fragmento CMAF (baja latencia):</label>
                    <div className="grid grid-cols-3 gap-1">
                      {[0.05, 0.1, 0.2].map((f) => (
                        <button
                          key={f}
                          onClick={() => onConfigChange({ ...config, frag_duration: f })}
                          className={`py-1.5 rounded font-mono border cursor-pointer ${
                            config.frag_duration === f
                              ? 'border-indigo-500 bg-indigo-900/50 text-indigo-200'
                              : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {Math.round(f * 1000)} ms
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Escalera actual */}
                <div className="pt-2 border-t border-slate-800 flex items-center space-x-2 text-xs font-mono">
                  <span className="text-slate-500">Escalera activa:</span>
                  {config.renditions.map((r) => (
                    <span key={r.height} className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300">
                      {r.height}p @ {r.bitrate_kbps}k
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Fila 3: Resumen Pre-Vuelo y Botón de Inicio */}
          <div className="pt-4 border-t border-slate-800 flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="text-xs text-slate-400 space-y-0.5 font-mono">
              <span className="text-slate-300 font-semibold uppercase block">Resumen del Experimento:</span>
              <span>
                {protocol === 'dash' ? 'LL-DASH' : protocol === 'moq' ? 'MoQ (QUIC)' : 'WebRTC'} · {durationS}s | Target: {targetLatencyMs}ms | Calidad: {quality === 'auto' ? 'Auto ABR' : `${quality}p`} | Red: {networkDraft.down.loss_pct}% loss, {(networkDraft.down.delay_ms + networkDraft.up.delay_ms)}ms RTT
              </span>
            </div>

            <button
              onClick={handleStart}
              className="flex items-center space-x-2 px-6 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs tracking-wider uppercase transition-all shadow-lg hover:shadow-emerald-600/30 cursor-pointer"
            >
              <Play className="w-4 h-4 fill-white" />
              <span>Iniciar Evaluación QoE</span>
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
            Configurando el canal de streaming, aplicando perfiles de red y estabilizando el jitter buffer del reproductor...
          </p>
        </div>
      )}

      {/* Fase de Ejecución */}
      {state === 'running' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className="w-3 h-3 rounded-full bg-rose-500 animate-ping" />
              <span className="font-bold text-sm text-slate-100 uppercase tracking-wide">
                Evaluando {protocol === 'dash' ? 'LL-DASH' : protocol === 'moq' ? 'MoQ' : 'WebRTC'}
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono border border-slate-700">
                Target: {targetLatencyMs}ms | {quality === 'auto' ? 'Auto ABR' : `${quality}p`}
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

          <div className="flex justify-end pt-2">
            <button
              onClick={handleCancel}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs transition-colors cursor-pointer"
            >
              <Square className="w-3.5 h-3.5 text-rose-400" />
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
          {/* Ficha Técnica de las Condiciones de la Prueba */}
          {testMetadataRef.current && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2.5">
                Ficha Técnica del Experimento Realizado
              </h4>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs font-mono">
                <div className="bg-slate-950/60 p-2 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[10px] uppercase">Protocolo</span>
                  <span className="text-indigo-300 font-bold uppercase">{testMetadataRef.current.protocol}</span>
                </div>
                <div className="bg-slate-950/60 p-2 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[10px] uppercase">Latencia Objetivo</span>
                  <span className="text-indigo-300 font-bold">{testMetadataRef.current.target_latency_ms} ms</span>
                </div>
                <div className="bg-slate-950/60 p-2 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[10px] uppercase">Calidad Configurada</span>
                  <span className="text-indigo-300 font-bold">
                    {testMetadataRef.current.quality_selection === 'auto' ? 'Auto ABR' : `${testMetadataRef.current.quality_selection}p`}
                  </span>
                </div>
                <div className="bg-slate-950/60 p-2 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[10px] uppercase">Red Emulada (tc)</span>
                  <span className="text-indigo-300 font-bold">
                    {testMetadataRef.current.network ? `${(testMetadataRef.current.network.down.delay_ms * 2)}ms RTT, ${testMetadataRef.current.network.down.loss_pct}% loss` : 'Directa'}
                  </span>
                </div>
                <div className="bg-slate-950/60 p-2 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[10px] uppercase">GOP / Fragmento</span>
                  <span className="text-indigo-300 font-bold">
                    {testMetadataRef.current.stream ? `GOP ${testMetadataRef.current.stream.gop_size} · Frag ${testMetadataRef.current.stream.frag_duration * 1000}ms` : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          )}

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
              <span>Descargar Informe JSON con Metadatos</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
