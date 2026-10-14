// Entry point: WebGPU initialisation, quality calibration, UI bootstrap and
// error screens.
import { App, TUNE, substepsFor } from './app.js';
import { Store } from './store.js';
import { DEFAULT_SETTINGS, QUALITY, QUALITY_ORDER } from './config.js';
import { initUI } from './ui/ui.js';

const PERSIST = [
  'quality', 'water', 'env', 'colorMode', 'cubeSize', 'tumble', 'foam', 'shadows', 'glass', 'bloom',
  'caustics', 'floorGrid', 'autoRotate', 'renderScale', 'autoScale', 'msaa', 'showStats',
];
const CALIBRATION_KEY = 'watersim.autoQuality.v2';
const FRAME_BUDGET_MS = 15; // GPU time we aim for in the default scene (60 fps with headroom)

async function boot() {
  const canvas = document.getElementById('gpu-canvas');
  if (!navigator.gpu) return fail('no-webgpu');
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    /* handled below */
  }
  if (!adapter) return fail('no-adapter');

  const requiredFeatures = [];
  const timestamps = adapter.features.has('timestamp-query');
  if (timestamps) requiredFeatures.push('timestamp-query');
  const MB = 1024 * 1024;
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1024 * MB),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1024 * MB),
    },
  });
  device.addEventListener('uncapturederror', (e) => console.error('[WebGPU]', e.error?.message || e.error));

  const store = new Store(DEFAULT_SETTINGS, PERSIST);
  const app = new App({ device, canvas, store, timestamps });
  window.__app = app;
  window.__tune = TUNE;

  device.lost.then((info) => {
    app.stop();
    if (info.reason !== 'destroyed') fail('lost', info.message);
  });
  app.on((type, data) => {
    if (type === 'error') {
      console.error(data);
      fail('crash', String(data?.stack || data));
    }
  });

  const wanted = store.get('quality');
  // Calibration results are remembered per GPU.
  const gpuId = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.device, adapter.info?.description].join('|');
  const calibrated = readCalibration(gpuId);
  let initial = wanted === 'auto' ? calibrated || 'medium' : wanted;
  app.autoQuality = initial;
  app.setQuality(initial);
  initUI(app, store);
  app.start();

  if (wanted === 'auto' && !calibrated) {
    setStatus('Tuning for your GPU…');
    const picked = await calibrate(app, timestamps);
    if (picked) {
      try { localStorage.setItem(CALIBRATION_KEY, JSON.stringify({ gpu: gpuId, quality: picked })); } catch { /* ignore */ }
      app.autoQuality = picked;
      if (picked !== app.quality) app.setQuality(picked);
      else app.reset();
    }
  }
  document.body.classList.add('ready');
  canvas.focus({ preventScroll: true });
}

function readCalibration(gpuId) {
  try {
    const c = JSON.parse(localStorage.getItem(CALIBRATION_KEY) || 'null');
    return c && c.gpu === gpuId && QUALITY[c.quality] ? c.quality : null;
  } catch {
    return null;
  }
}

/**
 * Measure the GPU cost of the current (medium) preset for a moment and pick the
 * richest preset that fits the frame budget. Simulation cost scales with the
 * particle count (n^3) times the substeps per frame; rendering roughly with
 * the number of visible cubes.
 */
async function calibrate(app, timestamps) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Only measure while frames are actually being drawn (a background tab
  // renders nothing); give up after a while and keep the default.
  const start = performance.now();
  const startFrames = app.frameCount || 0;
  while ((app.frameCount || 0) - startFrames < 40) {
    if (performance.now() - start > 15000) return null;
    await sleep(100);
  }
  await sleep(300);
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await sleep(90);
    const g = app.renderer.timestamps?.result;
    if (timestamps && g && g.total > 0) {
      samples.push({ simPerStep: g.sim / Math.max(1, app.stats.substeps), render: g.shadow + g.main, post: g.post });
    } else {
      samples.push({ frame: app.stats.frameMs });
    }
  }
  const median = (k) => {
    const v = samples.map((s) => s[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const base = QUALITY[app.quality].n;
  if (timestamps && samples.every((s) => s.simPerStep !== undefined)) {
    const simPerStep = median('simPerStep'), render = median('render'), post = median('post');
    let pick = 'low';
    const estimates = {};
    for (const q of QUALITY_ORDER) {
      const n = QUALITY[q].n;
      const r = n / base;
      const est = simPerStep * Math.pow(r, 3) * substepsFor(n) + render * Math.pow(r, 2.2) + post;
      estimates[q] = +est.toFixed(2);
      if (est <= FRAME_BUDGET_MS) pick = q;
    }
    window.__calibration = { samples, estimates, pick };
    return pick;
  }
  // No GPU timers: fall back to the frame rate.
  return median('frame') < 20 ? app.quality : 'low';
}

function setStatus(text) {
  const el = document.getElementById('intro-status');
  if (el) el.textContent = text;
}

function fail(kind, detail = '') {
  document.body.classList.add('failed', 'ready');
  const el = document.getElementById('fallback');
  if (!el) return;
  const msg = {
    'no-webgpu': ['WebGPU is not available', 'This sandbox simulates the water on your GPU with WebGPU. Open it in a recent Chrome or Edge, Safari 26 or newer, or Firefox 141+ on Windows.'],
    'no-adapter': ['No compatible GPU found', 'Your browser supports WebGPU but could not find a usable graphics adapter. Check that hardware acceleration is enabled.'],
    lost: ['The GPU device was lost', 'This can happen after a driver reset or when the tab sat in the background for a long time. Reload to start again.'],
    crash: ['Something went wrong', 'The simulation hit an unexpected error. Reloading usually fixes it.'],
  }[kind];
  el.querySelector('h2').textContent = msg[0];
  el.querySelector('p').textContent = msg[1];
  el.querySelector('code').textContent = detail;
  el.hidden = false;
}

boot().catch((err) => {
  console.error(err);
  fail('crash', String(err?.stack || err));
});
