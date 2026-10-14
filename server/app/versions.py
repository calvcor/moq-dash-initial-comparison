"""Versiones de los componentes de terceros desplegados y aviso de si hay otras más nuevas publicadas.

Las medidas dependen de la versión exacta de cada pieza (el relay cambió de pila QUIC entre dos versiones
seguidas), así que todas van fijadas y se muestran en el dashboard. La consulta de novedades es solo
informativa: nada se actualiza solo.
"""
import logging
import os
import re
import subprocess
import threading
import time

import requests

logger = logging.getLogger("orchestrator")

CHECK_EVERY_S = 6 * 3600
SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def run_version(cmd: list[str], pattern: str):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
        match = re.search(pattern, out)
        return match.group(1) if match else None
    except Exception:
        return None


# Lo instalado en el servidor. El relay y MediaMTX corren en otros contenedores: su versión es la etiqueta
# de imagen fijada en docker-compose.yml, que llega aquí como variable de entorno.
installed = {
    "moq_relay": os.getenv("MOQ_RELAY_VERSION") or None,
    "moq_cli": run_version(["moq", "--version"], r"moq (\S+)"),
    "mediamtx": os.getenv("MEDIAMTX_VERSION") or None,
    "ffmpeg": run_version(["ffmpeg", "-version"], r"ffmpeg version (\d+(?:\.\d+)+)"),
}

latest: dict = {"versions": {}, "checked_at": None, "errors": []}


def newest(tags) -> str | None:
    """La mayor de las etiquetas con forma x.y.z; las demás (latest, 1, 1.21.2-ffmpeg...) se ignoran."""
    found = [(tuple(int(n) for n in m.groups()), m.group(0).lstrip("v")) for m in map(SEMVER.match, tags) if m]
    return max(found)[1] if found else None


def docker_hub(repository: str) -> str | None:
    data = requests.get(f"https://hub.docker.com/v2/repositories/{repository}/tags?page_size=100&ordering=last_updated", timeout=10).json()
    return newest(tag["name"] for tag in data["results"])


def github_release(repository: str, prefix: str) -> str | None:
    data = requests.get(f"https://api.github.com/repos/{repository}/releases?per_page=100", timeout=10).json()
    return newest(r["tag_name"][len(prefix):] for r in data if r["tag_name"].startswith(prefix) and not r.get("prerelease"))


def npm(package: str) -> str | None:
    return requests.get(f"https://registry.npmjs.org/{package.replace('/', '%2f')}/latest", timeout=10).json().get("version")


SOURCES = {
    "moq_relay": lambda: docker_hub("moqdev/moq-relay"),
    "moq_cli": lambda: github_release("moq-dev/moq", "moq-cli-v"),
    "mediamtx": lambda: docker_hub("bluenviron/mediamtx"),
    # Los reproductores se empaquetan con el dashboard: su versión instalada la conoce el propio dashboard
    "moq_watch": lambda: npm("@moq/watch"),
    # Dependencias de @moq/watch con la parte de red y el catálogo: pueden cambiar sin que cambie @moq/watch
    "moq_net": lambda: npm("@moq/net"),
    "moq_hang": lambda: npm("@moq/hang"),
    "dashjs": lambda: npm("dashjs"),
}


def check():
    versions, errors = {}, []
    for key, fetch in SOURCES.items():
        try:
            versions[key] = fetch()
        except Exception as e:
            errors.append(key)
            logger.warning(f"No se pudo consultar la última versión de {key}: {e}")
    # Si una consulta falla se conserva el último valor conocido
    latest["versions"] = {**latest["versions"], **{k: v for k, v in versions.items() if v}}
    latest["checked_at"] = time.time()
    latest["errors"] = errors


def watch():
    while True:
        check()
        time.sleep(CHECK_EVERY_S)


def start():
    threading.Thread(target=watch, daemon=True).start()


def report() -> dict:
    return {"installed": installed, "latest": latest["versions"], "checked_at_ms": latest["checked_at"] and int(latest["checked_at"] * 1000), "errors": latest["errors"]}
