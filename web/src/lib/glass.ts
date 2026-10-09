// Medida glass-to-glass leyendo el timecode binario que el servidor quema en el vídeo.
// El mismo medidor se aplica al <video> de dash.js y al <canvas> de MoQ, así que ambas ramas
// se miden con idéntico método e incluyen codificación, empaquetado, red, búfer, decodificación y pintado.

import { serverNowMs } from './clock';
import type { TimecodeLayout } from '../types';

export const DEFAULT_TIMECODE: TimecodeLayout = { bits: 20, cell: 32, x: 64, y: 992, width: 1920, height: 1080 };

type Source = HTMLVideoElement | HTMLCanvasElement;

const PX = 4; // píxeles de sonda por celda
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
  #getSource: () => Source | null;
  #ctx: CanvasRenderingContext2D;
  #cells: number;
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

  constructor(getSource: () => Source | null, getLayouts: () => TimecodeLayout[] = () => [DEFAULT_TIMECODE]) {
    this.#getSource = getSource;
    this.#getLayouts = getLayouts;
    this.#cells = DEFAULT_TIMECODE.bits + 4;
    const canvas = document.createElement('canvas');
    canvas.width = this.#cells * PX;
    canvas.height = PX;
    this.#ctx = canvas.getContext('2d', { willReadFrequently: true })!;

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

  #sample(t: number) {
    // Si el muestreo estuvo parado no se puede distinguir un congelado real: no se cuenta
    if (t - this.#lastTick > SAMPLER_GAP_MS) {
      this.#lastChange = t;
      this.#inStall = false;
    }
    this.#lastTick = t;

    const code = this.#read();
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

  /** Devuelve el timecode (ms mod 2^bits) del frame visible, o null si no se puede leer con garantías. */
  #read(): number | null {
    const src = this.#getSource();
    if (!src) return null;
    const w = src instanceof HTMLVideoElement ? src.videoWidth : src.width;
    const h = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
    if (!w || !h) return null;

    // Cada calidad lleva su timecode con su propio tamaño de celda: se usa el de la altura que se está viendo
    const layouts = this.#getLayouts();
    const layout = layouts.find((l) => l.height === h) ?? layouts[0] ?? DEFAULT_TIMECODE;
    const { bits, cell, x, y, width, height } = layout;
    const n = this.#cells;
    try {
      this.#ctx.drawImage(src, (x * w) / width, (y * h) / height, (n * cell * w) / width, (cell * h) / height, 0, 0, n * PX, PX);
    } catch (_) {
      return null;
    }
    const px = this.#ctx.getImageData(0, 0, n * PX, PX).data;

    // Luma media de los 2x2 píxeles centrales de cada celda
    const luma = (i: number) => {
      let sum = 0;
      for (let row = 1; row <= 2; row++) {
        for (let col = 1; col <= 2; col++) {
          const o = (row * n * PX + i * PX + col) * 4;
          sum += 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
        }
      }
      return sum / 4;
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
