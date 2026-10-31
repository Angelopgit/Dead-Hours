import * as THREE from 'three';
import { FIRE, BLAST, fireStrength, type FirePatch } from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import type { Quality } from '../core/Settings';
import { ParticleBatch, SHAPE } from './Particles';
import { VolumeBatch } from './Volume';
import { Flames } from './Flames';
import { DECAL, type DecalBatch } from './Decals';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface LightAsk {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  intensity: number;
  range: number;
  /** Bigger wins a light when there are more asks than lights. */
  weight: number;
}

/** A fire on the ground, as drawn. */
interface FireView {
  id: number;
  patches: FirePatch[];
  start: number;
  end: number;
  /** Flames per patch: offsets, sizes and seeds, fixed when it caught. */
  tongues: { dx: number; dz: number; w: number; h: number; seed: number }[][];
  smokeAcc: number;
  emberAcc: number;
  scorched: boolean;
  centre: THREE.Vector3;
}

/** Something burning that moves (a zombie on fire, a Molotov's rag): flame points for this frame. */
export interface BurnPoint {
  x: number; y: number; z: number;
  /** Size of the flames there (1 = a torso). */
  size: number;
  /** 0..1 how fiercely. */
  strength: number;
  seed: number;
}

const LIGHTS = 3;

/**
 * Explosions and fire: fireballs that cool and erode into rolling smoke, flash and shockwave,
 * sparks and glowing embers, flung dirt and a dust ring, scorch marks; Molotov spills burning
 * as fields of licking flames over a sheet of burning fuel, with smoke columns and embers;
 * zombies on fire. A few pooled lights follow the brightest fires and blasts (lights are never
 * added or removed, which would recompile every lit material).
 */
export class Pyro {
  readonly root = new THREE.Group();
  private readonly fireball = new VolumeBatch(260, true);
  private readonly smoke = new VolumeBatch(520, false);
  private readonly sparks = new ParticleBatch(900, true);
  private readonly debris = new ParticleBatch(700, false);
  readonly flames = new Flames(900, 72);
  private readonly ring: THREE.Mesh;
  private ringT = -1;
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly lights: THREE.PointLight[] = [];
  private readonly asks: LightAsk[] = [];
  private readonly flashes: { pos: THREE.Vector3; t: number }[] = [];
  private readonly fires = new Map<number, FireView>();
  private burning: BurnPoint[] = [];
  private quality = 1;
  reducedFlashing = false;
  private readonly cam = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** Screen flash and shake for a blast near the camera (0..1), read by the session. */
  onBlastNear: ((closeness: number) => void) | null = null;

  constructor(scene: THREE.Scene, private readonly physics: Physics, private readonly decals: DecalBatch) {
    this.sparks.mesh.renderOrder = 6;
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uT; varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float band = smoothstep(0.7, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
          float a = band * (1.0 - uT) * (1.0 - uT);
          gl_FragColor = vec4(vec3(3.2, 1.6, 0.6) * a, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), this.ringMat);
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.root.add(this.smoke.mesh, this.fireball.mesh, this.debris.mesh, this.sparks.mesh, this.flames.root, this.ring);
    for (let i = 0; i < LIGHTS; i++) {
      const l = new THREE.PointLight(0xff8a3a, 0, 20, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.root.add(l);
    }
    scene.add(this.root);
  }

  setQuality(q: Quality, reducedFlashing: boolean): void {
    this.quality = q === 'low' ? 0.4 : q === 'medium' ? 0.7 : 1;
    for (const b of [this.fireball, this.smoke]) b.setCapacity(this.quality);
    for (const b of [this.sparks, this.debris]) b.setCapacity(this.quality);
    this.flames.setQuality(this.quality);
    this.reducedFlashing = reducedFlashing;
  }

  private n(count: number, k = 1): number {
    const v = count * this.quality * k;
    return Math.floor(v) + (Math.random() < v % 1 ? 1 : 0);
  }

  /** Height of the floor under a point (or its own height). */
  private floor(p: THREE.Vector3): number {
    const d = this.physics.raycast(p.x, p.y + 0.5, p.z, 0, -1, 0, 4);
    return d === null ? p.y - 0.2 : p.y + 0.5 - d;
  }

  // ------------------------------------------------------------------ explosions

  /** A frag going off at `pos` (on or near the floor). */
  explosion(pos: THREE.Vector3): void {
    const fy = this.floor(pos);
    const o = this.tmp.set(pos.x, Math.max(pos.y, fy) + 0.25, pos.z);
    const ox = o.x, oy = o.y, oz = o.z;
    const near = THREE.MathUtils.clamp(1 - (o.distanceTo(this.cam) - 3) / 32, 0, 1);
    const dim = this.reducedFlashing ? 0.4 : 1;
    // Indoors (a ceiling close above) the fireball spreads along the ceiling and smoke fills the room.
    const ceil = this.physics.raycast(ox, oy, oz, 0, 1, 0, 6);
    const roof = ceil === null ? 99 : ceil;

    // The flash: a white-hot core for a few frames.
    this.sparks.emit({ x: ox, y: oy + 0.3, z: oz, vx: 0, vy: 0, vz: 0, life: 0.09, size: 5.5 * dim, size1: 7 * dim, r: 9 * dim, g: 7 * dim, b: 4.5 * dim, alpha: 1, shape: SHAPE.flash });
    this.sparks.emit({ x: ox, y: oy + 0.4, z: oz, vx: 0, vy: 0, vz: 0, life: 0.16, size: 3, size1: 4.5, r: 6 * dim, g: 3.2 * dim, b: 1 * dim, alpha: 1, shape: SHAPE.spark });
    // Fireball: billows thrown out fast, braked hard by the air, rising as they cool and break up.
    for (let i = 0, c = this.n(16); i < c; i++) {
      const d = this.randDir(0.25);
      const s = rand(3.5, 9);
      this.fireball.emit({
        x: ox + d.x * 0.3, y: oy + 0.25 + d.y * 0.3, z: oz + d.z * 0.3,
        vx: d.x * s, vy: Math.min(d.y * s, (roof - 0.6) * 4) + 1, vz: d.z * s,
        life: rand(0.45, 0.85), size: rand(1, 1.6), size1: rand(2.6, 3.8),
        heat: rand(0.92, 1), cool: rand(2.6, 3.6), erode0: 0, erode1: rand(0.75, 0.95), drag: 5, lift: 2.5, floor: fy, alpha: 1,
      });
    }
    // Rolling fire rising off the top of it.
    for (let i = 0, c = this.n(7); i < c; i++) {
      this.fireball.emit({
        x: ox + rand(-0.7, 0.7), y: oy + rand(0.4, 1.1), z: oz + rand(-0.7, 0.7),
        vx: rand(-1, 1), vy: rand(2, 4) * Math.min(1, roof / 3), vz: rand(-1, 1),
        life: rand(0.8, 1.25), size: rand(1.2, 1.8), size1: rand(2.4, 3.2),
        heat: rand(0.65, 0.8), cool: rand(1.6, 2.4), erode0: 0.1, erode1: 0.95, drag: 2.5, lift: 1.5, floor: fy, alpha: 0.9,
      });
    }
    // Smoke: thick, dark, lit orange from inside at first, then rolling up and drifting.
    for (let i = 0, c = this.n(14); i < c; i++) {
      const d = this.randDir(0.1);
      const s = rand(1.5, 4.5);
      const g = rand(0.1, 0.16);
      this.smoke.emit({
        x: ox + d.x * 0.6, y: oy + 0.3 + Math.abs(d.y) * 0.6, z: oz + d.z * 0.6,
        vx: d.x * s, vy: Math.abs(d.y) * s * 0.6 + rand(0.4, 1.6), vz: d.z * s,
        life: rand(4.5, 8), size: rand(1, 1.6), size1: rand(3, 5),
        r: g, g: g * 0.95, b: g * 0.9, alpha: rand(0.55, 0.8), heat: rand(0.35, 0.55), cool: rand(4, 6),
        glow: 1, erode0: 0, erode1: 0.7, drag: 1.6, lift: roof < 4 ? -0.05 : 0.35, floor: fy, spin: rand(-0.3, 0.3),
      });
    }
    // Dust thrown out along the ground in a ring.
    for (let i = 0, c = this.n(16); i < c; i++) {
      const a = (i / c) * Math.PI * 2 + rand(-0.15, 0.15);
      const s = rand(7, 12);
      this.smoke.emit({
        x: ox + Math.cos(a) * 0.5, y: fy + 0.2, z: oz + Math.sin(a) * 0.5, vx: Math.cos(a) * s, vy: rand(0.2, 0.8), vz: Math.sin(a) * s,
        life: rand(1.8, 3.2), size: 0.6, size1: rand(2.6, 3.6), r: 0.33, g: 0.3, b: 0.26, alpha: 0.5, erode0: 0.1, erode1: 0.85, drag: 3.2, lift: 0.1, floor: fy,
      });
    }
    // Sparks and burning fragments.
    for (let i = 0, c = this.n(60); i < c; i++) {
      const d = this.randDir(0.05);
      const s = rand(9, 30);
      this.sparks.emit({
        x: ox, y: oy + 0.2, z: oz, vx: d.x * s, vy: d.y * s + 2, vz: d.z * s,
        life: rand(0.25, 0.9), size: rand(0.02, 0.05), r: 7, g: rand(2.8, 4), b: 1.1, alpha: 1, gravity: 1, drag: 1.4, stretch: 0.03, shape: SHAPE.spark, floor: fy,
      });
    }
    // Embers drifting up and around for a while after.
    for (let i = 0, c = this.n(30); i < c; i++) {
      this.sparks.emit({
        x: ox + rand(-1.2, 1.2), y: oy + rand(0, 1.5), z: oz + rand(-1.2, 1.2), vx: rand(-1.5, 1.5), vy: rand(1, 4), vz: rand(-1.5, 1.5),
        life: rand(1.6, 3.6), size: rand(0.015, 0.035), r: 5, g: 1.8, b: 0.45, alpha: 1, gravity: -0.04, drag: 1.2, stretch: 0.01, shape: SHAPE.spark,
      });
    }
    // Dirt, asphalt and grit thrown up.
    for (let i = 0, c = this.n(36); i < c; i++) {
      const d = this.randDir(0.35);
      const s = rand(4, 14);
      const shade = rand(0.08, 0.2);
      this.debris.emit({
        x: ox, y: fy + 0.1, z: oz, vx: d.x * s, vy: Math.abs(d.y) * s + 2, vz: d.z * s,
        life: rand(1.2, 2.6), size: rand(0.025, 0.07), r: shade, g: shade * 0.95, b: shade * 0.85, alpha: 1, gravity: 1, drag: 0.4, shape: SHAPE.hard, floor: fy + 0.02,
      });
    }
    // Shockwave over the ground, a scorch mark where it was.
    this.ring.position.set(ox, fy + 0.06, oz);
    this.ringT = 0;
    this.ring.visible = true;
    this.decals.add(DECAL.pool, this.tmp.set(ox, fy + 0.01, oz), this.up, rand(2.6, 3.4), 0.1, 0.09, 0.085, 0.95, 160);
    this.decals.add(DECAL.splat, this.tmp.set(ox, fy + 0.012, oz), this.up, rand(1.6, 2.2), 0.06, 0.055, 0.05, 0.9, 160);
    this.flashes.push({ pos: new THREE.Vector3(ox, oy + 0.6, oz), t: 0 });
    this.onBlastNear?.(near);
  }

  /** A Molotov breaking: glass flying, fuel splashing and catching in a rush of flame. */
  shatter(pos: THREE.Vector3, ground: THREE.Vector3): void {
    for (let i = 0, c = this.n(26); i < c; i++) {
      const d = this.randDir(0.3);
      const s = rand(2, 6);
      this.debris.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: d.x * s, vy: Math.abs(d.y) * s + 1, vz: d.z * s,
        life: rand(0.6, 1.4), size: rand(0.012, 0.03), r: 0.5, g: 0.62, b: 0.45, alpha: 1, gravity: 1, drag: 0.5, shape: SHAPE.hard, floor: ground.y + 0.01,
      });
    }
    for (let i = 0, c = this.n(10); i < c; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(1.5, 4);
      this.fireball.emit({
        x: ground.x + Math.cos(a) * 0.3, y: ground.y + 0.35, z: ground.z + Math.sin(a) * 0.3,
        vx: Math.cos(a) * s, vy: rand(1.5, 3.5), vz: Math.sin(a) * s,
        life: rand(0.5, 0.9), size: rand(0.6, 1), size1: rand(1.6, 2.4),
        heat: rand(0.75, 0.9), cool: 2.2, erode0: 0.05, erode1: 0.95, drag: 3, lift: 2, floor: ground.y, alpha: 0.9,
      });
    }
    this.flashes.push({ pos: new THREE.Vector3(ground.x, ground.y + 0.8, ground.z), t: 0.12 });
  }

  /** A Molotov's spill caught: it burns from `start` to `end` (simulation time). */
  fire(id: number, patches: FirePatch[], start: number, end: number): void {
    if (this.fires.has(id)) return;
    const tongues = patches.map((p) => {
      const list: FireView['tongues'][number] = [];
      const big = Math.max(2, Math.round(p.r * 2.6));
      for (let i = 0; i < big + 3; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * p.r * 0.75;
        const small = i >= big;
        list.push({
          dx: Math.cos(a) * d, dz: Math.sin(a) * d,
          w: small ? rand(0.35, 0.6) : rand(0.8, 1.25) * Math.min(1.3, p.r),
          h: small ? rand(0.5, 0.9) : rand(1.1, 2.1),
          seed: Math.random(),
        });
      }
      return list;
    });
    const c = new THREE.Vector3();
    for (const p of patches) c.add(this.tmp.set(p.x, p.y, p.z));
    c.divideScalar(Math.max(1, patches.length));
    this.fires.set(id, { id, patches, start, end, tongues, smokeAcc: 0, emberAcc: 0, scorched: false, centre: c });
    // Fuel stains where it spilled.
    for (const p of patches) this.decals.add(DECAL.pool, this.tmp.set(p.x, p.y, p.z), this.up, p.r * 2.1, 0.13, 0.11, 0.1, 0.85, 200, 1);
  }

  /** Where things are burning on moving bodies this frame. */
  setBurning(points: BurnPoint[]): void {
    this.burning = points;
  }

  /** A Molotov in flight: its rag burning. */
  rag(pos: THREE.Vector3, vel: THREE.Vector3): void {
    this.flames.flame(pos.x - vel.x * 0.01, pos.y, pos.z - vel.z * 0.01, 0.12, 0.26, 0.37, 0.8, 0.75);
    if (Math.random() < 0.5 * this.quality) {
      this.sparks.emit({ x: pos.x, y: pos.y + 0.05, z: pos.z, vx: rand(-0.4, 0.4), vy: rand(0.4, 1.2), vz: rand(-0.4, 0.4), life: rand(0.2, 0.5), size: 0.015, r: 5, g: 1.8, b: 0.4, alpha: 1, gravity: -0.05, drag: 1, stretch: 0.01, shape: SHAPE.spark });
    }
    if (Math.random() < 0.25 * this.quality) {
      this.smoke.emit({ x: pos.x, y: pos.y + 0.15, z: pos.z, vx: 0, vy: 0.5, vz: 0, life: rand(0.8, 1.4), size: 0.12, size1: 0.5, r: 0.12, g: 0.11, b: 0.1, alpha: 0.45, erode1: 0.8, drag: 1.5, lift: 0.4, glow: 0.5 });
    }
    this.ask(pos.x, pos.y, pos.z, 1, 0.55, 0.2, 6, 6, 2);
  }

  private randDir(minUp: number): THREE.Vector3 {
    const v = new THREE.Vector3();
    do v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)); while (v.lengthSq() > 1 || v.lengthSq() < 0.01);
    v.normalize();
    if (v.y < minUp) v.y = minUp + Math.random() * 0.3;
    return v.normalize();
  }

  private ask(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, range: number, weight: number): void {
    this.asks.push({ x, y, z, r, g, b, intensity, range, weight });
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, simTime: number, camera: THREE.Camera): void {
    this.cam.copy(camera.position);
    const f = this.flames;
    f.begin();
    const t = performance.now() / 1000;

    // Blast flashes: blinding for an instant, then the orange of the fireball, then nothing.
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const fl = this.flashes[i];
      fl.t += dt;
      const k = fl.t;
      const flash = Math.exp(-k * 22) * 5200 + Math.exp(-k * 4.5) * 900;
      if (k > 1.4) {
        this.flashes.splice(i, 1);
        continue;
      }
      const warm = Math.min(1, k * 6);
      this.ask(fl.pos.x, fl.pos.y, fl.pos.z, 1, 0.82 - warm * 0.3, 0.6 - warm * 0.45, flash * (this.reducedFlashing ? 0.4 : 1), 38, 100);
    }

    // Spills.
    for (const [id, v] of this.fires) {
      const s = fireStrength(v, simTime);
      if (simTime >= v.end + 4) {
        this.fires.delete(id);
        continue;
      }
      if (simTime >= v.end && !v.scorched) {
        v.scorched = true;
        for (const p of v.patches) this.decals.add(DECAL.pool, this.tmp.set(p.x, p.y + 0.005, p.z), this.up, p.r * 1.8, 0.08, 0.075, 0.07, 0.9, 160);
      }
      // Dying smoke after it is out.
      v.smokeAcc += dt * (s > 0 ? 2.2 + s * 3 : simTime < v.end + 3 ? 1.2 : 0) * this.quality;
      v.emberAcc += dt * s * 14 * this.quality;
      const dist = v.centre.distanceTo(this.cam);
      const lod = dist > 60 ? 0.4 : dist > 30 ? 0.7 : 1;
      for (let pi = 0; pi < v.patches.length; pi++) {
        const p = v.patches[pi];
        if (s <= 0) continue;
        f.pool(p.x, p.y, p.z, p.r * (0.6 + 0.45 * s), s, pi * 0.37 + id * 0.11);
        const list = v.tongues[pi];
        const count = Math.ceil(list.length * lod);
        for (let k = 0; k < count; k++) {
          const tg = list[k];
          const flick = 0.82 + 0.18 * Math.sin(t * (7 + tg.seed * 5) + tg.seed * 40) + 0.08 * Math.sin(t * 17.3 + tg.seed * 9);
          f.flame(p.x + tg.dx, p.y - 0.05, p.z + tg.dz, tg.w * (0.7 + 0.3 * s), tg.h * s * flick, tg.seed, 0.75 + 0.25 * s, Math.min(1, s * 1.4));
        }
      }
      while (v.smokeAcc >= 1) {
        v.smokeAcc -= 1;
        const p = v.patches[Math.floor(Math.random() * v.patches.length)];
        const g = rand(0.08, 0.13);
        this.smoke.emit({
          x: p.x + rand(-0.4, 0.4), y: p.y + 1.2 * Math.max(0.3, s), z: p.z + rand(-0.4, 0.4), vx: rand(-0.3, 0.3), vy: rand(1, 2), vz: rand(-0.3, 0.3),
          life: rand(4, 7), size: rand(0.7, 1.1), size1: rand(3, 5), r: g, g: g * 0.95, b: g * 0.92, alpha: rand(0.45, 0.7),
          glow: s * 0.9, erode0: 0.05, erode1: 0.8, drag: 0.6, lift: 0.35, spin: rand(-0.25, 0.25),
        });
      }
      while (v.emberAcc >= 1) {
        v.emberAcc -= 1;
        const p = v.patches[Math.floor(Math.random() * v.patches.length)];
        this.sparks.emit({
          x: p.x + rand(-p.r, p.r) * 0.6, y: p.y + rand(0.2, 1), z: p.z + rand(-p.r, p.r) * 0.6, vx: rand(-0.6, 0.6), vy: rand(1.2, 3.2), vz: rand(-0.6, 0.6),
          life: rand(0.8, 2), size: rand(0.012, 0.028), r: 6, g: rand(1.6, 2.6), b: 0.4, alpha: 1, gravity: -0.03, drag: 0.9, stretch: 0.012, shape: SHAPE.spark,
        });
      }
      if (s > 0) {
        const fl = 0.8 + 0.14 * Math.sin(t * 11 + id) + 0.08 * Math.sin(t * 23.7 + id * 3);
        this.ask(v.centre.x, v.centre.y + 1, v.centre.z, 1, 0.5, 0.16, 45 * s * fl, 13, 20);
      }
    }

    // Burning bodies.
    let bx = 0, by = 0, bz = 0, bw = 0;
    for (const b of this.burning) {
      const d = Math.hypot(b.x - this.cam.x, b.z - this.cam.z);
      const s = b.strength;
      const flick = 0.8 + 0.2 * Math.sin(t * 9 + b.seed * 30);
      f.flame(b.x, b.y - 0.2 * b.size, b.z, 0.55 * b.size, 0.9 * b.size * flick * (0.6 + 0.4 * s), b.seed, 0.75, s * 0.55);
      if (d < 35 && Math.random() < dt * 1.5 * s * this.quality) {
        this.sparks.emit({ x: b.x, y: b.y + 0.2, z: b.z, vx: rand(-0.5, 0.5), vy: rand(1, 2.5), vz: rand(-0.5, 0.5), life: rand(0.5, 1.4), size: 0.018, r: 6, g: 2, b: 0.4, alpha: 1, gravity: -0.03, drag: 1, stretch: 0.012, shape: SHAPE.spark });
      }
      // (Several points per body: a little smoke from each adds up.)
      if (d < 50 && Math.random() < dt * 0.35 * s * this.quality) {
        this.smoke.emit({ x: b.x, y: b.y + 0.6 * b.size, z: b.z, vx: rand(-0.2, 0.2), vy: rand(0.8, 1.5), vz: rand(-0.2, 0.2), life: rand(2.5, 4), size: 0.3, size1: rand(1.2, 2), r: 0.09, g: 0.085, b: 0.08, alpha: 0.45, glow: 0.35 * s, erode1: 0.8, drag: 0.8, lift: 0.3 });
      }
      const w = s / (1 + d * 0.15);
      bx += b.x * w; by += b.y * w; bz += b.z * w; bw += w;
    }
    if (bw > 0) this.ask(bx / bw, by / bw + 0.5, bz / bw, 1, 0.5, 0.16, Math.min(90, 25 + this.burning.length * 6), 10, 10);

    // Shockwave.
    if (this.ringT >= 0) {
      this.ringT += dt;
      const u = this.ringT / 0.32;
      if (u >= 1) {
        this.ringT = -1;
        this.ring.visible = false;
      } else {
        this.ring.scale.setScalar(0.6 + u * BLAST.radius);
        this.ringMat.uniforms.uT.value = u;
      }
    }

    this.fireball.update(dt, camera);
    this.smoke.update(dt, camera);
    this.sparks.update(dt);
    this.debris.update(dt);
    f.end(dt);
    this.placeLights();
  }

  /** Gives the pooled lights to the asks that matter most from here. */
  private placeLights(): void {
    const c = this.cam;
    const score = (a: LightAsk) => a.weight * a.intensity / (1 + Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z) * 0.2);
    this.asks.sort((a, b) => score(b) - score(a));
    for (let i = 0; i < LIGHTS; i++) {
      const l = this.lights[i];
      const a = this.asks[i];
      if (!a) {
        l.intensity = 0;
        continue;
      }
      l.position.set(a.x, a.y, a.z);
      l.color.setRGB(a.r, a.g, a.b);
      l.intensity = a.intensity;
      l.distance = a.range;
    }
    this.asks.length = 0;
  }

  /** Fires still burning (for sound). */
  activeFires(simTime: number): { id: number; pos: THREE.Vector3; strength: number }[] {
    const out: { id: number; pos: THREE.Vector3; strength: number }[] = [];
    for (const v of this.fires.values()) {
      const s = fireStrength(v, simTime);
      if (s > 0) out.push({ id: v.id, pos: v.centre, strength: s });
    }
    return out;
  }

  clear(): void {
    this.fires.clear();
    this.flashes.length = 0;
    this.burning = [];
    for (const b of [this.fireball, this.smoke]) b.clear();
    this.sparks.clear();
    this.debris.clear();
    for (const l of this.lights) l.intensity = 0;
  }

  dispose(): void {
    this.fireball.dispose();
    this.smoke.dispose();
    this.sparks.dispose();
    this.debris.dispose();
    this.flames.dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    for (const l of this.lights) l.dispose();
    this.root.removeFromParent();
  }
}

/** Seconds a Molotov spill burns (for anyone sizing sounds to it). */
export const FIRE_SECONDS = FIRE.duration;
