import React, { useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { Info } from 'lucide-react';
import { getClockSync } from '../lib/clock';
import type { PlayerMetrics, SampleRow } from '../types';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

interface MetricsDashboardProps {
  dashMetrics: PlayerMetrics;
  moqMetrics: PlayerMetrics;
  rtcMetrics: PlayerMetrics;
  history: {
    labels: string[];
    dashLatency: (number | null)[];
    moqLatency: (number | null)[];
    dashBitrate: (number | null)[];
    moqBitrate: (number | null)[];
    rtcLatency: (number | null)[];
    rtcBitrate: (number | null)[];
  };
  samples: SampleRow[];
  anomalies?: { master: number; dash: number; moq: number; rtc: number };
  availabilityDriftMs?: number | null;
  pipelineRestarts?: { master: number; dash: number; moq: number; rtc: number };
  onExport: () => void;
  onReset: () => void;
}

const WARMUP_S = 10; // arranque y catch-up inicial, fuera de los estadísticos

const fmt = (value: number | null, unit: string) => (value === null ? '--' : `${value} ${unit}`);

// Estadísticos de latencia glass-to-glass sobre las muestras del epoch actual
function summarize(values: (number | null)[]) {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (v.length < 2) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, mean: Math.round(mean), sd: Math.round(sd), p50: q(0.5), p95: q(0.95), min: v[0], max: v[v.length - 1] };
}

const Stat: React.FC<{ label: string; value: string; accent?: boolean; wide?: boolean; hint?: React.ReactNode }> = ({
  label,
  value,
  accent,
  wide,
  hint,
}) => (
  <div className={`group relative bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80 ${wide ? 'col-span-2' : ''} ${hint ? 'cursor-help' : ''}`}>
    <span className="text-xs text-slate-400 flex items-center justify-center gap-1 mb-0.5">
      {label}
      {hint && <Info className="w-3 h-3 text-slate-500" />}
    </span>
    <span className={`text-lg font-bold ${accent ? 'text-emerald-400' : 'text-slate-200'}`}>{value}</span>
    {hint && (
      <div className="pointer-events-none absolute z-10 left-1/2 -translate-x-1/2 top-full mt-1 w-72 hidden group-hover:block bg-slate-800 border border-slate-600 rounded-lg p-3 text-left text-[11px] leading-snug text-slate-200 shadow-xl space-y-1.5">
        {hint}
      </div>
    )}
  </div>
);

const VIDEO_HINT = (
  <p>Solo la carga útil de vídeo que entrega el reproductor, media de 10 s. Sin audio, manifiesto ni cabeceras de protocolo.</p>
);

const LAYER_WARNING = (
  <p className="text-amber-300">
    Cada protocolo se cuenta en una capa distinta: la comparación entre ambos es orientativa. No es el ancho de banda real en la red.
  </p>
);

const DASH_NETWORK_HINT = (
  <>
    <p>
      <b>Qué mide:</b> tamaño transferido de todas las peticiones HTTP al servidor DASH (vídeo, audio y manifiesto), con sus cabeceras HTTP de
      respuesta. Media de 10 s.
    </p>
    <p>
      <b>Fuente:</b> Resource Timing API del navegador (<code>transferSize</code>). Se actualiza al terminar cada petición, es decir, una vez por
      segmento.
    </p>
    <p>
      <b>No incluye:</b> cabeceras de las peticiones, sobrecarga TCP/IP ni retransmisiones TCP.
    </p>
    {LAYER_WARNING}
  </>
);

const MOQ_TRANSPORT_HINT = (
  <>
    <p>
      <b>Qué mide:</b> bytes recibidos por la conexión WebTransport en streams y datagramas (vídeo, audio, catálogo y señalización MoQ), duplicados
      incluidos. Media de 10 s.
    </p>
    <p>
      <b>Fuente:</b> <code>WebTransport.getStats()</code> (<code>bytesReceived</code>), muestreado cada 500 ms.
    </p>
    <p>
      <b>No incluye:</b> cabeceras QUIC, UDP/IP, cifrado ni paquetes de control (ACK).
    </p>
    {LAYER_WARNING}
  </>
);

const MOQ_PAYLOAD_HINT = (
  <>
    <p>
      <b>Qué mide:</b> carga útil de las pistas que descarga el reproductor: vídeo y, solo si no está silenciado, audio. Media de 10 s.
    </p>
    <p>
      <b>Fuente:</b> contadores de <code>@moq/watch</code>, porque este navegador no implementa <code>WebTransport.getStats()</code>.
    </p>
    <p>
      <b>No incluye:</b> tramas MoQ, catálogo, cabeceras QUIC, UDP/IP, cifrado ni retransmisiones.
    </p>
    <p>Silenciado, MoQ no descarga el audio; DASH lo descarga siempre. Parte de la diferencia entre ambos es eso.</p>
    {LAYER_WARNING}
  </>
);

const RTC_NETWORK_HINT = (
  <>
    <p>
      <b>Qué mide:</b> bytes recibidos por el transporte de la conexión WebRTC (RTP con el vídeo, RTCP y retransmisiones). Media de 10 s.
    </p>
    <p>
      <b>Fuente:</b> estadísticas del navegador (<code>RTCPeerConnection.getStats()</code>, transporte, <code>bytesReceived</code>).
    </p>
    <p>
      <b>No incluye:</b> cabeceras UDP/IP ni las comprobaciones de conectividad ICE. Esta rama no lleva audio.
    </p>
    {LAYER_WARNING}
  </>
);

const Telemetry: React.FC<{
  title: string;
  engine: string;
  color: string;
  bufferLabel: string;
  bufferHint?: React.ReactNode;
  networkHint: React.ReactNode;
  qualityHint: React.ReactNode;
  estimateHint: React.ReactNode;
  metrics: PlayerMetrics;
  stats: ReturnType<typeof summarize>;
}> = ({ title, engine, color, bufferLabel, bufferHint, networkHint, qualityHint, estimateHint, metrics, stats }) => (
  <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl">
    <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-800">
      <span className={`font-semibold text-sm ${color}`}>{title}</span>
      <span className="text-xs text-slate-500">{engine}</span>
    </div>
    <div className="grid grid-cols-2 gap-3 text-center">
      <Stat label="Latencia glass-to-glass" value={fmt(metrics.latencyMs, 'ms')} accent wide />
      <Stat label="Latencia según reproductor" value={fmt(metrics.reportedLatencyMs, 'ms')} />
      <Stat label="Frames presentados" value={fmt(metrics.fps, 'fps')} />
      <Stat
        label={`Calidad (${metrics.qualityMode === 'auto' ? 'auto' : 'fijada'})`}
        value={
          metrics.renditionHeight === null
            ? '--'
            : `${metrics.renditionHeight}p · ${metrics.renditionKbps ?? '--'} kbps` +
              (metrics.selectedHeight && metrics.selectedHeight !== metrics.renditionHeight ? ` (sel. ${metrics.selectedHeight}p)` : '')
        }
        wide
        hint={qualityHint}
      />
      <Stat label="Cambios de calidad" value={String(metrics.qualitySwitches)} />
      <Stat label="Ancho de banda estimado" value={fmt(metrics.bandwidthEstimateKbps, 'kbps')} hint={estimateHint} />
      <Stat label="Bitrate vídeo recibido" value={fmt(metrics.bitrateKbps, 'kbps')} hint={VIDEO_HINT} />
      <Stat label="Descarga total" value={fmt(metrics.networkKbps, 'kbps')} hint={networkHint} />
      <Stat label={bufferLabel} value={fmt(metrics.bufferLengthSec, 's')} hint={bufferHint} />
      <Stat label="Congelados" value={`${metrics.stalls} (${metrics.stallMs} ms)`} />
    </div>
    <p className="mt-3 text-[11px] font-mono text-slate-400">
      {stats
        ? `G2G n=${stats.n} · media ${stats.mean} · σ ${stats.sd} · p50 ${stats.p50} · p95 ${stats.p95} · min ${stats.min} · max ${stats.max} ms`
        : `G2G: esperando muestras (se descartan los primeros ${WARMUP_S} s)`}
    </p>
  </div>
);

export const MetricsDashboard: React.FC<MetricsDashboardProps> = ({
  dashMetrics,
  moqMetrics,
  rtcMetrics,
  history,
  samples,
  anomalies,
  availabilityDriftMs,
  pipelineRestarts,
  onExport,
  onReset,
}) => {
  const [metricTab, setMetricTab] = useState<'latency' | 'bitrate'>('latency');

  const steady = samples.filter((r) => r.elapsed_s >= WARMUP_S && !r.tab_hidden);
  const dashStats = summarize(steady.map((r) => r.dash_g2g_ms));
  const moqStats = summarize(steady.map((r) => r.moq_g2g_ms));
  const rtcStats = summarize(steady.map((r) => r.rtc_g2g_ms));
  const clock = getClockSync();
  const totalAnomalies = anomalies ? anomalies.master + anomalies.dash + anomalies.moq + (anomalies.rtc ?? 0) : 0;
  const serverRestarts = pipelineRestarts ? pipelineRestarts.master + pipelineRestarts.dash + pipelineRestarts.moq + (pipelineRestarts.rtc ?? 0) : 0;
  const playerRestarts = dashMetrics.restarts + moqMetrics.restarts + rtcMetrics.restarts;

  const latencyChartData = {
    labels: history.labels,
    datasets: [
      {
        label: 'LL-DASH Latencia G2G (ms)',
        data: history.dashLatency,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.5)',
        tension: 0.3,
      },
      {
        label: 'MoQ Latencia G2G (ms)',
        data: history.moqLatency,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.5)',
        tension: 0.3,
      },
      {
        label: 'WebRTC Latencia G2G (ms)',
        data: history.rtcLatency,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.5)',
        tension: 0.3,
      },
    ],
  };

  const bitrateChartData = {
    labels: history.labels,
    datasets: [
      {
        label: 'LL-DASH Bitrate Recibido (kbps)',
        data: history.dashBitrate,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.5)',
        tension: 0.3,
      },
      {
        label: 'MoQ Bitrate Recibido (kbps)',
        data: history.moqBitrate,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.5)',
        tension: 0.3,
      },
      {
        label: 'WebRTC Bitrate Recibido (kbps)',
        data: history.rtcBitrate,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.5)',
        tension: 0.3,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    scales: {
      y: {
        grid: { color: '#334155' },
        ticks: { color: '#94a3b8' },
      },
      x: {
        grid: { display: false },
        ticks: { color: '#94a3b8' },
      },
    },
    plugins: {
      legend: {
        labels: { color: '#cbd5e1', font: { size: 12 } },
      },
    },
  };

  return (
    <div className="space-y-4">
      {/* Tarjetas comparativas: mismas métricas y mismo método de medida en las tres ramas */}
      <div className="grid grid-cols-3 gap-4">
        <Telemetry
          title="Telemetría LL-DASH"
          engine="dash.js engine"
          color="text-blue-400"
          bufferLabel="Búfer local"
          networkHint={DASH_NETWORK_HINT}
          qualityHint={<p>Representación que reproduce dash.js y su bitrate declarado en el manifiesto. En auto decide su algoritmo ABR por defecto.</p>}
          estimateHint={<p>Caudal medio que dash.js mide en sus descargas de vídeo; es la entrada de su ABR. Con entrega chunked de baja latencia esta medida es poco precisa.</p>}
          metrics={dashMetrics}
          stats={dashStats}
        />
        <Telemetry
          title="Telemetría Media over QUIC"
          engine="WebTransport QUIC"
          color="text-emerald-400"
          bufferLabel="Búfer de jitter"
          bufferHint={
            <p>
              Tiempo medio que cada frame pasa retenido en el reproductor: desde que @moq/watch lo lee de la red hasta que lo entrega para
              pintarlo. Es la misma medida que en WebRTC, con una diferencia: aquí incluye la decodificación (1-2 ms por frame), que en
              WebRTC ocurre después del búfer.
            </p>
          }
          networkHint={moqMetrics.networkSource === 'transport' ? MOQ_TRANSPORT_HINT : MOQ_PAYLOAD_HINT}
          qualityHint={
            <p>
              Altura del frame que se está pintando y bitrate de la rendition seleccionada según el catálogo, que lo mide el publicador y sale
              más alto que el nominal. En auto decide @moq/watch sin intervención: la más alta cuyo bitrate quepa en el 80 % del ancho de banda
              estimado, descartando las que el publicador marca como atascadas. Cambia sin corte, así que durante un cambio la seleccionada y
              la pintada pueden no coincidir.
            </p>
          }
          estimateHint={<p>Tasa de recepción que estima el relay con su control de congestión y envía al reproductor (mensajes PROBE de MoQ).</p>}
          metrics={moqMetrics}
          stats={moqStats}
        />
        <Telemetry
          title="Telemetría WebRTC"
          engine="RTCPeerConnection"
          color="text-amber-400"
          bufferLabel="Búfer de jitter"
          bufferHint={
            <p>
              Tiempo medio que cada frame pasa en el búfer de jitter del navegador: desde que llega su primer paquete hasta que sale hacia el
              decodificador (<code>jitterBufferDelay / jitterBufferEmittedCount</code> de <code>getStats()</code>).
            </p>
          }
          networkHint={RTC_NETWORK_HINT}
          qualityHint={<p>Altura del vídeo recibido. WebRTC sirve siempre la calidad más alta de la escalera: en esta rama no hay adaptación.</p>}
          estimateHint={<p>No aplica: en esta rama no hay adaptación de calidad en el reproductor.</p>}
          metrics={rtcMetrics}
          stats={rtcStats}
        />
      </div>

      {/* Validez de la medida y exportación */}
      <div className="flex items-center justify-between bg-slate-900/90 border border-slate-800 px-4 py-2.5 rounded-xl text-[11px] font-mono">
        <div className="flex items-center space-x-4">
          <span className={clock && clock.rttMs < 10 ? 'text-slate-400' : 'text-amber-400'}>
            Reloj servidor: {clock ? `offset ${clock.offsetMs.toFixed(1)} ms · incertidumbre ±${(clock.rttMs / 2).toFixed(1)} ms` : 'sin sincronizar'}
          </span>
          <span className={totalAnomalies ? 'text-rose-400 font-bold' : 'text-slate-400'}>
            Anomalías de ingesta: {anomalies ? `${totalAnomalies} (fuente ${anomalies.master} · DASH ${anomalies.dash} · MoQ ${anomalies.moq} · WebRTC ${anomalies.rtc ?? 0})` : '--'}
          </span>
          <span className={Math.abs(availabilityDriftMs ?? 0) > 100 ? 'text-amber-400' : 'text-slate-400'}>
            Deriva disponibilidad DASH: {availabilityDriftMs == null ? '--' : `${availabilityDriftMs} ms`}
          </span>
          <span
            className={playerRestarts + serverRestarts ? 'text-amber-400' : 'text-slate-400'}
            title="Recuperaciones automáticas. Servidor: el supervisor relanzó la fuente o un empaquetador caído o colgado. Reproductores: llevaban 10 s sin imagen nueva y se recrearon."
          >
            Reinicios: servidor {pipelineRestarts ? serverRestarts : '--'} · DASH {dashMetrics.restarts} · MoQ {moqMetrics.restarts} · WebRTC {rtcMetrics.restarts}
          </span>
          <span className="text-slate-500">{samples.length} muestras</span>
        </div>
        <div className="flex items-center space-x-2 font-sans text-xs">
          <button onClick={onReset} className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer">
            Reiniciar medida
          </button>
          <button onClick={onExport} className="px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer">
            Exportar CSV
          </button>
        </div>
      </div>

      {/* Gráfica de evolución en tiempo real con selector de métrica */}
      <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-slate-300">
            {metricTab === 'latency'
              ? 'Evolución de Latencia Glass-to-Glass (ms)'
              : 'Evolución de Bitrate Recibido (kbps)'}
          </h4>
          <div className="flex space-x-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <button
              onClick={() => setMetricTab('latency')}
              className={`px-3 py-1 rounded transition-colors ${
                metricTab === 'latency'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Latencia (ms)
            </button>
            <button
              onClick={() => setMetricTab('bitrate')}
              className={`px-3 py-1 rounded transition-colors ${
                metricTab === 'bitrate'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Bitrate (kbps)
            </button>
          </div>
        </div>

        <div className="h-64 relative">
          {history.labels.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
              Recolectando datos de telemetría en tiempo real...
            </div>
          ) : (
            <Line
              data={metricTab === 'latency' ? latencyChartData : bitrateChartData}
              options={chartOptions}
            />
          )}
        </div>
      </div>
    </div>
  );
};
