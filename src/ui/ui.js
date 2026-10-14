// DOM user interface: toolbar, settings panel, playback dock, help, toasts and
// keyboard shortcuts. Everything binds to the settings store.
import { icon } from './icons.js';
import {
  TOOLS, SCENES, SCENE_ORDER, WATER_THEMES, WATER_ORDER, ENVIRONMENTS, ENV_ORDER,
  QUALITY, QUALITY_ORDER, gridForQuality,
} from '../config.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, children = []) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) el.append(c);
  return el;
};

const TOOL_ICON = { push: 'push', splash: 'splash', vortex: 'vortex', magnet: 'magnet', pour: 'pour', drain: 'drain', ball: 'ball', shake: 'shake' };
const COLOR_MODES = [
  { id: 'theme', label: 'Water' },
  { id: 'dye', label: 'Dye' },
  { id: 'speed', label: 'Speed' },
];

export function initUI(app, store) {
  const ui = new UI(app, store);
  ui.build();
  return ui;
}

class UI {
  constructor(app, store) {
    this.app = app;
    this.store = store;
    this.bindings = new Map(); // key -> [update fns]
  }

  bind(key, fn) {
    if (!this.bindings.has(key)) this.bindings.set(key, []);
    this.bindings.get(key).push(fn);
    fn(this.store.get(key));
  }

  build() {
    const root = $('#ui');
    root.append(
      this.buildBrand(),
      this.buildStats(),
      this.buildToolbar(),
      this.buildPanel(),
      this.buildDock(),
      this.buildHint(),
      this.buildHelp(),
      h('div', { class: 'toasts', id: 'toasts', 'aria-live': 'polite' }),
    );
    this.store.subscribe((key, value) => {
      for (const fn of this.bindings.get(key) || []) fn(value);
      this.onSetting(key, value);
    });
    this.app.on((type, data) => this.onAppEvent(type, data));
    this.attachKeys();
    this.updateHint();
    window.addEventListener('resize', () => this.updateInset());
    this.updateInset();
  }

  // ---------------------------------------------------------------- pieces

  buildBrand() {
    return h('header', { class: 'brand glass' }, [
      h('div', { class: 'logo', html: LOGO_SVG }),
      h('div', { class: 'brand-text' }, [
        h('h1', {}, 'Water Sim'),
        h('p', {}, 'Voxel fluid sandbox'),
      ]),
    ]);
  }

  buildStats() {
    const fps = h('span', { class: 'stat-fps' }, '--');
    const parts = h('span', { class: 'stat-parts' }, '--');
    const el = h('div', { class: 'stats glass', title: 'Frame rate and particle count' }, [
      h('span', { class: 'dot' }),
      fps, h('span', { class: 'stat-unit' }, 'fps'),
      h('span', { class: 'sep' }),
      parts, h('span', { class: 'stat-unit' }, 'cubes'),
    ]);
    this.statsEl = { el, fps, parts };
    this.bind('showStats', (v) => el.classList.toggle('hidden', !v));
    return el;
  }

  buildToolbar() {
    const bar = h('nav', { class: 'toolbar glass', 'aria-label': 'Tools' });
    for (const t of TOOLS) {
      const btn = h('button', {
        class: 'tool',
        'data-tool': t.id,
        'aria-label': `${t.label} (${t.key})`,
        onclick: () => this.store.set('tool', t.id),
      }, [
        h('span', { html: icon(TOOL_ICON[t.id]) }),
        h('span', { class: 'tool-label' }, t.label),
        h('kbd', {}, t.key),
        h('span', { class: 'tip' }, [h('b', {}, t.label), h('span', {}, t.hint)]),
      ]);
      bar.append(btn);
    }
    this.bind('tool', (tool) => {
      for (const b of bar.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
    });
    return bar;
  }

  buildPanel() {
    const tabs = [
      { id: 'scenes', label: 'Scenes', icon: 'scenes', build: () => this.scenesTab() },
      { id: 'physics', label: 'Physics', icon: 'physics', build: () => this.physicsTab() },
      { id: 'look', label: 'Look', icon: 'palette', build: () => this.lookTab() },
      { id: 'perf', label: 'Quality', icon: 'gauge', build: () => this.perfTab() },
    ];
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    const body = h('div', { class: 'panel-body' });
    const pages = {};
    for (const t of tabs) {
      const page = h('section', { class: 'page', role: 'tabpanel', 'data-page': t.id }, t.build());
      pages[t.id] = page;
      body.append(page);
      tabBar.append(h('button', {
        class: 'tab', role: 'tab', 'data-tab': t.id,
        onclick: () => this.showTab(t.id),
      }, [h('span', { html: icon(t.icon) }), h('span', {}, t.label)]));
    }
    const panel = h('aside', { class: 'panel glass', id: 'panel' }, [
      h('div', { class: 'panel-head' }, [
        tabBar,
        h('button', { class: 'icon-btn panel-close', 'aria-label': 'Close panel', html: icon('close'), onclick: () => this.togglePanel(false) }),
      ]),
      body,
    ]);
    this.panel = panel;
    this.pages = pages;
    let tab = 'scenes';
    try { tab = localStorage.getItem('watersim.tab') || 'scenes'; } catch { /* ignore */ }
    this.showTab(pages[tab] ? tab : 'scenes');

    const toggle = h('button', {
      class: 'panel-toggle glass icon-btn', 'aria-label': 'Settings', title: 'Settings',
      html: icon('settings'), onclick: () => this.togglePanel(),
    });
    this.panelToggle = toggle;
    const wide = window.matchMedia('(min-width: 900px)').matches;
    this.togglePanel(wide);
    return h('div', { class: 'panel-wrap' }, [toggle, panel]);
  }

  showTab(id) {
    for (const b of this.panel.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === id);
    for (const [k, p] of Object.entries(this.pages)) p.hidden = k !== id;
    try { localStorage.setItem('watersim.tab', id); } catch { /* ignore */ }
  }

  togglePanel(open) {
    const show = open ?? !this.panel.classList.contains('open');
    this.panel.classList.toggle('open', show);
    this.panelToggle.classList.toggle('active', show);
    document.body.classList.toggle('panel-open', show);
    this.updateInset();
  }

  /** Tell the camera which part of the screen the panel covers. */
  updateInset() {
    const open = this.panel.classList.contains('open');
    const sheet = window.matchMedia('(max-width: 899px)').matches;
    let right = 0, bottom = 0;
    if (open && !sheet) right = this.panel.offsetWidth + 24;
    if (open && sheet) bottom = this.panel.offsetHeight + 8;
    this.app.viewInset = { right, bottom };
  }

  // ---------------------------------------------------------------- tabs

  scenesTab() {
    const grid = h('div', { class: 'scene-grid' });
    for (const id of SCENE_ORDER) {
      const sc = SCENES[id];
      grid.append(h('button', {
        class: 'scene-card', 'data-scene': id,
        onclick: () => {
          this.store.set('scene', id);
          this.app.reset();
          if (window.matchMedia('(max-width: 899px)').matches) this.togglePanel(false);
        },
      }, [
        h('span', { class: 'scene-art', html: scenePictogram(sc) }),
        h('span', { class: 'scene-name' }, sc.label),
        h('span', { class: 'scene-desc' }, sc.desc),
      ]));
    }
    this.bind('scene', (s) => {
      for (const c of grid.querySelectorAll('.scene-card')) c.classList.toggle('active', c.dataset.scene === s);
    });
    return [
      grid,
      h('div', { class: 'row-buttons' }, [
        button('reset', 'Restart scene', () => this.app.reset(), 'R'),
        button('quake', 'Earthquake', () => this.app.earthquake(), 'E'),
      ]),
    ];
  }

  physicsTab() {
    return [
      group('Fluid', [
        this.slider('gravity', 'Gravity', 0, 2, 0.01, (v) => (v === 0 ? 'Zero-G' : `${v.toFixed(2)} g`)),
        this.slider('viscosity', 'Viscosity', 0, 3, 0.01, (v) => (v < 0.2 ? 'Water' : v < 1 ? 'Oil' : v < 2 ? 'Syrup' : 'Honey'), { curve: 2 }),
        this.slider('stiffness', 'Incompressibility', 0.5, 2.5, 0.05, (v) => `${v.toFixed(2)}×`, { title: 'Higher is more water-like but needs more substeps' }),
        this.slider('speed', 'Time scale', 0.1, 2, 0.05, (v) => `${v.toFixed(2)}×`),
      ]),
      group('Tank', [
        this.slider('tiltZ', 'Tilt left / right', -18, 18, 0.5, (v) => `${v.toFixed(0)}°`),
        this.slider('tiltX', 'Tilt front / back', -18, 18, 0.5, (v) => `${v.toFixed(0)}°`),
        this.toggle('autoRock', 'Rocking motion', 'Gently rock the tank back and forth'),
        h('div', { class: 'row-buttons' }, [
          button('tilt', 'Level tank', () => { this.store.set('tiltX', 0); this.store.set('tiltZ', 0); }),
          button('quake', 'Earthquake', () => this.app.earthquake(), 'E'),
        ]),
        this.deviceTiltControl(),
      ]),
      group('Wave machine', [
        this.toggle('waveMachine', 'Paddle on', 'A paddle on the left wall pumps waves', 'M'),
        this.slider('waveAmplitude', 'Stroke', 0.1, 1, 0.01, (v) => `${Math.round(v * 100)}%`),
        this.slider('waveFrequency', 'Frequency', 0.2, 1.4, 0.01, (v) => `${v.toFixed(2)} Hz`),
      ]),
      group('Tools', [
        this.slider('brushSize', 'Brush size', 0.4, 2, 0.05, (v) => `${v.toFixed(2)}×`),
        this.slider('brushStrength', 'Brush strength', 0.2, 3, 0.05, (v) => `${v.toFixed(2)}×`),
        this.slider('ballSize', 'Ball size', 0.6, 1.6, 0.05, (v) => `${v.toFixed(2)}×`),
        this.slider('ballDensity', 'Ball density', 0.15, 2, 0.05, (v) => (v < 1 ? `Floats · ${v.toFixed(2)}` : `Sinks · ${v.toFixed(2)}`)),
      ]),
    ];
  }

  lookTab() {
    const water = h('div', { class: 'swatches' });
    for (const id of WATER_ORDER) {
      const t = WATER_THEMES[id];
      water.append(h('button', {
        class: 'swatch', 'data-v': id, title: t.label, 'aria-label': t.label,
        style: `--a:${t.swatch[0]};--b:${t.swatch[1]}`,
        onclick: () => this.store.set('water', id),
      }, h('span', {}, t.label)));
    }
    this.bind('water', (v) => { for (const b of water.children) b.classList.toggle('active', b.dataset.v === v); });

    const env = h('div', { class: 'env-list' });
    for (const id of ENV_ORDER) {
      const e = ENVIRONMENTS[id];
      const top = rgbCss(e.skyTop, 1.8), hor = rgbCss(e.skyHorizon, 1.4), sun = rgbCss(e.sun.map((c) => c / 3), 1);
      env.append(h('button', {
        class: 'env', 'data-v': id,
        style: `--top:${top};--hor:${hor};--sun:${sun}`,
        onclick: () => this.store.set('env', id),
      }, h('span', {}, e.label)));
    }
    this.bind('env', (v) => { for (const b of env.children) b.classList.toggle('active', b.dataset.v === v); });

    return [
      group('Water', [water, this.segmented('colorMode', COLOR_MODES)]),
      group('Lighting', [env]),
      group('Cubes', [
        this.slider('cubeSize', 'Cube size', 0.5, 1.4, 0.01, (v) => `${Math.round(v * 100)}%`),
        this.toggle('tumble', 'Tumbling cubes', 'Cubes spin with the local swirl of the flow'),
        this.toggle('foam', 'Foam & spray', 'Whitewater on impacts and fast spray'),
      ]),
      group('Scene', [
        this.toggle('shadows', 'Shadows & light absorption'),
        this.toggle('caustics', 'Caustics'),
        this.toggle('glass', 'Glass walls'),
        this.toggle('bloom', 'Bloom'),
        this.toggle('floorGrid', 'Floor grid'),
        this.toggle('autoRotate', 'Orbit camera'),
      ]),
    ];
  }

  perfTab() {
    const opts = [{ id: 'auto', label: 'Auto' }, ...QUALITY_ORDER.map((q) => ({ id: q, label: QUALITY[q].label }))];
    const info = h('p', { class: 'note' });
    const updateInfo = () => {
      const q = this.store.get('quality');
      const active = this.app.quality;
      const g = gridForQuality(active);
      const res = g.interior.join(' × ');
      info.textContent = `${q === 'auto' ? `Auto picked ${QUALITY[active].label}. ` : ''}Grid ${res} cells, up to ${(g.capacity / 1000).toFixed(0)}k cubes.`;
    };
    this.updateQualityInfo = updateInfo;
    const gpu = h('div', { class: 'gpu-bars' });
    this.gpuEl = gpu;
    return [
      group('Simulation quality', [
        this.segmented('quality', opts, { wrap: true }),
        info,
      ]),
      group('Rendering', [
        this.slider('renderScale', 'Resolution', 0.4, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
        this.toggle('autoScale', 'Adaptive resolution', 'Lowers resolution when the frame rate drops'),
        this.toggle('msaa', 'Anti-aliasing (4× MSAA)'),
        this.toggle('showStats', 'Show frame rate'),
      ]),
      group('GPU time per frame', [gpu, h('p', { class: 'note', id: 'adapter-note' }, '')]),
    ];
  }

  deviceTiltControl() {
    if (!('DeviceOrientationEvent' in window) || !matchMedia('(pointer: coarse)').matches) return null;
    let on = false;
    let base = null;
    const handler = (e) => {
      if (e.beta == null || e.gamma == null) return;
      if (!base) base = [e.beta, e.gamma];
      const k = Math.PI / 180;
      const sx = clampN(-(e.gamma - base[1]) * 0.7, -18, 18) * k;
      const sy = clampN((e.beta - base[0]) * 0.7, -18, 18) * k;
      this.app.setDeviceTilt([sx, sy]);
    };
    const btn = button('phone', 'Tilt with device', async () => {
      on = !on;
      if (on) {
        try {
          if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            const r = await DeviceOrientationEvent.requestPermission();
            if (r !== 'granted') throw new Error('denied');
          }
          base = null;
          window.addEventListener('deviceorientation', handler);
          this.toast('Tilt your device to slosh the water');
        } catch {
          on = false;
          this.toast('Motion access was not granted');
        }
      } else {
        window.removeEventListener('deviceorientation', handler);
        this.app.setDeviceTilt(null);
      }
      btn.classList.toggle('active', on);
    });
    return h('div', { class: 'row-buttons' }, btn);
  }

  // ---------------------------------------------------------------- dock

  buildDock() {
    const play = h('button', { class: 'icon-btn', 'aria-label': 'Pause (Space)', title: 'Pause (Space)', onclick: () => this.app.togglePause() });
    const setPlay = (paused) => {
      play.innerHTML = icon(paused ? 'play' : 'pause');
      play.title = paused ? 'Play (Space)' : 'Pause (Space)';
      play.setAttribute('aria-label', play.title);
      document.body.classList.toggle('paused', paused);
    };
    setPlay(false);
    this.setPlay = setPlay;
    const step = h('button', { class: 'icon-btn', title: 'Step one frame (.)', 'aria-label': 'Step', html: icon('step'), onclick: () => this.app.step() });
    const speeds = h('div', { class: 'speed-chips', role: 'group', 'aria-label': 'Time scale' });
    for (const v of [0.25, 0.5, 1]) {
      speeds.append(h('button', { class: 'chip', 'data-v': v, onclick: () => this.store.set('speed', v) }, `${v}×`));
    }
    this.bind('speed', (s) => { for (const b of speeds.children) b.classList.toggle('active', Number(b.dataset.v) === s); });
    const sep = () => h('span', { class: 'dock-sep' });
    return h('div', { class: 'dock glass' }, [
      play, step, speeds, sep(),
      h('button', { class: 'icon-btn', title: 'Restart scene (R)', 'aria-label': 'Restart scene', html: icon('reset'), onclick: () => this.app.reset() }),
      h('button', { class: 'icon-btn', title: 'Earthquake (E)', 'aria-label': 'Earthquake', html: icon('quake'), onclick: () => this.app.earthquake() }),
      h('button', { class: 'icon-btn wave-btn', title: 'Wave machine (M)', 'aria-label': 'Wave machine', html: icon('wave'), onclick: () => this.store.set('waveMachine', !this.store.get('waveMachine')) }),
      sep(),
      h('button', { class: 'icon-btn', title: 'Screenshot (P)', 'aria-label': 'Screenshot', html: icon('camera'), onclick: () => this.screenshot() }),
      this.buildRecordButton(),
      h('button', { class: 'icon-btn hide-sm', title: 'Fullscreen (F)', 'aria-label': 'Fullscreen', html: icon('fullscreen'), onclick: () => this.fullscreen() }),
      h('button', { class: 'icon-btn', title: 'Help (H)', 'aria-label': 'Help', html: icon('help'), onclick: () => this.toggleHelp() }),
    ]);
  }

  buildRecordButton() {
    const supported = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
    const btn = h('button', {
      class: 'icon-btn record-btn', title: 'Record a video clip (K)', 'aria-label': 'Record video',
      html: icon('record'), onclick: () => this.toggleRecording(),
    });
    const time = h('span', { class: 'rec-time' }, '0:00');
    btn.append(time);
    this.recordBtn = btn;
    this.recordTime = time;
    if (!supported) btn.hidden = true;
    return btn;
  }

  toggleRecording() {
    if (this.recorder) {
      this.recorder.stop();
      return;
    }
    const canvas = document.getElementById('gpu-canvas');
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    let rec;
    try {
      const stream = canvas.captureStream(60);
      rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    } catch {
      this.toast('Video recording is not supported here');
      return;
    }
    const chunks = [];
    const started = performance.now();
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      clearInterval(this.recordTimer);
      this.recorder = null;
      this.recordBtn.classList.remove('recording');
      this.recordBtn.innerHTML = icon('record');
      this.recordBtn.append(this.recordTime);
      const type = rec.mimeType || mimeType || 'video/webm';
      const blob = new Blob(chunks, { type });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `water-sim-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.toast('Video saved');
    };
    rec.start(250);
    this.recorder = rec;
    this.recordBtn.classList.add('recording');
    this.recordBtn.innerHTML = icon('stop');
    this.recordBtn.append(this.recordTime);
    this.recordTime.textContent = '0:00';
    this.recordTimer = setInterval(() => {
      const s = Math.floor((performance.now() - started) / 1000);
      this.recordTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s >= 60) rec.stop(); // keep clips short
    }, 250);
    this.toast('Recording… press again to stop');
  }

  buildHint() {
    this.hintEl = h('div', { class: 'hint' });
    return this.hintEl;
  }

  updateHint() {
    const tool = TOOLS.find((t) => t.id === this.store.get('tool'));
    const touch = matchMedia('(pointer: coarse)').matches;
    const cam = touch ? 'Drag outside the tank or use two fingers to orbit' : 'Drag outside the tank or right-drag to orbit · scroll to zoom';
    this.hintEl.innerHTML = `<span><b>${tool.label}</b> ${tool.hint}</span><span class="hint-cam">${cam}</span>`;
    document.querySelector('.wave-btn')?.classList.toggle('active', this.store.get('waveMachine'));
    // Show the hint for a few seconds, then let the scene breathe.
    this.hintEl.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hintEl.classList.remove('show'), 6500);
  }

  buildHelp() {
    const rows = (list) => list.map(([k, v]) => h('div', { class: 'key-row' }, [h('span', { class: 'keys', html: k }), h('span', {}, v)]));
    const toolRows = TOOLS.map((t) => h('div', { class: 'tool-row' }, [
      h('span', { class: 'tool-ico', html: icon(TOOL_ICON[t.id]) }),
      h('span', {}, [h('b', {}, t.label), h('span', {}, t.hint)]),
      h('kbd', {}, t.key),
    ]));
    const dlg = h('div', { class: 'help-backdrop', hidden: true, onclick: (e) => { if (e.target === dlg) this.toggleHelp(false); } }, [
      h('div', { class: 'help glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Help' }, [
        h('div', { class: 'help-head' }, [
          h('div', {}, [h('h2', {}, 'How to play'), h('p', {}, 'A box of water made of tens of thousands of tiny cubes, simulated live on your GPU.')]),
          h('button', { class: 'icon-btn', 'aria-label': 'Close help', html: icon('close'), onclick: () => this.toggleHelp(false) }),
        ]),
        h('div', { class: 'help-cols' }, [
          h('div', {}, [
            h('h3', {}, 'Tools'),
            ...toolRows,
          ]),
          h('div', {}, [
            h('h3', {}, 'Camera'),
            ...rows([
              ['Drag outside tank', 'Orbit'],
              ['Right-drag', 'Orbit anywhere'],
              ['Shift + right-drag', 'Pan'],
              ['Scroll / pinch', 'Zoom'],
              ['<kbd>0</kbd>', 'Reset camera'],
            ]),
            h('h3', {}, 'Keyboard'),
            ...rows([
              ['<kbd>Space</kbd>', 'Pause / resume'],
              ['<kbd>.</kbd>', 'Step one frame'],
              ['<kbd>R</kbd>', 'Restart scene'],
              ['<kbd>N</kbd>', 'Next scene'],
              ['<kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd>', 'Tilt the tank (hold)'],
              ['<kbd>E</kbd>', 'Earthquake'],
              ['<kbd>M</kbd>', 'Wave machine'],
              ['<kbd>G</kbd>', 'Toggle zero gravity'],
              ['<kbd>C</kbd> / <kbd>V</kbd>', 'Water style / colour mode'],
              ['<kbd>P</kbd> / <kbd>K</kbd>', 'Screenshot / record video'],
              ['<kbd>F</kbd>', 'Fullscreen'],
              ['<kbd>U</kbd>', 'Hide interface'],
            ]),
          ]),
        ]),
      ]),
    ]);
    this.helpEl = dlg;
    return dlg;
  }

  toggleHelp(show) {
    const open = show ?? this.helpEl.hidden;
    this.helpEl.hidden = !open;
  }

  // ---------------------------------------------------------------- controls

  slider(key, label, min, max, step, format, opts = {}) {
    const curve = opts.curve || 1; // >1 gives finer control at the low end
    const toPos = (v) => Math.pow((v - min) / (max - min), 1 / curve);
    const fromPos = (p) => min + Math.pow(p, curve) * (max - min);
    const value = h('output', { class: 'value' });
    const input = h('input', {
      type: 'range', min: 0, max: 1000, step: 1,
      'aria-label': label,
      oninput: () => {
        let v = fromPos(Number(input.value) / 1000);
        v = Math.round(v / step) * step;
        this.store.set(key, Number(v.toFixed(4)));
      },
      ondblclick: () => this.store.set(key, this.store.defaults[key]),
    });
    const row = h('label', { class: 'control slider', title: opts.title || `${label} (double-click to reset)` }, [
      h('span', { class: 'label-row' }, [h('span', { class: 'label' }, label), value]),
      input,
    ]);
    this.bind(key, (v) => {
      input.value = String(Math.round(toPos(clampN(v, min, max)) * 1000));
      value.textContent = format(v);
      input.style.setProperty('--fill', `${toPos(clampN(v, min, max)) * 100}%`);
    });
    return row;
  }

  toggle(key, label, title, shortcut) {
    const input = h('input', { type: 'checkbox', role: 'switch', onchange: () => this.store.set(key, input.checked) });
    const row = h('label', { class: 'control toggle', title: title || label }, [
      h('span', { class: 'label' }, [label, shortcut ? h('kbd', {}, shortcut) : null]),
      input,
      h('span', { class: 'switch', 'aria-hidden': 'true' }),
    ]);
    this.bind(key, (v) => { input.checked = !!v; });
    return row;
  }

  segmented(key, options, opts = {}) {
    const seg = h('div', { class: `segmented${opts.wrap ? ' wrap' : ''}`, role: 'radiogroup' });
    for (const o of options) {
      seg.append(h('button', { 'data-v': o.id, role: 'radio', onclick: () => this.store.set(key, o.id) }, o.label));
    }
    this.bind(key, (v) => {
      for (const b of seg.children) {
        const on = b.dataset.v === v;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on);
      }
    });
    return seg;
  }

  // ---------------------------------------------------------------- reactions

  onSetting(key, value) {
    if (key === 'tool' || key === 'waveMachine') this.updateHint();
    if (key === 'quality') {
      const q = value === 'auto' ? (this.app.autoQuality || 'medium') : value;
      if (q !== this.app.quality) {
        this.app.setQuality(q);
        const g = gridForQuality(q);
        this.toast(`${QUALITY[q].label} quality · ${g.interior.join('×')} grid`);
      }
      this.updateQualityInfo?.();
    }
  }

  onAppEvent(type, data) {
    if (type === 'pointer-mode') {
      document.body.classList.toggle('dragging', data === 'orbit' || data === 'pan' || data === 'shake' || data === 'ball');
    }
    if (type === 'stats') this.updateStats(data);
    if (type === 'paused') this.setPlay(data);
    if (type === 'scene') this.updateQualityInfo?.();
    if (type === 'toast') this.toast(data);
  }

  updateStats(s) {
    const fps = Math.round(s.fps);
    this.statsEl.fps.textContent = fps;
    this.statsEl.parts.textContent = s.particles >= 1000 ? `${(s.particles / 1000).toFixed(s.particles >= 100000 ? 0 : 1)}k` : `${s.particles}`;
    this.statsEl.el.dataset.level = fps >= 50 ? 'good' : fps >= 30 ? 'ok' : 'bad';
    if (this.gpuEl && !this.panel.querySelector('[data-page="perf"]').hidden) {
      if (s.gpu) {
        const g = s.gpu;
        const parts = [['Simulation', g.sim], ['Shadows', g.shadow], ['Scene', g.main], ['Post', g.post]];
        const total = Math.max(g.total, 1e-3);
        this.gpuEl.innerHTML =
          `<div class="gpu-total"><b>${g.total.toFixed(1)} ms</b><span>${s.substeps} substeps · ${Math.round(s.renderScale * 100)}% res</span></div>` +
          `<div class="gpu-stack">${parts.map(([n, v], i) => `<span class="seg s${i}" style="flex-grow:${(v / total).toFixed(3)}"></span>`).join('')}</div>` +
          `<div class="gpu-legend">${parts.map(([n, v], i) => `<span><i class="s${i}"></i>${n} ${v.toFixed(1)}</span>`).join('')}</div>`;
      } else {
        this.gpuEl.innerHTML = `<div class="gpu-total"><b>${s.frameMs.toFixed(1)} ms</b><span>frame time (GPU timers unavailable)</span></div>`;
      }
    }
  }

  toast(text) {
    const box = $('#toasts');
    const t = h('div', { class: 'toast glass' }, text);
    box.append(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 400);
    }, 2600);
  }

  screenshot() {
    this.app.requestScreenshot((blob) => {
      if (!blob) return this.toast('Screenshot failed');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `water-sim-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      this.toast('Screenshot saved');
    });
  }

  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  attachKeys() {
    const tiltKeys = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea, select') && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (tiltKeys[e.key]) {
        this.app.keysTilt[tiltKeys[e.key]] = true;
        e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      const S = this.store;
      if (e.key === ' ') { this.app.togglePause(); e.preventDefault(); }
      else if (e.key === '.') this.app.step();
      else if (k >= '1' && k <= '8') S.set('tool', TOOLS[Number(k) - 1].id);
      else if (k === 'r') this.app.reset();
      else if (k === 'e') this.app.earthquake();
      else if (k === 'm') S.set('waveMachine', !S.get('waveMachine'));
      else if (k === 'g') S.set('gravity', S.get('gravity') === 0 ? 1 : 0);
      else if (k === 'c') S.set('water', cycle(WATER_ORDER, S.get('water')));
      else if (k === 'v') S.set('colorMode', cycle(COLOR_MODES.map((m) => m.id), S.get('colorMode')));
      else if (k === 'n') { S.set('scene', cycle(SCENE_ORDER, S.get('scene'))); this.app.reset(); }
      else if (k === 'h' || e.key === '?') this.toggleHelp();
      else if (k === 'f') this.fullscreen();
      else if (k === 'p') this.screenshot();
      else if (k === 'k') this.toggleRecording();
      else if (k === 'u') document.body.classList.toggle('ui-hidden');
      else if (k === '0' || e.key === 'Home') this.app.camera.reset();
      else if (e.key === 'Escape') { this.toggleHelp(false); }
      else return;
    });
    window.addEventListener('keyup', (e) => {
      if (tiltKeys[e.key]) this.app.keysTilt[tiltKeys[e.key]] = false;
    });
    window.addEventListener('blur', () => {
      for (const k of Object.keys(this.app.keysTilt)) this.app.keysTilt[k] = false;
    });
  }
}

// ------------------------------------------------------------------ helpers

function group(title, children) {
  return h('div', { class: 'group' }, [h('h3', {}, title), ...children.filter(Boolean)]);
}

function button(iconName, label, onclick, shortcut) {
  return h('button', { class: 'btn', onclick, title: shortcut ? `${label} (${shortcut})` : label }, [
    h('span', { html: icon(iconName) }), h('span', {}, label),
  ]);
}

function cycle(list, v) {
  return list[(list.indexOf(v) + 1) % list.length];
}

function clampN(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function rgbCss(c, gain = 1) {
  const s = (x) => Math.round(255 * Math.min(1, Math.pow(Math.max(0, x * gain), 1 / 2.2)));
  return `rgb(${s(c[0])} ${s(c[1])} ${s(c[2])})`;
}

/** Side-view pictogram generated from a scene's regions. */
function scenePictogram(scene) {
  const W = 120, H = 64, pad = 6;
  const sx = (x) => pad + (x / 2) * (W - 2 * pad);
  const sy = (y) => H - pad - y * (H - 2 * pad);
  let shapes = '';
  for (const r of scene.regions) {
    if (r.box) {
      const [a, b] = r.box;
      shapes += `<rect x="${sx(a[0])}" y="${sy(b[1])}" width="${sx(b[0]) - sx(a[0])}" height="${sy(a[1]) - sy(b[1])}" rx="1.5"/>`;
    } else if (r.sphere) {
      const [c, rad] = r.sphere;
      shapes += `<ellipse cx="${sx(c[0])}" cy="${sy(c[1])}" rx="${(rad / 2) * (W - 2 * pad)}" ry="${rad * (H - 2 * pad)}"/>`;
    }
  }
  const paddle = scene.settings?.waveMachine ? `<rect class="paddle" x="${sx(0) + 1}" y="${sy(0.62)}" width="3" height="${sy(0) - sy(0.62)}" rx="1"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5fd4ff"/><stop offset="1" stop-color="#1b5fd1"/></linearGradient></defs><rect class="tank" x="${pad - 2}" y="${pad - 2}" width="${W - 2 * pad + 4}" height="${H - 2 * pad + 4}" rx="3"/><g class="water" fill="url(#wg)">${shapes}</g>${paddle}</svg>`;
}

const LOGO_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7be6ff"/><stop offset="1" stop-color="#2f6bff"/></linearGradient><linearGradient id="lg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2fb6ff"/><stop offset="1" stop-color="#1638b8"/></linearGradient></defs><path d="M20 5 33 12.5v15L20 35 7 27.5v-15Z" fill="url(#lg2)" opacity=".35"/><path d="M7 21.5c4.5-3 8.5-3 13 0s8.5 3 13 0v6L20 35 7 27.5Z" fill="url(#lg1)"/><path d="M20 5 33 12.5v15L20 35 7 27.5v-15Z" fill="none" stroke="#bfefff" stroke-opacity=".8" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 12.5 20 20l13-7.5M20 20v15" fill="none" stroke="#bfefff" stroke-opacity=".35" stroke-width="1.2"/></svg>`;
