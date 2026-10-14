// GPU MLS-MPM fluid simulation driver: owns buffers and compute pipelines and
// encodes one frame of simulation work (picking, tools, N substeps).
import {
  WG, blockClearCode, blockCountCode, blockScanCode, blockScatterCode, p2gMassCode, p2gCode,
  gridUpdateCode, g2pCode, pickCode, brushCode, emitCode, drainMarkCode, drainHolesCode,
  drainFillCode, argsCode, surfaceCode, p2gMassDirectCode, p2gDirectCode, g2pTiledCode,
} from './shaders.js';

export const PARTICLE_FLOATS = 24; // 96 bytes
export const INSTANCE_BYTES = 32;
const PARAM_STRIDE = 256;          // uniform offset alignment per substep block
const PARAM_SIZE = 240;
export const MAX_SUBSTEPS = 8;
const FRAME_PARAM_BYTES = 192;
const BLOCK = 4;                   // particle binning block size (cells)

export const BRUSH = { none: 0, push: 1, splash: 2, vortex: 3, magnet: 4, repel: 5, pour: 6, drain: 7 };

// Binding numbers shared by all per-substep shaders (see shaders.js).
const B = {
  params: 0, particles: 1, grid: 2, gridV: 3, counts: 4, instances: 5, interact: 6, surface: 7,
  blockCounts: 8, blockStart: 9, keys: 10, sortedIdx: 11,
};

export class FluidSim {
  /**
   * @param {GPUDevice} device
   * @param {{ gridRes: number[], capacity: number, margin: number }} opts
   */
  constructor(device, opts) {
    this.device = device;
    this.gridRes = opts.gridRes;
    this.margin = opts.margin;
    this.capacity = opts.capacity;
    this.cellCount = this.gridRes[0] * this.gridRes[1] * this.gridRes[2];
    this.blocks = this.gridRes.map((n) => Math.ceil(n / BLOCK));
    this.blockCount = this.blocks[0] * this.blocks[1] * this.blocks[2];
    this.restDensity = 8;
    this.spacing = 0.5;
    this.radius = this.spacing * 0.5;
    this.wallMin = [this.margin, this.margin, this.margin];
    this.wallMax = this.gridRes.map((n) => n - this.margin);
    this.frameSeed = 1;
    this.countCPU = 0;
    this.tiled = true; // shared-memory P2G (see shaders.js)
    this._readPending = false;
    this._createBuffers();
    this._createPipelines();
  }

  _createBuffers() {
    const d = this.device;
    const S = GPUBufferUsage;
    const make = (label, size, usage = S.STORAGE) => d.createBuffer({ label, size, usage });
    this.particleBuffer = make('particles', this.capacity * PARTICLE_FLOATS * 4, S.STORAGE | S.COPY_DST | S.COPY_SRC);
    this.instanceBuffer = make('instances', this.capacity * INSTANCE_BYTES, S.STORAGE | S.VERTEX | S.COPY_DST);
    this.gridBuffer = make('grid-atomic', this.cellCount * 16, S.STORAGE | S.COPY_DST);
    this.gridVBuffer = make('grid-velocity', this.cellCount * 16, S.STORAGE | S.COPY_DST);
    this.countsBuffer = make('counts', 16, S.STORAGE | S.COPY_DST | S.COPY_SRC);
    this.argsBuffer = make('indirect-args', 32, S.STORAGE | S.INDIRECT | S.COPY_DST);
    this.interactBuffer = make('interact', 48, S.STORAGE | S.COPY_DST);
    this.surfaceBuffer = make('surface', this.gridRes[0] * this.gridRes[2] * 4, S.STORAGE | S.COPY_DST | S.COPY_SRC);
    this.holesBuffer = make('holes', this.capacity * 4);
    this.blockCountsBuffer = make('block-counts', this.blockCount * 4);
    this.blockStartBuffer = make('block-start', this.blockCount * 4);
    this.keysBuffer = make('sort-keys', this.capacity * 4);
    this.sortedBuffer = make('sorted-index', this.capacity * 4);
    this.simParamsBuffer = make('sim-params', PARAM_STRIDE * MAX_SUBSTEPS, S.UNIFORM | S.COPY_DST);
    this.frameParamsBuffer = make('frame-params', FRAME_PARAM_BYTES, S.UNIFORM | S.COPY_DST);
    this.readbackBuffer = make('count-readback', 16, S.MAP_READ | S.COPY_DST);

    this.simParamsData = new ArrayBuffer(PARAM_STRIDE * MAX_SUBSTEPS);
    this.frameParamsData = new ArrayBuffer(FRAME_PARAM_BYTES);

    // Interact: tBits = FLT_MAX, everything else zero.
    const init = new Uint32Array(12);
    init[0] = 0x7f7fffff;
    d.queue.writeBuffer(this.interactBuffer, 0, init);
  }

  _createPipelines() {
    const d = this.device;
    const make = (label, code) =>
      d.createComputePipeline({
        label,
        layout: 'auto',
        compute: { module: d.createShaderModule({ label, code }), entryPoint: 'main' },
      });
    const buffers = {
      [B.particles]: this.particleBuffer, [B.grid]: this.gridBuffer, [B.gridV]: this.gridVBuffer,
      [B.counts]: this.countsBuffer, [B.instances]: this.instanceBuffer, [B.interact]: this.interactBuffer,
      [B.surface]: this.surfaceBuffer, [B.blockCounts]: this.blockCountsBuffer,
      [B.blockStart]: this.blockStartBuffer, [B.keys]: this.keysBuffer, [B.sortedIdx]: this.sortedBuffer,
    };
    // Per-substep pipelines get one bind group per substep slot, each binding
    // that slot's parameter block.
    const substep = (label, code, bindings, usesParams = true) => {
      const pipeline = make(label, code);
      const groups = [];
      for (let s = 0; s < MAX_SUBSTEPS; s++) {
        const entries = bindings.map((b) => ({ binding: b, resource: { buffer: buffers[b] } }));
        if (usesParams) {
          entries.unshift({ binding: B.params, resource: { buffer: this.simParamsBuffer, offset: s * PARAM_STRIDE, size: PARAM_SIZE } });
        }
        groups.push(d.createBindGroup({ label: `${label}-${s}`, layout: pipeline.getBindGroupLayout(0), entries }));
      }
      return { pipeline, groups };
    };
    this.passes = {
      blockClear: substep('block-clear', blockClearCode, [B.blockCounts]),
      blockCount: substep('block-count', blockCountCode, [B.particles, B.counts, B.blockCounts, B.keys]),
      blockScan: substep('block-scan', blockScanCode, [B.blockCounts, B.blockStart]),
      blockScatter: substep('block-scatter', blockScatterCode, [B.counts, B.blockStart, B.keys, B.sortedIdx], false),
      p2gMass: substep('p2g-mass', p2gMassCode, [B.particles, B.grid, B.blockCounts, B.blockStart, B.sortedIdx]),
      p2g: substep('p2g', p2gCode, [B.particles, B.grid, B.blockCounts, B.blockStart, B.sortedIdx]),
      grid: substep('grid-update', gridUpdateCode, [B.grid, B.gridV, B.interact]),
      g2p: substep('g2p', g2pCode, [B.particles, B.gridV, B.counts, B.instances, B.surface]),
      surface: substep('surface', surfaceCode, [B.gridV, B.surface]),
      p2gMassDirect: substep('p2g-mass-direct', p2gMassDirectCode, [B.particles, B.grid, B.counts]),
      p2gDirect: substep('p2g-direct', p2gDirectCode, [B.particles, B.grid, B.counts]),
      g2pTiled: substep('g2p-tiled', g2pTiledCode, [B.particles, B.gridV, B.instances, B.surface, B.blockCounts, B.blockStart, B.sortedIdx]),
    };

    // Once-per-frame pipelines (frame parameters).
    const frame = (label, code, entries) => {
      const pipeline = make(label, code);
      const group = d.createBindGroup({
        label,
        layout: pipeline.getBindGroupLayout(0),
        entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
      });
      return { pipeline, group };
    };
    const F = this.frameParamsBuffer;
    this.framePasses = {
      pick: frame('pick', pickCode, [[0, F], [1, this.particleBuffer], [2, this.interactBuffer], [3, this.countsBuffer]]),
      brush: frame('brush', brushCode, [[0, F], [1, this.interactBuffer]]),
      emit: frame('emit', emitCode, [
        [0, F], [1, this.particleBuffer], [2, this.countsBuffer], [3, this.instanceBuffer], [4, this.interactBuffer],
      ]),
      drainMark: frame('drain-mark', drainMarkCode, [[0, F], [1, this.particleBuffer], [2, this.countsBuffer], [3, this.interactBuffer]]),
      drainHoles: frame('drain-holes', drainHolesCode, [[1, this.particleBuffer], [2, this.countsBuffer], [3, this.holesBuffer]]),
      drainFill: frame('drain-fill', drainFillCode, [
        [1, this.particleBuffer], [2, this.countsBuffer], [3, this.holesBuffer], [4, this.instanceBuffer],
      ]),
      args: frame('args', argsCode, [[0, F], [1, this.countsBuffer], [2, this.argsBuffer]]),
    };
  }

  /** Replace all particles. `data` holds PARTICLE_FLOATS floats per particle. */
  setParticles(data, count) {
    const d = this.device;
    count = Math.min(count, this.capacity);
    if (count > 0) d.queue.writeBuffer(this.particleBuffer, 0, data.buffer, data.byteOffset, count * PARTICLE_FLOATS * 4);
    // Instances are rewritten by the first G2P; seed them anyway so a paused
    // reset still renders.
    const inst = new ArrayBuffer(Math.max(count, 1) * INSTANCE_BYTES);
    const f = new Float32Array(inst);
    const u = new Uint32Array(inst);
    const snorm = (a, b) => ((Math.round(a * 32767) & 0xffff) | ((Math.round(b * 32767) & 0xffff) << 16)) >>> 0;
    for (let i = 0; i < count; i++) {
      const s = i * PARTICLE_FLOATS, o = i * 8;
      f[o] = data[s]; f[o + 1] = data[s + 1]; f[o + 2] = data[s + 2];
      const dye = Math.round(Math.min(1, Math.max(0, data[s + 7])) * 255);
      u[o + 3] = (dye << 8) | (128 << 16);
      u[o + 4] = snorm(data[s + 20], data[s + 21]);
      u[o + 5] = snorm(data[s + 22], data[s + 23]);
      u[o + 6] = 0;
      u[o + 7] = 0;
    }
    if (count > 0) d.queue.writeBuffer(this.instanceBuffer, 0, inst, 0, count * INSTANCE_BYTES);
    d.queue.writeBuffer(this.countsBuffer, 0, new Uint32Array([count, 0, 0, 0]));
    const wg = Math.ceil(count / WG);
    d.queue.writeBuffer(this.argsBuffer, 0, new Uint32Array([wg, 1, 1, 0, 18, count, 0, 0]));
    // Clear grid state so a reset starts from a clean slate.
    const enc = d.createCommandEncoder();
    enc.clearBuffer(this.gridBuffer);
    enc.clearBuffer(this.gridVBuffer);
    enc.clearBuffer(this.surfaceBuffer);
    d.queue.submit([enc.finish()]);
    this.countCPU = count;
  }

  /**
   * Encode one frame of simulation.
   * @param {GPUCommandEncoder} encoder
   * @param {object} frame { substeps: SimParams[], pointer, emit, drain }
   * @param {GPUComputePassTimestampWrites} [timestampWrites]
   */
  encode(encoder, frame, timestampWrites) {
    const d = this.device;
    const n = Math.min(frame.substeps.length, MAX_SUBSTEPS);
    for (let s = 0; s < Math.max(n, 1); s++) this._packSimParams(s, frame.substeps[s] || frame.substeps[0] || this._lastParams);
    if (frame.substeps.length) this._lastParams = frame.substeps[frame.substeps.length - 1];
    d.queue.writeBuffer(this.simParamsBuffer, 0, this.simParamsData, 0, Math.max(n, 1) * PARAM_STRIDE);
    const compacted = !!(frame.drain && frame.pointer?.pressed);
    this._packFrameParams(frame, compacted);
    d.queue.writeBuffer(this.frameParamsBuffer, 0, this.frameParamsData);

    const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : undefined);
    const run = (p, groups) => {
      pass.setPipeline(p.pipeline);
      pass.setBindGroup(0, p.group);
      if (groups === 'indirect') pass.dispatchWorkgroupsIndirect(this.argsBuffer, 0);
      else pass.dispatchWorkgroups(groups);
    };
    const FP = this.framePasses;

    // Pointer picking + brush state (always, so the cursor ring can follow).
    run(FP.pick, 'indirect');
    run(FP.brush, 1);

    let argsDirty = false;
    if (frame.emit && frame.emit.count > 0) {
      run(FP.emit, Math.ceil(frame.emit.count / 64));
      argsDirty = true;
    }
    if (compacted) {
      run(FP.drainMark, 'indirect');
      run(FP.drainHoles, 'indirect');
      run(FP.drainFill, 'indirect');
      argsDirty = true;
    }
    if (argsDirty) run(FP.args, 1);

    const P = this.passes;
    // Debug profiling: split every stage into its own timestamped pass.
    const prof = this.profiler;
    let profPass = null;
    const step = (p, s, groups, stage) => {
      let target = pass;
      if (prof) {
        const q = prof.next++;
        profPass = encoder.beginComputePass({ timestampWrites: { querySet: prof.querySet, beginningOfPassWriteIndex: q * 2, endOfPassWriteIndex: q * 2 + 1 } });
        prof.labels[q] = stage;
        target = profPass;
      }
      target.setPipeline(p.pipeline);
      target.setBindGroup(0, p.groups[s]);
      if (groups === 'indirect') target.dispatchWorkgroupsIndirect(this.argsBuffer, 0);
      else target.dispatchWorkgroups(groups);
      if (prof) profPass.end();
    };
    if (prof) { pass.end(); prof.next = 0; prof.labels = []; }
    const gridGroups = Math.ceil(this.cellCount / WG);
    const blockGroups = Math.ceil(this.blockCount / WG);
    for (let s = 0; s < n; s++) {
      if (this.tiled) {
        // Bin particles into blocks, then splat each block through a shared tile.
        step(P.blockClear, s, blockGroups, 'sort');
        step(P.blockCount, s, 'indirect', 'sort');
        step(P.blockScan, s, 1, 'sort');
        step(P.blockScatter, s, 'indirect', 'sort');
        step(P.p2gMass, s, this.blockCount, 'p2gMass');
        step(P.p2g, s, this.blockCount, 'p2g');
      } else {
        step(P.p2gMassDirect, s, 'indirect', 'p2gMass');
        step(P.p2gDirect, s, 'indirect', 'p2g');
      }
      step(P.grid, s, gridGroups, 'grid');
      if (this.tiled) step(P.g2pTiled, s, this.blockCount, 'g2p');
      else step(P.g2p, s, 'indirect', 'g2p');
    }
    // Refresh the surface height map (read by next frame's G2P for depth).
    if (n > 0) step(P.surface, n - 1, Math.ceil((this.gridRes[0] * this.gridRes[2]) / WG), 'surface');
    if (!prof) pass.end();
    if (prof && !prof.pending) {
      encoder.resolveQuerySet(prof.querySet, 0, prof.next * 2, prof.resolve, 0);
      encoder.copyBufferToBuffer(prof.resolve, 0, prof.readback, 0, prof.next * 16);
      prof.pending = true;
      const count = prof.next, labels = [...prof.labels];
      prof.collect = async () => {
        await prof.readback.mapAsync(GPUMapMode.READ);
        const t = new BigInt64Array(prof.readback.getMappedRange());
        const out = {};
        for (let q = 0; q < count; q++) {
          const ms = Number(t[q * 2 + 1] - t[q * 2]) / 1e6;
          out[labels[q]] = (out[labels[q]] || 0) + ms;
        }
        prof.readback.unmap();
        prof.pending = false;
        return out;
      };
    }
    this.frameSeed = (this.frameSeed * 1664525 + 1013904223) >>> 0;
  }

  /** Debug: enable per-stage GPU timing (requires timestamp-query). */
  enableProfiler() {
    const d = this.device;
    this.profiler = {
      querySet: d.createQuerySet({ type: 'timestamp', count: 128 }),
      resolve: d.createBuffer({ size: 128 * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      readback: d.createBuffer({ size: 128 * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      pending: false, next: 0, labels: [],
    };
  }

  /** Asynchronously refresh `countCPU` from the GPU (at most one in flight). */
  requestCountReadback(encoder) {
    if (this._readPending) return null;
    this._readPending = true;
    encoder.copyBufferToBuffer(this.countsBuffer, 0, this.readbackBuffer, 0, 16);
    return async () => {
      try {
        await this.readbackBuffer.mapAsync(GPUMapMode.READ);
        this.countCPU = new Uint32Array(this.readbackBuffer.getMappedRange())[0];
        this.readbackBuffer.unmap();
      } catch {
        /* device lost or destroyed */
      }
      this._readPending = false;
    };
  }

  _packSimParams(s, p) {
    const f = new Float32Array(this.simParamsData, s * PARAM_STRIDE, PARAM_SIZE / 4);
    const i = new Int32Array(this.simParamsData, s * PARAM_STRIDE, PARAM_SIZE / 4);
    i[0] = this.gridRes[0]; i[1] = this.gridRes[1]; i[2] = this.gridRes[2]; i[3] = this.cellCount;
    i[56] = this.blocks[0]; i[57] = this.blocks[1]; i[58] = this.blocks[2]; i[59] = this.blockCount;
    f.set(this.wallMin, 4);
    f.set(this.wallMax, 8); f[11] = this.radius;
    if (!p) return;
    f[7] = p.dt;
    f.set(p.gravity, 12); f[15] = p.stiffness;
    f.set(p.angVel, 16); f[19] = this.restDensity;
    f.set(p.angAcc, 20); f[23] = p.viscosity;
    f.set(p.pivot, 24); f[27] = p.maxSpeed;
    f.set(p.ball, 28);
    f.set(p.ballVel, 32);
    f.set(p.paddle, 36);
    f.set(p.brush, 40);
    f.set(p.foam, 44);
    f.set(p.misc, 48);
    f.set(p.misc2, 52);
  }

  _packFrameParams(frame, compacted) {
    const f = new Float32Array(this.frameParamsData);
    const u = new Uint32Array(this.frameParamsData);
    const ptr = frame.pointer;
    f.set(ptr.origin, 0); f[3] = ptr.pickRadius;
    f.set(ptr.dir, 4); f[7] = ptr.pressed ? 1 : 0;
    f.set(ptr.prevOrigin, 8); f[11] = frame.dtSim;
    f.set(ptr.prevDir, 12); f[15] = ptr.depthOffset;
    const e = frame.emit || { pos: [0, 0, 0], radius: 0, vel: [0, 0, 0], thickness: 0, count: 0, dye: 0 };
    f.set(e.pos, 16); f[19] = e.radius;
    f.set(e.vel, 20); f[23] = e.thickness;
    f.set(this.wallMin, 24); f[27] = ptr.fallbackT;
    f.set(this.wallMax, 28); f[31] = this.radius;
    u[32] = e.count; u[33] = this.frameSeed; u[34] = this.capacity; u[35] = ptr.resetDepth ? 1 : 0;
    const dr = frame.drain || { radius: 0, rate: 0 };
    f[36] = dr.radius; f[37] = dr.rate; u[38] = compacted ? 1 : 0; f[39] = this.restDensity;
    f[40] = e.dye; f[41] = ptr.hover ? 1 : 0; f[42] = this.spacing; f[43] = 0;
  }

  destroy() {
    for (const v of Object.values(this)) {
      if (v instanceof GPUBuffer) v.destroy();
    }
  }
}
