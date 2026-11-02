import * as THREE from 'three';
import { WORLD_FILTER, type Physics } from '../core/Physics';
import type { ZombieKind } from '@dead-hours/shared';
import { Humanoid, kindLooks, zombieLookOf } from './Humanoid';
import { BONE } from './rig';
import { goreMaterial, stumpGeometry, tintGore } from './Gore';
import type { Effects } from '../effects/Effects';

export type GibKind = 'head' | 'legL' | 'legR';

interface PartGeometry {
  geometry: THREE.BufferGeometry;
  /** From the joint (neck or hip) to the middle of the part, in bind space. */
  centre: THREE.Vector3;
  /** Rough size for collision. */
  radius: number;
}

const cache = new Map<string, PartGeometry>();

/**
 * Cuts a zombie's head (with whatever it wore there) or a whole leg out of its body mesh in
 * the bind pose, the joint it tore at as the origin. Cached per look.
 */
function partGeometry(kind: ZombieKind, look: number, part: GibKind): PartGeometry {
  const key = `${kind}:${look}:${part}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const body = new Humanoid(zombieLookOf(kind, look));
  const src = body.mesh.geometry;
  const bones: number[] = part === 'head' ? [BONE.head] : part === 'legL' ? [BONE.legLUpper, BONE.legLLower] : [BONE.legRUpper, BONE.legRLower];
  const joint = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(body.mesh.skeleton.boneInverses[bones[0]]).invert());
  const pos = src.getAttribute('position'), nor = src.getAttribute('normal'), col = src.getAttribute('color'), si = src.getAttribute('skinIndex');
  const P: number[] = [], N: number[] = [], C: number[] = [];
  const c = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    if (!bones.includes(si.getX(i))) continue;
    for (let j = i; j < i + 3; j++) {
      const x = pos.getX(j) - joint.x, y = pos.getY(j) - joint.y, z = pos.getZ(j) - joint.z;
      P.push(x, y, z);
      N.push(nor.getX(j), nor.getY(j), nor.getZ(j));
      // Soaked toward the torn end.
      const k = part === 'head' ? THREE.MathUtils.clamp(1 - y / 0.12, 0, 1) : THREE.MathUtils.clamp(1 + y / 0.3, 0, 1);
      C.push(col.getX(j) * (1 - k * 0.55) + 0.3 * k * 0.55, col.getY(j) * (1 - k * 0.8), col.getZ(j) * (1 - k * 0.8));
      c.x += x; c.y += y; c.z += z;
      n++;
    }
  }
  body.dispose();
  c.divideScalar(Math.max(1, n));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeBoundingSphere();
  const out = { geometry: g, centre: c, radius: part === 'head' ? 0.13 : 0.1 };
  cache.set(key, out);
  return out;
}

export function clearGibCache(): void {
  for (const g of cache.values()) g.geometry.dispose();
  cache.clear();
}

interface Gib {
  root: THREE.Group;
  mesh: THREE.Mesh;
  stump: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  /** Pivot (centre of mass) offset, metres, scaled. */
  radius: number;
  age: number;
  resting: boolean;
  bleed: number;
  part: GibKind;
}

const MAX_GIBS = 24;
const LIFETIME = 45;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _d = new THREE.Vector3();

/**
 * Heads and legs a blast tore off a zombie: the zombie's own head or leg, flung tumbling from
 * where it was, bleeding from the torn end as it flies, bouncing and rolling to a stop, leaving
 * blood where it lands. Cosmetic (not in the simulation): simple ballistic flight with ray
 * collisions against the world.
 */
export class Gibs {
  private readonly list: Gib[] = [];
  private readonly skin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, flatShading: true });
  private readonly gore = goreMaterial();
  private gored = true;
  onLand: ((pos: THREE.Vector3, strength: number) => void) | null = null;

  constructor(private readonly scene: THREE.Object3D, private readonly physics: Physics, private readonly effects: Effects) {}

  setGore(on: boolean): void {
    if (on === this.gored) return;
    this.gored = on;
    tintGore(this.gore, on);
  }

  /**
   * Throws `part` off a zombie: `joint` is where it tore (world), `q` the zombie part's world
   * orientation at that moment, `vel` how fast it flies.
   */
  spawn(kind: ZombieKind, look: number, part: GibKind, scale: number, joint: THREE.Vector3, q: THREE.Quaternion, vel: THREE.Vector3): void {
    if (kind === 'crawler') kind = 'walker';
    const pg = partGeometry(kind, look % kindLooks(kind), part);
    if (this.list.length >= MAX_GIBS) this.remove(this.list[0]);
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(pg.geometry, this.skin);
    mesh.castShadow = true;
    // The group's origin is the part's middle (it tumbles about that).
    mesh.position.copy(pg.centre).multiplyScalar(-1);
    const stump = new THREE.Mesh(stumpGeometry(part === 'head' ? 0.065 : 0.088, Math.floor(Math.random() * 1e6), 1), this.gore);
    stump.position.copy(mesh.position);
    if (part !== 'head') stump.rotation.x = Math.PI;
    root.add(mesh, stump);
    root.scale.setScalar(scale);
    root.quaternion.copy(q);
    root.position.copy(_v.copy(pg.centre).multiplyScalar(scale).applyQuaternion(q).add(joint));
    this.scene.add(root);
    const spin = new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).normalize().multiplyScalar(6 + Math.random() * 12);
    this.list.push({ root, mesh, stump, vel: vel.clone(), spin, radius: pg.radius * scale, age: 0, resting: false, bleed: 0, part });
  }

  /** A head with its torn neck, for compiling the gibs' shaders before the night (see Preload). */
  sample(): { root: THREE.Object3D; dispose: () => void } {
    const pg = partGeometry('walker', 0, 'head');
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(pg.geometry, this.skin);
    mesh.castShadow = true;
    const stump = new THREE.Mesh(stumpGeometry(0.065, 1, 1), this.gore);
    root.add(mesh, stump);
    return { root, dispose: () => {
      root.removeFromParent();
      stump.geometry.dispose();
    } };
  }

  update(dt: number): void {
    if (dt <= 0) return;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i];
      g.age += dt;
      if (g.age > LIFETIME) {
        // Sinks away like the bodies.
        g.root.position.y -= dt * 0.3;
        if (g.age > LIFETIME + 1.5) this.remove(g);
        continue;
      }
      if (g.resting) continue;
      const v = g.vel;
      v.y -= 9.8 * dt;
      const p = g.root.position;
      const len = v.length() * dt;
      if (len > 1e-6) {
        _d.copy(v).normalize();
        const hit = this.physics.raycastHit(p.x, p.y, p.z, _d.x, _d.y, _d.z, len + g.radius, WORLD_FILTER);
        if (hit) {
          p.addScaledVector(_d, Math.max(0, hit.distance - g.radius));
          _p.set(hit.nx, hit.ny, hit.nz);
          const vn = v.dot(_p);
          const speed = -vn;
          if (vn < 0) {
            v.addScaledVector(_p, -vn);
            v.multiplyScalar(0.55);
            v.addScaledVector(_p, speed * 0.22);
            g.spin.multiplyScalar(0.5);
            if (speed > 1.5) {
              this.effects.splat(p, 0.2 + Math.min(0.35, speed * 0.03));
              this.onLand?.(p, Math.min(1, speed / 8));
            }
          }
          if (hit.ny > 0.6 && v.length() < 0.5) {
            g.resting = true;
            v.set(0, 0, 0);
            this.effects.pool(_p.set(p.x, p.y - g.radius + 0.01, p.z), 0.35 + Math.random() * 0.2, 90);
          }
        } else {
          p.addScaledVector(v, dt);
        }
      }
      // Tumbling.
      const w = g.spin.length();
      if (w > 1e-3) {
        _q.setFromAxisAngle(_v.copy(g.spin).divideScalar(w), w * dt);
        g.root.quaternion.premultiply(_q);
      }
      // Blood streaming off the torn end while it flies.
      g.bleed -= dt;
      if (g.bleed <= 0 && g.age < 2.5) {
        g.bleed = 0.035;
        g.stump.getWorldPosition(_p);
        this.effects.drip(_p, v);
      }
    }
  }

  private remove(g: Gib): void {
    g.root.removeFromParent();
    g.stump.geometry.dispose();
    const i = this.list.indexOf(g);
    if (i >= 0) this.list.splice(i, 1);
  }

  get count(): number {
    return this.list.length;
  }

  clear(): void {
    while (this.list.length) this.remove(this.list[0]);
  }

  dispose(): void {
    this.clear();
    this.skin.dispose();
    this.gore.dispose();
  }
}
