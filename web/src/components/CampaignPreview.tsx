import React, { useEffect, useRef, useState } from 'react';
import { Eye, X } from 'lucide-react';
import { DashPlayer } from './DashPlayer';
import { MoqPlayer } from './MoqPlayer';
import { RtcPlayer } from './RtcPlayer';
import { gridCols } from '../lib/layout';
import { syncClock } from '../lib/clock';
import { PLAYER_IDS, INITIAL_METRICS } from '../lib/samples';
import type { CampaignAssignment, PlayerId, PlayerMetrics, PlayerPreset, ServerStatus } from '../types';

// Vista previa de una prueba (README, 4.8): el servidor ya ha aplicado su red y su emisión, y aquí se montan los
// reproductores con sus ajustes, como los montaría el trabajador, pero sin subir filas ni contar como prueba.
// Al cerrarla (o al cerrar la pestaña) el servidor deja la red y la emisión como estaban.

export interface Preview extends CampaignAssignment {
  stream_changed: boolean;
  settle_s: number; // margen tras reiniciar la emisión, el de la campaña
}

export function stopPreview(beacon = false) {
  if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/campaigns-preview/stop');
  else fetch('/api/campaigns-preview/stop', { method: 'POST', keepalive: true }).catch(() => {});
}

export const CampaignPreview: React.FC<{ preview: Preview; onClose: () => void }> = ({ preview, onClose }) => {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  // Si se ha reiniciado la emisión, se deja el mismo margen que en la campaña antes de montar
  const [ready, setReady] = useState(!preview.stream_changed);
  const [lastG2g, setLastG2g] = useState<Partial<Record<PlayerId, number | null>>>({});
  const metricsRef = useRef<Record<PlayerId, PlayerMetrics>>({ ...INITIAL_METRICS });

  useEffect(() => {
    syncClock('');
    const clock = setInterval(() => syncClock(''), 10000);
    const load = () =>
      fetch('/api/status')
        .then((res) => (res.ok ? res.json() : null))
        .then((data: ServerStatus | null) => data && setStatus(data))
        .catch(() => {});
    load();
    const poll = setInterval(load, 2000);
    const show = setInterval(() => setLastG2g(Object.fromEntries(PLAYER_IDS.map((p) => [p, metricsRef.current[p].latencyMs]))), 1000);
    // Cerrar la pestaña también deshace la vista previa
    const leave = () => stopPreview(true);
    window.addEventListener('pagehide', leave);
    return () => {
      clearInterval(clock);
      clearInterval(poll);
      clearInterval(show);
      window.removeEventListener('pagehide', leave);
    };
  }, []);

  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setReady(true), preview.settle_s * 1000);
    return () => clearTimeout(timer);
  }, [ready, preview.settle_s]);

  const players = preview.players ?? [];
  const active = Object.fromEntries(PLAYER_IDS.map((p) => [p, players.includes(p)])) as Record<PlayerId, boolean>;
  const presets = Object.fromEntries(
    PLAYER_IDS.map((p) => [p, { targetMs: preview.targets?.[p] ?? null, quality: preview.quality ?? 'auto', options: preview.options }]),
  ) as Record<PlayerId, PlayerPreset>;
  const update = (player: PlayerId) => (m: Partial<PlayerMetrics>) => {
    metricsRef.current = { ...metricsRef.current, [player]: { ...metricsRef.current[player], ...m } };
  };
  const isStreaming = status?.status === 'running';
  const key = `${preview.campaign}-${preview.run}`;

  return (
    <div className="bg-slate-900 border border-sky-800/60 rounded-xl p-4 space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5 font-semibold text-sky-200">
          <Eye className="w-4 h-4" /> Vista previa de <span className="font-mono">{preview.run}</span>
        </span>
        <span className="text-slate-400">
          red <span className="text-slate-200">{preview.network_label}</span> · objetivo <span className="text-slate-200">{preview.target_label}</span> ·
          repetición {(preview.rep ?? 0) + 1}
          {preview.kind === 'control' && ' · control'}
        </span>
        <span className="font-mono text-slate-400">
          {players.map((p) => `${p} ${lastG2g[p] != null ? `${Math.round(lastG2g[p]!)} ms` : '--'}`).join(' · ')}
        </span>
        <span className="text-slate-500">
          Red y emisión de la prueba aplicadas en el servidor; no se graba nada. Al cerrar vuelven a como estaban.
        </span>
        <button className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-200 hover:border-slate-500" onClick={onClose}>
          <X className="w-3.5 h-3.5" /> Cerrar
        </button>
      </div>

      {!ready || !status ? (
        <p className="text-slate-400">
          {preview.stream_changed ? `Emisión reiniciada con la configuración de la prueba: se esperan ${preview.settle_s} s antes de montar los reproductores…` : 'Cargando…'}
        </p>
      ) : (
        <div className={`grid gap-4 ${gridCols(active)}`}>
          {active.dash && (
            <DashPlayer
              key={`dash-${key}`}
              url={status.dash_url || '/media/dash/manifest.mpd'}
              timecodes={status.timecodes}
              renditions={status.config.renditions}
              isStreaming={isStreaming}
              audible={false}
              preset={presets.dash}
              onMetricsUpdate={update('dash')}
            />
          )}
          {active.moq && (
            <MoqPlayer
              key={`moq-${key}`}
              url={`https://${status.moq_host || window.location.hostname}:${status.moq_port ?? 4433}/anon`}
              spkiFingerprint={status.spki_fingerprint}
              timecodes={status.timecodes}
              renditions={status.config.renditions}
              isStreaming={isStreaming}
              audible={false}
              preset={presets.moq}
              onMetricsUpdate={update('moq')}
            />
          )}
          {active.rtc && (
            <RtcPlayer
              key={`rtc-${key}`}
              timecodes={status.timecodes}
              isStreaming={isStreaming}
              withAudio={status.config.rtc_audio}
              streamStartedMs={status.stream_ids?.rtc ?? 0}
              audible={false}
              preset={presets.rtc}
              onMetricsUpdate={update('rtc')}
            />
          )}
        </div>
      )}
    </div>
  );
};
