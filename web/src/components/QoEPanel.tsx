// Prueba de QoE (LL-GABR + VMAF): lanzarla con los reproductores activos y ver su resultado.
// La prueba la orquesta lib/qoe.ts; el cálculo (índice, VMAF, traducción de lo pintado y QoE) lo hace el
// servidor (server/app/qoe.py). El VMAF solo se calcula con la emisión parada: el panel lo dice, y parar
// la emisión es decisión de quien mide.

import React, { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { Award, Download, Info, Play } from 'lucide-react';
import { runQoETest, type PlayerId } from '../lib/qoe';

interface QoETerms {
  quality: number;
  rebuffer_time: number;
  rebuffer_count: number;
  latency: number;
  speed: number | null;
  smoothness: number;
}

interface QoEBrief {
  qoe: number | null;
  T: number;
  excluded_steps: number;
  terms: QoETerms | null;
  inputs?: {
    vmaf_mean: number;
    rebuffer_s: number;
    rebuffer_count: number;
    latency_mean_s: number;
    speed_mean: number | null;
    vmaf_change_sum: number;
  };
  hidden: boolean;
}

interface ViewSummary {
  frames: number;
  matched: number;
  outside_recording: number;
  unmatched: number;
  skipped: number;
  rendition_switches: number;
  gaps: number;
  hidden: boolean;
}

interface Recording {
  id: string;
  state: 'recording' | 'indexing' | 'ready' | 'error';
  error: string | null;
  duration_s: number;
  source?: string;
  vmaf?: { state: 'queued' | 'running' | 'done' | 'error'; error?: string; note?: string | null };
  views?: Partial<Record<PlayerId, ViewSummary>>;
  qoe?: Partial<Record<PlayerId, QoEBrief>>;
}

interface QoEStep {
  t: number;
  included: boolean;
  vmaf?: number;
  rebuffer_s?: number;
  latency_s?: number;
  speed?: number | null;
  frames?: number;
}

const PLAYERS: { id: PlayerId; label: string; color: string; text: string }[] = [
  { id: 'dash', label: 'LL-DASH', color: '#3b82f6', text: 'text-blue-400' },
  { id: 'moq', label: 'MoQ', color: '#10b981', text: 'text-emerald-400' },
  { id: 'rtc', label: 'WebRTC', color: '#f59e0b', text: 'text-amber-400' },
];

const TERMS: { key: keyof QoETerms; label: string }[] = [
  { key: 'quality', label: 'Calidad (α·Σ vmaf/20)' },
  { key: 'rebuffer_time', label: 'Tiempo de parón (β)' },
  { key: 'rebuffer_count', label: 'Número de parones (γ)' },
  { key: 'latency', label: 'Latencia media (σ)' },
  { key: 'speed', label: 'Velocidad (μ)' },
  { key: 'smoothness', label: 'Suavidad (ω)' },
];

const DURATIONS = [15, 30, 60, 120, 300];

const fmt = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? '--' : v.toFixed(digits));

const HINT = (
  <div className="space-y-1.5">
    <p>
      Graba en el servidor el flujo codificado y anota lo que pinta cada reproductor activo. Con eso el servidor calcula el VMAF de cada frame
      pintado y la QoE de LL-GABR (ecuación 6, pasos de 1 s). Detalle y decisiones en el README, sección 4.7.
    </p>
    <p>
      El registro empieza tras el margen, para que los primeros frames pintados (codificados antes, tanto como la latencia) estén grabados.
    </p>
    <p className="text-amber-300">
      El VMAF solo se calcula con la emisión parada: compararlo con ella en marcha retrasa al codificador. La QoE suma por segundos: solo son
      comparables pruebas de la misma duración.
    </p>
  </div>
);

export const QoEPanel: React.FC<{
  streaming: boolean;
  activePlayers: PlayerId[];
  onStopStream: () => Promise<void>;
}> = ({ streaming, activePlayers, onStopStream }) => {
  const [durationS, setDurationS] = useState(30);
  const [prerollS, setPrerollS] = useState(5);
  const [phase, setPhase] = useState<{ name: string; until?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [steps, setSteps] = useState<Partial<Record<PlayerId, QoEStep[]>>>({});
  const [chart, setChart] = useState<'vmaf' | 'latency' | 'speed'>('vmaf');
  const [, tick] = useState(0);

  const running = phase !== null && phase.name !== 'done';
  const current = recordings.find((r) => r.id === selected) ?? null;

  // Lista de pruebas: cada 2 s mientras haya alguna pendiente, si no cada 10 s
  useEffect(() => {
    let stop = false;
    let timer = 0;
    const load = async (): Promise<Recording[]> => {
      try {
        const res = await fetch('/api/qoe/recordings');
        if (res.ok) {
          const list: Recording[] = await res.json();
          if (!stop) setRecordings(list);
          return list;
        }
      } catch (_) {}
      return [];
    };
    const loop = async () => {
      const list = await load();
      if (stop) return;
      const busy = running || list.some((r) => r.state !== 'ready' || r.vmaf?.state === 'queued' || r.vmaf?.state === 'running');
      timer = window.setTimeout(loop, busy ? 2000 : 10000);
    };
    loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, selected]);

  useEffect(() => {
    if (!selected && recordings.length) setSelected(recordings[0].id);
  }, [recordings, selected]);

  // Pasos de 1 s de cada reproductor de la prueba elegida, cuando ya tiene QoE
  const qoeKey = current ? `${current.id}:${Object.keys(current.qoe ?? {}).join(',')}` : '';
  useEffect(() => {
    setSteps({});
    if (!current?.qoe) return;
    let stop = false;
    (async () => {
      const out: Partial<Record<PlayerId, QoEStep[]>> = {};
      for (const p of Object.keys(current.qoe!) as PlayerId[]) {
        const res = await fetch(`/api/qoe/recordings/${current.id}/qoe/${p}`);
        if (res.ok) out[p] = (await res.json()).rows;
      }
      if (!stop) setSteps(out);
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qoeKey]);

  // Cuenta atrás de la fase en curso
  useEffect(() => {
    if (!phase?.until) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [phase]);

  const start = async () => {
    setError(null);
    try {
      const result = await runQoETest({
        durationS,
        prerollS,
        players: activePlayers,
        onPhase: (name, until) => setPhase({ name, until }),
      });
      setSelected(result.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase(null);
    }
  };

  const download = (name: string, body: string, type: string) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([body], { type }));
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const exportJSON = async () => {
    if (!current) return;
    const full: Record<string, unknown> = {};
    for (const p of Object.keys(current.qoe ?? {})) {
      const res = await fetch(`/api/qoe/recordings/${current.id}/qoe/${p}`);
      if (res.ok) full[p] = await res.json();
    }
    download(`qoe-${current.id}.json`, JSON.stringify({ recording: current, qoe: full }, null, 2), 'application/json');
  };

  const exportCSV = () => {
    if (!current) return;
    const lines = ['recording,player,t_s,included,vmaf,rebuffer_s,latency_s,speed,frames'];
    for (const [p, rows] of Object.entries(steps)) {
      for (const r of rows ?? []) {
        lines.push([current.id, p, r.t, r.included, r.vmaf ?? '', r.rebuffer_s ?? '', r.latency_s ?? '', r.speed ?? '', r.frames ?? ''].join(','));
      }
    }
    download(`qoe-${current.id}.csv`, lines.join('\n'), 'text/csv');
  };

  const remaining = phase?.until ? Math.max(0, Math.ceil((phase.until - Date.now()) / 1000)) : null;
  const phaseText: Record<string, string> = {
    recording: 'Grabando el margen inicial',
    logging: 'Registrando lo que pinta cada reproductor',
    uploading: 'Subiendo los registros',
  };

  const value = (r: QoEStep) => (chart === 'vmaf' ? r.vmaf : chart === 'latency' ? (r.latency_s ?? 0) * 1000 : r.speed);
  const chartData = {
    datasets: PLAYERS.filter((p) => steps[p.id]).map((p) => ({
      label: p.label,
      data: steps[p.id]!.filter((r) => r.included && value(r) !== null && value(r) !== undefined).map((r) => ({ x: r.t, y: value(r) as number })),
      borderColor: p.color,
      backgroundColor: p.color,
      borderWidth: 1.5,
      pointRadius: 2,
      tension: 0,
    })),
  };
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    parsing: false as const,
    scales: {
      x: { type: 'linear' as const, grid: { display: false }, ticks: { color: '#94a3b8' }, title: { display: true, text: 'segundo de la prueba', color: '#94a3b8' } },
      y: {
        grid: { color: '#334155' },
        ticks: { color: '#94a3b8' },
        title: { display: true, text: chart === 'vmaf' ? 'VMAF' : chart === 'latency' ? 'latencia (ms)' : 'velocidad (×)', color: '#94a3b8' },
      },
    },
    plugins: { legend: { labels: { color: '#cbd5e1', font: { size: 12 } } } },
  };

  const vmafNote = (() => {
    if (!current) return null;
    if (current.state === 'error') return <span className="text-red-400">Grabación fallida: {current.error}</span>;
    if (current.state !== 'ready') return <span className="text-slate-400">Grabación: {current.state === 'recording' ? 'grabando' : 'indexando'}…</span>;
    const v = current.vmaf?.state;
    if (v === 'done') return null;
    if (v === 'error') return <span className="text-red-400">VMAF fallido: {current.vmaf?.error}</span>;
    if (v === 'running') return <span className="text-slate-300">Calculando el VMAF…</span>;
    return (
      <span className="flex flex-wrap items-center gap-2 text-amber-300">
        VMAF en cola: se calcula en cuanto la emisión esté parada.
        {current.vmaf?.note && <span className="text-slate-400">({current.vmaf.note})</span>}
        {streaming && (
          <button onClick={onStopStream} className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer">
            Detener la emisión
          </button>
        )}
      </span>
    );
  })();

  return (
    <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="group relative flex items-center gap-2 cursor-help">
          <Award className="w-4 h-4 text-amber-400" />
          <h4 className="text-sm font-semibold text-slate-300">Prueba de QoE (LL-GABR + VMAF)</h4>
          <Info className="w-3 h-3 text-slate-500" />
          <div className="pointer-events-none absolute z-10 left-0 top-full mt-1 w-96 hidden group-hover:block bg-slate-800 border border-slate-600 rounded-lg p-3 text-[11px] leading-snug text-slate-200 shadow-xl">
            {HINT}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
          <label className="flex items-center gap-1.5">
            Duración
            <select
              value={durationS}
              disabled={running}
              onChange={(e) => setDurationS(Number(e.target.value))}
              className="bg-slate-950 border border-slate-700 rounded px-1.5 py-1"
            >
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d} s
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Margen
            <input
              type="number"
              min={1}
              max={20}
              value={prerollS}
              disabled={running}
              onChange={(e) => setPrerollS(Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
              className="w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-1"
            />
            s
          </label>
          <span className="text-slate-500">
            {activePlayers.length ? PLAYERS.filter((p) => activePlayers.includes(p.id)).map((p) => p.label).join(' · ') : 'sin reproductores activos'}
          </span>
          <button
            onClick={start}
            disabled={running || !streaming || !activePlayers.length}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-medium cursor-pointer disabled:cursor-not-allowed"
          >
            <Play className="w-3.5 h-3.5" />
            Lanzar prueba
          </button>
        </div>
      </div>

      {running && (
        <p className="text-xs text-indigo-300">
          {phaseText[phase!.name] ?? phase!.name}
          {remaining !== null && ` · ${remaining} s`} · no cambies de pestaña: el navegador detiene el muestreo
        </p>
      )}
      {!streaming && !running && <p className="text-xs text-slate-500">La prueba necesita la emisión en marcha.</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {recordings.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
          <label className="flex items-center gap-1.5">
            Prueba
            <select
              value={selected ?? ''}
              onChange={(e) => setSelected(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-1.5 py-1 font-mono"
            >
              {recordings.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} · {Math.round(r.duration_s)} s{r.source === 'camera' ? ' · cámara' : ''}
                  {r.qoe ? ' · QoE' : r.views || r.state !== 'ready' ? '' : ' · sin registros'}
                </option>
              ))}
            </select>
          </label>
          {vmafNote}
          {current?.qoe && (
            <span className="ml-auto flex gap-2">
              <button onClick={exportCSV} className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 cursor-pointer">
                <Download className="w-3 h-3" /> CSV por segundo
              </button>
              <button onClick={exportJSON} className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 cursor-pointer">
                <Download className="w-3 h-3" /> JSON completo
              </button>
            </span>
          )}
        </div>
      )}

      {current?.views && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {PLAYERS.filter((p) => current.views?.[p.id]).map((p) => {
            const q = current.qoe?.[p.id];
            const v = current.views![p.id]!;
            const warnings = [
              v.hidden && 'pestaña oculta',
              v.gaps > 0 && `${v.gaps} tramos sin muestreo`,
              v.outside_recording > 0 && `${v.outside_recording} frames fuera de la grabación`,
              v.unmatched > 0 && `${v.unmatched} sin emparejar`,
              q && q.excluded_steps > 0 && `${q.excluded_steps} s excluidos`,
            ].filter(Boolean);
            return (
              <div key={p.id} className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3 text-xs space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className={`font-semibold ${p.text}`}>{p.label}</span>
                  <span className="text-2xl font-bold text-slate-100">{q ? fmt(q.qoe) : '--'}</span>
                </div>
                {q?.terms ? (
                  <table className="w-full font-mono text-[11px]">
                    <tbody>
                      {TERMS.map((t) => (
                        <tr key={t.key}>
                          <td className="text-slate-400">{t.label}</td>
                          <td className="text-right text-slate-200">{fmt(q.terms![t.key], 3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-slate-500">Sin QoE todavía: falta el VMAF.</p>
                )}
                {q?.inputs && (
                  <p className="text-[11px] text-slate-400 font-mono leading-relaxed">
                    T={q.T} s · VMAF {fmt(q.inputs.vmaf_mean, 1)} · latencia {fmt(q.inputs.latency_mean_s * 1000, 0)} ms · parones{' '}
                    {q.inputs.rebuffer_count} ({fmt(q.inputs.rebuffer_s, 2)} s) · velocidad {fmt(q.inputs.speed_mean, 3)}
                  </p>
                )}
                <p className="text-[11px] text-slate-500 font-mono">
                  {v.matched}/{v.frames} frames emparejados · {v.skipped} sin pintar · {v.rendition_switches} cambios de calidad
                </p>
                {warnings.length > 0 && <p className="text-[11px] text-amber-300">{warnings.join(' · ')}</p>}
              </div>
            );
          })}
        </div>
      )}

      {Object.keys(steps).length > 0 && (
        <div>
          <div className="flex justify-end mb-2">
            <div className="flex space-x-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
              {(
                [
                  ['vmaf', 'VMAF por segundo'],
                  ['latency', 'Latencia por segundo'],
                  ['speed', 'Velocidad por segundo'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setChart(key)}
                  className={`px-3 py-1 rounded transition-colors ${chart === key ? 'bg-blue-600 text-white font-medium' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="h-56 relative">
            <Line data={chartData} options={chartOptions} />
          </div>
        </div>
      )}
    </div>
  );
};
