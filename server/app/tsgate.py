"""Compuerta MPEG-TS: UDP -> stdout, empezando exactamente en un keyframe de vídeo.

Los empaquetadores arrancan en un punto arbitrario de la emisión. Con -c copy FFmpeg descarta el vídeo
hasta el primer IDR pero conserva el audio anterior, así que el vídeo empieza con un desfase aleatorio
de hasta un GOP sobre la rejilla de segmentos del manifiesto DASH y dash.js calcula mal su latencia.
Dejando pasar el flujo solo desde un IDR, audio y vídeo empiezan juntos en ambas ramas.

También vigila los contadores de continuidad: una pérdida en el reparto UDP interno afectaría a una
sola rama, así que se escribe en stderr para que el orquestador la cuente como anomalía de ingesta.
"""
import os
import socket
import sys

TS_PACKET = 188
VIDEO_PID = 0x100  # primer stream del muxer mpegts de FFmpeg
TABLE_PIDS = (0x0000, 0x0011, 0x1000)  # PAT, SDT y PMT del muxer mpegts de FFmpeg


def main(port: int):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    sock.bind(("127.0.0.1", port))

    started = False
    tables: dict[int, bytes] = {}
    counters: dict[int, int] = {}
    while True:
        data = sock.recv(65536)
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
                    data = b"".join(tables.values()) + data[offset:]
                    break
                if pid in TABLE_PIDS:
                    tables[pid] = data[offset:offset + TS_PACKET]
                continue

            if has_payload and pid != 0x1FFF:
                expected = counters.get(pid)
                counter = flags & 0x0F
                if expected is not None and counter != expected:
                    print(f"continuity check failed: pid={pid} expected={expected} got={counter}", file=sys.stderr, flush=True)
                counters[pid] = (counter + 1) & 0x0F

        if started:
            os.write(1, data)


if __name__ == "__main__":
    try:
        main(int(sys.argv[1]))
    except (BrokenPipeError, KeyboardInterrupt):
        pass
