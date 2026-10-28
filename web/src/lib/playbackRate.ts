import type { PlayerId } from '../types';

// Velocidad de reproducción del <video> (README, tabla de métricas). Solo cambia en DASH: dash.js acelera o
// frena para acercarse a la latencia objetivo (liveCatchup) o, con LoL+, para rellenar el búfer. Se sigue con el
// evento ratechange, sin muestrear: cada fila recibe la media ponderada por tiempo desde la anterior, el mínimo y
// el máximo, y cuánto tiempo fue más lenta o más rápida que 1×. Es la velocidad pedida al <video>, no la de los
// frames que llegan a pintarse (parado, no avanza aunque valga 1).

export interface RateWindow {
  mean: number | null;
  min: number | null;
  max: number | null;
  slowMs: number; // tiempo por debajo de 1×
  fastMs: number; // tiempo por encima de 1×
}

export class PlaybackRateTracker {
  #video: HTMLVideoElement;
  #rate: number;
  #since: number; // performance.now() del último cambio o de la última recogida
  #weighted = 0; // velocidad × ms acumulados en la ventana
  #elapsed = 0;
  #min: number;
  #max: number;
  #slowMs = 0;
  #fastMs = 0;
  #onChange = () => this.#change(this.#video.playbackRate);

  constructor(video: HTMLVideoElement) {
    this.#video = video;
    this.#rate = video.playbackRate;
    this.#since = performance.now();
    this.#min = this.#max = this.#rate;
    video.addEventListener('ratechange', this.#onChange);
  }

  get current(): number {
    return this.#rate;
  }

  #accumulate(now: number) {
    const ms = now - this.#since;
    this.#weighted += this.#rate * ms;
    this.#elapsed += ms;
    if (this.#rate < 1) this.#slowMs += ms;
    else if (this.#rate > 1) this.#fastMs += ms;
    this.#since = now;
  }

  #change(rate: number) {
    this.#accumulate(performance.now());
    this.#rate = rate;
    this.#min = Math.min(this.#min, rate);
    this.#max = Math.max(this.#max, rate);
  }

  /** Lo de la ventana desde la recogida anterior; recogerla abre la siguiente con la velocidad actual. */
  take(): RateWindow {
    this.#accumulate(performance.now());
    const out: RateWindow = {
      mean: this.#elapsed > 0 ? Number((this.#weighted / this.#elapsed).toFixed(3)) : null,
      min: this.#elapsed > 0 ? Number(this.#min.toFixed(3)) : null,
      max: this.#elapsed > 0 ? Number(this.#max.toFixed(3)) : null,
      slowMs: Math.round(this.#slowMs),
      fastMs: Math.round(this.#fastMs),
    };
    this.#weighted = this.#elapsed = this.#slowMs = this.#fastMs = 0;
    this.#min = this.#max = this.#rate;
    return out;
  }

  close() {
    this.#video.removeEventListener('ratechange', this.#onChange);
  }
}

// Los de los reproductores montados, para que cada fila recoja su ventana (como los parones del medidor)
export const rateTrackers: Partial<Record<PlayerId, PlaybackRateTracker>> = {};
