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

**Cámara RTSP como fuente (opcional).** En lugar del bucle se puede emitir el directo de una cámara IP. Su URL va en el `.env`, que no se sube al repositorio, porque suele llevar usuario y contraseña:

```bash
CAMERA_RTSP_URL=rtsp://usuario:contraseña@10.0.5.10:554/stream1
```

Después, `docker compose up -d --no-deps orchestrator` y elegir **Cámara RTSP** en el selector **Fuente** del panel. La cadencia la anuncia la cámara; si no la anuncia bien, se fija con `CAMERA_FPS=15` en el mismo `.env`. El orquestador debe alcanzar la cámara por la red. Detalles en la sección 3.1b.

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

6. **DASH directo (recomendado para medir).** Por defecto DASH pasa por el punto de entrada, que es un proxy: la conexión TCP del navegador termina en él y la emulación de red actúa sobre una segunda conexión interna, no sobre la del navegador. Para que DASH vaya extremo a extremo, como MoQ y WebRTC:
   - Crear un nombre DNS que apunte **directamente** al servidor (no al proxy). Con DuckDNS, un subdominio propio, p. ej. `phd-testing.duckdns.org` → `10.0.0.5`.
   - Añadir al `.env` `DASH_HOST=phd-testing.duckdns.org` y `DUCKDNS_TOKEN=<token>`. El token solo vive en ese fichero, que no se sube al repositorio.
   - El servicio `dash-cert` obtiene y renueva un certificado de Let's Encrypt por el reto DNS (con `acme.sh`, sin registrar correo), que se guarda en `certs/`, también fuera del repositorio. `nginx-dash` lo activa al aparecer y sirve DASH con TLS y HTTP/1.1 en el puerto **8443/tcp**, que el router reenvía y degrada igual que los de MoQ y WebRTC.
   - El puerto 8443/tcp del servidor debe ser alcanzable desde los navegadores.

   El pie del reproductor DASH indica el camino en uso ("Directo" o "Vía proxy"), y el CSV lo registra en la columna `dash_path`. Sin `DASH_HOST`, todo sigue funcionando por el proxy.

La emulación de red necesita en el kernel los módulos `sch_prio`, `sch_tbf`, `sch_netem` y `cls_u32`. En un contenedor LXC deben estar cargados en el anfitrión; si faltan, todo lo demás funciona y el panel lo indica.

---

## 2. Arquitectura

```
                    ┌──────────────────────────────────────────────┐
                    │  Fuente maestra (FFmpeg, x264 zerolatency)   │
                    │  Big Buck Bunny 1080p60 en bucle o cámara    │
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
| `testbed-orchestrator` | Python 3.12 + FastAPI + FFmpeg 7.1 + `moq` CLI 0.14.7 | ninguno | Fuente maestra, empaquetadores, origen LL-DASH en memoria y API de control |
| `testbed-nginx-dash` | `nginx:alpine` | ninguno | Reenvía `/media/dash/` al origen con `proxy_buffering off` |
| `testbed-moq-relay` | `moqdev/moq-relay:0.17.7` | ninguno | Relay MoQ con certificado autofirmado |
| `testbed-mediamtx` | `bluenviron/mediamtx:1.21.2` | ninguno | Servidor WebRTC: recibe la calidad más alta por RTSP y la sirve por WHEP |
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
                   ..." \
  -filter_complex "[1:a:0]asetpts=N/(SR*TB)[a]" \
  -map [v0] ... -map [vN] -map [a] \
  -c:v libx264 -preset ultrafast -tune zerolatency -threads 4 -x264opts repeat-headers=1 \
  -b:v:0 <kbps>k -maxrate:v:0 <1,2 x kbps>k -bufsize:v:0 <kbps>k ... \
  -g <gop> -keyint_min <gop> -sc_threshold 0 -r 60 -c:a libopus -ac 2 -b:a 128k -max_interleave_delta 1 \
  -f tee "[f=mpegts:pes_payload_size=0]udp://127.0.0.1:5001?pkt_size=1316|[f=mpegts:pes_payload_size=0]udp://127.0.0.1:5002?pkt_size=1316"
```

- **Dos entradas del mismo fichero**, una para vídeo y otra para audio. El MP4 intercala ambos en bloques de 0,5 s; con una sola entrada a ritmo real el audio llega a ráfagas y el multiplexor retiene el vídeo.
- **El audio en su propio grafo de filtros y `-max_interleave_delta 1`.** Sin ellos el vídeo salía a ráfagas: en el mismo grafo, FFmpeg hace avanzar el vídeo al compás de los frames de audio del fichero (24 ms), y el multiplexor retiene cada frame de vídeo hasta tener audio posterior. Con los dos cambios la separación entre frames a la salida queda igual que sin audio (p95 de 24 ms, ningún hueco de más de 50 ms; antes, p95 de 45 ms y un hueco de más de 50 ms por segundo), y la etapa de codificación baja de unos 30 a unos 10 ms. Detalle en el Anexo C de `PROTOCOLOS.md`.
- **`pes_payload_size=0`**: un PES por frame de audio. Por defecto MPEG-TS agrupa ~180 ms de audio y eso retrasa el vídeo aguas abajo.
- **Audio en Opus** (desde el 22-10-2026; antes AAC-LC). Es el único códec que admiten las tres ramas: DASH lo lleva en CMAF (`audio/mp4`, `codecs="opus"`), MoQ en su pista `1.opus` y WebRTC lo copia tal cual si se le activa el audio (sección 3.4b). Con AAC, WebRTC tendría que recodificarlo. Cambiar de códec no se nota en el resto, medido alternando AAC y Opus con la cámara a 15 fps y sin sonido en ningún reproductor, dos rondas de 60 s:

  | Audio de la fuente | Retraso del codificador p50 / p95 | Glass-to-glass MoQ | Glass-to-glass WebRTC | Glass-to-glass DASH |
  | :--- | :--- | :--- | :--- | :--- |
  | AAC | 5,0-5,3 / 6,3-6,9 ms | 51-57 ms | 60-68 ms | 347 ms (y 1027 en la primera ventana, arrancando) |
  | Opus | 5,2-5,3 / 6,7-7,6 ms | 47-66 ms | 64-66 ms | 347-350 ms |

  Un frame Opus dura 20 ms y uno AAC 21,3 ms. Las medidas anteriores a ese día se hicieron con AAC; los ejemplos de MPD y de catálogo de los anexos de `PROTOCOLOS.md` también.
- **Escalera de calidades**: la fuente codifica en vivo de 1 a 5 calidades (por defecto 1080p@4000, 720p@2000 y 360p@700 kbps), todas a 60 fps y con el mismo GOP para que sus keyframes coincidan. Viajan como varios vídeos de un mismo MPEG-TS.
- **Tope de tasa**: cada calidad lleva `-maxrate` al 120 % y un VBV de 1 s, para que el bitrate nominal sea una referencia fiable para la adaptación y la emulación de red.
- **Etiqueta de calidad**: cada calidad lleva quemado arriba a la derecha su nombre (`720p 2000 kbps`), para ver de un vistazo cuál se reproduce.
- **Timecode binario**: se quema en cada calidad después de escalarla. Ver sección 4.
- **Cuatro salidas**: UDP 5001 (DASH), 5002 (MoQ), 5003 (WebRTC) y 5004, que solo se escucha mientras se graba una prueba de QoE (sección 4.7). Sin nadie escuchando, los paquetes de 5004 se descartan en el kernel. Con la cámara como fuente hay una quinta, 5005, con la referencia para el VMAF (sección 3.1b).

Cambiar el GOP, la escalera o la fuente reinicia la fuente; cambiar segmento o fragmento solo reinicia los empaquetadores. **Detener Pipeline** para también la fuente, que es la que consume CPU, y el servidor queda en reposo; la parada se conserva aunque se reinicie el contenedor o la máquina.

### 3.1b. Fuente alternativa: cámara RTSP

Con **Fuente: Cámara RTSP** (`"source": "camera"` en `POST /api/config`), la fuente maestra lee la cámara de `CAMERA_RTSP_URL` en vez del fichero. Todo lo que va después es igual: escalera, reloj, timecode, x264 con el mismo GOP y las mismas salidas UDP. Cambia la entrada:

```bash
ffmpeg -rtsp_transport tcp -timeout 5000000 -fflags nobuffer -flags low_delay -i <cámara> \
  -filter_complex "[0:v]fps=<fps>,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2, \
                   setsar=1,setpts=N/(<fps>*TB),split=2[reference][base];[base]drawtext=<reloj>,split=N[s0]..[sN]; ..." \
  -filter_complex "[0:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[a]" \
  -filter_complex "anullsrc=r=48000:cl=stereo,asetpts=N/(SR*TB)[reference_audio]" \
  <escalera, igual que con el bucle> -f tee "...5001|...5002|...5003|...5004" \
  -map [reference] -map [reference_audio] -c:v libx264 -preset ultrafast -tune zerolatency -qp 10 -threads 4 \
  -g <gop> -keyint_min <gop> -sc_threshold 0 -c:a libopus -muxdelay 0 -muxpreload 0 -f mpegts udp://127.0.0.1:5005
```

- **Sin `-re`**: la cámara ya entrega a su ritmo.
- **Cadencia**: la emisión va a los fps que anuncia la cámara, redondeados. El servidor la sondea con `ffprobe` al arrancar con ella y sustituye el valor de `fps` de la configuración; el panel lo muestra junto al selector. El filtro `fps` deja una cadencia constante con las marcas de tiempo de la propia cámara: si la cámara pierde un frame, se repite el anterior. El GOP sigue yendo en frames, así que su duración depende de los fps; el panel ofrece las mismas duraciones (0,25 a 2 s) en frames de la cadencia en curso.
- **1920x1080**: cada frame se lleva a 1080p (con bandas si la cámara no es 16:9) antes de la escalera, como el vídeo del bucle.
- **Audio**: el de la cámara (en la de pruebas, G.711 a 8 kHz mono), pasado a 48 kHz estéreo y codificado en Opus como el del bucle. Usa las marcas de tiempo de la cámara, como el vídeo (`aresample=async=1`). Si la cámara no tiene micrófono, silencio generado. No frena a la escalera, medido alternando con el silencio dos rondas: retraso del codificador p50 5,6-6,2 ms con el audio de la cámara frente a 5,6-7,0 con silencio (p95 10-11 ms en ambos), y audio y vídeo alineados a menos de 13 ms en el flujo grabado.
- **Referencia para el VMAF (UDP 5005)**: no hay original guardado, así que la fuente emite cada frame tal como entra en la escalera, antes de dibujar nada encima, codificado casi sin pérdidas. Solo se graba durante las pruebas de QoE (sección 4.7); el resto del tiempo nadie escucha y el kernel descarta los paquetes, sin tocar el disco.
- **Caídas**: si la cámara deja de responder 5 s, FFmpeg termina y el supervisor relanza la fuente, con al menos 3 s entre intentos.

La URL no sale por la API ni al CSV: `GET /api/camera` y `/api/status` dan solo el host, lo que anunció la cámara (códec, resolución, fps, audio) y el último error. FFmpeg sí la escribe en su log, dentro del contenedor (`/tmp/ffmpeg_master.log`).

**La referencia no frena a la escalera.** Comparte proceso con ella y FFmpeg hace avanzar todas las salidas a la par. Sin `-tune zerolatency`, x264 reparte los frames entre hilos y entrega cada uno varios frames después, y la escalera quedaba retenida a ese ritmo. Medido el 22-10-2026 con la cámara a 15 fps, una calidad 1080p y sin espectadores, alternando las variantes en la misma sesión (retraso del codificador: marca quemada → llegada a la compuerta de MoQ):

| Referencia | p50 | p95 |
| :--- | :--- | :--- |
| Ninguna | 5,8-5,9 ms | 9,8-11,0 ms |
| Sin `zerolatency` (descartada) | 76-106 ms | 207-245 ms |
| Con `zerolatency` (la actual) | 5,4-5,7 ms | 9,7-9,9 ms |

Quitar el audio o los ajustes del multiplexor de la referencia no cambiaba nada; solo `zerolatency`. La calidad de la referencia no cambia con él (ver sección 4.7).

**Lo que cambia frente al bucle** (variables de confusión, a declarar):
- **La latencia medida empieza igual**, al quemar el timecode, que es después de recibir y decodificar la cámara. No incluye el tramo cámara → servidor (sensor, codificador de la cámara, red); medir de cristal a cristal exigiría apuntar la cámara a un reloj.
- **El contenido no se repite.** Una escena casi quieta se codifica con mucho menos que el bitrate nominal, con keyframes distintos, y da VMAF más altos. Las pruebas con la cámara no son comparables con las del bucle ni entre sí. Dentro de una prueba, las tres ramas sí ven exactamente lo mismo.
- **La entrada no es regular.** Lo que la red de la cámara haga con los frames llega igual a las tres ramas, pero pasa por el filtro `fps`. Se nota en WebRTC, que lo ve como jitter de llegada: 19-27 ms en el vídeo y 27-28 ms en el audio con la cámara de pruebas, frente a 0-2 y 5-7 ms con el bucle (`getStats()`, 22-10-2026). Su búfer de jitter crece en consecuencia, y la latencia de WebRTC sin audio pasa de 59-71 ms con el bucle a 244-329 ms con la cámara.
- **Deriva de reloj**: la cadencia sale de las marcas de tiempo de la cámara. Si su reloj se separa del del servidor, se verá en `dash_availability_drift_ms`.

### 3.2. Compuerta `tsgate.py`

Los dos empaquetadores leen su puerto UDP a través de `server/app/tsgate.py`, que:

- descarta todo hasta el primer keyframe de vídeo y antepone las tablas PAT/PMT, de modo que audio y vídeo empiezan juntos en ambas ramas;
- vigila los contadores de continuidad MPEG-TS y escribe en el log cualquier salto (pérdida en el reparto UDP interno).

### 3.3. Rama LL-DASH

```bash
python3 tsgate.py 5001 | ffmpeg -analyzeduration 1000000 -i pipe:0 \
  -map 0:v -map 0:a:0 -c:v copy -c:a copy -tag:v avc1 -b:v:0 <kbps>k ... \
  -f dash -dash_segment_type mp4 -adaptation_sets "id=0,streams=v id=1,streams=a" -seg_duration <seg> -frag_type duration -frag_duration <frag> \
  -streaming 1 -ldash 1 -use_template 1 -use_timeline 0 \
  -utc_timing_url /api/utc \
  -window_size <30 s en segmentos> -extra_window_size <ídem> \
  -method PUT -http_persistent 1 http://127.0.0.1:8000/media/dash/manifest.mpd
```

- **Publicación por HTTP PUT al origen en memoria** (`server/app/origin.py`). Cada segmento se sirve a los clientes mientras FFmpeg aún lo está escribiendo, fragmento a fragmento. Escribiendo a disco FFmpeg solo expone el segmento completo.
- **`-use_timeline 0`** hace que el manifiesto anuncie `availabilityTimeOffset`, que es lo que permite a dash.js pedir el segmento en curso.
- **`-frag_type duration`** es necesario para que `-frag_duration` tenga efecto.
- **`-dash_segment_type mp4`**: con audio Opus, FFmpeg metería esa pista en WebM; así va en CMAF como el vídeo.
- **`availabilityStartTime` calibrado**: el origen sustituye el que escribe FFmpeg (retrasado por su sondeo de entrada) por el deducido del instante real en que se abre un segmento. El manifiesto no se publica hasta tenerlo, unos segundos tras cada arranque.

El segmento no puede ser más corto que el GOP; backend y frontend lo validan.

### 3.4b. Rama WebRTC

```bash
python3 tsgate.py 5003 rtc | ffmpeg -fflags nobuffer -analyzeduration 1000000 -i pipe:0 \
  -map 0:v:0 -c:v copy -an -f rtsp -rtsp_transport tcp rtsp://mediamtx:8554/live
```

- **MediaMTX** recibe por RTSP la calidad más alta, sin recodificar, y la sirve por WebRTC. El navegador negocia por WHEP (`/rtc/live/whep`, a través del punto de entrada) y recibe el vídeo directo por UDP 8189, pasando por el router de emulación.
- **Una sola calidad y, por defecto, sin audio.** No hay adaptación: esta rama sirve siempre la calidad más alta de la escalera. El audio Opus de la fuente se le añade, sin recodificar, con **Audio en WebRTC** en el panel (`rtc_audio` en `POST /api/config`; `-map 0:a:0 -c:a copy` en vez de `-an`). Viene desactivado porque cambia lo que se mide: el navegador sincroniza las dos pistas y **retrasa el vídeo hasta el búfer de jitter del audio**. Medido el 22-10-2026 en Chrome headless, con `getStats()` de la conexión (`jitterBufferTargetDelay` medio de cada pista) y sin sonido en ningún reproductor:

  | Fuente y momento de la conexión | Glass-to-glass WebRTC | Búfer objetivo vídeo | Búfer objetivo audio |
  | :--- | :--- | :--- | :--- |
  | Bucle, sin audio | 59-71 ms | 15-20 ms | — |
  | Bucle, con audio, conectando justo al arrancar la emisión (antes de la espera de abajo) | 142-151 ms | 76-134 ms | 40-51 ms |
  | Bucle, con audio, conectando con la emisión ya en marcha | 79-149 ms (226 en una conexión con el audio a 105 ms) | 34-92 ms (128) | 40-48 ms (105) |
  | Cámara, sin audio | 244-329 ms | 130-143 ms | — |
  | Cámara, con audio (cualquier momento) | 330-557 ms | 154-336 ms | 225-315 ms |

  - **El vídeo sigue al búfer del audio.** Con audio, su búfer objetivo sube hasta el del audio, en todas las conexiones medidas. Sin audio, el vídeo se queda con el suyo.
  - **Cuánto sube depende del audio.** Con el bucle, el audio llega regular (jitter 5-7 ms) y pide ~40 ms: la subida es pequeña. Con la cámara llega irregular (jitter 27-28 ms, y el vídeo 19-27 ms frente a 0-2 con el bucle) y pide 225-315 ms: la subida es de 100-200 ms.
  - **Conectar en los primeros segundos de la emisión** deja el vídeo además 45-55 ms por encima, durante toda la sesión. Medido con dos clientes WHEP mínimos en la misma página, uno al publicarse la emisión y otro 30 s después (búfer objetivo de vídeo 120 y 82 ms frente a 74 y 28; con el audio en 40 ms en todos). Conectando 3 s después de publicarse, mixto; 6 s después, ya no. Ese cliente recibe de golpe el último segundo de media (unos 50 paquetes de audio en el primer cuarto de segundo, frente a 12-13). No es el sondeo de 1 s del empaquetador: con 0,1 s pasa lo mismo. Qué lo envía de golpe no está localizado.
  - **Por eso el reproductor del dashboard espera** a que la emisión lleve unos segundos publicada antes de conectar (8 s desde que arranca el empaquetador, con el reloj sincronizado con el servidor; muestra "Esperando a que la emisión lleve unos segundos publicada"). Antes, aplicar un cambio sin recargar reconectaba justo al arrancar y medía ese caso, y recargar medía el otro: con el bucle y audio, 142-151 ms frente a 79-114. Con la espera, 100 y 119 ms sin recargar frente a 113 y 149 recargando, y sin audio 61-72 ms. Es lo que le pasa a cualquier espectador que se une a un directo ya en marcha; no cambia nada del protocolo.

  Antes de esta medida se había atribuido al audio una subida de 110-180 ms a partir de dos rondas que reconectaban todo en cada cambio; la variación entre sesiones era del mismo orden, así que aquella cifra no valía como medida del efecto. En el CSV, `rtc_audio`.
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
| Tiempo en pantalla de cada frame | Del pintado de un frame (timecode nuevo) al del siguiente, con el mismo medidor. Tarjeta: desviación típica y p95 del último segundo; CSV: `*_frametime_sd_ms`, `*_frametime_p95_ms` y `*_frametime_max_ms`; gráfica: cada frame de los últimos 10 s (pestaña **Tiempo en pantalla**). Va en refrescos de pantalla (16,7 ms a 60 Hz), así que depende de la pantalla y del navegador además del protocolo, y un frame que el medidor no lee (lectura anterior sin terminar, timecode ilegible) cuenta como uno de doble duración. Los parones entran con su duración |
| Bitrate de vídeo recibido | Bytes de vídeo descargados sobre una ventana de 10 s (dash.js: segmentos completados; MoQ: `bytesReceived` del decodificador) |
| Tráfico IP en el router | Bytes IP reenviados por protocolo y sentido, con cabeceras y retransmisiones; misma capa para ambos. Es la cifra rigurosa de consumo de red |
| Descarga total | A nivel de aplicación y en capas distintas, así que la comparación es orientativa. DASH: tamaño transferido de todas las peticiones (vídeo, audio y manifiesto, con cabeceras HTTP de respuesta) según la Resource Timing API. MoQ: `WebTransport.getStats()` si el navegador lo implementa; en Chrome no existe y se suma la carga útil de las pistas descargadas. El detalle aparece al pasar el ratón por la tarjeta |
| Latencia según reproductor | La que declara cada uno (`getCurrentLiveLatency()` en dash.js, retardo de sincronización en `@moq/watch`); solo como contraste |
| Búfer local (DASH) | Segundos de vídeo descargados por delante del punto de reproducción (`getBufferLength('video')`) |
| Búfer de jitter (MoQ y WebRTC) | Tiempo medio que cada frame pasa retenido en el reproductor. WebRTC: `jitterBufferDelay / jitterBufferEmittedCount` de `getStats()`, desde el primer paquete hasta la salida hacia el decodificador. MoQ: desde que `@moq/watch` lee el frame de la red hasta que lo entrega para pintarlo; incluye la decodificación |

Cuando no hay medida se muestra `--`; no se rellena con valores supuestos.

Silenciado, `@moq/watch` no descarga el audio, mientras que dash.js lo descarga siempre: unos 130 kbps de la diferencia en descarga total vienen de ahí.

#### Por qué los frames presentados bajan de 60

Medido el 21-10-2026 con Chrome headless en el Mac del usuario contra el servidor, por la VPN WireGuard, con una calidad 1080p y una sonda que cuenta cada segundo lo que llega, lo que se decodifica y lo que se pinta en cada reproductor (`requestVideoFrameCallback` y `getVideoPlaybackQuality` en los `<video>`, `getStats` en WebRTC, y en MoQ el contador `frameCount` del decodificador y los cambios de `decoder.out.frame` y `renderer.out.frame`). Son tres causas distintas:

1. **La red, cuando reproducen los tres a la vez por la VPN.** Los tres flujos suman unos 12,5 Mbit/s, más las ráfagas de DASH al arrancar, y el túnel da unos 21 Mbit/s en una conexión TCP. En los colapsos el RTT HTTP al servidor pasa de unos 50 ms a 1,2-5,9 s y la llegada cae a la vez en las tres ramas (de 0 a 30 fps durante varios segundos, y después llega todo de golpe), mientras la traza del servidor muestra el codificador a 60 fps sin huecos. Sin reproductores, en 71 s el RTT no pasó de 138 ms. Por la red local no se ha medido.
2. **Pintar 60 fps en una pantalla de 60 Hz sin acompasar los frames al refresco.** Con la llegada y la decodificación a 60 fps:
   - **WebRTC** pinta unos 52-53: el navegador descarta unos 7 frames por segundo ya decodificados cuando dos caen en el mismo refresco. Con `--disable-frame-rate-limit` pinta 59 y descarta 1 por segundo; no depende de la carga ni del medidor.
   - **MoQ** pinta 45-56 según la pasada: `@moq/watch` libera cada frame a su hora de presentación y, si llegan dos antes del siguiente refresco, dibuja solo el último. Con `delay: auto` el búfer queda en unos 75 ms para un jitter medido de 27 ms, y los frames que llegan tarde se liberan nada más decodificarse y se amontonan. Alternando en la misma sesión: con `auto` (76 ms), 53,6 fps pintados; con 500 ms (546 ms), 59,5. Es el comportamiento por defecto de la librería, y así se mide.
   - **DASH** pinta 57-60: el `<video>` con MSE presenta al ritmo del reloj de reproducción.
3. **El propio medidor.** La lectura del timecode (`VideoFrame.copyTo`) ocupa el 21,5 % del hilo principal con los tres reproductores, unos 1,3 ms síncronos por lectura. Apagándola en tramos alternos de 8 s, el hilo principal pasa del 40 % al 10 % ocupado y MoQ pinta 47,3 fps en vez de 44,9; DASH y WebRTC no cambian. El medidor le cuesta a MoQ unos 2-3 fps.

Lo que marca el medidor coincide con lo que pinta cada reproductor (diferencias de menos de 1 fps): la caída es real, no un error de cuenta. Con una pantalla de 120 Hz la causa 2 debería pesar menos; no se ha medido. Aparte, en el servidor la entrada del publicador de MoQ tuvo esperas de hasta 665 ms con una sola calidad (`forwarded_ms` de `POST /api/trace`), que dejan a MoQ solo sin frames durante unos segundos. Vienen de los keyframes: `moq-cli` 0.14.7 no procesa más de ~2 MB/s de entrada, y cada keyframe (~100 kB) lo frena unos 50 ms en local y mucho más con la máquina cargada (detalle en `PROTOCOLOS.md`, sección 4.14).

Por la red local (21-10-2026, el testbed en el mismo Mac que el navegador, una calidad), la llegada fue de 60 fps en todos los segundos y los frames pintados, 59,8-59,9 en DASH, 56,4-59,8 en MoQ y 58,8-59,8 en WebRTC con los tres a la vez. El codificador local entrega los frames con una desviación de 1,3 ms (p99 20 ms), frente a 5,7 ms (p99 35 ms) en el servidor: el jitter de la fuente depende de la máquina que codifica.

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

### 4.4b. Versiones de los componentes

Las medidas dependen de la versión exacta de cada pieza de terceros: entre dos versiones seguidas del relay cambió, por ejemplo, la implementación de QUIC que lleva dentro. Por eso todas van **fijadas**, se muestran en la cabecera del dashboard y quedan en la columna `versions` del CSV.

| Componente | Dónde se fija la versión |
| :--- | :--- |
| `moq-relay` | `docker-compose.yml`, `MOQ_RELAY_VERSION` (dos valores por defecto: la imagen y la variable que la muestra) |
| MediaMTX | `docker-compose.yml`, `MEDIAMTX_VERSION` (igual) |
| `moq-cli` | `server/Dockerfile`: la versión publicada, en la URL de descarga. Con `MOQ_CLI_FROM=git` en el `.env` se compila desde el commit `MOQ_CLI_COMMIT` (ver abajo) y se identifica como `git@<commit>` |
| `@moq/watch`, `dash.js` | `web/package.json` y `web/package-lock.json`. Con `MOQ_WATCH_FROM=git` en el `.env`, `@moq/watch` y sus paquetes `@moq/*` se compilan desde el commit `MOQ_WATCH_COMMIT` (ver abajo) y se identifican como `git@<commit>` |
| FFmpeg | El paquete de Debian de la imagen del orquestador; no se consulta si hay novedades |
| `vmaf` (solo QoE) | `server/Dockerfile`, `VMAF_VERSION`; no se muestra en el dashboard, queda en cada resultado de VMAF |

**`moq-cli` desde un commit.** Para medir una versión del publicador aún no publicada, el `.env` admite `MOQ_CLI_FROM=git` y `MOQ_CLI_COMMIT=<hash>` (por defecto, `release` y el commit `bc64b9c` de `main`). La etapa de compilación solo se construye con `git`; con `release` no se compila nada. Compila con LTO *thin* y solo el transporte QUIC (el LTO completo no cupo en 7,7 GB de RAM) y guarda las cachés de Cargo entre construcciones, así que la memoria solo se usa al construir y cambiar de commit reutiliza las dependencias. Si no cambia el commit, la etapa sale de la caché de Docker. Para liberar el disco de esas cachés: `docker builder prune`.

**`@moq/watch` desde un commit.** Igual para el reproductor: `MOQ_WATCH_FROM=git` y `MOQ_WATCH_COMMIT` (por defecto, `release` y `bc64b9c`). `web/Dockerfile` compila con bun los once paquetes `@moq/*` que necesita (`clock`, `signals`, `pattern`, `net`, `flate`, `json`, `loc`, `hang`, `msf`, `video` y `watch`) y la web los usa en vez de los de npm, también como dependencias indirectas (`overrides`). Al instalar en Linux, el lockfile de moq no trae el binario nativo de `rolldown` ni `pako`, que se añaden en la versión que fija; sin `pako`, cuatro de los paquetes salían con sus fuentes `.ts` sin compilar, así que la construcción exige el `package.json` de publicación de cada uno. `MoqPlayer.tsx` vale para las dos versiones. Construir la web así tarda alrededor de un minuto. `web/.dockerignore` evita que el `node_modules` del anfitrión pise el instalado en la imagen.

El orquestador consulta cada 6 horas la última versión publicada de cada uno (Docker Hub, las publicaciones de GitHub y el registro de npm) y el dashboard marca en ámbar los que tienen una más nueva. **Es solo un aviso: nada se actualiza solo.** Para actualizar hay que cambiar la versión fijada y volver a desplegar (`docker compose up -d --build`); las medidas hechas con versiones distintas no son comparables entre sí.

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

### 4.7. Evaluación de QoE (en construcción)

Objetivo: puntuar cada sesión con la QoE de LL-GABR (Raman et al., 2024, ecuación 6), que combina VMAF, parones, latencia, velocidad de reproducción y cambios de calidad. **El VMAF no se calcula en el navegador ni se graba allí el vídeo**: grabar los fotogramas cargaría el navegador (y alteraría la medida) y enviarlos obligaría a recodificar. En su lugar:

1. Durante la prueba, el servidor graba el flujo que sale del codificador. Es el mismo que reparten las tres ramas, que no recodifican.
2. El navegador anota qué timecode muestra y cuándo (pendiente).
3. El servidor calcula el VMAF de cada fotograma grabado frente a su original de Big Buck Bunny (hecho) y, con el registro del navegador, reconstruye lo que vio el espectador (pendiente).

En DASH y MoQ el transporte es fiable y la decodificación H.264 es determinista, así que el fotograma reconstruido es el que se pintó. En WebRTC con pérdidas no tiene por qué: la ocultación de errores del navegador no se reproduce y el VMAF saldría optimista.

**Fase a, hecha: grabación y emparejamiento con el original.** `POST /api/qoe/recordings` graba de 5 a 300 s desde el siguiente keyframe (`server/app/recorder.py`, que escucha en la cuarta salida del tee de la fuente, UDP 5004, solo mientras graba). Después `server/app/qoe.py` indexa cada fotograma de cada calidad:

- saca su número de frame del PTS, que la fuente pone exacto (`setpts=N`: número de frame por 1500 ticks más una base);
- fija esa base con el timecode: lee el de cada fotograma con la misma lectura que el navegador (`decodeTimecodeFromFrame`) y cada uno que cae a menos de 4 ms de una marca de las que FFmpeg escribe al quemarlo (las del desglose por etapas, copiadas mientras dura la grabación) vota por la base que resulta;
- el número de frame módulo los frames del original (38 072) es el fotograma de Big Buck Bunny del que viene: la fuente vuelve a empezar la numeración del original en cada vuelta del bucle.

El índice cuenta lo que no cuadra y debe ser 0: PTS fuera de la rejilla (`pts_off_grid`), números no consecutivos (`not_consecutive`) y timecodes a más de 100 ms de su propia marca (`timecode_disagree`). Si no es 0, el VMAF se niega. El último fotograma de cada calidad se descarta: el grabador lo corta y el decodificador lo completa con el anterior.

**El timecode quemado no es exactamente la marca.** Cada uno de sus 20 bits lee el reloj por separado y la marca se escribe con el último; con la máquina cargada pasa algo de tiempo entre unos y otros. El índice anota la diferencia (`timecode_lag_ms`). Medido el 21-10-2026 en el servidor: mediana 0 ms y p95 1 ms, con máximos de 12 ms (una calidad) y 6 ms (tres) y mínimos de −4 ms; en local, 0-1 ms. Unos pocos fotogramas por grabación pasan de los 4 ms de tolerancia: por eso el número de frame sale del PTS y el timecode solo fija la base. En la medida glass-to-glass, que lee ese mismo timecode, el error es de ese orden en esos pocos fotogramas.

`POST /api/qoe/recordings/{id}/check` comprueba el emparejamiento por PSNR: para 20 fotogramas por calidad, escalados a 1080p, compara con su original y con los dos anteriores y posteriores. Se compara sin lo que la fuente dibuja encima (reloj, etiqueta de calidad y franja del timecode: filas 136 a 927 en la escalera por defecto). Medido en local el 20-10-2026:

| Calidad | PSNR medio (−2, −1, **0**, +1, +2) | Máximo en el emparejado |
| :--- | :--- | :--- |
| 1080p (sola) | 30,2 · 31,8 · **35,4** · 31,6 · 29,9 dB | 19 de 20 |
| 1080p (escalera) | 30,2 · 31,8 · **34,1** · 31,5 · 29,6 dB | 17 de 20 |
| 720p | 29,4 · 30,6 · **32,2** · 30,2 · 28,7 dB | 13 de 20 |
| 360p | 27,5 · 28,2 · **29,1** · 28,0 · 27,0 dB | 11 de 20 |

**Con la cámara como fuente**, el original es la referencia que la fuente emite por UDP 5005 (sección 3.1b). Se graba a la vez que el flujo (`reference.ts`, junto a `stream.ts`). Su grabador arranca antes, espera a su propio keyframe y dura 5 s más, para cubrir todos los fotogramas grabados. Tiene los mismos PTS que la escalera, así que el índice numera sus frames con la base de la primera calidad, sin decodificarla. El índice comprueba que la referencia no tenga PTS fuera de la rejilla ni huecos y que cubra todas las calidades (`reference` en la grabación: `pts_off_grid`, `not_consecutive` y `uncovered_streams`); si no, el VMAF y la comprobación se niegan. La comprobación por PSNR es la que confirma que el emparejamiento es bueno: con la base desplazada un número entero de frames, la rejilla cuadraría igual.

Para que los PTS coincidan hubo que corregir dos cosas, cada una de las cuales desplazaba la referencia sin que la rejilla lo delatara:
- FFmpeg suma `muxdelay` y `muxpreload` (0,7 + 0,5 s) a los PTS de una salida MPEG-TS, pero no a las de dentro del `tee`. Con ellos, la referencia iba 36 frames por delante a 30 fps.
- FFmpeg desplaza cada salida para que nada empiece en negativo, y el codificador de audio empieza unas muestras antes: 312 con Opus (585 ticks), 1024 con el AAC de antes (1920 ticks, más de un frame a 60 fps). La referencia lleva una pista de silencio propia, en el mismo códec, solo para desplazarse igual que la escalera.

Para la referencia se usa x264 con `qp` 10. Medido sobre 5 s de Big Buck Bunny el 22-10-2026, frente al original:

| Referencia | Mbit/s | VMAF medio / mínimo | PSNR de luma |
| :--- | :--- | :--- | :--- |
| qp 0 (sin pérdidas) | 238 | 99,26 / 97,43 | 60 dB (idéntica) |
| qp 6 | 141 | 98,98 / 96,76 | 54,1 dB |
| **qp 10 (la usada)** | **99** | **98,79 / 96,39** | **51,5 dB** |
| qp 14 | 61 | 98,26 / 95,29 | 48,4 dB |

Con `-tune zerolatency` sale exactamente lo mismo. El VMAF de una copia idéntica no es 100 (99,26), así que la referencia cuesta ~0,5 puntos. Ocupa según la imagen: con la cámara de pruebas (1080p a 15 fps, escena casi quieta), ~9 Mbit/s, unos 27 MB por cada 20 s de prueba.

Medido el 22-10-2026 en local con esa cámara, una calidad 1080p a 4000 kbps y 20 s: índice y referencia sin incidencias, VMAF medio 95,3 (p5 93,7). En la comprobación, el emparejado gana en las 20 muestras, pero con un margen mínimo de 0,1 dB (45,07 dB frente a 44,56 y 44,0 de los vecinos): con una escena casi quieta, los fotogramas vecinos se parecen mucho. Con una cámara simulada (Big Buck Bunny a 720p30 publicado en MediaMTX), 44,97 dB en el emparejado frente a 34-37 dB de los vecinos.

Una grabación de 20 s que cruza el cambio de vuelta del bucle (frames 37 500 a 38 698, con el corte en 38 072) da lo mismo a ambos lados del corte: 1080p 44,7 dB en el emparejado frente a 34,3 y 34,2 en los vecinos inmediatos, 720p 43,1 frente a 35,7 y 35,6, 360p 36,5 frente a 31,9 y 32,0, sin ningún PTS ni número de frame incoherente.

Las muestras en que gana un vecino tienen todas menos de 0,5 dB de diferencia, están en escenas lentas y el vecino es siempre uno anterior; con poco bitrate x264 copia bloques del fotograma de referencia y la imagen arrastra algo del anterior (deducción, no medida). Un desplazamiento del índice daría el máximo fuera de 0 también en las escenas con movimiento, y con márgenes de varios dB.

Decodificar, escalar y comparar se hace después de grabar y en procesos con `nice 19`, pero **con `nice 19` no basta para no tocar al codificador**. Medido en el servidor el 20-10-2026, con una calidad 1080p y sin espectadores, el retraso del codificador (marca quemada → llegada a la compuerta, `POST /api/trace`):

| Mientras | Retraso p50 / p95 / máx. | Duración |
| :--- | :--- | :--- |
| Reposo | 6,1 / 15,8 / 42,6 ms | |
| Se graba | 4,8 / 11,2 / 19,6 ms | 30 s |
| Se indexa | 5,5 / 15,8 / 44,7 ms | 5,3 s para 30 s grabados |
| Se comprueba por PSNR | **10,7 / 28,4 / 48,1 ms** | 22,7 s |

Grabar e indexar no se notan; la comprobación sí. Por eso lo que compara imágenes (la comprobación y el VMAF) **solo se hace con la emisión parada**: la comprobación se rechaza con la emisión en marcha. Las grabaciones se guardan en `media/qoe/` (se conservan las 10 últimas).

**Fase b, hecha: VMAF de cada fotograma grabado.** Al indexar, la grabación entra en una cola. El cálculo empieza en cuanto la emisión está parada (`POST /api/stop`; ni empaquetadores ni fuente). Si la emisión vuelve a arrancar a medias, se interrumpe y vuelve a la cola, igual que si se reinicia el orquestador. `POST /api/qoe/recordings/{id}/vmaf` vuelve a encolar una grabación, y el resultado se lee con `GET` en la misma ruta.

- **Herramienta:** `vmaf` de Netflix 3.0.0, compilada en una etapa propia de `server/Dockerfile`. El FFmpeg de Debian no trae libvmaf y no se cambia, porque es el que codifica la fuente. FFmpeg solo decodifica y escala; `vmaf` compara.
- **Modelo:** `vmaf_v0.6.1`, el de por defecto (1080p visto a tres alturas de pantalla). La imagen grabada se escala a 1920x1080 con bicúbico, como pide el método de VMAF; el navegador escala con su propio algoritmo.
- **Zona comparada:** la misma de la comprobación (sin reloj, etiqueta ni franja del timecode), así que el VMAF no es el de la imagen entera.
- **Referencia:** como los fotogramas grabados son consecutivos (lo comprueba el índice; si no lo son, el cálculo se niega), el original es un tramo continuo del vídeo fuente, partido en dos si cruza el final del bucle. Con `-stream_loop`, FFmpeg no vuelve al frame 0 después de un `-ss`: con un solo tramo, los fotogramas posteriores al corte salían con VMAF 0.
- **Salida:** VMAF y PSNR de luma de cada fotograma, por calidad y en el orden del índice, más media, p5 y mínimo.

Medido en local (10 núcleos) con la grabación que cruza el final del bucle, 20 s y tres calidades: 55 s de cálculo. VMAF medio 89,9 (1080p), 82,0 (720p) y 58,2 (360p); p5 72,5, 58,4 y 25,5. Los fotogramas en negro del final y del principio del vídeo dan 97,4 en las tres calidades.

En el servidor (8 vCPU), el 21-10-2026, con 30 s grabados: 51-59 s de cálculo con una calidad y 138 s con tres (27 s grabados). VMAF medio a 1080p y 4000 kbps entre 69 y 78 según el tramo de la película (p5 57-62); con la escalera, 68,8 (1080p), 56,4 (720p) y 32,1 (360p). La prueba de principio a fin (grabar con la emisión en marcha, `POST /api/stop`, cálculo automático) funciona: empieza a los pocos segundos de la parada.

---

## 5. Emulación de red

El router (`router/agent.py`) reenvía los puertos del navegador con DNAT, sin terminar conexiones, y degrada ese tráfico con `tc`. Se controla desde el panel **Emulación de Red** o con `POST /api/network`.

| Parámetro | Por sentido | Notas |
| :--- | :--- | :--- |
| Ancho de banda (kbit/s) | Sí | Vacío = sin límite |
| Retardo (ms) | Sí | El RTT es la suma de bajada y subida |
| Jitter (ms) | Sí | No puede superar el retardo. **Desordena los paquetes, y mucho** (ver abajo) |
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

**El jitter de netem desordena los paquetes, y eso hunde a MoQ (medido el 21-10-2026, en local).** netem da a cada paquete un retardo aleatorio propio (uniforme en ±jitter, correlación 25 %) y los entrega por orden de salida, así que dos paquetes que salen juntos pueden llegar con hasta 2×jitter de diferencia y en orden inverso. Con un flujo de prueba numerado por la cola de bajada de MoQ (ráfagas de 6 paquetes cada 16,7 ms):

| Perfil | Llegan fuera de orden | Adelantados por 3 o más posteriores |
| :--- | :--- | :--- |
| 150 ms, sin jitter | 0 % | 0 % |
| 150 ± 20 ms | 69 % | 39 % (máx. 12) |
| 150 ± 50 ms | 79-80 % | 60 % (máx. 27) |

QUIC (RFC 9002) da un paquete por perdido cuando se confirma otro 3 números posterior. La pila del relay (`noq` 1.3.0) usa ese umbral fijo, sin adaptarlo al desorden, y su BBRv3 recorta la ventana en cuanto la pérdida de una ronda supera el 2 %. Traza qlog del relay (compilado con `qlog`) con 150 ± 50 ms y un espectador: el 36 % de los paquetes dados por perdidos, todos por `reordering_threshold` y **todos confirmados después** (no se perdió ninguno); ventana de congestión mediana de 17 kB frente a 433 kB sin desorden, y 0,54 Mbit/s enviados para un vídeo de ~4,3. A MoQ le llegan 7-8 fps. El TCP de DASH (Linux, CUBIC con RACK) adapta su umbral de desorden con los DSACK (`tcp_max_reordering` = 300): en el mismo perfil detectó 4.234 desórdenes y retransmitió 6 segmentos de 17.543, y a DASH le llegan 60 fps. WebRTC no retransmite ni recorta por desorden: el búfer de jitter reordena.

Con el mismo 150 ± 50 ms pero conservando el orden (`netem ... rate 1gbit`: cada paquete sale como pronto cuando sale el anterior), MoQ recibe 60 fps y pinta 52-58, sin congelados. Esa variante estrecha el reparto de retardos (p5-p95 de 44-79 ms frente a 6-95 ms), así que hay un control con el mismo reparto y con desorden, 150 ± 20 ms: MoQ sufre (45-59 fps pintados, 2-10 s de congelados) pero no se hunde. El daño crece con la profundidad del desorden. Con la escalera de calidades MoQ sí baja, a 360p, porque la estimación del relay cae a 0,2-0,9 Mbit/s, pero ni esa calidad cabe.

**La latencia objetivo de DASH no se adapta al retardo de la red (medido el 21-10-2026, en local).** El slider fija `liveDelay` (por defecto 0,3 s) y dash.js lo persigue tal cual: con la red lenta acelera la reproducción (modo `LoLP`) para alcanzarlo, vacía el búfer, se para y, si se aleja más de `maxDrift`, salta al directo. WebRTC calcula su búfer a partir del jitter que mide y MoQ en `auto` a partir del RTT que le comunica el relay, así que los dos suben su latencia solos. DASH solo, 150 ms por sentido sin jitter, 45 s descontando los 15 primeros:

| Objetivo DASH | Frames pintados | Congelados | Saltos al directo | Velocidad media | Latencia real |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 0,3 s | 42,3 fps | 17 (14,2 s) | 3 | 1,3× | 564 ms |
| 0,5 s | 53,2 | 3 (0,9 s) | 0 | 1,0× | 556 ms |
| 0,7 s | 59,8 | 2 (0,6 s) | 0 | 1,0× | 757 ms |
| 1,0 s | 59,8 | 0 | 0 | 1,0× | 1.048 ms |
| 0,3 s sin retardo de red | 59,8 | 0 | 0 | 1,0× | 339 ms |

(Los congelados se cuentan desde la carga de la página e incluyen el arranque.) dash.js 5.2.1 no adapta el objetivo: `liveDelay` se fija al arrancar y solo cambia si el usuario busca a mano. Lo que sí deja configurar es cómo lo persigue (`liveCatchup`), y ninguna combinación probada lo deja en la latencia que la red permite (objetivo 0,3 s, mismo perfil):

| `liveCatchup` | Congelados | Saltos al directo | Velocidad media | Latencia real |
| :--- | :--- | :--- | :--- | :--- |
| `maxDrift` 1,5 s (el del testbed) | 19 (16,8 s) | 3 | 1,3× | 707 ms |
| `maxDrift` 0 (sin salto) | 8 (11,5 s) | 0 | 1,4× | 1.505 ms |
| `maxDrift` 0, `playbackBufferMin` 1 s | 15 (13,9 s) | 0 | 1,3× | 1.040 ms |
| `maxDrift` 0, `liveThreshold` 0,3 s | 0 | 0 | 1,0× | 2.264 ms |

Con `liveThreshold` deja de perseguir el objetivo y se queda en la latencia a la que le llevaron los congelados del arranque. En `LoLP` la velocidad media sigue en 1,3-1,4× aunque el búfer debería estar por debajo de `playbackBufferMin`; no se ha averiguado por qué no frena. Con un objetivo inalcanzable no se queda en la latencia que puede sostener: la persigue acelerando y se para. Comparar DASH con los otros dos a igual perfil de red exige elegir su objetivo para ese perfil, y declararlo; una alternativa es medir, por perfil, el objetivo mínimo sin congelados.

**Consecuencia para las medidas:** el parámetro jitter del testbed mezcla dos cosas, variación de retardo y desorden profundo, y la segunda castiga casi solo a QUIC. En redes reales el retardo varía sobre todo en las colas, que no desordenan. Cualquier resultado de MoQ con jitter hay que leerlo así. Sin desorden, DASH tuvo problemas por encima de TCP (cero retransmisiones, pero el reproductor no llegó a pintar); no investigado.

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

- **Identificador de emisión.** Cada vez que arranca un empaquetador, su `stream_id` en `/api/status` cambia. Cualquier dashboard abierto remonta ese reproductor al verlo, lo haya reiniciado esa pestaña, otra, la API o el supervisor. Sin esto, el reproductor MoQ quedaba anclado al reloj de la emisión anterior y pintaba a trompicones. El de WebRTC no conecta hasta 8 s después de arrancar su empaquetador: conectar en los primeros segundos de la emisión le deja más latencia toda la sesión (sección 3.4b).
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
| Fuente | Big Buck Bunny en bucle o cámara RTSP (sección 3.1b) | Con la cámara, los fps los fija el servidor (los de la cámara) y hay una salida de referencia para el VMAF. En el CSV, `source` y `fps` |
| GOP | 0,25, 0,5, 1 o 2 s, en frames de la cadencia en curso (15 a 120 frames a 60 fps) | Tamaño del grupo MoQ y límite inferior del segmento DASH |
| Escalera de calidades | 1 a 5; altura 1080/720/540/480/360/240 y bitrate libre | Lo que codifica la fuente. Con una sola no hay adaptación |
| Calidad (por reproductor) | Auto o una calidad fija | Auto usa la adaptación de cada reproductor; fijar una la desactiva |
| Reproductores activos | Cualquier combinación de LL-DASH, MoQ y WebRTC, con al menos uno | Un reproductor apagado se desmonta: cierra su conexión y no descarga nada, así que no compite con los demás por la red ni por el navegador. Se recuerda en el navegador; cada cambio abre un tramo de medida nuevo. En el CSV, `players` lista los activos y las métricas de los apagados quedan vacías |
| Sonido | Ninguno (al abrir), LL-DASH, MoQ o WebRTC: uno a la vez | Quita el silencio a ese reproductor. En DASH y WebRTC el audio ya se descargaba; **en MoQ no**: `@moq/watch` solo se suscribe a la pista de audio con el sonido activado. Efecto medido el 22-10-2026 con la cámara a 15 fps, alternando con "Ninguno" (cinco ventanas de 45-90 s por rama): en WebRTC y DASH, ninguno visible (WebRTC 331-430 ms con sonido frente a 344-451 sin él; DASH varía más que cualquier diferencia, 523-847 frente a 509-852); en MoQ, igual en tres ventanas (85-91 ms frente a 83-89) y más alto en dos (127 y 157 ms). En headless no hay altavoz: el navegador reproduce hacia una salida nula. En el CSV, `audio` |
| Audio en WebRTC | Desactivado (por defecto) o activado | El Opus de la fuente, sin recodificar. Sube la latencia de WebRTC hasta el búfer del audio: poco con el bucle, 100-200 ms con la cámara (sección 3.4b). En el CSV, `rtc_audio` |
| Pantalla completa (por reproductor) | Botón arriba a la derecha del vídeo (aparece al pasar el ratón) o doble clic; Esc para salir | Amplía la zona de vídeo, con sus avisos. Solo escala la imagen: el timecode se lee del frame decodificado y el reproductor de MoQ sigue dibujando aunque su canvas quede tapado (`visible: 'always'`). Los otros reproductores siguen midiendo detrás (comprobado en Chrome headless el 22-10-2026). En el CSV, `fullscreen` dice cuál está a pantalla completa |
| Segmento DASH | 0,5, 1, 2, 4 s | `-seg_duration`; debe ser ≥ GOP |
| Fragmento CMAF | 100 (por defecto), 200, 500, 1000 ms | `-frag_duration`; unidad de entrega chunked |
| Latencia objetivo DASH | 0,05 a 6,0 s (0,3 s al abrir) | `liveDelay` de dash.js, con catch-up LoL+ |
| Umbral de búfer vacío DASH | 0 a 1 s, por defecto 0,3 s (el de fábrica) | `buffer.stallThreshold` y `lowLatencyStallThreshold` de dash.js: por debajo, declara el búfer vacío, fuerza la calidad más baja y la corrección de latencia lo da por parado. No detiene el vídeo. En el CSV, `dash_stall_threshold_s` |
| Salto al directo DASH | 0 (desactivado) a 10 s, por defecto 1,5 s | `liveCatchup.maxDrift` de dash.js: desvío sobre el objetivo a partir del cual salta al directo en vez de corregir con la velocidad. El salto aborta las descargas y abre conexiones TCP frías; con retardo de red alto puede encadenar saltos y paradas |
| Latencia objetivo MoQ | auto (al abrir), o 50 a 2000 ms | `delay` de `@moq/watch`. En auto, que es su valor por defecto, la librería lo calcula del RTT que comunica el relay (1,25 × el mínimo, con suelo de 20 ms). En ambos casos le suma el jitter de pista del catálogo; el valor efectivo se muestra junto al slider. En auto, `moq_target_ms` queda vacío en el CSV. **En auto no sube durante la sesión**: tras cambiar el perfil de red hay que recargar para que lo recalcule (PROTOCOLOS, 4.11) |

La fuente, el GOP, la escalera, el segmento y el fragmento requieren pulsar **Aplicar Cambios**; los sliders actúan al momento y su valor queda en el CSV (`dash_target_ms`, `dash_max_drift_s`, `moq_target_ms`).

El reproductor de dash.js queda accesible como `window.dashPlayer` en la consola del navegador para depurar.

---

## 9. API del orquestador (bajo `/api`)

| Método y ruta | Descripción |
| :--- | :--- |
| `GET /api/status` | Estado, configuración, `stream_ids`, reinicios del supervisor, disposición del timecode, anomalías de ingesta, deriva DASH y red (perfil y contadores del router) |
| `POST /api/start` | Arranca los empaquetadores (cuerpo opcional: configuración) |
| `POST /api/stop` | Detiene todo, incluida la codificación de la fuente. La parada se recuerda entre reinicios: no vuelve a emitir hasta `POST /api/start` |
| `POST /api/config` | Aplica una configuración y reinicia lo necesario. La escalera va en `renditions: [{height, bitrate_kbps}]`; se sigue aceptando `bitrate_kbps` para una única calidad 1080p. `source`: `file` (bucle, por defecto) o `camera`; con la cámara, `fps` lo fija el servidor y, si no la alcanza, responde 502 con el motivo. `rtc_audio`: audio en la rama WebRTC (por defecto, no) |
| `GET /api/camera` | Sondea la cámara: host (sin credenciales), códec, resolución, fps, audio y último error. Con la cámara emitiendo, devuelve lo último que se supo sin abrir otra sesión |
| `POST /api/network` | Aplica un perfil de red (`down` y `up`) a las dos ramas en el router |
| `POST /api/trace` | Dadas las marcas de tiempo de frames ya pintados, devuelve cuándo pasó cada uno por los puntos de medida del servidor |
| `POST /api/qoe/recordings` | Graba el flujo codificado `duration_s` segundos (5-300) y lo indexa al terminar; con la cámara, también la referencia. Exige la emisión en marcha |
| `GET /api/qoe/recordings` | Grabaciones guardadas, de la más reciente a la más antigua |
| `GET /api/qoe/recordings/{id}` | Estado (`recording`, `indexing`, `ready`, `error`), resumen del índice por calidad y resultado de la comprobación |
| `GET /api/qoe/recordings/{id}/index` | Por fotograma grabado y calidad: PTS, timecode leído y número de frame de la fuente |
| `POST /api/qoe/recordings/{id}/index` | Rehace el índice con las marcas guardadas y vuelve a encolar el VMAF |
| `POST /api/qoe/recordings/{id}/check` | Comprueba por PSNR el emparejamiento con el original (resultado en el `GET` anterior). Solo con la emisión parada |
| `POST /api/qoe/recordings/{id}/vmaf` | Pone en la cola el cálculo de VMAF (se encola solo al indexar). Se calcula en cuanto la emisión esté parada |
| `GET /api/qoe/recordings/{id}/vmaf` | VMAF y PSNR de luma de cada fotograma grabado, por calidad, con la versión de vmaf, el modelo y la zona comparada |
| `GET /api/versions` | Versiones desplegadas de los componentes de terceros y la última publicada de cada uno |
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
│       ├── qoe.py                # QoE: grabación del flujo codificado, índice y emparejamiento con el original
│       ├── recorder.py           # Grabador MPEG-TS de la cuarta salida de la fuente (UDP 5004) y de la referencia de la cámara (5005)
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
- [x] Cámara RTSP como fuente alternativa al bucle, con referencia grabada para el VMAF.

Pendiente:

- [ ] Atribuir los ~200 ms entre latencia real y declarada en MoQ, repitiendo la medida con decodificación por hardware.
- [ ] Perfiles de red dinámicos (trazas o escalones programados) y modo de enlace compartido, para estudiar la competencia entre protocolos.
- [ ] Cliente fuera del host (contenedor u otra máquina) para que TCP sea extremo a extremo también en macOS.
- [ ] Adaptación de calidad: elegir el algoritmo ABR de dash.js (L2A, LoL+) desde el panel y corregir el bitrate inflado del catálogo MoQ.
- [ ] Carga de CPU: tres calidades a 1080p60 más dos reproductores en la misma máquina la dejan cerca de la saturación.

---

## 12. Créditos

El vídeo de prueba es *Big Buck Bunny* (versión Sunflower, 1080p 60 fps), © Blender Foundation, [bbb3d.renderfarming.net](http://bbb3d.renderfarming.net), bajo licencia [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
