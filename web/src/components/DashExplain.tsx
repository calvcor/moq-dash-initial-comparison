import React from 'react';
import type { DashAbr } from '../types';

// Explicación, en la propia página, de cómo elige calidad y cómo persigue la latencia el reproductor LL-DASH con las
// opciones elegidas. Resume PROTOCOLOS 3.5 y 3.6, README 5 y 6 y lo leído del código de dash.js 5.2.1
// (AbrController, ABRRulesCollection, sus reglas y CatchupController): si cambia alguno de ellos, hay que cambiar
// también este texto.

interface Props {
  abr: DashAbr;
  /** Calidad fijada a mano (altura) o 'auto'. */
  quality: number | 'auto';
  targetLatency: number;
  maxDrift: number;
  /** Búfer mínimo de la corrección LoL+ (liveCatchup.playbackBufferMin). */
  playbackBufferMin: number;
}

/** Búfer a partir del cual las reglas de fábrica cambian la de caudal por BOLA (abr.hybridSwitchBufferTime). */
const BOLA_ON_S = 12;

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-1">
    <div className="text-slate-300 font-semibold">{title}</div>
    <ul className="list-disc pl-4 space-y-1">{children}</ul>
  </div>
);

const s = (sec: number) => `${sec.toFixed(2).replace('.', ',')} s`;

const WHEN = (
  <li>
    <b>Cuándo decide:</b> antes de pedir cada segmento (2 s con la configuración habitual). La calidad nueva entra con
    el segmento siguiente; lo que ya está en el búfer no se reemplaza.
  </li>
);

const THROUGHPUT = (
  <li>
    <b>Caudal estimado:</b> dash.js mide cada fragmento CMAF desde su <code>moof</code> hasta el final de su{' '}
    <code>mdat</code> y promedia con medias exponenciales. Sin límite de red sale unas dos veces el bitrate que
    descarga, no la capacidad (README 6); con 4 Mbit/s de bajada se midió ~4,45 Mbit/s en el servidor, un 11 % por
    encima del enlace.
  </li>
);

/** Velocidad que pone la corrección LoL+ con el búfer por debajo del mínimo (CatchupController, playbackRate ±0,5). */
const lolpRate = (buffer: number, min: number) => 0.5 + 1 / (1 + Math.exp(-5 * (buffer - min)));
const x = (rate: number) => `${rate.toFixed(2).replace('.', ',')}×`;

/** Cómo persigue la latencia objetivo; igual con calidad automática o fija. */
function latencySection({ targetLatency, maxDrift, playbackBufferMin }: Props): React.ReactNode {
  const min = playbackBufferMin;
  return (
    <Section title="Latencia">
      <li>
        <b>Objetivo fijo</b> ({s(targetLatency)}, el slider): dash.js se coloca a esa distancia del directo y no la cambia
        por su cuenta, ni con la red lenta ni tras una parada (README 5). Todo lo que hay entre la reproducción y el
        directo es búfer, así que la latencia nunca es menor que el búfer.
      </li>
      {min > 0 ? (
        <li>
          <b>Corrección (modo LoL+), búfer por debajo del mínimo</b> ({s(min)}, el slider): frena para rellenarlo, más
          cuanto menos búfer ({x(lolpRate(min / 2, min))} con {s(min / 2)}; {x(lolpRate(0, min))} vacío), y no persigue el
          objetivo hasta superarlo.
          {targetLatency < min && (
            <>
              {' '}
              <span className="text-amber-300">
                Con el objetivo ({s(targetLatency)}) por debajo del mínimo, el búfer no llega a él: frena casi siempre y
                la latencia queda por encima del objetivo, en torno al mínimo más lo que tarda en llegar cada fragmento
                (deducción del código, sin medir).
              </span>
            </>
          )}
        </li>
      ) : (
        <li>
          <b>Corrección (modo LoL+), búfer mínimo en 0:</b> no frena nunca por búfer; solo corrige la latencia, aunque el
          búfer esté a punto de vaciarse.
        </li>
      )}
      <li>
        <b>Corrección, búfer por encima del mínimo:</b> si la latencia se aparta más de un 2 % del objetivo, acelera o
        frena entre 0,5× y 1,5× según lo lejos que esté; si no, reproduce a 1×.
      </li>
      <li>
        <b>Salto al directo:</b>{' '}
        {maxDrift > 0 ? (
          <>
            si va más de {s(maxDrift)} por detrás del objetivo, deja de corregir con la velocidad y salta al directo,
            abortando las descargas en curso.
          </>
        ) : (
          <>desactivado: solo corrige con la velocidad, por lejos que quede.</>
        )}
      </li>
      <li>
        El vídeo se congela solo cuando el navegador se queda sin datos; ninguna regla de dash.js lo detiene antes.
      </li>
    </Section>
  );
}

export const DashExplain: React.FC<Props> = (props) => {
  const { abr, quality, targetLatency } = props;

  if (quality !== 'auto') {
    return (
      <div className="space-y-2">
        <Section title={`Calidad fijada (${quality}p)`}>
          <li>No hay adaptación: se pide siempre esa Representation, aunque no quepa en el enlace.</li>
          <li>Al cambiarla a mano, la nueva entra con el segmento siguiente.</li>
        </Section>
        {latencySection(props)}
      </div>
    );
  }

  if (abr === 'l2a') {
    return (
      <div className="space-y-2">
        <p>
          <b>Regla L2A de dash.js</b> (<i>Learn2Adapt</i>), en solitario: las de fábrica, incluida la de abandono, quedan
          apagadas. Cambiar el selector recrea el reproductor, porque la regla guarda estado desde el arranque.
        </p>
        <Section title="Elección (subir y bajar con la misma regla)">
          {WHEN}
          <li>
            Aprendizaje en línea sobre el caudal y el búfer. Compara el bitrate nominal (el del MPD) con la{' '}
            <b>última muestra de caudal, sin margen</b>, así que tiende a la calidad máxima aunque sus picos no quepan
            (README 6). Medido en local con 2 Mbit/s: sube a 720p@2000, que no cabe, y se congela.
          </li>
          {THROUGHPUT}
        </Section>
        {latencySection(props)}
      </div>
    );
  }

  if (abr === 'lolp') {
    return (
      <div className="space-y-2">
        <p>
          <b>Regla LoL+ de dash.js</b> (<i>Low-on-Latency+</i>), en solitario: las de fábrica, incluida la de abandono,
          quedan apagadas. Cambiar el selector recrea el reproductor, porque la regla guarda estado desde el arranque.
        </p>
        <Section title="Elección (subir y bajar con la misma regla)">
          {WHEN}
          <li>
            Antes de nada, <b>baja si búfer − tiempo de descarga estimado &lt; 0,3 s</b>, a la más alta de las inferiores
            que quepa en el caudal; en la mínima se queda. El tiempo de descarga lo estima para un segmento entero de la
            calidad actual (bitrate × duración / caudal). Con segmentos
            de 2 s necesita unos 0,6 s de búfer para poder subir
            {targetLatency < 0.6 && <>: con el objetivo en {s(targetLatency)} no sale de la calidad mínima</>}.
          </li>
          <li>
            Si pasa ese filtro, un mapa autoorganizado pondera calidad, latencia, búfer y cambios para elegir.
          </li>
          {THROUGHPUT}
          <li>
            Con el búfer lleno hasta el objetivo, cada segmento se descarga al ritmo del codificador y la estimación
            acaba siguiendo al bitrate que descarga: tras un rato en la mínima puede no subir aunque se alargue la
            latencia (README 6).
          </li>
        </Section>
        {latencySection(props)}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p>
        <b>Reglas de fábrica de dash.js</b> (lo que mide el banco). Cada regla propone una calidad y gana la más baja de
        las propuestas.
      </p>
      <Section title="Elección">
        {WHEN}
        <li>
          <b>Regla de caudal</b>, la que decide en la práctica: la calidad más alta cuyo <b>bitrate nominal</b> (el del
          MPD) no pase de <b>0,9 × el caudal estimado</b>. Sin histéresis: se recalcula en cada segmento y puede oscilar.
        </li>
        {THROUGHPUT}
        <li>
          <b>Con un enlace justo oscila:</b> con 4 Mbit/s y la escalera 1080p@4000 / 720p@2000, en 720p el enlace va
          holgado, la estimación (×0,9) llega a ~4000 y sube a 1080p, que no cabe; ahí baja de 4000 y vuelve a 720p.
          Medido en el servidor: 13-28 cambios por minuto y, con 0,3 s de objetivo, 12-30 congelados por minuto.
        </li>
        <li>
          <b>BOLA</b> (por búfer) solo releva a la de caudal con {BOLA_ON_S} s de búfer o más (vuelve a la de caudal por
          debajo de {BOLA_ON_S / 2}): con el objetivo en {s(targetLatency)}, no entra.
        </li>
        <li>
          <b>Búfer insuficiente:</b> no actúa. El MPD declara <code>availabilityTimeComplete=&quot;false&quot;</code>, así
          que dash.js va en modo de baja latencia, y en ese modo se la salta.
        </li>
        <li>
          <b>Historial de cambios:</b> si desde una calidad se ha bajado más de un 7,5 % de las veces (con al menos 8
          decisiones), la limita a la de debajo. En las medidas no evitó la oscilación.
        </li>
        <li>
          <b>Abandono:</b> corta una descarga si va a tardar más de 1,8 veces la duración del segmento. En baja latencia
          cada segmento se descarga al ritmo del codificador, así que rara vez actúa.
        </li>
      </Section>
      {latencySection(props)}
    </div>
  );
};
