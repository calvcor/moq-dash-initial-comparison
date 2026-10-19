import React, { useState, useRef, useEffect } from 'react';
import type { ServerStatus, QoEEvaluationResponse } from '../types';
import { QoERunner } from '../lib/qoe';
import { grabFromVideo } from '../lib/glass';
import * as Watch from '@moq/watch';
import * as Net from '@moq/net';
import { Signal } from '@moq/signals';

interface QoETestViewProps {
  status: ServerStatus | null;
  onClose: () => void;
}

export const QoETestView: React.FC<QoETestViewProps> = ({ status, onClose }) => {
  const [protocol, setProtocol] = useState<'dash' | 'moq' | 'rtc'>('dash');
  const [durationS, setDurationS] = useState<number>(30);
  const [state, setState] = useState<'idle' | 'running' | 'evaluating' | 'completed' | 'error'>('idle');
  const [progress, setProgress] = useState<{ elapsedS: number; remainingS: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [result, setResult] = useState<QoEEvaluationResponse | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runnerRef = useRef<QoERunner | null>(null);

  // Instancias de reproductores
  const dashPlayerRef = useRef<any>(null);
  const moqPlayerRef = useRef<Watch.Player | null>(null);
  const moqConnRef = useRef<Net.Connection | null>(null);
  const rtcPcRef = useRef<RTCPeerConnection | null>(null);

  const cleanupPlayers = () => {
    if (dashPlayerRef.current) {
      try {
        dashPlayerRef.current.reset();
      } catch (_) {}
      dashPlayerRef.current = null;
    }
    if (moqPlayerRef.current) {
      try {
        moqPlayerRef.current.close();
      } catch (_) {}
      moqPlayerRef.current = null;
    }
    if (moqConnRef.current) {
      try {
        moqConnRef.current.close();
      } catch (_) {}
      moqConnRef.current = null;
    }
    if (rtcPcRef.current) {
      try {
        rtcPcRef.current.close();
      } catch (_) {}
      rtcPcRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      cleanupPlayers();
      if (runnerRef.current) runnerRef.current.stop();
    };
  }, []);

  const handleStart = async () => {
    setErrorMsg('');
    setResult(null);
    setState('running');
    cleanupPlayers();

    try {
      let grabber: () => VideoFrame | null = () => null;
      let getPlaybackRate: () => number = () => 1.0;
      let getRenditionHeight: () => number = () => 1080;

      if (protocol === 'dash') {
        const dashjs = (window as any).dashjs;
        if (!dashjs) throw new Error('dash.js no disponible');
        const video = videoRef.current;
        if (!video) throw new Error('Elemento video no montado');

        const player = dashjs.MediaPlayer().create();
        dashPlayerRef.current = player;
        player.initialize(video, status?.dash_url || '/media/dash/manifest.mpd', true);
        player.updateSettings({
          streaming: {
            lowLatencyEnabled: true,
            delay: { liveDelay: 1.0 },
            liveCatchup: { enabled: true, maxDrift: 0.5, playbackRate: { min: -0.15, max: 0.15 } },
          },
        });

        grabber = () => grabFromVideo(video);
        getPlaybackRate = () => video.playbackRate || 1.0;
        getRenditionHeight = () => {
          try {
            const q = player.getQualityFor('video');
            const list = player.getBitrateInfoListFor('video');
            return list && list[q] ? list[q].height : 1080;
          } catch (_) {
            return 1080;
          }
        };
      } else if (protocol === 'moq') {
        const canvas = canvasRef.current;
        if (!canvas) throw new Error('Elemento canvas no montado');

        let hexFingerprint = '';
        try {
          const res = await fetch('/certificate.sha256', { cache: 'no-store' });
          if (res.ok) hexFingerprint = (await res.text()).trim();
        } catch (_) {}

        const host = status?.moq_host || window.location.hostname;
        const port = status?.moq_port || 4433;
        const targetUrl = new URL(`https://${host}:${port}/moq`);

        const conn = new Net.Connection({
          url: targetUrl,
          enabled: true,
          webtransport: hexFingerprint
            ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: hexFingerprint }] }
            : undefined,
        });
        moqConnRef.current = conn;

        const player = new Watch.Player({
          origin: conn.origin,
          probe: conn.probe,
          name: Net.Path.from('live.hang'),
          announced: true,
          visible: 'always',
          canvas,
          muted: new Signal(true),
        });
        moqPlayerRef.current = player;

        grabber = () => {
          try {
            return player.renderer.out.frame.peek()?.clone() ?? null;
          } catch (_) {
            return null;
          }
        };
        getPlaybackRate = () => 1.0;
        getRenditionHeight = () => {
          try {
            const f = player.renderer.out.frame.peek();
            return f ? f.displayHeight : 1080;
          } catch (_) {
            return 1080;
          }
        };
      } else if (protocol === 'rtc') {
        const video = videoRef.current;
        if (!video) throw new Error('Elemento video no montado');

        const pc = new RTCPeerConnection();
        rtcPcRef.current = pc;
        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.ontrack = (ev) => {
          if (ev.track.kind === 'video' && video) {
            video.srcObject = ev.streams[0];
            video.play().catch(() => {});
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const whepRes = await fetch('/rtc/whep', {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: offer.sdp,
        });
        if (!whepRes.ok) throw new Error(`Fallo WHEP: ${whepRes.statusText}`);
        const answerSdp = await whepRes.text();
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

        grabber = () => grabFromVideo(video);
        getPlaybackRate = () => 1.0;
        getRenditionHeight = () => (video.videoHeight > 0 ? video.videoHeight : 1080);
      }

      // Dejar 1.5 s de cortesía para enganchar
      await new Promise((r) => setTimeout(r, 1500));

      const runner = new QoERunner({
        protocol,
        durationS,
        grab: grabber,
        getLayouts: () => status?.timecodes ?? [],
        getPlaybackRate,
        getRenditionHeight,
        onProgress: (elapsed, remaining) => {
          setProgress({ elapsedS: elapsed, remainingS: remaining });
        },
      });
      runnerRef.current = runner;

      const evalResult = await runner.start();
      setResult(evalResult);
      setState('completed');
    } catch (err: any) {
      setErrorMsg(err.message || String(err));
      setState('error');
    } finally {
      cleanupPlayers();
    }
  };

  const handleCancel = () => {
    if (runnerRef.current) runnerRef.current.stop();
    cleanupPlayers();
    setState('idle');
    setProgress(null);
  };

  const exportJSON = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qoe_eval_${result.protocol}_${result.duration_s}s.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1200px', margin: '0 auto', color: '#f3f4f6' }}>
      {/* Cabecera */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', margin: 0, color: '#60a5fa' }}>
            Evaluación Aislada de QoE (LL-GABR + VMAF)
          </h2>
          <p style={{ margin: '0.25rem 0 0 0', color: '#9ca3af', fontSize: '0.9rem' }}>
            Banco de pruebas doctoral: evaluación matemática objetiva en ventanas uniformes de 1 segundo
          </p>
        </div>
        <button
          onClick={onClose}
          style={{
            background: '#374151',
            color: '#e5e7eb',
            border: 'none',
            padding: '0.5rem 1rem',
            borderRadius: '0.375rem',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          Volver al Dashboard
        </button>
      </div>

      {/* Controles de Configuración */}
      {state === 'idle' && (
        <div style={{ background: '#1f2937', padding: '1.5rem', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            {/* Protocolo */}
            <div>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem', color: '#d1d5db' }}>
                Protocolo a evaluar:
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {(['dash', 'moq', 'rtc'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setProtocol(p)}
                    style={{
                      flex: 1,
                      padding: '0.6rem 0.5rem',
                      borderRadius: '0.375rem',
                      border: protocol === p ? '2px solid #3b82f6' : '1px solid #4b5563',
                      background: protocol === p ? '#1e3a8a' : '#374151',
                      color: protocol === p ? '#93c5fd' : '#d1d5db',
                      fontWeight: 600,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >
                    {p === 'dash' ? 'LL-DASH' : p === 'moq' ? 'MoQ (QUIC)' : 'WebRTC'}
                  </button>
                ))}
              </div>
            </div>

            {/* Duración */}
            <div>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem', color: '#d1d5db' }}>
                Duración de la prueba:
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {[15, 30, 60].map((dur) => (
                  <button
                    key={dur}
                    onClick={() => setDurationS(dur)}
                    style={{
                      flex: 1,
                      padding: '0.6rem 0.5rem',
                      borderRadius: '0.375rem',
                      border: durationS === dur ? '2px solid #10b981' : '1px solid #4b5563',
                      background: durationS === dur ? '#064e3b' : '#374151',
                      color: durationS === dur ? '#6ee7b7' : '#d1d5db',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {dur}s
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ marginTop: '1.5rem', textAlign: 'right' }}>
            <button
              onClick={handleStart}
              style={{
                background: '#2563eb',
                color: '#ffffff',
                border: 'none',
                padding: '0.75rem 2rem',
                borderRadius: '0.375rem',
                fontWeight: 'bold',
                fontSize: '1rem',
                cursor: 'pointer',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)',
              }}
            >
              Iniciar Evaluación
            </button>
          </div>
        </div>
      )}

      {/* Monitor durante la prueba */}
      {state === 'running' && (
        <div style={{ background: '#111827', padding: '1.5rem', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  background: '#ef4444',
                  animation: 'pulse 1.5s infinite',
                }}
              />
              <span style={{ fontWeight: 600, fontSize: '1.1rem', textTransform: 'uppercase' }}>
                Evaluando {protocol === 'dash' ? 'LL-DASH' : protocol === 'moq' ? 'MoQ' : 'WebRTC'}
              </span>
            </div>
            <div style={{ fontSize: '1rem', color: '#93c5fd' }}>
              Tiempo restante: <strong>{progress?.remainingS ?? durationS}s</strong> / {durationS}s
            </div>
          </div>

          {/* Barra de progreso */}
          <div style={{ height: '8px', background: '#374151', borderRadius: '4px', overflow: 'hidden', marginBottom: '1rem' }}>
            <div
              style={{
                height: '100%',
                background: '#3b82f6',
                width: `${Math.min(100, (((progress?.elapsedS ?? 0) / durationS) * 100))}%`,
                transition: 'width 0.2s ease',
              }}
            />
          </div>

          {/* Área de vídeo/canvas */}
          <div
            style={{
              position: 'relative',
              width: '100%',
              maxHeight: '480px',
              aspectRatio: '16/9',
              background: '#000',
              borderRadius: '0.375rem',
              overflow: 'hidden',
              margin: '0 auto',
            }}
          >
            {protocol === 'moq' ? (
              <canvas ref={canvasRef} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            ) : (
              <video ref={videoRef} playsInline autoPlay muted style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            )}
          </div>

          <div style={{ marginTop: '1rem', textAlign: 'center' }}>
            <button
              onClick={handleCancel}
              style={{
                background: '#dc2626',
                color: '#fff',
                border: 'none',
                padding: '0.5rem 1.5rem',
                borderRadius: '0.375rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Cancelar Prueba
            </button>
          </div>
        </div>
      )}

      {/* Estado de error */}
      {state === 'error' && (
        <div style={{ background: '#7f1d1d', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1.5rem', color: '#fecaca' }}>
          <strong>Error durante la prueba:</strong> {errorMsg}
          <div style={{ marginTop: '0.5rem' }}>
            <button
              onClick={() => setState('idle')}
              style={{ background: '#991b1b', color: '#fff', border: 'none', padding: '0.4rem 1rem', borderRadius: '0.25rem', cursor: 'pointer' }}
            >
              Reintentar
            </button>
          </div>
        </div>
      )}

      {/* Resultados de la Evaluación */}
      {state === 'completed' && result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Tarjetas resumen */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
            {/* QoE Score */}
            <div style={{ background: '#1e3a8a', padding: '1.25rem', borderRadius: '0.5rem', border: '1px solid #3b82f6' }}>
              <div style={{ color: '#93c5fd', fontSize: '0.85rem', fontWeight: 600, textTransform: 'uppercase' }}>
                QoE Global (LL-GABR)
              </div>
              <div style={{ fontSize: '2.5rem', fontWeight: 800, color: '#ffffff', marginTop: '0.25rem' }}>
                {result.qoe_score.toFixed(2)}
                <span style={{ fontSize: '1rem', color: '#bfdbfe', fontWeight: 500 }}> / 5.0</span>
              </div>
            </div>

            {/* VMAF Medio */}
            <div style={{ background: '#1f2937', padding: '1.25rem', borderRadius: '0.5rem', border: '1px solid #374151' }}>
              <div style={{ color: '#9ca3af', fontSize: '0.85rem', fontWeight: 600, textTransform: 'uppercase' }}>
                VMAF Medio
              </div>
              <div style={{ fontSize: '2rem', fontWeight: 700, color: '#34d399', marginTop: '0.25rem' }}>
                {result.vmaf_mean.toFixed(1)}
                <span style={{ fontSize: '0.9rem', color: '#9ca3af' }}> / 100</span>
              </div>
            </div>

            {/* Latencia Media */}
            <div style={{ background: '#1f2937', padding: '1.25rem', borderRadius: '0.5rem', border: '1px solid #374151' }}>
              <div style={{ color: '#9ca3af', fontSize: '0.85rem', fontWeight: 600, textTransform: 'uppercase' }}>
                Latencia Media
              </div>
              <div style={{ fontSize: '2rem', fontWeight: 700, color: '#fbbf24', marginTop: '0.25rem' }}>
                {result.avg_latency_s.toFixed(2)} s
              </div>
            </div>

            {/* Parones / Stalls */}
            <div style={{ background: '#1f2937', padding: '1.25rem', borderRadius: '0.5rem', border: '1px solid #374151' }}>
              <div style={{ color: '#9ca3af', fontSize: '0.85rem', fontWeight: 600, textTransform: 'uppercase' }}>
                Parones (Stalls)
              </div>
              <div style={{ fontSize: '2rem', fontWeight: 700, color: result.stalls_count > 0 ? '#f87171' : '#60a5fa', marginTop: '0.25rem' }}>
                {result.total_freeze_s.toFixed(2)} s
                <span style={{ fontSize: '0.9rem', color: '#9ca3af', fontWeight: 400 }}> ({result.stalls_count} cortes)</span>
              </div>
            </div>
          </div>

          {/* Desglose de penalizaciones LL-GABR */}
          <div style={{ background: '#1f2937', padding: '1.25rem', borderRadius: '0.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 1rem 0', color: '#e5e7eb' }}>
              Desglose de Factores LL-GABR
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', fontSize: '0.9rem' }}>
              <div>
                <span style={{ color: '#9ca3af' }}>Calidad Base (+):</span>
                <div style={{ fontWeight: 600, color: '#34d399' }}>+{result.penalties.visual_quality_score.toFixed(2)}</div>
              </div>
              <div>
                <span style={{ color: '#9ca3af' }}>Penalización Parón (-):</span>
                <div style={{ fontWeight: 600, color: '#f87171' }}>-{result.penalties.freeze_penalty.toFixed(2)}</div>
              </div>
              <div>
                <span style={{ color: '#9ca3af' }}>Penalización Cortes (-):</span>
                <div style={{ fontWeight: 600, color: '#f87171' }}>-{result.penalties.stall_count_penalty.toFixed(2)}</div>
              </div>
              <div>
                <span style={{ color: '#9ca3af' }}>Penalización Latencia (-):</span>
                <div style={{ fontWeight: 600, color: '#fbbf24' }}>-{result.penalties.latency_penalty.toFixed(2)}</div>
              </div>
              <div>
                <span style={{ color: '#9ca3af' }}>Penalización Catch-up (-):</span>
                <div style={{ fontWeight: 600, color: '#e5e7eb' }}>-{result.penalties.catchup_penalty.toFixed(2)}</div>
              </div>
              <div>
                <span style={{ color: '#9ca3af' }}>Inestabilidad Calidad (-):</span>
                <div style={{ fontWeight: 600, color: '#e5e7eb' }}>-{result.penalties.smoothness_penalty.toFixed(2)}</div>
              </div>
            </div>
          </div>

          {/* Gráfica Temporal por Segundo */}
          <div style={{ background: '#1f2937', padding: '1.25rem', borderRadius: '0.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 0.5rem 0', color: '#e5e7eb' }}>
              Serie Temporal (Segundo a Segundo)
            </h3>
            <p style={{ margin: '0 0 1rem 0', fontSize: '0.85rem', color: '#9ca3af' }}>
              Evolución de VMAF (verde), Latencia (ámbar) y momentos de congelación (rojo)
            </p>

            <div style={{ width: '100%', height: '220px', position: 'relative' }}>
              <svg width="100%" height="100%" viewBox={`0 0 ${result.timeline.length * 20 + 40} 180`} preserveAspectRatio="none">
                {/* Ejes y líneas de cuadrícula */}
                <line x1="30" y1="20" x2={result.timeline.length * 20 + 30} y2="20" stroke="#374151" strokeDasharray="2" />
                <line x1="30" y1="80" x2={result.timeline.length * 20 + 30} y2="80" stroke="#374151" strokeDasharray="2" />
                <line x1="30" y1="140" x2={result.timeline.length * 20 + 30} y2="140" stroke="#4b5563" />

                {/* Etiquetas eje Y */}
                <text x="25" y="24" fill="#9ca3af" fontSize="9" textAnchor="end">100</text>
                <text x="25" y="84" fill="#9ca3af" fontSize="9" textAnchor="end">50</text>
                <text x="25" y="144" fill="#9ca3af" fontSize="9" textAnchor="end">0</text>

                {/* Barras de freeze en fondo */}
                {result.timeline.map((s, idx) => {
                  const x = 30 + idx * 20;
                  if (s.freeze_s > 0) {
                    return (
                      <rect
                        key={`frz-${s.sec}`}
                        x={x}
                        y="20"
                        width="18"
                        height="120"
                        fill="rgba(239, 68, 68, 0.25)"
                        stroke="#ef4444"
                        strokeWidth="1"
                      />
                    );
                  }
                  return null;
                })}

                {/* Curva VMAF */}
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="2.5"
                  points={result.timeline
                    .map((s, idx) => {
                      const x = 39 + idx * 20;
                      const y = 140 - (s.vmaf / 100) * 120;
                      return `${x},${y}`;
                    })
                    .join(' ')}
                />

                {/* Curva Latencia */}
                <polyline
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="2"
                  strokeDasharray="3 2"
                  points={result.timeline
                    .map((s, idx) => {
                      const x = 39 + idx * 20;
                      const clampedLat = Math.min(5.0, s.latency_s);
                      const y = 140 - (clampedLat / 5.0) * 120;
                      return `${x},${y}`;
                    })
                    .join(' ')}
                />

                {/* Puntos de cada segundo */}
                {result.timeline.map((s, idx) => {
                  const x = 39 + idx * 20;
                  const y = 140 - (s.vmaf / 100) * 120;
                  return (
                    <circle
                      key={`pt-${s.sec}`}
                      cx={x}
                      cy={y}
                      r="3"
                      fill={s.freeze_s > 0 ? '#ef4444' : '#10b981'}
                    />
                  );
                })}
              </svg>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', gap: '1.5rem', marginTop: '0.75rem', fontSize: '0.85rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ width: '12px', height: '3px', background: '#10b981' }} /> VMAF (0-100)
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ width: '12px', height: '2px', background: '#f59e0b', borderTop: '2px dashed #f59e0b' }} /> Latencia (0-5 s)
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ width: '10px', height: '10px', background: 'rgba(239, 68, 68, 0.4)', border: '1px solid #ef4444' }} /> Congelación
              </div>
            </div>
          </div>

          {/* Botones de acción final */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem' }}>
            <button
              onClick={() => setState('idle')}
              style={{
                background: '#374151',
                color: '#e5e7eb',
                border: 'none',
                padding: '0.6rem 1.25rem',
                borderRadius: '0.375rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Nueva Prueba
            </button>
            <button
              onClick={exportJSON}
              style={{
                background: '#2563eb',
                color: '#ffffff',
                border: 'none',
                padding: '0.6rem 1.25rem',
                borderRadius: '0.375rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Descargar Informe JSON
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
