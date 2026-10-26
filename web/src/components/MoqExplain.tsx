import React from 'react';
import type { MoqAbr, MoqSwitching } from '../types';

// Explicación, en la propia página, de cómo sube y baja de calidad el reproductor MoQ con las opciones elegidas.
// Resume README 6, 6.1 y 6.3 y lo leído del código de @moq/watch (git@bc64b9c) y de web/src/lib/moqProbe.ts: si
// cambia alguno de ellos, hay que cambiar también este texto.

interface Props {
  abr: MoqAbr;
  switching: MoqSwitching;
  /** Calidad fijada a mano (altura) o 'auto'. */
  quality: number | 'auto';
  /** La versión de @moq/watch trae el parche con la opción de cambio. */
  switchingSupported: boolean | null;
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-1">
    <div className="text-slate-300 font-semibold">{title}</div>
    <ul className="list-disc pl-4 space-y-1">{children}</ul>
  </div>
);

/** Cómo se hace el relevo al bajar, según la opción Cambio. */
function downHandover(switching: MoqSwitching, supported: boolean | null): React.ReactNode {
  if (supported === false)
    return (
      <li>
        <b>Relevo (versión sin el parche):</b> el de @moq/watch, sin corte: sigue descargando la calidad anterior, con la
        misma prioridad, hasta que la nueva la alcanza. Con el enlace lleno puede no completarse nunca.
      </li>
    );
  switch (switching) {
    case 'cancel':
      return (
        <li>
          <b>Relevo (Cambio = Cancelar):</b> la calidad anterior deja de descargarse al momento y su última imagen se queda
          en pantalla hasta que la nueva la alcanza. Libera el enlace enseguida, a cambio de un instante de imagen
          congelada. Si la selección cambia otra vez antes, o la nueva falla, la anterior vuelve a descargarse.
        </li>
      );
    case 'priority':
      return (
        <li>
          <b>Relevo (Cambio = Prioridad):</b> la nueva calidad se pide con prioridad 61 frente a los 60 de la anterior, así
          que el relay la envía primero. La anterior sigue pintándose, con lo que sobre del enlace, hasta que la nueva la
          alcanza; entonces la nueva vuelve a prioridad 60 y la anterior se suelta.
        </li>
      );
    default:
      return (
        <li>
          <b>Relevo (Cambio = Sin corte, el original):</b> se suscribe a la nueva calidad y sigue descargando la anterior,
          con la misma prioridad, hasta que la nueva alcanza la imagen en pantalla. Con el enlace lleno, la nueva puede no
          alcanzarla nunca: se sigue viendo la anterior, con congelados (README 6.1).
        </li>
      );
  }
}

const UP_HANDOVER = (
  <li>
    <b>Relevo al subir</b> (siempre sin corte, sea cual sea Cambio): @moq/watch abre la suscripción a la calidad nueva,
    con prioridad 60, y sigue pintando la anterior hasta que la nueva la alcanza; puede verse un paso atrás de hasta
    100 ms. Mientras dura, se descargan las dos con la misma prioridad.
  </li>
);

export const MoqExplain: React.FC<Props> = ({ abr, switching, quality, switchingSupported }) => {
  if (quality !== 'auto') {
    return (
      <div className="space-y-2">
        <Section title={`Calidad fijada (${quality}p)`}>
          <li>No hay adaptación: se pide siempre esa calidad, por nombre, a @moq/watch, aunque no quepa en el enlace.</li>
          <li>Al cambiarla a mano, el relevo hacia una calidad mayor es sin corte; hacia una menor, el de la opción Cambio.</li>
          {downHandover(switching, switchingSupported)}
        </Section>
      </div>
    );
  }

  if (abr === 'probe') {
    return (
      <div className="space-y-2">
        <p>
          <b className="text-amber-300">Experimento (README 6.3), no el comportamiento de @moq/watch.</b> Decide un
          controlador del banco, que pide la calidad a @moq/watch por nombre; la regla de la librería y la estimación del
          relay no intervienen (la estimación solo se muestra). Arranca en la calidad más baja.
        </p>
        <Section title="Subir de calidad">
          <li>
            Tras cada cambio espera a que se pinte la calidad pedida (de 3 a 10 s). Después, cada cierto tiempo (6 s al
            principio; el doble, hasta 32 s, tras un sondeo fallido o una bajada) abre un <b>sondeo de 4 s</b>: se suscribe a
            la calidad siguiente con <b>prioridad 0</b>, sin decodificarla. La actual sigue a 60, así que el relay solo le da
            al sondeo lo que sobra del enlace.
          </li>
          <li>
            <b>Capacidad</b> = lo que reciben la actual y la de sondeo en los 2 últimos segundos. <b>Bitrate real</b> de la
            siguiente = bytes por frame × cadencia, con al menos dos grupos completos (no el del catálogo, que es el pico).
          </li>
          <li>
            Sube si <b>0,8 × capacidad ≥ bitrate real</b>; si no, espera el doble hasta el siguiente sondeo. Tras subir, sondea
            la siguiente a los 5 s. Los datos del sondeo no se reutilizan: la librería abre su propia suscripción.
          </li>
          {UP_HANDOVER}
        </Section>
        <Section title="Bajar de calidad">
          <li>
            Si la actual recibe menos del <b>90 % de su cadencia</b> en frames por segundo durante 2 s, baja <b>un escalón</b>.
            Si eso pasa durante un sondeo, corta el sondeo en vez de bajar. La medida de capacidad no se usa para bajar.
          </li>
          {downHandover(switching, switchingSupported)}
        </Section>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p>
        <b>Comportamiento de @moq/watch</b> (lo que mide el banco). La estimación de ancho de banda la hace el relay y la envía
        en los mensajes PROBE: es su ventana de congestión entre el RTT, que con RTT pequeños sale muy por encima del enlace
        (README 6, PROTOCOLOS 4.10).
      </p>
      <Section title="Elección (subir y bajar con la misma regla)">
        <li>
          Elige la calidad <b>más alta cuyo bitrate de catálogo quepa en el 80 % de la estimación</b>; si no cabe ninguna, la
          más baja. El bitrate del catálogo es el pico retenido de ventanas de 1 s (unas 1,85 veces el nominal).
        </li>
        <li>Sin histéresis ni temporizadores: se recalcula cada vez que cambia la estimación, y puede oscilar.</li>
      </Section>
      <Section title="Subir de calidad">{UP_HANDOVER}</Section>
      <Section title="Bajar de calidad">{downHandover(switching, switchingSupported)}</Section>
    </div>
  );
};
