import math
import os
import re
import signal
import subprocess
import threading
import logging
import time
from datetime import datetime, timezone
from typing import Optional
import requests
from pydantic import BaseModel, Field, model_validator
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

from . import source
from .origin import origin, router as origin_router
from .source import VIDEO_FILE

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("orchestrator")

app = FastAPI(
    title="MoQ vs LL-DASH Testbed Orchestrator (Docker)",
    description="Control API para gestión de fuentes de vídeo, codificación, DASH y MoQ",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(origin_router)

# Los empaquetadores publican en el origen en memoria de este mismo proceso (ver origin.py)
DASH_PUBLISH_URL = "http://127.0.0.1:8000/media/dash/manifest.mpd"
# Agente del router que emula la red entre el navegador y los servidores finales (ver router/agent.py)
ROUTER_URL = os.getenv("ROUTER_URL", "http://172.30.50.2:9000")
TSGATE = os.path.join(os.path.dirname(__file__), "tsgate.py")
# Reloj que usará dash.js; debe ser el mismo con el que se calcula el availabilityStartTime
# Relativa al manifiesto: vale para cualquier nombre de host y para HTTP o HTTPS
UTC_TIMING_URL = os.getenv("UTC_TIMING_URL", "/api/utc")
CERTS_DIR = "/certs"

# MoQ relay URL dentro de la red docker
MOQ_RELAY_URL = os.getenv("MOQ_RELAY_URL", "https://moq-relay:4433/anon")

# Estado de los subprocesos de FFmpeg y sincronización de reloj
processes = {
    "master_source": None,
    "dash_pipeline": None,
    "moq_pipeline": None,
}
master_start_time: float = time.time()

# Ciclo de vida: las órdenes de la API y el supervisor no deben pisarse
lifecycle = threading.RLock()
desired_running = False
# Identificador de cada emisión. Cambia cada vez que arranca su empaquetador, lo provoque quien lo provoque:
# así cualquier dashboard abierto sabe que debe reconectar ese reproductor.
stream_ids = {"dash": 0, "moq": 0}
started_at = {"dash": 0.0, "moq": 0.0}
# Reinicios automáticos hechos por el supervisor (procesos caídos o colgados)
restarts = {"master": 0, "dash": 0, "moq": 0}
# Ambos empaquetadores leen la fuente a través de tsgate.py, que abre el paso justo en un IDR.
# Así el sondeo inicial de FFmpeg (5 s por defecto) puede acortarse a 1 s.
PROBE_S = 1.0

class Rendition(BaseModel):
    """Una calidad de la escalera: altura en píxeles (16:9) y bitrate de vídeo objetivo."""
    height: int = Field(..., ge=144, le=1080)
    bitrate_kbps: int = Field(..., ge=150, le=20000)

    @property
    def width(self) -> int:
        return round(self.height * 16 / 9 / 2) * 2

def default_ladder() -> list[Rendition]:
    return [Rendition(height=1080, bitrate_kbps=4000), Rendition(height=720, bitrate_kbps=2000), Rendition(height=360, bitrate_kbps=700)]

class StreamConfig(BaseModel):
    gop_size: int = 60           # 1 segundo a 60 fps
    fps: int = 60
    seg_duration: float = 2.0    # Segundos por segmento DASH
    frag_duration: float = 0.2   # Chunks CMAF de 200ms para LL-DASH
    # Escalera de calidades que se codifica en vivo, de mayor a menor. Una sola entrada = sin adaptación.
    renditions: list[Rendition] = Field(default_factory=default_ladder, min_length=1, max_length=5)

    @model_validator(mode="before")
    @classmethod
    def accept_single_bitrate(cls, data):
        # Compatibilidad con la API anterior: {"bitrate_kbps": N} equivale a una única calidad 1080p
        if isinstance(data, dict) and "bitrate_kbps" in data:
            data = dict(data)
            bitrate = data.pop("bitrate_kbps")
            data.setdefault("renditions", [{"height": 1080, "bitrate_kbps": bitrate}])
        return data

    @model_validator(mode="after")
    def sort_ladder(self):
        # El primer stream es siempre la calidad más alta; no se admiten dos calidades idénticas
        self.renditions = sorted(self.renditions, key=lambda r: (r.height, r.bitrate_kbps), reverse=True)
        if len({(r.height, r.bitrate_kbps) for r in self.renditions}) != len(self.renditions):
            raise ValueError("Hay calidades repetidas en la escalera")
        return self

current_config = StreamConfig()

class LinkProfile(BaseModel):
    rate_kbit: Optional[int] = Field(None, ge=100, le=1_000_000)  # None = sin límite
    delay_ms: float = Field(0, ge=0, le=2000)
    jitter_ms: float = Field(0, ge=0, le=500)
    loss_pct: float = Field(0, ge=0, le=50)
    queue_ms: int = Field(100, ge=10, le=5000)  # cola del cuello de botella; solo actúa con rate_kbit

class NetworkProfile(BaseModel):
    down: LinkProfile = LinkProfile()  # servidor -> navegador
    up: LinkProfile = LinkProfile()    # navegador -> servidor

def router_call(profile: Optional[NetworkProfile] = None) -> Optional[dict]:
    """Lee (o aplica) el perfil de red del router. None si el router no responde."""
    try:
        if profile is None:
            return requests.get(ROUTER_URL, timeout=1).json()
        return requests.post(ROUTER_URL, json=profile.model_dump(), timeout=5).json()
    except Exception as e:
        logger.warning(f"Router de red no disponible: {e}")
        return None

# Timecode binario quemado en el vídeo: reloj de pared del servidor en ms (mod 2^TC_BITS), en código Gray.
# Es la referencia común para medir latencia glass-to-glass en ambos reproductores leyendo píxeles.
# Disposición (celdas alineadas a macrobloque): [blanco][negro][bit MSB..LSB][negro][blanco]
# Se quema en cada calidad después de escalarla, con un tamaño de celda propio: escalar un timecode
# pensado para 1080p deja celdas de pocos píxeles que la compresión emborrona y el lector falla.
TC_BITS = 20

def timecode_layout(width: int, height: int) -> dict:
    cells = TC_BITS + 4
    cell = 32 if width >= (cells + 2) * 32 else 16
    return {
        "bits": TC_BITS,
        "cell": cell,
        "x": 2 * cell,
        "y": (height - 2 * cell - cell // 2) // 16 * 16,
        "width": width,
        "height": height,
    }

def timecode_filter(layout: dict) -> str:
    n = TC_BITS + 4
    size, x0, y0, pad = layout["cell"], layout["x"], layout["y"], layout["cell"] // 2
    cell = lambda i: f"x={x0 + i * size}:y={y0}:w={size}:h={size}:color=white:t=fill"
    parts = [
        f"drawbox=x={x0 - pad}:y={y0 - pad}:w={n * size + 2 * pad}:h={size + 2 * pad}:color=black:t=fill",
        f"drawbox={cell(0)}",
        f"drawbox={cell(n - 1)}",
    ]
    ms = "time(0)*1000"
    for bit in range(TC_BITS):
        # Gray con una sola lectura de reloj por bit: si el ms cambia entre dos drawbox el error es de 1 ms como máximo
        if bit == TC_BITS - 1:
            expr = f"mod(floor({ms}/{2 ** bit}),2)"
        else:
            expr = f"mod(floor(({ms}+{2 ** bit})/{2 ** (bit + 1)}),2)"
        parts.append(f"drawbox={cell(2 + TC_BITS - 1 - bit)}:enable='{expr}'")
    return ",".join(parts)

# Anomalías de ingesta en los logs de FFmpeg (pérdida UDP interna, paquetes corruptos): invalidan la comparación
ANOMALY_RE = re.compile(rb"buffer overrun|corrupt|continuity check|non[- ]monoton", re.I)
log_state = {name: {"offset": 0, "count": 0} for name in ("master", "dash", "moq")}

def count_anomalies(name: str) -> int:
    st = log_state[name]
    try:
        with open(f"/tmp/ffmpeg_{name}.log", "rb") as f:
            if os.fstat(f.fileno()).st_size < st["offset"]:
                st["offset"], st["count"] = 0, 0  # log truncado: el proceso se ha reiniciado
            f.seek(st["offset"])
            data = f.read()
    except OSError:
        return st["count"]
    st["offset"] += len(data)
    st["count"] += len(ANOMALY_RE.findall(data))
    return st["count"]

def get_font_path() -> str:
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if not os.path.exists(font_path):
        font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    return font_path

def get_spki_fingerprint() -> str:
    cert_path = os.path.join(CERTS_DIR, "cert.pem")
    if not os.path.exists(cert_path):
        return ""
    try:
        cmd = f"openssl x509 -in {cert_path} -outform der | openssl dgst -sha256 -binary | base64"
        res = subprocess.check_output(cmd, shell=True, text=True).strip()
        return res
    except Exception as e:
        logger.error(f"Error calculando fingerprint del certificado: {e}")
        return ""

def kill_proc(proc: Optional[subprocess.Popen]):
    """Termina el grupo de procesos y no vuelve hasta que ha muerto entero.

    Con SIGTERM el shell muere al instante pero FFmpeg puede seguir emitiendo mientras cierra: al reiniciar
    la fuente convivían dos emisiones en los mismos puertos UDP y los empaquetadores las recibían mezcladas.
    Se da un margen al cierre ordenado (el publicador MoQ debe despedirse del relay o la emisión siguiente
    queda tapada por la sesión muerta) y después se fuerza.
    """
    if proc and proc.poll() is None:
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGTERM)
            deadline = time.time() + 1.5
            while time.time() < deadline:
                proc.poll()
                try:
                    os.killpg(pgid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.02)
            else:
                os.killpg(pgid, signal.SIGKILL)
            proc.wait(timeout=3)
        except Exception as e:
            logger.warning(f"No se pudo terminar el proceso {proc.pid}: {e}")

def ensure_master_source(force_restart: bool = False):
    """Mantiene la fuente FFmpeg maestra emitiendo Big Buck Bunny en bucle continuo sin parar."""
    global master_start_time
    if force_restart or processes["master_source"] is None or processes["master_source"].poll() is not None:
        kill_proc(processes.get("master_source"))
        master_start_time = time.time()
        start_epoch_sec = int(master_start_time)
        font_path = get_font_path()
        vf_text = (
            f"setpts=N/(60*TB),"
            f"drawtext=fontfile={font_path}:text='%{{pts\\:hms}}.%{{eif\\:mod(t*1000\\,1000)\\:d\\:3}}':"
            f"fontsize=48:fontcolor=white:box=1:boxcolor=black@0.8:x=60:y=60"
        )

        # Escalera de calidades: cada una se escala y recibe su propio timecode. Mismo GOP y sin cortes
        # de escena en todas, para que sus keyframes coincidan y se pueda conmutar entre ellas.
        ladder = current_config.renditions
        graph = f"[0:v]{vf_text},split={len(ladder)}" + "".join(f"[s{i}]" for i in range(len(ladder)))
        maps, rates = "", ""
        for i, r in enumerate(ladder):
            # Etiqueta con la calidad, arriba a la derecha: deja ver de un vistazo cuál se está reproduciendo
            size = max(14, r.height // 22)
            label = (
                f"drawtext=fontfile={font_path}:text='{r.height}p {r.bitrate_kbps} kbps':fontsize={size}:"
                f"fontcolor=white:box=1:boxcolor=black@0.8:boxborderw={size // 3}:x=w-tw-{size}:y={size}"
            )
            graph += f";[s{i}]scale={r.width}:{r.height},{label},{timecode_filter(timecode_layout(r.width, r.height))}[v{i}]"
            maps += f"-map '[v{i}]' "
            # Tope de tasa (VBV de 1 s): sin él los picos de x264 superan con mucho el bitrate nominal
            # y ni la emulación de red ni la adaptación de calidad tendrían una referencia fiable.
            rates += f"-b:v:{i} {r.bitrate_kbps}k -maxrate:v:{i} {int(r.bitrate_kbps * 1.2)}k -bufsize:v:{i} {r.bitrate_kbps}k "
        graph += ";[1:a]asetpts=N/(SR*TB)[a]"

        # pes_payload_size=0: un PES por frame de audio. Por defecto MPEG-TS agrupa ~180 ms de audio y los
        # empaquetadores retienen el vídeo ese tiempo al intercalar.
        # Emite continuamente por UDP 5001 (DASH) y 5002 (MoQ) con cabeceras repetidas para sincronización en caliente
        # Vídeo y audio se leen por entradas separadas: el fichero los intercala en bloques de 0,5 s y con
        # una sola entrada a ritmo real el audio llega a ráfagas, el muxer retiene el vídeo hasta tenerlo
        # y ambas ramas reciben los frames a trompicones y con retardo añadido.
        master_cmd = (
            f"ffmpeg -re -stream_loop -1 -i '{VIDEO_FILE}' -re -stream_loop -1 -i '{VIDEO_FILE}' "
            f"-filter_complex \"{graph}\" {maps}-map '[a]' "
            f"-c:v libx264 -preset ultrafast -tune zerolatency -threads 4 "
            f"-x264opts \"repeat-headers=1\" "
            f"{rates}-g {current_config.gop_size} -keyint_min {current_config.gop_size} -sc_threshold 0 "
            f"-r {current_config.fps} -c:a aac -ac 2 -b:a 128k "
            f"-f tee \"[f=mpegts:pes_payload_size=0]udp://127.0.0.1:5001?pkt_size=1316|[f=mpegts:pes_payload_size=0]udp://127.0.0.1:5002?pkt_size=1316\""
        )
        logger.info(f"Iniciando Fuente Maestra Continua FFmpeg con reloj en vivo (epoch {start_epoch_sec})...")
        processes["master_source"] = subprocess.Popen(
            master_cmd,
            shell=True,
            preexec_fn=os.setsid,
            stdout=subprocess.DEVNULL,
            stderr=open("/tmp/ffmpeg_master.log", "w")
        )

@app.get("/api/time")
async def get_time():
    """Reloj del servidor (el mismo que FFmpeg quema en el timecode) para sincronizar el navegador."""
    return {"t_ms": time.time() * 1000}

@app.get("/api/utc", response_class=PlainTextResponse)
async def get_utc():
    """Hora del servidor en xs:dateTime para el elemento UTCTiming del manifiesto DASH."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def alive(name: str) -> bool:
    return processes[name] is not None and processes[name].poll() is None

@app.get("/api/status")
def get_status():
    return {
        "status": "running" if desired_running else "stopped",
        "config": current_config,
        "master_start_time_ms": int(master_start_time * 1000),
        "processes": {
            "master_source": alive("master_source"),
            "dash_pipeline": alive("dash_pipeline"),
            "moq_pipeline": alive("moq_pipeline"),
            "pipeline": desired_running,
        },
        "stream_ids": stream_ids,
        "source": source.state,
        "restarts": restarts,
        # Rutas relativas al punto de entrada; MoQ va directo por UDP al puerto indicado
        "dash_url": "/media/dash/manifest.mpd",
        "moq_port": int(os.getenv("MOQ_PORT", "4433")),
        "spki_fingerprint": get_spki_fingerprint(),
        "timecodes": [timecode_layout(r.width, r.height) for r in current_config.renditions],
        "ingest_anomalies": {name: count_anomalies(name) for name in log_state},
        "dash_availability_drift_ms": origin.drift_ms,
        "network": router_call(),
    }

@app.post("/api/network")
def set_network(profile: NetworkProfile):
    """Aplica el mismo perfil de red a las dos ramas (LL-DASH y MoQ) en el router."""
    if profile.down.jitter_ms > profile.down.delay_ms or profile.up.jitter_ms > profile.up.delay_ms:
        raise HTTPException(status_code=422, detail="El jitter no puede superar el retardo")
    result = router_call(profile)
    if result is None or "error" in result:
        raise HTTPException(status_code=502, detail=(result or {}).get("error", "Router de red no disponible"))
    logger.info(f"Perfil de red aplicado: {profile.model_dump()}")
    return result

def launch(name: str, cmd: str, log: str):
    processes[name] = subprocess.Popen(
        cmd,
        shell=True,
        preexec_fn=os.setsid,
        stdout=subprocess.DEVNULL,
        stderr=open(log, "w")
    )

def start_dash():
    """Empaquetador LL-DASH: lee de UDP 5001 y publica fragmentos CMAF por HTTP PUT chunked."""
    kill_proc(processes.get("dash_pipeline"))
    # Vaciar el origen para no mezclar segmentos de la emisión anterior
    origin.reset(current_config.seg_duration, PROBE_S)

    # Sin SegmentTimeline el manifiesto anuncia availabilityTimeOffset y el cliente pide el segmento en curso.
    window = math.ceil(30 / current_config.seg_duration)
    # Todas las calidades van en un único AdaptationSet para que dash.js conmute entre ellas.
    # El bitrate se declara porque con -c copy FFmpeg no lo conoce y el manifiesto lo necesita.
    declared = "".join(f"-b:v:{i} {r.bitrate_kbps}k " for i, r in enumerate(current_config.renditions))
    dash_cmd = (
        f"python3 -u {TSGATE} 5001 | "
        f"ffmpeg -y -analyzeduration {int(PROBE_S * 1_000_000)} -i pipe:0 "
        f"-map 0:v -map 0:a:0 -c:v copy -c:a copy -tag:v avc1 -tag:a mp4a {declared}"
        f"-f dash -adaptation_sets 'id=0,streams=v id=1,streams=a' -seg_duration {current_config.seg_duration} "
        f"-frag_type duration -frag_duration {current_config.frag_duration} "
        f"-streaming 1 -ldash 1 -use_template 1 -use_timeline 0 "
        f"-utc_timing_url '{UTC_TIMING_URL}' "
        f"-window_size {window} -extra_window_size {window} "
        f"-method PUT -http_persistent 1 '{DASH_PUBLISH_URL}'"
    )
    logger.info("Iniciando Empaquetador LL-DASH...")
    launch("dash_pipeline", dash_cmd, "/tmp/ffmpeg_dash.log")
    started_at["dash"] = time.time()
    stream_ids["dash"] = int(started_at["dash"] * 1000)

def start_moq():
    """Empaquetador MoQ: lee de UDP 5002 y publica a moq-relay, sin remultiplexado intermedio."""
    kill_proc(processes.get("moq_pipeline"))
    moq_cmd = (
        f"python3 -u {TSGATE} 5002 | "
        f"moq --connect '{MOQ_RELAY_URL}' --connect-tls-insecure --broadcast live.hang import ts"
    )
    logger.info("Iniciando Empaquetador MoQ hacia moq-relay...")
    launch("moq_pipeline", moq_cmd, "/tmp/ffmpeg_moq.log")
    started_at["moq"] = time.time()
    stream_ids["moq"] = int(started_at["moq"] * 1000)

@app.post("/api/start")
def start_pipeline(config: Optional[StreamConfig] = None):
    global current_config, desired_running
    if source.state["state"] != "ready":
        raise HTTPException(status_code=409, detail="El vídeo fuente todavía se está descargando")
    with lifecycle:
        need_restart_master = False
        if config:
            if config.renditions != current_config.renditions or config.gop_size != current_config.gop_size:
                need_restart_master = True
            current_config = config

        # Asegurar que el segmento DASH no sea inferior a la duración del GOP cuando usamos -c copy
        min_seg = current_config.gop_size / current_config.fps
        if current_config.seg_duration < min_seg:
            logger.info(f"Ajustando seg_duration a {min_seg}s para alinear con GOP de {current_config.gop_size} frames")
            current_config.seg_duration = min_seg

        # Detener los empaquetadores antes de tocar la fuente, para que no mezclen dos emisiones
        kill_proc(processes.get("dash_pipeline"))
        kill_proc(processes.get("moq_pipeline"))
        ensure_master_source(force_restart=need_restart_master)
        start_dash()
        start_moq()
        desired_running = True

    return {"message": "Streaming iniciado con éxito (fuente en directo)", "config": current_config}

@app.post("/api/stop")
def stop_pipeline():
    global desired_running
    with lifecycle:
        logger.info("Deteniendo empaquetadores DASH y MoQ (fuente maestra sigue en directo)...")
        desired_running = False
        kill_proc(processes.get("dash_pipeline"))
        kill_proc(processes.get("moq_pipeline"))
        processes["dash_pipeline"] = None
        processes["moq_pipeline"] = None
        origin.reset(current_config.seg_duration, 0)
    return {"message": "DASH y MoQ detenidos. Fuente maestra sigue en directo."}

@app.post("/api/config")
def update_config(config: StreamConfig):
    return start_pipeline(config)

def supervise():
    """Relanza lo que se haya caído o colgado mientras la emisión deba estar en marcha.

    Cada rama se relanza por separado para no interrumpir la otra; su stream_id cambia y los dashboards
    reconectan solo ese reproductor. Los reinicios quedan contados en /api/status.
    """
    BACKOFF_S = 3
    while True:
        time.sleep(1)
        try:
            with lifecycle:
                if not desired_running:
                    continue
                now = time.time()
                if not alive("master_source"):
                    logger.warning("Supervisor: la fuente maestra ha caído; se relanza todo el pipeline")
                    restarts["master"] += 1
                    kill_proc(processes.get("dash_pipeline"))
                    kill_proc(processes.get("moq_pipeline"))
                    ensure_master_source()
                    start_dash()
                    start_moq()
                    continue
                # DASH colgado: el proceso vive pero lleva varios segmentos sin publicar nada en el origen
                dash_silence = max(10.0, 3 * current_config.seg_duration)
                dash_stuck = now - max(origin.last_activity, started_at["dash"]) > dash_silence
                if (not alive("dash_pipeline") or dash_stuck) and now - started_at["dash"] > BACKOFF_S:
                    logger.warning(f"Supervisor: empaquetador LL-DASH {'colgado' if dash_stuck else 'caído'}; se relanza")
                    restarts["dash"] += 1
                    start_dash()
                if not alive("moq_pipeline") and now - started_at["moq"] > BACKOFF_S:
                    logger.warning("Supervisor: empaquetador MoQ caído; se relanza")
                    restarts["moq"] += 1
                    start_moq()
        except Exception as e:
            logger.error(f"Supervisor: {e}")

def boot():
    """Deja listo el vídeo fuente (descargándolo si falta) y arranca la emisión."""
    while True:
        try:
            source.fetch_video()
            break
        except Exception as e:
            logger.error(f"No se pudo obtener el vídeo fuente: {e}; se reintenta en 30 s")
            source.state.update(state="error", error=str(e))
            time.sleep(30)
    logger.info("Iniciando fuente continua maestra y pipelines al arrancar...")
    start_pipeline()

@app.on_event("startup")
def on_startup():
    # En segundo plano: la descarga inicial tarda minutos y la API debe responder mientras tanto
    threading.Thread(target=boot, daemon=True).start()
    threading.Thread(target=supervise, daemon=True).start()

@app.on_event("shutdown")
def on_shutdown():
    global desired_running
    with lifecycle:
        desired_running = False  # que el supervisor no relance nada mientras se apaga
    kill_proc(processes.get("dash_pipeline"))
    kill_proc(processes.get("moq_pipeline"))
    kill_proc(processes.get("master_source"))
