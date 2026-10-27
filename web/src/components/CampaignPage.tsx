import React, { useEffect, useState } from 'react';
import { ArrowLeft, Check, Copy, Download, FlaskConical, Pause, Pencil, Play, Settings2, Square, Trash2, X } from 'lucide-react';
import { CampaignEditor, DEFAULT_PLAYER_OPTIONS, formatDuration } from './CampaignEditor';
import { CampaignWorker } from './CampaignWorker';
import { CampaignResults } from './CampaignResults';
import type { Campaign, CampaignPlan, CampaignRun, PlayerId, ServerStatus } from '../types';

// Página de campañas de medida (/campaign; README, 4.8): editor, monitor y, en la misma pestaña o en otra
// (/campaign?worker=1), el trabajador que monta los reproductores. Con el trabajador activo el monitor se
// consulta menos y la tabla de pruebas va plegada, para no cargar el navegador que mide.

const STATE_LABEL: Record<string, string> = {
  ready: 'lista',
  running: 'en marcha',
  paused: 'en pausa',
  done: 'terminada',
  aborted: 'cancelada',
  pending: 'en cola',
  preparing: 'preparando',
  mounting: 'montando',
  warmup: 'calentando',
  measuring: 'midiendo',
  closing: 'cerrando',
  invalid: 'inválida',
};
const STATE_STYLE: Record<string, string> = {
  running: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  paused: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  done: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  aborted: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  ready: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
};
const PLAYER_SHORT: Record<PlayerId, string> = { dash: 'DASH', moq: 'MoQ', rtc: 'RTC' };

const ABR_LABEL: Record<string, string> = { default: 'por defecto', l2a: 'L2A', lolp: 'LoL+', watch: 'librería', probe: 'sondeo (experimento)' };
const SWITCHING_LABEL: Record<string, string> = { seamless: 'sin corte', cancel: 'cancelar (experimento)', priority: 'prioridad (experimento)' };

/** Ajustes de los reproductores de la campaña, de los protocolos que prueba. Sin player_options (campañas
 * anteriores), los del dashboard al abrirse. */
function optionsText(plan: Campaign['plan']): string {
  const o = { ...DEFAULT_PLAYER_OPTIONS, ...(plan.player_options ?? {}) };
  const parts = [];
  if (plan.players.includes('dash'))
    parts.push(`DASH: ABR ${ABR_LABEL[o.dash_abr]}, salto al directo ${o.dash_max_drift_s ? `${o.dash_max_drift_s} s` : 'nunca'}, búfer mínimo ${o.dash_playback_buffer_min_s} s`);
  if (plan.players.includes('moq')) parts.push(`MoQ: adaptación ${ABR_LABEL[o.moq_abr]}, cambio ${SWITCHING_LABEL[o.moq_switching]}`);
  if (plan.players.includes('rtc')) parts.push('WebRTC');
  return `${parts.join(' · ')} · ${plan.player_mode === 'each' ? 'de uno en uno' : 'a la vez'} · calidad ${plan.quality ? `${plan.quality}p` : 'auto'}`;
}

const fmt = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '--' : v.toFixed(digits));

const Badge: React.FC<{ state: string }> = ({ state }) => (
  <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATE_STYLE[state] ?? STATE_STYLE.ready}`}>{STATE_LABEL[state] ?? state}</span>
);

async function call(path: string, method = 'GET', payload?: unknown): Promise<any> {
  const res = await fetch(path, payload === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : `Error ${res.status}`);
  return body;
}

const RunsTable: React.FC<{ campaign: Campaign }> = ({ campaign }) => {
  const plan = campaign.plan;
  const runs = campaign.runs ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[11px]">
        <thead className="text-[10px] text-slate-500 uppercase">
          <tr>
            <th className="py-1 pr-2 font-medium">Prueba</th>
            <th className="py-1 pr-2 font-medium">Red</th>
            <th className="py-1 pr-2 font-medium">Objetivo</th>
            <th className="py-1 pr-2 font-medium">Rep.</th>
            <th className="py-1 pr-2 font-medium">Estado</th>
            <th className="py-1 pr-2 font-medium" title="Por reproductor: glass-to-glass p50 / p95 (ms), fracción del tiempo parado y cambios de calidad">
              Resultado (p50 / p95 ms · parado · cambios)
            </th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {runs.map((run: CampaignRun) => (
            <tr key={run.id} className={`border-t border-slate-800/60 ${run.id === campaign.current ? 'bg-indigo-950/40' : ''}`}>
              <td className="py-1 pr-2 text-slate-300">
                {run.id}
                {run.kind === 'control' && <span className="text-slate-500"> control</span>}
                {run.attempt > 1 && <span className="text-slate-500"> intento {run.attempt}</span>}
              </td>
              <td className="py-1 pr-2 text-slate-300 font-sans">{run.network === null ? 'sin restricción' : plan.networks[run.network].label}</td>
              <td className="py-1 pr-2 text-slate-300 font-sans">{plan.targets[run.target].label}</td>
              <td className="py-1 pr-2 text-slate-400">{run.rep + 1}</td>
              <td className="py-1 pr-2 font-sans" title={run.invalid_reasons.join('; ')}>
                <span className={run.state === 'invalid' ? 'text-rose-300' : run.state === 'done' ? 'text-emerald-300' : 'text-slate-400'}>
                  {STATE_LABEL[run.state] ?? run.state}
                </span>
                {run.state === 'invalid' && <span className="text-slate-500"> ({run.invalid_reasons.join('; ')})</span>}
              </td>
              <td className="py-1 pr-2 text-slate-300">
                {run.summary
                  ? run.players
                      .map((p) => {
                        const s = run.summary!.players[p] ?? {};
                        return `${PLAYER_SHORT[p]} ${fmt(s.g2g_p50_ms)}/${fmt(s.g2g_p95_ms)} · ${s.stall_ratio == null ? '--' : `${(s.stall_ratio * 100).toFixed(1)} %`} · ${fmt(s.quality_switches)}`;
                      })
                      .join('   ')
                  : run.players.map((p) => PLAYER_SHORT[p]).join(' + ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// Lo que muestra el editor: una campaña nueva, la copia de otra o el plan de una que aún no ha empezado
type EditorMode = { initial?: CampaignPlan; editId?: string };

const Monitor: React.FC<{
  campaign: Campaign;
  lean: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  onEdit: (mode: EditorMode) => void;
}> = ({ campaign, lean, onChanged, onDeleted, onEdit }) => {
  const [error, setError] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(!lean);
  // Con el trabajador en esta pestaña, las gráficas van plegadas: no se dibujan mientras mide
  const [showResults, setShowResults] = useState(!lean);
  // Nombre en edición; null si no se está editando
  const [draftName, setDraftName] = useState<string | null>(null);
  const saveName = async () => {
    const name = draftName?.trim();
    if (!name || name === campaign.name) return setDraftName(null);
    try {
      await call(`/api/campaigns/${campaign.id}`, 'PATCH', { name });
      setDraftName(null);
      setError(null);
      onChanged();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  const act = async (action: 'start' | 'pause' | 'abort') => {
    try {
      await call(`/api/campaigns/${campaign.id}/${action}`, 'POST');
      setError(null);
      onChanged();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  const remove = async () => {
    if (!window.confirm(`¿Borrar la campaña ${campaign.name} y todas sus medidas?`)) return;
    try {
      await call(`/api/campaigns/${campaign.id}`, 'DELETE');
      onDeleted();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const c = campaign.counts;
  const finished = (c.done ?? 0) + (c.invalid ?? 0);
  const current = campaign.runs?.find((r) => r.id === campaign.current);
  const worker = campaign.worker;
  const plan = campaign.plan;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        {draftName === null ? (
          <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
            {campaign.name}
            <button className="text-slate-500 hover:text-indigo-300" title="Cambiar el nombre" onClick={() => setDraftName(campaign.name)}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </h2>
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              maxLength={120}
              className="bg-slate-950 border border-indigo-500 rounded px-2 py-1 text-sm text-white w-80 focus:outline-none"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName();
                if (e.key === 'Escape') setDraftName(null);
              }}
            />
            <button className="text-emerald-400 hover:text-emerald-300" title="Guardar (Intro)" onClick={saveName}>
              <Check className="w-4 h-4" />
            </button>
            <button className="text-slate-500 hover:text-slate-300" title="Cancelar (Esc)" onClick={() => setDraftName(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <Badge state={campaign.state} />
        <span className="text-slate-500 font-mono">{campaign.id}</span>
        <div className="ml-auto flex gap-2">
          {(campaign.state === 'ready' || campaign.state === 'paused') && (
            <button className="flex items-center gap-1 px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white" onClick={() => act('start')}>
              <Play className="w-3.5 h-3.5" /> {campaign.state === 'paused' ? 'Reanudar' : 'Arrancar'}
            </button>
          )}
          {campaign.state === 'running' && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white"
              title="La prueba en curso se repetirá al reanudar. En pausa se pueden tocar la emisión y la red desde el dashboard."
              onClick={() => act('pause')}
            >
              <Pause className="w-3.5 h-3.5" /> Pausa
            </button>
          )}
          {/* Lista = aún no ha arrancado nunca (al arrancar pasa a en marcha y de ahí nunca vuelve) */}
          {campaign.state === 'ready' && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
              title="Cambiar el plan: solo antes de arrancarla. Las pruebas se vuelven a sortear."
              onClick={() => onEdit({ initial: campaign.plan, editId: campaign.id })}
            >
              <Settings2 className="w-3.5 h-3.5" /> Editar
            </button>
          )}
          <button
            className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
            title="Campaña nueva con este plan, para repetirla o variar algo. La original no cambia."
            onClick={() => onEdit({ initial: campaign.plan })}
          >
            <Copy className="w-3.5 h-3.5" /> Duplicar
          </button>
          {(campaign.state === 'running' || campaign.state === 'paused' || campaign.state === 'ready') && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded bg-rose-800 hover:bg-rose-700 text-white"
              title="Termina la campaña y deja la red y la emisión como estaban al empezar"
              onClick={() => act('abort')}
            >
              <Square className="w-3.5 h-3.5" /> Cancelar
            </button>
          )}
          {(['runs', 'samples'] as const).map((name) => (
            <a
              key={name}
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
              href={`/api/campaigns/${campaign.id}/${name}.csv`}
              title={name === 'runs' ? 'Una fila por prueba y reproductor, con su resumen' : 'Todas las filas de cada segundo, con la condición de su prueba'}
            >
              <Download className="w-3.5 h-3.5" /> {name === 'runs' ? 'Resumen CSV' : 'Muestras CSV'}
            </a>
          ))}
          {campaign.state !== 'running' && (
            <button className="text-slate-500 hover:text-rose-400 px-1" title="Borrar la campaña" onClick={remove}>
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Progreso */}
      <div className="space-y-1">
        <div className="h-2 rounded bg-slate-800 overflow-hidden flex">
          <div className="bg-emerald-500" style={{ width: `${(100 * (c.done ?? 0)) / Math.max(1, campaign.total_runs)}%` }} />
          <div className="bg-rose-500" style={{ width: `${(100 * (c.invalid ?? 0)) / Math.max(1, campaign.total_runs)}%` }} />
        </div>
        <div className="flex flex-wrap gap-x-4 text-slate-400">
          <span>
            {finished} de {campaign.total_runs} pruebas ({c.done ?? 0} válidas, {c.invalid ?? 0} inválidas)
          </span>
          {campaign.state !== 'done' && campaign.state !== 'aborted' && <span>quedan unas {formatDuration(campaign.eta_s)}</span>}
          <span>
            {plan.networks.length} redes × {plan.targets.length} objetivos × {plan.repetitions} repeticiones · {plan.warmup_s} + {plan.measure_s} s · semilla {plan.seed}
          </span>
          <span>{optionsText(plan)}</span>
        </div>
      </div>

      {/* Prueba en curso y trabajador */}
      {campaign.state === 'running' && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
          {current ? (
            <span>
              En curso: <span className="font-mono text-slate-200">{current.id}</span> · {STATE_LABEL[current.state]} · red{' '}
              <span className="text-slate-200">{current.network === null ? 'sin restricción' : plan.networks[current.network].label}</span> · objetivo{' '}
              <span className="text-slate-200">{plan.targets[current.target].label}</span>
            </span>
          ) : (
            <span>Sin prueba en curso</span>
          )}
          <span className={worker?.connected ? 'text-emerald-300' : 'text-amber-300'}>
            {worker?.connected ? `Trabajador ${worker.id} conectado` : 'Esperando a un trabajador: abre /campaign?worker=1 en una pestaña visible'}
          </span>
        </div>
      )}
      {error && <p className="text-rose-300">{error}</p>}

      {/* Eventos */}
      {!!campaign.events?.length && (
        <div className="text-slate-500 space-y-0.5 max-h-28 overflow-y-auto">
          {[...campaign.events].reverse().slice(0, lean ? 3 : 20).map((e, i) => (
            <div key={i}>
              <span className="font-mono">{new Date(e.t_ms).toLocaleString()}</span> {e.message}
            </div>
          ))}
        </div>
      )}

      <button className="text-indigo-300 hover:text-indigo-200" onClick={() => setShowRuns((v) => !v)}>
        {showRuns ? 'Ocultar las pruebas ▴' : 'Ver las pruebas ▾'}
      </button>
      {showRuns && <RunsTable campaign={campaign} />}

      <button className="block text-indigo-300 hover:text-indigo-200" onClick={() => setShowResults((v) => !v)}>
        {showResults ? 'Ocultar los resultados ▴' : 'Ver los resultados ▾'}
      </button>
      {showResults && <CampaignResults campaign={campaign} />}
    </div>
  );
};

export const CampaignPage: React.FC = () => {
  const [worker, setWorker] = useState(() => new URLSearchParams(window.location.search).get('worker') === '1');
  const [list, setList] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Campaign | null>(null);
  // Editor abierto (y con qué plan); null, el monitor
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const editing = editor !== null;
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    fetch('/api/status')
      .then((res) => (res.ok ? res.json() : null))
      .then(setStatus)
      .catch(() => {});
  }, []);

  // Lista de campañas; por defecto se sigue la que esté en marcha o la más reciente
  useEffect(() => {
    const load = () =>
      call('/api/campaigns')
        .then((all: Campaign[]) => {
          setList(all);
          setSelectedId((id) => id ?? all.find((c) => c.state === 'running')?.id ?? all[0]?.id ?? null);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, worker ? 15000 : 5000);
    return () => clearInterval(timer);
  }, [worker, tick]);

  useEffect(() => {
    if (!selectedId) return setSelected(null);
    const load = () =>
      call(`/api/campaigns/${selectedId}`)
        .then(setSelected)
        .catch(() => setSelected(null));
    load();
    const timer = setInterval(load, worker ? 10000 : 3000);
    return () => clearInterval(timer);
  }, [selectedId, worker, tick]);

  const toggleWorker = () => {
    const next = !worker;
    setWorker(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('worker', '1');
    else url.searchParams.delete('worker');
    window.history.replaceState(null, '', url);
  };

  // La emisión por defecto del editor: la que esté configurada ahora
  const cfg = status?.config;
  const defaultStream = {
    source: cfg?.source ?? 'file',
    rtc_audio: cfg?.rtc_audio ?? false,
    gop_size: cfg?.gop_size ?? 60,
    seg_duration: cfg?.seg_duration ?? 2.0,
    frag_duration: cfg?.frag_duration ?? 0.1,
    renditions: cfg?.renditions ?? [{ height: 1080, bitrate_kbps: 4000 }],
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-sans">
      <div className="max-w-[1800px] mx-auto space-y-4">
        <header className="flex flex-wrap items-center gap-4 pb-4 border-b border-slate-800">
          <a href="/" className="text-slate-400 hover:text-white flex items-center gap-1 text-xs">
            <ArrowLeft className="w-4 h-4" /> Dashboard
          </a>
          <div className="flex items-center gap-2">
            <span className="p-2 bg-indigo-900/60 border border-indigo-700/50 rounded-lg text-indigo-400">
              <FlaskConical className="w-5 h-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">Campañas de medida</h1>
              <p className="text-xs text-slate-400">Pruebas desatendidas por condición de red y latencia objetivo (README, 4.8)</p>
            </div>
          </div>
          <label
            className="ml-auto flex items-center gap-2 text-xs text-slate-300 cursor-pointer"
            title="Esta pestaña monta los reproductores de cada prueba y sube sus medidas. Un solo trabajador a la vez; la pestaña tiene que quedar visible."
          >
            <input type="checkbox" checked={worker} onChange={toggleWorker} />
            Esta pestaña es el trabajador
          </label>
        </header>

        {worker && <CampaignWorker />}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-400">Campañas:</span>
          {list.map((c) => (
            <button
              key={c.id}
              className={`px-2.5 py-1 rounded-lg border flex items-center gap-2 ${c.id === selectedId && !editing ? 'border-indigo-500 bg-indigo-900/40 text-indigo-100' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
              onClick={() => {
                setSelectedId(c.id);
                setEditor(null);
              }}
            >
              {c.name} <Badge state={c.state} />
            </button>
          ))}
          <button
            className={`px-2.5 py-1 rounded-lg border ${editing && !editor.initial ? 'border-emerald-500 bg-emerald-900/40 text-emerald-100' : 'border-slate-700 text-emerald-300 hover:border-emerald-500'}`}
            onClick={() => setEditor({})}
          >
            + Nueva campaña
          </button>
        </div>

        {editing ? (
          <CampaignEditor
            key={`${status ? 'ready' : 'loading'}-${editor.editId ?? ''}-${editor.initial ? 'plan' : 'new'}`}
            defaultStream={defaultStream}
            initial={editor.initial}
            editId={editor.editId}
            onCreated={(id) => {
              setEditor(null);
              setSelectedId(id);
              refresh();
            }}
          />
        ) : selected ? (
          <Monitor
            campaign={selected}
            lean={worker}
            onChanged={refresh}
            onEdit={setEditor}
            onDeleted={() => {
              setSelectedId(null);
              refresh();
            }}
          />
        ) : (
          <p className="text-xs text-slate-500">No hay campañas todavía.</p>
        )}
      </div>
    </div>
  );
};
