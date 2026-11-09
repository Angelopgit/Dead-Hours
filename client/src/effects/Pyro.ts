import * as THREE from 'three';
import { FIRE, BLAST, fireStrength, type FirePatch } from '@dead-hours/shared';
import { GROUP, groups, type Physics } from '../core/Physics';
import { lampPower } from '../lighting/BeamPower';
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
  /**
   * A fire that burns on: its intensity without the flicker, which lampPower holds down so the
   * wall or car beside it doesn't burn white. 0 for a blast's flash, which may blind for an instant.
   */
  steady: number;
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
/** Something with fuel in it that smokes or burns where it stands (a shot-up car, a pump, a drum). */
export interface SmoulderPoint {
  x: number;
  y: number;
  z: number;
  /** 1 smoking, 2 on fire, 3 burnt out (black smoke, a last few flames), 4 the same with the flames gone. */
  stage: number;
  /** How big the thing is (1: a car's hood). */
  size: number;
  seed: number;
  /** 0..1: how hard it smokes or burns now. */
  strength: number;
}

export interface BurnPoint {
  x: number; y: number; z: number;
  /** Size of the flames there (1 = a torso). */
  size: number;
  /** 0..1 how fiercely. */
  strength: number;
  seed: number;
}

const LIGHTS = 3;
/** Shrapnel marks what stands still: walls, fences, parked cars (not doors, which swing away from their marks). */
const SHRAPNEL_FILTER = groups(0xffff, GROUP.static);
/** How long the marks a blast leaves on walls last (s). */
const SCAR_LIFE = 420;
/**
 * A fire's light in the volumetric fog: a warm haze round it. At full strength the fog right round
 * a Molotov came out several times the bloom threshold and the bloom spread it over the street.
 */
const FIRE_FOG = 0.3;
/** A Molotov catching, as a share of a blast's flash: about 120 cd at its height, under 3 fire's worth. */
const MOLOTOV_FLASH = 0.22;
/** How fast a fire's light settles to a new power when it moves (1/s). */
const SETTLE = 6;

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
  /** Each light's share of its fire's power (lampPower) and where that fire was. */
  private readonly power: number[] = [];
  private readonly lit: THREE.Vector3[] = [];
  private readonly asks: LightAsk[] = [];
  /** Light flashes: a grenade's blast (`fire` false: it may blind for an instant) or a Molotov catching. */
  private readonly flashes: { pos: THREE.Vector3; t: number; scale: number; fire: boolean }[] = [];
  private readonly fires = new Map<number, FireView>();
  private burning: BurnPoint[] = [];
  private smouldering: SmoulderPoint[] = [];
  private ringR: number = BLAST.radius;
  /** The blast being drawn, against a frag's. */
  private blastScale = 1;
  private readonly tmpN = new THREE.Vector3();
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
      this.power.push(1);
      this.lit.push(new THREE.Vector3(Infinity, 0, 0));
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

  /**
   * A frag going off at `pos` (on or near the floor). `scale`: a bigger blast (a car's is 1.25).
   * `fuel`: something with fuel in it going up: a taller, longer fireball, black smoke, burning scrap.
   */
  explosion(pos: THREE.Vector3, scale = 1, fuel = false): void {
    if (scale !== 1 || fuel) {
      // Thrown bigger and farther; a tank of fuel burns on as it rises.
      const q = this.quality;
      this.quality = q * scale * (fuel ? 1.15 : 1);
      this.blastScale = scale;
      this.explosion(pos);
      this.blastScale = 1;
      this.quality = q;
      this.ringR = BLAST.radius * scale;
      const last = this.flashes[this.flashes.length - 1];
      if (last) last.scale = Math.min(1.6, scale);
      if (fuel) this.fuelBurst(pos, scale);
      return;
    }
    this.ringR = BLAST.radius;
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
    this.flashes.push({ pos: new THREE.Vector3(ox, oy + 0.6, oz), t: 0, scale: 1, fire: false });
    this.shrapnel(ox, oy, oz, this.blastScale);
    this.onBlastNear?.(near);
  }

  /**
   * What a blast does to whatever stands round it: fragments fly out and pock the walls, fences
   * and cars they strike, crack them where they hit hardest, and the nearest wall is left black.
   */
  private shrapnel(ox: number, oy: number, oz: number, scale: number): void {
    const reach = BLAST.radius * 0.9 * scale;
    const p = this.tmp, n = this.tmpN;
    let soot = 3.2 * scale;
    for (let i = 0, c = this.n(18, scale); i < c; i++) {
      const d = this.randDir(-0.3);
      const hit = this.physics.raycastHit(ox, oy, oz, d.x, d.y, d.z, reach, SHRAPNEL_FILTER);
      // Floors already carry the scorch.
      if (!hit || hit.ny > 0.7) continue;
      p.set(ox + d.x * hit.distance, oy + d.y * hit.distance, oz + d.z * hit.distance);
      n.set(hit.nx, hit.ny, hit.nz);
      const near = 1 - hit.distance / reach;
      const shade = rand(0.03, 0.08);
      this.decals.add(DECAL.hole, p, n, rand(0.05, 0.1) + near * 0.07, shade, shade, shade, 0.92, SCAR_LIFE);
      if (Math.random() < 0.25 + near * 0.5) this.decals.add(DECAL.crack, p, n, rand(0.22, 0.4) + near * 0.4, 0.1, 0.095, 0.09, 0.85, SCAR_LIFE);
      // Soot on the nearest wall, where the fire washed over it.
      if (hit.distance < soot) {
        soot = -1;
        this.decals.add(DECAL.splat, p, n, rand(1.5, 2.1) * scale, 0.09, 0.085, 0.08, 0.8, SCAR_LIFE);
        this.decals.add(DECAL.crack, p, n, rand(0.8, 1.2) * scale, 0.08, 0.075, 0.07, 0.9, SCAR_LIFE);
      }
      // What it knocks off the surface.
      if (i % 2) continue;
      const tone = hit.surface === 'wood' ? 0.24 : hit.surface === 'metal' ? 0.12 : 0.4;
      this.smoke.emit({
        x: p.x + n.x * 0.1, y: p.y + n.y * 0.1, z: p.z + n.z * 0.1, vx: n.x * rand(0.6, 1.8), vy: n.y * rand(0.6, 1.8) + 0.2, vz: n.z * rand(0.6, 1.8),
        life: rand(0.9, 1.7), size: 0.15, size1: rand(0.6, 1), r: tone, g: tone * 0.94, b: tone * 0.86, alpha: 0.4, erode0: 0.1, erode1: 0.9, drag: 2.5, lift: 0.1,
      });
    }
  }

  /**
   * Masonry and plaster dust: a wall blown out, a building coming down. Clouds billow out of a box
   * (`size` across each way round `pos`) and hang; `amount` 1 is one bay of wall.
   */
  dust(pos: THREE.Vector3, size: THREE.Vector3, amount: number, push?: THREE.Vector3): void {
    const fy = this.floor(pos);
    const big = Math.min(1, amount / 12);
    for (let i = 0, c = this.n(10 * Math.min(amount, 9)); i < c; i++) {
      const g = rand(0.3, 0.44);
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.6, 2.6) + big * 3;
      this.smoke.emit({
        x: pos.x + rand(-0.5, 0.5) * size.x, y: Math.max(fy + 0.2, pos.y + rand(-0.5, 0.5) * size.y), z: pos.z + rand(-0.5, 0.5) * size.z,
        vx: Math.cos(a) * s + (push?.x ?? 0) * rand(0.5, 1.5), vy: rand(0.1, 1.2) + big * 1.5, vz: Math.sin(a) * s + (push?.z ?? 0) * rand(0.5, 1.5),
        life: rand(3.5, 6.5) + big * 4, size: rand(0.7, 1.2) + big, size1: rand(2.4, 3.8) + big * 3.5,
        r: g, g: g * 0.95, b: g * 0.88, alpha: rand(0.4, 0.6), erode0: 0.05, erode1: 0.8, drag: 1.8, lift: 0.08, floor: fy, spin: rand(-0.25, 0.25),
      });
    }
    // Grit raining out of it.
    for (let i = 0, c = this.n(16 * Math.min(amount, 5)); i < c; i++) {
      const d = this.randDir(0.1);
      const s = rand(2, 7);
      const shade = rand(0.14, 0.34);
      this.debris.emit({
        x: pos.x + rand(-0.5, 0.5) * size.x, y: pos.y + rand(-0.4, 0.5) * size.y, z: pos.z + rand(-0.5, 0.5) * size.z,
        vx: d.x * s + (push?.x ?? 0), vy: Math.abs(d.y) * s + 1, vz: d.z * s + (push?.z ?? 0),
        life: rand(1.2, 2.6), size: rand(0.03, 0.08), r: shade, g: shade * 0.95, b: shade * 0.88, alpha: 1, gravity: 1, drag: 0.4, shape: SHAPE.hard, floor: fy + 0.02,
      });
    }
  }

  /** What a fuel tank adds to a blast: a ball of fire rolling up, black smoke after it, burning scrap thrown wide. */
  private fuelBurst(pos: THREE.Vector3, scale: number): void {
    const fy = this.floor(pos);
    const ox = pos.x, oy = Math.max(pos.y, fy) + 0.4, oz = pos.z;
    for (let i = 0, c = this.n(12, scale); i < c; i++) {
      this.fireball.emit({
        x: ox + rand(-1.1, 1.1), y: oy + rand(0.2, 1.4), z: oz + rand(-1.1, 1.1),
        vx: rand(-1.6, 1.6), vy: rand(3.5, 7.5), vz: rand(-1.6, 1.6),
        life: rand(1.1, 1.9), size: rand(1.4, 2.2), size1: rand(3.2, 4.6),
        heat: rand(0.7, 0.9), cool: rand(1.1, 1.7), erode0: 0.05, erode1: 0.95, drag: 1.6, lift: 2.2, floor: fy, alpha: 0.95,
      });
    }
    for (let i = 0, c = this.n(16, scale); i < c; i++) {
      const g = rand(0.035, 0.07);
      this.smoke.emit({
        x: ox + rand(-1, 1), y: oy + rand(0.6, 2), z: oz + rand(-1, 1), vx: rand(-0.8, 0.8), vy: rand(2.2, 4.8), vz: rand(-0.8, 0.8),
        life: rand(6, 10), size: rand(1.4, 2), size1: rand(4.5, 7), r: g, g: g * 0.95, b: g * 0.9, alpha: rand(0.7, 0.9),
        heat: rand(0.3, 0.5), cool: rand(3, 5), glow: 1, erode0: 0, erode1: 0.65, drag: 0.9, lift: 0.5, floor: fy, spin: rand(-0.3, 0.3),
      });
    }
    // Scrap on fire, tumbling out and bouncing.
    for (let i = 0, c = this.n(26, scale); i < c; i++) {
      const d = this.randDir(0.3);
      const s = rand(6, 17);
      this.sparks.emit({
        x: ox, y: oy, z: oz, vx: d.x * s, vy: Math.abs(d.y) * s + 3, vz: d.z * s,
        life: rand(1.2, 2.8), size: rand(0.05, 0.11), r: 6, g: rand(1.8, 2.8), b: 0.5, alpha: 1, gravity: 1, drag: 0.5, stretch: 0.02, shape: SHAPE.spark, floor: fy + 0.03,
      });
    }
    for (let i = 0, c = this.n(30, scale); i < c; i++) {
      const d = this.randDir(0.3);
      const s = rand(5, 16);
      const shade = rand(0.02, 0.07);
      this.debris.emit({
        x: ox, y: oy, z: oz, vx: d.x * s, vy: Math.abs(d.y) * s + 3, vz: d.z * s,
        life: rand(1.6, 3.2), size: rand(0.05, 0.14), r: shade, g: shade, b: shade, alpha: 1, gravity: 1, drag: 0.35, shape: SHAPE.hard, floor: fy + 0.03,
      });
    }
    this.decals.add(DECAL.pool, this.tmp.set(ox, fy + 0.011, oz), this.up, rand(4.6, 5.6) * scale, 0.05, 0.045, 0.04, 0.95, 240);
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
    // The fuel catching: a whoosh a few times the fire's own light, not a blast's flash (at blast
    // strength, ~500 cd for half a second, it lit the fog white across the street).
    this.flashes.push({ pos: new THREE.Vector3(ground.x, ground.y + 0.8, ground.z), t: 0.12, scale: MOLOTOV_FLASH, fire: true });
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

  /** The cars, pumps and drums that smoke or burn this frame. */
  setSmouldering(points: SmoulderPoint[]): void {
    this.smouldering = points;
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
    this.ask(pos.x, pos.y, pos.z, 1, 0.55, 0.2, 6, 6, 2, 6);
  }

  private randDir(minUp: number): THREE.Vector3 {
    const v = new THREE.Vector3();
    do v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)); while (v.lengthSq() > 1 || v.lengthSq() < 0.01);
    v.normalize();
    if (v.y < minUp) v.y = minUp + Math.random() * 0.3;
    return v.normalize();
  }

  private ask(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, range: number, weight: number, steady: number): void {
    this.asks.push({ x, y, z, r, g, b, intensity, range, weight, steady });
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, simTime: number, camera: THREE.Camera): void {
    this.cam.copy(camera.position);
    const f = this.flames;
    f.begin();
    const t = performance.now() / 1000;

    // Blast flashes: blinding for an instant, then the orange of the fireball, then nothing. A
    // Molotov's whoosh is a fire's light (held down near walls and cars, faint in the fog).
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const fl = this.flashes[i];
      fl.t += dt;
      const k = fl.t;
      const flash = (Math.exp(-k * 22) * 5200 + Math.exp(-k * 4.5) * 900) * fl.scale * (this.reducedFlashing ? 0.4 : 1);
      if (k > 1.4) {
        this.flashes.splice(i, 1);
        continue;
      }
      const warm = Math.min(1, k * 6);
      this.ask(fl.pos.x, fl.pos.y, fl.pos.z, 1, 0.82 - warm * 0.3, 0.6 - warm * 0.45, flash, 38, 100, fl.fire ? flash : 0);
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
        this.ask(v.centre.x, v.centre.y + 1, v.centre.z, 1, 0.5, 0.16, 45 * s * fl, 13, 20, 45 * s);
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
    if (bw > 0) {
      const glow = Math.min(90, 25 + this.burning.length * 6);
      this.ask(bx / bw, by / bw + 0.5, bz / bw, 1, 0.5, 0.16, glow, 10, 10, glow);
    }

    // Shot-up cars, pumps and drums: smoke from the damage, flames once they catch, a black column after.
    for (const p of this.smouldering) {
      const d = Math.hypot(p.x - this.cam.x, p.z - this.cam.z);
      if (d > 120) continue;
      const lod = (d > 60 ? 0.4 : d > 30 ? 0.7 : 1) * this.quality;
      const s = p.strength, z = p.size;
      if ((p.stage === 2 || p.stage === 3) && s > 0.02) {
        const big = p.stage === 2 ? 1 : 0.55 * s;
        for (let k = 0; k < 3; k++) {
          const seed = (p.seed + k * 0.31) % 1;
          const flick = 0.8 + 0.2 * Math.sin(t * (8 + seed * 5) + seed * 40);
          const a = seed * 6.283 + k * 2.1;
          f.flame(p.x + Math.cos(a) * 0.35 * z, p.y - 0.15, p.z + Math.sin(a) * 0.35 * z, (0.7 + seed * 0.4) * z * big, (1.5 + seed * 0.9) * z * big * flick, seed, 0.85, Math.min(1, 0.5 + s));
        }
        if (Math.random() < dt * 9 * big * lod) {
          this.sparks.emit({ x: p.x + rand(-0.5, 0.5) * z, y: p.y + rand(0.2, 0.9), z: p.z + rand(-0.5, 0.5) * z, vx: rand(-0.7, 0.7), vy: rand(1.5, 3.6), vz: rand(-0.7, 0.7), life: rand(0.8, 2), size: rand(0.014, 0.03), r: 6, g: rand(1.6, 2.6), b: 0.4, alpha: 1, gravity: -0.03, drag: 0.9, stretch: 0.012, shape: SHAPE.spark });
        }
        const fl = 0.8 + 0.14 * Math.sin(t * 11 + p.seed * 9) + 0.08 * Math.sin(t * 23.7 + p.seed * 31);
        this.ask(p.x, p.y + 0.8, p.z, 1, 0.5, 0.16, 40 * big * fl, 12, 16, 40 * big);
      }
      // Smoke: a grey wisp from a hole in the hood, black and rolling from a fire.
      const rate = p.stage === 1 ? 2.5 * s : p.stage === 2 ? 7 : p.stage === 3 ? 5 * s : 3.5 * s;
      if (Math.random() < dt * rate * lod) {
        const g = p.stage === 1 ? rand(0.16, 0.24) : rand(0.035, 0.075);
        this.smoke.emit({
          x: p.x + rand(-0.25, 0.25) * z, y: p.y + (p.stage === 1 ? 0.1 : 0.9), z: p.z + rand(-0.25, 0.25) * z, vx: rand(-0.25, 0.25), vy: rand(1.1, 2.2), vz: rand(-0.25, 0.25),
          life: p.stage === 1 ? rand(2.2, 3.6) : rand(5, 8), size: (p.stage === 1 ? rand(0.25, 0.4) : rand(0.8, 1.2)) * z, size1: (p.stage === 1 ? rand(1.2, 1.9) : rand(3.4, 5.2)) * z,
          r: g, g: g * 0.96, b: g * 0.93, alpha: p.stage === 1 ? rand(0.3, 0.45) : rand(0.6, 0.85),
          glow: p.stage === 2 ? 0.9 : p.stage === 3 ? 0.4 * s : 0, erode0: 0.05, erode1: 0.8, drag: 0.6, lift: 0.4, spin: rand(-0.25, 0.25),
        });
      }
    }

    // Shockwave.
    if (this.ringT >= 0) {
      this.ringT += dt;
      const u = this.ringT / 0.32;
      if (u >= 1) {
        this.ringT = -1;
        this.ring.visible = false;
      } else {
        this.ring.scale.setScalar(0.6 + u * this.ringR);
        this.ringMat.uniforms.uT.value = u;
      }
    }

    this.fireball.update(dt, camera);
    this.smoke.update(dt, camera);
    this.sparks.update(dt);
    this.debris.update(dt);
    f.end(dt);
    this.placeLights(dt);
  }

  /**
   * Gives the pooled lights to the asks that matter most from here. A fire's light is held down
   * near walls, cars and ceilings (lampPower) and kept faint in the fog; a blast's flash isn't.
   */
  private placeLights(dt: number): void {
    const c = this.cam;
    const score = (a: LightAsk) => a.weight * a.intensity / (1 + Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z) * 0.2);
    this.asks.sort((a, b) => score(b) - score(a));
    for (let i = 0; i < LIGHTS; i++) {
      const l = this.lights[i];
      const a = this.asks[i];
      if (!a) {
        l.intensity = 0;
        this.lit[i].x = Infinity;
        continue;
      }
      l.position.set(a.x, a.y, a.z);
      l.color.setRGB(a.r, a.g, a.b);
      l.distance = a.range;
      let power = 1;
      if (a.steady > 0) {
        power = lampPower(this.physics, l, a.steady, l.position);
        // The same fire (or a burning body walking on): settle, don't jump.
        if (this.lit[i].distanceToSquared(l.position) < 2.25) power = this.power[i] + (power - this.power[i]) * (1 - Math.exp(-dt * SETTLE));
      }
      this.power[i] = power;
      this.lit[i].copy(l.position);
      l.intensity = a.intensity * power;
      l.userData.fogScale = a.steady > 0 ? FIRE_FOG : 1;
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
    this.smouldering = [];
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
