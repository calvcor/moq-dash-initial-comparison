import { useState, useEffect, useRef } from 'react';
import { DashPlayer } from './components/DashPlayer';
import { MoqPlayer } from './components/MoqPlayer';
import { RtcPlayer } from './components/RtcPlayer';
import { MetricsDashboard } from './components/MetricsDashboard';
import { ControlPanel } from './components/ControlPanel';
import { NetworkPanel } from './components/NetworkPanel';
import { PipelineDiagram } from './components/PipelineDiagram';
import { VersionsPanel } from './components/VersionsPanel';
import type { FrameTime } from './lib/glass';
import { runQoETest } from './lib/qoe';
import { QoEPanel } from './components/QoEPanel';
import { gridCols } from './lib/layout';
import { syncClock } from './lib/clock';
import { PLAYER_IDS, INITIAL_METRICS, IpRates, buildSampleRow } from './lib/samples';
import type { PlayerId } from './lib/samples';
import type { StreamConfig, ServerStatus, PlayerMetrics, SampleRow, NetworkProfile, VersionReport } from './types';
import { Activity, Radio, Cpu, Network } from 'lucide-react';

// Mismo origen que el dashboard: el punto de entrada (edge) reparte /api, /media/dash y el resto
const API_BASE = '';

const PLAYERS_KEY = 'testbed.players';

/** Reproductores activos, recordados en este navegador. Si no se puede leer, los tres. */
function loadPlayers(): Record<PlayerId, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYERS_KEY) || 'null');
    if (saved && PLAYER_IDS.some((id) => saved[id] === true)) return { dash: !!saved.dash, moq: !!saved.moq, rtc: !!saved.rtc };
  } catch (_) {}
  return { dash: true, moq: true, rtc: true };
}

// Gráfica del tiempo en pantalla de cada frame: últimos 10 s
const FRAME_HISTORY_MS = 10000;
const appendFrames = (kept: FrameTime[], fresh: FrameTime[], now: number) => {
  const last = kept.length ? kept[kept.length - 1].t : -Infinity;
  return [...kept, ...fresh.filter((f) => f.t > last)].filter((f) => f.t > now - FRAME_HISTORY_MS);
};


export function App() {
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [versions, setVersions] = useState<VersionReport | null>(null);
  const versionsRef = useRef<VersionReport | null>(null);
  versionsRef.current = versions;

  // Versiones desplegadas y novedades: el servidor las consulta cada varias horas, aquí basta refrescar de vez en cuando
  useEffect(() => {
    const load = () =>
      fetch(`${API_BASE}/api/versions`)
        .then((res) => (res.ok ? res.json() : null))
        .then((report) => report && setVersions(report))
        .catch(() => {});
    load();
    const timer = setInterval(load, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [config, setConfig] = useState<StreamConfig>({
    source: 'file',
    rtc_audio: false,
    gop_size: 60,
    fps: 60,
    renditions: [
      { height: 1080, bitrate_kbps: 4000 },
      { height: 720, bitrate_kbps: 2000 },
      { height: 360, bitrate_kbps: 700 },
    ],
    seg_duration: 2.0,
    frag_duration: 0.1,
  });

  const [dashMetrics, setDashMetrics] = useState<PlayerMetrics>(INITIAL_METRICS.dash);

  const [moqMetrics, setMoqMetrics] = useState<PlayerMetrics>(INITIAL_METRICS.moq);

  const [rtcMetrics, setRtcMetrics] = useState<PlayerMetrics>(INITIAL_METRICS.rtc);

  const [history, setHistory] = useState<{
    labels: string[];
    dashLatency: (number | null)[];
    moqLatency: (number | null)[];
    dashBitrate: (number | null)[];
    moqBitrate: (number | null)[];
    rtcLatency: (number | null)[];
    rtcBitrate: (number | null)[];
    // Tiempo en pantalla de cada frame, de los últimos FRAME_HISTORY_MS
    dashFrames: FrameTime[];
    moqFrames: FrameTime[];
    rtcFrames: FrameTime[];
    framesAt: number; // performance.now() de la última actualización, para el eje "segundos atrás"
  }>({
    labels: [],
    dashLatency: [],
    moqLatency: [],
    dashBitrate: [],
    moqBitrate: [],
    rtcLatency: [],
    rtcBitrate: [],
    dashFrames: [],
    moqFrames: [],
    rtcFrames: [],
    framesAt: 0,
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
  const ipWindows = useRef(new IpRates());
  const ipRates = () => ipWindows.current.rates();

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
        ipWindows.current.push(data);
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

  // Reproductores activos. Uno desactivado se desmonta entero: cierra su conexión y deja de descargar, así
  // que no compite con los demás por la red ni por el navegador.
  const [players, setPlayers] = useState<Record<PlayerId, boolean>>(loadPlayers);
  const playersRef = useRef(players);
  playersRef.current = players;
  // Prueba de QoE también desde la consola (la usan las pruebas con Chrome headless): await qoeTest(30)
  // graba, anota lo que pinta cada reproductor activo durante 30 s y lo sube (lib/qoe.ts)
  useEffect(() => {
    (window as any).qoeTest = (durationS = 30, prerollS = 5) =>
      runQoETest({ durationS, prerollS, players: PLAYER_IDS.filter((p) => playersRef.current[p]) });
  }, []);
  const resetters: Record<PlayerId, (m: PlayerMetrics) => void> = { dash: setDashMetrics, moq: setMoqMetrics, rtc: setRtcMetrics };
  // Reproductor con el sonido activado; los demás van silenciados. Al cargar, ninguno: el navegador solo
  // deja reproducir con sonido después de un gesto del usuario, y elegirlo aquí lo es.
  const [audioPlayer, setAudioPlayer] = useState<PlayerId | null>(null);
  const audioPlayerRef = useRef<PlayerId | null>(null);
  audioPlayerRef.current = audioPlayer;
  const rtcAudio = serverStatus?.config.rtc_audio ?? false;
  useEffect(() => {
    if (audioPlayer === 'rtc' && !rtcAudio) setAudioPlayer(null);
  }, [audioPlayer, rtcAudio]);

  const togglePlayer = (id: PlayerId) => {
    const next = { ...players, [id]: !players[id] };
    if (!PLAYER_IDS.some((p) => next[p])) return; // siempre queda al menos uno
    setPlayers(next);
    if (!next[id] && audioPlayer === id) setAudioPlayer(null);
    try {
      localStorage.setItem(PLAYERS_KEY, JSON.stringify(next));
    } catch (_) {}
    if (!next[id]) resetters[id](INITIAL_METRICS[id]);
    // Cambian las condiciones de la medida (carga del navegador y de la red): tramo nuevo
    startMeasureEpoch();
  };

  const dashMetricsRef = useRef(dashMetrics);
  const moqMetricsRef = useRef(moqMetrics);
  const rtcMetricsRef = useRef(rtcMetrics);

  useEffect(() => {
    dashMetricsRef.current = dashMetrics;
  }, [dashMetrics]);

  useEffect(() => {
    moqMetricsRef.current = moqMetrics;
  }, [moqMetrics]);

  useEffect(() => {
    rtcMetricsRef.current = rtcMetrics;
  }, [rtcMetrics]);

  // Actualizar historial de gráficos cada segundo si el servidor está emitiendo
  useEffect(() => {
    if (serverStatus?.status !== 'running') return;

    const interval = setInterval(() => {
      const timeStr = new Date().toLocaleTimeString();
      // Un reproductor desactivado aporta su fila vacía, nunca su último valor
      const active = playersRef.current;
      const currentDash = active.dash ? dashMetricsRef.current : INITIAL_METRICS.dash;
      const currentMoq = active.moq ? moqMetricsRef.current : INITIAL_METRICS.moq;
      const currentRtc = active.rtc ? rtcMetricsRef.current : INITIAL_METRICS.rtc;

      samplesRef.current.push(
        buildSampleRow({
          epoch: epochRef.current.epoch,
          epochStartedAt: epochRef.current.startedAt,
          active,
          metrics: { dash: dashMetricsRef.current, moq: moqMetricsRef.current, rtc: rtcMetricsRef.current },
          status: serverStatusRef.current,
          ip: ipRates(),
          audioPlayer: audioPlayerRef.current,
          versions: versionsRef.current,
        }),
      );

      const now = performance.now();
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
          rtcLatency: [...prev.rtcLatency, currentRtc.latencyMs].slice(-25),
          rtcBitrate: [...prev.rtcBitrate, currentRtc.bitrateKbps].slice(-25),
          // Cada informe trae los frames de sus últimos 2 s: se añaden los posteriores al último guardado
          dashFrames: appendFrames(prev.dashFrames, currentDash.frameTimes, now),
          moqFrames: appendFrames(prev.moqFrames, currentMoq.frameTimes, now),
          rtcFrames: appendFrames(prev.rtcFrames, currentRtc.frameTimes, now),
          framesAt: now,
        };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [serverStatus?.status]);

  // Motivo del último arranque o cambio rechazado (p. ej. la cámara no responde)
  const [configError, setConfigError] = useState<string | null>(null);
  const rejection = async (res: Response) => {
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    return typeof detail === 'string' ? detail : `El servidor rechazó la configuración (${res.status})`;
  };

  const handleStart = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      setConfigError(res.ok ? null : await rejection(res));
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
      // El servidor normaliza la configuración (ordena la escalera, ajusta el segmento al GOP, fija los fps)
      const applied = res.ok ? (await res.json()).config : null;
      if (applied) setConfig(applied);
      setConfigError(res.ok ? null : await rejection(res));
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
  // Con una campaña en marcha los reproductores de esta pestaña no se montan: compartirían la cola de emulación
  // con los del trabajador y falsearían sus medidas
  const campaign = serverStatus?.campaign;
  const campaignRunning = campaign?.state === 'running';

  // Cada reproductor se remonta cuando cambia el identificador de su emisión en el servidor, sea quien sea
  // quien la haya reiniciado (esta pestaña, otra, la API o el supervisor).
  const dashStreamId = serverStatus?.stream_ids?.dash ?? 0;
  const moqStreamId = serverStatus?.stream_ids?.moq ?? 0;
  const rtcStreamId = serverStatus?.stream_ids?.rtc ?? 0;
  useEffect(() => {
    startMeasureEpoch();
  }, [dashStreamId, moqStreamId, rtcStreamId]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-sans">
      <div className="max-w-[1800px] mx-auto space-y-6">
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
                  Doctorado en Streaming de Vídeo de Baja Latencia |{' '}
                  {serverStatus?.config.source === 'camera' ? `Cámara RTSP a ${serverStatus.config.fps} fps` : 'Big Buck Bunny 1080p60'}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-4 text-xs font-mono">
            <a href="/campaign" className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-indigo-300 hover:border-indigo-500">
              Campañas de medida
            </a>
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

        <VersionsPanel report={versions} />

        {campaignRunning && (
          <div className="px-4 py-3 rounded-xl border border-amber-500/40 bg-amber-950/40 text-xs text-amber-200">
            Campaña de medida en marcha (<span className="font-semibold">{campaign.name}</span>): la emisión y la red las lleva ella y los
            reproductores de esta pestaña no se montan, para no compartir la red emulada con los del trabajador.{' '}
            <a href="/campaign" className="underline hover:text-white">Ir a la campaña</a>
          </div>
        )}

        {serverStatus?.campaign_preview && (
          <div className="px-4 py-3 rounded-xl border border-sky-500/40 bg-sky-950/40 text-xs text-sky-200">
            Vista previa de la prueba <span className="font-mono">{serverStatus.campaign_preview.run}</span> abierta en la página de campañas: la red y
            la emisión son las de esa prueba hasta que se cierre, y entonces vuelven a como estaban.{' '}
            <a href="/campaign" className="underline hover:text-white">Ir a la campaña</a>
          </div>
        )}

        {/* Panel de Mandos */}
        <ControlPanel
          status={serverStatus}
          config={config}
          isLoading={isLoading}
          onConfigChange={setConfig}
          onStart={handleStart}
          onStop={handleStop}
          onApplyConfig={handleApplyConfig}
          error={configError}
          apiBase={API_BASE}
        />

        {/* Emulación de red, igual para las tres ramas */}
        <NetworkPanel network={serverStatus?.network} ipRates={ipRates()} isLoading={isLoading} onApply={handleApplyNetwork} />

        {/* Reproductores activos: se pueden probar por separado o comparar de dos en dos */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400 font-medium mr-1">Reproductores:</span>
          {PLAYER_IDS.map((id) => {
            const on = players[id];
            const last = on && PLAYER_IDS.filter((p) => players[p]).length === 1;
            const style = { dash: 'border-blue-600 bg-blue-900/50 text-blue-200', moq: 'border-emerald-600 bg-emerald-900/50 text-emerald-200', rtc: 'border-amber-600 bg-amber-900/50 text-amber-200' }[id];
            return (
              <button
                key={id}
                onClick={() => togglePlayer(id)}
                disabled={last}
                title={last ? 'Tiene que quedar al menos un reproductor activo' : on ? 'Desactivar: se cierra su conexión y deja de descargar' : 'Activar'}
                className={`px-3 py-1 rounded-lg border font-medium transition-colors ${on ? style : 'border-slate-700 bg-slate-900 text-slate-500 hover:text-slate-300'} ${last ? 'cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {{ dash: 'LL-DASH', moq: 'MoQ', rtc: 'WebRTC' }[id]} {on ? '· activo' : '· apagado'}
              </button>
            );
          })}
          <span className="text-slate-500 ml-2">Activar o apagar uno empieza un tramo de medida nuevo.</span>

          {/* Sonido: un solo reproductor a la vez, para no mezclarlos */}
          <span className="text-slate-400 font-medium ml-auto mr-1">Sonido:</span>
          {([null, ...PLAYER_IDS] as (PlayerId | null)[]).map((id) => {
            const unavailable = id !== null && (!players[id] || (id === 'rtc' && !rtcAudio));
            const selected = audioPlayer === id;
            return (
              <button
                key={id ?? 'none'}
                onClick={() => setAudioPlayer(id)}
                disabled={unavailable}
                title={
                  id === 'rtc' && !rtcAudio
                    ? 'La rama WebRTC va sin audio: actívalo en el panel de control (Audio en WebRTC)'
                    : id !== null && !players[id]
                      ? 'Reproductor apagado'
                      : undefined
                }
                className={`px-2.5 py-1 rounded-lg border transition-colors ${
                  selected ? 'border-indigo-500 bg-indigo-900/50 text-indigo-200' : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                } ${unavailable ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {id === null ? 'Ninguno' : { dash: 'LL-DASH', moq: 'MoQ', rtc: 'WebRTC' }[id]}
              </button>
            );
          })}
        </div>

        {/* Reproductores lado a lado */}
        <div className={`grid gap-4 ${gridCols(players)}`}>
          {players.dash && !campaignRunning && <DashPlayer
            key={`dash-${dashStreamId}`}
            url={serverStatus?.dash_url || '/media/dash/manifest.mpd'}
            timecodes={serverStatus?.timecodes}
            renditions={serverStatus?.config.renditions}
            isStreaming={isStreaming}
            audible={audioPlayer === 'dash'}
            onMetricsUpdate={(m) => setDashMetrics((prev) => ({ ...prev, ...m }))}
          />}

          {players.moq && !campaignRunning && <MoqPlayer
            key={`moq-${moqStreamId}`}
            url={`https://${serverStatus?.moq_host || window.location.hostname}:${serverStatus?.moq_port ?? 4433}/anon`}
            spkiFingerprint={serverStatus?.spki_fingerprint}
            timecodes={serverStatus?.timecodes}
            renditions={serverStatus?.config.renditions}
            isStreaming={isStreaming}
            audible={audioPlayer === 'moq'}
            onMetricsUpdate={(m) => setMoqMetrics((prev) => ({ ...prev, ...m }))}
          />}

          {players.rtc && !campaignRunning && <RtcPlayer
            key={`rtc-${rtcStreamId}`}
            timecodes={serverStatus?.timecodes}
            isStreaming={isStreaming}
            withAudio={rtcAudio}
            streamStartedMs={rtcStreamId}
            audible={audioPlayer === 'rtc'}
            onMetricsUpdate={(m) => setRtcMetrics((prev) => ({ ...prev, ...m }))}
          />}
        </div>

        {/* Recorrido de un frame con la latencia medida en cada etapa */}
        <PipelineDiagram
          players={players}
          stages={{ dash: dashMetrics.stages, moq: moqMetrics.stages, rtc: rtcMetrics.stages }}
          latency={{ dash: dashMetrics.latencyMs, moq: moqMetrics.latencyMs, rtc: rtcMetrics.latencyMs }}
        />

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
            rtcMetrics={rtcMetrics}
            players={players}
            history={history}
            samples={samplesRef.current.filter((r) => r.epoch === measureEpoch)}
            anomalies={serverStatus?.ingest_anomalies}
            pipelineRestarts={serverStatus?.restarts}
            availabilityDriftMs={serverStatus?.dash_availability_drift_ms}
            onExport={handleExport}
            onReset={handleResetSamples}
          />
        </div>

        {/* Prueba de QoE: grabación en el servidor, lo que pinta cada reproductor, VMAF y LL-GABR */}
        <QoEPanel
          streaming={serverStatus?.status === 'running'}
          activePlayers={PLAYER_IDS.filter((p) => players[p])}
          onStopStream={handleStop}
        />
      </div>
    </div>
  );
}

export default App;
