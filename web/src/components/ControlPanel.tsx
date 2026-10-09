import React from 'react';
import { Play, Square, Settings2, RefreshCw, Plus, X } from 'lucide-react';
import type { StreamConfig, ServerStatus, Rendition } from '../types';

const MAX_RENDITIONS = 5;
const HEIGHTS = [1080, 720, 540, 480, 360, 240];
const SUGGESTED_KBPS: Record<number, number> = { 1080: 4000, 720: 2000, 540: 1200, 480: 1000, 360: 700, 240: 400 };

interface ControlPanelProps {
  status: ServerStatus | null;
  config: StreamConfig;
  isLoading: boolean;
  onConfigChange: (newConfig: StreamConfig) => void;
  onStart: () => void;
  onStop: () => void;
  onApplyConfig: () => void;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  status,
  config,
  isLoading,
  onConfigChange,
  onStart,
  onStop,
  onApplyConfig,
}) => {
  const isRunning = status?.status === 'running';
  const source = status?.source;
  const sourceReady = !source || source.state === 'ready';
  const hasChanges = Boolean(
    status?.config &&
    (config.gop_size !== status.config.gop_size ||
      JSON.stringify(config.renditions) !== JSON.stringify(status.config.renditions) ||
      config.seg_duration !== status.config.seg_duration ||
      config.frag_duration !== status.config.frag_duration)
  );

  const setRendition = (index: number, rendition: Rendition) =>
    onConfigChange({ ...config, renditions: config.renditions.map((r, i) => (i === index ? rendition : r)) });

  // La calidad nueva es el primer escalón libre por debajo de la más baja que haya
  const addRendition = () => {
    const used = new Set(config.renditions.map((r) => r.height));
    const height = HEIGHTS.find((h) => !used.has(h) && h < Math.min(...used)) ?? HEIGHTS.find((h) => !used.has(h)) ?? 360;
    onConfigChange({ ...config, renditions: [...config.renditions, { height, bitrate_kbps: SUGGESTED_KBPS[height] }] });
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg">
      <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
        <div className="flex items-center space-x-2">
          <Settings2 className="w-5 h-5 text-indigo-400" />
          <h3 className="font-semibold text-slate-200">Panel de Control Experimental</h3>
          {hasChanges && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
              Cambios pendientes
            </span>
          )}
          {source && source.state !== 'ready' && (
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full border ${
                source.state === 'error' ? 'bg-rose-500/20 text-rose-300 border-rose-500/30' : 'bg-sky-500/20 text-sky-300 border-sky-500/30'
              }`}
              title={source.error ?? 'El vídeo fuente no viene con el repositorio: se descarga de download.blender.org la primera vez.'}
            >
              {source.state === 'downloading' && `Descargando vídeo fuente… ${source.progress_pct} %`}
              {source.state === 'extracting' && 'Descomprimiendo vídeo fuente…'}
              {source.state === 'error' && 'Fallo al descargar el vídeo fuente; reintentando'}
            </span>
          )}
        </div>

        <div className="flex items-center space-x-3">
          {hasChanges && (
            <button
              onClick={onApplyConfig}
              disabled={isLoading || !sourceReady}
              className="flex items-center space-x-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-semibold transition cursor-pointer disabled:opacity-50 shadow-md shadow-indigo-600/30 animate-pulse"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Aplicar Cambios</span>
            </button>
          )}

          {isRunning ? (
            <button
              onClick={onStop}
              disabled={isLoading}
              className="flex items-center space-x-1.5 px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-sm font-medium transition cursor-pointer disabled:opacity-50"
            >
              <Square className="w-4 h-4" />
              <span>Detener Pipeline</span>
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={isLoading || !sourceReady}
              className="flex items-center space-x-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition cursor-pointer disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              <span>Iniciar Streaming</span>
            </button>
          )}
        </div>
      </div>

      {/* Selectores de Parámetros */}
      <div className="grid grid-cols-3 gap-4">
        {/* Tamaño de GOP (MoQ Group Boundary) */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">
            GOP / MoQ Group (Frames)
          </label>
          <select
            value={config.gop_size}
            onChange={(e) => {
              const newGop = Number(e.target.value);
              const gopSec = newGop / config.fps;
              const newSeg = Math.max(config.seg_duration, gopSec);
              onConfigChange({ ...config, gop_size: newGop, seg_duration: newSeg });
            }}
            className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          >
            <option value={15}>15 frames (~0.25 s)</option>
            <option value={30}>30 frames (~0.5 s)</option>
            <option value={60}>60 frames (1.0 s)</option>
            <option value={120}>120 frames (2.0 s)</option>
          </select>
          <span className="text-[10px] text-slate-500 mt-1 block">
            1 Keyframe = 1 nuevo MoQ Group ID
          </span>
        </div>

        {/* Chunk CMAF LL-DASH */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">
            Fragmento CMAF (LL-DASH)
          </label>
          <select
            value={config.frag_duration}
            onChange={(e) => onConfigChange({ ...config, frag_duration: Number(e.target.value) })}
            className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          >
            <option value={0.1}>100 ms</option>
            <option value={0.2}>200 ms</option>
            <option value={0.5}>500 ms</option>
            <option value={1.0}>1.0 s</option>
          </select>
          <span className="text-[10px] text-slate-500 mt-1 block">
            HTTP Chunked Transfer unit
          </span>
        </div>

        {/* Segmento Completo DASH */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">
            Segmento DASH (-seg_duration)
          </label>
          <select
            value={config.seg_duration}
            onChange={(e) => onConfigChange({ ...config, seg_duration: Number(e.target.value) })}
            className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          >
            {config.gop_size <= 30 && <option value={0.5}>0.5 segundos</option>}
            {config.gop_size <= 60 && <option value={1.0}>1.0 segundo</option>}
            <option value={2.0}>2.0 segundos</option>
            <option value={4.0}>4.0 segundos</option>
          </select>
          <span className="text-[10px] text-slate-500 mt-1 block">
            Debe ser ≥ GOP ({(config.gop_size / config.fps).toFixed(1)}s)
          </span>
        </div>

      </div>

      {/* Escalera de calidades que codifica la fuente en vivo */}
      <div className="mt-4 pt-3 border-t border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-slate-400">
            Escalera de calidades <span className="text-slate-600">(la adaptación elige entre ellas; con una sola no hay adaptación)</span>
          </span>
          <button
            onClick={addRendition}
            disabled={config.renditions.length >= MAX_RENDITIONS}
            className="flex items-center space-x-1 px-2.5 py-1 rounded border border-slate-800 bg-slate-950 text-xs text-slate-300 hover:text-white cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Añadir calidad</span>
          </button>
        </div>
        <div className="grid grid-cols-5 gap-3">
          {config.renditions.map((rendition, index) => (
            <div key={index} className="flex items-center space-x-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5">
              <select
                value={rendition.height}
                onChange={(e) => setRendition(index, { height: Number(e.target.value), bitrate_kbps: SUGGESTED_KBPS[Number(e.target.value)] })}
                className="bg-transparent text-slate-200 text-sm focus:outline-none"
              >
                {HEIGHTS.map((h) => (
                  <option key={h} value={h}>
                    {h}p
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={150}
                max={20000}
                step={100}
                value={rendition.bitrate_kbps}
                onChange={(e) => setRendition(index, { ...rendition, bitrate_kbps: Number(e.target.value) })}
                className="w-full min-w-0 bg-transparent text-slate-200 text-sm font-mono text-right focus:outline-none"
              />
              <span className="text-[10px] text-slate-500">kbps</span>
              <button
                onClick={() => onConfigChange({ ...config, renditions: config.renditions.filter((_, i) => i !== index) })}
                disabled={config.renditions.length <= 1}
                className="text-slate-500 hover:text-rose-400 cursor-pointer disabled:opacity-30 disabled:cursor-default"
                title="Quitar esta calidad"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <span className="text-[10px] text-slate-500 mt-1.5 block">
          Todas a {config.fps} fps y con el mismo GOP. Cambiar la escalera reinicia la fuente; el servidor las ordena de mayor a menor.
        </span>
      </div>
    </div>
  );
};
