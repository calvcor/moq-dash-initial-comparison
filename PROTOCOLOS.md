# Cómo funcionan los tres mecanismos de entrega: LL-DASH, Media over QUIC y WebRTC

Este documento explica, de extremo a extremo, cómo viaja el vídeo en cada una de las tres ramas del testbed. La parte de Media over QUIC (MoQ) es la más detallada: usa su terminología propia y baja hasta lo que hacen exactamente las versiones instaladas aquí.

**De dónde sale la información.** Lo que se afirma sobre el comportamiento concreto de este testbed está leído del código fuente de las librerías instaladas, de la configuración del proyecto y de los registros del servidor desplegado (9 de octubre de 2026). Cuando algo es una deducción y no una comprobación directa, se dice.

> **Versiones desplegadas:** relay 0.17.3 y publicador 0.14.3 desde el 13 de octubre de 2026; relay 0.17.4 desde el 14 de octubre y 0.17.5 desde el 15. El publicador estuvo en 0.14.3 hasta el 15 de octubre, cuando pasó a 0.14.5: el 0.14.4 acumula retraso en su entrada sin parar, y el 0.14.5 se queda atrás en cuanto hay un espectador (medido el 15 de octubre; ver el commit de esa fecha). Desde el 19 de octubre: relay 0.17.7, publicador 0.14.7 (sin ese problema), `@moq/watch` 0.6.3, `@moq/net` 0.4.4 y `@moq/hang` 0.5.3. Desde el 23 de octubre, relay 0.17.8: solo retroportes de correcciones (TLS, límites al analizar certificados y rutas); en el servidor, con el bucle, la escalera 1080/720/540 y WebRTC de control, la latencia y los frames de MoQ no cambiaron de forma apreciable: p50 de 86 ms y 59 fps antes; 66 y 109 ms, 49,5 y 59,5 fps en dos pasadas después (WebRTC, que no pasa por el relay, 54 ms antes y 67-75 después). Una pasada antes y dos después, de 45 s: la variación entre pasadas es mayor que la diferencia. Desde el 21 de octubre, el servidor usa un publicador compilado desde la rama principal de moq (`git@bc64b9c`, `MOQ_CLI_FROM=git`; su `--version` dice 0.14.2), que no tiene el límite de ~2 MB/s de entrada de la 0.14.7: con la escalera 2000/1000/350 y un espectador, espera p95 en su entrada de 1 ms frente a 1,2-3,5 s y ningún cambio de calidad en 40 s frente a 34-54 (ver 4.14). Las medidas de MoQ anteriores y posteriores a ese día no son comparables. Desde el 22 de octubre, el dashboard del servidor usa también `@moq/watch` y sus `@moq/*` compilados desde ese mismo commit (`git@bc64b9c`, `MOQ_WATCH_FROM=git`), como ya se hacía en local: el reproductor de MoQ cambia, así que las medidas de MoQ del servidor anteriores y posteriores tampoco son comparables entre sí. Desde el 23 de octubre, ese `@moq/watch` lleva además el parche del experimento de cambio de calidad (README, 6.1; versión `git@bc64b9c+switching`): con su opción por defecto (`seamless`) se comporta como sin parche. Desde el 29 de octubre, relay 0.17.9 (retroportes; el que importa aquí: un publicador reiniciado se impone a su sesión anterior en el relay) y MediaMTX 1.21.3 (sin cambios en WebRTC más allá de dependencias). Lo que este documento describe se observó con las de la tabla (0.17.2 y 0.14.2) salvo que se indique otra cosa. Las versiones en uso se ven en la cabecera del dashboard y quedan en el CSV.

> **Audio:** desde el 22 de octubre de 2026 la fuente codifica el audio en **Opus** (antes, AAC-LC), para que las tres ramas lleven el mismo: en MoQ la pista pasa de `1.aac` a `1.opus` y en el MPD de `mp4a.40.2` a `opus`. Los ejemplos de MPD, catálogo y MPEG-TS de los anexos se capturaron con AAC y se dejan así; la estructura es la misma.

| Componente                                                | Versión comprobada    |
| :-------------------------------------------------------- | :-------------------- |
| Relay MoQ (`moqdev/moq-relay`)                            | 0.17.2                |
| Publicador MoQ (`moq`, moq-cli)                           | 0.14.2                |
| Reproductor MoQ (`@moq/watch` / `@moq/net` / `@moq/hang`) | 0.6.2 / 0.4.2 / 0.5.2 |
| Protocolo MoQ negociado (navegador y publicador)          | `moq-lite-06`         |
| Reproductor DASH (`dash.js`)                              | 5.2.1                 |
| Servidor WebRTC (MediaMTX)                                | 1.21.2                |
| Codificador                                               | FFmpeg 7.1 + libx264  |

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
9. [Anexo A. El manifiesto MPD, campo a campo](#anexo-a-el-manifiesto-mpd-campo-a-campo)
10. [Anexo B. El catálogo de MoQ, campo a campo](#anexo-b-el-catálogo-de-moq-campo-a-campo)
11. [Anexo C. MPEG-TS: el formato intermedio del testbed](#anexo-c-mpeg-ts-el-formato-intermedio-del-testbed)
12. [Anexo D. Cómo se mide la latencia](#anexo-d-cómo-se-mide-la-latencia)

---

## 1. Lo que comparten las tres ramas

Las tres ramas reciben **exactamente el mismo vídeo codificado**. Hay un único proceso FFmpeg (la "fuente maestra") que lee Big Buck Bunny a ritmo real, quema el timecode y la etiqueta de calidad, codifica con x264 y reparte el resultado por tres puertos UDP locales. A partir de ahí nadie vuelve a codificar: cada rama solo **reempaqueta** los mismos bytes H.264 en su propio formato.

```
                          ┌─ UDP 5001 ─ tsgate ─ ffmpeg (-f dash) ─ PUT ─▶ origen en memoria ─▶ nginx ─▶ router ─▶ navegador (dash.js)
Fichero ─▶ FFmpeg ────────┼─ UDP 5002 ─ tsgate ─ moq import ts ─ QUIC ───▶ moq-relay ─────────────────▶ router ─▶ navegador (@moq/watch)
(x264, 1 a 5 calidades)   └─ UDP 5003 ─ tsgate ─ UDP (MPEG-TS) ─────────▶ MediaMTX ──────────────────▶ router ─▶ navegador (RTCPeerConnection)
```

Hay una cuarta salida, UDP 5004, que no va a ninguna rama: la graba `recorder.py` durante las pruebas de QoE, para calcular después el VMAF con el vídeo tal como salió del codificador (README, sección 4.7).

En lugar del fichero, la fuente puede leer una **cámara RTSP** (README, sección 3.1b). Lo de después no cambia: misma escalera, mismo timecode y mismas salidas. Hay además una quinta, UDP 5005, con cada frame tal como entra en la escalera, casi sin pérdidas, que hace de original para el VMAF porque no hay fichero con el que comparar. Con la cámara la emisión va a los fps de la cámara, el contenido no se repite entre pruebas y la latencia medida empieza, como siempre, al quemar el timecode: no incluye el tramo de la cámara al servidor.

Consecuencias para la comparación:

- **La codificación no es una variable.** Mismo códec (H.264 *baseline*, `ultrafast`, `zerolatency`, sin B-frames), mismo GOP, mismo bitrate. Las diferencias de latencia entre ramas vienen del empaquetado, del transporte y del reproductor.
- **La ingesta no se degrada.** El tramo codificador → servidor de cada rama va por la red interna de Docker. El router que emula la red solo actúa entre los servidores finales y el navegador.
- **`tsgate.py`** es una compuerta que deja pasar el flujo MPEG-TS a cada empaquetador empezando justo en un keyframe, y de paso apunta a qué hora salió cada frame del codificador. No altera los datos.
- **La latencia se mide igual en las tres**, leyendo un timecode que la fuente quema en la imagen. El método, incluido el reparto por etapas, está en el [Anexo D](#anexo-d-cómo-se-mide-la-latencia).

El formato intermedio entre la fuente y los empaquetadores es **MPEG-TS**: un contenedor de paquetes fijos de 188 bytes pensado para emisión, que permite engancharse al flujo en cualquier momento. Solo existe dentro del servidor; ninguna rama lo envía al navegador. Su funcionamiento y el papel que cumple aquí se explican en el [Anexo C](#anexo-c-mpeg-ts-el-formato-intermedio-del-testbed).

---

## 2. Conceptos previos

Cuatro ideas que aparecen en las tres ramas y que conviene tener claras antes.

### 2.1. Frames, keyframes y GOP

Un vídeo comprimido no guarda cada imagen completa. Guarda de vez en cuando una imagen entera (un **keyframe**, o frame IDR) y, entre medias, solo las diferencias respecto a la anterior (frames **delta**, o P-frames). El conjunto de un keyframe y todos los delta que dependen de él es un **GOP** (*Group of Pictures*).

Dos consecuencias que condicionan todo lo demás:

- **Solo se puede empezar a decodificar en un keyframe.** Quien llega a mitad de un GOP tiene que esperar al siguiente keyframe o recibir el GOP desde su principio.
- **Si se pierde un frame, los siguientes del mismo GOP no sirven**, porque dependen de él. Lo perdido no se recupera hasta el siguiente keyframe (o hasta que se retransmita).

Aquí el GOP por defecto es de 60 frames a 60 fps: un keyframe por segundo.

### 2.2. Transporte fiable y no fiable

- **TCP** entrega todos los bytes y en orden. Si un paquete se pierde, todo lo que venía detrás espera a que se retransmita, aunque ya haya llegado. Eso es el **bloqueo de cabeza de línea** (*head-of-line blocking*).
- **UDP** entrega paquetes sueltos sin garantías: pueden perderse o llegar desordenados, y nadie espera a nadie.
- **QUIC** va sobre UDP y ofrece **muchos streams independientes** dentro de una misma conexión. Cada stream es fiable y ordenado por dentro, pero una pérdida en un stream no detiene a los demás. Además permite **cancelar** un stream (dejar de retransmitirlo) y **priorizar** unos sobre otros.

Esta es la diferencia de fondo entre las tres ramas: DASH usa un flujo fiable único (TCP), WebRTC paquetes sueltos (UDP con retransmisión selectiva) y MoQ muchos flujos fiables cancelables (QUIC).

### 2.3. Control de congestión

Es el algoritmo con el que el **emisor** decide a qué ritmo puede enviar sin saturar la red. Cada rama usa uno distinto, y eso afecta al resultado tanto como el protocolo:

| Rama | Quién lo ejecuta | Algoritmo |
| :--- | :--- | :--- |
| DASH | El núcleo Linux del servidor (TCP) | CUBIC, basado en pérdidas |
| MoQ | El relay (QUIC) | BBRv3 por defecto (`--quic-congestion-control delay`); alternativa `loss` |
| WebRTC | MediaMTX | No adapta el envío: reenvía el flujo tal cual llega |

Con un 1 % de pérdida, CUBIC reduce su ventana en cada pérdida y se queda por debajo del bitrate del vídeo; BBR estima el ancho de banda real y apenas se inmuta. Es una variable de confusión: parte de lo que se observa "en MoQ" frente a "en DASH" con pérdidas es BBR frente a CUBIC.

### 2.4. Búfer y directo

El **directo** (*live edge*) es el instante más reciente del contenido que ya existe. El reproductor siempre va algo por detrás, y esa distancia es media ya recibida y aún no mostrada: el **búfer**. Es el colchón contra las irregularidades de la red y, a la vez, la mayor parte de la latencia.

---

## 3. LL-DASH

### 3.1. La idea

DASH (*Dynamic Adaptive Streaming over HTTP*) trata el vídeo como una **colección de ficheros pequeños** servidos por un servidor web normal. El reproductor descarga un índice, calcula qué fichero toca en cada momento y lo pide por HTTP. Toda la inteligencia está en el cliente; el servidor solo sirve ficheros. Por eso escala tan bien con CDN: cualquier caché HTTP vale.

El precio es la latencia. En DASH clásico un fichero (un **segmento**) no se puede pedir hasta que está completo, y el reproductor necesita varios por delante. Con segmentos de 2 a 6 s salen latencias de 10 a 30 s. **LL-DASH** (*Low-Latency DASH*) es el conjunto de técnicas para reducir eso sin abandonar HTTP.

### 3.2. Las piezas

**El manifiesto (MPD).** Un XML que describe el contenido. Su jerarquía:

- **Period**: un tramo temporal del contenido. Aquí hay uno solo.
- **AdaptationSet**: un componente (el vídeo, el audio). Agrupa versiones intercambiables entre sí.
- **Representation**: una versión concreta (una **calidad**): resolución, bitrate y códec.
- **SegmentTemplate**: la plantilla con la que se construyen las URL de los segmentos.

**Los segmentos.** Dos tipos de fichero por cada Representation:

- **Segmento de inicialización** (`init-stream0.m4s`): cabeceras (`ftyp` + `moov`) con la configuración del decodificador. Se descarga una vez.
- **Segmentos de media** (`chunk-stream0-00042.m4s`): el vídeo en sí, numerados. Cada uno empieza por un keyframe.

**CMAF** (*Common Media Application Format*) es el formato de esos ficheros: MP4 fragmentado. Lo relevante para la baja latencia es que un segmento CMAF se compone de **chunks** (aquí llamados **fragmentos**): pares `moof` + `mdat`, cada uno con unos pocos frames y decodificable en cuanto llega, sin esperar al resto del segmento.

```
Segmento de 2 s  =  [moof][mdat] [moof][mdat] [moof][mdat] ... (20 fragmentos de 100 ms)
                     └─ fragmento ─┘
```

### 3.3. Qué añade la baja latencia

Tres mecanismos, que tienen que darse a la vez:

1. **Codificación en fragmentos.** El empaquetador cierra un fragmento cada `frag_duration` y lo emite de inmediato, en vez de esperar al segmento entero.
2. **Transferencia *chunked*.** El servidor sirve un segmento **mientras todavía se está escribiendo**: la respuesta HTTP no declara longitud y va soltando fragmentos conforme existen (`Transfer-Encoding: chunked`). El reproductor pide el segmento en curso y lo recibe a goteo.
3. **Anuncio de disponibilidad adelantada.** El manifiesto le dice al reproductor que puede pedir un segmento antes de que esté completo.

En el manifiesto eso se reduce a tres campos:

| Campo | Significado |
| :--- | :--- |
| `availabilityStartTime` | Hora de reloj en la que empezó la emisión. Con ella y la duración de segmento, el reproductor **calcula** qué segmento toca en cada momento, sin descargar ninguna lista. |
| `availabilityTimeOffset="1.900"` | El segmento se puede pedir 1,9 s antes de estar completo: en cuanto existe su primer fragmento (2 s − 0,1 s). |
| `availabilityTimeComplete="false"` | Avisa de que lo que se sirve puede estar incompleto. Es la señal de baja latencia. |

Como las direcciones se calculan con el reloj, **si el reloj del reproductor o la hora de inicio están mal, el reproductor pide segmentos que aún no existen o va más atrasado de lo que cree**. Por eso el manifiesto indica también de dónde sacar la hora (`UTCTiming`), y el origen del testbed recalibra la hora de inicio midiendo cuándo se abre realmente cada segmento.

El manifiesto completo, con todos sus campos explicados y ejemplos de cálculo, está en el [Anexo A](#anexo-a-el-manifiesto-mpd-campo-a-campo).

### 3.4. El recorrido en este testbed

1. **Empaquetado.** `ffmpeg -f dash -streaming 1 -ldash 1` lee el MPEG-TS, copia el vídeo sin recodificar y produce fragmentos CMAF. Las opciones relevantes:
   - `-seg_duration` y `-frag_duration`: los dos mandos del panel. Con la opción "1 frame" se usa `-frag_type every_frame` en vez de `-frag_duration`: un fragmento por frame.
   - `-use_template 1 -use_timeline 0`: URL calculadas por número, sin lista de segmentos. Es condición para que el manifiesto anuncie `availabilityTimeOffset`.
   - `-adaptation_sets "id=0,streams=v id=1,streams=a"`: todas las calidades de vídeo en un mismo AdaptationSet, para que el reproductor pueda conmutar entre ellas.
   - `-method PUT -http_persistent 1`: sube cada fichero por HTTP PUT *chunked* a medida que lo genera.
2. **Origen.** Un servidor en memoria dentro del orquestador (`origin.py`) recibe esos PUT y sirve los GET. Si un GET llega mientras el PUT sigue abierto, reenvía los bytes según entran.
3. **Entrega.** nginx reenvía sin búfer (`proxy_buffering off`). Hay dos caminos:
   - **Directo** (con `DASH_HOST` configurado): el navegador conecta por HTTPS y HTTP/1.1 al puerto 8443 del servidor, que el router reenvía al nginx de DASH. La conexión TCP del propio navegador atraviesa la red emulada, como en MoQ y WebRTC.
   - **A través del punto de entrada**: el navegador conecta al nginx de entrada (o a un proxy externo), que abre otra conexión, esa sí por el router. La red emulada actúa sobre esa segunda conexión, no sobre la del navegador.
4. **Reproducción.** `dash.js` descarga con `fetch` leyendo el cuerpo a trozos, y va metiendo cada fragmento en el `SourceBuffer` de **MSE** (*Media Source Extensions*). A partir de ahí decodifica y pinta el elemento `<video>` del navegador. El reproductor se explica en 3.8.

En esta rama se hace una petición HTTP por segmento y por componente: una de vídeo y una de audio cada 2 s. Los datos de cada petición llegan repartidos a lo largo de esos 2 s.

### 3.5. El reproductor: latencia objetivo y búfer

`dash.js` no reproduce lo último que tiene, sino que se coloca a una distancia fija del directo:

- **`liveDelay`** (el slider "Latencia objetivo", 0,3 s al abrir la página) es esa distancia. Todo lo que hay entre el punto de reproducción y el directo es búfer.
- **Catch-up** (`liveCatchup`). Si la latencia real se desvía del objetivo, `dash.js` la corrige **cambiando la velocidad de reproducción**: hasta un 50 % más rápido o más lento por defecto. Aquí está en modo LoL+ (`liveCatchupModeLoLP`): si el búfer baja de `playbackBufferMin` (el slider "Búfer mínimo": 0 al abrir la página, 0,5 s de fábrica), frena para rellenarlo, más cuanto menos búfer (con 0,5 s de mínimo, 0,77× con 0,3 s de búfer y 0,58× vacío) y no persigue el objetivo hasta superarlo; si no, corrige según la latencia (a 1× si está a menos de un 2 % del objetivo). Como la latencia nunca es menor que el búfer, el mínimo hace de suelo: con un objetivo por debajo de él, el búfer no llega a superarlo, frena casi siempre y la latencia queda por encima del objetivo (deducción del código, sin medir). Con el mínimo en 0 no frena nunca por búfer.

  > **Hasta el 27-10-2026 el modo LoL+ no estuvo activo nunca.** El testbed pedía `liveCatchupModeLoLp` (p minúscula), que dash.js 5.2.1 no reconoce, y aplicaba su modo por defecto: mira solo la latencia y, mientras el búfer está "vacío" (umbral de abajo), no corrige y reproduce a 1×. En ese modo el umbral de búfer vacío sí influía, y por eso el panel lo tuvo como slider hasta ese día; lo ha sustituido el búfer mínimo. Comprobado en el reproductor con `getSettings()` y leído de `CatchupController`. Todas las medidas de DASH anteriores se hicieron con el modo por defecto y **no son comparables** con las posteriores.
- **`maxDrift`** (el slider "Salto al directo", 1,5 s por defecto aquí; 12 s es el valor por defecto de la librería). Si el desvío supera este umbral, deja de corregir con la velocidad y **salta** al directo con un *seek*. El salto aborta las descargas en curso y abre peticiones nuevas.
- **Búfer "vacío".** Si el búfer baja de un umbral (0,3 s de fábrica; `lowLatencyStallThreshold` en baja latencia, `stallThreshold` fuera de ella), `dash.js` lo declara vacío. Eso **no detiene el vídeo** ni baja la calidad: sus métricas registran un rebuffering y, en el modo de corrección por defecto (no en LoL+, que usa `playbackBufferMin`), la corrección deja de acelerar. Con LoL+ y este MPD no cambia la reproducción: lo demás que reacciona a él (BOLA, la regla de búfer insuficiente, la parada sintética, CMCD) está inactivo aquí. Por eso se deja en su valor de fábrica. (Hasta el 27-10-2026 aquí se decía que la regla de búfer insuficiente fuerza la calidad más baja: no es así en baja latencia, ver 3.6.) El vídeo solo se congela de verdad cuando el navegador se queda sin datos. (`dash.js` puede detenerlo al cruzar el umbral, pero esa opción, `syntheticStallEvents`, viene desactivada.) Con la latencia objetivo en 0,3 s, el búfer oscila justo alrededor de este umbral. Fue configurable desde el panel hasta el 27-10-2026.

Con latencias objetivo muy bajas el búfer es casi nulo: cualquier retraso de un fragmento lo vacía. Es la razón de que DASH necesite del orden de segundos para ser estable.

### 3.6. Adaptación de calidad (ABR)

Decide **solo el cliente**. `dash.js` mide a qué velocidad descarga y cómo está el búfer, y elige la Representation. Las reglas activas por defecto en esta versión son:

| Regla | Qué mira |
| :--- | :--- |
| `throughputRule` | El caudal medido en las últimas descargas. |
| `bolaRule` | El nivel de búfer (algoritmo BOLA). |
| `insufficientBufferRule` | Baja de calidad si el búfer se está vaciando. **No actúa aquí**: se salta en modo de baja latencia. |
| `switchHistoryRule` | Evita oscilar entre calidades. |
| `abandonRequestsRule` | Abandona una descarga en curso si va demasiado lenta. |

En la práctica, con el MPD del testbed, **decide la regla de caudal** (leído del código de dash.js 5.2.1, corregido el 27-10-2026). El MPD declara `availabilityTimeComplete="false"`, así que dash.js va en modo de baja latencia, y en ese modo `insufficientBufferRule` no se ejecuta. BOLA solo releva a la de caudal con 12 s de búfer o más (`hybridSwitchBufferTime`; vuelve por debajo de 6 s), más que el máximo del slider de latencia. La de caudal elige la calidad más alta cuyo bitrate nominal no pase de 0,9 veces el caudal estimado, sin histéresis, antes de pedir cada segmento. Cada regla propone una calidad y gana la más baja. La pestaña "Cómo funciona" del reproductor lo resume según las opciones elegidas.

Las reglas específicas de baja latencia (`l2ARule`, `loLPRule`) existen pero están desactivadas por defecto. El selector **ABR** del panel permite elegir una de ellas: dash.js documenta que están probadas en solitario, así que el testbed activa solo la elegida y apaga las demás, como hace su ejemplo de baja latencia. Por defecto se dejan las de fábrica. Queda en el CSV como `dash_abr`.

| Opción | Reglas activas |
| :--- | :--- |
| Por defecto | Las de la tabla de arriba (`droppedFramesRule`, de fábrica, está apagada). |
| L2A | Solo `l2ARule` (*Learn2Adapt*, aprendizaje en línea sobre el caudal y el búfer). |
| LoL+ | Solo `loLPRule` (*Low-on-Latency+*, que pondera calidad, latencia, búfer y cambios). |

Cambiar de opción recrea el reproductor: dash.js sí aplica un cambio de reglas en caliente, pero su ejemplo de baja latencia pide recargar, porque las dos reglas guardan estado desde el arranque.

Medido el 23-10-2026 con las reglas de fábrica, 2 Mbit/s de bajada y objetivo de 0,3 s (README, sección 6): dash.js estimó 2,4-2,8 Mbit/s, se quedó en 720p@2000, que no cabe, con el búfer en torno a 0 s y 11 s congelados en un minuto. En local (DASH por el proxy, escalera 4000/2000/700, dos rondas alternas de 60 s, README, sección 6), LoL+ se quedó en 360p sin un cambio ni un congelado y con 0,31 s de latencia mediana; las de fábrica, casi igual (0-1 s congelados); L2A subió a 720p y se congeló 5 s en cada ronda. Una medida anterior en el servidor que no permitía ordenarlas se descartó: tenía otros reproductores en la misma cola.

**Cómo deciden L2A y LoL+** (leído del código de dash.js 5.2.1; README, sección 6):

- **L2A** mantiene una distribución de probabilidad sobre las calidades y la ajusta en cada segmento con un paso de descenso de Lagrange: penaliza las calidades cuyo `velocidad × bitrate` supera la última muestra de caudal (media de una sola descarga) y elige la más próxima a la media ponderada. Sube como mucho un escalón, y solo si su bitrate nominal cabe en ese caudal, sin margen. No mira la latencia ni el búfer. Con 5 Mbit/s y 1080p@4000 tiende a la máxima aunque sus picos no quepan.
- **LoL+** elige con un mapa autoorganizado (una neurona por calidad, con caudal, latencia, parón y cambio) cuyos pesos escoge en cada segmento maximizando un modelo de QoE (premio por bitrate, penalización por parón, latencia y velocidad distinta de 1×). Antes aplica una bajada de seguridad: si `búfer − bitrate × duración del segmento / caudal < 0,3 s` (`DWS_BUFFER_MIN`), baja, y en la mínima se queda. Con segmentos de 2 s y objetivo de 0,3 s se cumple siempre: LoL+ no sale de la mínima, haya o no límite de red. Con el objetivo a 6 s, en local y sin límite, subió a 1080p en cuanto el búfer superó unos 1,5-3 s (tres pasadas).

El cambio de calidad ocurre **en una frontera de segmento**: el siguiente segmento se pide de otra Representation. Con segmentos de 2 s, esa es la granularidad de reacción.

Un problema conocido de medir caudal en baja latencia: un segmento servido a goteo tarda 2 s en descargarse **por definición**, vaya como vaya la red, así que "bytes / tiempo" da el bitrate del vídeo y no la capacidad del enlace. `dash.js` lo compensa midiendo cada fragmento por separado (modo `moofParsing`, la idea de ACTE), pero acumula los fragmentos que llegan en 1 ms o menos hasta pasar de 1 ms, y ese intervalo incluye el hueco hasta el siguiente: con la red rápida (sin límite, en local o en la red local del servidor) la estimación vuelve a ser unas dos veces el bitrate descargado. Medido el 26-10-2026: 1,65 Mbit/s en 360p sin límite, 18,7-21 Mbit/s con la red limitada a 20 Mbit/s (README, sección 6).

### 3.7. De dónde sale su latencia

- **Empaquetado**: hasta un `frag_duration`, lo que tarda en cerrarse el fragmento que contiene el frame.
- **Red**: TCP. Una pérdida detiene todo lo que viene detrás hasta la retransmisión.
- **Búfer**: `liveDelay`. Con mucha diferencia, la partida mayor. En las medidas del testbed, de 3,06 s totales unos 2,8 s eran búfer.

### 3.8. El reproductor: `dash.js` por dentro

El reproductor de esta rama es **`dash.js`** (versión 5.2.1), la implementación de referencia del DASH Industry Forum. Es una librería de JavaScript: todo lo que hace ocurre en la página, no en el navegador.

**Qué pone el navegador y qué pone la librería.** Un navegador no sabe reproducir DASH. Sabe reproducir un MP4 que se le entregue, y ofrece una API para entregárselo a trozos desde JavaScript: **MSE** (*Media Source Extensions*). El reparto de papeles es este:

| Quién | Qué hace |
| :--- | :--- |
| `dash.js` | Descarga y entiende el manifiesto, calcula qué segmento toca, lo descarga, elige la calidad, decide a qué distancia del directo reproducir y corrige la velocidad. |
| MSE (`MediaSource`, `SourceBuffer`) | Recibe los trozos de MP4 que le pasa `dash.js` y los pone a disposición del `<video>`. |
| Elemento `<video>` | Decodifica, sincroniza vídeo y audio y pinta. Lo hace el navegador, fuera del alcance de JavaScript. |

```
manifest.mpd ─▶ dash.js ─▶ fetch (segmento a goteo) ─▶ SourceBuffer ─▶ <video> ─▶ pantalla
                  │                                     (MSE)          (decodifica y pinta)
                  └─ decide: qué pedir, qué calidad, a qué velocidad reproducir
```

Esto marca una diferencia importante con MoQ: **`dash.js` no ve los frames**. Entrega bytes al navegador y a partir de ahí solo puede actuar sobre el `<video>` con los mandos que este ofrece: la posición (`currentTime`) y la velocidad (`playbackRate`). No puede decidir cuándo se pinta un frame concreto ni saltarse uno. Por eso su forma de corregir la latencia es acelerar, frenar o saltar.

**El ciclo de reproducción:**

1. **Manifiesto.** Lo descarga y lo interpreta (Anexo A). Sincroniza su reloj con el servidor mediante `UTCTiming`.
2. **Inicialización.** Crea un `MediaSource`, lo conecta al `<video>` y abre un `SourceBuffer` para el vídeo y otro para el audio. Descarga el segmento de inicialización de cada uno.
3. **Planificación.** Calcula con el reloj qué segmento está en curso y lo pide.
4. **Descarga a goteo.** Usa `fetch` y lee el cuerpo de la respuesta según llega, sin esperar al final. Cada fragmento CMAF completo (`moof` + `mdat`) que reconoce lo pasa al `SourceBuffer`.
5. **Reproducción.** El `<video>` avanza. `dash.js` vigila la latencia y el nivel de búfer y ajusta la velocidad.
6. **Siguiente segmento.** Cuando la respuesta termina, pide el siguiente, de la misma calidad o de otra si el ABR lo decide.

**El modo de baja latencia** no tiene interruptor en esta versión: `dash.js` lo activa por su cuenta cuando el manifiesto anuncia `availabilityTimeComplete="false"`. Es lo que le hace leer la respuesta a goteo en el paso 4, en vez de esperar al segmento completo.

**Componentes internos**, para quien lea su código o sus registros:

| Componente | Función |
| :--- | :--- |
| `ManifestLoader`, `DashAdapter` | Descargar e interpretar el MPD. |
| `TimeSyncController` | Sincronizar el reloj con `UTCTiming`. |
| `ScheduleController` | Decidir cuándo pedir el siguiente segmento. |
| `FragmentLoader` | Descargar; con baja latencia usa `fetch` con lectura progresiva. |
| `BufferController` | Alimentar el `SourceBuffer` y vigilar su nivel. |
| `AbrController` y sus reglas | Elegir la calidad (3.6). |
| `PlaybackController` | Controlar el `<video>` y calcular la latencia. |
| `CatchupController` | Corregir la latencia con la velocidad o con un salto (3.5). |

**Configuración.** `dash.js` se configura con un árbol de ajustes (`updateSettings`). Los que toca el testbed:

| Ajuste | Por defecto en `dash.js` | Aquí | Efecto |
| :--- | :--- | :--- | :--- |
| `streaming.delay.liveDelay` | Sin fijar; lo deduce del manifiesto | Slider, 0,05 a 2 s (0,3 s al abrir; hasta el 27-10-2026, 6 s) | Distancia al directo. |
| `streaming.liveCatchup.enabled` | Automático | `true` | Activa la corrección de latencia. |
| `streaming.liveCatchup.mode` | `liveCatchupModeDefault` | `liveCatchupModeLoLP` (hasta el 27-10-2026, por una errata, el por defecto: ver 3.5) | Algoritmo de corrección. LoL+ mira la latencia y también el búfer. |
| `streaming.liveCatchup.playbackBufferMin` | 0,5 s | Slider "Búfer mínimo", 0 a 2 s (0 al abrir) | Búfer por debajo del cual LoL+ frena y no persigue el objetivo. Suelo de la latencia. |
| `streaming.liveCatchup.maxDrift` | 12 s | Slider, 0 a 10 s (1,5 s al abrir) | Desvío a partir del cual salta al directo en vez de corregir con la velocidad. |
| `streaming.retryAttempts` | Menos | 15 para manifiesto, inicialización y segmentos | Reintentos ante un fallo de descarga. |
| `streaming.retryIntervals` | — | 1000 ms | Espera entre reintentos. |
| `streaming.abr.autoSwitchBitrate.video` | `true` | `true`, o `false` al fijar una calidad | Activa o desactiva el ABR. |
| `streaming.abr.rules` | Ver 3.6 | Las de fábrica (al abrir), o solo `l2ARule` o solo `loLPRule` | Qué reglas de ABR están activas (selector **ABR**). |

Y los que se dejan en su valor de fábrica, pero afectan a lo que se mide:

| Ajuste | Valor | Efecto |
| :--- | :--- | :--- |
| `streaming.liveCatchup.playbackRate` | −0,5 a +0,5 | Cuánto puede frenar o acelerar: entre 0,5× y 1,5×. |
| `streaming.buffer.stallThreshold`, `lowLatencyStallThreshold` | 0,3 s | Por debajo de este búfer lo declara vacío y lo anota en sus métricas (en el modo de corrección por defecto, además, deja de acelerar). No baja la calidad ni detiene el vídeo. Con LoL+ no cambia la reproducción. |
| `streaming.utcSynchronization.enabled` | `true` | Sincronización de reloj con el servidor. |

Tres de las elecciones del testbed se apartan de `dash.js` de fábrica y conviene declararlas: el modo de corrección LoL+ (efectivo desde el 27-10-2026, ver 3.5), el `playbackBufferMin` de 0 al abrir la página (desde el mismo día; con él, LoL+ no frena por búfer y solo corrige la latencia) y el `maxDrift` de 1,5 s.

**Lo que el testbed añade alrededor**, sin tocar la librería:

- **Espera al manifiesto.** Antes de crear el reproductor comprueba que el manifiesto existe. El origen no lo publica hasta calibrar la hora de inicio, unos segundos después de cada arranque.
- **Silenciado.** El `<video>` está en silencio para que el navegador permita la reproducción automática. `dash.js` descarga el audio igualmente.
- **Vigilancia.** Si la imagen lleva 10 s sin cambiar, se destruye el reproductor y se crea otro. Se cuenta como reinicio en las métricas (`dash_player_restarts`).
- **Calidad fija.** El selector llama a `setRepresentationForTypeById` y desactiva el ABR.
- **Medida.** El timecode se lee del `<video>`, y los bytes descargados, de los eventos de la librería y de la API de tiempos de recursos del navegador.

El reproductor queda accesible en la consola del navegador como `window.dashPlayer`.

---

## 4. Media over QUIC

### 4.1. Qué es

MoQ es un protocolo de **publicación/suscripción** sobre QUIC pensado para media en directo. No describe ficheros ni conexiones punto a punto: describe **pistas con nombre** a las que uno se suscribe, y deja que servidores intermedios (**relays**) las repartan a muchos suscriptores sin entender lo que llevan dentro.

La idea central es aprovechar lo que QUIC ofrece y TCP no: **cada trozo independiente de media va en su propio stream QUIC**. Así, cuando la red no da para todo, se puede priorizar lo nuevo y **abandonar lo viejo** sin que lo viejo bloquee a lo nuevo. En vez de acumular retraso (como TCP) o de romper la imagen (como UDP puro), MoQ descarta unidades completas y decodificables.

### 4.2. Dos protocolos con el mismo nombre

Hay que distinguir dos cosas, porque la documentación las mezcla:

- **MoQ Transport (MoQT)**: el borrador del IETF (`draft-ietf-moq-transport`). Es el estándar en elaboración, grande y todavía cambiante. La librería instalada reconoce los borradores 14 a 22.
- **moq-lite**: un subconjunto simplificado, mantenido por el proyecto `moq.dev` (el mismo que hace el relay, el publicador y el reproductor que usa este testbed). Tiene menos mensajes y menos opciones, y está pensado para ser compatible hacia delante con MoQT.

La sesión negocia cuál de los dos se usa. **En este testbed se negocia `moq-lite-06`**, tanto entre el publicador y el relay como entre el relay y el navegador (comprobado en el registro del relay). Todo lo que sigue describe moq-lite salvo que se indique; el apartado 4.13 da la correspondencia con los términos de MoQT.

Encima del transporte hay una segunda capa:

- **hang**: el formato de media del mismo proyecto. Define el **catálogo** (qué pistas hay y cómo decodificarlas) y el **contenedor** (cómo se mete cada frame en el transporte). El transporte no sabe nada de vídeo; hang es quien le da significado.

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

- **Un grupo empieza siempre en un punto de entrada.** En vídeo, un keyframe. Cualquier grupo se puede decodificar sin tener los anteriores.
- **Dentro de un grupo, los frames van en orden y de forma fiable.** Un frame depende de los anteriores del mismo grupo.
- **Entre grupos no hay dependencia.** Por eso un grupo se puede saltar entero sin romper nada.

De ahí sale la correspondencia con QUIC, que es el corazón del protocolo:

> **Un grupo = un stream QUIC unidireccional.**

Los frames de un grupo viajan uno detrás de otro por su stream. Grupos distintos van por streams distintos y no se bloquean entre sí. Cancelar un stream es descartar un grupo.

Sobre el conjunto está el **origin**: la tabla de broadcasts que una conexión conoce y puede servir o consumir. En el código aparece como `connection.origin`.

### 4.4. Los actores

- **Publisher** (publicador): quien produce las pistas. Aquí, `moq import ts` dentro del orquestador.
- **Subscriber** (suscriptor): quien las consume. Aquí, `@moq/watch` en el navegador.
- **Relay**: un servidor que es suscriptor hacia arriba y publicador hacia abajo. Aquí, `moq-relay`.

Los roles son **por pista, no por conexión**: una misma sesión puede publicar unas pistas y suscribirse a otras. El relay no interpreta la media; solo mueve grupos y frames.

Dos propiedades del relay que importan:

- **Suscripción bajo demanda.** El relay no recibe la media del publicador hasta que alguien la pide. Cuando un navegador se suscribe a `0.avc3`, el relay se suscribe a su vez al publicador. En el registro del publicador se ve llegar esa suscripción con los mismos parámetros que pidió el navegador (prioridad y *max age*).
- **Reparto y caché.** Varios suscriptores de la misma pista comparten una única suscripción hacia arriba. El relay conserva los grupos recientes para servir a quien llega después.

### 4.5. La sesión: de la URL al primer frame

**1. Conexión.** El navegador abre una sesión **WebTransport** contra `https://<host>:4433/anon`. WebTransport es la API del navegador para usar QUIC: por debajo es una sesión HTTP/3 que da acceso a streams y datagramas QUIC. La ruta `/anon` es la que el relay permite sin autenticación (`--auth-public anon/**`); en un despliegue real iría un token JWT.

**2. Certificado.** QUIC exige TLS. El relay genera un certificado autofirmado al arrancar (`--listen-tls-generate`) y publica su huella SHA-256 por HTTP en `/certificate.sha256`. El reproductor la descarga y la pasa a WebTransport como `serverCertificateHashes`: el navegador acepta ese certificado concreto sin que lo firme ninguna autoridad. El navegador solo admite este mecanismo con certificados de validez corta (dos semanas como máximo).

**3. Negociación.** Cliente y servidor acuerdan la versión del protocolo mediante el subprotocolo de WebTransport (`moq-lite-06`). Cada extremo abre además un stream unidireccional con un único mensaje **SETUP** que declara sus capacidades: entre ellas, el nivel de **PROBE** que soporta (ver 4.10).

**4. Descubrimiento (ANNOUNCE).** El suscriptor abre un stream de anuncios y envía un **ANNOUNCE_REQUEST** con un prefijo de ruta. El relay responde con los broadcasts activos bajo ese prefijo y sigue informando de altas y bajas mientras el stream viva. Así sabe el reproductor que `live.hang` existe antes de pedir nada.

**5. Catálogo.** El reproductor se suscribe a la pista `catalog.json` del broadcast. Su contenido le dice qué pistas de media hay.

**6. Suscripción a la media (SUBSCRIBE).** Elegida una calidad, abre un stream bidireccional con un mensaje **SUBSCRIBE**: broadcast, nombre de la pista, **prioridad** y ***max age***. Lo que se ve en el registro del publicador:

```
Subscribe { id: 16, broadcast: "live.hang", track: "catalog.json", priority: 100, max_age: 0ns  }
Subscribe { id: 17, broadcast: "live.hang", track: "0.avc3",       priority: 60,  max_age: 396ms }
```

**7. Datos.** Por cada grupo, el publicador abre un stream unidireccional nuevo. Empieza con una cabecera (a qué suscripción pertenece y su número de secuencia) y sigue con los frames, cada uno con su tamaño y su marca de tiempo.

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

Es una pista más (`catalog.json`), a la que el reproductor se suscribe y que se actualiza cuando cambia algo. Su parte esencial, para una calidad:

```json
{
  "video": { "renditions": {
    "0.avc3": { "codec": "avc3.42c02a", "codedWidth": 1920, "codedHeight": 1080,
                "bitrate": 7573296, "framerate": 60.0, "container": { "kind": "legacy" } } } },
  "audio": { "renditions": {
    "1.aac":  { "codec": "mp4a.40.2", "sampleRate": 48000, "numberOfChannels": 2,
                "bitrate": 165007, "description": "1190",
                "container": { "kind": "legacy" }, "jitter": 43 } } }
}
```

Una **rendition** es una versión de un mismo contenido: cada calidad de vídeo es una rendition, y su clave en el mapa es el nombre de la pista a la que hay que suscribirse. Con varias calidades en la escalera aparecen `0.avc3`, `1.avc3`, etc.

Los campos que condicionan el comportamiento del reproductor son cuatro:

| Campo | Efecto |
| :--- | :--- |
| `bitrate` | Es el dato con el que la adaptación automática decide si una calidad cabe. |
| `stalled` | El publicador recomienda evitar temporalmente esa calidad. Con `@moq/watch` 0.6.x la adaptación automática la descartaba; desde `git@bc64b9c` el reproductor ya no lo mira (ver 4.10). |
| `jitter` | Irregularidad con la que el publicador envía los frames. El reproductor la suma a su búfer. |
| `delay` | Retraso de una calidad respecto a la más temprana. También se suma al búfer. |

El resto describe cómo configurar el decodificador (`codec`, `description`, resolución) y cómo va empaquetado cada frame (`container`, que se explica a continuación).

El catálogo completo, con todas sus secciones y campos explicados y con ejemplos, está en el [Anexo B](#anexo-b-el-catálogo-de-moq-campo-a-campo).

### 4.7. El contenedor

Define qué bytes hay dentro de cada frame de MoQ. hang admite tres:

| Contenedor | Contenido de cada frame |
| :--- | :--- |
| `legacy` | Una marca de tiempo en microsegundos seguida del frame codificado tal cual. |
| `cmaf` | Un fragmento CMAF (`moof` + `mdat`); el segmento de inicialización va en el catálogo. |
| `loc` | *Low Overhead Container*, el formato del borrador del IETF. |

**Este testbed usa `legacy`**: es lo que produce `moq import ts`. Esto responde a una duda habitual: **en la rama MoQ no hay CMAF, ni segmentos, ni fragmentos**. Los mandos "segmento" y "fragmento" del panel solo afectan a DASH. Cada frame de vídeo es un frame de MoQ y se envía en cuanto sale del codificador.

### 4.8. Cómo se convierte el vídeo en grupos

El publicador (`moq import ts`) lee el MPEG-TS y hace lo siguiente:

- Cada pista elemental del TS se convierte en una pista de MoQ (`0.avc3`, `1.aac`; con el audio Opus de la fuente desde el 22-10-2026, `1.opus`).
- `@moq/watch` solo se suscribe a la pista de audio con el sonido activado: con el reproductor silenciado, el audio no viaja (comprobado el 22-10-2026: `audio.out.stats` sin bytes hasta quitar el silencio).
- Cada **keyframe abre un grupo nuevo**. Por tanto **grupo = GOP**.
- Cada frame se escribe en el grupo abierto y se envía de inmediato.

Con GOP de 60 a 60 fps hay un grupo por segundo y 60 frames por grupo. Esto aclara otra duda frecuente: **el vídeo no llega "por grupos"**. El grupo es la unidad de *descarte* y de *entrada*, no la de *envío*. Los frames llegan de uno en uno, cada 16,7 ms, por el stream del grupo en curso. La latencia no tiene como suelo la duración de un GOP.

Lo que el tamaño del GOP **sí** determina en MoQ:

- **El tiempo de arranque y el salto inicial.** Quien se suscribe recibe el grupo en curso desde su keyframe: si llega a mitad, recibe de golpe los frames ya emitidos y luego el resto a ritmo real.
- **La granularidad del descarte.** Si la red se atasca, lo que se salta es un grupo entero: con GOP de 1 s, un salto supone hasta 1 s de imagen perdida.
- **El cambio de calidad**, que solo puede completarse a partir de un keyframe de la nueva pista.

Un GOP más corto hace todo eso más fino, a cambio de más bitrate (los keyframes son grandes).

### 4.9. Prioridad, *max age* y qué pasa cuando la red no da

Este es el mecanismo que distingue a MoQ. Tiene tres piezas.

**Prioridad entre pistas.** Cada suscripción lleva una prioridad de 0 a 255; se envía primero la mayor. Los valores que usa hang:

| Pista | Prioridad |
| :--- | :--- |
| Catálogo | 100 |
| Texto / subtítulos | 90 |
| Audio | 80 |
| Vídeo | 60 |

Si el enlace no da para todo, el audio pasa antes que el vídeo: se prefiere seguir oyendo aunque la imagen se resienta.

**Orden entre grupos de una misma pista: el más nuevo primero.** Cuando hay varios grupos pendientes a la vez (porque la red va por detrás), el publicador da preferencia al más reciente. En moq-lite-06 esto es fijo: el campo que antes permitía pedir otro orden se ha retirado. Bajo congestión se sacrifica el atraso, no el directo.

Ambos criterios se traducen en la **prioridad de envío del stream QUIC**: la prioridad de la pista manda y, dentro de ella, la posición del grupo.

***Max age*: cuándo se da un grupo por perdido.** Es la edad máxima que puede tener un grupo que ya no es el último antes de saltárselo. Lo fija el suscriptor en el SUBSCRIBE y puede cambiarlo con SUBSCRIBE_UPDATE. Con 0, un grupo viejo se abandona en cuanto existe uno más nuevo. Cuando un grupo supera su *max age*, su stream se cancela: QUIC deja de retransmitirlo y el ancho de banda queda para el grupo siguiente.

El reproductor fija el *max age* igual a su búfer total (ver 4.11): no tiene sentido esperar a un grupo más de lo que se está dispuesto a ir por detrás del directo.

**El resultado visible.** Con la red justa, MoQ no acumula retraso indefinidamente. Lo que hace es:

1. Los frames del grupo actual empiezan a llegar tarde. Mientras quepan en el búfer, no se nota.
2. Si se agota el búfer, la imagen se congela.
3. Llega el siguiente keyframe, se abre un grupo nuevo, que tiene preferencia. El anterior se abandona.
4. La imagen salta hacia delante y se recupera la latencia.

En las métricas eso aparece como paradas breves con la latencia volviendo a su valor, en vez de una latencia que crece.

**Dentro de un grupo sigue habiendo bloqueo de cabeza de línea.** Un stream QUIC es fiable y ordenado: si se pierde un paquete, los frames siguientes *de ese grupo* esperan a la retransmisión. Lo que MoQ evita es que eso afecte a otros grupos y a otras pistas.

**Datagramas.** Desde moq-lite-05, un grupo de un solo frame puede enviarse como datagrama QUIC, sin fiabilidad ninguna. Sirve para media donde cada unidad es independiente (audio, por ejemplo). El vídeo de este testbed, con grupos de 60 frames, va por streams.

### 4.10. Estimación de ancho de banda y adaptación de calidad

**PROBE.** En DASH el cliente estima la red midiendo sus descargas. En MoQ quien conoce la red es el **emisor**, porque es quien ejecuta el control de congestión. El mensaje **PROBE** hace llegar ese conocimiento al receptor: el relay envía periódicamente su estimación de **bitrate de envío** y su **RTT** suavizado. En la librería aparecen como `connection.probe`, con los campos `estimatedRecvRate` y `rtt`. Es el valor que el panel muestra como "estimación de ancho de banda" de MoQ.

El nivel de PROBE se declara en el SETUP: ninguno, **Report** (solo informar) o **Increase** (además puede enviar relleno para sondear si hay más capacidad). Este último punto importa: un control de congestión solo descubre capacidad que intenta usar. Si el vídeo ocupa 4 Mbit/s en un enlace de 100, la estimación no tiene por qué reflejar los 100.

**La selección de rendition en `@moq/watch`.** Es lo que el testbed deja actuar sin tocar. El algoritmo de la versión desplegada (`git@bc64b9c`, `js/watch/src/video/source.ts`, `#runSelected`; idéntico en la rama principal el 23-10-2026 salvo comentarios), leído del código, es este:

1. Descarta las renditions que el navegador no puede decodificar y las que el catálogo marca con `enabled: false` (sin frames).
2. Se queda con las de mayor `preference` (una transcodificación de compatibilidad lleva -1).
3. Toma la estimación del relay (`estimatedRecvRate`, del PROBE) y le aplica un **margen del 80 %**.
4. Elige la rendition de **mayor bitrate que quepa** en ese presupuesto, según el `bitrate` del catálogo. Si no cabe ninguna, la de menor bitrate.
5. Sin estimación disponible, elige la mejor por orden: mayor imagen y, a igualdad, mayor bitrate.

En esa lógica no hay histéresis, temporizadores, búfer ni historial: la selección se recalcula cada vez que cambia la estimación. La única amortiguación es el margen del 80 %. Es una regla de caudal pura, del tipo de la `throughputRule` de dash.js, con la estimación del emisor en vez de la del cliente.

**Corrección (23-10-2026).** Hasta esta fecha este apartado decía que también se descartaban las renditions marcadas `stalled`. Era cierto en `@moq/watch` 0.6.x, con el que se escribió, pero en `git@bc64b9c` el catálogo ya no tiene ese campo en su esquema y la selección no lo usa. Las medidas de 4.10 que atribuyen los cambios de calidad a las marcas `stalled` se hicieron con 0.6.2-0.6.3.

**El bitrate con el que compara.** Lo escribe el publicador. En `moq-cli` (`git@bc64b9c`), según los comentarios de `rs/moq-mux`, se mide en ventanas de 1 s y se retiene el pico: se toma con la primera ventana, sube cuando otra lo supera y no baja nunca. Medido en el testbed: 7,4-7,5 Mbit/s para 1080p@4000, 3,6 para 720p@2000, unas 1,85 veces el nominal. Con el margen del 80 %, mantener 1080p exige estimar más de 9,3 Mbit/s.

El reproductor admite además un **objetivo** (`target`) que restringe la elección: por nombre de pista, por píxeles, por ancho o alto máximos, o por bitrate máximo. El selector de calidad del panel usa solo el nombre, y solo cuando se fija una calidad a mano.

**El cambio de pista.** No hay un mensaje de "cambiar de calidad": cada calidad es una pista distinta, así que cambiar es **suscribirse a la nueva y darse de baja de la anterior**. El reproductor lo hace sin corte:

1. Se suscribe a la nueva pista sin soltar la anterior. Durante un tiempo descarga las dos.
2. Sigue pintando la anterior hasta que la nueva ha alcanzado el mismo punto de reproducción (con 100 ms de tolerancia).
3. Promueve la nueva y cierra la anterior.

Dos consecuencias medibles. La primera: durante el cambio se descargan dos calidades a la vez, justo cuando la red va peor. Si la anterior ya llena el enlace, la nueva no la alcanza nunca y el cambio no termina. Medido el 23-10-2026 en el servidor, con `@moq/watch` y `moq-cli` compilados desde `git@bc64b9c`, escalera 1080p@4000 / 720p@2000 / 540p@1200 y 2 Mbit/s de bajada: durante 60 s la selección fue 540p en 58 de 60 muestras y el frame pintado, 1080p en las 60, con el enlace al tope y 10 s congelados (README, sección 6). En el bundle desplegado, la pista nueva se promociona solo cuando su playhead alcanza el de la activa (leído del código); no hay un plazo que suelte la anterior. Las dos pistas se piden con la misma prioridad (`Catalog.PRIORITY.video`, 60) y ninguna opción de la librería lo cambia. El testbed tiene un experimento declarado que modifica esto (README, 6.1): soltar la anterior o dar prioridad a la nueva al bajar elimina el atasco con 2 Mbit/s. Otro experimento (README, 6.3) sustituye la estimación del relay por un sondeo con la calidad siguiente a prioridad mínima: mide bien la capacidad (85-98 % de la real), pero como algoritmo de adaptación no mejora al de la librería con la red fija. La segunda: la calidad **seleccionada** y la calidad **pintada** pueden no coincidir durante un rato, o indefinidamente si la nueva nunca llega a alcanzar a la anterior. Por eso el testbed registra las dos por separado (`moq_selected_height` y `moq_height`).

**Lo observado en el testbed con tres calidades.** El reproductor cambia de calidad varias veces por segundo sin que la red tenga nada que ver: la estimación del relay estuvo entre 0,35 y 3,7 Gbit/s. La causa es el paso 2. El publicador marca la calidad alta como `stalled` durante 10 a 60 ms, el reproductor salta a la siguiente, la marca se retira y vuelve.

El publicador activa la marca cuando pasan más de 50 ms sin que entregue un frame de esa calidad (ver B.9). Se han identificado dos causas, y solo una era del testbed:

1. **La fuente entregaba los frames a ráfagas. Corregido el 13 de octubre de 2026.** Los frames entraban al codificador cada 16,7 ms, pero salían con huecos de más de 50 ms alrededor de una vez por segundo. La causa era el audio, por dos mecanismos de FFmpeg que se sumaban (ver C.9). Con el arreglo, la salida es tan regular como sin audio.
2. **El publicador no lee su entrada a ritmo constante. Sin corregir: es comportamiento de `moq import`.** Aun sin ningún espectador, y con la fuente ya regular, hay frames que esperan en la compuerta a que el publicador los acepte: 50 ms en el percentil 95 y más de 200 ms en el peor caso, cuando en las otras dos ramas esa espera no pasa de 3 ms. Mientras no lee, el publicador tampoco entrega, y su propio detector lo cuenta como un atasco.

Efecto del arreglo, en una comparación alternada con y sin él (sesiones de 45 s, tres calidades, servidor de 8 núcleos, un espectador en automático):

| | Sin el arreglo (6 sesiones) | Con el arreglo (5 sesiones) |
| :--- | :--- | :--- |
| Veces que 1080p se marca `stalled` | 147 a 185 | 99 a 122 |
| Cambios de selección del reproductor | 285 a 338 | 175 a 221 |
| Latencia *glass-to-glass* de MoQ | 109 a 349 ms | 96 a 109 ms |
| Anomalías de ingesta | 0 | 0 |

El arreglo quita aproximadamente un tercio de las marcas. Las que quedan se deben a la segunda causa, y por tanto **los cambios de calidad de MoQ con varias calidades siguen sin medir adaptación a la red**. Es comportamiento real de esta versión del publicador ante su propia cadencia de lectura, y no se ha modificado.

**Por qué lee así (investigado el 21-10-2026, en local).** `moq-cli` 0.14.7 no procesa más de unos 2 MB/s de entrada (ver 4.14): cada byte le cuesta unos 0,3 µs de CPU, casi todo en el núcleo. Con tres calidades los keyframes llegan a la vez (unos 100 + 50 + 18 kB) y la escalera completa ronda 1 MB/s con picos, así que el publicador se queda atrás: en local, con un espectador de MoQ en automático, los frames esperaron en su entrada 572-705 ms en el percentil 95 (con una sola calidad, 0,1 ms salvo el keyframe). El 90 % de las marcas `stalled` llegó con un hueco de entrega al publicador en los 150 ms anteriores, frente a un 31-33 % de instantes al azar. Y la prueba causal, sin tocar el publicador: la misma escalera con la mitad de bitrate, alternada dos veces con la normal.

| Escalera, 40 s, un espectador | Marcas `stalled` | Cambios de calidad pintada | Espera p95 en la entrada |
| :--- | :--- | :--- | :--- |
| 4000/2000/700 kbit/s | 188 y 190 | 200 y 202 | 705 y 572 ms |
| 2000/1000/350 kbit/s | 66 y 68 | 64 y 60 | 6 y 6 ms |

Con la mitad de bytes desaparece la cola del publicador y caen dos tercios de las marcas y de los cambios de calidad. Las que quedan no van tan ligadas a los huecos de entrega (42-44 %, frente a un 6-7 % al azar): hay una parte que no se explica con esto. Además, la cola del publicador suma cientos de ms a la latencia de MoQ con la escalera completa: esa comparación entre calidades y protocolos hay que hacerla sabiendo que el publicador va saturado.

Fuera de esa comparación, en pruebas sueltas con el arreglo aplicado hubo dos sesiones en las que la rama MoQ se degradó mucho (latencia de varios segundos, pérdidas en su compuerta). En las once sesiones de la comparación no ocurrió con ninguna de las dos fuentes, así que no puedo atribuirlo al arreglo ni descartarlo: queda anotado como algo a vigilar.

### 4.11. El reproductor por dentro

El reproductor de esta rama es **`@moq/watch`** (versión 0.6.2), la librería de JavaScript del proyecto `moq.dev`. Se apoya en dos API del navegador:

| Quién | Qué hace |
| :--- | :--- |
| **WebTransport** | Da acceso a los streams QUIC de la conexión con el relay. |
| `@moq/watch` | Habla el protocolo MoQ, lee el catálogo, elige la calidad, ordena los frames, decide cuándo se muestra cada uno y lo dibuja. |
| **WebCodecs** (`VideoDecoder`) | Decodifica cada frame comprimido y devuelve la imagen. Usa el decodificador del sistema, normalmente por hardware. |
| Elemento **`<canvas>`** | La superficie donde la librería dibuja cada imagen. |

No interviene ningún elemento `<video>` ni MSE. Es la diferencia práctica con DASH: aquí **cada frame pasa por código de la página**. La librería recibe el frame comprimido, lo manda decodificar, recibe la imagen y decide en qué momento exacto dibujarla. Por eso puede hacer cosas que `dash.js` no: saltarse un grupo entero, mostrar un frame en cuanto llega, o cambiar de calidad sin corte solapando dos pistas.

El precio es que todo ese trabajo ocurre en el hilo principal de la página. Si la página está ocupada, el reproductor se retrasa, cosa que no le pasa a un `<video>`, que el navegador pinta por su cuenta. Fue lo que ocurrió con la primera versión del medidor de latencia (ver D.3).

El testbed usa la interfaz de programación (`Watch.Player`) sobre un `<canvas>` propio, no el componente web `<moq-watch>` que la librería también ofrece. Son lo mismo por dentro.

La cadena de `@moq/watch`, con los nombres que tiene en el código:

```
Connection ─▶ Broadcast ─▶ Source ─▶ Decoder ─────────────────────────▶ Renderer
(WebTransport)  (anuncio,    (elige     (SUBSCRIBE, Consumer, WebCodecs,    (canvas, en cada
                 catálogo)    rendition)  espera a Sync)                     refresco de pantalla)
                                              ▲
                                            Sync (reloj común de vídeo, audio y subtítulos)
```

- **Consumer** (de hang): recibe los grupos de la suscripción, los ordena por secuencia y entrega los frames. Si un grupo envejece más allá del *max age*, lo salta.
- **Decoder**: pasa cada frame a un `VideoDecoder` de **WebCodecs**. No hay MSE ni elemento `<video>`: el reproductor recibe los frames decodificados uno a uno y decide cuándo pintarlos.
- **Sync**: decide ese "cuándo". Es el búfer.
- **Renderer**: dibuja el último frame en el canvas con `requestAnimationFrame`.

**Cómo funciona Sync.** No guarda una cantidad fija de datos: mantiene una **referencia de tiempo**.

- Para cada frame recibido calcula `hora de llegada − marca de tiempo del frame`. El **menor** valor visto es la *referencia*: representa el frame que menos tardó en llegar, la mejor estimación del directo.
- Cada frame se muestra cuando `ahora = referencia + marca de tiempo + delay`. Hasta entonces, espera decodificado.
- El **`delay`** es por tanto la distancia que se mantiene respecto al directo: el colchón contra las irregularidades de llegada.

El `delay` efectivo es la suma de dos partes:

| Parte | De dónde sale |
| :--- | :--- |
| *Jitter* configurado | La opción `delay` del reproductor (ver tabla siguiente). |
| *Jitter* de la rendition | El campo `jitter` del catálogo o, si falta, un intervalo de frame (17 ms a 60 fps). Se toma el mayor entre las pistas activas. |

Los tres modos de la opción `delay`:

| Valor | Comportamiento |
| :--- | :--- |
| `"auto"` (por defecto de la librería) | Se calcula del RTT que informa el relay: 1,25 × el RTT mínimo visto, con un suelo de 20 ms. Es el margen para una retransmisión. Sin RTT, 100 ms. |
| Una duración | Valor fijo. **Es lo que hace el slider del testbed** al moverlo; al abrir la página está en `auto`, su extremo izquierdo. |
| `"instant"` | Sin búfer ni espera: cada frame se pinta en cuanto se decodifica. Desactiva el audio. |

**En `auto`, el búfer no sube durante la sesión** (comprobado en el código de `@moq/watch` 0.6.3 y medido el 21-10-2026). El RTT mínimo se guarda como mínimo acumulado (`Math.min`), así que solo puede bajar; y la referencia de sincronización solo se mueve hacia atrás, cuando un frame llega antes de lo previsto. Si la red se vuelve más lenta con la página abierta, los frames llegan "tarde" respecto a la referencia y se pintan en cuanto se decodifican: la latencia sube lo que añade la red, pero ya sin búfer frente al jitter. Al recargar, la conexión nueva mide el RTT con el retardo puesto y el búfer sale mucho mayor. Medido en local, sin jitter:

| | `delay` de la librería | RTT del relay | Latencia real |
| :--- | :--- | :--- | :--- |
| Sin retardo de red | 88 ms | 1 ms | 119 ms |
| Misma sesión tras aplicar 150 ms por sentido | 88 ms | 301 ms | 268 ms |
| Sesión nueva con 150 ms por sentido | 444 ms | 301 ms | 625 ms |

Con la misma red, MoQ mide 268 o 625 ms según se haya cambiado el perfil en caliente o se haya recargado, y en el primer caso no le queda margen para el jitter. En `auto` el búfer crece con el RTT, no con el jitter medido: con 150 ms por sentido y sin jitter reserva 444 ms.

Ese margen de 1,25 × RTT es el que deja llegar a tiempo un paquete retransmitido. Con 150 ms por sentido y un 1 % de pérdida (sin jitter), durante 30 s: la sesión que conservaba el búfer calculado sin retardo (88 ms) pintó 23 fps de mediana, con 29 de los 30 segundos por debajo de 50 fps y 57 congelados nuevos; la sesión recargada (444 ms) pintó 60 fps con 2 congelados, a 633 ms de latencia frente a 277. La latencia alta tras recargar es el precio de aguantar pérdidas; la baja sin recargar solo se sostiene en una red sin pérdidas ni jitter.

**En la rama principal de moq el modo `auto` ya se adapta durante la sesión** (medido el 22-10-2026, `@moq/watch` y sus dependencias compilados desde el commit `bc64b9c`, aún sin publicar). Sustituye el cálculo con el RTT por un estimador copiado de NetEq (el búfer de audio de WebRTC): mide lo tarde que llega cada frame y toma el percentil 95 de un histograma de cubos de 20 ms, que sube enseguida y baja con una vida media de 20 s, con techo de unos 2 s (`doc/concept/audio-jitter.md` de moq). Un frame retransmitido cuenta como tardío, así que las pérdidas también lo suben. En local, misma sesión sin recargar, alternando con la 0.6.3 dos veces:

| | 0.6.3: objetivo / latencia / pintados | `main`: objetivo / latencia / pintados |
| :--- | :--- | :--- |
| Sin restricciones | 88 ms / 116-123 ms / 60 fps | 20 ms / 49-59 ms / 54-60 fps |
| 150 ms por sentido | 88 ms / 189-265 ms / 60 fps | 160 ms / 342-348 ms / 58-60 fps |
| 150 ms y 1 % de pérdida | 88 ms / 264-271 ms / 24-28 fps | 340 ms / 514-524 ms / 47-60 fps |

Con la pérdida, la primera pasada tardó en subir (15 de 20 s por debajo de 50 fps) y la segunda no (1 de 20).

**Mide jitter, no latencia.** El retraso de cada frame se cuenta respecto al más rápido de los últimos 2 s de media, así que un retardo constante, aunque sea grande, no necesita búfer. Ante un salto de 0 a 1.000 ms en la bajada (medido el 22-10-2026, misma sesión): durante unos 2 s la referencia es anterior al salto y los frames parecen llegar 1 s tarde, así que el objetivo sube a 1.020 ms (2 congelados, 3,5 s parado, en la transición); se mantiene unos 20 s con la latencia en ~2,04 s (1 s de red y 1 s de búfer), y a los ~27 s del salto cae de golpe a 80 ms y la latencia a ~1,1 s, sin bajar de 60 fps pintados (es decir, saltando ese tramo); después oscila entre 20 y 40 ms con la latencia en ~1,05 s. La caída es de golpe, no gradual: el percentil 95 no se mueve hasta que el peso de las observaciones altas baja del 5 %. El usuario observó un pico de 2.000 ms con el mismo salto; en esta medida fue de 1.020.

**La opción `buffer`.** Es distinta del `delay` y se confunde con facilidad. Regula cuánta media "adelantada" se tolera antes de recolocar la referencia:

- Con `buffer = 0` (valor por defecto de la librería), en cuanto un frame llega antes de lo previsto la referencia baja y la reproducción **se pega al directo** todo lo que el `delay` permite.
- Con `buffer > 0`, se permite que se acumule hasta esa cantidad de media por delante sin saltar.

El *max age* que se envía en el SUBSCRIBE es `delay + buffer`.

**Lo que ocurre en este testbed.** El reproductor se crea con `delay` = slider y `buffer` en su valor por defecto, 0. El slider arranca en `auto`; puesto en 200 ms, la librería resuelve:

```
delay efectivo = 200 ms (slider) + 46 ms (jitter de rendition, el del audio del catálogo) = 246 ms
max age        = 246 ms + 0 ms (buffer)                                                    = 246 ms
```

La latencia glass-to-glass medida así es de unos 300 ms (294 y 301 ms en dos conexiones, 9 de octubre de 2026, Chrome headless contra el servidor, red sin restricción). La diferencia con los 246 ms es el resto del recorrido: codificación, publicador, relay, red, decodificación y pintado.

**Por qué `buffer` está a 0.** Hasta esa fecha el testbed lo fijaba en 150 ms. En la misma prueba, con ese valor, el *max age* era de 396 ms y la latencia medida de 387 ms: unos 90 ms más para el mismo slider. La explicación, leída del código: al suscribirse, el reproductor recibe de golpe los frames ya emitidos del grupo en curso; con `buffer > 0` ese adelanto se conserva (hasta el límite de `buffer`) en vez de descartarse, y la reproducción queda más atrás de lo que el slider indica. Cuánto exactamente depende del instante de la conexión, así que la latencia dejaba de estar determinada por el slider. La medida con 150 ms es de una sola conexión.

Sigue habiendo un suelo que el slider no controla: el *jitter* de rendition (46 ms aquí) lo suma la librería por su cuenta.

**Visibilidad.** Por defecto la librería deja de descargar el vídeo cuando el canvas sale de la pantalla o la pestaña pasa a segundo plano (`visible: "20%"`). El testbed lo fija en `"always"` para que la medida no se interrumpa al hacer scroll.

**Lo que el testbed añade alrededor**, sin tocar la librería:

- **Huella del certificado.** Antes de conectar descarga `/certificate.sha256` y se la pasa a WebTransport (ver 4.5).
- **Silenciado.** Con el reproductor en silencio, `@moq/watch` no descarga la pista de audio. Es una diferencia con DASH, que la descarga siempre.
- **Vigilancia.** 10 s sin imagen nueva y se recrea el reproductor (`moq_player_restarts`).
- **Calidad fija.** El selector pasa el nombre de la pista en `target`; en automático no pasa nada.
- **Medida.** El timecode se lee del frame que la librería acaba de dibujar, y los tiempos, de las señales que expone.

El reproductor queda accesible en la consola del navegador como `window.moqPlayer`.

### 4.12. Opciones y configuración

**Reproductor (`Watch.Player` / elemento `<moq-watch>`)**

| Opción | Valor por defecto | Aquí | Efecto |
| :--- | :--- | :--- | :--- |
| `delay` | `auto` | Slider: `auto` (al abrir) o de 50 a 2000 ms | Distancia al directo. |
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

Para leer los borradores del IETF o comparar con otras implementaciones. Los nombres exactos cambian entre borradores, así que conviene tomar esta tabla como orientación y contrastarla con el borrador concreto que se cite.

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

- **Ingesta**: del orden de milisegundos para un frame normal, pero **no para los keyframes** (corregido el 21-10-2026; antes se decía sin matiz). `moq-cli` 0.14.7 procesa su entrada a unos 2 MB/s como máximo, con unos 0,3 µs de CPU por byte, casi todos en el núcleo (sincronización entre hilos: 467.000 `futex` para 11 MB). Un keyframe de ~100 kB (12 veces un frame normal a 1080p y 4 Mbit/s) tarda así unos 50 ms en entrar, y el frame siguiente espera detrás. En local, con un espectador: el keyframe espera 25 ms en la compuerta, el siguiente 14, y la entrega tiene un hueco de ~45 ms una vez por grupo; con más carga en la máquina, 60-170 ms, y en el servidor hasta 665 ms. Ocurre igual sin espectadores, con control de congestión `loss` o BBRv3, con 1 o 2 hilos de tokio y con H.264 crudo (`import avc3`) en vez de MPEG-TS, así que no es la red ni el demultiplexor TS. El vídeo llega al relay con un tirón por grupo, que solo se ve si el búfer del reproductor es menor. **Está resuelto en la rama principal de moq, sin versión publicada todavía** (medido el 21-10-2026, commit `bc64b9c`, compilado en local con LTO *thin* y solo el transporte QUIC): lee la entrada a 200-730 MB/s sin ritmo real, frente a 1,9-2,0 MB/s de la 0.14.7 tanto publicada como compilada con esos mismos ajustes, así que la diferencia es del código y no de la compilación. En directo, con un espectador: el keyframe espera 0,2-0,3 ms en la compuerta (0.14.7: 32-55 ms de mediana); con la escalera de tres calidades, ningún cambio de calidad ni hueco de entrega en 40 s (0.14.7: 92-140 cambios y espera p95 de 117-146 ms).
- **Red**: QUIC. Una pérdida retrasa solo los frames siguientes de ese grupo.
- **Búfer**: `delay` + *jitter* de la rendition (más lo que retenga `buffer`, aquí 0). Es la mayor partida: unos 200 ms de ~300 ms en las medidas del testbed.

La parte que no es búfer suma unas decenas de milisegundos. La latencia de MoQ aquí es, casi entera, una decisión de configuración del reproductor.

---

## 5. WebRTC

### 5.1. La idea

WebRTC nació para videollamadas: comunicación **interactiva**, donde llegar tarde es peor que llegar con defectos. No trabaja con ficheros ni con streams fiables, sino con **paquetes sueltos sobre UDP**, y prefiere mostrar una imagen degradada antes que esperar.

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

**Señalización con SDP.** Los dos extremos tienen que acordar códecs, direcciones y claves antes de enviar nada. Lo hacen intercambiando dos textos en formato **SDP**: una **oferta** y una **respuesta**. WebRTC no dice cómo transportarlos.

**WHEP** (*WebRTC-HTTP Egress Protocol*) es la forma estándar de hacerlo para reproducir: un único `POST` HTTP con la oferta en el cuerpo, y la respuesta en la contestación. En el testbed va a `/rtc/live/whep`, a través del nginx de entrada. **Solo la señalización pasa por HTTP**; la media va después directa por UDP.

**ICE.** Es el procedimiento para encontrar un camino de red entre los dos extremos. Cada uno reúne **candidatos** (direcciones IP y puertos por los que se le podría alcanzar), los intercambia en el SDP, y prueba combinaciones hasta que una funciona. Normalmente hacen falta servidores **STUN** (para descubrir la IP pública) y **TURN** (para retransmitir cuando no hay camino directo).

Aquí es más sencillo: el servidor tiene una dirección alcanzable y la anuncia directamente como candidato (`MTX_WEBRTCADDITIONALHOSTS`, que toma el valor de `MOQ_HOST`). No hay STUN ni TURN. Todo el tráfico va por un único puerto UDP, el 8189.

**DTLS y SRTP.** Sobre el camino elegido se hace un saludo **DTLS** (TLS adaptado a UDP) del que salen las claves. La media se cifra con **SRTP**. La huella del certificado viaja en el SDP, así que no hace falta ninguna autoridad certificadora.

### 5.3. Cómo viaja la media

**RTP.** Cada paquete lleva una cabecera con un **número de secuencia** (para detectar pérdidas y reordenar), una **marca de tiempo** (para saber cuándo se muestra) y un identificador de flujo (**SSRC**).

Un frame de vídeo no cabe en un paquete UDP (unos 1200 bytes útiles), así que se **trocea**. Un keyframe de 1080p puede ocupar decenas de paquetes. El frame solo puede decodificarse cuando han llegado todos.

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
3. Si no llega a tiempo, el frame se descarta. Los siguientes dependen de él, así que la imagen se congela.
4. El receptor envía un PLI para pedir un keyframe. En una videollamada, el codificador genera uno de inmediato y la imagen vuelve.

En este testbed el paso 4 tiene una limitación (ver también la variable de confusión 7 de 6.4): **MediaMTX no codifica, solo reenvía**. No puede fabricar un keyframe a petición, así que el receptor tiene que esperar al siguiente keyframe del flujo, que llega cada GOP (1 s). No he comprobado si MediaMTX traslada el PLI de alguna forma al origen; por cómo está montada la ingesta (RTSP desde un FFmpeg que copia), no hay nadie que pueda atenderlo.

### 5.5. El búfer de jitter

Los paquetes llegan con separaciones irregulares y a veces desordenados. El **búfer de jitter** los retiene lo justo para reordenarlos, esperar retransmisiones y entregar los frames a ritmo constante.

Es **adaptativo y lo gestiona el navegador**: mide la variación de los tiempos de llegada y ajusta su tamaño continuamente. Con buena red baja a decenas de milisegundos; si la red empeora, crece solo. En las medidas del testbed estaba entre 55 y 95 ms.

La aplicación solo puede **sugerir** un mínimo con `jitterBufferTarget` (el slider "Búfer objetivo"). El navegador lo trata como una pista, no como una orden. En "auto" no se pide nada.

### 5.6. Control de congestión y adaptación

En una videollamada, el emisor estima el ancho de banda con la realimentación TWCC (algoritmo **GCC**, *Google Congestion Control*) y **ordena al codificador que cambie de bitrate** sobre la marcha. La adaptación ocurre en el codificador, no eligiendo entre versiones ya hechas. Para repartir a muchos se usa **simulcast** (el emisor manda varias calidades y un servidor elige cuál reenviar a cada uno) o **SVC** (un flujo en capas).

**Nada de eso se usa aquí.** El testbed envía una sola calidad, la más alta, sin recodificar. Si el enlace no da para ella, no hay calidad inferior a la que bajar: se pierden paquetes y la imagen se congela. Es una decisión deliberada de alcance, y hay que tenerla presente al comparar: **la rama WebRTC no tiene adaptación de calidad**, las otras dos sí.

### 5.7. El recorrido en este testbed

1. **Ingesta.** Desde el 29-10-2026, la compuerta envía el MPEG-TS por UDP directamente a MediaMTX, con solo la calidad más alta (y el audio, con `rtc_audio`) y la PMT reducida a esas pistas; antes, `ffmpeg -c:v copy -an -f rtsp` lo publicaba por RTSP (sobre TCP), y se puede volver a ello con `RTC_INGEST=rtsp` (README, 3.4b). Sin audio por defecto. Con la opción `rtc_audio`, también el audio Opus de la fuente, sin recodificar (`-c:a copy`). Entonces el navegador sincroniza audio y vídeo: el búfer de jitter objetivo del vídeo sube hasta el del audio (comprobado con `getStats()` el 22-10-2026). Con el bucle el audio pide ~40 ms y la latencia sube poco (de 59-71 a 79-120 ms); con la cámara, cuyo audio llega con más jitter, pide 225-315 ms y la latencia sube 100-200 ms (README, sección 3.4b). Una conexión abierta en los primeros segundos de la emisión queda además 45-55 ms por encima toda la sesión; por eso el dashboard espera a que la emisión lleve unos segundos publicada antes de conectar. Hasta ese día la fuente codificaba en AAC, que WebRTC no admite.
2. **Servidor.** MediaMTX reparte el H.264 en paquetes RTP y los envía a cada navegador conectado.
3. **Navegador.** `RTCPeerConnection` recibe, reordena, decodifica y pinta en un `<video>`. Todo lo hace el navegador; la aplicación solo lee estadísticas con `getStats()`. Se explica en 5.9.

Que la fuente no use B-frames (`zerolatency`) importa aquí: WebRTC en navegadores no los admite bien.

### 5.8. De dónde sale su latencia

- **Ingesta**: milisegundos.
- **Red**: UDP directo, sin esperas por orden.
- **Búfer de jitter**: decenas de milisegundos, adaptativo.

En las medidas del testbed, entre 145 y 185 ms en total. Es la rama con menos latencia y también la que menos margen tiene.

### 5.9. El reproductor: `RTCPeerConnection` por dentro

En esta rama **no hay librería de reproducción**. El reproductor es el propio navegador, a través de la API estándar `RTCPeerConnection`. La página se limita a establecer la sesión y a conectar el resultado a un elemento `<video>`; son unas cuarenta líneas de código.

Es la diferencia de fondo con las otras dos ramas:

| Rama | Dónde está la lógica de reproducción | Qué control tiene la página |
| :--- | :--- | :--- |
| DASH | En JavaScript (`dash.js`), hasta entregar los bytes | Mucho: qué pedir, calidad, velocidad. |
| MoQ | En JavaScript (`@moq/watch`), hasta el pintado de cada frame | Total: cada frame pasa por código de la página. |
| WebRTC | En el navegador, entera | Casi ninguno: una sugerencia de búfer y estadísticas de lectura. |

**Lo que hace el navegador por su cuenta**, sin que la página intervenga:

```
UDP ─▶ ICE ─▶ DTLS/SRTP ─▶ RTP ─▶ búfer de jitter ─▶ decodificador ─▶ <video> ─▶ pantalla
              (descifra)    │      (reordena, espera     (H.264)
                            │       retransmisiones)
                            └─▶ RTCP hacia el servidor: NACK, PLI, informes de recepción
```

Recibe los paquetes, los descifra, reconstruye cada frame a partir de sus trozos, pide las retransmisiones que falten, decide cuánto retener cada frame, lo decodifica y lo pinta.

**Lo que hace la página**, paso a paso:

1. **Crea la conexión**, sin servidores STUN ni TURN: `new RTCPeerConnection()`.
2. **Declara qué quiere recibir**: un único flujo de vídeo, solo de recepción (`addTransceiver('video', { direction: 'recvonly' })`).
3. **Genera la oferta SDP** y espera a que el navegador reúna sus candidatos ICE, hasta 2 s.
4. **La envía por WHEP**: un `POST` a `/rtc/liveudp/whep` (el path depende de la ingesta: `liveudp`, `liveudpa` con audio, o `live` con la ingesta RTSP) con la oferta en el cuerpo (`Content-Type: application/sdp`).
5. **Aplica la respuesta SDP** que devuelve MediaMTX.
6. **Conecta el vídeo**: cuando el navegador avisa de que llega la pista, la asigna al `<video>` (`video.srcObject`).

A partir del paso 5, navegador y MediaMTX completan solos ICE y DTLS y empieza a llegar el vídeo.

**WHEP, en concreto.** Es un protocolo mínimo: toda la señalización es una petición y su respuesta.

```
POST /rtc/live/whep
Content-Type: application/sdp

v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
...                                  ← la oferta: "quiero recibir vídeo, admito estos códecs,
                                        estos son mis candidatos y mi huella DTLS"

201 Created
Content-Type: application/sdp

v=0
...                                  ← la respuesta: "te envío H.264, este es mi candidato
                                        (la dirección del servidor, puerto UDP 8189) y mi huella"
```

El testbed usa la variante **sin *trickle***: en vez de ir enviando los candidatos ICE según aparecen, espera a tenerlos todos y los manda dentro de la oferta. Es más simple y cuesta como mucho esos 2 s al conectar. Al cerrar, la página cierra la conexión sin avisar a MediaMTX por HTTP; el servidor la da por terminada cuando deja de recibir tráfico.

**Lo que se negocia.** En la respuesta de MediaMTX capturada en una prueba, el vídeo H.264 se acordó con estos mecanismos de realimentación:

| Mecanismo | Qué permite |
| :--- | :--- |
| `nack` | Que el navegador pida la retransmisión de paquetes concretos. |
| `nack pli` | Que pida un keyframe nuevo. |
| `transport-cc` | Que informe de los tiempos de llegada, para estimar el ancho de banda. |

No se negoció la extensión de retardo de reproducción, con la que un servidor puede imponer un búfer mínimo o máximo al receptor. El búfer queda entero a criterio del navegador.

**Los mandos disponibles.** Solo hay uno con efecto sobre la reproducción:

| Mando | Por defecto | Aquí | Efecto |
| :--- | :--- | :--- | :--- |
| `RTCRtpReceiver.jitterBufferTarget` | Sin fijar | Slider: automático o de 50 a 2000 ms | Sugiere al navegador un tamaño de búfer de jitter. Es una pista, no una orden. |

No hay selector de calidad ni ABR en la página: MediaMTX envía un único flujo.

**Lo que la página puede leer.** `getStats()` devuelve las estadísticas internas del navegador. El testbed las consulta cada 500 ms y usa estas:

| Estadística | Para qué |
| :--- | :--- |
| `bytesReceived` (del flujo de vídeo) | Bitrate de vídeo recibido. |
| `bytesReceived` (del transporte) | Descarga total, con RTCP y retransmisiones. |
| `jitterBufferDelay`, `jitterBufferEmittedCount` | Tiempo medio de cada frame en el búfer de jitter. |
| `frameHeight` | Resolución recibida. |
| `packetsLost` | Paquetes perdidos. |

Otras que el navegador ofrece y son útiles para diagnosticar: `nackCount` y `pliCount` (cuántas retransmisiones y keyframes ha pedido), `jitter`, `totalDecodeTime` y `framesDecoded`.

**Lo que el testbed añade alrededor:**

- **Reintento.** Si la negociación falla, lo habitual justo tras un arranque porque MediaMTX aún no tiene la emisión, se repite cada 1,5 s.
- **Vigilancia.** Como en las otras ramas: 10 s sin imagen nueva y se recrea la conexión (`rtc_player_restarts`).
- **Medida.** El timecode se lee del `<video>`. La hora de llegada de cada frame la da el navegador con cada frame presentado (ver D.5 y la reserva de D.8).

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

1. **Control de congestión**: CUBIC (DASH) frente a BBRv3 (MoQ). El relay admite `loss` para acercarlos.
2. **Adaptación**: WebRTC no tiene; DASH y MoQ sí.
3. **Audio**: WebRTC no lo lleva; los otros dos sí (aunque silenciado en el reproductor).
4. **Búfer**: cada rama tiene un valor por defecto de orden distinto. Comparar latencias es, en buena parte, comparar configuraciones de búfer.
5. **Implementación**: se mide `dash.js`, `@moq/watch` y el WebRTC del navegador, no los protocolos en abstracto. Otras implementaciones se comportarían distinto.
6. **Proxy**: si DASH pasa por el punto de entrada, la conexión TCP del navegador termina en el proxy y la red emulada actúa sobre una segunda conexión interna. Se evita con el camino directo (`DASH_HOST`), en el que la conexión del navegador atraviesa el router igual que en MoQ y WebRTC. El CSV registra qué camino se usó (`dash_path`).
7. **Codificación pensada para emisión, no para WebRTC interactivo.** Las tres ramas reciben el mismo flujo: H.264 *Constrained Baseline* sin B-frames, un keyframe cada GOP (1 s por defecto) y bitrate con tope (120 % del nominal, búfer de 1 s). Es la configuración que recomiendan los servicios que reciben WebRTC desde un codificador externo (WHIP): sin B-frames y keyframe cada 1-2 s. Pero no es como codifica WebRTC en una videollamada. Allí el codificador de los navegadores (libwebrtc) usa bitrate constante ajustado en vivo por el control de congestión, un intervalo de keyframes de 3000 frames (50 s a 60 fps) y keyframes adicionales cuando el receptor los pide tras una pérdida.

   Aquí falta ese lazo con el codificador. MediaMTX reenvía lo que recibe de un FFmpeg que solo copia, así que nadie atiende las peticiones de keyframe del navegador (PLI/FIR) ni ajusta la tasa del codificador según la congestión. Tras una pérdida, la imagen solo se recupera en el siguiente GOP, y ante falta de ancho de banda no hay forma de bajar la tasa. Las otras dos ramas tampoco tienen ese lazo, pero no lo necesitan: DASH y MoQ adaptan eligiendo entre calidades ya codificadas.

   El GOP fijo es aquí la elección correcta (con un GOP "a lo libwebrtc", la espera tras una pérdida podría ser de 50 s) y es necesario para las otras ramas: en DASH cada segmento empieza por un keyframe, y en MoQ cada grupo es un GOP. Pero significa que **WebRTC se mide en condiciones distintas a las de su uso habitual**, especialmente con pérdidas o con ancho de banda limitado. Para medirlo "como en una videollamada" haría falta un emisor propio que atienda la realimentación del receptor (un navegador o un emisor basado en libwebrtc); rompería el flujo idéntico para las tres ramas, así que sería un experimento aparte y declarado.

   Fuentes: el estándar solo fija los códecs (RFC 7742); el comportamiento de libwebrtc sale de su código (`libvpx_vp8_encoder.cc`, `h264_encoder_impl.cc` y los valores por defecto de `video_encoder.cc`); las recomendaciones de ingesta, de guías de Gcore, Alibaba Cloud, VDO.Ninja y nanocosmos. Las unidades del búfer de libvpx (milisegundos) son una lectura de su configuración, no un comentario del código.

8. **La lectura del MPEG-TS cuesta distinto en cada rama y cae en etapas distintas.** Desde la llegada del último paquete de un frame hasta que sale empaquetado: MediaMTX 17 ms (1 frame), el publicador de MoQ 34 ms (2 frames, con el relay incluido) y FFmpeg 50,5 ms (3 frames), medido en local el 29-10-2026 a 60 fps (C.4). El frame inherente al formato lo pagan las tres; los demás son de cada implementación. Además, en DASH ese tiempo cae en la etapa "Empaquetado CMAF", y en MoQ y WebRTC queda escondido en "Publicación y transporte", así que las etapas de entrada no son comparables entre ramas: la de DASH incluye la lectura y las otras dos no. La latencia total sí es comparable. Se valoró añadir puntos de medida a la salida del publicador y de MediaMTX para equipararlas, y se descartó: habría que mantener un suscriptor y un lector permanentes en el servidor.

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
| **Reproductores activos** | Apagado: no descarga ni ocupa la red | Apagado: no descarga ni ocupa la red | Apagado: no descarga ni ocupa la red |

---

## 8. Glosario

**ABR** (*Adaptive Bitrate*). Elegir la calidad según el estado de la red.

**ANNOUNCE**. En MoQ, mecanismo por el que se descubren los broadcasts disponibles.

**AST** (*availabilityStartTime*). En DASH, hora de reloj en la que empezó la emisión.

**BBR**. Control de congestión que estima ancho de banda y retardo, en vez de reaccionar a pérdidas.

**Broadcast**. En MoQ, una emisión: conjunto de pistas bajo un nombre.

**Catálogo**. En MoQ, pista que describe las demás pistas del broadcast.

**Chunk / fragmento CMAF**. Par `moof` + `mdat`: la porción mínima de un segmento que se puede decodificar.

**CMAF**. Formato de MP4 fragmentado común a DASH y HLS.

**CUBIC**. Control de congestión por defecto de TCP en Linux, basado en pérdidas.

**DTLS**. TLS adaptado a UDP; en WebRTC sirve para acordar las claves.

**Frame**. Una imagen codificada. En MoQ, además, la unidad mínima del transporte.

**GCC**. Control de congestión de WebRTC.

**GOP**. Un keyframe y los frames que dependen de él.

**Group**. En MoQ, tramo de una pista decodificable por sí solo; viaja en su propio stream QUIC.

**hang**. Formato de media (catálogo y contenedor) del proyecto `moq.dev`.

**Head-of-line blocking**. Que un dato perdido detenga a los que vienen detrás aunque ya hayan llegado.

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

**QUIC**. Protocolo de transporte sobre UDP con streams independientes, cifrado y control de congestión.

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

---

## Anexo A. El manifiesto MPD, campo a campo

Este anexo recorre el manifiesto que sirve el testbed, elemento por elemento y atributo por atributo: qué significa cada uno, qué valor tiene aquí, de dónde sale y qué hace el reproductor con él.

El manifiesto de ejemplo se capturó del servidor el 9 de octubre de 2026, con una sola calidad (1080p a 4000 kbit/s), segmentos de 2 s y fragmentos de 100 ms. Los valores numéricos de los ejemplos salen de él.

### A.1. El manifiesto completo

```xml
<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns="urn:mpeg:dash:schema:mpd:2011"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xsi:schemaLocation="urn:mpeg:DASH:schema:MPD:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd"
     profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="dynamic"
     minimumUpdatePeriod="PT500S"
     availabilityStartTime="2026-10-09T14:07:37.116Z"
     publishTime="2026-10-09T17:13:13.056Z"
     timeShiftBufferDepth="PT30.0S"
     maxSegmentDuration="PT2.0S"
     minBufferTime="PT1.0S">
  <ProgramInformation>
  </ProgramInformation>
  <ServiceDescription id="0">
  </ServiceDescription>
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true"
                   bitstreamSwitching="true" frameRate="60/1" maxWidth="1920" maxHeight="1080" par="16:9">
      <Resync dT="100000" type="0"/>
      <Representation id="0" mimeType="video/mp4" codecs="avc1.42c02a" bandwidth="4000000"
                      width="1920" height="1080" sar="1:1">
        <ProducerReferenceTime id="0" inband="true" type="captured"
                               wallClockTime="2026-10-09T14:07:38.089Z" presentationTime="0">
          <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="/api/utc"/>
        </ProducerReferenceTime>
        <Resync dT="1000000" type="1"/>
        <SegmentTemplate timescale="1000000" duration="2000000"
                         availabilityTimeOffset="1.900" availabilityTimeComplete="false"
                         initialization="init-stream$RepresentationID$.m4s"
                         media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true"
                   bitstreamSwitching="true">
      <Resync dT="100000" type="0"/>
      <Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="130858"
                      audioSamplingRate="48000">
        <AudioChannelConfiguration
            schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
        <Resync dT="21333" type="1"/>
        <SegmentTemplate timescale="1000000" duration="2000000"
                         availabilityTimeOffset="1.900" availabilityTimeComplete="false"
                         initialization="init-stream$RepresentationID$.m4s"
                         media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="/api/utc"/>
</MPD>
```

Lo escribe FFmpeg (`-f dash`). El testbed interviene en dos puntos, que se señalan donde tocan: el origen reescribe `availabilityStartTime`, y el `bandwidth` del vídeo se le declara a FFmpeg a mano.

### A.2. Los formatos que aparecen

Antes de los campos, las cuatro notaciones que se repiten:

| Notación | Ejemplo | Cómo se lee |
| :--- | :--- | :--- |
| Duración (`xs:duration`) | `PT2.0S`, `PT500S`, `PT1H30M` | `P` de periodo, `T` de tiempo, y luego cantidades con su unidad: `H` horas, `M` minutos, `S` segundos. `PT2.0S` son 2 segundos. |
| Fecha y hora (`xs:dateTime`) | `2026-10-09T14:07:37.116Z` | ISO 8601. La `Z` final indica UTC. Siempre es hora de reloj real, no tiempo del vídeo. |
| Tiempo en unidades de `timescale` | `duration="2000000"` con `timescale="1000000"` | Un entero que se divide por la escala para obtener segundos: 2 000 000 / 1 000 000 = 2 s. Evita decimales. |
| Identificador de esquema (URN) | `urn:mpeg:dash:utc:http-xsdate:2014` | Un nombre normalizado que dice cómo interpretar el `value` que lo acompaña. |

Hay dos relojes distintos en todo el manifiesto, y conviene no mezclarlos:

- **Tiempo de reloj** (*wall clock*): la hora real, en UTC.
- **Tiempo de medios**: la posición dentro del vídeo, que empieza en 0 al inicio de la emisión.

El manifiesto existe, en buena parte, para relacionar uno con otro.

### A.3. El elemento raíz, `MPD`

Describe la emisión en su conjunto.

| Atributo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `xmlns`, `xmlns:xsi`, `xmlns:xlink`, `xsi:schemaLocation` | — | Declaraciones XML: qué vocabulario se usa y dónde está su esquema. No afectan a la reproducción. |
| `profiles` | `urn:mpeg:dash:profile:isoff-live:2011` | El subconjunto de DASH que cumple el manifiesto. Este es el perfil "ISO BMFF live": segmentos MP4 fragmentado direccionados por plantilla. Le dice al reproductor qué puede esperar. |
| `type` | `dynamic` | `dynamic` es un directo: el contenido crece y la disponibilidad depende de la hora. `static` es vídeo bajo demanda: todo existe ya. |
| `availabilityStartTime` | `2026-10-09T14:07:37.116Z` | El ancla de todo: la hora de reloj que corresponde al tiempo de medios 0. |
| `publishTime` | `2026-10-09T17:13:13.056Z` | Cuándo se generó esta versión del manifiesto. |
| `minimumUpdatePeriod` | `PT500S` | Cada cuánto, como mínimo, puede cambiar el manifiesto. El reproductor no lo vuelve a pedir antes. |
| `timeShiftBufferDepth` | `PT30.0S` | Cuánto pasado se conserva en el servidor. |
| `maxSegmentDuration` | `PT2.0S` | Duración máxima de un segmento en toda la emisión. |
| `minBufferTime` | `PT1.0S` | Parámetro del modelo de búfer que define qué significa `bandwidth`. |

**`type`.** Con `dynamic`, el reproductor no puede pedir cualquier segmento: solo los que la hora actual hace disponibles. Con `static` no hay reloj que consultar.

**`availabilityStartTime` (AST).** Si el AST es las 14:07:37,116, el frame con tiempo de medios 10 s corresponde a las 14:07:47,116. Todos los cálculos de A.9 parten de aquí. Un AST adelantado hace que el reproductor pida segmentos que aún no existen (errores 404); uno atrasado añade latencia sin que el reproductor lo sepa.

> **Intervención del testbed.** FFmpeg escribe como AST la hora en que arrancó, que no coincide con la hora real en que empiezan a existir los segmentos. El origen (`origin.py`) mide a qué hora se abre cada segmento, calcula el AST que le corresponde y lo sustituye en el manifiesto antes de servirlo. Mientras no lo tiene calibrado, no publica el manifiesto. El desfase del último segmento respecto a ese calendario es la métrica `dash_availability_drift_ms`.

**`publishTime`.** Sirve para distinguir versiones del manifiesto. En el ejemplo, el manifiesto se generó 3 h 5 min después de empezar la emisión.

**`minimumUpdatePeriod`.** En un manifiesto con lista explícita de segmentos hay que releerlo constantemente para descubrir los nuevos. Aquí las direcciones se calculan con una fórmula (A.9), así que el manifiesto no cambia y basta un valor alto: 500 s.

**`timeShiftBufferDepth`.** Define la ventana en la que se puede retroceder. Con 30 s, a las 17:13:13 se puede pedir contenido desde las 17:12:43. FFmpeg recibe la ventana con `-window_size` y va pidiendo al origen que borre los segmentos que salen de ella.

**`minBufferTime` y `bandwidth`.** Van juntos. La definición formal es: si el cliente descarga por un canal de velocidad constante igual al `bandwidth` de una Representation, y espera `minBufferTime` antes de empezar a reproducir, no se quedará sin datos. Es decir, `bandwidth` no es el bitrate medio, sino un caudal que garantiza continuidad dado ese colchón. En la práctica los reproductores usan `bandwidth` como bitrate de la calidad y gestionan su búfer con ajustes propios.

Atributos que este manifiesto no lleva y conviene conocer:

| Atributo | Para qué sirve |
| :--- | :--- |
| `suggestedPresentationDelay` | Distancia al directo que el servicio recomienda. Sin él, decide el reproductor. |
| `mediaPresentationDuration` | Duración total. Solo tiene sentido en `static`. |
| `availabilityEndTime` | Hora a partir de la cual el contenido deja de estar disponible. |

### A.4. `ProgramInformation` y `ServiceDescription`

**`ProgramInformation`** lleva metadatos para humanos: título, fuente, derechos. Aquí está vacío. Con contenido sería así:

```xml
<ProgramInformation>
  <Title>Big Buck Bunny en directo</Title>
  <Source>Blender Foundation</Source>
</ProgramInformation>
```

**`ServiceDescription`** es donde el servicio le dice al reproductor cómo quiere que se comporte en baja latencia. Aquí está vacío, con solo su `id`. Es importante saber qué podría llevar, porque es el mecanismo estándar para fijar la latencia desde el servidor:

```xml
<ServiceDescription id="0">
  <Latency target="3000" min="2000" max="6000"/>
  <PlaybackRate min="0.96" max="1.04"/>
</ServiceDescription>
```

| Elemento | Significado |
| :--- | :--- |
| `Latency@target` | Latencia objetivo respecto al directo, en milisegundos. |
| `Latency@min`, `@max` | Margen aceptable. Fuera de él, el reproductor debe corregir. |
| `PlaybackRate@min`, `@max` | Cuánto puede acelerar o frenar la reproducción para corregir. `1.04` es un 4 % más rápido. |

Como el del testbed está vacío, **el manifiesto no impone ninguna latencia**: la fija el slider del panel, que escribe el ajuste `liveDelay` de `dash.js`. Es una diferencia con MoQ, donde el publicador sí condiciona el búfer del reproductor a través del catálogo.

### A.5. `Period`

Un tramo continuo de contenido. Una emisión puede tener varios, por ejemplo programa, publicidad y programa; cada uno con sus propias pistas y calidades.

| Atributo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `id` | `0` | Identificador. |
| `start` | `PT0.0S` | Cuándo empieza el periodo, contado desde el AST. |

Con `start="PT0.0S"` el periodo empieza justo en el AST. Si hubiera un segundo periodo con `start="PT600S"`, empezaría 10 minutos después, y su tiempo de medios volvería a contar desde su propio origen.

### A.6. `AdaptationSet`

Un componente del contenido: aquí hay dos, el vídeo y el audio. Dentro de un AdaptationSet, todas las Representations son **el mismo contenido en versiones intercambiables**. El reproductor elige una de cada AdaptationSet y puede cambiar entre las de uno mismo.

| Atributo | Vídeo | Audio | Significado |
| :--- | :--- | :--- | :--- |
| `id` | `0` | `1` | Identificador. |
| `contentType` | `video` | `audio` | Qué tipo de media contiene. |
| `startWithSAP` | `1` | `1` | Cada segmento empieza por un punto de acceso del tipo indicado. |
| `segmentAlignment` | `true` | `true` | Los segmentos de las distintas calidades cubren los mismos intervalos. |
| `bitstreamSwitching` | `true` | `true` | Se puede cambiar de calidad sin reiniciar el decodificador. |
| `frameRate` | `60/1` | — | Frames por segundo, como fracción. |
| `maxWidth`, `maxHeight` | `1920`, `1080` | — | La resolución mayor de entre sus Representations. |
| `par` | `16:9` | — | Relación de aspecto de la imagen. |

**`startWithSAP`.** Un SAP (*Stream Access Point*) es un punto por el que se puede empezar a decodificar. El tipo 1 es el más estricto: un keyframe a partir del cual todo lo que sigue se decodifica y se muestra en orden, sin depender de nada anterior. Es lo que garantiza que el reproductor puede entrar por cualquier segmento. Por eso el segmento tiene que ser múltiplo del GOP: con GOP de 1 s y segmento de 2 s, cada segmento empieza por keyframe.

**`segmentAlignment`.** Si el segmento 5568 de 1080p cubre de 11134 a 11136 s, el de 720p cubre exactamente lo mismo. Así el reproductor puede reproducir el 5568 en una calidad y el 5569 en otra sin huecos ni solapes. El testbed lo consigue codificando todas las calidades con el mismo GOP y sin cortes de escena.

**`frameRate="60/1"`.** Se da como fracción para expresar tasas no enteras: 29,97 fps se escribe `30000/1001`.

**`par`** (*picture aspect ratio*) es la forma de la imagen final. No hay que confundirlo con `sar` de la Representation (A.7).

**Con varias calidades**, el AdaptationSet de vídeo contiene una Representation por cada una, todas dentro del mismo conjunto. Esto lo fija la opción `-adaptation_sets "id=0,streams=v id=1,streams=a"` de FFmpeg: sin ella, cada calidad quedaría en un AdaptationSet distinto y `dash.js` no conmutaría entre ellas.

#### El elemento `Resync`

Aparece dos veces en cada componente, y es específico de la baja latencia. Describe los **puntos de resincronización dentro de un segmento**: lugares por los que un reproductor puede engancharse sin esperar al segmento siguiente.

| Dónde | Valor | Significado |
| :--- | :--- | :--- |
| AdaptationSet (vídeo y audio) | `dT="100000" type="0"` | Hay un punto de resincronización cada 100 ms como máximo. |
| Representation de vídeo | `dT="1000000" type="1"` | Hay un punto de acceso de tipo 1 cada 1 s como máximo. |
| Representation de audio | `dT="21333" type="1"` | Hay un punto de acceso de tipo 1 cada 21,333 ms como máximo. |

- **`dT`** es la distancia máxima entre puntos, en unidades de `timescale` (aquí, microsegundos).
- **`type`** es el tipo de SAP que se garantiza en esos puntos. `0` significa que no se garantiza ninguno: es solo un límite de fragmento, por el que se puede empezar a *leer* pero no necesariamente a *decodificar*.

Los tres valores se corresponden con la configuración:

- 100 ms es la duración de fragmento: cada `moof` + `mdat` es un punto de resincronización.
- 1 s es el GOP: cada keyframe es un punto por el que empezar a decodificar.
- 21,333 ms es un frame de audio AAC: 1024 muestras a 48 000 Hz. Todos los frames de audio son independientes, así que cada uno es un punto de acceso.

Leídos juntos dicen: "puedes engancharte a mitad de segmento cada 100 ms, pero para empezar a mostrar vídeo tendrás que esperar hasta 1 s a que llegue un keyframe".

### A.7. `Representation`

Una versión concreta: lo que en MoQ se llama rendition.

**Vídeo**

| Atributo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `id` | `0` | Identificador. Se usa para construir las direcciones (`$RepresentationID$`). |
| `mimeType` | `video/mp4` | Formato del contenedor. |
| `codecs` | `avc1.42c02a` | Códec y sus parámetros, en una cadena normalizada. |
| `bandwidth` | `4000000` | Caudal necesario, en bits por segundo (ver A.3). |
| `width`, `height` | `1920`, `1080` | Resolución en píxeles. |
| `sar` | `1:1` | Relación de aspecto del píxel. |

**`codecs="avc1.42c02a"`.** Se descompone así:

| Parte | Valor | Significado |
| :--- | :--- | :--- |
| `avc1` | — | H.264, con los parámetros del decodificador (SPS y PPS) en el segmento de inicialización. |
| `42` | 66 en decimal | Perfil *Baseline*. |
| `c0` | — | Restricciones adicionales: con estos bits, *Constrained Baseline*. |
| `2a` | 42 en decimal | Nivel 4.2, el que permite 1080p a 60 fps. |

El reproductor usa esta cadena para preguntar al navegador si puede decodificarlo antes de descargar nada. El perfil *Baseline* es consecuencia de codificar con `-preset ultrafast`: sin B-frames ni CABAC.

Compárese con el catálogo de MoQ, que para el mismo vídeo dice `avc3.42c02a`. Los mismos bytes, pero `avc3` indica que los parámetros van dentro del flujo, repetidos en cada keyframe, y `avc1` que van aparte, en el segmento de inicialización.

**`bandwidth="4000000"`.**

> **Intervención del testbed.** Como el empaquetador copia el vídeo sin recodificar (`-c copy`), FFmpeg no conoce su bitrate. El testbed se lo declara (`-b:v:0 4000k`) para que el manifiesto lo lleve. Es el valor nominal de la escalera, no una medida. El ABR de `dash.js` lo usa para decidir si una calidad cabe.

Aquí hay otra diferencia con MoQ: para esta misma calidad, el catálogo de MoQ declara unos 7 Mbit/s, porque allí el valor lo mide el publicador.

**`sar`** (*sample aspect ratio*) es la forma de cada píxel. `1:1` son píxeles cuadrados. Con vídeo anamórfico, por ejemplo 1440×1080 mostrado como 16:9, sería `4:3`.

**Audio**

| Atributo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `codecs` | `mp4a.40.2` | AAC-LC: `mp4a` es audio MPEG-4, `40` el tipo de objeto MPEG-4 Audio y `2` el perfil *Low Complexity*. |
| `bandwidth` | `130858` | Aquí sí lo conoce FFmpeg, porque lo lee del flujo: unos 128 kbit/s más cabeceras. |
| `audioSamplingRate` | `48000` | Muestras por segundo. |

**`AudioChannelConfiguration`** indica la disposición de canales. Con el esquema `...audio_channel_configuration:2011`, el `value` es directamente el número de canales: `2` es estéreo.

### A.8. `ProducerReferenceTime`

Relaciona un instante del vídeo con la hora de reloj a la que se produjo. Es lo que permite a un reproductor calcular su latencia real de extremo a extremo.

| Atributo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `id` | `0` | Identificador. |
| `type` | `captured` | A qué momento se refiere la hora: `captured` es la captura; `encoder` sería la salida del codificador. |
| `wallClockTime` | `2026-10-09T14:07:38.089Z` | La hora de reloj. |
| `presentationTime` | `0` | El tiempo de medios al que corresponde, en unidades de `timescale`. |
| `inband` | `true` | La misma información va también dentro de los segmentos, en cajas `prft`. |

Se lee: "el frame con tiempo de medios 0 se capturó a las 14:07:38,089". Con eso, la latencia sería:

```
latencia = ahora − (wallClockTime + tiempo de medios que se está mostrando)
```

El `UTCTiming` anidado indica con qué reloj se tomó esa hora, para que el reproductor use el mismo.

> **Observación.** En este manifiesto, `wallClockTime` (14:07:38,089) y `availabilityStartTime` (14:07:37,116) difieren en 0,973 s, cuando los dos se refieren al tiempo de medios 0. El primero lo escribe FFmpeg con su propio reloj y el origen no lo corrige; el segundo es el que el origen recalibra. La latencia que declaró `dash.js` en las pruebas (3,002 s con objetivo de 3 s, frente a 3,119 s medidos por timecode) es coherente con que se guíe por el AST. No he comprobado en su código qué uso hace de este elemento.

### A.9. `SegmentTemplate`: cómo se calculan las direcciones

Es la pieza central. En vez de listar los segmentos, da una **fórmula** para construir sus direcciones y saber cuándo existen.

| Atributo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `timescale` | `1000000` | Unidades por segundo para los tiempos de este elemento. |
| `duration` | `2000000` | Duración de cada segmento: 2 s. |
| `startNumber` | `1` | Número del primer segmento. |
| `initialization` | `init-stream$RepresentationID$.m4s` | Plantilla del segmento de inicialización. |
| `media` | `chunk-stream$RepresentationID$-$Number%05d$.m4s` | Plantilla de los segmentos de media. |
| `availabilityTimeOffset` | `1.900` | Cuántos segundos antes de estar completo se puede pedir un segmento. |
| `availabilityTimeComplete` | `false` | Si lo que se sirve en ese momento está completo o no. |

**Las plantillas.** Los identificadores entre `$` se sustituyen:

| Identificador | Se sustituye por |
| :--- | :--- |
| `$RepresentationID$` | El `id` de la Representation. |
| `$Number$` | El número de segmento. `%05d` lo rellena con ceros hasta 5 cifras. |
| `$Bandwidth$` | El `bandwidth` de la Representation. No se usa aquí. |
| `$Time$` | El tiempo de inicio del segmento. Se usa con listas de segmentos, no aquí. |

Para la Representation `0`, las direcciones quedan `init-stream0.m4s` y `chunk-stream0-00042.m4s`. Son relativas a la del manifiesto: `/media/dash/chunk-stream0-00042.m4s`.

**Qué segmento toca.** El número del segmento que se está produciendo en un instante dado es:

```
número = startNumber + parte entera de ( (ahora − AST − Period@start) / duración )
```

Ejemplo, con el manifiesto de A.1, a las 17:13:13,056:

```
ahora − AST = 17:13:13,056 − 14:07:37,116 = 11 135,94 s
11 135,94 / 2 = 5567,97  →  parte entera: 5567
número = 1 + 5567 = 5568

dirección: /media/dash/chunk-stream0-05568.m4s
```

Ese segmento cubre el tiempo de medios de 11 134 a 11 136 s. El reproductor no ha descargado ninguna lista: lo ha calculado con el reloj.

**Cuándo se puede pedir.** En DASH clásico, un segmento está disponible cuando termina:

```
disponible desde = AST + Period@start + (número − startNumber + 1) × duración
```

Para el 5568: 14:07:37,116 + 5568 × 2 s = **17:13:13,116**. Es decir, 2 s después de que empezara a producirse. Ese retraso es la razón de la latencia alta de DASH clásico.

**`availabilityTimeOffset`** adelanta ese momento:

```
disponible desde = (lo anterior) − availabilityTimeOffset
                 = 17:13:13,116 − 1,9 s = 17:13:11,216
```

El segmento empezó a producirse a las 17:13:11,116 y se puede pedir desde las 17:13:11,216: solo 100 ms después, que es lo que tarda en existir su primer fragmento. El valor 1,9 sale de restar la duración de fragmento a la de segmento (2 − 0,1). Lo calcula FFmpeg.

| Fragmento | Segmento | `availabilityTimeOffset` |
| :--- | :--- | :--- |
| 100 ms | 2 s | 1,900 |
| 200 ms | 2 s | 1,800 |
| 500 ms | 2 s | 1,500 |
| 100 ms | 4 s | 3,900 |

**`availabilityTimeComplete="false"`** es el complemento necesario: avisa de que, en ese momento adelantado, el segmento **no está entero**. El reproductor debe pedirlo y leer la respuesta conforme llega, en vez de esperar a que termine. `dash.js` activa su modo de baja latencia al ver este valor.

**Línea de tiempo del segmento 5568:**

```
17:13:11,116  empieza a producirse
17:13:11,216  primer fragmento completo → ya se puede pedir (gracias a availabilityTimeOffset)
17:13:11,316  segundo fragmento, que el servidor envía por la petición ya abierta
     ...      (un fragmento cada 100 ms)
17:13:13,116  último fragmento: el segmento está completo y la respuesta HTTP termina
17:13:13,216  ya se puede pedir el 5569
```

**La alternativa: `SegmentTimeline`.** En vez de una duración fija, se puede listar cada segmento con su inicio y duración exactos:

```xml
<SegmentTemplate timescale="1000000" media="chunk-$Time$.m4s">
  <SegmentTimeline>
    <S t="11134000000" d="2000000" r="2"/>
  </SegmentTimeline>
</SegmentTemplate>
```

Es más preciso, porque tolera segmentos de duración irregular, pero obliga a releer el manifiesto para conocer cada segmento nuevo y no permite anunciar disponibilidad adelantada. Por eso el testbed lo desactiva (`-use_timeline 0`).

### A.10. `UTCTiming`

Todo lo anterior depende de que el "ahora" del reproductor sea el mismo que el del servidor. Con el reloj del ordenador 2 s adelantado, el reproductor pediría segmentos que no existen. `UTCTiming` le dice de dónde sacar la hora buena.

| Atributo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `schemeIdUri` | `urn:mpeg:dash:utc:http-xsdate:2014` | El método. |
| `value` | `/api/utc` | Depende del método; aquí, la dirección a consultar. |

Con `http-xsdate`, el reproductor hace una petición GET y recibe la hora como texto:

```
GET /api/utc
→ 2026-10-13T09:48:38.776Z
```

`dash.js` compara esa hora con la de su reloj, calcula la diferencia y la aplica a todos sus cálculos. La dirección es relativa al manifiesto, así que funciona con cualquier nombre de host y tanto con HTTP como con HTTPS. La sirve el propio orquestador, con el mismo reloj que usa para calibrar el AST.

Otros métodos que define el estándar:

| Esquema | Cómo obtiene la hora |
| :--- | :--- |
| `...:http-xsdate:2014` | Cuerpo de una respuesta HTTP, en formato `xs:dateTime`. El que se usa aquí. |
| `...:http-iso:2014` | Igual, en formato ISO 8601. |
| `...:http-head:2014` | Cabecera `Date` de una respuesta HTTP. Solo tiene precisión de segundos. |
| `...:http-ntp:2014`, `...:ntp:2014` | Protocolo NTP. |
| `...:direct:2014` | La hora va escrita en el propio `value`. |

Aparece dos veces en el manifiesto: una en la raíz, que es la que rige la reproducción, y otra dentro de `ProducerReferenceTime` (A.8).

La precisión de este método está limitada por lo que tarde la petición. Es una de las razones por las que el testbed mide la latencia con un timecode quemado en la imagen y su propia sincronización de reloj, y no con la que declara el reproductor.

### A.11. Los ficheros a los que apunta

El manifiesto no contiene media; solo dice cómo encontrarla. Para cada Representation hay:

| Fichero | Contenido | Cuándo se pide |
| :--- | :--- | :--- |
| `init-stream0.m4s` | Cajas `ftyp` y `moov`: tipo de fichero y configuración del decodificador (resolución, SPS y PPS). Sin frames. | Una vez, al empezar y al cambiar de calidad. |
| `chunk-stream0-NNNNN.m4s` | Una sucesión de fragmentos, cada uno con su `moof` (índice de los frames que siguen y su tiempo) y su `mdat` (los frames). | Uno cada 2 s por componente. |

Con una calidad, el reproductor mantiene dos descargas en curso: el segmento de vídeo (`chunk-stream0-…`) y el de audio (`chunk-stream1-…`).

### A.12. Resumen: de qué depende cada valor

| Campo | Lo fija | Mando del panel |
| :--- | :--- | :--- |
| `availabilityStartTime` | El origen, midiendo | — |
| `SegmentTemplate@duration`, `maxSegmentDuration` | `-seg_duration` | Duración de segmento |
| `availabilityTimeOffset`, `Resync@dT` (tipo 0) | `-seg_duration` y `-frag_duration` | Duración de segmento y de fragmento |
| `Resync@dT` (tipo 1, vídeo) | El GOP de la fuente | GOP |
| `Representation` (cuántas, `width`, `height`, `bandwidth`) | La escalera | Escalera de calidades |
| `frameRate` | La fuente | — |
| `timeShiftBufferDepth` | `-window_size`, calculado para 30 s | — |
| `UTCTiming@value` | `-utc_timing_url` | — |
| `ServiceDescription` | Nadie: vacío | — (la latencia la fija el slider en el reproductor) |

---

## Anexo B. El catálogo de MoQ, campo a campo

Este anexo hace con el catálogo de MoQ lo mismo que el Anexo A con el manifiesto de DASH: recorrerlo entero, sección por sección y campo por campo.

El catálogo cumple el mismo papel que el MPD: decirle al reproductor qué hay y cómo decodificarlo. Pero es más pequeño, porque le falta casi todo lo que en el MPD se dedica a **localizar** la media. En MoQ no hay direcciones que calcular ni horas de disponibilidad: basta el nombre de la pista para suscribirse, y el relay envía lo que vaya llegando.

**Fuentes.** El catálogo de ejemplo se capturó del servidor el 9 de octubre de 2026, con una sola calidad. Las definiciones de los campos salen del esquema de la librería instalada (`@moq/hang` 0.5.2), que es lo que el reproductor entiende. Para lo que esa versión no documenta he consultado el código del publicador en su rama de desarrollo, que es posterior a la versión instalada (moq-cli 0.14.2); donde me apoyo en ella, lo digo.

### B.1. Qué es y cómo viaja

El catálogo no es un fichero que se descarga: **es una pista más del broadcast**, llamada `catalog.json`. El reproductor se suscribe a ella igual que al vídeo, y recibe una versión nueva cada vez que algo cambia.

| Aspecto | Valor |
| :--- | :--- |
| Nombre de la pista | `catalog.json` |
| Prioridad de la suscripción | 100, la más alta: pasa por delante del audio (80) y del vídeo (60) |
| *Max age* de la suscripción | 0: solo interesa la versión más reciente |
| Formato | JSON en texto |
| Variante comprimida | `catalog.json.z`, con DEFLATE. Opcional; el reproductor solo la usa si se le pide |

El formato del catálogo se deduce del nombre del broadcast, como la extensión de un fichero: `live.hang` indica catálogo hang; `live.msf` indicaría el formato MSF del IETF.

**Actualizaciones.** La pista funciona en modo *snapshot*: cada grupo empieza con el catálogo completo, y los frames siguientes del mismo grupo son **parches** que solo llevan lo que cambia, en formato JSON Merge Patch (RFC 7396). Quien se suscribe recibe el grupo más reciente y con eso tiene el estado completo.

Por ejemplo, para marcar una calidad como atascada no hace falta reenviar todo. Bastaría un parche como este (ilustrativo; no lo he capturado del cable):

```json
{ "video": { "renditions": { "0.avc3": { "stalled": true } } } }
```

Y para retirar la marca, el mismo campo con valor `null`, que en ese formato significa "borrar":

```json
{ "video": { "renditions": { "0.avc3": { "stalled": null } } } }
```

Esta es la razón de que las calidades se guarden en un **mapa** con el nombre de la pista como clave, y no en una lista: un parche puede dirigirse a una entrada de un mapa por su clave, pero no a un elemento de una lista.

Las actualizaciones pueden ser muy frecuentes. Con la fuente irregular del testbed y tres calidades se observaron 334 en 30 s, casi todas para poner y quitar esa marca.

### B.2. El catálogo completo

```json
{
  "video": {
    "renditions": {
      "0.avc3": {
        "codec": "avc3.42c02a",
        "codedWidth": 1920,
        "codedHeight": 1080,
        "bitrate": 7573296,
        "framerate": 60.0,
        "container": { "kind": "legacy" }
      }
    }
  },
  "audio": {
    "renditions": {
      "1.aac": {
        "codec": "mp4a.40.2",
        "sampleRate": 48000,
        "numberOfChannels": 2,
        "bitrate": 165007,
        "description": "1190",
        "container": { "kind": "legacy" },
        "jitter": 43
      }
    }
  },
  "archive": { "track": "timeline.z", "timescale": 1000 },
  "clock": { "wall": 213718046806804, "timescale": 1000000 },
  "mpegts": {
    "tracks": { "0.avc3": { "pid": 256 }, "1.aac": { "pid": 257 } },
    "program": { "transportStreamId": 1, "programNumber": 1, "pmtPid": 4096 },
    "si": { "17": { "66": { "track": "0x0011-0x42.si", "interval": 2000 } } }
  }
}
```

Lo escribe entero el publicador (`moq import ts`), deduciéndolo del flujo MPEG-TS que recibe. El testbed no interviene en ningún campo: a diferencia del manifiesto de DASH, aquí no hay nada reescrito ni declarado a mano.

### B.3. La raíz: las secciones

El catálogo es un objeto con una sección por tipo de contenido. Una sección sin pistas se omite.

| Sección | Contenido | En este catálogo |
| :--- | :--- | :--- |
| `video` | Calidades de vídeo | Sí |
| `audio` | Versiones de audio | Sí |
| `text` | Subtítulos | No |
| `json` | Pistas de datos de aplicación en JSON | No |
| `binary` | Pistas de datos de aplicación en binario | No |
| `archive` | Índice de segmentos de la emisión y, si existe, su grabación | Sí |
| `clock` | Relación entre el tiempo de medios y la hora de reloj | Sí |
| `mpegts` | Extensión del importador: datos para reconstruir el MPEG-TS original | Sí |

La raíz es **abierta**: una sección que el reproductor no conoce se ignora sin invalidar el resto. Es lo que ocurre con `mpegts`, que no pertenece al esquema base. Una aplicación puede añadir las suyas.

Hay un límite: como máximo 64 renditions entre vídeo, audio y texto en un mismo catálogo.

### B.4. La sección `video`

```json
"video": {
  "renditions": { "0.avc3": { ... }, "1.avc3": { ... } },
  "display": { "width": 1920, "height": 1080 },
  "rotation": 0,
  "flip": false
}
```

| Campo | En este catálogo | Significado |
| :--- | :--- | :--- |
| `renditions` | Una entrada | Mapa de nombre de pista a configuración. Todas son el mismo contenido en versiones intercambiables. |
| `display` | Ausente | Tamaño al que debe mostrarse el vídeo, en píxeles. Si falta, el reproductor usa el del frame. |
| `rotation` | Ausente (0) | Giro en grados, para vídeo grabado con el móvil en vertical, por ejemplo. |
| `flip` | Ausente (`false`) | Espejo horizontal, típico de una cámara frontal. |

`display`, `rotation` y `flip` valen para todas las calidades a la vez. Están separados de la configuración de cada rendition porque cambiarlos no obliga a reiniciar el decodificador.

**La clave del mapa es el nombre de la pista.** Para ver la calidad `0.avc3`, el reproductor se suscribe a la pista `0.avc3` del broadcast `live.hang`. No hay plantilla ni cálculo: es el equivalente directo, y mucho más simple, de `SegmentTemplate` en DASH.

El nombre lo elige el publicador. Aquí sigue el patrón *índice.códec*: `0.avc3` es la primera pista elemental del MPEG-TS, en H.264. El reproductor no interpreta el nombre; solo lo usa para suscribirse.

### B.5. Los campos de una rendition de vídeo

Reproducen los de `VideoDecoderConfig`, la estructura con la que el navegador configura un decodificador de WebCodecs, más unos pocos propios de hang. La idea es que el reproductor pueda pasárselos al decodificador casi tal cual.

| Campo | Valor aquí | Obligatorio | Significado |
| :--- | :--- | :--- | :--- |
| `codec` | `avc3.42c02a` | Sí | Códec y sus parámetros. |
| `container` | `{"kind":"legacy"}` | No (por defecto `legacy`) | Cómo va empaquetado cada frame. |
| `description` | Ausente | No | Configuración del decodificador, en hexadecimal. |
| `codedWidth`, `codedHeight` | `1920`, `1080` | No | Resolución codificada, en píxeles. |
| `displayAspectWidth`, `displayAspectHeight` | Ausentes | No | Relación de aspecto de presentación. |
| `framerate` | `60.0` | No | Frames por segundo. |
| `bitrate` | `7573296` | No | Bitrate, en bits por segundo. |
| `optimizeForLatency` | Ausente (`true`) | No | Pide al decodificador que priorice la latencia. |
| `jitter` | Ausente | No | Irregularidad con la que el publicador envía los frames, en ms. |
| `delay` | Ausente | No | Retraso de esta rendition respecto a la más temprana, en ms. |
| `stalled` | Ausente | No | El publicador recomienda evitarla por ahora. |
| `label` | Ausente | No | Nombre legible para un selector de calidad. |
| `broadcast` | Ausente | No | La pista está en otro broadcast. |

**`codec`.** La misma notación que en DASH (ver A.7): `42` es el perfil *Baseline*, `c0` sus restricciones y `2a` el nivel 4.2. La diferencia está en el prefijo:

| Prefijo | Dónde van los parámetros del decodificador (SPS y PPS) |
| :--- | :--- |
| `avc1` | Fuera del flujo. En DASH, en el segmento de inicialización; en MoQ, en `description`. |
| `avc3` | Dentro del flujo, repetidos antes de cada keyframe. |

Aquí es `avc3`, y por eso no hay `description`: el reproductor los obtiene del primer keyframe que reciba. Encaja con el modelo de grupos, donde cada grupo debe poder decodificarse por sí solo. La fuente los repite gracias a la opción `repeat-headers=1` de x264.

**`description`.** Cuando existe, es una cadena hexadecimal con la configuración que el códec necesita antes del primer frame. Permite preparar el decodificador solo con el catálogo. El ejemplo de este catálogo está en el audio (B.6).

**`codedWidth` y `codedHeight`.** El reproductor las usa para ordenar las calidades por resolución y para aplicar límites del tipo "no más de 720 de alto". Con `avc3` la resolución real también va en el flujo, así que estos valores son informativos.

**`displayAspectWidth` y `displayAspectHeight`.** Sirven para vídeo con píxeles no cuadrados. Un vídeo de 1440×1080 que deba verse en 16:9 llevaría `16` y `9`. Si faltan, los píxeles son cuadrados. Es el equivalente a `sar` en el MPD.

**`framerate`.** Tiene dos usos en el reproductor. Uno es informativo. El otro afecta a la latencia: si la rendition no declara `jitter`, el reproductor asume un intervalo de frame (1000 / 60 = 17 ms) como irregularidad mínima.

**`bitrate`.** Es el campo que usa la adaptación automática: el reproductor elige la calidad de mayor `bitrate` que quepa en el 80 % del ancho de banda estimado (ver 4.10).

> **Observación.** Para la calidad configurada a 4000 kbit/s, el catálogo declara 7,57 Mbit/s. En otras emisiones he visto 6,70 y 6,95 Mbit/s para la misma configuración. El código del publicador (rama de desarrollo) documenta este campo como el bitrate **máximo** de la pista, no el medio, lo que explica que salga por encima del nominal: los keyframes producen picos. No he comprobado sobre qué ventana lo calcula.
>
> La consecuencia es una asimetría con DASH. Para el mismo vídeo, el MPD declara 4 Mbit/s (el valor nominal, puesto a mano) y el catálogo unos 7 Mbit/s (un máximo medido). Con el mismo ancho de banda disponible, los dos reproductores no ven la misma escalera.

**`optimizeForLatency`.** Se pasa tal cual al decodificador. Con `true`, que es lo que se asume si falta, el decodificador entrega cada frame en cuanto puede en lugar de acumular varios.

**`label`.** Texto para mostrar al usuario, como "1080p" o "Alta". Si falta, un selector tiene que componerlo a partir de la resolución.

**`broadcast`.** Permite que el catálogo de un broadcast apunte a pistas publicadas en otro, con una ruta relativa. Sirve para repartir las calidades entre publicadores distintos:

```json
"720p": { "codec": "avc3.42c01f", "broadcast": "../transcodificado" }
```

Leído desde `live.hang`, esa pista se buscaría en el broadcast `transcodificado`. Una referencia que intente salir por encima de la raíz invalida el catálogo.

`jitter`, `delay` y `stalled` se tratan aparte, en B.8 y B.9, porque son los que condicionan el comportamiento del reproductor.

### B.6. La sección `audio` y sus renditions

Tiene la misma forma que la de vídeo: un mapa `renditions` con una entrada por versión. Los campos reproducen los de `AudioDecoderConfig` de WebCodecs.

| Campo | Valor aquí | Obligatorio | Significado |
| :--- | :--- | :--- | :--- |
| `codec` | `mp4a.40.2` | Sí | AAC-LC (ver A.7). |
| `sampleRate` | `48000` | Sí | Muestras por segundo. |
| `numberOfChannels` | `2` | Sí | Número de canales: estéreo. |
| `bitrate` | `165007` | No | Bitrate, en bits por segundo. |
| `description` | `1190` | No | Configuración del decodificador, en hexadecimal. |
| `container` | `{"kind":"legacy"}` | No | Igual que en vídeo. |
| `jitter` | `43` | No | Igual que en vídeo (B.8). |
| `delay`, `label`, `broadcast` | Ausentes | No | Igual que en vídeo. |

**`description: "1190"`.** Son dos bytes, `0x11` y `0x90`, que forman la configuración estándar de AAC (*AudioSpecificConfig*). En binario:

```
0x11 0x90  =  00010 0011 0010 000
              │     │    │    └─ relleno
              │     │    └────── 2  → 2 canales
              │     └─────────── 3  → 48 000 Hz (índice 3 de la tabla de frecuencias)
              └───────────────── 2  → AAC-LC
```

Repite lo que ya dicen `codec`, `sampleRate` y `numberOfChannels`, pero en el formato que el decodificador exige. A diferencia del H.264 en `avc3`, el AAC no lleva esta información dentro de cada frame, así que tiene que ir aquí.

**`bitrate: 165007`.** La fuente codifica el audio a 128 kbit/s. Como en el vídeo, el valor del catálogo es mayor que el nominal.

El audio no tiene `stalled`: ese campo solo existe para vídeo.

### B.7. El campo `container`

Dice cómo interpretar los bytes de cada frame de MoQ. Hay tres valores conocidos:

**`legacy`**, el que usa el testbed:

```json
"container": { "kind": "legacy" }
```

Cada frame es una marca de tiempo en microsegundos seguida del frame codificado tal cual, sin más envoltorio. Es el valor por defecto: si el campo falta, se asume este.

**`cmaf`:**

```json
"container": { "kind": "cmaf", "init": "AAAAHGZ0eXBpc281AAAC..." }
```

Cada frame de MoQ es un fragmento CMAF completo (`moof` + `mdat`), como los de DASH. El segmento de inicialización, que en DASH es un fichero aparte, va aquí dentro, codificado en base64. Permite reutilizar media ya empaquetada para DASH o HLS.

**`loc`:**

```json
"container": { "kind": "loc" }
```

*Low Overhead Container*, el formato del borrador del IETF: un pequeño bloque de propiedades y el frame codificado.

Un `kind` desconocido no invalida el catálogo: esa rendition se ignora y las demás siguen disponibles.

### B.8. `jitter` y `delay`: lo que el publicador le dice al búfer

Son los dos campos con efecto directo sobre la latencia, y no tienen equivalente en el MPD de este testbed.

**`jitter`** es el retraso máximo, en milisegundos, entre que un frame está listo y el publicador lo envía. Lo mide el publicador sobre sí mismo, no sobre la red. Ejemplos de lo que valdría:

| Cómo envía el publicador | `jitter` |
| :--- | :--- |
| Cada frame en cuanto sale, a 60 fps | Un intervalo de frame: 17 ms |
| Hasta 3 B-frames seguidos, que obligan a reordenar | 3 intervalos: 50 ms |
| Acumula segmentos de 2 s antes de enviar | 2000 ms |

Dos propiedades importantes:

- **Solo crece** a lo largo de una emisión. Si en algún momento el publicador se retrasó 65 ms, el valor queda en 65 hasta que se reinicie.
- **Un 0 se trata como ausente.**

**`delay`** es cuánto llega esta rendition por detrás de la más temprana del mismo broadcast. La más temprana no lo lleva. Sirve cuando una calidad se genera a partir de otra: si el 720p sale de transcodificar el 1080p y eso tarda 80 ms, el 720p declararía `"delay": 80`.

**Qué hace el reproductor con ellos.** Para cada rendition activa calcula `delay + jitter`, usando un intervalo de frame si no hay `jitter`. Toma el mayor de todas las pistas, y se lo suma al búfer que tenga configurado. En este catálogo:

```
vídeo  0.avc3 : sin jitter → 1000 / 60 = 17 ms
audio  1.aac  : jitter 43               = 43 ms
                                 mayor  = 43 ms  → se suma al slider o al valor automático
```

Con el reproductor en automático y 20 ms de búfer de red, el retardo efectivo sale de 63 ms. Tres cosas que conviene saber:

- **Manda el audio, aunque esté silenciado.** El reproductor cuenta su `jitter` aunque no descargue la pista. Con solo vídeo serían 17 ms.
- **El valor cambia entre emisiones y dentro de una.** He visto 43, 46 y 65 ms para el audio en momentos distintos, este último con el servidor saturado.
- **Es un suelo.** El slider no puede bajar de él.

Por qué el audio declara 43 ms: un frame AAC dura 1024 / 48 000 = 21,3 ms, así que 43 son dos frames. Es coherente con que el publicador haya observado el audio llegar de dos en dos, pero no he comprobado que esa sea la causa.

### B.9. `stalled`: el aviso de que una calidad no va bien

Es un indicador que el publicador pone a `true` en una rendition de vídeo cuando no consigue entregarla al ritmo debido. Solo se escribe cuando es `true`; ausente significa que va bien.

**Cuándo se activa**, según el detector de la versión instalada. Tiene que haber alguien suscrito a esa calidad, y cumplirse una de dos condiciones:

- lo último recibido de la fuente va más de 3 intervalos de frame por delante de lo entregado al transporte, o
- la fuente lleva más de 3 intervalos sin entregar un frame de esa calidad.

**Cuándo se retira:** tras 3 frames seguidos entregados a tiempo.

| Tasa de frames | Intervalo | Umbral para activarse |
| :--- | :--- | :--- |
| 60 fps | 16,7 ms | 50 ms |
| 30 fps | 33,3 ms | 100 ms |
| Sin `framerate` declarado | 33 ms (se asume) | 99 ms |

**Qué hace el reproductor.** En modo automático, descarta las renditions marcadas y elige entre las demás. Si están todas marcadas, se queda con la de menor bitrate. Una calidad fijada a mano se mantiene aunque esté marcada: el indicador orienta la adaptación automática, no anula una elección explícita.

Es un mecanismo sin equivalente en DASH: **el publicador puede sacar una calidad de la selección de todos los reproductores a la vez**, sin que ninguno haya medido nada. En el testbed es la causa de los cambios continuos de calidad observados en MoQ (ver el final de 4.10).

> **Este campo está cambiando.** En la rama de desarrollo del proyecto, `stalled` ya no se escribe y se ignora al leer; lo sustituye un campo `enabled` con otro significado: si es `false`, no llegan frames y el reproductor no debe seleccionar esa calidad. La versión instalada aquí, que es la última publicada, sigue usando `stalled`.

### B.10. La sección `clock`

Relaciona el tiempo de medios con la hora de reloj. Es el equivalente a `availabilityStartTime` y `ProducerReferenceTime` del MPD, en un solo sitio y para todo el broadcast.

| Campo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `wall` | `213718046806804` | Hora de reloj del tiempo de medios 0, contada desde la época de MoQ. |
| `timescale` | `1000000` | Unidades por segundo de `wall`. Por defecto, microsegundos. |

La **época de MoQ** es el 1 de enero de 2020 a las 00:00:00 UTC, no la de Unix (1970). El cálculo:

```
213 718 046 806 804 µs  =  213 718 046,806804 s  ≈  2473,6 días desde el 1-1-2020

→ 9 de octubre de 2026, 14:07:26,806804 UTC
```

Para saber a qué hora corresponde cualquier frame, se suma su marca de tiempo:

```
frame con marca de tiempo 10 s  →  14:07:26,807 + 10 s  =  14:07:36,807
```

El publicador fija este valor una vez y no lo cambia durante la emisión, ni siquiera si se ajusta el reloj del sistema.

El reproductor de vídeo **no lo usa para decidir cuándo pintar**: se guía por las horas de llegada de los frames (ver 4.11). Aquí está la diferencia de fondo con DASH. Allí, sin la relación entre reloj y medios el reproductor no sabe ni qué segmento pedir. En MoQ es un dato opcional, útil para alinear varias emisiones entre sí o con datos externos, pero prescindible para reproducir.

### B.11. La sección `archive`

Anuncia el índice de segmentos de la emisión: una pista auxiliar con la que se puede localizar contenido ya pasado para pedirlo con FETCH.

| Campo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `track` | `timeline.z` | Nombre de la pista que lleva el índice. |
| `timescale` | `1000` | Unidades por segundo de sus marcas de tiempo: milisegundos. |
| `durationMax` | Ausente | Cota superior de la duración de un segmento. |
| `replay` | Ausente | Broadcast desde el que se sirve la grabación, si es otro. |
| `store` | Ausente | Dirección del almacén de objetos donde vive la grabación. |
| `version` | Ausente | Versión del formato de grabación. Solo aparece si hay almacén. |

Aquí solo están los dos primeros, lo que corresponde a un publicador en directo sin grabación duradera: hay índice de lo reciente, pero nada almacenado. El sufijo `.z` del nombre es una convención para pistas comprimidas; el esquema advierte de que no debe deducirse la compresión a partir del nombre.

El reproductor del testbed no usa esta sección: solo reproduce el directo.

### B.12. La sección `mpegts`

No pertenece al esquema base. La añade el importador porque la fuente es un flujo MPEG-TS, y guarda lo necesario para **reconstruir ese flujo** a la salida (con `moq export ts`): todo lo que no cabe en la descripción genérica de vídeo y audio. La describe el código del publicador en su rama de desarrollo, de donde salen estas definiciones.

```json
"mpegts": {
  "tracks":  { "0.avc3": { "pid": 256 }, "1.aac": { "pid": 257 } },
  "program": { "transportStreamId": 1, "programNumber": 1, "pmtPid": 4096 },
  "si":      { "17": { "66": { "track": "0x0011-0x42.si", "interval": 2000 } } }
}
```

| Campo | Valor aquí | Significado |
| :--- | :--- | :--- |
| `tracks` | `0.avc3` → 256, `1.aac` → 257 | El PID que tenía cada pista en el MPEG-TS original. |
| `program.transportStreamId` | `1` | Identificador del flujo de transporte. |
| `program.programNumber` | `1` | Número de programa dentro del flujo. |
| `program.pmtPid` | `4096` | PID de la tabla que describe el programa (PMT). |
| `si` | PID 17, tabla 66 | Tablas de información de servicio que se conservan tal cual. |

Qué es un PID, una PMT o una SDT se explica en el [Anexo C](#anexo-c-mpeg-ts-el-formato-intermedio-del-testbed). En resumen: un **PID** es el identificador de cada flujo elemental dentro de un MPEG-TS. Los valores coinciden con los que produce FFmpeg en la fuente: 256 (`0x100`) para el primer vídeo y los siguientes en orden. Son los mismos que usa `tsgate.py` para reconocer los frames de cada calidad.

En `si`, las claves son números en decimal escritos como texto: `17` es el PID `0x0011` y `66` es el identificador de tabla `0x42`. Corresponden a la tabla de descripción de servicio (SDT), la que lleva el nombre del servicio y del proveedor. Su contenido no va en el catálogo sino en una pista aparte (`0x0011-0x42.si`), y `interval` indica cada cuántos milisegundos debe repetirse al reconstruir el flujo.

Nada de esta sección afecta a la reproducción en el navegador.

### B.13. Las secciones que este catálogo no lleva

**`text`**: subtítulos. Una rendition por idioma o variante.

```json
"text": {
  "renditions": {
    "subs-es": { "format": "vtt", "role": "subtitle", "lang": "es", "label": "Español" }
  }
}
```

| Campo | Significado |
| :--- | :--- |
| `format` | Formato de cada subtítulo: `vtt` (WebVTT), `ttml` o `utf8` (texto sin formato). |
| `role` | `subtitle` (solo diálogos) o `caption` (todo el audio, para personas sordas). Por defecto, `subtitle`. |
| `lang` | Idioma, en notación BCP 47: `es`, `en`, `es-419`. |
| `label`, `container`, `jitter`, `delay`, `broadcast` | Como en vídeo y audio. |

**`json` y `binary`**: datos de aplicación que no son media, como un marcador deportivo, la posición de un dron o un chat.

```json
"json": {
  "tracks": {
    "marcador": { "mode": "snapshot", "schema": "https://ejemplo.org/marcador.schema.json" }
  }
}
```

| Campo | Significado |
| :--- | :--- |
| `mode` | `snapshot`: cada grupo sustituye al anterior y solo importa el último valor. `stream`: un registro sin pérdidas, donde importan todos los valores en orden. Obligatorio. |
| `compression` | `deflate` si los frames van comprimidos; ausente si no. |
| `schema` | Identificador de la forma de los datos. Solo descriptivo. |
| `bitrate`, `jitter`, `delay`, `broadcast` | Como en vídeo y audio. |

Aquí la clave del mapa es `tracks`, no `renditions`: las entradas son pistas distintas, no versiones alternativas entre las que elegir.

### B.14. Con varias calidades

Con la escalera de tres calidades, el importador publica tres renditions de vídeo. No capturé ese catálogo entero, pero sí los nombres y los bitrates que vio el reproductor:

| Pista | Calidad | Bitrate nominal | `bitrate` en el catálogo (dos emisiones) |
| :--- | :--- | :--- | :--- |
| `0.avc3` | 1080p | 4000 kbit/s | 6950 y 6648 kbit/s |
| `1.avc3` | 720p | 2000 kbit/s | 3393 y 3259 kbit/s |
| `2.avc3` | 360p | 700 kbit/s | 1249 y 1111 kbit/s |

Ninguna de las tres declaraba `jitter` ni `delay`. El audio pasa a ser la pista siguiente en el orden del MPEG-TS.

El orden de las calidades es el de la fuente, que las emite de mayor a menor. El reproductor no depende de ese orden: las ordena él por resolución o por bitrate.

### B.15. Qué usa el reproductor, y comparación con el MPD

**Lo que `@moq/watch` usa de este catálogo para reproducir vídeo:**

| Campo | Para qué |
| :--- | :--- |
| Clave de `renditions` | Nombre de la pista a la que suscribirse. |
| `codec`, `description`, `optimizeForLatency`, `displayAspect*` | Configurar el decodificador, y comprobar antes que el navegador lo admite. |
| `container` | Elegir cómo extraer el frame y su marca de tiempo. |
| `codedWidth`, `codedHeight` | Ordenar las calidades y aplicar límites de resolución. |
| `bitrate` | Adaptación automática. |
| `stalled` | Excluir calidades de la adaptación automática. |
| `framerate`, `jitter`, `delay` | Dimensionar el búfer. |
| `display`, `rotation`, `flip` | Pintar el canvas. |

No usa `archive`, `clock` ni `mpegts`.

**Los dos documentos, lado a lado:**

| Función | MPD (DASH) | Catálogo (MoQ) |
| :--- | :--- | :--- |
| Cómo se obtiene | Petición HTTP; se relee cada cierto tiempo | Suscripción a una pista; llegan los cambios |
| Formato | XML | JSON |
| Agrupar versiones intercambiables | `AdaptationSet` | Sección `video` o `audio` |
| Una versión concreta | `Representation` | Entrada de `renditions` |
| Códec | `codecs` | `codec` |
| Configuración del decodificador | Segmento de inicialización | `description`, o dentro del flujo |
| Resolución | `width`, `height` | `codedWidth`, `codedHeight` |
| Bitrate | `bandwidth` (aquí, el nominal declarado a mano) | `bitrate` (aquí, un máximo medido) |
| Localizar la media | `SegmentTemplate`: plantilla, numeración y duración | El nombre de la pista |
| Cuándo existe cada trozo | `availabilityStartTime`, `availabilityTimeOffset` | No hace falta: el relay empuja |
| Reloj común | `UTCTiming`, imprescindible | No hace falta |
| Tiempo de medios y reloj | `availabilityStartTime`, `ProducerReferenceTime` | `clock`, opcional |
| Puntos de entrada | `startWithSAP`, `Resync` | Implícito: cada grupo empieza en uno |
| Latencia sugerida por el servicio | `ServiceDescription` (aquí vacío) | `jitter` y `delay`, que el reproductor suma siempre |
| Estado de una calidad en directo | No existe | `stalled` |
| Contenido pasado | `timeShiftBufferDepth` | `archive` |

La diferencia de tamaño entre los dos anexos refleja la de los modelos. En DASH el cliente tira, así que el manifiesto tiene que darle una forma de calcular qué pedir y cuándo, y un reloj fiable para hacerlo. En MoQ el servidor empuja, y al catálogo le basta con decir qué hay y cómo decodificarlo. A cambio, el catálogo lleva dos cosas que el MPD no tiene: el estado en vivo de cada calidad y la irregularidad del propio publicador.

---

## Anexo C. MPEG-TS: el formato intermedio del testbed

MPEG-TS aparece en varios puntos de este documento sin haberse explicado: es lo que sale de la fuente, lo que lee `tsgate.py`, lo que consume cada empaquetador y lo que describe la sección `mpegts` del catálogo de MoQ. Este anexo explica qué es, cómo está hecho por dentro y qué papel cumple aquí.

Lo primero, para situarlo: **MPEG-TS no llega nunca al navegador**. Solo existe dentro del servidor, en el tramo que va de la fuente a los tres empaquetadores. Cada rama lo deshace y vuelve a empaquetar el vídeo en su propio formato.

```
                      ┌── MPEG-TS ──▶ tsgate ──▶ ffmpeg -f dash ──▶ CMAF  (DASH)
Fuente (FFmpeg) ──────┼── MPEG-TS ──▶ tsgate ──▶ moq import ts  ──▶ frames MoQ
codifica y multiplexa └── MPEG-TS ──▶ tsgate ──▶ MediaMTX (UDP) ──▶ RTP   (WebRTC)

                      └─────── dentro del servidor ───────┘        └─ hacia el navegador ─┘
```

### C.1. Qué es un contenedor y por qué hace falta

Un codificador produce **flujos elementales**: una sucesión de frames de vídeo comprimidos por un lado, y una sucesión de frames de audio por otro. Eso, tal cual, no se puede transmitir ni guardar de forma útil, porque faltan tres cosas:

- **Juntarlos.** Vídeo y audio tienen que viajar por el mismo canal, mezclados en orden.
- **Sincronizarlos.** Hay que saber en qué instante se muestra cada frame y cuál de audio le corresponde.
- **Describirlos.** Quien lo recibe tiene que saber qué hay dentro: cuántas pistas y de qué códec.

Un **contenedor** es el formato que resuelve esas tres cosas. No comprime nada: envuelve lo ya comprimido. MP4, MPEG-TS, Matroska o WebM son contenedores. El proceso de juntar los flujos se llama **multiplexar**, y el de separarlos, **demultiplexar**.

MPEG-TS (*MPEG Transport Stream*, también llamado M2TS o simplemente TS) es el contenedor diseñado en los años noventa para la **televisión digital**: satélite, cable, TDT. Está definido en la norma ISO/IEC 13818-1. Sigue siendo el formato de la emisión televisiva y de buena parte de la contribución profesional, y es también el formato original de los segmentos de HLS.

### C.2. La idea de diseño: poder engancharse en cualquier momento

Un MP4 normal tiene una cabecera con el índice de todo el fichero. Sin ella no se puede leer nada, y no se puede escribir hasta saber cuánto dura el contenido. Sirve para ficheros, no para una emisión que no termina nunca.

MPEG-TS se diseñó para el caso contrario: una emisión continua, por un canal con errores, a la que los receptores se conectan cuando quieren (al encender el televisor o cambiar de canal). De ahí salen sus cuatro decisiones de diseño:

| Decisión | Consecuencia |
| :--- | :--- |
| Paquetes de tamaño fijo, 188 bytes | Tras un error, el receptor encuentra el siguiente paquete sin interpretar nada: basta contar. |
| Sin cabecera global ni final | El flujo no tiene principio. Se puede empezar a leer por cualquier paquete. |
| La descripción del contenido se repite periódicamente | Quien llega tarde la recibe en una fracción de segundo. |
| Cada paquete lleva un contador | Se detecta si se ha perdido alguno. |

Es justo lo que necesita el testbed, y la razón de haberlo elegido como formato intermedio (C.9).

### C.3. El paquete de 188 bytes

Todo el flujo es una sucesión de paquetes idénticos en tamaño: 4 bytes de cabecera y 184 de carga.

```
┌────────────── 4 bytes ──────────────┬──────────────── 184 bytes ────────────────┐
│ cabecera                            │ carga (o campo de adaptación + carga)     │
└─────────────────────────────────────┴───────────────────────────────────────────┘
```

Los 32 bits de la cabecera:

| Campo | Bits | Significado |
| :--- | :--- | :--- |
| Byte de sincronización | 8 | Siempre `0x47`. Marca el inicio de cada paquete. |
| Indicador de error | 1 | El receptor de radiofrecuencia lo activa si no pudo corregir el paquete. |
| **Inicio de unidad** | 1 | Este paquete empieza algo nuevo: un frame o una tabla. |
| Prioridad | 1 | Apenas se usa. |
| **PID** | 13 | A qué flujo pertenece el paquete. |
| Cifrado | 2 | Si la carga va cifrada (televisión de pago). |
| Control de adaptación | 2 | Si hay campo de adaptación, carga, o ambos. |
| **Contador de continuidad** | 4 | Se incrementa en cada paquete del mismo PID: 0, 1, …, 15, 0, … |

Los tres campos en negrita son los que usa el testbed.

**El PID** (*Packet Identifier*) es la clave de todo el formato. Es un número de 13 bits, de 0 a 8191, que dice a qué flujo pertenece el paquete. Los paquetes de vídeo, de audio y de tablas van mezclados en la misma sucesión, y el PID es lo que permite separarlos: para sacar el vídeo basta quedarse con los paquetes de su PID.

```
PID:   256  256  257  256  256    0  256  256  257  256 4096  256 ...
       vídeo     audio          PAT            audio     PMT
```

**El contador de continuidad** permite detectar pérdidas. Si de un PID llegan los paquetes con contador 7, 8 y 10, falta el 9. Solo tiene 4 bits, así que detecta la pérdida pero no dice cuántos paquetes faltan si son 16 o más.

**El campo de adaptación** es una extensión opcional de la cabecera, que ocupa parte de los 184 bytes. Lleva tres cosas relevantes:

| Contenido | Para qué |
| :--- | :--- |
| **PCR** | La referencia de reloj del emisor (C.6). |
| **Indicador de acceso aleatorio** | Marca que en este paquete empieza un punto por el que se puede empezar a decodificar: un keyframe. |
| Relleno | Bytes de relleno para completar los 188 cuando la carga no llega. |

Hay además un PID reservado, el 8191 (`0x1FFF`), para **paquetes nulos**: relleno sin contenido que se inserta para mantener un caudal constante. En televisión son habituales; en el testbed, la fuente no los genera.

### C.4. De un frame a paquetes: la capa PES

Un frame de vídeo no cabe en 184 bytes. Entre el frame y los paquetes hay una capa intermedia, el **PES** (*Packetized Elementary Stream*).

1. Cada frame se envuelve en un paquete PES: una pequeña cabecera, que incluye sus marcas de tiempo, seguida del frame.
2. Ese PES se trocea en porciones de 184 bytes.
3. Cada porción va en un paquete TS con el PID de su flujo. El primero lleva activado el indicador de inicio de unidad.

```
Frame de vídeo (8300 bytes)
        │
        ▼
┌─────────────┬──────────────────────────────────────────┐
│ cabecera PES│ frame H.264                              │   un PES
│ (PTS, DTS)  │                                          │
└─────────────┴──────────────────────────────────────────┘
        │  se trocea en porciones de 184 bytes
        ▼
[TS inicio=1][TS][TS][TS][TS] ... [TS + relleno]            ≈ 46 paquetes, todos con PID 256
```

Con los valores por defecto del testbed, en órdenes de magnitud:

| Unidad | Tamaño aproximado | Paquetes TS |
| :--- | :--- | :--- |
| Frame medio de vídeo (1080p a 4 Mbit/s y 60 fps) | 8,3 kB | Unos 46 |
| Keyframe | Varias veces mayor | Varios cientos |
| Frame de audio (AAC a 128 kbit/s) | 340 bytes | 2 |

En total, unos 2900 paquetes por segundo para una calidad.

**Cómo se sabe dónde acaba un frame.** La cabecera PES tiene un campo de longitud, pero en vídeo suele valer 0, que significa "sin límite declarado". El final de un frame se reconoce entonces porque **empieza el siguiente**: llega un paquete del mismo PID con el indicador de inicio activado. Así lo hace `tsgate.py`. Tiene una consecuencia: quien lee el flujo no puede dar un frame por completo hasta ver el principio del siguiente, 17 ms después a 60 fps. `tsgate.py` lo compensa anotando la hora de llegada del *último* paquete de cada frame, no la del momento en que supo que había terminado. Medido el 29-10-2026 para el empaquetador de DASH (FFmpeg), con fragmentos de 1 frame a 60 fps: la etapa "Empaquetado CMAF" tiene una mediana de unos 50 ms por frame (51 ms en el servidor, 50,4 ms en local), casi constante, es decir, 3 frames. Leer el MPEG-TS, por sí solo, retiene cada frame 33,5 ms (2 frames): medido con un FFmpeg aislado que copia el vídeo a una salida que escribe cada frame al instante, alimentado a ritmo real; `-fflags nobuffer` no lo cambia. Que sea un frame por el final de PES (arriba) y otro por el analizador de H.264, que delimita cada frame al ver empezar el siguiente, es una deducción, no una medida separada. El tercer frame está en la escritura del fragmento MP4 y su envío al origen; que se deba a que el muxer necesita la marca de tiempo del frame siguiente para calcular la duración del anterior también es una deducción. Ni el audio ni el intercalado influyen: sin audio, 50,4 ms; con `-max_interleave_delta 1`, 50,5 ms. Es un coste de esta implementación y de usar MPEG-TS como formato intermedio, no del protocolo DASH. Medido también el 29-10-2026 en local, sobre la misma emisión (1080p60, una calidad) y en tres pasadas, desde la llegada del último paquete de cada frame hasta que sale de cada programa: MediaMTX lo retiene 17 ms (1 frame: lectura del MPEG-TS y reempaquetado a RTP, observado con un lector RTSP en la propia máquina), el publicador de MoQ 34 ms (2 frames, cota superior: incluye el relay y un suscriptor `moq export h264` en la propia máquina) y FFmpeg 50,5 ms (3 frames). En MoQ y WebRTC ese tiempo queda dentro de la etapa "Publicación y transporte"; en DASH, en la de empaquetado (ver la variable de confusión 8 de 6.4).

### C.5. Las tablas: cómo se describe el contenido

Con solo paquetes y PID, el receptor no sabría qué PID lleva qué. Esa información viaja en el propio flujo, en **tablas** (PSI, *Program Specific Information*) que ocupan sus propios PID y se repiten varias veces por segundo.

Se leen en cadena:

```
PAT  (PID 0, siempre)
 └─▶ "el programa 1 se describe en el PID 4096"
        │
        ▼
PMT  (PID 4096)
 └─▶ "el programa 1 tiene: vídeo H.264 en el PID 256
                           audio AAC   en el PID 257"
        │
        ▼
     paquetes con PID 256 y 257: la media
```

| Tabla | PID | Contenido |
| :--- | :--- | :--- |
| **PAT** (*Program Association Table*) | 0, fijo | La lista de programas del flujo y en qué PID está la PMT de cada uno. Es el punto de entrada: su PID es el único que se conoce de antemano. |
| **PMT** (*Program Map Table*) | El que indique la PAT | Para un programa: qué flujos lo componen, de qué tipo es cada uno y en qué PID va. |
| **SDT** (*Service Description Table*) | 17 | Nombre del servicio y del proveedor. Es de la norma DVB, no imprescindible para decodificar. |

Un **programa** es lo que en televisión se llama un canal: un conjunto de flujos que se reproducen juntos. Un mismo MPEG-TS puede llevar varios, y así viajan varios canales por una sola frecuencia de TDT. El del testbed lleva uno solo.

Los valores concretos del testbed son los que FFmpeg usa por defecto:

| Qué | PID | En hexadecimal |
| :--- | :--- | :--- |
| PAT | 0 | `0x0000` |
| SDT | 17 | `0x0011` |
| PMT | 4096 | `0x1000` |
| Primer flujo (el vídeo de mayor calidad) | 256 | `0x0100` |
| Flujos siguientes | 257, 258, … | `0x0101`, … |

Con una calidad, el vídeo va en el PID 256 y el audio en el 257. Con tres, los vídeos ocupan 256, 257 y 258, de mayor a menor calidad, y el audio pasa al 259. **Las tres calidades viajan en el mismo flujo**, como tres pistas de vídeo de un mismo programa.

Esto explica la sección `mpegts` del catálogo de MoQ (B.12), que ahora se puede leer entera:

```json
"mpegts": {
  "tracks":  { "0.avc3": { "pid": 256 }, "1.aac": { "pid": 257 } },
  "program": { "transportStreamId": 1, "programNumber": 1, "pmtPid": 4096 },
  "si":      { "17": { "66": { "track": "0x0011-0x42.si", "interval": 2000 } } }
}
```

- `tracks`: los PID que la PMT asignaba al vídeo y al audio.
- `program`: lo que decía la PAT. Un flujo con identificador 1, que lleva el programa 1, descrito en el PID 4096.
- `si`: la SDT, que viajaba en el PID 17 y tiene el identificador de tabla 66 (`0x42`).

El importador de MoQ guarda todo eso porque, al convertir el flujo en pistas de MoQ, esa información se perdería. Con ella, otra herramienta podría reconstruir un MPEG-TS equivalente al original a la salida del relay.

### C.6. El tiempo: PTS, DTS y PCR

MPEG-TS mide el tiempo con un reloj de **90 000 unidades por segundo** (90 kHz). Hay tres marcas:

| Marca | Dónde va | Qué indica |
| :--- | :--- | :--- |
| **PTS** (*Presentation Time Stamp*) | Cabecera PES | En qué instante debe mostrarse el frame. |
| **DTS** (*Decoding Time Stamp*) | Cabecera PES | En qué instante debe decodificarse. Solo difiere del PTS si hay B-frames. |
| **PCR** (*Program Clock Reference*) | Campo de adaptación | La hora del reloj del emisor, para que el receptor ajuste el suyo. |

**El PTS** es la marca de tiempo de cada frame. A 60 fps, dos frames consecutivos distan 90 000 / 60 = **1500 unidades**. Es un número de 33 bits, así que da la vuelta cada 26,5 horas.

```
frame n     PTS = 1 260 000
frame n+1   PTS = 1 261 500     (+1500 = 1/60 s)
frame n+2   PTS = 1 263 000
```

El testbed usa el PTS para **identificar frames**. Las marcas de etapa del desglose de latencia se guardan por PTS: `tsgate.py` anota a qué hora llegó el frame con cada PTS, y el orquestador calcula el PTS de un frame a partir de su número de orden (PTS del frame 0 más 1500 por frame).

**El DTS** existe porque, con B-frames, el orden de decodificación no coincide con el de presentación. La fuente del testbed no los usa (`-tune zerolatency`), así que DTS y PTS coinciden.

**El PCR** resuelve un problema propio de la emisión televisiva: el receptor no tiene forma de preguntar la hora al emisor, y su reloj va ligeramente más rápido o más lento. El emisor inserta su hora varias veces por segundo y el receptor ajusta su reloj a ella, para consumir exactamente al ritmo al que se emite. En el testbed no cumple ninguna función práctica: los empaquetadores procesan el flujo según llega.

### C.7. Cómo viaja dentro del servidor

La fuente envía el MPEG-TS por **UDP** a tres puertos locales, uno por rama:

| Puerto | Rama |
| :--- | :--- |
| 5001 | DASH |
| 5002 | MoQ |
| 5003 | WebRTC |

Cada datagrama UDP lleva **7 paquetes TS**: 7 × 188 = 1316 bytes. Es el tamaño habitual, porque es el mayor múltiplo de 188 que cabe en un paquete de red corriente sin fragmentarse. Corresponde a la opción `pkt_size=1316`.

El reparto lo hace el multiplexor `tee` de FFmpeg, que escribe el mismo flujo en los tres destinos. Las tres ramas reciben **exactamente los mismos paquetes**.

UDP no garantiza la entrega ni siquiera dentro de una misma máquina: si un empaquetador lee más despacio de lo que la fuente escribe, el búfer del sistema se llena y se descartan datagramas. Esa pérdida afectaría solo a una rama y falsearía la comparación, y por eso se vigila (C.8).

### C.8. Qué hace `tsgate.py`

Es un programa pequeño colocado entre la fuente y cada empaquetador: lee los datagramas UDP y los escribe por una tubería (en la rama WebRTC, desde el 29-10-2026, los reenvía por UDP a MediaMTX, solo con las pistas que este debe servir). Usa directamente los campos descritos arriba, para tres cosas.

**1. Empezar en un keyframe.** Los empaquetadores arrancan en un instante cualquiera de la emisión. La compuerta descarta todo hasta ver un paquete del PID 256 con el **indicador de acceso aleatorio** activado: ahí empieza un keyframe. Mientras espera, guarda la última copia de la PAT, la SDT y la PMT, y las envía justo antes de ese keyframe, para que el empaquetador pueda interpretar el flujo desde el primer byte. Así las tres ramas empiezan en un punto limpio.

**2. Vigilar la continuidad.** Para cada PID comprueba que el **contador de continuidad** avanza de uno en uno. Si no, escribe una línea como esta:

```
continuity check failed: pid=257 expected=9 got=10
```

Significa que del PID 257 se esperaba el paquete con contador 9 y llegó el 10: se ha perdido uno. El orquestador cuenta esas líneas y las muestra como **anomalías de ingesta**. Con el servidor saturado se llegaron a ver 203 en la rama de MoQ; con 8 núcleos, ninguna.

**3. Anotar cuándo llega cada frame.** Cada vez que ve un paquete con el **indicador de inicio de unidad** en un PID de vídeo, lee el **PTS** de la cabecera PES que empieza ahí y da por terminado el frame anterior. Envía al orquestador el PTS de cada frame junto con dos horas: cuándo llegó su último paquete al sistema y cuándo se reenvió al empaquetador. Son las etapas "Codificación" y "Entrada al empaquetador" del desglose de latencia.

No modifica ningún byte de la media: solo decide por dónde empezar y observa.

### C.9. Por qué se usa aquí, y qué coste tiene

**Por qué MPEG-TS como formato intermedio:**

- **Los empaquetadores pueden arrancar y reiniciarse por separado.** Como el flujo no tiene principio, cualquiera puede engancharse a mitad de emisión. Es lo que permite que el supervisor reinicie una rama sin tocar las otras ni la fuente.
- **Es un formato que las tres herramientas saben leer:** FFmpeg para DASH y WebRTC, y el importador de MoQ.
- **Lleva varias pistas de vídeo en un mismo flujo**, lo que permite enviar toda la escalera de calidades de una vez.
- **Sus marcas de inicio de frame y de keyframe son fáciles de leer** sin decodificar el vídeo, que es lo que hace posible la compuerta.

**Lo que cuesta:**

- **Sobrecarga.** 4 bytes de cabecera por cada 188 son un 2 %, más las cabeceras PES, las tablas y el relleno. Solo afecta al tramo interno.
- **El final de cada frame se conoce con un frame de retraso** (C.4).
- **Un único canal para todo.** Vídeo, audio y tablas se serializan en una sola sucesión de paquetes, así que el multiplexor tiene que decidir en qué orden los escribe.

Ese último punto es el origen de dos problemas de la fuente, ambos causados por el audio y ambos ya corregidos. Se manifestaban igual: el vídeo, que entra al codificador cada 16,7 ms, salía a ráfagas.

**1. El agrupado de audio en un PES.** Por defecto, el multiplexor de MPEG-TS de FFmpeg agrupa varios frames de audio en un mismo PES, unos 180 ms, para ahorrar cabeceras. El vídeo intercalado con ese audio se retenía ese tiempo. La opción `pes_payload_size=0` lo desactiva: un PES por cada frame de audio.

**2. El acoplamiento entre vídeo y audio dentro de FFmpeg** (corregido el 13 de octubre de 2026). Eran dos mecanismos distintos que se sumaban:

- **Un grafo de filtros compartido.** El vídeo y el audio pasaban por un único grafo de filtros. FFmpeg alimenta un grafo pidiendo frames a sus entradas por turnos, según sus marcas de tiempo, de modo que el vídeo avanzaba al compás de los frames de audio del fichero de origen (MP3, 24 ms cada uno) en vez de al suyo. Ahora el audio tiene su propio grafo (`-filter_complex` aparte).
- **El intercalado estricto del multiplexor.** Para escribir los paquetes en orden exacto de tiempo, FFmpeg retiene cada frame de vídeo hasta tener un paquete de audio posterior. Como el audio llega más espaciado, el vídeo salía de dos en dos. La opción `-max_interleave_delta 1` hace que cada paquete se escriba en cuanto está listo.

Hacían falta los dos cambios: cada uno por separado solo lo arreglaba a medias.

| Fuente con tres calidades, 20 s, calidad 1080p | Mediana | p95 | Máximo | Huecos > 33 ms | Huecos > 50 ms |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Antes | 15,9 ms | 45,2 ms | 93,7 ms | 156 | 25 |
| Solo el grafo separado (una calidad, 15 s) | 16,4 ms | 36,3 ms | 45,8 ms | 117 | 0 |
| Solo `-max_interleave_delta 1` | 15,0 ms | 48,9 ms | 74,8 ms | 146 | 50 |
| Los dos cambios | 16,3 ms | 24,1 ms | 38,0 ms | 8 | 0 |
| Referencia: la misma fuente sin audio | 16,4 ms | 24,1 ms | 36,0 ms | 3 | 0 |

Las cifras son la separación entre frames consecutivos a la salida de la fuente; lo ideal es 16,7 ms. Con los dos cambios queda igual que sin audio.

El arreglo tiene un segundo efecto, que beneficia a las tres ramas: como el vídeo ya no espera al audio, la etapa de codificación del desglose baja de unos 30 ms a unos 10 ms de mediana.

La contrapartida es que vídeo y audio ya no van intercalados en orden estricto de tiempo dentro del MPEG-TS: el audio de un instante puede ir unas decenas de milisegundos detrás del vídeo del mismo instante. Los tres empaquetadores lo aceptan, y las marcas de tiempo de cada frame no cambian.

### C.10. Lo que hace cada rama con el flujo

Las tres hacen lo mismo en esencia: demultiplexar, es decir, separar los paquetes por PID, reconstruir los PES y extraer los frames con su PTS. Lo que cambia es en qué los vuelven a envolver.

| Rama | Herramienta | Qué toma | En qué lo convierte |
| :--- | :--- | :--- | :--- |
| DASH | `ffmpeg -f dash` | Todos los vídeos y el audio | Fragmentos CMAF: cada frame pasa a un `mdat`, y su PTS a los tiempos del `moof`. |
| MoQ | `moq import ts` | Todos los vídeos y el audio | Una pista por PID; cada frame, un frame de MoQ con su marca de tiempo; cada keyframe abre un grupo. |
| WebRTC | MediaMTX, que lee el MPEG-TS por UDP (antes, `ffmpeg -f rtsp`) | Solo el primer vídeo (PID 256), y el audio con `rtc_audio`: la compuerta filtra el resto y rehace la PMT | Paquetes RTP hacia el navegador. |

En ninguna se recodifica: los bytes de H.264 de cada frame son los mismos a la entrada y a la salida. Lo que se desecha es el envoltorio de MPEG-TS, es decir, las cabeceras de 188 bytes, los PES y las tablas. El importador de MoQ conserva además un resumen de esas tablas en el catálogo.

Dos detalles de cómo se trata el PTS:

- **DASH** resta a todo el flujo el PTS del primer frame que recibe, de modo que el tiempo de medios empieza en 0. Por eso importa que la compuerta haga empezar el flujo en un keyframe.
- **MoQ** reescribe las marcas de tiempo con un desfase propio. Por esa razón el testbed no puede seguir un frame por su marca de tiempo en la rama de MoQ, y lo identifica por el timecode quemado en la imagen.

### C.11. Vocabulario

| Término | Significado |
| :--- | :--- |
| Flujo elemental | La salida de un codificador: solo vídeo o solo audio. |
| Multiplexar / demultiplexar | Mezclar varios flujos en uno / separarlos. |
| Paquete TS | La unidad de 188 bytes. |
| PID | Identificador de flujo que lleva cada paquete. |
| PES | Envoltorio de cada frame, con sus marcas de tiempo, antes de trocearlo. |
| PAT, PMT | Tablas que describen qué programas hay y qué flujos tiene cada uno. |
| SDT | Tabla con el nombre del servicio. |
| Programa | Conjunto de flujos que se reproducen juntos: un canal. |
| PTS, DTS | Instante de presentación y de decodificación de un frame, a 90 kHz. |
| PCR | Referencia de reloj del emisor. |
| Contador de continuidad | Contador de 4 bits por PID para detectar pérdidas. |
| Indicador de acceso aleatorio | Marca de que empieza un keyframe. |
| Paquete nulo | Relleno, en el PID 8191. |

---

## Anexo D. Cómo se mide la latencia

Este anexo explica cómo obtiene el testbed sus dos medidas de latencia: la total (*glass-to-glass*) y su reparto por etapas. En particular, cómo se sabe que la hora anotada en cada punto corresponde al mismo frame.

El principio que lo rige todo: **se mide igual en las tres ramas, y se mide lo que se ve**. No se usa la latencia que declara cada reproductor, porque cada uno la define a su manera y ninguna incluye todo el recorrido. Se lee en la imagen.

### D.1. El timecode quemado

Antes de codificar, la fuente dibuja en cada frame la hora a la que lo procesa. No como texto, sino como una fila de cuadros blancos y negros en la esquina inferior izquierda, que una máquina puede leer sin ambigüedad aunque la compresión emborrone la imagen.

```
┌──────┬──────┬────┬────┬────┬─────┬────┬──────┬──────┐
│blanco│negro │ b19│ b18│ b17│ ... │ b0 │negro │blanco│
└──────┴──────┴────┴────┴────┴─────┴────┴──────┴──────┘
 referencias     20 cuadros: un bit cada uno     referencias
```

| Característica | Valor | Motivo |
| :--- | :--- | :--- |
| Qué codifica | La hora del servidor, en milisegundos | Es la referencia común a todo el recorrido. |
| Cuántos bits | 20 | Cabe un ciclo de 2²⁰ ms = 17,5 minutos, mucho más que cualquier latencia. |
| Tamaño de cada cuadro | 32 px, o 16 px en las calidades pequeñas | Alineado con los bloques de compresión, para que sobreviva a ella. |
| Cuadros de los extremos | Blanco y negro fijos | Dan el umbral de lectura y delatan una imagen sin timecode. |
| Codificación | Código Gray | Ver abajo. |

Cada calidad lleva su propio timecode, dibujado después de escalarla. Un timecode pensado para 1080p y reducido a 360p tendría cuadros de pocos píxeles, ilegibles tras la compresión.

**Por qué código Gray.** En binario normal, pasar de 7 a 8 cambia cuatro bits a la vez (`0111` → `1000`). Si la lectura de un cuadro falla justo en ese momento, puede salir cualquier número. En código Gray, dos valores consecutivos difieren siempre en **un solo bit**, así que un fallo de lectura en la transición produce como mucho un error de 1 ms.

**Por qué solo 20 bits.** La hora completa en milisegundos necesita unos 41 bits. Se queman solo los 20 más bajos, y el navegador reconstruye el resto con su propia hora: sabe qué hora es con un margen muy inferior a 17,5 minutos, así que solo hay una hora posible que termine en esos 20 bits.

```
hora al leer el frame (servidor):   1 791 554 900 123 ms   → sus 20 bits bajos valen 938 139
valor leído en el timecode:                                                      937 839
diferencia dentro del ciclo:        938 139 − 937 839 = 300 ms
instante del quemado:               1 791 554 900 123 − 300 = 1 791 554 899 823 ms
```

### D.2. Poner de acuerdo los dos relojes

El timecode lleva la hora **del servidor**. Para restarla de "ahora", el navegador tiene que saber qué hora es en el servidor, no en su propio reloj, que puede ir desviado.

Cada 10 segundos el navegador pregunta la hora al servidor (`GET /api/time`) varias veces seguidas. En cada consulta apunta cuándo la envió y cuándo recibió la respuesta, y supone que la hora del servidor corresponde al punto medio:

```
desfase = hora que responde el servidor − (hora de envío + hora de recepción) / 2
```

De todas las consultas se queda con la de **menor tiempo de ida y vuelta**, que es la que menos margen de error tiene.

| Dato | Ejemplo |
| :--- | :--- |
| Envío, en el reloj del navegador | 12:00:00,000 |
| Recepción, en el reloj del navegador | 12:00:00,006 |
| Hora que respondió el servidor | 12:00:00,105 |
| Punto medio | 12:00:00,003 |
| Desfase | +102 ms: el servidor va 102 ms adelantado |
| Incertidumbre | ±3 ms: la mitad de los 6 ms de ida y vuelta |

La incertidumbre sale de que no se sabe cómo se repartieron esos 6 ms entre la ida y la vuelta. Se muestra en el panel y se guarda en el CSV (`clock_offset_ms`, `clock_rtt_ms`). **Es el límite de exactitud de toda medida que compare una hora del servidor con una del navegador.** Afecta por igual a las tres ramas, así que no altera las diferencias entre ellas.

### D.3. La latencia *glass-to-glass*

Con el timecode y los relojes sincronizados, la medida es una resta. En cada refresco de pantalla, para cada reproductor:

1. Se toma el frame que el reproductor acaba de mostrar.
2. Se lee su timecode.
3. Se calcula `latencia = hora actual del servidor − hora quemada en el frame`.

La tarjeta muestra la mediana del último segundo.

| Incluye | No incluye |
| :--- | :--- |
| Codificación | La lectura y decodificación del fichero de origen, anteriores al quemado |
| Empaquetado | El último tramo hasta la pantalla: composición y refresco del monitor, de uno a dos refrescos |
| Red | |
| Búfer del reproductor | |
| Decodificación y pintado | |

Lo que queda fuera es idéntico en las tres ramas.

El frame se identifica a sí mismo: no hace falta saber nada más de él que lo que lleva dibujado. Por eso esta medida es la más sólida del testbed.

**La medida supone que la fuente va al ritmo del tiempo real, y no siempre es así.** El timecode es la hora a la que FFmpeg dibuja el frame, pero su PTS es solo su número por la duración de un frame. Si FFmpeg se atasca X ms (falta de CPU, por ejemplo), los frames siguientes llevan una marca X ms más tarde con el PTS que les tocaba. Los tres reproductores programan la imagen por PTS, de modo que la pintan a su hora y la resta da X ms menos: la latencia medida baja a la vez y casi lo mismo en las tres ramas, sin que nada haya llegado antes. El búfer lo paga: en MoQ, la referencia de reproducción solo se mueve hacia abajo (`js/watch/src/sync.ts`), así que el búfer queda en el objetivo menos X hasta que la fuente se pone al día y manda frames antes de su hora; si X pasa del objetivo, se vacía y cada frame se pinta según llega, a unos ~50 ms, sin ningún parón porque los frames siguen llegando. WebRTC reajusta por su cuenta su correspondencia entre RTP y reloj y sale de otra manera, con congelados y picos. Un retraso de la red, en cambio, nunca baja la latencia: o lo absorbe el búfer o la sube. Por eso, una latencia por debajo del objetivo en las tres ramas a la vez delata a la fuente. Desde el 30-10-2026 el orquestador mide ese retraso en cada segundo (README, tabla de métricas, **Retraso de la fuente**).

**El lector no debe alterar lo que mide.** Lee solo dos filas de píxeles de la franja del timecode, de forma asíncrona. Una versión anterior copiaba la imagen entera en cada frame y saturaba la página hasta degradar al reproductor de MoQ: las medidas anteriores a ese cambio no son válidas.

### D.4. El desglose por etapas: la idea

La latencia total dice cuánto, pero no dónde. Para repartirla hay que anotar la hora a la que **un mismo frame** pasa por varios puntos del recorrido y restar cada par consecutivo.

```
quemado ──▶ salida del ──▶ entrega al ──▶ (fragmento ──▶ llegada al ──▶ pintado
            codificador    empaquetador    completo)     reproductor
   │             │              │              │              │            │
   └── etapa 1 ──┴── etapa 2 ───┴─── etapa 3 ──┴── etapa 4 ───┴─ etapa 5 ──┘
```

Como cada etapa es la diferencia entre dos horas del mismo frame, **las etapas suman exactamente su latencia total**. No hay estimaciones ni repartos proporcionales.

La dificultad está en reconocer el frame en cada punto. El timecode solo se puede leer donde hay imagen: al principio (la fuente sabe qué quemó) y al final (el navegador lo lee). En medio, el frame es un bloque de bytes comprimidos, y cada tramo lo identifica de otra manera.

### D.5. Cómo se sigue un frame de punta a punta

Cinco veces por segundo, el navegador elige un frame recién pintado y reconstruye su recorrido. La cadena de identificadores es esta:

| Paso | De qué se parte | Qué se obtiene | Cómo |
| :--- | :--- | :--- | :--- |
| 1 | La imagen pintada | La hora quemada | Leyendo el timecode. |
| 2 | La hora quemada | El número de orden del frame | Registro de la fuente. |
| 3 | El número de orden | Su PTS | Una cuenta. |
| 4 | El PTS | Horas de salida del codificador y de entrega | Registro de la compuerta. |
| 5 | El PTS (solo DASH) | Hora en que se completó su fragmento | Registro del origen. |
| 6 | El frame pintado | Su hora de llegada al reproductor | Distinto en cada reproductor. |

**Paso 2: de la hora al número de frame.** Al quemar el timecode, FFmpeg escribe en su registro, para cada frame, la hora exacta que quemó y su número de orden (0, 1, 2, …). El servidor guarda esa lista. Cuando el navegador envía una hora, busca el frame cuya hora coincide, con 4 ms de tolerancia. Como los frames distan 16,7 ms, no hay confusión posible.

**Paso 3: del número de frame al PTS.** La compuerta no ve números de orden: solo puede leer el PTS, la marca de tiempo que cada frame lleva en el MPEG-TS (ver C.6). El PTS cuenta 90 000 unidades por segundo, así que a 60 fps avanza 1500 unidades por frame, siempre igual. Conociendo el PTS del frame 0, que la compuerta anota al verlo pasar, el de cualquier otro es:

```
PTS del frame n = PTS del frame 0 + n × 1500

si el frame 0 llevaba el PTS 126 000:
   frame 600  →  126 000 + 600 × 1500  =  1 026 000
```

Para que la compuerta vea el frame 0, el testbed arranca primero las compuertas y después la fuente.

**Paso 4: del PTS a las horas del servidor.** La compuerta de cada rama (`tsgate.py`) apunta dos horas por cada frame, indexadas por su PTS (ver C.8). Se busca el PTS calculado, con medio frame de tolerancia.

**Paso 5, solo en DASH.** El origen sigue los fragmentos CMAF según los recibe y apunta a qué hora se completa cada uno y qué intervalo de tiempo de medios cubre. El PTS del frame se convierte en tiempo de medios y se mira en qué fragmento cae.

**Paso 6: la llegada al navegador.** Aquí cada reproductor ofrece algo distinto:

| Rama | Cómo se identifica el frame pintado | De dónde sale su hora de llegada |
| :--- | :--- | :--- |
| DASH | Por su tiempo de medios, que da el navegador con cada frame mostrado | Se vigila el búfer del `<video>` cada 20 ms y se anota cuándo pasó a contener ese instante. |
| MoQ | Por su marca de tiempo, que lleva el frame decodificado | El reproductor anuncia la marca de cada frame que lee de la red, antes de decodificarlo; se anota cuándo anunció esa. |
| WebRTC | No hace falta | El navegador entrega, junto con cada frame mostrado, la hora a la que recibió su último paquete. |

### D.6. Los puntos de medida y las etapas de cada rama

Los seis puntos, con el reloj en que se toma cada hora:

| Punto | Dónde se toma | Reloj |
| :--- | :--- | :--- |
| Quemado | Filtro de FFmpeg en la fuente | Servidor |
| Salida del codificador | `tsgate`: llegada al sistema del último paquete del frame | Servidor |
| Entrega al empaquetador | `tsgate`: cuando lo lee y lo escribe hacia el empaquetador | Servidor |
| Fragmento completo (DASH) | Origen | Servidor |
| Llegada al reproductor | Página web | Navegador, convertido |
| Pintado | Página web | Navegador, convertido |

La hora de salida del codificador la pone el propio sistema operativo en el instante en que recibe el paquete, no el programa cuando lo lee. Así no depende de lo ocupada que esté la compuerta.

**LL-DASH**

| Etapa | Entre qué puntos | Qué contiene |
| :--- | :--- | :--- |
| Codificación | Quemado → salida del codificador | Escalado, codificación x264 y multiplexado MPEG-TS. |
| Empaquetado CMAF | Salida del codificador → fragmento completo | Paso por la compuerta, FFmpeg y la espera a que se cierre el fragmento. |
| Entrega | Fragmento completo → llegada | Origen, nginx, router de emulación, red y lectura en `dash.js`. |
| Búfer y pintado | Llegada → pintado | Espera en el búfer, decodificación y pintado. |

**Media over QUIC**

| Etapa | Entre qué puntos | Qué contiene |
| :--- | :--- | :--- |
| Codificación | Quemado → salida del codificador | Igual que en DASH. |
| Entrada al publicador | Salida del codificador → entrega | Lo que el frame espera a que el publicador lo acepte. Normalmente 0 ms. |
| Publicación y transporte | Entrega → llegada | Importador, relay, router de emulación y red. |
| Búfer de jitter y pintado | Llegada → pintado | Decodificación, espera en el búfer y pintado. |

**WebRTC**

| Etapa | Entre qué puntos | Qué contiene |
| :--- | :--- | :--- |
| Codificación | Quemado → salida del codificador | Igual que en DASH. |
| Entrada al empaquetador | Salida del codificador → entrega | Como en MoQ. |
| Publicación y transporte | Entrega → llegada | FFmpeg, RTSP, MediaMTX, router de emulación y red. |
| Búfer de jitter y pintado | Llegada → pintado | Búfer de jitter, decodificación y pintado. |

La etapa "Codificación" es la misma medida en las tres ramas, porque es anterior al reparto. Las pequeñas diferencias que se ven entre carriles se deben a que cada rama muestrea frames distintos.

**La resolución es la de los puntos de medida.** Dentro de una etapa no se sabe cómo se reparte el tiempo. En MoQ, por ejemplo, importador, relay y red van juntos, porque el relay es un programa de terceros en el que no hay donde anotar una hora.

### D.7. Un ejemplo con cifras reales

Dos frames medidos el 10 de octubre de 2026 contra el servidor. La conexión del cliente tenía ese día mucha variación de retardo, lo que infla las etapas que cruzan la red; sirven como ejemplo de lectura, no como valores de referencia.

| Rama | Etapas | Suma |
| :--- | :--- | :--- |
| DASH (objetivo 3 s) | 38 + 97 + 76 + 2908 ms | 3119 ms |
| MoQ (slider 200 ms) | 24 + 0 + 104 + 173 ms | 301 ms |

Cómo se lee el de DASH: el frame tardó 38 ms en codificarse, pasaron 97 ms hasta que su fragmento quedó completo (el fragmento era de 100 ms), 76 ms hasta que llegó al reproductor, y esperó 2908 ms en el búfer. En total 3119 ms, que es lo que marcaba su tarjeta de latencia *glass-to-glass*.

**Qué frame se muestra.** Cada segundo se siguen unos cinco frames por rama. No se promedia cada etapa por separado: se elige **un frame real**, el de latencia total mediana, y se muestran las suyas. Así las cifras suman exactamente y corresponden a algo que ocurrió.

### D.8. Precisión y límites

| Medida | Precisión | Por qué |
| :--- | :--- | :--- |
| Etapas con las dos horas en el servidor (codificación, entrada al empaquetador y, en DASH, empaquetado) | Del orden de 1 ms | Mismo reloj en los dos extremos. La hora del quemado puede tener 1 ms de error. |
| Etapas que cruzan al navegador | La incertidumbre del reloj, ±RTT/2 | Comparan una hora del servidor con una del navegador. |
| Llegada en DASH | Hasta 20 ms más | El búfer se consulta cada 20 ms. Además llega un fragmento entero, así que todos sus frames comparten hora de llegada. |
| Llegada en MoQ | Unos milisegundos | El reproductor agrupa los avisos de frames que llegan casi a la vez; a un frame se le puede asignar la hora del siguiente. |
| Llegada en WebRTC | Dudosa | Ver abajo. |

**La llegada en WebRTC no cuadra con las estadísticas del navegador.** En una misma prueba, el desglose atribuía 11 ms a "Búfer de jitter y pintado", mientras que las estadísticas del propio navegador daban 55 ms de permanencia media en el búfer de jitter. Las dos cifras no pueden ser ciertas a la vez. La total de la rama es fiable, porque no depende de esa hora; el reparto entre "Publicación y transporte" y "Búfer de jitter y pintado" en WebRTC no lo es. Está sin resolver.

Otros límites:

- **Se descarta lo que no cuadra.** Si para un frame sale una etapa negativa, o una codificación fuera de entre 0 y 1 s, alguna hora no era la suya y la muestra entera se desecha.
- **El muestreo es de cinco frames por segundo**, no de todos.
- **El final de un frame se conoce con retraso** en MPEG-TS, pero la medida lo compensa (C.4). En el empaquetador de DASH (FFmpeg), leer el MPEG-TS cuesta 2 frames y escribir el fragmento uno más: con fragmentos de 1 frame, la etapa de empaquetado no baja de unos 50 ms a 60 fps (C.4). MediaMTX retiene 1 frame y el publicador de MoQ unos 2, que quedan dentro de su etapa de transporte (C.4 y variable de confusión 8 de 6.4).
- **Tras un reinicio de la fuente** se pierde la referencia del frame 0 hasta que se restablece.

### D.9. Otras dos medidas de búfer, y en qué se diferencian

El panel muestra, además de la etapa de búfer del desglose, una cifra de búfer en la tarjeta de cada rama. No son lo mismo:

| Medida | Qué es | Cómo se obtiene |
| :--- | :--- | :--- |
| Etapa "Búfer… y pintado" | Tiempo de un frame concreto desde que llega hasta que se pinta. | Como en D.5. |
| "Búfer local" (DASH) | Segundos de vídeo descargados por delante del punto de reproducción. | Lo declara `dash.js`. |
| "Búfer de jitter" (MoQ) | Tiempo medio que los frames pasan retenidos en el reproductor. | Se anota cuándo el reproductor lee cada frame y cuándo lo entrega para pintar. Incluye la decodificación. |
| "Búfer de jitter" (WebRTC) | Tiempo medio que los frames pasan en el búfer de jitter. | Estadísticas del navegador. No incluye la decodificación. |

En MoQ, la etapa del desglose y la cifra de la tarjeta deberían salir parecidas, y así ocurre. En WebRTC es donde aparece la discrepancia descrita en D.8.

Hay una tercera cifra que conviene no confundir con ninguna de estas: el **retardo efectivo** que se muestra junto al slider de MoQ. No es una medida, sino el valor que el reproductor se ha fijado como objetivo. El búfer medido sale menor, porque el objetivo se cuenta desde el frame que más rápido llegó y los demás llegan algo más tarde (ver 4.11).

### D.10. Dónde queda registrado

Todo va al CSV que exporta el panel, una fila por segundo:

| Columnas | Contenido |
| :--- | :--- |
| `dash_g2g_ms`, `moq_g2g_ms`, `rtc_g2g_ms` | Latencia *glass-to-glass*. |
| `dash_stage_encode_ms`, `_package_ms`, `_deliver_ms`, `_player_ms` | Etapas de DASH. |
| `moq_stage_encode_ms`, `_ingest_ms`, `_transport_ms`, `_player_ms` | Etapas de MoQ. |
| `rtc_stage_encode_ms`, `_ingest_ms`, `_transport_ms`, `_player_ms` | Etapas de WebRTC. |
| `dash_buffer_s`, `moq_jitter_buffer_s`, `rtc_jitter_buffer_s` | Las cifras de búfer de las tarjetas. |
| `clock_offset_ms`, `clock_rtt_ms` | Sincronización de relojes y su incertidumbre. |
| `ingest_anomalies`, `dash_availability_drift_ms` | Indicadores de validez de la sesión. |
