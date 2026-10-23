"""Evaluación de QoE, fase a: grabación del flujo codificado y emparejamiento con el original.

Para calcular VMAF sin grabar nada en el navegador ni recodificar, el servidor guarda durante la prueba
el flujo que sale del codificador (el mismo que reparten las tres ramas, que no recodifican) y lo indexa:

1. Lee el timecode quemado en cada fotograma grabado, con la misma lectura que hace el navegador.
2. Saca el número de frame del PTS, que la fuente pone exacto. La correspondencia entre PTS y número de
   frame la fija el timecode, por mayoría, con las marcas que FFmpeg escribe en su log al quemarlo
   (trace.py; se copian mientras dura la grabación, porque trace.py solo recuerda el último minuto).
3. El número de frame, módulo los frames del vídeo original, es el fotograma de Big Buck Bunny del que
   viene: la fuente lo numera en orden de decodificación, sin saltos ni repeticiones (setpts=N), y vuelve
   a empezar en cada vuelta del bucle.

Con el registro de qué timecode mostró el navegador y cuándo (fase c), se podrá reconstruir lo que vio
el espectador y compararlo con el original. La comprobación (check) mide por PSNR que el emparejamiento
es correcto: el fotograma emparejado debe parecerse al codificado más que cualquiera de sus vecinos.

Fase b: VMAF de cada fotograma grabado frente a su original. Comparar imágenes retrasa al codificador
aunque vaya con nice 19 (medido: README, sección 4.7), así que el cálculo se encola al indexar y solo se
hace con la emisión parada; si vuelve a arrancar a medias, se interrumpe y vuelve a la cola. Lo mismo
vale para la comprobación por PSNR.

Indexar (decodificar dos filas por fotograma) sí se hace al terminar de grabar: no se nota en el
codificador.

Fase c: lo que vio cada reproductor. Durante la prueba, el medidor glass-to-glass de cada reproductor
anota cada frame nuevo que pinta (hora en reloj del servidor, timecode y altura) y al final lo sube. El
timecode que lee el navegador sale de los mismos píxeles codificados que el que se lee aquí al indexar,
así que se traduce a número de frame buscándolo tal cual en el índice, sin tolerancias. De ahí salen la
latencia exacta de cada frame (contra la marca de FFmpeg), los saltos y los cambios de calidad.

Fase d: la QoE de LL-GABR (Raman, Turkkan y Kosar, 2024, ecuación 6) de cada reproductor, con lo que pintó
(fase c) y el VMAF de cada frame (fase b). Se calcula sola en cuanto están las dos cosas. Ver qoe_session.

Con la cámara RTSP como fuente no hay vídeo original guardado. La fuente emite entonces una referencia
casi sin pérdidas (UDP 5005, ver main.py) con los mismos PTS que la escalera: se graba a la vez que el
flujo codificado y hace de original, de modo que el fotograma n grabado se compara con el n de la referencia.
"""
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections import Counter
from typing import Callable, Optional

from pydantic import BaseModel, Field

from . import trace
from .source import VIDEO_FILE

logger = logging.getLogger("orchestrator")

QOE_DIR = os.path.join(os.path.dirname(VIDEO_FILE), "qoe")
RECORDER = os.path.join(os.path.dirname(__file__), "recorder.py")
RECORD_PORT = 5004       # cuarta salida del tee de la fuente (main.py)
REFERENCE_PORT = 5005    # referencia que emite la fuente con la cámara (main.py)
# La referencia empieza en su primer keyframe y debe cubrir toda la grabación: se pone en marcha antes y
# dura algo más, lo bastante para cubrir lo que el flujo tarde en llegar a su propio keyframe (un GOP)
REFERENCE_EXTRA_S = 5
# Con la cámara, la fuente lleva cada frame a 1920x1080 antes de la escalera (main.py)
CAMERA_SIZE = (1920, 1080)
KEEP_RECORDINGS = 10     # se borran las más antiguas
STAMP_TOLERANCE_MS = 4   # el timecode va en ms enteros y cada bit lee el reloj por separado (ver trace.py)
NICE = ["nice", "-n", "19"]
REC_ID = re.compile(r"^\d{8}-\d{6}$")
SHOWINFO = re.compile(r"\bn:\s*(\d+)\s+pts:\s*(-?\d+)")
STARTED = re.compile(r"started (\d+)")

# Comprobación del emparejamiento: PSNR frente al original emparejado y a sus vecinos
CHECK_OFFSETS = (-2, -1, 0, 1, 2)
CHECK_SAMPLES = 20

# VMAF: modelo por defecto de libvmaf (1080p visto a 3 alturas de pantalla), con la imagen grabada escalada
# a la resolución del original como pide su método. PSNR de luma de paso, para diagnosticar.
VMAF_MODEL = "vmaf_v0.6.1"
VMAF_SCALER = "bicubic"
VMAF_POLL_S = 2.0
IDLE_REQUIRED = "Compara imágenes: solo se hace con la emisión parada"


# QoE de LL-GABR, ecuación 6 (sección 4.3 del artículo), con sus pesos
LLGABR = {"alpha": 0.077, "beta": 1.249, "gamma": 2.897, "sigma": 1.249, "mu": 0.771, "omega": 1.436}
QOE_STEP_MS = 1000   # un paso de la ecuación = 1 s de reloj del espectador (los segmentos del artículo son de 1 s)
STALL_MS = 150       # parón: tanto o más sin frame nuevo; el mismo umbral que "Congelados" en el dashboard
MIN_SPEED_FRAMES = 3 # frames pintados que hacen falta en un paso para estimar su velocidad


def qoe_session(segments: list[dict], start: float, end: float, fps: float, gaps: list) -> dict:
    """QoE de LL-GABR de lo que vio un reproductor entre start y end (ms, reloj del servidor).

    segments: lo que hubo en pantalla, en orden: {"t0", "t1", "n", "latency_ms", "vmaf"}; n None si no se
    sabe qué frame era. Cada uno va de su pintado al siguiente.

    Por paso t (1 s de reloj del espectador):
    - vmaf_t: media del VMAF de los frames distintos que estuvieron en pantalla en el paso, aunque se
      pintaran antes (así un paso entero congelado tiene el del frame congelado).
    - rt_t: segundos del paso dentro de un parón (STALL_MS o más sin frame nuevo, con toda su duración).
    - l_t: latencia media de lo que hubo en pantalla, en s: la de cada frame crece desde su pintado mientras
      sigue en pantalla. Respecto a la que se mide al pintar, suma medio intervalo entre frames (~8 ms a 60 fps).
    - s_t: velocidad de reproducción, la pendiente de vídeo avanzado frente a reloj en los pintados del paso
      (mínimos cuadrados, para no depender del redondeo a refrescos de pantalla). Solo en pasos sin parón:
      dentro de un parón ya penalizan rt_t y r_c.
    - r_c: número de parones que empiezan en la sesión.

    Un paso que se solapa con algo desconocido (frame sin emparejar, fuera de la grabación, sin VMAF o sin
    latencia, o el muestreo parado) se excluye entero; T es el número de pasos que quedan. La suavidad solo
    se cuenta entre pasos consecutivos incluidos.

    Lo que el artículo no dice y aquí se decide: no define rt_t, r_c ni s_t en el texto (por su tabla 3,
    congelado y latencia van en segundos); el término de velocidad aparece sin sumatorio, y se toma su media
    sobre los pasos, como el de latencia. Los demás términos se suman como en la ecuación, así que la QoE
    crece con la duración: solo se comparan sesiones de la misma duración.
    """
    w = LLGABR
    steps = int((end - start) // QOE_STEP_MS)
    rows = []
    for k in range(steps):
        a, b = start + k * QOE_STEP_MS, start + (k + 1) * QOE_STEP_MS
        inside = [s for s in segments if s["t1"] > a and s["t0"] < b]
        known = inside and all(s["n"] is not None and s["vmaf"] is not None and s["latency_ms"] is not None for s in inside)
        stopped = any(g[1] > a and g[0] < b for g in gaps)
        if not known or stopped:
            rows.append({"t": k, "included": False})
            continue
        frames = {(s["stream"], s["n"]): s["vmaf"] for s in inside}
        vmaf = sum(frames.values()) / len(frames)
        stall_ms = latency_area = 0.0
        for s in inside:
            u, v = max(a, s["t0"]), min(b, s["t1"])
            if s["t1"] - s["t0"] >= STALL_MS:
                stall_ms += v - u
            # Integral de la latencia (que crece 1 ms por ms mientras el frame sigue en pantalla) entre u y v
            latency_area += s["latency_ms"] * (v - u) + ((v - s["t0"]) ** 2 - (u - s["t0"]) ** 2) / 2
        speed = None
        painted = [(s["t0"], s["n"]) for s in inside if a <= s["t0"] < b]
        if stall_ms == 0 and len(painted) >= MIN_SPEED_FRAMES:
            mt = sum(t for t, _ in painted) / len(painted)
            mn = sum(n for _, n in painted) / len(painted)
            var = sum((t - mt) ** 2 for t, _ in painted)
            if var > 0:
                # frames por ms → segundos de vídeo por segundo de reloj
                speed = sum((t - mt) * (n - mn) for t, n in painted) / var * 1000 / fps
        rows.append({
            "t": k, "included": True, "vmaf": round(vmaf, 3), "rebuffer_s": round(stall_ms / 1000, 3),
            "latency_s": round(latency_area / QOE_STEP_MS / 1000, 4), "speed": round(speed, 4) if speed is not None else None,
            "frames": len(frames),
        })

    included = [r for r in rows if r["included"]]
    T = len(included)
    if T == 0:
        return {"T": 0, "steps": steps, "qoe": None, "terms": None, "rows": rows}
    first_kept, last_kept = start + included[0]["t"] * QOE_STEP_MS, start + (included[-1]["t"] + 1) * QOE_STEP_MS
    kept = {r["t"] for r in included}
    stalls = [s for s in segments if s["t1"] - s["t0"] >= STALL_MS and int((s["t0"] - start) // QOE_STEP_MS) in kept]
    speeds = [r["speed"] for r in included if r["speed"] is not None]
    smooth = sum(abs(r["vmaf"] - p["vmaf"]) / 20 for p, r in zip(rows, rows[1:]) if p["included"] and r["included"])
    terms = {
        "quality": w["alpha"] * sum(r["vmaf"] / 20 for r in included),
        "rebuffer_time": -w["beta"] * sum(r["rebuffer_s"] for r in included),
        "rebuffer_count": -w["gamma"] * len(stalls),
        "latency": -w["sigma"] * sum(r["latency_s"] for r in included) / T,
        "speed": -w["mu"] * (sum(abs(1 - s) for s in speeds) / len(speeds)) if speeds else None,
        "smoothness": -w["omega"] * smooth,
    }
    qoe = sum(v for v in terms.values() if v is not None)
    return {
        "T": T,
        "steps": steps,
        "excluded_steps": steps - T,
        "qoe": round(qoe, 3),
        "terms": {k: (round(v, 3) if v is not None else None) for k, v in terms.items()},
        "inputs": {
            "vmaf_mean": round(sum(r["vmaf"] for r in included) / T, 2),
            "rebuffer_s": round(sum(r["rebuffer_s"] for r in included), 3),
            "rebuffer_count": len(stalls),
            "latency_mean_s": round(sum(r["latency_s"] for r in included) / T, 4),
            "speed_mean": round(sum(speeds) / len(speeds), 4) if speeds else None,
            "speed_steps": len(speeds),
            "speed_abs_dev_mean": round(sum(abs(1 - s) for s in speeds) / len(speeds), 4) if speeds else None,
            "vmaf_change_sum": round(smooth * 20, 2),
        },
        "rows": rows,
        "window_ms": [first_kept, last_kept],
    }


class Interrupted(Exception):
    """La emisión volvió a arrancar mientras se comparaban imágenes."""


class RecordingRequest(BaseModel):
    duration_s: float = Field(..., ge=5, le=330, description="Segundos que se graban desde el primer keyframe")
    # El VMAF solo se calcula con la emisión parada: así se calcula nada más terminar la prueba
    stop_after: bool = Field(False, description="Detener la emisión en cuanto termine la grabación")


PLAYERS = ("dash", "moq", "rtc")


class ViewUpload(BaseModel):
    """Lo que pintó un reproductor durante la prueba, según su medidor glass-to-glass."""
    frames: list[tuple[float, int, int]] = Field(..., description="[hora de pintado (ms desde window_ms[0]), timecode, altura] por frame nuevo")
    gaps: list[tuple[float, float]] = Field(default_factory=list, description="Tramos con el muestreo parado (pestaña oculta, hilo bloqueado): no se sabe qué se pintó")
    unreadable: int = Field(0, description="Lecturas sin timecode legible")
    window_ms: tuple[float, float] = Field(..., description="Principio y fin del registro, reloj del servidor")
    clock_offset_ms: Optional[float] = None
    clock_rtt_ms: Optional[float] = None
    hidden: bool = Field(False, description="La pestaña estuvo oculta en algún momento del registro")
    user_agent: str = ""


_source_info: Optional[dict] = None


def source_info() -> dict:
    """Frames, primera marca de tiempo y cadencia del vídeo original (se cuentan una vez)."""
    global _source_info
    if _source_info is None:
        out = subprocess.run(
            NICE + ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
                    "-show_entries", "stream=nb_read_packets,start_time,r_frame_rate,width,height",
                    "-of", "json", VIDEO_FILE],
            capture_output=True, text=True, check=True,
        ).stdout
        stream = json.loads(out)["streams"][0]
        num, den = stream["r_frame_rate"].split("/")
        _source_info = {
            "frames": int(stream["nb_read_packets"]),
            "start_time": float(stream["start_time"]),
            "fps": int(num) / int(den),
            "width": stream["width"],
            "height": stream["height"],
        }
    return _source_info


_vmaf_version: Optional[str] = None


def vmaf_version() -> str:
    global _vmaf_version
    if _vmaf_version is None:
        done = subprocess.run(["vmaf", "--version"], capture_output=True, text=True)
        _vmaf_version = (done.stdout or done.stderr).strip()  # la escribe en stderr
    return _vmaf_version


def unwrap(pts: list[int]) -> list[int]:
    """PTS sin la vuelta de los 33 bits (cada 26,5 h de emisión)."""
    unwrapped, carry = [], 0
    for p in pts:
        if unwrapped and p + carry < unwrapped[-1] - 2 ** 32:
            carry += 2 ** 33
        unwrapped.append(p + carry)
    return unwrapped


def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(p * len(ordered)))]


def even(value: float) -> int:
    return int(value // 2) * 2


def compare_region(layouts: list[dict], width: int, height: int) -> tuple[int, int, int, int]:
    """(ancho, alto, x, y) de la zona que se compara con el original, en la resolución del original.

    Se deja fuera lo que la fuente dibuja encima y el original no tiene: el reloj de arriba a la
    izquierda (fontsize 48 en y=60, antes de escalar), la etiqueta de calidad de arriba a la derecha y
    la franja del timecode de abajo, que en cada calidad está a otra altura relativa. Es la misma zona
    para todas las calidades de una grabación.
    """
    top = 136
    bottom = min((l["y"] - l["cell"] // 2) * height / l["height"] for l in layouts) - 8
    return width, even(bottom - top), 0, top


def strip_rect(layout: dict) -> tuple[int, int, int]:
    """(x, y, ancho) de las dos filas centrales de la franja del timecode, como en glass.ts."""
    n = layout["bits"] + 4
    x = even(layout["x"])
    y = even(layout["y"] + layout["cell"] / 2 - 1)
    width = min(even(n * layout["cell"] + 1), even(layout["width"] - layout["x"]))
    return x, y, width


def decode_strip(px: bytes, width: int, layout: dict) -> Optional[int]:
    """Timecode (ms módulo 2^bits) de dos filas de luma de la franja, o None si no se lee.

    Es la misma lectura que decodeTimecodeFromFrame en web/src/lib/glass.ts, a escala 1.
    """
    bits, cell = layout["bits"], layout["cell"]
    n = bits + 4

    def luma(i: int) -> float:
        col = min(width - 2, int((i + 0.5) * cell) - 1)
        return (px[col] + px[col + 1] + px[width + col] + px[width + col + 1]) / 4

    white = min(luma(0), luma(n - 1))
    black = max(luma(1), luma(n - 2))
    span = white - black
    if span < 80:
        return None
    threshold = black + span / 2
    bit = value = 0
    for i in range(bits):
        level = luma(2 + i)
        if abs(level - threshold) < span * 0.2:
            return None  # celda ambigua
        bit ^= 1 if level > threshold else 0  # Gray -> binario, de MSB a LSB
        value = value * 2 + bit
    return value


class Recordings:
    def __init__(self):
        self.lock = threading.Lock()
        self.meta_lock = threading.Lock()
        self.views_lock = threading.Lock()
        self.active: Optional[str] = None
        self.checking: set[str] = set()
        self.computing: Optional[str] = None
        # Lo pone main.py: True si la emisión está parada (ni empaquetadores ni fuente)
        self.idle: Callable[[], bool] = lambda: False

    # --- ficheros ---

    def path(self, rec_id: str, name: str = "") -> str:
        if not REC_ID.match(rec_id):
            raise KeyError(rec_id)
        return os.path.join(QOE_DIR, rec_id, name)

    def read(self, rec_id: str, name: str) -> Optional[dict]:
        try:
            with open(self.path(rec_id, name)) as f:
                return json.load(f)
        except FileNotFoundError:
            return None

    def write(self, rec_id: str, name: str, data: dict):
        tmp = self.path(rec_id, name + ".part")
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, self.path(rec_id, name))

    def update_meta(self, rec_id: str, **fields) -> dict:
        # Leer, modificar y escribir de una vez: escriben a la vez el hilo de la grabación, la cola de VMAF
        # y las peticiones que suben lo que vio cada reproductor
        with self.meta_lock:
            meta = self.read(rec_id, "meta.json") or {}
            meta.update(fields)
            self.write(rec_id, "meta.json", meta)
            return meta

    def all(self) -> list[dict]:
        if not os.path.isdir(QOE_DIR):
            return []
        ids = sorted((d for d in os.listdir(QOE_DIR) if REC_ID.match(d)), reverse=True)
        return [m for m in (self.read(i, "meta.json") for i in ids) if m]

    def get(self, rec_id: str) -> Optional[dict]:
        meta = self.read(rec_id, "meta.json")
        if meta is not None:
            meta["check"] = self.read(rec_id, "check.json")
        return meta

    # --- lo que vio cada reproductor (fase c) ---

    def add_view(self, rec_id: str, player: str, view: ViewUpload) -> Optional[dict]:
        """Guarda el registro de un reproductor y, si la grabación ya está indexada, lo traduce."""
        if player not in PLAYERS:
            raise KeyError(player)
        self.write(rec_id, f"view-{player}.json", view.model_dump())
        if (self.read(rec_id, "meta.json") or {}).get("state") == "ready":
            return self._map_view(rec_id, player)
        return None

    def view(self, rec_id: str, player: str) -> Optional[dict]:
        if player not in PLAYERS:
            raise KeyError(player)
        return self.read(rec_id, f"view-{player}.mapped.json")

    def _map_views(self, rec_id: str):
        for player in PLAYERS:
            if self.read(rec_id, f"view-{player}.json") is not None:
                self._map_view(rec_id, player)

    def _map_view(self, rec_id: str, player: str) -> dict:
        """Número de frame, calidad y latencia exacta de cada frame que pintó el reproductor.

        Fuera de la grabación quedan los frames codificados antes de que empezara o después de que
        terminara (el registro del navegador empieza más tarde para que no los haya, pero con más latencia
        que ese margen aparecen); sin emparejar, los timecodes que caen dentro y no están en el índice
        (lectura errónea). Ninguno de los dos se rellena.
        """
        view = self.read(rec_id, f"view-{player}.json")
        index = self.index(rec_id)
        stamps = self.read(rec_id, "stamps.json") or {}
        span = 2 ** self.read(rec_id, "meta.json")["timecodes"][0]["bits"]
        by_height, tables, ranges, marks = {}, {}, {}, {}
        for stream in index["streams"]:
            i = stream["index"]
            by_height[stream["height"]] = i
            tables[i] = {c: n for c, n in zip(stream["timecode"], stream["n"]) if c is not None and n is not None}
            codes = [c for c in stream["timecode"] if c is not None]
            ranges[i] = (codes[0], codes[-1]) if codes else None
            marks[i] = {int(n): m for n, m in stamps.get(str(i), [])}

        def outside(i: int, code: int) -> bool:
            first, last = ranges[i]
            # Distancias módulo 2^bits respecto al primer timecode grabado: fuera si cae antes o después
            return (code - first) % span > (last - first) % span

        rows, latencies = [], []
        counts = {"outside_recording": 0, "unmatched": 0, "unknown_height": 0}
        start = view["window_ms"][0]
        for since, code, height in view["frames"]:
            t = round(start + since, 1)
            i = by_height.get(height)
            if i is None:
                counts["unknown_height"] += 1
                rows.append([t, None, None, None])
                continue
            n = tables[i].get(code)
            if n is None:
                counts["outside_recording" if ranges[i] is None or outside(i, code) else "unmatched"] += 1
                rows.append([t, i, None, None])
                continue
            mark = marks[i].get(n)
            latency = round(t - mark, 1) if mark is not None else None
            if latency is not None:
                latencies.append(latency)
            rows.append([t, i, n, latency])

        matched = [(t, i, n) for t, i, n, _ in rows if n is not None]
        skipped = sum(max(0, b[2] - a[2] - 1) for a, b in zip(matched, matched[1:]))
        backwards = sum(1 for a, b in zip(matched, matched[1:]) if b[2] <= a[2])
        switches = sum(1 for a, b in zip(matched, matched[1:]) if b[1] != a[1])
        summary = {
            "frames": len(rows),
            "matched": len(matched),
            **counts,
            "unreadable": view.get("unreadable", 0),
            # Frames de la fuente que no llegaron a pintarse entre dos pintados (saltos al directo, frames
            # descartados por el reproductor o no leídos por el medidor)
            "skipped": skipped,
            # Debería ser 0: un frame anterior pintado después de uno posterior
            "backwards": backwards,
            "rendition_switches": switches,
            "gaps": len(view.get("gaps", [])),
            "hidden": view.get("hidden", False),
            "window_s": round((view["window_ms"][1] - view["window_ms"][0]) / 1000, 1),
            "latency_ms": {
                "p50": percentile(latencies, 0.5), "p95": percentile(latencies, 0.95),
                "min": min(latencies), "max": max(latencies),
            } if latencies else None,
            "clock_rtt_ms": view.get("clock_rtt_ms"),
        }
        self.write(rec_id, f"view-{player}.mapped.json", {
            "summary": summary,
            "columns": ["t_ms", "stream", "n", "latency_ms"],
            "frames": rows,
            "gaps": view.get("gaps", []),
            "window_ms": view["window_ms"],
        })
        with self.views_lock:
            meta = self.read(rec_id, "meta.json")
            self.update_meta(rec_id, views={**(meta.get("views") or {}), player: summary})
        if (meta.get("vmaf") or {}).get("state") == "done":
            self._qoe(rec_id, player)
        return summary

    def recompute_qoe(self, rec_id: str) -> dict:
        """Rehace la QoE de los reproductores con registro (p. ej. tras cambiar el método)."""
        if ((self.read(rec_id, "meta.json") or {}).get("vmaf") or {}).get("state") != "done":
            raise RuntimeError("Falta el VMAF de la grabación")
        done = [p for p in PLAYERS if self.read(rec_id, f"view-{p}.mapped.json") is not None]
        for player in done:
            self._qoe(rec_id, player)
        return (self.read(rec_id, "meta.json") or {}).get("qoe") or {}

    def qoe(self, rec_id: str, player: str) -> Optional[dict]:
        if player not in PLAYERS:
            raise KeyError(player)
        return self.read(rec_id, f"qoe-{player}.json")

    def _qoe(self, rec_id: str, player: str):
        """QoE de LL-GABR de un reproductor: lo que pintó (fase c) con el VMAF de cada frame (fase b)."""
        view = self.read(rec_id, f"view-{player}.mapped.json")
        vmaf = self.vmaf(rec_id)
        index = self.index(rec_id)
        meta = self.read(rec_id, "meta.json")
        score = {}
        for stream, result in zip(index["streams"], vmaf["streams"]):
            score[stream["index"]] = dict(zip(stream["n"], result["vmaf"]))
        frames = view["frames"]
        end = view["window_ms"][1]
        segments = []
        for k, (t, stream, n, latency) in enumerate(frames):
            t1 = frames[k + 1][0] if k + 1 < len(frames) else end
            segments.append({
                "t0": t, "t1": t1, "stream": stream, "n": n, "latency_ms": latency,
                "vmaf": score.get(stream, {}).get(n) if n is not None else None,
            })
        # Desde el primer frame pintado: lo que había en pantalla antes no se sabe
        start = frames[0][0] if frames else end
        result = qoe_session(segments, start, end, meta["fps"], view.get("gaps", []))
        result.update({
            "player": player,
            "weights": LLGABR,
            "step_ms": QOE_STEP_MS,
            "stall_ms": STALL_MS,
            "hidden": view["summary"].get("hidden", False),
            "view": view["summary"],
        })
        self.write(rec_id, f"qoe-{player}.json", result)
        with self.views_lock:
            meta = self.read(rec_id, "meta.json")
            brief = {k: result.get(k) for k in ("qoe", "T", "excluded_steps", "terms", "inputs", "hidden")}
            self.update_meta(rec_id, qoe={**(meta.get("qoe") or {}), player: brief})
        logger.info(f"QoE: {rec_id} {player}: {result['qoe']} (T={result['T']})")

    def index(self, rec_id: str) -> Optional[dict]:
        return self.read(rec_id, "index.json")

    def prune(self):
        ids = sorted(d for d in os.listdir(QOE_DIR) if REC_ID.match(d))
        for old in ids[:-KEEP_RECORDINGS]:
            if old != self.active and old not in self.checking and old != self.computing:
                shutil.rmtree(os.path.join(QOE_DIR, old), ignore_errors=True)

    # --- grabación ---

    def start(self, duration_s: float, context: dict, master_start_ms: Callable[[], int],
              on_recorded: Optional[Callable[[], None]] = None) -> dict:
        """Empieza a grabar. context: calidades, timecodes y cadencia de la emisión en curso.

        on_recorded se llama al terminar de grabar bien, antes de indexar (p. ej. para detener la emisión).
        """
        with self.lock:
            if self.active:
                raise RuntimeError(f"Ya hay una grabación en curso ({self.active})")
            rec_id = time.strftime("%Y%m%d-%H%M%S")
            os.makedirs(self.path(rec_id), exist_ok=True)
            meta = {"id": rec_id, "state": "recording", "error": None, "duration_s": duration_s,
                    "created_ms": int(time.time() * 1000), **context}
            self.write(rec_id, "meta.json", meta)
            self.active = rec_id
        threading.Thread(target=self._run, args=(rec_id, duration_s, master_start_ms, on_recorded), daemon=True).start()
        return meta

    def _run(self, rec_id: str, duration_s: float, master_start_ms: Callable[[], int],
             on_recorded: Optional[Callable[[], None]] = None):
        try:
            started_ms, stamps = self._record(rec_id, duration_s, master_start_ms)
            self.update_meta(rec_id, state="indexing", started_ms=started_ms)
            if on_recorded:
                # La emisión ya no hace falta: indexar y subir los registros no dependen de ella
                try:
                    on_recorded()
                    self.update_meta(rec_id, stopped_after=True)
                except Exception as e:
                    logger.warning(f"QoE: no se pudo detener la emisión tras {rec_id}: {e}")
            summary = self._build_index(rec_id, stamps)
            self.update_meta(rec_id, state="ready", streams=summary, vmaf=self._queued())
            logger.info(f"QoE: grabación {rec_id} indexada: {summary}")
            # Los registros que subieron los reproductores antes de terminar el índice
            self._map_views(rec_id)
        except Exception as e:
            logger.warning(f"QoE: grabación {rec_id} fallida: {e}")
            self.update_meta(rec_id, state="error", error=str(e))
        finally:
            with self.lock:
                self.active = None
            self.prune()

    def _record(self, rec_id: str, duration_s: float, master_start_ms: Callable[[], int]):
        master = master_start_ms()
        camera = self.read(rec_id, "meta.json").get("source") == "camera"
        since_ms = time.time() * 1000 - 1000
        stamps: dict[str, dict[int, float]] = {}
        procs: list[subprocess.Popen] = []

        def collect():
            for stream, pairs in trace.frame_log.stamps_since(since_ms).items():
                known = stamps.setdefault(str(stream), {})
                for mark, number in pairs:
                    known[number] = mark

        def recorder(port: int, name: str, seconds: float) -> subprocess.Popen:
            proc = subprocess.Popen(
                ["python3", "-u", RECORDER, str(port), self.path(rec_id, name), str(seconds)],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            procs.append(proc)
            return proc

        def wait(running: Callable[[], bool], deadline: float):
            while running():
                collect()
                if master_start_ms() != master:
                    raise RuntimeError("La fuente se reinició durante la grabación")
                if time.time() > deadline:
                    raise RuntimeError("No llegó el flujo de la fuente: ¿está la emisión en marcha?")
                time.sleep(0.2)

        def started(proc: subprocess.Popen, what: str) -> int:
            output = proc.stdout.read()
            found = STARTED.search(output)
            if proc.returncode != 0 or not found:
                raise RuntimeError(f"El grabador {what} terminó con código {proc.returncode}: {output.strip()[-300:]}")
            return int(found.group(1))

        try:
            reference = None
            if camera:
                # La referencia se pone en marcha antes y espera a su propio keyframe: así su primer frame
                # es anterior al primero del flujo grabado. Termina REFERENCE_EXTRA_S después.
                reference = recorder(REFERENCE_PORT, "reference.ts", duration_s + REFERENCE_EXTRA_S)
                ready = []
                reader = threading.Thread(target=lambda: ready.append(reference.stdout.readline()), daemon=True)
                reader.start()
                wait(lambda: reader.is_alive() and reference.poll() is None, time.time() + 15)
                reader.join(timeout=1)
                if not ready or not STARTED.search(ready[0]):
                    raise RuntimeError(f"No llegó la referencia de la cámara: {''.join(ready).strip()[-300:]}")
            proc = recorder(RECORD_PORT, "stream.ts", duration_s)
            wait(lambda: proc.poll() is None, time.time() + duration_s + 15)
            if reference is not None:
                wait(lambda: reference.poll() is None, time.time() + REFERENCE_EXTRA_S + 15)
        finally:
            for p in procs:
                if p.poll() is None:
                    p.kill()
                    p.wait()
        collect()
        started_ms = started(proc, "del flujo")
        if reference is not None:
            output = reference.stdout.read()
            if reference.returncode != 0:
                raise RuntimeError(f"El grabador de la referencia terminó con código {reference.returncode}: {output.strip()[-300:]}")
        self.write(rec_id, "stamps.json", {s: sorted(d.items()) for s, d in stamps.items()})
        return started_ms, {s: sorted(d.items()) for s, d in stamps.items()}

    # --- índice ---

    def reindex(self, rec_id: str) -> list[dict]:
        """Rehace el índice con las marcas guardadas (p. ej. tras cambiar el método) y vuelve a encolar el VMAF."""
        meta = self.read(rec_id, "meta.json")
        stamps = self.read(rec_id, "stamps.json")
        if not meta or meta.get("state") not in ("ready", "error") or stamps is None:
            raise RuntimeError("La grabación no ha terminado o no tiene marcas guardadas")
        if self.computing == rec_id or rec_id in self.checking:
            raise RuntimeError("La grabación se está comparando")
        summary = self._build_index(rec_id, stamps)
        self.update_meta(rec_id, state="ready", error=None, streams=summary, vmaf=self._queued())
        self._map_views(rec_id)
        return summary

    def original(self, rec_id: str) -> dict:
        """El original con el que se compara: el vídeo del bucle o la referencia grabada de la cámara."""
        index = self.index(rec_id)
        if index and index["source"].get("kind") == "camera":
            return index["source"]
        return {"kind": "file", **source_info()}

    def _build_index(self, rec_id: str, stamps: dict) -> list[dict]:
        meta = self.read(rec_id, "meta.json")
        camera = meta.get("source") == "camera"
        # Con la cámara no hay vídeo en bucle: el número de frame es directamente el de la referencia
        src = None if camera else source_info()
        ticks = round(90000 / meta["fps"])
        streams, summary = [], []
        for i, layout in enumerate(meta["timecodes"]):
            x, y, width = strip_rect(layout)
            raw, log = self.path(rec_id, f"strip{i}.raw"), self.path(rec_id, f"strip{i}.log")
            with open(log, "w") as err:
                subprocess.run(
                    NICE + ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info", "-copyts",
                            "-i", self.path(rec_id, "stream.ts"), "-map", f"0:v:{i}",
                            "-vf", f"crop={width}:2:{x}:{y},format=gray,showinfo",
                            "-fps_mode", "passthrough", "-f", "rawvideo", "-y", raw],
                    stdout=subprocess.DEVNULL, stderr=err, check=True,
                )
            with open(log) as f:
                pts = [int(p) for _, p in SHOWINFO.findall(f.read())]
            with open(raw, "rb") as f:
                data = f.read()
            os.remove(raw)
            size = width * 2
            if len(data) != size * len(pts):
                raise RuntimeError(f"Calidad {i}: {len(data) // size} imágenes y {len(pts)} marcas de showinfo")
            # El grabador corta a mitad del último frame y el decodificador completa lo que falta con el
            # anterior (repite su timecode): no se usa
            pts = pts[:-1]

            pts = unwrap(pts)

            # El número de frame sale del PTS, que la fuente pone exacto (n por la duración de un frame más
            # una base). El timecode solo fija la base, por mayoría: cada fotograma cuyo timecode cae a
            # menos de STAMP_TOLERANCE_MS de una marca vota por la base que resulta. No basta con el
            # timecode solo: cada bit lee el reloj por separado y, con la máquina cargada, el valor quemado
            # se queda hasta decenas de ms por detrás de la marca (medido: hasta 44 ms con tres calidades),
            # más cerca a veces de la marca del frame anterior que de la suya.
            span = 2 ** layout["bits"]
            stamp_of = {int(number): mark for number, mark in stamps.get(str(i), [])}
            by_code: dict[int, list] = {}
            for number, mark in stamp_of.items():
                by_code.setdefault(int(mark) % span, []).append(number)
            codes = [decode_strip(data[j * size:(j + 1) * size], width, layout) for j in range(len(pts))]
            votes: Counter = Counter()
            for p, code in zip(pts, codes):
                if code is None:
                    continue
                near = {n for d in range(-STAMP_TOLERANCE_MS, STAMP_TOLERANCE_MS + 1) for n in by_code.get((code + d) % span, [])}
                for n in near:
                    votes[p - n * ticks] += 1
            if not votes:
                raise RuntimeError(f"Calidad {i}: ningún timecode coincide con las marcas de la fuente")
            base, base_votes = votes.most_common(1)[0]
            numbers = [(p - base) // ticks if (p - base) % ticks == 0 else None for p in pts]

            # Comprobaciones: con la base buena, todos los PTS caen en la rejilla, los números son
            # consecutivos y el timecode leído de cada frame queda unos ms por detrás de su propia marca
            lags = []
            for n, code in zip(numbers, codes):
                if n is not None and code is not None and n in stamp_of:
                    lag = (int(stamp_of[n]) - code) % span
                    lags.append(lag - span if lag > span // 2 else lag)
            assigned = [n for n in numbers if n is not None]
            not_consecutive = sum(1 for a, b in zip(numbers, numbers[1:]) if a is None or b is None or b - a != 1)
            first_n = assigned[0] if assigned else None
            last_n = assigned[-1] if assigned else None
            stream_summary = {
                "index": i,
                "width": layout["width"],
                "height": layout["height"],
                "frames": len(pts),
                "timecode_read": sum(c is not None for c in codes),
                "base_votes": base_votes,  # fotogramas cuyo timecode confirma la base
                "assigned": len(assigned),
                # Deberían ser 0: PTS fuera de la rejilla, números no consecutivos y timecodes que no
                # cuadran con su propia marca (más de 100 ms: lectura errónea o base equivocada)
                "pts_off_grid": len(numbers) - len(assigned),
                "not_consecutive": not_consecutive,
                "timecode_disagree": sum(1 for lag in lags if abs(lag) > 100),
                # Marca escrita por FFmpeg menos timecode quemado, en ms
                "timecode_lag_ms": {
                    "p50": percentile(lags, 0.5), "p95": percentile(lags, 0.95), "max": max(lags), "min": min(lags),
                } if lags else None,
                "first_n": first_n,
                "last_n": last_n,
                "pts_base": base,
            }
            if src is not None:
                stream_summary.update({
                    "source_first": first_n % src["frames"] if first_n is not None else None,
                    "source_last": last_n % src["frames"] if last_n is not None else None,
                    "loop_wraps": (last_n // src["frames"] - first_n // src["frames"]) if assigned else 0,
                })
            summary.append(stream_summary)
            streams.append({**stream_summary, "pts": pts, "timecode": codes, "n": numbers})
        if camera:
            src = self._index_reference(rec_id, summary, ticks, meta["fps"])
            self.update_meta(rec_id, reference=src)
        self.write(rec_id, "index.json", {"source": src, "streams": streams})
        return summary

    def _index_reference(self, rec_id: str, summary: list[dict], ticks: int, fps: int) -> dict:
        """Numera los frames de la referencia de la cámara con la base de PTS de la primera calidad.

        Sale del mismo proceso y del mismo setpts=N que la escalera, así que comparte sus PTS: basta con
        leer los de los paquetes, sin decodificar. La comprobación por PSNR confirma que el emparejamiento
        es bueno (con una base desplazada un número entero de frames, la rejilla cuadraría igual).
        """
        out = subprocess.run(
            NICE + ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts",
                    "-of", "csv=p=0", self.path(rec_id, "reference.ts")],
            capture_output=True, text=True, check=True,
        ).stdout
        # Sin frames B (preset ultrafast), el orden de los paquetes es el de presentación. El último se
        # descarta, como en el flujo: el grabador lo corta.
        values = (line.split(",")[0].strip() for line in out.splitlines())
        pts = unwrap([int(v) for v in values if v.lstrip("-").isdigit()])[:-1]
        base = summary[0]["pts_base"]
        numbers = [(p - base) // ticks if (p - base) % ticks == 0 else None for p in pts]
        assigned = [n for n in numbers if n is not None]
        first_n = assigned[0] if assigned else None
        last_n = assigned[-1] if assigned else None
        uncovered = [
            s["index"] for s in summary
            if first_n is None or s["first_n"] is None or s["first_n"] < first_n or s["last_n"] > last_n
        ]
        return {
            "kind": "camera",
            "width": CAMERA_SIZE[0],
            "height": CAMERA_SIZE[1],
            "fps": fps,
            "frames": len(pts),
            # Deberían ser 0 y estar vacío: PTS fuera de la rejilla, números no consecutivos y calidades
            # con frames fuera del tramo grabado de la referencia
            "pts_off_grid": len(numbers) - len(assigned),
            "not_consecutive": sum(1 for a, b in zip(numbers, numbers[1:]) if a is None or b is None or b - a != 1),
            "uncovered_streams": uncovered,
            "first_n": first_n,
            "last_n": last_n,
            "pts_base": base,
            "ticks": ticks,
        }

    def _reference_usable(self, rec_id: str):
        ref = self.original(rec_id)
        if ref["kind"] == "camera" and (ref["pts_off_grid"] or ref["not_consecutive"] or ref["uncovered_streams"]):
            raise RuntimeError("La referencia de la cámara no es fiable (ver pts_off_grid, not_consecutive y uncovered_streams)")
        return ref

    def _reference_cmd(self, rec_id: str, ref: dict, numbers: list[int], vf: str) -> list[list[str]]:
        """Órdenes de FFmpeg que escriben en crudo, por stdout y en orden, los frames numbers del original.

        numbers va en orden creciente: o un tramo consecutivo (VMAF) o varios sueltos (comprobación).
        Con el bucle, cada tramo consecutivo se lee con un -ss propio y se parte en dos si cruza el final
        del vídeo: con -stream_loop, FFmpeg no vuelve al frame 0 después de un -ss. Con -ss delante de -i
        descarta lo anterior a esa hora absoluta; el frame k está en start_time + k/fps.
        Con la cámara se decodifica la referencia desde el principio y se escogen los frames por su PTS
        original (-copyts), sin saltar: un salto en MPEG-TS puede caer entre dos keyframes y desplazarlo todo.
        """
        if ref["kind"] == "camera":
            pts = lambda n: ref["pts_base"] + n * ref["ticks"]
            if numbers[-1] - numbers[0] + 1 == len(numbers):
                wanted = f"between(pts\\,{pts(numbers[0])}\\,{pts(numbers[-1])})"
            else:
                wanted = "+".join(f"eq(pts\\,{pts(n)})" for n in numbers)
            return [["ffmpeg", "-nostdin", "-v", "error", "-copyts", "-i", self.path(rec_id, "reference.ts"),
                     "-map", "0:v:0", "-vf", f"select='{wanted}',{vf}",
                     "-fps_mode", "passthrough", "-f", "rawvideo", "-"]]
        runs: list[list[int]] = []
        for n in numbers:
            k = n % ref["frames"]
            if runs and k == runs[-1][0] + runs[-1][1]:
                runs[-1][1] += 1
            else:
                runs.append([k, 1])
        cmds = []
        for k, take in runs:
            seek = ref["start_time"] + k / ref["fps"] - 0.25 / ref["fps"]
            cmds.append(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{seek:.6f}", "-i", VIDEO_FILE,
                         "-map", "0:v:0", "-frames:v", str(take), "-vf", vf, "-f", "rawvideo", "-"])
        return cmds

    # --- comprobación del emparejamiento ---

    def start_check(self, rec_id: str):
        meta = self.read(rec_id, "meta.json")
        if not meta or meta.get("state") != "ready":
            raise RuntimeError("La grabación no está indexada")
        if not self.idle():
            raise RuntimeError(IDLE_REQUIRED)
        with self.lock:
            if rec_id in self.checking:
                raise RuntimeError("La comprobación ya está en marcha")
            self.checking.add(rec_id)
        self.write(rec_id, "check.json", {"state": "running"})
        threading.Thread(target=self._check, args=(rec_id,), daemon=True).start()

    def _check(self, rec_id: str):
        try:
            result = {"state": "done", "streams": [self._check_stream(rec_id, s) for s in self.index(rec_id)["streams"]]}
        except Exception as e:
            logger.warning(f"QoE: comprobación de {rec_id} fallida: {e}")
            result = {"state": "error", "error": str(e)}
        finally:
            with self.lock:
                self.checking.discard(rec_id)
        self.write(rec_id, "check.json", result)

    def _check_stream(self, rec_id: str, stream: dict) -> dict:
        """PSNR de una muestra de fotogramas grabados frente a su original emparejado y a sus vecinos."""
        src = self._reference_usable(rec_id)
        layouts = self.read(rec_id, "meta.json")["timecodes"]
        w, h, cx, cy = compare_region(layouts, src["width"], src["height"])
        frame_size = w * h
        reach = max(abs(k) for k in CHECK_OFFSETS)
        if src["kind"] == "camera":
            inside = lambda n: src["first_n"] + reach <= n <= src["last_n"] - reach
        else:
            inside = lambda n: reach <= n % src["frames"] < src["frames"] - reach
        candidates = [(j, n) for j, n in enumerate(stream["n"]) if n is not None and inside(n)]
        if not candidates:
            return {"index": stream["index"], "samples": []}
        step = max(1, len(candidates) // CHECK_SAMPLES)
        samples = candidates[::step][:CHECK_SAMPLES]
        tmp = self.path(rec_id, f"check{stream['index']}")
        os.makedirs(tmp, exist_ok=True)
        try:
            # Fotogramas grabados, escalados a 1080p como los escalará el cálculo de VMAF
            select = "+".join(f"eq(n\\,{j})" for j, _ in samples)
            enc = os.path.join(tmp, "enc.raw")
            subprocess.run(
                NICE + ["ffmpeg", "-nostdin", "-v", "error", "-i", self.path(rec_id, "stream.ts"),
                        "-map", f"0:v:{stream['index']}",
                        "-vf", f"select='{select}',scale={src['width']}:{src['height']}:flags=bicubic,"
                               f"crop={w}:{h}:{cx}:{cy},format=gray",
                        "-fps_mode", "passthrough", "-f", "rawvideo", "-y", enc],
                check=True, capture_output=True,
            )
            if os.path.getsize(enc) != frame_size * len(samples):
                raise RuntimeError("No se extrajeron todos los fotogramas grabados de la muestra")

            # Originales: para cada muestra, los frames n-2..n+2 (las ventanas de dos muestras pueden solaparse)
            needed = sorted({n + k for _, n in samples for k in CHECK_OFFSETS})
            out = b"".join(
                subprocess.run(NICE + cmd, check=True, capture_output=True).stdout
                for cmd in self._reference_cmd(rec_id, src, needed, f"crop={w}:{h}:{cx}:{cy},format=gray")
            )
            if len(out) != frame_size * len(needed):
                raise RuntimeError(f"Se extrajeron {len(out) // frame_size} de {len(needed)} originales")
            position = {n: pos for pos, n in enumerate(needed)}
            for k in CHECK_OFFSETS:
                with open(os.path.join(tmp, f"ref{k}.raw"), "wb") as f:
                    for _, n in samples:
                        pos = position[n + k]
                        f.write(out[pos * frame_size:(pos + 1) * frame_size])

            psnr = {}
            for k in CHECK_OFFSETS:
                stats = os.path.join(tmp, f"psnr{k}.log")
                raw_in = ["-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}"]
                subprocess.run(
                    NICE + ["ffmpeg", "-nostdin", "-v", "error", *raw_in, "-i", enc,
                            *raw_in, "-i", os.path.join(tmp, f"ref{k}.raw"),
                            "-lavfi", f"[0][1]psnr=stats_file={stats}", "-f", "null", "-"],
                    check=True, capture_output=True,
                )
                with open(stats) as f:
                    values = re.findall(r"psnr_y:(\S+)", f.read())
                psnr[k] = [float(v) if v != "inf" else 99.0 for v in values]
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

        rows = []
        for pos, (j, n) in enumerate(samples):
            by_offset = {k: round(psnr[k][pos], 2) for k in CHECK_OFFSETS}
            # En un empate (p. ej. un fotograma en negro entre otros iguales) gana el emparejado
            best = max(CHECK_OFFSETS, key=lambda k: (by_offset[k], k == 0))
            neighbours = max(v for k, v in by_offset.items() if k != 0)
            rows.append({"frame": j, "n": n, "source": n % src["frames"] if src["kind"] == "file" else n, "psnr_db": by_offset,
                         "best_offset": best, "margin_db": round(by_offset[0] - neighbours, 2)})
        return {
            "index": stream["index"],
            "height": stream["height"],
            "samples": rows,
            "best_at_zero": sum(r["best_offset"] == 0 for r in rows),
            "mean_psnr_db": {k: round(sum(r["psnr_db"][k] for r in rows) / len(rows), 2) for k in CHECK_OFFSETS},
            "min_margin_db": min(r["margin_db"] for r in rows),
            "region": {"width": w, "height": h, "x": cx, "y": cy},
        }

    # --- VMAF ---

    @staticmethod
    def _queued(note: Optional[str] = None) -> dict:
        return {"state": "queued", "queued_ms": int(time.time() * 1000), "note": note}

    def enqueue_vmaf(self, rec_id: str):
        meta = self.read(rec_id, "meta.json")
        if not meta or meta.get("state") != "ready":
            raise RuntimeError("La grabación no está indexada")
        if self.computing == rec_id:
            raise RuntimeError("El VMAF de esta grabación se está calculando")
        self.update_meta(rec_id, vmaf=self._queued())

    def vmaf(self, rec_id: str) -> Optional[dict]:
        return self.read(rec_id, "vmaf.json")

    def start_worker(self, idle: Callable[[], bool]):
        """Atiende la cola de VMAF: la grabación más antigua pendiente, solo con la emisión parada."""
        self.idle = idle
        # Lo que estaba calculándose cuando se reinició el orquestador vuelve a la cola
        for meta in self.all():
            if (meta.get("vmaf") or {}).get("state") == "running":
                self.update_meta(meta["id"], vmaf=self._queued("Interrumpido por un reinicio del orquestador"))
        threading.Thread(target=self._worker, daemon=True).start()

    def _worker(self):
        while True:
            time.sleep(VMAF_POLL_S)
            try:
                if not self.idle():
                    continue
                pending = [m for m in self.all() if m.get("state") == "ready" and (m.get("vmaf") or {}).get("state") == "queued"]
                if pending:
                    self._compute_vmaf(min(pending, key=lambda m: m["vmaf"]["queued_ms"])["id"])
            except Exception as e:
                logger.warning(f"QoE: cola de VMAF: {e}")

    def _compute_vmaf(self, rec_id: str):
        self.computing = rec_id
        began = time.time()
        self.update_meta(rec_id, vmaf={"state": "running", "started_ms": int(began * 1000)})
        logger.info(f"QoE: calculando VMAF de {rec_id}")
        try:
            streams = [self._vmaf_stream(rec_id, s) for s in self.index(rec_id)["streams"]]
            src = self.original(rec_id)
            w, h, cx, cy = compare_region(self.read(rec_id, "meta.json")["timecodes"], src["width"], src["height"])
            self.write(rec_id, "vmaf.json", {
                "vmaf_version": vmaf_version(),
                "model": VMAF_MODEL,
                "scaler": VMAF_SCALER,
                "region": {"width": w, "height": h, "x": cx, "y": cy},
                "streams": streams,
            })
            summary = [{k: v for k, v in s.items() if k not in ("vmaf", "psnr_y")} for s in streams]
            self.update_meta(rec_id, vmaf={"state": "done", "elapsed_s": round(time.time() - began, 1), "streams": summary})
            logger.info(f"QoE: VMAF de {rec_id} en {time.time() - began:.0f} s")
            for player in PLAYERS:
                if self.read(rec_id, f"view-{player}.mapped.json") is not None:
                    self._qoe(rec_id, player)
        except Interrupted:
            logger.info(f"QoE: VMAF de {rec_id} interrumpido: la emisión volvió a arrancar")
            self.update_meta(rec_id, vmaf=self._queued("Interrumpido: la emisión volvió a arrancar"))
        except Exception as e:
            logger.warning(f"QoE: VMAF de {rec_id} fallido: {e}")
            self.update_meta(rec_id, vmaf={"state": "error", "error": str(e)})
        finally:
            self.computing = None

    def _vmaf_stream(self, rec_id: str, stream: dict) -> dict:
        """VMAF y PSNR de luma de cada fotograma grabado de una calidad frente a su original.

        Las dos entradas llegan a vmaf por tuberías con nombre, sin pasar por disco (30 s de 1080p en
        crudo son más de 5 GB). Como los fotogramas grabados son consecutivos (lo comprueba el índice),
        el original es un tramo continuo: del vídeo fuente (partido en dos si cruza el final del bucle) o
        de la referencia grabada de la cámara.
        """
        if stream["pts_off_grid"] or stream["not_consecutive"] or stream["timecode_disagree"]:
            raise RuntimeError(f"Calidad {stream['index']}: el índice no es fiable (ver pts_off_grid, not_consecutive y timecode_disagree)")
        src = self._reference_usable(rec_id)
        w, h, cx, cy = compare_region(self.read(rec_id, "meta.json")["timecodes"], src["width"], src["height"])
        crop = f"crop={w}:{h}:{cx}:{cy},format=yuv420p"
        count = len(stream["n"])
        first = stream["n"][0]
        reference_cmds = self._reference_cmd(rec_id, src, list(range(first, first + count)), crop)

        tmp = tempfile.mkdtemp(prefix="vmaf-")
        ref, dist, out = (os.path.join(tmp, name) for name in ("ref.yuv", "dist.yuv", "vmaf.json"))
        os.mkfifo(ref)
        os.mkfifo(dist)
        procs: list[subprocess.Popen] = []
        errors: list[str] = []

        def run(cmd: list[str], **kwargs) -> subprocess.Popen:
            proc = subprocess.Popen(NICE + cmd, stderr=subprocess.PIPE, **kwargs)
            procs.append(proc)
            return proc

        def write_reference():
            try:
                with open(ref, "wb") as fifo:
                    for cmd in reference_cmds:
                        proc = run(cmd, stdout=fifo)
                        if proc.wait() != 0:
                            errors.append(f"original: {proc.stderr.read().decode()[-300:]}")
                            return
            except OSError as e:
                errors.append(f"original: {e}")

        try:
            meter = run(["vmaf", "-r", ref, "-d", dist, "-w", str(w), "-h", str(h), "-p", "420", "-b", "8",
                         "--threads", str(os.cpu_count() or 1), "--model", f"version={VMAF_MODEL}",
                         "--feature", "psnr", "--json", "-o", out, "-q"], stdout=subprocess.DEVNULL)
            decoder = run(["ffmpeg", "-nostdin", "-v", "error", "-i", self.path(rec_id, "stream.ts"),
                           "-map", f"0:v:{stream['index']}", "-frames:v", str(count),
                           "-vf", f"scale={src['width']}:{src['height']}:flags={VMAF_SCALER},{crop}",
                           "-fps_mode", "passthrough", "-f", "rawvideo", "-y", dist], stdout=subprocess.DEVNULL)
            writer = threading.Thread(target=write_reference, daemon=True)
            writer.start()
            while meter.poll() is None:
                if not self.idle():
                    raise Interrupted()
                time.sleep(0.5)
            decoder.wait(timeout=10)
            writer.join(timeout=10)
            if meter.returncode != 0:
                raise RuntimeError(f"vmaf: {meter.stderr.read().decode()[-300:]}")
            if decoder.returncode != 0:
                raise RuntimeError(f"grabación: {decoder.stderr.read().decode()[-300:]}")
            if errors:
                raise RuntimeError(errors[0])
            with open(out) as f:
                frames = json.load(f)["frames"]
        finally:
            for proc in procs:
                if proc.poll() is None:
                    proc.kill()
            # Si vmaf murió antes de abrir el original, quien lo escribe sigue esperando a un lector
            try:
                os.close(os.open(ref, os.O_RDONLY | os.O_NONBLOCK))
            except OSError:
                pass
            shutil.rmtree(tmp, ignore_errors=True)

        if len(frames) != count:
            raise RuntimeError(f"Calidad {stream['index']}: vmaf midió {len(frames)} de {count} fotogramas")
        scores = [round(f["metrics"]["vmaf"], 3) for f in frames]
        psnr = [round(f["metrics"]["psnr_y"], 3) for f in frames]
        return {
            "index": stream["index"],
            "height": stream["height"],
            "first_n": stream["n"][0],
            "frames": count,
            "mean": round(sum(scores) / count, 2),
            "p5": round(percentile(scores, 0.05), 2),
            "min": round(min(scores), 2),
            "psnr_y_mean": round(sum(psnr) / count, 2),
            # Por fotograma, en el orden del índice (el mismo que stream["n"])
            "vmaf": scores,
            "psnr_y": psnr,
        }


recordings = Recordings()
