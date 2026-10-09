"""Registro de por dónde pasa cada frame y a qué hora, para desglosar la latencia por etapas.

Un frame se identifica por la marca de tiempo que lleva quemada, que es lo único que el dashboard puede
leer igual en los dos reproductores. Aquí se guarda:

- De la fuente: qué número de frame y de qué calidad recibió cada marca (lo escribe FFmpeg en su log).
- De cada compuerta (tsgate.py): a qué hora terminó de llegarle cada frame de vídeo, por PTS, y a qué
  hora lo reenvió al empaquetador.

El PTS de un frame es el del frame 0 más su número por la duración de un frame. El PTS del frame 0 se
conoce porque las compuertas se arrancan antes que la fuente y lo ven pasar. Con esto y con lo que anota
el origen DASH se sabe cuánto tardó un frame concreto en cada tramo, sin estimar nada.
"""
import bisect
import json
import logging
import socket
import threading

logger = logging.getLogger("orchestrator")

TRACE_PORT = 5010
FIRST_VIDEO_PID = 0x100  # el stream i de la escalera viaja en el PID 0x100 + i
KEEP = 3600              # frames por calidad que se recuerdan (60 s a 60 fps)
PTS_TOLERANCE = 750      # medio frame a 60 fps, en ticks de 90 kHz


class FrameLog:
    def __init__(self):
        self.lock = threading.Lock()
        self.frames = {"dash": {}, "moq": {}, "rtc": {}}     # rama -> stream -> ([pts...], [(llegada, reenvío)...])
        self.first_pts = {"dash": {}, "moq": {}, "rtc": {}}  # rama -> stream -> PTS del primer frame que dejó pasar la compuerta
        self.stamps = {}    # stream -> ([marca ms...], [número de frame...])
        self.pts_base = {}  # stream -> PTS del frame 0 de la fuente actual

    def master_restarted(self):
        with self.lock:
            self.stamps = {}
            self.pts_base = {}

    def add_stamp(self, stream: int, number: int, stamp_ms: float):
        with self.lock:
            marks, numbers = self.stamps.setdefault(stream, ([], []))
            if numbers and number <= numbers[-1]:
                return  # FFmpeg evalúa la expresión más de una vez por frame: vale la primera
            marks.append(stamp_ms)
            numbers.append(number)
            if len(marks) > KEEP + 600:
                del marks[:600], numbers[:600]

    def frame_for_stamp(self, stream: int, stamp_ms: float):
        """(número de frame, marca exacta) del frame de esa calidad que lleva esa marca, o None."""
        with self.lock:
            marks, numbers = self.stamps.get(stream, ([], []))
            i = bisect.bisect_left(marks, stamp_ms)
            best = min((j for j in (i - 1, i) if 0 <= j < len(marks)), key=lambda j: abs(marks[j] - stamp_ms), default=None)
            # El timecode quemado va en ms enteros y puede diferir 1 ms de la marca registrada
            if best is not None and abs(marks[best] - stamp_ms) <= 4:
                return numbers[best], marks[best]
        return None

    def reset(self, branch: str):
        with self.lock:
            self.frames[branch] = {}
            self.first_pts[branch] = {}

    def add(self, message: dict):
        branch = message["b"]
        with self.lock:
            for pid, pts in message["first"].items():
                self.first_pts[branch].setdefault(int(pid) - FIRST_VIDEO_PID, pts)
                # Solo cuenta como frame 0 si aún no hay referencia: se borra al reiniciar la fuente
                self.pts_base.setdefault(int(pid) - FIRST_VIDEO_PID, pts)
            for pid, pts, arrived, forwarded in message["frames"]:
                keys, times = self.frames[branch].setdefault(pid - FIRST_VIDEO_PID, ([], []))
                if keys and pts <= keys[-1]:
                    continue  # fuera de orden: no debería ocurrir sin frames B
                keys.append(pts)
                times.append((arrived, forwarded))
                if len(keys) > KEEP + 600:
                    del keys[:600], times[:600]

    def lookup(self, branch: str, stream: int, pts: int):
        """(llegada al kernel, reenvío al empaquetador) del frame con ese PTS en esa compuerta, epoch en s."""
        with self.lock:
            keys, times = self.frames[branch].get(stream, ([], []))
            i = bisect.bisect_left(keys, pts - PTS_TOLERANCE)
            if i < len(keys) and abs(keys[i] - pts) <= PTS_TOLERANCE:
                return times[i]
        return None


frame_log = FrameLog()


def listen():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", TRACE_PORT))
    while True:
        try:
            frame_log.add(json.loads(sock.recv(65536)))
        except Exception as e:
            logger.warning(f"Traza de frames: mensaje ilegible ({e})")
