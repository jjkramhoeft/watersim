// WGSL compute shaders for the MLS-MPM fluid simulation.
//
// The fluid is simulated in "grid space" of the tank (1 unit = 1 grid cell),
// in the tank's own (possibly moving and rotating) reference frame. Grid nodes
// sit at cell centres. Particle -> grid transfers use fixed-point atomics since
// WGSL has no float atomics.

export const WG = 128; // workgroup size for particle and grid passes

const common = /* wgsl */ `
const WG: u32 = ${WG}u;
const FP: f32 = 1048576.0;          // fixed-point scale for grid atomics
const FLT_MAX_BITS: u32 = 0x7f7fffffu;

struct Particle {
  pos: vec3f,  foam: f32,
  vel: vec3f,  dye: f32,
  c0: vec3f,   density: f32,         // APIC affine matrix C, column-wise
  c1: vec3f,   flags: f32,           // flags > 0.5 => dead (pending removal)
  c2: vec3f,   seed: f32,
  rot: vec4f,                        // visual orientation of the cube (quaternion)
};

struct Instance {
  pos: vec3f,
  packed: u32,                       // unorm8 x4: foam, dye, density, speed
  rot: vec2u,                        // snorm16 x4 quaternion
  extra: u32,                        // unorm16 x2: depth below surface (/32 cells), spare
  pad: u32,
};

fn makeInstance(pos: vec3f, packed: u32, q: vec4f, depth: f32) -> Instance {
  return Instance(pos, packed, vec2u(pack2x16snorm(q.xy), pack2x16snorm(q.zw)),
                  pack2x16unorm(vec2f(clamp(depth / 32.0, 0.0, 1.0), 0.0)), 0u);
}

struct SimParams {
  gridRes: vec3i,  cellCount: i32,
  wallMin: vec3f,  dt: f32,
  wallMax: vec3f,  radius: f32,      // radius = half extent of a particle cube
  gravity: vec3f,  stiffness: f32,   // gravity includes linear inertial accel
  angVel: vec3f,   restDensity: f32,
  angAcc: vec3f,   viscosity: f32,
  pivot: vec3f,    maxSpeed: f32,
  ball: vec4f,                       // xyz centre, w radius (0 = disabled)
  ballVel: vec4f,
  paddle: vec4f,                     // x: position, y: velocity, z: active (full-height piston)
  brush: vec4f,                      // x: mode, y: radius, z: strength
  foam: vec4f,                       // x: decay, y: impact gain, z: impact threshold, w: spray speed threshold
  misc: vec4f,                       // x: tumble, y: align rate, z: eos gamma, w: min pressure
  misc2: vec4f,                      // x: max pressure, y: spray gain, z: bulk viscosity
  blocks: vec4i,                     // particle sort blocks: nx, ny, nz, total
};

struct FrameParams {
  rayOrigin: vec3f,      pickRadius: f32,
  rayDir: vec3f,         pressed: f32,
  prevRayOrigin: vec3f,  dtSim: f32,
  prevRayDir: vec3f,     depthOffset: f32,
  emitPos: vec3f,        emitRadius: f32,
  emitVel: vec3f,        emitThickness: f32,
  wallMin: vec3f,        fallbackT: f32,
  wallMax: vec3f,        radius: f32,
  emitCount: u32, seed: u32, capacity: u32, resetDepth: u32,
  drainRadius: f32, drainRate: f32, compacted: u32, restDensity: f32,
  emitDye: f32, hover: f32, spacing: f32, pad2: f32,
};

struct Interact {
  tBits: u32,
  hasDepth: u32,
  pressed: u32,
  hover: u32,
  center: vec3f, depth: f32,
  vel: vec3f, valid: f32,
};

struct Counts { n: u32, alive: u32, holes: u32, fill: u32 };

fn quatMul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

fn quatToMat(q: vec4f) -> mat3x3f {
  let x = q.x; let y = q.y; let z = q.z; let w = q.w;
  return mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w)),
    vec3f(2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w)),
    vec3f(2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y)));
}

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand3(a: u32, b: u32) -> vec3f {
  let h0 = pcg(a ^ pcg(b));
  let h1 = pcg(h0);
  let h2 = pcg(h1);
  return vec3f(f32(h0 >> 8u), f32(h1 >> 8u), f32(h2 >> 8u)) / 16777216.0;
}
`;

const simBindings = /* wgsl */ `
@group(0) @binding(0) var<uniform> P: SimParams;

fn cellIndex(c: vec3i) -> i32 {
  return c.x + P.gridRes.x * (c.y + P.gridRes.y * c.z);
}

fn bsplineWeights(x: vec3f, w: ptr<function, array<vec3f, 3>>) -> vec3i {
  let base = floor(x);
  let fx = x - base - 0.5;
  (*w)[0] = 0.5 * (0.5 - fx) * (0.5 - fx);
  (*w)[1] = 0.75 - fx * fx;
  (*w)[2] = 0.5 * (0.5 + fx) * (0.5 + fx);
  return vec3i(base);
}
`;

const ghostMassFn = /* wgsl */ `
fn ghostMass(cell: vec3i) -> f32 {
  let lo = vec3i(P.wallMin);
  let hi = vec3i(P.wallMax);
  var m = 0.0;
  let side = P.paddle.w > 0.5;
  if (side && cell.x < lo.x + 2) { m += massAt(vec3i(2 * lo.x - 1 - cell.x, cell.y, cell.z)); }
  if (side && cell.x >= hi.x - 2) { m += massAt(vec3i(2 * hi.x - 1 - cell.x, cell.y, cell.z)); }
  if (cell.y < lo.y + 2) { m += massAt(vec3i(cell.x, 2 * lo.y - 1 - cell.y, cell.z)); }
  if (cell.y >= hi.y - 2) { m += massAt(vec3i(cell.x, 2 * hi.y - 1 - cell.y, cell.z)); }
  if (side && cell.z < lo.z + 2) { m += massAt(vec3i(cell.x, cell.y, 2 * lo.z - 1 - cell.z)); }
  if (side && cell.z >= hi.z - 2) { m += massAt(vec3i(cell.x, cell.y, 2 * hi.z - 1 - cell.z)); }
  return m;
}
`;

const stressFn = /* wgsl */ `
// Equation of state + viscous stress -> APIC affine momentum matrix (mass 1).
fn stressAffine(p: Particle, density: f32) -> mat3x3f {
  let C = mat3x3f(p.c0, p.c1, p.c2);
  let volume = 1.0 / max(density, 0.2 * P.restDensity);
  var pressure = P.stiffness * (pow(max(density, 1e-4) / P.restDensity, P.misc.z) - 1.0);
  pressure = clamp(pressure, P.misc.w, P.misc2.x);
  let strain = C + transpose(C);
  // Artificial bulk viscosity damps the compression ("breathing") modes of the
  // weakly compressible fluid without affecting divergence-free flow.
  let divv = C[0].x + C[1].y + C[2].z;
  let iso = P.misc2.z * divv - pressure;
  let stress = P.viscosity * strain + mat3x3f(iso, 0.0, 0.0, 0.0, iso, 0.0, 0.0, 0.0, iso);
  return (-volume * 4.0 * P.dt) * stress + C;
}
`;

// ---------------------------------------------------------------------------
// Particle binning: particles are bucketed into 4x4x4-cell blocks every
// substep (counting sort) so P2G can accumulate a block's contributions in
// fast workgroup memory and flush each grid node to global memory once.
const blockCommon = /* wgsl */ `
const BS: i32 = 4;                   // block size in cells
const TS: i32 = 6;                   // tile size: block + 1 cell halo on each side
const TN: u32 = 216u;                // TS^3
const PWG: u32 = 128u;               // threads per block workgroup

fn blockOf(x: vec3f) -> u32 {
  let b = clamp(vec3i(floor(x)) / BS, vec3i(0), P.blocks.xyz - 1);
  return u32(b.x + P.blocks.x * (b.y + P.blocks.y * b.z));
}

fn blockOrigin(b: u32) -> vec3i {
  let bi = i32(b);
  let c = vec3i(bi % P.blocks.x, (bi / P.blocks.x) % P.blocks.y, bi / (P.blocks.x * P.blocks.y));
  return c * BS - 1;
}

fn tileIndex(lc: vec3i) -> u32 {
  return u32(lc.x + TS * (lc.y + TS * lc.z));
}

fn inTile(lc: vec3i) -> bool {
  return all(lc >= vec3i(0)) && all(lc < vec3i(TS));
}
`;

export const blockClearCode = common + simBindings + blockCommon + /* wgsl */ `
@group(0) @binding(8) var<storage, read_write> blockCounts: array<u32>;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < u32(P.blocks.w)) { blockCounts[gid.x] = 0u; }
}
`;

export const blockCountCode = common + simBindings + blockCommon + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(4) var<storage, read> counts: Counts;
@group(0) @binding(8) var<storage, read_write> blockCounts: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> keys: array<u32>;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= counts.n) { return; }
  let b = blockOf(particles[i].pos);
  let slot = atomicAdd(&blockCounts[b], 1u);
  keys[i] = (b << 16u) | min(slot, 65535u);
}
`;

// Exclusive prefix sum over the block counts in a single workgroup.
export const blockScanCode = common + simBindings + blockCommon + /* wgsl */ `
@group(0) @binding(8) var<storage, read_write> blockCounts: array<u32>;
@group(0) @binding(9) var<storage, read_write> blockStart: array<u32>;

var<workgroup> sums: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lid: u32) {
  let n = u32(P.blocks.w);
  let chunk = (n + 255u) / 256u;
  let begin = lid * chunk;
  var total = 0u;
  for (var k = 0u; k < chunk; k++) {
    let j = begin + k;
    if (j < n) { total += blockCounts[j]; }
  }
  sums[lid] = total;
  workgroupBarrier();
  // Hillis-Steele inclusive scan of the per-thread sums.
  for (var off = 1u; off < 256u; off = off * 2u) {
    var v = 0u;
    if (lid >= off) { v = sums[lid - off]; }
    workgroupBarrier();
    sums[lid] = sums[lid] + v;
    workgroupBarrier();
  }
  var run = sums[lid] - total;
  for (var k = 0u; k < chunk; k++) {
    let j = begin + k;
    if (j < n) {
      blockStart[j] = run;
      run += blockCounts[j];
    }
  }
}
`;

export const blockScatterCode = common + simBindings + blockCommon + /* wgsl */ `
@group(0) @binding(4) var<storage, read> counts: Counts;
@group(0) @binding(9) var<storage, read_write> blockStart: array<u32>;
@group(0) @binding(10) var<storage, read_write> keys: array<u32>;
@group(0) @binding(11) var<storage, read_write> sortedIdx: array<u32>;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= counts.n) { return; }
  let k = keys[i];
  sortedIdx[blockStart[k >> 16u] + (k & 0xffffu)] = i;
}
`;

// ---------------------------------------------------------------------------
// Particle -> grid, pass 1: scatter particle mass (B-spline weights).
// One workgroup per block; contributions go to a shared tile first.
export const p2gMassCode = common + simBindings + blockCommon + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(8) var<storage, read_write> blockCounts: array<u32>;
@group(0) @binding(9) var<storage, read_write> blockStart: array<u32>;
@group(0) @binding(11) var<storage, read_write> sortedIdx: array<u32>;

var<workgroup> tile: array<atomic<i32>, 216>;
var<workgroup> range: vec2u;

@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let b = wid.x;
  let origin = blockOrigin(b);
  for (var t = lid; t < TN; t += PWG) { atomicStore(&tile[t], 0); }
  if (lid == 0u) { range = vec2u(blockStart[b], blockCounts[b]); }
  let r = workgroupUniformLoad(&range);
  if (r.y == 0u) { return; }

  for (var k = lid; k < r.y; k += PWG) {
    let x = particles[sortedIdx[r.x + k]].pos;
    var w: array<vec3f, 3>;
    let bi = bsplineWeights(x, &w);
    for (var gx = 0; gx < 3; gx++) {
      for (var gy = 0; gy < 3; gy++) {
        let wxy = w[gx].x * w[gy].y;
        for (var gz = 0; gz < 3; gz++) {
          let cell = bi + vec3i(gx - 1, gy - 1, gz - 1);
          let q = i32(wxy * w[gz].z * FP + 0.5);
          let lc = cell - origin;
          if (inTile(lc)) { atomicAdd(&tile[tileIndex(lc)], q); }
          else { atomicAdd(&grid[u32(cellIndex(cell)) * 4u + 3u], q); }
        }
      }
    }
  }
  workgroupBarrier();
  for (var t = lid; t < TN; t += PWG) {
    let v = atomicLoad(&tile[t]);
    if (v != 0) {
      let ti = i32(t);
      let cell = origin + vec3i(ti % TS, (ti / TS) % TS, ti / (TS * TS));
      if (all(cell >= vec3i(0)) && all(cell < P.gridRes)) {
        atomicAdd(&grid[u32(cellIndex(cell)) * 4u + 3u], v);
      }
    }
  }
}
`;

// Particle -> grid, pass 2: gather the current density from the grid mass,
// evaluate the equation of state and scatter momentum + stress impulse.
export const p2gCode = common + simBindings + blockCommon + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(8) var<storage, read_write> blockCounts: array<u32>;
@group(0) @binding(9) var<storage, read_write> blockStart: array<u32>;
@group(0) @binding(11) var<storage, read_write> sortedIdx: array<u32>;

var<workgroup> tileM: array<f32, 216>;
var<workgroup> tileV: array<atomic<i32>, 648>;
var<workgroup> range: vec2u;

fn enc(x: f32) -> i32 { return i32(clamp(x * FP, -2.0e9, 2.0e9)); }

fn massAt(c: vec3i) -> f32 {
  return f32(atomicLoad(&grid[u32(cellIndex(c)) * 4u + 3u])) / FP;
}

` + ghostMassFn + stressFn + /* wgsl */ `
@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let b = wid.x;
  let origin = blockOrigin(b);
  if (lid == 0u) { range = vec2u(blockStart[b], blockCounts[b]); }
  let r = workgroupUniformLoad(&range);
  if (r.y == 0u) { return; }
  for (var t = lid; t < TN; t += PWG) {
    let ti = i32(t);
    let cell = origin + vec3i(ti % TS, (ti / TS) % TS, ti / (TS * TS));
    var m = 0.0;
    if (all(cell >= vec3i(0)) && all(cell < P.gridRes)) { m = massAt(cell); }
    tileM[t] = m;
    atomicStore(&tileV[t * 3u], 0);
    atomicStore(&tileV[t * 3u + 1u], 0);
    atomicStore(&tileV[t * 3u + 2u], 0);
  }
  workgroupBarrier();

  for (var k = lid; k < r.y; k += PWG) {
    let i = sortedIdx[r.x + k];
    let p = particles[i];
    let x = p.pos;
    var w: array<vec3f, 3>;
    let bi = bsplineWeights(x, &w);

    var density = 0.0;
    for (var gx = 0; gx < 3; gx++) {
      for (var gy = 0; gy < 3; gy++) {
        let wxy = w[gx].x * w[gy].y;
        for (var gz = 0; gz < 3; gz++) {
          let cell = bi + vec3i(gx - 1, gy - 1, gz - 1);
          let lc = cell - origin;
          var m = 0.0;
          if (inTile(lc)) { m = tileM[tileIndex(lc)]; } else { m = massAt(cell); }
          // Method of images: near a wall, add the mass of the mirrored node so
          // particles along the glass see the true local density.
          m += ghostMass(cell);
          density += wxy * w[gz].z * m;
        }
      }
    }
    particles[i].density = density;

    let affine = stressAffine(p, density);

    for (var gx = 0; gx < 3; gx++) {
      for (var gy = 0; gy < 3; gy++) {
        let wxy = w[gx].x * w[gy].y;
        for (var gz = 0; gz < 3; gz++) {
          let weight = wxy * w[gz].z;
          let cell = bi + vec3i(gx - 1, gy - 1, gz - 1);
          let dpos = vec3f(cell) + 0.5 - x;
          let mom = weight * (p.vel + affine * dpos);
          let lc = cell - origin;
          if (inTile(lc)) {
            let t = tileIndex(lc) * 3u;
            atomicAdd(&tileV[t], enc(mom.x));
            atomicAdd(&tileV[t + 1u], enc(mom.y));
            atomicAdd(&tileV[t + 2u], enc(mom.z));
          } else {
            let idx = u32(cellIndex(cell)) * 4u;
            atomicAdd(&grid[idx], enc(mom.x));
            atomicAdd(&grid[idx + 1u], enc(mom.y));
            atomicAdd(&grid[idx + 2u], enc(mom.z));
          }
        }
      }
    }
  }
  workgroupBarrier();
  for (var t = lid; t < TN; t += PWG) {
    let ti = i32(t);
    let cell = origin + vec3i(ti % TS, (ti / TS) % TS, ti / (TS * TS));
    if (all(cell >= vec3i(0)) && all(cell < P.gridRes)) {
      let idx = u32(cellIndex(cell)) * 4u;
      let vx = atomicLoad(&tileV[t * 3u]);
      let vy = atomicLoad(&tileV[t * 3u + 1u]);
      let vz = atomicLoad(&tileV[t * 3u + 2u]);
      if (vx != 0) { atomicAdd(&grid[idx], vx); }
      if (vy != 0) { atomicAdd(&grid[idx + 1u], vy); }
      if (vz != 0) { atomicAdd(&grid[idx + 2u], vz); }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Grid update: momentum -> velocity, body + inertial forces, user tools,
// obstacles and tank walls. Also clears the atomic grid for the next substep.
export const gridUpdateCode = common + simBindings + /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> grid: array<i32>;
@group(0) @binding(3) var<storage, read_write> gridV: array<vec4f>;
@group(0) @binding(6) var<storage, read> I: Interact;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let ci = i32(gid.x);
  if (ci >= P.cellCount) { return; }
  let idx = u32(ci) * 4u;
  let m = f32(grid[idx + 3u]) / FP;
  var v = vec3f(f32(grid[idx]), f32(grid[idx + 1u]), f32(grid[idx + 2u])) / FP;
  grid[idx] = 0; grid[idx + 1u] = 0; grid[idx + 2u] = 0; grid[idx + 3u] = 0;
  if (m <= 1e-5) {
    gridV[ci] = vec4f(0.0);
    return;
  }
  v = v / m;

  let nx = P.gridRes.x;
  let ny = P.gridRes.y;
  let coord = vec3i(ci % nx, (ci / nx) % ny, ci / (nx * ny));
  let pos = vec3f(coord) + 0.5;

  // Gravity + fictitious forces of the moving tank frame
  // (linear, Euler, centrifugal and Coriolis).
  let r = pos - P.pivot;
  let acc = P.gravity
    - cross(P.angAcc, r)
    - cross(P.angVel, cross(P.angVel, r))
    - 2.0 * cross(P.angVel, v);
  v += acc * P.dt;

  // Interactive tools.
  let mode = i32(P.brush.x + 0.5);
  if (mode > 0 && I.pressed != 0u && I.valid > 0.5) {
    let d = pos - I.center;
    let R = P.brush.y;
    let S = P.brush.z;
    if (mode == 3) {
      // Vortex: a vertical whirl column.
      let rr = length(d.xz);
      if (rr < R) {
        let q = rr / R;
        let f = (1.0 - q * q) * (1.0 - q * q);
        let rl = max(rr, 0.75);
        let tang = vec3f(-d.z, 0.0, d.x) / rl;
        let inward = -vec3f(d.x, 0.0, d.z) / rl;
        let swirl = tang * S * (0.35 + 0.65 * q) + inward * S * 0.18 + vec3f(0.0, -0.12 * S, 0.0);
        v = mix(v, v + swirl, clamp(f * P.dt * 1.6, 0.0, 1.0));
      }
    } else {
      let dist = length(d);
      if (dist < R) {
        let q = dist / R;
        let f = (1.0 - q * q) * (1.0 - q * q);
        let n = d / max(dist, 1e-3);
        if (mode == 1) {
          // Push: drag the water along with the brush motion.
          let k = clamp(S * f * P.dt, 0.0, 1.0);
          v = mix(v, I.vel, k);
        } else if (mode == 2) {
          // Splash: one-off radial blast with an upward kick.
          v += (n + vec3f(0.0, 0.7, 0.0)) * S * f;
        } else if (mode == 4) {
          // Magnet: pull towards the cursor and calm the blob.
          v += (-n * S * f) * P.dt;
          v *= 1.0 - clamp(0.6 * f * P.dt, 0.0, 0.5);
        } else if (mode == 5) {
          // Repel.
          v += (n * S * f) * P.dt;
        } else if (mode == 7) {
          // Drain: gentle suction into the plughole.
          v += (-n * S * f) * P.dt;
        }
      }
    }
  }

  // Kinematic ball obstacle (separating slip condition).
  if (P.ball.w > 0.0) {
    let d = pos - P.ball.xyz;
    let dist = length(d);
    if (dist < P.ball.w + 0.6) {
      let n = d / max(dist, 1e-4);
      let rel = v - P.ballVel.xyz;
      let vn = dot(rel, n);
      if (vn < 0.0) { v -= vn * n; }
    }
  }

  // Wave-maker paddle (moving wall on the -x side).
  if (P.paddle.z > 0.5 && pos.x < P.paddle.x) {
    v.x = max(v.x, P.paddle.y);
  }

  // Tank walls: separating boundary. Nodes behind a wall also lose most of
  // their tangential velocity (friction), which stops thin wall layers from
  // creeping up the glass.
  let outside = (pos < P.wallMin) | (pos > P.wallMax);
  if (any(outside)) {
    let fr = P.misc2.w;
    if (pos.x < P.wallMin.x) { v.x = max(v.x, 0.0); v.y *= 1.0 - fr; v.z *= 1.0 - fr; }
    if (pos.x > P.wallMax.x) { v.x = min(v.x, 0.0); v.y *= 1.0 - fr; v.z *= 1.0 - fr; }
    if (pos.y < P.wallMin.y) { v.y = max(v.y, 0.0); v.x *= 1.0 - fr; v.z *= 1.0 - fr; }
    if (pos.y > P.wallMax.y) { v.y = min(v.y, 0.0); v.x *= 1.0 - fr; v.z *= 1.0 - fr; }
    if (pos.z < P.wallMin.z) { v.z = max(v.z, 0.0); v.x *= 1.0 - fr; v.y *= 1.0 - fr; }
    if (pos.z > P.wallMax.z) { v.z = min(v.z, 0.0); v.x *= 1.0 - fr; v.y *= 1.0 - fr; }
  }

  gridV[ci] = vec4f(v, m);
}
`;

// ---------------------------------------------------------------------------
// Grid -> particle: gather velocity + APIC affine matrix + density, advect,
// collide, update foam and the cube's visual orientation, and emit the compact
// per-instance record used for rendering.
const g2pBody = /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(3) var<storage, read_write> gridV: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> instances: array<Instance>;
@group(0) @binding(7) var<storage, read_write> surface: array<u32>;

fn quatFromMat(m: mat3x3f) -> vec4f {
  let tr = m[0].x + m[1].y + m[2].z;
  if (tr > 0.0) {
    let s = sqrt(tr + 1.0) * 2.0;
    return vec4f((m[1].z - m[2].y) / s, (m[2].x - m[0].z) / s, (m[0].y - m[1].x) / s, 0.25 * s);
  } else if (m[0].x > m[1].y && m[0].x > m[2].z) {
    let s = sqrt(1.0 + m[0].x - m[1].y - m[2].z) * 2.0;
    return vec4f(0.25 * s, (m[1].x + m[0].y) / s, (m[2].x + m[0].z) / s, (m[1].z - m[2].y) / s);
  } else if (m[1].y > m[2].z) {
    let s = sqrt(1.0 + m[1].y - m[0].x - m[2].z) * 2.0;
    return vec4f((m[1].x + m[0].y) / s, 0.25 * s, (m[2].y + m[1].z) / s, (m[2].x - m[0].z) / s);
  }
  let s = sqrt(1.0 + m[2].z - m[0].x - m[1].y) * 2.0;
  return vec4f((m[2].x + m[0].z) / s, (m[2].y + m[1].z) / s, 0.25 * s, (m[0].y - m[1].x) / s);
}

fn argmax3(a: vec3f) -> i32 {
  if (a.x >= a.y && a.x >= a.z) { return 0; }
  if (a.y >= a.z) { return 1; }
  return 2;
}

fn axisVec(i: i32, s: f32) -> vec3f {
  var e = vec3f(0.0);
  if (i == 0) { e.x = s; } else if (i == 1) { e.y = s; } else { e.z = s; }
  return e;
}

// Nearest orientation from the cube's symmetry group (axis aligned).
fn snapRotation(q: vec4f) -> vec4f {
  let m = quatToMat(q);
  let i0 = argmax3(abs(m[0]));
  let e0 = axisVec(i0, select(-1.0, 1.0, m[0][i0] >= 0.0));
  var a1 = abs(m[1]);
  if (i0 == 0) { a1.x = -1.0; } else if (i0 == 1) { a1.y = -1.0; } else { a1.z = -1.0; }
  let i1 = argmax3(a1);
  let e1 = axisVec(i1, select(-1.0, 1.0, m[1][i1] >= 0.0));
  let e2 = cross(e0, e1);
  var t = quatFromMat(mat3x3f(e0, e1, e2));
  if (dot(t, q) < 0.0) { t = -t; }
  return t;
}

// Everything after the grid gather: v = sum w v_i, B = sum w v_i dpos^T.
fn integrate(i: u32, pIn: Particle, vIn: vec3f, B: mat3x3f, dens: f32) {
  var p = pIn;
  var v = vIn;
  let C = B * 4.0;

  // CFL guard.
  let sp = length(v);
  if (sp > P.maxSpeed) { v *= P.maxSpeed / sp; }

  // Foam / whitewater: generated by hard impacts (acceleration well above
  // gravity) and by fast, sparse spray; decays over a couple of seconds.
  let accel = length(v - p.vel) / max(P.dt, 1e-4);
  let densRatio = dens / P.restDensity;
  let spray = clamp(1.0 - densRatio * 1.25, 0.0, 1.0);
  let gen = P.foam.y * max(accel - P.foam.z, 0.0)
          + P.misc2.y * spray * max(sp - P.foam.w, 0.0);
  p.foam = clamp(p.foam * P.foam.x + gen * P.dt, 0.0, 1.0);

  var nx = p.pos + v * P.dt;

  // Ball obstacle.
  if (P.ball.w > 0.0) {
    let d = nx - P.ball.xyz;
    let dist = length(d);
    let R = P.ball.w + P.radius;
    if (dist < R) {
      let n = d / max(dist, 1e-4);
      nx = P.ball.xyz + n * R;
      let rel = dot(v - P.ballVel.xyz, n);
      if (rel < 0.0) { v -= rel * n; }
    }
  }

  // Wave paddle.
  if (P.paddle.z > 0.5) {
    let px = P.paddle.x + P.radius;
    if (nx.x < px) { nx.x = px; v.x = max(v.x, P.paddle.y); }
  }

  // Tank walls.
  let lo = P.wallMin + P.radius;
  let hi = P.wallMax - P.radius;
  if (nx.x < lo.x) { nx.x = lo.x; v.x = max(v.x, 0.0); }
  if (nx.x > hi.x) { nx.x = hi.x; v.x = min(v.x, 0.0); }
  if (nx.y < lo.y) { nx.y = lo.y; v.y = max(v.y, 0.0); }
  if (nx.y > hi.y) { nx.y = hi.y; v.y = min(v.y, 0.0); }
  if (nx.z < lo.z) { nx.z = lo.z; v.z = max(v.z, 0.0); }
  if (nx.z > hi.z) { nx.z = hi.z; v.z = min(v.z, 0.0); }

  // Visual orientation: integrate local fluid rotation (half the vorticity),
  // and relax back to the axis-aligned voxel look when the water is calm.
  var q = p.rot;
  if (P.misc.x > 0.5) {
    let omega = 0.5 * vec3f(C[1].z - C[2].y, C[2].x - C[0].z, C[0].y - C[1].x);
    q = normalize(q + 0.5 * P.dt * 1.5 * quatMul(vec4f(omega, 0.0), q));
    let calm = 1.0 - clamp((sp - 0.25) * 1.2 + length(omega) * 0.8, 0.0, 1.0);
    let rate = P.misc.y * calm;
    if (rate > 0.0) {
      q = normalize(mix(q, snapRotation(q), rate));
    }
  } else {
    q = vec4f(0.0, 0.0, 0.0, 1.0);
  }

  p.pos = nx;
  p.vel = v;
  p.c0 = C[0];
  p.c1 = C[1];
  p.c2 = C[2];
  p.rot = q;
  particles[i] = p;

  // Depth below the local water surface (height map from the previous frame).
  let col = clamp(vec2i(nx.xz), vec2i(0), P.gridRes.xz - 1);
  let top = bitcast<f32>(surface[u32(col.x + col.y * P.gridRes.x)]);
  let depth = max(top - nx.y, 0.0);
  let packed = pack4x8unorm(vec4f(p.foam, p.dye, clamp(densRatio * 0.5, 0.0, 1.0), clamp(sp / P.maxSpeed, 0.0, 1.0)));
  instances[i] = makeInstance(nx, packed, q, depth);
}
`;

// Direct G2P: one thread per particle gathering straight from global memory.
export const g2pCode = common + simBindings + g2pBody + /* wgsl */ `
@group(0) @binding(4) var<storage, read> counts: Counts;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= counts.n) { return; }
  let p = particles[i];
  let x = p.pos;
  var w: array<vec3f, 3>;
  let bi = bsplineWeights(x, &w);
  var v = vec3f(0.0);
  var B = mat3x3f(vec3f(0.0), vec3f(0.0), vec3f(0.0));
  var dens = 0.0;
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      let wxy = w[gx].x * w[gy].y;
      for (var gz = 0; gz < 3; gz++) {
        let weight = wxy * w[gz].z;
        let cell = bi + vec3i(gx - 1, gy - 1, gz - 1);
        let dpos = vec3f(cell) + 0.5 - x;
        let g = gridV[cellIndex(cell)];
        let wv = weight * g.xyz;
        v += wv;
        B += mat3x3f(wv * dpos.x, wv * dpos.y, wv * dpos.z);
        dens += weight * g.w;
      }
    }
  }
  integrate(i, p, v, B, dens);
}
`;

// Tiled G2P: a workgroup per particle block reads the block's grid velocities
// into shared memory once, then every particle gathers from the tile.
export const g2pTiledCode = common + simBindings + blockCommon + g2pBody + /* wgsl */ `
@group(0) @binding(8) var<storage, read_write> blockCounts: array<u32>;
@group(0) @binding(9) var<storage, read_write> blockStart: array<u32>;
@group(0) @binding(11) var<storage, read_write> sortedIdx: array<u32>;

var<workgroup> tile: array<vec4f, 216>;
var<workgroup> range: vec2u;

@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let b = wid.x;
  let origin = blockOrigin(b);
  if (lid == 0u) { range = vec2u(blockStart[b], blockCounts[b]); }
  let r = workgroupUniformLoad(&range);
  if (r.y == 0u) { return; }
  for (var t = lid; t < TN; t += PWG) {
    let ti = i32(t);
    let cell = origin + vec3i(ti % TS, (ti / TS) % TS, ti / (TS * TS));
    var g = vec4f(0.0);
    if (all(cell >= vec3i(0)) && all(cell < P.gridRes)) { g = gridV[cellIndex(cell)]; }
    tile[t] = g;
  }
  workgroupBarrier();

  for (var k = lid; k < r.y; k += PWG) {
    let i = sortedIdx[r.x + k];
    let p = particles[i];
    let x = p.pos;
    var w: array<vec3f, 3>;
    let bi = bsplineWeights(x, &w);
    var v = vec3f(0.0);
    var B = mat3x3f(vec3f(0.0), vec3f(0.0), vec3f(0.0));
    var dens = 0.0;
    for (var gx = 0; gx < 3; gx++) {
      for (var gy = 0; gy < 3; gy++) {
        let wxy = w[gx].x * w[gy].y;
        for (var gz = 0; gz < 3; gz++) {
          let weight = wxy * w[gz].z;
          let cell = bi + vec3i(gx - 1, gy - 1, gz - 1);
          let dpos = vec3f(cell) + 0.5 - x;
          let lc = cell - origin;
          var g = vec4f(0.0);
          if (inTile(lc)) { g = tile[tileIndex(lc)]; } else { g = gridV[cellIndex(cell)]; }
          let wv = weight * g.xyz;
          v += wv;
          B += mat3x3f(wv * dpos.x, wv * dpos.y, wv * dpos.z);
          dens += weight * g.w;
        }
      }
    }
    integrate(i, p, v, B, dens);
  }
}
`;

// ---------------------------------------------------------------------------
// Cursor picking: nearest particle hit along the pointer ray (atomic min on the
// bit pattern of the positive hit distance).
export const pickCode = common + /* wgsl */ `
struct InteractA {
  tBits: atomic<u32>,
  hasDepth: u32,
  pressed: u32,
  hover: u32,
  center: vec3f, depth: f32,
  vel: vec3f, valid: f32,
};
@group(0) @binding(0) var<uniform> F: FrameParams;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> I: InteractA;
@group(0) @binding(3) var<storage, read> counts: Counts;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= counts.n) { return; }
  let rel = particles[i].pos - F.rayOrigin;
  let t = dot(rel, F.rayDir);
  if (t <= 0.0) { return; }
  let d2 = dot(rel, rel) - t * t;
  let r2 = F.pickRadius * F.pickRadius;
  if (d2 > r2) { return; }
  let th = max(t - sqrt(r2 - d2), 0.0);
  atomicMin(&I.tBits, bitcast<u32>(th));
}
`;

// Single-thread brush update: turns the pick result into a brush centre and a
// brush velocity (from the pointer motion at the hit depth).
export const brushCode = common + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: FrameParams;
@group(0) @binding(1) var<storage, read_write> I: Interact;

@compute @workgroup_size(1)
fn main() {
  let hit = I.tBits != FLT_MAX_BITS;
  if (F.resetDepth != 0u) { I.hasDepth = 0u; }
  var t = I.depth;
  if (hit) {
    let th = bitcast<f32>(I.tBits) + F.depthOffset;
    if (I.hasDepth != 0u && F.pressed > 0.5) {
      t = mix(I.depth, th, 0.35);
    } else {
      t = th;
    }
    I.hasDepth = 1u;
  } else if (I.hasDepth == 0u || F.pressed < 0.5) {
    t = F.fallbackT;
  }
  let c = F.rayOrigin + F.rayDir * t;
  let cPrev = F.prevRayOrigin + F.prevRayDir * t;
  var vel = vec3f(0.0);
  if (F.dtSim > 0.0) { vel = (c - cPrev) / F.dtSim; }
  let vl = length(vel);
  if (vl > 6.0) { vel *= 6.0 / vl; }
  I.vel = mix(I.vel, vel, 0.6);
  I.center = clamp(c, F.wallMin, F.wallMax);
  I.depth = t;
  I.pressed = select(0u, 1u, F.pressed > 0.5);
  I.hover = select(0u, 1u, F.hover > 0.5);
  I.valid = select(0.0, 1.0, hit || I.hasDepth != 0u || F.pressed > 0.5);
  I.tBits = FLT_MAX_BITS;
}
`;

// Pour tool: append new particles (GPU-side particle count).
export const emitCode = common + /* wgsl */ `
struct CountsA { n: atomic<u32>, alive: u32, holes: u32, fill: u32 };
@group(0) @binding(0) var<uniform> F: FrameParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> counts: CountsA;
@group(0) @binding(3) var<storage, read_write> instances: array<Instance>;
@group(0) @binding(4) var<storage, read> I: Interact;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= F.emitCount) { return; }
  let slot = atomicAdd(&counts.n, 1u);
  if (slot >= F.capacity) { return; }
  let h = rand3(k * 7919u + 13u, F.seed);
  let ang = h.x * 6.2831853;
  let rad = sqrt(h.y) * F.emitRadius;
  // Pour from the top of the tank, straight above the cursor's water point.
  var origin = F.emitPos;
  if (I.valid > 0.5) { origin = vec3f(I.center.x, F.emitPos.y, I.center.z); }
  var pos = origin + vec3f(cos(ang) * rad, (h.z - 0.5) * F.emitThickness, sin(ang) * rad);
  pos = clamp(pos, F.wallMin + F.radius, F.wallMax - F.radius);
  var p: Particle;
  p.pos = pos;
  p.foam = 0.25;
  p.vel = F.emitVel;
  p.dye = F.emitDye;
  p.c0 = vec3f(0.0);
  p.c1 = vec3f(0.0);
  p.c2 = vec3f(0.0);
  p.density = F.restDensity;
  p.flags = 0.0;
  p.seed = h.z;
  p.rot = vec4f(0.0, 0.0, 0.0, 1.0);
  particles[slot] = p;
  instances[slot] = makeInstance(pos, pack4x8unorm(vec4f(p.foam, p.dye, 0.5, 0.2)), p.rot, 0.0);
}
`;

// Drain tool: mark particles near the brush as dead and count survivors.
export const drainMarkCode = common + /* wgsl */ `
struct CountsA { n: u32, alive: atomic<u32>, holes: u32, fill: u32 };
@group(0) @binding(0) var<uniform> F: FrameParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> counts: CountsA;
@group(0) @binding(3) var<storage, read> I: Interact;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= counts.n) { return; }
  var dead = false;
  if (I.valid > 0.5 && I.pressed != 0u) {
    let d = length(particles[i].pos - I.center);
    if (d < F.drainRadius) {
      let h = rand3(i, F.seed);
      dead = h.x < F.drainRate * (1.0 - d / F.drainRadius * 0.5);
    }
  }
  particles[i].flags = select(0.0, 1.0, dead);
  if (!dead) { atomicAdd(&counts.alive, 1u); }
}
`;

// Compaction step 1: dead slots below the survivor count become holes.
export const drainHolesCode = common + /* wgsl */ `
struct CountsA { n: u32, alive: u32, holes: atomic<u32>, fill: u32 };
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> counts: CountsA;
@group(0) @binding(3) var<storage, read_write> holes: array<u32>;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= counts.n || i >= counts.alive) { return; }
  if (particles[i].flags > 0.5) {
    let h = atomicAdd(&counts.holes, 1u);
    holes[h] = i;
  }
}
`;

// Compaction step 2: survivors above the survivor count move into holes.
export const drainFillCode = common + /* wgsl */ `
struct CountsA { n: u32, alive: u32, holes: u32, fill: atomic<u32> };
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> counts: CountsA;
@group(0) @binding(3) var<storage, read> holes: array<u32>;
@group(0) @binding(4) var<storage, read_write> instances: array<Instance>;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= counts.n || i < counts.alive) { return; }
  if (particles[i].flags > 0.5) { return; }
  let j = atomicAdd(&counts.fill, 1u);
  let dst = holes[j];
  particles[dst] = particles[i];
  instances[dst] = instances[i];
}
`;

// Single thread: finalise counts and write indirect dispatch / draw arguments.
export const argsCode = common + /* wgsl */ `
struct Args {
  dispatch: vec3u, pad: u32,
  vertexCount: u32, instanceCount: u32, firstVertex: u32, firstInstance: u32,
};
@group(0) @binding(0) var<uniform> F: FrameParams;
@group(0) @binding(1) var<storage, read_write> counts: Counts;
@group(0) @binding(2) var<storage, read_write> args: Args;

@compute @workgroup_size(1)
fn main() {
  var n = counts.n;
  if (F.compacted != 0u) { n = counts.alive; }
  n = min(n, F.capacity);
  counts.n = n;
  counts.alive = 0u;
  counts.holes = 0u;
  counts.fill = 0u;
  args.dispatch = vec3u((n + WG - 1u) / WG, 1u, 1u);
  args.vertexCount = 18u;
  args.instanceCount = n;
  args.firstVertex = 0u;
  args.firstInstance = 0u;
}
`;

// Water surface height map from the grid: per (x, z) column, walk up from the
// floor while the cells are filled; the crossing height is the local surface.
export const surfaceCode = common + simBindings + /* wgsl */ `
@group(0) @binding(3) var<storage, read_write> gridV: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> surface: array<u32>;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let nxz = u32(P.gridRes.x * P.gridRes.z);
  if (gid.x >= nxz) { return; }
  let x = i32(gid.x) % P.gridRes.x;
  let z = i32(gid.x) / P.gridRes.x;
  let thr = 0.45 * P.restDensity;
  let y0 = i32(P.wallMin.y);
  var top = P.wallMin.y;
  var prev = P.restDensity;
  for (var y = y0; y < P.gridRes.y; y++) {
    let m = gridV[cellIndex(vec3i(x, y, z))].w;
    if (m < thr) {
      // Interpolate the threshold crossing between this node and the last.
      let f = clamp((prev - thr) / max(prev - m, 1e-4), 0.0, 1.0);
      top = f32(y) - 0.5 + f;
      break;
    }
    prev = m;
    top = f32(y) + 0.5;
  }
  surface[gid.x] = bitcast<u32>(top);
}
`;

// ---------------------------------------------------------------------------
// Direct (untiled) P2G variants: one thread per particle, global atomics.
// Faster than the tiled path on GPUs with fast global atomics.
export const p2gMassDirectCode = common + simBindings + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(4) var<storage, read> counts: Counts;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= counts.n) { return; }
  let x = particles[i].pos;
  var w: array<vec3f, 3>;
  let bi = bsplineWeights(x, &w);
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      let wxy = w[gx].x * w[gy].y;
      for (var gz = 0; gz < 3; gz++) {
        let cell = bi + vec3i(gx - 1, gy - 1, gz - 1);
        atomicAdd(&grid[u32(cellIndex(cell)) * 4u + 3u], i32(wxy * w[gz].z * FP + 0.5));
      }
    }
  }
}
`;

export const p2gDirectCode = common + simBindings + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(4) var<storage, read> counts: Counts;

fn enc(x: f32) -> i32 { return i32(clamp(x * FP, -2.0e9, 2.0e9)); }

fn massAt(c: vec3i) -> f32 {
  return f32(atomicLoad(&grid[u32(cellIndex(c)) * 4u + 3u])) / FP;
}
` + ghostMassFn + stressFn + /* wgsl */ `
@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= counts.n) { return; }
  let p = particles[i];
  let x = p.pos;
  var w: array<vec3f, 3>;
  let bi = bsplineWeights(x, &w);

  var density = 0.0;
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      let wxy = w[gx].x * w[gy].y;
      for (var gz = 0; gz < 3; gz++) {
        let cell = bi + vec3i(gx - 1, gy - 1, gz - 1);
        density += wxy * w[gz].z * (massAt(cell) + ghostMass(cell));
      }
    }
  }
  particles[i].density = density;
  let affine = stressAffine(p, density);

  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      let wxy = w[gx].x * w[gy].y;
      for (var gz = 0; gz < 3; gz++) {
        let weight = wxy * w[gz].z;
        let cell = bi + vec3i(gx - 1, gy - 1, gz - 1);
        let dpos = vec3f(cell) + 0.5 - x;
        let mom = weight * (p.vel + affine * dpos);
        let idx = u32(cellIndex(cell)) * 4u;
        atomicAdd(&grid[idx], enc(mom.x));
        atomicAdd(&grid[idx + 1u], enc(mom.y));
        atomicAdd(&grid[idx + 2u], enc(mom.z));
      }
    }
  }
}
`;

