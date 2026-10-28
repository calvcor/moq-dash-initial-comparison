import React, { useMemo, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  type ChartDataset,
  type ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import type { Campaign, CampaignRun, PlayerId } from '../types';
import { CampaignSeries } from './CampaignSeries';

ChartJS.register(CategoryScale, LinearScale, LogarithmicScale, PointElement, LineElement, Tooltip, Legend);

// Resultados de una campaña (README, 4.8): una gráfica por condición de red o por latencia objetivo, con un
// punto por prueba válida (cada repetición) y una línea por la mediana de las repeticiones. Solo pruebas
// terminadas y válidas; las de control van aparte, en orden de ejecución, para ver la deriva del sistema.

// Los colores de cada protocolo en todo el dashboard (el color sigue a la entidad); la forma del punto es la
// segunda codificación, para no depender solo del color
const STYLE: Record<PlayerId, { label: string; color: string; point: 'circle' | 'triangle' | 'rect' }> = {
  dash: { label: 'LL-DASH', color: '#3b82f6', point: 'circle' },
  moq: { label: 'MoQ', color: '#10b981', point: 'triangle' },
  rtc: { label: 'WebRTC', color: '#f59e0b', point: 'rect' },
};

interface Metric {
  label: string;
  unit: string;
  get: (s: Record<string, number | null>) => number | null;
  latency?: boolean; // se compara con la latencia objetivo
}

const METRICS: Record<string, Metric> = {
  g2g_p50: { label: 'Glass-to-glass p50', unit: 'ms', get: (s) => s.g2g_p50_ms, latency: true },
  g2g_p95: { label: 'Glass-to-glass p95', unit: 'ms', get: (s) => s.g2g_p95_ms, latency: true },
  stall: { label: 'Tiempo parado', unit: '%', get: (s) => (s.stall_ratio == null ? null : s.stall_ratio * 100) },
  coverage: { label: 'Segundos con latencia medida', unit: '%', get: (s) => (s.coverage == null ? null : s.coverage * 100) },
  kbps: { label: 'Bitrate de vídeo recibido', unit: 'kbit/s', get: (s) => s.kbps_mean },
  height: { label: 'Altura media reproducida', unit: 'p', get: (s) => s.height_mean },
  switches: { label: 'Cambios de calidad', unit: '', get: (s) => s.quality_switches },
  frametime: { label: 'Tiempo en pantalla p95 (mediana)', unit: 'ms', get: (s) => s.frametime_p95_ms_median },
  startup: { label: 'Del montaje a la primera latencia', unit: 's', get: (s) => s.first_g2g_s },
  skipped: { label: 'Contenido no reproducido', unit: '%', get: (s) => (s.content_skipped_share == null ? null : s.content_skipped_share * 100) },
  content: { label: 'Avance del contenido medio', unit: '×', get: (s) => s.content_speed_mean },
  // Solo DASH: las demás ramas no cambian la velocidad del vídeo
  rate: { label: 'Velocidad de reproducción media (DASH)', unit: '×', get: (s) => s.playback_rate_mean },
  slow: { label: 'Tiempo frenando, por debajo de 1× (DASH)', unit: '%', get: (s) => (s.playback_slow_share == null ? null : s.playback_slow_share * 100) },
  fast: { label: 'Tiempo acelerando, por encima de 1× (DASH)', unit: '%', get: (s) => (s.playback_fast_share == null ? null : s.playback_fast_share * 100) },
};

const median = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const GRID = '#334155';
const TICK = '#94a3b8';

function chartOptions(metric: Metric, log: boolean, xTitle: string): ChartOptions<'line'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', intersect: false },
    scales: {
      x: { type: 'category', grid: { color: GRID }, ticks: { color: TICK }, title: { display: true, text: xTitle, color: TICK } },
      y: {
        type: log ? 'logarithmic' : 'linear',
        min: log ? undefined : 0,
        grid: { color: GRID },
        ticks: { color: TICK },
        title: { display: true, text: metric.unit ? `${metric.label} (${metric.unit})` : metric.label, color: TICK },
      },
    },
    plugins: {
      legend: { labels: { color: '#cbd5e1', usePointStyle: true, filter: (item) => !String(item.text).startsWith('·') } },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const raw = ctx.raw as { y: number; rep?: number; run?: string };
            const value = `${raw.y.toFixed(metric.unit === 'ms' || metric.unit === 'kbit/s' ? 0 : metric.unit === '×' ? 3 : 1)}${metric.unit ? ` ${metric.unit}` : ''}`;
            const name = String(ctx.dataset.label).replace(/^· /, '');
            return raw.run ? `${name}, ${raw.run} (rep. ${(raw.rep ?? 0) + 1}): ${value}` : `${name}: ${value}`;
          },
        },
      },
    },
  };
}

/** Datasets de una gráfica: por protocolo, la mediana (línea) y cada prueba (puntos sueltos). */
function datasets(
  runs: CampaignRun[],
  players: PlayerId[],
  xOf: (run: CampaignRun) => string,
  categories: string[],
  metric: Metric,
): ChartDataset<'line'>[] {
  const out: ChartDataset<'line'>[] = [];
  for (const p of players) {
    const points = runs
      .filter((r) => r.players.includes(p) && r.summary?.players[p])
      .map((r) => ({ x: xOf(r), y: metric.get(r.summary!.players[p]!), rep: r.rep, run: r.id }))
      .filter((pt): pt is { x: string; y: number; rep: number; run: string } => pt.y !== null && pt.y !== undefined);
    const st = STYLE[p];
    const medians = categories
      .map((c) => {
        const ys = points.filter((pt) => pt.x === c).map((pt) => pt.y);
        return ys.length ? { x: c, y: median(ys) } : null;
      })
      .filter(Boolean) as { x: string; y: number }[];
    out.push({
      label: st.label,
      data: medians as any,
      borderColor: st.color,
      backgroundColor: st.color,
      borderWidth: 2,
      pointStyle: st.point,
      pointRadius: 5,
      pointHoverRadius: 7,
    });
    out.push({
      label: `· ${st.label}`,
      data: points as any,
      showLine: false,
      borderColor: st.color,
      backgroundColor: `${st.color}55`,
      pointStyle: st.point,
      pointRadius: 3,
      pointHoverRadius: 6,
    });
  }
  return out;
}

const Panel: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
    <h4 className="text-xs font-medium text-slate-300 mb-2">{title}</h4>
    <div className="h-64">{children}</div>
  </div>
);

export const CampaignResults: React.FC<{ campaign: Campaign }> = ({ campaign }) => {
  const plan = campaign.plan;
  const [metricKey, setMetricKey] = useState('g2g_p50');
  const [xAxis, setXAxis] = useState<'network' | 'target'>('network');
  const [log, setLog] = useState(false);
  const metric = METRICS[metricKey];

  const valid = useMemo(() => (campaign.runs ?? []).filter((r) => r.state === 'done' && r.summary), [campaign.runs]);
  const tests = valid.filter((r) => r.kind === 'test');
  const controls = valid.filter((r) => r.kind === 'control').sort((a, b) => (a.started_ms ?? 0) - (b.started_ms ?? 0));
  const players = plan.players;

  if (!valid.length) return <p className="text-slate-500">Todavía no hay pruebas terminadas y válidas.</p>;

  // Una gráfica por valor del otro factor; en el eje, las condiciones de red o los objetivos en el orden del plan
  const networkLabels = plan.networks.map((n) => n.label);
  const targetLabels = plan.targets.map((t) => t.label);
  const categories = xAxis === 'network' ? networkLabels : targetLabels;
  const facets = xAxis === 'network' ? plan.targets.map((_, i) => i) : plan.networks.map((_, i) => i);
  const xOf = (r: CampaignRun) => (xAxis === 'network' ? networkLabels[r.network!] : targetLabels[r.target]);
  const options = chartOptions(metric, log, xAxis === 'network' ? 'Condición de red' : 'Latencia objetivo');

  // Línea del objetivo pedido, si es la misma en los tres reproductores y numérica (en auto no hay valor que pintar)
  const targetLine = (targetIdx: number[]): ChartDataset<'line'> | null => {
    if (!metric.latency) return null;
    const data = categories
      .map((c, i) => {
        const t = plan.targets[xAxis === 'network' ? targetIdx[0] : i];
        const same = t.dash_ms === t.moq_ms && t.moq_ms === t.rtc_ms;
        return same && t.dash_ms !== null ? { x: c, y: t.dash_ms } : null;
      })
      .filter(Boolean);
    if (!data.length) return null;
    // Un trazo horizontal en cada categoría: con un solo objetivo numérico no habría línea que ver
    return {
      label: 'Objetivo pedido',
      data: data as any,
      borderColor: '#94a3b8',
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointStyle: 'line',
      pointRadius: 10,
      pointBorderWidth: 2,
      backgroundColor: '#94a3b8',
    };
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">Métrica</span>
          <select className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
            {Object.entries(METRICS).map(([k, m]) => (
              <option key={k} value={k}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">En el eje horizontal</span>
          <select className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" value={xAxis} onChange={(e) => setXAxis(e.target.value as 'network' | 'target')}>
            <option value="network">Condición de red (una gráfica por objetivo)</option>
            <option value="target">Latencia objetivo (una gráfica por condición de red)</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 pb-1 text-slate-300">
          <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />
          Escala logarítmica
        </label>
        <span className="text-slate-500 pb-1">
          Línea: mediana de las repeticiones; puntos: cada prueba válida ({tests.length} de prueba, {controls.length} de control).
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {facets.map((f) => {
          const runs = tests.filter((r) => (xAxis === 'network' ? r.target === f : r.network === f));
          if (!runs.length) return null;
          const ds = datasets(runs, players, xOf, categories, metric);
          const line = targetLine([f]);
          return (
            <Panel key={f} title={xAxis === 'network' ? `Objetivo ${targetLabels[f]}` : networkLabels[f]}>
              <Line data={{ labels: categories, datasets: line ? [...ds, line] : ds }} options={options} />
            </Panel>
          );
        })}
        {controls.length > 0 && (
          <Panel title="Pruebas de control (sin restricción), en orden de ejecución: deriva del sistema">
            <Line
              data={{
                labels: controls.map((r) => r.id),
                datasets: datasets(controls, players, (r) => r.id, controls.map((r) => r.id), metric),
              }}
              options={chartOptions(metric, log, 'Prueba de control')}
            />
          </Panel>
        )}
      </div>

      <CampaignSeries campaign={campaign} runs={[...tests, ...controls]} />
    </div>
  );
};
