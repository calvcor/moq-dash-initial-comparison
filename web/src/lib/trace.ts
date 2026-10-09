// Desglose de la latencia glass-to-glass por etapas, frame a frame y solo con horas medidas.
//
// Para un frame que se acaba de pintar se conocen, en el navegador, su marca de origen (timecode
// quemado), cuándo llegó y cuándo se pintó. Al servidor se le pregunta por ese mismo frame, identificado
// por esa marca, cuándo salió del codificador y (en DASH) cuándo quedó empaquetado. Cada etapa es la
// diferencia entre dos de esas horas, así que la suma de etapas es la latencia total de ese frame.

import { serverNowMs } from './clock';
import { DEFAULT_TIMECODE, type GlassMeter } from './glass';
import type { StageBreakdown } from '../types';

const SAMPLE_EVERY_MS = 200; // un frame de cada ~12
const REPORT_EVERY_MS = 1000;
const SPAN = 2 ** DEFAULT_TIMECODE.bits;

interface Sample {
  stampMs: number; // hora del servidor quemada en el frame
  paintedMs: number; // hora del servidor a la que se pintó
  id: number; // tiempo de medios (DASH, s) o marca de tiempo (MoQ, µs)
}

/** Hora completa de la marca a partir del timecode (que solo lleva los 20 bits bajos) y de cuándo se vio. */
function stampFromCode(code: number, seenMs: number): number {
  return seenMs - ((((seenMs - code) % SPAN) + SPAN) % SPAN);
}

/** El frame de latencia total mediana entre los seguidos en el último periodo, con sus etapas. */
function summarize(rows: Record<string, number>[]): StageBreakdown | null {
  // Una etapa negativa significa que alguna hora no corresponde a ese frame: la muestra no vale
  const valid = rows.filter((row) => Object.values(row).every((ms) => Number.isFinite(ms) && ms > -20));
  if (!valid.length) return null;
  // Se muestra un frame real y no la mediana de cada etapa por separado: así las etapas suman
  // exactamente su latencia de extremo a extremo.
  const total = (row: Record<string, number>) => Object.values(row).reduce((sum, ms) => sum + ms, 0);
  const chosen = [...valid].sort((a, b) => total(a) - total(b))[valid.length >> 1];
  const stages = Object.keys(chosen).map((key) => ({ key, ms: Math.round(chosen[key]) }));
  return { stages, totalMs: stages.reduce((sum, stage) => sum + stage.ms, 0), samples: valid.length };
}

async function askServer(body: object): Promise<{ dash: any[]; moq: any[] } | null> {
  try {
    const res = await fetch('/api/trace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  }
}

export class DashTracer {
  #closed = false;
  #samples: Sample[] = [];
  #buffered: { t: number; end: number }[] = []; // hasta qué tiempo de medios había datos en el búfer, y cuándo
  #timers: ReturnType<typeof setInterval>[] = [];

  constructor(video: HTMLVideoElement, meter: GlassMeter, getStream: () => number, onResult: (breakdown: StageBreakdown | null) => void) {
    // Cada frame presentado trae su tiempo de medios exacto; se lee su timecode en ese mismo instante
    let lastSample = 0;
    const onFrame = (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (this.#closed) return;
      const seenMs = serverNowMs(now);
      if (now - lastSample >= SAMPLE_EVERY_MS && seenMs !== null) {
        const code = meter.readCode();
        if (code !== null) {
          lastSample = now;
          this.#samples.push({ stampMs: stampFromCode(code, seenMs), paintedMs: seenMs, id: metadata.mediaTime });
        }
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);

    // Llegada al reproductor: el instante en que el búfer pasa a contener ese tiempo de medios
    this.#timers.push(
      setInterval(() => {
        const ranges = video.buffered;
        for (let i = 0; i < ranges.length; i++) {
          if (ranges.start(i) <= video.currentTime + 0.5 && video.currentTime <= ranges.end(i)) {
            this.#buffered.push({ t: performance.now(), end: ranges.end(i) });
          }
        }
        const cutoff = performance.now() - 30000;
        while (this.#buffered.length && this.#buffered[0].t < cutoff) this.#buffered.shift();
      }, 20),
    );

    this.#timers.push(
      setInterval(async () => {
        const samples = this.#samples.splice(0);
        const stream = getStream();
        if (!samples.length || stream < 0) return onResult(null);
        const answer = await askServer({ dash_stream: stream, dash_stamps_ms: samples.map((s) => s.stampMs) });
        if (this.#closed) return;
        const rows: Record<string, number>[] = [];
        samples.forEach((sample, i) => {
          const server = answer?.dash[i];
          const arrived = this.#buffered.find((entry) => entry.end > sample.id + 0.001);
          const arrivedMs = arrived ? serverNowMs(arrived.t) : null;
          if (!server || server.encoded_ms === null || server.packaged_ms === null || arrivedMs === null) return;
          rows.push({
            encode: server.encoded_ms - server.stamp_ms,
            package: server.packaged_ms - server.encoded_ms,
            deliver: arrivedMs - server.packaged_ms,
            player: sample.paintedMs - arrivedMs,
          });
        });
        onResult(summarize(rows));
      }, REPORT_EVERY_MS),
    );
  }

  close() {
    this.#closed = true;
    this.#timers.forEach(clearInterval);
  }
}

// Lo que se necesita del reproductor de @moq/watch, sin atarse a sus tipos internos
interface MoqPlayerLike {
  sync: { out: { timestamp: { subscribe(fn: (ms: number | undefined) => void): () => void } } };
  renderer: { out: { frame: { peek(): VideoFrame | undefined } } };
}

export class MoqTracer {
  #closed = false;
  #samples: Sample[] = [];
  #arrivals: { t: number; ms: number }[] = []; // marca de tiempo más alta recibida de la red, y cuándo
  #timers: ReturnType<typeof setInterval>[] = [];
  #raf = 0;
  #channel = new MessageChannel();
  #unsubscribe: () => void;

  constructor(player: MoqPlayerLike, meter: GlassMeter, getStream: () => number, onResult: (breakdown: StageBreakdown | null) => void) {
    // Llegada al reproductor: @moq/watch anota cada frame al leerlo de la red, antes de decodificarlo
    this.#unsubscribe = player.sync.out.timestamp.subscribe((ms) => {
      if (ms === undefined) return;
      const now = performance.now();
      this.#arrivals.push({ t: now, ms });
      while (this.#arrivals.length && this.#arrivals[0].t < now - 30000) this.#arrivals.shift();
    });

    // Pintado: igual que el medidor glass-to-glass, se mira el canvas justo después de que el reproductor
    // dibuje, y se anota qué frame era
    let frameTime = 0;
    let lastSample = 0;
    this.#channel.port1.onmessage = () => {
      const seenMs = serverNowMs(frameTime);
      const frame = player.renderer.out.frame.peek();
      if (frameTime - lastSample < SAMPLE_EVERY_MS || seenMs === null || !frame) return;
      const code = meter.readCode();
      if (code === null) return;
      lastSample = frameTime;
      this.#samples.push({ stampMs: stampFromCode(code, seenMs), paintedMs: seenMs, id: frame.timestamp });
    };
    const tick = (t: number) => {
      frameTime = t;
      this.#channel.port2.postMessage(null);
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);

    this.#timers.push(
      setInterval(async () => {
        const samples = this.#samples.splice(0);
        const stream = getStream();
        if (!samples.length || stream < 0) return onResult(null);
        const answer = await askServer({ moq_stream: stream, moq_stamps_ms: samples.map((s) => s.stampMs) });
        if (this.#closed) return;
        const rows: Record<string, number>[] = [];
        samples.forEach((sample, i) => {
          const server = answer?.moq[i];
          const arrived = this.#arrivals.find((entry) => entry.ms >= sample.id / 1000 - 0.5);
          const arrivedMs = arrived ? serverNowMs(arrived.t) : null;
          if (!server || server.encoded_ms === null || arrivedMs === null) return;
          rows.push({
            encode: server.encoded_ms - server.stamp_ms,
            ingest: server.forwarded_ms - server.encoded_ms,
            transport: arrivedMs - server.forwarded_ms,
            player: sample.paintedMs - arrivedMs,
          });
        });
        onResult(summarize(rows));
      }, REPORT_EVERY_MS),
    );
  }

  close() {
    this.#closed = true;
    this.#timers.forEach(clearInterval);
    cancelAnimationFrame(this.#raf);
    this.#channel.port1.close();
    this.#unsubscribe();
  }
}
