"""Router de emulación de red del testbed.

Reenvía a nivel IP (DNAT, sin terminar conexiones) los puertos que usa el navegador hacia los servidores
finales y degrada ese tráfico con tc en los dos sentidos:

    navegador -> :8080/tcp -> nginx-dash:80      (LL-DASH)
    navegador -> :4433/udp -> moq-relay:4433     (MoQ sobre QUIC)

La ingesta (orquestador -> nginx / relay) va por la red interna sin pasar por aquí, así que la emulación
solo afecta al tramo servidor-cliente y lo hace igual para las dos ramas.

Expone un agente HTTP en :9000 para que el orquestador aplique perfiles y lea contadores.
"""
import json
import math
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NGINX_IP = os.environ["NGINX_IP"]
RELAY_IP = os.environ["RELAY_IP"]
DASH_PORT, MOQ_PORT, CERT_PORT = 8080, 4433, 8081

# Cada protocolo tiene su propia cola por sentido, con el mismo perfil: los dos ven un enlace idéntico
# en vez de competir entre sí por uno compartido. Clase de la qdisc raíz y handles del limitador y de netem.
QUEUES = {
    "dash_down": ("1:1", "10", "100"),
    "moq_down": ("1:2", "20", "200"),
    "dash_up": ("1:3", "30", "300"),
    "moq_up": ("1:4", "40", "400"),
}
DIRECTIONS = ("down", "up")
EMPTY = {"rate_kbit": None, "delay_ms": 0, "jitter_ms": 0, "loss_pct": 0, "queue_ms": 100}
MTU_BITS = 1500 * 8

profile = {name: dict(EMPTY) for name in DIRECTIONS}
shaped = {name: False for name in QUEUES}
# None si la emulación funciona; si no, el motivo (p. ej. faltan módulos sch_* en el kernel del anfitrión)
emulation_error = None


def run(cmd: str, check: bool = True) -> str:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"{cmd}: {result.stderr.strip()}")
    return result.stdout


def interfaces() -> list[str]:
    return sorted(dev for dev in os.listdir("/sys/class/net") if dev.startswith("eth"))


def setup():
    # Reenvío de los puertos del cliente a los servidores finales, con contadores por protocolo y sentido
    for proto, port, dest_ip, dest_port in (
        ("tcp", DASH_PORT, NGINX_IP, 80),
        ("udp", MOQ_PORT, RELAY_IP, MOQ_PORT),
        ("tcp", CERT_PORT, RELAY_IP, CERT_PORT),
    ):
        run(f"iptables -t nat -A PREROUTING -p {proto} --dport {port} -j DNAT --to-destination {dest_ip}:{dest_port}")
    run("iptables -t nat -A POSTROUTING -m conntrack --ctstate DNAT -j MASQUERADE")
    for name, rule in (
        ("dash_down", f"-s {NGINX_IP} -p tcp --sport 80"),
        ("dash_up", f"-d {NGINX_IP} -p tcp --dport 80"),
        ("moq_down", f"-s {RELAY_IP} -p udp --sport {MOQ_PORT}"),
        ("moq_up", f"-d {RELAY_IP} -p udp --dport {MOQ_PORT}"),
    ):
        run(f"iptables -A FORWARD {rule} -m comment --comment {name}")

    # La emulación necesita en el kernel sch_prio, sch_tbf, sch_netem y cls_u32. Si faltan (p. ej. en un
    # contenedor LXC cuyo anfitrión no los tiene cargados) el reenvío sigue funcionando, sin emulación.
    global emulation_error
    try:
        # Clasificación en todas las interfaces, sin depender de por cuál publique Docker los puertos.
        # Bajada = servidor -> cliente, subida = cliente -> servidor; 1:5 es el resto del tráfico, sin tocar.
        for dev in interfaces():
            run(f"tc qdisc replace dev {dev} root handle 1: prio bands 5 priomap 4 4 4 4 4 4 4 4 4 4 4 4 4 4 4 4")
            u32 = f"tc filter add dev {dev} parent 1: protocol ip u32"
            run(f"{u32} match ip protocol 6 0xff match ip sport {DASH_PORT} 0xffff flowid {QUEUES['dash_down'][0]}")
            run(f"{u32} match ip protocol 17 0xff match ip sport {MOQ_PORT} 0xffff flowid {QUEUES['moq_down'][0]}")
            run(f"{u32} match ip protocol 6 0xff match ip dst {NGINX_IP}/32 match ip dport 80 0xffff flowid {QUEUES['dash_up'][0]}")
            run(f"{u32} match ip protocol 17 0xff match ip dst {RELAY_IP}/32 match ip dport {MOQ_PORT} 0xffff flowid {QUEUES['moq_up'][0]}")
    except RuntimeError as e:
        emulation_error = str(e)
        for dev in interfaces():
            run(f"tc qdisc del dev {dev} root", check=False)
        print(f"Emulación de red no disponible: {e}", flush=True)


def apply_queue(queue: str, link: dict):
    parent, limiter, netem = QUEUES[queue]
    active = bool(link["rate_kbit"] or link["delay_ms"] or link["jitter_ms"] or link["loss_pct"])
    for dev in interfaces():
        if not active:
            # Sin restricciones se retira todo: paso directo real, no un limitador muy alto
            run(f"tc qdisc del dev {dev} parent {parent} handle {limiter}:", check=False)
            continue

        # Limitador delante con ráfaga de un paquete: además de fijar el ancho de banda, trocea los
        # superpaquetes GSO/TSO, que netem descartaría enteros falseando la tasa de pérdida.
        rate_bps = (link["rate_kbit"] or 1_000_000) * 1000
        verb = "change" if shaped[queue] else "add"
        run(f"tc qdisc {verb} dev {dev} parent {parent} handle {limiter}: tbf rate {rate_bps}bit burst 1600 latency 1s")

        # netem aplica retardo y pérdida, y su límite hace de cola del cuello de botella. El límite va en
        # paquetes: los que caben en tránsito durante el retardo más los de la cola pedida.
        hold_ms = link["delay_ms"] + link["jitter_ms"] + (link["queue_ms"] if link["rate_kbit"] else 1000)
        limit = max(20, math.ceil(rate_bps * hold_ms / 1000 / MTU_BITS))
        spec = f"limit {min(limit, 100000)}"
        if link["delay_ms"] or link["jitter_ms"]:
            spec += f" delay {link['delay_ms']}ms"
            if link["jitter_ms"]:
                spec += f" {link['jitter_ms']}ms 25%"
        if link["loss_pct"]:
            spec += f" loss {link['loss_pct']}%"
        run(f"tc qdisc {verb} dev {dev} parent {limiter}:1 handle {netem}: netem {spec}")
    shaped[queue] = active


def stats() -> dict:
    out = {}
    # Bytes IP reenviados por protocolo y sentido (cabeceras y retransmisiones incluidas), antes de la emulación
    for line in run("iptables-save -c -t filter").splitlines():
        if "--comment" in line and line.startswith("["):
            packets, size = line[1 : line.index("]")].split(":")
            out[line.split("--comment")[1].split()[0].strip('"')] = {"packets": int(packets), "bytes": int(size)}
    # Descartes de la emulación por cola: pérdida aleatoria de netem y desbordamiento de la cola
    for queue, (_, _, netem) in QUEUES.items():
        dropped = backlog = 0
        for dev in interfaces():
            for qdisc in json.loads(run(f"tc -s -j qdisc show dev {dev}")):
                # Solo netem: el limitador padre vuelve a contar los mismos descartes
                if qdisc.get("handle") == f"{netem}:":
                    dropped += qdisc.get("drops", 0)
                    backlog += qdisc.get("qlen", 0)
        out[queue].update(dropped=dropped, queued=backlog)
    return out


class Agent(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200, {"profile": profile, "stats": stats(), "emulation_error": emulation_error})

    def do_POST(self):
        try:
            if emulation_error:
                raise RuntimeError(f"Emulación de red no disponible en este servidor: {emulation_error}")
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            for direction in DIRECTIONS:
                link = {**EMPTY, **(body.get(direction) or {})}
                for queue in QUEUES:
                    if queue.endswith(direction):
                        apply_queue(queue, link)
                profile[direction] = link
            self.reply(200, {"profile": profile, "stats": stats(), "emulation_error": None})
        except Exception as e:
            self.reply(400, {"error": str(e)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    setup()
    print(f"Router listo: interfaces {interfaces()}, nginx {NGINX_IP}, relay {RELAY_IP}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 9000), Agent).serve_forever()
