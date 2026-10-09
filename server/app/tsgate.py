"""Compuerta MPEG-TS: UDP -> stdout, empezando exactamente en un keyframe de vídeo.

Los empaquetadores arrancan en un punto arbitrario de la emisión. Con -c copy FFmpeg descarta el vídeo
hasta el primer IDR pero conserva el audio anterior, así que el vídeo empieza con un desfase aleatorio
de hasta un GOP sobre la rejilla de segmentos del manifiesto DASH y dash.js calcula mal su latencia.
Dejando pasar el flujo solo desde un IDR, audio y vídeo empiezan juntos en ambas ramas.

También vigila los contadores de continuidad: una pérdida en el reparto UDP interno afectaría a una
sola rama, así que se escribe en stderr para que el orquestador la cuente como anomalía de ingesta.

Y anota dos horas por cada frame de vídeo (por PTS) y se las envía al orquestador, para el desglose de
latencia por etapas:

- Cuándo llegó su último paquete al kernel (marca SO_TIMESTAMPNS): es la "salida del codificador", y no
  depende de lo que tarde nadie en leerlo.
- Cuándo lo leyó y reenvió esta compuerta. La compuerta escribe en una tubería y se bloquea si el
  empaquetador no la vacía, así que la diferencia entre ambas horas es lo que el frame esperó a que el
  empaquetador lo aceptara.
"""
import json
import os
import socket
import struct
import sys
import time

TS_PACKET = 188
VIDEO_PID = 0x100  # primer stream del muxer mpegts de FFmpeg
TABLE_PIDS = (0x0000, 0x0011, 0x1000)  # PAT, SDT y PMT del muxer mpegts de FFmpeg
TRACE_ADDR = ("127.0.0.1", 5010)       # orquestador (trace.py)
SO_TIMESTAMPNS = 35                    # Linux: el kernel adjunta a cada datagrama su hora de llegada


def pes_video_pts(data: bytes, offset: int, has_adaptation: int):
    """PTS (90 kHz) si el paquete TS en offset abre un PES de vídeo; None en otro caso."""
    start = offset + 4 + (1 + data[offset + 4] if has_adaptation else 0)
    if start + 14 > offset + TS_PACKET or data[start:start + 3] != b"\x00\x00\x01":
        return None
    if not 0xE0 <= data[start + 3] <= 0xEF or not data[start + 7] & 0x80:
        return None
    b = data[start + 9:start + 14]
    return ((b[0] >> 1) & 0x07) << 30 | b[1] << 22 | (b[2] >> 1) << 15 | b[3] << 7 | b[4] >> 1


def main(port: int, branch: str):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    sock.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMPNS, 1)
    sock.bind(("127.0.0.1", port))
    trace = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    started = False
    tables: dict[int, bytes] = {}
    counters: dict[int, int] = {}
    open_frame: dict[int, int] = {}    # PID de vídeo -> PTS del frame que está llegando
    last_packet: dict[int, tuple] = {}  # PID de vídeo -> (llegada al kernel, lectura aquí) de su último paquete
    first_pts: dict[int, int] = {}
    finished: list = []                 # frames completos pendientes de comunicar: [pid, pts, kernel, lectura]
    last_report = 0.0
    while True:
        data, ancillary, _, _ = sock.recvmsg(65536, 64)
        now = time.time()
        arrived = now
        for level, kind, value in ancillary:
            if level == socket.SOL_SOCKET and kind == SO_TIMESTAMPNS:
                seconds, nanos = struct.unpack("ll", value[:16])
                arrived = seconds + nanos / 1e9
        out = data
        for offset in range(0, len(data) - TS_PACKET + 1, TS_PACKET):
            if data[offset] != 0x47:
                continue
            pid = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2]
            flags = data[offset + 3]
            has_adaptation, has_payload = flags & 0x20, flags & 0x10

            if not started:
                # random_access_indicator en el PID de vídeo: empieza un IDR
                if pid == VIDEO_PID and has_adaptation and data[offset + 4] > 0 and data[offset + 5] & 0x40:
                    # Las tablas van por delante para que el IDR se pueda interpretar nada más llegar
                    started = True
                    out = b"".join(tables.values()) + data[offset:]
                else:
                    if pid in TABLE_PIDS:
                        tables[pid] = data[offset:offset + TS_PACKET]
                    continue

            if has_payload and pid != 0x1FFF:
                expected = counters.get(pid)
                counter = flags & 0x0F
                if expected is not None and counter != expected:
                    print(f"continuity check failed: pid={pid} expected={expected} got={counter}", file=sys.stderr, flush=True)
                counters[pid] = (counter + 1) & 0x0F

                # Un frame termina de llegar con el último paquete anterior al que abre el siguiente PES
                if data[offset + 1] & 0x40:
                    pts = pes_video_pts(data, offset, has_adaptation)
                    if pts is not None:
                        if pid in open_frame:
                            finished.append([pid, open_frame[pid], *last_packet[pid]])
                        open_frame[pid] = pts
                        first_pts.setdefault(pid, pts)
                if pid in open_frame:
                    last_packet[pid] = (arrived, now)

        if started:
            os.write(1, out)
            if finished and now - last_report >= 0.1:
                try:
                    trace.sendto(json.dumps({"b": branch, "first": first_pts, "frames": finished}).encode(), TRACE_ADDR)
                except OSError:
                    pass
                finished = []
                last_report = now


if __name__ == "__main__":
    try:
        main(int(sys.argv[1]), sys.argv[2])
    except (BrokenPipeError, KeyboardInterrupt):
        pass
