"""Vídeo fuente del testbed: Big Buck Bunny 1080p60 (Blender Foundation, CC BY 3.0).

No se distribuye con el repositorio. Si falta, se descarga de la web de Blender al arrancar.
"""
import logging
import os
import shutil
import zipfile

import requests

logger = logging.getLogger("orchestrator")

VIDEO_URL = os.getenv(
    "VIDEO_URL", "https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_60fps_normal.mp4.zip"
)
VIDEO_FILE = os.getenv("VIDEO_FILE", "/data/bbb_sunflower_1080p_60fps_normal.mp4")

# Lo que ve el dashboard mientras se prepara: ready | downloading | extracting | error
state = {"state": "downloading", "progress_pct": 0, "error": None}


def fetch_video(dest: str = VIDEO_FILE):
    """Deja el vídeo en dest, descargándolo y descomprimiéndolo si no está. Lanza excepción si falla."""
    if os.path.exists(dest):
        state.update(state="ready", progress_pct=100, error=None)
        return

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    archive = dest + ".zip.part"
    logger.info(f"Vídeo fuente no encontrado; descargando {VIDEO_URL}")
    state.update(state="downloading", progress_pct=0, error=None)
    with requests.get(VIDEO_URL, stream=True, timeout=30) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length", 0))
        done = 0
        with open(archive, "wb") as out:
            for chunk in response.iter_content(chunk_size=1 << 20):
                out.write(chunk)
                done += len(chunk)
                if total:
                    state["progress_pct"] = int(done * 100 / total)

    # El .zip trae un único .mp4; se escribe con otro nombre y se renombra al final para no dejar
    # un fichero a medias que parezca válido si el proceso se interrumpe.
    state.update(state="extracting")
    with zipfile.ZipFile(archive) as bundle:
        member = next(name for name in bundle.namelist() if name.lower().endswith(".mp4"))
        with bundle.open(member) as src, open(dest + ".part", "wb") as out:
            shutil.copyfileobj(src, out, 1 << 20)
    os.replace(dest + ".part", dest)
    os.remove(archive)
    logger.info(f"Vídeo fuente listo en {dest}")
    state.update(state="ready", progress_pct=100, error=None)
