// WGSL for rendering. All geometry except the water instances is procedural.

export const SCENE_FLOATS = 164;

const sceneStruct = /* wgsl */ `
struct Scene {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  lightViewProj: mat4x4f,
  gridToWorld: mat4x4f,
  tankModel: mat4x4f,
  tankRot: vec4f,
  camPos: vec3f,       time: f32,
  lightDir: vec3f,     cubeHalf: f32,
  sunColor: vec3f,     exposure: f32,
  skyTop: vec3f,       floorY: f32,
  skyHorizon: vec3f,   shadowOn: f32,
  groundColor: vec3f,  gridOn: f32,
  waterShallow: vec3f, colorMode: f32,
  waterDeep: vec3f,    foamOn: f32,
  absorption: vec3f,   emissive: f32,
  foamColor: vec3f,    glassAlpha: f32,
  tankHalf: vec3f,     frameRadius: f32,
  ball: vec4f,         // grid-space centre, radius (grid units); radius 0 = hidden
  paddle: vec4f,       // x (grid), active, top y (grid), thickness (grid)
  brush: vec4f,        // tool colour index, radius (grid), visible, pressed-look
  lightRange: vec4f,   // depth range (world), map size, 1/size, solid bias
  viewport: vec4f,     // w, h, 1/w, 1/h
  misc: vec4f,         // dx (world), caustics, fog distance, cube edge strength
  gridColor: vec3f,    aoStrength: f32,
  wallMin: vec3f,      pad0: f32,
  wallMax: vec3f,      pad1: f32,
};

fn quatToMat(q: vec4f) -> mat3x3f {
  let x = q.x; let y = q.y; let z = q.z; let w = q.w;
  return mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w)),
    vec3f(2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w)),
    vec3f(2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y)));
}

fn quatMul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

fn hash11(n: u32) -> f32 {
  var h = n * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h >> 8u) / 16777216.0;
}

struct BoxV { p: vec3f, n: vec3f, uv: vec2f };

// Unit box [-1, 1]^3, 36 vertices, CCW outward-facing triangles.
fn boxVertex(vi: u32) -> BoxV {
  let face = vi / 6u;
  let corner = vi % 6u;
  var qp = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                           vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  var qn = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(1.0, -1.0),
                           vec2f(-1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let axis = face / 2u;
  let positive = (face % 2u) == 0u;
  let s = select(-1.0, 1.0, positive);
  var uv = qp[corner];
  if (!positive) { uv = qn[corner]; }
  var p = vec3f(0.0);
  var n = vec3f(0.0);
  if (axis == 0u) { p = vec3f(s, uv.x, uv.y); n = vec3f(s, 0.0, 0.0); }
  else if (axis == 1u) { p = vec3f(uv.y, s, uv.x); n = vec3f(0.0, s, 0.0); }
  else { p = vec3f(uv.x, uv.y, s); n = vec3f(0.0, 0.0, s); }
  return BoxV(p, n, uv);
}
`;

const lighting = /* wgsl */ `
@group(0) @binding(1) var shadowTex: texture_2d<f32>;
@group(0) @binding(2) var shadowSampler: sampler;

fn envColor(d: vec3f) -> vec3f {
  let y = d.y;
  var c = mix(S.skyHorizon, S.skyTop, smoothstep(-0.05, 0.75, y));
  // Soft overhead light panel (studio softbox) for nicer reflections.
  let panel = smoothstep(0.55, 0.9, y) * smoothstep(0.75, 0.2, abs(d.x + 0.25 * d.z));
  c += S.sunColor * panel * 0.045;
  // Ground below the horizon.
  c = mix(c, S.groundColor * 0.8, 1.0 - smoothstep(-0.12, 0.0, y));
  // Sun disc + glow.
  let sd = max(dot(d, -S.lightDir), 0.0);
  c += S.sunColor * (pow(sd, 900.0) * 6.0 + pow(sd, 24.0) * 0.08);
  return c;
}

// Returns (water thickness along the light ray in world units, frame
// visibility, ball visibility). The shadow map stores the water front depth in
// R, the frame/paddle front depth in G, the ball front depth in B and the water
// back depth in A (min/max blending).
fn shadowTerms(world: vec3f) -> vec3f {
  if (S.shadowOn < 0.5) { return vec3f(0.0, 1.0, 1.0); }
  let lp = S.lightViewProj * vec4f(world, 1.0);
  let uv = vec2f(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  if (uv.x <= 0.001 || uv.x >= 0.999 || uv.y <= 0.001 || uv.y >= 0.999) { return vec3f(0.0, 1.0, 1.0); }
  let z = vec4f(lp.z);
  let st = uv * S.lightRange.y - 0.5;
  let f = fract(st);
  let front = textureGather(0, shadowTex, shadowSampler, uv);
  let frame = textureGather(1, shadowTex, shadowSampler, uv);
  let ball = textureGather(2, shadowTex, shadowSampler, uv);
  let back = textureGather(3, shadowTex, shadowSampler, uv);
  let w = vec4f((1.0 - f.x) * f.y, f.x * f.y, f.x * (1.0 - f.y), (1.0 - f.x) * (1.0 - f.y));
  let thick = max(min(z, back) - front, vec4f(0.0));
  let visF = select(vec4f(0.0), vec4f(1.0), z <= frame + S.lightRange.w);
  let visB = select(vec4f(0.0), vec4f(1.0), z <= ball + S.lightRange.w);
  return vec3f(dot(thick, w) * S.lightRange.x, dot(visF, w), dot(visB, w));
}

fn caustics(p: vec2f, t: f32) -> f32 {
  var q = p;
  var c = 0.0;
  for (var n = 0; n < 4; n++) {
    let tt = t * (1.0 - 3.2 / f32(n + 2));
    q = p + vec2f(cos(tt - q.x) + sin(tt + q.y), sin(tt - q.y) + cos(tt + q.x));
    c += 1.0 / length(vec2f(p.x / (sin(q.x + tt) / 0.006), p.y / (cos(q.y + tt) / 0.006)));
  }
  c = 1.2 - pow(c / 4.0, 1.4);
  return clamp(pow(abs(c), 7.0), 0.0, 3.0);
}
`;

// ---------------------------------------------------------------------------
// Water cubes.
export const cubeCode = sceneStruct + /* wgsl */ `
@group(0) @binding(0) var<uniform> S: Scene;
` + lighting + /* wgsl */ `
struct CubeIn {
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
  @location(0) pos: vec3f,
  @location(1) packed: u32,
  @location(2) rot: vec4f,
  @location(3) extra: vec2f,
};

struct CubeOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) normal: vec3f,
  @location(3) @interpolate(flat) albedo: vec4f,
  @location(4) @interpolate(flat) info: vec4f,
  @location(5) @interpolate(flat) depth: f32,
};

fn rainbow(t: f32) -> vec3f {
  let c = 0.5 + 0.5 * cos(6.2831853 * (vec3f(t) * 0.92 + vec3f(0.02, 0.36, 0.68)));
  return c * c;
}

fn heat(t: f32) -> vec3f {
  let a = vec3f(0.02, 0.08, 0.35);
  let b = vec3f(0.0, 0.55, 0.95);
  let c = vec3f(0.65, 0.95, 1.0);
  let d = vec3f(1.0, 0.85, 0.35);
  if (t < 0.33) { return mix(a, b, t / 0.33); }
  if (t < 0.66) { return mix(b, c, (t - 0.33) / 0.33); }
  return mix(c, d, (t - 0.66) / 0.34);
}

@vertex
fn vsMain(in: CubeIn) -> CubeOut {
  let info = unpack4x8unorm(in.packed); // foam, dye, density/2, speed
  let center = (S.gridToWorld * vec4f(in.pos, 1.0)).xyz;
  let q = quatMul(S.tankRot, normalize(in.rot));
  var R = quatToMat(q);
  let face = in.vi / 6u;
  var qp = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                           vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let uv = qp[in.vi % 6u];
  let a = R[face];
  let b = R[(face + 1u) % 3u];
  let c = R[(face + 2u) % 3u];
  let s = select(-1.0, 1.0, dot(a, S.camPos - center) >= 0.0);
  let n = a * s;
  // Isolated spray particles render a little smaller.
  let shrink = mix(0.62, 1.0, smoothstep(0.1, 0.4, info.z));
  let half = S.cubeHalf * shrink;
  let world = center + (n + b * uv.x + c * uv.y) * half;

  var base = S.waterShallow;
  let mode = i32(S.colorMode + 0.5);
  if (mode == 1) { base = rainbow(info.y); }
  else if (mode == 2) { base = heat(info.w); }
  let jitter = 0.94 + 0.12 * hash11(in.ii);
  base *= jitter;
  let foam = info.x * S.foamOn;
  let fm = smoothstep(0.05, 0.85, foam);
  let albedo = mix(base, S.foamColor, fm);

  var out: CubeOut;
  out.clip = S.viewProj * vec4f(world, 1.0);
  out.world = world;
  out.uv = uv;
  out.normal = n;
  out.albedo = vec4f(albedo, fm);
  out.info = info;
  out.depth = in.extra.x * 32.0 * S.misc.x;
  return out;
}

@fragment
fn fsMain(in: CubeOut) -> @location(0) vec4f {
  let N = in.normal;
  let V = normalize(S.camPos - in.world);
  let L = -S.lightDir;
  let sh = shadowTerms(in.world);
  let T = exp(-S.absorption * sh.x);
  let vis = sh.z;
  let albedo = in.albedo.rgb;
  let foam = in.albedo.a;

  let ndl = dot(N, L);
  let wrap = max(ndl * 0.8 + 0.2, 0.0);
  // Underwater caustic flicker on submerged faces.
  let submerged = smoothstep(0.02, 0.15, sh.x) * (1.0 - smoothstep(0.35, 0.9, sh.x));
  let caus = 1.0 + S.misc.y * submerged * 1.1 * caustics(in.world.xz * 7.0 - 250.0, S.time * 0.9);
  let sunT = S.sunColor * T * vis;
  var col = albedo * sunT * wrap * caus;
  // Translucency: sunlight leaking through thin water on faces turned away.
  col += albedo * sunT * max(-ndl, 0.0) * 0.3 * (1.0 - foam);

  // Skylight comes from above: attenuate it by the depth below the surface.
  let amb = mix(S.groundColor * 0.8, mix(S.skyHorizon, S.skyTop, 0.35) * 1.5 + vec3f(0.02), N.y * 0.5 + 0.5);
  let ambT = exp(-S.absorption * in.depth * 0.8);
  col += albedo * amb * (0.35 + 0.65 * ambT) * 1.2;
  // In-scattered light: deep water glows faintly with its deep colour.
  col += S.waterDeep * (vec3f(1.0) - ambT) * 1.1 * (1.0 - foam);

  // Specular and Fresnel reflection only where there is an air/water
  // interface, i.e. for cubes at the surface (flat faces act as tiny mirrors).
  let surf = 1.0 - smoothstep(0.6, 2.2, in.depth / S.misc.x);
  let H = normalize(L + V);
  let spec = pow(max(dot(N, H), 0.0), 220.0) * 4.0;
  col += S.sunColor * spec * T * vis * (1.0 - foam * 0.85) * surf;
  let ndv = max(dot(N, V), 0.0);
  let F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  col = mix(col, envColor(reflect(-V, N)), F * 0.8 * (1.0 - foam) * surf);

  // Emissive themes (lava, toxic): a darker cooling crust at rest that glows
  // hot wherever the flow is fast, churned up or freshly exposed.
  let heat = clamp(in.info.w * 3.0 + foam * 1.2 + (1.0 - smoothstep(0.0, 2.0 * S.misc.x, in.depth)) * 0.35, 0.0, 1.6);
  col += albedo * S.emissive * (0.12 + heat);

  // Bevel-like edge shading gives each cube a crisp voxel outline.
  let e = max(abs(in.uv.x), abs(in.uv.y));
  let fw = fwidth(e);
  let edge = smoothstep(1.0 - 0.16 - fw, 1.0 - 0.16 + fw, e);
  let strength = S.misc.w * clamp(1.0 - fw * 3.0, 0.0, 1.0);
  col *= 1.0 - edge * strength * 0.32;
  // Slight top-face highlight.
  col *= 1.0 + 0.06 * max(N.y, 0.0);
  return vec4f(col, 1.0);
}
`;

// Shadow pass for water cubes: faces towards the light, min/max depth blending.
export const shadowCubeCode = sceneStruct + /* wgsl */ `
@group(0) @binding(0) var<uniform> S: Scene;

struct ShadowIn {
  @builtin(vertex_index) vi: u32,
  @location(0) pos: vec3f,
  @location(1) packed: u32,
  @location(2) rot: vec4f,
  @location(3) extra: vec2f,
};

@vertex
fn vsMain(in: ShadowIn) -> @builtin(position) vec4f {
  let info = unpack4x8unorm(in.packed);
  let center = (S.gridToWorld * vec4f(in.pos, 1.0)).xyz;
  let q = quatMul(S.tankRot, normalize(in.rot));
  var R = quatToMat(q);
  let face = in.vi / 6u;
  var qp = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                           vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let uv = qp[in.vi % 6u];
  let a = R[face];
  let b = R[(face + 1u) % 3u];
  let c = R[(face + 2u) % 3u];
  let s = select(-1.0, 1.0, dot(a, -S.lightDir) >= 0.0);
  let shrink = mix(0.62, 1.0, smoothstep(0.1, 0.4, info.z));
  let world = center + (a * s + b * uv.x + c * uv.y) * (S.cubeHalf * shrink);
  return S.lightViewProj * vec4f(world, 1.0);
}

@fragment
fn fsMain(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return vec4f(p.z, 1.0, 1.0, p.z);
}
`;

// ---------------------------------------------------------------------------
// Solid objects: tank frame (12 bars) + wave paddle (instance 12) + ball.
const solidCommon = /* wgsl */ `
struct SolidOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) material: u32,
  @location(3) uv: vec2f,
};

fn frameVertex(vi: u32, ii: u32) -> SolidOut {
  let bv = boxVertex(vi);
  var out: SolidOut;
  if (ii < 12u) {
    let axis = ii / 4u;
    let k = ii % 4u;
    let r = S.frameRadius;
    let h = S.tankHalf + vec3f(r);
    let s1 = select(-1.0, 1.0, (k & 1u) != 0u);
    let s2 = select(-1.0, 1.0, (k & 2u) != 0u);
    var c = vec3f(0.0);
    var hh = vec3f(r);
    if (axis == 0u) { c = vec3f(0.0, s1 * h.y, s2 * h.z); hh.x = h.x + r; }
    else if (axis == 1u) { c = vec3f(s1 * h.x, 0.0, s2 * h.z); hh.y = h.y + r; }
    else { c = vec3f(s1 * h.x, s2 * h.y, 0.0); hh.z = h.z + r; }
    out.world = (S.tankModel * vec4f(c + bv.p * hh, 1.0)).xyz;
    out.normal = (S.tankModel * vec4f(bv.n, 0.0)).xyz;
    out.material = 0u;
  } else {
    let t = S.paddle.w;
    let px = S.paddle.x;
    let c = vec3f(px - t * 0.5, (S.wallMin.y + S.paddle.z) * 0.5, (S.wallMin.z + S.wallMax.z) * 0.5);
    let hh = vec3f(t * 0.5, (S.paddle.z - S.wallMin.y) * 0.5, (S.wallMax.z - S.wallMin.z) * 0.5 - 0.15);
    var p = c + bv.p * hh;
    if (S.paddle.y < 0.5) { p = vec3f(-1000.0); }
    out.world = (S.gridToWorld * vec4f(p, 1.0)).xyz;
    out.normal = (S.tankModel * vec4f(bv.n, 0.0)).xyz;
    out.material = 1u;
  }
  out.uv = bv.uv;
  out.clip = S.viewProj * vec4f(out.world, 1.0);
  return out;
}

const BALL_SEG: u32 = 48u;
const BALL_RING: u32 = 24u;

fn ballVertex(vi: u32) -> SolidOut {
  let quad = vi / 6u;
  var offs = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(1u, 1u),
                             vec2u(0u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));
  let o = offs[vi % 6u];
  let u = f32(quad % BALL_SEG + o.x) / f32(BALL_SEG);
  let v = f32(quad / BALL_SEG + o.y) / f32(BALL_RING);
  let theta = u * 6.2831853;
  let phi = v * 3.14159265;
  let n = vec3f(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
  let center = (S.gridToWorld * vec4f(S.ball.xyz, 1.0)).xyz;
  let r = S.ball.w * S.misc.x;
  var out: SolidOut;
  out.world = center + n * r;
  if (S.ball.w <= 0.0) { out.world = vec3f(-1000.0); }
  out.normal = n;
  out.material = 2u;
  out.uv = vec2f(u, v);
  out.clip = S.viewProj * vec4f(out.world, 1.0);
  return out;
}
`;

export const solidCode = sceneStruct + /* wgsl */ `
@group(0) @binding(0) var<uniform> S: Scene;
` + lighting + solidCommon + /* wgsl */ `
@vertex
fn vsFrame(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SolidOut {
  return frameVertex(vi, ii);
}

@vertex
fn vsBall(@builtin(vertex_index) vi: u32) -> SolidOut {
  return ballVertex(vi);
}

@fragment
fn fsMain(in: SolidOut) -> @location(0) vec4f {
  let N = normalize(in.normal);
  let V = normalize(S.camPos - in.world);
  let L = -S.lightDir;
  let sh = shadowTerms(in.world + N * 0.004);
  let T = exp(-S.absorption * sh.x);
  var vis = sh.y * sh.z;
  if (in.material == 0u) { vis = 1.0; }
  if (in.material == 2u) { vis = sh.y; }
  var albedo = vec3f(0.04, 0.045, 0.055);
  var rough = 0.35;
  var metal = 1.0;
  if (in.material == 1u) {
    albedo = vec3f(0.85, 0.87, 0.9);
    rough = 0.45;
    metal = 0.0;
    let stripe = step(0.82, abs(in.uv.y));
    albedo = mix(albedo, vec3f(1.0, 0.42, 0.12), stripe);
  } else if (in.material == 2u) {
    albedo = vec3f(1.0, 0.36, 0.2);
    let band = step(0.5, fract(in.uv.x * 4.0));
    albedo = mix(albedo, vec3f(0.95, 0.95, 0.92), band * step(0.2, in.uv.y) * step(in.uv.y, 0.8));
    rough = 0.18;
    metal = 0.0;
  }
  let ndl = max(dot(N, L), 0.0);
  let amb = mix(S.groundColor, mix(S.skyHorizon, S.skyTop, 0.5) * 1.5 + vec3f(0.02), N.y * 0.5 + 0.5);
  var col = albedo * (S.sunColor * ndl * T * vis + amb) * (1.0 - metal * 0.7);
  let H = normalize(L + V);
  let shin = mix(400.0, 30.0, rough);
  let spec = pow(max(dot(N, H), 0.0), shin) * (shin / 40.0);
  col += S.sunColor * spec * T * vis * mix(0.35, 1.0, metal);
  let ndv = max(dot(N, V), 0.0);
  let F = mix(0.04, 0.6, metal) + (1.0 - mix(0.04, 0.6, metal)) * pow(1.0 - ndv, 5.0);
  col += envColor(reflect(-V, N)) * F * mix(0.6, 1.1, metal) * T;
  return vec4f(col, 1.0);
}
`;

export const shadowSolidCode = sceneStruct + /* wgsl */ `
@group(0) @binding(0) var<uniform> S: Scene;
` + solidCommon + /* wgsl */ `
@vertex
fn vsFrame(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let o = frameVertex(vi, ii);
  return S.lightViewProj * vec4f(o.world, 1.0);
}

@vertex
fn vsBall(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let o = ballVertex(vi);
  return S.lightViewProj * vec4f(o.world, 1.0);
}

@fragment
fn fsFrame(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return vec4f(1.0, p.z, 1.0, 0.0);
}

@fragment
fn fsBall(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return vec4f(1.0, 1.0, p.z, 0.0);
}
`;

// ---------------------------------------------------------------------------
// Floor + background.
export const floorCode = sceneStruct + /* wgsl */ `
@group(0) @binding(0) var<uniform> S: Scene;
` + lighting + /* wgsl */ `
struct FloorOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
};

@vertex
fn vsFloor(@builtin(vertex_index) vi: u32) -> FloorOut {
  var q = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(1.0, -1.0),
                          vec2f(-1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let p = q[vi] * 60.0;
  var out: FloorOut;
  out.world = vec3f(p.x, S.floorY, p.y);
  out.clip = S.viewProj * vec4f(out.world, 1.0);
  return out;
}

fn gridLine(p: vec2f) -> f32 {
  let fw = fwidth(p);
  let g = abs(fract(p - 0.5) - 0.5) / max(fw, vec2f(1e-4));
  return 1.0 - min(min(g.x, g.y), 1.0);
}

@fragment
fn fsFloor(in: FloorOut) -> @location(0) vec4f {
  let w = in.world;
  let V = normalize(S.camPos - w);
  let sh = shadowTerms(w);
  let T = exp(-S.absorption * sh.x);
  let vis = mix(1.0, sh.y, 0.85) * mix(1.0, sh.z, 0.8);
  let L = -S.lightDir;
  let ndl = max(L.y, 0.0);

  // Tiles: subtle major / minor grid lines.
  var base = S.groundColor;
  if (S.gridOn > 0.5) {
    let minor = gridLine(w.xz * 4.0);
    let major = gridLine(w.xz * 1.0);
    let fade = 1.0 - smoothstep(2.0, 9.0, length(w.xz));
    base = mix(base, S.gridColor, (minor * 0.35 + major * 0.8) * fade);
  }

  // Soft contact occlusion under the floating tank.
  let tc = (S.tankModel * vec4f(0.0, 0.0, 0.0, 1.0)).xyz;
  let d = abs(w.xz - tc.xz) - S.tankHalf.xz;
  let dist = length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
  let ao = 1.0 - S.aoStrength * (1.0 - smoothstep(-0.25, 0.75, dist));

  // Soft stage spotlight around the tank.
  let r2 = dot(w.xz, w.xz);
  let stage = 0.45 + 1.1 * exp(-r2 * 0.09);
  let amb = mix(S.skyHorizon, S.skyTop, 0.4) * 1.3 + vec3f(0.015);
  var col = base * stage * (amb * ao + S.sunColor * ndl * T * vis * 0.85);

  // Caustics where the light passed through water.
  let waterAmt = 1.0 - exp(-sh.x * 5.0);
  let c = caustics(w.xz * 5.5 - 250.0, S.time * 0.8);
  col += S.sunColor * T * vis * c * waterAmt * S.misc.y * 0.22 * (S.waterShallow + 0.25);

  // Fade into the backdrop.
  let fog = smoothstep(S.misc.z * 0.3, S.misc.z, length(w - S.camPos));
  col = mix(col, envColor(-V), fog);
  return vec4f(col, 1.0);
}

struct SkyOut {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vsSky(@builtin(vertex_index) vi: u32) -> SkyOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: SkyOut;
  out.clip = vec4f(p[vi], 1.0, 1.0);
  out.ndc = p[vi];
  return out;
}

@fragment
fn fsSky(in: SkyOut) -> @location(0) vec4f {
  let a = S.invViewProj * vec4f(in.ndc, 0.0, 1.0);
  let b = S.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  return vec4f(envColor(dir), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Glass walls and cursor (blended).
export const glassCode = sceneStruct + /* wgsl */ `
@group(0) @binding(0) var<uniform> S: Scene;
` + lighting + /* wgsl */ `
struct Interact {
  tBits: u32, hasDepth: u32, pressed: u32, hover: u32,
  center: vec3f, depth: f32,
  vel: vec3f, valid: f32,
};
@group(0) @binding(3) var<storage, read> I: Interact;

struct GlassOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

@vertex
fn vsGlass(@builtin(vertex_index) vi: u32) -> GlassOut {
  let bv = boxVertex(vi);
  var out: GlassOut;
  out.world = (S.tankModel * vec4f(bv.p * (S.tankHalf + vec3f(0.004)), 1.0)).xyz;
  out.normal = (S.tankModel * vec4f(bv.n, 0.0)).xyz;
  out.uv = bv.uv;
  out.clip = S.viewProj * vec4f(out.world, 1.0);
  return out;
}

@fragment
fn fsGlass(in: GlassOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var N = normalize(in.normal);
  if (!front) { N = -N; }
  let V = normalize(S.camPos - in.world);
  let ndv = abs(dot(N, V));
  let F = 0.035 + 0.965 * pow(1.0 - ndv, 5.0);
  var col = envColor(reflect(-V, N)) * F;
  let H = normalize(-S.lightDir + V);
  col += S.sunColor * pow(max(dot(N, H), 0.0), 500.0) * 2.0;
  let e = max(abs(in.uv.x), abs(in.uv.y));
  let rim = smoothstep(0.975, 1.0, e);
  var alpha = clamp(S.glassAlpha + F * 0.55 + rim * 0.12, 0.0, 0.9);
  col += vec3f(0.55, 0.8, 1.0) * (S.glassAlpha * 0.35 + rim * 0.08);
  return vec4f(col, alpha);
}

struct CursorOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
};

@vertex
fn vsCursor(@builtin(vertex_index) vi: u32) -> CursorOut {
  var q = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                          vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  var out: CursorOut;
  let show = S.brush.z > 0.5 && I.valid > 0.5 && (I.hover != 0u || I.pressed != 0u);
  let c = (S.gridToWorld * vec4f(I.center, 1.0)).xyz;
  let r = S.brush.y * S.misc.x * 1.25;
  let fwd = normalize(c - S.camPos);
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, fwd);
  let p = c + (right * q[vi].x + up * q[vi].y) * r;
  out.clip = S.viewProj * vec4f(p, 1.0);
  if (!show) { out.clip = vec4f(2.0, 2.0, 2.0, 1.0); }
  out.uv = q[vi] * 1.25;
  var colors = array<vec3f, 8>(
    vec3f(0.35, 0.85, 1.0), vec3f(1.0, 0.75, 0.3), vec3f(0.6, 0.55, 1.0), vec3f(1.0, 0.4, 0.6),
    vec3f(0.3, 0.95, 0.65), vec3f(1.0, 0.45, 0.3), vec3f(1.0, 0.6, 0.35), vec3f(0.9, 0.9, 1.0));
  let ci = u32(clamp(S.brush.x, 0.0, 7.0));
  out.color = vec4f(colors[ci], select(0.65, 1.0, I.pressed != 0u));
  return out;
}

@fragment
fn fsCursor(in: CursorOut) -> @location(0) vec4f {
  let d = length(in.uv);
  let fw = fwidth(d);
  let ring = 1.0 - smoothstep(0.035, 0.035 + fw * 1.5, abs(d - 1.0));
  let glow = exp(-abs(d - 1.0) * 10.0) * 0.35;
  let fill = select(0.0, 0.06, d < 1.0);
  let a = clamp((ring * 0.9 + glow + fill) * in.color.a, 0.0, 1.0);
  return vec4f(in.color.rgb * 1.6 * a, a);
}
`;

// ---------------------------------------------------------------------------
// Post: bloom down/up sampling and final composite.
const fullscreen = /* wgsl */ `
struct FsOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> FsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: FsOut;
  out.clip = vec4f(p[vi], 0.0, 1.0);
  out.uv = vec2f(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return out;
}
`;

export const bloomCode = fullscreen + /* wgsl */ `
struct BloomParams { texel: vec2f, threshold: f32, knee: f32 };
@group(0) @binding(0) var<uniform> B: BloomParams;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment
fn fsDown(in: FsOut) -> @location(0) vec4f {
  let t = B.texel;
  var c = textureSampleLevel(src, samp, in.uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(src, samp, in.uv + vec2f(-t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(-t.x, t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(t.x, t.y), 0.0).rgb;
  c /= 8.0;
  if (B.threshold > 0.0) {
    let br = max(c.r, max(c.g, c.b));
    var soft = clamp(br - B.threshold + B.knee, 0.0, 2.0 * B.knee);
    soft = soft * soft / (4.0 * B.knee + 1e-4);
    let contrib = max(soft, br - B.threshold) / max(br, 1e-4);
    c *= contrib;
  }
  return vec4f(min(c, vec3f(64.0)), 1.0);
}

@fragment
fn fsUp(in: FsOut) -> @location(0) vec4f {
  let t = B.texel;
  var c = textureSampleLevel(src, samp, in.uv + vec2f(-2.0 * t.x, 0.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(2.0 * t.x, 0.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(0.0, -2.0 * t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(0.0, 2.0 * t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(-t.x, -t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv + vec2f(t.x, -t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv + vec2f(-t.x, t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv + vec2f(t.x, t.y), 0.0).rgb * 2.0;
  return vec4f(c / 12.0, 1.0);
}
`;

export const compositeCode = fullscreen + /* wgsl */ `
struct Post { exposure: f32, bloom: f32, vignette: f32, time: f32, aspect: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(0) var<uniform> U: Post;
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

@fragment
fn fsMain(in: FsOut) -> @location(0) vec4f {
  var hdr = textureSampleLevel(hdrTex, samp, in.uv, 0.0).rgb;
  hdr += textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb * U.bloom;
  var c = aces(hdr * U.exposure);
  let d = (in.uv - 0.5) * vec2f(U.aspect, 1.0);
  c *= 1.0 - U.vignette * smoothstep(0.35, 1.25, length(d));
  c = toSrgb(c);
  let n = fract(sin(dot(in.clip.xy + U.time, vec2f(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 255.0;
  return vec4f(c, 1.0);
}
`;
