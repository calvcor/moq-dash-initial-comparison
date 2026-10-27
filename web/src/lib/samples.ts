// Fila de cada segundo del registro de la sesión (la del CSV del dashboard). La usan el dashboard y el
// trabajador de las campañas, que sube las mismas filas al servidor.
import { RateWindow } from './glass';
import { getClockSync } from './clock';
import { versionsLabel } from '../components/VersionsPanel';
import type { PlayerId, PlayerMetrics, SampleRow, ServerStatus, VersionReport } from '../types';

export type { PlayerId } from '../types';
export const PLAYER_IDS: PlayerId[] = ['dash', 'moq', 'rtc'];

// Métricas de un reproductor sin medida: así queda también uno desactivado, para que el CSV lo deje vacío
export const INITIAL_METRICS: Record<PlayerId, PlayerMetrics> = {
  dash: {
      protocol: 'LL-DASH',
      latencyMs: null,
      reportedLatencyMs: null,
      bitrateKbps: null,
      networkKbps: null,
      fps: null,
      frameTimeSdMs: null,
      frameTimeP95Ms: null,
      frameTimeMaxMs: null,
      frameTimes: [],
      bufferLengthSec: null,
      stalls: 0,
      stallMs: 0,
      restarts: 0,
      targetLatencyMs: null,
      renditionHeight: null,
      renditionKbps: null,
      qualitySwitches: 0,
      bandwidthEstimateKbps: null,
      qualityMode: 'auto',
      status: 'idle',
  },
  moq: {
      protocol: 'Media over QUIC',
      latencyMs: null,
      reportedLatencyMs: null,
      bitrateKbps: null,
      networkKbps: null,
      fps: null,
      frameTimeSdMs: null,
      frameTimeP95Ms: null,
      frameTimeMaxMs: null,
      frameTimes: [],
      bufferLengthSec: null,
      stalls: 0,
      stallMs: 0,
      restarts: 0,
      targetLatencyMs: null,
      renditionHeight: null,
      renditionKbps: null,
      qualitySwitches: 0,
      bandwidthEstimateKbps: null,
      qualityMode: 'auto',
      status: 'idle',
  },
  rtc: {
      protocol: 'WebRTC',
      latencyMs: null,
      reportedLatencyMs: null,
      bitrateKbps: null,
      networkKbps: null,
      fps: null,
      frameTimeSdMs: null,
      frameTimeP95Ms: null,
      frameTimeMaxMs: null,
      frameTimes: [],
      bufferLengthSec: null,
      stalls: 0,
      stallMs: 0,
      restarts: 0,
      targetLatencyMs: null,
      renditionHeight: null,
      renditionKbps: null,
      qualitySwitches: 0,
      bandwidthEstimateKbps: null,
      qualityMode: 'manual',
      status: 'idle',
  },
};

const stage = (metrics: PlayerMetrics, key: string) => metrics.stages?.stages.find((s) => s.key === key)?.ms ?? null;

type IpKey = 'dash_down' | 'dash_up' | 'moq_down' | 'moq_up' | 'rtc_down' | 'rtc_up';
const IP_KEYS: IpKey[] = ['dash_down', 'dash_up', 'moq_down', 'moq_up', 'rtc_down', 'rtc_up'];

/** Tráfico IP por protocolo y sentido, a partir de los contadores acumulados del router. */
export class IpRates {
  #windows = Object.fromEntries(IP_KEYS.map((k) => [k, new RateWindow()])) as Record<IpKey, RateWindow>;

  push(status: ServerStatus) {
    if (!status.network) return;
    for (const key of IP_KEYS) if (status.network.stats[key]) this.#windows[key].push(status.network.stats[key].bytes);
  }

  rates(): Record<IpKey, number | null> {
    return Object.fromEntries(IP_KEYS.map((k) => [k, this.#windows[k].kbps()])) as Record<IpKey, number | null>;
  }
}

export interface SampleContext {
  epoch: number;
  epochStartedAt: number; // performance.now() del inicio del tramo
  active: Record<PlayerId, boolean>;
  metrics: Record<PlayerId, PlayerMetrics>;
  status: ServerStatus | null;
  ip: Record<IpKey, number | null>;
  audioPlayer: PlayerId | null;
  versions: VersionReport | null;
}

export function buildSampleRow({ epoch, epochStartedAt, active, metrics, status, ip, audioPlayer, versions }: SampleContext): SampleRow {
  // Un reproductor desactivado aporta su fila vacía, nunca su último valor
  const currentDash = active.dash ? metrics.dash : INITIAL_METRICS.dash;
  const currentMoq = active.moq ? metrics.moq : INITIAL_METRICS.moq;
  const currentRtc = active.rtc ? metrics.rtc : INITIAL_METRICS.rtc;
  const clock = getClockSync();
  const net = status?.network?.profile;
  return {
  time_iso: new Date().toISOString(),
  epoch: epoch,
  players: PLAYER_IDS.filter((id) => active[id]).join('|'),
  fullscreen: (document.fullscreenElement as HTMLElement | null)?.dataset.player ?? null,
  audio: audioPlayer,
  rtc_audio: status?.config.rtc_audio ?? null,
  elapsed_s: Math.round((performance.now() - epochStartedAt) / 1000),
  source: status?.config.source ?? null,
  fps: status?.config.fps ?? null,
  gop_size: status?.config.gop_size ?? null,
  ladder: status?.config.renditions.map((r) => `${r.height}p@${r.bitrate_kbps}`).join('|') ?? null,
  dash_path: status?.dash_path ?? null,
  seg_duration: status?.config.seg_duration ?? null,
  frag_duration: status?.config.frag_duration ?? null,
  dash_g2g_ms: currentDash.latencyMs,
  dash_reported_ms: currentDash.reportedLatencyMs,
  dash_kbps: currentDash.bitrateKbps,
  dash_net_kbps: currentDash.networkKbps,
  dash_fps: currentDash.fps,
  dash_frametime_sd_ms: currentDash.frameTimeSdMs,
  dash_frametime_p95_ms: currentDash.frameTimeP95Ms,
  dash_frametime_max_ms: currentDash.frameTimeMaxMs,
  dash_buffer_s: currentDash.bufferLengthSec,
  dash_stalls: currentDash.stalls,
  dash_stall_ms: currentDash.stallMs,
  dash_player_restarts: currentDash.restarts,
  dash_target_ms: currentDash.targetLatencyMs,
  dash_height: currentDash.renditionHeight,
  dash_rendition_kbps: currentDash.renditionKbps,
  dash_quality_switches: currentDash.qualitySwitches,
  dash_bw_estimate_kbps: currentDash.bandwidthEstimateKbps,
  dash_quality_mode: currentDash.qualityMode,
  dash_max_drift_s: currentDash.maxDriftSec ?? null,
  dash_playback_buffer_min_s: currentDash.playbackBufferMinSec ?? null,
  dash_abr: currentDash.abr ?? null,
  moq_g2g_ms: currentMoq.latencyMs,
  moq_reported_ms: currentMoq.reportedLatencyMs,
  moq_kbps: currentMoq.bitrateKbps,
  moq_net_kbps: currentMoq.networkKbps,
  moq_fps: currentMoq.fps,
  moq_frametime_sd_ms: currentMoq.frameTimeSdMs,
  moq_frametime_p95_ms: currentMoq.frameTimeP95Ms,
  moq_frametime_max_ms: currentMoq.frameTimeMaxMs,
  moq_jitter_buffer_s: currentMoq.bufferLengthSec,
  moq_stalls: currentMoq.stalls,
  moq_stall_ms: currentMoq.stallMs,
  moq_player_restarts: currentMoq.restarts,
  moq_target_ms: currentMoq.targetLatencyMs,
  moq_height: currentMoq.renditionHeight,
  moq_selected_height: currentMoq.selectedHeight ?? null,
  moq_rendition_kbps: currentMoq.renditionKbps,
  moq_quality_switches: currentMoq.qualitySwitches,
  moq_bw_estimate_kbps: currentMoq.bandwidthEstimateKbps,
  moq_quality_mode: currentMoq.qualityMode,
  moq_switching: currentMoq.switching ?? null,
  moq_abr: currentMoq.moqAbr ?? 'watch',
  moq_probing: currentMoq.probing == null ? null : currentMoq.probing ? 1 : 0,
  moq_probe_capacity_kbps: currentMoq.probeCapacityKbps ?? null,
  dash_stage_encode_ms: stage(currentDash, 'encode'),
  dash_stage_package_ms: stage(currentDash, 'package'),
  dash_stage_deliver_ms: stage(currentDash, 'deliver'),
  dash_stage_player_ms: stage(currentDash, 'player'),
  moq_stage_encode_ms: stage(currentMoq, 'encode'),
  moq_stage_ingest_ms: stage(currentMoq, 'ingest'),
  moq_stage_transport_ms: stage(currentMoq, 'transport'),
  moq_stage_player_ms: stage(currentMoq, 'player'),
  rtc_g2g_ms: currentRtc.latencyMs,
  rtc_kbps: currentRtc.bitrateKbps,
  rtc_net_kbps: currentRtc.networkKbps,
  rtc_fps: currentRtc.fps,
  rtc_frametime_sd_ms: currentRtc.frameTimeSdMs,
  rtc_frametime_p95_ms: currentRtc.frameTimeP95Ms,
  rtc_frametime_max_ms: currentRtc.frameTimeMaxMs,
  rtc_jitter_buffer_s: currentRtc.bufferLengthSec,
  rtc_stalls: currentRtc.stalls,
  rtc_stall_ms: currentRtc.stallMs,
  rtc_player_restarts: currentRtc.restarts,
  rtc_target_ms: currentRtc.targetLatencyMs,
  rtc_height: currentRtc.renditionHeight,
  rtc_packets_lost: currentRtc.packetsLost ?? null,
  rtc_stage_encode_ms: stage(currentRtc, 'encode'),
  rtc_stage_ingest_ms: stage(currentRtc, 'ingest'),
  rtc_stage_transport_ms: stage(currentRtc, 'transport'),
  rtc_stage_player_ms: stage(currentRtc, 'player'),
  clock_offset_ms: clock ? Number(clock.offsetMs.toFixed(2)) : null,
  clock_rtt_ms: clock ? Number(clock.rttMs.toFixed(2)) : null,
  ingest_anomalies: status?.ingest_anomalies
    ? status.ingest_anomalies.master + status.ingest_anomalies.dash + status.ingest_anomalies.moq + (status.ingest_anomalies.rtc ?? 0)
    : null,
  dash_availability_drift_ms: status?.dash_availability_drift_ms ?? null,
  pipeline_restarts: status?.restarts ? status.restarts.master + status.restarts.dash + status.restarts.moq + (status.restarts.rtc ?? 0) : null,
  net_down_rate_kbit: net?.down.rate_kbit ?? null,
  net_down_delay_ms: net?.down.delay_ms ?? null,
  net_down_jitter_ms: net?.down.jitter_ms ?? null,
  net_down_loss_pct: net?.down.loss_pct ?? null,
  net_down_queue_ms: net?.down.queue_ms ?? null,
  net_up_rate_kbit: net?.up.rate_kbit ?? null,
  net_up_delay_ms: net?.up.delay_ms ?? null,
  net_up_jitter_ms: net?.up.jitter_ms ?? null,
  net_up_loss_pct: net?.up.loss_pct ?? null,
  net_up_queue_ms: net?.up.queue_ms ?? null,
  dash_ip_down_kbps: ip.dash_down,
  dash_ip_up_kbps: ip.dash_up,
  moq_ip_down_kbps: ip.moq_down,
  moq_ip_up_kbps: ip.moq_up,
  rtc_ip_down_kbps: ip.rtc_down,
  rtc_ip_up_kbps: ip.rtc_up,
  dash_down_dropped: status?.network?.stats.dash_down.dropped ?? null,
  moq_down_dropped: status?.network?.stats.moq_down.dropped ?? null,
  dash_up_dropped: status?.network?.stats.dash_up.dropped ?? null,
  moq_up_dropped: status?.network?.stats.moq_up.dropped ?? null,
  rtc_down_dropped: status?.network?.stats.rtc_down?.dropped ?? null,
  rtc_up_dropped: status?.network?.stats.rtc_up?.dropped ?? null,
  tab_hidden: document.hidden,
  versions: versionsLabel(versions),
};
}
