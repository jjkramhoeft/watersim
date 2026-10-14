// Rigid-body motion of the tank: spring-driven translation (shaking) and
// tilting. The simulation runs in the tank frame, so this motion becomes
// inertial forces on the water.
import { quat, clamp } from './math.js';

const DEG = Math.PI / 180;
export const MAX_TILT = 18 * DEG;
const MAX_OFFSET = 0.38;

export class Tank {
  constructor() {
    this.reset();
  }

  reset() {
    this.pos = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.acc = [0, 0, 0];
    this.target = [0, 0, 0];
    this.grabbed = false;
    this.tilt = [0, 0];      // rotation about world X and Z (radians)
    this.tiltVel = [0, 0];
    this.tiltAcc = [0, 0];
    this.tiltTarget = [0, 0];
    this.quakeTime = 0;
    this.quakePhase = [0, 0, 0, 0];
    this.time = 0;
  }

  earthquake(duration = 2.6) {
    this.quakeTime = duration;
    this.quakePhase = [0, 1, 2, 3].map(() => Math.random() * Math.PI * 2);
    const a = Math.random() * Math.PI * 2;
    this.quakeDir = [Math.cos(a), Math.sin(a)];
  }

  /** Displace the tank target while the user drags it (world offset). */
  grab(offset) {
    this.grabbed = true;
    this.target = [clamp(offset[0], -MAX_OFFSET, MAX_OFFSET), 0, clamp(offset[2], -MAX_OFFSET, MAX_OFFSET)];
  }

  release() {
    this.grabbed = false;
    this.target = [0, 0, 0];
  }

  /**
   * Advance by dt seconds of simulated time.
   * @param {number} dt
   * @param {[number, number]} tiltGoal requested tilt (radians)
   */
  step(dt, tiltGoal) {
    this.time += dt;
    // Translational spring-damper; stiffer while grabbed for responsiveness.
    const w = this.grabbed ? 15 : 9;
    const zeta = this.grabbed ? 0.85 : 0.32;
    let tx = this.target[0], tz = this.target[2], ty = 0;
    if (this.quakeTime > 0) {
      this.quakeTime -= dt;
      // A few seconds of shaking: a strong low rumble near the sloshing
      // frequencies plus a little high-frequency jitter.
      const env = Math.min(1, this.quakeTime / 0.6) * Math.min(1, (2.6 - this.quakeTime) / 0.3 + 0.2);
      const t = this.time;
      const p = this.quakePhase;
      const s = env * (0.06 * Math.sin(t * 10.5 + p[0]) + 0.012 * Math.sin(t * 23 + p[1]));
      const s2 = env * 0.035 * Math.sin(t * 13 + p[2]);
      tx += this.quakeDir[0] * s - this.quakeDir[1] * s2;
      tz += this.quakeDir[1] * s + this.quakeDir[0] * s2;
      ty += 0.012 * env * Math.sin(t * 17 + p[3]);
    }
    const tgt = [tx, ty, tz];
    for (let i = 0; i < 3; i++) {
      const wi = this.quakeTime > 0 ? 40 : w;
      const zi = this.quakeTime > 0 ? 0.7 : zeta;
      const a = wi * wi * (tgt[i] - this.pos[i]) - 2 * zi * wi * this.vel[i];
      this.acc[i] = a;
      this.vel[i] += a * dt;
      this.pos[i] += this.vel[i] * dt;
    }

    // Tilt spring.
    const goal = [clamp(tiltGoal[0], -MAX_TILT, MAX_TILT), clamp(tiltGoal[1], -MAX_TILT, MAX_TILT)];
    const wt = 7, zt = 0.85;
    for (let i = 0; i < 2; i++) {
      const a = wt * wt * (goal[i] - this.tilt[i]) - 2 * zt * wt * this.tiltVel[i];
      this.tiltAcc[i] = a;
      this.tiltVel[i] += a * dt;
      this.tilt[i] += this.tiltVel[i] * dt;
    }
  }

  get rotation() {
    const qx = quat.fromAxisAngle([1, 0, 0], this.tilt[0]);
    const qz = quat.fromAxisAngle([0, 0, 1], this.tilt[1]);
    return quat.multiply(qz, qx);
  }

  /** World angular velocity / acceleration (small-angle approximation). */
  get angularVelocity() {
    return [this.tiltVel[0], 0, this.tiltVel[1]];
  }

  get angularAcceleration() {
    return [this.tiltAcc[0], 0, this.tiltAcc[1]];
  }
}
