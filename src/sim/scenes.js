// CPU-side particle seeding for scene presets.
import { PARTICLE_FLOATS } from './fluid.js';

/**
 * Build the initial particle buffer for a scene.
 * @param {object} scene  scene definition from config.SCENES
 * @param {{ interior: number[], n: number, capacity: number }} grid
 * @param {number} margin grid cells outside the walls
 * @param {number} restDensity
 * @returns {{ data: Float32Array, count: number }}
 */
export function buildScene(scene, grid, margin, restDensity) {
  const spacing = 0.5;
  const [ix, iy, iz] = grid.interior;
  const unit = grid.n; // grid cells per tank unit (tank height = 1)
  const data = new Float32Array(grid.capacity * PARTICLE_FLOATS);
  let count = 0;
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const nx = Math.round(ix / spacing);
  const ny = Math.round(iy / spacing);
  const nz = Math.round(iz / spacing);
  const jitter = 0.06 * spacing;

  for (let k = 0; k < nz && count < grid.capacity; k++) {
    for (let j = 0; j < ny && count < grid.capacity; j++) {
      for (let i = 0; i < nx && count < grid.capacity; i++) {
        // Position in tank units.
        const tx = ((i + 0.5) * spacing) / unit;
        const ty = ((j + 0.5) * spacing) / unit;
        const tz = ((k + 0.5) * spacing) / unit;
        const region = scene.regions.find((r) => inside(r, tx, ty, tz));
        if (!region) continue;
        const o = count * PARTICLE_FLOATS;
        data[o] = margin + (i + 0.5) * spacing + (rnd() - 0.5) * jitter;
        data[o + 1] = margin + (j + 0.5) * spacing + (rnd() - 0.5) * jitter;
        data[o + 2] = margin + (k + 0.5) * spacing + (rnd() - 0.5) * jitter;
        data[o + 3] = 0; // foam
        const v = region.vel || [0, 0, 0];
        data[o + 4] = v[0]; data[o + 5] = v[1]; data[o + 6] = v[2];
        data[o + 7] = dyeFor(region, tx, ty, tz);
        data[o + 11] = restDensity; // density
        data[o + 15] = 0;           // flags
        data[o + 19] = rnd();       // seed
        data[o + 23] = 1;           // rot = identity quaternion
        count++;
      }
    }
  }
  return { data, count };
}

function inside(r, x, y, z) {
  if (r.box) {
    const [a, b] = r.box;
    return x >= a[0] && x < b[0] && y >= a[1] && y < b[1] && z >= a[2] && z < b[2];
  }
  if (r.sphere) {
    const [c, rad] = r.sphere;
    const dx = x - c[0], dy = y - c[1], dz = z - c[2];
    return dx * dx + dy * dy + dz * dz < rad * rad;
  }
  return false;
}

function dyeFor(r, x, y, z) {
  if (typeof r.dye === 'number') return r.dye;
  if (r.dye === 'x') return Math.min(1, Math.max(0, x / 2));
  if (r.dye === 'y') {
    // Stripes of colour by height for the layered look.
    const bands = 5;
    const lo = r.box ? r.box[0][1] : r.sphere[0][1] - r.sphere[1];
    const hi = r.box ? r.box[1][1] : r.sphere[0][1] + r.sphere[1];
    const t = (y - lo) / Math.max(1e-6, hi - lo);
    return (Math.floor(t * bands) + 0.5) / bands;
  }
  return Math.min(1, Math.max(0, z));
}
