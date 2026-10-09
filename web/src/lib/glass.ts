// Medida glass-to-glass leyendo el timecode binario que el servidor quema en el vídeo.
// El mismo medidor se aplica a los tres reproductores, así que todas las ramas se miden con idéntico
// método e incluyen codificación, empaquetado, red, búfer, decodificación y pintado.
//
// El timecode se lee del propio frame de vídeo (VideoFrame.copyTo), copiando solo dos filas de la franja
// y de forma asíncrona. La versión anterior dibujaba el vídeo en un canvas y lo leía con getImageData en
// cada frame: una copia síncrona de GPU a CPU por reproductor que saturaba el hilo principal, sobre todo
// en Brave, y con ello degradaba al reproductor MoQ, que pinta en ese mismo hilo. Un medidor que altera
// lo que mide no sirve.

import { serverNowMs } from './clock';
import type { TimecodeLayout } from '../types';

export const DEFAULT_TIMECODE: TimecodeLayout = { bits: 20, cell: 32, x: 64, y: 992, width: 1920, height: 1080 };

/** Devuelve un VideoFrame propio con lo que el reproductor muestra ahora, o null. Quien lo pide lo cierra. */
export type FrameGrabber = () => VideoFrame | null;

/** El frame que está mostrando un <video>. */
export function grabFromVideo(video: HTMLVideoElement | null): VideoFrame | null {
  if (!video || video.readyState < 2 || !video.videoWidth) return null;
  try {
    return new VideoFrame(video);
  } catch (_) {
    return null;
  }
}

const WINDOW_MS = 1000;
const FPS_WINDOW_MS = 2000;
const STALL_MS = 150; // ~9 frames a 60 fps sin imagen nueva
const SAMPLER_GAP_MS = 250; // el propio muestreo se detuvo (pestaña oculta, hilo bloqueado)

// Vigilancia de los reproductores: sin imagen nueva durante WATCHDOG_MS se recrea el reproductor,
// dejando WATCHDOG_GRACE_MS desde cada arranque para conectar y llenar el búfer.
export const WATCHDOG_MS = 10000;
export const WATCHDOG_GRACE_MS = 20000;

export interface GlassSnapshot {
  latencyMs: number | null; // mediana de los frames presentados en el último segundo
  fps: number | null; // frames distintos presentados por segundo, media de los últimos 2 s
  stalls: number;
  stallMs: number;
}

export class GlassMeter {
  #getLayouts: () => TimecodeLayout[];
  #grab: FrameGrabber;
  #buffer = new Uint8Array(0);
  #reading = false;
  #raf = 0;
  #channel = new MessageChannel();
  #frameTime = 0;
  #lastTick = 0;
  #lastCode: number | null = null;
  #lastChange = 0;
  #inStall = false;
  #stalls = 0;
  #stallMs = 0;
  #samples: { t: number; latency: number }[] = [];

  constructor(grab: FrameGrabber, getLayouts: () => TimecodeLayout[] = () => [DEFAULT_TIMECODE]) {
    this.#grab = grab;
    this.#getLayouts = getLayouts;

    // Se lee en una tarea posterior a la fase de requestAnimationFrame para ver lo que este frame
    // acaba de entregar al compositor, sea cual sea el orden de los callbacks de cada reproductor.
    this.#channel.port1.onmessage = () => this.#sample(this.#frameTime);
    const tick = (t: number) => {
      this.#frameTime = t;
      this.#channel.port2.postMessage(null);
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  close() {
    cancelAnimationFrame(this.#raf);
    this.#channel.port1.close();
  }

  /** Tiempo sin imagen nueva, o null si el propio muestreo está parado (pestaña oculta) y no se puede saber. */
  frozenMs(): number | null {
    if (performance.now() - this.#lastTick > SAMPLER_GAP_MS) return null;
    return this.#lastTick - this.#lastChange;
  }

  snapshot(): GlassSnapshot {
    const counters = { stalls: this.#stalls, stallMs: Math.round(this.#stallMs) };
    // Con el muestreo parado (pestaña oculta) no hay medida actual
    if (performance.now() - this.#lastTick > SAMPLER_GAP_MS) return { latencyMs: null, fps: null, ...counters };

    // Las ventanas se anclan al último frame muestreado, no al instante de la consulta: las muestras
    // llevan la hora de su frame y contarlas hasta "ahora" deja fuera de media un frame por ventana.
    const end = this.#lastTick;
    this.#samples = this.#samples.filter((s) => s.t > end - FPS_WINDOW_MS);
    const sorted = this.#samples
      .filter((s) => s.t > end - WINDOW_MS)
      .map((s) => s.latency)
      .sort((a, b) => a - b);
    return {
      latencyMs: sorted.length ? Math.round(sorted[sorted.length >> 1]) : null,
      // Intervalos entre frames, no frames por ventana: contar en una ventana fija oscila ±1 según la fase
      fps: sorted.length > 1 ? Math.round(((this.#samples.length - 1) * 10000) / (end - this.#samples[0].t)) / 10 : null,
      ...counters,
    };
  }

  async #sample(t: number) {
    // Si el muestreo estuvo parado no se puede distinguir un congelado real: no se cuenta
    if (t - this.#lastTick > SAMPLER_GAP_MS) {
      this.#lastChange = t;
      this.#inStall = false;
    }
    this.#lastTick = t;

    // La lectura es asíncrona: si la anterior no ha terminado, este frame de pantalla se salta
    if (this.#reading) return;
    const frame = this.#grab();
    if (!frame) return;
    this.#reading = true;
    let code: number | null = null;
    try {
      code = await this.decode(frame);
    } finally {
      frame.close();
      this.#reading = false;
    }
    if (code === null) return;

    if (code === this.#lastCode) {
      if (!this.#inStall && t - this.#lastChange > STALL_MS) {
        this.#inStall = true;
        this.#stalls++;
      }
      return;
    }

    if (this.#inStall) {
      this.#stallMs += t - this.#lastChange;
      this.#inStall = false;
    }
    this.#lastCode = code;
    this.#lastChange = t;

    const now = serverNowMs(t);
    if (now === null) return;
    const span = 2 ** DEFAULT_TIMECODE.bits;
    let latency = (((now - code) % span) + span) % span;
    if (latency > span / 2) latency -= span; // negativa: reloj mal sincronizado, se deja visible
    this.#samples.push({ t, latency });
  }

  /**
   * Timecode (ms mod 2^bits) quemado en ese frame, o null si no se puede leer con garantías.
   * No cierra el frame. Lo usan también los trazadores de etapas, que necesitan seguir un frame concreto.
   */
  async decode(frame: VideoFrame): Promise<number | null> {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (!w || !h) return null;

    // Cada calidad lleva su timecode con su propio tamaño de celda: se usa el de la altura que se está viendo
    const layouts = this.#getLayouts();
    const layout = layouts.find((l) => l.height === h) ?? layouts[0] ?? DEFAULT_TIMECODE;
    const { bits, cell } = layout;
    const n = bits + 4;
    const scale = w / layout.width;
    const cellPx = cell * scale;

    // Solo dos filas del centro de la franja. Coordenadas pares, como exigen los formatos 4:2:0.
    const even = (value: number) => Math.floor(value / 2) * 2;
    const visible = frame.visibleRect!;
    const rect = {
      x: visible.x + even(layout.x * scale),
      y: visible.y + even((layout.y + cell / 2) * scale - 1),
      width: Math.min(even(n * cellPx + 1), even(visible.width - layout.x * scale)),
      height: 2,
    };
    let planes: PlaneLayout[];
    try {
      const size = frame.allocationSize({ rect });
      if (this.#buffer.length < size) this.#buffer = new Uint8Array(size);
      planes = await frame.copyTo(this.#buffer, { rect });
    } catch (_) {
      return null;
    }
    // Formatos planares (NV12, I420...): el primer plano es la luma. Empaquetados (RGBA, BGRA...): 4 bytes
    // por píxel, y como luma basta la media de los tres primeros.
    const px = this.#buffer;
    const { offset, stride } = planes[0];
    const packed = planes.length === 1;
    const at = (row: number, col: number) => {
      const o = offset + row * stride + (packed ? col * 4 : col);
      return packed ? (px[o] + px[o + 1] + px[o + 2]) / 3 : px[o];
    };

    // Luma media de los 2x2 píxeles centrales de cada celda
    const luma = (i: number) => {
      const col = Math.min(rect.width - 2, Math.floor((i + 0.5) * cellPx) - 1);
      return (at(0, col) + at(0, col + 1) + at(1, col) + at(1, col + 1)) / 4;
    };

    // Las celdas de referencia de los extremos fijan el umbral y delatan una imagen sin timecode
    const white = Math.min(luma(0), luma(n - 1));
    const black = Math.max(luma(1), luma(n - 2));
    const range = white - black;
    if (range < 80) return null;
    const threshold = black + range / 2;

    let bit = 0;
    let value = 0;
    for (let i = 0; i < bits; i++) {
      const l = luma(2 + i);
      if (Math.abs(l - threshold) < range * 0.2) return null; // celda ambigua
      bit ^= l > threshold ? 1 : 0; // Gray → binario, de MSB a LSB
      value = value * 2 + bit;
    }
    return value;
  }
}

/** Tasa media (kbps) a partir de un contador acumulado de bytes, sobre una ventana deslizante. */
export class RateWindow {
  #samples: { t: number; bytes: number }[] = [];
  #windowMs: number;

  constructor(windowMs = 10000) {
    this.#windowMs = windowMs;
  }

  push(bytes: number, t: number = performance.now()) {
    this.#samples.push({ t, bytes });
    while (this.#samples.length > 2 && t - this.#samples[1].t >= this.#windowMs) this.#samples.shift();
  }

  kbps(): number | null {
    const first = this.#samples[0];
    const last = this.#samples[this.#samples.length - 1];
    if (!first || last.t - first.t < 1000) return null;
    // Sin datos nuevos durante toda la ventana: el flujo se ha cortado
    if (performance.now() - last.t > this.#windowMs) return null;
    return Math.round(((last.bytes - first.bytes) * 8) / (last.t - first.t));
  }
}
