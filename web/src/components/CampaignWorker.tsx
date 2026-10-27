import React, { useEffect, useRef, useState } from 'react';
import { DashPlayer } from './DashPlayer';
import { MoqPlayer } from './MoqPlayer';
import { RtcPlayer } from './RtcPlayer';
import { gridCols } from '../lib/layout';
import { syncClock, serverNowMs } from '../lib/clock';
import { PLAYER_IDS, INITIAL_METRICS, IpRates, buildSampleRow } from '../lib/samples';
import type { CampaignAssignment, PlayerId, PlayerMetrics, PlayerPreset, SampleRow, ServerStatus, VersionReport } from '../types';

// Trabajador de las campañas (README, 4.8). El servidor decide qué prueba toca; esta pestaña monta los
// reproductores con sus ajustes, avisa al tenerlos y sube las filas de cada segundo, las mismas del CSV del
// dashboard más la hora del servidor. Los reproductores son siempre nuevos en cada prueba.

const WORKER_KEY = 'testbed.campaignWorker';
const BEAT_MS = 1000;
const UPLOAD_MS = 5000;
const MAX_PENDING_ROWS = 600; // lo que admite el servidor por lote
// Fases en las que la prueba debe tener los reproductores montados
const MOUNTED_PHASES = new Set(['mounting', 'warmup', 'measuring', 'closing']);

const PHASE_LABEL: Record<string, string> = {
  idle: 'sin prueba',
  pending: 'en cola',
  preparing: 'preparando red y emisión',
  mounting: 'montando reproductores',
  warmup: 'calentamiento',
  measuring: 'midiendo',
  closing: 'cerrando',
};

/** Identificador de esta pestaña como trabajador; sobrevive a recargas, no a cerrarla. */
function workerId(): string {
  try {
    const saved = sessionStorage.getItem(WORKER_KEY);
    if (saved) return saved;
    const fresh = `w-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(WORKER_KEY, fresh);
    return fresh;
  } catch (_) {
    return `w-${Math.random().toString(36).slice(2, 10)}`;
  }
}

interface Mounted {
  campaign: string;
  run: string;
  players: PlayerId[];
  presets: Record<PlayerId, PlayerPreset>;
  atServerMs: number; // cuándo se crearon los reproductores, en reloj del servidor
  atPerf: number;
}

export const CampaignWorker: React.FC = () => {
  const idRef = useRef(workerId());
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const statusRef = useRef<ServerStatus | null>(null);
  const ipRef = useRef(new IpRates());
  const versionsRef = useRef<VersionReport | null>(null);
  const [assignment, setAssignment] = useState<CampaignAssignment | null>(null);
  const [busyBy, setBusyBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState<Mounted | null>(null);
  const mountedRef = useRef<Mounted | null>(null);
  mountedRef.current = mounted;
  const metricsRef = useRef<Record<PlayerId, PlayerMetrics>>({ ...INITIAL_METRICS });
  const pendingRef = useRef<{ campaign: string; run: string; rows: SampleRow[] }[]>([]);
  const [now, setNow] = useState(Date.now());
  const [lastG2g, setLastG2g] = useState<Partial<Record<PlayerId, number | null>>>({});

  // Reloj del servidor, estado de la emisión y versiones, como el dashboard
  useEffect(() => {
    syncClock('');
    const clock = setInterval(() => syncClock(''), 10000);
    const load = () =>
      fetch('/api/status')
        .then((res) => (res.ok ? res.json() : null))
        .then((data: ServerStatus | null) => {
          if (!data) return;
          statusRef.current = data;
          ipRef.current.push(data);
          setStatus(data);
        })
        .catch(() => {});
    load();
    const poll = setInterval(load, 2000);
    fetch('/api/versions')
      .then((res) => (res.ok ? res.json() : null))
      .then((report) => (versionsRef.current = report))
      .catch(() => {});
    return () => {
      clearInterval(clock);
      clearInterval(poll);
    };
  }, []);

  // Pantalla encendida mientras trabaja: con la pestaña oculta el navegador pausa el vídeo y la prueba no vale
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = () => {
      if (document.visibilityState === 'visible' && 'wakeLock' in navigator) {
        (navigator as any).wakeLock.request('screen').then((l: typeof lock) => (lock = l)).catch(() => {});
      }
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      document.removeEventListener('visibilitychange', request);
      lock?.release().catch(() => {});
    };
  }, []);

  // Latido: dice qué tiene montado y recibe lo que debe tener
  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      const m = mountedRef.current;
      try {
        const res = await fetch('/api/campaigns-worker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            worker_id: idRef.current,
            mounted: m?.run ?? null,
            mounted_at_ms: m?.atServerMs ?? null,
            info: { user_agent: navigator.userAgent, hidden: document.hidden },
          }),
        });
        if (!res.ok) throw new Error(`latido rechazado (${res.status})`);
        const body = await res.json();
        if (stopped) return;
        setBusyBy(body.busy ? body.worker : null);
        setAssignment(body.busy ? null : body.assignment);
        setError(null);
      } catch (e) {
        if (!stopped) setError(String(e));
      }
      setNow(Date.now());
    };
    beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  // Montar o desmontar según la fase de la prueba asignada
  useEffect(() => {
    const wanted = assignment && MOUNTED_PHASES.has(assignment.phase) ? assignment : null;
    if (!wanted) {
      if (mountedRef.current) setMounted(null);
      return;
    }
    const current = mountedRef.current;
    if (current && current.run === wanted.run && current.campaign === wanted.campaign) return;
    // Sin reloj sincronizado o sin estado de la emisión no se puede medir: se espera al siguiente latido
    const at = serverNowMs();
    if (at === null || !statusRef.current || !wanted.players || !wanted.run) return;
    const presets = Object.fromEntries(
      PLAYER_IDS.map((p) => [p, { targetMs: wanted.targets?.[p] ?? null, quality: wanted.quality ?? 'auto', options: wanted.options }]),
    ) as Record<PlayerId, PlayerPreset>;
    metricsRef.current = { ...INITIAL_METRICS };
    setLastG2g({});
    setMounted({ campaign: wanted.campaign, run: wanted.run, players: wanted.players, presets, atServerMs: at, atPerf: performance.now() });
  }, [assignment]);

  // Una fila por segundo mientras hay prueba montada
  useEffect(() => {
    if (!mounted) return;
    const batch = { campaign: mounted.campaign, run: mounted.run, rows: [] as SampleRow[] };
    pendingRef.current.push(batch);
    const active = Object.fromEntries(PLAYER_IDS.map((p) => [p, mounted.players.includes(p)])) as Record<PlayerId, boolean>;
    const timer = setInterval(() => {
      const t = serverNowMs();
      if (t === null) return;
      const row = buildSampleRow({
        epoch: 0,
        epochStartedAt: mounted.atPerf,
        active,
        metrics: metricsRef.current,
        status: statusRef.current,
        ip: ipRef.current.rates(),
        audioPlayer: null,
        versions: versionsRef.current,
      });
      batch.rows.push({ ...row, t_server_ms: Math.round(t) } as SampleRow);
      if (batch.rows.length > MAX_PENDING_ROWS) batch.rows.shift();
      setLastG2g(Object.fromEntries(mounted.players.map((p) => [p, metricsRef.current[p].latencyMs])));
    }, 1000);
    return () => clearInterval(timer);
  }, [mounted]);

  // Subida por lotes; lo que no se pueda subir se reintenta en la siguiente vuelta
  useEffect(() => {
    let busy = false;
    const upload = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const batch of [...pendingRef.current]) {
          if (batch.rows.length) {
            const rows = batch.rows.splice(0, batch.rows.length);
            try {
              const res = await fetch(`/api/campaigns/${batch.campaign}/samples`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ run_id: batch.run, rows }),
              });
              // 404: la campaña ya no existe; las filas se descartan
              if (!res.ok && res.status !== 404) batch.rows.unshift(...rows);
            } catch (_) {
              batch.rows.unshift(...rows);
            }
          }
          // Los lotes de pruebas ya desmontadas se retiran cuando están vacíos
          if (!batch.rows.length && batch.run !== mountedRef.current?.run) {
            pendingRef.current = pendingRef.current.filter((b) => b !== batch);
          }
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(upload, UPLOAD_MS);
    return () => clearInterval(timer);
  }, []);

  const update = (player: PlayerId) => (m: Partial<PlayerMetrics>) => {
    metricsRef.current = { ...metricsRef.current, [player]: { ...metricsRef.current[player], ...m } };
  };

  const phase = assignment?.phase ?? 'idle';
  const remaining = assignment?.ends_ms ? Math.max(0, Math.round((assignment.ends_ms - (serverNowMs() ?? now)) / 1000)) : null;
  const isStreaming = status?.status === 'running';
  const active = Object.fromEntries(PLAYER_IDS.map((p) => [p, !!mounted?.players.includes(p)])) as Record<PlayerId, boolean>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5">
        <span className="font-semibold text-slate-200">Trabajador {idRef.current}</span>
        {busyBy ? (
          <span className="text-amber-300">Ya hay otro trabajador conectado ({busyBy}); esta pestaña espera</span>
        ) : (
          <>
            <span className="text-slate-400">
              Fase: <span className="text-indigo-300 font-medium">{PHASE_LABEL[phase] ?? phase}</span>
              {remaining !== null && <span className="font-mono text-slate-300"> · {remaining} s</span>}
            </span>
            {assignment?.run && (
              <span className="text-slate-400">
                Prueba <span className="font-mono text-slate-200">{assignment.run}</span>
                {assignment.network_label && <> · red <span className="text-slate-200">{assignment.network_label}</span></>}
                {assignment.target_label && <> · objetivo <span className="text-slate-200">{assignment.target_label}</span></>}
                {assignment.rep !== undefined && <> · repetición {assignment.rep + 1}</>}
              </span>
            )}
            {mounted && (
              <span className="font-mono text-slate-400">
                {mounted.players.map((p) => `${p} ${lastG2g[p] != null ? `${Math.round(lastG2g[p]!)} ms` : '--'}`).join(' · ')}
              </span>
            )}
          </>
        )}
        {error && <span className="text-rose-300">Sin servidor: {error}</span>}
        <span className="text-slate-500 ml-auto">Deja esta pestaña visible: oculta, la prueba no vale.</span>
      </div>

      {mounted && status && (
        <div className={`grid gap-4 ${gridCols(active)}`}>
          {active.dash && (
            <DashPlayer
              key={`dash-${mounted.run}`}
              url={status.dash_url || '/media/dash/manifest.mpd'}
              timecodes={status.timecodes}
              renditions={status.config.renditions}
              isStreaming={isStreaming}
              audible={false}
              preset={mounted.presets.dash}
              onMetricsUpdate={update('dash')}
            />
          )}
          {active.moq && (
            <MoqPlayer
              key={`moq-${mounted.run}`}
              url={`https://${status.moq_host || window.location.hostname}:${status.moq_port ?? 4433}/anon`}
              spkiFingerprint={status.spki_fingerprint}
              timecodes={status.timecodes}
              renditions={status.config.renditions}
              isStreaming={isStreaming}
              audible={false}
              preset={mounted.presets.moq}
              onMetricsUpdate={update('moq')}
            />
          )}
          {active.rtc && (
            <RtcPlayer
              key={`rtc-${mounted.run}`}
              timecodes={status.timecodes}
              isStreaming={isStreaming}
              withAudio={status.config.rtc_audio}
              streamStartedMs={status.stream_ids?.rtc ?? 0}
              audible={false}
              preset={mounted.presets.rtc}
              onMetricsUpdate={update('rtc')}
            />
          )}
        </div>
      )}
    </div>
  );
};
