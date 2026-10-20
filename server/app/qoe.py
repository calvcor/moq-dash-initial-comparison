"""Evaluación de QoE, fase a: grabación del flujo codificado y emparejamiento con el original.

Para calcular VMAF sin grabar nada en el navegador ni recodificar, el servidor guarda durante la prueba
el flujo que sale del codificador (el mismo que reparten las tres ramas, que no recodifican) y lo indexa:

1. Lee el timecode quemado en cada fotograma grabado, con la misma lectura que hace el navegador.
2. Pasa de timecode a número de frame con las marcas que FFmpeg escribe en su log al quemarlo (trace.py).
   Se copian mientras dura la grabación, porque trace.py solo recuerda el último minuto.
3. El número de frame, módulo los frames del vídeo original, es el fotograma de Big Buck Bunny del que
   viene: la fuente lo numera en orden de decodificación, sin saltos ni repeticiones (setpts=N), y vuelve
   a empezar en cada vuelta del bucle.

Con el registro de qué timecode mostró el navegador y cuándo (fase c), se podrá reconstruir lo que vio
el espectador y compararlo con el original. La comprobación (check) mide por PSNR que el emparejamiento
es correcto: el fotograma emparejado debe parecerse al codificado más que cualquiera de sus vecinos.

Todo el trabajo pesado (decodificar, escalar, comparar) va en procesos de FFmpeg con nice 19 y después
de grabar, para no quitarle CPU al codificador en directo.
"""
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from typing import Callable, Optional

from pydantic import BaseModel, Field

from . import trace
from .source import VIDEO_FILE

logger = logging.getLogger("orchestrator")

QOE_DIR = os.path.join(os.path.dirname(VIDEO_FILE), "qoe")
RECORDER = os.path.join(os.path.dirname(__file__), "recorder.py")
RECORD_PORT = 5004       # cuarta salida del tee de la fuente (main.py)
KEEP_RECORDINGS = 10     # se borran las más antiguas
STAMP_TOLERANCE_MS = 4   # el timecode va en ms enteros y cada bit lee el reloj por separado (ver trace.py)
NICE = ["nice", "-n", "19"]
REC_ID = re.compile(r"^\d{8}-\d{6}$")
SHOWINFO = re.compile(r"\bn:\s*(\d+)\s+pts:\s*(-?\d+)")

# Comprobación del emparejamiento: PSNR frente al original emparejado y a sus vecinos
CHECK_OFFSETS = (-2, -1, 0, 1, 2)
CHECK_SAMPLES = 20


class RecordingRequest(BaseModel):
    duration_s: float = Field(..., ge=5, le=300, description="Segundos que se graban desde el primer keyframe")


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
        self.active: Optional[str] = None
        self.checking: set[str] = set()

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

    def index(self, rec_id: str) -> Optional[dict]:
        return self.read(rec_id, "index.json")

    def prune(self):
        ids = sorted(d for d in os.listdir(QOE_DIR) if REC_ID.match(d))
        for old in ids[:-KEEP_RECORDINGS]:
            if old != self.active and old not in self.checking:
                shutil.rmtree(os.path.join(QOE_DIR, old), ignore_errors=True)

    # --- grabación ---

    def start(self, duration_s: float, context: dict, master_start_ms: Callable[[], int]) -> dict:
        """Empieza a grabar. context: calidades, timecodes y cadencia de la emisión en curso."""
        with self.lock:
            if self.active:
                raise RuntimeError(f"Ya hay una grabación en curso ({self.active})")
            rec_id = time.strftime("%Y%m%d-%H%M%S")
            os.makedirs(self.path(rec_id), exist_ok=True)
            meta = {"id": rec_id, "state": "recording", "error": None, "duration_s": duration_s,
                    "created_ms": int(time.time() * 1000), **context}
            self.write(rec_id, "meta.json", meta)
            self.active = rec_id
        threading.Thread(target=self._run, args=(rec_id, duration_s, master_start_ms), daemon=True).start()
        return meta

    def _run(self, rec_id: str, duration_s: float, master_start_ms: Callable[[], int]):
        try:
            started_ms, stamps = self._record(rec_id, duration_s, master_start_ms)
            self.update_meta(rec_id, state="indexing", started_ms=started_ms)
            summary = self._build_index(rec_id, stamps)
            self.update_meta(rec_id, state="ready", streams=summary)
            logger.info(f"QoE: grabación {rec_id} indexada: {summary}")
        except Exception as e:
            logger.warning(f"QoE: grabación {rec_id} fallida: {e}")
            self.update_meta(rec_id, state="error", error=str(e))
        finally:
            with self.lock:
                self.active = None
            self.prune()

    def _record(self, rec_id: str, duration_s: float, master_start_ms: Callable[[], int]):
        master = master_start_ms()
        since_ms = time.time() * 1000 - 1000
        stamps: dict[str, dict[int, float]] = {}

        def collect():
            for stream, pairs in trace.frame_log.stamps_since(since_ms).items():
                known = stamps.setdefault(str(stream), {})
                for mark, number in pairs:
                    known[number] = mark

        proc = subprocess.Popen(
            ["python3", "-u", RECORDER, str(RECORD_PORT), self.path(rec_id, "stream.ts"), str(duration_s)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        deadline = time.time() + duration_s + 15
        while proc.poll() is None:
            collect()
            if master_start_ms() != master:
                proc.kill()
                raise RuntimeError("La fuente se reinició durante la grabación")
            if time.time() > deadline:
                proc.kill()
                raise RuntimeError("No llegó el flujo de la fuente: ¿está la emisión en marcha?")
            time.sleep(0.5)
        collect()
        output = proc.stdout.read()
        found = re.search(r"started (\d+)", output)
        if proc.returncode != 0 or not found:
            raise RuntimeError(f"El grabador terminó con código {proc.returncode}: {output.strip()[-300:]}")
        self.write(rec_id, "stamps.json", {s: sorted(d.items()) for s, d in stamps.items()})
        return int(found.group(1)), {s: sorted(d.items()) for s, d in stamps.items()}

    # --- índice ---

    def _build_index(self, rec_id: str, stamps: dict) -> list[dict]:
        meta = self.read(rec_id, "meta.json")
        src = source_info()
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

            # Timecode -> (marca, número de frame) de esta calidad, por ms módulo 2^bits
            span = 2 ** layout["bits"]
            by_code: dict[int, list] = {}
            for number, mark in stamps.get(str(i), []):
                by_code.setdefault(int(mark) % span, []).append((mark, number))

            codes, numbers = [], []
            for j in range(len(pts)):
                code = decode_strip(data[j * size:(j + 1) * size], width, layout)
                codes.append(code)
                best = None
                if code is not None:
                    for d in range(-STAMP_TOLERANCE_MS, STAMP_TOLERANCE_MS + 1):
                        for mark, number in by_code.get((code + d) % span, []):
                            if best is None or abs(d) < best[0]:
                                best = (abs(d), number)
                numbers.append(best[1] if best else None)

            # Comprobación cruzada: la fuente pone PTS = n / fps exactos, así que entre dos frames
            # emparejados la diferencia de PTS debe ser la de número de frame por la duración de uno
            matched = [(j, pts[j], numbers[j]) for j in range(len(pts)) if numbers[j] is not None]
            pts_mismatch = not_consecutive = 0
            if matched:
                j0, p0, n0 = matched[0]
                for (ja, pa, na), (jb, pb, nb) in zip(matched, matched[1:]):
                    if nb - na != jb - ja:
                        not_consecutive += 1
                for j, p, n in matched:
                    if p - p0 != (n - n0) * ticks:
                        pts_mismatch += 1
            first_n = matched[0][2] if matched else None
            last_n = matched[-1][2] if matched else None
            stream_summary = {
                "index": i,
                "width": layout["width"],
                "height": layout["height"],
                "frames": len(pts),
                "timecode_read": sum(c is not None for c in codes),
                "matched": len(matched),
                # Deberían ser 0: frames emparejados con un número que no encaja con su PTS o con su posición
                "pts_mismatch": pts_mismatch,
                "not_consecutive": not_consecutive,
                "first_n": first_n,
                "last_n": last_n,
                "source_first": first_n % src["frames"] if first_n is not None else None,
                "source_last": last_n % src["frames"] if last_n is not None else None,
                "loop_wraps": (last_n // src["frames"] - first_n // src["frames"]) if matched else 0,
            }
            summary.append(stream_summary)
            streams.append({**stream_summary, "pts": pts, "timecode": codes, "n": numbers})
        self.write(rec_id, "index.json", {"source": src, "streams": streams})
        return summary

    # --- comprobación del emparejamiento ---

    def start_check(self, rec_id: str):
        meta = self.read(rec_id, "meta.json")
        if not meta or meta.get("state") != "ready":
            raise RuntimeError("La grabación no está indexada")
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
        src = source_info()
        layouts = self.read(rec_id, "meta.json")["timecodes"]
        w, h, cx, cy = compare_region(layouts, src["width"], src["height"])
        frame_size = w * h
        reach = max(abs(k) for k in CHECK_OFFSETS)
        candidates = [
            (j, n) for j, n in enumerate(stream["n"])
            if n is not None and reach <= n % src["frames"] < src["frames"] - reach
        ]
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

            # Originales: para cada muestra, los frames n-2..n+2 del vídeo fuente. Con -ss delante de
            # -i FFmpeg descarta lo anterior a esa hora absoluta; el frame k está en start_time + k/fps.
            refs = {k: open(os.path.join(tmp, f"ref{k}.raw"), "wb") for k in CHECK_OFFSETS}
            try:
                for _, n in samples:
                    first = n % src["frames"] - reach
                    seek = src["start_time"] + first / src["fps"] - 0.25 / src["fps"]
                    out = subprocess.run(
                        NICE + ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{seek:.6f}", "-i", VIDEO_FILE,
                                "-map", "0:v:0", "-frames:v", str(len(CHECK_OFFSETS)),
                                "-vf", f"crop={w}:{h}:{cx}:{cy},format=gray", "-f", "rawvideo", "-"],
                        check=True, capture_output=True,
                    ).stdout
                    if len(out) != frame_size * len(CHECK_OFFSETS):
                        raise RuntimeError(f"No se extrajeron los originales alrededor del frame {n % src['frames']}")
                    for pos, k in enumerate(CHECK_OFFSETS):
                        refs[k].write(out[pos * frame_size:(pos + 1) * frame_size])
            finally:
                for f in refs.values():
                    f.close()

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
            rows.append({"frame": j, "n": n, "source": n % src["frames"], "psnr_db": by_offset,
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


recordings = Recordings()
