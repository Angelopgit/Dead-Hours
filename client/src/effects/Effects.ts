import * as THREE from 'three';
import type { Surface, WeaponId } from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import type { Quality } from '../core/Settings';
import { ParticleBatch, SHAPE, type ParticleSpec } from './Particles';
import { DECAL, DecalBatch } from './Decals';
import { Casings } from './Casings';

export type Gore = 'off' | 'reduced' | 'full';

interface SurfaceFx {
  dust: [number, number, number];
  chip: [number, number, number] | null;
  chips: number;
  sparks: number;
  hole: [number, number, number] | null;
  holeSize: number;
  cell?: number;
}

const SURFACES: Record<Surface, SurfaceFx> = {
  concrete: { dust: [0.34, 0.33, 0.31], chip: [0.42, 0.41, 0.38], chips: 6, sparks: 0, hole: [0.16, 0.16, 0.16], holeSize: 0.075 },
  asphalt: { dust: [0.2, 0.2, 0.2], chip: [0.16, 0.16, 0.16], chips: 5, sparks: 1, hole: [0.2, 0.2, 0.2], holeSize: 0.08 },
  brick: { dust: [0.36, 0.2, 0.15], chip: [0.42, 0.2, 0.14], chips: 7, sparks: 0, hole: [0.2, 0.14, 0.12], holeSize: 0.085 },
  plaster: { dust: [0.55, 0.53, 0.5], chip: [0.62, 0.6, 0.56], chips: 6, sparks: 0, hole: [0.22, 0.21, 0.2], holeSize: 0.07 },
  wood: { dust: [0.34, 0.25, 0.16], chip: [0.42, 0.28, 0.15], chips: 7, sparks: 0, hole: [0.22, 0.16, 0.12], holeSize: 0.06 },
  metal: { dust: [0.22, 0.22, 0.24], chip: null, chips: 0, sparks: 10, hole: [0.28, 0.28, 0.3], holeSize: 0.045 },
  glass: { dust: [0.5, 0.55, 0.6], chip: [0.75, 0.85, 0.9], chips: 10, sparks: 0, hole: [0.55, 0.6, 0.66], holeSize: 0.28, cell: DECAL.crack },
  grass: { dust: [0.2, 0.19, 0.12], chip: [0.14, 0.17, 0.08], chips: 6, sparks: 0, hole: null, holeSize: 0 },
  dirt: { dust: [0.27, 0.21, 0.15], chip: [0.2, 0.15, 0.1], chips: 7, sparks: 0, hole: [0.45, 0.4, 0.36], holeSize: 0.1 },
  fabric: { dust: [0.4, 0.38, 0.36], chip: null, chips: 0, sparks: 0, hole: [0.3, 0.28, 0.27], holeSize: 0.05 },
  flesh: { dust: [0.25, 0.02, 0.02], chip: null, chips: 0, sparks: 0, hole: null, holeSize: 0 },
};

const BLOOD: [number, number, number] = [0.24, 0.008, 0.008];
const BLOOD_DECAL: [number, number, number] = [0.34, 0.03, 0.025];

const FLASH: Record<WeaponId, { size: number; light: number }> = {
  ar: { size: 0.42, light: 1 }, smg: { size: 0.32, light: 0.8 }, shotgun: { size: 0.65, light: 1.4 },
  marksman: { size: 0.55, light: 1.2 }, pistol: { size: 0.3, light: 0.7 }, machete: { size: 0, light: 0 },
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Combat visuals: surface impacts (dust, chips, sparks, glass, bullet holes), blood (mist,
 * droplets that land as drips, directional splatter on whatever is behind, pools under the
 * dead), muzzle flashes with a light, tracers and ejected casings. Everything is pooled;
 * emission thins out with distance and the particle quality setting; gore can be reduced or off.
 */
export class Effects {
  readonly root = new THREE.Group();
  private readonly soft: ParticleBatch;
  private readonly glow: ParticleBatch;
  readonly decals: DecalBatch;
  readonly casings: Casings;
  private readonly light = new THREE.PointLight(0xffb066, 0, 10, 2);
  private lightT = 0;
  private lightPower = 0;
  private quality = 1;
  gore: Gore = 'full';
  reducedFlashing = false;
  private readonly camPos = new THREE.Vector3();
  private dripBudget = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** Marks are skipped on moving surfaces (doors) so they never float in the air. */
  isMoving: ((pos: THREE.Vector3, normal: THREE.Vector3) => boolean) | null = null;

  constructor(scene: THREE.Scene, private readonly physics: Physics) {
    this.soft = new ParticleBatch(1800, false);
    this.glow = new ParticleBatch(700, true);
    this.decals = new DecalBatch(380);
    this.casings = new Casings(56);
    this.root.add(this.decals.mesh, this.soft.mesh, this.glow.mesh, this.casings.mesh);
    this.light.castShadow = false;
    // The flash light stays in the scene at zero intensity: adding and removing lights would
    // recompile every lit material.
    this.root.add(this.light);
    scene.add(this.root);
    this.soft.onLand = (kind, x, y, z) => this.landed(kind, x, y, z);
  }

  setQuality(q: Quality, gore: Gore, reducedFlashing: boolean): void {
    this.quality = q === 'low' ? 0.35 : q === 'medium' ? 0.65 : 1;
    this.soft.setCapacity(this.quality);
    this.glow.setCapacity(this.quality);
    this.decals.setCapacity(q === 'low' ? 0.45 : q === 'medium' ? 0.75 : 1);
    this.gore = gore;
    this.reducedFlashing = reducedFlashing;
  }

  /** Emission multiplier: full up close, thinning with distance from the camera. */
  private scale(pos: THREE.Vector3): number {
    const d = pos.distanceTo(this.camPos);
    return this.quality * THREE.MathUtils.clamp(1 - (d - 18) / 55, 0.2, 1);
  }

  private n(count: number, k: number): number {
    const v = count * k;
    return Math.floor(v) + (Math.random() < v % 1 ? 1 : 0);
  }

  private emitSoft(p: ParticleSpec): void {
    this.soft.emit(p);
  }

  /** A bullet stopped by the world. */
  impact(pos: THREE.Vector3, normal: THREE.Vector3, surface: Surface, dir: THREE.Vector3): void {
    const fx = SURFACES[surface] ?? SURFACES.concrete;
    const k = this.scale(pos);
    const n = normal;
    // Debris leaves along the reflected direction, biased off the surface.
    const refl = this.tmp.copy(dir).addScaledVector(n, -2 * dir.dot(n)).lerp(n, 0.45).normalize();
    for (let i = 0, c = this.n(3, k); i < Math.max(1, c); i++) {
      const s = rand(0.6, 1.6);
      this.emitSoft({
        x: pos.x + n.x * 0.04, y: pos.y + n.y * 0.04, z: pos.z + n.z * 0.04,
        vx: n.x * s + rand(-0.3, 0.3), vy: n.y * s + rand(0, 0.5), vz: n.z * s + rand(-0.3, 0.3),
        life: rand(0.8, 1.6), size: 0.08, size1: rand(0.45, 0.7),
        r: fx.dust[0], g: fx.dust[1], b: fx.dust[2], alpha: 0.42, drag: 3.2, gravity: -0.02,
      });
    }
    if (fx.chip) {
      const floor = pos.y - 3;
      for (let i = 0, c = this.n(fx.chips, k); i < c; i++) {
        const s = rand(2, 5.5);
        this.emitSoft({
          x: pos.x + n.x * 0.02, y: pos.y + n.y * 0.02, z: pos.z + n.z * 0.02,
          vx: (refl.x + rand(-0.5, 0.5)) * s, vy: (refl.y + rand(-0.3, 0.6)) * s, vz: (refl.z + rand(-0.5, 0.5)) * s,
          life: rand(0.5, 0.9), size: surface === 'glass' ? rand(0.015, 0.035) : rand(0.012, 0.028),
          r: fx.chip[0], g: fx.chip[1], b: fx.chip[2], alpha: surface === 'glass' ? 0.75 : 1,
          gravity: 1, drag: 0.6, shape: SHAPE.hard, floor,
        });
      }
    }
    const sparks = this.n(fx.sparks, k);
    for (let i = 0; i < sparks; i++) {
      const s = rand(3, 9);
      this.glow.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: (refl.x + rand(-0.6, 0.6)) * s, vy: (refl.y + rand(-0.2, 0.8)) * s, vz: (refl.z + rand(-0.6, 0.6)) * s,
        life: rand(0.15, 0.4), size: 0.012, size1: 0.004, r: 4, g: 2.3, b: 0.7, alpha: 1,
        gravity: 0.7, drag: 1.5, stretch: 0.025, shape: SHAPE.spark,
      });
    }
    if (fx.sparks > 0 || surface === 'concrete' || surface === 'asphalt') {
      // Brief hot point at the strike.
      this.glow.emit({ x: pos.x + n.x * 0.02, y: pos.y + n.y * 0.02, z: pos.z + n.z * 0.02, vx: 0, vy: 0, vz: 0, life: 0.05, size: 0.09, size1: 0.02, r: 3, g: 2, b: 1.2, alpha: 0.9, shape: SHAPE.spark });
    }
    if (fx.hole && !this.isMoving?.(pos, n)) {
      const size = fx.holeSize * rand(0.85, 1.2);
      this.decals.add(fx.cell ?? DECAL.hole, pos, n, size, fx.hole[0], fx.hole[1], fx.hole[2], 0.95, 90);
    }
  }

  /** A round or blade hit a zombie (or a player). */
  blood(pos: THREE.Vector3, dir: THREE.Vector3, damage: number, opts: { exit: { pos: THREE.Vector3; normal: THREE.Vector3 } | null; killed: boolean; head: boolean; melee: boolean }): void {
    const k = this.scale(pos);
    if (this.gore === 'off') {
      this.emitSoft({ x: pos.x, y: pos.y, z: pos.z, vx: -dir.x * 0.4, vy: 0.2, vz: -dir.z * 0.4, life: 0.4, size: 0.08, size1: 0.3, r: 0.22, g: 0.2, b: 0.18, alpha: 0.35, drag: 3 });
      return;
    }
    const gore = this.gore === 'full' ? 1 : 0.4;
    // Mist where it went in, kicked slightly back toward the shooter.
    for (let i = 0; i < (this.gore === 'full' ? 2 : 1); i++) {
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z,
        vx: -dir.x * rand(0.2, 0.8) + rand(-0.2, 0.2), vy: rand(0, 0.4), vz: -dir.z * rand(0.2, 0.8) + rand(-0.2, 0.2),
        life: rand(0.3, 0.5), size: 0.1, size1: rand(0.35, 0.55) * (opts.head ? 1.4 : 1),
        r: BLOOD[0] * 1.3, g: BLOOD[1], b: BLOOD[2], alpha: 0.55, drag: 4,
      });
    }
    // Droplets out the far side.
    const floorD = this.physics.raycast(pos.x, pos.y, pos.z, 0, -1, 0, 4);
    const floor = floorD === null ? pos.y - 4 : pos.y - floorD + 0.01;
    const count = this.n((6 + Math.min(20, damage / 4)) * (opts.head && opts.killed ? 2.2 : 1) * gore, k);
    for (let i = 0; i < count; i++) {
      const s = rand(1.5, 4.5) * (opts.melee ? 0.7 : 1);
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * s + rand(-1, 1), vy: dir.y * s + rand(-0.2, 1.4), vz: dir.z * s + rand(-1, 1),
        life: rand(0.6, 1.2), size: rand(0.018, 0.04),
        r: BLOOD[0], g: BLOOD[1], b: BLOOD[2], alpha: 0.95, gravity: 1, drag: 0.4, stretch: 0.02, shape: SHAPE.hard,
        floor, onLand: 1,
      });
    }
    if (opts.head && opts.killed && this.gore === 'full') {
      for (let i = 0; i < this.n(8, k); i++) {
        const s = rand(1, 3.5);
        this.emitSoft({
          x: pos.x, y: pos.y, z: pos.z,
          vx: dir.x * s + rand(-1.2, 1.2), vy: rand(0.5, 2.5), vz: dir.z * s + rand(-1.2, 1.2),
          life: rand(0.7, 1.1), size: rand(0.035, 0.06), r: 0.14, g: 0.008, b: 0.008, alpha: 1,
          gravity: 1, drag: 0.3, shape: SHAPE.hard, floor, onLand: 2,
        });
      }
    }
    // Splatter on the wall or floor behind.
    if (opts.exit && (this.gore === 'full' || opts.killed) && !this.isMoving?.(opts.exit.pos, opts.exit.normal)) {
      const size = (0.45 + Math.min(0.6, damage / 90)) * (opts.head && opts.killed ? 1.4 : 1) * (this.gore === 'full' ? 1 : 0.6);
      this.decals.add(DECAL.splat, opts.exit.pos, opts.exit.normal, size, BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.92, 60, 0, dir);
    }
  }

  /** Height of whatever is below a point (where falling blood lands). */
  private floorBelow(pos: THREE.Vector3, reach = 4): number {
    const d = this.physics.raycast(pos.x, pos.y, pos.z, 0, -1, 0, reach);
    return d === null ? pos.y - reach : pos.y - d + 0.01;
  }

  /** Blood droplets in a cone around `dir`. */
  private droplets(pos: THREE.Vector3, dir: THREE.Vector3, count: number, speed: [number, number], spread: number, floor: number, size: [number, number] = [0.016, 0.036]): void {
    for (let i = 0; i < count; i++) {
      const s = rand(speed[0], speed[1]);
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z,
        vx: (dir.x + rand(-spread, spread)) * s, vy: (dir.y + rand(-spread, spread)) * s + rand(0, 0.6), vz: (dir.z + rand(-spread, spread)) * s,
        life: rand(0.7, 1.3), size: rand(size[0], size[1]),
        r: BLOOD[0], g: BLOOD[1], b: BLOOD[2], alpha: 0.95, gravity: 1, drag: 0.35, stretch: 0.022, shape: SHAPE.hard,
        floor, onLand: 1,
      });
    }
  }

  /** Lumps of meat (they land as big splats) and pale splinters of bone. */
  private chunks(pos: THREE.Vector3, dir: THREE.Vector3, meat: number, bone: number, floor: number): void {
    for (let i = 0; i < meat; i++) {
      const s = rand(1.2, 3.6);
      const dark = rand(0.55, 1);
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * s + rand(-1.3, 1.3), vy: rand(0.6, 2.6), vz: dir.z * s + rand(-1.3, 1.3),
        life: rand(0.8, 1.4), size: rand(0.03, 0.065), r: 0.3 * dark, g: 0.03 * dark, b: 0.025 * dark, alpha: 1,
        gravity: 1, drag: 0.25, shape: SHAPE.hard, floor, onLand: 2,
      });
    }
    for (let i = 0; i < bone; i++) {
      const s = rand(1.5, 4);
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * s + rand(-1.5, 1.5), vy: rand(0.8, 2.8), vz: dir.z * s + rand(-1.5, 1.5),
        life: rand(0.7, 1.2), size: rand(0.012, 0.024), r: 0.82, g: 0.77, b: 0.64, alpha: 1,
        gravity: 1, drag: 0.3, stretch: 0.01, shape: SHAPE.hard, floor,
      });
    }
  }

  /**
   * An arm torn off at `pos`: a burst of blood and mist both ways from the cut, scraps of meat
   * and bone, and a splash on whatever is behind and below.
   */
  sever(pos: THREE.Vector3, dir: THREE.Vector3, melee: boolean): void {
    if (this.gore === 'off') {
      this.emitSoft({ x: pos.x, y: pos.y, z: pos.z, vx: dir.x * 0.6, vy: 0.3, vz: dir.z * 0.6, life: 0.5, size: 0.1, size1: 0.4, r: 0.22, g: 0.2, b: 0.18, alpha: 0.35, drag: 3 });
      return;
    }
    const full = this.gore === 'full' ? 1 : 0.45;
    const k = this.scale(pos) * full;
    const floor = this.floorBelow(pos);
    for (let i = 0; i < (full === 1 ? 4 : 2); i++) {
      this.emitSoft({
        x: pos.x + rand(-0.05, 0.05), y: pos.y + rand(-0.05, 0.05), z: pos.z + rand(-0.05, 0.05),
        vx: dir.x * rand(0.3, 1.2) + rand(-0.3, 0.3), vy: rand(0, 0.5), vz: dir.z * rand(0.3, 1.2) + rand(-0.3, 0.3),
        life: rand(0.5, 0.9), size: 0.12, size1: rand(0.45, 0.75),
        r: BLOOD[0] * 1.35, g: BLOOD[1], b: BLOOD[2], alpha: 0.6, drag: 3.5,
      });
    }
    this.droplets(pos, dir, this.n(34, k), [2, 5.5], 0.45, floor);
    const back = this.tmp.copy(dir).negate();
    this.droplets(pos, back, this.n(12, k), [1, 2.5], 0.6, floor);
    this.chunks(pos, dir, this.n(melee ? 7 : 5, k), this.n(melee ? 2 : 4, k), floor);
    // Splashes: along the blow onto a wall, and down onto the floor.
    const ray = new THREE.Vector3(dir.x, dir.y * 0.3 - 0.25, dir.z).normalize();
    const hit = this.physics.raycastHit(pos.x, pos.y, pos.z, ray.x, ray.y, ray.z, 2.8);
    if (hit) {
      const at = new THREE.Vector3().copy(pos).addScaledVector(ray, hit.distance);
      const n = new THREE.Vector3(hit.nx, hit.ny, hit.nz);
      if (!this.isMoving?.(at, n)) this.decals.add(DECAL.splat, at, n, rand(0.5, 0.8) * (full === 1 ? 1 : 0.6), BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.92, 70, 0, dir);
    }
  }

  /** One pulse of blood from a fresh stump (several a second, weakening). */
  spurt(pos: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    if (this.gore === 'off' || strength <= 0) return;
    const k = this.scale(pos) * (this.gore === 'full' ? 1 : 0.4);
    const floor = this.floorBelow(pos);
    this.droplets(pos, dir, Math.max(1, this.n(3 + strength * 9, k)), [1 + strength * 1.5, 2 + strength * 3.2], 0.16, floor, [0.014, 0.03]);
    if (strength > 0.4 && Math.random() < 0.5) {
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z, vx: dir.x * 0.6, vy: dir.y * 0.6, vz: dir.z * 0.6,
        life: 0.35, size: 0.05, size1: rand(0.18, 0.28), r: BLOOD[0] * 1.3, g: BLOOD[1], b: BLOOD[2], alpha: 0.45, drag: 4,
      });
    }
  }

  /** Blood thrown off something being swung: the drops fly on with its velocity. */
  fling(pos: THREE.Vector3, vel: THREE.Vector3, count: number): void {
    if (this.gore === 'off') return;
    const k = this.scale(pos) * (this.gore === 'full' ? 1 : 0.4);
    // A hitch in the frame rate would make a swing look impossibly fast.
    const speed = vel.length();
    const cap = speed > 9 ? 9 / speed : 1;
    const floor = this.floorBelow(pos);
    for (let i = 0, n = this.n(count, k); i < n; i++) {
      const s = rand(0.45, 0.95) * cap;
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z,
        vx: vel.x * s + rand(-0.4, 0.4), vy: vel.y * s + rand(-0.2, 0.5), vz: vel.z * s + rand(-0.4, 0.4),
        life: rand(0.6, 1.1), size: rand(0.012, 0.03), r: BLOOD[0], g: BLOOD[1], b: BLOOD[2], alpha: 0.95,
        gravity: 1, drag: 0.35, stretch: 0.024, shape: SHAPE.hard, floor, onLand: 1,
      });
    }
  }

  /** A single drop falling from a wound (they leave a trail on the ground). */
  drip(pos: THREE.Vector3, vel?: THREE.Vector3): void {
    if (this.gore === 'off') return;
    this.emitSoft({
      x: pos.x, y: pos.y, z: pos.z, vx: (vel?.x ?? 0) * 0.6, vy: (vel?.y ?? 0) * 0.3 - 0.2, vz: (vel?.z ?? 0) * 0.6,
      life: 1.4, size: rand(0.012, 0.022), r: BLOOD[0], g: BLOOD[1], b: BLOOD[2], alpha: 0.95,
      gravity: 1, drag: 0.2, stretch: 0.03, shape: SHAPE.hard, floor: this.floorBelow(pos), onLand: 1,
    });
  }

  /** A severed arm landing: a wet splat where it hit. */
  splat(pos: THREE.Vector3, size: number): void {
    if (this.gore === 'off') return;
    this.tmp.set(pos.x, this.floorBelow(this.tmp.set(pos.x, pos.y + 0.2, pos.z), 0.6), pos.z);
    this.decals.add(DECAL.splat, this.tmp, this.up, size * (this.gore === 'full' ? 1 : 0.6), BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.9, 60);
  }

  /** Clubbing with a severed arm: the torn end splashes blood along the swing. */
  clubSplash(pos: THREE.Vector3, dir: THREE.Vector3): void {
    if (this.gore === 'off') return;
    const k = this.scale(pos) * (this.gore === 'full' ? 1 : 0.4);
    const floor = this.floorBelow(pos);
    this.droplets(pos, dir, this.n(16, k), [1.5, 4], 0.55, floor);
    this.chunks(pos, dir, this.n(2, k), 0, floor);
    this.emitSoft({
      x: pos.x, y: pos.y, z: pos.z, vx: dir.x, vy: 0.2, vz: dir.z,
      life: 0.45, size: 0.1, size1: 0.5, r: BLOOD[0] * 1.3, g: BLOOD[1], b: BLOOD[2], alpha: 0.5, drag: 4,
    });
  }

  /** A worn-out arm bursting apart in the hands. */
  gibs(pos: THREE.Vector3, dir: THREE.Vector3): void {
    if (this.gore === 'off') {
      this.emitSoft({ x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0.3, vz: 0, life: 0.6, size: 0.12, size1: 0.5, r: 0.22, g: 0.2, b: 0.18, alpha: 0.35, drag: 3 });
      return;
    }
    const k = this.scale(pos) * (this.gore === 'full' ? 1 : 0.45);
    const floor = this.floorBelow(pos);
    this.chunks(pos, dir, this.n(14, k), this.n(7, k), floor);
    this.droplets(pos, dir, this.n(30, k), [1.2, 4.5], 0.8, floor);
    for (let i = 0; i < 3; i++) {
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z, vx: rand(-0.5, 0.5) + dir.x * 0.5, vy: rand(0, 0.5), vz: rand(-0.5, 0.5) + dir.z * 0.5,
        life: rand(0.5, 0.9), size: 0.12, size1: rand(0.5, 0.8), r: BLOOD[0] * 1.35, g: BLOOD[1], b: BLOOD[2], alpha: 0.6, drag: 3.5,
      });
    }
  }

  private landed(kind: number, x: number, y: number, z: number): void {
    if (this.gore === 'off') return;
    // Not every drop leaves a mark.
    this.dripBudget += kind === 2 ? 1 : 0.35;
    if (this.dripBudget < 1) return;
    this.dripBudget -= 1;
    this.tmp.set(x, y, z);
    const size = kind === 2 ? rand(0.12, 0.2) : rand(0.08, 0.16);
    this.decals.add(DECAL.splat, this.tmp, this.up, size, BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.85, 40);
  }

  /** Spreading pool under a body. */
  pool(pos: THREE.Vector3, size: number, life: number): void {
    if (this.gore === 'off') return;
    const s = size * (this.gore === 'full' ? 1 : 0.6);
    this.decals.add(DECAL.pool, pos, this.up, s, BLOOD_DECAL[0] * 0.9, BLOOD_DECAL[1], BLOOD_DECAL[2], 0.92, life, 5);
  }

  muzzle(pos: THREE.Vector3, dir: THREE.Vector3, weapon: WeaponId): void {
    const f = FLASH[weapon];
    if (!f.size) return;
    const dim = this.reducedFlashing ? 0.45 : 1;
    this.glow.emit({ x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0, life: 0.045, size: f.size * rand(0.8, 1.1), size1: f.size * 0.6, r: 5 * dim, g: 3 * dim, b: 1.3 * dim, alpha: 1, shape: SHAPE.flash });
    this.glow.emit({
      x: pos.x + dir.x * 0.08, y: pos.y + dir.y * 0.08, z: pos.z + dir.z * 0.08,
      vx: dir.x * 9, vy: dir.y * 9, vz: dir.z * 9,
      life: 0.04, size: f.size * 0.35, r: 4 * dim, g: 2.4 * dim, b: 1 * dim, alpha: 0.9, stretch: 0.03, shape: SHAPE.spark,
    });
    for (let i = 0; i < (weapon === 'shotgun' || weapon === 'marksman' ? 3 : 1); i++) {
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * rand(0.6, 1.6), vy: dir.y * rand(0.6, 1.6) + 0.15, vz: dir.z * rand(0.6, 1.6),
        life: rand(0.8, 1.5), size: 0.06, size1: rand(0.3, 0.5), r: 0.45, g: 0.45, b: 0.46, alpha: 0.16, drag: 2.5, gravity: -0.04,
      });
    }
    this.light.position.copy(pos).addScaledVector(dir, 0.15);
    this.lightPower = f.light * dim;
    this.lightT = 0.06;
  }

  /** Bright streak from the muzzle to where the round stopped. */
  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const d = this.tmp.subVectors(to, from);
    const len = d.length();
    if (len < 2) return;
    d.divideScalar(len);
    const speed = 300;
    const start = 0.8;
    this.glow.emit({
      x: from.x + d.x * start, y: from.y + d.y * start, z: from.z + d.z * start,
      vx: d.x * speed, vy: d.y * speed, vz: d.z * speed,
      life: Math.max(0.02, (len - start) / speed), size: 0.022, r: 3, g: 2.1, b: 1.1, alpha: 0.55, stretch: 0.011, shape: SHAPE.spark,
    });
  }

  eject(pos: THREE.Vector3, dir: THREE.Vector3, floor: number, shell: boolean, inherit: THREE.Vector3): void {
    this.casings.eject(pos, dir, floor, shell, inherit);
  }

  /** Splinters and dust when a door bursts open. */
  splinters(pos: THREE.Vector3, normal: THREE.Vector3): void {
    for (let i = 0; i < this.n(18, this.scale(pos)); i++) {
      const s = rand(1.5, 4);
      this.emitSoft({
        x: pos.x + rand(-0.4, 0.4), y: pos.y + rand(-0.8, 0.8), z: pos.z + rand(-0.4, 0.4),
        vx: normal.x * s + rand(-1, 1), vy: rand(0, 2), vz: normal.z * s + rand(-1, 1),
        life: rand(0.8, 1.4), size: rand(0.02, 0.05), r: 0.4, g: 0.27, b: 0.15, alpha: 1, gravity: 1, drag: 0.5, shape: SHAPE.hard, floor: pos.y - 1.1,
      });
    }
    for (let i = 0; i < 4; i++) {
      this.emitSoft({ x: pos.x + rand(-0.5, 0.5), y: pos.y + rand(-0.8, 0.6), z: pos.z + rand(-0.5, 0.5), vx: normal.x, vy: 0.2, vz: normal.z, life: 1.5, size: 0.2, size1: 0.9, r: 0.36, g: 0.3, b: 0.24, alpha: 0.3, drag: 2 });
    }
  }

  /** Red signal smoke and sparks from a flare on a supply crate. */
  flareSmoke(pos: THREE.Vector3, strong: boolean): void {
    const k = this.scale(pos);
    if (Math.random() < 0.35 + 0.65 * k) {
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z, vx: rand(-0.25, 0.25), vy: rand(0.7, 1.2), vz: rand(-0.25, 0.25),
        life: rand(2.6, 4.2), size: 0.12, size1: rand(1.3, 2.2), r: 0.78, g: 0.13, b: 0.11, alpha: strong ? 0.3 : 0.14, drag: 0.55, gravity: -0.06,
      });
    }
    if (this.reducedFlashing) return;
    for (let i = 0; i < this.n(2, k); i++) {
      this.glow.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: rand(-0.6, 0.6), vy: rand(0.8, 2.2), vz: rand(-0.6, 0.6),
        life: rand(0.12, 0.3), size: 0.035, r: 6, g: 1.4, b: 0.5, alpha: 1, gravity: 0.6, stretch: 0.02, shape: SHAPE.spark,
      });
    }
  }

  /** Dust kicked up by something heavy landing on the ground. */
  landingDust(pos: THREE.Vector3): void {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + rand(-0.2, 0.2);
      const s = rand(1.2, 2.6);
      this.emitSoft({
        x: pos.x + Math.cos(a) * 0.5, y: pos.y + 0.05, z: pos.z + Math.sin(a) * 0.5, vx: Math.cos(a) * s, vy: rand(0.1, 0.5), vz: Math.sin(a) * s,
        life: rand(1.2, 2.2), size: 0.2, size1: rand(0.8, 1.3), r: 0.42, g: 0.38, b: 0.32, alpha: 0.32, drag: 2.2, gravity: -0.02,
      });
    }
  }

  clear(): void {
    this.soft.clear();
    this.glow.clear();
    this.decals.clear();
    this.casings.clear();
    this.light.intensity = 0;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.camPos.copy(camera.position);
    this.soft.update(dt);
    this.glow.update(dt);
    this.decals.update(dt);
    this.casings.update(dt);
    this.lightT -= dt;
    this.light.intensity = this.lightT > 0 ? this.lightPower * 9 * (this.lightT / 0.06) : 0;
  }

  dispose(): void {
    this.soft.dispose();
    this.glow.dispose();
    this.decals.dispose();
    this.casings.dispose();
    this.light.removeFromParent();
    this.light.dispose();
    this.root.removeFromParent();
  }
}
