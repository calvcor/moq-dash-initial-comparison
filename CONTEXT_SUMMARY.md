# Contexto Completo del Testbed: Media over QUIC (MoQ) vs. Low-Latency DASH (LL-DASH)
**Fecha y hora:** 2026-10-08 | Entorno Doctoral en Streaming Multimedia de Baja Latencia  
**Proyecto:** Comparativa Cuantitativa y Experimental entre MoQ y LL-DASH  

---

## 1. Arquitectura General del Sistema

El testbed está completamente containerizado en **Docker Compose** y reproduce una señal en directo ininterrumpida de **Big Buck Bunny (1080p60)** con un código de tiempo quemado en el vídeo a nivel de píxel (`HH:MM:SS.mmm`).

```
                              ┌────────────────────────────────────────┐
                              │  Fuente Maestra Continua FFmpeg        │
                              │  Big Buck Bunny 1080p60 bucle infinito │
                              │  (PTS / Reloj en vivo quemado)         │
                              └───────┬────────────────────────┬───────┘
                                      │ UDP :5001              │ UDP :5002
                                      ▼                        ▼
              ┌───────────────────────────────┐        ┌───────────────────────────────┐
              │  tsgate.py (arranque en IDR)  │        │  tsgate.py (arranque en IDR)  │
              │  FFmpeg -f dash -> HTTP PUT   │        │  moq import ts (sin remux)    │
              │  Origen chunked (origin.py)   │        │                               │
              └───────────────┬───────────────┘        └───────────────┬───────────────┘
                              │                                        │ QUIC / WebTransport
                              ▼                                        ▼
              ┌───────────────────────────────┐        ┌───────────────────────────────┐
              │  Nginx (:8080) proxy sin búfer│        │   moq-relay Oficial (:4433)   │
              │  /media/dash/manifest.mpd     │        │   moqdev/moq-relay (Rust)     │
              └───────────────┬───────────────┘        └───────────────┬───────────────┘
                              │ HTTP GET                               │ WebTransport / QUIC
                              ▼                                        ▼
              ┌───────────────────────────────┐        ┌───────────────────────────────┐
              │  dash.js (MSE / HTML5 Video)  │        │  @moq/watch (WebCodecs+Canvas)│
              │  Live Latency / LoLp Catch-up │        │  Sub-second Playhead Transit  │
              └───────────────────────────────┴────────┴───────────────────────────────┘
                                               ▲
                                               │
                                 ┌───────────────────────────┐
                                 │ Panel de Mandos React     │
                                 │ Telemetría y Métricas QoE │
                                 │ Sliders de Latencia en V. │
                                 └───────────────────────────┘
```

---

## 2. Contenedores y Servicios Docker

1. **`testbed-moq-relay`** (`moqdev/moq-relay:latest`):
   - Puertos: `4433/udp` (QUIC/WebTransport) y `8081/tcp` (HTTP para endpoint `/certificate.sha256`).
   - Autenticación pública en namespace `anon/**`.
2. **`testbed-nginx-dash`** (`nginx:alpine`):
   - Puerto: `8080/tcp`.
   - Reenvía `/media/dash/` al origen del orquestador con `proxy_buffering off`; ya no sirve ficheros de disco.
3. **`testbed-orchestrator`** (`Python 3.12 + FastAPI + FFmpeg 7.1`):
   - Puerto: `8000/tcp`.
   - Orquesta la fuente continua maestra y los procesos de empaquetado independientes.
   - Aloja el **origen LL-DASH en memoria** (`app/origin.py`): FFmpeg publica por HTTP PUT chunked y cada segmento se sirve mientras se escribe.
   - `GET /api/time` y `GET /api/utc`: reloj del servidor para la medida glass-to-glass y para el `UTCTiming` de dash.js.
   - Proporciona endpoints REST:
     - `GET /api/status`: Estado del pipeline, configuraciones activas y `master_start_time_ms`.
     - `POST /api/start`: Inicia la emisión.
     - `POST /api/stop`: Detiene empaquetadores y fuente maestra; la parada se recuerda entre reinicios (`media/.stopped`).
     - `POST /api/config`: Aplica configuraciones en caliente y auto-inicia el stream.
4. **`testbed-web`** (`React 19 + Vite + TypeScript + TailwindCSS + Nginx`):
   - Puerto: `5173/tcp`.
   - Configurado con cabeceras de aislamiento Cross-Origin:
     - `Cross-Origin-Opener-Policy: same-origin`
     - `Cross-Origin-Embedder-Policy: require-corp`
   - Habilita `SharedArrayBuffer` nativo para el `AudioWorklet` de `@moq/watch`.

---

## 3. Parámetros de Control Experimental

Los siguientes parámetros son modificables desde el Panel de Control Web:
- **GOP Size (Group of Pictures):** 15 (0.25s), 30 (0.5s), 60 (1.0s) o 120 (2.0s) a 60 fps.
- **Bitrate de vídeo:** 2000, 4000, 6000 u 8000 kbps (1080p).
- **Segmento DASH (`-seg_duration`):** 0.5s, 1.0s, 2.0s o 4.0s (con validación reactiva que prohíbe duraciones menores al tamaño de GOP).
- **Fragmento CMAF (`-frag_duration`):** 100ms, 200ms, 500ms o 1000ms.
- **Sliders de Latencia Objetivo en Vivo:**
  - **DASH:** Slider independiente de `0.05s` a `6.0s` en pasos de 0.05s que actualiza `liveDelay` en `dash.js` y activa el algoritmo de catch-up (LoLp).
  - **MoQ:** Slider independiente de `50ms` a `2000ms` en pasos de 50ms conectado mediante `Signal<Net.Time>` al `Watch.Player`.

---

## 4. Conceptos Clave y Problemas Resueltos

### 4.1. Aviso `@moq/hang`: `skipping covered group: 429 -> 430`
- **Causa:** En MoQ Lite cada GOP es un grupo independiente transportado en su propio stream QUIC. Cuando el decodificador WebCodecs termina de renderizar todos los frames del grupo actual y los frames del nuevo grupo ya han llegado por la red antes de que el stream previo reciba el flag `FIN`, el método `#tryDurationSkip()` salta inmediatamente para mantener cero retraso.
- **Impacto:** No representa caída de frames ni error; es el mecanismo de sincronización que previene buffering acumulativo.

### 4.2. ¿Qué significa `anon` en la URL de MoQ?
- Es el **Namespace** jerárquico de MoQ (similar a un canal o dominio). Permite organizar publicaciones públicas y privadas en el relay (`anon` = acceso anónimo sin token de autenticación).

### 4.3. Paradas periódicas en DASH al subir el GOP a 2s
- **Causa técnica:** En ISO-BMFF / DASH todo segmento de medios debe comenzar con un frame clave IDR (SAP Tipo 1/2). Con `-c:v copy`, FFmpeg no puede cortar segmentos más pequeños que la distancia entre frames IDR.
- **Resolución:** Se fijó una validación estricta en backend y frontend asegurando siempre:
  $$\text{seg\_duration} \ge \frac{\text{gop\_size}}{\text{fps}}$$

### 4.4. Error `manifest.mpd is not available` al aplicar cambios
- **Causa:** Al reiniciar el empaquetador con nuevos parámetros, el backend eliminaba los archivos viejos. Durante ~1 segundo `manifest.mpd` no existía físicamente en disco y `dash.js` entraba en fallo irrecuperable por HTTP 404.
- **Resolución:** 
  1. `DashPlayer.tsx` implementa sondeo de disponibilidad con `HEAD /media/dash/manifest.mpd` hasta recibir HTTP 200 antes de inicializar `dash.js`.
  2. Uso de una clave reactiva `streamEpoch` en `<DashPlayer key={...}>` y `<MoqPlayer key={...}>` que remonta limpiamente las instancias al reconfigurar.
  3. Reconexión automática transparente en caso de reinicios en caliente.

### 4.5. Latencia de Protocolo vs. Latencia "Glass-to-Glass"
- **Diferencia:** cada reproductor declara su latencia respecto a su propia idea del *live edge* (`dash.js`: `availabilityStartTime` del manifiesto; `@moq/watch`: búfer de sincronización). Ninguna incluye codificación, empaquetado ni pintado, y no son comparables entre sí.
- **Método de medida (idéntico en ambas ramas):**
  - La fuente maestra quema en el vídeo un **timecode binario** (`timecode_filter()` en `main.py`): el reloj de pared del servidor en ms, 20 bits en código Gray, en celdas de 32 px abajo a la izquierda, con celdas de referencia blanco/negro en los extremos.
  - `web/src/lib/glass.ts` (`GlassMeter`) lee esos píxeles en cada frame tanto del `<video>` de DASH como del `<canvas>` de MoQ y calcula `latencia = reloj_servidor − timecode`. De la misma lectura salen los frames presentados por segundo y los congelados (≥150 ms sin imagen nueva).
  - `web/src/lib/clock.ts` sincroniza el reloj del navegador con `GET /api/time` (estilo NTP, sondeo de menor RTT); la incertidumbre se muestra en el panel.
  - No incluye el retardo de composición/pantalla (1-2 vsync), que es igual para ambas ramas.
- **`availabilityStartTime` calibrado:** FFmpeg escribe como AST la hora de su primera escritura, retrasada por el sondeo de entrada, y `dash.js` reproducía ese tiempo de más sin contarlo (8,3 s reales con 3,0 s declarados). El origen lo recalcula a partir del instante en que se abre un segmento ya en régimen y no publica el manifiesto hasta tenerlo. Resultado: latencia declarada y glass-to-glass difieren en ~55 ms (codificación, empaquetado y pintado) en todas las configuraciones probadas.
- **Descarga total por protocolo:** DASH con `transferSize` de la Resource Timing API (Nginx envía `Timing-Allow-Origin`); MoQ con `connection.stats()` y, como Chrome no implementa `WebTransport.getStats()`, con la suma de carga útil de vídeo y audio. Son capas distintas; el aviso está en el hover de la tarjeta.
- **Validez de la sesión:** `/api/status` expone `ingest_anomalies` (saltos de continuidad MPEG-TS detectados por `tsgate.py`, paquetes corruptos) y `dash_availability_drift_ms` (desfase de cada segmento respecto al calendario anunciado). El panel permite exportar a CSV una muestra por segundo con la configuración activa.

### 4.7. Entrega LL-DASH real y artefactos del pipeline corregidos
- **Segmentos en curso:** escribiendo a disco, FFmpeg solo exponía cada segmento al renombrar el `.tmp` ya completo y, con `-use_timeline 1`, el manifiesto no anunciaba `availabilityTimeOffset`. Además `-frag_duration` no tenía efecto sin `-frag_type duration`. Ahora se usa `-use_timeline 0 -frag_type duration` y publicación HTTP PUT al origen en memoria.
- **Arranque en IDR (`app/tsgate.py`):** ambos empaquetadores leen el UDP de la fuente a través de una compuerta que abre el paso en un keyframe y antepone PAT/PMT. Sin ella, con `-c copy` el audio empezaba antes que el vídeo y la rejilla de segmentos quedaba desfasada hasta un GOP.
- **Fuente:** audio y vídeo se leen por entradas separadas (el MP4 los intercala en bloques de 0,5 s y con `-re` el muxer retenía el vídeo) y MPEG-TS emite un PES por frame de audio (`pes_payload_size=0`).
- **Reinicios:** `kill_proc` espera a que muera el grupo entero. Antes la fuente antigua seguía emitiendo unos segundos y se mezclaba con la nueva en los mismos puertos UDP.
- **Rama MoQ:** `moq import ts` lee directamente de la compuerta, sin el FFmpeg intermedio de remultiplexado.

### 4.6. Aviso de Audio: `SharedArrayBuffer unavailable`
- **Causa:** Por motivos de seguridad (Spectre), los navegadores exigen Cross-Origin Isolation para permitir memoria compartida en `AudioWorklet`.
- **Resolución:** Se añadieron las cabeceras `Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Embedder-Policy: require-corp` en el servidor Nginx del frontend web.

### 4.9. Recuperación automática
- **Síntoma:** un stream quedaba "raro" (paradas periódicas o sin cargar) hasta recargar la pestaña.
- **Causa principal:** si el pipeline se reiniciaba sin que esa pestaña lo supiera (otra pestaña, la API, arranque del orquestador), `@moq/watch` conservaba su referencia de reloj de la emisión anterior; todos los frames nuevos le parecían tardíos y los pintaba sin temporizar. dash.js tardaba ~12 s en recuperarse por su cuenta. Además, nada relanzaba un empaquetador muerto.
- **Solución:** `stream_ids` por rama en `/api/status` (los reproductores usan ese valor como `key` y se remontan al cambiar), hilo supervisor en `main.py` (relanza fuente y empaquetadores; reinicios en `restarts`), vigilancia en cada reproductor con `GlassMeter.frozenMs()` (10 s sin imagen nueva), `announced: true` en el reproductor MoQ para no suscribirse antes de que exista la emisión, y detección de backend caído en `App.tsx`.
- **`kill_proc` y apagado:** el supervisor se desactiva en `on_shutdown` para no relanzar procesos mientras el contenedor se para.

### 4.11. Codificación multicalidad y adaptación
- **Fuente:** `StreamConfig.renditions` (1-5 calidades, `height` + `bitrate_kbps`). Un solo FFmpeg hace `split`, escala cada calidad, le quema su etiqueta y su timecode (`timecode_layout()` da un tamaño de celda por calidad) y las codifica con el mismo GOP y tope de tasa (`-maxrate` 120 %, VBV 1 s). Van como varios PID de vídeo en un mismo programa MPEG-TS.
- **DASH:** `-map 0:v` con `-adaptation_sets "id=0,streams=v id=1,streams=a"` y bitrates declarados con `-b:v:i`; dash.js adapta con su ABR por defecto.
- **MoQ:** `moq import ts` convierte cada PID de vídeo en una rendition del catálogo sin cambios. En automático **no se interviene**: decide `@moq/watch` (80 % de `probe.estimatedRecvRate` frente al bitrate de catálogo, excluyendo renditions `stalled`, cambio sin corte). Se probó sustituirlo por una regla propia (veto con retroceso, corte en seco) y se retiró a petición del usuario: el objetivo es observar el protocolo y sus implementaciones, no hacer que funcione bien. `MoqPlayer.tsx` solo fija `target: {name}` cuando el usuario elige una calidad a mano, y mide por separado la rendition seleccionada y la altura del frame pintado.
- **Observado con el comportamiento nativo (4 Mbit, enlace en exclusiva):** la selección oscila entre 360p y 720p unas 35 veces por minuto mientras el frame pintado sigue en 1080p y el enlace saturado; 46 congelados en 90 s. Con red libre también oscila porque el publicador marca la calidad alta como `stalled` intermitentemente.
- **Cola compartida:** la emulación tiene una cola por protocolo, no por cliente. Dos navegadores a la vez comparten el enlace; las pruebas con límite de ancho de banda exigen un solo cliente.
- **Timecode por calidad:** quemarlo antes de escalar dejaba celdas de ~10 px a 360p que la compresión emborronaba y el medidor leía valores basura. `/api/status` expone `timecodes` y `GlassMeter` elige el de la altura que ve.
- **Límite conocido:** tres calidades a 1080p60 más los reproductores en la misma máquina la acercan a la saturación (cargas de 9-10); aparecen saltos de continuidad en la ingesta y las medidas se vuelven ruidosas.

### 4.10. Bucle de saltos al directo en DASH con retardo de red alto
- **Síntoma:** con 500 ms de retardo de bajada DASH se congela una y otra vez, a veces indefinidamente y a veces se estabiliza solo; MoQ no se ve afectado.
- **Causa:** una conexión TCP fría tarda ~2,5 s en coger ritmo con RTT de 500 ms (arranque lento). Mientras tanto la latencia supera `liveCatchup.maxDrift` (1,5 s) y dash.js salta al directo, lo que aborta las descargas, cierra la conexión y obliga a abrir otra fría. Es metaestable: se sale cuando un salto pilla una conexión caliente.
- **Solución:** `maxDrift` es ahora un slider del reproductor DASH (0 = no saltar nunca) y se registra en el CSV. Con 0, la misma red da ~0,3 s de congelados al arrancar y luego estabilidad.

### 4.12. Desglose de latencia por etapas (panel "Recorrido de un frame")
- **Identidad del frame:** por su timecode quemado. FFmpeg escribe en su log, con `print()` dentro de la expresión `enable` del bit más alto, la marca exacta y `n*10+stream`; `pump_master_log` lo aparta del log y `trace.py` guarda marca → número de frame por calidad.
- **De número de frame a PTS:** `PTS = PTS del frame 0 + n × 90000/fps`. El PTS del frame 0 lo ven las compuertas porque `start_all` las arranca antes que la fuente. Se probó identificar los frames por las marcas de tiempo de cada reproductor y no sirve en MoQ: `moq import` las reescribe con un desfase no documentado.
- **Puntos de medida:** llegada al kernel y reenvío en `tsgate.py` (envía lotes por UDP a `trace.listen`, puerto 5010), fragmento completo en `origin.py` (`FragmentParser`), llegada al navegador y pintado en `web/src/lib/trace.ts` (`DashTracer` con `requestVideoFrameCallback` y sondeo de `buffered`; `MoqTracer` suscrito a `sync.out.timestamp`).
- **API:** `POST /api/trace` con las marcas de frames pintados. El navegador calcula las etapas y elige como representante el frame de latencia total mediana.
- **Hallazgos:** el grueso de la latencia de MoQ (~400 de ~470 ms) está en el búfer del reproductor, no en publicador, relay ni red; y con un navegador suscrito el publicador a veces deja de vaciar su entrada y los frames esperan en la compuerta (etapa "Entrada al publicador").

### 4.8. Emulación de red
- **Router (`router/agent.py`):** contenedor con `NET_ADMIN` entre el navegador y Nginx/relay. Publica 8080, 4433/udp y 8081, reenvía con DNAT (sin terminar conexiones) y aplica `tc` en los dos sentidos. Nginx y el relay ya no publican puertos y tienen IP fija en la red interna `core`.
- **Una cola por protocolo y sentido** con el mismo perfil: `tbf` (ancho de banda, y trocea los superpaquetes GSO que netem descartaría enteros) con `netem` hijo (retardo, jitter, pérdida y cola). DASH y MoQ no compiten entre sí.
- **Control:** `POST /api/network` en el orquestador, que habla con el agente del router por la red interna. El panel abre un tramo de medida nuevo al aplicar, sin remontar los reproductores.
- **Contadores:** reglas `iptables` en `FORWARD` cuentan bytes IP por protocolo y sentido; netem aporta descartes y cola.
- **Limitación en macOS:** Docker Desktop publica puertos con un proxy propio, así que el extremo TCP del cliente es ese proxy y no el navegador. QUIC pasa extremo a extremo.

---

## 5. Resumen de Archivos Modificados

- [`docker-compose.yml`](docker-compose.yml): Orquestación de los 4 servicios.
- [`server/app/origin.py`](server/app/origin.py): Origen LL-DASH chunked en memoria y calibración del `availabilityStartTime`.
- [`server/app/tsgate.py`](server/app/tsgate.py): Compuerta MPEG-TS con arranque en IDR y control de continuidad.
- [`web/src/lib/glass.ts`](web/src/lib/glass.ts) y [`clock.ts`](web/src/lib/clock.ts): Medida glass-to-glass por timecode y sincronización de reloj.
- [`server/app/main.py`](server/app/main.py): Lógica de procesos FFmpeg, cálculo de `master_start_time_ms` y auto-arranque en `/api/config`.
- [`web/src/types.ts`](web/src/types.ts): Definiciones de tipos TypeScript para telemetría y configuraciones.
- [`web/src/App.tsx`](web/src/App.tsx): Gestión del estado global, `streamEpoch` y propagación de `master_start_time_ms`.
- [`web/src/components/DashPlayer.tsx`](web/src/components/DashPlayer.tsx): Readiness check HTTP 200, slider de latencia en vivo y cálculo Glass-to-Glass.
- [`web/src/components/MoqPlayer.tsx`](web/src/components/MoqPlayer.tsx): Control reactivo de latencia vía `@moq/signals`, reconexión suave y telemetría de tránsito.
- [`web/src/components/ControlPanel.tsx`](web/src/components/ControlPanel.tsx): Botón de aplicar cambios pendiente, validación cruzada GOP/segmento y desacoplo de polling.
- [`web/Dockerfile`](web/Dockerfile): Configuración Nginx con cabeceras COOP y COEP para SharedArrayBuffer.
