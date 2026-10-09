"""Origen LL-DASH en memoria.

FFmpeg publica aquí por HTTP PUT con chunked transfer y cada segmento se sirve a los clientes
mientras todavía se está escribiendo, fragmento CMAF a fragmento. Escribiendo a disco FFmpeg solo
expone el segmento al renombrarlo una vez completo, lo que anula la baja latencia.
"""
import asyncio
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
    first = True
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            if first:
                origin.on_first_data(name, time.time())
                first = False
            origin.last_activity = time.time()
            await live.append(chunk)
    finally:
        await live.append(None)
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
