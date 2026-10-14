// Static configuration: tank geometry, quality presets, scenes and themes.

/** Tank interior size in world units (metres-ish). Height is 1. */
export const TANK = {
  size: [2.0, 1.0, 1.0],
  floatHeight: 0.36, // gap between floor and tank bottom
  margin: 2,         // grid cells outside the walls (boundary layer)
};

/**
 * Quality presets. `n` = grid cells along the tank height. Particles are
 * seeded 2x2x2 per cell, so cube size = 1 / (2n) of the tank height.
 */
export const QUALITY = {
  low:     { label: 'Low',     n: 18, shadow: 768,  fill: 0.62 },
  medium:  { label: 'Medium',  n: 24, shadow: 1024, fill: 0.62 },
  high:    { label: 'High',    n: 30, shadow: 1024, fill: 0.62 },
  ultra:   { label: 'Ultra',   n: 36, shadow: 1280, fill: 0.62 },
  extreme: { label: 'Extreme', n: 44, shadow: 1536, fill: 0.6 },
};
export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra', 'extreme'];

export function gridForQuality(q) {
  const n = QUALITY[q].n;
  const interior = TANK.size.map((s) => Math.round(s * n));
  const gridRes = interior.map((c) => c + TANK.margin * 2);
  const dx = TANK.size[1] / n;
  const capacity = Math.ceil(interior[0] * interior[1] * interior[2] * 8 * QUALITY[q].fill);
  return { n, interior, gridRes, dx, capacity };
}

/**
 * Scenes. Regions are in tank units: x in [0, 2], y in [0, 1], z in [0, 1].
 * dye: 'x' (gradient along x), 'y' (layers) or a number in [0, 1].
 */
export const SCENES = {
  dambreak: {
    label: 'Dam Break',
    desc: 'A wall of water collapses',
    regions: [{ box: [[0, 0, 0], [0.72, 0.82, 1]], dye: 'x' }],
  },
  doubledam: {
    label: 'Clash',
    desc: 'Two columns collide',
    regions: [
      { box: [[0, 0, 0], [0.46, 0.8, 1]], dye: 0.08 },
      { box: [[1.54, 0, 0], [2, 0.8, 1]], dye: 0.92 },
    ],
  },
  drop: {
    label: 'Big Drop',
    desc: 'A cube plunges into a pool',
    regions: [
      { box: [[0, 0, 0], [2, 0.3, 1]], dye: 0.2 },
      { box: [[0.78, 0.5, 0.29], [1.22, 0.94, 0.71]], dye: 0.85, vel: [0, -0.6, 0] },
    ],
  },
  pool: {
    label: 'Calm Pool',
    desc: 'Still water to play with',
    regions: [{ box: [[0, 0, 0], [2, 0.4, 1]], dye: 'x' }],
  },
  wavetank: {
    label: 'Wave Tank',
    desc: 'A paddle makes rolling waves',
    regions: [{ box: [[0.1, 0, 0], [2, 0.36, 1]], dye: 'x' }],
    settings: { waveMachine: true },
  },
  tower: {
    label: 'Tower',
    desc: 'A tall column topples',
    regions: [
      { box: [[0, 0, 0], [2, 0.1, 1]], dye: 0.15 },
      { box: [[0.8, 0.1, 0.3], [1.2, 0.98, 0.7]], dye: 'y' },
    ],
  },
  zerog: {
    label: 'Zero-G',
    desc: 'A floating blob in free fall',
    regions: [{ sphere: [[1, 0.5, 0.5], 0.36], dye: 'y' }],
    settings: { gravity: 0 },
  },
  layers: {
    label: 'Layer Cake',
    desc: 'Stacked colours mix as you stir',
    regions: [{ box: [[0, 0, 0], [2, 0.5, 1]], dye: 'y' }],
    settings: { colorMode: 'dye' },
  },
};
export const SCENE_ORDER = ['dambreak', 'doubledam', 'drop', 'pool', 'wavetank', 'tower', 'zerog', 'layers'];

/** Water colour themes (linear RGB). */
export const WATER_THEMES = {
  ocean: {
    label: 'Ocean', swatch: ['#1fb6ff', '#0a3d91'],
    shallow: [0.06, 0.42, 0.78], deep: [0.004, 0.035, 0.12], absorption: [6.5, 2.6, 1.25],
    foam: [0.92, 0.97, 1.0], emissive: 0,
  },
  tropical: {
    label: 'Lagoon', swatch: ['#3ff3d6', '#0b6f8a'],
    shallow: [0.18, 0.86, 0.8], deep: [0.0, 0.14, 0.2], absorption: [2.8, 0.75, 0.75],
    foam: [0.95, 1.0, 0.98], emissive: 0,
  },
  glacier: {
    label: 'Glacier', swatch: ['#d6f4ff', '#5b9bd5'],
    shallow: [0.62, 0.86, 0.98], deep: [0.08, 0.2, 0.42], absorption: [1.6, 0.8, 0.45],
    foam: [1, 1, 1], emissive: 0,
  },
  lava: {
    label: 'Lava', swatch: ['#ffb02e', '#a3160b'],
    shallow: [0.85, 0.16, 0.02], deep: [0.12, 0.01, 0.0], absorption: [0.6, 2.6, 5.0],
    foam: [1.0, 0.78, 0.28], emissive: 1.25,
  },
  toxic: {
    label: 'Toxic', swatch: ['#b6ff3b', '#1f6b12'],
    shallow: [0.32, 0.85, 0.08], deep: [0.01, 0.12, 0.02], absorption: [2.6, 0.7, 3.4],
    foam: [0.85, 1.0, 0.6], emissive: 0.45,
  },
  ink: {
    label: 'Ink', swatch: ['#a78bfa', '#1e1250'],
    shallow: [0.42, 0.3, 0.95], deep: [0.03, 0.01, 0.12], absorption: [1.8, 2.4, 0.9],
    foam: [0.95, 0.9, 1.0], emissive: 0,
  },
};
export const WATER_ORDER = ['ocean', 'tropical', 'glacier', 'lava', 'toxic', 'ink'];

/** Environment / lighting themes (linear RGB). */
export const ENVIRONMENTS = {
  studio: {
    label: 'Studio',
    skyTop: [0.012, 0.018, 0.035], skyHorizon: [0.07, 0.09, 0.14], ground: [0.05, 0.058, 0.08],
    sun: [2.5, 2.38, 2.2], lightDir: [0.38, -1.0, 0.5], exposure: 1.1, fogFar: 13,
    gridColor: [0.12, 0.15, 0.22],
  },
  day: {
    label: 'Daylight',
    skyTop: [0.18, 0.38, 0.78], skyHorizon: [0.62, 0.74, 0.88], ground: [0.52, 0.53, 0.55],
    sun: [3.1, 2.95, 2.7], lightDir: [0.35, -1.0, 0.45], exposure: 0.9, fogFar: 16,
    gridColor: [0.42, 0.44, 0.48],
  },
  sunset: {
    label: 'Sunset',
    skyTop: [0.05, 0.035, 0.12], skyHorizon: [0.78, 0.33, 0.17], ground: [0.1, 0.06, 0.07],
    sun: [3.0, 1.55, 0.75], lightDir: [0.8, -0.5, 0.35], exposure: 1.0, fogFar: 14,
    gridColor: [0.24, 0.13, 0.12],
  },
  night: {
    label: 'Midnight',
    skyTop: [0.005, 0.008, 0.02], skyHorizon: [0.02, 0.03, 0.06], ground: [0.02, 0.022, 0.03],
    sun: [1.3, 1.5, 2.1], lightDir: [-0.3, -1.0, 0.5], exposure: 1.4, fogFar: 10,
    gridColor: [0.06, 0.08, 0.13],
  },
};
export const ENV_ORDER = ['studio', 'day', 'sunset', 'night'];

export const TOOLS = [
  { id: 'push', label: 'Push', key: '1', hint: 'Drag through the water to push it around' },
  { id: 'splash', label: 'Splash', key: '2', hint: 'Click to blast a splash; hold to keep blasting' },
  { id: 'vortex', label: 'Vortex', key: '3', hint: 'Hold to spin up a whirlpool' },
  { id: 'magnet', label: 'Magnet', key: '4', hint: 'Hold to pull water in. Shift to repel' },
  { id: 'pour', label: 'Pour', key: '5', hint: 'Hold to pour water in from above' },
  { id: 'drain', label: 'Drain', key: '6', hint: 'Hold to suck water out' },
  { id: 'ball', label: 'Ball', key: '7', hint: 'Drag or throw the ball; let go and it floats' },
  { id: 'shake', label: 'Shake', key: '8', hint: 'Grab the tank and shake it' },
];

export const DEFAULT_SETTINGS = {
  scene: 'dambreak',
  tool: 'push',
  quality: 'auto',
  // physics
  gravity: 1,
  viscosity: 0.08,
  stiffness: 1,
  speed: 1,
  waveMachine: false,
  waveAmplitude: 0.5,
  waveFrequency: 0.55,
  tiltX: 0,
  tiltZ: 0,
  autoRock: false,
  brushSize: 1,
  brushStrength: 1,
  ballSize: 1,
  ballDensity: 0.45,
  // visuals
  water: 'ocean',
  env: 'studio',
  colorMode: 'theme',
  cubeSize: 1,
  tumble: true,
  foam: true,
  shadows: true,
  glass: true,
  bloom: true,
  caustics: true,
  floorGrid: true,
  autoRotate: false,
  renderScale: 1,
  autoScale: true,
  msaa: true,
  showStats: true,
};
