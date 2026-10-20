"""Grabador MPEG-TS: UDP -> fichero, desde un keyframe y durante un tiempo fijo.

Guarda tal cual el flujo que sale del codificador (todas las calidades), el mismo que reciben las tres
ramas, para reconstruir después en el servidor lo que vio el espectador sin grabar nada en el navegador
(ver qoe.py). Escucha en su propio puerto del tee de la fuente: no toca a las compuertas ni a los
empaquetadores.

Uso: recorder.py <puerto> <fichero> <segundos>
"""
import socket
import sys
import time

TS_PACKET = 188
VIDEO_PID = 0x100  # primer stream del muxer mpegts de FFmpeg
TABLE_PIDS = (0x0000, 0x0011, 0x1000)  # PAT, SDT y PMT


def main(port: int, path: str, seconds: float):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    sock.bind(("127.0.0.1", port))
    sock.settimeout(1.0)

    started_at = None
    tables: dict[int, bytes] = {}
    with open(path, "wb") as out:
        while started_at is None or time.time() - started_at < seconds:
            try:
                data = sock.recv(65536)
            except socket.timeout:
                continue
            if started_at is None:
                # Igual que la compuerta: se empieza en un IDR de la primera calidad, con las tablas delante
                for offset in range(0, len(data) - TS_PACKET + 1, TS_PACKET):
                    pid = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2]
                    flags = data[offset + 3]
                    if pid == VIDEO_PID and flags & 0x20 and data[offset + 4] > 0 and data[offset + 5] & 0x40:
                        started_at = time.time()
                        out.write(b"".join(tables.values()) + data[offset:])
                        print(f"started {started_at * 1000:.0f}", flush=True)
                        break
                    if pid in TABLE_PIDS:
                        tables[pid] = data[offset:offset + TS_PACKET]
                continue
            out.write(data)


if __name__ == "__main__":
    try:
        main(int(sys.argv[1]), sys.argv[2], float(sys.argv[3]))
    except KeyboardInterrupt:
        pass
