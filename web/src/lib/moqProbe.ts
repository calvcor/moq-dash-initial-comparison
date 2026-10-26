// Experimento (README 6.3): adaptación de calidad de MoQ con sondeo por prioridad, a la manera que sugiere MOQT
// (draft-ietf-moq-transport-22, 14.1.2). No es el comportamiento de @moq/watch: por defecto el banco deja decidir
// a la librería. Aquí decide este controlador y se lo pide a @moq/watch por la vía pública (target.name).
//
// Idea: la calidad actual va con la prioridad de vídeo de siempre; a ratos se suscribe además la siguiente con la
// prioridad mínima. El relay solo le da lo que sobra del enlace, así que, mientras se queda atrás, lo que recibe es
// la capacidad libre: capacidad ≈ lo que recibe la actual + lo que recibe la de sondeo. Mientras se sondea siempre
// hay datos pendientes, así que el envío lo limita la red y no hay tiempos muertos que falseen la medida (lo que les
// pasa a la medida de dash.js y a la estimación del relay). Se sube si la siguiente cabe en esa capacidad, comparando
// con su bitrate real (bytes por frame × cadencia de lo recibido), no con el del catálogo, que es el pico retenido.
// Se baja cuando la actual deja de recibir frames al ritmo de su cadencia.
import type * as Watch from '@moq/watch';

/** Prioridad de la suscripción de sondeo: la mínima (en moq-lite se envía antes la mayor). */
const PROBE_PRIORITY = 0;
/** Retraso que tolera la suscripción de sondeo. Va por detrás por diseño, y solo con grupos completos se puede
 * calcular el bitrate real de la calidad: los principios de grupo empiezan por el keyframe y lo inflarían. */
const PROBE_MAX_DELAY_MS = 10000;
/** Grupos completos necesarios para fiarse del bitrate real: un grupo suelto puede ser más ligero que la media. */
const MIN_FULL_GROUPS = 2;
/** Cada cuánto se evalúa. */
const TICK_MS = 250;
/** Ventana con la que se miden caudales y frames por segundo. */
const WINDOW_MS = 2000;
/** Duración de cada sondeo y tiempo que se descarta al principio, mientras la suscripción arranca. */
const PROBE_MS = 4000;
const PROBE_WARMUP_MS = 1000;
/** Tras un cambio de calidad no se decide nada hasta que se pinta la calidad pedida (como poco SETTLE_MS y como
 * mucho SETTLE_MAX_MS): mientras dura el relevo, la librería descarga las dos y sus estadísticas las mezclan. */
const SETTLE_MS = 3000;
const SETTLE_MAX_MS = 10000;
/** Espera entre sondeos: la base, y cómo crece tras un sondeo fallido o una bajada. */
const PROBE_INTERVAL_MS = 6000;
const PROBE_INTERVAL_MAX_MS = 32000;
/** Margen sobre la capacidad estimada para subir: el mismo 80 % que aplica @moq/watch a la estimación del relay. */
const UP_MARGIN = 0.8;
/** La calidad actual va bien si recibe al menos esta fracción de su cadencia. */
const HEALTHY_FPS = 0.9;

type Rendition = { name: string; track: string; bitrate: number; fps: number };

export interface ProbeState {
  /** Calidad que el controlador pide a @moq/watch. */
  current: string | null;
  /** Hay un sondeo en curso. */
  probing: boolean;
  /** Última capacidad estimada en un sondeo (kbit/s). */
  capacityKbps: number | null;
  /** Bitrate real medido de la calidad sondeada en el último sondeo (kbit/s). */
  probeContentKbps: number | null;
  /** En el último sondeo, lo que recibían la actual y la de sondeo (kbit/s). */
  currentKbps: number | null;
  probeKbps: number | null;
  /** Frames por segundo que recibe la calidad actual (ventana de 2 s). */
  currentFps: number | null;
  /** Subidas, bajadas y sondeos desde que empezó el controlador. */
  ups: number;
  downs: number;
  probes: number;
}

type Sample = [number, number]; // [instante, valor acumulado]

/** Valor acumulado al principio de la ventana y ritmo por segundo dentro de ella. */
function ratePerSecond(samples: Sample[], now: number, windowMs: number): number | null {
  const from = now - windowMs;
  const inside = samples.filter(([t]) => t >= from);
  if (inside.length < 2) return null;
  const [t0, v0] = inside[0];
  const [t1, v1] = inside[inside.length - 1];
  if (t1 - t0 < windowMs / 2) return null;
  return ((v1 - v0) * 1000) / (t1 - t0);
}

export class MoqProbeAbr {
  readonly state: ProbeState = {
    current: null, probing: false, capacityKbps: null, probeContentKbps: null,
    currentKbps: null, probeKbps: null, currentFps: null, ups: 0, downs: 0, probes: 0,
  };
  #player: Watch.Player;
  #timer: ReturnType<typeof setInterval>;
  #settleUntil = 0;
  #settleMax = 0;
  #nextProbeAt = 0;
  #interval = PROBE_INTERVAL_MS;
  // Lo que recibe la calidad actual, según las estadísticas de la librería
  #curBytes: Sample[] = [];
  #curFrames: Sample[] = [];
  // El sondeo en curso
  #probe: {
    rendition: Rendition;
    started: number;
    close: () => void;
    bytes: number;
    frames: number;
    fullBytes: number;
    fullFrames: number;
    fullGroups: number;
    samples: { bytes: Sample[]; frames: Sample[] };
    healthy: boolean;
  } | null = null;

  constructor(player: Watch.Player) {
    this.#player = player;
    this.#timer = setInterval(() => this.#tick(performance.now()), TICK_MS);
  }

  close() {
    clearInterval(this.#timer);
    this.#stopProbe();
  }

  #ladder(): Rendition[] {
    const available = this.#player.video.source.out.available.peek() as Record<string, any>;
    return Object.entries(available ?? {})
      .map(([name, c]) => ({ name, track: c.track ?? name, bitrate: c.bitrate ?? 0, fps: c.framerate ?? 30 }))
      .sort((a, b) => a.bitrate - b.bitrate);
  }

  #tick(now: number) {
    const ladder = this.#ladder();
    if (ladder.length === 0) return;
    let index = ladder.findIndex((r) => r.name === this.state.current);
    if (index < 0) {
      // Arranca en la más baja y sube sondeando
      index = 0;
      this.#switchTo(ladder[0].name, now);
      return;
    }

    const stats = this.#player.video.out.stats.peek();
    if (stats) {
      this.#curBytes.push([now, stats.bytesReceived]);
      this.#curFrames.push([now, stats.frameCount]);
      const keep = now - 4 * WINDOW_MS;
      while (this.#curBytes.length && this.#curBytes[0][0] < keep) this.#curBytes.shift();
      while (this.#curFrames.length && this.#curFrames[0][0] < keep) this.#curFrames.shift();
    }
    const current = ladder[index];
    if (now < this.#settleUntil) return;
    if (now < this.#settleMax) {
      const available = this.#player.video.source.out.available.peek() as Record<string, any>;
      const painted = this.#player.video.out.frame.peek()?.displayHeight;
      if (painted !== available?.[current.name]?.codedHeight) return;
      // Relevo hecho: se empieza a medir la calidad nueva desde aquí
      this.#settleMax = 0;
      this.#curBytes = [];
      this.#curFrames = [];
      return;
    }
    // ¿La actual llega al ritmo de su cadencia? Frames recibidos por segundo en la ventana: un corte suelto no
    // basta para bajar, una pérdida sostenida de ritmo sí.
    const curFps = ratePerSecond(this.#curFrames, now, WINDOW_MS);
    const healthy = curFps === null || curFps >= HEALTHY_FPS * current.fps;
    this.state.currentFps = curFps === null ? null : Math.round(curFps);

    if (this.#probe) {
      const p = this.#probe;
      p.samples.bytes.push([now, p.bytes]);
      p.samples.frames.push([now, p.frames]);
      // El sondeo no debe perjudicar a la actual: si se queda atrás, se corta y se espera más
      if (!healthy && now - p.started > PROBE_WARMUP_MS) {
        p.healthy = false;
        this.#endProbe(now, false);
        return;
      }
      if (now - p.started >= PROBE_MS) this.#endProbe(now, true);
      return;
    }

    if (!healthy) {
      if (index > 0) {
        this.state.downs++;
        this.#interval = Math.min(this.#interval * 2, PROBE_INTERVAL_MAX_MS);
        this.#switchTo(ladder[index - 1].name, now);
        this.#nextProbeAt = now + SETTLE_MS + this.#interval;
      }
      return;
    }

    if (index < ladder.length - 1 && now >= this.#nextProbeAt) this.#startProbe(ladder[index + 1], now);
  }

  #switchTo(name: string, now: number) {
    this.state.current = name;
    this.#settleUntil = now + SETTLE_MS;
    this.#settleMax = now + SETTLE_MAX_MS;
    this.#curBytes = [];
    this.#curFrames = [];
  }

  #startProbe(rendition: Rendition, now: number) {
    const broadcast = (this.#player.broadcast.out.active.peek() as any) ?? null;
    if (!broadcast) return;
    let closed = false;
    const sub = broadcast.track(rendition.track).subscribe({ priority: PROBE_PRIORITY, maxDelay: PROBE_MAX_DELAY_MS });
    const probe = {
      rendition,
      started: now,
      close: () => {
        closed = true;
        try {
          sub.close();
        } catch (_) {}
      },
      bytes: 0,
      frames: 0,
      // Bytes y frames de los grupos que terminaron enteros
      fullBytes: 0,
      fullFrames: 0,
      fullGroups: 0,
      samples: { bytes: [[now, 0]] as Sample[], frames: [[now, 0]] as Sample[] },
      healthy: true,
    };
    this.#probe = probe;
    this.state.probing = true;
    this.state.probes++;
    // Solo se cuentan bytes y frames: no se decodifica nada
    (async () => {
      for (;;) {
        const group = await sub.recvGroup();
        if (!group || closed) break;
        (async () => {
          let bytes = 0;
          let frames = 0;
          for (;;) {
            const frame = await group.readFrame();
            if (closed) return;
            if (!frame) {
              // Fin limpio del grupo: está entero (un grupo cancelado termina con error, no aquí)
              probe.fullBytes += bytes;
              probe.fullFrames += frames;
              probe.fullGroups++;
              return;
            }
            bytes += frame.payload.byteLength;
            frames++;
            probe.bytes += frame.payload.byteLength;
            probe.frames++;
          }
        })().catch(() => {});
      }
    })().catch(() => {});
  }

  #stopProbe() {
    this.#probe?.close();
    this.#probe = null;
    this.state.probing = false;
  }

  #endProbe(now: number, completed: boolean) {
    const p = this.#probe!;
    // Ventana de medida: lo último del sondeo, sin el arranque
    const windowMs = Math.min(WINDOW_MS, now - p.started - PROBE_WARMUP_MS);
    const probeRate = windowMs > 0 ? ratePerSecond(p.samples.bytes, now, windowMs) : null; // bytes/s
    const curRate = windowMs > 0 ? ratePerSecond(this.#curBytes, now, windowMs) : null;
    // Bitrate real de la calidad sondeada: bytes por frame × cadencia, con los grupos enteros. Sin ninguno entero no
    // se puede saber y no se sube.
    const content = p.fullGroups >= MIN_FULL_GROUPS ? (p.fullBytes / p.fullFrames) * p.rendition.fps * 8 : null; // bit/s
    const capacity = probeRate !== null && curRate !== null ? (probeRate + curRate) * 8 : null; // bit/s
    this.state.capacityKbps = capacity !== null ? Math.round(capacity / 1000) : null;
    this.state.currentKbps = curRate !== null ? Math.round((curRate * 8) / 1000) : null;
    this.state.probeKbps = probeRate !== null ? Math.round((probeRate * 8) / 1000) : null;
    this.state.probeContentKbps = content !== null ? Math.round(content / 1000) : null;
    this.#stopProbe();

    if (completed && p.healthy && capacity !== null && content !== null && capacity * UP_MARGIN >= content) {
      this.state.ups++;
      this.#interval = PROBE_INTERVAL_MS;
      this.#switchTo(p.rendition.name, now);
      // Tras subir, se sondea la siguiente pronto
      this.#nextProbeAt = now + SETTLE_MS + 2000;
    } else {
      this.#interval = Math.min(this.#interval * 2, PROBE_INTERVAL_MAX_MS);
      this.#nextProbeAt = now + this.#interval;
    }
  }
}
