// Una calidad de la escalera que codifica la fuente (16:9)
export interface Rendition {
  height: number;
  bitrate_kbps: number;
}

export interface StreamConfig {
  gop_size: number;
  fps: number;
  renditions: Rendition[]; // de mayor a menor; una sola = sin adaptación
  seg_duration: number;
  frag_duration: number;
}

// Posición del timecode binario quemado en una calidad, en píxeles de esa calidad (width x height)
export interface TimecodeLayout {
  bits: number;
  cell: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Condiciones de un sentido del enlace emulado por el router
export interface LinkProfile {
  rate_kbit: number | null; // null = sin límite
  delay_ms: number;
  jitter_ms: number;
  loss_pct: number;
  queue_ms: number;
}

export interface NetworkProfile {
  down: LinkProfile; // servidor -> navegador
  up: LinkProfile; // navegador -> servidor
}

// Por protocolo y sentido: tráfico IP reenviado y lo que ha descartado o retiene su cola de emulación
type Counter = { packets: number; bytes: number; dropped: number; queued: number };

export interface NetworkState {
  profile: NetworkProfile;
  emulation_error?: string | null; // motivo por el que el servidor no puede emular la red, si es el caso
  stats: {
    dash_down: Counter;
    dash_up: Counter;
    moq_down: Counter;
    moq_up: Counter;
  };
}

export interface ServerStatus {
  status: 'running' | 'stopped';
  config: StreamConfig;
  processes: {
    pipeline: boolean;
  };
  dash_url: string;
  moq_port?: number;
  moq_host?: string | null; // dirección directa para MoQ; null = el host de la página
  spki_fingerprint: string;
  master_start_time_ms?: number;
  timecodes?: TimecodeLayout[]; // uno por calidad de la escalera
  ingest_anomalies?: { master: number; dash: number; moq: number };
  // Desfase del último segmento DASH respecto al calendario de disponibilidad anunciado en el manifiesto
  dash_availability_drift_ms?: number | null;
  network?: NetworkState | null;
  // Cambian cuando arranca el empaquetador de cada rama: señal para reconectar ese reproductor
  stream_ids?: { dash: number; moq: number };
  // Reinicios automáticos del supervisor del servidor
  restarts?: { master: number; dash: number; moq: number };
  // Vídeo fuente: se descarga al primer arranque si no está
  source?: { state: 'ready' | 'downloading' | 'extracting' | 'error'; progress_pct: number; error: string | null };
}

// Los valores numéricos son null cuando no hay medida: nunca se rellenan con valores supuestos
export interface PlayerMetrics {
  protocol: 'LL-DASH' | 'Media over QUIC';
  latencyMs: number | null; // glass-to-glass por timecode, mediana del último segundo
  reportedLatencyMs: number | null; // la que declara el propio reproductor, como contraste
  bitrateKbps: number | null; // vídeo recibido, ventana deslizante
  networkKbps: number | null; // descarga total a nivel de aplicación; cada protocolo la cuenta en una capa distinta
  // De dónde sale networkKbps en MoQ: contadores del transporte, o carga útil si el navegador no los ofrece
  networkSource?: 'transport' | 'payload';
  fps: number | null; // frames distintos presentados en el último segundo
  bufferLengthSec: number | null;
  stalls: number;
  stallMs: number;
  restarts: number; // veces que la vigilancia ha tenido que recrear el reproductor
  targetLatencyMs: number | null; // latencia objetivo fijada en el slider del reproductor
  // Adaptación de calidad
  renditionHeight: number | null; // calidad que se está reproduciendo
  renditionKbps: number | null; // su bitrate según el manifiesto (DASH) o el catálogo (MoQ)
  selectedHeight?: number | null; // solo MoQ: rendition seleccionada, que puede no ser aún la que se pinta
  qualitySwitches: number; // cambios de calidad desde que arrancó el reproductor
  bandwidthEstimateKbps: number | null; // estimación en la que se basa la adaptación
  qualityMode: 'auto' | 'manual';
  maxDriftSec?: number; // solo DASH: desvío a partir del cual dash.js salta al directo (0 = nunca)
  status: 'idle' | 'connecting' | 'playing' | 'error';
  errorMessage?: string;
}

// Una fila por segundo del registro exportable de la sesión
export interface SampleRow {
  time_iso: string;
  epoch: number; // se incrementa en cada reconfiguración del pipeline o de la red
  elapsed_s: number; // segundos desde el inicio del epoch
  gop_size: number | null;
  ladder: string | null; // escalera codificada, p. ej. 1080p@4000|720p@2000
  seg_duration: number | null;
  frag_duration: number | null;
  dash_g2g_ms: number | null;
  dash_reported_ms: number | null;
  dash_kbps: number | null;
  dash_net_kbps: number | null;
  dash_fps: number | null;
  dash_buffer_s: number | null;
  dash_stalls: number;
  dash_stall_ms: number;
  dash_player_restarts: number;
  dash_target_ms: number | null;
  dash_height: number | null;
  dash_rendition_kbps: number | null;
  dash_quality_switches: number;
  dash_bw_estimate_kbps: number | null;
  dash_quality_mode: string;
  dash_max_drift_s: number | null;
  moq_g2g_ms: number | null;
  moq_reported_ms: number | null;
  moq_kbps: number | null;
  moq_net_kbps: number | null;
  moq_fps: number | null;
  moq_jitter_s: number | null;
  moq_stalls: number;
  moq_stall_ms: number;
  moq_player_restarts: number;
  moq_target_ms: number | null;
  moq_height: number | null;
  moq_selected_height: number | null;
  moq_rendition_kbps: number | null;
  moq_quality_switches: number;
  moq_bw_estimate_kbps: number | null;
  moq_quality_mode: string;
  clock_offset_ms: number | null;
  clock_rtt_ms: number | null;
  ingest_anomalies: number | null;
  dash_availability_drift_ms: number | null;
  pipeline_restarts: number | null; // reinicios automáticos del supervisor (fuente + DASH + MoQ)
  // Perfil de red activo en el router
  net_down_rate_kbit: number | null;
  net_down_delay_ms: number | null;
  net_down_jitter_ms: number | null;
  net_down_loss_pct: number | null;
  net_down_queue_ms: number | null;
  net_up_rate_kbit: number | null;
  net_up_delay_ms: number | null;
  net_up_jitter_ms: number | null;
  net_up_loss_pct: number | null;
  net_up_queue_ms: number | null;
  // Tráfico IP por protocolo visto por el router y descartes acumulados de la emulación
  dash_ip_down_kbps: number | null;
  dash_ip_up_kbps: number | null;
  moq_ip_down_kbps: number | null;
  moq_ip_up_kbps: number | null;
  dash_down_dropped: number | null;
  moq_down_dropped: number | null;
  dash_up_dropped: number | null;
  moq_up_dropped: number | null;
  tab_hidden: boolean;
}
