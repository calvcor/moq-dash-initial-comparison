import { useState, useEffect, useRef } from 'react';
import { DashPlayer } from './components/DashPlayer';
import { MoqPlayer } from './components/MoqPlayer';
import { MetricsDashboard } from './components/MetricsDashboard';
import { ControlPanel } from './components/ControlPanel';
import { NetworkPanel } from './components/NetworkPanel';
import { PipelineDiagram } from './components/PipelineDiagram';
import { RateWindow } from './lib/glass';
import { syncClock, getClockSync } from './lib/clock';
import type { StreamConfig, ServerStatus, PlayerMetrics, SampleRow, NetworkProfile } from './types';
import { Activity, Radio, Cpu, Network } from 'lucide-react';

// Mismo origen que el dashboard: el punto de entrada (edge) reparte /api, /media/dash y el resto
const API_BASE = '';

const stage = (metrics: PlayerMetrics, key: string) => metrics.stages?.stages.find((s) => s.key === key)?.ms ?? null;

export function App() {
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [config, setConfig] = useState<StreamConfig>({
    gop_size: 60,
    fps: 60,
    renditions: [
      { height: 1080, bitrate_kbps: 4000 },
      { height: 720, bitrate_kbps: 2000 },
      { height: 360, bitrate_kbps: 700 },
    ],
    seg_duration: 2.0,
    frag_duration: 0.2,
  });

  const [dashMetrics, setDashMetrics] = useState<PlayerMetrics>({
    protocol: 'LL-DASH',
    latencyMs: null,
    reportedLatencyMs: null,
    bitrateKbps: null,
    networkKbps: null,
    fps: null,
    bufferLengthSec: null,
    stalls: 0,
    stallMs: 0,
    restarts: 0,
    targetLatencyMs: null,
    renditionHeight: null,
    renditionKbps: null,
    qualitySwitches: 0,
    bandwidthEstimateKbps: null,
    qualityMode: 'auto',
    status: 'idle',
  });

  const [moqMetrics, setMoqMetrics] = useState<PlayerMetrics>({
    protocol: 'Media over QUIC',
    latencyMs: null,
    reportedLatencyMs: null,
    bitrateKbps: null,
    networkKbps: null,
    fps: null,
    bufferLengthSec: null,
    stalls: 0,
    stallMs: 0,
    restarts: 0,
    targetLatencyMs: null,
    renditionHeight: null,
    renditionKbps: null,
    qualitySwitches: 0,
    bandwidthEstimateKbps: null,
    qualityMode: 'auto',
    status: 'idle',
  });

  const [history, setHistory] = useState<{
    labels: string[];
    dashLatency: (number | null)[];
    moqLatency: (number | null)[];
    dashBitrate: (number | null)[];
    moqBitrate: (number | null)[];
  }>({
    labels: [],
    dashLatency: [],
    moqLatency: [],
    dashBitrate: [],
    moqBitrate: [],
  });

  const hasInitializedConfig = useRef(false);
  const failedPolls = useRef(0);

  // Registro completo de la sesión (1 muestra/s) para exportar y calcular estadísticos
  const samplesRef = useRef<SampleRow[]>([]);
  const serverStatusRef = useRef<ServerStatus | null>(null);
  const epochRef = useRef({ epoch: 0, startedAt: performance.now() });

  // Tramo de medida: cambia al reiniciar el pipeline o al cambiar la red, para no mezclar condiciones
  // en los estadísticos. Los reproductores solo se remontan cuando cambia el stream_id de su emisión.
  const [measureEpoch, setMeasureEpoch] = useState<number>(0);
  const startMeasureEpoch = () => {
    epochRef.current = { epoch: epochRef.current.epoch + 1, startedAt: performance.now() };
    setMeasureEpoch(epochRef.current.epoch);
  };

  // Tráfico IP por protocolo y sentido, a partir de los contadores acumulados del router
  const ipWindows = useRef({ dash_down: new RateWindow(), dash_up: new RateWindow(), moq_down: new RateWindow(), moq_up: new RateWindow() });
  const ipRates = () => {
    const w = ipWindows.current;
    return { dash_down: w.dash_down.kbps(), dash_up: w.dash_up.kbps(), moq_down: w.moq_down.kbps(), moq_up: w.moq_up.kbps() };
  };

  // Mantener el reloj del navegador referido al del servidor que quema el timecode
  useEffect(() => {
    syncClock(API_BASE);
    const interval = setInterval(() => syncClock(API_BASE), 10000);
    return () => clearInterval(interval);
  }, []);

  // Consultar estado de la API
  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/status`);
      if (res.ok) {
        const data: ServerStatus = await res.json();
        setServerStatus(data);
        serverStatusRef.current = data;
        if (data.network) {
          for (const key of ['dash_down', 'dash_up', 'moq_down', 'moq_up'] as const) {
            ipWindows.current[key].push(data.network.stats[key].bytes);
          }
        }
        if (data.config && !hasInitializedConfig.current) {
          setConfig(data.config);
          hasInitializedConfig.current = true;
        }
        failedPolls.current = 0;
      }
    } catch (_) {
      // Backend caído: tras varios fallos seguidos se da por parado, para no dejar los reproductores
      // colgados de un estado antiguo. Al volver, sus stream_ids nuevos los reconectan.
      if (++failedPolls.current >= 3) {
        setServerStatus(null);
        serverStatusRef.current = null;
      }
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const dashMetricsRef = useRef(dashMetrics);
  const moqMetricsRef = useRef(moqMetrics);

  useEffect(() => {
    dashMetricsRef.current = dashMetrics;
  }, [dashMetrics]);

  useEffect(() => {
    moqMetricsRef.current = moqMetrics;
  }, [moqMetrics]);

  // Actualizar historial de gráficos cada segundo si el servidor está emitiendo
  useEffect(() => {
    if (serverStatus?.status !== 'running') return;

    const interval = setInterval(() => {
      const timeStr = new Date().toLocaleTimeString();
      const currentDash = dashMetricsRef.current;
      const currentMoq = moqMetricsRef.current;

      const status = serverStatusRef.current;
      const clock = getClockSync();
      const net = status?.network?.profile;
      const ip = ipRates();
      samplesRef.current.push({
        time_iso: new Date().toISOString(),
        epoch: epochRef.current.epoch,
        elapsed_s: Math.round((performance.now() - epochRef.current.startedAt) / 1000),
        gop_size: status?.config.gop_size ?? null,
        ladder: status?.config.renditions.map((r) => `${r.height}p@${r.bitrate_kbps}`).join('|') ?? null,
        seg_duration: status?.config.seg_duration ?? null,
        frag_duration: status?.config.frag_duration ?? null,
        dash_g2g_ms: currentDash.latencyMs,
        dash_reported_ms: currentDash.reportedLatencyMs,
        dash_kbps: currentDash.bitrateKbps,
        dash_net_kbps: currentDash.networkKbps,
        dash_fps: currentDash.fps,
        dash_buffer_s: currentDash.bufferLengthSec,
        dash_stalls: currentDash.stalls,
        dash_stall_ms: currentDash.stallMs,
        dash_player_restarts: currentDash.restarts,
        dash_target_ms: currentDash.targetLatencyMs,
        dash_height: currentDash.renditionHeight,
        dash_rendition_kbps: currentDash.renditionKbps,
        dash_quality_switches: currentDash.qualitySwitches,
        dash_bw_estimate_kbps: currentDash.bandwidthEstimateKbps,
        dash_quality_mode: currentDash.qualityMode,
        dash_max_drift_s: currentDash.maxDriftSec ?? null,
        moq_g2g_ms: currentMoq.latencyMs,
        moq_reported_ms: currentMoq.reportedLatencyMs,
        moq_kbps: currentMoq.bitrateKbps,
        moq_net_kbps: currentMoq.networkKbps,
        moq_fps: currentMoq.fps,
        moq_jitter_s: currentMoq.bufferLengthSec,
        moq_stalls: currentMoq.stalls,
        moq_stall_ms: currentMoq.stallMs,
        moq_player_restarts: currentMoq.restarts,
        moq_target_ms: currentMoq.targetLatencyMs,
        moq_height: currentMoq.renditionHeight,
        moq_selected_height: currentMoq.selectedHeight ?? null,
        moq_rendition_kbps: currentMoq.renditionKbps,
        moq_quality_switches: currentMoq.qualitySwitches,
        moq_bw_estimate_kbps: currentMoq.bandwidthEstimateKbps,
        moq_quality_mode: currentMoq.qualityMode,
        dash_stage_encode_ms: stage(currentDash, 'encode'),
        dash_stage_package_ms: stage(currentDash, 'package'),
        dash_stage_deliver_ms: stage(currentDash, 'deliver'),
        dash_stage_player_ms: stage(currentDash, 'player'),
        moq_stage_encode_ms: stage(currentMoq, 'encode'),
        moq_stage_ingest_ms: stage(currentMoq, 'ingest'),
        moq_stage_transport_ms: stage(currentMoq, 'transport'),
        moq_stage_player_ms: stage(currentMoq, 'player'),
        clock_offset_ms: clock ? Number(clock.offsetMs.toFixed(2)) : null,
        clock_rtt_ms: clock ? Number(clock.rttMs.toFixed(2)) : null,
        ingest_anomalies: status?.ingest_anomalies
          ? status.ingest_anomalies.master + status.ingest_anomalies.dash + status.ingest_anomalies.moq
          : null,
        dash_availability_drift_ms: status?.dash_availability_drift_ms ?? null,
        pipeline_restarts: status?.restarts ? status.restarts.master + status.restarts.dash + status.restarts.moq : null,
        net_down_rate_kbit: net?.down.rate_kbit ?? null,
        net_down_delay_ms: net?.down.delay_ms ?? null,
        net_down_jitter_ms: net?.down.jitter_ms ?? null,
        net_down_loss_pct: net?.down.loss_pct ?? null,
        net_down_queue_ms: net?.down.queue_ms ?? null,
        net_up_rate_kbit: net?.up.rate_kbit ?? null,
        net_up_delay_ms: net?.up.delay_ms ?? null,
        net_up_jitter_ms: net?.up.jitter_ms ?? null,
        net_up_loss_pct: net?.up.loss_pct ?? null,
        net_up_queue_ms: net?.up.queue_ms ?? null,
        dash_ip_down_kbps: ip.dash_down,
        dash_ip_up_kbps: ip.dash_up,
        moq_ip_down_kbps: ip.moq_down,
        moq_ip_up_kbps: ip.moq_up,
        dash_down_dropped: status?.network?.stats.dash_down.dropped ?? null,
        moq_down_dropped: status?.network?.stats.moq_down.dropped ?? null,
        dash_up_dropped: status?.network?.stats.dash_up.dropped ?? null,
        moq_up_dropped: status?.network?.stats.moq_up.dropped ?? null,
        tab_hidden: document.hidden,
      });

      setHistory((prev) => {
        const newLabels = [...prev.labels, timeStr].slice(-25);
        const newDashLat = [...prev.dashLatency, currentDash.latencyMs].slice(-25);
        const newMoqLat = [...prev.moqLatency, currentMoq.latencyMs].slice(-25);
        const newDashBit = [...prev.dashBitrate, currentDash.bitrateKbps].slice(-25);
        const newMoqBit = [...prev.moqBitrate, currentMoq.bitrateKbps].slice(-25);

        return {
          labels: newLabels,
          dashLatency: newDashLat,
          moqLatency: newMoqLat,
          dashBitrate: newDashBit,
          moqBitrate: newMoqBit,
        };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [serverStatus?.status]);

  const handleStart = async () => {
    setIsLoading(true);
    try {
      await fetch(`${API_BASE}/api/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      await fetchStatus();
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleStop = async () => {
    setIsLoading(true);
    try {
      await fetch(`${API_BASE}/api/stop`, { method: 'POST' });
      await fetchStatus();
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyConfig = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      // El servidor normaliza la configuración (ordena la escalera, ajusta el segmento al GOP)
      const applied = res.ok ? (await res.json()).config : null;
      if (applied) setConfig(applied);
      else console.error('Configuración rechazada', res.status);
      await fetchStatus();
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExport = () => {
    const rows = samplesRef.current;
    if (!rows.length) return;
    const columns = Object.keys(rows[0]) as (keyof SampleRow)[];
    const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => r[c] ?? '').join(','))].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `moq-vs-dash-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleResetSamples = () => {
    samplesRef.current = [];
    epochRef.current.startedAt = performance.now();
  };

  const handleApplyNetwork = async (profile: NetworkProfile) => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/network`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      });
      if (!res.ok) console.error('Perfil de red rechazado', await res.text());
      startMeasureEpoch();
      await fetchStatus();
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const isStreaming = serverStatus?.status === 'running';

  // Cada reproductor se remonta cuando cambia el identificador de su emisión en el servidor, sea quien sea
  // quien la haya reiniciado (esta pestaña, otra, la API o el supervisor).
  const dashStreamId = serverStatus?.stream_ids?.dash ?? 0;
  const moqStreamId = serverStatus?.stream_ids?.moq ?? 0;
  useEffect(() => {
    startMeasureEpoch();
  }, [dashStreamId, moqStreamId]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Cabecera Doctoral */}
        <header className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center space-x-3">
              <span className="p-2 bg-indigo-900/60 border border-indigo-700/50 rounded-lg text-indigo-400">
                <Radio className="w-5 h-5" />
              </span>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-white">
                  Media over QUIC vs. LL-DASH Testbed
                </h1>
                <p className="text-xs text-slate-400">
                  Doctorado en Streaming de Vídeo de Baja Latencia | Big Buck Bunny 1080p60
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-4 text-xs font-mono">
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800">
              <Cpu className="w-4 h-4 text-slate-400" />
              <span className="text-slate-400">Pipeline:</span>
              <span className={isStreaming ? 'text-emerald-400 font-bold' : 'text-slate-500'}>
                {isStreaming ? 'ACTIVO' : 'DETENIDO'}
              </span>
            </div>

            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800">
              <Network className="w-4 h-4 text-slate-400" />
              <span className="text-slate-400">Docker Backend:</span>
              <span className={serverStatus ? 'text-emerald-400' : 'text-amber-500'}>
                {serverStatus ? 'Conectado (:8000)' : 'Desconectado'}
              </span>
            </div>
          </div>
        </header>

        {/* Panel de Mandos */}
        <ControlPanel
          status={serverStatus}
          config={config}
          isLoading={isLoading}
          onConfigChange={setConfig}
          onStart={handleStart}
          onStop={handleStop}
          onApplyConfig={handleApplyConfig}
        />

        {/* Emulación de red, igual para las dos ramas */}
        <NetworkPanel network={serverStatus?.network} ipRates={ipRates()} isLoading={isLoading} onApply={handleApplyNetwork} />

        {/* Reproductores Lado a Lado (Split-Screen) */}
        <div className="grid grid-cols-2 gap-6">
          <DashPlayer
            key={`dash-${dashStreamId}`}
            url={serverStatus?.dash_url || '/media/dash/manifest.mpd'}
            timecodes={serverStatus?.timecodes}
            renditions={serverStatus?.config.renditions}
            isStreaming={isStreaming}
            onMetricsUpdate={(m) => setDashMetrics((prev) => ({ ...prev, ...m }))}
          />

          <MoqPlayer
            key={`moq-${moqStreamId}`}
            url={`https://${serverStatus?.moq_host || window.location.hostname}:${serverStatus?.moq_port ?? 4433}/anon`}
            spkiFingerprint={serverStatus?.spki_fingerprint}
            timecodes={serverStatus?.timecodes}
            renditions={serverStatus?.config.renditions}
            isStreaming={isStreaming}
            onMetricsUpdate={(m) => setMoqMetrics((prev) => ({ ...prev, ...m }))}
          />
        </div>

        {/* Recorrido de un frame con la latencia medida en cada etapa */}
        <PipelineDiagram dash={dashMetrics.stages} moq={moqMetrics.stages} dashLatencyMs={dashMetrics.latencyMs} moqLatencyMs={moqMetrics.latencyMs} />

        {/* Panel de Métricas y Telemetría */}
        <div className="pt-2">
          <div className="flex items-center space-x-2 mb-3">
            <Activity className="w-4 h-4 text-indigo-400" />
            <h2 className="font-semibold text-sm text-slate-300">
              Comparativa Cuantitativa de Rendimiento y QoE
            </h2>
          </div>
          <MetricsDashboard
            dashMetrics={dashMetrics}
            moqMetrics={moqMetrics}
            history={history}
            samples={samplesRef.current.filter((r) => r.epoch === measureEpoch)}
            anomalies={serverStatus?.ingest_anomalies}
            pipelineRestarts={serverStatus?.restarts}
            availabilityDriftMs={serverStatus?.dash_availability_drift_ms}
            onExport={handleExport}
            onReset={handleResetSamples}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
