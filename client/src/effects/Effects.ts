import * as THREE from 'three';
import type { Surface, WeaponId } from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import type { Quality } from '../core/Settings';
import { ParticleBatch, SHAPE, type ParticleSpec } from './Particles';
import { DECAL, DecalBatch } from './Decals';
import { Casings } from './Casings';
import { SmokeWisps } from './Smoke';
import { FleshChunks, type ChunkKind } from './Chunks';

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

const FLASH: Partial<Record<WeaponId, { size: number; light: number }>> = {
  ar: { size: 0.42, light: 1 }, smg: { size: 0.32, light: 0.8 }, shotgun: { size: 0.65, light: 1.4 },
  marksman: { size: 0.55, light: 1.2 }, pistol: { size: 0.3, light: 0.7 }, akimbo: { size: 0.3, light: 0.7 }, machete: { size: 0, light: 0 },
  lmg: { size: 0.45, light: 1.0 }, battle: { size: 0.5, light: 1.1 }, sniper: { size: 0.85, light: 1.7 },
  rpg: { size: 1.1, light: 2.2 }, wraith: { size: 0.12, light: 0.25 },
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
  /** Survivors' cigarette, joint and blunt smoke (see Smoking). */
  readonly smoke: SmokeWisps;
  /** Lumps of meat, bone and skull thrown off bodies. */
  readonly chunks: FleshChunks;
  /** A piece of a body hit the ground (for its sound). */
  onChunkLand: ((pos: THREE.Vector3, strength: number, kind: ChunkKind) => void) | null = null;
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmp3 = new THREE.Vector3();
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
    // Blood marks share the ring with bullet holes: room for a street fight's worth of both.
    this.decals = new DecalBatch(520);
    this.casings = new Casings(56);
    // A little brighter than the explosions' smoke ambient, so a thin wisp still reads at night.
    this.smoke = new SmokeWisps(220, new THREE.Color(0.2, 0.21, 0.24));
    this.chunks = new FleshChunks(physics);
    this.root.add(this.decals.mesh, this.soft.mesh, this.glow.mesh, this.casings.mesh, this.smoke.mesh, this.chunks.mesh);
    this.chunks.onLand = (pos, strength, kind, normal) => {
      // Wet pieces leave a mark where they first come down; bone just clatters.
      if (this.gore !== 'off' && kind !== 'bone' && (strength > 0.15 || Math.random() < 0.5) && !this.isMoving?.(pos, normal)) {
        this.decals.add(DECAL.splat, this.tmp3.copy(pos), normal, rand(0.09, 0.16) + strength * 0.14, BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.88, 50);
      }
      this.onChunkLand?.(pos, strength, kind);
    };
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
    this.smoke.setQuality(this.quality);
    this.decals.setCapacity(q === 'low' ? 0.45 : q === 'medium' ? 0.75 : 1);
    this.chunks.setQuality(q);
    this.chunks.enabled = gore !== 'off';
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

  /**
   * A round or blade hit a zombie (or a player). `power` (GORE.power, 0..1.5) is how heavy the
   * round was: big ones blow a jet of blood, a red mist and pieces of meat and bone out the back.
   */
  blood(pos: THREE.Vector3, dir: THREE.Vector3, damage: number, opts: { exit: { pos: THREE.Vector3; normal: THREE.Vector3 } | null; killed: boolean; head: boolean; melee: boolean; power?: number }): void {
    const k = this.scale(pos);
    if (this.gore === 'off') {
      this.emitSoft({ x: pos.x, y: pos.y, z: pos.z, vx: -dir.x * 0.4, vy: 0.2, vz: -dir.z * 0.4, life: 0.4, size: 0.08, size1: 0.3, r: 0.22, g: 0.2, b: 0.18, alpha: 0.35, drag: 3 });
      return;
    }
    const full = this.gore === 'full';
    const gore = full ? 1 : 0.4;
    const pw = opts.power ?? (opts.melee ? Math.min(1, damage / 60) : 0.4);
    // Mist where it went in, kicked slightly back toward the shooter.
    for (let i = 0; i < (full ? 2 + (pw > 0.7 ? 1 : 0) : 1); i++) {
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z,
        vx: -dir.x * rand(0.2, 0.8) + rand(-0.2, 0.2), vy: rand(0, 0.4), vz: -dir.z * rand(0.2, 0.8) + rand(-0.2, 0.2),
        life: rand(0.3, 0.5), size: 0.1, size1: rand(0.35, 0.55) * (opts.head ? 1.4 : 1) * (1 + pw * 0.5),
        r: BLOOD[0] * 1.3, g: BLOOD[1], b: BLOOD[2], alpha: 0.55, drag: 4,
      });
    }
    // Droplets out the far side.
    const floor = this.floorBelow(pos);
    const count = this.n((6 + Math.min(20, damage / 4)) * (1 + pw * 0.8) * (opts.head && opts.killed ? 2.2 : 1) * gore, k);
    for (let i = 0; i < count; i++) {
      const s = rand(1.5, 4.5) * (opts.melee ? 0.7 : 1) * (1 + pw * 0.35);
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * s + rand(-1, 1), vy: dir.y * s + rand(-0.2, 1.4), vz: dir.z * s + rand(-1, 1),
        life: rand(0.6, 1.2), size: rand(0.018, 0.04),
        r: BLOOD[0], g: BLOOD[1], b: BLOOD[2], alpha: 0.95, gravity: 1, drag: 0.4, stretch: 0.02, shape: SHAPE.hard,
        floor, onLand: 1,
      });
    }
    // Spatter flung back toward the shooter.
    this.droplets(pos, this.tmp2.copy(dir).negate().setY(0.25), this.n((3 + pw * 5) * gore, k), [0.8, 2.2], 0.5, floor);
    // Blown out the back: a jet of blood and a red mist hanging behind the body.
    const out = this.tmp3.copy(pos).addScaledVector(dir, opts.melee ? 0.05 : 0.22);
    if (!opts.melee && pw >= 0.3) {
      this.droplets(out, dir, this.n((8 + 24 * pw) * gore, k), [2.5 + 2 * pw, 5 + 4 * pw], 0.2, floor, [0.014, 0.04]);
      this.emitSoft({
        x: out.x, y: out.y, z: out.z, vx: dir.x * (0.8 + pw), vy: dir.y * (0.8 + pw) + 0.1, vz: dir.z * (0.8 + pw),
        life: rand(0.5, 0.8), size: 0.14, size1: (0.45 + pw * 0.5) * (full ? 1 : 0.7), r: BLOOD[0] * 1.35, g: BLOOD[1], b: BLOOD[2], alpha: 0.5, drag: 3.2,
      });
    }
    // Pieces of it: torn meat out the back (heavy rounds take bone with them, blades less of either).
    const meat = (opts.melee ? 0.45 : 0.3 + pw * 1.5) * (opts.killed ? 1.6 : 1) * (opts.head ? 1.25 : 1) * (full ? 1 : 0.4);
    const sp = opts.melee ? [1.2, 3] as [number, number] : [1.8 + pw * 2, 3.8 + pw * 4] as [number, number];
    this.chunks.burst(out, dir, this.n(meat, k), 'meat', sp, 0.45, 0.9, [0.035, 0.06 + pw * 0.04]);
    if (pw >= 0.8) this.chunks.burst(out, dir, this.n(pw * 0.9 * (full ? 1 : 0.4), k), 'bone', [sp[0] + 1, sp[1] + 2], 0.5, 1, [0.024, 0.05]);
    if (opts.head && opts.killed && full) {
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
    if (opts.exit && (full || opts.killed) && !this.isMoving?.(opts.exit.pos, opts.exit.normal)) {
      const size = (0.45 + Math.min(0.6, damage / 90)) * (opts.head && opts.killed ? 1.4 : 1) * (full ? 1 : 0.6) * (1 + Math.min(0.6, pw * 0.4));
      this.decals.add(DECAL.splat, opts.exit.pos, opts.exit.normal, size, BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.92, 60, 0, dir);
      // A heavy round paints a second, longer run of it.
      if (pw >= 0.8 && full) {
        const at = this.tmp2.copy(opts.exit.pos).addScaledVector(dir, 0.25).addScaledVector(opts.exit.normal, 0.02);
        this.decals.add(DECAL.splat, at, opts.exit.normal, size * rand(0.6, 0.85), BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.85, 60, 0, dir);
      }
    }
    // A kill lets a gout of it fall straight onto the ground underneath.
    if (opts.killed && floor > pos.y - 3) {
      this.tmp2.set(pos.x + dir.x * 0.3, floor, pos.z + dir.z * 0.3);
      this.decals.add(DECAL.splat, this.tmp2, this.up, (0.3 + pw * 0.25) * (full ? 1 : 0.6), BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.9, 70, 0.4, dir);
    }
  }

  /**
   * A head blown apart (a heavy round or a shotgun close up): a burst of red mist, blood thrown
   * everywhere along the shot, pieces of skull with scalp on them, brain and meat flying, and
   * splatter painted on whatever is behind.
   */
  headPop(pos: THREE.Vector3, dir: THREE.Vector3): void {
    if (this.gore === 'off') {
      this.emitSoft({ x: pos.x, y: pos.y, z: pos.z, vx: dir.x * 0.6, vy: 0.3, vz: dir.z * 0.6, life: 0.6, size: 0.12, size1: 0.5, r: 0.22, g: 0.2, b: 0.18, alpha: 0.35, drag: 3 });
      return;
    }
    const full = this.gore === 'full' ? 1 : 0.45;
    const k = this.scale(pos) * full;
    const floor = this.floorBelow(pos, 5);
    for (let i = 0; i < (full === 1 ? 4 : 2); i++) {
      this.emitSoft({
        x: pos.x + rand(-0.06, 0.06), y: pos.y + rand(-0.04, 0.08), z: pos.z + rand(-0.06, 0.06),
        vx: dir.x * rand(0.5, 2.2) + rand(-0.4, 0.4), vy: rand(0.05, 0.6), vz: dir.z * rand(0.5, 2.2) + rand(-0.4, 0.4),
        life: rand(0.6, 1.1), size: 0.16, size1: rand(0.65, 1.1), r: BLOOD[0] * 1.35, g: BLOOD[1], b: BLOOD[2], alpha: 0.62, drag: 3,
      });
    }
    this.droplets(pos, dir, this.n(46, k), [2.5, 8], 0.45, floor, [0.016, 0.05]);
    this.droplets(pos, this.up, this.n(18, k), [1.5, 4], 0.9, floor);
    this.chunks.burst(pos, dir, this.n(9, k), 'meat', [2, 7], 0.55, 1.2, [0.035, 0.075]);
    this.chunks.burst(pos, dir, this.n(6, k), 'skull', [2.5, 7.5], 0.6, 1.4, [0.045, 0.085]);
    this.chunks.burst(pos, dir, this.n(4, k), 'brain', [1.5, 5], 0.5, 1, [0.03, 0.06]);
    this.chunks.burst(pos, dir, this.n(3, k), 'bone', [3, 8], 0.6, 1.2, [0.02, 0.04]);
    // Painted along the shot onto whatever is behind, and around.
    const ray = this.tmp2, at = this.tmp3;
    for (let i = 0; i < 5; i++) {
      ray.set(dir.x + rand(-0.45, 0.45), dir.y + rand(-0.45, 0.2), dir.z + rand(-0.45, 0.45)).normalize();
      const hit = this.physics.raycastHit(pos.x, pos.y, pos.z, ray.x, ray.y, ray.z, 6);
      if (!hit) continue;
      at.copy(pos).addScaledVector(ray, hit.distance);
      const n = new THREE.Vector3(hit.nx, hit.ny, hit.nz);
      if (!this.isMoving?.(at, n)) this.decals.add(DECAL.splat, at, n, rand(0.5, 1.1) * (full === 1 ? 1 : 0.6) * (1 - hit.distance / 12), BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.92, 80, 0, ray);
    }
  }

  /** A round into a body already lying dead: a spurt, a scrap of meat, a mark on the ground under it. */
  corpseHit(pos: THREE.Vector3, dir: THREE.Vector3, power: number): void {
    if (this.gore === 'off') {
      this.emitSoft({ x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0.3, vz: 0, life: 0.4, size: 0.08, size1: 0.3, r: 0.22, g: 0.2, b: 0.18, alpha: 0.35, drag: 3 });
      return;
    }
    const full = this.gore === 'full' ? 1 : 0.4;
    const k = this.scale(pos) * full;
    const floor = this.floorBelow(this.tmp2.set(pos.x, pos.y + 0.3, pos.z), 1.6);
    this.emitSoft({
      x: pos.x, y: pos.y, z: pos.z, vx: -dir.x * 0.4, vy: 0.35, vz: -dir.z * 0.4,
      life: rand(0.3, 0.5), size: 0.08, size1: rand(0.3, 0.45) * (1 + power * 0.4), r: BLOOD[0] * 1.3, g: BLOOD[1], b: BLOOD[2], alpha: 0.5, drag: 4,
    });
    const up = this.tmp3.set(-dir.x * 0.35, 1, -dir.z * 0.35).normalize();
    this.droplets(pos, up, this.n(8 + power * 10, k), [1, 2.6 + power], 0.55, floor);
    this.chunks.burst(pos, up, this.n(0.35 + power * 0.9, k), 'meat', [1, 2.5 + power], 0.6, 0.4, [0.03, 0.055]);
    this.tmp2.set(pos.x, floor, pos.z);
    this.decals.add(DECAL.splat, this.tmp2, this.up, (0.22 + power * 0.18) * (full === 1 ? 1 : 0.6), BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.88, 60, 0, dir);
  }

  /** Scraps of meat (3D pieces) thrown off something torn apart, for callers outside the effects. */
  meat(pos: THREE.Vector3, dir: THREE.Vector3, count: number, bone = 0): void {
    if (this.gore === 'off') return;
    const k = this.scale(pos) * (this.gore === 'full' ? 1 : 0.45);
    this.chunks.burst(pos, dir, this.n(count, k), 'meat', [1.5, 4.5], 0.6, 1, [0.035, 0.07]);
    if (bone > 0) this.chunks.burst(pos, dir, this.n(bone, k), 'bone', [2, 5], 0.6, 1, [0.022, 0.045]);
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
  private scraps(pos: THREE.Vector3, dir: THREE.Vector3, meat: number, bone: number, floor: number): void {
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
    this.scraps(pos, dir, this.n(melee ? 7 : 5, k), this.n(melee ? 2 : 4, k), floor);
    this.chunks.burst(pos, dir, this.n(melee ? 3 : 4, k), 'meat', [1.5, 4.5], 0.55, 1, [0.035, 0.07]);
    this.chunks.burst(pos, dir, this.n(melee ? 0.5 : 1.5, k), 'bone', [2, 5], 0.55, 1, [0.022, 0.045]);
    // Splashes: along the blow onto a wall, and down onto the floor.
    const ray = new THREE.Vector3(dir.x, dir.y * 0.3 - 0.25, dir.z).normalize();
    const hit = this.physics.raycastHit(pos.x, pos.y, pos.z, ray.x, ray.y, ray.z, 2.8);
    if (hit) {
      const at = new THREE.Vector3().copy(pos).addScaledVector(ray, hit.distance);
      const n = new THREE.Vector3(hit.nx, hit.ny, hit.nz);
      if (!this.isMoving?.(at, n)) this.decals.add(DECAL.splat, at, n, rand(0.5, 0.8) * (full === 1 ? 1 : 0.6), BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.92, 70, 0, dir);
    }
  }

  /**
   * A bloater bursting: a sallow cloud of gas, meat, bone and blood thrown every way, and
   * splatter painted on the walls and ground all around.
   */
  bloaterBurst(pos: THREE.Vector3): void {
    // The gas is there whatever the gore setting.
    for (let i = 0; i < 7; i++) {
      this.emitSoft({
        x: pos.x + rand(-0.2, 0.2), y: pos.y + rand(-0.2, 0.3), z: pos.z + rand(-0.2, 0.2),
        vx: rand(-1.6, 1.6), vy: rand(0.1, 1.1), vz: rand(-1.6, 1.6),
        life: rand(1.6, 2.8), size: 0.4, size1: rand(1.8, 2.8), r: 0.36, g: 0.38, b: 0.16, alpha: 0.42, drag: 1.8,
      });
    }
    if (this.gore === 'off') return;
    const full = this.gore === 'full' ? 1 : 0.45;
    const k = this.scale(pos) * full;
    const floor = this.floorBelow(pos);
    const dir = this.tmp;
    for (let i = 0; i < 4; i++) {
      this.emitSoft({
        x: pos.x, y: pos.y, z: pos.z, vx: rand(-1.4, 1.4), vy: rand(0, 1), vz: rand(-1.4, 1.4),
        life: rand(0.6, 1), size: 0.25, size1: rand(1, 1.6), r: BLOOD[0] * 1.35, g: BLOOD[1], b: BLOOD[2], alpha: 0.65, drag: 3,
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + rand(-0.2, 0.2);
      dir.set(Math.cos(a), rand(0.05, 0.45), Math.sin(a));
      this.droplets(pos, dir, this.n(9, k), [3, 7.5], 0.3, floor, [0.02, 0.05]);
      this.scraps(pos, dir.multiplyScalar(1.6), this.n(3, k), this.n(1, k), floor);
      this.chunks.burst(pos, dir.normalize(), this.n(1.6, k), 'meat', [3, 8], 0.35, 1.4, [0.04, 0.09]);
      if (i % 3 === 0) this.chunks.burst(pos, dir, this.n(1, k), i % 2 ? 'fat' : 'bone', [3, 7], 0.35, 1.2, [0.03, 0.06]);
    }
    // Splatter on whatever is around, and a spray on the ground.
    const at = new THREE.Vector3(), n = new THREE.Vector3(), ray = new THREE.Vector3();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + rand(-0.15, 0.15);
      ray.set(Math.cos(a), rand(-0.5, 0.15), Math.sin(a)).normalize();
      const hit = this.physics.raycastHit(pos.x, pos.y, pos.z, ray.x, ray.y, ray.z, 5);
      if (!hit) continue;
      at.copy(pos).addScaledVector(ray, hit.distance);
      n.set(hit.nx, hit.ny, hit.nz);
      if (!this.isMoving?.(at, n)) this.decals.add(DECAL.splat, at, n, rand(0.6, 1.2) * (full === 1 ? 1 : 0.6), BLOOD_DECAL[0], BLOOD_DECAL[1], BLOOD_DECAL[2], 0.92, 80, 0, ray);
    }
    at.set(pos.x, floor, pos.z);
    this.decals.add(DECAL.pool, at, this.up, 1.8 * (full === 1 ? 1 : 0.6), BLOOD_DECAL[0] * 0.8, BLOOD_DECAL[1] * 1.2, BLOOD_DECAL[2], 0.9, 90, 3);
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
    this.scraps(pos, dir, this.n(2, k), 0, floor);
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
    this.scraps(pos, dir, this.n(14, k), this.n(7, k), floor);
    this.chunks.burst(pos, dir, this.n(5, k), 'meat', [1.2, 4], 0.8, 1, [0.035, 0.07]);
    this.chunks.burst(pos, dir, this.n(2, k), 'bone', [1.5, 4.5], 0.8, 1, [0.022, 0.045]);
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
  pool(pos: THREE.Vector3, size: number, life: number, grow = 5): void {
    if (this.gore === 'off') return;
    const s = size * (this.gore === 'full' ? 1 : 0.6);
    this.decals.add(DECAL.pool, pos, this.up, s, BLOOD_DECAL[0] * 0.9, BLOOD_DECAL[1], BLOOD_DECAL[2], 0.92, life, grow);
  }

  muzzle(pos: THREE.Vector3, dir: THREE.Vector3, weapon: WeaponId): void {
    const f = FLASH[weapon] ?? FLASH.machete!;
    if (!f.size) return;
    const dim = this.reducedFlashing ? 0.45 : 1;
    this.glow.emit({ x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0, life: 0.045, size: f.size * rand(0.8, 1.1), size1: f.size * 0.6, r: 5 * dim, g: 3 * dim, b: 1.3 * dim, alpha: 1, shape: SHAPE.flash });
    this.glow.emit({
      x: pos.x + dir.x * 0.08, y: pos.y + dir.y * 0.08, z: pos.z + dir.z * 0.08,
      vx: dir.x * 9, vy: dir.y * 9, vz: dir.z * 9,
      life: 0.04, size: f.size * 0.35, r: 4 * dim, g: 2.4 * dim, b: 1 * dim, alpha: 0.9, stretch: 0.03, shape: SHAPE.spark,
    });
    for (let i = 0; i < (weapon === 'shotgun' || weapon === 'marksman' || weapon === 'sniper' ? 3 : 1); i++) {
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
  splinters(pos: THREE.Vector3, normal: THREE.Vector3, opts: { floor?: number; amount?: number; spread?: number } = {}): void {
    const amount = opts.amount ?? 1, sp = opts.spread ?? 0.8;
    for (let i = 0; i < this.n(Math.round(18 * amount), this.scale(pos)); i++) {
      const s = rand(1.5, 4);
      this.emitSoft({
        x: pos.x + rand(-0.4, 0.4), y: pos.y + rand(-sp, sp), z: pos.z + rand(-0.4, 0.4),
        vx: normal.x * s + rand(-1, 1), vy: rand(0, 2), vz: normal.z * s + rand(-1, 1),
        life: rand(0.8, 1.4), size: rand(0.02, 0.05), r: 0.4, g: 0.27, b: 0.15, alpha: 1, gravity: 1, drag: 0.5, shape: SHAPE.hard, floor: opts.floor ?? pos.y - 1.1,
      });
    }
    for (let i = 0; i < Math.round(4 * amount); i++) {
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
    this.smoke.clear();
    this.chunks.clear();
    this.light.intensity = 0;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.camPos.copy(camera.position);
    this.soft.update(dt);
    this.glow.update(dt);
    this.decals.update(dt);
    this.casings.update(dt);
    this.smoke.update(dt, camera);
    this.chunks.update(dt);
    this.lightT -= dt;
    this.light.intensity = this.lightT > 0 ? this.lightPower * 9 * (this.lightT / 0.06) : 0;
  }

  dispose(): void {
    this.soft.dispose();
    this.glow.dispose();
    this.decals.dispose();
    this.casings.dispose();
    this.smoke.dispose();
    this.chunks.dispose();
    this.light.removeFromParent();
    this.light.dispose();
    this.root.removeFromParent();
  }
}
