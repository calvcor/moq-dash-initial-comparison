import React, { useEffect, useMemo, useState } from 'react';
import { Chart as ChartJS, LinearScale, PointElement, LineElement, Tooltip, Legend, type ChartDataset, type ChartOptions, type Plugin } from 'chart.js';
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

// source 'ip': de las lecturas del router que hace el servidor cada segundo, no de las filas del navegador
const METRICS: Record<string, { label: string; unit: string; field: string; only?: PlayerId; source?: 'ip' }> = {
  g2g: { label: 'Glass-to-glass', unit: 'ms', field: 'g2g_ms' },
  kbps: { label: 'Bitrate de vídeo recibido', unit: 'kbit/s', field: 'kbps' },
  ip_down: { label: 'Tráfico IP de bajada en el router', unit: 'kbit/s', field: 'ip_down_kbps', source: 'ip' },
  ip_up: { label: 'Tráfico IP de subida en el router', unit: 'kbit/s', field: 'ip_up_kbps', source: 'ip' },
  height: { label: 'Altura reproducida', unit: 'p', field: 'height' },
  stall: { label: 'Tiempo parado acumulado', unit: 'ms', field: 'stall_ms' },
  frametime: { label: 'Tiempo en pantalla p95', unit: 'ms', field: 'frametime_p95_ms' },
  // Según el timecode, en las tres ramas: ms de la fuente por ms reales y ms de la fuente que no se pintaron
  content: { label: 'Avance del contenido', unit: '×', field: 'content_speed' },
  skipped: { label: 'Contenido no reproducido en cada segundo', unit: 'ms', field: 'content_skipped_ms' },
  // Media de cada segundo; solo DASH cambia la velocidad del vídeo
  rate: { label: 'Velocidad de reproducción', unit: '×', field: 'playback_rate', only: 'dash' },
};

interface Series {
  aligned: 'source' | 'measure';
  zero_ms?: number; // el cero del eje en reloj del servidor
  rows: ({ t_s: number; phase: 'warmup' | 'measuring' } & Record<string, number | null | string>)[];
  ip?: Series['rows']; // tráfico IP de cada intervalo; t_s es su final
}

// Sombreado de los parones: cada parón como una franja vertical del color de su línea, de su inicio a su fin
// exactos (stall_spans, que el medidor anota desde el 28-10-2026). En pruebas anteriores solo está el contador
// de cada fila: entonces se sombrea cada segundo con tiempo parado, más opaco cuanto mayor la fracción del
// segundo parada, porque no se sabe en qué parte del segundo fue. Con los
// protocolos superpuestos, franjas de alto completo de tres colores se mezclarían: cada protocolo va entonces en
// su propio carril, una banda estrecha en lo alto de la gráfica.
type StallSpan = [number, number, number]; // [desde, hasta (s del eje), fracción parada; 1 si es exacto]

/** Parones de un reproductor en una prueba; exact dice si son los intervalos del medidor o la aproximación por segundo. */
function stallSpans(series: Series | undefined, player: PlayerId): { spans: StallSpan[]; exact: boolean } {
  const rows = series?.rows ?? [];
  const zero = series?.zero_ms;
  // Las filas con medidor nuevo traen el campo como texto (vacío si no hubo parón); las anteriores, null
  if (zero !== undefined && rows.some((r) => typeof r[`${player}_stall_spans`] === 'string')) {
    const spans: StallSpan[] = [];
    for (const row of rows) {
      for (const part of String(row[`${player}_stall_spans`] ?? '').split(';')) {
        const [a, b] = part.split('-').map(Number);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) spans.push([(a - zero) / 1000, (b - zero) / 1000, 1]);
      }
    }
    // El parón que seguía abierto en la última fila llega hasta ella
    const last = rows[rows.length - 1];
    const open = last?.[`${player}_stall_open_since_ms`] as number | null | undefined;
    if (last && open != null) spans.push([(open - zero) / 1000, last.t_s, 1]);
    return { spans, exact: true };
  }
  return { spans: bySecond(rows, player), exact: false };
}

function bySecond(rows: Series['rows'], player: PlayerId): StallSpan[] {
  const out: StallSpan[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1][`${player}_stall_ms`] as number | null;
    const b = rows[i][`${player}_stall_ms`] as number | null;
    const dt = rows[i].t_s - rows[i - 1].t_s;
    if (a == null || b == null || dt <= 0 || b <= a) continue;
    out.push([rows[i - 1].t_s, rows[i].t_s, Math.min(1, (b - a) / (dt * 1000))]);
  }
  return out;
}

const LANE_PX = 10;

const shadeStalls: Plugin<'line'> = {
  id: 'shadeStalls',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
    ctx.clip();
    chart.data.datasets.forEach((d, i) => {
      const spans = (d as any).stalls as StallSpan[] | undefined;
      if (!spans || !chart.isDatasetVisible(i)) return;
      const lane = (d as any).stallLane as number | undefined;
      const exact = !!(d as any).stallsExact;
      const top = lane === undefined ? chartArea.top : chartArea.top + lane * (LANE_PX + 2);
      const height = lane === undefined ? chartArea.height : LANE_PX;
      ctx.fillStyle = d.borderColor as string;
      for (const [x0, x1, frac] of spans) {
        ctx.globalAlpha = exact ? (lane === undefined ? 0.28 : 0.85) : lane === undefined ? 0.12 + 0.3 * frac : 0.25 + 0.75 * frac;
        const left = scales.x.getPixelForValue(x0);
        ctx.fillRect(left, top, scales.x.getPixelForValue(x1) - left, height);
      }
    });
    ctx.restore();
  },
};

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
  const [shade, setShade] = useState(true);
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
  const players = plan.players.filter((p) => (!metric.only || metric.only === p) && chosen.some((id) => byId[id].players.includes(p)));
  // El eje abarca todas las filas de las pruebas elegidas, tengan medida o no: un reproductor con pocos puntos
  // no encoge su gráfica, y todas comparten escala
  const times = chosen.flatMap((id) => (data[id]?.rows ?? []).map((r) => r.t_s));
  const xMin = times.length ? Math.floor(Math.min(...times)) : undefined;
  const xMax = times.length ? Math.ceil(Math.max(...times)) : undefined;

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    scales: {
      x: {
        type: 'linear',
        min: xMin,
        max: xMax,
        grid: { color: GRID },
        ticks: { color: TICK },
        title: {
          display: true,
          color: TICK,
          text: aligned === 'source' ? 'Segundo del vídeo (desde que arranca la fuente)' : 'Segundos desde el inicio de la medida',
        },
      },
      y: {
        // La velocidad oscila alrededor de 1×: desde 0 no se verían sus cambios
        min: metric.unit === '×' ? undefined : 0,
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
          label: (ctx) => {
            const y = (ctx.raw as { y: number | null }).y;
            return `${ctx.dataset.label}: ${y === null ? '--' : `${y.toFixed(metric.unit === '×' ? 3 : 0)} ${metric.unit}`}`;
          },
        },
      },
    },
  };

  // Superpuestos: una entrada de la leyenda por protocolo, que muestra u oculta todas sus pruebas. Los carriles de
  // los parones ocupan lo alto de la gráfica: el eje y deja ese hueco por encima de las líneas
  const overlayOptions: ChartOptions<'line'> = {
    ...options,
    scales: {
      ...options.scales,
      y: { ...(options.scales!.y as any), grace: shade ? '12%' : 0 },
    },
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
        // Los segundos sin valor se quedan como y: null, para que la línea se corte ahí (spanGaps: false)
        const points = ((metric.source === 'ip' ? data[id]?.ip : data[id]?.rows) ?? []).map((row) => ({ x: row.t_s, y: (row[`${p}_${metric.field}`] as number | null) ?? null, phase: row.phase }));
        return {
          label: together ? `${PLAYER_LABEL[p]}, ${id} (rep. ${byId[id].rep + 1})` : `${id} (rep. ${byId[id].rep + 1})`,
          protocol: p,
          ...(() => {
            if (!shade) return {};
            const { spans, exact } = stallSpans(data[id], p);
            return { stalls: spans, stallsExact: exact };
          })(),
          stallLane: together ? players.indexOf(p) : undefined,
          data: points as any,
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          // Un segundo con medida entre dos sin ella no forma línea: se pinta como punto para que no desaparezca
          pointRadius: (ctx: any) => {
            const i = ctx.dataIndex;
            const isolated = points[i]?.y !== null && points[i - 1]?.y == null && points[i + 1]?.y == null;
            return isolated ? 2.5 : 0;
          },
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
        <label className="flex items-center gap-1.5 pb-1 text-slate-300" title="Cada parón como una franja vertical del color de su línea, de su inicio a su fin exactos (con los protocolos superpuestos, un carril por protocolo en lo alto de la gráfica). En pruebas medidas antes del 28-10-2026 no hay intervalos: se sombrea cada segundo con tiempo parado, más opaco cuanto más del segundo estuvo parado">
          <input type="checkbox" checked={shade} onChange={(e) => setShade(e.target.checked)} />
          Sombrear los parones
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
          <h4 className="text-xs font-medium text-slate-300 mb-2">{players.map((p) => PLAYER_LABEL[p]).join(', ')}: una línea por prueba, con el color del protocolo{shade && players.length > 1 && <span className="text-slate-500 font-normal"> · arriba, un carril de parones por protocolo, en el orden de la leyenda</span>}</h4>
          <div className="h-[28rem]">
            <Line data={{ datasets: players.flatMap((p) => datasetsFor(p, true)) }} options={overlayOptions} plugins={[shadeStalls]} />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {players.map((p) => (
            <div key={p} className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
              <h4 className="text-xs font-medium text-slate-300 mb-2">{PLAYER_LABEL[p]}</h4>
              <div className="h-80">
                <Line data={{ datasets: datasetsFor(p) }} options={options} plugins={[shadeStalls]} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
