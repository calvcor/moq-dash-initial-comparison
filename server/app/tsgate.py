"""Compuerta MPEG-TS: UDP -> stdout (o -> UDP), empezando exactamente en un keyframe de vídeo.

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

Con --udp HOST:PORT la salida va por UDP, en datagramas de hasta 7 paquetes, en vez de a stdout: así lee
MediaMTX el flujo de WebRTC sin un FFmpeg intermedio. MediaMTX no puede elegir pistas, así que con
--first-video la compuerta deja pasar solo el primer vídeo (la calidad más alta) y, con --audio, también el
audio, y rehace la PMT para que anuncie solo esas pistas: MediaMTX espera datos de cada pista que anuncia.
Es lo mismo que hacía el FFmpeg intermedio con -map; los paquetes de esas pistas pasan sin tocar.
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
PMT_PID = 0x1000
VIDEO_STREAM_TYPES = {0x01, 0x02, 0x10, 0x1B, 0x24, 0x33}  # MPEG-1/2, MPEG-4, H.264, H.265, H.266
UDP_PACKETS = 7                        # paquetes TS por datagrama: 1316 bytes, el tamaño habitual
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


def crc32_mpeg(data: bytes) -> int:
    """CRC-32/MPEG-2, el de las tablas PSI."""
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) if crc & 0x80000000 else crc << 1
            crc &= 0xFFFFFFFF
    return crc


def filter_pmt(packet: bytes, keep_audio: bool):
    """PMT de un solo paquete reducida al primer vídeo (y al resto de pistas, con keep_audio).

    Devuelve (paquete nuevo, PIDs que conserva, PID del PCR), o None si el paquete no es una PMT completa.
    """
    if not packet[1] & 0x40:
        return None
    start = 4 + (1 + packet[4] if packet[3] & 0x20 else 0)
    p = start + 1 + packet[start]  # campo puntero
    if packet[p] != 0x02:
        return None
    section_length = ((packet[p + 1] & 0x0F) << 8) | packet[p + 2]
    end = p + 3 + section_length  # incluye el CRC
    if end > len(packet):
        return None  # PMT repartida en varios paquetes: no se da con el muxer de FFmpeg
    pcr_pid = ((packet[p + 8] & 0x1F) << 8) | packet[p + 9]
    info_length = ((packet[p + 10] & 0x0F) << 8) | packet[p + 11]
    entries, i = [], p + 12 + info_length
    while i < end - 4:
        info = ((packet[i + 3] & 0x0F) << 8) | packet[i + 4]
        entries.append((packet[i], ((packet[i + 1] & 0x1F) << 8) | packet[i + 2], packet[i:i + 5 + info]))
        i += 5 + info
    videos = [e for e in entries if e[0] in VIDEO_STREAM_TYPES]
    if not videos:
        return None
    kept = [videos[0]] + ([e for e in entries if e[0] not in VIDEO_STREAM_TYPES] if keep_audio else [])
    body = packet[p + 3:p + 12 + info_length] + b"".join(e[2] for e in kept)
    length = len(body) + 4
    section = bytes([packet[p], (packet[p + 1] & 0xF0) | (length >> 8), length & 0xFF]) + body
    section += crc32_mpeg(section).to_bytes(4, "big")
    new = packet[:p] + section
    return new + b"\xff" * (TS_PACKET - len(new)), {e[1] for e in kept}, pcr_pid


def main(port: int, branch: str, udp_target=None, first_video=False, keep_audio=False):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    sock.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMPNS, 1)
    sock.bind(("127.0.0.1", port))
    trace = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    output = socket.socket(socket.AF_INET, socket.SOCK_DGRAM) if udp_target else None
    pmt_cache: dict[bytes, tuple] = {}  # PMT original -> (PMT reducida, PIDs que conserva)
    allowed = {0x0000, 0x0011, PMT_PID, VIDEO_PID}  # PIDs que pasan con --first-video, hasta leer la PMT
    warned_pcr = False

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
        kept_packets: list[bytes] = []  # con --first-video: lo que sale de este datagrama
        for offset in range(0, len(data) - TS_PACKET + 1, TS_PACKET):
            if data[offset] != 0x47:
                continue
            pid = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2]
            flags = data[offset + 3]
            has_adaptation, has_payload = flags & 0x20, flags & 0x10

            packet = data[offset:offset + TS_PACKET]
            if first_video and pid == PMT_PID:
                if packet not in pmt_cache:
                    reduced = filter_pmt(packet, keep_audio)
                    if reduced:
                        new_packet, pids, pcr_pid = reduced
                        pmt_cache[packet] = (new_packet, pids)
                        if pcr_pid not in pids and not warned_pcr:
                            print(f"aviso: el PCR va en el PID {pcr_pid}, que no se reenvía", file=sys.stderr, flush=True)
                            warned_pcr = True
                if packet in pmt_cache:
                    packet, pids = pmt_cache[packet]
                    allowed = {0x0000, 0x0011, PMT_PID} | pids

            if not started:
                # random_access_indicator en el PID de vídeo: empieza un IDR
                if pid == VIDEO_PID and has_adaptation and data[offset + 4] > 0 and data[offset + 5] & 0x40:
                    # Las tablas van por delante para que el IDR se pueda interpretar nada más llegar
                    started = True
                    out = b"".join(tables.values()) + data[offset:]
                    kept_packets.extend(tables.values())
                else:
                    if pid in TABLE_PIDS:
                        tables[pid] = packet
                    continue

            if first_video and pid in allowed:
                kept_packets.append(packet)

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
            if first_video:
                out = b"".join(kept_packets)
            if output:
                step = UDP_PACKETS * TS_PACKET
                for i in range(0, len(out), step):
                    output.sendto(out[i:i + step], udp_target)
            elif out:
                os.write(1, out)
            if finished and now - last_report >= 0.1:
                try:
                    trace.sendto(json.dumps({"b": branch, "first": first_pts, "frames": finished}).encode(), TRACE_ADDR)
                except OSError:
                    pass
                finished = []
                last_report = now


if __name__ == "__main__":
    args = sys.argv[3:]
    target = None
    if "--udp" in args:
        host, _, udp_port = args[args.index("--udp") + 1].rpartition(":")
        target = (host, int(udp_port))
    try:
        main(int(sys.argv[1]), sys.argv[2], target, "--first-video" in args, "--audio" in args)
    except (BrokenPipeError, KeyboardInterrupt):
        pass
