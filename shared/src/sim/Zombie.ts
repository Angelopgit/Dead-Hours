import { RAPIER, GROUP, groups } from '../physics/Physics';
import { ZOMBIES, type ZombieDef, type ZombieKind } from '../config/zombies';
import { COMBAT, type HitZone } from '../config/weapons';
import { LIMBS, type ArmState, type ArmZone, type LimbCut } from '../config/limbs';
import { zombieZones, type ZoneShape } from './hitzones';
import { NAV_INDOOR, NAV_NEAR_WALL } from './NavGrid';
import { angleDiff, clamp, dist2D, rng, v3, type Vec3 } from './math';
import type { SimPlayer, Simulation } from './Simulation';

/** Zombies collide with the world, doors and players, but steer around each other. */
export const ZOMBIE_GROUPS = groups(GROUP.zombie, GROUP.static | GROUP.dynamic | GROUP.player);

export type ZombieState =
  | 'idle' | 'wander' | 'approach' | 'investigate' | 'chase' | 'attack' | 'bash' | 'stagger' | 'down' | 'dead';

const SEPARATION = 0.95;

/**
 * One zombie: perception (sight cones, line of sight, hearing), a small state machine, path
 * following on the nav grid, and movement through Rapier's character controller.
 */
export class Zombie {
  readonly def: ZombieDef;
  readonly scale: number;
  readonly rand: () => number;
  readonly pos: Vec3;
  readonly prev: Vec3;
  readonly vel = v3();
  facing: number;
  private vy = 0;
  grounded = true;
  health: number;
  state: ZombieState = 'idle';
  stateT = 0;
  private resumeState: ZombieState = 'wander';
  readonly wanderSpeed: number;
  readonly chaseSpeed: number;

  target: string | null = null;
  lastKnown: Vec3 | null = null;
  lastSeen = -99;
  private goal: Vec3 | null = null;
  private home: Vec3;
  private path: Vec3[] = [];
  /** Doors the current path goes through. */
  private pathDoors: number[] = [];
  private pathI = 0;
  private needPath = false;
  private repathAt = 0;
  private pathTarget: Vec3 | null = null;
  private nextSense: number;
  private heardUpTo = 0;
  private wanderUntil = 0;
  private approachAt = 0;

  /** Swipe progress in seconds (attack state). */
  attackT = 0;
  private attackCd = 0;
  private landed = false;
  private staggerT = 0;
  private readonly push = v3();
  private downT = 0;
  private stuckT = 0;
  /** Sidestep around whatever it is stuck on: direction, and until when. */
  private detourX = 0;
  private detourZ = 0;
  private detourUntil = 0;
  private readonly progressRef: Vec3;
  private progressT = 0;
  private alertAt = 0;
  private groanAt: number;
  private bashDoor = -1;
  private bashAt = 0;
  private legDamage = 0;
  private recentDamage = 0;
  private recentT = 0;
  /** Horizontal speed actually achieved (animation). */
  moveSpeed = 0;
  /** Signed turn rate (animation). */
  turnRate = 0;
  /** Most recent hit, for flinch animation. */
  lastHit: { zone: HitZone; dx: number; dz: number; at: number; amount: number } | null = null;
  /** Its arms: whole, cut at the elbow or gone at the shoulder (renderers hide what is gone). */
  readonly arms: Record<ArmZone, ArmState> = { armL: 'intact', armR: 'intact' };
  /** Damage each arm has soaked toward coming off. */
  readonly armDamage: Record<ArmZone, number> = { armL: 0, armR: 0 };
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly seed: number;
  /** Simulation time of the last update and the step it covered (render interpolation). */
  updatedAt = 0;
  lastDt = 1 / 60;
  /** Time accumulated since the last update (distant zombies update less often). */
  pending = 0;

  constructor(readonly id: number, readonly kind: ZombieKind, readonly look: number, at: Vec3, facing: number, seed: number, private readonly sim: Simulation) {
    this.def = ZOMBIES[kind];
    this.seed = seed;
    this.rand = rng(seed);
    this.scale = this.def.height / 1.75;
    this.pos = { ...at };
    this.prev = { ...at };
    this.home = { ...at };
    this.progressRef = { ...at };
    this.facing = facing;
    this.health = this.def.health;
    const r = this.rand;
    this.wanderSpeed = this.def.wanderSpeed[0] + r() * (this.def.wanderSpeed[1] - this.def.wanderSpeed[0]);
    this.chaseSpeed = this.def.chaseSpeed[0] + r() * (this.def.chaseSpeed[1] - this.def.chaseSpeed[0]);
    this.nextSense = sim.time + r() * 0.3;
    this.groanAt = sim.time + 2 + r() * 10;
    const half = (this.def.height - this.def.radius * 2) / 2;
    const w = sim.physics.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y + this.def.height / 2 + 0.02, at.z));
    this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(half, this.def.radius).setCollisionGroups(ZOMBIE_GROUPS), this.body);
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  get eye(): Vec3 {
    return { x: this.pos.x, y: this.pos.y + 1.55 * this.scale, z: this.pos.z };
  }

  get chest(): Vec3 {
    return { x: this.pos.x, y: this.pos.y + 1.2 * this.scale, z: this.pos.z };
  }

  /** Arms missing: one per arm gone at the shoulder, half per elbow stub. */
  get armsLost(): number {
    let n = 0;
    for (const a of [this.arms.armL, this.arms.armR]) n += a === 'shoulder' ? 1 : a === 'elbow' ? 0.5 : 0;
    return n;
  }

  /** Current hit zones (posture and missing arms included). */
  zones(out: ZoneShape[]): ZoneShape[] {
    return zombieZones(this.pos, this.facing, this.scale, this.state === 'down' ? 'down' : 'standing', out, this.def.girth, this.arms);
  }

  /** Whether an arm can still come off (a stub left at the elbow stays on). */
  canLose(arm: ArmZone): boolean {
    return this.arms[arm] === 'intact';
  }

  /** The arm comes off; the shock of it throws the zombie off balance. */
  loseArm(arm: ArmZone, cut: LimbCut, dir: Vec3): void {
    this.arms[arm] = cut;
    this.armDamage[arm] = 0;
    if (!this.alive || this.state === 'down') return;
    this.setState('stagger');
    this.staggerT = 0.85 + this.rand() * 0.3;
    const hl = Math.hypot(dir.x, dir.z) || 1;
    this.push.x = (dir.x / hl) * 1.4;
    this.push.z = (dir.z / hl) * 1.4;
    this.recentDamage = 0;
  }

  /** True while it is pursuing someone it knows about. */
  get engaged(): boolean {
    return this.state === 'chase' || this.state === 'attack' || this.state === 'bash' || (this.target !== null && this.state !== 'wander');
  }

  setState(s: ZombieState): void {
    if (s === this.state) return;
    if (s === 'stagger' || s === 'down') {
      if (this.state !== 'stagger' && this.state !== 'down') this.resumeState = this.state === 'attack' ? 'chase' : this.state;
    }
    this.state = s;
    this.stateT = 0;
    if (s === 'attack') {
      this.attackT = 0;
      this.landed = false;
    }
    if (s !== 'bash') this.bashDoor = -1;
  }

  /** Starts walking somewhere (noise, alert from another zombie). */
  investigate(at: Vec3, spread: number): void {
    if (this.state === 'chase' && this.sim.time - this.lastSeen < 2) return;
    if (this.state === 'attack' || this.state === 'stagger' || this.state === 'down' || this.state === 'dead' || this.state === 'bash') return;
    const r = this.rand;
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * spread;
    this.goal = { x: at.x + Math.cos(a) * d, y: at.y, z: at.z + Math.sin(a) * d };
    if (this.state !== 'chase') this.setState('investigate');
    else this.lastKnown = { ...this.goal };
    this.needPath = true;
  }

  /** Sent toward the survivors by the spawner. */
  approach(): void {
    this.setState('approach');
    this.approachAt = 0;
  }

  wander(): void {
    this.setState('wander');
    this.home = { ...this.pos };
    this.goal = null;
    this.wanderUntil = this.sim.time + 6 + this.rand() * 10;
  }

  // ---------------------------------------------------------------- perception

  private sense(): void {
    const sim = this.sim;
    let best: SimPlayer | null = null;
    let bestD = Infinity;
    const eye = this.eye;
    for (const p of sim.players.values()) {
      if (!p.alive) continue;
      const chest = p.chest;
      const dx = chest.x - eye.x, dy = chest.y - eye.y, dz = chest.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      const tracking = this.target === p.id && sim.time - this.lastSeen < 4;
      const range = this.def.sightRange * (p.motion.crouching ? 0.55 : 1) * (tracking ? 1.6 : 1);
      if (d > range) continue;
      if (d > 2.4 && !tracking) {
        const ang = Math.abs(angleDiff(Math.atan2(dx, dz), this.facing));
        if (ang > 1.15) continue;
      }
      if (d > 0.5) {
        const hit = sim.physics.raycast(eye.x, eye.y, eye.z, dx / d, dy / d, dz / d, d);
        if (hit !== null && hit < d - 0.35) continue;
      }
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) this.spotted(best);

    // Hearing.
    let loudest: { pos: Vec3; source: string | null; score: number } | null = null;
    const self = `z${this.id}`;
    for (const n of sim.noises) {
      if (n.time <= this.heardUpTo || n.source === self) continue;
      const d = Math.hypot(n.pos.x - this.pos.x, (n.pos.y - this.pos.y) * 2, n.pos.z - this.pos.z);
      const reach = n.radius * this.def.hearing;
      if (d > reach) continue;
      const score = d / reach;
      if (!loudest || score < loudest.score) loudest = { pos: n.pos, source: n.source, score };
    }
    this.heardUpTo = sim.time;
    if (loudest && !best && this.state !== 'bash') {
      const dist = dist2D(loudest.pos, this.pos);
      if (this.target && loudest.source === this.target) {
        // The one it hunts gave themselves away.
        this.lastKnown = { ...loudest.pos };
        this.needPath = true;
      } else if (!(this.state === 'chase' && sim.time - this.lastSeen < 3)) {
        this.investigate(loudest.pos, Math.min(6, 1 + dist * 0.12));
        if (this.groanAt < sim.time + 1) this.groanAt = sim.time + 0.4 + this.rand();
      }
    }
  }

  private spotted(p: SimPlayer): void {
    const sim = this.sim;
    const fresh = this.target !== p.id || sim.time - this.lastSeen > 6;
    this.target = p.id;
    this.lastKnown = { ...p.motion.pos };
    this.lastSeen = sim.time;
    if (this.state === 'idle' || this.state === 'wander' || this.state === 'approach' || this.state === 'investigate') {
      this.setState('chase');
      this.needPath = true;
    }
    if (fresh && sim.time > this.alertAt) {
      this.alertAt = sim.time + 7;
      this.groanAt = sim.time + 4 + this.rand() * 4;
      sim.emit({ type: 'zombieAlert', zombie: this.id, pos: { ...this.pos } });
      sim.alertNearby(this, this.lastKnown);
    }
  }

  // ---------------------------------------------------------------- damage

  /** Applies a hit. Returns true when it kills. `knock` overrides how far a melee blow shoves it. */
  takeHit(damage: number, zone: HitZone, dir: Vec3, by: SimPlayer, melee: boolean, knock: number = COMBAT.meleeKnockback): boolean {
    if (!this.alive) return false;
    const sim = this.sim;
    this.health -= damage;
    if (this.sim.time - this.recentT > 0.4) this.recentDamage = 0;
    this.recentT = sim.time;
    this.recentDamage += damage;
    if (zone === 'legL' || zone === 'legR') this.legDamage += damage;
    const hl = Math.hypot(dir.x, dir.z) || 1;
    this.lastHit = { zone, dx: dir.x / hl, dz: dir.z / hl, at: sim.time, amount: Math.min(1, damage / 60) };
    if (this.health <= 0) {
      this.setState('dead');
      return true;
    }
    // Being shot gives away where the shooter is.
    if (this.target !== by.id || sim.time - this.lastSeen > 1) {
      this.target = by.id;
      this.lastKnown = { ...by.motion.pos };
      this.lastSeen = sim.time - 0.8;
      this.needPath = true;
    }
    if (this.state === 'idle' || this.state === 'wander' || this.state === 'approach' || this.state === 'investigate' || this.state === 'bash') {
      this.setState('chase');
    }
    if (this.state === 'down') return false;
    if (this.legDamage >= this.def.health * 0.5 && this.rand() < 0.7) {
      this.legDamage = 0;
      this.setState('down');
      this.downT = 2.2 + this.rand() * 0.8;
      return false;
    }
    if (melee || zone === 'head' || this.recentDamage >= this.def.staggerAt) {
      this.setState('stagger');
      this.staggerT = melee ? 0.75 : 0.4 + this.rand() * 0.25;
      const k = melee ? knock : Math.min(1.6, damage * 0.03);
      this.push.x = (dir.x / hl) * k;
      this.push.z = (dir.z / hl) * k;
      this.recentDamage = 0;
    }
    return false;
  }

  // ---------------------------------------------------------------- update

  update(dt: number): void {
    const sim = this.sim;
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.pos.z;
    if (!this.alive) return;
    this.stateT += dt;
    this.attackCd -= dt;
    if (sim.time >= this.nextSense && this.state !== 'stagger' && this.state !== 'down') {
      this.nextSense = sim.time + 0.2 + this.rand() * 0.12;
      this.sense();
    }
    if (sim.time > this.groanAt) {
      this.groanAt = sim.time + (this.engaged ? 3 + this.rand() * 4 : 7 + this.rand() * 12);
      sim.emit({ type: 'zombieGroan', zombie: this.id, pos: { ...this.pos } });
    }

    let wishX = 0, wishZ = 0, speed = 0;
    let faceX = 0, faceZ = 0;
    const target = this.target ? sim.players.get(this.target) ?? null : null;
    if (target && !target.alive) this.loseTarget();

    switch (this.state) {
      case 'idle': {
        if (this.stateT > 2 + this.rand() * 4) this.wander();
        break;
      }
      case 'wander': {
        if (!this.goal || this.arrived(1.0)) {
          if (sim.time > this.wanderUntil && this.target === null && this.rand() < 0.35) {
            this.setState('idle');
            break;
          }
          const n = sim.nav.randomNear(this.home.x, this.home.y, this.home.z, 9, this.rand);
          if (n >= 0) {
            this.goal = sim.nav.nodePos(n);
            this.needPath = true;
          }
        }
        [wishX, wishZ] = this.follow();
        speed = this.wanderSpeed;
        break;
      }
      case 'approach': {
        if (sim.time > this.approachAt || !this.goal) {
          this.approachAt = sim.time + 10 + this.rand() * 8;
          const g = sim.approachGoal(this);
          if (g) {
            this.goal = g;
            this.needPath = true;
          }
        }
        if (this.goal && this.arrived(2.0)) this.wander();
        [wishX, wishZ] = this.follow();
        speed = this.wanderSpeed * 1.25;
        break;
      }
      case 'investigate': {
        if (this.goal && this.arrived(1.4)) {
          this.home = { ...this.goal };
          this.setState('wander');
          this.goal = null;
          this.wanderUntil = sim.time + 6 + this.rand() * 6;
          break;
        }
        [wishX, wishZ] = this.follow();
        speed = Math.min(this.chaseSpeed, this.wanderSpeed * 1.7);
        break;
      }
      case 'chase': {
        if (!target || !this.lastKnown) {
          this.loseTarget();
          break;
        }
        const seenRecently = sim.time - this.lastSeen < 0.6;
        if (seenRecently) this.lastKnown = { ...target.motion.pos };
        const tp = target.motion.pos;
        const d = dist2D(this.pos, tp);
        const dy = Math.abs(tp.y - this.pos.y);
        if (seenRecently && d < this.def.attackRange && dy < 1.2 && this.attackCd <= 0) {
          this.setState('attack');
          sim.emit({ type: 'zombieAttack', zombie: this.id, target: target.id });
          break;
        }
        const myNode = sim.nav.nodeAt(this.pos.x, this.pos.y, this.pos.z, 1);
        const direct = seenRecently && dy < 1.0 && (d < 1.6 || sim.nav.walkableLine(myNode, sim.nav.nodeAt(tp.x, tp.y, tp.z, 1)));
        if (direct) {
          wishX = tp.x - this.pos.x;
          wishZ = tp.z - this.pos.z;
          const l = Math.hypot(wishX, wishZ) || 1;
          wishX /= l;
          wishZ /= l;
          this.path.length = 0;
        } else {
          if (!this.pathTarget || dist2D(this.pathTarget, this.lastKnown) > 1.5 || sim.time > this.repathAt) {
            this.goal = { ...this.lastKnown };
            this.needPath = true;
          }
          [wishX, wishZ] = this.follow();
          if (this.arrived(1.2) && sim.time - this.lastSeen > 2.5) {
            // Lost them: search around the last place they were seen.
            this.home = { ...this.lastKnown };
            this.target = null;
            this.setState('wander');
            this.goal = null;
            this.wanderUntil = sim.time + 8 + this.rand() * 6;
          }
        }
        if (sim.time - this.lastSeen > 14) this.loseTarget();
        speed = this.chaseSpeed * (d < 2.5 ? 0.85 : 1);
        break;
      }
      case 'attack': {
        this.attackT += dt;
        if (target) {
          faceX = target.motion.pos.x - this.pos.x;
          faceZ = target.motion.pos.z - this.pos.z;
        }
        if (this.attackT < this.def.windup) {
          wishX = faceX;
          wishZ = faceZ;
          const l = Math.hypot(wishX, wishZ) || 1;
          wishX /= l;
          wishZ /= l;
          speed = 0.35;
        }
        if (!this.landed && this.attackT >= this.def.windup) {
          this.landed = true;
          if (target && target.alive) {
            const tp = target.motion.pos;
            const d = dist2D(this.pos, tp);
            const ang = Math.abs(angleDiff(Math.atan2(tp.x - this.pos.x, tp.z - this.pos.z), this.facing));
            const clear = sim.physics.raycast(this.chest.x, this.chest.y, this.chest.z, (tp.x - this.pos.x) / (d || 1), 0, (tp.z - this.pos.z) / (d || 1), d);
            if (d < this.def.attackRange + 0.5 && ang < 1.25 && Math.abs(tp.y - this.pos.y) < 1.2 && (clear === null || clear > d - 0.4)) {
              // Missing arms claw less; with none left it can only bite.
              const reach = 1 - LIMBS.attackLoss * this.armsLost;
              const dmg = Math.round((this.def.damage[0] + this.rand() * (this.def.damage[1] - this.def.damage[0])) * reach);
              sim.damagePlayer(target, dmg, this.pos);
            }
          }
        }
        if (this.attackT >= this.def.windup + 0.45) {
          this.attackCd = Math.max(0.2, this.def.cooldown - this.def.windup - 0.45);
          this.setState(target ? 'chase' : 'wander');
        }
        break;
      }
      case 'bash': {
        const door = sim.doors[this.bashDoor];
        if (!door || door.open) {
          this.setState(this.target ? 'chase' : 'investigate');
          this.needPath = true;
          break;
        }
        faceX = door.center.x - this.pos.x;
        faceZ = door.center.z - this.pos.z;
        // The one it hunts is out here after all (left by another door): go after them.
        if (target && sim.time - this.lastSeen < 1.5 && door.side(target.motion.pos.x, target.motion.pos.z) === door.side(this.pos.x, this.pos.z)) {
          this.setState('chase');
          this.needPath = true;
          break;
        }
        if (sim.time > this.bashAt) {
          this.bashAt = sim.time + 0.85 + this.rand() * 0.35;
          this.attackT = 0;
          sim.emit({ type: 'doorPound', door: door.index, pos: { ...this.pos } });
          // The pounding carries: others nearby come to help.
          sim.noise(door.center, 14, `z${this.id}`);
          if (door.pound(this.def.bash * (1 - LIMBS.bashLoss * this.armsLost), this.pos.x, this.pos.z)) {
            sim.emit({ type: 'doorForced', door: door.index, pos: { ...door.center } });
          }
        }
        this.attackT += dt;
        if (this.stateT > 30) this.wander();
        break;
      }
      case 'stagger': {
        this.staggerT -= dt;
        const k = Math.exp(-dt * 5);
        this.push.x *= k;
        this.push.z *= k;
        if (this.staggerT <= 0) {
          const next = this.resumeState === 'stagger' || this.resumeState === 'down' ? 'chase' : this.resumeState;
          if (next === 'chase' && !this.target) this.wander();
          else this.setState(next);
          this.needPath = true;
        }
        break;
      }
      case 'down': {
        this.downT -= dt;
        if (this.downT <= 0) {
          this.setState(this.target ? 'chase' : 'wander');
          this.needPath = true;
        }
        break;
      }
      default:
        break;
    }

    if (sim.time < this.detourUntil && (wishX !== 0 || wishZ !== 0)) {
      wishX = this.detourX;
      wishZ = this.detourZ;
    }
    this.move(dt, wishX, wishZ, speed, faceX, faceZ);
  }

  private loseTarget(): void {
    this.target = null;
    if (this.state === 'chase' || this.state === 'attack') {
      this.home = this.lastKnown ? { ...this.lastKnown } : { ...this.pos };
      this.setState('wander');
      this.goal = null;
      this.wanderUntil = this.sim.time + 6;
    }
  }

  private arrived(radius: number): boolean {
    if (!this.goal) return true;
    return dist2D(this.pos, this.goal) < radius && Math.abs(this.goal.y - this.pos.y) < 1.4;
  }

  /** Direction along the current path, planning one when needed (the sim rations planning). */
  private follow(): [number, number] {
    const sim = this.sim;
    if (this.needPath && this.goal && sim.requestPathBudget()) {
      this.needPath = false;
      this.repathAt = sim.time + 1.2 + this.rand() * 0.8;
      const res = sim.nav.findPath(this.pos, this.goal, {
        maxExpand: 6000,
        seed: this.seed,
        doorCost: (i) => {
          const d = sim.doors[i];
          // Hunting zombies will break a door down; idle ones walk around closed houses.
          return d && !d.open ? (this.state === 'wander' ? 60 : 6) : 0;
        },
      });
      this.path = res ? this.alignDoors(res.points) : [];
      this.pathDoors = res ? res.doors : [];
      this.pathI = this.path.length > 1 ? 1 : 0;
      this.pathTarget = { ...this.goal };
      if (res && !res.complete) this.repathAt = sim.time + 0.6;
    }
    while (this.pathI < this.path.length) {
      const wp = this.path[this.pathI];
      const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const last = this.pathI === this.path.length - 1;
      if (d < (last ? 0.3 : 0.55)) {
        if (Math.abs(wp.y - this.pos.y) < 0.7) {
          this.pathI++;
          continue;
        }
        // Under or beside the waypoint on another level (missed the stairs): plan again.
        if (!this.needPath) this.needPath = true;
      }
      return [dx / d, dz / d];
    }
    if (this.goal && !this.arrived(0.6) && this.path.length === 0) {
      const dx = this.goal.x - this.pos.x, dz = this.goal.z - this.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      return [dx / d, dz / d];
    }
    return [0, 0];
  }

  private move(dt: number, wishX: number, wishZ: number, speed: number, faceX: number, faceZ: number): void {
    const sim = this.sim;
    // Separation from other zombies so crowds spread instead of stacking.
    let sx = 0, sz = 0;
    for (const o of sim.zombies) {
      if (o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      if (Math.abs(dx) > SEPARATION || Math.abs(dz) > SEPARATION || Math.abs(o.pos.y - this.pos.y) > 1.5) continue;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) {
        sx += this.rand() - 0.5;
        continue;
      }
      if (d < SEPARATION) {
        const w = (1 - d / SEPARATION) / d;
        sx += dx * w;
        sz += dz * w;
      }
    }
    let tx = wishX * speed, tz = wishZ * speed;
    if (this.state !== 'stagger' && this.state !== 'down' && this.state !== 'bash') {
      tx += sx * 1.4;
      tz += sz * 1.4;
    }
    // Facing: turn toward travel; slow down while turning sharply (turn-in-place shuffle).
    const fx = faceX || tx, fz = faceZ || tz;
    if (Math.hypot(fx, fz) > 0.05) {
      const want = Math.atan2(fx, fz);
      const diff = angleDiff(want, this.facing);
      const maxTurn = this.def.turnRate * dt * (this.state === 'attack' ? 0.6 : 1);
      const turn = clamp(diff, -maxTurn, maxTurn);
      this.facing += turn;
      this.turnRate = turn / Math.max(dt, 1e-4);
      if (Math.abs(diff) > 1.3 && this.state !== 'stagger') {
        tx *= 0.25;
        tz *= 0.25;
      }
    } else {
      this.turnRate *= 0.8;
    }
    if (this.state === 'stagger') {
      tx = this.push.x;
      tz = this.push.z;
    } else if (this.state === 'down') {
      tx = tz = 0;
    }
    const k = 1 - Math.exp(-dt * (this.state === 'stagger' ? 12 : 6));
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.z += (tz - this.vel.z) * k;
    this.vy += -19.6 * dt;
    // No downward push while grounded: snap-to-ground holds the feet down, and a slanted move
    // defeats autostep at walking speed (zombies would stall on door thresholds).
    if (this.grounded && this.vy < 0) this.vy = 0;

    const ctrl = sim.zombieController;
    ctrl.computeColliderMovement(this.collider, { x: this.vel.x * dt, y: this.vy * dt, z: this.vel.z * dt }, undefined, ZOMBIE_GROUPS);
    const m = ctrl.computedMovement();
    this.grounded = ctrl.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0;
    const t = this.body.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.body.setNextKinematicTranslation(next);
    this.pos.x = next.x;
    this.pos.y = next.y - this.def.height / 2 - 0.02;
    this.pos.z = next.z;
    this.moveSpeed = Math.hypot(m.x, m.z) / Math.max(dt, 1e-4);
    if (this.pos.y < -20) this.setState('dead');

    // Stuck: wanted to move but barely did. A closed door in the way gets pounded on.
    const wants = Math.hypot(tx, tz) > 0.3 && this.state !== 'stagger' && this.state !== 'attack';
    this.progressT += dt;
    if (this.progressT > 0.8) {
      const moved = dist2D(this.pos, this.progressRef);
      this.progressT = 0;
      this.progressRef.x = this.pos.x;
      this.progressRef.y = this.pos.y;
      this.progressRef.z = this.pos.z;
      if (wants && moved < 0.25) this.stuckT += 0.8;
      else this.stuckT = 0;
      if (this.stuckT > 0) this.unstick(tx, tz);
    }
  }

  private unstick(wx: number, wz: number): void {
    const sim = this.sim;
    const door = sim.closedDoorNear(this.pos, 1.6);
    // Only a door it means to go through: one on its route, or one between it and its quarry.
    const wanted = door && (this.pathDoors.includes(door.index)
      || (this.lastKnown !== null && door.side(this.lastKnown.x, this.lastKnown.z) !== door.side(this.pos.x, this.pos.z)));
    if (door && wanted && (this.state === 'chase' || this.state === 'investigate' || this.state === 'approach')) {
      this.setState('bash');
      this.bashDoor = door.index;
      this.bashAt = sim.time + 0.3;
      return;
    }
    this.sidestep(wx, wz);
    if (this.stuckT >= 1.6) {
      // Try a slightly different route, then give up on the goal.
      this.needPath = true;
      if (this.goal && this.stuckT >= 4) {
        const n = sim.nav.randomNear(this.pos.x, this.pos.y, this.pos.z, 4, this.rand);
        if (n >= 0) this.goal = sim.nav.nodePos(n);
        this.stuckT = 0;
      }
    }
  }

  /**
   * Stuck against something the grid thinks it can walk past (a car's corner, a crowd, a
   * jamb): step for a moment toward an open neighbouring cell well off the blocked heading.
   */
  private sidestep(wx: number, wz: number): void {
    const sim = this.sim;
    const nav = sim.nav;
    const n = nav.nodeAt(this.pos.x, this.pos.y, this.pos.z, 1);
    const wl = Math.hypot(wx, wz);
    if (n < 0 || wl < 1e-3) return;
    wx /= wl;
    wz /= wl;
    const px = nav.nodeX(n), pz = nav.nodeZ(n);
    // Keep circling the same way while stuck on the same thing.
    const hand = this.detourX * wz - this.detourZ * wx > 0 ? 1 : this.detourX || this.detourZ ? -1 : this.rand() < 0.5 ? 1 : -1;
    let best = -Infinity, bx = 0, bz = 0;
    for (let d = 0; d < 8; d++) {
      const m = nav.link(n, d);
      if (m < 0 || !nav.reachable(m)) continue;
      let dx = nav.nodeX(m) - px, dz = nav.nodeZ(m) - pz;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const along = dx * wx + dz * wz;
      if (along > 0.75 || along < -0.35) continue;
      const beyond = nav.link(m, d);
      let score = along;
      if (nav.flags[m] & NAV_NEAR_WALL) score -= 0.6;
      score += beyond >= 0 && nav.reachable(beyond) ? 0.3 : -0.5;
      score += 0.2 * hand * Math.sign(dx * wz - dz * wx) + this.rand() * 0.1;
      if (score > best) {
        best = score;
        bx = dx;
        bz = dz;
      }
    }
    if (best === -Infinity) return;
    this.detourX = bx;
    this.detourZ = bz;
    this.detourUntil = sim.time + 0.6 + this.rand() * 0.4;
  }

  /**
   * Door cells sit on the 0.5 m grid, which rarely lines up with the opening, so a doorway
   * waypoint can be a quarter metre off its centre: enough for a broad zombie to catch the
   * frame. Each run of waypoints in one doorway becomes a point just before and one just past
   * the opening, on its centre line.
   */
  private alignDoors(points: Vec3[]): Vec3[] {
    const sim = this.sim;
    const nav = sim.nav;
    const doorAt = (p: Vec3) => {
      const n = nav.nodeAt(p.x, p.y, p.z, 0);
      return n >= 0 ? nav.door[n] : -1;
    };
    const out: Vec3[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const di = i > 0 && i < points.length - 1 ? doorAt(p) : -1;
      if (di < 0) {
        out.push(p);
        continue;
      }
      let j = i;
      while (j + 1 < points.length - 1 && doorAt(points[j + 1]) === di) j++;
      const spec = sim.map.doors[di];
      const nx = spec.axis === 'x' ? 0 : 1, nz = spec.axis === 'x' ? 1 : 0;
      const prev = out[out.length - 1];
      const side = Math.sign((prev.x - spec.x) * nx + (prev.z - spec.z) * nz) || 1;
      const y = spec.floorY ?? p.y;
      const at = (k: number): Vec3 | null => {
        const x = spec.x + nx * k, z = spec.z + nz * k;
        const m = nav.nodeAt(x, y, z, 0.3);
        return nav.reachable(m) ? { x, y: nav.nodeY[m], z } : null;
      };
      const before = at(side * 0.7), after = at(-side * 0.7);
      if (before && after) {
        // Already at the opening: don't step back to line up.
        if (Math.hypot(prev.x - spec.x, prev.z - spec.z) > 0.9) out.push(before);
        out.push(after);
      } else {
        // Something stands right behind the door: keep the grid's waypoints, centred in the opening.
        for (let k = i; k <= j; k++) {
          const q = points[k];
          out.push(spec.axis === 'x' ? { x: spec.x, y: q.y, z: q.z } : { x: q.x, y: q.y, z: spec.z });
        }
      }
      i = j;
    }
    return out;
  }

  /** Whether it stands inside a building (for the spawner and despawning). */
  indoors(): boolean {
    const n = this.sim.nav.nodeAt(this.pos.x, this.pos.y, this.pos.z, 0.5);
    return n >= 0 && (this.sim.nav.flags[n] & NAV_INDOOR) !== 0;
  }

  /** Swipe progress 0..1 for the animation (-1 when not attacking). */
  get attackPhase(): number {
    if (this.state === 'attack') return clamp(this.attackT / (this.def.windup + 0.45), 0, 1);
    if (this.state === 'bash') return clamp(this.attackT / 0.8, 0, 1);
    return -1;
  }

  removeBody(): void {
    const w = this.sim.physics.world;
    w.removeRigidBody(this.body);
  }
}
