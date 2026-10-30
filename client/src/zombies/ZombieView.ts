import * as THREE from 'three';
import { SPAWNING, type ArmZone, type HitZone, type LimbCut, type Simulation, type Zombie, type ZombieKind } from '@dead-hours/shared';
import { Humanoid, ZOMBIE_LOOKS, zombieLook, type ZombieGait } from '../characters/Humanoid';
import { Ragdoll, ZONE_PARTICLES } from '../characters/Ragdoll';
import type { Physics } from '../core/Physics';
import type { Effects } from '../effects/Effects';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';

interface View {
  id: number;
  look: number;
  gait: ZombieGait;
  body: Humanoid;
  probe: DynamicProbe;
  facing: number;
  ragdoll: Ragdoll | null;
  /** Seconds since death (corpses), -1 while alive. */
  deadT: number;
  /** Height the body died at (corpses sink from here). */
  baseY: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  pooledBlood: boolean;
  /** Stumps still bleeding. */
  bleeds: Bleed[];
}

/** A fresh stump: pumping blood for a few seconds, then dripping, slowing to nothing. */
interface Bleed {
  arm: ArmZone;
  /** Seconds since the arm came off. */
  t: number;
  /** Seconds to the next pulse or drop. */
  next: number;
  /** How hard it pumps (a shoulder opens more than an elbow). */
  strength: number;
}

/** Pumping, then dripping, then dry. */
const SPURT_TIME = 2.6;
const BLEED_TIME = 40;

const MAX_CORPSES = 14;

/** Crawlers aren't spawned yet; until they have their own body they walk like walkers. */
const gaitOf = (kind: ZombieKind): ZombieGait => (kind === 'runner' || kind === 'brute' ? kind : 'walker');

/** Voice pitch per kind: brutes rumble, runners shriek. */
const VOICE_PITCH: Record<ZombieGait, number> = { walker: 1, runner: 1.32, brute: 0.62 };

/**
 * Renders the simulation's zombies: pooled skinned bodies per look, positions interpolated
 * between simulation steps, animation channels from the AI state, hit flinches and wounds,
 * ragdolls on death, and corpses that stay for a while and then sink away.
 */
export class ZombieView {
  private readonly views = new Map<number, View>();
  private readonly corpses: View[] = [];
  /** Bodies are pooled per kind and look with their light probe: the probe is patched into the material once. */
  private readonly pool = new Map<string, { body: Humanoid; probe: DynamicProbe }[]>();
  private readonly root = new THREE.Group();
  private readonly tmp = new THREE.Vector3();
  gore = true;
  /** A body came to rest (blood pool under it). */
  onCorpseSettled: ((pos: THREE.Vector3) => void) | null = null;

  constructor(scene: THREE.Scene, private readonly physics: Physics, private readonly field: LightField, private readonly effects: Effects) {
    this.root.name = 'zombies';
    scene.add(this.root);
  }

  private poolOf(gait: ZombieGait, look: number) {
    const key = `${gait}:${look % ZOMBIE_LOOKS[gait]}`;
    let list = this.pool.get(key);
    if (!list) this.pool.set(key, (list = []));
    return list;
  }

  private acquire(gait: ZombieGait, look: number): { body: Humanoid; probe: DynamicProbe } {
    let entry = this.poolOf(gait, look).pop();
    if (!entry) {
      const body = new Humanoid(zombieLook(look, gait));
      const probe = new DynamicProbe(this.field, 0.3 + Math.random() * 0.1);
      probe.attach(body.surfaces());
      entry = { body, probe };
    }
    const h = entry.body;
    h.resetPose();
    h.clearWounds();
    // Some arrive already torn up.
    if (this.gore) {
      const r = (look * 2654435761) >>> 0;
      for (let b = 0; b < h.wounds.length; b++) if (((r >> b) & 3) === 0) h.wounds[b] = 0.15 + ((r >> (b + 3)) & 7) / 20;
    }
    h.mesh.castShadow = true;
    h.setVisible(true);
    this.root.add(h.root);
    return entry;
  }

  private release(v: View): void {
    v.body.root.removeFromParent();
    v.body.ragdoll = false;
    v.bleeds.length = 0;
    this.poolOf(v.gait, v.look).push({ body: v.body, probe: v.probe });
  }

  get count(): number {
    return this.views.size;
  }

  /** Bodies currently on screen or dying (tests, HUD debug). */
  get corpseCount(): number {
    return this.corpses.length;
  }

  hit(id: number, zone: HitZone, dir: THREE.Vector3, damage: number, melee: boolean): void {
    const v = this.views.get(id);
    if (!v) return;
    const amount = Math.min(1, damage / 60) * (melee ? 1.4 : 1);
    v.body.flinch(zone, dir.x, dir.z, amount);
    if (this.gore) v.body.wound(zone, 0.18 + amount * 0.45);
  }

  /**
   * An arm came off (just before any death the same blow causes): the stump shows at once and
   * starts pumping blood. Where it was and which way it faces, for the burst at the cut.
   */
  severed(id: number, arm: ArmZone, cut: LimbCut, pos: THREE.Vector3, dir: THREE.Vector3): boolean {
    const v = this.views.get(id);
    if (!v) return false;
    v.body.setArm(arm, cut);
    v.body.root.updateMatrixWorld(true);
    if (this.gore) v.body.wound(arm, 0.7);
    v.bleeds = v.bleeds.filter((b) => b.arm !== arm);
    v.bleeds.push({ arm, t: 0, next: 0.05, strength: cut === 'shoulder' ? 1 : 0.7 });
    return v.body.stump(arm, pos, dir);
  }

  /** Death: the body goes limp from its current pose, thrown by the killing hit. */
  died(id: number, zone: HitZone, dir: THREE.Vector3, force: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    if (this.gore) v.body.wound(zone, 0.5);
    const r = new Ragdoll(this.physics, v.body);
    const push = dir.clone().setY(Math.max(dir.y, 0) + 0.25).multiplyScalar(force * 2.6);
    const pushes = [{ joints: ZONE_PARTICLES[zone] ?? ZONE_PARTICLES.torso, impulse: push }];
    if (zone === 'legL' || zone === 'legR') pushes.push({ joints: ZONE_PARTICLES.torso, impulse: dir.clone().multiplyScalar(-force * 0.8) });
    // The ragdoll reads joints from the bones: a missing arm still has its (hidden) joints.
    v.body.withWholeArms(() => r.start(v.vel, pushes));
    v.ragdoll = r;
    v.deadT = 0;
    v.baseY = v.body.root.position.y;
    this.corpses.push(v);
    if (this.corpses.length > MAX_CORPSES) {
      // Oldest corpse starts sinking right away.
      const old = this.corpses.find((c) => c.deadT < SPAWNING.corpseTime);
      if (old) old.deadT = SPAWNING.corpseTime;
    }
  }

  removed(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    this.release(v);
  }

  /** Voice pitch of a zombie on screen (1 when unknown). */
  pitchOf(id: number): number {
    const v = this.views.get(id);
    return v ? VOICE_PITCH[v.gait] : 1;
  }

  /** Spatial anchor for zombie audio. */
  headOf(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.views.get(id);
    if (!v) return null;
    return v.body.head.getWorldPosition(out);
  }

  /**
   * `renderTime` is the simulation time being shown (one step behind the latest, plus the
   * render interpolation fraction).
   */
  update(dt: number, sim: Simulation, renderTime: number, camera: THREE.Camera): void {
    const seen = new Set<number>();
    const cam = camera.position;
    for (const z of sim.zombies) {
      if (!z.alive) continue;
      seen.add(z.id);
      let v = this.views.get(z.id);
      if (!v) {
        const gait = gaitOf(z.kind);
        const { body, probe } = this.acquire(gait, z.look);
        v = { id: z.id, look: z.look, gait, body, probe, facing: z.facing, ragdoll: null, deadT: -1, baseY: 0, pos: new THREE.Vector3(z.pos.x, z.pos.y, z.pos.z), vel: new THREE.Vector3(), pooledBlood: false, bleeds: [] };
        this.views.set(z.id, v);
      }
      this.animate(v, z, dt, renderTime, cam, camera);
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        this.views.delete(id);
        this.release(v);
      }
    }
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.deadT += dt;
      const r = c.ragdoll!;
      if (!r.asleep) r.update(dt);
      else if (!c.pooledBlood) {
        c.pooledBlood = true;
        this.onCorpseSettled?.(r.center(this.tmp).setY(r.floorY + 0.01));
      }
      c.probe.update(dt, c.body.root.position, camera, 0.4);
      // The dead keep bleeding out of a fresh stump.
      if (c.bleeds.length && c.deadT <= SPAWNING.corpseTime) this.bleed(c, dt, cam);
      // After a while the body sinks into the ground and is recycled.
      if (c.deadT > SPAWNING.corpseTime) {
        const t = c.deadT - SPAWNING.corpseTime;
        c.body.root.position.y = c.baseY - t * 0.35;
        c.body.mesh.castShadow = false;
        if (t > 2.2) {
          this.corpses.splice(i, 1);
          this.release(c);
        }
      }
    }
  }

  private animate(v: View, z: Zombie, dt: number, renderTime: number, cam: THREE.Vector3, camera: THREE.Camera): void {
    const b = v.body;
    // Interpolate between the zombie's last two updates (distant ones update less often).
    const span = Math.max(1e-4, z.lastDt);
    const u = THREE.MathUtils.clamp((renderTime - (z.updatedAt - span)) / span, 0, 1);
    const x = z.prev.x + (z.pos.x - z.prev.x) * u;
    const y = z.prev.y + (z.pos.y - z.prev.y) * u;
    const zz = z.prev.z + (z.pos.z - z.prev.z) * u;
    v.vel.set(z.vel.x, 0, z.vel.z);
    v.pos.set(x, y, zz);
    b.root.position.set(x, y, zz);
    b.root.scale.setScalar(z.scale);
    const diff = Math.atan2(Math.sin(z.facing - v.facing), Math.cos(z.facing - v.facing));
    v.facing += diff * (1 - Math.exp(-dt * 14));
    b.root.rotation.y = v.facing;

    const state = z.state;
    b.attack = state === 'attack' ? z.attackPhase : -1;
    b.bash = state === 'bash' ? z.attackPhase : -1;
    b.downTarget = state === 'down' ? 1 : 0;
    b.staggerTarget = state === 'stagger' ? 1 : 0;
    if (state === 'stagger' && z.lastHit) b.setStaggerDir(z.lastHit.dx, z.lastHit.dz);
    const sp = Math.hypot(z.vel.x, z.vel.z);
    const moveAngle = sp > 0.2 ? Math.atan2(Math.sin(Math.atan2(z.vel.x, z.vel.z) - v.facing), Math.cos(Math.atan2(z.vel.x, z.vel.z) - v.facing)) : 0;
    const dist = Math.hypot(cam.x - x, cam.z - zz);
    // Far away: cheaper (no shadow, animation at a lower rate is not noticeable).
    b.mesh.castShadow = dist < 45;
    // What is left of its arms (also for zombies first seen after losing one).
    b.setArm('armL', z.arms.armL);
    b.setArm('armR', z.arms.armR);
    b.goreShown = this.gore;
    b.update(dt, { speed: state === 'stagger' ? Math.min(sp, 1.2) : z.moveSpeed, crouch: 0, aim: 0, grounded: z.grounded, strafe: 0, moveAngle, turn: z.turnRate });
    v.probe.update(dt, this.tmp.set(x, y, zz), camera);
    if (v.bleeds.length) this.bleed(v, dt, cam);
  }

  /** Blood out of the stumps: pulses in time with what's left of a heartbeat, then drops. */
  private bleed(v: View, dt: number, cam: THREE.Vector3): void {
    for (let i = v.bleeds.length - 1; i >= 0; i--) {
      const s = v.bleeds[i];
      s.t += dt;
      s.next -= dt;
      if (s.t > BLEED_TIME || !this.gore) {
        v.bleeds.splice(i, 1);
        continue;
      }
      if (s.next > 0) continue;
      if (!v.body.stump(s.arm, _sp, _sd)) {
        v.bleeds.splice(i, 1);
        continue;
      }
      // Far off nobody sees single drops.
      const far = _sp.distanceTo(cam) > 40;
      if (s.t < SPURT_TIME) {
        const k = s.strength * (1 - s.t / SPURT_TIME) * (v.deadT >= 0 ? 0.6 : 1);
        s.next = 0.24 + Math.random() * 0.08 + s.t * 0.06;
        if (!far) this.effects.spurt(_sp, _sd.addScaledVector(_up, 0.15).normalize(), 0.25 + k * 0.75);
      } else {
        // Slowing: a drop every fraction of a second at first, every couple of seconds later.
        const u = (s.t - SPURT_TIME) / (BLEED_TIME - SPURT_TIME);
        s.next = 0.18 + u * 2.4 + Math.random() * 0.25;
        if (!far) this.effects.drip(_sp.addScaledVector(_sd, 0.02), v.deadT >= 0 ? undefined : v.vel);
      }
    }
  }

  clear(): void {
    for (const v of this.views.values()) this.release(v);
    this.views.clear();
    for (const c of this.corpses) this.release(c);
    this.corpses.length = 0;
  }

  dispose(): void {
    this.clear();
    for (const list of this.pool.values()) for (const e of list) e.body.dispose();
    this.root.removeFromParent();
  }
}

const _sp = new THREE.Vector3(), _sd = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
