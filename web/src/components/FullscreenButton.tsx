import React, { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

// Pantalla completa de la zona de vídeo de un reproductor (el contenedor, no solo el <video> o el canvas,
// para que se sigan viendo sus avisos). Solo escala la imagen: el timecode se lee del frame decodificado,
// no de lo que se pinta. El contenedor lleva data-player con el id del reproductor; el CSV registra cuál
// está a pantalla completa en la columna fullscreen.

export function toggleFullscreen(target: HTMLElement | null) {
  if (!target) return;
  if (document.fullscreenElement === target) void document.exitFullscreen();
  else void target.requestFullscreen().catch(() => {});
}

export const FullscreenButton: React.FC<{ target: React.RefObject<HTMLElement | null> }> = ({ target }) => {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const update = () => setActive(document.fullscreenElement !== null && document.fullscreenElement === target.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, [target]);

  return (
    <button
      onClick={() => toggleFullscreen(target.current)}
      className="absolute top-2 right-2 z-10 p-1.5 rounded bg-black/50 text-slate-300 hover:text-white hover:bg-black/70 opacity-0 group-hover:opacity-100 focus:opacity-100 transition cursor-pointer"
      title={active ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa (o doble clic en el vídeo)'}
    >
      {active ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
    </button>
  );
};
