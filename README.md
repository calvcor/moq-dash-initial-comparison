# Banco de Pruebas Comparativo: Media over QUIC (MoQ), LL-DASH y WebRTC

Banco de pruebas (*testbed*) de la investigación doctoral:

> **"Streaming de vídeo en directo de baja latencia mediante Media over QUIC: evaluación comparativa con WebRTC y HTTP adaptive streaming, y mecanismos de adaptación para la mejora de la QoE"**

Emite la misma señal en directo por tres ramas, **LL-DASH** (CMAF por HTTP con chunked transfer), **Media over QUIC** (WebTransport) y **WebRTC** (WHEP), y las reproduce lado a lado midiéndolas con el mismo método.

El detalle de las decisiones y de los problemas resueltos está en [`CONTEXT_SUMMARY.md`](CONTEXT_SUMMARY.md).

---

## 1. Puesta en marcha

Requisitos: Docker con Compose y conexión a Internet en el primer arranque.

```bash
git clone git@github.com:calvcor/moq-dash-initial-comparison.git
```

```bash
cd moq-dash-initial-comparison
```

```bash
docker compose up -d --build
```

El vídeo fuente (Big Buck Bunny 1080p60, 355 MB) no va en el repositorio. La primera vez el orquestador lo descarga de [download.blender.org](https://download.blender.org/demo/movies/BBB/) y lo descomprime en `media/`; el panel muestra el progreso y la emisión arranca sola al terminar. En arranques posteriores se reutiliza. Para usar una copia que ya tengas, déjala en `media/bbb_sunflower_1080p_60fps_normal.mp4` antes de arrancar.

Abrir <http://localhost> en Chrome o Edge (hace falta WebTransport y WebCodecs). La emisión arranca sola.

```bash
docker compose logs -f orchestrator
```

```bash
docker compose down
```

Tras editar código:

| Qué se ha cambiado | Cómo aplicarlo |
| :--- | :--- |
| `server/app/*.py` | `docker compose restart orchestrator` (el directorio está montado, pero uvicorn no recarga solo) |
| `server/nginx.conf` | `docker compose restart nginx-dash` |
| `web/` | `docker compose up -d --build web` |

---

### Despliegue en un servidor, detrás de un proxy con HTTPS

Fuera de `localhost` el navegador solo permite WebTransport y WebCodecs en páginas HTTPS, así que hace falta un proxy inverso con certificado (por ejemplo Nginx Proxy Manager) delante del puerto 80.

1. En el servidor, crear un `.env` con el nombre por el que se accederá: `PUBLIC_HOST=testbed.ejemplo.org`. Se usa para el certificado autofirmado del relay.
2. `docker compose up -d --build`.
3. En el proxy, un único host que reenvíe `https://testbed.ejemplo.org` a `http://<servidor>:80`. No hace falta definir rutas.
4. Los puertos **4433/udp** (MoQ) y **8189/udp** (WebRTC) del servidor deben ser alcanzables directamente desde los navegadores: no pasan por el proxy.
5. Si el nombre público resuelve al proxy y no al servidor (lo habitual con un comodín DNS), añadir al `.env` la dirección directa del servidor para MoQ: `MOQ_HOST=10.0.0.5`. El relay usa un certificado autofirmado fijado por huella, así que vale una IP. La alternativa es que el proxy reenvíe el puerto 4433/udp como *stream*.

A tener en cuenta en las medidas: detrás del proxy, DASH llega al navegador por la conexión del proxy (normalmente HTTP/2) y la emulación de red actúa sobre el tramo interno, no sobre la conexión TCP del navegador. MoQ sí va extremo a extremo.

La emulación de red necesita en el kernel los módulos `sch_prio`, `sch_tbf`, `sch_netem` y `cls_u32`. En un contenedor LXC deben estar cargados en el anfitrión; si faltan, todo lo demás funciona y el panel lo indica.

---

## 2. Arquitectura

```
                    ┌──────────────────────────────────────────────┐
                    │  Fuente maestra (FFmpeg, x264 zerolatency)   │
                    │  Big Buck Bunny 1080p60 en bucle             │
                    │  + reloj de texto + timecode binario quemado │
                    └────────────┬───────────────────┬─────────────┘
                     MPEG-TS/UDP │ :5001             │ :5002  MPEG-TS/UDP
                                 ▼                   ▼
                    ┌─────────────────────┐ ┌─────────────────────┐
                    │ tsgate.py           │ │ tsgate.py           │
                    │ (abre paso en IDR)  │ │ (abre paso en IDR)  │
                    └──────────┬──────────┘ └──────────┬──────────┘
                               ▼                       ▼
                    ┌─────────────────────┐ ┌─────────────────────┐
                    │ FFmpeg -f dash      │ │ moq import ts       │
                    │ CMAF, -c copy       │ │ broadcast live.hang │
                    └──────────┬──────────┘ └──────────┬──────────┘
               HTTP PUT chunked│                       │ QUIC
                               ▼                       ▼
                    ┌─────────────────────┐ ┌─────────────────────┐
                    │ Origen en memoria   │ │ moq-relay           │
                    │ (origin.py, :8000)  │ │ (:4433/udp)         │
                    └──────────┬──────────┘ └──────────┬──────────┘
                               ▼                       │
                    ┌─────────────────────┐            │
                    │ Nginx               │            │
                    │ proxy sin búfer     │            │
                    └──────────┬──────────┘            │
                               ▼                       ▼
                    ┌──────────────────────────────────────────────┐
                    │ Router de emulación de red (tc + netem)      │
                    │ :8080/tcp → Nginx   ·   :4433/udp → relay    │
                    │ ancho de banda, retardo, jitter y pérdida    │
                    └──────────┬───────────────────────┬───────────┘
             HTTP/1.1 chunked  │                       │ WebTransport
                               ▼                       ▼
                    ┌─────────────────────┐ ┌─────────────────────┐
                    │ dash.js             │ │ @moq/watch          │
                    │ <video> + MSE       │ │ WebCodecs + <canvas>│
                    └──────────┬──────────┘ └──────────┬──────────┘
                               └───────────┬───────────┘
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │ Dashboard React (entrada única, puerto 80)   │
                    │ lectura del timecode en píxeles de ambos     │
                    │ reproductores · estadísticos · export CSV    │
                    └──────────────────────────────────────────────┘
```

Las dos ramas reciben **el mismo bitstream H.264**: la fuente codifica una sola vez y los empaquetadores solo copian (`-c copy`).

### Contenedores

| Contenedor | Imagen | Puertos publicados | Función |
| :--- | :--- | :--- | :--- |
| `testbed-edge` | `nginx:alpine` | 80/tcp | Entrada HTTP única: reparte entre dashboard (`/`), API (`/api`), LL-DASH (`/media/dash`) y huella del certificado del relay |
| `testbed-router` | Alpine + `tc` + `iptables` + agente Python | 4433/udp | Paso obligado hacia DASH y MoQ; reenvía a nivel IP y emula la red |
| `testbed-orchestrator` | Python 3.12 + FastAPI + FFmpeg 7.1 + `moq` CLI 0.14.2 | ninguno | Fuente maestra, empaquetadores, origen LL-DASH en memoria y API de control |
| `testbed-nginx-dash` | `nginx:alpine` | ninguno | Reenvía `/media/dash/` al origen con `proxy_buffering off` |
| `testbed-moq-relay` | `moqdev/moq-relay:latest` | ninguno | Relay MoQ con certificado autofirmado |
| `testbed-mediamtx` | `bluenviron/mediamtx:latest` | ninguno | Servidor WebRTC: recibe la calidad más alta por RTSP y la sirve por WHEP |
| `testbed-web` | React 19 + Vite + Tailwind, servido por Nginx | ninguno | Dashboard, con cabeceras COOP/COEP para `SharedArrayBuffer` |

Solo se publican tres puertos: **80/tcp** para todo el HTTP, y **4433/udp** (MoQ, QUIC) y **8189/udp** (WebRTC), a los que el navegador va directo. Los dos primeros se pueden cambiar con `HTTP_PORT` y `MOQ_PORT` en un fichero `.env`. `MOQ_HOST` sirve también como dirección que WebRTC anuncia al navegador.

Los puertos UDP 5001 y 5002 son internos al contenedor del orquestador.

Hay dos redes Docker. En la interna (`core`, 172.30.50.0/24) viven Nginx, el relay, el orquestador y una pata del router; la ingesta circula por ella y nunca se degrada. El navegador solo alcanza Nginx y el relay atravesando el router.

> [!IMPORTANT]
> QUIC va sobre UDP: el puerto `4433/udp` tiene que estar abierto en cualquier firewall entre el navegador y el relay.

---

## 3. Pipeline de medios

### 3.1. Fuente maestra

Un único FFmpeg lee el MP4 a ritmo real y lo emite duplicado por UDP:

```bash
ffmpeg -re -stream_loop -1 -i <vídeo> -re -stream_loop -1 -i <vídeo> \
  -filter_complex "[0:v]setpts=N/(60*TB),drawtext=<reloj>,split=N[s0]..[sN]; \
                   [s0]scale=1920:1080,drawtext=<etiqueta de calidad>,<timecode binario>[v0]; ...; \
                   [1:a]asetpts=N/(SR*TB)[a]" \
  -map [v0] ... -map [vN] -map [a] \
  -c:v libx264 -preset ultrafast -tune zerolatency -threads 4 -x264opts repeat-headers=1 \
  -b:v:0 <kbps>k -maxrate:v:0 <1,2 x kbps>k -bufsize:v:0 <kbps>k ... \
  -g <gop> -keyint_min <gop> -sc_threshold 0 -r 60 -c:a aac -ac 2 -b:a 128k \
  -f tee "[f=mpegts:pes_payload_size=0]udp://127.0.0.1:5001?pkt_size=1316|[f=mpegts:pes_payload_size=0]udp://127.0.0.1:5002?pkt_size=1316"
```

- **Dos entradas del mismo fichero**, una para vídeo y otra para audio. El MP4 intercala ambos en bloques de 0,5 s; con una sola entrada a ritmo real el audio llega a ráfagas y el multiplexor retiene el vídeo.
- **`pes_payload_size=0`**: un PES por frame de audio. Por defecto MPEG-TS agrupa ~180 ms de audio y eso retrasa el vídeo aguas abajo.
- **Escalera de calidades**: la fuente codifica en vivo de 1 a 5 calidades (por defecto 1080p@4000, 720p@2000 y 360p@700 kbps), todas a 60 fps y con el mismo GOP para que sus keyframes coincidan. Viajan como varios vídeos de un mismo MPEG-TS.
- **Tope de tasa**: cada calidad lleva `-maxrate` al 120 % y un VBV de 1 s, para que el bitrate nominal sea una referencia fiable para la adaptación y la emulación de red.
- **Etiqueta de calidad**: cada calidad lleva quemado arriba a la derecha su nombre (`720p 2000 kbps`), para ver de un vistazo cuál se reproduce.
- **Timecode binario**: se quema en cada calidad después de escalarla. Ver sección 4.

Cambiar el GOP o la escalera reinicia la fuente; cambiar segmento o fragmento solo reinicia los empaquetadores. **Detener Pipeline** para también la fuente, que es la que consume CPU, y el servidor queda en reposo; la parada se conserva aunque se reinicie el contenedor o la máquina.

### 3.2. Compuerta `tsgate.py`

Los dos empaquetadores leen su puerto UDP a través de `server/app/tsgate.py`, que:

- descarta todo hasta el primer keyframe de vídeo y antepone las tablas PAT/PMT, de modo que audio y vídeo empiezan juntos en ambas ramas;
- vigila los contadores de continuidad MPEG-TS y escribe en el log cualquier salto (pérdida en el reparto UDP interno).

### 3.3. Rama LL-DASH

```bash
python3 tsgate.py 5001 | ffmpeg -analyzeduration 1000000 -i pipe:0 \
  -map 0:v -map 0:a:0 -c:v copy -c:a copy -tag:v avc1 -tag:a mp4a -b:v:0 <kbps>k ... \
  -f dash -adaptation_sets "id=0,streams=v id=1,streams=a" -seg_duration <seg> -frag_type duration -frag_duration <frag> \
  -streaming 1 -ldash 1 -use_template 1 -use_timeline 0 \
  -utc_timing_url /api/utc \
  -window_size <30 s en segmentos> -extra_window_size <ídem> \
  -method PUT -http_persistent 1 http://127.0.0.1:8000/media/dash/manifest.mpd
```

- **Publicación por HTTP PUT al origen en memoria** (`server/app/origin.py`). Cada segmento se sirve a los clientes mientras FFmpeg aún lo está escribiendo, fragmento a fragmento. Escribiendo a disco FFmpeg solo expone el segmento completo.
- **`-use_timeline 0`** hace que el manifiesto anuncie `availabilityTimeOffset`, que es lo que permite a dash.js pedir el segmento en curso.
- **`-frag_type duration`** es necesario para que `-frag_duration` tenga efecto.
- **`availabilityStartTime` calibrado**: el origen sustituye el que escribe FFmpeg (retrasado por su sondeo de entrada) por el deducido del instante real en que se abre un segmento. El manifiesto no se publica hasta tenerlo, unos segundos tras cada arranque.

El segmento no puede ser más corto que el GOP; backend y frontend lo validan.

### 3.4b. Rama WebRTC

```bash
python3 tsgate.py 5003 rtc | ffmpeg -fflags nobuffer -analyzeduration 1000000 -i pipe:0 \
  -map 0:v:0 -c:v copy -an -f rtsp -rtsp_transport tcp rtsp://mediamtx:8554/live
```

- **MediaMTX** recibe por RTSP la calidad más alta, sin recodificar, y la sirve por WebRTC. El navegador negocia por WHEP (`/rtc/live/whep`, a través del punto de entrada) y recibe el vídeo directo por UDP 8189, pasando por el router de emulación.
- **Una sola calidad y sin audio.** WebRTC no admite el AAC de la fuente, y no hay adaptación: esta rama sirve siempre la calidad más alta de la escalera.
- **El reproductor** es un `RTCPeerConnection` sobre un `<video>`, sin ajustes: el búfer de jitter lo decide el navegador. Un slider permite pedirle un búfer concreto (`jitterBufferTarget`); en "auto" no se pide nada.
- **Métricas propias** de las estadísticas del navegador (`getStats`): bitrate, búfer de jitter y paquetes perdidos. No declara una latencia respecto al directo, así que esa tarjeta queda vacía.

### 3.4. Rama MoQ

```bash
python3 tsgate.py 5002 | moq --connect https://moq-relay:4433/anon --connect-tls-insecure \
  --broadcast live.hang import ts
```

Cada GOP es un grupo MoQ en su propio stream QUIC. El navegador se conecta a `https://localhost:4433/anon` fijando el certificado por su huella SHA-256 y se suscribe a `live.hang`.

---

## 4. Método de medida

Las métricas principales se obtienen igual en las dos ramas, **leyendo píxeles de lo que cada reproductor pinta**.

### 4.1. Latencia glass-to-glass

1. La fuente quema en cada frame un **timecode binario**: el reloj de pared del servidor en milisegundos (módulo 2²⁰), en código Gray, como una fila de celdas blancas y negras abajo a la izquierda. Las celdas de los extremos son referencias fijas blanco/negro. Cada calidad lleva el suyo, con celdas de 32 px (16 px en las calidades pequeñas); `/api/status` publica la disposición de cada una y el lector usa la de la altura que está viendo.
2. El navegador sincroniza su reloj con el del servidor contra `GET /api/time` (estilo NTP, se queda con el sondeo de menor RTT, cada 10 s).
3. En cada frame de pantalla, `GlassMeter` (`web/src/lib/glass.ts`) toma el frame que muestra cada reproductor, copia solo dos filas de la franja del timecode (`VideoFrame.copyTo`, asíncrono) y calcula `latencia = hora del servidor − timecode`.

> [!WARNING]
> **El medidor no debe alterar lo que mide.** Hasta el 9 de octubre de 2026 el timecode se leía dibujando el vídeo en un canvas y leyéndolo con `getImageData` en cada frame. Con tres reproductores eso saturaba el hilo principal de la página (en Brave bajaba a 35 vueltas por segundo, y a menos en una ventana real). El reproductor MoQ pinta en ese hilo: se quedaba atrás, dejaba de leer de la red y la presión llegaba hasta el publicador, con latencias de varios segundos. **Las observaciones sobre MoQ anteriores a ese cambio (congelados, oscilación de calidad, esperas en el publicador, pruebas con ancho de banda limitado) están contaminadas por ese efecto y hay que repetirlas.**

Incluye codificación, empaquetado, red, búfer del reproductor, decodificación y pintado. No incluye el retardo de composición y pantalla (1-2 refrescos), que es idéntico en ambas ramas.

### 4.2. Resto de métricas

| Métrica | Cómo se obtiene |
| :--- | :--- |
| Frames presentados (fps) | Timecodes distintos vistos por segundo, media de los últimos 2 s |
| Congelados | Periodos ≥ 150 ms sin timecode nuevo; se cuenta número y duración |
| Bitrate de vídeo recibido | Bytes de vídeo descargados sobre una ventana de 10 s (dash.js: segmentos completados; MoQ: `bytesReceived` del decodificador) |
| Tráfico IP en el router | Bytes IP reenviados por protocolo y sentido, con cabeceras y retransmisiones; misma capa para ambos. Es la cifra rigurosa de consumo de red |
| Descarga total | A nivel de aplicación y en capas distintas, así que la comparación es orientativa. DASH: tamaño transferido de todas las peticiones (vídeo, audio y manifiesto, con cabeceras HTTP de respuesta) según la Resource Timing API. MoQ: `WebTransport.getStats()` si el navegador lo implementa; en Chrome no existe y se suma la carga útil de las pistas descargadas. El detalle aparece al pasar el ratón por la tarjeta |
| Latencia según reproductor | La que declara cada uno (`getCurrentLiveLatency()` en dash.js, retardo de sincronización en `@moq/watch`); solo como contraste |
| Búfer local (DASH) | Segundos de vídeo descargados por delante del punto de reproducción (`getBufferLength('video')`) |
| Búfer de jitter (MoQ y WebRTC) | Tiempo medio que cada frame pasa retenido en el reproductor. WebRTC: `jitterBufferDelay / jitterBufferEmittedCount` de `getStats()`, desde el primer paquete hasta la salida hacia el decodificador. MoQ: desde que `@moq/watch` lee el frame de la red hasta que lo entrega para pintarlo; incluye la decodificación |

Cuando no hay medida se muestra `--`; no se rellena con valores supuestos.

Silenciado, `@moq/watch` no descarga el audio, mientras que dash.js lo descarga siempre: unos 130 kbps de la diferencia en descarga total vienen de ahí.

### 4.3. Indicadores de validez

El panel muestra, y el CSV registra:

- **Incertidumbre del reloj** (±RTT/2 de la sincronización).
- **Anomalías de ingesta**: saltos de continuidad o paquetes corruptos entre la fuente y cada empaquetador. Cualquier valor distinto de cero invalida la comparación de esa sesión.
- **Deriva de disponibilidad DASH**: desfase de cada segmento respecto al calendario que anuncia el manifiesto.

### 4.4. Estadísticos y exportación

Cada tarjeta muestra n, media, σ, p50, p95, mínimo y máximo de la latencia glass-to-glass, descartando los 10 primeros segundos tras cada arranque y las muestras tomadas con la pestaña oculta.

**Exportar CSV** descarga una fila por segundo con la configuración activa, todas las métricas de ambas ramas y los indicadores de validez. La columna `epoch` se incrementa en cada reconfiguración.

> [!NOTE]
> Con la pestaña en segundo plano el navegador pausa el vídeo y el muestreo. Esas filas quedan marcadas con `tab_hidden`.

### 4.5. Desglose de la latencia por etapas

El panel **Recorrido de un frame** reparte la latencia glass-to-glass entre las etapas del camino, con medidas y sin estimaciones. Sigue frames concretos (unos cinco por segundo y rama) y anota la hora en cada punto donde se les puede observar:

| Punto de medida | Dónde y cómo |
| :--- | :--- |
| Marca de origen | FFmpeg, al quemar el timecode, escribe en su log la marca exacta, el número de frame y la calidad (`print()` en la expresión del filtro). El orquestador lo lee y puede identificar después cualquier frame por su timecode |
| Salida del codificador | `tsgate.py`: hora a la que el kernel recibe el último paquete del frame (`SO_TIMESTAMPNS`) |
| Entrega al empaquetador | `tsgate.py`: hora a la que lee ese paquete y lo escribe hacia FFmpeg o `moq import`. Se retrasa si el empaquetador no vacía la tubería |
| Fragmento completo (DASH) | `origin.py` sigue las cajas `moof`/`mdat` según llegan y anota cuándo se completa cada fragmento |
| Llegada al reproductor | DASH: primer instante en que `video.buffered` contiene el frame (cada 20 ms). MoQ: cuando `@moq/watch` lo lee de la conexión, antes de decodificar |
| Pintado | El mismo lector de timecode del medidor glass-to-glass |

Cada etapa es la diferencia entre dos puntos consecutivos:

- **LL-DASH:** codificación → empaquetado CMAF → entrega → búfer y pintado.
- **MoQ:** codificación → entrada al publicador → publicación y transporte → búfer de jitter y pintado.
- **WebRTC:** codificación → entrada al empaquetador → publicación y transporte → búfer de jitter y pintado. La llegada al reproductor la da el propio navegador con cada frame (`receiveTime`), con unos pocos ms de imprecisión.

Lo que hay que saber para interpretarlo:

- **Las cifras son las de un frame real**, el de latencia total mediana entre los seguidos en el último segundo, así que las etapas suman exactamente su latencia.
- **La resolución es la de los puntos de medida, no la de cada caja del esquema.** Dentro de una etapa no se sabe cómo se reparte el tiempo; en MoQ, publicador, relay y red van juntos porque el relay es un binario de terceros.
- **Incertidumbre:** las etapas con las dos horas en el servidor son exactas al milisegundo; las que cruzan al navegador añaden el error de sincronización de relojes (se muestra) y, en DASH, los 20 ms del sondeo del búfer.
- **El PTS del frame 0** se obtiene arrancando las compuertas antes que la fuente. Si una medida no cuadra (codificación fuera de 0-1 s) se descarta en vez de mostrarse.

Los puntos animados recorren cada carril a velocidad real: tardan en cada etapa lo medido. Las etapas van también al CSV (`dash_stage_*_ms`, `moq_stage_*_ms`).

Primera observación con este panel (Chrome headless, red sin restricción): en MoQ, de ~470 ms, unos 400 ms se pasan en el búfer del reproductor (medido con `buffer` a 150 ms; desde que se usa el valor por defecto de la librería, 0, son unos 200 de ~300 ms) y solo 15-40 ms en publicador, relay y red; en DASH, de ~3,06 s, unos 2,8 s son búfer.

### 4.6. Valores de referencia

Medidos en Chrome headless en la misma máquina, con latencia objetivo de 3,0 s en DASH y 200 ms en MoQ:

| GOP / segmento / fragmento / bitrate | DASH real | DASH declarada | MoQ real | MoQ declarada |
| :--- | :--- | :--- | :--- | :--- |
| 60 / 2 s / 0,2 s / 4000k | 3,06 s | 3,01 s | 463 ms | 268 ms |
| 120 / 4 s / 0,5 s / 8000k | 3,06 s | 3,00 s | 466 ms | 268 ms |
| 15 / 0,5 s / 0,1 s / 2000k | 3,06 s | 3,01 s | 467 ms | 268 ms |
| 30 / 1 s / 0,2 s / 6000k | 3,06 s | 3,00 s | 462 ms | 268 ms |

En DASH la diferencia entre real y declarada (~55 ms) es el tiempo de codificación, empaquetado y pintado. En MoQ quedan ~200 ms sin atribuir (publicador, relay o decodificación por software del navegador headless).

---

## 5. Emulación de red

El router (`router/agent.py`) reenvía los puertos del navegador con DNAT, sin terminar conexiones, y degrada ese tráfico con `tc`. Se controla desde el panel **Emulación de Red** o con `POST /api/network`.

| Parámetro | Por sentido | Notas |
| :--- | :--- | :--- |
| Ancho de banda (kbit/s) | Sí | Vacío = sin límite |
| Retardo (ms) | Sí | El RTT es la suma de bajada y subida |
| Jitter (ms) | Sí | No puede superar el retardo; puede reordenar paquetes |
| Pérdida (%) | Sí | Aleatoria e independiente por paquete |
| Cola (ms) | Sí | Búfer del cuello de botella; solo actúa con ancho de banda limitado |

- **Un enlace idéntico por protocolo.** DASH y MoQ tienen cada uno su propia cola con el mismo perfil, así que no compiten entre sí: limitar a 5 Mbit significa 5 Mbit para cada uno.
- **Los dos sentidos.** Bajada es servidor → navegador y subida es navegador → servidor.
- **Cambio en caliente.** Aplicar un perfil no reinicia los reproductores, pero sí abre un tramo de medida nuevo para no mezclar condiciones en los estadísticos. El perfil activo queda en cada fila del CSV.
- **Contadores del router.** El panel muestra el tráfico IP real por protocolo y sentido (cabeceras y retransmisiones incluidas, misma capa para ambos) y los paquetes descartados por la emulación.

Implementación: por cada cola, un `tbf` con ráfaga de un paquete fija el ancho de banda y trocea los superpaquetes GSO, y un `netem` hijo aplica retardo y pérdida y hace de cola.

Limitaciones:

- **En macOS, el extremo TCP del cliente es el proxy de Docker Desktop**, no el navegador. Para DASH la conexión degradada es proxy–Nginx; el control de congestión del servidor sí es el real. QUIC no se ve afectado. En un host Linux no ocurre.
- **La cola se dimensiona en paquetes** suponiendo paquetes de 1500 bytes, así que su duración real es aproximada.
- **La tabla siguiente es anterior a la escalera de calidades**: se midió con una única calidad y sin tope de tasa en la fuente.

Comportamiento observado en Chrome headless (45 s por caso, vídeo a 4 Mbit, objetivos de 3 s en DASH y 200 ms en MoQ):

| Perfil | DASH | MoQ |
| :--- | :--- | :--- |
| Sin restricción | 3,11 s, sin congelados | 446 ms, sin congelados |
| 50 ms de retardo por sentido | 3,11 s (lo absorbe el búfer) | 494 ms (+50 ms) |
| 2 % de pérdida por sentido, 20 ms | 28 congelados, 25 s parado | 456 ms, sin congelados |
| 10 Mbit, 20 ms | sin congelados | 5 congelados, 1,4 s |
| 5 Mbit, 20 ms | 9 congelados, 6,4 s | 10 congelados, 3,9 s |
| 3 Mbit, 20 ms | no sostenible | no sostenible |

---

## 6. Adaptación de calidad

Con más de una calidad en la escalera, cada reproductor adapta por su cuenta (selector **Calidad: Auto**) o se le fija una.

| | LL-DASH | MoQ |
| :--- | :--- | :--- |
| Dónde están las calidades | Varias `Representation` en un `AdaptationSet` del manifiesto | Varias *renditions* (pistas) en el catálogo de la emisión |
| Quién decide | dash.js, con su ABR por defecto | El reproductor, a partir de lo que estima el relay |
| En qué se basa | Caudal que mide en sus descargas | Tasa de recepción que el relay estima con su control de congestión y envía por mensajes PROBE |
| Regla | La de dash.js (throughput + BOLA) | La de `@moq/watch`: la más alta cuyo bitrate de catálogo quepa en el 80 % de la estimación, descartando las que el publicador marca `stalled` |
| Cuándo conmuta | En frontera de segmento | En frontera de grupo (keyframe), sin corte: mantiene la suscripción anterior hasta que la nueva la alcanza |

**En automático el banco no interviene en ninguno de los dos reproductores**: se observa el comportamiento de dash.js y de `@moq/watch` tal cual. Solo al fijar una calidad a mano se le pide al reproductor esa en concreto (en MoQ, por nombre de rendition).

El panel muestra por reproductor la calidad en curso, los cambios de calidad y el ancho de banda estimado; todo va al CSV (`*_height`, `*_rendition_kbps`, `*_quality_switches`, `*_bw_estimate_kbps`, `*_quality_mode`, `moq_selected_height` y `ladder`). En MoQ se registran por separado la rendition **seleccionada** y la altura del frame que realmente **se pinta**, porque durante un cambio no coinciden.

Comportamiento observado en Chrome headless, enlace en exclusiva, bajada limitada a 4 Mbit (cola de 100 ms) y escalera 1080p@4000 / 720p@2000 / 360p@700 / 240p@400, durante 90 s:

| | Calidad pintada | Tráfico en el router | Latencia | Cambios | Congelados |
| :--- | :--- | :--- | :--- | :--- | :--- |
| DASH | 720p estable | 2,2-2,5 Mbit/s | 3,06 s | 2 | 1 (0,2 s) |
| MoQ | 1080p todo el tiempo | 3,95 Mbit/s (el tope) | 0,5-0,8 s | 52 de selección, entre 360p y 720p | 46 (14,8 s) |

Lo que se ve en MoQ con `@moq/watch` 0.6.2 y `moq-cli` 0.14.2:

- **La selección cambia unas 35 veces por minuto**, pero el frame pintado sigue siendo el de 1080p: el cambio sin corte no llega a completarse con el enlace saturado, y la calidad alta sigue descargándose junto a la nueva.
- **La estimación del relay ronda los 3-6 Mbit/s** en un enlace de 4.
- **El bitrate del catálogo sale en torno a 1,6-1,8 veces el nominal** (720p@2000 figura como ~3,7 Mbit/s), así que la regla del 80 % deja fuera calidades que caben.
- **Con la red libre** la selección también oscila (unas 50 veces por minuto), porque el publicador marca la calidad alta como `stalled` de forma intermitente.

Son observaciones de una prueba por caso, no resultados contrastados.

> [!IMPORTANT]
> La cola de emulación es una por protocolo, no una por espectador: dos pestañas abiertas a la vez comparten el mismo enlace y se estorban. Para medir con límite de ancho de banda, una sola pestaña.

---

## 7. Recuperación automática

La plataforma se recupera sola de reinicios y caídas, sin recargar la pestaña:

- **Identificador de emisión.** Cada vez que arranca un empaquetador, su `stream_id` en `/api/status` cambia. Cualquier dashboard abierto remonta ese reproductor al verlo, lo haya reiniciado esa pestaña, otra, la API o el supervisor. Sin esto, el reproductor MoQ quedaba anclado al reloj de la emisión anterior y pintaba a trompicones.
- **Supervisor en el orquestador.** Cada segundo comprueba la fuente y los dos empaquetadores y relanza lo que haya muerto, o el de DASH si lleva varios segmentos sin publicar. Cada rama se relanza por separado para no interrumpir la otra.
- **Vigilancia en cada reproductor.** Si pasan 10 s sin imagen nueva (con la pestaña visible y tras 20 s de margen desde el arranque), el reproductor se recrea. Los contadores de congelados se conservan.
- **Backend caído.** Tras tres consultas de estado fallidas el dashboard pasa a "desconectado" y reconecta al volver.

Los reinicios quedan a la vista en el panel ("Reinicios: servidor · DASH · MoQ") y en el CSV (`pipeline_restarts`, `dash_player_restarts`, `moq_player_restarts`): una sesión con reinicios no es una medida limpia.

| Incidente provocado | Recuperación observada |
| :--- | :--- |
| Reconfiguración desde otra pestaña o la API | ~5 s, ambos |
| Muere el publicador MoQ, el FFmpeg de DASH o la fuente | ~5 s; la otra rama no se entera |
| Reinicio del orquestador | 5-10 s, ambos |
| Reinicio de Nginx | sin efecto visible |
| Reinicio del router | ~10 s, ambos; **el perfil de red se pierde** y vuelve a "sin restricción" |
| Reinicio del relay | 10-15 s en MoQ (lo recupera la vigilancia del reproductor) |
| Red muy degradada y vuelta a la normalidad | ~5 s, ambos |

En una prueba con la red deliberadamente rota, la vigilancia puede recrear un reproductor que lleva más de 10 s congelado; queda registrado en las columnas de reinicios.

---

## 8. Parámetros experimentales

Desde el panel de control:

| Parámetro | Valores | Efecto |
| :--- | :--- | :--- |
| GOP | 15, 30, 60, 120 frames (0,25 a 2 s) | Tamaño del grupo MoQ y límite inferior del segmento DASH |
| Escalera de calidades | 1 a 5; altura 1080/720/540/480/360/240 y bitrate libre | Lo que codifica la fuente. Con una sola no hay adaptación |
| Calidad (por reproductor) | Auto o una calidad fija | Auto usa la adaptación de cada reproductor; fijar una la desactiva |
| Segmento DASH | 0,5, 1, 2, 4 s | `-seg_duration`; debe ser ≥ GOP |
| Fragmento CMAF | 100, 200, 500, 1000 ms | `-frag_duration`; unidad de entrega chunked |
| Latencia objetivo DASH | 0,05 a 6,0 s | `liveDelay` de dash.js, con catch-up LoL+ |
| Salto al directo DASH | 0 (desactivado) a 10 s, por defecto 1,5 s | `liveCatchup.maxDrift` de dash.js: desvío sobre el objetivo a partir del cual salta al directo en vez de corregir con la velocidad. El salto aborta las descargas y abre conexiones TCP frías; con retardo de red alto puede encadenar saltos y paradas |
| Latencia objetivo MoQ | auto, o 50 a 2000 ms (200 ms al abrir) | `delay` de `@moq/watch`. En auto, que es su valor por defecto, la librería lo calcula del RTT que comunica el relay (1,25 × el mínimo, con suelo de 20 ms). En ambos casos le suma el jitter de pista del catálogo; el valor efectivo se muestra junto al slider. En auto, `moq_target_ms` queda vacío en el CSV |

Los cuatro primeros requieren pulsar **Aplicar Cambios**; los sliders actúan al momento y su valor queda en el CSV (`dash_target_ms`, `dash_max_drift_s`, `moq_target_ms`).

El reproductor de dash.js queda accesible como `window.dashPlayer` en la consola del navegador para depurar.

---

## 9. API del orquestador (bajo `/api`)

| Método y ruta | Descripción |
| :--- | :--- |
| `GET /api/status` | Estado, configuración, `stream_ids`, reinicios del supervisor, disposición del timecode, anomalías de ingesta, deriva DASH y red (perfil y contadores del router) |
| `POST /api/start` | Arranca los empaquetadores (cuerpo opcional: configuración) |
| `POST /api/stop` | Detiene todo, incluida la codificación de la fuente. La parada se recuerda entre reinicios: no vuelve a emitir hasta `POST /api/start` |
| `POST /api/config` | Aplica una configuración y reinicia lo necesario. La escalera va en `renditions: [{height, bitrate_kbps}]`; se sigue aceptando `bitrate_kbps` para una única calidad 1080p |
| `POST /api/network` | Aplica un perfil de red (`down` y `up`) a las dos ramas en el router |
| `POST /api/trace` | Dadas las marcas de tiempo de frames ya pintados, devuelve cuándo pasó cada uno por los puntos de medida del servidor |
| `GET /api/time` | Reloj del servidor en ms, para la medida glass-to-glass |
| `GET /api/utc` | Reloj del servidor en ISO 8601, para el `UTCTiming` del manifiesto |
| `PUT` / `GET` / `DELETE /media/dash/{nombre}` | Origen LL-DASH; el navegador accede por el punto de entrada, a través del router y de Nginx |

Documentación interactiva en <http://localhost/docs>.

---

## 10. Estructura del proyecto

```text
moq-dash-initial-comparison/
├── README.md
├── CONTEXT_SUMMARY.md            # Decisiones y problemas resueltos
├── docker-compose.yml
├── media/                        # Vídeo fuente; se descarga solo y no se versiona
├── edge/
│   └── nginx.conf                # Entrada HTTP única (puerto 80)
├── router/                       # (MediaMTX no tiene carpeta: se configura por variables en docker-compose.yml)
│   ├── Dockerfile
│   └── agent.py                  # Reenvío IP, emulación con tc y agente de control
├── server/
│   ├── Dockerfile
│   ├── nginx.conf                # Proxy sin búfer hacia el origen
│   ├── requirements.txt
│   └── app/
│       ├── main.py               # API de control y ciclo de vida de los procesos
│       ├── source.py             # Descarga del vídeo fuente si falta
│       ├── trace.py              # Registro de por dónde pasa cada frame, para el desglose por etapas
│       ├── origin.py             # Origen LL-DASH en memoria y calibración del AST
│       └── tsgate.py             # Compuerta MPEG-TS: arranque en IDR y continuidad
└── web/
    ├── Dockerfile                # Build de Vite + Nginx con COOP/COEP
    └── src/
        ├── App.tsx               # Estado global, registro de muestras y export CSV
        ├── types.ts
        ├── lib/
        │   ├── clock.ts          # Sincronización con el reloj del servidor
        │   ├── glass.ts          # Lectura del timecode y medidor glass-to-glass
        │   └── trace.ts          # Seguimiento de frames por etapas en el navegador
        └── components/
            ├── ControlPanel.tsx
            ├── NetworkPanel.tsx
            ├── PipelineDiagram.tsx
            ├── DashPlayer.tsx
            ├── MoqPlayer.tsx
            └── MetricsDashboard.tsx
```


---

## 11. Estado y trabajo pendiente

Hecho:

- [x] Fuente común con marca de tiempo y streaming dual simultáneo.
- [x] LL-DASH con entrega chunked real y MoQ sobre WebTransport.
- [x] Dashboard unificado con parametrización en caliente.
- [x] Medida glass-to-glass homogénea, estadísticos y exportación CSV.
- [x] Emulación de red en los dos sentidos (ancho de banda, retardo, jitter, pérdida), idéntica para las tres ramas.
- [x] Rama WebRTC con MediaMTX (una calidad, sin adaptación).

Pendiente:

- [ ] Atribuir los ~200 ms entre latencia real y declarada en MoQ, repitiendo la medida con decodificación por hardware.
- [ ] Perfiles de red dinámicos (trazas o escalones programados) y modo de enlace compartido, para estudiar la competencia entre protocolos.
- [ ] Cliente fuera del host (contenedor u otra máquina) para que TCP sea extremo a extremo también en macOS.
- [ ] Adaptación de calidad: elegir el algoritmo ABR de dash.js (L2A, LoL+) desde el panel y corregir el bitrate inflado del catálogo MoQ.
- [ ] Carga de CPU: tres calidades a 1080p60 más dos reproductores en la misma máquina la dejan cerca de la saturación.

---

## 12. Créditos

El vídeo de prueba es *Big Buck Bunny* (versión Sunflower, 1080p 60 fps), © Blender Foundation, [bbb3d.renderfarming.net](http://bbb3d.renderfarming.net), bajo licencia [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
