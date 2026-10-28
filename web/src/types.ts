import type { FrameTime } from './lib/glass';

// Una calidad de la escalera que codifica la fuente (16:9)
export interface Rendition {
  height: number;
  bitrate_kbps: number;
}

// Fuente de la emisión: Big Buck Bunny en bucle o la cámara RTSP del .env del servidor
export type SourceKind = 'file' | 'camera';

export interface StreamConfig {
  source: SourceKind;
  gop_size: number;
  fps: number; // con el bucle, 60; con la cámara la fija el servidor (la de la cámara)
  rtc_audio: boolean; // audio Opus en la rama WebRTC (recodificado en el servidor); desactivado por defecto
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
    rtc_down: Counter;
    rtc_up: Counter;
  };
}

export interface ServerStatus {
  status: 'running' | 'stopped';
  config: StreamConfig;
  processes: {
    pipeline: boolean;
  };
  dash_url: string;
  dash_path?: 'direct' | 'proxy'; // direct: el navegador va al servidor de DASH por el router; proxy: a través del punto de entrada
  moq_port?: number;
  moq_host?: string | null; // dirección directa para MoQ; null = el host de la página
  spki_fingerprint: string;
  master_start_time_ms?: number;
  timecodes?: TimecodeLayout[]; // uno por calidad de la escalera
  ingest_anomalies?: { master: number; dash: number; moq: number; rtc: number };
  // Desfase del último segmento DASH respecto al calendario de disponibilidad anunciado en el manifiesto
  dash_availability_drift_ms?: number | null;
  network?: NetworkState | null;
  // Cambian cuando arranca el empaquetador de cada rama: señal para reconectar ese reproductor
  stream_ids?: { dash: number; moq: number; rtc: number };
  // Reinicios automáticos del supervisor del servidor
  restarts?: { master: number; dash: number; moq: number; rtc: number };
  // Vídeo fuente: se descarga al primer arranque si no está
  source?: { state: 'ready' | 'downloading' | 'extracting' | 'error'; progress_pct: number; error: string | null };
  camera?: CameraState;
  campaign?: CampaignBrief | null; // campaña en marcha (README, 4.8)
  campaign_preview?: { campaign: string; run: string; started_ms: number } | null; // vista previa de una prueba (README, 4.8)
}

// Cámara RTSP (GET /api/camera y /api/status): nunca incluye la URL, que puede llevar credenciales
export interface CameraState {
  configured: boolean;
  host: string | null;
  probe: { codec: string | null; width: number | null; height: number | null; fps: number; audio: boolean } | null;
  error: string | null;
}

// Versiones desplegadas en el servidor y última publicada de cada componente (GET /api/versions)
export interface VersionReport {
  installed: Record<string, string | null>;
  latest: Record<string, string | null>;
  checked_at_ms: number | null;
  errors: string[];
}

// Los valores numéricos son null cuando no hay medida: nunca se rellenan con valores supuestos
export interface PlayerMetrics {
  protocol: 'LL-DASH' | 'Media over QUIC' | 'WebRTC';
  latencyMs: number | null; // glass-to-glass por timecode, mediana del último segundo
  reportedLatencyMs: number | null; // la que declara el propio reproductor, como contraste
  bitrateKbps: number | null; // vídeo recibido, ventana deslizante
  networkKbps: number | null; // descarga total a nivel de aplicación; cada protocolo la cuenta en una capa distinta
  // De dónde sale networkKbps en MoQ: contadores del transporte, o carga útil si el navegador no los ofrece
  networkSource?: 'transport' | 'payload';
  fps: number | null; // frames distintos presentados en el último segundo
  // Tiempo en pantalla de cada frame (del pintado de uno al del siguiente), último segundo; va en refrescos
  frameTimeSdMs: number | null;
  frameTimeP95Ms: number | null;
  frameTimeMaxMs: number | null;
  frameTimes: FrameTime[]; // los de los últimos 2 s, para la gráfica
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
  playbackBufferMinSec?: number; // solo DASH: búfer por debajo del cual la corrección LoL+ frena (liveCatchup.playbackBufferMin)
  switching?: MoqSwitching | null;
  moqAbr?: MoqAbr; // solo MoQ: quién decide la calidad (la librería o el experimento de sondeo)
  probing?: boolean | null; // solo MoQ con sondeo: hay un sondeo en curso
  probeCapacityKbps?: number | null; // solo MoQ con sondeo: capacidad estimada en el último sondeo // solo MoQ: cambio de calidad hacia abajo (parche de web/patches); null sin el parche
  abr?: DashAbr; // solo DASH: reglas de adaptación de dash.js
  packetsLost?: number | null; // solo WebRTC: paquetes RTP perdidos según el navegador
  stages?: StageBreakdown | null;
  status: 'idle' | 'connecting' | 'playing' | 'error';
  errorMessage?: string;
}

// Cambio de calidad hacia abajo en MoQ (opción `switching` del parche de web/patches)
export type MoqSwitching = 'seamless' | 'cancel' | 'priority';

// Quién decide la calidad en MoQ: @moq/watch, o el controlador del experimento de sondeo (README 6.3)
export type MoqAbr = 'watch' | 'probe';

// Reglas de adaptación de dash.js: las de fábrica, o L2A o LoL+ en solitario
export type DashAbr = 'default' | 'l2a' | 'lolp';

// Latencia glass-to-glass repartida por etapas, medida sobre frames concretos del último segundo
export interface StageBreakdown {
  stages: { key: string; ms: number }[]; // mediana de cada etapa, en el orden del recorrido
  totalMs: number;
  samples: number; // frames seguidos de principio a fin en el periodo
}

export type PlayerId = 'dash' | 'moq' | 'rtc';

// Ajustes con los que arranca un reproductor en una prueba de campaña (README, 4.8). Sin ellos, los de la página.
export interface PlayerPreset {
  targetMs: number | null; // latencia objetivo en el mando del reproductor; null = la de fábrica de su implementación
  quality: number | 'auto';
  options?: Partial<PlayerOptions>; // lo que falte, como el dashboard al abrirse
}

// Ajustes de los reproductores de una campaña, iguales en todas sus pruebas (README, 4.8)
export interface PlayerOptions {
  dash_abr: DashAbr;
  dash_max_drift_s: number; // salto al directo (liveCatchup.maxDrift); 0 = nunca
  dash_playback_buffer_min_s: number; // búfer mínimo de LoL+ (liveCatchup.playbackBufferMin)
  moq_abr: MoqAbr;
  moq_switching: MoqSwitching;
}

// Una fila por segundo del registro exportable de la sesión
export interface SampleRow {
  time_iso: string;
  epoch: number; // se incrementa en cada reconfiguración del pipeline o de la red, o al activar o apagar un reproductor
  players: string; // reproductores activos en esa muestra, p. ej. dash|moq
  fullscreen: string | null; // reproductor a pantalla completa en ese momento (dash, moq o rtc), o vacío
  audio: string | null; // reproductor con el sonido activado (dash, moq o rtc), o vacío si todos van silenciados
  rtc_audio: boolean | null; // la rama WebRTC lleva audio (opción del servidor)
  elapsed_s: number; // segundos desde el inicio del epoch
  source: SourceKind | null; // fuente de la emisión: file (bucle) o camera
  fps: number | null; // cadencia de la emisión
  gop_size: number | null;
  ladder: string | null; // escalera codificada, p. ej. 1080p@4000|720p@2000
  dash_path: string | null; // direct o proxy: si la conexión del navegador atraviesa la red emulada
  seg_duration: number | null;
  frag_duration: number | null;
  dash_g2g_ms: number | null;
  dash_reported_ms: number | null;
  dash_kbps: number | null;
  dash_net_kbps: number | null;
  dash_fps: number | null;
  dash_frametime_sd_ms: number | null; // tiempo en pantalla de cada frame, último segundo
  dash_frametime_p95_ms: number | null;
  dash_frametime_max_ms: number | null;
  dash_buffer_s: number | null;
  dash_stalls: number;
  dash_stall_ms: number;
  dash_stall_spans: string | null; // parones exactos desde la fila anterior: "inicio-fin;..." en ms del reloj del servidor
  dash_stall_open_since_ms: number | null; // inicio del parón en curso, si lo hay
  dash_player_restarts: number;
  dash_target_ms: number | null;
  dash_height: number | null;
  dash_rendition_kbps: number | null;
  dash_quality_switches: number;
  dash_bw_estimate_kbps: number | null;
  dash_quality_mode: string;
  dash_max_drift_s: number | null;
  dash_playback_buffer_min_s: number | null;
  dash_abr: string | null; // default, l2a o lolp
  moq_g2g_ms: number | null;
  moq_reported_ms: number | null;
  moq_kbps: number | null;
  moq_net_kbps: number | null;
  moq_fps: number | null;
  moq_frametime_sd_ms: number | null; // tiempo en pantalla de cada frame, último segundo
  moq_frametime_p95_ms: number | null;
  moq_frametime_max_ms: number | null;
  moq_jitter_buffer_s: number | null; // tiempo medio retenido en el reproductor, como rtc_jitter_buffer_s
  moq_stalls: number;
  moq_stall_ms: number;
  moq_stall_spans: string | null; // parones exactos desde la fila anterior: "inicio-fin;..." en ms del reloj del servidor
  moq_stall_open_since_ms: number | null; // inicio del parón en curso, si lo hay
  moq_player_restarts: number;
  moq_target_ms: number | null;
  moq_height: number | null;
  moq_selected_height: number | null;
  moq_rendition_kbps: number | null;
  moq_quality_switches: number;
  moq_bw_estimate_kbps: number | null;
  moq_quality_mode: string;
  moq_switching: string | null;
  moq_abr: string; // watch (la librería) o probe (experimento de sondeo, README 6.3)
  moq_probing: number | null; // 1 si había un sondeo en curso en la muestra
  moq_probe_capacity_kbps: number | null; // capacidad estimada en el último sondeo // seamless (original), cancel o priority; vacío sin el parche
  // Desglose de la latencia por etapas (ms); la suma de las de cada rama es su glass-to-glass
  dash_stage_encode_ms: number | null;
  dash_stage_package_ms: number | null;
  dash_stage_deliver_ms: number | null;
  dash_stage_player_ms: number | null;
  moq_stage_encode_ms: number | null;
  moq_stage_ingest_ms: number | null;
  moq_stage_transport_ms: number | null;
  moq_stage_player_ms: number | null;
  // WebRTC: siempre la calidad más alta, sin adaptación
  rtc_g2g_ms: number | null;
  rtc_kbps: number | null;
  rtc_net_kbps: number | null;
  rtc_fps: number | null;
  rtc_frametime_sd_ms: number | null; // tiempo en pantalla de cada frame, último segundo
  rtc_frametime_p95_ms: number | null;
  rtc_frametime_max_ms: number | null;
  rtc_jitter_buffer_s: number | null;
  rtc_stalls: number;
  rtc_stall_ms: number;
  rtc_stall_spans: string | null; // parones exactos desde la fila anterior: "inicio-fin;..." en ms del reloj del servidor
  rtc_stall_open_since_ms: number | null; // inicio del parón en curso, si lo hay
  rtc_player_restarts: number;
  rtc_target_ms: number | null;
  rtc_height: number | null;
  rtc_packets_lost: number | null;
  rtc_stage_encode_ms: number | null;
  rtc_stage_ingest_ms: number | null;
  rtc_stage_transport_ms: number | null;
  rtc_stage_player_ms: number | null;
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
  rtc_ip_down_kbps: number | null;
  rtc_ip_up_kbps: number | null;
  dash_down_dropped: number | null;
  moq_down_dropped: number | null;
  dash_up_dropped: number | null;
  moq_up_dropped: number | null;
  rtc_down_dropped: number | null;
  rtc_up_dropped: number | null;
  tab_hidden: boolean;
  versions: string | null; // componentes de terceros desplegados, p. ej. moq-relay=0.17.2;moq-cli=0.14.2
}

// --- Campañas de medida (README, 4.8; server/app/campaign.py) ---

export interface CampaignNetwork {
  label: string;
  profile: NetworkProfile;
}

// Latencia objetivo en el mando de cada reproductor; null = la de fábrica de su implementación
export interface CampaignTarget {
  label: string;
  dash_ms: number | null;
  moq_ms: number | null;
  rtc_ms: number | null;
}

export interface CampaignPlan {
  name: string;
  streams: Omit<StreamConfig, 'fps'>[];
  networks: CampaignNetwork[];
  targets: CampaignTarget[];
  players: PlayerId[];
  player_mode: 'together' | 'each';
  quality: number | null; // null = la adaptación de cada reproductor
  player_options: PlayerOptions;
  repetitions: number;
  warmup_s: number;
  measure_s: number;
  control_every: number;
  max_attempts: number;
  // continuous: la fuente sigue entre pruebas; restart: se reinicia antes de cada una (mismo tramo del vídeo)
  content?: 'continuous' | 'restart';
  stream_settle_s: number;
  seed: number | null;
}

export type CampaignState = 'ready' | 'running' | 'paused' | 'done' | 'aborted';
export type RunState = 'pending' | 'preparing' | 'mounting' | 'warmup' | 'measuring' | 'closing' | 'done' | 'invalid' | 'replaced';

export interface CampaignRun {
  id: string;
  stream: number;
  network: number | null; // null = prueba de control, sin restricción
  target: number;
  players: PlayerId[];
  rep: number;
  kind: 'test' | 'control';
  attempt: number;
  retry_of?: string; // la prueba que repite (reintento automático o repetición pedida)
  manual?: boolean; // repetición pedida a mano
  replaced_by?: string; // válida, pero sustituida por su repetición válida
  state: RunState;
  invalid_reasons: string[];
  started_ms: number | null;
  measure_start_ms: number | null;
  ended_ms: number | null;
  summary: {
    rows: number;
    server: { restarts: number | null; ingest_anomalies: number | null };
    players: Partial<Record<PlayerId, Record<string, number | null>>>;
  } | null;
}

export interface CampaignWorkerState {
  connected: boolean;
  id: string | null;
  seen_ms: number;
  mounted: string | null;
  info: Record<string, unknown>;
}

export interface Campaign {
  id: string;
  name: string;
  state: CampaignState;
  created_ms: number;
  plan: CampaignPlan;
  runs?: CampaignRun[];
  events?: { t_ms: number; message: string }[];
  current: string | null;
  counts: Partial<Record<RunState, number>>;
  total_runs: number;
  eta_s: number;
  worker?: CampaignWorkerState;
  versions?: Record<string, string | null>;
}

export interface CampaignBrief {
  id: string;
  name: string;
  state: CampaignState;
  current: string | null;
  worker: CampaignWorkerState;
}

// Lo que debe tener montado el trabajador (POST /api/campaigns-worker)
export interface CampaignAssignment {
  campaign: string;
  phase: 'idle' | RunState;
  run?: string;
  players?: PlayerId[];
  targets?: Record<PlayerId, number | null>;
  target_label?: string;
  network_label?: string;
  quality?: number | null;
  options?: Partial<PlayerOptions>;
  kind?: 'test' | 'control';
  rep?: number;
  ends_ms?: number | null;
}
