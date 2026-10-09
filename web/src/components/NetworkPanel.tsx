import React, { useEffect, useState } from 'react';
import { Network, Check } from 'lucide-react';
import type { LinkProfile, NetworkProfile, NetworkState } from '../types';

interface NetworkPanelProps {
  network: NetworkState | null | undefined;
  ipRates: Record<'dash_down' | 'dash_up' | 'moq_down' | 'moq_up', number | null>;
  isLoading: boolean;
  onApply: (profile: NetworkProfile) => void;
}

const CLEAR: LinkProfile = { rate_kbit: null, delay_ms: 0, jitter_ms: 0, loss_pct: 0, queue_ms: 100 };

// Perfiles orientativos para arrancar una prueba; no reproducen ninguna red medida
const PRESETS: { label: string; profile: NetworkProfile }[] = [
  { label: 'Sin restricción', profile: { down: CLEAR, up: CLEAR } },
  { label: 'RTT 100 ms', profile: { down: { ...CLEAR, delay_ms: 50 }, up: { ...CLEAR, delay_ms: 50 } } },
  { label: 'Pérdida 1 %', profile: { down: { ...CLEAR, delay_ms: 20, loss_pct: 1 }, up: { ...CLEAR, delay_ms: 20, loss_pct: 1 } } },
  {
    label: 'Móvil',
    profile: {
      down: { rate_kbit: 10000, delay_ms: 30, jitter_ms: 5, loss_pct: 0.2, queue_ms: 200 },
      up: { rate_kbit: 5000, delay_ms: 30, jitter_ms: 5, loss_pct: 0.2, queue_ms: 200 },
    },
  },
  { label: 'Enlace saturado (3 Mbit)', profile: { down: { ...CLEAR, rate_kbit: 3000, delay_ms: 30, queue_ms: 200 }, up: { ...CLEAR, delay_ms: 30 } } },
];

const FIELDS: { key: keyof LinkProfile; label: string; unit: string; step: number; hint: string }[] = [
  { key: 'rate_kbit', label: 'Ancho de banda', unit: 'kbit/s', step: 500, hint: 'Vacío = sin límite' },
  { key: 'delay_ms', label: 'Retardo', unit: 'ms', step: 10, hint: 'Por sentido; el RTT es la suma de ambos' },
  { key: 'jitter_ms', label: 'Jitter', unit: 'ms', step: 1, hint: 'Variación del retardo; puede reordenar paquetes' },
  { key: 'loss_pct', label: 'Pérdida', unit: '%', step: 0.1, hint: 'Aleatoria e independiente por paquete' },
  { key: 'queue_ms', label: 'Cola', unit: 'ms', step: 50, hint: 'Búfer del cuello de botella; solo actúa con ancho de banda limitado' },
];

const same = (a: NetworkProfile, b: NetworkProfile) => JSON.stringify(a) === JSON.stringify(b);
const kbps = (value: number | null) => (value === null ? '--' : `${value} kbps`);

export const NetworkPanel: React.FC<NetworkPanelProps> = ({ network, ipRates, isLoading, onApply }) => {
  const applied = network?.profile;
  const [draft, setDraft] = useState<NetworkProfile>({ down: CLEAR, up: CLEAR });
  const [initialized, setInitialized] = useState(false);

  // Partir del perfil que ya tenga el router (puede haberse aplicado desde otra pestaña)
  useEffect(() => {
    if (applied && !initialized) {
      setDraft(applied);
      setInitialized(true);
    }
  }, [applied, initialized]);

  const setField = (direction: 'down' | 'up', key: keyof LinkProfile, raw: string) => {
    const value = raw === '' ? (key === 'rate_kbit' ? null : 0) : Number(raw);
    setDraft((d) => ({ ...d, [direction]: { ...d[direction], [key]: value } }));
  };

  const pending = Boolean(applied && !same(applied, draft));
  const stats = network?.stats;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg">
      <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
        <div className="flex items-center space-x-2">
          <Network className="w-5 h-5 text-indigo-400" />
          <h3 className="font-semibold text-slate-200" title="El mismo perfil se aplica por separado a LL-DASH y a MoQ: cada protocolo ve un enlace idéntico y no compiten entre sí.">
            Emulación de Red (un enlace idéntico por protocolo)
          </h3>
          {!network && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30">Router no disponible</span>
          )}
          {network?.emulation_error && (
            <span
              className="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30"
              title={`El servidor no puede emular la red; suele faltar cargar en su kernel los módulos sch_prio, sch_tbf, sch_netem y cls_u32. ${network.emulation_error}`}
            >
              Emulación no disponible en este servidor
            </span>
          )}
          {pending && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">Cambios pendientes</span>
          )}
        </div>
        <div className="flex items-center space-x-2 text-xs">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => setDraft(preset.profile)}
              className={`px-2.5 py-1 rounded border cursor-pointer ${
                same(draft, preset.profile) ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200' : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {preset.label}
            </button>
          ))}
          <button
            onClick={() => onApply(draft)}
            disabled={isLoading || !network || !pending || Boolean(network.emulation_error)}
            className="flex items-center space-x-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            <Check className="w-4 h-4" />
            <span>Aplicar red</span>
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {(['down', 'up'] as const).map((direction) => (
          <div key={direction} className="grid grid-cols-6 gap-3 items-end">
            <div className="text-xs text-slate-300 pb-2">
              <span className="font-semibold">{direction === 'down' ? 'Bajada' : 'Subida'}</span>
              <span className="block text-[10px] text-slate-500">{direction === 'down' ? 'servidor → navegador' : 'navegador → servidor'}</span>
            </div>
            {FIELDS.map((field) => (
              <label key={field.key} className="block" title={field.hint}>
                {direction === 'down' && (
                  <span className="block text-xs font-medium text-slate-400 mb-1">
                    {field.label} <span className="text-slate-600">({field.unit})</span>
                  </span>
                )}
                <input
                  type="number"
                  min={0}
                  step={field.step}
                  placeholder={field.key === 'rate_kbit' ? 'sin límite' : '0'}
                  value={draft[direction][field.key] ?? ''}
                  onChange={(e) => setField(direction, field.key, e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-indigo-500"
                />
              </label>
            ))}
          </div>
        ))}
      </div>

      {/* Lo que ve el router: tráfico IP real por protocolo y descartes de la emulación */}
      <div className="mt-3 pt-3 border-t border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-400">
        <span title="Bytes IP reenviados por el router (cabeceras TCP/UDP/IP y retransmisiones incluidas), medidos antes de aplicar la emulación. Misma capa para los dos protocolos.">
          Tráfico IP en el router · DASH ↓ {kbps(ipRates.dash_down)} ↑ {kbps(ipRates.dash_up)} · MoQ ↓ {kbps(ipRates.moq_down)} ↑ {kbps(ipRates.moq_up)}
        </span>
        <span title="Paquetes descartados por la emulación desde que arrancó el router (pérdida aleatoria más desbordamiento de la cola) y paquetes retenidos ahora mismo en la cola de bajada. Cada protocolo tiene su propia cola con el mismo perfil.">
          Descartes ↓/↑ · DASH {stats?.dash_down.dropped ?? '--'}/{stats?.dash_up.dropped ?? '--'} · MoQ {stats?.moq_down.dropped ?? '--'}/
          {stats?.moq_up.dropped ?? '--'} · en cola ↓ DASH {stats?.dash_down.queued ?? '--'} · MoQ {stats?.moq_down.queued ?? '--'} paq.
        </span>
      </div>
    </div>
  );
};
