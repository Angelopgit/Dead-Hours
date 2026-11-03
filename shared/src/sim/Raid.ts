import { RAPIER, BODY_FILTER, GROUP, climbing, groups, stalled, touchedLedge } from '../physics/Physics';
import type { DoorBody } from '../physics/DoorBody';
import { WEAPONS, type HitZone, type WeaponId } from '../config/weapons';
import { RAID, RAID_ROUTES, raiderAppearance, routeAt, sampleRoute, type RouteSamples } from '../config/raid';
import { encodeAppearance } from '../config/appearance';
import { Arsenal, type ArsenalTick } from './Arsenal';
import { NAV_INDOOR } from './NavGrid';
import { ZOMBIE_STEP } from './Zombie';
import { rayCapsule, rayZones, zombieZones, type ZoneShape } from './hitzones';
import { angleDiff, clamp, dist2D, rng, v3, type Vec3 } from './math';
import type { PelletTrace } from './events';
import type { PlayerMotion, SimPlayer, Simulation } from './Simulation';

/** Raiders bump into survivors and the world; zombies and raiders pass through each other. */
const RAIDER_GROUPS = groups(GROUP.zombie, BODY_FILTER | GROUP.player);

export type RaidStage = 'waiting' | 'inbound' | 'arrived' | 'over';
export type RaiderState = 'deploy' | 'hunt' | 'engage' | 'breach' | 'dead';

/** Random direction inside a cone around `d` (unit) with half-angle `deg`. */
function cone(d: Vec3, deg: number, rand: () => number): Vec3 {
  const a = ((deg * Math.PI) / 180) * Math.sqrt(rand());
  const phi = rand() * Math.PI * 2;
  const ux = Math.abs(d.y) < 0.95 ? 0 : 1, uy = Math.abs(d.y) < 0.95 ? 1 : 0;
  let bx = uy * d.z, by = -ux * d.z, bz = ux * d.y - uy * d.x;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;
  const cx = d.y * bz - d.z * by, cy = d.z * bx - d.x * bz, cz = d.x * by - d.y * bx;
  const s = Math.sin(a), c = Math.cos(a);
  const x = d.x * c + (bx * Math.cos(phi) + cx * Math.sin(phi)) * s;
  const y = d.y * c + (by * Math.cos(phi) + cy * Math.sin(phi)) * s;
  const z = d.z * c + (bz * Math.cos(phi) + cz * Math.sin(phi)) * s;
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

/** The white van: where it is on its route and how fast it is going. */
export interface RaidVan {
  route: number;
  pos: Vec3;
  /** Heading (atan2(dx, dz): 0 faces +Z). */
  yaw: number;
  speed: number;
  /** Metres along the route. */
  s: number;
  /** Side door open (the crew is getting out). */
  door: boolean;
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
}

/**
 * One hostile survivor: a gun (a real Arsenal, so magazines and reloads run like a player's),
 * a body that walks the nav grid like a zombie's, and a small hunter's mind. The fields a
 * renderer needs (motion, arsenal, appearance) have the same shape as a SimPlayer's.
 */
export class Raider {
  readonly id: string;
  readonly name = 'RAIDER';
  readonly arsenal: Arsenal;
  readonly appearance: string;
  readonly rand: () => number;
  health: number = RAID.health;
  alive = true;
  state: RaiderState = 'deploy';
  readonly motion: PlayerMotion;
  /** Body facing (atan2(dx, dz)). */
  facing: number;
  readonly prev: Vec3;
  readonly body: RAPIER.RigidBody | null;
  readonly collider: RAPIER.Collider | null;
  /** Simulation time of the last update and the step it covered (render interpolation). */
  updatedAt = 0;
  lastDt = 1 / 60;
  pending = 0;
  diedAt = 0;
  /** Most recent hit (flinch). */
  lastHit: { zone: HitZone; dx: number; dz: number; at: number } | null = null;

  target: string | null = null;
  lastKnown: Vec3 | null = null;
  lastSeen = -99;
  /** Seen continuously since (first shot waits for the reaction time). */
  private seenSince = -1;
  private nextSense = 0;
  private goal: Vec3 | null = null;
  private path: Vec3[] = [];
  private pathDoors: number[] = [];
  private pathI = 0;
  private repathAt = 0;
  private burstLeft = 0;
  private fireAt = 0;
  private strafe = 0;
  private strafeUntil = 0;
  private kickAt = 0;
  private stuckT = 0;
  private readonly progressRef: Vec3;
  private progressT = 0;
  private detour = { x: 0, z: 0, until: 0 };
  /** Shooting through a window: holds there until (then goes in after them). */
  private holdUntil = 0;
  moveSpeed = 0;

  constructor(readonly num: number, weapon: WeaponId, at: Vec3, facing: number, readonly seed: number, private readonly raid: Raid, private readonly sim: Simulation, solid = true) {
    this.id = `raider:${num}`;
    this.rand = rng(seed);
    this.appearance = encodeAppearance(raiderAppearance(rng(seed ^ 0x5bd1e995)));
    const pistol = WEAPONS[weapon].slot === 'secondary';
    this.arsenal = new Arsenal(pistol ? 'smg' : weapon, 'pistol');
    if (pistol) {
      this.arsenal.active = 'secondary';
      this.arsenal.actionT = this.arsenal.actionTotal = WEAPONS.pistol.draw;
    }
    // They brought plenty.
    this.arsenal.primary.reserve = this.arsenal.secondary.reserve = 999;
    this.facing = facing;
    this.motion = {
      pos: { ...at }, vel: v3(), yaw: facing + Math.PI, pitch: 0, eyeHeight: RAID.eyeHeight,
      crouching: false, sprinting: false, aiming: false, grounded: true,
    };
    this.prev = { ...at };
    this.progressRef = { ...at };
    this.nextSense = sim.time + this.rand() * 0.25;
    if (solid) {
      const w = sim.physics.world;
      const half = (RAID.height - RAID.radius * 2) / 2;
      this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y + RAID.height / 2 + 0.02, at.z));
      this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(half, RAID.radius).setCollisionGroups(RAIDER_GROUPS), this.body);
    } else {
      this.body = null;
      this.collider = null;
    }
  }

  get weapon(): WeaponId {
    return this.arsenal.weapon.id;
  }

  get pos(): Vec3 {
    return this.motion.pos;
  }

  get eye(): Vec3 {
    const p = this.motion.pos;
    return { x: p.x, y: p.y + this.motion.eyeHeight, z: p.z };
  }

  get chest(): Vec3 {
    const p = this.motion.pos;
    return { x: p.x, y: p.y + 1.25, z: p.z };
  }

  zones(out: ZoneShape[]): ZoneShape[] {
    return zombieZones(this.motion.pos, this.facing, RAID.height / 1.75, 'standing', out);
  }

  /** Sent to fan out from the van to a spot nearby before the hunt starts. */
  deployTo(at: Vec3): void {
    this.state = 'deploy';
    this.goal = at;
    this.repathAt = 0;
  }

  /** Hit by a survivor: turns on whoever shot them. */
  onHit(by: SimPlayer, zone: HitZone, dir: Vec3): void {
    const hl = Math.hypot(dir.x, dir.z) || 1;
    this.lastHit = { zone, dx: dir.x / hl, dz: dir.z / hl, at: this.sim.time };
    if (this.target !== by.id || this.sim.time - this.lastSeen > 1.5) {
      this.target = by.id;
      this.lastKnown = { ...by.motion.pos };
      this.repathAt = 0;
    }
    if (this.state === 'deploy') this.state = 'hunt';
  }

  // ---------------------------------------------------------------- mind

  /** Whether a survivor can be seen (window glass doesn't hide them). */
  private canSee(p: SimPlayer): boolean {
    const e = this.eye;
    const d = dist2D(e, p.motion.pos);
    if (d > RAID.sight) return false;
    // Head and chest: either will do.
    for (const h of [p.motion.eyeHeight - 0.05, p.motion.eyeHeight * 0.7]) {
      const t = { x: p.motion.pos.x, y: p.motion.pos.y + h, z: p.motion.pos.z };
      if (this.raid.clearLine(e, t)) return true;
    }
    return false;
  }

  private sense(): void {
    const sim = this.sim;
    let best: SimPlayer | null = null;
    let bestScore = Infinity;
    for (const p of sim.players.values()) {
      // A survivor already down is left to bleed: they go for whoever can still shoot back.
      if (!p.up) continue;
      if (!this.canSee(p)) continue;
      // Keep on the one already in the sights unless someone is much closer.
      const d = dist2D(p.motion.pos, this.pos) * (p.id === this.target ? 0.7 : 1);
      if (d < bestScore) {
        bestScore = d;
        best = p;
      }
    }
    if (best) {
      if (this.target !== best.id || sim.time - this.lastSeen > 0.6) this.seenSince = sim.time;
      this.target = best.id;
      this.lastKnown = { ...best.motion.pos };
      this.lastSeen = sim.time;
      return;
    }
    const cur = this.target ? sim.players.get(this.target) : undefined;
    if (!cur || !cur.up) {
      // Nobody in sight: go for the nearest survivor (they came here for them).
      this.target = null;
      let nd = Infinity;
      for (const p of sim.players.values()) {
        if (!p.up) continue;
        const d = dist2D(p.motion.pos, this.pos);
        if (d < nd) {
          nd = d;
          this.target = p.id;
        }
      }
      const t = this.target ? sim.players.get(this.target) : undefined;
      this.lastKnown = t ? { ...t.motion.pos } : null;
      this.repathAt = 0;
    } else if (sim.time - this.lastSeen > 2.5) {
      // They have a rough idea where everyone holed up.
      this.lastKnown = { ...cur.motion.pos };
    }
  }

  update(dt: number): void {
    const sim = this.sim;
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.pos.z;
    if (!this.alive) return;
    const ticks: ArsenalTick[] = [];
    this.arsenal.step(dt, this.motion.aiming, ticks);
    if (sim.time >= this.nextSense) {
      this.nextSense = sim.time + 0.22 + this.rand() * 0.1;
      this.sense();
    }
    const target = this.target ? sim.players.get(this.target) ?? null : null;
    const visible = !!target && target.up && sim.time - this.lastSeen < 0.35;
    const W = RAID.engage[this.weapon === 'shotgun' ? 'shotgun' : this.weapon === 'pistol' ? 'pistol' : 'ar'];

    let wishX = 0, wishZ = 0, speed = 0;
    let faceX = 0, faceZ = 0;
    this.motion.aiming = false;

    if (this.state === 'deploy') {
      [wishX, wishZ] = this.follow();
      speed = RAID.runSpeed;
      if (!this.goal || dist2D(this.pos, this.goal) < 0.8 || this.stuckT > 1.5) this.state = 'hunt';
      if (visible) this.state = 'engage';
    } else if (visible && target) {
      const tp = target.motion.pos;
      const d = dist2D(this.pos, tp);
      if (d <= W[1]) {
        this.state = 'engage';
        this.motion.aiming = true;
        faceX = tp.x - this.pos.x;
        faceZ = tp.z - this.pos.z;
        this.shoot(target, d);
        // Inside? Hold at the window a while, then go in after them.
        if (this.indoors(tp) && !this.indoors(this.pos)) {
          if (this.holdUntil < sim.time - 4) this.holdUntil = sim.time + RAID.holdTime * (0.6 + this.rand() * 0.8);
        }
        if (d > W[0]) {
          // Close in while shooting.
          this.goal = { ...tp };
          [wishX, wishZ] = this.follow();
          speed = RAID.walkSpeed * 0.75;
        } else {
          // Hold ground, side-stepping now and then.
          if (sim.time > this.strafeUntil) {
            this.strafe = this.rand() < 0.45 ? 0 : this.rand() < 0.5 ? -1 : 1;
            this.strafeUntil = sim.time + 0.8 + this.rand() * 1.4;
          }
          const l = Math.hypot(faceX, faceZ) || 1;
          wishX = (faceZ / l) * this.strafe;
          wishZ = (-faceX / l) * this.strafe;
          speed = RAID.walkSpeed * 0.55;
        }
      } else {
        this.state = 'hunt';
        this.goal = { ...tp };
        [wishX, wishZ] = this.follow();
        speed = RAID.runSpeed;
      }
    } else if (target && this.lastKnown) {
      const inside = this.indoors(this.lastKnown);
      // Stay at the window a little after losing sight: they tend to pop back up.
      if (sim.time < this.holdUntil && sim.time - this.lastSeen < 3) {
        if (target) {
          faceX = this.lastKnown.x - this.pos.x;
          faceZ = this.lastKnown.z - this.pos.z;
        }
        this.motion.aiming = true;
      } else {
        this.state = inside ? 'breach' : 'hunt';
        if (!this.goal || dist2D(this.goal, this.lastKnown) > 2.5) {
          const n = sim.nav.randomNear(this.lastKnown.x, this.lastKnown.y, this.lastKnown.z, inside ? 1.5 : 3.5, this.rand);
          this.goal = n >= 0 ? sim.nav.nodePos(n) : { ...this.lastKnown };
          this.repathAt = 0;
        }
        [wishX, wishZ] = this.follow();
        speed = this.state === 'breach' ? RAID.walkSpeed * 1.15 : RAID.runSpeed;
        this.handleDoors();
      }
    } else {
      this.state = 'hunt';
    }
    // Reload behind the gun as soon as it runs dry (or between fights).
    const a = this.arsenal;
    if (a.action === 'idle' && (a.weapon.mag === 0 || (!visible && a.weapon.mag < WEAPONS[a.weapon.id].magazine * 0.4))) {
      if (a.startReload()) sim.emit({ type: 'reload', player: this.id, weapon: a.weapon.id, stage: 'start' });
    }
    for (const t of ticks) {
      if (t === 'shell') sim.emit({ type: 'reload', player: this.id, weapon: a.weapon.id, stage: 'shell' });
      if (t === 'reloaded') sim.emit({ type: 'reload', player: this.id, weapon: a.weapon.id, stage: 'end' });
    }
    if (sim.time < this.detour.until && (wishX !== 0 || wishZ !== 0)) {
      wishX = this.detour.x;
      wishZ = this.detour.z;
    }
    this.move(dt, wishX, wishZ, speed, faceX, faceZ);
    // Aim pitch toward whoever they are looking at.
    if (target && this.motion.aiming) {
      const e = this.eye, tp = target.chest;
      this.motion.pitch = Math.atan2(tp.y - e.y, Math.max(0.5, dist2D(e, tp)));
    } else this.motion.pitch *= 0.9;
  }

  private indoors(p: Vec3): boolean {
    const n = this.sim.nav.nodeAt(p.x, p.y, p.z, 0.6);
    return n >= 0 && (this.sim.nav.flags[n] & NAV_INDOOR) !== 0;
  }

  /** Fires when the gun and the aim allow: bursts from rifles, single aimed shots otherwise. */
  private shoot(target: SimPlayer, d: number): void {
    const sim = this.sim;
    const a = this.arsenal;
    if (sim.time - this.seenSince < RAID.reaction[0] + (RAID.reaction[1] - RAID.reaction[0]) * ((this.seed % 97) / 97)) return;
    // Facing roughly the right way first.
    const want = Math.atan2(target.motion.pos.x - this.pos.x, target.motion.pos.z - this.pos.z);
    if (Math.abs(angleDiff(want, this.facing)) > 0.35) return;
    if (sim.time < this.fireAt || a.fireState() !== 'ok') return;
    const def = a.def;
    if (this.burstLeft <= 0) {
      this.burstLeft = def.auto ? RAID.burst[0] + Math.floor(this.rand() * (RAID.burst[1] - RAID.burst[0] + 1)) : 1;
    }
    this.raid.fire(this, target, d);
    this.burstLeft--;
    if (this.burstLeft <= 0) {
      const [lo, hi] = def.auto ? RAID.burstPause : RAID.shotPause;
      this.fireAt = sim.time + lo + this.rand() * (hi - lo) + (def.pellets > 1 ? RAID.pumpPause : 0);
    }
  }

  /** Doors on the way in: an unlocked one is opened, a barricaded one kicked in. */
  private handleDoors(): void {
    const sim = this.sim;
    const door = sim.closedDoorNear(this.pos, 1.5);
    if (!door) return;
    const wanted = this.pathDoors.includes(door.index)
      || (this.lastKnown !== null && door.side(this.lastKnown.x, this.lastKnown.z) !== door.side(this.pos.x, this.pos.z));
    if (!wanted || sim.time < this.kickAt) return;
    this.kickAt = sim.time + RAID.kickEvery * (0.8 + this.rand() * 0.4);
    if (this.raid.kickDoor(door, this)) this.repathAt = 0;
  }

  // ---------------------------------------------------------------- movement

  private follow(): [number, number] {
    const sim = this.sim;
    if (this.goal && sim.time >= this.repathAt) {
      this.repathAt = sim.time + 1.4 + this.rand() * 0.8;
      const res = sim.nav.findPath(this.pos, this.goal, {
        maxExpand: 20000,
        seed: this.seed,
        doorCost: (i) => (sim.doors[i] && !sim.doors[i]!.open ? 4 : 0),
      });
      this.path = res ? res.points : [];
      this.pathDoors = res ? res.doors : [];
      this.pathI = this.path.length > 1 ? 1 : 0;
    }
    while (this.pathI < this.path.length) {
      const wp = this.path[this.pathI];
      const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const last = this.pathI === this.path.length - 1;
      if (d < (last ? 0.35 : 0.6) && Math.abs(wp.y - this.pos.y) < 0.8) {
        this.pathI++;
        continue;
      }
      return [dx / (d || 1), dz / (d || 1)];
    }
    return [0, 0];
  }

  private move(dt: number, wishX: number, wishZ: number, speed: number, faceX: number, faceZ: number): void {
    const sim = this.sim;
    // Keep apart from the rest of the crew.
    let sx = 0, sz = 0;
    for (const o of this.raid.raiders) {
      if (o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4 && d < 1.6) {
        sx += (dx / d) * (1 - d / 1.6);
        sz += (dz / d) * (1 - d / 1.6);
      }
    }
    let tx = wishX * speed + sx * 1.5, tz = wishZ * speed + sz * 1.5;
    const fx = faceX || tx, fz = faceZ || tz;
    if (Math.hypot(fx, fz) > 0.05) {
      const want = Math.atan2(fx, fz);
      const diff = angleDiff(want, this.facing);
      const max = 7 * dt;
      this.facing += clamp(diff, -max, max);
      if (Math.abs(diff) > 1.6 && !faceX && !faceZ) {
        tx *= 0.3;
        tz *= 0.3;
      }
    }
    this.motion.yaw = this.facing + Math.PI;
    const m = this.motion;
    const k = 1 - Math.exp(-dt * 8);
    m.vel.x += (tx - m.vel.x) * k;
    m.vel.z += (tz - m.vel.z) * k;
    m.vel.y = Math.max(-20, m.vel.y - 19.6 * dt);
    if (m.grounded && m.vel.y < 0) m.vel.y = 0;
    m.sprinting = Math.hypot(m.vel.x, m.vel.z) > RAID.walkSpeed + 0.4;
    if (!this.collider || !this.body) {
      m.pos.x += m.vel.x * dt;
      m.pos.z += m.vel.z * dt;
      return;
    }
    const ctrl = sim.zombieController;
    const want = { x: m.vel.x * dt, y: m.vel.y * dt, z: m.vel.z * dt };
    ctrl.computeColliderMovement(this.collider, want, undefined, RAIDER_GROUPS);
    // Stalled on a doorstep's edge: ride up it as a survivor does (see climbing()).
    if (m.grounded && stalled(ctrl, want) && touchedLedge(ctrl, m.pos.y + ZOMBIE_STEP + 0.05)) {
      ctrl.computeColliderMovement(this.collider, climbing(want), undefined, RAIDER_GROUPS);
    }
    const mv = ctrl.computedMovement();
    m.grounded = ctrl.computedGrounded();
    const t = this.body.translation();
    const next = { x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z };
    this.body.setNextKinematicTranslation(next);
    m.pos.x = next.x;
    m.pos.y = next.y - RAID.height / 2 - 0.02;
    m.pos.z = next.z;
    this.moveSpeed = Math.hypot(mv.x, mv.z) / Math.max(dt, 1e-4);
    if (m.pos.y < -20) this.raid.kill(this, null, 'torso', { x: 0, y: 0, z: 1 });

    // Stuck: sidestep, then plan again.
    const wants = Math.hypot(tx, tz) > 0.5;
    this.progressT += dt;
    if (this.progressT > 0.7) {
      const moved = dist2D(this.pos, this.progressRef);
      this.progressT = 0;
      this.progressRef.x = this.pos.x;
      this.progressRef.y = this.pos.y;
      this.progressRef.z = this.pos.z;
      if (wants && moved < 0.2) this.stuckT += 0.7;
      else this.stuckT = 0;
      if (this.stuckT > 0) {
        this.handleDoors();
        const a = this.rand() * Math.PI * 2;
        this.detour = { x: Math.cos(a), z: Math.sin(a), until: sim.time + 0.5 };
        if (this.stuckT > 1.4) this.repathAt = 0;
        if (this.stuckT > 3 && this.goal) {
          const n = sim.nav.randomNear(this.pos.x, this.pos.y, this.pos.z, 4, this.rand);
          if (n >= 0) this.goal = sim.nav.nodePos(n);
          this.stuckT = 0;
        }
      }
    }
  }

  private bodyGone = false;

  removeBody(): void {
    if (this.body && !this.bodyGone) this.sim.physics.world.removeRigidBody(this.body);
    this.bodyGone = true;
  }
}

/**
 * The raid itself: waits for its time, picks the road in farthest from the survivors, drives
 * the van in, lets the crew out one by one, and ends when the last raider is down (the van's
 * cargo is then left for the survivors). It happens once a night.
 */
export class Raid {
  stage: RaidStage = 'waiting';
  van: RaidVan | null = null;
  readonly raiders: Raider[] = [];
  private samples: RouteSamples | null = null;
  private crew: WeaponId[] = [];
  private nextOut = 0;
  private nextNum = 1;
  private readonly rand: () => number;
  private readonly zoneBuf: ZoneShape[] = [];
  arrivedAt = 0;
  killed = 0;
  private doorCloseAt = 0;
  /** Threat-clock second it comes at (Simulation.threatTime; tests and debugging move it). */
  at: number = RAID.at;

  constructor(private readonly sim: Simulation, seed: number) {
    this.rand = rng((seed ^ 0x2545f491) >>> 0 || 7);
  }

  get active(): boolean {
    return this.stage === 'inbound' || this.stage === 'arrived';
  }

  raider(id: string): Raider | undefined {
    return this.raiders.find((r) => r.id === id);
  }

  /** Raiders still standing (and those still in the van). */
  get remaining(): number {
    return this.raiders.filter((r) => r.alive).length + this.crew.length;
  }

  /** One step, from Simulation.step. `world` false holds the raiders (see Simulation.step). */
  update(dt: number, world: boolean): void {
    const sim = this.sim;
    if (this.stage === 'waiting') {
      // On the threat clock (it stands still during a lull), and never while one is on.
      if (sim.phase === 'survival' && sim.threatTime >= this.at && !sim.lulling) this.start();
      return;
    }
    if (this.stage === 'inbound') this.drive(dt);
    else if (this.stage === 'arrived') this.deploy();
    if (this.van?.door && this.doorCloseAt > 0 && sim.time >= this.doorCloseAt) {
      this.van.door = false;
      this.doorCloseAt = 0;
    }
    for (const r of this.raiders) {
      r.pending += dt;
      if (!world) continue;
      r.update(r.pending);
      r.updatedAt = sim.time;
      r.lastDt = r.pending;
      r.pending = 0;
    }
    for (let i = this.raiders.length - 1; i >= 0; i--) {
      const r = this.raiders[i];
      if (!r.alive && sim.time - r.diedAt > 1) {
        this.raiders.splice(i, 1);
        sim.emit({ type: 'raiderRemoved', raider: r.id });
      }
    }
    if (this.stage === 'arrived' && this.crew.length === 0 && !this.raiders.some((r) => r.alive)) this.finish();
  }

  /** The van and its solid body (survivors, zombies and bullets all stop on it). */
  private makeVan(route: number, x: number, z: number, yaw: number): RaidVan {
    const w = this.sim.physics.world;
    const V = RAID.van;
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, V.height / 2 + 0.15, z).setRotation(yawQuat(yaw)));
    const collider = w.createCollider(
      RAPIER.ColliderDesc.cuboid(V.width / 2, V.height / 2 - 0.1, V.length / 2).setCollisionGroups(groups(GROUP.dynamic, 0xffff)),
      body,
    );
    this.sim.physics.setSurface(collider, 'metal');
    return { route, pos: { x, y: 0, z }, yaw, speed: 0, s: 0, door: false, body, collider };
  }

  /** A network client's copy: the van where the server says (its body follows for collisions). */
  syncVan(route: number, stage: RaidStage, x: number, z: number, yaw: number, speed: number, door: boolean): void {
    if (!this.van) this.van = this.makeVan(route, x, z, yaw);
    const v = this.van;
    v.pos.x = x;
    v.pos.z = z;
    v.yaw = yaw;
    v.speed = speed;
    v.door = door;
    v.body?.setNextKinematicTranslation({ x, y: RAID.van.height / 2 + 0.15, z });
    v.body?.setNextKinematicRotation(yawQuat(yaw));
    if (this.stage !== 'over') this.stage = stage;
  }

  /** Starts the raid now (it only ever happens once). Returns false if it can't. */
  start(): boolean {
    const sim = this.sim;
    if (this.stage !== 'waiting') return false;
    const alive = [...sim.players.values()].filter((p) => p.alive);
    if (!alive.length) return false;
    // The way in farthest from everyone.
    let best = 0, bestD = -1;
    RAID_ROUTES.forEach((r, i) => {
      const p = r.points[Math.min(2, r.points.length - 1)];
      let near = Infinity;
      for (const q of alive) near = Math.min(near, Math.hypot(q.motion.pos.x - p.x, q.motion.pos.z - p.z));
      if (near > bestD) {
        bestD = near;
        best = i;
      }
    });
    this.samples = sampleRoute(RAID_ROUTES[best]);
    const at = routeAt(this.samples, 0);
    this.van = this.makeVan(best, at.x, at.z, at.yaw);
    this.van.speed = RAID.van.cruise;
    // The crew: a mix of guns, never all the same.
    const total = RAID.weapons.reduce((s, [, k]) => s + k, 0);
    const roll = (): WeaponId => {
      let x = this.rand() * total;
      for (const [id, k] of RAID.weapons) if ((x -= k) < 0) return id;
      return RAID.weapons[0][0];
    };
    this.crew = Array.from({ length: RAID.raiders }, roll);
    if (this.crew.every((c) => c === this.crew[0])) {
      const others = RAID.weapons.map(([id]) => id).filter((id) => id !== this.crew[0]);
      this.crew[Math.floor(this.rand() * this.crew.length)] = others[Math.floor(this.rand() * others.length)];
    }
    this.stage = 'inbound';
    sim.emit({ type: 'raid', stage: 'inbound', route: best, pos: { ...this.van.pos }, count: RAID.raiders });
    sim.emit({ type: 'notice', player: null, text: 'VEHICLE APPROACHING', sub: `Engine noise from ${RAID_ROUTES[best].name}` });
    return true;
  }

  private drive(dt: number): void {
    const sim = this.sim;
    const van = this.van!;
    const R = this.samples!;
    const V = RAID.van;
    const limit = routeAt(R, van.s).speed;
    // Brakes for survivors in the road (it would drive straight through them).
    const fx = Math.sin(van.yaw), fz = Math.cos(van.yaw);
    let blocked = false;
    for (const p of sim.players.values()) {
      if (!p.alive) continue;
      const dx = p.motion.pos.x - van.pos.x, dz = p.motion.pos.z - van.pos.z;
      const along = dx * fx + dz * fz, side = dx * fz - dz * fx;
      if (Math.abs(side) < V.width / 2 + 0.7 && along > -V.length / 2 && along < V.length / 2 + 2.5 + van.speed * 0.4) blocked = true;
    }
    const want = blocked ? 0 : Math.max(limit, van.s < R.length - 0.5 ? 0.7 : 0);
    van.speed = want < van.speed ? Math.max(want, van.speed - (blocked ? 9 : V.brake * 1.6) * dt) : Math.min(want, van.speed + V.accel * dt);
    van.s = Math.min(R.length, van.s + van.speed * dt);
    const at = routeAt(R, van.s);
    van.pos.x = at.x;
    van.pos.z = at.z;
    van.yaw = at.yaw;
    van.body!.setNextKinematicTranslation({ x: at.x, y: V.height / 2 + 0.15, z: at.z });
    van.body!.setNextKinematicRotation(yawQuat(at.yaw));
    // Engine noise carries: the dead come to look.
    if (Math.floor(sim.time * 2) !== Math.floor((sim.time - dt) * 2)) sim.noise(van.pos, 24, null);
    // Anything dead in the road goes under it.
    if (van.speed > 2.5) {
      for (const z of sim.zombies) {
        if (!z.alive) continue;
        const dx = z.pos.x - van.pos.x, dz = z.pos.z - van.pos.z;
        const along = dx * fx + dz * fz, side = dx * fz - dz * fx;
        if (Math.abs(side) > V.width / 2 + z.def.radius || along < -V.length / 2 || along > V.length / 2 + z.def.radius + 0.2) continue;
        const dir = { x: fx, y: 0.3, z: fz };
        z.takeHit(V.ramDamage, 'torso', dir, null as unknown as SimPlayer, false);
        sim.emit({ type: 'zombieHit', zombie: z.id, zone: 'torso', pos: z.chest, dir, damage: z.def.health, killed: true, by: 'raider:0', melee: false, exit: null });
        sim.emit({ type: 'zombieDied', zombie: z.id, zone: 'torso', dir, force: 1.2 + van.speed * 0.25, by: 'raider:0' });
      }
    }
    if (van.s >= R.length - 0.01 && van.speed < 0.05) {
      this.stage = 'arrived';
      this.arrivedAt = sim.time;
      this.nextOut = sim.time + 0.9;
      van.speed = 0;
      sim.noise(van.pos, 40, null);
      sim.emit({ type: 'raid', stage: 'arrived', route: van.route, pos: { ...van.pos }, count: this.crew.length });
      sim.emit({ type: 'notice', player: null, text: 'HOSTILE SURVIVORS', sub: `${this.crew.length} armed raiders · take them out` });
    }
  }

  /** The crew gets out of the side door one at a time and fans out. */
  private deploy(): void {
    const sim = this.sim;
    const van = this.van!;
    if (!this.crew.length || sim.time < this.nextOut) return;
    van.door = true;
    this.nextOut = sim.time + RAID.deployEvery;
    const weapon = this.crew.shift()!;
    const D = RAID.van.door;
    const door = vanLocal(van, D.x, D.z);
    const n = sim.nav.nodeAt(door.x, 0.2, door.z, 1.2);
    const at = n >= 0 ? sim.nav.nodePos(n) : { x: door.x, y: 0.05, z: door.z };
    const r = new Raider(this.nextNum++, weapon, { x: at.x, y: at.y + 0.02, z: at.z }, van.yaw - Math.PI / 2, (Math.floor(this.rand() * 1e9) + 1) >>> 0, this, sim);
    r.updatedAt = sim.time;
    this.raiders.push(r);
    // A spot out from the van, spread around its side and back.
    const [lo, hi] = RAID.spread;
    const ang = van.yaw - Math.PI / 2 + (this.rand() - 0.5) * 2.4;
    const dd = lo + this.rand() * (hi - lo);
    const m = sim.nav.nodeAt(at.x + Math.sin(ang) * dd, 0.2, at.z + Math.cos(ang) * dd, 2);
    r.deployTo(m >= 0 ? sim.nav.nodePos(m) : { ...at });
    sim.emit({ type: 'raiderSpawned', raider: r.id, weapon });
    if (!this.crew.length) this.doorCloseAt = sim.time + 1.4;
  }

  private finish(): void {
    const sim = this.sim;
    this.stage = 'over';
    const van = this.van;
    sim.emit({ type: 'raid', stage: 'over', route: van?.route ?? 0, pos: van ? { ...van.pos } : v3(), count: 0 });
    sim.emit({ type: 'notice', player: null, text: 'RAIDERS ELIMINATED', sub: 'Their van still has supplies in the back' });
    if (!van) return;
    // Their supplies, in the back of the van.
    const c = vanLocal(van, RAID.van.cargo.x, RAID.van.cargo.z - 0.6);
    const alive = [...sim.players.values()].filter((p) => p.alive).length;
    sim.interactables.push({
      id: sim.interactables.length, kind: 'supply', pos: { x: c.x, y: 0.9, z: c.z }, supply: RAID.cargoUses + alive, range: 2.2, takenBy: new Map(),
    });
    const b = vanLocal(van, 0.9, RAID.van.cargo.z - 0.6);
    sim.interactables.push({ id: sim.interactables.length, kind: 'medical', pos: { x: b.x, y: 0.9, z: b.z }, supply: RAID.cargoBandages, range: 2.2 });
  }

  // ---------------------------------------------------------------- combat

  /** Whether nothing solid lies between two points (window glass is see-through). */
  clearLine(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.3) return true;
    const d = { x: dx / len, y: dy / len, z: dz / len };
    const hit = this.sim.castRound(a, d, len, false);
    return !hit || hit.distance > len - 0.3;
  }

  /** One trigger pull at `target`: every round is traced like a survivor's, against survivors. */
  fire(r: Raider, target: SimPlayer, dist: number): void {
    const sim = this.sim;
    const a = r.arsenal;
    const def = a.def;
    a.consume();
    sim.noise(r.pos, Math.min(def.noise, RAID.noise), r.id);
    const o = r.eye;
    const tm = target.motion;
    // Mostly centre of mass, now and then the head.
    const h = tm.prone ? 0.25 : this.rand() < 0.18 ? tm.eyeHeight - 0.05 : tm.eyeHeight * 0.68;
    const aim = { x: tm.pos.x - o.x, y: tm.pos.y + h - o.y, z: tm.pos.z - o.z };
    const al = Math.hypot(aim.x, aim.y, aim.z) || 1;
    let dir = { x: aim.x / al, y: aim.y / al, z: aim.z / al };
    const speed = Math.hypot(tm.vel.x, tm.vel.z);
    const chance = Math.max(0.1, (RAID.hitChance - RAID.movingPenalty * speed) * (tm.prone ? RAID.proneFactor : tm.crouching ? RAID.crouchFactor : 1));
    if (this.rand() >= chance) {
      // A near miss: past the head or the shoulder, close enough to hear it go by.
      const ux = Math.abs(dir.y) < 0.95 ? 0 : 1, uy = Math.abs(dir.y) < 0.95 ? 1 : 0;
      let bx = uy * dir.z, by = -ux * dir.z, bz = ux * dir.y - uy * dir.x;
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl; by /= bl; bz /= bl;
      const cx = dir.y * bz - dir.z * by, cy = dir.z * bx - dir.x * bz, cz = dir.x * by - dir.y * bx;
      const phi = this.rand() * Math.PI * 2, off = (0.55 + this.rand() * 0.9 + (def.pellets > 1 ? 0.25 * dist * Math.tan((def.hipSpread * Math.PI) / 180) + 0.4 : 0)) / al;
      const ox = (bx * Math.cos(phi) + cx * Math.sin(phi)) * off, oy = (by * Math.cos(phi) + cy * Math.sin(phi)) * off, oz = (bz * Math.cos(phi) + cz * Math.sin(phi)) * off;
      const l = Math.hypot(dir.x + ox, dir.y + oy, dir.z + oz) || 1;
      dir = { x: (dir.x + ox) / l, y: (dir.y + oy) / l, z: (dir.z + oz) / l };
    }
    const aimed = cone(dir, RAID.aimError + (dist > 30 ? 0.4 : 0), this.rand);
    const pellets: PelletTrace[] = [];
    for (let i = 0; i < def.pellets; i++) {
      const pd = def.pellets > 1 ? cone(aimed, def.hipSpread * 0.8, this.rand) : aimed;
      pellets.push(this.trace(r, o, pd, def.damage * RAID.damageScale, def.range, def.pellets > 1));
    }
    sim.emit({ type: 'shot', player: r.id, weapon: a.weapon.id, origin: o, pellets });
  }

  /** A raider's round: through window glass (breaking it), into the first survivor or wall. */
  private trace(r: Raider, o: Vec3, d: Vec3, damage: number, range: number, pellet: boolean): PelletTrace {
    const sim = this.sim;
    const maxD = range * 1.6;
    const world = sim.castRound(o, d, maxD, true);
    const worldD = world ? world.distance : maxD;
    let best: SimPlayer | null = null, bestT = worldD, head = false;
    for (const p of sim.players.values()) {
      if (!p.alive) continue;
      const m = p.motion;
      if (m.prone) {
        // Lying along the view: feet behind, head ahead, all of it low.
        const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
        const feet = { x: m.pos.x - fx * 0.75, y: m.pos.y + 0.18, z: m.pos.z - fz * 0.75 };
        const top = { x: m.pos.x + fx * 0.7, y: m.pos.y + 0.32, z: m.pos.z + fz * 0.7 };
        const t = rayCapsule(o, d, feet, top, 0.26);
        if (t >= 0 && t < bestT) {
          bestT = t;
          best = p;
          head = (o.x + d.x * t - m.pos.x) * fx + (o.z + d.z * t - m.pos.z) * fz > 0.45;
        }
        continue;
      }
      const top = { x: m.pos.x, y: m.pos.y + m.eyeHeight - 0.1, z: m.pos.z };
      const t = rayCapsule(o, d, { x: m.pos.x, y: m.pos.y + 0.35, z: m.pos.z }, top, 0.33);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = p;
        head = o.y + d.y * t > m.pos.y + m.eyeHeight - 0.25;
      }
    }
    if (best) {
      const pos = { x: o.x + d.x * bestT, y: o.y + d.y * bestT, z: o.z + d.z * bestT };
      const fall = bestT <= range * 0.5 ? 1 : bestT <= range ? 1 - 0.5 * ((bestT - range * 0.5) / (range * 0.5)) : 0.25;
      const dmg = Math.max(1, Math.round(damage * fall * (head ? 1.6 : 1) * (pellet ? 1 : 1)));
      sim.damagePlayer(best, dmg, r.eye);
      return { end: pos, hit: 'zombie' };
    }
    // Zombies in the line of fire soak it up.
    for (const z of sim.zombies) {
      if (!z.alive) continue;
      const cx = z.pos.x - o.x, cy = z.pos.y + 0.9 * z.scale - o.y, cz = z.pos.z - o.z;
      const along = cx * d.x + cy * d.y + cz * d.z;
      if (along < 0 || along > worldD) continue;
      const px = cx - d.x * along, py = cy - d.y * along, pz = cz - d.z * along;
      if (px * px + py * py + pz * pz > 2.6) continue;
      const hz = rayZones(o, d, z.zones(this.zoneBuf), worldD);
      if (!hz) continue;
      const pos = { x: o.x + d.x * hz.t, y: o.y + d.y * hz.t, z: o.z + d.z * hz.t };
      const killed = z.takeHit(damage * 2, hz.zone, d, r as unknown as SimPlayer, false);
      sim.emit({ type: 'zombieHit', zombie: z.id, zone: hz.zone, pos, dir: { ...d }, damage: damage * 2, killed, by: r.id, melee: false, exit: null });
      if (killed) sim.emit({ type: 'zombieDied', zombie: z.id, zone: hz.zone, dir: { ...d }, force: 0.8, by: r.id });
      return { end: pos, hit: 'zombie' };
    }
    if (world) {
      const pos = { x: o.x + d.x * world.distance, y: o.y + d.y * world.distance, z: o.z + d.z * world.distance };
      sim.emit({ type: 'impact', pos, normal: { x: world.nx, y: world.ny, z: world.nz }, surface: world.surface, dir: { ...d } });
      return { end: pos, hit: 'world' };
    }
    return { end: { x: o.x + d.x * maxD, y: o.y + d.y * maxD, z: o.z + d.z * maxD }, hit: 'none' };
  }

  /** Nearest raider a survivor's round meets before `maxD`, for Simulation.traceRound. */
  traceHit(o: Vec3, d: Vec3, maxD: number): { r: Raider; zone: HitZone; t: number } | null {
    let best: { r: Raider; zone: HitZone; t: number } | null = null;
    for (const r of this.raiders) {
      if (!r.alive) continue;
      const c = r.chest;
      const cx = c.x - o.x, cy = c.y - 0.3 - o.y, cz = c.z - o.z;
      const along = cx * d.x + cy * d.y + cz * d.z;
      if (along < -1 || along > maxD + 1) continue;
      const px = cx - d.x * along, py = cy - d.y * along, pz = cz - d.z * along;
      if (px * px + py * py + pz * pz > 2.6) continue;
      const h = rayZones(o, d, r.zones(this.zoneBuf), best ? best.t : maxD);
      if (h) best = { r, zone: h.zone, t: h.t };
    }
    return best;
  }

  /** A survivor's round lands on a raider. */
  hit(by: SimPlayer, r: Raider, damage: number, zone: HitZone, pos: Vec3, dir: Vec3, melee = false): void {
    if (!r.alive) return;
    const dmg = damage * RAID.zones[zone];
    const dealt = Math.min(r.health, dmg);
    r.health -= dmg;
    by.stats.damageDealt += dealt;
    const killed = r.health <= 0;
    this.sim.emit({ type: 'raiderHit', raider: r.id, zone, pos: { ...pos }, dir: { ...dir }, damage: dealt, killed, by: by.id, melee });
    if (killed) this.kill(r, by, zone, dir);
    else r.onHit(by, zone, dir);
  }

  kill(r: Raider, by: SimPlayer | null, zone: HitZone, dir: Vec3): void {
    if (!r.alive) return;
    r.alive = false;
    r.state = 'dead';
    r.health = 0;
    r.diedAt = this.sim.time;
    r.removeBody();
    this.killed++;
    this.sim.emit({ type: 'raiderDied', raider: r.id, zone, dir: { ...dir }, by: by?.id ?? null, weapon: r.weapon, left: this.remaining });
    const left = this.remaining;
    if (left > 0) this.sim.emit({ type: 'notice', player: null, text: `RAIDER DOWN · ${left} LEFT` });
  }

  /** A raider at a closed door: opens it, or kicks at it while it is barricaded. True when it gives. */
  kickDoor(door: DoorBody, r: Raider): boolean {
    const sim = this.sim;
    if (!sim.doorBarred(door)) {
      door.setOpen(true, r.pos.x, r.pos.z);
      return true;
    }
    sim.emit({ type: 'doorPound', door: door.index, pos: { ...r.pos } });
    sim.noise(door.center, 18, r.id);
    if (sim.poundDoor(door, RAID.kick, r.pos.x, r.pos.z)) {
      sim.emit({ type: 'doorForced', door: door.index, pos: { ...door.center } });
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const r of this.raiders) r.removeBody();
    this.raiders.length = 0;
    if (this.van?.body) this.sim.physics.world.removeRigidBody(this.van.body);
    if (this.van) {
      this.van.body = null;
      this.van.collider = null;
    }
  }
}

export function yawQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** A point in the van's frame (+x right of the heading, +z forward) in world space. */
export function vanLocal(van: { pos: Vec3; yaw: number }, x: number, z: number): Vec3 {
  const fx = Math.sin(van.yaw), fz = Math.cos(van.yaw);
  // Right of a +Z heading is -X (looking down +Z with +Y up).
  const rx = -fz, rz = fx;
  return { x: van.pos.x + rx * x + fx * z, y: van.pos.y, z: van.pos.z + rz * x + fz * z };
}
