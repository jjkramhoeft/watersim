// Application core: owns the simulation, renderer, camera and tank, runs the
// frame loop and turns pointer input into tools.
import { mat4, vec3, clamp, damp, rayBox, rayPlane } from './math.js';
import { OrbitCamera } from './camera.js';
import { Tank, MAX_TILT } from './tank.js';
import { FluidSim, BRUSH, MAX_SUBSTEPS } from './sim/fluid.js';
import { buildScene } from './sim/scenes.js';
import { Renderer } from './render/renderer.js';
import {
  TANK, QUALITY, gridForQuality, SCENES, WATER_THEMES, ENVIRONMENTS,
} from './config.js';

const DEG = Math.PI / 180;
const H_PHYS = 1.6;  // the tank "feels" this many metres tall
const G0 = 0.35;     // gravity in grid units at the reference time scale

/** Solver tuning (exposed for experimentation from the console). */
export const TUNE = {
  eps: 0.16,         // tolerated hydrostatic compression at the bottom
  cfl: 0.8,          // acoustic CFL number
  gamma: 1,          // equation-of-state exponent
  minP: -0.005,      // tension clamp (fraction of stiffness)
  maxP: 3,           // pressure clamp (multiple of stiffness)
  foamGain: 0.035,   // foam per unit of excess impact acceleration
  foamImpact: 3.5,   // impact acceleration threshold (cells / unit^2)
  foamSpeed: 2.0,    // spray speed threshold (cells / unit)
  sprayGain: 0.35,
  bulk: 2.0,         // artificial bulk viscosity
  sideGhost: 1,      // mirror-image density at the side walls
  wallFriction: 0.8, // tangential damping of grid nodes behind walls
};
/** Substeps per frame the solver needs for grid resolution n at a frame rate. */
export function substepsFor(n, fps = 60, stiffness = 1) {
  const ups = Math.sqrt((9.81 * n) / (H_PHYS * G0));
  const c = Math.sqrt((G0 * 0.5 * n) / TUNE.eps) * Math.sqrt(stiffness);
  return Math.max(1, Math.ceil(((ups / fps) * c) / TUNE.cfl - 1e-4));
}

const TOOL_INDEX = { push: 0, splash: 1, vortex: 2, magnet: 3, pour: 4, drain: 5, ball: 6, shake: 7 };
const WATER_TOOLS = new Set(['push', 'splash', 'vortex', 'magnet', 'pour', 'drain']);

export class App {
  /**
   * @param {{ device: GPUDevice, canvas: HTMLCanvasElement, store: import('./store.js').Store, timestamps: boolean }} o
   */
  constructor({ device, canvas, store, timestamps }) {
    this.device = device;
    this.canvas = canvas;
    this.store = store;
    this.camera = new OrbitCamera();
    this.tank = new Tank();
    this.renderer = new Renderer(device, canvas, { timestamps });
    this.paused = false;
    this.stepOnce = false;
    this.simTime = 0;
    this.time = 0;
    this.last = performance.now();
    this.dtSmooth = 1 / 60;
    this.stats = { fps: 60, frameMs: 16.7, particles: 0, substeps: 0, gpu: null, renderScale: 1, quality: '' };
    this.fpsAccum = { t: 0, frames: 0 };
    this.renderScaleAuto = 1;
    this.scaleTimer = 0;
    this.substepCap = MAX_SUBSTEPS; // lowered when the GPU can't keep up
    this.listeners = new Set();
    this.pointers = new Map();
    this.pointer = { x: 0, y: 0, over: false, mode: null, justPressed: false, shift: false };
    this.prevRay = null;
    this.keysTilt = { left: false, right: false, up: false, down: false };
    this.deviceTilt = null;
    this.ball = { pos: [0, 0, 0], prev: [0, 0, 0], vel: [0, 0, 0], target: null, dragPlane: null };
    this.paddle = { phase: 0, amp: 0, x: 0, vel: 0 };
    this.splashTimer = 0;
    this.sceneForced = {};
    this.viewInset = { right: 0, bottom: 0 };
    this.running = false;
    this._attachInput();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners) fn(type, data);
  }

  // ------------------------------------------------------------------ setup

  setQuality(q) {
    if (!QUALITY[q]) q = 'medium';
    this.quality = q;
    const g = gridForQuality(q);
    this.grid = g;
    this.sim?.destroy();
    this.sim = new FluidSim(this.device, { gridRes: g.gridRes, capacity: g.capacity, margin: TANK.margin });
    this.renderer.setInteractBuffer(this.sim.interactBuffer);
    this.renderer.setShadowSize(QUALITY[q].shadow);
    const n = g.n;
    this.ups = Math.sqrt((9.81 * n) / (H_PHYS * G0)); // grid time units per real second
    this.soundSpeed = Math.sqrt((G0 * 0.5 * n) / TUNE.eps); // cells / unit
    this.resScale = Math.sqrt(n / 24);                // tool strengths scale with resolution
    this.ballRadius = 0.12 * n;
    this.stats.quality = QUALITY[q].label;
    this.substepCap = MAX_SUBSTEPS;
    this.renderScaleAuto = 1;
    this.loadScene(this.store.get('scene'));
  }

  loadScene(name) {
    const scene = SCENES[name] || SCENES.dambreak;
    const { data, count } = buildScene(scene, this.grid, TANK.margin, this.sim.restDensity);
    this.sim.setParticles(data, count);
    this.stats.particles = count;
    this.tank.reset();
    this.simTime = 0;
    this.paddle = { phase: 0, amp: 0, x: this.sim.wallMin[0], vel: 0 };
    this._resetBall();
    // Scene-specific overrides, reverting the previous scene's overrides.
    const forced = scene.settings || {};
    for (const [k, v] of Object.entries(this.sceneForced)) {
      if (!(k in forced) && this.store.get(k) === v) this.store.set(k, this.store.defaults[k]);
    }
    for (const [k, v] of Object.entries(forced)) this.store.set(k, v);
    this.sceneForced = forced;
    this.emit('scene', name);
  }

  reset() {
    this.loadScene(this.store.get('scene'));
  }

  _resetBall(keepActive = false) {
    const lo = this.sim.wallMin, hi = this.sim.wallMax;
    const p = [lo[0] + (hi[0] - lo[0]) * 0.62, lo[1] + (hi[1] - lo[1]) * 0.82, (lo[2] + hi[2]) / 2];
    const active = keepActive && !!this.ball?.active;
    this.ball = { pos: p, prev: [...p], vel: [0, 0, 0], target: null, dragPlane: null, active, radius: this.ballRadius };
    this._surfaceMap = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      try {
        this.frame(now);
      } catch (err) {
        this.running = false;
        this.emit('error', err);
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  // ------------------------------------------------------------------ frame

  frame(now) {
    const S = this.store.state;
    const dtReal = clamp((now - this.last) / 1000, 0, 0.1);
    this.last = now;
    this.time += dtReal;
    this.frameCount = (this.frameCount || 0) + 1;
    this.dtSmooth += (dtReal - this.dtSmooth) * 0.1;
    this._updateStats(dtReal);
    this._resize(dtReal);

    this.camera.autoRotate = S.autoRotate;
    this.camera.update(dtReal, this.canvas.clientWidth, this.canvas.clientHeight, this.viewInset);

    // How much simulated time this frame covers.
    let seconds = 0;
    // Cap the simulated time per frame: a slow GPU gets mild slow motion
    // instead of a spiral of ever more substeps per frame.
    if (!this.paused) seconds = Math.min(this.dtSmooth, 1 / 45) * S.speed;
    else if (this.stepOnce) seconds = 1 / 60;
    this.stepOnce = false;
    const units = seconds * this.ups;
    const c = this.soundSpeed * Math.sqrt(S.stiffness);
    const k = (c * c * this.sim.restDensity) / TUNE.gamma;
    const dtMax = TUNE.cfl / c;
    let nSub = units > 0 ? Math.ceil(units / dtMax - 1e-4) : 0;
    let dt = nSub ? units / nSub : 0;
    if (nSub > this.substepCap) {
      // Over budget: run fewer full-size substeps (gentle slow motion).
      nSub = this.substepCap;
      dt = dtMax;
    }
    const simUnits = nSub * dt;
    this.stats.substeps = nSub;

    // Ball: dragged kinematically or floating freely (grid space).
    this._localAccel = this._tankAccelGrid();
    this._updateBall(simUnits);

    const tiltGoal = this._tiltGoal();
    const substeps = [];
    for (let s = 0; s < nSub; s++) {
      const dtSec = dt / this.ups;
      this.tank.step(dtSec, tiltGoal);
      this._stepPaddle(dtSec, dt);
      this.simTime += dtSec;
      substeps.push(this._substepParams(s, nSub, dt, k));
    }
    this._updateTransforms();

    const pointer = this._pointerFrame();
    const frame = { substeps, pointer, dtSim: simUnits, emit: null, drain: null };
    const tool = S.tool;
    if (this.pointer.mode === 'tool' && simUnits > 0) {
      if (tool === 'pour') frame.emit = this._emitFrame(simUnits);
      if (tool === 'drain') frame.drain = { radius: this._brushRadius() * 0.85, rate: Math.min(0.5, 0.45 * simUnits) };
    }

    const encoder = this.device.createCommandEncoder();
    this.sim.encode(encoder, frame, this.renderer.tsWrites(0));
    this.renderer.render(encoder, this._renderFrame());
    const readback = this.time - (this._lastRead || 0) > 0.25 ? this.sim.requestCountReadback(encoder) : null;
    const surfaceRead = this._readSurface(encoder);
    this.device.queue.submit([encoder.finish()]);
    surfaceRead?.();
    this.renderer.afterSubmit();
    if (this._shotCallback) {
      // The canvas still holds this frame's texture within the same task.
      const cb = this._shotCallback;
      this._shotCallback = null;
      this.canvas.toBlob(cb, 'image/png');
    }
    if (readback) {
      this._lastRead = this.time;
      readback().then(() => {
        this.stats.particles = this.sim.countCPU;
        const full = this.sim.countCPU >= this.sim.capacity;
        if (full && !this._fullNotified && S.tool === 'pour' && this.pointer.mode === 'tool') this.emit('toast', 'The tank is full');
        this._fullNotified = full;
      });
    }
    this.pointer.justPressed = false;
  }

  _updateStats(dt) {
    const a = this.fpsAccum;
    a.t += dt;
    a.frames++;
    if (a.t >= 0.5) {
      this.stats.fps = a.frames / a.t;
      this.stats.frameMs = (a.t / a.frames) * 1000;
      a.t = 0;
      a.frames = 0;
      const ts = this.renderer.timestamps;
      this.stats.gpu = ts ? { ...ts.result } : null;
      this.emit('stats', this.stats);
    }
  }

  _resize(dt) {
    const S = this.store.state;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Keep the frame rate up on slow GPUs: lower the render resolution when
    // drawing is the bottleneck, shed substeps when the simulation is.
    this.scaleTimer += dt;
    const ts = this.renderer.timestamps?.result;
    const gpu = ts?.total || 0;
    const renderShare = gpu > 0 ? (ts.shadow + ts.main + ts.post) / gpu : 1;
    if (this.scaleTimer > 1.0) {
      // Trust GPU timers when we have them (a throttled background tab has a
      // low frame rate but an idle GPU).
      const slow = gpu > 0 ? gpu > 24 : this.stats.fps < 40;
      const fast = gpu > 0 ? gpu < 12 : this.stats.fps > 57;
      if (slow && S.autoScale && renderShare > 0.4 && this.renderScaleAuto > 0.5) {
        this.renderScaleAuto = Math.max(0.5, this.renderScaleAuto - 0.1);
        this.scaleTimer = 0;
      } else if (slow && this.stats.substeps > 2 && this.substepCap > 2) {
        this.substepCap = this.stats.substeps - 1;
        this.scaleTimer = 0;
      } else if (fast) {
        if (this.substepCap < MAX_SUBSTEPS) this.substepCap++;
        else if (S.autoScale && this.renderScaleAuto < 1) this.renderScaleAuto = Math.min(1, this.renderScaleAuto + 0.05);
        this.scaleTimer = -1;
      }
    }
    if (!S.autoScale) this.renderScaleAuto = 1;
    const scale = S.renderScale * this.renderScaleAuto;
    this.stats.renderScale = scale;
    const w = Math.round(this.canvas.clientWidth * dpr * scale);
    const h = Math.round(this.canvas.clientHeight * dpr * scale);
    this.renderer.resize(w, h, S.msaa ? 4 : 1);
  }

  // ------------------------------------------------------------------ physics inputs

  _tiltGoal() {
    const S = this.store.state;
    let x = S.tiltX * DEG, z = S.tiltZ * DEG;
    if (S.autoRock) {
      z += 11 * DEG * Math.sin(this.simTime * 1.15);
      x += 4 * DEG * Math.sin(this.simTime * 0.71 + 1.3);
    }
    // Screen-relative tilt from arrow keys or the device orientation.
    let sx = 0, sy = 0;
    const kt = this.keysTilt;
    if (kt.left) sx += 1;
    if (kt.right) sx -= 1;
    if (kt.up) sy -= 1;
    if (kt.down) sy += 1;
    sx *= 15 * DEG;
    sy *= 15 * DEG;
    if (this.deviceTilt) {
      sx += this.deviceTilt[0];
      sy += this.deviceTilt[1];
    }
    if (sx || sy) {
      const yaw = this.camera.cur.yaw;
      // "Screen-left down" rotates about the axis pointing at the viewer,
      // "far side down" about the negated screen-right axis.
      const toViewer = [Math.sin(yaw), 0, Math.cos(yaw)];
      const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
      x += toViewer[0] * sx + right[0] * sy;
      z += toViewer[2] * sx + right[2] * sy;
    }
    return [clamp(x, -MAX_TILT, MAX_TILT), clamp(z, -MAX_TILT, MAX_TILT)];
  }

  _stepPaddle(dtSec, dtGrid) {
    const S = this.store.state;
    const p = this.paddle;
    const wallMin = this.sim.wallMin[0];
    const goalAmp = S.waveMachine ? S.waveAmplitude * 0.16 * this.grid.interior[0] : 0;
    p.amp += (goalAmp - p.amp) * damp(1.5, dtSec);
    p.phase += 2 * Math.PI * S.waveFrequency * dtSec;
    const x = wallMin + p.amp * (1 - Math.cos(p.phase)) * 0.5;
    p.vel = dtGrid > 0 ? (x - p.x) / dtGrid : 0;
    p.x = x;
    p.active = p.amp > 0.02;
  }

  _updateBall(units) {
    const S = this.store.state;
    const b = this.ball;
    b.prev = [...b.pos];
    const wasActive = b.active;
    b.active = S.tool === 'ball';
    if (!b.active) {
      b.vel = [0, 0, 0];
      return;
    }
    if (!wasActive) this._resetBall(true);
    const R = this.ballRadius * S.ballSize;
    b.radius = R;
    if (units <= 0) return;
    const lo = this.sim.wallMin.map((v) => v + R);
    const hi = this.sim.wallMax.map((v) => v - R);
    if (b.target) {
      // Dragged: follow the pointer with a speed limit the solver can handle.
      const t = b.target.map((v, i) => clamp(v, lo[i], hi[i]));
      const k = damp(10, units / this.ups);
      const next = b.pos.map((v, i) => v + (t[i] - v) * k);
      const d = vec3.sub(next, b.pos);
      const len = vec3.length(d);
      const maxStep = 0.9 * units;
      const step = len > maxStep ? vec3.scale(d, maxStep / len) : d;
      b.pos = vec3.add(b.pos, step);
      b.vel = vec3.scale(step, 1 / units);
      return;
    }
    // Free: gravity (tank frame), buoyancy from the water height map, drag.
    const g = this._localAccel || [0, -0.35, 0];
    const iters = Math.max(1, Math.ceil(units / 0.1));
    const dt = units / iters;
    for (let it = 0; it < iters; it++) {
      // The ball displaces the water in its own column, so read the level on
      // a ring just outside it.
      const ring = R + 1.5;
      const hx0 = this._surfaceHeight(b.pos[0] - ring, b.pos[2]);
      const hx1 = this._surfaceHeight(b.pos[0] + ring, b.pos[2]);
      const hz0 = this._surfaceHeight(b.pos[0], b.pos[2] - ring);
      const hz1 = this._surfaceHeight(b.pos[0], b.pos[2] + ring);
      const h = (hx0 + hx1 + hz0 + hz1) / 4;
      const depth = clamp(h - (b.pos[1] - R), 0, 2 * R);
      const frac = (depth * depth * (3 * R - depth)) / (4 * R * R * R); // submerged volume fraction
      const buoy = frac / Math.max(0.05, S.ballDensity);
      const a = vec3.scale(g, 1 - buoy);
      // Waves push the ball downhill along the surface.
      if (frac > 0 && frac < 1) {
        a[0] += g[1] * ((hx1 - hx0) / (2 * ring)) * 0.8;
        a[2] += g[1] * ((hz1 - hz0) / (2 * ring)) * 0.8;
      }
      b.vel = vec3.add(b.vel, vec3.scale(a, dt));
      const drag = Math.exp(-(0.015 + 1.4 * frac) * dt);
      b.vel = vec3.scale(b.vel, drag);
      const vmax = 0.9 / Math.max(dt, 0.05);
      const sp = vec3.length(b.vel);
      if (sp > vmax) b.vel = vec3.scale(b.vel, vmax / sp);
      b.pos = vec3.add(b.pos, vec3.scale(b.vel, dt));
      for (let i = 0; i < 3; i++) {
        if (b.pos[i] < lo[i]) { b.pos[i] = lo[i]; if (b.vel[i] < 0) b.vel[i] *= -0.35; }
        if (b.pos[i] > hi[i]) { b.pos[i] = hi[i]; if (b.vel[i] > 0) b.vel[i] *= -0.35; }
      }
    }
  }

  /** Local water surface height (grid units) from the async height-map copy. */
  _surfaceHeight(x, z) {
    const map = this._surfaceMap;
    if (!map) return this.sim.wallMin[1];
    const nx = this.grid.gridRes[0], nz = this.grid.gridRes[2];
    const fx = clamp(x - 0.5, 0, nx - 1.001), fz = clamp(z - 0.5, 0, nz - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const at = (i, k) => map[Math.min(nx - 1, i) + Math.min(nz - 1, k) * nx];
    const a = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * tx;
    const c = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * tx;
    return a + (c - a) * tz;
  }

  /** Keep a CPU copy of the GPU surface height map while the ball is out. */
  _readSurface(encoder) {
    if (!this.ball.active || this._surfacePending) return null;
    const size = this.grid.gridRes[0] * this.grid.gridRes[2] * 4;
    if (!this._surfaceStaging || this._surfaceStaging.size !== size) {
      this._surfaceStaging?.destroy();
      this._surfaceStaging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    const buf = this._surfaceStaging;
    const sim = this.sim;
    encoder.copyBufferToBuffer(sim.surfaceBuffer, 0, buf, 0, size);
    this._surfacePending = true;
    return () => buf.mapAsync(GPUMapMode.READ).then(() => {
      if (this.sim === sim) this._surfaceMap = new Float32Array(buf.getMappedRange().slice(0));
      buf.unmap();
    }).catch(() => {}).finally(() => { this._surfacePending = false; });
  }

  _brushRadius() {
    return this.store.state.brushSize * 0.2 * this.grid.n;
  }

  /** Gravity plus the linear inertial force, in tank-frame grid units. */
  _tankAccelGrid() {
    const tank = this.tank;
    const qInv = quatConj(tank.rotation);
    const toGrid = this.grid.n / (this.ups * this.ups); // world accel -> grid accel
    const gWorld = [0, (-9.81 / H_PHYS) * this.store.state.gravity, 0];
    return vec3.scale(quatRotate(qInv, vec3.sub(gWorld, tank.acc)), toGrid);
  }

  _substepParams(s, nSub, dt, stiffness) {
    const S = this.store.state;
    const tank = this.tank;
    const qInv = quatConj(tank.rotation);
    const accel = this._tankAccelGrid();
    const angVel = vec3.scale(quatRotate(qInv, tank.angularVelocity), 1 / this.ups);
    const angAcc = vec3.scale(quatRotate(qInv, tank.angularAcceleration), 1 / (this.ups * this.ups));
    const pivot = this.grid.gridRes.map((v) => v / 2);

    // Tools.
    let mode = BRUSH.none;
    let strength = 0;
    const tool = S.tool;
    const rs = this.resScale * S.brushStrength;
    if (this.pointer.mode === 'tool') {
      if (tool === 'push') { mode = BRUSH.push; strength = 5.5 * S.brushStrength; }
      else if (tool === 'splash') {
        if (s === 0 && this._splashNow) { mode = BRUSH.splash; strength = 4.2 * rs; }
      }
      else if (tool === 'vortex') { mode = BRUSH.vortex; strength = 2.6 * rs; }
      else if (tool === 'magnet') { mode = this.pointer.shift ? BRUSH.repel : BRUSH.magnet; strength = 2.4 * rs; }
      else if (tool === 'drain') { mode = BRUSH.drain; strength = 1.6 * rs; }
    }
    const radius = tool === 'vortex' ? this._brushRadius() * 1.25 : this._brushRadius();

    const b = this.ball;
    const t = (s + 1) / nSub;
    const ballPos = vec3.lerp(b.prev, b.pos, t);
    const ball = b.active ? [...ballPos, b.radius || this.ballRadius] : [0, 0, 0, 0];
    const ballVel = b.active ? [...b.vel, 0] : [0, 0, 0, 0];

    const p = this.paddle;
    const foamDecay = Math.exp(-(dt / this.ups) / 1.7);
    return {
      dt,
      gravity: accel,
      stiffness,
      angVel,
      angAcc,
      viscosity: S.viscosity,
      pivot,
      maxSpeed: 0.95 / dt,
      ball,
      ballVel,
      paddle: [p.x, p.vel, p.active ? 1 : 0, TUNE.sideGhost],
      brush: [mode, radius, strength, 0],
      foam: [foamDecay, TUNE.foamGain, TUNE.foamImpact * this.resScale, TUNE.foamSpeed * this.resScale],
      misc: [S.tumble ? 1 : 0, 0.05, TUNE.gamma, TUNE.minP * stiffness],
      misc2: [TUNE.maxP * stiffness, TUNE.sprayGain, TUNE.bulk, TUNE.wallFriction],
    };
  }

  _emitFrame(units) {
    const lo = this.sim.wallMin, hi = this.sim.wallMax;
    const n = this.grid.n;
    const r = 0.085 * n;
    const v = 2.4 * this.resScale;
    const rate = Math.PI * r * r * v * this.sim.restDensity * 0.9; // particles per grid unit
    const count = Math.min(4096, Math.round(rate * units));
    // The GPU pours above the cursor's water point; this is the fallback.
    const c = [(lo[0] + hi[0]) / 2, hi[1], (lo[2] + hi[2]) / 2];
    return {
      count,
      pos: [c[0], hi[1] - 1.2 - v * units * 0.5, c[2]],
      radius: r,
      vel: [0, -v, 0],
      thickness: v * units,
      dye: (this.simTime * 0.09) % 1,
    };
  }

  // ------------------------------------------------------------------ transforms

  _updateTransforms() {
    const g = this.grid;
    const center = [this.tank.pos[0], TANK.floatHeight + TANK.size[1] / 2 + this.tank.pos[1], this.tank.pos[2]];
    this.tankCenter = center;
    this.tankQuat = this.tank.rotation;
    this.tankModel = mat4.multiply(mat4.fromTranslation(center), mat4.fromQuat(this.tankQuat));
    const gridCenter = g.gridRes.map((v) => -v / 2);
    this.gridToWorld = mat4.multiply(
      this.tankModel,
      mat4.multiply(mat4.fromScale([g.dx, g.dx, g.dx]), mat4.fromTranslation(gridCenter)),
    );
    this.worldToGrid = mat4.invert(this.gridToWorld);
  }

  _gridRay(px, py) {
    const ndc = [(px / this.canvas.clientWidth) * 2 - 1, 1 - (py / this.canvas.clientHeight) * 2];
    const ray = this.camera.ray(ndc[0], ndc[1]);
    const o = mat4.transformPoint(this.worldToGrid, ray.origin);
    const d = vec3.normalize(mat4.transformDir(this.worldToGrid, ray.dir));
    return { o, d, world: ray };
  }

  _rayHitsTank(px, py, pad = 1) {
    if (!this.worldToGrid) return false;
    const { o, d } = this._gridRay(px, py);
    const lo = this.sim.wallMin.map((v) => v - pad), hi = this.sim.wallMax.map((v) => v + pad);
    return !!rayBox(o, d, lo, hi);
  }

  _pointerFrame() {
    const S = this.store.state;
    const p = this.pointer;
    const { o, d } = this._gridRay(p.x, p.y);
    const prev = this.prevRay || { o, d };
    this.prevRay = { o, d };
    const lo = this.sim.wallMin, hi = this.sim.wallMax;
    const box = rayBox(o, d, lo, hi);
    // Fallback depth when the ray hits no water: a horizontal plane at
    // roughly the water line, else the middle of the ray's span in the tank.
    let fallbackT = 0;
    if (box) {
      const yPlane = lo[1] + (hi[1] - lo[1]) * 0.3;
      const tp = rayPlane(o, d, [0, yPlane, 0], [0, 1, 0]);
      fallbackT = tp && tp > box[0] && tp < box[1] ? tp : (Math.max(box[0], 0) + box[1]) / 2;
    }
    const waterTool = WATER_TOOLS.has(S.tool);
    const pressed = p.mode === 'tool' && waterTool;
    const hover = waterTool && p.over && !p.mode && !!box;
    const R = this._brushRadius();
    let depthOffset = R * 0.35;
    if (S.tool === 'pour' || S.tool === 'vortex') depthOffset = 0;
    if (S.tool === 'splash') depthOffset = R * 0.15;
    // Splash fires on press and repeatedly while held.
    this._splashNow = false;
    if (pressed && S.tool === 'splash') {
      this.splashTimer -= this.dtSmooth;
      if (p.justPressed || this.splashTimer <= 0) {
        this._splashNow = true;
        this.splashTimer = 0.32;
      }
    }
    return {
      origin: o,
      dir: d,
      prevOrigin: prev.o,
      prevDir: prev.d,
      pickRadius: 0.62,
      pressed,
      hover: hover || pressed,
      depthOffset,
      fallbackT,
      resetDepth: p.justPressed,
    };
  }

  _renderFrame() {
    const S = this.store.state;
    const r = this.renderer;
    const env = ENVIRONMENTS[S.env] || ENVIRONMENTS.studio;
    const water = WATER_THEMES[S.water] || WATER_THEMES.ocean;
    const g = this.grid;
    const s = r.sceneData;
    const cam = this.camera;

    // Light: orthographic, fitted around the tank.
    const L = vec3.normalize(env.lightDir);
    const R = Math.hypot(...TANK.size) / 2 + 0.55;
    const c = this.tankCenter;
    const back = R + 2;
    const eye = vec3.sub(c, vec3.scale(L, back));
    const far = back + (c[1] + R) / Math.max(0.2, -L[1]) + 1;
    const lightView = mat4.lookAt(eye, c, Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
    const lightProj = mat4.ortho(-R, R, -R, R, 0.1, far);
    const lightViewProj = mat4.multiply(lightProj, lightView);

    s.set(cam.viewProj, 0);
    s.set(cam.invViewProj, 16);
    s.set(lightViewProj, 32);
    s.set(this.gridToWorld, 48);
    s.set(this.tankModel, 64);
    s.set(this.tankQuat, 80);
    s.set(cam.position, 84); s[87] = this.time;
    s.set(L, 88); s[91] = g.dx * this.sim.radius * S.cubeSize * 1.04;
    s.set(env.sun, 92); s[95] = env.exposure;
    s.set(env.skyTop, 96); s[99] = 0;
    s.set(env.skyHorizon, 100); s[103] = S.shadows ? 1 : 0;
    s.set(env.ground, 104); s[107] = S.floorGrid ? 1 : 0;
    s.set(water.shallow, 108); s[111] = S.colorMode === 'dye' ? 1 : S.colorMode === 'speed' ? 2 : 0;
    s.set(water.deep, 112); s[115] = S.foam ? 1 : 0;
    s.set(water.absorption, 116); s[119] = water.emissive;
    s.set(water.foam, 120); s[123] = 0.05;
    s.set(TANK.size.map((v) => v / 2), 124); s[127] = 0.0095;
    const b = this.ball;
    if (b.active) s.set([...b.pos, b.radius || this.ballRadius], 128); else s.set([0, 0, 0, 0], 128);
    s.set([this.paddle.x, this.paddle.active ? 1 : 0, this.sim.wallMax[1], 1.2], 132);
    const waterTool = WATER_TOOLS.has(S.tool);
    const radius = S.tool === 'vortex' ? this._brushRadius() * 1.25 : this._brushRadius();
    s.set([TOOL_INDEX[S.tool] ?? 0, S.tool === 'pour' ? radius * 0.5 : radius, waterTool ? 1 : 0, 0], 136);
    s.set([far - 0.1, r.shadowSize, 1 / r.shadowSize, 0.0025], 140);
    s.set([r.width, r.height, 1 / r.width, 1 / r.height], 144);
    s.set([g.dx, S.caustics ? 1 : 0, env.fogFar, 1], 148);
    s.set(env.gridColor, 152); s[155] = 0.42;
    s.set(this.sim.wallMin, 156); s[159] = 0;
    s.set(this.sim.wallMax, 160); s[163] = 0;

    return {
      scene: s,
      instanceBuffer: this.sim.instanceBuffer,
      argsBuffer: this.sim.argsBuffer,
      shadows: S.shadows,
      glass: S.glass,
      bloom: S.bloom,
      bloomStrength: water.emissive > 0.5 ? 0.12 : 0.07,
      exposure: env.exposure,
      vignette: 0.32,
      ballVisible: b.active,
      time: this.time,
    };
  }

  /** Debug: read back particles and summarise their state (slow). */
  async debugParticles() {
    const n = this.sim.countCPU;
    const size = n * 96;
    const buf = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.sim.particleBuffer, 0, buf, 0, size);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(buf.getMappedRange());
    const lo = this.sim.wallMin, hi = this.sim.wallMax;
    let sumY = 0, maxV = 0, sumV = 0, high = 0, sumD = 0, sumFoam = 0, nan = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 24;
      const y = (f[o + 1] - lo[1]) / (hi[1] - lo[1]);
      const v = Math.hypot(f[o + 4], f[o + 5], f[o + 6]);
      if (!Number.isFinite(y) || !Number.isFinite(v)) { nan++; continue; }
      sumY += y; sumV += v; maxV = Math.max(maxV, v); sumD += f[o + 11]; sumFoam += f[o + 3];
      if (y > 0.6) high++;
    }
    buf.unmap();
    buf.destroy();
    return {
      n, nan, meanY: sumY / n, fracAbove60: high / n, meanSpeed: sumV / n, maxSpeed: maxV,
      meanDensity: sumD / n / this.sim.restDensity, meanFoam: sumFoam / n, simTime: this.simTime,
    };
  }

  // ------------------------------------------------------------------ actions

  togglePause() {
    this.paused = !this.paused;
    this.emit('paused', this.paused);
  }

  step() {
    this.paused = true;
    this.stepOnce = true;
    this.emit('paused', true);
  }

  earthquake() {
    this.tank.earthquake();
  }

  /** Capture the next rendered frame as a PNG blob. */
  requestScreenshot(cb) {
    this._shotCallback = cb;
  }

  setDeviceTilt(t) {
    this.deviceTilt = t;
  }

  // ------------------------------------------------------------------ input

  _attachInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    c.addEventListener('pointermove', (e) => this._onPointerMove(e));
    c.addEventListener('pointerup', (e) => this._onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    c.addEventListener('pointerleave', () => { if (!this.pointer.mode) this.pointer.over = false; });
    c.addEventListener('pointerenter', () => { this.pointer.over = true; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      // While dragging the ball, the wheel moves it nearer / farther.
      if (this.pointer.mode === 'ball') this.nudgeBallDepth(-delta * 0.0015);
      else this.camera.zoom(Math.exp(delta * 0.0012));
    }, { passive: false });
  }

  _localXY(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _onPointerDown(e) {
    const [x, y] = this._localXY(e);
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x, y, sx: x, sy: y });
    const p = this.pointer;
    p.shift = e.shiftKey;
    if (this.pointers.size === 2) {
      // Second finger: switch to camera gesture.
      this._endMode();
      p.mode = 'gesture';
      this._gesture = this._gestureState();
      return;
    }
    if (this.pointers.size > 2) return;
    p.x = x;
    p.y = y;
    p.over = true;
    const tool = this.store.state.tool;
    if (e.button === 2 && (e.shiftKey || e.ctrlKey)) p.mode = 'pan';
    else if (e.button === 2) p.mode = 'orbit';
    else if (e.button === 1) p.mode = 'pan';
    else if (e.button === 0) {
      const hits = this._rayHitsTank(x, y, tool === 'shake' ? 3 : 1);
      if (!hits) p.mode = 'orbit';
      else if (tool === 'shake') this._beginShake(x, y);
      else if (tool === 'ball') this._beginBall(x, y);
      else {
        p.mode = 'tool';
        p.justPressed = true;
        this.splashTimer = 0;
      }
    }
    this.emit('pointer-mode', p.mode);
  }

  _onPointerMove(e) {
    const [x, y] = this._localXY(e);
    const p = this.pointer;
    p.shift = e.shiftKey;
    const prev = this.pointers.get(e.pointerId);
    if (prev) {
      const dx = x - prev.x, dy = y - prev.y;
      prev.x = x;
      prev.y = y;
      if (p.mode === 'gesture') {
        this._updateGesture();
        return;
      }
      if (p.mode === 'orbit') this.camera.rotate(dx, dy);
      else if (p.mode === 'pan') this.camera.pan(dx, dy);
    }
    p.x = x;
    p.y = y;
    p.over = true;
    if (p.mode === 'shake') this._moveShake(x, y);
    if (p.mode === 'ball') this._moveBall(x, y);
  }

  _onPointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointer.mode === 'gesture') {
      if (this.pointers.size < 2) this.pointer.mode = this.pointers.size === 1 ? 'orbit' : null;
      return;
    }
    if (this.pointers.size === 0) this._endMode();
    if (e.pointerType !== 'mouse') this.pointer.over = false;
  }

  _endMode() {
    const p = this.pointer;
    if (p.mode === 'shake') this.tank.release();
    if (p.mode === 'ball') this.ball.target = null;
    p.mode = null;
    this.emit('pointer-mode', null);
  }

  _gestureState() {
    const pts = [...this.pointers.values()];
    const [a, b] = pts;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
  }

  _updateGesture() {
    const g = this._gestureState();
    const prev = this._gesture;
    if (prev.dist > 0 && g.dist > 0) this.camera.zoom(prev.dist / g.dist);
    this.camera.rotate(g.mid[0] - prev.mid[0], g.mid[1] - prev.mid[1]);
    this._gesture = g;
  }

  _beginShake(x, y) {
    const p = this.pointer;
    const ray = this._gridRay(x, y).world;
    const planeY = this.tankCenter[1];
    const t = rayPlane(ray.origin, ray.dir, [0, planeY, 0], [0, 1, 0]);
    if (t === null) { p.mode = 'orbit'; return; }
    p.mode = 'shake';
    this._shakeStart = vec3.add(ray.origin, vec3.scale(ray.dir, t));
    this._shakeBase = [...this.tank.pos];
  }

  _moveShake(x, y) {
    const ray = this._gridRay(x, y).world;
    const t = rayPlane(ray.origin, ray.dir, [0, this._shakeStart[1], 0], [0, 1, 0]);
    if (t === null) return;
    const hit = vec3.add(ray.origin, vec3.scale(ray.dir, t));
    const off = vec3.add(this._shakeBase, vec3.sub(hit, this._shakeStart));
    this.tank.grab(off);
  }

  _beginBall(x, y) {
    this.pointer.mode = 'ball';
    this.ball.vel = [0, 0, 0];
    // Drag on a camera-facing plane through the ball.
    const ballWorld = mat4.transformPoint(this.gridToWorld, this.ball.pos);
    const ray = this._gridRay(x, y).world;
    const n = vec3.normalize(vec3.sub(this.camera.position, ballWorld));
    this.ball.dragPlane = { p: ballWorld, n };
    this._moveBall(x, y);
  }

  _moveBall(x, y) {
    const plane = this.ball.dragPlane;
    if (!plane) return;
    const ray = this._gridRay(x, y).world;
    const t = rayPlane(ray.origin, ray.dir, plane.p, plane.n);
    if (t === null) return;
    const hit = vec3.add(ray.origin, vec3.scale(ray.dir, t));
    this.ball.target = mat4.transformPoint(this.worldToGrid, hit);
  }

  /** Move the ball's drag plane depth (mouse wheel while dragging the ball). */
  nudgeBallDepth(amount) {
    const plane = this.ball.dragPlane;
    if (!plane) return;
    plane.p = vec3.add(plane.p, vec3.scale(plane.n, amount));
    this._moveBall(this.pointer.x, this.pointer.y);
  }
}

function quatConj(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

function quatRotate(q, v) {
  const u = [q[0], q[1], q[2]];
  const t = vec3.scale(vec3.cross(u, v), 2);
  return vec3.add(vec3.add(v, vec3.scale(t, q[3])), vec3.cross(u, t));
}

