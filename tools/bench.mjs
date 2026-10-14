// Headless WebGPU benchmark / screenshot tool driven over the Chrome DevTools
// protocol. Zero dependencies (uses Node's built-in fetch + WebSocket).
//
//   node tools/bench.mjs [--url http://localhost:5173/] [--seconds 6]
//                        [--size 1280x800] [--shot out.png] [--eval "js"]
//
// The dev server (tools/serve.mjs) must be running.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const url = opt('url', 'http://localhost:5173/');
const seconds = Number(opt('seconds', '6'));
const [width, height] = opt('size', '1280x800').split('x').map(Number);
const shot = opt('shot', '');
const evalBefore = opt('eval', '');
const probes = opt('probes', '').split(',').filter(Boolean).map(Number); // seconds after boot
const probeExpr = opt('probe', 'window.__app.debugParticles()');
const assert = argv.includes('--assert'); // exit non-zero on errors, NaNs or < 30 fps
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'watersim-bench-'));

const proc = spawn(chrome, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not start');
}

let ws, nextId = 1;
const pending = new Map();
const consoleLines = [];
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

try {
  ws = new WebSocket(await cdpTarget());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push('[exception] ' + JSON.stringify(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  // Wait for the app to boot.
  let booted = false;
  for (let i = 0; i < 80 && !booted; i++) {
    await sleep(250);
    booted = await evaluate('document.body.classList.contains("ready")');
  }
  const adapter = await evaluate(`(async () => { const a = await navigator.gpu?.requestAdapter(); return a ? { vendor: a.info?.vendor, arch: a.info?.architecture, desc: a.info?.description } : null })()`);
  if (evalBefore) await evaluate(evalBefore);
  const probeResults = [];
  const t0 = Date.now();
  for (const at of probes) {
    const wait = at * 1000 - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    const r = await evaluate(probeExpr);
    probeResults.push({ at, ...r });
    if (shot) {
      const img = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(shot.replace(/\.png$/, `-${at}s.png`), Buffer.from(img.data, 'base64'));
    }
  }
  await sleep(1500);
  // Measure frame times over the window.
  const result = await evaluate(`(async () => {
    const t = [];
    const end = performance.now() + ${seconds * 1000};
    await new Promise((res) => { const f = (now) => { t.push(now); if (now < end) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
    const avg = d.reduce((a, b) => a + b, 0) / d.length;
    const app = window.__app;
    return {
      fps: 1000 / avg,
      p95ms: d[Math.floor(d.length * 0.95)],
      worstMs: d[d.length - 1],
      failed: document.body.classList.contains('failed'),
      stats: app ? app.stats : null,
    };
  })()`);
  if (shot) {
    const img = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot, Buffer.from(img.data, 'base64'));
  }
  console.log(JSON.stringify({ adapter, ...result, probes: probeResults, console: consoleLines.slice(0, 30) }, null, 2));
  if (assert) {
    const problems = [];
    if (result.failed) problems.push('app reported a failure');
    if (consoleLines.some((l) => l.startsWith('[error]') || l.startsWith('[exception]'))) problems.push('console errors');
    if (result.fps < 30) problems.push(`frame rate ${result.fps.toFixed(1)} < 30`);
    if (probeResults.some((p) => p.nan > 0)) problems.push('NaN particles');
    if (probeResults.some((p) => p.n === 0)) problems.push('no particles');
    if (problems.length) {
      console.error('CHECK FAILED: ' + problems.join(', '));
      process.exitCode = 1;
    } else {
      console.error('CHECK PASSED');
    }
  }
} catch (err) {
  console.error('bench failed:', err.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  proc.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
