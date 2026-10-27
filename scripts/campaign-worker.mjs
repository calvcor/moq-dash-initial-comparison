#!/usr/bin/env node
// Trabajador de campañas en Chrome headless (README, 4.8), para dejar el equipo midiendo sin una pestaña a la
// vista. Abre /campaign?worker=1 y lo vigila: si Chrome se cae lo vuelve a lanzar, y si la página se cuelga o
// deja de latir con una campaña en marcha, la recarga (la prueba interrumpida la repite el servidor).
//
//   node scripts/campaign-worker.mjs                                  # contra http://localhost
//   node scripts/campaign-worker.mjs --url https://moq-dash.mininet.duckdns.org
//   node scripts/campaign-worker.mjs --url http://10.20.40.90 --insecure
//
// Opciones: --url, --chrome (ruta del ejecutable; también CHROME), --port (depuración remota, 9400) e
// --insecure (trata como seguro el origen HTTP de --url: hace falta por IP sin HTTPS, no con localhost).
// Necesita Node 22 (WebSocket y fetch globales). En macOS impide que el equipo se duerma mientras corre.
// Ctrl+C cierra Chrome y borra su perfil desechable.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return pairs;
  }, []),
);
const BASE = String(args.url || 'http://localhost').replace(/\/$/, '');
const PORT = Number(args.port || 9400);
const CHROME =
  args.chrome ||
  process.env.CHROME ||
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
// Sin latido del trabajador durante este tiempo, con una campaña en marcha, se recarga la página
const STALE_MS = 60_000;
const CHECK_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toLocaleString(), ...m);

let chrome = null;
// Chrome ha terminado. No vale exitCode: si lo mata una señal (p. ej. SIGKILL), exitCode se queda en null
let chromeExited = false;
let profile = null;
let ws = null;
let stopping = false;

function cleanup() {
  stopping = true;
  try {
    ws?.close();
  } catch {}
  if (chrome && !chromeExited) {
    chrome.kill('SIGTERM');
    // Si no se cierra por las buenas, a la fuerza: un Chrome huérfano seguiría reproduciendo y compartiría
    // la cola de emulación con las medidas siguientes
    const pid = chrome.pid;
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {}
    }, 2000).unref();
  }
  if (profile) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('Cerrando Chrome y saliendo');
    cleanup();
    setTimeout(() => process.exit(0), 2500);
  });
}
process.on('exit', cleanup);

if (process.platform === 'darwin') {
  // Que el Mac no se duerma mientras viva este proceso
  spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' }).unref();
}

async function launch() {
  profile = mkdtempSync(join(tmpdir(), 'campaign-worker-'));
  const flags = [
    '--headless=new',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1600,1000',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
  ];
  if (args.insecure) flags.push(`--unsafely-treat-insecure-origin-as-secure=${new URL(BASE).origin}`);
  chrome = spawn(CHROME, [...flags, 'about:blank'], { stdio: 'ignore' });
  chromeExited = false;
  log(`Chrome lanzado (pid ${chrome.pid})`);
  chrome.on('exit', (code, signal) => {
    chromeExited = true;
    if (!stopping) log(`Chrome ha terminado (${signal ? `señal ${signal}` : `código ${code}`})`);
  });

  let tabs = null;
  for (let i = 0; i < 80 && !tabs; i++) {
    try {
      tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    } catch {
      await sleep(250);
    }
  }
  const page = tabs?.find((t) => t.type === 'page');
  if (!page) throw new Error('Chrome no ofrece la pestaña por el puerto de depuración');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Inspector.targetCrashed') {
      log('La pestaña se ha colgado: se recarga');
      navigate();
    }
  };
  ws.send(JSON.stringify({ id: ++id, method: 'Inspector.enable' }));
  ws.send(JSON.stringify({ id: ++id, method: 'Page.enable' }));
  // Se abre en about:blank y se navega después: abrir la URL directamente ha dado pestañas sin el
  // reproductor de MoQ (CLAUDE.md)
  const navigate = () => ws.send(JSON.stringify({ id: ++id, method: 'Page.navigate', params: { url: `${BASE}/campaign?worker=1` } }));
  navigate();
  log(`Trabajador abierto en ${BASE}/campaign?worker=1`);
  return navigate;
}

async function main() {
  let navigate = await launch();
  let staleSince = null;
  let last = '';
  while (!stopping) {
    await sleep(CHECK_MS);
    if (stopping) break; // nada de relanzar Chrome mientras se cierra
    if (chromeExited) {
      log('Se vuelve a lanzar Chrome');
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
      await sleep(3000);
      navigate = await launch();
      staleSince = null;
      continue;
    }
    let campaign = null;
    try {
      campaign = (await (await fetch(`${BASE}/api/status`)).json()).campaign;
    } catch {
      continue; // servidor caído: el servidor retoma la campaña al volver y la página se reengancha sola
    }
    const line = campaign
      ? `Campaña «${campaign.name}»: ${campaign.state}, prueba ${campaign.current ?? '-'}, trabajador ${campaign.worker.connected ? campaign.worker.id : 'desconectado'}`
      : 'Sin campaña en marcha';
    if (line !== last) log(line);
    last = line;
    if (campaign?.state === 'running' && !campaign.worker.connected) {
      staleSince ??= Date.now();
      if (Date.now() - staleSince > STALE_MS) {
        log('La página no late con la campaña en marcha: se recarga');
        navigate();
        staleSince = null;
      }
    } else {
      staleSince = null;
    }
  }
}

main().catch((e) => {
  console.error(e);
  cleanup();
  setTimeout(() => process.exit(1), 2500);
});
