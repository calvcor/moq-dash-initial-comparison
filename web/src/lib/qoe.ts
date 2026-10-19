import { serverNowMs } from './clock';
import { DEFAULT_TIMECODE, decodeTimecodeFromFrame } from './glass';
import type {
  TimecodeLayout,
  QoEFrameSample,
  QoEStallEvent,
  QoEEvaluationRequest,
  QoEEvaluationResponse,
} from '../types';

const STALL_THRESHOLD_MS = 150; // ~9 frames a 60 fps sin cambio
const SAMPLER_GAP_MS = 250;

export type FrameGrabber = () => VideoFrame | null;

export interface QoERunnerOptions {
  protocol: 'dash' | 'moq' | 'rtc';
  durationS: number;
  grab: FrameGrabber;
  getLayouts?: () => TimecodeLayout[];
  getPlaybackRate?: () => number;
  getRenditionHeight?: () => number;
  targetLatencyMs?: number | null;
  onProgress?: (elapsedS: number, remainingS: number, liveQoE: { vmaf: number; latencyMs: number } | null) => void;
}

export class QoERunner {
  #protocol: 'dash' | 'moq' | 'rtc';
  #durationS: number;
  #grab: FrameGrabber;
  #getLayouts: () => TimecodeLayout[];
  #getPlaybackRate: () => number;
  #getRenditionHeight: () => number;
  #targetLatencyMs: number | null;
  #onProgress?: (elapsedS: number, remainingS: number, liveQoE: { vmaf: number; latencyMs: number } | null) => void;

  #raf = 0;
  #channel = new MessageChannel();
  #reading = false;
  #bufferHolder = { buffer: new Uint8Array(0) };

  #running = false;
  #startWallTime = 0;
  #lastTick = 0;
  #lastTimestamp: number | null = null;
  #lastCode: number | null = null;
  #lastChange = 0;
  #inStall = false;
  #currentStallStart = 0;
  #currentStallCode: number | null = null;

  #frames: QoEFrameSample[] = [];
  #stalls: QoEStallEvent[] = [];

  constructor(opts: QoERunnerOptions) {
    this.#protocol = opts.protocol;
    this.#durationS = opts.durationS;
    this.#grab = opts.grab;
    this.#getLayouts = opts.getLayouts ?? (() => [DEFAULT_TIMECODE]);
    this.#getPlaybackRate = opts.getPlaybackRate ?? (() => 1.0);
    this.#getRenditionHeight = opts.getRenditionHeight ?? (() => 1080);
    this.#targetLatencyMs = opts.targetLatencyMs ?? null;
    this.#onProgress = opts.onProgress;

    this.#channel.port1.onmessage = () => this.#sample(this.#lastTick);
  }

  start(): Promise<QoEEvaluationResponse> {
    return new Promise((resolve, reject) => {
      this.#running = true;
      this.#startWallTime = performance.now();
      this.#lastChange = this.#startWallTime;
      this.#lastTimestamp = null;
      this.#lastCode = null;
      this.#frames = [];
      this.#stalls = [];
      this.#inStall = false;
      this.#currentStallCode = null;

      const tick = (t: number) => {
        if (!this.#running) return;

        this.#lastTick = t;
        this.#channel.port2.postMessage(null);

        const elapsedS = (t - this.#startWallTime) / 1000;
        const remainingS = Math.max(0, this.#durationS - elapsedS);

        if (this.#onProgress) {
          const lastSample = this.#frames.length ? this.#frames[this.#frames.length - 1] : null;
          this.#onProgress(
            Math.round(elapsedS * 10) / 10,
            Math.round(remainingS * 10) / 10,
            lastSample ? { vmaf: 90, latencyMs: Math.round(lastSample.latency_ms) } : null
          );
        }

        if (elapsedS >= this.#durationS) {
          this.stop();
          this.#evaluate()
            .then(resolve)
            .catch(reject);
          return;
        }

        this.#raf = requestAnimationFrame(tick);
      };

      this.#raf = requestAnimationFrame(tick);
    });
  }

  stop() {
    this.#running = false;
    cancelAnimationFrame(this.#raf);
    if (this.#inStall && this.#currentStallCode !== null) {
      const now = performance.now();
      this.#stalls.push({
        start_wall_time_ms: this.#currentStallStart,
        duration_ms: now - this.#currentStallStart,
        frozen_timecode_ms: this.#currentStallCode,
      });
      this.#inStall = false;
    }
  }

  #checkStall(code: number, t: number) {
    if (!this.#inStall && t - this.#lastChange > STALL_THRESHOLD_MS) {
      this.#inStall = true;
      this.#currentStallStart = this.#lastChange;
      this.#currentStallCode = code;
    }
  }

  async #sample(t: number) {
    if (!this.#running) return;

    if (t - this.#lastTick > SAMPLER_GAP_MS) {
      this.#lastChange = t;
      this.#inStall = false;
    }

    if (this.#reading) return;
    const frame = this.#grab();
    if (!frame) return;

    // Si el timestamp no ha cambiado, no hay nuevo frame en pantalla.
    // Evitamos llamar a copyTo() innecesariamente (crítico para estabilidad de GPU en Chromium/Brave).
    const ts = frame.timestamp;
    if (this.#lastTimestamp !== null && ts !== null && ts === this.#lastTimestamp && this.#lastCode !== null) {
      frame.close();
      this.#checkStall(this.#lastCode, t);
      return;
    }

    this.#reading = true;
    let code: number | null = null;
    try {
      code = await decodeTimecodeFromFrame(frame, this.#getLayouts(), this.#bufferHolder);
    } finally {
      frame.close();
      this.#reading = false;
    }

    if (code === null) return;
    this.#lastTimestamp = ts;

    // Comprobar parón
    if (code === this.#lastCode) {
      this.#checkStall(code, t);
      return;
    }

    // Imagen ha avanzado
    if (this.#inStall) {
      this.#stalls.push({
        start_wall_time_ms: this.#currentStallStart,
        duration_ms: t - this.#currentStallStart,
        frozen_timecode_ms: this.#currentStallCode ?? code,
      });
      this.#inStall = false;
      this.#currentStallCode = null;
    }

    this.#lastCode = code;
    this.#lastChange = t;

    const now = serverNowMs(t);
    if (now === null) return;

    const span = 2 ** DEFAULT_TIMECODE.bits;
    let latency = (((now - code) % span) + span) % span;
    if (latency > span / 2) latency -= span;

    const renditionH = this.#getRenditionHeight();
    const playbackRate = this.#getPlaybackRate();

    this.#frames.push({
      wall_time_ms: t,
      timecode_ms: code,
      rendition_height: renditionH,
      latency_ms: Math.max(0, latency),
      playback_rate: playbackRate,
    });
  }

  async #evaluate(): Promise<QoEEvaluationResponse> {
    const payload: QoEEvaluationRequest = {
      protocol: this.#protocol,
      duration_s: this.#durationS,
      frames: this.#frames,
      stalls: this.#stalls,
      target_latency_ms: this.#targetLatencyMs,
    };

    const res = await fetch('/api/qoe/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Error en evaluación QoE (${res.status}): ${await res.text()}`);
    }

    return (await res.json()) as QoEEvaluationResponse;
  }
}
