// WebGPU renderer: shadow (water thickness) pass, HDR MSAA main pass, bloom
// and a tonemapping composite into the canvas.
import {
  SCENE_FLOATS, cubeCode, shadowCubeCode, solidCode, shadowSolidCode, floorCode,
  glassCode, bloomCode, compositeCode,
} from './shaders.js';

const HDR = 'rgba16float';
const DEPTH = 'depth32float';
const BLOOM_LEVELS = 6;
const BALL_VERTS = 48 * 24 * 6;

export class Renderer {
  /**
   * @param {GPUDevice} device
   * @param {HTMLCanvasElement} canvas
   * @param {{ timestamps: boolean }} opts
   */
  constructor(device, canvas, opts = {}) {
    this.device = device;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.width = 0;
    this.height = 0;
    this.sampleCount = 4;
    this.shadowSize = 0;
    this.pipelineCache = new Map();
    this.sceneData = new Float32Array(SCENE_FLOATS);

    this.sceneBuffer = device.createBuffer({
      label: 'scene', size: SCENE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.postBuffer = device.createBuffer({
      label: 'post', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bloomParamBuffer = device.createBuffer({
      label: 'bloom-params', size: 256 * BLOOM_LEVELS * 2, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.linearSampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
    this.pointSampler = device.createSampler({
      magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });

    const V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
    this.mainLayout = device.createBindGroupLayout({
      label: 'main-layout',
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: F, sampler: { type: 'filtering' } },
        { binding: 3, visibility: V | F, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.shadowLayout = device.createBindGroupLayout({
      label: 'shadow-layout',
      entries: [{ binding: 0, visibility: V | F, buffer: { type: 'uniform' } }],
    });
    this.shadowBG = device.createBindGroup({
      layout: this.shadowLayout,
      entries: [{ binding: 0, resource: { buffer: this.sceneBuffer } }],
    });

    this.modules = {
      cube: device.createShaderModule({ label: 'cube', code: cubeCode }),
      shadowCube: device.createShaderModule({ label: 'shadow-cube', code: shadowCubeCode }),
      solid: device.createShaderModule({ label: 'solid', code: solidCode }),
      shadowSolid: device.createShaderModule({ label: 'shadow-solid', code: shadowSolidCode }),
      floor: device.createShaderModule({ label: 'floor', code: floorCode }),
      glass: device.createShaderModule({ label: 'glass', code: glassCode }),
      bloom: device.createShaderModule({ label: 'bloom', code: bloomCode }),
      composite: device.createShaderModule({ label: 'composite', code: compositeCode }),
    };
    this._createStaticPipelines();

    this.timestamps = null;
    if (opts.timestamps) this._initTimestamps();
  }

  _initTimestamps() {
    const d = this.device;
    this.timestamps = {
      querySet: d.createQuerySet({ type: 'timestamp', count: 8 }),
      resolve: d.createBuffer({ size: 64, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      readback: d.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      pending: false,
      result: { sim: 0, shadow: 0, main: 0, post: 0, total: 0 },
      used: false,
    };
  }

  /** Timestamp writes for a pass: index pair 0 = sim, 1 = shadow, 2 = main, 3 = post. */
  tsWrites(slot) {
    if (!this.timestamps) return undefined;
    this.timestamps.used = true;
    return {
      querySet: this.timestamps.querySet,
      beginningOfPassWriteIndex: slot * 2,
      endOfPassWriteIndex: slot * 2 + 1,
    };
  }

  _vertexLayout() {
    return [{
      arrayStride: 32,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'uint32' },
        { shaderLocation: 2, offset: 16, format: 'snorm16x4' },
        { shaderLocation: 3, offset: 24, format: 'unorm16x2' },
      ],
    }];
  }

  _createStaticPipelines() {
    const d = this.device;
    const shadowPL = d.createPipelineLayout({ bindGroupLayouts: [this.shadowLayout] });
    const minMax = {
      color: { operation: 'min', srcFactor: 'one', dstFactor: 'one' },
      alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
    };
    const shadowTarget = [{ format: HDR, blend: minMax }];
    this.shadowCubePipeline = d.createRenderPipeline({
      label: 'shadow-cubes',
      layout: shadowPL,
      vertex: { module: this.modules.shadowCube, entryPoint: 'vsMain', buffers: this._vertexLayout() },
      fragment: { module: this.modules.shadowCube, entryPoint: 'fsMain', targets: shadowTarget },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    this.shadowFramePipeline = d.createRenderPipeline({
      label: 'shadow-frame',
      layout: shadowPL,
      vertex: { module: this.modules.shadowSolid, entryPoint: 'vsFrame' },
      fragment: { module: this.modules.shadowSolid, entryPoint: 'fsFrame', targets: shadowTarget },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    this.shadowBallPipeline = d.createRenderPipeline({
      label: 'shadow-ball',
      layout: shadowPL,
      vertex: { module: this.modules.shadowSolid, entryPoint: 'vsBall' },
      fragment: { module: this.modules.shadowSolid, entryPoint: 'fsBall', targets: shadowTarget },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    // Post-processing.
    this.bloomLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const bloomPL = d.createPipelineLayout({ bindGroupLayouts: [this.bloomLayout] });
    this.bloomDownPipeline = d.createRenderPipeline({
      label: 'bloom-down',
      layout: bloomPL,
      vertex: { module: this.modules.bloom, entryPoint: 'vsFull' },
      fragment: { module: this.modules.bloom, entryPoint: 'fsDown', targets: [{ format: HDR }] },
    });
    this.bloomUpPipeline = d.createRenderPipeline({
      label: 'bloom-up',
      layout: bloomPL,
      vertex: { module: this.modules.bloom, entryPoint: 'vsFull' },
      fragment: {
        module: this.modules.bloom, entryPoint: 'fsUp',
        targets: [{
          format: HDR,
          blend: {
            color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
            alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
          },
        }],
      },
    });
    this.compositeLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.compositePipeline = d.createRenderPipeline({
      label: 'composite',
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module: this.modules.composite, entryPoint: 'vsFull' },
      fragment: { module: this.modules.composite, entryPoint: 'fsMain', targets: [{ format: this.format }] },
    });
  }

  /** Main-pass pipelines depend on the MSAA sample count; cache per count. */
  _mainPipelines(sampleCount) {
    let p = this.pipelineCache.get(sampleCount);
    if (p) return p;
    const d = this.device;
    const layout = d.createPipelineLayout({ bindGroupLayouts: [this.mainLayout] });
    const multisample = { count: sampleCount };
    const opaqueDepth = { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less' };
    const premul = {
      color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const m = this.modules;
    p = {
      cube: d.createRenderPipeline({
        label: 'cubes', layout, multisample,
        vertex: { module: m.cube, entryPoint: 'vsMain', buffers: this._vertexLayout() },
        fragment: { module: m.cube, entryPoint: 'fsMain', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: opaqueDepth,
      }),
      frame: d.createRenderPipeline({
        label: 'frame', layout, multisample,
        vertex: { module: m.solid, entryPoint: 'vsFrame' },
        fragment: { module: m.solid, entryPoint: 'fsMain', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: opaqueDepth,
      }),
      ball: d.createRenderPipeline({
        label: 'ball', layout, multisample,
        vertex: { module: m.solid, entryPoint: 'vsBall' },
        fragment: { module: m.solid, entryPoint: 'fsMain', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: opaqueDepth,
      }),
      floor: d.createRenderPipeline({
        label: 'floor', layout, multisample,
        vertex: { module: m.floor, entryPoint: 'vsFloor' },
        fragment: { module: m.floor, entryPoint: 'fsFloor', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: opaqueDepth,
      }),
      sky: d.createRenderPipeline({
        label: 'sky', layout, multisample,
        vertex: { module: m.floor, entryPoint: 'vsSky' },
        fragment: { module: m.floor, entryPoint: 'fsSky', targets: [{ format: HDR }] },
        depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'less-equal' },
      }),
      glassBack: d.createRenderPipeline({
        label: 'glass-back', layout, multisample,
        vertex: { module: m.glass, entryPoint: 'vsGlass' },
        fragment: { module: m.glass, entryPoint: 'fsGlass', targets: [{ format: HDR, blend: premul }] },
        primitive: { topology: 'triangle-list', cullMode: 'front' },
        depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'less' },
      }),
      glassFront: d.createRenderPipeline({
        label: 'glass-front', layout, multisample,
        vertex: { module: m.glass, entryPoint: 'vsGlass' },
        fragment: { module: m.glass, entryPoint: 'fsGlass', targets: [{ format: HDR, blend: premul }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'less' },
      }),
      cursor: d.createRenderPipeline({
        label: 'cursor', layout, multisample,
        vertex: { module: m.glass, entryPoint: 'vsCursor' },
        fragment: { module: m.glass, entryPoint: 'fsCursor', targets: [{ format: HDR, blend: premul }] },
        depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'always' },
      }),
    };
    this.pipelineCache.set(sampleCount, p);
    return p;
  }

  /** Bind the interact buffer of the current simulation (for the cursor). */
  setInteractBuffer(buffer) {
    this.interactBuffer = buffer;
    this.mainBG = null;
  }

  setShadowSize(size) {
    if (size === this.shadowSize) return;
    this.shadowTex?.destroy();
    this.shadowSize = size;
    this.shadowTex = this.device.createTexture({
      label: 'shadow-map', size: [size, size], format: HDR,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowView = this.shadowTex.createView();
    this.mainBG = null;
  }

  resize(width, height, sampleCount) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height && sampleCount === this.sampleCount && this.hdrTex) return;
    this.width = width;
    this.height = height;
    this.sampleCount = sampleCount;
    this.canvas.width = width;
    this.canvas.height = height;
    const d = this.device;
    for (const t of [this.msaaTex, this.hdrTex, this.depthTex, ...(this.bloomTex || [])]) t?.destroy();
    const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    this.msaaTex = sampleCount > 1
      ? d.createTexture({ label: 'hdr-msaa', size: [width, height], format: HDR, sampleCount, usage: RA })
      : null;
    this.hdrTex = d.createTexture({ label: 'hdr', size: [width, height], format: HDR, usage: RA | TB });
    this.depthTex = d.createTexture({ label: 'depth', size: [width, height], format: DEPTH, sampleCount, usage: RA });
    this.msaaView = this.msaaTex?.createView();
    this.hdrView = this.hdrTex.createView();
    this.depthView = this.depthTex.createView();

    this.bloomTex = [];
    this.bloomViews = [];
    let bw = width, bh = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
      const t = d.createTexture({ label: `bloom-${i}`, size: [bw, bh], format: HDR, usage: RA | TB });
      this.bloomTex.push(t);
      this.bloomViews.push(t.createView());
    }

    // Bloom pass parameters: down passes (source texel size), then up passes.
    const params = new Float32Array(64 * BLOOM_LEVELS * 2);
    const srcSize = (i) => (i < 0 ? [width, height] : [this.bloomTex[i].width, this.bloomTex[i].height]);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const [sw, sh] = srcSize(i - 1);
      params.set([1 / sw, 1 / sh, i === 0 ? 1.0 : 0, 0.6], i * 64);
    }
    for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
      const [sw, sh] = srcSize(i + 1);
      params.set([1 / sw, 1 / sh, 0, 0], (BLOOM_LEVELS + i) * 64);
    }
    d.queue.writeBuffer(this.bloomParamBuffer, 0, params);
    const bloomBG = (slot, view) =>
      d.createBindGroup({
        layout: this.bloomLayout,
        entries: [
          { binding: 0, resource: { buffer: this.bloomParamBuffer, offset: slot * 256, size: 16 } },
          { binding: 1, resource: view },
          { binding: 2, resource: this.linearSampler },
        ],
      });
    this.bloomDownBG = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.bloomDownBG.push(bloomBG(i, i === 0 ? this.hdrView : this.bloomViews[i - 1]));
    }
    this.bloomUpBG = [];
    for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
      this.bloomUpBG.push(bloomBG(BLOOM_LEVELS + i, this.bloomViews[i + 1]));
    }
    this.compositeBG = d.createBindGroup({
      layout: this.compositeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.postBuffer } },
        { binding: 1, resource: this.hdrView },
        { binding: 2, resource: this.bloomViews[0] },
        { binding: 3, resource: this.linearSampler },
      ],
    });
  }

  _ensureMainBG() {
    if (this.mainBG) return;
    this.mainBG = this.device.createBindGroup({
      layout: this.mainLayout,
      entries: [
        { binding: 0, resource: { buffer: this.sceneBuffer } },
        { binding: 1, resource: this.shadowView },
        { binding: 2, resource: this.pointSampler },
        { binding: 3, resource: { buffer: this.interactBuffer } },
      ],
    });
  }

  /**
   * @param {GPUCommandEncoder} encoder
   * @param {object} f frame description (see App.render)
   */
  render(encoder, f) {
    const d = this.device;
    d.queue.writeBuffer(this.sceneBuffer, 0, f.scene);
    const post = new Float32Array([f.exposure, f.bloom ? f.bloomStrength : 0, f.vignette, f.time % 100, this.width / this.height, 0, 0, 0]);
    d.queue.writeBuffer(this.postBuffer, 0, post);
    this._ensureMainBG();
    const P = this._mainPipelines(this.sampleCount);

    // 1. Shadow / water thickness map.
    const shadowPass = encoder.beginRenderPass({
      label: 'shadow',
      colorAttachments: [{ view: this.shadowView, clearValue: [1, 1, 1, 0], loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: this.tsWrites(1),
    });
    if (f.shadows) {
      shadowPass.setBindGroup(0, this.shadowBG);
      shadowPass.setPipeline(this.shadowCubePipeline);
      shadowPass.setVertexBuffer(0, f.instanceBuffer);
      shadowPass.drawIndirect(f.argsBuffer, 16);
      shadowPass.setPipeline(this.shadowFramePipeline);
      shadowPass.draw(36, 13);
      if (f.ballVisible) {
        shadowPass.setPipeline(this.shadowBallPipeline);
        shadowPass.draw(BALL_VERTS);
      }
    }
    shadowPass.end();

    // 2. Main HDR pass.
    const msaa = this.sampleCount > 1;
    const main = encoder.beginRenderPass({
      label: 'main',
      colorAttachments: [{
        view: msaa ? this.msaaView : this.hdrView,
        resolveTarget: msaa ? this.hdrView : undefined,
        clearValue: [0, 0, 0, 1],
        loadOp: 'clear',
        storeOp: msaa ? 'discard' : 'store',
      }],
      depthStencilAttachment: {
        view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard',
      },
      timestampWrites: this.tsWrites(2),
    });
    main.setBindGroup(0, this.mainBG);
    main.setPipeline(P.cube);
    main.setVertexBuffer(0, f.instanceBuffer);
    main.drawIndirect(f.argsBuffer, 16);
    main.setPipeline(P.frame);
    main.draw(36, 13);
    if (f.ballVisible) {
      main.setPipeline(P.ball);
      main.draw(BALL_VERTS);
    }
    main.setPipeline(P.floor);
    main.draw(6);
    main.setPipeline(P.sky);
    main.draw(3);
    if (f.glass) {
      main.setPipeline(P.glassBack);
      main.draw(36);
      main.setPipeline(P.glassFront);
      main.draw(36);
    }
    main.setPipeline(P.cursor);
    main.draw(6);
    main.end();

    // 3. Bloom. Post timing spans the first bloom pass to the end of composite.
    const qs = this.timestamps?.querySet;
    if (f.bloom) {
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: this.bloomViews[i], loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          timestampWrites: qs && i === 0 ? { querySet: qs, beginningOfPassWriteIndex: 6 } : undefined,
        });
        pass.setPipeline(this.bloomDownPipeline);
        pass.setBindGroup(0, this.bloomDownBG[i]);
        pass.draw(3);
        pass.end();
      }
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: this.bloomViews[i], loadOp: 'load', storeOp: 'store' }],
        });
        pass.setPipeline(this.bloomUpPipeline);
        pass.setBindGroup(0, this.bloomUpBG[i]);
        pass.draw(3);
        pass.end();
      }
    }

    // 4. Composite to the canvas.
    let compTs;
    if (qs) compTs = f.bloom ? { querySet: qs, endOfPassWriteIndex: 7 } : this.tsWrites(3);
    const comp = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1],
      }],
      timestampWrites: compTs,
    });
    comp.setPipeline(this.compositePipeline);
    comp.setBindGroup(0, this.compositeBG);
    comp.draw(3);
    comp.end();

    if (this.timestamps && this.timestamps.used && !this.timestamps.pending) {
      encoder.resolveQuerySet(this.timestamps.querySet, 0, 8, this.timestamps.resolve, 0);
      encoder.copyBufferToBuffer(this.timestamps.resolve, 0, this.timestamps.readback, 0, 64);
      this.timestamps.pending = true;
      this._tsToRead = true;
    }
  }

  /** Call after queue.submit to collect GPU timings asynchronously. */
  afterSubmit() {
    const t = this.timestamps;
    if (!t || !this._tsToRead) return;
    this._tsToRead = false;
    t.readback.mapAsync(GPUMapMode.READ).then(() => {
      const v = new BigInt64Array(t.readback.getMappedRange());
      const ms = (a, b) => {
        const dt = Number(v[b] - v[a]) / 1e6;
        return dt > 0 && dt < 1000 ? dt : 0;
      };
      const r = t.result;
      const k = 0.2;
      r.sim = r.sim + (ms(0, 1) - r.sim) * k;
      r.shadow = r.shadow + (ms(2, 3) - r.shadow) * k;
      r.main = r.main + (ms(4, 5) - r.main) * k;
      r.post = r.post + (ms(6, 7) - r.post) * k;
      r.total = r.sim + r.shadow + r.main + r.post;
      t.readback.unmap();
      t.pending = false;
    }).catch(() => { t.pending = false; });
  }
}
