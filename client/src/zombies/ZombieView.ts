import * as THREE from 'three';
import { SPAWNING, isLeg, type ArmCut, type GibPart, type HitZone, type LegCut, type LimbCut, type LimbZone, type Simulation, type Vec3, type Zombie, type ZombieKind } from '@dead-hours/shared';
import { Humanoid, kindLooks, zombieLookOf, type ZombieGait } from '../characters/Humanoid';
import { Gibs } from '../characters/Gibs';
import type { BurnPoint } from '../effects/Pyro';
import { Ragdoll, ZONE_PARTICLES } from '../characters/Ragdoll';
import type { Physics } from '../core/Physics';
import type { Effects } from '../effects/Effects';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';

interface View {
  id: number;
  look: number;
  kind: ZombieKind;
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
  /** On fire 0..1 (flames shown), and how charred 0..1. */
  burn: number;
  char: number;
  /** Corpses: seconds the body keeps burning. */
  burnLeft: number;
  /** Crawling: ground covered since the last smear of blood it dragged behind it. */
  trail: number;
}

/** How a zombie died, when it was more than a bullet. */
export interface DeathDetail {
  cause?: 'blast' | 'fire';
  gibs?: GibPart[];
  shred?: boolean;
  blast?: Vec3;
}

/** A fresh stump: pumping blood for a few seconds, then dripping, slowing to nothing. */
interface Bleed {
  arm: LimbZone;
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

/** Kinds the spawner sends (crawlers are walkers that lost their legs: walker bodies). */
const WARM_KINDS: readonly ZombieKind[] = ['walker', 'runner', 'brute', 'screamer', 'bloater'];

/** Voice pitch per kind: brutes rumble, runners shriek, screamers shriek higher, bloaters gurgle low. */
const VOICE_PITCH: Record<ZombieKind, number> = { walker: 1, runner: 1.32, brute: 0.62, crawler: 1, screamer: 1.5, bloater: 0.74 };
/**
 * Footfalls are heard this far (m), sharing STEP_RATE a second; within NEAR_STEPS they may
 * overdraw by NEAR_CREDIT, so a crowd at arm's length is heard without turning into noise.
 */
const STEP_RANGE = 45;
const NEAR_STEPS = 12;
const STEP_RATE = 24;
const NEAR_CREDIT = 6;

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
  /** A zombie's foot came down (gait, how hard 0..1). */
  onStep: ((pos: THREE.Vector3, gait: ZombieGait, loudness: number) => void) | null = null;
  /** Far footfalls left to play this moment (a horde would otherwise be hundreds a second). */
  private stepBudget = 8;
  private readonly ear = new THREE.Vector3();
  /** Heads and legs blown off. */
  readonly gibs: Gibs;

  constructor(scene: THREE.Scene, private readonly physics: Physics, private readonly field: LightField, private readonly effects: Effects) {
    this.root.name = 'zombies';
    scene.add(this.root);
    this.gibs = new Gibs(this.root, physics, effects);
  }

  private poolOf(kind: ZombieKind, look: number) {
    // Crawlers aren't spawned yet; until they have their own body they look like walkers.
    if (kind === 'crawler') kind = 'walker';
    const key = `${kind}:${look % kindLooks(kind)}`;
    let list = this.pool.get(key);
    if (!list) this.pool.set(key, (list = []));
    return list;
  }

  private build(kind: ZombieKind, look: number): { body: Humanoid; probe: DynamicProbe } {
    const body = new Humanoid(zombieLookOf(kind === 'crawler' ? 'walker' : kind, look));
    const probe = new DynamicProbe(this.field, 0.3 + Math.random() * 0.1);
    probe.attach(body.surfaces());
    return { body, probe };
  }

  /**
   * Builds one body of every zombie look ahead of time (while the screen is dark), and compiles
   * their shaders when given the renderer. Otherwise each look's first appearance costs a frame
   * 10-80 ms to build, and a horde brings dozens of looks in its first seconds.
   */
  warm(renderer?: THREE.WebGLRenderer, camera?: THREE.Camera, scene?: THREE.Scene): number {
    const t0 = performance.now();
    const built: { body: Humanoid; probe: DynamicProbe }[] = [];
    for (const kind of WARM_KINDS) {
      for (let look = 0; look < kindLooks(kind); look++) {
        const list = this.poolOf(kind, look);
        if (list.length) continue;
        const e = this.build(kind, look);
        list.push(e);
        built.push(e);
      }
    }
    if (renderer && camera && built.length) {
      // Bodies only take part in a compile while they are in the graph and visible. The scene is
      // drawn into a render target (post effects), whose shader variant differs from the screen's.
      for (const e of built) {
        e.body.setVisible(true);
        this.root.add(e.body.root);
      }
      const was = renderer.getRenderTarget();
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
      renderer.setRenderTarget(rt);
      renderer.compile(this.root, camera, scene);
      renderer.setRenderTarget(was);
      rt.dispose();
      for (const e of built) e.body.root.removeFromParent();
    }
    return performance.now() - t0;
  }

  private acquire(kind: ZombieKind, look: number): { body: Humanoid; probe: DynamicProbe } {
    const entry = this.poolOf(kind, look).pop() ?? this.build(kind, look);
    const h = entry.body;
    h.resetPose();
    h.clearWounds();
    h.material.color.setScalar(1);
    h.material.emissive.setScalar(0);
    // Some arrive already torn up.
    if (this.gore) {
      const r = (look * 2654435761) >>> 0;
      for (let b = 0; b < h.wounds.length; b++) if (((r >> b) & 3) === 0) h.wounds[b] = 0.08 + ((r >> (b + 3)) & 7) / 40;
      // Bites and gashes from before it turned, different on every body.
      h.oldWounds(Math.random() * 1e6, 1 + Math.floor(Math.random() * 3));
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
    v.body.root.scale.setScalar(1);
    this.poolOf(v.kind, v.look).push({ body: v.body, probe: v.probe });
  }

  /**
   * Lines one pooled body of each kind up at `at` (the loading screen's warm-up: their shaders
   * finish compiling and draw once, shadows included, before the night is shown). `warm` has
   * built them; the returned function puts them back in the pool.
   */
  lineUp(at: THREE.Vector3): () => void {
    const out: { kind: ZombieKind; entry: { body: Humanoid; probe: DynamicProbe } }[] = [];
    WARM_KINDS.forEach((kind, i) => {
      const entry = this.acquire(kind, 0);
      entry.body.root.position.set(at.x + (i - 2) * 0.8, at.y, at.z);
      entry.body.root.updateMatrixWorld(true);
      out.push({ kind, entry });
    });
    return () => {
      for (const { kind, entry } of out) {
        entry.body.root.removeFromParent();
        entry.body.root.position.set(0, 0, 0);
        this.poolOf(kind, 0).push(entry);
      }
      out.length = 0;
    };
  }

  get count(): number {
    return this.views.size;
  }

  /** Bodies currently on screen or dying (tests, HUD debug). */
  get corpseCount(): number {
    return this.corpses.length;
  }

  /**
   * A hit: the body flinches, a wound opens where it landed (and where a bullet came out) and
   * its blood soaks into the clothes around it; every hit leaves the limb bloodier overall.
   */
  hit(id: number, zone: HitZone, dir: THREE.Vector3, damage: number, melee: boolean, pos?: THREE.Vector3, exit?: THREE.Vector3 | null): void {
    const v = this.views.get(id);
    if (!v) return;
    const amount = Math.min(1, damage / 60) * (melee ? 1.4 : 1);
    v.body.flinch(zone, dir.x, dir.z, amount);
    if (!this.gore) return;
    v.body.wound(zone, 0.1 + amount * 0.25);
    if (pos) v.body.woundAt(pos, zone, Math.min(1.2, 0.35 + amount * 0.7));
    // Exit wounds are the bigger mess.
    if (exit) v.body.woundAt(exit, zone, Math.min(1.5, 0.7 + amount * 0.8));
  }

  /**
   * An arm came off (just before any death the same blow causes): the stump shows at once and
   * starts pumping blood. Where it was and which way it faces, for the burst at the cut.
   */
  severed(id: number, arm: LimbZone, cut: LimbCut, pos: THREE.Vector3, dir: THREE.Vector3): boolean {
    const v = this.views.get(id) ?? this.corpses.find((c) => c.id === id && c.deadT >= 0 && c.deadT < 0.2);
    if (!v) return false;
    if (isLeg(arm)) v.body.setLeg(arm, cut as LegCut);
    else v.body.setArm(arm, cut as ArmCut);
    v.body.root.updateMatrixWorld(true);
    if (this.gore) v.body.wound(arm, 0.7);
    v.bleeds = v.bleeds.filter((b) => b.arm !== arm);
    // A thigh pumps hardest of all (the big artery runs down it).
    v.bleeds.push({ arm, t: 0, next: 0.05, strength: cut === 'hip' ? 1.25 : cut === 'shoulder' || cut === 'knee' ? 1 : 0.7 });
    return v.body.stump(arm, pos, dir);
  }

  /** Death: the body goes limp from its current pose, thrown by the killing hit. */
  died(id: number, zone: HitZone, dir: THREE.Vector3, force: number, detail: DeathDetail = {}): void {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    if (this.gore) v.body.wound(zone, 0.5);
    const r = new Ragdoll(this.physics, v.body);
    // A blast throws a body a few metres (up and away), not across the street.
    const push = detail.cause === 'blast'
      ? dir.clone().setY(Math.max(dir.y, 0) + 0.45).normalize().multiplyScalar(force * 1.35)
      : dir.clone().setY(Math.max(dir.y, 0) + 0.25).multiplyScalar(force * 2.6);
    const pushes = [{ joints: ZONE_PARTICLES[zone] ?? ZONE_PARTICLES.torso, impulse: push }];
    if (detail.cause === 'blast') {
      // Thrown bodily, the parts nearest the blast hardest.
      for (const j of Object.values(ZONE_PARTICLES)) pushes.push({ joints: j, impulse: push.clone().multiplyScalar(0.6) });
    } else if (zone === 'legL' || zone === 'legR') pushes.push({ joints: ZONE_PARTICLES.torso, impulse: dir.clone().multiplyScalar(-force * 0.8) });
    // The ragdoll reads joints from the bones: a missing arm still has its (hidden) joints.
    v.body.withWholeArms(() => r.start(v.vel, pushes));
    v.ragdoll = r;
    if (detail.cause === 'fire') {
      v.burn = 1;
      v.char = Math.max(v.char, 0.85);
      v.burnLeft = 3.5 + Math.random() * 2.5;
    } else if (detail.cause === 'blast') {
      // Blackened by it, and torn apart.
      v.char = Math.max(v.char, detail.shred ? 0.55 : 0.3);
      if (this.gore) for (const z of ['torso', 'legL', 'legR', 'head'] as const) v.body.wound(z, detail.shred ? 1 : 0.6);
      this.tear(v, detail);
    }
    v.deadT = 0;
    v.baseY = v.body.root.position.y;
    this.corpses.push(v);
    if (this.corpses.length > MAX_CORPSES) {
      // Oldest corpse starts sinking right away.
      const old = this.corpses.find((c) => c.deadT < SPAWNING.corpseTime);
      if (old) old.deadT = SPAWNING.corpseTime;
    }
  }

  /**
   * A bloater burst: its body (already a ragdoll from the killing blow) is gone, blown apart.
   * Returns where its middle was, for the gore.
   */
  burst(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const i = this.corpses.findIndex((c) => c.id === id && c.deadT >= 0 && c.deadT < 1);
    const v = i >= 0 ? this.corpses[i] : this.views.get(id);
    if (!v) return null;
    if (v.ragdoll) v.ragdoll.center(out);
    else out.set(v.pos.x, v.pos.y + 1, v.pos.z);
    if (i >= 0) this.corpses.splice(i, 1);
    else this.views.delete(id);
    v.ragdoll = null;
    this.release(v);
    return out;
  }

  /** Heads and legs come off and fly; blood bursts from where they were. */
  private tear(v: View, detail: DeathDetail): void {
    const b = v.body;
    b.root.updateMatrixWorld(true);
    for (const g of detail.gibs ?? []) {
      const bone = g.part === 'head' ? b.head : g.part === 'legL' ? b.legL.upper : b.legR.upper;
      bone.getWorldPosition(_sp);
      bone.getWorldQuaternion(_q);
      _sd.set(g.dir.x, g.dir.y, g.dir.z).multiplyScalar(g.speed).add(v.vel);
      if (this.gore) this.gibs.spawn(v.kind, v.look, g.part, b.root.scale.x, _sp, _q, _sd);
      b.tearOff(g.part);
      _sd.set(g.dir.x, g.dir.y, g.dir.z);
      this.effects.sever(_sp, _sd, false);
      if (this.gore) {
        this.effects.gibs(_sp, _sd);
        v.bleeds.push({ arm: g.part as unknown as LimbZone, t: 0, next: 0.05, strength: g.part === 'head' ? 1.2 : 1 });
      }
    }
    if (detail.shred && this.gore) {
      // Caught at the heart of it: the body bursts.
      b.spine.getWorldPosition(_sp);
      const away = detail.blast ? _sd.set(_sp.x - detail.blast.x, 0.6, _sp.z - detail.blast.z).normalize() : _sd.set(0, 1, 0);
      for (let i = 0; i < 3; i++) this.effects.gibs(_sp, away);
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
    return v ? VOICE_PITCH[v.kind] : 1;
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
    this.ear.copy(cam);
    this.stepBudget = Math.min(8, this.stepBudget + dt * STEP_RATE);
    for (const z of sim.zombies) {
      if (!z.alive) continue;
      seen.add(z.id);
      let v = this.views.get(z.id);
      if (!v) {
        const { body, probe } = this.acquire(z.kind, z.look);
        const view: View = v = { id: z.id, look: z.look, kind: z.kind, body, probe, facing: z.facing, ragdoll: null, deadT: -1, baseY: 0, pos: new THREE.Vector3(z.pos.x, z.pos.y, z.pos.z), vel: new THREE.Vector3(), pooledBlood: false, bleeds: [], burn: 0, char: 0, burnLeft: 0, trail: 0 };
        body.onFootstep = (l) => this.stepped(view, l);
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
    this.gibs.setGore(this.gore);
    this.gibs.update(dt);
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.deadT += dt;
      if (c.burn > 0) {
        c.burnLeft -= dt;
        if (c.burnLeft <= 0) c.burn = Math.max(0, c.burn - dt * 0.6);
        this.shadeBurn(c, dt);
      }
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
    if (z.kind === 'bloater') {
      // Gas swelling and settling inside it.
      const swell = 1 + Math.sin(renderTime * 2.1 + v.id) * 0.025 + Math.sin(renderTime * 5.3 + v.id * 2) * 0.01;
      b.root.scale.x *= swell;
      b.root.scale.z *= swell;
    }
    const diff = Math.atan2(Math.sin(z.facing - v.facing), Math.cos(z.facing - v.facing));
    v.facing += diff * (1 - Math.exp(-dt * 14));
    b.root.rotation.y = v.facing;

    const state = z.state;
    b.attack = state === 'attack' ? z.attackPhase : -1;
    // Breaking in through a window pounds like a door; climbing through, it hauls itself over hunched with arms out.
    b.bash = state === 'bash' || state === 'breach' ? z.attackPhase : state === 'vault' ? 0.5 : -1;
    b.scream = state === 'scream' ? z.attackPhase : -1;
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
    b.setLeg('legL', z.legs.legL);
    b.setLeg('legR', z.legs.legR);
    b.crawlTarget = z.crawling ? 1 : 0;
    // Dragging itself along on fresh stumps leaves a smeared trail of blood.
    if (z.crawling && this.gore) {
      v.trail += Math.hypot(z.vel.x, z.vel.z) * dt;
      if (v.trail > 0.42 && v.bleeds.some((s) => (s.arm === 'legL' || s.arm === 'legR') && s.t < BLEED_TIME * 0.75)) {
        v.trail = 0;
        if (dist < 40) this.effects.splat(this.tmp.set(x - Math.sin(v.facing) * 0.5, y + 0.05, zz - Math.cos(v.facing) * 0.5), 0.2 + Math.random() * 0.14);
      }
    }
    b.goreShown = this.gore;
    b.update(dt, { speed: state === 'stagger' ? Math.min(sp, 1.2) : z.moveSpeed, crouch: state === 'vault' && !z.crawling ? 0.6 : 0, aim: 0, grounded: z.grounded, strafe: 0, moveAngle, turn: z.turnRate });
    v.probe.update(dt, this.tmp.set(x, y, zz), camera);
    if (v.bleeds.length) this.bleed(v, dt, cam);
    // On fire: flames all over, the skin charring black.
    if (z.burning) v.burn = Math.min(1, v.burn + dt * 3);
    else v.burn = Math.max(0, v.burn - dt * 1.5);
    if (v.burn > 0) v.char = Math.min(1, v.char + dt * 0.18 * v.burn);
    if (v.burn > 0 || v.char > 0) this.shadeBurn(v, dt);
  }

  /** Charred colour and the glow of embers in the skin while it burns. */
  private shadeBurn(v: View, dt: number): void {
    void dt;
    const m = v.body.material;
    m.color.setScalar(1 - 0.84 * v.char);
    const flick = 0.75 + 0.25 * Math.sin(performance.now() * 0.013 + v.id);
    m.emissive.setRGB(0.55 * v.burn * flick * v.char, 0.12 * v.burn * flick * v.char, 0.02 * v.burn * v.char);
  }

  /** Where flames are on burning bodies this frame (living and dead). */
  flamePoints(out: BurnPoint[], camera: THREE.Camera): BurnPoint[] {
    out.length = 0;
    const cam = camera.position;
    const add = (v: View) => {
      if (v.burn <= 0.02 || !v.body.root.visible) return;
      const b = v.body;
      const s = b.root.scale.x;
      const d = b.root.position.distanceTo(cam);
      const bones = d > 45 ? [b.spine] : d > 22 ? [b.spine, b.head, b.legL.lower] : [b.spine, b.head, b.armL.lower, b.armR.lower, b.hips];
      for (let i = 0; i < bones.length; i++) {
        const bone = bones[i];
        if (bone.scale.x < 0.01) continue;
        bone.getWorldPosition(_sp);
        const torso = bone === b.spine || bone === b.hips;
        out.push({ x: _sp.x, y: _sp.y + (torso ? 0.15 : 0), z: _sp.z, size: s * (torso ? 1 : bone === b.head ? 0.75 : 0.6) * (d > 45 ? 1.6 : 1), strength: v.burn, seed: (v.id * 7 + i) * 0.137 % 1 });
      }
    };
    for (const v of this.views.values()) add(v);
    for (const c of this.corpses) if (c.deadT < SPAWNING.corpseTime) add(c);
    return out;
  }

  private stepped(v: View, loudness: number): void {
    if (!this.onStep || v.ragdoll) return;
    const d = v.pos.distanceTo(this.ear);
    if (d > STEP_RANGE) return;
    if (this.stepBudget < (d > NEAR_STEPS ? 1 : 1 - NEAR_CREDIT)) return;
    this.stepBudget -= 1;
    this.onStep(v.pos, v.body.gait, loudness);
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
      // Blown off by a blast (torn end) or shot off (a stump at the hip or knee).
      const part = s.arm as string;
      const torn = part === 'head' || ((part === 'legL' || part === 'legR') && v.body.isTorn(part));
      if (!(torn ? v.body.tornEnd(s.arm as unknown as 'head', _sp, _sd) : v.body.stump(s.arm, _sp, _sd))) {
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
    this.gibs.clear();
    for (const v of this.views.values()) this.release(v);
    this.views.clear();
    for (const c of this.corpses) this.release(c);
    this.corpses.length = 0;
  }

  dispose(): void {
    this.clear();
    this.gibs.dispose();
    for (const list of this.pool.values()) for (const e of list) e.body.dispose();
    this.root.removeFromParent();
  }
}

const _sp = new THREE.Vector3(), _sd = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _q = new THREE.Quaternion();
