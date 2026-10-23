// Prueba de QoE, lado del navegador (fase c): mientras el servidor graba el flujo codificado, el medidor
// glass-to-glass de cada reproductor anota cada frame nuevo que pinta, y al final cada uno sube su registro.
// El servidor lo traduce a número de frame con el índice de la grabación (server/app/qoe.py).
//
// El registro empieza prerollS después de pedir la grabación: los frames que se pintan al principio se
// codificaron antes (la latencia) y tienen que estar ya grabados. Los que aun así caen fuera se cuentan
// aparte en el servidor.

import { getClockSync } from './clock';
import type { GlassMeter, ViewLog } from './glass';

export type PlayerId = 'dash' | 'moq' | 'rtc';

/** El medidor de cada reproductor montado; cada componente registra el suyo. */
export const meters: Partial<Record<PlayerId, GlassMeter>> = {};

export interface QoETestOptions {
  durationS: number;
  prerollS?: number;
  players: PlayerId[];
  onPhase?: (phase: 'recording' | 'logging' | 'uploading' | 'done', untilMs?: number) => void;
}

export interface QoETestResult {
  id: string;
  views: Partial<Record<PlayerId, unknown>>; // respuesta del servidor a cada subida
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runQoETest({ durationS, prerollS = 5, players, onPhase }: QoETestOptions): Promise<QoETestResult> {
  if (!getClockSync()) throw new Error('Sin sincronización de reloj con el servidor');
  const active = players.filter((p) => meters[p]);
  if (!active.length) throw new Error('No hay ningún reproductor activo');

  // La grabación cubre el margen inicial, la prueba y 2 s más para los frames que se pintan al final
  const res = await fetch('/api/qoe/recordings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duration_s: prerollS + durationS + 2 }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `No se pudo grabar (${res.status})`);
  const { id } = await res.json();
  onPhase?.('recording', Date.now() + prerollS * 1000);
  await sleep(prerollS * 1000);

  let hidden = document.hidden;
  const onVisibility = () => {
    if (document.hidden) hidden = true;
  };
  document.addEventListener('visibilitychange', onVisibility);
  for (const p of active) meters[p]!.startLog();
  onPhase?.('logging', Date.now() + durationS * 1000);
  await sleep(durationS * 1000);
  const logs: Partial<Record<PlayerId, ViewLog | null>> = {};
  for (const p of active) logs[p] = meters[p]?.stopLog() ?? null;
  document.removeEventListener('visibilitychange', onVisibility);

  onPhase?.('uploading');
  const clock = getClockSync();
  const views: QoETestResult['views'] = {};
  for (const p of active) {
    const log = logs[p];
    if (!log) continue;
    const upload = await fetch(`/api/qoe/recordings/${id}/views/${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frames: log.frames,
        gaps: log.gaps,
        unreadable: log.unreadable,
        window_ms: [log.startMs, log.endMs],
        clock_offset_ms: clock?.offsetMs ?? null,
        clock_rtt_ms: clock?.rttMs ?? null,
        hidden,
        user_agent: navigator.userAgent,
      }),
    });
    views[p] = upload.ok ? await upload.json() : { error: `${upload.status} ${await upload.text()}` };
  }
  onPhase?.('done');
  return { id, views };
}
