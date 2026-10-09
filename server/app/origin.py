"""Origen LL-DASH en memoria.

FFmpeg publica aquí por HTTP PUT con chunked transfer y cada segmento se sirve a los clientes
mientras todavía se está escribiendo, fragmento CMAF a fragmento. Escribiendo a disco FFmpeg solo
expone el segmento al renombrarlo una vez completo, lo que anula la baja latencia.
"""
import asyncio
import bisect
import logging
import math
import re
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse

logger = logging.getLogger("orchestrator")
router = APIRouter()

MIME = {"mpd": "application/dash+xml", "m4s": "video/mp4"}
SEGMENT_RE = re.compile(r"chunk-stream(\d+)-(\d+)\.m4s$")
INIT_RE = re.compile(r"init-stream(\d+)\.m4s$")
AST_RE = re.compile(rb'availabilityStartTime="[^"]*"')


class LiveFile:
    def __init__(self):
        self.chunks: list[bytes] = []
        self.done = False
        self.cond = asyncio.Condition()

    async def append(self, chunk: Optional[bytes]):
        async with self.cond:
            if chunk is None:
                self.done = True
            else:
                self.chunks.append(chunk)
            self.cond.notify_all()

    async def stream(self):
        sent = 0
        while True:
            async with self.cond:
                await self.cond.wait_for(lambda: len(self.chunks) > sent or self.done)
                pending, finished = self.chunks[sent:], self.done
            for chunk in pending:
                yield chunk
            sent += len(pending)
            if finished:
                return


class FragmentParser:
    """Sigue las cajas ISO BMFF de un segmento según llega y avisa cuando cada fragmento CMAF está completo.

    Un fragmento es moof + mdat; su tiempo de medios es el baseMediaDecodeTime (tfdt) del moof. El mdat no
    se guarda: solo se cuenta hasta dónde llega.
    """

    def __init__(self, on_fragment):
        self.on_fragment = on_fragment
        self.buffer = b""
        self.mdat_left = 0
        self.tfdt = None

    def feed(self, chunk: bytes, now: float):
        if self.mdat_left:
            used = min(self.mdat_left, len(chunk))
            self.mdat_left -= used
            chunk = chunk[used:]
            if self.mdat_left:
                return
            self.complete(now)
        self.buffer += chunk
        while len(self.buffer) >= 8:
            size, kind = int.from_bytes(self.buffer[:4], "big"), self.buffer[4:8]
            if size < 8:
                self.buffer = b""  # caja que no se sabe interpretar: se deja de seguir este segmento
                return
            if kind == b"mdat":
                if len(self.buffer) < size:
                    self.mdat_left = size - len(self.buffer)
                    self.buffer = b""
                    return
                self.buffer = self.buffer[size:]
                self.complete(now)
                continue
            if len(self.buffer) < size:
                return
            if kind == b"moof":
                at = self.buffer.find(b"tfdt", 0, size)
                if at >= 0:
                    wide = self.buffer[at + 4] == 1
                    self.tfdt = int.from_bytes(self.buffer[at + 8:at + (16 if wide else 12)], "big")
            self.buffer = self.buffer[size:]

    def complete(self, now: float):
        if self.tfdt is not None:
            self.on_fragment(self.tfdt, now)
            self.tfdt = None


class Origin:
    def __init__(self):
        self.reset(2.0, 1.5)

    def reset(self, seg_duration: float, probe_s: float):
        self.files: dict[str, LiveFile] = {}
        self.seg = seg_duration
        # El sondeo de entrada se vuelca en ráfaga al arrancar: se calibra con un segmento ya en régimen
        self.calibration_segment = math.ceil((probe_s + 2.0) / seg_duration) + 1
        self.streams: set[int] = set()
        self.estimates: dict[int, float] = {}
        self.ast: Optional[float] = None
        self.drift_ms: Optional[float] = None
        self.last_activity = time.time()  # última escritura de FFmpeg, para detectar un empaquetador colgado
        # Para el desglose de latencia: cuándo quedó completo en el origen cada fragmento de cada calidad
        self.timescale: dict[int, int] = {}
        self.first_media_time: dict[int, float] = {}  # tiempo de medios del primer frame de cada calidad
        self.fragments: dict[int, tuple[list, list]] = {}  # stream -> ([tiempo de medios...], [hora...])

    def on_init(self, stream: int, body: bytes):
        at = body.find(b"mdhd")
        if at >= 0:
            wide = body[at + 4] == 1
            start = at + 8 + (16 if wide else 8)
            self.timescale[stream] = int.from_bytes(body[start:start + 4], "big")

    def on_fragment(self, stream: int, tfdt: int, now: float):
        timescale = self.timescale.get(stream)
        if not timescale:
            return
        media_time = tfdt / timescale
        self.first_media_time.setdefault(stream, media_time)
        starts, times = self.fragments.setdefault(stream, ([], []))
        starts.append(media_time)
        times.append(now)
        if len(starts) > 1500:
            del starts[:500], times[:500]

    def fragment_time(self, stream: int, media_time: float):
        """Hora (epoch, s) a la que quedó completo en el origen el fragmento que contiene ese instante."""
        starts, times = self.fragments.get(stream, ([], []))
        i = bisect.bisect_right(starts, media_time + 1e-4) - 1
        # El último de la lista puede no ser aún el que lo contiene: hace falta ver empezar el siguiente
        if 0 <= i < len(starts) - 1:
            return times[i]
        return None

    def on_first_data(self, name: str, now: float):
        """FFmpeg abre el segmento n (caja styp) al recibir su primer frame, en (n-1)*seg de tiempo de medios.

        De ahí sale el availabilityStartTime real: el que escribe FFmpeg es la hora de su primera
        escritura, retrasada por el sondeo de entrada, y dash.js lo reproduciría de más sin contarlo.
        El primer fragmento llega un frag_duration después, que es justo lo que anuncia availabilityTimeOffset.
        """
        match = SEGMENT_RE.search(name)
        if not match:
            return
        stream, number = int(match.group(1)), int(match.group(2))
        self.streams.add(stream)
        estimate = now - (number - 1) * self.seg
        if self.ast is not None:
            # Deriva del ritmo de la fuente respecto al calendario de disponibilidad anunciado
            self.drift_ms = round((estimate - self.ast) * 1000, 1)
        elif number >= self.calibration_segment:
            self.estimates.setdefault(stream, estimate)
            if set(self.estimates) == self.streams:
                self.ast = max(self.estimates.values())
                logger.info(f"availabilityStartTime calibrado: {self.format_ast()}")

    def format_ast(self) -> str:
        return datetime.fromtimestamp(self.ast, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


origin = Origin()


@router.put("/media/dash/{name}")
async def put_file(name: str, request: Request):
    if name.endswith(".mpd"):
        # El manifiesto se sustituye de una vez: nunca se sirve a medio escribir
        manifest = LiveFile()
        manifest.chunks = [await request.body()]
        manifest.done = True
        origin.files[name] = manifest
        return Response(status_code=201)

    live = LiveFile()
    origin.files[name] = live
    segment = SEGMENT_RE.search(name)
    init = INIT_RE.search(name)
    if segment:
        stream = int(segment.group(1))
        parser = FragmentParser(lambda tfdt, now: origin.on_fragment(stream, tfdt, now))
    first = True
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            now = time.time()
            if first:
                origin.on_first_data(name, now)
                first = False
            origin.last_activity = now
            if segment:
                parser.feed(chunk, now)
            await live.append(chunk)
    finally:
        await live.append(None)
    if init:
        origin.on_init(int(init.group(1)), b"".join(live.chunks))
    return Response(status_code=201)


@router.delete("/media/dash/{name}")
async def delete_file(name: str):
    origin.files.pop(name, None)
    return Response(status_code=204)


@router.api_route("/media/dash/{name}", methods=["GET", "HEAD"])
async def get_file(name: str, request: Request):
    live = origin.files.get(name)
    is_manifest = name.endswith(".mpd")
    # El manifiesto no se publica hasta tener calibrado el availabilityStartTime
    if live is None or (is_manifest and origin.ast is None):
        return Response(status_code=404)

    headers = {"Cache-Control": "no-cache, no-store, must-revalidate" if is_manifest else "max-age=5"}
    media_type = MIME.get(name.rsplit(".", 1)[-1], "application/octet-stream")
    if request.method == "HEAD":
        return Response(headers=headers, media_type=media_type)
    if is_manifest:
        body = AST_RE.sub(f'availabilityStartTime="{origin.format_ast()}"'.encode(), live.chunks[0])
        return Response(body, headers=headers, media_type=media_type)
    if live.done:
        return Response(b"".join(live.chunks), headers=headers, media_type=media_type)
    return StreamingResponse(live.stream(), headers=headers, media_type=media_type)
