// Scripted headless browser session for interaction tests and screenshots.
// Zero dependencies: Chrome DevTools protocol over Node's built-in WebSocket.
//
//   node tools/drive.mjs steps.json [--size 1280x800] [--out dir] [--url ...]
//
// Steps (JSON array), executed in order:
//   { "wait": 1.5 }                                  seconds
//   { "eval": "js expression" }                       result is printed
//   { "click": [x, y] }                               left click
//   { "drag": [[x0, y0], [x1, y1], ...], "duration": 1, "button": "left" }
//   { "key": "e" }                                    key press (DOM key name)
//   { "keyDown": "ArrowLeft" } / { "keyUp": "ArrowLeft" }
//   { "wheel": [x, y, deltaY] }
//   { "shot": "name" }                                PNG into --out
//   { "touch": [[x, y], ...], "duration": 1 }         single-finger touch drag
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const stepsArg = argv[0];
const steps = JSON.parse(stepsArg.trim().startsWith('[') ? stepsArg : readFileSync(stepsArg, 'utf8'));
const url = opt('url', 'http://localhost:5173/');
const [width, height] = opt('size', '1280x800').split('x').map(Number);
const outDir = opt('out', '.');
const mobile = argv.includes('--mobile');
const noGpu = argv.includes('--no-webgpu'); // simulate a browser without WebGPU
mkdirSync(outDir, { recursive: true });
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'watersim-drive-'));
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
  '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, nextId = 1;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
};
const mouse = (type, x, y, button = 'left', buttons = 0, clickCount = 1) =>
  send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount });

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error('Chrome did not start');
}

try {
  ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  if (noGpu) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });",
    });
  }
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (await evaluate('document.body.classList.contains("ready") || document.body.classList.contains("failed")')) break;
  }
  for (const step of steps) {
    if (step.wait) await sleep(step.wait * 1000);
    else if (step.eval) console.log('eval:', JSON.stringify(await evaluate(step.eval)));
    else if (step.click) {
      const [x, y] = step.click;
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, 'left', 1);
      await sleep(40);
      await mouse('mouseReleased', x, y, 'left', 0);
    } else if (step.drag) {
      const pts = step.drag;
      const button = step.button || 'left';
      const bmask = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
      const frames = Math.max(2, Math.round((step.duration || 1) * 60));
      await mouse('mouseMoved', pts[0][0], pts[0][1]);
      await mouse('mousePressed', pts[0][0], pts[0][1], button, bmask);
      for (let f = 1; f <= frames; f++) {
        const t = (f / frames) * (pts.length - 1);
        const i = Math.min(pts.length - 2, Math.floor(t));
        const u = t - i;
        const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u;
        const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u;
        await mouse('mouseMoved', x, y, button, bmask);
        await sleep(1000 / 60);
      }
      const last = pts[pts.length - 1];
      await mouse('mouseReleased', last[0], last[1], button, 0);
    } else if (step.touch) {
      const pts = step.touch;
      const frames = Math.max(2, Math.round((step.duration || 1) * 60));
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] });
      for (let f = 1; f <= frames; f++) {
        const t = (f / frames) * (pts.length - 1);
        const i = Math.min(pts.length - 2, Math.floor(t));
        const u = t - i;
        await send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u }],
        });
        await sleep(1000 / 60);
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else if (step.key || step.keyDown || step.keyUp) {
      const key = step.key || step.keyDown || step.keyUp;
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
      const text = key.length === 1 ? key : undefined;
      if (!step.keyUp) await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text });
      if (!step.keyDown) await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
    } else if (step.wheel) {
      const [x, y, dy] = step.wheel;
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
    } else if (step.shot) {
      const img = await send('Page.captureScreenshot', { format: 'png' });
      const file = join(outDir, `${step.shot}.png`);
      writeFileSync(file, Buffer.from(img.data, 'base64'));
      console.log('shot:', file);
    }
  }
  if (logs.length) console.log('console:\n' + logs.slice(0, 40).join('\n'));
} catch (err) {
  console.error('drive failed:', err.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  proc.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
