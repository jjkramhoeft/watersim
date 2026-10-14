// Smoothed orbit camera.
import { mat4, vec3, clamp, damp } from './math.js';

export class OrbitCamera {
  constructor() {
    this.fov = (36 * Math.PI) / 180;
    this.near = 0.05;
    this.far = 80;
    this.floorY = 0;
    this.home = { yaw: 0.62, pitch: 0.36, distance: 3.75, target: [0, 0.78, 0] };
    this.goal = { ...this.home, target: [...this.home.target] };
    this.cur = { ...this.home, target: [...this.home.target] };
    this.autoRotate = false;
    this.position = [0, 0, 0];
    this.view = mat4.identity();
    this.proj = mat4.identity();
    this.viewProj = mat4.identity();
    this.invViewProj = mat4.identity();
  }

  reset() {
    this.goal = { ...this.home, target: [...this.home.target] };
  }

  rotate(dx, dy) {
    this.goal.yaw -= dx * 0.0055;
    this.goal.pitch = clamp(this.goal.pitch + dy * 0.0045, -0.12, 1.45);
  }

  zoom(factor) {
    this.goal.distance = clamp(this.goal.distance * factor, 1.4, 12);
  }

  pan(dx, dy) {
    const s = this.cur.distance * 0.0011;
    const yaw = this.cur.yaw;
    const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const t = this.goal.target;
    t[0] -= right[0] * dx * s;
    t[2] -= right[2] * dx * s;
    t[1] = clamp(t[1] + dy * s, 0.1, 2.5);
    // Keep the target near the tank.
    const r = Math.hypot(t[0], t[2]);
    if (r > 2.5) { t[0] *= 2.5 / r; t[2] *= 2.5 / r; }
  }

  /**
   * @param {number} dt
   * @param {number} width  viewport width (px)
   * @param {number} height viewport height (px)
   * @param {{ right: number, bottom: number }} inset  screen area covered by UI (px)
   */
  update(dt, width, height, inset = { right: 0, bottom: 0 }) {
    if (this.autoRotate) this.goal.yaw += dt * 0.12;
    const k = damp(14, dt);
    const c = this.cur, g = this.goal;
    c.yaw += (g.yaw - c.yaw) * k;
    c.pitch += (g.pitch - c.pitch) * k;
    c.distance += (g.distance - c.distance) * k;
    c.target = vec3.lerp(c.target, g.target, k);
    // Smoothly follow UI insets so the tank stays centred in the free area.
    const ki = damp(8, dt);
    this.shift = this.shift || [0, 0, 1];
    const visW = Math.max(1, width - inset.right), visH = Math.max(1, height - inset.bottom);
    // Distance needed to fit the tank into the free area, relative to the
    // framing the default distance was tuned for (a 16:10 landscape view).
    const t = 2 * Math.tan(this.fov / 2);
    const need = Math.max(2.1 / (t * (visW / height)), 1.55 / (t * (visH / height)));
    const ref = Math.max(2.1 / (t * 1.6), 1.55 / t);
    const fit = Math.max(1, need / ref);
    this.shift[0] += (-inset.right / width - this.shift[0]) * ki;
    this.shift[1] += (inset.bottom / height - this.shift[1]) * ki;
    this.shift[2] += (fit - this.shift[2]) * ki;

    const dist = c.distance * this.shift[2];
    const cp = Math.cos(c.pitch);
    let eye = [
      c.target[0] + dist * cp * Math.sin(c.yaw),
      c.target[1] + dist * Math.sin(c.pitch),
      c.target[2] + dist * cp * Math.cos(c.yaw),
    ];
    // Never dip below the floor.
    if (eye[1] < this.floorY + 0.06) eye[1] = this.floorY + 0.06;
    this.position = eye;
    this.view = mat4.lookAt(eye, c.target, [0, 1, 0]);
    this.proj = mat4.perspective(this.fov, width / height, this.near, this.far);
    // Lens shift: move the principal point into the centre of the free area.
    this.proj[8] = -this.shift[0];
    this.proj[9] = -this.shift[1];
    this.viewProj = mat4.multiply(this.proj, this.view);
    this.invViewProj = mat4.invert(this.viewProj);
  }

  /** World-space ray through normalised device coordinates. */
  ray(ndcX, ndcY) {
    const a = mat4.transformPoint(this.invViewProj, [ndcX, ndcY, 0]);
    const b = mat4.transformPoint(this.invViewProj, [ndcX, ndcY, 1]);
    return { origin: a, dir: vec3.normalize(vec3.sub(b, a)) };
  }
}
