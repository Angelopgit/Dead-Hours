import * as THREE from 'three';
import { WORLD_FILTER, type Physics } from '../core/Physics';
import type { Quality } from '../core/Settings';

/** What a piece is: torn meat, splinters of bone, skull with scalp still on it, brain, fat. */
export type ChunkKind = 'meat' | 'bone' | 'skull' | 'brain' | 'fat';

const COLORS: Record<ChunkKind, number[]> = {
  meat: [0x6e0e0a, 0x8a1611, 0x58090a, 0x9a2219, 0x430505, 0x7a1410],
  bone: [0xe2d8bf, 0xd4c8a8, 0xc8b998],
  skull: [0xd8ccb0, 0x3a2a22, 0x8a1611, 0x2a1d17],
  brain: [0xb87a74, 0xa0605c, 0xc48c84],
  fat: [0xb89a62, 0xc4a670],
};

/** How each kind is shaped (non-uniform scale on the lump) and how it bounces. */
const SHAPE: Record<ChunkKind, { x: number; y: number; z: number; bounce: number }> = {
  meat: { x: 1, y: 0.62, z: 0.85, bounce: 0.12 },
  bone: { x: 0.35, y: 0.3, z: 1.6, bounce: 0.38 },
  skull: { x: 1.1, y: 0.28, z: 0.9, bounce: 0.3 },
  brain: { x: 0.9, y: 0.6, z: 0.8, bounce: 0.05 },
  fat: { x: 0.8, y: 0.5, z: 0.7, bounce: 0.1 },
};

interface Chunk {
  active: boolean;
  kind: ChunkKind;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  q: THREE.Quaternion;
  spin: THREE.Vector3;
  scale: THREE.Vector3;
  radius: number;
  age: number;
  life: number;
  resting: boolean;
  /** Has hit something yet (the first landing splats). */
  landed: boolean;
  /** Matrix needs writing this frame. */
  dirty: boolean;
}

/** A lump of torn tissue: a squashed, dented icosahedron, faceted like the bodies. */
function lumpGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.getAttribute('position');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Dent each shared vertex the same way so the surface stays closed.
  const dents = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let k = dents.get(key);
    if (k === undefined) dents.set(key, (k = 0.62 + rnd() * 0.5));
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  const flat = g.toNonIndexed();
  g.dispose();
  flat.deleteAttribute('uv');
  flat.computeVertexNormals();
  return flat;
}

const MAX = 200;
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _c = new THREE.Color(), _e = new THREE.Euler();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Pieces of zombie that fly off when it is shot or torn apart: real lumps of meat, bone splinters,
 * bits of skull and brain, tumbling through the air, bouncing off walls and the street, leaving a
 * wet mark where they first land, and lying there for a while. One instanced draw call; cosmetic
 * (not in the simulation), so every screen throws its own.
 */
export class FleshChunks {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly list: Chunk[] = [];
  private next = 0;
  private capacity = MAX;
  private lifetime = 40;
  /** A piece hit the ground or a wall: where, how hard 0..1, and what it was. */
  onLand: ((pos: THREE.Vector3, strength: number, kind: ChunkKind, normal: THREE.Vector3) => void) | null = null;

  constructor(private readonly physics: Physics) {
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0, flatShading: true });
    this.mesh = new THREE.InstancedMesh(lumpGeometry(), this.material, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The colour attribute exists from the start, so the material compiles once with it.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    this.mesh.name = 'flesh-chunks';
    for (let i = 0; i < MAX; i++) {
      this.list.push({
        active: false, kind: 'meat', pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(), spin: new THREE.Vector3(),
        scale: new THREE.Vector3(), radius: 0, age: 0, life: 0, resting: false, landed: false, dirty: false,
      });
      this.mesh.setMatrixAt(i, ZERO);
    }
  }

  setQuality(q: Quality): void {
    this.capacity = q === 'low' ? 70 : q === 'medium' ? 130 : MAX;
    this.lifetime = q === 'low' ? 22 : q === 'medium' ? 32 : 40;
    for (let i = this.capacity; i < MAX; i++) this.kill(i);
    if (this.next >= this.capacity) this.next = 0;
  }

  /** Gore off: nothing is thrown, and what lies about goes. */
  set enabled(on: boolean) {
    if (!on) this.clear();
    this.on = on;
  }
  private on = true;

  get active(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.list[i].active) n++;
    return n;
  }

  /** Throws one piece of `kind`, about `size` m across, from `pos` at `vel`. */
  spawn(pos: THREE.Vector3, vel: THREE.Vector3, size: number, kind: ChunkKind): void {
    if (!this.on) return;
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const c = this.list[i];
    c.active = true;
    c.kind = kind;
    c.pos.copy(pos);
    c.vel.copy(vel);
    c.q.setFromEuler(_e.set(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
    c.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(8 + Math.random() * 18);
    const sh = SHAPE[kind];
    const s = size * 0.5;
    c.scale.set(s * sh.x * (0.8 + Math.random() * 0.4), s * sh.y * (0.8 + Math.random() * 0.4), s * sh.z * (0.8 + Math.random() * 0.4));
    c.radius = Math.max(0.012, Math.min(c.scale.x, c.scale.y, c.scale.z) * 0.9);
    c.age = 0;
    c.life = this.lifetime * (0.75 + Math.random() * 0.5);
    c.resting = false;
    c.landed = false;
    c.dirty = true;
    const cols = COLORS[kind];
    _c.setHex(cols[Math.floor(Math.random() * cols.length)]);
    this.mesh.setColorAt(i, _c);
    this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
  }

  /**
   * A spray of `count` pieces out along `dir` (unit): `speed` m/s range, `spread` of sideways
   * scatter, `up` extra lift, `size` m range.
   */
  burst(pos: THREE.Vector3, dir: THREE.Vector3, count: number, kind: ChunkKind, speed: [number, number], spread: number, up: number, size: [number, number], inherit?: THREE.Vector3): void {
    for (let k = 0; k < count; k++) {
      const s = speed[0] + Math.random() * (speed[1] - speed[0]);
      _v.set(
        (dir.x + (Math.random() * 2 - 1) * spread) * s,
        (dir.y + (Math.random() * 2 - 1) * spread) * s + up * (0.5 + Math.random()),
        (dir.z + (Math.random() * 2 - 1) * spread) * s,
      );
      if (inherit) _v.add(inherit);
      _n.set(pos.x + (Math.random() - 0.5) * 0.06, pos.y + (Math.random() - 0.5) * 0.06, pos.z + (Math.random() - 0.5) * 0.06);
      this.spawn(_n, _v, size[0] + Math.random() * (size[1] - size[0]), kind);
    }
  }

  /** A blast throws what lies within `radius` of `at` about again. */
  blast(at: THREE.Vector3, radius: number, power: number): void {
    for (let i = 0; i < this.capacity; i++) {
      const c = this.list[i];
      if (!c.active) continue;
      const d = c.pos.distanceTo(at);
      if (d > radius) continue;
      const k = (1 - d / radius) * power;
      _v.subVectors(c.pos, at).setY(0);
      if (_v.lengthSq() < 1e-6) _v.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      _v.normalize().multiplyScalar(4 + 9 * k);
      _v.y = 2 + 6 * k;
      c.vel.copy(_v);
      c.resting = false;
      c.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(10 + 15 * k);
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    let moved = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const c = this.list[i];
      if (!c.active) continue;
      c.age += dt;
      if (c.age > c.life) {
        // Shrinks away into the ground.
        const k = 1 - (c.age - c.life) / 1.5;
        if (k <= 0) {
          this.kill(i);
          moved = true;
          continue;
        }
        _m.compose(c.pos, c.q, _v.copy(c.scale).multiplyScalar(k));
        this.mesh.setMatrixAt(i, _m);
        moved = true;
        continue;
      }
      if (!c.resting) this.fly(c, dt);
      if (c.dirty) {
        c.dirty = c.resting ? false : true;
        _m.compose(c.pos, c.q, c.scale);
        this.mesh.setMatrixAt(i, _m);
        moved = true;
      }
    }
    if (moved) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private fly(c: Chunk, dt: number): void {
    const v = c.vel;
    v.y -= 9.8 * dt;
    v.multiplyScalar(Math.exp(-0.15 * dt));
    const len = v.length() * dt;
    if (len > 1e-6) {
      _v.copy(v).divideScalar(v.length());
      const hit = this.physics.raycastHit(c.pos.x, c.pos.y, c.pos.z, _v.x, _v.y, _v.z, len + c.radius, WORLD_FILTER);
      if (hit) {
        c.pos.addScaledVector(_v, Math.max(0, hit.distance - c.radius));
        _n.set(hit.nx, hit.ny, hit.nz);
        const vn = v.dot(_n);
        if (vn < 0) {
          const speed = -vn;
          const bounce = SHAPE[c.kind].bounce;
          // Wet meat sticks and slides; bone skips off.
          v.addScaledVector(_n, -vn * (1 + bounce));
          v.multiplyScalar(c.kind === 'bone' || c.kind === 'skull' ? 0.6 : 0.4);
          c.spin.multiplyScalar(0.45);
          if (!c.landed || speed > 2.5) {
            c.landed = true;
            this.onLand?.(c.pos, Math.min(1, speed / 7), c.kind, _n);
          }
        }
        if (hit.ny > 0.6 && v.length() < 0.55) {
          c.resting = true;
          v.set(0, 0, 0);
          c.pos.y += 0.002;
          // Settles flat on its broad side.
          lieFlat(c.q);
        }
      } else {
        c.pos.addScaledVector(v, dt);
      }
    }
    const w = c.spin.length();
    if (w > 1e-3 && !c.resting) {
      _q.setFromAxisAngle(_v.copy(c.spin).divideScalar(w), w * dt);
      c.q.premultiply(_q);
    }
    c.dirty = true;
  }

  private kill(i: number): void {
    const c = this.list[i];
    if (!c.active) return;
    c.active = false;
    this.mesh.setMatrixAt(i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** One piece lying at `at`, for compiling the material before the night (see Preload). */
  sample(at: THREE.Vector3): () => void {
    const was = this.on;
    this.on = true;
    const i = this.next;
    this.spawn(at, _v.set(0, 0, 0), 0.1, 'meat');
    this.list[i].resting = true;
    _m.compose(at, this.list[i].q, this.list[i].scale);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.on = was;
    return () => this.kill(i);
  }

  clear(): void {
    for (let i = 0; i < MAX; i++) this.kill(i);
    this.mesh.count = 0;
    this.next = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

/** Turns a resting piece so its flattest side (local Y) faces up, keeping its heading. */
function lieFlat(q: THREE.Quaternion): void {
  const up = _n.set(0, 1, 0).applyQuaternion(q);
  _q.setFromUnitVectors(up, _v.set(0, up.y >= 0 ? 1 : -1, 0));
  q.premultiply(_q);
}
