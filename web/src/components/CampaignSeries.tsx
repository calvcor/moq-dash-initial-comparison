import React, { useEffect, useMemo, useState } from 'react';
import { Chart as ChartJS, LinearScale, PointElement, LineElement, Tooltip, Legend, type ChartDataset, type ChartOptions } from 'chart.js';
import { Line } from 'react-chartjs-2';
import type { Campaign, CampaignRun, PlayerId } from '../types';

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Legend);

// Segundo a segundo de varias pruebas superpuestas (README, 4.8): una gráfica por protocolo y una línea por
// prueba, cada una a todo el ancho (la evolución en el tiempo necesita eje horizontal); o, superpuestos, todos
// los protocolos en una sola, con el color de cada protocolo y todas sus pruebas en ese color. Con el contenido
// reiniciado en cada prueba el eje es el segundo del vídeo, el mismo en todas; si no, los segundos desde el
// inicio de la medida. El calentamiento va en trazo discontinuo.

const PLAYER_LABEL: Record<PlayerId, string> = { dash: 'LL-DASH', moq: 'MoQ', rtc: 'WebRTC' };
// Los colores de cada protocolo en todo el dashboard, para la gráfica superpuesta
const PLAYER_COLOR: Record<PlayerId, string> = { dash: '#3b82f6', moq: '#10b981', rtc: '#f59e0b' };

// Aquí la entidad es la prueba: paleta categórica en orden fijo (la de los protocolos ya distingue las gráficas)
const RUN_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const MAX_RUNS = RUN_COLORS.length;

const METRICS: Record<string, { label: string; unit: string; field: string }> = {
  g2g: { label: 'Glass-to-glass', unit: 'ms', field: 'g2g_ms' },
  kbps: { label: 'Bitrate de vídeo recibido', unit: 'kbit/s', field: 'kbps' },
  height: { label: 'Altura reproducida', unit: 'p', field: 'height' },
  stall: { label: 'Tiempo parado acumulado', unit: 'ms', field: 'stall_ms' },
  frametime: { label: 'Tiempo en pantalla p95', unit: 'ms', field: 'frametime_p95_ms' },
};

interface Series {
  aligned: 'source' | 'measure';
  rows: ({ t_s: number; phase: 'warmup' | 'measuring' } & Record<string, number | null | string>)[];
}

const GRID = '#334155';
const TICK = '#94a3b8';

export const CampaignSeries: React.FC<{ campaign: Campaign; runs: CampaignRun[] }> = ({ campaign, runs }) => {
  const plan = campaign.plan;
  const conditionOf = (r: CampaignRun) => (r.network === null ? 'control' : `${r.network}:${r.target}`);
  const conditionLabel = (key: string) => {
    if (key === 'control') return 'Pruebas de control';
    const [n, t] = key.split(':').map(Number);
    return `${plan.networks[n].label} · objetivo ${plan.targets[t].label}`;
  };
  const conditions = useMemo(() => [...new Set(runs.map(conditionOf))], [runs]);
  const [condition, setCondition] = useState(conditions[0] ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [metricKey, setMetricKey] = useState('g2g');
  const [overlay, setOverlay] = useState(false);
  const [data, setData] = useState<Record<string, Series>>({});
  const [error, setError] = useState<string | null>(null);
  const metric = METRICS[metricKey];

  // Al cambiar de condición se eligen sus pruebas (sus repeticiones), hasta el máximo de colores
  useEffect(() => {
    setSelected(runs.filter((r) => conditionOf(r) === condition).slice(0, MAX_RUNS).map((r) => r.id));
  }, [condition, runs]);

  useEffect(() => {
    if (!selected.length) return setData({});
    let cancelled = false;
    fetch(`/api/campaigns/${campaign.id}/series?runs=${selected.join(',')}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body) => {
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [campaign.id, selected.join(',')]);

  const toggle = (id: string) =>
    setSelected((all) => (all.includes(id) ? all.filter((x) => x !== id) : all.length < MAX_RUNS ? [...all, id] : all));

  const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
  const chosen = selected.filter((id) => byId[id]);
  const aligned = chosen.some((id) => data[id]?.aligned === 'measure') ? 'measure' : 'source';
  const players = plan.players.filter((p) => chosen.some((id) => byId[id].players.includes(p)));

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    scales: {
      x: {
        type: 'linear',
        grid: { color: GRID },
        ticks: { color: TICK },
        title: {
          display: true,
          color: TICK,
          text: aligned === 'source' ? 'Segundo del vídeo (desde que arranca la fuente)' : 'Segundos desde el inicio de la medida',
        },
      },
      y: {
        min: 0,
        grid: { color: GRID },
        ticks: { color: TICK },
        title: { display: true, text: `${metric.label} (${metric.unit})`, color: TICK },
      },
    },
    plugins: {
      legend: { labels: { color: '#cbd5e1', boxWidth: 12, boxHeight: 2 } },
      tooltip: {
        callbacks: {
          title: (items) => (items.length ? `${(items[0].raw as { x: number }).x.toFixed(0)} s` : ''),
          label: (ctx) => `${ctx.dataset.label}: ${(ctx.raw as { y: number }).y.toFixed(0)} ${metric.unit}`,
        },
      },
    },
  };

  // Superpuestos: una entrada de la leyenda por protocolo, que muestra u oculta todas sus pruebas
  const overlayOptions: ChartOptions<'line'> = {
    ...options,
    plugins: {
      ...options.plugins,
      legend: {
        labels: {
          color: '#cbd5e1',
          boxWidth: 12,
          boxHeight: 2,
          generateLabels: (chart) =>
            players.map((p) => {
              const indexes = chart.data.datasets.flatMap((d, i) => ((d as any).protocol === p ? [i] : []));
              return {
                text: PLAYER_LABEL[p],
                fillStyle: PLAYER_COLOR[p],
                strokeStyle: PLAYER_COLOR[p],
                fontColor: '#cbd5e1',
                lineWidth: 2,
                hidden: indexes.length > 0 && indexes.every((i) => !chart.isDatasetVisible(i)),
                datasetIndex: indexes[0],
                protocol: p,
              } as any;
            }),
        },
        onClick: (_e, item, legend) => {
          const chart = legend.chart;
          chart.data.datasets.forEach((d, i) => {
            if ((d as any).protocol === (item as any).protocol) chart.setDatasetVisibility(i, !!item.hidden);
          });
          chart.update();
        },
      },
    },
  };

  const datasetsFor = (p: PlayerId, together = false): ChartDataset<'line'>[] =>
    chosen
      .filter((id) => byId[id].players.includes(p))
      .map((id) => {
        const color = together ? PLAYER_COLOR[p] : RUN_COLORS[selected.indexOf(id) % RUN_COLORS.length];
        const points = (data[id]?.rows ?? [])
          .map((row) => ({ x: row.t_s, y: row[`${p}_${metric.field}`] as number | null, phase: row.phase }))
          .filter((pt) => pt.y !== null && pt.y !== undefined);
        return {
          label: together ? `${PLAYER_LABEL[p]}, ${id} (rep. ${byId[id].rep + 1})` : `${id} (rep. ${byId[id].rep + 1})`,
          protocol: p,
          data: points as any,
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          // Sin medida no se une: un hueco es un segundo sin latencia, no un valor intermedio
          spanGaps: false,
          segment: { borderDash: (ctx: any) => (ctx.p0.raw?.phase === 'warmup' ? [4, 4] : undefined) },
        };
      });

  if (!runs.length) return null;

  return (
    <div className="space-y-3 pt-2">
      <h4 className="text-xs font-semibold text-slate-200">Segundo a segundo</h4>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">Condición</span>
          <select className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" value={condition} onChange={(e) => setCondition(e.target.value)}>
            {conditions.map((c) => (
              <option key={c} value={c}>
                {conditionLabel(c)}
              </option>
            ))}
          </select>
        </label>
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
        <label className="flex items-center gap-1.5 pb-1 text-slate-300">
          <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
          Superponer los protocolos
        </label>
        <span className="text-slate-500 pb-1">
          {plan.content === 'restart'
            ? 'Contenido reiniciado en cada prueba: el mismo segundo del eje es el mismo tramo del vídeo en todas.'
            : 'Contenido continuo: cada prueba ve un tramo distinto del bucle; el eje solo alinea el inicio de la medida.'}{' '}
          Discontinuo: calentamiento. Hasta {MAX_RUNS} pruebas.
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {runs
          .filter((r) => conditionOf(r) === condition || selected.includes(r.id))
          .map((r) => (
            <label key={r.id} className="flex items-center gap-1 text-slate-300">
              <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
              <span className="font-mono">{r.id}</span>
              <span className="text-slate-500">rep. {r.rep + 1}</span>
            </label>
          ))}
      </div>
      {error && <p className="text-rose-400">No se pudieron leer las series: {error}</p>}
      {overlay ? (
        <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
          <h4 className="text-xs font-medium text-slate-300 mb-2">{players.map((p) => PLAYER_LABEL[p]).join(', ')}: una línea por prueba, con el color del protocolo</h4>
          <div className="h-[28rem]">
            <Line data={{ datasets: players.flatMap((p) => datasetsFor(p, true)) }} options={overlayOptions} />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {players.map((p) => (
            <div key={p} className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
              <h4 className="text-xs font-medium text-slate-300 mb-2">{PLAYER_LABEL[p]}</h4>
              <div className="h-80">
                <Line data={{ datasets: datasetsFor(p) }} options={options} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
