import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CLEAR, PRESETS } from './NetworkPanel';
import { PLAYER_IDS } from '../lib/samples';
import type { CampaignNetwork, CampaignPlan, CampaignTarget, DashAbr, LinkProfile, MoqAbr, MoqSwitching, PlayerId, PlayerOptions, StreamConfig } from '../types';

// Editor de campañas (README, 4.8): emisiones, condiciones de red, latencias objetivo y diseño. El servidor
// sortea las pruebas al crearla; aquí solo se estima cuántas salen y cuánto tardan.

type Stream = CampaignPlan['streams'][number];

const PLAYER_LABEL: Record<PlayerId, string> = { dash: 'LL-DASH', moq: 'MoQ', rtc: 'WebRTC' };
// Los del dashboard al abrirse (DashPlayer y MoqPlayer); los mismos que pone el servidor si faltan
export const DEFAULT_PLAYER_OPTIONS: PlayerOptions = {
  dash_abr: 'default',
  dash_max_drift_s: 1.5,
  dash_playback_buffer_min_s: 0,
  moq_abr: 'watch',
  moq_switching: 'seamless',
};
// Lo que añade el servidor a cada prueba además del calentamiento y la medida (campaign.py: OVERHEAD_S y
// UPLOAD_GRACE_S)
const RUN_OVERHEAD_S = 18;

const ladderText = (s: Stream) => s.renditions.map((r) => `${r.height}@${r.bitrate_kbps}`).join(', ');
function parseLadder(text: string): Stream['renditions'] | null {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const out = parts.map((p) => {
    const m = p.match(/^(\d+)\s*[@:x]\s*(\d+)$/);
    return m ? { height: Number(m[1]), bitrate_kbps: Number(m[2]) } : null;
  });
  return out.length && out.every(Boolean) ? (out as Stream['renditions']) : null;
}

const describe = (l: LinkProfile) =>
  [
    l.rate_kbit ? `${l.rate_kbit} kbit/s` : null,
    l.delay_ms ? `${l.delay_ms} ms` : null,
    l.jitter_ms ? `±${l.jitter_ms} ms` : null,
    l.loss_pct ? `${l.loss_pct} %` : null,
  ]
    .filter(Boolean)
    .join(', ') || 'sin límite';

// Barridos de un parámetro sobre una base común. RTT y jitter van repartidos por igual en los dos sentidos;
// la pérdida, en los dos; el ancho de banda, solo en la bajada (la subida apenas lleva tráfico)
type SweepParam = 'rtt' | 'loss' | 'rate' | 'jitter';
const SWEEPS: Record<SweepParam, { label: string; unit: string; example: string }> = {
  rtt: { label: 'RTT', unit: 'ms', example: '0, 50, 100, 200' },
  loss: { label: 'Pérdida', unit: '%', example: '0, 0.5, 1, 2' },
  rate: { label: 'Ancho de banda de bajada', unit: 'kbit/s', example: '10000, 6000, 4000, 2000' },
  jitter: { label: 'Jitter', unit: 'ms', example: '0, 5, 10, 20' },
};

function sweep(param: SweepParam, values: number[], baseRttMs: number, queueMs: number): CampaignNetwork[] {
  return values.map((v) => {
    const base = { ...CLEAR, delay_ms: baseRttMs / 2 };
    let down: LinkProfile = { ...base };
    let up: LinkProfile = { ...base };
    let label = '';
    if (param === 'rtt') {
      down = { ...down, delay_ms: v / 2 };
      up = { ...up, delay_ms: v / 2 };
      label = `RTT ${v} ms`;
    } else if (param === 'loss') {
      down = { ...down, loss_pct: v };
      up = { ...up, loss_pct: v };
      label = `pérdida ${v} %`;
    } else if (param === 'rate') {
      down = { ...down, rate_kbit: v || null, queue_ms: queueMs };
      label = v ? `${v} kbit/s` : 'sin límite';
    } else {
      // El jitter no puede superar el retardo: el router lo rechaza
      down = { ...down, jitter_ms: v, delay_ms: Math.max(down.delay_ms, v) };
      up = { ...up, jitter_ms: v, delay_ms: Math.max(up.delay_ms, v) };
      label = `jitter ${v} ms`;
    }
    if (baseRttMs && param !== 'rtt') label += ` (RTT ${baseRttMs} ms)`;
    return { label, profile: { down, up } };
  });
}

// Columnas de la tabla de condiciones, en el orden de cada sentido
const LINK_COLUMNS: { key: keyof LinkProfile; label: string; unit: string; hint: string }[] = [
  { key: 'rate_kbit', label: 'Ancho de banda', unit: 'kbit/s', hint: 'Vacío = sin límite' },
  { key: 'delay_ms', label: 'Retardo', unit: 'ms', hint: 'En este sentido; el RTT es la suma de los dos' },
  { key: 'jitter_ms', label: 'Jitter', unit: 'ms', hint: 'Variación del retardo; no puede superarlo y desordena paquetes' },
  { key: 'loss_pct', label: 'Pérdida', unit: '%', hint: 'Aleatoria e independiente por paquete' },
  { key: 'queue_ms', label: 'Cola', unit: 'ms', hint: 'Búfer del cuello de botella; solo actúa con ancho de banda limitado' },
];
const DIRECTION_LABEL = { down: 'Bajada (servidor → navegador)', up: 'Subida (navegador → servidor)' };

const numbers = (text: string) =>
  text
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);

/** Latencias objetivo de un texto: "auto, 100, 300" (auto = la de fábrica de cada reproductor). */
function parseTargets(text: string): CampaignTarget[] | null {
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  const out = parts.map((p) => {
    if (/^auto$/i.test(p)) return { label: 'auto', dash_ms: null, moq_ms: null, rtc_ms: null };
    const ms = Number(p);
    return Number.isInteger(ms) && ms > 0 ? { label: `${ms} ms`, dash_ms: ms, moq_ms: ms, rtc_ms: ms } : null;
  });
  return out.length && out.every(Boolean) ? (out as CampaignTarget[]) : null;
}

export const formatDuration = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

const input = 'bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500';
const label = 'text-[11px] text-slate-400';

const uniformTarget = (t: CampaignTarget) => t.dash_ms === t.moq_ms && t.moq_ms === t.rtc_ms;
const targetsToText = (targets: CampaignTarget[]) => targets.map((t) => (t.dash_ms === null ? 'auto' : String(t.dash_ms))).join(', ');

interface Props {
  defaultStream: Stream;
  // Plan del que partir: el de la campaña que se duplica o se edita. Sin él, una campaña nueva
  initial?: CampaignPlan;
  // Campaña que se edita (aún sin empezar): al guardar se sustituye su plan en vez de crear otra
  editId?: string;
  onCreated: (id: string) => void;
}

export const CampaignEditor: React.FC<Props> = ({ defaultStream, initial, editId, onCreated }) => {
  const [name, setName] = useState(initial ? (editId ? initial.name : `${initial.name} (copia)`) : '');
  const [streams, setStreams] = useState<Stream[]>(initial?.streams ?? [defaultStream]);
  const [ladders, setLadders] = useState<string[]>((initial?.streams ?? [defaultStream]).map(ladderText));
  const [networks, setNetworks] = useState<CampaignNetwork[]>(initial ? JSON.parse(JSON.stringify(initial.networks)) : []);
  const [sweepParam, setSweepParam] = useState<SweepParam>('rtt');
  const [sweepValues, setSweepValues] = useState(SWEEPS.rtt.example);
  const [sweepBaseRtt, setSweepBaseRtt] = useState(0);
  const [sweepQueue, setSweepQueue] = useState(200);
  const [targetsText, setTargetsText] = useState(initial ? targetsToText(initial.targets) : 'auto, 100, 300, 600, 1000');
  // Objetivos distintos por rama (solo se crean por la API): se conservan tal cual mientras no se edite el texto
  const [keptTargets, setKeptTargets] = useState<CampaignTarget[] | null>(
    initial && !initial.targets.every(uniformTarget) ? initial.targets : null,
  );
  const [players, setPlayers] = useState<PlayerId[]>(initial?.players ?? [...PLAYER_IDS]);
  const [playerMode, setPlayerMode] = useState<'together' | 'each'>(initial?.player_mode ?? 'together');
  const [quality, setQuality] = useState<number | null>(initial?.quality ?? null);
  const [options, setOptions] = useState<PlayerOptions>({ ...DEFAULT_PLAYER_OPTIONS, ...(initial?.player_options ?? {}) });
  const setOption = <K extends keyof PlayerOptions>(key: K, value: PlayerOptions[K]) => setOptions((o) => ({ ...o, [key]: value }));
  const moqExperiment = options.moq_abr !== 'watch' || options.moq_switching !== 'seamless';
  const [repetitions, setRepetitions] = useState(initial?.repetitions ?? 3);
  const [warmup, setWarmup] = useState(initial?.warmup_s ?? 30);
  const [measure, setMeasure] = useState(initial?.measure_s ?? 120);
  const [controlEvery, setControlEvery] = useState(initial?.control_every ?? 10);
  const [maxAttempts, setMaxAttempts] = useState(initial?.max_attempts ?? 2);
  const [settle, setSettle] = useState(initial?.stream_settle_s ?? 15);
  // Al duplicar, sorteo nuevo (la semilla vacía la elige el servidor); al editar, la misma
  const [seed, setSeed] = useState(editId && initial?.seed != null ? String(initial.seed) : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const targets = keptTargets ?? parseTargets(targetsText);
  const ladderOk = ladders.map((t) => parseLadder(t) !== null);

  // Misma cuenta que el servidor (campaign.py: expand y estimate_s)
  const groups = playerMode === 'together' ? 1 : players.length;
  const tests = streams.length * repetitions * networks.length * (targets?.length ?? 0) * groups;
  const controls = controlEvery ? Math.ceil(tests / controlEvery) * groups : 0;
  const etaS = (tests + controls) * (warmup + measure + RUN_OVERHEAD_S) + streams.length * settle;

  const setStream = (i: number, patch: Partial<Stream>) => setStreams((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setLadder = (i: number, text: string) => {
    setLadders((all) => all.map((t, j) => (j === i ? text : t)));
    const parsed = parseLadder(text);
    if (parsed) setStream(i, { renditions: parsed });
  };
  const setLink = (i: number, dir: 'down' | 'up', key: keyof LinkProfile, raw: string) => {
    const value = raw === '' ? (key === 'rate_kbit' ? null : 0) : Number(raw);
    setNetworks((all) => all.map((n, j) => (j === i ? { ...n, profile: { ...n.profile, [dir]: { ...n.profile[dir], [key]: value } } } : n)));
  };

  const create = async () => {
    if (!targets) return setError('Latencias objetivo: números en ms separados por comas, o auto');
    if (!ladderOk.every(Boolean)) return setError('Escalera: altura@kbps separadas por comas, p. ej. 1080@4000, 720@2000');
    if (!networks.length) return setError('Añade al menos una condición de red');
    if (!players.length) return setError('Elige al menos un reproductor');
    const plan: CampaignPlan = {
      name: name.trim() || `Campaña ${new Date().toLocaleString()}`,
      streams,
      networks,
      targets,
      players: PLAYER_IDS.filter((p) => players.includes(p)),
      player_mode: playerMode,
      quality,
      player_options: options,
      repetitions,
      warmup_s: warmup,
      measure_s: measure,
      control_every: controlEvery,
      max_attempts: maxAttempts,
      stream_settle_s: settle,
      seed: seed.trim() === '' ? null : Number(seed),
    };
    setSaving(true);
    try {
      const res = await fetch(editId ? `/api/campaigns/${editId}` : '/api/campaigns', { method: editId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan) });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = body?.detail;
        setError(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d: any) => d.msg).join('; ') : `Rechazada (${res.status})`);
        return;
      }
      setError(null);
      onCreated(body.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-5 text-xs">
      {initial && (
        <p className="text-indigo-300 font-medium">
          {editId ? `Editando «${initial.name}», que aún no ha empezado` : `Copia de «${initial.name}»: se creará como una campaña nueva`}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 flex-1 min-w-[16rem]">
          <span className={label}>Nombre</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Barrido de RTT con una calidad" />
        </label>
      </div>

      {/* Protocolos y ajustes de sus reproductores, fijos en toda la campaña */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">Protocolos y reproductores</h3>
        <div className="grid gap-3 md:grid-cols-3">
          {PLAYER_IDS.map((p) => {
            const on = players.includes(p);
            return (
              <div key={p} className={`rounded-lg border p-3 space-y-2 ${on ? 'border-indigo-600/60 bg-slate-950/60' : 'border-slate-800 opacity-60'}`}>
                <label className="flex items-center gap-2 font-semibold text-slate-100 cursor-pointer">
                  <input type="checkbox" checked={on} onChange={(e) => setPlayers((all) => (e.target.checked ? [...all, p] : all.filter((q) => q !== p)))} />
                  {PLAYER_LABEL[p]}
                </label>
                {p === 'dash' && (
                  <div className="flex flex-wrap gap-3">
                    <label className="flex flex-col gap-1" title="Reglas de adaptación de dash.js en Auto. Por defecto: las de fábrica (caudal y BOLA, búfer insuficiente, historial de cambios, abandono de peticiones). L2A y LoL+: sus reglas para baja latencia, cada una en solitario.">
                      <span className={label}>ABR</span>
                      <select className={input} disabled={!on} value={options.dash_abr} onChange={(e) => setOption('dash_abr', e.target.value as DashAbr)}>
                        <option value="default">Por defecto</option>
                        <option value="l2a">L2A</option>
                        <option value="lolp">LoL+</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 w-28" title="liveCatchup.maxDrift: si la latencia se desvía del objetivo más que esto, dash.js salta al directo en vez de corregir con la velocidad. 0 = no saltar nunca.">
                      <span className={label}>Salto al directo (s)</span>
                      <input className={input} disabled={!on} type="number" min={0} max={10} step={0.5} value={options.dash_max_drift_s} onChange={(e) => setOption('dash_max_drift_s', Number(e.target.value))} />
                    </label>
                    <label className="flex flex-col gap-1 w-28" title="liveCatchup.playbackBufferMin (LoL+): por debajo de este búfer dash.js frena para rellenarlo; hace de suelo de la latencia. 0 = no frenar nunca; 0,5 s es el de fábrica.">
                      <span className={label}>Búfer mínimo (s)</span>
                      <input className={input} disabled={!on} type="number" min={0} max={2} step={0.05} value={options.dash_playback_buffer_min_s} onChange={(e) => setOption('dash_playback_buffer_min_s', Number(e.target.value))} />
                    </label>
                  </div>
                )}
                {p === 'moq' && (
                  <>
                    <div className="flex flex-wrap gap-3">
                      <label className="flex flex-col gap-1" title="Librería: decide @moq/watch (lo que se mide). Sondeo: el controlador propio con sondeo por prioridad de README 6.3, un experimento.">
                        <span className={label}>Adaptación</span>
                        <select className={input} disabled={!on} value={options.moq_abr} onChange={(e) => setOption('moq_abr', e.target.value as MoqAbr)}>
                          <option value="watch">Librería</option>
                          <option value="probe">Sondeo (experimento)</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1" title="Qué hacer al bajar de calidad (opción switching del parche de web/patches, README 6.1). Sin corte: el original de @moq/watch. Cancelar y Prioridad son el experimento. Sin el parche no tiene efecto.">
                        <span className={label}>Cambio</span>
                        <select className={input} disabled={!on} value={options.moq_switching} onChange={(e) => setOption('moq_switching', e.target.value as MoqSwitching)}>
                          <option value="seamless">Sin corte</option>
                          <option value="cancel">Cancelar (experimento)</option>
                          <option value="priority">Prioridad (experimento)</option>
                        </select>
                      </label>
                    </div>
                    {moqExperiment && <p className="text-amber-300">No es el comportamiento de @moq/watch: la campaña es un experimento declarado (README 6.1 y 6.3).</p>}
                  </>
                )}
                {p === 'rtc' && <p className="text-slate-500">Sin ajustes: una calidad, sin adaptación. La latencia objetivo va a jitterBufferTarget.</p>}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1" title="De uno en uno mide cuánto se estorban los reproductores en el navegador">
            <span className={label}>En cada prueba</span>
            <select className={input} value={playerMode} onChange={(e) => setPlayerMode(e.target.value as 'together' | 'each')}>
              <option value="together">Todos a la vez</option>
              <option value="each">De uno en uno</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Calidad</span>
            <select className={input} value={quality ?? ''} onChange={(e) => setQuality(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">Auto (adaptación de cada reproductor)</option>
              {[...new Set(streams.flatMap((s) => s.renditions.map((r) => r.height)))].map((h) => (
                <option key={h} value={h}>
                  Fija en {h}p
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* Emisiones */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">Emisión</h3>
        <p className="text-slate-500">Cada emisión es un bloque: la fuente solo se reinicia al pasar de una a otra.</p>
        {streams.map((s, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className={label}>Fuente</span>
              <select className={input} value={s.source} onChange={(e) => setStream(i, { source: e.target.value as StreamConfig['source'] })}>
                <option value="file">Big Buck Bunny en bucle</option>
                <option value="camera">Cámara RTSP</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 min-w-[14rem]">
              <span className={label}>Escalera (altura@kbps)</span>
              <input className={`${input} ${ladderOk[i] ? '' : 'border-rose-500'}`} value={ladders[i]} onChange={(e) => setLadder(i, e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 w-20">
              <span className={label}>GOP (frames)</span>
              <input className={input} type="number" min={1} value={s.gop_size} onChange={(e) => setStream(i, { gop_size: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-1 w-20">
              <span className={label}>Segmento (s)</span>
              <input className={input} type="number" step={0.5} min={0.25} value={s.seg_duration} onChange={(e) => setStream(i, { seg_duration: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-1" title="Fragmento CMAF de LL-DASH. 1 frame es frag_duration = 0 en la API y en el CSV (-frag_type every_frame)">
              <span className={label}>Fragmento CMAF</span>
              <select className={input} value={s.frag_duration} onChange={(e) => setStream(i, { frag_duration: Number(e.target.value) })}>
                {/* Las mismas opciones que el panel de control; una duración distinta (de la configuración en curso) también se conserva */}
                {[...new Set([0, 0.1, 0.2, 0.5, 1, s.frag_duration])].map((f) => (
                  <option key={f} value={f}>
                    {f === 0 ? `1 frame (${s.source === 'camera' ? 'el de la cámara' : '16,7 ms a 60 fps'})` : `${Math.round(f * 1000)} ms`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 pb-1">
              <input type="checkbox" checked={s.rtc_audio} onChange={(e) => setStream(i, { rtc_audio: e.target.checked })} />
              <span className="text-slate-300">Audio en WebRTC</span>
            </label>
            {streams.length > 1 && (
              <button
                className="text-slate-500 hover:text-rose-400 pb-1"
                title="Quitar esta emisión"
                onClick={() => {
                  setStreams((all) => all.filter((_, j) => j !== i));
                  setLadders((all) => all.filter((_, j) => j !== i));
                }}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
        <button
          className="flex items-center gap-1 text-indigo-300 hover:text-indigo-200"
          onClick={() => {
            setStreams((all) => [...all, { ...all[all.length - 1] }]);
            setLadders((all) => [...all, all[all.length - 1]]);
          }}
        >
          <Plus className="w-3.5 h-3.5" /> Otra emisión
        </button>
      </section>

      {/* Condiciones de red */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">Condiciones de red</h3>
        <div className="flex flex-wrap items-end gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800">
          <label className="flex flex-col gap-1">
            <span className={label}>Barrido de</span>
            <select
              className={input}
              value={sweepParam}
              onChange={(e) => {
                const p = e.target.value as SweepParam;
                setSweepParam(p);
                setSweepValues(SWEEPS[p].example);
              }}
            >
              {(Object.keys(SWEEPS) as SweepParam[]).map((p) => (
                <option key={p} value={p}>
                  {SWEEPS[p].label} ({SWEEPS[p].unit})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 min-w-[12rem]">
            <span className={label}>Valores ({SWEEPS[sweepParam].unit})</span>
            <input className={input} value={sweepValues} onChange={(e) => setSweepValues(e.target.value)} />
          </label>
          {sweepParam !== 'rtt' && (
            <label className="flex flex-col gap-1 w-24" title="RTT común a todas las condiciones del barrido, repartido entre los dos sentidos">
              <span className={label}>con RTT (ms)</span>
              <input className={input} type="number" min={0} value={sweepBaseRtt} onChange={(e) => setSweepBaseRtt(Number(e.target.value))} />
            </label>
          )}
          {sweepParam === 'rate' && (
            <label className="flex flex-col gap-1 w-24" title="Búfer del cuello de botella">
              <span className={label}>Cola (ms)</span>
              <input className={input} type="number" min={10} value={sweepQueue} onChange={(e) => setSweepQueue(Number(e.target.value))} />
            </label>
          )}
          <button
            className="px-3 py-1 rounded bg-indigo-700 hover:bg-indigo-600 text-white"
            onClick={() => setNetworks((all) => [...all, ...sweep(sweepParam, numbers(sweepValues), sweepBaseRtt, sweepQueue)])}
          >
            Añadir barrido
          </button>
          <span className="text-slate-500">o un perfil:</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
              onClick={() => setNetworks((all) => [...all, { label: p.label, profile: JSON.parse(JSON.stringify(p.profile)) }])}
            >
              {p.label}
            </button>
          ))}
        </div>

        {networks.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-[11px] text-slate-400">
                <tr>
                  <th rowSpan={2} className="py-1 pr-2 font-medium align-bottom">Nombre</th>
                  {(['down', 'up'] as const).map((d) => (
                    <th key={d} colSpan={LINK_COLUMNS.length} className={`py-1 px-2 font-semibold text-slate-300 text-center border-b border-slate-700 ${d === 'up' ? 'border-l' : ''}`}>
                      {DIRECTION_LABEL[d]}
                    </th>
                  ))}
                  <th rowSpan={2} />
                </tr>
                <tr>
                  {(['down', 'up'] as const).map((d) =>
                    LINK_COLUMNS.map((c, j) => (
                      <th
                        key={`${d}-${c.key}`}
                        title={c.hint}
                        className={`pt-1 pb-1.5 font-medium whitespace-nowrap ${d === 'up' && j === 0 ? 'border-l border-slate-700 pl-2' : 'pl-0'} pr-1`}
                      >
                        {c.label} <span className="text-slate-500 font-normal">({c.unit})</span>
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {networks.map((n, i) => (
                  <tr key={i} className="border-t border-slate-800/60">
                    <td className="py-1 pr-2">
                      <input
                        className={`${input} w-48`}
                        value={n.label}
                        onChange={(e) => setNetworks((all) => all.map((m, j) => (j === i ? { ...m, label: e.target.value } : m)))}
                      />
                    </td>
                    {(['down', 'up'] as const).map((d) =>
                      LINK_COLUMNS.map(({ key: k }, j) => (
                        <td key={`${d}-${k}`} className={`py-1 pr-1 ${d === 'up' && j === 0 ? 'border-l border-slate-700 pl-2' : ''}`}>
                          <input
                            className={`${input} w-24`}
                            type="number"
                            min={0}
                            step={k === 'loss_pct' ? 0.1 : 1}
                            placeholder={k === 'rate_kbit' ? '∞' : ''}
                            value={n.profile[d][k] ?? ''}
                            onChange={(e) => setLink(i, d, k, e.target.value)}
                          />
                        </td>
                      )),
                    )}
                    <td>
                      <button className="text-slate-500 hover:text-rose-400" title="Quitar" onClick={() => setNetworks((all) => all.filter((_, j) => j !== i))}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-slate-500 mt-1">
              {networks.map((n) => `${n.label}: ↓ ${describe(n.profile.down)} / ↑ ${describe(n.profile.up)}`).join(' · ')}
            </p>
          </div>
        )}
        <p className="text-slate-500">Las pruebas de control, sin restricción, se añaden solas (abajo). El jitter de netem desordena paquetes y castiga casi solo a QUIC (README, sección 5).</p>
      </section>

      {/* Latencias objetivo */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">Latencias objetivo</h3>
        <input
          className={`${input} w-full max-w-xl ${targets ? '' : 'border-rose-500'}`}
          value={targetsText}
          onChange={(e) => {
            setTargetsText(e.target.value);
            setKeptTargets(null);
          }}
        />
        {keptTargets && (
          <p className="text-amber-300">
            Esta campaña tiene objetivos distintos por rama ({keptTargets.map((t) => `${t.label}: DASH ${t.dash_ms ?? 'auto'}, MoQ ${t.moq_ms ?? 'auto'}, WebRTC ${t.rtc_ms ?? 'auto'}`).join(' · ')}). Se conservan; si editas el texto, se sustituyen por el mismo valor en los tres.
          </p>
        )}
        <p className="text-slate-500">
          En ms, separadas por comas; <span className="font-mono">auto</span> es la de fábrica de cada reproductor. Cada valor va al mando de cada reproductor tal como lo entiende su implementación, que no significa lo mismo: <span className="font-mono">liveDelay</span> de dash.js (de extremo a extremo), <span className="font-mono">delay</span> de @moq/watch (búfer, más el jitter del catálogo) y <span className="font-mono">jitterBufferTarget</span> de WebRTC (solo el búfer). El primero es también el de las pruebas de control.
        </p>
      </section>

      {/* Diseño */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">Diseño</h3>
        <div className="flex flex-wrap items-end gap-4">
          {(
            [
              ['Repeticiones', repetitions, setRepetitions, 1],
              ['Calentamiento (s)', warmup, setWarmup, 5],
              ['Medida (s)', measure, setMeasure, 10],
              ['Control cada (pruebas, 0 = no)', controlEvery, setControlEvery, 0],
              ['Intentos por prueba', maxAttempts, setMaxAttempts, 1],
              ['Margen tras reiniciar la emisión (s)', settle, setSettle, 0],
            ] as [string, number, (n: number) => void, number][]
          ).map(([text, value, set, min]) => (
            <label key={text} className="flex flex-col gap-1 w-28">
              <span className={label}>{text}</span>
              <input className={input} type="number" min={min} value={value} onChange={(e) => set(Number(e.target.value))} />
            </label>
          ))}
          <label className="flex flex-col gap-1 w-28" title="Semilla del sorteo; vacía, la elige el servidor y queda guardada">
            <span className={label}>Semilla</span>
            <input className={input} value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))} placeholder="al azar" />
          </label>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-slate-800">
        <span className="text-slate-300">
          {tests} pruebas{controls ? ` + ${controls} de control` : ''} · unas <span className="font-semibold text-white">{formatDuration(etaS)}</span>
        </span>
        <button disabled={saving} className="px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-medium disabled:opacity-50" onClick={create}>
          {editId ? 'Guardar cambios' : 'Crear campaña'}
        </button>
        <span className="text-slate-500">
          {editId
            ? 'Las pruebas se vuelven a sortear con el plan nuevo.'
            : 'Se crea sin arrancar: revisa las pruebas sorteadas y arráncala desde el monitor.'}
          {initial && !editId && ' La semilla se deja vacía para un sorteo nuevo; escribe la de la original para repetir el mismo orden.'}
        </span>
        {error && <span className="text-rose-300 w-full">{error}</span>}
      </div>
    </div>
  );
};
