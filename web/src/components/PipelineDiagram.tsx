import React, { useEffect, useRef, useState } from 'react';
import { Workflow } from 'lucide-react';
import { getClockSync } from '../lib/clock';
import type { StageBreakdown } from '../types';

// Recorrido de un frame en cada rama. Los elementos se agrupan por etapa MEDIDA: entre dos puntos de
// medida consecutivos se sabe con exactitud cuánto tarda un frame, pero no cómo se reparte ese tiempo
// entre los elementos de dentro. No se muestra ninguna cifra que no salga de dos horas medidas.
interface Stage {
  key: string;
  name: string;
  nodes: string[];
  includes: string;
  from: string;
  to: string;
  uncertainty: 'server' | 'browser' | 'both';
}

const ENCODE: Stage = {
  key: 'encode',
  name: 'Codificación',
  nodes: ['Fuente + timecode', 'x264', 'MPEG-TS / UDP'],
  includes: 'Escalado, codificación H.264 de esa calidad, multiplexado MPEG-TS junto al resto de calidades y al audio, y envío por UDP interno.',
  from: 'la marca de tiempo que FFmpeg quema en el frame antes de codificarlo',
  to: 'la llegada del último paquete de ese frame al socket de la compuerta de la rama (hora que marca el kernel)',
  uncertainty: 'server',
};

type LaneId = 'dash' | 'moq' | 'rtc';

const LANES: { id: LaneId; title: string; color: string; bar: string; stages: Stage[] }[] = [
  {
    id: 'dash',
    title: 'LL-DASH',
    color: 'text-blue-400',
    bar: '#3b82f6',
    stages: [
      ENCODE,
      {
        key: 'package',
        name: 'Empaquetado CMAF',
        nodes: ['Compuerta', 'FFmpeg dash', 'Origen'],
        includes:
          'Espera a que se complete el fragmento CMAF que contiene el frame (hasta la duración de fragmento configurada), más el paso por FFmpeg y la escritura en el origen.',
        from: 'la llegada del frame al socket de la compuerta',
        to: 'el instante en que su fragmento queda completo en el origen',
        uncertainty: 'server',
      },
      {
        key: 'deliver',
        name: 'Entrega',
        nodes: ['Nginx', 'Router (emulación)', 'Entrada / proxy', 'Red', 'dash.js'],
        includes:
          'Camino HTTP del fragmento desde el origen hasta el búfer del navegador: Nginx, router de emulación de red, punto de entrada, proxy externo si lo hay, la red y la descarga y anexado por dash.js. Si el navegador aún no había pedido el segmento, también esa espera.',
        from: 'el fragmento completo en el origen',
        to: 'el primer instante en que el búfer del <video> contiene ese frame (se comprueba cada 20 ms)',
        uncertainty: 'both',
      },
      {
        key: 'player',
        name: 'Búfer y pintado',
        nodes: ['Búfer MSE', 'Decodificador', 'Pantalla'],
        includes: 'Tiempo que el frame espera en el búfer del reproductor hasta que le toca, más decodificación y presentación. Es donde actúa la latencia objetivo.',
        from: 'la entrada del frame en el búfer',
        to: 'el instante en que el navegador lo presenta',
        uncertainty: 'browser',
      },
    ],
  },
  {
    id: 'moq',
    title: 'Media over QUIC',
    color: 'text-emerald-400',
    bar: '#10b981',
    stages: [
      ENCODE,
      {
        key: 'ingest',
        name: 'Entrada al publicador',
        nodes: ['Compuerta'],
        includes:
          'Tiempo que el frame, ya codificado, espera a que el publicador lo acepte. La compuerta le entrega los datos por una tubería y se bloquea si el publicador no la vacía; si esta etapa crece, el publicador (o lo que tiene detrás) no da abasto.',
        from: 'la llegada del frame al socket de la compuerta',
        to: 'el instante en que la compuerta lo lee y lo escribe hacia el publicador',
        uncertainty: 'server',
      },
      {
        key: 'transport',
        name: 'Publicación y transporte',
        nodes: ['moq import', 'Relay', 'Router (emulación)', 'Red QUIC'],
        includes:
          'Publicador, relay y red juntos: no se pueden separar sin instrumentar el relay, que es un binario de terceros. Incluye retransmisiones QUIC si hay pérdidas.',
        from: 'la entrega del frame al publicador',
        to: 'el instante en que el reproductor lo lee de la conexión, antes de decodificarlo',
        uncertainty: 'both',
      },
      {
        key: 'player',
        name: 'Búfer de jitter y pintado',
        nodes: ['Búfer de jitter', 'WebCodecs', 'Canvas'],
        includes: 'Espera en el búfer de sincronización hasta su hora de presentación (latencia objetivo), decodificación y dibujado en el canvas.',
        from: 'la llegada del frame al reproductor',
        to: 'el instante en que está dibujado en el canvas',
        uncertainty: 'browser',
      },
    ],
  },
  {
    id: 'rtc',
    title: 'WebRTC',
    color: 'text-amber-400',
    bar: '#f59e0b',
    stages: [
      ENCODE,
      {
        key: 'ingest',
        name: 'Entrada al empaquetador',
        nodes: ['Compuerta'],
        includes:
          'Tiempo que el frame, ya codificado, espera a que el FFmpeg que lo publica por RTSP lo acepte. La compuerta le entrega los datos por una tubería y se bloquea si no la vacía.',
        from: 'la llegada del frame al socket de la compuerta',
        to: 'el instante en que la compuerta lo lee y lo escribe hacia FFmpeg',
        uncertainty: 'server',
      },
      {
        key: 'transport',
        name: 'Publicación y transporte',
        nodes: ['FFmpeg (RTSP)', 'MediaMTX', 'Router (emulación)', 'Red SRTP'],
        includes:
          'Reempaquetado a RTSP, MediaMTX y la red juntos: no se pueden separar sin instrumentar MediaMTX. Incluye las retransmisiones que pida el navegador si hay pérdidas.',
        from: 'la entrega del frame al FFmpeg que publica',
        to: 'la hora a la que el navegador recibe el último paquete de ese frame (la da el propio navegador con cada frame)',
        uncertainty: 'both',
      },
      {
        key: 'player',
        name: 'Búfer de jitter y pintado',
        nodes: ['Búfer de jitter', 'Decodificador', 'Pantalla'],
        includes: 'Espera en el búfer de jitter del navegador, decodificación y presentación.',
        from: 'la recepción del último paquete del frame',
        to: 'el instante en que el navegador lo presenta',
        uncertainty: 'browser',
      },
    ],
  },
];

interface PipelineDiagramProps {
  stages: Record<LaneId, StageBreakdown | null | undefined>;
  latency: Record<LaneId, number | null>;
}

const stageMs = (breakdown: StageBreakdown | null | undefined, key: string) => breakdown?.stages.find((s) => s.key === key)?.ms ?? null;

/** Puntos que recorren el carril a velocidad real: tardan en cada etapa lo que se ha medido en ella. */
const Particles: React.FC<{ stages: Stage[]; breakdown?: StageBreakdown | null; color: string }> = ({ stages, breakdown, color }) => {
  const track = useRef<HTMLDivElement | null>(null);
  const latest = useRef(breakdown);
  latest.current = breakdown;

  useEffect(() => {
    const timer = setInterval(() => {
      const current = latest.current;
      const host = track.current;
      if (!current || !host || document.hidden || current.totalMs <= 0) return;
      const nodes = stages.reduce((sum, s) => sum + s.nodes.length, 0);
      // Fotogramas clave en las fronteras entre etapas: posición según el esquema, tiempo según lo medido.
      // Se anima transform y no left, para que lo mueva el compositor sin recalcular el layout.
      const width = host.clientWidth;
      let position = 0;
      let elapsed = 0;
      const frames: Keyframe[] = [{ transform: 'translateX(0px)', offset: 0 }];
      for (const s of stages) {
        position += s.nodes.length / nodes;
        elapsed += Math.max(0, stageMs(current, s.key) ?? 0);
        frames.push({ transform: `translateX(${Math.round(position * width)}px)`, offset: Math.min(1, elapsed / current.totalMs) });
      }
      frames[frames.length - 1].offset = 1;
      const dot = document.createElement('span');
      dot.style.cssText = `position:absolute;top:-3px;left:-4px;width:8px;height:8px;border-radius:9999px;background:${color};box-shadow:0 0 8px ${color};will-change:transform`;
      host.appendChild(dot);
      dot.animate(frames, { duration: Math.max(200, current.totalMs), easing: 'linear' }).onfinish = () => dot.remove();
    }, 400);
    return () => clearInterval(timer);
  }, [stages, color]);

  return <div ref={track} className="relative h-0.5 bg-slate-700/70 rounded mx-1 my-2" />;
};

export const PipelineDiagram: React.FC<PipelineDiagramProps> = ({ stages: data, latency }) => {
  const [selected, setSelected] = useState<{ lane: LaneId; key: string }>({ lane: 'dash', key: 'deliver' });
  const scaleMs = Math.max(data.dash?.totalMs ?? 0, data.moq?.totalMs ?? 0, data.rtc?.totalMs ?? 0, 1);
  const clock = getClockSync();
  const clockError = clock ? clock.rttMs / 2 : null;

  const lane = LANES.find((l) => l.id === selected.lane)!;
  const stage = lane.stages.find((s) => s.key === selected.key) ?? lane.stages[0];
  const value = stageMs(data[lane.id], stage.key);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg">
      <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
        <div className="flex items-center space-x-2">
          <Workflow className="w-5 h-5 text-indigo-400" />
          <h3 className="font-semibold text-slate-200">Recorrido de un frame y latencia medida en cada etapa</h3>
        </div>
        <span className="text-[11px] text-slate-500">Los puntos viajan a velocidad real. Pulsa una etapa para ver qué incluye y cómo se mide.</span>
      </div>

      <div className="space-y-5">
        {LANES.map((l) => {
          const breakdown = data[l.id];
          const nodes = l.stages.reduce((sum, s) => sum + s.nodes.length, 0);
          return (
            <div key={l.id}>
              <div className="flex items-baseline justify-between mb-1.5 text-xs">
                <span className={`font-semibold ${l.color}`}>{l.title}</span>
                <span className="font-mono text-slate-400">
                  {breakdown
                    ? `este frame: ${breakdown.totalMs} ms · mediana glass-to-glass ${latency[l.id] ?? '--'} ms · ${breakdown.samples} frames seguidos en el último segundo`
                    : 'sin frames seguidos de principio a fin en el último segundo'}
                </span>
              </div>

              {/* Elementos del recorrido, agrupados por etapa medida */}
              <div className="flex gap-1.5">
                {l.stages.map((s) => {
                  const ms = stageMs(breakdown, s.key);
                  const active = selected.lane === l.id && selected.key === s.key;
                  return (
                    <button
                      key={s.key}
                      onClick={() => setSelected({ lane: l.id, key: s.key })}
                      style={{ flexGrow: s.nodes.length, flexBasis: 0 }}
                      className={`min-w-0 text-left rounded-lg border p-2 cursor-pointer transition ${
                        active ? 'border-indigo-500 bg-indigo-950/40' : 'border-slate-800 bg-slate-950/60 hover:border-slate-600'
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2 mb-1.5">
                        <span className="text-[11px] text-slate-400 truncate">{s.name}</span>
                        <span className="font-mono text-sm font-bold text-slate-100 whitespace-nowrap">{ms === null ? '--' : `${ms} ms`}</span>
                      </div>
                      <div className="flex gap-1">
                        {s.nodes.map((node) => (
                          <span
                            key={node}
                            className="flex-1 min-w-0 truncate text-center text-[10px] text-slate-300 bg-slate-800/80 border border-slate-700/60 rounded px-1 py-1"
                            title={node}
                          >
                            {node}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div style={{ paddingLeft: 0 }}>
                <Particles stages={l.stages} breakdown={breakdown} color={l.bar} />
              </div>

              {/* Reparto a escala de tiempo común para las dos ramas */}
              <div className="flex h-5 rounded overflow-hidden bg-slate-950/60 border border-slate-800" title={`Barra a escala: ${nodes} elementos, ${breakdown?.totalMs ?? '--'} ms`}>
                {breakdown?.stages.map((s, i) => (
                  <div
                    key={s.key}
                    style={{ width: `${(Math.max(0, s.ms) / scaleMs) * 100}%`, background: l.bar, opacity: 1 - i * 0.2 }}
                    className="h-full flex items-center justify-center text-[10px] font-mono text-white/90 overflow-hidden whitespace-nowrap border-r border-slate-950/60"
                  >
                    {s.ms > scaleMs * 0.04 ? s.ms : ''}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detalle de la etapa seleccionada */}
      <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-300 space-y-1.5">
        <p>
          <span className={`font-semibold ${lane.color}`}>{lane.title}</span> · <span className="font-semibold text-slate-100">{stage.name}</span>:{' '}
          <span className="font-mono">{value === null ? 'sin medida' : `${value} ms`}</span>
        </p>
        <p>
          <span className="text-slate-500">Qué incluye:</span> {stage.includes}
        </p>
        <p>
          <span className="text-slate-500">Cómo se mide:</span> desde {stage.from} hasta {stage.to}. Las cifras son las de un frame real: el de latencia total mediana entre los seguidos en el último segundo.
        </p>
        <p className="text-slate-400">
          <span className="text-slate-500">Incertidumbre:</span>{' '}
          {stage.uncertainty === 'server' && 'las dos horas son del reloj del servidor: precisión de milisegundos.'}
          {stage.uncertainty === 'browser' && 'las dos horas son del reloj del navegador: la limita el periodo de refresco de pantalla (unos 17 ms a 60 Hz).'}
          {stage.uncertainty === 'both' &&
            `una hora es del servidor y la otra del navegador, así que se suma el error de sincronización de relojes${
              clockError === null ? '' : ` (±${clockError.toFixed(1)} ms ahora)`
            }.`}
        </p>
      </div>
    </div>
  );
};
