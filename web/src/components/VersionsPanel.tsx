import React from 'react';
import type { VersionReport } from '../types';

// Componentes de terceros de los que dependen las medidas, con dónde se fija la versión de cada uno
const COMPONENTS: { key: string; name: string; where: string }[] = [
  { key: 'moq_relay', name: 'moq-relay', where: 'docker-compose.yml (MOQ_RELAY_VERSION)' },
  { key: 'moq_cli', name: 'moq-cli', where: 'server/Dockerfile' },
  { key: 'moq_watch', name: '@moq/watch', where: 'web/package.json' },
  { key: 'moq_net', name: '@moq/net', where: 'dependencia de @moq/watch, fijada en web/package-lock.json' },
  { key: 'moq_hang', name: '@moq/hang', where: 'dependencia de @moq/watch, fijada en web/package-lock.json' },
  { key: 'dashjs', name: 'dash.js', where: 'web/package.json' },
  { key: 'mediamtx', name: 'MediaMTX', where: 'docker-compose.yml (MEDIAMTX_VERSION)' },
  { key: 'ffmpeg', name: 'FFmpeg', where: 'paquete de Debian de la imagen del orquestador' },
];

const parts = (version: string) => version.split('.').map((n) => parseInt(n, 10) || 0);

/** Si `latest` es posterior a `installed`, comparando número a número. */
export function isNewer(latest: string | null | undefined, installed: string | null | undefined): boolean {
  // Un binario compilado desde un commit (git@abc1234) no tiene número de versión con el que comparar
  if (!latest || !installed || !/^\d/.test(installed)) return false;
  const [a, b] = [parts(latest), parts(installed)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** Versiones instaladas: las del servidor más las de los reproductores empaquetados con este dashboard. */
export const installedVersions = (report: VersionReport | null): Record<string, string | null> => ({
  ...(report?.installed ?? {}),
  ...__PLAYER_VERSIONS__,
});

/** Para el CSV: una sola cadena con todas las versiones desplegadas. */
export const versionsLabel = (report: VersionReport | null): string | null => {
  const installed = installedVersions(report);
  const known = COMPONENTS.filter((c) => installed[c.key]);
  return report ? known.map((c) => `${c.name}=${installed[c.key]}`).join(';') : null;
};

export const VersionsPanel: React.FC<{ report: VersionReport | null }> = ({ report }) => {
  const installed = installedVersions(report);
  const outdated = COMPONENTS.filter((c) => isNewer(report?.latest[c.key], installed[c.key]));
  const checked = report?.checked_at_ms ? new Date(report.checked_at_ms).toLocaleString() : null;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-400 font-medium mr-1">Versiones desplegadas:</span>
        {COMPONENTS.map((c) => {
          const latest = report?.latest[c.key];
          const stale = isNewer(latest, installed[c.key]);
          return (
            <span
              key={c.key}
              title={`Se fija en ${c.where}.` + (latest ? ` Última publicada: ${latest}.` : c.key === 'ffmpeg' ? ' No se consulta si hay versiones nuevas.' : '')}
              className={`px-2 py-1 rounded border font-mono ${stale ? 'border-amber-600/60 bg-amber-950/40 text-amber-200' : 'border-slate-700 bg-slate-950 text-slate-300'}`}
            >
              {c.name} <span className="font-semibold">{installed[c.key] ?? '--'}</span>
              {stale && <span className="text-amber-400"> → {latest}</span>}
            </span>
          );
        })}
      </div>
      {outdated.length > 0 && (
        <p className="mt-2 text-amber-300">
          Hay versiones más nuevas de {outdated.map((c) => c.name).join(', ')}. No se actualizan solas: hay que cambiar la versión fijada y
          volver a desplegar. Las medidas hechas con versiones distintas no son comparables entre sí.
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-slate-500">
        {checked ? `Última comprobación: ${checked}.` : 'Todavía no se ha comprobado si hay versiones nuevas.'}
        {report?.errors.length ? ` No se pudo consultar: ${report.errors.join(', ')}.` : ''} Pasa el ratón por cada una para ver dónde se fija.
      </p>
    </div>
  );
};
