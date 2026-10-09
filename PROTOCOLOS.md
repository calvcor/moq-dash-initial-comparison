# Cómo funcionan los tres mecanismos de entrega: LL-DASH, Media over QUIC y WebRTC

Este documento explica, de extremo a extremo, cómo viaja el vídeo en cada una de las tres ramas del
testbed. La parte de Media over QUIC (MoQ) es la más detallada: usa su terminología propia y baja
hasta lo que hacen exactamente las versiones instaladas aquí.

**De dónde sale la información.** Lo que se afirma sobre el comportamiento concreto de este testbed
está leído del código fuente de las librerías instaladas, de la configuración del proyecto y de los
registros del servidor desplegado (9 de octubre de 2026). Cuando algo es una deducción y no una
comprobación directa, se dice.

| Componente | Versión comprobada |
| :--- | :--- |
| Relay MoQ (`moqdev/moq-relay`) | 0.17.2 |
| Publicador MoQ (`moq`, moq-cli) | 0.14.2 |
| Reproductor MoQ (`@moq/watch` / `@moq/net` / `@moq/hang`) | 0.6.2 / 0.4.2 / 0.5.2 |
| Protocolo MoQ negociado (navegador y publicador) | `moq-lite-06` |
| Reproductor DASH (`dash.js`) | 5.2.1 |
| Servidor WebRTC (MediaMTX) | 1.21.2 |
| Codificador | FFmpeg 7.1 + libx264 |

---

## Índice

1. [Lo que comparten las tres ramas](#1-lo-que-comparten-las-tres-ramas)
2. [Conceptos previos](#2-conceptos-previos)
3. [LL-DASH](#3-ll-dash)
4. [Media over QUIC](#4-media-over-quic)
5. [WebRTC](#5-webrtc)
6. [Comparación lado a lado](#6-comparación-lado-a-lado)
7. [Qué controla cada mando del panel](#7-qué-controla-cada-mando-del-panel)
8. [Glosario](#8-glosario)

---

## 1. Lo que comparten las tres ramas

Las tres ramas reciben **exactamente el mismo vídeo codificado**. Hay un único proceso FFmpeg (la
"fuente maestra") que lee Big Buck Bunny a ritmo real, quema el timecode y la etiqueta de calidad,
codifica con x264 y reparte el resultado por tres puertos UDP locales. A partir de ahí nadie vuelve a
codificar: cada rama solo **reempaqueta** los mismos bytes H.264 en su propio formato.

```
                          ┌─ UDP 5001 ─ tsgate ─ ffmpeg (-f dash) ─ PUT ─▶ origen en memoria ─▶ nginx ─▶ router ─▶ navegador (dash.js)
Fichero ─▶ FFmpeg ────────┼─ UDP 5002 ─ tsgate ─ moq import ts ─ QUIC ───▶ moq-relay ─────────────────▶ router ─▶ navegador (@moq/watch)
(x264, 1 a 5 calidades)   └─ UDP 5003 ─ tsgate ─ ffmpeg (-f rtsp) ─ RTSP ▶ MediaMTX ──────────────────▶ router ─▶ navegador (RTCPeerConnection)
```

Consecuencias para la comparación:

- **La codificación no es una variable.** Mismo códec (H.264 *baseline*, `ultrafast`, `zerolatency`,
  sin B-frames), mismo GOP, mismo bitrate. Las diferencias de latencia entre ramas vienen del
  empaquetado, del transporte y del reproductor.
- **La ingesta no se degrada.** El tramo codificador → servidor de cada rama va por la red interna
  de Docker. El router que emula la red solo actúa entre los servidores finales y el navegador.
- **`tsgate.py`** es una compuerta que deja pasar el flujo MPEG-TS a cada empaquetador empezando
  justo en un keyframe, y de paso apunta a qué hora salió cada frame del codificador. No altera los
  datos.

El formato intermedio entre la fuente y los empaquetadores es **MPEG-TS**: un contenedor de paquetes
fijos de 188 bytes pensado para emisión, que permite engancharse al flujo en cualquier momento. Solo
existe dentro del servidor; ninguna rama lo envía al navegador.

---

## 2. Conceptos previos

Cuatro ideas que aparecen en las tres ramas y que conviene tener claras antes.

### 2.1. Frames, keyframes y GOP

Un vídeo comprimido no guarda cada imagen completa. Guarda de vez en cuando una imagen entera (un
**keyframe**, o frame IDR) y, entre medias, solo las diferencias respecto a la anterior (frames
**delta**, o P-frames). El conjunto de un keyframe y todos los delta que dependen de él es un **GOP**
(*Group of Pictures*).

Dos consecuencias que condicionan todo lo demás:

- **Solo se puede empezar a decodificar en un keyframe.** Quien llega a mitad de un GOP tiene que
  esperar al siguiente keyframe o recibir el GOP desde su principio.
- **Si se pierde un frame, los siguientes del mismo GOP no sirven**, porque dependen de él. Lo
  perdido no se recupera hasta el siguiente keyframe (o hasta que se retransmita).

Aquí el GOP por defecto es de 60 frames a 60 fps: un keyframe por segundo.

### 2.2. Transporte fiable y no fiable

- **TCP** entrega todos los bytes y en orden. Si un paquete se pierde, todo lo que venía detrás
  espera a que se retransmita, aunque ya haya llegado. Eso es el **bloqueo de cabeza de línea**
  (*head-of-line blocking*).
- **UDP** entrega paquetes sueltos sin garantías: pueden perderse o llegar desordenados, y nadie
  espera a nadie.
- **QUIC** va sobre UDP y ofrece **muchos streams independientes** dentro de una misma conexión.
  Cada stream es fiable y ordenado por dentro, pero una pérdida en un stream no detiene a los demás.
  Además permite **cancelar** un stream (dejar de retransmitirlo) y **priorizar** unos sobre otros.

Esta es la diferencia de fondo entre las tres ramas: DASH usa un flujo fiable único (TCP), WebRTC
paquetes sueltos (UDP con retransmisión selectiva) y MoQ muchos flujos fiables cancelables (QUIC).

### 2.3. Control de congestión

Es el algoritmo con el que el **emisor** decide a qué ritmo puede enviar sin saturar la red. Cada
rama usa uno distinto, y eso afecta al resultado tanto como el protocolo:

| Rama | Quién lo ejecuta | Algoritmo |
| :--- | :--- | :--- |
| DASH | El núcleo Linux del servidor (TCP) | CUBIC, basado en pérdidas |
| MoQ | El relay (QUIC) | BBRv3 por defecto (`--quic-congestion-control delay`); alternativa `loss` |
| WebRTC | MediaMTX | No adapta el envío: reenvía el flujo tal cual llega |

Con un 1 % de pérdida, CUBIC reduce su ventana en cada pérdida y se queda por debajo del bitrate
del vídeo; BBR estima el ancho de banda real y apenas se inmuta. Es una variable de confusión: parte
de lo que se observa "en MoQ" frente a "en DASH" con pérdidas es BBR frente a CUBIC.

### 2.4. Búfer y directo

El **directo** (*live edge*) es el instante más reciente del contenido que ya existe. El reproductor
siempre va algo por detrás, y esa distancia es media ya recibida y aún no mostrada: el **búfer**.
Es el colchón contra las irregularidades de la red y, a la vez, la mayor parte de la latencia.

---

## 3. LL-DASH

### 3.1. La idea

DASH (*Dynamic Adaptive Streaming over HTTP*) trata el vídeo como una **colección de ficheros
pequeños** servidos por un servidor web normal. El reproductor descarga un índice, calcula qué
fichero toca en cada momento y lo pide por HTTP. Toda la inteligencia está en el cliente; el
servidor solo sirve ficheros. Por eso escala tan bien con CDN: cualquier caché HTTP vale.

El precio es la latencia. En DASH clásico un fichero (un **segmento**) no se puede pedir hasta que
está completo, y el reproductor necesita varios por delante. Con segmentos de 2 a 6 s salen latencias
de 10 a 30 s. **LL-DASH** (*Low-Latency DASH*) es el conjunto de técnicas para reducir eso sin
abandonar HTTP.

### 3.2. Las piezas

**El manifiesto (MPD).** Un XML que describe el contenido. Su jerarquía:

- **Period**: un tramo temporal del contenido. Aquí hay uno solo.
- **AdaptationSet**: un componente (el vídeo, el audio). Agrupa versiones intercambiables entre sí.
- **Representation**: una versión concreta (una **calidad**): resolución, bitrate y códec.
- **SegmentTemplate**: la plantilla con la que se construyen las URL de los segmentos.

**Los segmentos.** Dos tipos de fichero por cada Representation:

- **Segmento de inicialización** (`init-stream0.m4s`): cabeceras (`ftyp` + `moov`) con la
  configuración del decodificador. Se descarga una vez.
- **Segmentos de media** (`chunk-stream0-00042.m4s`): el vídeo en sí, numerados. Cada uno empieza por
  un keyframe.

**CMAF** (*Common Media Application Format*) es el formato de esos ficheros: MP4 fragmentado. Lo
relevante para la baja latencia es que un segmento CMAF se compone de **chunks** (aquí llamados
**fragmentos**): pares `moof` + `mdat`, cada uno con unos pocos frames y decodificable en cuanto
llega, sin esperar al resto del segmento.

```
Segmento de 2 s  =  [moof][mdat] [moof][mdat] [moof][mdat] ... (20 fragmentos de 100 ms)
                     └─ fragmento ─┘
```

### 3.3. Qué añade la baja latencia

Tres mecanismos, que tienen que darse a la vez:

1. **Codificación en fragmentos.** El empaquetador cierra un fragmento cada `frag_duration` y lo
   emite de inmediato, en vez de esperar al segmento entero.
2. **Transferencia *chunked*.** El servidor sirve un segmento **mientras todavía se está
   escribiendo**: la respuesta HTTP no declara longitud y va soltando fragmentos conforme existen
   (`Transfer-Encoding: chunked`). El reproductor pide el segmento en curso y lo recibe a goteo.
3. **Anuncio de disponibilidad adelantada.** El manifiesto le dice al reproductor que puede pedir un
   segmento antes de que esté completo.

El manifiesto real que sirve ahora el testbed (resumido) lo muestra:

```xml
<MPD type="dynamic"
     availabilityStartTime="2026-10-09T14:07:37.116Z"
     timeShiftBufferDepth="PT30.0S" maxSegmentDuration="PT2.0S" minBufferTime="PT1.0S">
  <ServiceDescription id="0"/>
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video" segmentAlignment="true" bitstreamSwitching="true">
      <Representation id="0" codecs="avc1.42c02a" bandwidth="4000000" width="1920" height="1080">
        <ProducerReferenceTime type="captured" wallClockTime="..." presentationTime="0"/>
        <SegmentTemplate timescale="1000000" duration="2000000"
                         availabilityTimeOffset="1.900" availabilityTimeComplete="false"
                         initialization="init-stream$RepresentationID$.m4s"
                         media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="/api/utc"/>
</MPD>
```

Lo que significa cada campo:

| Campo | Significado |
| :--- | :--- |
| `type="dynamic"` | Es un directo: el contenido crece con el tiempo. |
| `availabilityStartTime` (AST) | Hora de reloj en la que empezó la emisión. Es el ancla de todo el cálculo. |
| `duration` / `timescale` | Duración de cada segmento: 2 000 000 / 1 000 000 = 2 s. |
| `$Number$` | El reproductor **no descarga una lista** de segmentos: calcula el número con `(ahora − AST) / duración`. |
| `availabilityTimeOffset="1.900"` | El segmento se puede pedir 1,9 s antes de estar completo, es decir, en cuanto existe su primer fragmento (2 s − 0,1 s). |
| `availabilityTimeComplete="false"` | Avisa de que lo que se sirve puede estar incompleto: es la señal de baja latencia. |
| `UTCTiming` | De dónde saca el reproductor la hora, para que su "ahora" coincida con el del servidor. |
| `ProducerReferenceTime` | Relación entre el tiempo del vídeo y la hora de captura; permite al reproductor calcular su latencia. |
| `timeShiftBufferDepth` | Cuánto pasado se conserva (30 s). |
| `ServiceDescription` | Aquí está vacío: el manifiesto no impone una latencia objetivo y decide el reproductor. |

Un detalle importante: como las URL se calculan con el reloj, **si el reloj del reproductor o el AST
están mal, el reproductor pide segmentos que aún no existen o va más atrasado de lo que cree**. Por
eso el origen del testbed recalibra el AST con la hora real en que se abre cada segmento y expone
el desfase como métrica (`dash_availability_drift_ms`).

### 3.4. El recorrido en este testbed

1. **Empaquetado.** `ffmpeg -f dash -streaming 1 -ldash 1` lee el MPEG-TS, copia el vídeo sin
   recodificar y produce fragmentos CMAF. Las opciones relevantes:
   - `-seg_duration` y `-frag_duration`: los dos mandos del panel.
   - `-use_template 1 -use_timeline 0`: URL calculadas por número, sin lista de segmentos. Es
     condición para que el manifiesto anuncie `availabilityTimeOffset`.
   - `-adaptation_sets "id=0,streams=v id=1,streams=a"`: todas las calidades de vídeo en un mismo
     AdaptationSet, para que el reproductor pueda conmutar entre ellas.
   - `-method PUT -http_persistent 1`: sube cada fichero por HTTP PUT *chunked* a medida que lo
     genera.
2. **Origen.** Un servidor en memoria dentro del orquestador (`origin.py`) recibe esos PUT y sirve
   los GET. Si un GET llega mientras el PUT sigue abierto, reenvía los bytes según entran.
3. **Entrega.** nginx reenvía sin búfer (`proxy_buffering off`), a través del router de emulación,
   hasta el navegador.
4. **Reproducción.** `dash.js` descarga con `fetch` leyendo el cuerpo a trozos, y va metiendo cada
   fragmento en el `SourceBuffer` de **MSE** (*Media Source Extensions*). A partir de ahí decodifica
   y pinta el elemento `<video>` del navegador.

En esta rama se hace una petición HTTP por segmento y por componente: una de vídeo y una de audio
cada 2 s. Los datos de cada petición llegan repartidos a lo largo de esos 2 s.

### 3.5. El reproductor: latencia objetivo y búfer

`dash.js` no reproduce lo último que tiene, sino que se coloca a una distancia fija del directo:

- **`liveDelay`** (el slider "Latencia objetivo", 3 s por defecto) es esa distancia. Todo lo que hay
  entre el punto de reproducción y el directo es búfer.
- **Catch-up** (`liveCatchup`). Si la latencia real se desvía del objetivo, `dash.js` la corrige
  **cambiando la velocidad de reproducción**: hasta un 50 % más rápido o más lento por defecto. Aquí
  está en modo `liveCatchupModeLoLp`, que además de la latencia tiene en cuenta el nivel de búfer.
- **`maxDrift`** (el slider "Salto al directo", 1,5 s por defecto aquí; 12 s es el valor por defecto
  de la librería). Si el desvío supera este umbral, deja de corregir con la velocidad y **salta**
  al directo con un *seek*. El salto aborta las descargas en curso y abre peticiones nuevas.
- **Parada.** Si el búfer baja de 0,3 s (`stallThreshold`), el vídeo se congela hasta rellenarse.

Con latencias objetivo muy bajas el búfer es casi nulo: cualquier retraso de un fragmento lo vacía.
Es la razón de que DASH necesite del orden de segundos para ser estable.

### 3.6. Adaptación de calidad (ABR)

Decide **solo el cliente**. `dash.js` mide a qué velocidad descarga y cómo está el búfer, y elige la
Representation. Las reglas activas por defecto en esta versión son:

| Regla | Qué mira |
| :--- | :--- |
| `throughputRule` | El caudal medido en las últimas descargas. |
| `bolaRule` | El nivel de búfer (algoritmo BOLA). |
| `insufficientBufferRule` | Baja de calidad si el búfer se está vaciando. |
| `switchHistoryRule` | Evita oscilar entre calidades. |
| `abandonRequestsRule` | Abandona una descarga en curso si va demasiado lenta. |

Las reglas específicas de baja latencia (`l2ARule`, `loLPRule`) existen pero están desactivadas por
defecto; el testbed no las activa.

El cambio de calidad ocurre **en una frontera de segmento**: el siguiente segmento se pide de otra
Representation. Con segmentos de 2 s, esa es la granularidad de reacción.

Un problema conocido de medir caudal en baja latencia: un segmento servido a goteo tarda 2 s en
descargarse **por definición**, vaya como vaya la red, así que "bytes / tiempo" da el bitrate del
vídeo y no la capacidad del enlace. `dash.js` lo compensa con heurísticas sobre los fragmentos
individuales, que son menos fiables que una medida directa.

### 3.7. De dónde sale su latencia

- **Empaquetado**: hasta un `frag_duration`, lo que tarda en cerrarse el fragmento que contiene el
  frame.
- **Red**: TCP. Una pérdida detiene todo lo que viene detrás hasta la retransmisión.
- **Búfer**: `liveDelay`. Con mucha diferencia, la partida mayor. En las medidas del testbed, de
  3,06 s totales unos 2,8 s eran búfer.

---

## 4. Media over QUIC

### 4.1. Qué es

MoQ es un protocolo de **publicación/suscripción** sobre QUIC pensado para media en directo. No
describe ficheros ni conexiones punto a punto: describe **pistas con nombre** a las que uno se
suscribe, y deja que servidores intermedios (**relays**) las repartan a muchos suscriptores sin
entender lo que llevan dentro.

La idea central es aprovechar lo que QUIC ofrece y TCP no: **cada trozo independiente de media va en
su propio stream QUIC**. Así, cuando la red no da para todo, se puede priorizar lo nuevo y **abandonar
lo viejo** sin que lo viejo bloquee a lo nuevo. En vez de acumular retraso (como TCP) o de romper la
imagen (como UDP puro), MoQ descarta unidades completas y decodificables.

### 4.2. Dos protocolos con el mismo nombre

Hay que distinguir dos cosas, porque la documentación las mezcla:

- **MoQ Transport (MoQT)**: el borrador del IETF (`draft-ietf-moq-transport`). Es el estándar en
  elaboración, grande y todavía cambiante. La librería instalada reconoce los borradores 14 a 22.
- **moq-lite**: un subconjunto simplificado, mantenido por el proyecto `moq.dev` (el mismo que hace
  el relay, el publicador y el reproductor que usa este testbed). Tiene menos mensajes y menos
  opciones, y está pensado para ser compatible hacia delante con MoQT.

La sesión negocia cuál de los dos se usa. **En este testbed se negocia `moq-lite-06`**, tanto entre
el publicador y el relay como entre el relay y el navegador (comprobado en el registro del relay).
Todo lo que sigue describe moq-lite salvo que se indique; el apartado 4.13 da la correspondencia con
los términos de MoQT.

Encima del transporte hay una segunda capa:

- **hang**: el formato de media del mismo proyecto. Define el **catálogo** (qué pistas hay y cómo
  decodificarlas) y el **contenedor** (cómo se mete cada frame en el transporte). El transporte no
  sabe nada de vídeo; hang es quien le da significado.

```
┌─────────────────────────────────────────────┐
│ hang: catálogo + contenedor (qué es la media)│
├─────────────────────────────────────────────┤
│ moq-lite: broadcasts, tracks, groups, frames │
├─────────────────────────────────────────────┤
│ WebTransport (sesión sobre HTTP/3)           │
├─────────────────────────────────────────────┤
│ QUIC (streams, control de congestión, TLS)   │
├─────────────────────────────────────────────┤
│ UDP                                          │
└─────────────────────────────────────────────┘
```

### 4.3. El modelo de datos

Cuatro niveles, de mayor a menor. Es el vocabulario imprescindible.

| Término | Qué es | Aquí |
| :--- | :--- | :--- |
| **Broadcast** | Una emisión: un conjunto de pistas con un nombre (una ruta). | `live.hang` |
| **Track** | Una pista: una secuencia de grupos de un mismo tipo. Cada calidad es una pista distinta. | `0.avc3` (vídeo), `1.aac` (audio), `catalog.json` |
| **Group** | Un tramo de la pista **decodificable por sí solo**. Tiene un número de secuencia creciente. | Un GOP: un keyframe y sus 59 frames delta |
| **Frame** | Un bloque de bytes con una marca de tiempo. Es la unidad mínima. | Un frame de vídeo codificado |

Las reglas que hacen útil esta estructura:

- **Un grupo empieza siempre en un punto de entrada.** En vídeo, un keyframe. Cualquier grupo se
  puede decodificar sin tener los anteriores.
- **Dentro de un grupo, los frames van en orden y de forma fiable.** Un frame depende de los
  anteriores del mismo grupo.
- **Entre grupos no hay dependencia.** Por eso un grupo se puede saltar entero sin romper nada.

De ahí sale la correspondencia con QUIC, que es el corazón del protocolo:

> **Un grupo = un stream QUIC unidireccional.**

Los frames de un grupo viajan uno detrás de otro por su stream. Grupos distintos van por streams
distintos y no se bloquean entre sí. Cancelar un stream es descartar un grupo.

Sobre el conjunto está el **origin**: la tabla de broadcasts que una conexión conoce y puede servir o
consumir. En el código aparece como `connection.origin`.

### 4.4. Los actores

- **Publisher** (publicador): quien produce las pistas. Aquí, `moq import ts` dentro del orquestador.
- **Subscriber** (suscriptor): quien las consume. Aquí, `@moq/watch` en el navegador.
- **Relay**: un servidor que es suscriptor hacia arriba y publicador hacia abajo. Aquí, `moq-relay`.

Los roles son **por pista, no por conexión**: una misma sesión puede publicar unas pistas y
suscribirse a otras. El relay no interpreta la media; solo mueve grupos y frames.

Dos propiedades del relay que importan:

- **Suscripción bajo demanda.** El relay no recibe la media del publicador hasta que alguien la pide.
  Cuando un navegador se suscribe a `0.avc3`, el relay se suscribe a su vez al publicador. En el
  registro del publicador se ve llegar esa suscripción con los mismos parámetros que pidió el
  navegador (prioridad y *max age*).
- **Reparto y caché.** Varios suscriptores de la misma pista comparten una única suscripción hacia
  arriba. El relay conserva los grupos recientes para servir a quien llega después.

### 4.5. La sesión: de la URL al primer frame

**1. Conexión.** El navegador abre una sesión **WebTransport** contra
`https://<host>:4433/anon`. WebTransport es la API del navegador para usar QUIC: por debajo es una
sesión HTTP/3 que da acceso a streams y datagramas QUIC. La ruta `/anon` es la que el relay permite
sin autenticación (`--auth-public anon/**`); en un despliegue real iría un token JWT.

**2. Certificado.** QUIC exige TLS. El relay genera un certificado autofirmado al arrancar
(`--listen-tls-generate`) y publica su huella SHA-256 por HTTP en `/certificate.sha256`. El
reproductor la descarga y la pasa a WebTransport como `serverCertificateHashes`: el navegador acepta
ese certificado concreto sin que lo firme ninguna autoridad. El navegador solo admite este mecanismo
con certificados de validez corta (dos semanas como máximo).

**3. Negociación.** Cliente y servidor acuerdan la versión del protocolo mediante el subprotocolo de
WebTransport (`moq-lite-06`). Cada extremo abre además un stream unidireccional con un único mensaje
**SETUP** que declara sus capacidades: entre ellas, el nivel de **PROBE** que soporta (ver 4.10).

**4. Descubrimiento (ANNOUNCE).** El suscriptor abre un stream de anuncios y envía un
**ANNOUNCE_REQUEST** con un prefijo de ruta. El relay responde con los broadcasts activos bajo ese
prefijo y sigue informando de altas y bajas mientras el stream viva. Así sabe el reproductor que
`live.hang` existe antes de pedir nada.

**5. Catálogo.** El reproductor se suscribe a la pista `catalog.json` del broadcast. Su contenido le
dice qué pistas de media hay.

**6. Suscripción a la media (SUBSCRIBE).** Elegida una calidad, abre un stream bidireccional con un
mensaje **SUBSCRIBE**: broadcast, nombre de la pista, **prioridad** y ***max age***. Lo que se ve en
el registro del publicador:

```
Subscribe { id: 16, broadcast: "live.hang", track: "catalog.json", priority: 100, max_age: 0ns  }
Subscribe { id: 17, broadcast: "live.hang", track: "0.avc3",       priority: 60,  max_age: 396ms }
```

**7. Datos.** Por cada grupo, el publicador abre un stream unidireccional nuevo. Empieza con una
cabecera (a qué suscripción pertenece y su número de secuencia) y sigue con los frames, cada uno
con su tamaño y su marca de tiempo.

Los mensajes de control viajan cada uno en su propio stream bidireccional, según su tipo:

| Stream de control | Para qué |
| :--- | :--- |
| Announce | Descubrir broadcasts bajo un prefijo y seguir sus altas y bajas. |
| Subscribe | Pedir una pista y actualizar sus parámetros (`SUBSCRIBE_UPDATE`) sin reabrirla. |
| Track | Consultar las propiedades fijas de una pista (`TRACK_INFO`): escala de tiempo, *max age* del publicador. |
| Fetch | Pedir un grupo concreto ya pasado. |
| Probe | Recibir las estimaciones de red del otro extremo. |
| Goaway | Avisar de que hay que reconectar a otro servidor. |

Cerrar el stream de una suscripción es darse de baja. No hay un mensaje aparte para eso.

### 4.6. El catálogo

Es una pista más (`catalog.json`), que se actualiza cuando cambia algo. El catálogo real que publica
ahora el testbed:

```json
{
  "video": { "renditions": {
    "0.avc3": { "codec": "avc3.42c02a", "codedWidth": 1920, "codedHeight": 1080,
                "bitrate": 7573296, "framerate": 60.0, "container": { "kind": "legacy" } } } },
  "audio": { "renditions": {
    "1.aac":  { "codec": "mp4a.40.2", "sampleRate": 48000, "numberOfChannels": 2,
                "bitrate": 165007, "description": "1190",
                "container": { "kind": "legacy" }, "jitter": 43 } } },
  "archive": { "track": "timeline.z", "timescale": 1000 },
  "clock":   { "wall": 213718046806804, "timescale": 1000000 },
  "mpegts":  { "tracks": { "0.avc3": { "pid": 256 }, "1.aac": { "pid": 257 } }, "...": "..." }
}
```

Una **rendition** es una versión de un mismo contenido: cada calidad de vídeo es una rendition, y su
clave en el mapa es el nombre de la pista a la que hay que suscribirse. Con varias calidades en la
escalera aparecen `0.avc3`, `1.avc3`, etc.

Los campos de cada rendition de vídeo (son los de `VideoDecoderConfig` de WebCodecs, más algunos
propios):

| Campo | Significado |
| :--- | :--- |
| `codec` | Cadena de códec. `avc3` indica que la configuración (SPS/PPS) va **dentro del flujo**, repetida antes de cada keyframe, y no en el catálogo. |
| `description` | Configuración del decodificador fuera de banda, cuando el códec la necesita (el AAC la lleva). |
| `codedWidth` / `codedHeight` | Resolución. |
| `bitrate` | Bitrate en bits por segundo. Es el dato que usa la adaptación de calidad. |
| `framerate` | Frames por segundo. |
| `container` | Cómo va empaquetado cada frame: `legacy`, `cmaf` o `loc` (ver 4.7). |
| `jitter` | Retraso máximo, medido en el publicador, entre que un frame está listo y se envía. El búfer del reproductor debe ser mayor. Si falta, se asume un intervalo de frame. |
| `delay` | Cuánto llega esta rendition por detrás de la más temprana del broadcast. |
| `stalled` | El publicador recomienda evitar temporalmente esta rendition. |

Las demás secciones (`archive`, `clock`, `mpegts`) son extras que añade el importador y que el
reproductor de vídeo no necesita.

> **Observación a tener en cuenta.** El catálogo declara 7,57 Mbit/s para una calidad configurada a
> 4000 kbit/s con tope de 4800. Ese valor lo calcula el propio importador, no sale de la
> configuración del testbed, y es el que usa la adaptación automática de calidad (4.10). No he
> comprobado cómo lo mide ni si se actualiza con el tiempo. Con una sola calidad no tiene efecto; con
> varias, condiciona cuándo el reproductor considera que una calidad "cabe".

### 4.7. El contenedor

Define qué bytes hay dentro de cada frame de MoQ. hang admite tres:

| Contenedor | Contenido de cada frame |
| :--- | :--- |
| `legacy` | Una marca de tiempo en microsegundos seguida del frame codificado tal cual. |
| `cmaf` | Un fragmento CMAF (`moof` + `mdat`); el segmento de inicialización va en el catálogo. |
| `loc` | *Low Overhead Container*, el formato del borrador del IETF. |

**Este testbed usa `legacy`**: es lo que produce `moq import ts`. Esto responde a una duda habitual:
**en la rama MoQ no hay CMAF, ni segmentos, ni fragmentos**. Los mandos "segmento" y "fragmento" del
panel solo afectan a DASH. Cada frame de vídeo es un frame de MoQ y se envía en cuanto sale del
codificador.

### 4.8. Cómo se convierte el vídeo en grupos

El publicador (`moq import ts`) lee el MPEG-TS y hace lo siguiente:

- Cada pista elemental del TS se convierte en una pista de MoQ (`0.avc3`, `1.aac`).
- Cada **keyframe abre un grupo nuevo**. Por tanto **grupo = GOP**.
- Cada frame se escribe en el grupo abierto y se envía de inmediato.

Con GOP de 60 a 60 fps hay un grupo por segundo y 60 frames por grupo. Esto aclara otra duda
frecuente: **el vídeo no llega "por grupos"**. El grupo es la unidad de *descarte* y de *entrada*,
no la de *envío*. Los frames llegan de uno en uno, cada 16,7 ms, por el stream del grupo en curso.
La latencia no tiene como suelo la duración de un GOP.

Lo que el tamaño del GOP **sí** determina en MoQ:

- **El tiempo de arranque y el salto inicial.** Quien se suscribe recibe el grupo en curso desde su
  keyframe: si llega a mitad, recibe de golpe los frames ya emitidos y luego el resto a ritmo real.
- **La granularidad del descarte.** Si la red se atasca, lo que se salta es un grupo entero: con GOP
  de 1 s, un salto supone hasta 1 s de imagen perdida.
- **El cambio de calidad**, que solo puede completarse a partir de un keyframe de la nueva pista.

Un GOP más corto hace todo eso más fino, a cambio de más bitrate (los keyframes son grandes).

### 4.9. Prioridad, *max age* y qué pasa cuando la red no da

Este es el mecanismo que distingue a MoQ. Tiene tres piezas.

**Prioridad entre pistas.** Cada suscripción lleva una prioridad de 0 a 255; se envía primero la
mayor. Los valores que usa hang:

| Pista | Prioridad |
| :--- | :--- |
| Catálogo | 100 |
| Texto / subtítulos | 90 |
| Audio | 80 |
| Vídeo | 60 |

Si el enlace no da para todo, el audio pasa antes que el vídeo: se prefiere seguir oyendo aunque la
imagen se resienta.

**Orden entre grupos de una misma pista: el más nuevo primero.** Cuando hay varios grupos pendientes
a la vez (porque la red va por detrás), el publicador da preferencia al más reciente. En moq-lite-06
esto es fijo: el campo que antes permitía pedir otro orden se ha retirado. Bajo congestión se
sacrifica el atraso, no el directo.

Ambos criterios se traducen en la **prioridad de envío del stream QUIC**: la prioridad de la pista
manda y, dentro de ella, la posición del grupo.

***Max age*: cuándo se da un grupo por perdido.** Es la edad máxima que puede tener un grupo que ya
no es el último antes de saltárselo. Lo fija el suscriptor en el SUBSCRIBE y puede cambiarlo con
SUBSCRIBE_UPDATE. Con 0, un grupo viejo se abandona en cuanto existe uno más nuevo. Cuando un grupo
supera su *max age*, su stream se cancela: QUIC deja de retransmitirlo y el ancho de banda queda para
el grupo siguiente.

El reproductor fija el *max age* igual a su búfer total (ver 4.11): no tiene sentido esperar a un
grupo más de lo que se está dispuesto a ir por detrás del directo.

**El resultado visible.** Con la red justa, MoQ no acumula retraso indefinidamente. Lo que hace es:

1. Los frames del grupo actual empiezan a llegar tarde. Mientras quepan en el búfer, no se nota.
2. Si se agota el búfer, la imagen se congela.
3. Llega el siguiente keyframe, se abre un grupo nuevo, que tiene preferencia. El anterior se
   abandona.
4. La imagen salta hacia delante y se recupera la latencia.

En las métricas eso aparece como paradas breves con la latencia volviendo a su valor, en vez de una
latencia que crece.

**Dentro de un grupo sigue habiendo bloqueo de cabeza de línea.** Un stream QUIC es fiable y
ordenado: si se pierde un paquete, los frames siguientes *de ese grupo* esperan a la retransmisión.
Lo que MoQ evita es que eso afecte a otros grupos y a otras pistas.

**Datagramas.** Desde moq-lite-05, un grupo de un solo frame puede enviarse como datagrama QUIC, sin
fiabilidad ninguna. Sirve para media donde cada unidad es independiente (audio, por ejemplo). El
vídeo de este testbed, con grupos de 60 frames, va por streams.

### 4.10. Estimación de ancho de banda y adaptación de calidad

**PROBE.** En DASH el cliente estima la red midiendo sus descargas. En MoQ quien conoce la red es el
**emisor**, porque es quien ejecuta el control de congestión. El mensaje **PROBE** hace llegar ese
conocimiento al receptor: el relay envía periódicamente su estimación de **bitrate de envío** y su
**RTT** suavizado. En la librería aparecen como `connection.probe`, con los campos
`estimatedRecvRate` y `rtt`. Es el valor que el panel muestra como "estimación de ancho de banda" de
MoQ.

El nivel de PROBE se declara en el SETUP: ninguno, **Report** (solo informar) o **Increase** (además
puede enviar relleno para sondear si hay más capacidad). Este último punto importa: un control de
congestión solo descubre capacidad que intenta usar. Si el vídeo ocupa 4 Mbit/s en un enlace de
100, la estimación no tiene por qué reflejar los 100.

**La selección de rendition en `@moq/watch`.** Es lo que el testbed deja actuar sin tocar. El
algoritmo, leído del código, es este:

1. Descarta las renditions que el navegador no puede decodificar.
2. Descarta las marcadas como `stalled` (si lo están todas, se queda con la de menor bitrate).
3. Toma la estimación del relay y le aplica un **margen del 80 %**.
4. Elige la rendition de **mayor bitrate que quepa** en ese presupuesto, según el `bitrate` del
   catálogo. Si no cabe ninguna, la de menor bitrate.
5. Sin estimación disponible, elige la de mayor resolución.

En esa lógica no hay histéresis ni temporizadores: la selección se recalcula cada vez que cambia la
estimación. La única amortiguación es el margen del 80 %.

El reproductor admite además un **objetivo** (`target`) que restringe la elección: por nombre de
pista, por píxeles, por ancho o alto máximos, o por bitrate máximo. El selector de calidad del panel
usa solo el nombre, y solo cuando se fija una calidad a mano. Una calidad fijada a mano se mantiene
aunque esté `stalled`.

**El cambio de pista.** No hay un mensaje de "cambiar de calidad": cada calidad es una pista
distinta, así que cambiar es **suscribirse a la nueva y darse de baja de la anterior**. El
reproductor lo hace sin corte:

1. Se suscribe a la nueva pista sin soltar la anterior. Durante un tiempo descarga las dos.
2. Sigue pintando la anterior hasta que la nueva ha alcanzado el mismo punto de reproducción (con
   100 ms de tolerancia).
3. Promueve la nueva y cierra la anterior.

Dos consecuencias medibles. La primera: durante el cambio se descargan dos calidades a la vez, justo
cuando la red va peor. La segunda: la calidad **seleccionada** y la calidad **pintada** pueden no
coincidir durante un rato, o indefinidamente si la nueva nunca llega a alcanzar a la anterior. Por
eso el testbed registra las dos por separado (`moq_selected_height` y `moq_height`).

### 4.11. El reproductor por dentro

La cadena de `@moq/watch`, con los nombres que tiene en el código:

```
Connection ─▶ Broadcast ─▶ Source ─▶ Decoder ─────────────────────────▶ Renderer
(WebTransport)  (anuncio,    (elige     (SUBSCRIBE, Consumer, WebCodecs,    (canvas, en cada
                 catálogo)    rendition)  espera a Sync)                     refresco de pantalla)
                                              ▲
                                            Sync (reloj común de vídeo, audio y subtítulos)
```

- **Consumer** (de hang): recibe los grupos de la suscripción, los ordena por secuencia y entrega los
  frames. Si un grupo envejece más allá del *max age*, lo salta.
- **Decoder**: pasa cada frame a un `VideoDecoder` de **WebCodecs**. No hay MSE ni elemento
  `<video>`: el reproductor recibe los frames decodificados uno a uno y decide cuándo pintarlos.
- **Sync**: decide ese "cuándo". Es el búfer.
- **Renderer**: dibuja el último frame en el canvas con `requestAnimationFrame`.

**Cómo funciona Sync.** No guarda una cantidad fija de datos: mantiene una **referencia de tiempo**.

- Para cada frame recibido calcula `hora de llegada − marca de tiempo del frame`. El **menor** valor
  visto es la *referencia*: representa el frame que menos tardó en llegar, la mejor estimación del
  directo.
- Cada frame se muestra cuando `ahora = referencia + marca de tiempo + delay`. Hasta entonces,
  espera decodificado.
- El **`delay`** es por tanto la distancia que se mantiene respecto al directo: el colchón contra
  las irregularidades de llegada.

El `delay` efectivo es la suma de dos partes:

| Parte | De dónde sale |
| :--- | :--- |
| *Jitter* configurado | La opción `delay` del reproductor (ver tabla siguiente). |
| *Jitter* de la rendition | El campo `jitter` del catálogo o, si falta, un intervalo de frame (17 ms a 60 fps). Se toma el mayor entre las pistas activas. |

Los tres modos de la opción `delay`:

| Valor | Comportamiento |
| :--- | :--- |
| `"auto"` (por defecto de la librería) | Se calcula del RTT que informa el relay: 1,25 × el RTT mínimo visto, con un suelo de 20 ms. Es el margen para una retransmisión. Sin RTT, 100 ms. |
| Una duración | Valor fijo. **Es lo que hace el slider del testbed** (200 ms al abrir); en su extremo izquierdo pasa a `auto`. |
| `"instant"` | Sin búfer ni espera: cada frame se pinta en cuanto se decodifica. Desactiva el audio. |

**La opción `buffer`.** Es distinta del `delay` y se confunde con facilidad. Regula cuánta media
"adelantada" se tolera antes de recolocar la referencia:

- Con `buffer = 0` (valor por defecto de la librería), en cuanto un frame llega antes de lo previsto
  la referencia baja y la reproducción **se pega al directo** todo lo que el `delay` permite.
- Con `buffer > 0`, se permite que se acumule hasta esa cantidad de media por delante sin saltar.

El *max age* que se envía en el SUBSCRIBE es `delay + buffer`.

**Lo que ocurre en este testbed.** El reproductor se crea con `delay` = slider (200 ms) y `buffer`
en su valor por defecto, 0. Con el slider en 200 ms, la librería resuelve:

```
delay efectivo = 200 ms (slider) + 46 ms (jitter de rendition, el del audio del catálogo) = 246 ms
max age        = 246 ms + 0 ms (buffer)                                                    = 246 ms
```

La latencia glass-to-glass medida así es de unos 300 ms (294 y 301 ms en dos conexiones, 9 de octubre
de 2026, Chrome headless contra el servidor, red sin restricción). La diferencia con los 246 ms es el
resto del recorrido: codificación, publicador, relay, red, decodificación y pintado.

**Por qué `buffer` está a 0.** Hasta esa fecha el testbed lo fijaba en 150 ms. En la misma prueba,
con ese valor, el *max age* era de 396 ms y la latencia medida de 387 ms: unos 90 ms más para el
mismo slider. La explicación, leída del código: al suscribirse, el reproductor recibe de golpe los
frames ya emitidos del grupo en curso; con `buffer > 0` ese adelanto se conserva (hasta el límite de
`buffer`) en vez de descartarse, y la reproducción queda más atrás de lo que el slider indica. Cuánto
exactamente depende del instante de la conexión, así que la latencia dejaba de estar determinada por
el slider. La medida con 150 ms es de una sola conexión.

Sigue habiendo un suelo que el slider no controla: el *jitter* de rendition (46 ms aquí) lo suma la
librería por su cuenta.

**Visibilidad.** Por defecto la librería deja de descargar el vídeo cuando el canvas sale de la
pantalla o la pestaña pasa a segundo plano (`visible: "20%"`). El testbed lo fija en `"always"` para
que la medida no se interrumpa al hacer scroll.

### 4.12. Opciones y configuración

**Reproductor (`Watch.Player` / elemento `<moq-watch>`)**

| Opción | Valor por defecto | Aquí | Efecto |
| :--- | :--- | :--- | :--- |
| `delay` | `auto` | Slider: `auto` o de 50 a 2000 ms (200 ms al abrir) | Distancia al directo. |
| `buffer` | `0ms` | `0ms` (por defecto) | Media adelantada tolerada antes de recolocar. |
| `target` | sin restricción | Solo al fijar calidad a mano | Restringe la rendition elegida. |
| `announced` | `true` | `true` | Espera a que el broadcast esté anunciado antes de suscribirse. |
| `visible` | `20%` | `always` | Cuándo descargar el vídeo según la posición del canvas. |
| `muted` | `false` | `true` | Silenciar; además deja de descargar el audio. |
| `paused` | `false` | — | Pausa. |
| `catalogFormat` | detectado por el sufijo del nombre | `.hang` → hang | Formato del catálogo: `hang`, `hangz` (comprimido), `msf` o `manual`. |

**Conexión (`Net.Connection`)**

| Opción | Efecto |
| :--- | :--- |
| `url` | Dirección del relay, incluida la ruta de autenticación (`/anon`). |
| `webtransport.serverCertificateHashes` | Huella del certificado autofirmado. |
| `websocket` | Alternativa por WebSocket (sobre TCP) cuando WebTransport no está disponible o tarda más de 500 ms. Por TCP se pierden las ventajas de QUIC. En el testbed solo se publica el puerto UDP, así que esta vía no llega al relay. |

**Relay (`moq-relay`)** — las opciones con efecto sobre lo que se mide:

| Opción | Por defecto | Efecto |
| :--- | :--- | :--- |
| `--quic-congestion-control` | `delay` (BBRv3) | `loss` usa un algoritmo basado en pérdidas. Es la variable a igualar o declarar frente al CUBIC de DASH. |
| `--listen-version` | todas | Restringe las versiones aceptadas; permite forzar `moq-transport-NN` en vez de moq-lite. |
| `--quic-max-streams` | 10 000 | Streams simultáneos por conexión. MoQ abre uno por grupo. |
| `--quic-mtu-discovery` | desactivado | Descubrimiento del tamaño máximo de paquete. |
| `--quic-gso` | activado | Agrupa envíos UDP. Es lo que obligó a poner un `tbf` delante de `netem` en el router. |
| `--quic-receive-window`, `--quic-send-window` | 64 MiB | Ventanas de control de flujo. |
| `--cache-duration`, `--cache-capacity` | sin límite | Cuánto conserva el relay para quien llega tarde. |
| `--auth-public`, `--auth-url` | — | Qué rutas admiten sesiones anónimas, y servidor de autenticación. |
| `--cluster-*` | — | Encadenar varios relays. |
| `--quic-qlog` | — | Volcar trazas qlog de QUIC, útiles para analizar pérdidas y ventana de congestión. |

**Publicador (`moq`)**

| Opción | Efecto |
| :--- | :--- |
| `--connect` | URL del relay. Admite WebTransport (`https`), QUIC directo (`moql`, `moqt`), WebSocket y otros. |
| `--connect-version` | Fuerza una versión del protocolo. |
| `--broadcast` | Nombre del broadcast. |
| `import ts` | Lee MPEG-TS por la entrada estándar. Otras fuentes y destinos con `import` y `export`. |
| `fetch <pista>` | Vuelca un grupo de una pista; útil para inspeccionar el catálogo. |

### 4.13. Correspondencia con MoQ Transport (IETF)

Para leer los borradores del IETF o comparar con otras implementaciones. Los nombres exactos cambian
entre borradores, así que conviene tomar esta tabla como orientación y contrastarla con el borrador
concreto que se cite.

| moq-lite | MoQ Transport | Notas |
| :--- | :--- | :--- |
| Broadcast (una ruta) | *Track namespace* | En MoQT una pista se identifica por espacio de nombres + nombre. |
| Track | Track | |
| Group | Group | |
| Frame | **Object** | En MoQT la unidad mínima se llama objeto. |
| (no existe) | **Subgroup** | MoQT permite dividir un grupo en subgrupos, cada uno en su stream. Sirve para capas (SVC): descartar las capas altas sin perder la base. |
| ANNOUNCE | PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE | En borradores antiguos, ANNOUNCE y SUBSCRIBE_ANNOUNCES. |
| SUBSCRIBE | SUBSCRIBE (y PUBLISH, iniciado por el publicador) | MoQT añade filtros sobre desde dónde empezar. |
| FETCH | FETCH | Para contenido pasado. |
| Prioridad + *max age* | *Subscriber priority*, *publisher priority*, *group order*, *delivery timeout* | MoQT tiene más mandos; moq-lite fija "el más nuevo primero". |
| PROBE | Sin equivalente directo en el transporte | |
| Un stream de control por petición | Un único stream de control | Diferencia estructural: en MoQT los mensajes de control comparten stream. |
| Catálogo hang | Catálogo MSF / WARP; contenedor LOC o CMSF | Formatos de media del IETF. La librería entiende `msf` y `loc`. |

### 4.14. De dónde sale su latencia

- **Ingesta**: del orden de milisegundos. El importador envía cada frame al salir del codificador.
- **Red**: QUIC. Una pérdida retrasa solo los frames siguientes de ese grupo.
- **Búfer**: `delay` + *jitter* de la rendition (más lo que retenga `buffer`, aquí 0). Es la mayor
  partida: unos 200 ms de ~300 ms en las medidas del testbed.

La parte que no es búfer suma unas decenas de milisegundos. La latencia de MoQ aquí es, casi entera,
una decisión de configuración del reproductor.

---

## 5. WebRTC

### 5.1. La idea

WebRTC nació para videollamadas: comunicación **interactiva**, donde llegar tarde es peor que llegar
con defectos. No trabaja con ficheros ni con streams fiables, sino con **paquetes sueltos sobre UDP**,
y prefiere mostrar una imagen degradada antes que esperar.

No es un protocolo, sino una pila de varios, todos obligatorios:

```
┌──────────────────────────────────────────────┐
│ Señalización (fuera de WebRTC): aquí, WHEP     │  acordar la sesión
├──────────────────────────────────────────────┤
│ RTP / RTCP                                     │  media y realimentación
├──────────────────────────────────────────────┤
│ SRTP                                           │  cifrado de la media
├──────────────────────────────────────────────┤
│ DTLS                                           │  intercambio de claves
├──────────────────────────────────────────────┤
│ ICE (STUN / TURN)                              │  encontrar un camino de red
├──────────────────────────────────────────────┤
│ UDP                                            │
└──────────────────────────────────────────────┘
```

### 5.2. Establecer la sesión

**Señalización con SDP.** Los dos extremos tienen que acordar códecs, direcciones y claves antes de
enviar nada. Lo hacen intercambiando dos textos en formato **SDP**: una **oferta** y una
**respuesta**. WebRTC no dice cómo transportarlos.

**WHEP** (*WebRTC-HTTP Egress Protocol*) es la forma estándar de hacerlo para reproducir: un único
`POST` HTTP con la oferta en el cuerpo, y la respuesta en la contestación. En el testbed va a
`/rtc/live/whep`, a través del nginx de entrada. **Solo la señalización pasa por HTTP**; la media va
después directa por UDP.

**ICE.** Es el procedimiento para encontrar un camino de red entre los dos extremos. Cada uno reúne
**candidatos** (direcciones IP y puertos por los que se le podría alcanzar), los intercambia en el
SDP, y prueba combinaciones hasta que una funciona. Normalmente hacen falta servidores **STUN** (para
descubrir la IP pública) y **TURN** (para retransmitir cuando no hay camino directo).

Aquí es más sencillo: el servidor tiene una dirección alcanzable y la anuncia directamente como
candidato (`MTX_WEBRTCADDITIONALHOSTS`, que toma el valor de `MOQ_HOST`). No hay STUN ni TURN. Todo
el tráfico va por un único puerto UDP, el 8189.

**DTLS y SRTP.** Sobre el camino elegido se hace un saludo **DTLS** (TLS adaptado a UDP) del que
salen las claves. La media se cifra con **SRTP**. La huella del certificado viaja en el SDP, así que
no hace falta ninguna autoridad certificadora.

### 5.3. Cómo viaja la media

**RTP.** Cada paquete lleva una cabecera con un **número de secuencia** (para detectar pérdidas y
reordenar), una **marca de tiempo** (para saber cuándo se muestra) y un identificador de flujo
(**SSRC**).

Un frame de vídeo no cabe en un paquete UDP (unos 1200 bytes útiles), así que se **trocea**. Un
keyframe de 1080p puede ocupar decenas de paquetes. El frame solo puede decodificarse cuando han
llegado todos.

**RTCP.** Es el canal de vuelta. El receptor informa al emisor de lo que le llega:

| Mensaje | Función |
| :--- | :--- |
| *Receiver report* | Estadísticas: pérdidas, jitter. |
| **NACK** | "Me falta el paquete N": pide una retransmisión concreta. |
| **PLI** / FIR | "He perdido la referencia": pide un keyframe nuevo. |
| **TWCC** / REMB | Tiempos de llegada de los paquetes, con los que el emisor estima el ancho de banda. |

### 5.4. Recuperación ante pérdidas

A diferencia de TCP y QUIC, aquí la retransmisión es **selectiva y con plazo**:

1. Falta un paquete. El receptor envía un NACK.
2. Si la retransmisión llega a tiempo de mostrar el frame, no se nota nada.
3. Si no llega a tiempo, el frame se descarta. Los siguientes dependen de él, así que la imagen se
   congela.
4. El receptor envía un PLI para pedir un keyframe. En una videollamada, el codificador genera uno
   de inmediato y la imagen vuelve.

En este testbed el paso 4 tiene una limitación: **MediaMTX no codifica, solo reenvía**. No puede
fabricar un keyframe a petición, así que el receptor tiene que esperar al siguiente keyframe del
flujo, que llega cada GOP (1 s). No he comprobado si MediaMTX traslada el PLI de alguna forma al
origen; por cómo está montada la ingesta (RTSP desde un FFmpeg que copia), no hay nadie que pueda
atenderlo.

### 5.5. El búfer de jitter

Los paquetes llegan con separaciones irregulares y a veces desordenados. El **búfer de jitter** los
retiene lo justo para reordenarlos, esperar retransmisiones y entregar los frames a ritmo constante.

Es **adaptativo y lo gestiona el navegador**: mide la variación de los tiempos de llegada y ajusta su
tamaño continuamente. Con buena red baja a decenas de milisegundos; si la red empeora, crece solo.
En las medidas del testbed estaba entre 55 y 95 ms.

La aplicación solo puede **sugerir** un mínimo con `jitterBufferTarget` (el slider "Búfer objetivo").
El navegador lo trata como una pista, no como una orden. En "auto" no se pide nada.

### 5.6. Control de congestión y adaptación

En una videollamada, el emisor estima el ancho de banda con la realimentación TWCC (algoritmo **GCC**,
*Google Congestion Control*) y **ordena al codificador que cambie de bitrate** sobre la marcha. La
adaptación ocurre en el codificador, no eligiendo entre versiones ya hechas. Para repartir a muchos
se usa **simulcast** (el emisor manda varias calidades y un servidor elige cuál reenviar a cada uno)
o **SVC** (un flujo en capas).

**Nada de eso se usa aquí.** El testbed envía una sola calidad, la más alta, sin recodificar. Si el
enlace no da para ella, no hay calidad inferior a la que bajar: se pierden paquetes y la imagen se
congela. Es una decisión deliberada de alcance, y hay que tenerla presente al comparar: **la rama
WebRTC no tiene adaptación de calidad**, las otras dos sí.

### 5.7. El recorrido en este testbed

1. **Ingesta.** `ffmpeg -c:v copy -an -f rtsp` publica el vídeo por RTSP (sobre TCP) en MediaMTX.
   Sin audio: el AAC de la fuente no es un códec admitido por WebRTC en navegadores.
2. **Servidor.** MediaMTX reparte el H.264 en paquetes RTP y los envía a cada navegador conectado.
3. **Navegador.** `RTCPeerConnection` recibe, reordena, decodifica y pinta en un `<video>`. Todo lo
   hace el navegador; la aplicación solo lee estadísticas con `getStats()`.

Que la fuente no use B-frames (`zerolatency`) importa aquí: WebRTC en navegadores no los admite bien.

### 5.8. De dónde sale su latencia

- **Ingesta**: milisegundos.
- **Red**: UDP directo, sin esperas por orden.
- **Búfer de jitter**: decenas de milisegundos, adaptativo.

En las medidas del testbed, entre 145 y 185 ms en total. Es la rama con menos latencia y también la
que menos margen tiene.

---

## 6. Comparación lado a lado

### 6.1. Diseño

| | LL-DASH | Media over QUIC | WebRTC |
| :--- | :--- | :--- | :--- |
| Modelo | Ficheros por HTTP; el cliente tira | Publicación/suscripción; el servidor empuja | Sesión punto a punto; el servidor empuja |
| Transporte | TCP | QUIC (sobre UDP) | RTP sobre UDP |
| Unidad de envío | Fragmento CMAF (100 a 200 ms) | Frame | Paquete RTP (trozo de frame) |
| Unidad de descarte | Ninguna: todo llega | Grupo (un GOP) | Paquete; en la práctica, hasta el siguiente keyframe |
| Fiabilidad | Total | Total dentro de un grupo; el grupo es cancelable | Retransmisión selectiva con plazo |
| Bloqueo de cabeza de línea | En todo el flujo | Solo dentro de un grupo | No hay |
| Cifrado | TLS (si hay HTTPS) | TLS 1.3, obligatorio en QUIC | DTLS + SRTP, obligatorio |
| Escala con | Cualquier CDN HTTP | Relays MoQ | Servidores SFU |
| Estado en el servidor | Ninguno | Por suscripción | Por conexión, con realimentación continua |

### 6.2. Reproducción

| | LL-DASH | Media over QUIC | WebRTC |
| :--- | :--- | :--- | :--- |
| API del navegador | MSE + `<video>` | WebTransport + WebCodecs + canvas | `RTCPeerConnection` + `<video>` |
| Quién gestiona el búfer | `dash.js` | `@moq/watch` (Sync) | El navegador |
| Tamaño del búfer aquí | ~2,8 s | ~200 ms | 55 a 95 ms |
| Cómo se fija | `liveDelay` | `delay` | Automático; sugerencia con `jitterBufferTarget` |
| Si la red se retrasa | Se vacía el búfer y se para; luego acelera o salta | Se para y salta al grupo siguiente | Se congela hasta el siguiente keyframe |
| Latencia medida aquí | ~3,1 s | ~300 ms | 145 a 185 ms |

### 6.3. Adaptación de calidad

| | LL-DASH | Media over QUIC | WebRTC (aquí) |
| :--- | :--- | :--- | :--- |
| Quién decide | El cliente | El cliente | No hay |
| Con qué información | Caudal de sus descargas y nivel de búfer | Estimación del control de congestión del relay (PROBE) | — |
| Algoritmo | Reglas de `dash.js` (caudal, BOLA, búfer) | Mayor bitrate que quepa en el 80 % de la estimación | — |
| Cómo se cambia | Pidiendo el siguiente segmento de otra Representation | Suscribiéndose a otra pista, con solape | — |
| Granularidad | Un segmento (2 s) | Un grupo (1 s) | — |

### 6.4. Variables de confusión a declarar

Diferencias entre las ramas que no son del protocolo en sí, y que conviene controlar o citar:

1. **Control de congestión**: CUBIC (DASH) frente a BBRv3 (MoQ). El relay admite `loss` para
   acercarlos.
2. **Adaptación**: WebRTC no tiene; DASH y MoQ sí.
3. **Audio**: WebRTC no lo lleva; los otros dos sí (aunque silenciado en el reproductor).
4. **Búfer**: cada rama tiene un valor por defecto de orden distinto. Comparar latencias es, en buena
   parte, comparar configuraciones de búfer.
5. **Implementación**: se mide `dash.js`, `@moq/watch` y el WebRTC del navegador, no los protocolos
   en abstracto. Otras implementaciones se comportarían distinto.
6. **Proxy**: detrás de Nginx Proxy Manager, la conexión TCP de DASH termina en el proxy y no en el
   servidor; MoQ y WebRTC van directos por UDP.

---

## 7. Qué controla cada mando del panel

| Mando | LL-DASH | Media over QUIC | WebRTC |
| :--- | :--- | :--- | :--- |
| **GOP** | Cada cuánto hay keyframe; los segmentos deben ser múltiplos | Duración de cada grupo: granularidad de descarte y de arranque | Cada cuánto puede recuperarse la imagen tras una pérdida |
| **Duración de segmento** | Tamaño de cada fichero y granularidad del cambio de calidad | Sin efecto | Sin efecto |
| **Duración de fragmento** | Cada cuánto sale media del empaquetador | Sin efecto | Sin efecto |
| **Escalera de calidades** | Representations entre las que elige `dash.js` | Pistas entre las que elige `@moq/watch` | Solo se usa la más alta |
| **Latencia objetivo** | `liveDelay` | `delay` de Sync | `jitterBufferTarget` (sugerencia) |
| **Salto al directo** | `liveCatchup.maxDrift` | — | — |
| **Calidad** | Fija la Representation y desactiva el ABR | Fija la pista (`target.name`) | — |
| **Red emulada** | Cola propia en el router | Cola propia en el router | Cola propia en el router |

---

## 8. Glosario

**ABR** (*Adaptive Bitrate*). Elegir la calidad según el estado de la red.

**ANNOUNCE**. En MoQ, mecanismo por el que se descubren los broadcasts disponibles.

**AST** (*availabilityStartTime*). En DASH, hora de reloj en la que empezó la emisión.

**BBR**. Control de congestión que estima ancho de banda y retardo, en vez de reaccionar a pérdidas.

**Broadcast**. En MoQ, una emisión: conjunto de pistas bajo un nombre.

**Catálogo**. En MoQ, pista que describe las demás pistas del broadcast.

**Chunk / fragmento CMAF**. Par `moof` + `mdat`: la porción mínima de un segmento que se puede
decodificar.

**CMAF**. Formato de MP4 fragmentado común a DASH y HLS.

**CUBIC**. Control de congestión por defecto de TCP en Linux, basado en pérdidas.

**DTLS**. TLS adaptado a UDP; en WebRTC sirve para acordar las claves.

**Frame**. Una imagen codificada. En MoQ, además, la unidad mínima del transporte.

**GCC**. Control de congestión de WebRTC.

**GOP**. Un keyframe y los frames que dependen de él.

**Group**. En MoQ, tramo de una pista decodificable por sí solo; viaja en su propio stream QUIC.

**hang**. Formato de media (catálogo y contenedor) del proyecto `moq.dev`.

**Head-of-line blocking**. Que un dato perdido detenga a los que vienen detrás aunque ya hayan
llegado.

**ICE**. Procedimiento de WebRTC para encontrar un camino de red entre dos extremos.

**Jitter**. Variación en los tiempos de llegada de los paquetes.

**Keyframe / IDR**. Frame completo, decodificable sin ningún otro.

**Live edge / directo**. El instante más reciente del contenido ya disponible.

**Max age**. En MoQ, edad máxima de un grupo antes de saltárselo.

**MoQT**. *MoQ Transport*, el borrador del IETF.

**moq-lite**. Subconjunto simplificado de MoQT; el protocolo que negocia este testbed.

**MPD**. El manifiesto de DASH.

**MSE**. API del navegador para dar media a un `<video>` desde JavaScript.

**NACK**. En WebRTC, petición de retransmisión de un paquete concreto.

**Object**. En MoQT, lo que moq-lite llama frame.

**Origin**. En MoQ, la tabla de broadcasts que una conexión puede servir o consumir.

**PLI**. En WebRTC, petición de un keyframe nuevo.

**PROBE**. En moq-lite, mensaje con el que el emisor comunica su estimación de bitrate y RTT.

**QUIC**. Protocolo de transporte sobre UDP con streams independientes, cifrado y control de
congestión.

**Relay**. Servidor MoQ que se suscribe hacia arriba y publica hacia abajo.

**Rendition**. Una versión de un contenido (una calidad). En DASH se llama Representation.

**RTP / RTCP**. Protocolo de transporte de media en tiempo real y su canal de realimentación.

**RTT**. Tiempo de ida y vuelta de un paquete.

**SDP**. Formato de texto con el que dos extremos WebRTC describen la sesión.

**Segmento**. En DASH, cada uno de los ficheros de media.

**SRTP**. RTP cifrado.

**Track**. En MoQ, una pista: secuencia de grupos de un mismo tipo.

**WebCodecs**. API del navegador para codificar y decodificar frame a frame.

**WebTransport**. API del navegador para usar streams y datagramas QUIC, sobre HTTP/3.

**WHEP**. Señalización estándar por HTTP para reproducir un flujo WebRTC.
