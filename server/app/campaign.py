"""Campañas de medida: baterías de pruebas desatendidas sobre condiciones de red y latencias objetivo.

El orquestador guarda el plan y marca el ritmo; el navegador (página /campaign en modo trabajador) solo
monta los reproductores con los ajustes de la prueba en curso y sube sus filas de cada segundo, las mismas
del CSV del dashboard. Así una recarga o un cuelgue de la pestaña no pierde la campaña: el trabajador se
vuelve a enganchar y la prueba interrumpida se repite.

Cada prueba (run) es una terna condición de red x latencia objetivo x repetición, con una configuración de
la emisión y unos reproductores:

1. preparing: el trabajador desmonta los reproductores; se aplica la emisión (solo si cambia, con un
   margen para que las ramas arranquen) y el perfil de red, y se deja un respiro para vaciar las colas.
2. mounting: el trabajador crea reproductores nuevos con los ajustes de la prueba y avisa al tenerlos. Son
   siempre nuevos: MoQ en auto calcula su objetivo del RTT solo al conectar (PROTOCOLOS, 4.11), y de paso
   se mide el arranque.
3. warmup: las filas se guardan, marcadas, pero no entran en el resumen.
4. measuring: las filas que entran en el resumen.
5. done o invalid. Una prueba inválida (pestaña oculta, reinicios del supervisor, anomalías de ingesta,
   trabajador desconectado, filas que faltan) se repite al final de su bloque, hasta max_attempts veces.

El orden se aleatoriza dentro de cada bloque (configuración de la emisión x repetición), para que la deriva
del sistema en una campaña larga no se confunda con la condición y sin reiniciar la fuente en cada prueba.
Cada control_every pruebas se intercala una de control, sin restricción de red, que detecta esa deriva.

La latencia objetivo de cada prueba se pasa a cada reproductor tal como lo entiende su implementación
(liveDelay de dash.js, delay de @moq/watch, jitterBufferTarget de WebRTC): no significan lo mismo y se
declara así. None es el valor por defecto de la implementación.

Al terminar (o al cancelar) la red vuelve a quedar sin restricción y la emisión como estaba al empezar.
Si el orquestador se reinicia con una campaña en marcha, al arrancar la retoma: la prueba en curso se repite.
"""
import csv
import io
import json
import logging
import os
import random
import re
import statistics
import threading
import time
from typing import Callable, Optional

from .source import VIDEO_FILE

logger = logging.getLogger("orchestrator")

PLAYERS = ("dash", "moq", "rtc")
CAMPAIGN_ID = re.compile(r"^\d{8}-\d{6}$")
# Sin noticias del trabajador durante este tiempo, la prueba en curso se da por perdida
WORKER_TIMEOUT_S = 15
# Lo que se espera a que el trabajador desmonte los reproductores, o los monte, antes de seguir sin él
UNMOUNT_WAIT_S = 10
MOUNT_WAIT_S = 60
# Tras cambiar el perfil de red, para que se vacíen las colas del anterior
NETWORK_SETTLE_S = 2
# Tras la medida, para recibir las últimas filas (el trabajador las sube por lotes)
UPLOAD_GRACE_S = 8
# Por debajo de esta fracción de filas con latencia medida, la prueba no vale
MIN_COVERAGE = 0.8
# Duración aproximada de la preparación y el montaje, para la estimación de la campaña
OVERHEAD_S = 10

UNRESTRICTED = {
    direction: {"rate_kbit": None, "delay_ms": 0, "jitter_ms": 0, "loss_pct": 0, "queue_ms": 100}
    for direction in ("down", "up")
}

# Columna del búfer de cada reproductor en las filas del dashboard
BUFFER_COLUMN = {"dash": "dash_buffer_s", "moq": "moq_jitter_buffer_s", "rtc": "rtc_jitter_buffer_s"}


def percentile(values: list[float], p: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def rounded(value: Optional[float], digits: int = 1) -> Optional[float]:
    return None if value is None else round(value, digits)


def column(rows: list[dict], key: str) -> list[float]:
    return [r[key] for r in rows if isinstance(r.get(key), (int, float)) and not isinstance(r.get(key), bool)]


def increase(rows: list[dict], key: str) -> Optional[float]:
    """Lo que ha subido un contador acumulado en las filas (paradas, cambios de calidad, descartes)."""
    values = column(rows, key)
    if len(values) < 2:
        return None
    # Si el contador vuelve a cero (reproductor recreado), se suman los tramos
    total = 0.0
    for before, after in zip(values, values[1:]):
        total += after - before if after >= before else after
    return total


def summarize_player(player: str, rows: list[dict], measure_s: float, target_ms: Optional[int]) -> dict:
    g2g = column(rows, f"{player}_g2g_ms")
    heights = column(rows, f"{player}_height")
    top = max(heights) if heights else None
    stall_ms = increase(rows, f"{player}_stall_ms")
    mean = lambda key: rounded(statistics.fmean(column(rows, key))) if column(rows, key) else None
    median = lambda key: rounded(statistics.median(column(rows, key))) if column(rows, key) else None
    return {
        "samples": len(g2g),
        "coverage": rounded(len(g2g) / measure_s, 3) if measure_s else None,
        "target_ms": target_ms,
        "g2g_p50_ms": rounded(percentile(g2g, 50)),
        "g2g_p95_ms": rounded(percentile(g2g, 95)),
        "g2g_mean_ms": rounded(statistics.fmean(g2g)) if g2g else None,
        "g2g_sd_ms": rounded(statistics.stdev(g2g)) if len(g2g) > 1 else None,
        "g2g_min_ms": rounded(min(g2g)) if g2g else None,
        "g2g_max_ms": rounded(max(g2g)) if g2g else None,
        "stalls": increase(rows, f"{player}_stalls"),
        "stall_ms": rounded(stall_ms),
        "stall_ratio": rounded(stall_ms / (measure_s * 1000), 4) if stall_ms is not None and measure_s else None,
        "kbps_mean": mean(f"{player}_kbps"),
        "net_kbps_mean": mean(f"{player}_net_kbps"),
        "ip_down_kbps_mean": mean(f"{player}_ip_down_kbps"),
        "fps_mean": mean(f"{player}_fps"),
        "frametime_p95_ms_median": median(f"{player}_frametime_p95_ms"),
        "buffer_s_mean": rounded(statistics.fmean(column(rows, BUFFER_COLUMN[player])), 3) if column(rows, BUFFER_COLUMN[player]) else None,
        "height_mean": rounded(statistics.fmean(heights)) if heights else None,
        # Fracción del tiempo en la calidad más alta que llegó a reproducir en la prueba
        "top_height_share": rounded(sum(1 for h in heights if h == top) / len(heights), 3) if heights else None,
        "quality_switches": increase(rows, f"{player}_quality_switches"),
        "player_restarts": increase(rows, f"{player}_player_restarts"),
        "down_dropped": increase(rows, f"{player}_down_dropped"),
        "packets_lost": increase(rows, "rtc_packets_lost") if player == "rtc" else None,
    }


class Campaigns:
    def __init__(self, root: str):
        self.root = root
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.campaigns: dict[str, dict] = {}
        self.active: Optional[str] = None
        # Filas de la prueba en curso, para su resumen (en disco van todas a samples.jsonl)
        self.rows: dict[str, list[dict]] = {}
        # mounted_at_ms: cuándo creó el trabajador los reproductores de la prueba montada, en reloj del servidor
        self.worker = {"id": None, "seen": 0.0, "mounted": None, "mounted_at_ms": None, "info": {}}
        # Los pone main.py
        self.apply_stream: Callable[[dict], None] = lambda config: None
        self.apply_network: Callable[[dict], None] = lambda profile: None
        self.stop_stream: Callable[[], None] = lambda: None
        self.snapshot: Callable[[], dict] = lambda: {}

    # --- ficheros ---

    def path(self, cid: str, name: str = "") -> str:
        if not CAMPAIGN_ID.match(cid):
            raise KeyError(cid)
        return os.path.join(self.root, cid, name)

    def save(self, campaign: dict):
        tmp = self.path(campaign["id"], "campaign.json.part")
        with open(tmp, "w") as f:
            json.dump(campaign, f)
        os.replace(tmp, self.path(campaign["id"], "campaign.json"))

    def load(self):
        """Lee las campañas guardadas y retoma la que estuviera en marcha al reiniciarse el orquestador."""
        if not os.path.isdir(self.root):
            return
        for cid in sorted(os.listdir(self.root)):
            try:
                with open(self.path(cid, "campaign.json")) as f:
                    campaign = json.load(f)
            except (KeyError, OSError, ValueError):
                continue
            for run in campaign["runs"]:
                if run["state"] not in ("pending", "done", "invalid", "skipped"):
                    run["state"] = "pending"
            self.campaigns[cid] = campaign
            if campaign["state"] == "running":
                self.log(campaign, "Orquestador reiniciado: se retoma la campaña y se repite la prueba en curso")
                self.save(campaign)
                self.active = cid

    def log(self, campaign: dict, message: str):
        logger.info(f"Campaña {campaign['id']}: {message}")
        campaign.setdefault("events", []).append({"t_ms": int(time.time() * 1000), "message": message})
        del campaign["events"][:-200]

    # --- plan ---

    def expand(self, plan: dict) -> list[dict]:
        rng = random.Random(plan["seed"])
        players = plan["players"]
        groups = [players] if plan["player_mode"] == "together" else [[p] for p in players]
        runs = []
        for s in range(len(plan["streams"])):
            for rep in range(plan["repetitions"]):
                block = [
                    {"stream": s, "network": n, "target": t, "players": group, "rep": rep, "kind": "test"}
                    for n in range(len(plan["networks"]))
                    for t in range(len(plan["targets"]))
                    for group in groups
                ]
                rng.shuffle(block)
                runs.extend(block)
        if plan["control_every"]:
            with_controls = []
            for i, run in enumerate(runs):
                # El control va con la emisión de la prueba que le sigue: no fuerza un reinicio de la fuente
                if i % plan["control_every"] == 0:
                    for group in groups:
                        with_controls.append({**run, "network": None, "target": 0, "players": group, "kind": "control"})
                with_controls.append(run)
            runs = with_controls
        return [self.new_run(i, run) for i, run in enumerate(runs)]

    @staticmethod
    def new_run(index: int, run: dict, attempt: int = 1) -> dict:
        return {**run, "id": f"r{index:04d}", "attempt": attempt, "state": "pending", "invalid_reasons": [],
                "started_ms": None, "mounted_ms": None, "warmup_start_ms": None, "measure_start_ms": None, "ended_ms": None, "summary": None}

    def estimate_s(self, campaign: dict) -> float:
        plan = campaign["plan"]
        pending = [r for r in campaign["runs"] if r["state"] == "pending"]
        per_run = plan["warmup_s"] + plan["measure_s"] + OVERHEAD_S + UPLOAD_GRACE_S
        restarts = len({r["stream"] for r in pending})
        return len(pending) * per_run + restarts * plan["stream_settle_s"]

    def create(self, plan: dict) -> dict:
        with self.lock:
            cid = time.strftime("%Y%m%d-%H%M%S")
            while cid in self.campaigns:
                time.sleep(1)
                cid = time.strftime("%Y%m%d-%H%M%S")
            if plan.get("seed") is None:
                plan["seed"] = random.randrange(2 ** 31)
            campaign = {"id": cid, "name": plan["name"], "state": "ready", "created_ms": int(time.time() * 1000),
                        "plan": plan, "runs": self.expand(plan), "current": None, "restore": None, "events": []}
            os.makedirs(self.path(cid), exist_ok=True)
            self.campaigns[cid] = campaign
            self.save(campaign)
            return self.view(campaign)

    def view(self, campaign: dict, runs: bool = True) -> dict:
        counts = {}
        for run in campaign["runs"]:
            counts[run["state"]] = counts.get(run["state"], 0) + 1
        out = {k: v for k, v in campaign.items() if runs or k not in ("runs", "events")}
        out.update(counts=counts, total_runs=len(campaign["runs"]), eta_s=round(self.estimate_s(campaign)))
        if campaign["id"] == self.active:
            out["worker"] = self.worker_view()
        return out

    def worker_view(self) -> dict:
        connected = self.worker["id"] is not None and time.time() - self.worker["seen"] < WORKER_TIMEOUT_S
        return {"connected": connected, "id": self.worker["id"], "seen_ms": int(self.worker["seen"] * 1000),
                "mounted": self.worker["mounted"], "info": self.worker["info"]}

    def all(self) -> list[dict]:
        with self.lock:
            return [self.view(c, runs=False) for c in sorted(self.campaigns.values(), key=lambda c: c["id"], reverse=True)]

    def get(self, cid: str) -> Optional[dict]:
        with self.lock:
            campaign = self.campaigns.get(cid)
            return self.view(campaign) if campaign else None

    def running(self) -> Optional[dict]:
        """Resumen de la campaña en marcha, para /api/status (None si no hay ninguna)."""
        with self.lock:
            if not self.active:
                return None
            campaign = self.campaigns[self.active]
            return {"id": campaign["id"], "name": campaign["name"], "state": campaign["state"],
                    "current": campaign["current"], "worker": self.worker_view()}

    def delete(self, cid: str):
        with self.lock:
            if cid == self.active:
                raise RuntimeError("La campaña está en marcha: cancélala antes de borrarla")
            if cid not in self.campaigns:
                raise KeyError(cid)
            del self.campaigns[cid]
            for name in os.listdir(self.path(cid)):
                os.remove(self.path(cid, name))
            os.rmdir(self.path(cid))

    # --- control ---

    def start(self, cid: str):
        with self.lock:
            campaign = self.campaigns[cid]
            if self.active and self.active != cid:
                raise RuntimeError(f"Ya hay otra campaña en marcha ({self.active})")
            if campaign["state"] not in ("ready", "paused"):
                raise RuntimeError(f"La campaña está {campaign['state']}")
            if campaign["restore"] is None:
                # Cómo estaba todo al empezar, para dejarlo igual al terminar (sobrevive a reinicios)
                snap = self.snapshot()
                campaign["restore"] = {"running": snap.get("running"), "config": snap.get("config"),
                                       "network": snap.get("network")}
                campaign["versions"] = snap.get("versions")
            campaign["state"] = "running"
            self.log(campaign, "Campaña en marcha")
            self.save(campaign)
            self.active = cid
            self.wake.set()

    def pause(self, cid: str):
        """Detiene la campaña sin restaurar nada; la prueba en curso se repetirá al reanudar."""
        with self.lock:
            campaign = self.campaigns[cid]
            if campaign["state"] != "running":
                raise RuntimeError(f"La campaña está {campaign['state']}")
            campaign["state"] = "paused"
            self.log(campaign, "Campaña en pausa")
            self.save(campaign)
            self.wake.set()

    def abort(self, cid: str):
        with self.lock:
            campaign = self.campaigns[cid]
            if campaign["state"] not in ("running", "paused", "ready"):
                raise RuntimeError(f"La campaña está {campaign['state']}")
            campaign["state"] = "aborted"
            self.log(campaign, "Campaña cancelada")
            self.save(campaign)
            self.wake.set()
            if cid != self.active and campaign["restore"] is not None:
                # En pausa no hay planificador que restaure: se hace aquí
                threading.Thread(target=self.restore, args=(campaign,), daemon=True).start()

    def restore(self, campaign: dict):
        restore = campaign.get("restore") or {}
        try:
            self.apply_network((restore.get("network") or UNRESTRICTED))
        except Exception as e:
            self.log(campaign, f"No se pudo restaurar la red: {e}")
        try:
            if restore.get("running") and restore.get("config"):
                self.apply_stream(restore["config"])
            elif restore.get("running") is False:
                self.stop_stream()
        except Exception as e:
            self.log(campaign, f"No se pudo restaurar la emisión: {e}")
        with self.lock:
            self.save(campaign)

    # --- trabajador ---

    def heartbeat(self, worker_id: str, mounted: Optional[str], mounted_at_ms: Optional[float], info: dict) -> dict:
        """El trabajador dice qué tiene montado y recibe lo que debe tener."""
        with self.lock:
            now = time.time()
            if self.worker["id"] not in (None, worker_id) and now - self.worker["seen"] < WORKER_TIMEOUT_S:
                return {"busy": True, "worker": self.worker["id"], "assignment": None}
            if self.worker["id"] != worker_id:
                logger.info(f"Campañas: trabajador {worker_id} conectado")
            # Si no lo dice (o no es creíble), el primer latido que trae la prueba montada
            if mounted is None:
                mounted_at_ms = None
            elif mounted_at_ms is None or not now * 1000 - 60000 <= mounted_at_ms <= now * 1000 + 1000:
                same = self.worker["mounted"] == mounted and self.worker["mounted_at_ms"]
                mounted_at_ms = self.worker["mounted_at_ms"] if same else now * 1000
            self.worker.update(id=worker_id, seen=now, mounted=mounted, mounted_at_ms=mounted_at_ms, info=info)
            self.wake.set()
            return {"busy": False, "assignment": self.assignment()}

    def assignment(self) -> Optional[dict]:
        if not self.active:
            return None
        campaign = self.campaigns[self.active]
        current = campaign["current"]
        if campaign["state"] != "running" or current is None:
            return {"campaign": campaign["id"], "phase": "idle"}
        run = self.find_run(campaign, current)
        plan = campaign["plan"]
        phase = run["state"]
        out = {"campaign": campaign["id"], "run": run["id"], "phase": phase}
        if phase in ("mounting", "warmup", "measuring", "closing"):
            target = plan["targets"][run["target"]]
            out.update(
                players=run["players"],
                targets={p: target.get(f"{p}_ms") for p in PLAYERS},
                target_label=target["label"],
                network_label="control (sin restricción)" if run["network"] is None else plan["networks"][run["network"]]["label"],
                quality=plan["quality"],
                kind=run["kind"],
                rep=run["rep"],
                ends_ms=self.phase_end_ms(run, plan),
            )
        return out

    @staticmethod
    def phase_end_ms(run: dict, plan: dict) -> Optional[int]:
        if run["state"] == "warmup":
            return run["warmup_start_ms"] + int(plan["warmup_s"] * 1000)
        if run["state"] == "measuring":
            return run["measure_start_ms"] + int(plan["measure_s"] * 1000)
        return None

    def add_rows(self, cid: str, run_id: str, rows: list[dict]) -> int:
        """Guarda las filas que sube el trabajador, marcadas con la fase de la prueba a la que pertenecen."""
        with self.lock:
            campaign = self.campaigns.get(cid)
            if campaign is None:
                raise KeyError(cid)
            run = self.find_run(campaign, run_id)
            if run is None or run["mounted_ms"] is None:
                return 0
            end_ms = run["measure_start_ms"] + int(campaign["plan"]["measure_s"] * 1000) if run["measure_start_ms"] else None
            kept = []
            for row in rows:
                t = row.get("t_server_ms")
                if not isinstance(t, (int, float)):
                    continue
                if run["measure_start_ms"] is None or t < run["measure_start_ms"]:
                    phase = "warmup"
                elif t <= end_ms:
                    phase = "measuring"
                else:
                    continue  # ya fuera de la prueba
                # run_started_ms distingue la prueba repetida tras una pausa o un reinicio, que conserva su id
                kept.append({"campaign": cid, "run_id": run_id, "attempt": run["attempt"],
                             "run_started_ms": run["started_ms"], "phase": phase, **row})
            if not kept:
                return 0
            with open(self.path(cid, "samples.jsonl"), "a") as f:
                for row in kept:
                    f.write(json.dumps(row) + "\n")
            if run["state"] in ("warmup", "measuring", "closing"):
                self.rows.setdefault(run_id, []).extend(kept)
            return len(kept)

    @staticmethod
    def find_run(campaign: dict, run_id: str) -> Optional[dict]:
        return next((r for r in campaign["runs"] if r["id"] == run_id), None)

    # --- planificador ---

    def scheduler(self):
        """Hilo del planificador: lleva la campaña activa prueba a prueba."""
        while True:
            self.wake.wait(1)
            self.wake.clear()
            with self.lock:
                cid = self.active
            if not cid:
                continue
            try:
                self.drive(self.campaigns[cid])
            except Exception as e:
                logger.exception(f"Campañas: error en el planificador: {e}")
                time.sleep(5)

    def worker_alive(self) -> bool:
        return self.worker["id"] is not None and time.time() - self.worker["seen"] < WORKER_TIMEOUT_S

    def wait(self, seconds: float, campaign: dict, until: Optional[Callable[[], bool]] = None) -> bool:
        """Espera mientras la campaña siga en marcha. False si deja de estarlo."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            if campaign["state"] != "running":
                return False
            if until and until():
                return True
            time.sleep(0.25)
        return campaign["state"] == "running"

    def drive(self, campaign: dict):
        plan = campaign["plan"]
        applied_stream = None
        while True:
            with self.lock:
                if campaign["state"] != "running":
                    break
                run = next((r for r in campaign["runs"] if r["state"] == "pending"), None)
                if run is None:
                    campaign["state"] = "done"
                    campaign["current"] = None
                    self.log(campaign, "Campaña terminada")
                    self.save(campaign)
                    break
                campaign["current"] = run["id"]
                run.update(state="preparing", started_ms=int(time.time() * 1000), mounted_ms=None, warmup_start_ms=None,
                           measure_start_ms=None, ended_ms=None, invalid_reasons=[], summary=None)
                self.rows.pop(run["id"], None)
                self.save(campaign)

            # Sin trabajador no tiene sentido tocar nada: se espera a que se conecte
            if not self.worker_alive():
                with self.lock:
                    run["state"] = "pending"
                    campaign["current"] = None
                if not self.wait(3600 * 24, campaign, self.worker_alive):
                    break
                continue

            # 1. El trabajador desmonta lo que tenga antes de cambiar la red o la emisión
            self.wait(UNMOUNT_WAIT_S, campaign, lambda: self.worker["mounted"] is None)
            try:
                stream = plan["streams"][run["stream"]]
                snap = self.snapshot()
                if applied_stream != run["stream"] or not snap.get("running"):
                    self.log(campaign, f"Emisión {run['stream'] + 1} de {len(plan['streams'])}")
                    self.apply_stream(stream)
                    applied_stream = run["stream"]
                    if not self.wait(plan["stream_settle_s"], campaign):
                        self.requeue(campaign, run)
                        break
                network = UNRESTRICTED if run["network"] is None else plan["networks"][run["network"]]["profile"]
                self.apply_network(network)
            except Exception as e:
                self.log(campaign, f"No se pudo preparar {run['id']}: {e}; se reintenta en 30 s")
                applied_stream = None
                self.requeue(campaign, run)
                if not self.wait(30, campaign):
                    break
                continue
            if not self.wait(NETWORK_SETTLE_S, campaign):
                self.requeue(campaign, run)
                break
            before = self.snapshot()

            # 2. El trabajador monta reproductores nuevos y avisa
            with self.lock:
                run["state"] = "mounting"
                self.save(campaign)
            mounted = self.wait(MOUNT_WAIT_S, campaign, lambda: self.worker["mounted"] == run["id"])
            if campaign["state"] != "running":
                self.requeue(campaign, run)
                break
            if not mounted:
                self.close(campaign, run, before, ["el trabajador no montó los reproductores"])
                continue

            # 3. Calentamiento y 4. medida
            with self.lock:
                run.update(state="warmup", warmup_start_ms=int(time.time() * 1000), mounted_ms=int(self.worker["mounted_at_ms"] or time.time() * 1000))
                self.save(campaign)
            lost = lambda: not self.worker_alive() or self.worker["mounted"] != run["id"]
            if not self.wait(plan["warmup_s"], campaign, lost) or lost():
                if campaign["state"] != "running":
                    self.requeue(campaign, run)
                    break
                self.close(campaign, run, before, ["trabajador desconectado o reproductores desmontados"])
                continue
            with self.lock:
                run.update(state="measuring", measure_start_ms=int(time.time() * 1000))
                self.save(campaign)
            if not self.wait(plan["measure_s"], campaign, lost) or lost():
                if campaign["state"] != "running":
                    self.requeue(campaign, run)
                    break
                self.close(campaign, run, before, ["trabajador desconectado o reproductores desmontados"])
                continue

            # 5. Últimas filas y resumen
            with self.lock:
                run["state"] = "closing"
                self.save(campaign)
            time.sleep(UPLOAD_GRACE_S)
            self.close(campaign, run, before, [])

        with self.lock:
            if campaign["state"] in ("done", "aborted"):
                campaign["current"] = None
                self.active = None
            elif campaign["state"] == "paused":
                campaign["current"] = None
                self.active = None
            self.save(campaign)
        if campaign["state"] in ("done", "aborted"):
            self.restore(campaign)

    def requeue(self, campaign: dict, run: dict):
        with self.lock:
            run.update(state="pending", mounted_ms=None, measure_start_ms=None)
            campaign["current"] = None
            self.rows.pop(run["id"], None)
            self.save(campaign)

    def close(self, campaign: dict, run: dict, before: dict, reasons: list[str]):
        plan = campaign["plan"]
        after = self.snapshot()
        with self.lock:
            kept = self.rows.pop(run["id"], [])
            rows = [r for r in kept if r["phase"] == "measuring"]
            warmup = sorted((r for r in kept if r["phase"] == "warmup"), key=lambda r: r["t_server_ms"])
            reasons = list(reasons)
            if not reasons:
                reasons += self.validity(run, rows, before, after, plan)
            target = plan["targets"][run["target"]]
            run["summary"] = {
                "rows": len(rows),
                "server": {
                    "restarts": self.delta(before.get("restarts"), after.get("restarts")),
                    "ingest_anomalies": self.delta(before.get("anomalies"), after.get("anomalies")),
                },
                "players": {p: summarize_player(p, rows, plan["measure_s"], target.get(f"{p}_ms")) for p in run["players"]},
            }
            # Del montaje a la primera fila con latencia medida, con la resolución de una fila por segundo
            for p in run["players"]:
                first = next((r["t_server_ms"] for r in warmup if r.get(f"{p}_g2g_ms") is not None), None)
                run["summary"]["players"][p]["first_g2g_s"] = rounded((first - run["mounted_ms"]) / 1000) if first and run["mounted_ms"] else None
            run.update(ended_ms=int(time.time() * 1000), invalid_reasons=reasons, state="invalid" if reasons else "done")
            if reasons:
                self.log(campaign, f"{run['id']} inválida: {'; '.join(reasons)}")
                if run["attempt"] < plan["max_attempts"]:
                    self.retry(campaign, run)
            campaign["current"] = None
            self.save(campaign)
        self.append_summary(campaign, run)

    @staticmethod
    def delta(before: Optional[dict], after: Optional[dict]) -> Optional[int]:
        if not before or not after:
            return None
        return sum(after.get(k, 0) - before.get(k, 0) for k in after)

    def validity(self, run: dict, rows: list[dict], before: dict, after: dict, plan: dict) -> list[str]:
        reasons = []
        if any(r.get("tab_hidden") for r in rows):
            reasons.append("pestaña oculta")
        restarts = self.delta(before.get("restarts"), after.get("restarts"))
        if restarts:
            reasons.append(f"{restarts} reinicios del supervisor")
        anomalies = self.delta(before.get("anomalies"), after.get("anomalies"))
        if anomalies:
            reasons.append(f"{anomalies} anomalías de ingesta")
        wanted = "|".join(p for p in PLAYERS if p in run["players"])
        if any(r.get("players") != wanted for r in rows):
            reasons.append("reproductores activos distintos de los de la prueba")
        for p in run["players"]:
            measured = len(column(rows, f"{p}_g2g_ms"))
            if measured < MIN_COVERAGE * plan["measure_s"]:
                reasons.append(f"{p}: latencia medida en {measured} de {round(plan['measure_s'])} s")
        return reasons

    def retry(self, campaign: dict, run: dict):
        """Repite la prueba al final de su bloque (misma emisión y repetición), para no reiniciar la fuente."""
        runs = campaign["runs"]
        position = max(i for i, r in enumerate(runs) if r["stream"] == run["stream"] and r["rep"] == run["rep"]) + 1
        fields = {k: run[k] for k in ("stream", "network", "target", "players", "rep", "kind")}
        copy = self.new_run(len(runs), fields, attempt=run["attempt"] + 1)
        copy["retry_of"] = run["id"]
        runs.insert(position, copy)

    # --- exportación ---

    def run_columns(self, campaign: dict, run: dict) -> dict:
        plan = campaign["plan"]
        target = plan["targets"][run["target"]]
        network = {"label": "control", "profile": UNRESTRICTED} if run["network"] is None else plan["networks"][run["network"]]
        out = {
            "campaign": campaign["id"], "run_id": run["id"], "attempt": run["attempt"], "state": run["state"],
            "kind": run["kind"], "rep": run["rep"], "stream_idx": run["stream"],
            "network_label": network["label"], "target_label": target["label"],
            "players_run": "|".join(run["players"]),
            "invalid_reasons": "; ".join(run["invalid_reasons"]),
            "started_ms": run["started_ms"], "measure_start_ms": run["measure_start_ms"], "ended_ms": run["ended_ms"],
        }
        for direction in ("down", "up"):
            for key, value in network["profile"][direction].items():
                out[f"net_{direction}_{key}"] = value
        return out

    def append_summary(self, campaign: dict, run: dict):
        """Una fila por prueba y reproductor en runs.jsonl (los intentos inválidos también)."""
        base = self.run_columns(campaign, run)
        summary = run["summary"] or {}
        with open(self.path(campaign["id"], "runs.jsonl"), "a") as f:
            for player, values in (summary.get("players") or {}).items():
                row = {**base, "player": player, "server_restarts": summary["server"]["restarts"],
                       "ingest_anomalies": summary["server"]["ingest_anomalies"], **values}
                f.write(json.dumps(row) + "\n")

    def export_csv(self, cid: str, name: str) -> str:
        """runs.jsonl o samples.jsonl en CSV, con la unión de todas las columnas en orden de aparición."""
        if cid not in self.campaigns:
            raise KeyError(cid)
        rows = []
        try:
            with open(self.path(cid, name)) as f:
                rows = [json.loads(line) for line in f if line.strip()]
        except OSError:
            pass
        if name == "samples.jsonl":
            # Las columnas de la condición, delante de las del dashboard
            campaign = self.campaigns[cid]
            runs = {r["id"]: r for r in campaign["runs"]}
            rows = [{**self.run_columns(campaign, runs[r["run_id"]]), **r,
                     # La fila entra en el resumen de una prueba válida (no de un intento interrumpido)
                     "in_summary": r["phase"] == "measuring" and runs[r["run_id"]]["state"] == "done"
                     and r.get("run_started_ms") == runs[r["run_id"]]["started_ms"]}
                    if r["run_id"] in runs else r for r in rows]
        keys = list(dict.fromkeys(k for row in rows for k in row))
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=keys, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: ("" if v is None else v) for k, v in row.items()})
        return out.getvalue()


# Junto al vídeo fuente, en el volumen media/: sobreviven a reinicios del contenedor
campaigns = Campaigns(os.path.join(os.path.dirname(VIDEO_FILE), "campaigns"))
