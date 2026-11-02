import * as THREE from 'three';
import { RAPIER, WORLD_FILTER, type Physics } from '../core/Physics';
import type { Humanoid, Limb } from './Humanoid';

/** Particle indices. */
const J = { hips: 0, neck: 1, head: 2, shL: 3, elL: 4, haL: 5, shR: 6, elR: 7, haR: 8, hpL: 9, knL: 10, ftL: 11, hpR: 12, knR: 13, ftR: 14 } as const;
const COUNT = 15;
const RADIUS = [0.14, 0.12, 0.12, 0.08, 0.06, 0.05, 0.08, 0.06, 0.05, 0.1, 0.07, 0.06, 0.1, 0.07, 0.06];
const GRAVITY = -9.8;
const STEP = 1 / 60;

interface Link { a: number; b: number; rest: number; k: number; min: boolean }

/**
 * Extra spheres for hit tests along the long bones (particle pairs): rounds landing in a belly or
 * a thigh between two joints still find the body.
 */
const SPANS: [number, number, number][] = [
  [J.hips, J.neck, 0.15], [J.shL, J.elL, 0.07], [J.shR, J.elR, 0.07], [J.elL, J.haL, 0.06], [J.elR, J.haR, 0.06],
  [J.hpL, J.knL, 0.1], [J.hpR, J.knR, 0.1], [J.knL, J.ftL, 0.075], [J.knR, J.ftR, 0.075],
];
/** Particles a hard landing is felt through (the body's weight). */
const HEAVY: readonly number[] = [J.hips, J.neck, J.shL, J.shR];

/** Which particles take the push of a killing hit, by zone. */
export const ZONE_PARTICLES: Record<string, number[]> = {
  head: [J.head, J.neck],
  torso: [J.neck, J.shL, J.shR, J.hips],
  armL: [J.elL, J.haL, J.shL],
  armR: [J.elR, J.haR, J.shR],
  legL: [J.knL, J.ftL],
  legR: [J.knR, J.ftR],
};

/**
 * Verlet ragdoll for a dead character: 15 particles held together by distance links (rigid
 * torso, swinging head and limbs, folding limits), colliding with the static world and doors
 * by swept rays. It writes its pose into the Humanoid's bones and goes to sleep once still.
 */
export class Ragdoll {
  private readonly pos = new Float32Array(COUNT * 3);
  private readonly prev = new Float32Array(COUNT * 3);
  private readonly snapshot = new Float32Array(COUNT * 3);
  private readonly links: Link[] = [];
  private floor = -Infinity;
  private acc = 0;
  private stillT = 0;
  private age = 0;
  asleep = false;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  /** Other bodies nearby (set each frame): this one lands on them and rolls off instead of passing through. */
  obstacles: Ragdoll[] = [];
  /** It hit the ground or a wall hard: where, and how hard 0..1 (a few times per body at most). */
  onImpact: ((pos: THREE.Vector3, strength: number) => void) | null = null;
  private impacts = 0;
  private lastImpact = -1;
  private impactSpeed = 0;
  private readonly impactAt = new THREE.Vector3();

  constructor(private readonly physics: Physics, private readonly body: Humanoid) {}

  /** Starts from the character's current pose, moving at `vel`, plus per-particle pushes. */
  start(vel: THREE.Vector3, pushes: { joints: number[]; impulse: THREE.Vector3 }[]): void {
    const b = this.body;
    b.root.updateMatrixWorld(true);
    const at = (o: THREE.Object3D, i: number, x = 0, y = 0, z = 0) => {
      _v.set(x, y, z);
      o.localToWorld(_v);
      this.pos[i * 3] = _v.x;
      this.pos[i * 3 + 1] = _v.y;
      this.pos[i * 3 + 2] = _v.z;
    };
    at(b.hips, J.hips);
    at(b.head, J.neck);
    at(b.head, J.head, 0, 0.2, 0.02);
    const limb = (l: Limb, s: number, e: number, h: number) => {
      at(l.upper, s);
      at(l.lower, e);
      at(l.end, h);
    };
    limb(b.armL, J.shL, J.elL, J.haL);
    limb(b.armR, J.shR, J.elR, J.haR);
    limb(b.legL, J.hpL, J.knL, J.ftL);
    limb(b.legR, J.hpR, J.knR, J.ftR);

    this.links.length = 0;
    const link = (a: number, c: number, k = 1, min = false, rest?: number) => this.links.push({ a, b: c, rest: rest ?? this.dist(a, c), k, min });
    const torso = [J.hips, J.neck, J.shL, J.shR, J.hpL, J.hpR];
    for (let i = 0; i < torso.length; i++) for (let j = i + 1; j < torso.length; j++) link(torso[i], torso[j]);
    link(J.neck, J.head);
    link(J.head, J.shL, 0.35);
    link(J.head, J.shR, 0.35);
    link(J.head, J.hips, 1, true, this.dist(J.head, J.hips) * 0.9);
    for (const [s, e, h] of [[J.shL, J.elL, J.haL], [J.shR, J.elR, J.haR]]) {
      link(s, e);
      link(e, h);
      link(s, h, 1, true, 0.24);
      link(h, J.hips, 1, true, 0.18);
    }
    for (const [s, e, h] of [[J.hpL, J.knL, J.ftL], [J.hpR, J.knR, J.ftR]]) {
      link(s, e);
      link(e, h);
      link(s, h, 1, true, 0.55);
    }
    link(J.ftL, J.ftR, 1, true, 0.12);
    link(J.knL, J.knR, 1, true, 0.1);

    for (let i = 0; i < COUNT; i++) {
      _v.copy(vel);
      for (const p of pushes) if (p.joints.includes(i)) _v.add(p.impulse);
      this.prev[i * 3] = this.pos[i * 3] - _v.x * STEP;
      this.prev[i * 3 + 1] = this.pos[i * 3 + 1] - _v.y * STEP;
      this.prev[i * 3 + 2] = this.pos[i * 3 + 2] - _v.z * STEP;
    }
    // The floor under the body catches anything the swept rays miss.
    const hx = this.pos[0], hy = this.pos[1], hz = this.pos[2];
    const d = this.physics.raycast(hx, hy + 0.3, hz, 0, -1, 0, 3);
    this.floor = d === null ? hy - 1.2 : hy + 0.3 - d;
    this.snapshot.set(this.pos);
    this.acc = 0;
    this.age = 0;
    this.stillT = 0;
    this.asleep = false;
    this.impacts = 0;
    this.lastImpact = -1;
    this.obstacles = [];
    b.ragdoll = true;
  }

  /**
   * Adds velocity `v` (m/s) to `joints` (all of them when null) and wakes the body: shot, kicked
   * or thrown by a blast where it lies.
   */
  impulse(joints: readonly number[] | null, v: THREE.Vector3): void {
    const add = (i: number) => {
      this.prev[i * 3] -= v.x * STEP;
      this.prev[i * 3 + 1] -= v.y * STEP;
      this.prev[i * 3 + 2] -= v.z * STEP;
    };
    if (joints) for (const i of joints) add(i);
    else for (let i = 0; i < COUNT; i++) add(i);
    if (this.asleep || this.age > 5) {
      // Gets a few more seconds to come to rest again, and may thud down again.
      this.age = Math.min(this.age, 4);
      this.impacts = Math.min(this.impacts, 1);
    }
    this.asleep = false;
    this.stillT = 0;
  }

  /**
   * The nearest place a ray from `o` along unit `d` meets the body within `maxT`: the distance
   * and the particle nearest it (for the push), or null.
   */
  hitTest(o: THREE.Vector3, d: THREE.Vector3, maxT: number): { t: number; joint: number } | null {
    const p = this.pos;
    // Cheap reject on the whole body (it is never more than ~1.2 m from its hips).
    if (sphereT(o, d, p[0], p[1], p[2], 1.25) === null) return null;
    let best = maxT, joint = -1;
    for (let i = 0; i < COUNT; i++) {
      const t = sphereT(o, d, p[i * 3], p[i * 3 + 1], p[i * 3 + 2], Math.max(0.09, RADIUS[i] * 1.35));
      if (t !== null && t < best) {
        best = t;
        joint = i;
      }
    }
    for (const [a, b, r] of SPANS) {
      const t = sphereT(o, d, (p[a * 3] + p[b * 3]) / 2, (p[a * 3 + 1] + p[b * 3 + 1]) / 2, (p[a * 3 + 2] + p[b * 3 + 2]) / 2, r);
      if (t !== null && t < best) {
        best = t;
        joint = a;
      }
    }
    return joint < 0 ? null : { t: best, joint };
  }

  /** Index of the particle nearest `at` (and its world position in `out`). */
  nearest(at: THREE.Vector3, out?: THREE.Vector3): number {
    const p = this.pos;
    let best = Infinity, k = 0;
    for (let i = 0; i < COUNT; i++) {
      const d = (p[i * 3] - at.x) ** 2 + (p[i * 3 + 1] - at.y) ** 2 + (p[i * 3 + 2] - at.z) ** 2;
      if (d < best) {
        best = d;
        k = i;
      }
    }
    out?.set(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]);
    return k;
  }

  /** World position of particle `i`. */
  joint(i: number, out: THREE.Vector3): THREE.Vector3 {
    return this.P(i, out);
  }

  private dist(a: number, b: number): number {
    const p = this.pos;
    return Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  }

  update(dt: number): void {
    if (this.asleep) return;
    this.acc = Math.min(this.acc + dt, STEP * 4);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.step();
    }
    this.apply();
  }

  private step(): void {
    const p = this.pos, q = this.prev;
    this.age += STEP;
    let maxMove = 0;
    const world = this.physics.world;
    for (let i = 0; i < COUNT; i++) {
      const o = i * 3;
      const vx = (p[o] - q[o]) * 0.985, vy = (p[o + 1] - q[o + 1]) * 0.985, vz = (p[o + 2] - q[o + 2]) * 0.985;
      q[o] = p[o]; q[o + 1] = p[o + 1]; q[o + 2] = p[o + 2];
      let nx = p[o] + vx, ny = p[o + 1] + vy + GRAVITY * STEP * STEP, nz = p[o + 2] + vz;
      // Swept collision against the world.
      const dx = nx - q[o], dy = ny - q[o + 1], dz = nz - q[o + 2];
      const len = Math.hypot(dx, dy, dz);
      const r = RADIUS[i];
      if (len > 1e-5) {
        this.ray.origin = { x: q[o], y: q[o + 1], z: q[o + 2] };
        this.ray.dir = { x: dx / len, y: dy / len, z: dz / len };
        const hit = world.castRayAndGetNormal(this.ray, len + r, true, undefined, WORLD_FILTER);
        if (hit && hit.timeOfImpact > 1e-4) {
          const t = Math.max(0, hit.timeOfImpact - r);
          const n = hit.normal;
          nx = q[o] + (dx / len) * t + n.x * 0.002;
          ny = q[o + 1] + (dy / len) * t + n.y * 0.002;
          nz = q[o + 2] + (dz / len) * t + n.z * 0.002;
          // Kill the normal velocity, keep some slide.
          const vn = vx * n.x + vy * n.y + vz * n.z;
          if (-vn > this.impactSpeed * STEP && HEAVY.includes(i)) {
            this.impactSpeed = -vn / STEP;
            this.impactAt.set(nx, ny, nz);
          }
          const tx = vx - vn * n.x, ty = vy - vn * n.y, tz = vz - vn * n.z;
          q[o] = nx - tx * 0.5 + vn * n.x * 0.1;
          q[o + 1] = ny - ty * 0.5 + vn * n.y * 0.1;
          q[o + 2] = nz - tz * 0.5 + vn * n.z * 0.1;
        }
      }
      p[o] = nx; p[o + 1] = ny; p[o + 2] = nz;
    }
    for (let it = 0; it < 6; it++) {
      for (const l of this.links) {
        const a = l.a * 3, b = l.b * 3;
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        if (l.min && d >= l.rest) continue;
        const k = ((d - l.rest) / d) * 0.5 * l.k;
        p[a] += dx * k; p[a + 1] += dy * k; p[a + 2] += dz * k;
        p[b] -= dx * k; p[b + 1] -= dy * k; p[b + 2] -= dz * k;
      }
      // Every other pass is enough to keep piled bodies apart (and halves the cost).
      if (it & 1) for (const o of this.obstacles) this.collide(o);
      for (let i = 0; i < COUNT; i++) {
        const y = this.floor + RADIUS[i];
        if (p[i * 3 + 1] < y) {
          if (it === 0 && HEAVY.includes(i)) {
            const fall = (q[i * 3 + 1] - p[i * 3 + 1]) / STEP;
            if (fall > this.impactSpeed) {
              this.impactSpeed = fall;
              this.impactAt.set(p[i * 3], y, p[i * 3 + 2]);
            }
          }
          p[i * 3 + 1] = y;
          // Ground friction.
          q[i * 3] += (p[i * 3] - q[i * 3]) * 0.4;
          q[i * 3 + 2] += (p[i * 3 + 2] - q[i * 3 + 2]) * 0.4;
        }
      }
    }
    // A hard landing is heard (the first one loudest; rattling about on the ground is not).
    if (this.impactSpeed > 1.6 && this.impacts < 3 && this.age - this.lastImpact > 0.3) {
      this.impacts++;
      this.lastImpact = this.age;
      this.onImpact?.(this.impactAt, Math.min(1, (this.impactSpeed - 1) / 5));
    }
    this.impactSpeed = 0;
    // Contacts jitter a little every step: judge stillness over a window instead.
    this.stillT += STEP;
    if (this.stillT >= 0.25) {
      this.stillT = 0;
      for (let i = 0; i < COUNT * 3; i++) {
        maxMove = Math.max(maxMove, Math.abs(p[i] - this.snapshot[i]));
        this.snapshot[i] = p[i];
      }
      if ((this.age > 0.8 && maxMove < 0.015) || this.age > 7) this.asleep = true;
    }
  }

  /**
   * Keeps this body's particles out of another body's: it lands on a corpse already lying there
   * and rolls off it (only this one moves, so a pile settles instead of jittering).
   */
  private collide(o: Ragdoll): void {
    if (o === this) return;
    const p = this.pos, q = o.pos;
    const hx = p[0] - q[0], hz = p[2] - q[2];
    if (hx * hx + hz * hz > 2.4 * 2.4) return;
    for (let i = 0; i < COUNT; i++) {
      const ri = RADIUS[i];
      for (let j = 0; j < COUNT; j++) {
        const dx = p[i * 3] - q[j * 3], dy = p[i * 3 + 1] - q[j * 3 + 1], dz = p[i * 3 + 2] - q[j * 3 + 2];
        const min = ri + RADIUS[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 1e-4;
        // Out along the line between them, favouring up when on top (bodies pile, they don't
        // shove sideways); a limb caught underneath goes down and the floor holds it.
        const k = (min - d) / d;
        p[i * 3] += dx * k * 0.8;
        p[i * 3 + 1] += dy >= 0 ? Math.max(dy * k, (min - d) * 0.5) : dy * k;
        p[i * 3 + 2] += dz * k * 0.8;
      }
    }
  }

  private P(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
  }

  /** Writes the particle pose into the bones. */
  apply(): void {
    const b = this.body;
    const root = b.root;
    // Keep the root under the hips so culling bounds stay valid as the body slides.
    root.position.x = this.pos[0];
    root.position.z = this.pos[2];
    root.updateMatrixWorld(true);
    const rootQ = root.getWorldQuaternion(_q0);

    const hips = this.P(J.hips, _p0), neck = this.P(J.neck, _p1);
    const x = this.P(J.hpL, _ax).sub(this.P(J.hpR, _p3)).normalize();
    const y = _ay.subVectors(neck, hips).normalize();
    const hipsQ = basisQ(x, y, _q1);
    b.hips.position.copy(root.worldToLocal(_p5.copy(hips)));
    b.hips.quaternion.copy(rootQ).invert().multiply(hipsQ);

    const sx = this.P(J.shL, _sx).sub(this.P(J.shR, _p3)).normalize();
    const spineQ = basisQ(sx, y, _q2);
    b.spine.quaternion.copy(hipsQ).invert().multiply(spineQ);

    const hy = this.P(J.head, _hy).sub(neck).normalize();
    const headQ = basisQ(sx, hy, _q3);
    b.head.quaternion.copy(spineQ).invert().multiply(headQ);

    this.limb(b.armL, spineQ, J.shL, J.elL, J.haL);
    this.limb(b.armR, spineQ, J.shR, J.elR, J.haR);
    this.limb(b.legL, hipsQ, J.hpL, J.knL, J.ftL);
    this.limb(b.legR, hipsQ, J.hpR, J.knR, J.ftR);
  }

  private limb(l: Limb, parentQ: THREE.Quaternion, s: number, e: number, h: number): void {
    const d1 = this.P(e, _p2).sub(this.P(s, _p3)).normalize();
    const rest = _p4.set(0, -1, 0).applyQuaternion(parentQ);
    const upperW = _q4.setFromUnitVectors(rest, d1).multiply(parentQ);
    l.upper.quaternion.copy(parentQ).invert().multiply(upperW);
    const d2 = this.P(h, _p2).sub(this.P(e, _p3)).normalize();
    const rest2 = _p4.set(0, -1, 0).applyQuaternion(upperW);
    const lowerW = _q5.setFromUnitVectors(rest2, d2).multiply(upperW);
    l.lower.quaternion.copy(upperW).invert().multiply(lowerW);
  }

  /** World position of the pelvis (blood pool, death camera). */
  center(out: THREE.Vector3): THREE.Vector3 {
    return this.P(J.hips, out);
  }

  get floorY(): number {
    return this.floor;
  }
}

/** Distance along unit `d` from `o` to a sphere, or null when the ray misses it (or starts past it). */
function sphereT(o: THREE.Vector3, d: THREE.Vector3, x: number, y: number, z: number, r: number): number | null {
  const lx = x - o.x, ly = y - o.y, lz = z - o.z;
  const tc = lx * d.x + ly * d.y + lz * d.z;
  if (tc < 0) return null;
  const d2 = lx * lx + ly * ly + lz * lz - tc * tc;
  if (d2 > r * r) return null;
  return Math.max(0, tc - Math.sqrt(r * r - d2));
}

/** Rotation from an X axis and a Y hint (Y is orthogonalized). */
function basisQ(x: THREE.Vector3, y: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const yy = _b1.copy(y).addScaledVector(x, -y.dot(x)).normalize();
  const z = _b2.crossVectors(x, yy);
  return out.setFromRotationMatrix(_m.makeBasis(x, yy, z));
}

const _v = new THREE.Vector3();
const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _p3 = new THREE.Vector3();
const _p4 = new THREE.Vector3(), _p5 = new THREE.Vector3(), _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3();
const _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _sx = new THREE.Vector3(), _hy = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _q4 = new THREE.Quaternion(), _q5 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
