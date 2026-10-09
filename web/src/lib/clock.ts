// Sincronización del reloj del navegador con el del orquestador, que es el que FFmpeg quema en el timecode.
// Estilo NTP: de una ráfaga de sondeos se queda con el de menor RTT; la incertidumbre es ±RTT/2.

export interface ClockSync {
  offsetMs: number; // reloj servidor − reloj navegador
  rttMs: number;
  syncedAt: number; // performance.now() de la última sincronización válida
}

let current: ClockSync | null = null;

export const getClockSync = () => current;

/** Hora del servidor (ms epoch) correspondiente a un instante de performance.now(). */
export function serverNowMs(perfNow: number = performance.now()): number | null {
  if (!current) return null;
  return performance.timeOrigin + perfNow + current.offsetMs;
}

export async function syncClock(apiBase: string, probes = 8): Promise<ClockSync | null> {
  let best: ClockSync | null = null;
  for (let i = 0; i < probes; i++) {
    try {
      const t0 = performance.now();
      const res = await fetch(`${apiBase}/api/time`, { cache: 'no-store' });
      const { t_ms } = await res.json();
      const t1 = performance.now();
      const rttMs = t1 - t0;
      if (!best || rttMs < best.rttMs) {
        best = { offsetMs: t_ms - (performance.timeOrigin + (t0 + t1) / 2), rttMs, syncedAt: t1 };
      }
    } catch (_) {
      // Backend apagado
    }
  }
  if (best) current = best;
  return current;
}
