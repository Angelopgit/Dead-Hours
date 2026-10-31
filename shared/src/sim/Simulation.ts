import { RAPIER, GROUP, groups, type Physics, type RayHit } from '../physics/Physics';
import type { DoorBody } from '../physics/DoorBody';
import { COMBAT, PRIMARY_WEAPONS, WEAPONS, ZONE_MULTIPLIER, type HitZone, type WeaponDef, type WeaponId } from '../config/weapons';
import { GAME } from '../config/game';
import { DOWNED, PLAYER } from '../config/player';
import { HORDES, SPAWNING, SPECIALS, type ZombieKind } from '../config/zombies';
import { SERUM, SUPPLY_DROPS, caseSpot } from '../config/drops';
import { LEGS, LIMBS, isLeg, limbClub, type ArmCut, type ArmZone, type LegCut, type LegZone } from '../config/limbs';
import { MELEE, MELEE_PICKUPS, isMelee, type MeleeId } from '../config/melee';
import { findPickupRooms, pickFoundWeapon, type PickupRoom } from './MeleePickups';
import { THROWABLES, THROWING, type ThrowKind } from '../config/throwables';
import { propOccluders } from '../map/colliders';
import { decodeAppearance, encodeAppearance } from '../config/appearance';
import { encodeBuild, type Loadout, type WeaponBuild } from '../config/progression';
import type { MapDefinition } from '../types/world';
import { Arsenal, type ArsenalTick, type HeldLimb } from './Arsenal';
import { NAV_INDOOR, NAV_NEAR_WALL, NAV_REACHABLE, type NavGrid } from './NavGrid';
import { rayZones, along, type ZoneShape } from './hitzones';
import { ZOMBIE_STEP, Zombie } from './Zombie';
import { Raid } from './Raid';
import { hordeAt, hordeBonus, hordeRunnerBoost, type HordeState } from './Hordes';
import { Barricades, type BarricadeSlot } from './Barricades';
import { BARRICADE } from '../config/barricades';
import { clamp, dist2D, quatFromUp, rng, rotate, v3, type Quat, type Vec3 } from './math';
import type { GibPart, HeliFlight, PelletTrace, SimEvent, SimPhase } from './events';
import { Explosives } from './Explosives';

/** Movement state of a player, fed from the character controller every step. */
export interface PlayerMotion {
  pos: Vec3;
  vel: Vec3;
  /** Camera yaw/pitch (aim direction). */
  yaw: number;
  pitch: number;
  eyeHeight: number;
  crouching: boolean;
  sprinting: boolean;
  aiming: boolean;
  grounded: boolean;
  /** Their flashlight is switched on (others see the beam online). */
  light?: boolean;
}

export interface PlayerStats {
  kills: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
  suppliesCollected: number;
  damageTaken: number;
  /** Arms shot or cut off zombies. */
  limbsSevered: number;
  /** Zombies beaten to death with a severed arm. */
  limbKills: number;
  /** Teammates picked back up. */
  revives: number;
}

export class SimPlayer {
  health: number = PLAYER.maxHealth;
  alive = true;
  readonly arsenal: Arsenal;
  bandages: number = COMBAT.startBandages;
  /** Lazarus serum armor left: soaks up part of every zombie hit (SERUM). */
  armor = 0;
  readonly motion: PlayerMotion;
  readonly stats: PlayerStats = { kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0, suppliesCollected: 0, damageTaken: 0, limbsSevered: 0, limbKills: 0, revives: 0 };
  /** The crosshair ray the last melee swing was aimed with (decides what it lands on). */
  meleeAim: { origin: Vec3; dir: Vec3 } | null = null;
  /** Where the throw in progress goes (the crosshair ray when it was started). */
  throwAim: { origin: Vec3; dir: Vec3 } | null = null;
  footstepT = 0;
  diedAt = 0;
  /** On the ground at zero health, bleeding out until a teammate gets them up (still `alive`). */
  downed = false;
  /** Seconds of bleeding left while downed. */
  bleed = 0;
  /** Times downed this night. */
  downs = 0;
  /** Who is holding interact on them, and for how long so far. */
  reviver: string | null = null;
  revive = 0;
  /** Wire form of the survivor's look (encodeAppearance), for the clients that render them. */
  appearance = '';
  /** Nailing boards up or prying them off, while the key is held. */
  work: { slot: number; kind: 'board' | 'pry'; t: number; hammerT: number } | null = null;

  constructor(readonly id: string, readonly name: string, primary: WeaponId, secondary: WeaponId, spawn: Vec3, yaw: number, builds: Loadout = {}) {
    this.arsenal = new Arsenal(primary, secondary, builds);
    this.motion = {
      pos: { ...spawn }, vel: v3(), yaw, pitch: 0, eyeHeight: PLAYER.eyeHeight,
      crouching: false, sprinting: false, aiming: false, grounded: true,
    };
  }

  get eye(): Vec3 {
    const m = this.motion;
    return { x: m.pos.x, y: m.pos.y + m.eyeHeight, z: m.pos.z };
  }

  get chest(): Vec3 {
    const m = this.motion;
    return { x: m.pos.x, y: m.pos.y + m.eyeHeight * 0.72, z: m.pos.z };
  }

  get speed(): number {
    return Math.hypot(this.motion.vel.x, this.motion.vel.z);
  }

  /** Alive and on their feet: can fight, use things and revive others. */
  get up(): boolean {
    return this.alive && !this.downed;
  }
}

export interface Noise {
  pos: Vec3;
  radius: number;
  time: number;
  source: string | null;
}

export type InteractKind = 'weapons' | 'ammo' | 'medical' | 'supply' | 'exclusive' | 'serum' | 'melee';

export interface Interactable {
  id: number;
  kind: InteractKind;
  pos: Vec3;
  /** Uses left (ammo crates, first aid boxes); weapon tables are unlimited. */
  supply: number;
  range: number;
  /** Supply crates: how many times each survivor has taken from it. */
  takenBy?: Map<string, number>;
  /** Weapon cases from a supply drop: the exclusive gun inside. Found melee weapons: which one. */
  weapon?: WeaponId;
  /** Found melee weapons: the room it lies in (one room holds only so many). */
  room?: string;
}

/** One helicopter supply drop, from the flight in to the crate being emptied or taken away. */
export interface SupplyDrop {
  id: number;
  flight: HeliFlight;
  stage: 'inbound' | 'falling' | 'landed' | 'gone';
  /** Interactable index once landed, else -1. */
  interactable: number;
  body: RAPIER.RigidBody | null;
  /** Exclusive weapon in a case beside the crate (rare), and that case's interactable (-1 until landed). */
  weapon: WeaponId | null;
  caseItem: number;
  /** A Lazarus serum on the crate's other side (rare), and its interactable (-1 until landed). */
  serum: boolean;
  serumItem: number;
}

/**
 * A severed arm or leg: tumbling and lying about as a physics body, or in a survivor's hands
 * (`holder`, no body). Its pose is the capsule's centre, with local +Y toward the cut end.
 */
export interface SimLimb extends HeldLimb {
  holder: string | null;
  body: RAPIER.RigidBody | null;
  pos: Vec3;
  rot: Quat;
  /** Pose at the previous step (render interpolation). */
  prevPos: Vec3;
  prevRot: Quat;
  /** Cut end to fingertips, and thickness. */
  length: number;
  radius: number;
  /** When it came off, and when it was last let go of (lying-around timer). */
  bornAt: number;
  looseAt: number;
}

export interface SimOptions {
  physics: Physics;
  map: MapDefinition;
  nav: NavGrid;
  doors: (DoorBody | null)[];
  seed?: number;
  /** Seconds of preparation before the outbreak. */
  preparation?: number;
}

/** Bullet damage that bursts a closed door open (an AR round is about 30). */
const COMBAT_DOOR_HP = 420;

const FALLOFF = (def: WeaponDef, t: number): number => {
  const r = def.range;
  if (t <= r * COMBAT.falloffStart) return 1;
  if (t <= r) return 1 - (1 - COMBAT.falloffMin) * ((t - r * COMBAT.falloffStart) / (r * (1 - COMBAT.falloffStart)));
  return COMBAT.falloffMin * 0.5;
};

/** Random direction inside a cone around `d` (unit) with half-angle `deg`. */
function cone(d: Vec3, deg: number, rand: () => number): Vec3 {
  const a = (deg * Math.PI) / 180 * Math.sqrt(rand());
  const phi = rand() * Math.PI * 2;
  // Orthonormal basis around d.
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

/**
 * Authoritative combat and survival simulation: players' weapons and health, zombies, noise,
 * interactables and the phase clock. Runs at the physics rate; the caller steps the Rapier
 * world after each step. Solo play runs it in the browser, the Phase 4 room on the server.
 */
export class Simulation {
  readonly physics: Physics;
  readonly map: MapDefinition;
  readonly nav: NavGrid;
  readonly doors: (DoorBody | null)[];
  readonly players = new Map<string, SimPlayer>();
  readonly zombies: Zombie[] = [];
  readonly noises: Noise[] = [];
  readonly interactables: Interactable[] = [];
  readonly zombieController: RAPIER.KinematicCharacterController;
  /** The same without stepping up, which costs about half again: tried first (see Zombie.move). */
  readonly zombieWalker: RAPIER.KinematicCharacterController;
  time = 0;
  phase: SimPhase = 'preparation';
  /** Seconds left in preparation, or survived so far. */
  phaseTime: number;
  private events: SimEvent[] = [];
  private nextZombieId = 1;
  private spawnAt = 0;
  private pathBudget = 0;
  /** Steps run while zombies were held (see step()): their path searches are saved up for the next. */
  private heldSteps = 0;
  private stepDt = 1 / 60;
  private readonly rand: () => number;
  private readonly outdoorNodes: Int32Array;
  private readonly zones: ZoneShape[] = [];
  private lookCounter = 0;
  readonly drops: SupplyDrop[] = [];
  /** Survival time of the next supply drop. */
  private nextDropAt: number = SUPPLY_DROPS.firstAt;
  /** Things a drop must not come down on: tree crowns, lamp arms, poles, canopies. */
  private readonly overhead: { x: number; z: number; r: number }[] = [];
  /** Severed arms, loose or held. */
  readonly limbs: SimLimb[] = [];
  /** The van raid (once a night, see Raid.ts). */
  readonly raid: Raid;
  private nextLimbId = 1;
  /** Rooms found melee weapons turn up in (worked out on first use), and when the next one appears. */
  private pickupRooms: PickupRoom[] | null = null;
  /** Its own random stream, so placing weapons never shifts the zombies' rolls. */
  private readonly pickRand: () => number;
  private nextPickupAt = 0;
  /** Where the night is in the horde schedule (see Hordes.ts), as of the last survival step. */
  horde: HordeState = hordeAt(0);
  /** Bloaters killed and waiting to burst (a blast can set off another: they go in turn). */
  private readonly bursts: { z: Zombie; by: SimPlayer }[] = [];
  private bursting = false;
  /** Boards on the doors and windows of the homes. */
  readonly barricades: Barricades;
  private readonly doorByCollider = new Map<number, DoorBody>();
  /** Grenades and Molotovs in the air, and fires burning. */
  readonly explosives: Explosives;

  constructor(opts: SimOptions) {
    this.physics = opts.physics;
    this.map = opts.map;
    this.nav = opts.nav;
    this.doors = opts.doors;
    this.rand = rng(opts.seed ?? 1);
    this.pickRand = rng(((opts.seed ?? 1) * 7919 + 13) >>> 0);
    this.raid = new Raid(this, opts.seed ?? 1);
    this.phaseTime = opts.preparation ?? GAME.preparationSeconds;
    const controller = (step: boolean) => {
      const ctrl = this.physics.world.createCharacterController(0.02);
      ctrl.setUp({ x: 0, y: 1, z: 0 });
      if (step) ctrl.enableAutostep(ZOMBIE_STEP, 0.15, false);
      ctrl.enableSnapToGround(0.35);
      ctrl.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
      ctrl.setMinSlopeSlideAngle((60 * Math.PI) / 180);
      ctrl.setSlideEnabled(true);
      return ctrl;
    };
    this.barricades = new Barricades(this.map, this.nav, this.doors, this.physics);
    for (const d of this.doors) if (d) this.doorByCollider.set(d.collider.handle, d);
    this.zombieController = controller(true);
    this.zombieWalker = controller(false);
    this.explosives = new Explosives(this);

    const nodes: number[] = [];
    const nav = this.nav;
    for (let i = 0; i < nav.nodeCount; i++) {
      const f = nav.flags[i];
      if (f & NAV_REACHABLE && !(f & NAV_INDOOR)) nodes.push(i);
    }
    this.outdoorNodes = Int32Array.from(nodes);

    let id = 0;
    for (const p of this.map.props) {
      const y = p.y ?? 0;
      if (p.kind === 'ammoCrate') this.interactables.push({ id: id++, kind: 'ammo', pos: { x: p.x, y: y + 0.45, z: p.z }, supply: COMBAT.crateUses, range: COMBAT.interactRange });
      else if (p.kind === 'firstAid') this.interactables.push({ id: id++, kind: 'medical', pos: { x: p.x, y: y, z: p.z }, supply: COMBAT.aidBoxBandages, range: COMBAT.interactRange });
      else if (p.use === 'weapons') this.interactables.push({ id: id++, kind: 'weapons', pos: { x: p.x, y: y + 0.95, z: p.z }, supply: Infinity, range: 2.1 });
      for (const o of propOccluders(p)) this.overhead.push({ x: o.x, z: o.z, r: o.r });
      if (p.kind === 'streetlight' || p.kind === 'utilityPole' || p.kind === 'floodlight' || p.kind === 'signPylon' || p.kind === 'parkLamp') {
        this.overhead.push({ x: p.x, z: p.z, r: 2.8 });
      } else if (p.kind === 'gazebo' || p.kind === 'tent' || p.kind === 'shed') {
        this.overhead.push({ x: p.x, z: p.z, r: 3.4 });
      }
    }
  }

  /** The simulation's seeded random numbers (0..1). */
  get random(): () => number {
    return this.rand;
  }

  emit(e: SimEvent): void {
    this.events.push(e);
  }

  /** Events since the last drain, oldest first. */
  drain(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** `builds` must already be checked against the player's unlocks (sanitizeLoadout). */
  addPlayer(id: string, name: string, primary: WeaponId, secondary: WeaponId, spawn: Vec3, yaw: number, appearance = '', builds: Loadout = {}): SimPlayer {
    const p = new SimPlayer(id, name, primary, secondary, spawn, yaw, builds);
    p.appearance = encodeAppearance(decodeAppearance(appearance));
    this.players.set(id, p);
    return p;
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (p) {
      this.dropLimb(p, false);
      this.dropMelee(p);
    }
    this.players.delete(id);
    this.stopRevive(id);
    // The last one standing left: nobody is coming for the downed.
    if (p?.up) this.checkWipe();
  }

  setMotion(id: string, m: Partial<PlayerMotion>): void {
    const p = this.players.get(id);
    if (!p) return;
    Object.assign(p.motion, m);
  }

  noise(pos: Vec3, radius: number, source: string | null): void {
    this.noises.push({ pos: { ...pos }, radius, time: this.time, source });
  }

  /** Path planning is rationed so a crowd replanning at once can't stall a step. */
  requestPathBudget(): boolean {
    if (this.pathBudget <= 0) return false;
    this.pathBudget--;
    return true;
  }

  alertNearby(from: Zombie, at: Vec3): void {
    for (const z of this.zombies) {
      if (z === from || !z.alive || z.engaged) continue;
      if (dist2D(z.pos, from.pos) < 13 && Math.abs(z.pos.y - from.pos.y) < 3) z.investigate(at, 3);
    }
  }

  closedDoorNear(pos: Vec3, radius: number): DoorBody | null {
    let best: DoorBody | null = null;
    let bestD = radius;
    for (const d of this.doors) {
      if (!d || d.open) continue;
      const dd = Math.hypot(d.center.x - pos.x, d.center.z - pos.z);
      if (dd < bestD && Math.abs(d.center.y - 1.1 - pos.y) < 1.2) {
        bestD = dd;
        best = d;
      }
    }
    return best;
  }

  /** A boarded-up door won't open until the boards come off. */
  doorLocked(door: number): boolean {
    return (this.barricades.forDoor(door)?.boards ?? 0) > 0;
  }

  /** A zombie pounding on a closed door: boards first, then the door itself. Returns true when it bursts open. */
  poundDoor(door: DoorBody, amount: number, fromX: number, fromZ: number): boolean {
    const slot = this.barricades.forDoor(door.index);
    if (slot && slot.boards > 0) {
      if (this.barricades.pound(slot, amount)) this.boardBroke(slot);
      return false;
    }
    return door.pound(amount, fromX, fromZ);
  }

  /**
   * A zombie at a window: the first blow smashes the glass, the next ones work on the boards.
   * Returns true once the way is clear.
   */
  poundWindow(slot: BarricadeSlot, amount: number, from: Vec3): boolean {
    const b = this.barricades;
    if (b.breakGlass(slot)) {
      this.emit({ type: 'glassBroken', slot: slot.index, pos: { ...slot.center }, dir: { x: -slot.normal.x * b.side(slot, from.x, from.z), y: 0, z: -slot.normal.z * b.side(slot, from.x, from.z) } });
      this.noise(slot.center, 18, null);
    } else if (slot.boards > 0) {
      this.emit({ type: 'barricadeHit', slot: slot.index, pos: { ...slot.center } });
      if (b.pound(slot, amount)) this.boardBroke(slot);
    }
    return b.clear(slot);
  }

  /**
   * A ray for bullets: window panes it meets shatter and it carries on through the empty frame.
   * Returns what finally stops it.
   */
  castThrough(o: Vec3, d: Vec3, maxD: number): RayHit | null {
    for (let i = 0; i < 4; i++) {
      const hit = this.physics.raycastHit(o.x, o.y, o.z, d.x, d.y, d.z, maxD);
      const slot = hit ? this.barricades.forPane(hit.collider.handle) : undefined;
      if (!hit || !slot || !this.barricades.breakGlass(slot)) return hit;
      this.emit({ type: 'glassBroken', slot: slot.index, pos: { x: o.x + d.x * hit.distance, y: o.y + d.y * hit.distance, z: o.z + d.z * hit.distance }, dir: { ...d } });
      this.noise(slot.center, 18, null);
    }
    return this.physics.raycastHit(o.x, o.y, o.z, d.x, d.y, d.z, maxD);
  }

  /** A bullet in a closed door: it splinters boards first, then works the latch loose until the door swings in. */
  shootDoor(door: DoorBody, damage: number, from: Vec3): void {
    if (door.open) return;
    if (this.poundDoor(door, damage / COMBAT_DOOR_HP, from.x, from.z)) this.emit({ type: 'doorForced', door: door.index, pos: { ...door.center } });
  }

  private boardBroke(slot: BarricadeSlot): void {
    this.emit({ type: 'barricade', slot: slot.index, boards: slot.boards, change: 'broken', player: null, pos: { ...slot.center } });
  }

  /** Whether a survivor can work on a slot from where they stand: inside, within reach. */
  canWork(p: SimPlayer, slot: BarricadeSlot): boolean {
    if (!p.up || this.revivingOf(p.id)) return false;
    const e = p.eye, c = slot.center;
    if (Math.hypot(e.x - c.x, (e.y - c.y) * 0.5, e.z - c.z) > BARRICADE.reach) return false;
    return this.barricades.side(slot, p.motion.pos.x, p.motion.pos.z) < 0;
  }

  /** What working on a slot would do now: nail a board, pry one off, or nothing. */
  workFor(p: SimPlayer, slot: BarricadeSlot, kind: 'board' | 'pry'): boolean {
    if (!this.canWork(p, slot)) return false;
    if (kind === 'pry') return slot.boards > 0;
    if (slot.boards >= slot.max) return false;
    // A door is boarded shut, not open.
    if (slot.kind === 'door' && this.doors[slot.ref]?.open) return false;
    return true;
  }

  /** Starts (or, with slot -1, stops) nailing boards up or prying them off; it carries on board after board. */
  barricade(id: string, slot: number, kind: 'board' | 'pry' = 'board'): boolean {
    const p = this.players.get(id);
    if (!p) return false;
    const s = this.barricades.slots[slot];
    if (!s || this.phase === 'over' || !this.workFor(p, s, kind)) {
      p.work = null;
      return false;
    }
    if (p.work && p.work.slot === slot && p.work.kind === kind) return true;
    p.work = { slot, kind, t: 0, hammerT: 0 };
    return true;
  }

  private updateWork(p: SimPlayer, dt: number): void {
    const w = p.work;
    if (!w) return;
    const s = this.barricades.slots[w.slot];
    const busy = p.arsenal.action === 'melee' || p.arsenal.action === 'bandage';
    if (!s || busy || !this.workFor(p, s, w.kind)) {
      p.work = null;
      return;
    }
    w.t += dt;
    if (w.kind === 'board') {
      w.hammerT -= dt;
      if (w.hammerT <= 0) {
        w.hammerT = BARRICADE.hammerEvery;
        this.emit({ type: 'hammer', slot: s.index, player: p.id, pos: { ...s.center } });
        this.noise(s.center, BARRICADE.hammerNoise, p.id);
      }
    }
    if (w.t < (w.kind === 'board' ? BARRICADE.boardTime : BARRICADE.pryTime)) return;
    w.t = 0;
    w.hammerT = 0;
    if (w.kind === 'board') {
      s.boards++;
      s.damage = 0;
    } else {
      s.boards--;
      s.damage = 0;
    }
    this.emit({ type: 'barricade', slot: s.index, boards: s.boards, change: w.kind === 'board' ? 'nailed' : 'pried', player: p.id, pos: { ...s.center } });
    if (!this.workFor(p, s, w.kind)) p.work = null;
  }

  /** Where an approaching zombie should head: near the closest survivor, never exactly at them. */
  approachGoal(z: Zombie): Vec3 | null {
    let best: SimPlayer | null = null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = dist2D(p.motion.pos, z.pos);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return null;
    const pos = best.motion.pos;
    const n = this.nav.randomNear(pos.x, pos.y, pos.z, Math.min(12, 4 + bestD * 0.1), z.rand);
    return n >= 0 ? this.nav.nodePos(n) : { ...pos };
  }

  damagePlayer(p: SimPlayer, damage: number, from: Vec3): void {
    if (!p.alive) return;
    if (p.armor > 0) {
      const soak = Math.min(p.armor, damage * SERUM.absorb);
      p.armor = Math.max(0, p.armor - soak);
      damage = Math.round((damage - soak) * 10) / 10;
    }
    p.stats.damageTaken += damage;
    if (p.downed) {
      // Mauled on the ground: the blood runs out faster.
      p.bleed -= damage * DOWNED.hitBleed;
      this.emit({ type: 'playerHurt', player: p.id, damage, from: { ...from }, health: 0 });
      if (p.bleed <= 0) this.killPlayer(p);
      return;
    }
    p.health = Math.max(0, p.health - damage);
    if (p.arsenal.cancelBandage()) this.emit({ type: 'bandage', player: p.id, stage: 'cancel' });
    this.emit({ type: 'playerHurt', player: p.id, damage, from: { ...from }, health: p.health });
    if (p.health > 0) return;
    if (this.canGoDown(p)) this.downPlayer(p);
    else this.killPlayer(p);
  }

  /** A teammate still on their feet could come for them, and they have a down left. */
  private canGoDown(p: SimPlayer): boolean {
    if (this.phase === 'over' || p.downs >= DOWNED.maxDowns) return false;
    for (const q of this.players.values()) if (q !== p && q.up) return true;
    return false;
  }

  private downPlayer(p: SimPlayer): void {
    p.downed = true;
    p.downs++;
    p.health = 0;
    p.bleed = DOWNED.bleedOut;
    p.reviver = null;
    p.revive = 0;
    p.work = null;
    p.arsenal.cancelReload();
    if (p.arsenal.cancelBandage()) this.emit({ type: 'bandage', player: p.id, stage: 'cancel' });
    this.dropLimb(p, false);
    this.stopRevive(p.id);
    this.emit({ type: 'playerDowned', player: p.id, bleed: p.bleed, last: p.downs >= DOWNED.maxDowns });
  }

  private killPlayer(p: SimPlayer, wipe = true): void {
    if (!p.alive) return;
    p.alive = false;
    p.downed = false;
    p.health = 0;
    p.diedAt = this.time;
    if (p.reviver) this.emit({ type: 'revive', player: p.reviver, target: p.id, stage: 'cancel' });
    p.reviver = null;
    p.revive = 0;
    p.work = null;
    p.arsenal.cancelReload();
    this.dropLimb(p, false);
    this.dropMelee(p);
    this.stopRevive(p.id);
    this.emit({ type: 'playerDied', player: p.id });
    if (wipe) this.checkWipe();
  }

  /** Nobody is left on their feet: the downed bleed out where they lie and the night is over. */
  private checkWipe(): void {
    const ps = [...this.players.values()];
    if (ps.some((q) => q.up)) return;
    for (const q of ps) if (q.downed) this.killPlayer(q, false);
    if (this.phase !== 'over') {
      this.phase = 'over';
      this.emit({ type: 'phase', phase: 'over' });
    }
  }

  /**
   * Starts (or keeps up) picking a downed teammate back up; `target` null lets go. The reviver
   * must stay close: each step counts it down and cancels when they move off or are downed.
   */
  revive(id: string, target: string | null): boolean {
    if (target === null) {
      this.stopRevive(id);
      return true;
    }
    const p = this.players.get(id);
    const t = this.players.get(target);
    if (!p || !t || !p.up || !t.downed || this.phase === 'over' || !this.inReviveReach(p, t)) return false;
    if (t.reviver === id) return true;
    if (t.reviver) return false;
    this.stopRevive(id);
    // Both hands on them: the reload stops and the arm is put down.
    if (p.arsenal.cancelReload()) this.emit({ type: 'reload', player: id, weapon: p.arsenal.weapon.id, stage: 'cancel' });
    if (p.arsenal.cancelBandage()) this.emit({ type: 'bandage', player: id, stage: 'cancel' });
    this.dropLimb(p, false);
    t.reviver = id;
    t.revive = 0;
    this.emit({ type: 'revive', player: id, target, stage: 'start' });
    return true;
  }

  /** Whoever `id` is helping up, let go. */
  stopRevive(id: string): void {
    for (const t of this.players.values()) {
      if (t.reviver !== id) continue;
      t.reviver = null;
      t.revive = 0;
      this.emit({ type: 'revive', player: id, target: t.id, stage: 'cancel' });
    }
  }

  /** The downed teammate `id` is helping up, if any. */
  revivingOf(id: string): SimPlayer | null {
    for (const t of this.players.values()) if (t.reviver === id) return t;
    return null;
  }

  inReviveReach(p: SimPlayer, t: SimPlayer): boolean {
    return dist2D(p.motion.pos, t.motion.pos) < DOWNED.reviveRange && Math.abs(p.motion.pos.y - t.motion.pos.y) < 1.4;
  }

  /** Downed teammates within reach of `id`, nearest first. */
  downedInReach(id: string): SimPlayer[] {
    const p = this.players.get(id);
    if (!p || !p.up) return [];
    const out = [...this.players.values()].filter((t) => t.downed && this.inReviveReach(p, t));
    return out.sort((a, b) => dist2D(a.motion.pos, p.motion.pos) - dist2D(b.motion.pos, p.motion.pos));
  }

  private stepDowned(dt: number): void {
    for (const t of this.players.values()) {
      if (!t.downed) continue;
      if (t.reviver) {
        const r = this.players.get(t.reviver);
        if (r && (!r.up || !this.inReviveReach(r, t))) this.stopRevive(r.id);
        else if (!r) {
          t.reviver = null;
          t.revive = 0;
        }
      }
      if (t.reviver) {
        // Bleeding pauses while someone works on them.
        t.revive += dt;
        if (t.revive < DOWNED.reviveTime) continue;
        const by = t.reviver;
        t.downed = false;
        t.reviver = null;
        t.revive = 0;
        t.bleed = 0;
        t.health = DOWNED.reviveHealth;
        const r = this.players.get(by);
        if (r) r.stats.revives++;
        this.emit({ type: 'revive', player: by, target: t.id, stage: 'end' });
        this.emit({ type: 'playerRevived', player: t.id, by, health: t.health });
        continue;
      }
      t.bleed -= dt;
      if (t.bleed <= 0) this.killPlayer(t);
    }
  }

  // ---------------------------------------------------------------- player intents

  /**
   * Fires the active weapon. `origin`/`dir` are the camera ray the client aimed with; the
   * origin is checked against the shooter's position and every round is traced here.
   */
  fire(id: string, origin: Vec3, dir: Vec3, pressed: boolean, seed: number): 'fired' | 'dry' | 'busy' {
    const p = this.players.get(id);
    if (!p || !p.up || this.phase === 'over' || this.revivingOf(id)) return 'busy';
    const a = p.arsenal;
    // With an arm in hand the trigger finger swings it instead.
    if (a.limb) return pressed && this.melee(id, { origin, dir }) ? 'fired' : 'busy';
    const def = a.def;
    if (!def.auto && !pressed) return 'busy';
    p.work = null;
    const state = a.fireState();
    if (state === 'busy') return 'busy';
    if (state === 'empty') {
      a.dryFire();
      this.emit({ type: 'dryFire', player: id, weapon: a.weapon.id });
      if (a.startReload()) this.emit({ type: 'reload', player: id, weapon: a.weapon.id, stage: 'start' });
      return 'dry';
    }
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    if (!(dl > 0.5)) return 'busy';
    const d = { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl };
    const eye = p.eye;
    let o = origin;
    if (!(Math.hypot(origin.x - eye.x, origin.y - eye.y, origin.z - eye.z) <= COMBAT.maxOriginOffset)) o = eye;
    const spread = a.spread({ speed: p.speed, crouching: p.motion.crouching, grounded: p.motion.grounded, aiming: p.motion.aiming });
    a.consume();
    p.stats.shotsFired++;
    this.noise(p.motion.pos, def.noise, id);
    const rand = rng(seed >>> 0 || 1);
    const pellets: PelletTrace[] = [];
    let anyHit = false;
    for (let i = 0; i < def.pellets; i++) {
      const pd = cone(d, spread, rand);
      const res = this.traceRound(p, o, pd, def);
      if (res.hit === 'zombie') anyHit = true;
      pellets.push(res);
    }
    if (anyHit) p.stats.shotsHit++;
    this.emit({ type: 'shot', player: id, weapon: a.weapon.id, origin: { ...o }, pellets });
    return 'fired';
  }

  private traceRound(p: SimPlayer, o: Vec3, d: Vec3, def: WeaponDef): PelletTrace {
    const maxD = def.range * COMBAT.maxRangeFactor;
    const world = this.castThrough(o, d, maxD);
    const worldD = world ? world.distance : maxD;
    const hits: { z: Zombie; zone: HitZone; t: number; along: number }[] = [];
    for (const z of this.zombies) {
      if (!z.alive) continue;
      // Cheap reject: distance from the zombie's middle to the ray.
      const cx = z.pos.x - o.x, cy = z.pos.y + 0.9 * z.scale - o.y, cz = z.pos.z - o.z;
      const along = cx * d.x + cy * d.y + cz * d.z;
      if (along < -1 || along > worldD + 1) continue;
      const px = cx - d.x * along, py = cy - d.y * along, pz = cz - d.z * along;
      if (px * px + py * py + pz * pz > 2.6) continue;
      const h = rayZones(o, d, z.zones(this.zones), worldD);
      if (h) hits.push({ z, zone: h.zone, t: h.t, along: h.along });
    }
    hits.sort((a, b) => a.t - b.t);
    // A raider in the way stops the round (no rounds pass through people).
    const raider = this.raid.raiders.length ? this.raid.traceHit(o, d, worldD) : null;

    // The camera sees around corners the gun can't: check the line from the eye too.
    const firstT = Math.min(hits.length ? hits[0].t : worldD, raider ? raider.t : worldD);
    const eye = p.eye;
    const tx = o.x + d.x * firstT - eye.x, ty = o.y + d.y * firstT - eye.y, tz = o.z + d.z * firstT - eye.z;
    const L = Math.hypot(tx, ty, tz);
    if (L > 0.6) {
      const ob = this.castThrough(eye, { x: tx / L, y: ty / L, z: tz / L }, L - 0.25);
      if (ob) {
        const pos = { x: eye.x + (tx / L) * ob.distance, y: eye.y + (ty / L) * ob.distance, z: eye.z + (tz / L) * ob.distance };
        this.emit({ type: 'impact', pos, normal: { x: ob.nx, y: ob.ny, z: ob.nz }, surface: ob.surface, dir: { x: tx / L, y: ty / L, z: tz / L } });
        return { end: pos, hit: 'world' };
      }
    }

    let pierced = 0;
    for (const h of hits) {
      if (raider && raider.t < h.t) break;
      const pos = { x: o.x + d.x * h.t, y: o.y + d.y * h.t, z: o.z + d.z * h.t };
      const dmg = def.damage * ZONE_MULTIPLIER[h.zone] * FALLOFF(def, h.t) * Math.pow(0.6, pierced);
      this.hitZombie(p, h.z, dmg, h.zone, pos, d, false, def.pellets > 1 ? 0.5 : 1, { along: h.along, armTally: dmg });
      pierced++;
      if (pierced > def.penetration) return { end: pos, hit: 'zombie' };
    }
    if (raider) {
      const pos = { x: o.x + d.x * raider.t, y: o.y + d.y * raider.t, z: o.z + d.z * raider.t };
      this.raid.hit(p, raider.r, def.damage * FALLOFF(def, raider.t) * Math.pow(0.6, pierced), raider.zone, pos, d);
      return { end: pos, hit: 'zombie' };
    }
    if (world) {
      const pos = { x: o.x + d.x * world.distance, y: o.y + d.y * world.distance, z: o.z + d.z * world.distance };
      this.emit({ type: 'impact', pos, normal: { x: world.nx, y: world.ny, z: world.nz }, surface: world.surface, dir: { ...d } });
      const door = this.doorByCollider.get(world.collider.handle);
      if (door) this.shootDoor(door, def.damage * FALLOFF(def, world.distance), eye);
      return { end: pos, hit: 'world' };
    }
    return { end: { x: o.x + d.x * maxD, y: o.y + d.y * maxD, z: o.z + d.z * maxD }, hit: 'none' };
  }

  /**
   * Applies a hit. `along` is where on the zone it landed (arms: 0 shoulder .. 1 hand) and
   * `armTally` how much it counts toward taking an arm off; `limb` is the arm it was clubbed with.
   */
  hitZombie(
    p: SimPlayer, z: Zombie, damage: number, zone: HitZone, pos: Vec3, dir: Vec3, melee: boolean, force: number,
    opts: {
      along?: number; armTally?: number; limb?: number; knock?: number; weapon?: MeleeId;
      /** How it died, for a kill (blasts: the parts torn off). */
      death?: { cause: 'blast' | 'fire'; gibs?: GibPart[]; shred?: boolean; blast?: Vec3 };
      /** Overrides how hard a kill throws the body. */
      force?: number;
    } = {},
  ): void {
    if (!z.alive) return;
    const before = z.health;
    // Enough punishment and the leg comes off: high up at the hip, lower down at the knee. Some
    // that would have died of it live on, dragging themselves after you on their arms.
    let legCut: LegCut | null = null;
    if (isLeg(zone) && z.canLoseLeg(zone)) {
      z.legSever[zone] += opts.armTally ?? damage;
      if (z.legSever[zone] >= LEGS.legHealth[z.kind]) {
        legCut = (opts.along ?? 0) < LEGS.kneeAt ? 'hip' : 'knee';
        if (damage >= z.health && this.rand() < LEGS.survive) {
          const left = Math.max(1, Math.min(z.health - 1, Math.round(z.def.health * LEGS.surviveHealth)));
          damage = Math.max(0, z.health - left);
        }
      }
    }
    const killed = z.takeHit(damage, zone, dir, p, melee, opts.knock);
    const dealt = Math.min(before, damage);
    p.stats.damageDealt += dealt;
    // Blood sprays out the far side onto whatever is behind.
    let exit: { pos: Vec3; normal: Vec3 } | null = null;
    const back = this.physics.raycastHit(pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, 2.6);
    if (back) exit = { pos: { x: pos.x + dir.x * back.distance, y: pos.y + dir.y * back.distance, z: pos.z + dir.z * back.distance }, normal: { x: back.nx, y: back.ny, z: back.nz } };
    this.emit({ type: 'zombieHit', zombie: z.id, zone, pos, dir: { ...dir }, damage: dealt, killed, by: p.id, melee, exit, ...(opts.limb !== undefined ? { limb: opts.limb } : {}), ...(opts.weapon ? { weapon: opts.weapon } : {}) });
    // Enough punishment and the arm comes off: near the shoulder the whole arm, lower down the forearm.
    if ((zone === 'armL' || zone === 'armR') && z.canLose(zone)) {
      z.armDamage[zone] += opts.armTally ?? damage;
      if (z.armDamage[zone] >= LIMBS.armHealth[z.kind]) {
        this.severArm(p, z, zone, (opts.along ?? 0) < LIMBS.elbowAt ? 'shoulder' : 'elbow', dir, melee, damage, killed);
      }
    }
    if (legCut && isLeg(zone)) this.severLeg(p, z, zone, legCut, dir, melee, damage, killed);
    if (killed) {
      p.stats.kills++;
      if (zone === 'head') p.stats.headshots++;
      if (opts.limb !== undefined) p.stats.limbKills++;
      this.emit({
        type: 'zombieDied', zombie: z.id, zone, dir: { ...dir }, force: opts.force ?? (melee ? 1.2 : 0.6 + Math.min(1.4, damage / 60)) * force, by: p.id,
        ...(opts.death ?? {}),
      });
      if (z.kind === 'bloater') this.burst(z, p);
    }
  }

  /** A bloater bursts where it died. Chains (a blast killing another bloater) run one after another. */
  private burst(z: Zombie, by: SimPlayer): void {
    this.bursts.push({ z, by });
    if (this.bursting) return;
    this.bursting = true;
    try {
      for (let b = this.bursts.shift(); b; b = this.bursts.shift()) this.blast(b.z, b.by);
    } finally {
      this.bursting = false;
      this.bursts.length = 0;
    }
  }

  /**
   * The blast: both its arms fly off (loose arms anyone can pick up), anyone close takes a
   * beating that falls off with distance and stops at walls, and the dead next to it are torn
   * apart. Credit for what it kills goes to whoever killed the bloater.
   */
  private blast(z: Zombie, by: SimPlayer): void {
    const B = SPECIALS.bloater;
    const c = z.chest;
    const shapes = z.zones(this.zones);
    const outward = (arm: ArmZone): Vec3 => {
      const s = shapes.find((sh) => sh.zone === arm);
      let x = s ? s.a.x - c.x : this.rand() - 0.5, zz = s ? s.a.z - c.z : this.rand() - 0.5;
      const l = Math.hypot(x, zz) || 1;
      x /= l; zz /= l;
      return { x, y: 0.5, z: zz };
    };
    this.emit({ type: 'zombieBurst', zombie: z.id, pos: { ...c }, by: by.id });
    this.noise(c, B.noise, null);
    for (const arm of ['armL', 'armR'] as const) {
      if (z.canLose(arm)) this.severArm(by, z, arm, 'shoulder', outward(arm), false, 70, true);
    }
    const clear = (to: Vec3, d: number): boolean => {
      if (d < 0.3) return true;
      const hit = this.physics.raycast(c.x, c.y, c.z, (to.x - c.x) / d, (to.y - c.y) / d, (to.z - c.z) / d, d);
      return hit === null || hit > d - 0.3;
    };
    const falloff = (d: number) => 1 - (1 - B.edge) * clamp(d / B.radius, 0, 1);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const pc = p.chest;
      const d = Math.hypot(pc.x - c.x, pc.y - c.y, pc.z - c.z);
      if (d > B.radius || !clear(pc, d)) continue;
      this.damagePlayer(p, Math.round(B.playerDamage * falloff(d)), c);
    }
    for (const o of this.zombies) {
      if (o === z || !o.alive) continue;
      const oc = o.chest;
      const d = Math.hypot(oc.x - c.x, oc.y - c.y, oc.z - c.z);
      if (d > B.radius || !clear(oc, d)) continue;
      const hl = Math.hypot(oc.x - c.x, oc.z - c.z) || 1;
      const dir = { x: (oc.x - c.x) / hl, y: 0.3, z: (oc.z - c.z) / hl };
      // Close in, arms are torn off before the body takes the rest.
      if (d < B.severWithin) {
        for (const arm of ['armL', 'armR'] as const) {
          if (o.canLose(arm) && this.rand() < 0.65) this.severArm(by, o, arm, this.rand() < 0.6 ? 'shoulder' : 'elbow', dir, false, 60, false);
        }
        for (const leg of ['legL', 'legR'] as const) {
          if (o.canLoseLeg(leg) && this.rand() < 0.4) this.severLeg(by, o, leg, this.rand() < 0.5 ? 'hip' : 'knee', dir, false, 60, false);
        }
      }
      this.hitZombie(by, o, B.zombieDamage * falloff(d), 'torso', oc, dir, false, 1.8, { armTally: 0 });
      if (o.alive) o.shove(dir, B.knock * falloff(d));
    }
  }

  /**
   * A screamer's call: the dead within earshot come straight for `target`, and a few more come
   * running from out of sight (capped, on top of the night's normal numbers).
   */
  screamCall(from: Zombie, target: SimPlayer): void {
    const S = SPECIALS.screamer;
    this.noise(from.pos, S.noise, `z${from.id}`);
    let called = 0;
    for (const z of this.zombies) {
      if (z === from || !z.alive) continue;
      if (dist2D(z.pos, from.pos) > S.callRadius || Math.abs(z.pos.y - from.pos.y) > 6) continue;
      const was = z.target;
      z.summon(target);
      if (z.target === target.id && was !== target.id) called++;
    }
    let fresh = 0;
    if (this.phase === 'survival') {
      let alive = 0, extra = 0;
      for (const z of this.zombies) {
        if (!z.alive) continue;
        alive++;
        if (z.reinforcement) extra++;
      }
      const [lo, hi] = S.reinforcements;
      const want = lo + Math.floor(this.rand() * (hi - lo + 1));
      const [minD, maxD] = S.reinforceDistance;
      for (let i = 0; i < want && extra < S.reinforceCap && alive < SPAWNING.maxPopulation; i++) {
        const at = this.findSpawnPoint(minD, maxD);
        if (!at) continue;
        const z = this.spawnZombie(this.rand() < S.reinforceRunners ? 'runner' : 'walker', at, 'approach');
        z.reinforcement = true;
        z.summon(target);
        extra++;
        alive++;
        fresh++;
      }
    }
    this.emit({ type: 'zombieScream', zombie: from.id, pos: { ...from.pos }, target: target.id, called, fresh });
  }

  reload(id: string): boolean {
    const p = this.players.get(id);
    if (!p || !p.up || this.revivingOf(id)) return false;
    if (!p.arsenal.startReload()) return false;
    this.emit({ type: 'reload', player: id, weapon: p.arsenal.weapon.id, stage: 'start' });
    return true;
  }

  switchWeapon(id: string, slot: 'primary' | 'secondary'): boolean {
    const p = this.players.get(id);
    if (!p || !p.up) return false;
    // Reaching for a gun means tossing the arm aside.
    if (p.arsenal.limb) {
      if (p.arsenal.action === 'melee') return false;
      this.dropLimb(p, true);
    }
    const reloading = p.arsenal.action === 'reload';
    const weaponBefore = p.arsenal.weapon.id;
    if (!p.arsenal.switchTo(slot)) return false;
    if (reloading) this.emit({ type: 'reload', player: id, weapon: weaponBefore, stage: 'cancel' });
    this.emit({ type: 'draw', player: id, slot, weapon: p.arsenal.weapon.id });
    return true;
  }

  /**
   * Swings the machete, or the severed arm in hand. `aim` is the crosshair ray (checked like a
   * shot's): where it crosses the zombie decides what the blow lands on.
   */
  melee(id: string, aim?: { origin: Vec3; dir: Vec3 }): boolean {
    const p = this.players.get(id);
    if (!p || !p.up || this.phase === 'over' || this.revivingOf(id)) return false;
    const reloading = p.arsenal.action === 'reload';
    if (!p.arsenal.startMelee()) return false;
    p.meleeAim = null;
    if (aim) {
      const dl = Math.hypot(aim.dir.x, aim.dir.y, aim.dir.z);
      const eye = p.eye;
      const near = Math.hypot(aim.origin.x - eye.x, aim.origin.y - eye.y, aim.origin.z - eye.z) <= COMBAT.maxOriginOffset;
      if (dl > 0.5 && near) p.meleeAim = { origin: { ...aim.origin }, dir: { x: aim.dir.x / dl, y: aim.dir.y / dl, z: aim.dir.z / dl } };
    }
    if (reloading) this.emit({ type: 'reload', player: id, weapon: p.arsenal.weapon.id, stage: 'cancel' });
    this.emit({ type: 'melee', player: id, stage: 'swing', limb: p.arsenal.meleeWith === 'limb' });
    return true;
  }

  /**
   * Throws a grenade or Molotov along the crosshair ray (checked like a shot's). It leaves the
   * hand THROWING.release seconds later.
   */
  throwItem(id: string, kind: ThrowKind, aim: { origin: Vec3; dir: Vec3 }): boolean {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase === 'over' || !THROWABLES[kind]) return false;
    const dl = Math.hypot(aim.dir.x, aim.dir.y, aim.dir.z);
    if (!(dl > 0.5)) return false;
    const reloading = p.arsenal.action === 'reload';
    if (!p.arsenal.startThrow(kind)) return false;
    p.throwAim = { origin: { ...aim.origin }, dir: { x: aim.dir.x / dl, y: aim.dir.y / dl, z: aim.dir.z / dl } };
    if (reloading) this.emit({ type: 'reload', player: id, weapon: p.arsenal.weapon.id, stage: 'cancel' });
    this.emit({ type: 'throwStart', player: id, kind });
    return true;
  }

  /** A zombie burning: fire damage without blood or knockback. Returns true when it burns to death. */
  burnZombie(p: SimPlayer, z: Zombie, damage: number): boolean {
    if (!z.alive) return false;
    const before = z.health;
    const hl = Math.hypot(z.vel.x, z.vel.z);
    const dir = hl > 0.1 ? { x: z.vel.x / hl, y: 0, z: z.vel.z / hl } : { x: Math.sin(z.facing), y: 0, z: Math.cos(z.facing) };
    const killed = z.takeHit(damage, 'torso', dir, p, false, 0);
    p.stats.damageDealt += Math.min(before, damage);
    if (!killed) return false;
    p.stats.kills++;
    this.emit({ type: 'zombieDied', zombie: z.id, zone: 'torso', dir, force: 0.35, by: p.id, cause: 'fire' });
    return true;
  }

  bandage(id: string): boolean {
    const p = this.players.get(id);
    if (!p || !p.up || p.bandages <= 0 || p.health >= PLAYER.maxHealth || this.revivingOf(id)) return false;
    if (p.arsenal.action === 'melee' || p.arsenal.action === 'bandage') return false;
    // Both hands are needed for the dressing: the arm goes down at your feet.
    this.dropLimb(p, false);
    if (!p.arsenal.startBandage()) return false;
    this.emit({ type: 'bandage', player: id, stage: 'start' });
    return true;
  }

  /** Whether an interactable is within a player's reach. */
  inReach(id: string, it: Interactable): boolean {
    const p = this.players.get(id);
    if (!p || !p.up) return false;
    const c = p.chest;
    return Math.hypot(it.pos.x - c.x, (it.pos.y - c.y) * 1.5, it.pos.z - c.z) < it.range;
  }

  /** Interactables in reach of a player, nearest first. */
  reachable(id: string): Interactable[] {
    const p = this.players.get(id);
    if (!p || !p.up) return [];
    const c = p.chest;
    const d = (it: Interactable) => Math.hypot(it.pos.x - c.x, (it.pos.y - c.y) * 1.5, it.pos.z - c.z);
    return this.interactables.filter((it) => this.inReach(id, it)).sort((a, b) => d(a) - d(b));
  }

  /** Nearest interactable in reach of a player. */
  interactableFor(id: string): Interactable | null {
    return this.reachable(id)[0] ?? null;
  }

  /** Uses an ammunition crate or first aid box. */
  use(id: string, target: number): boolean {
    const p = this.players.get(id);
    const it = this.interactables[target];
    if (!p || !p.up || !it || !this.inReach(id, it)) return false;
    if (it.kind === 'ammo') {
      if (it.supply <= 0) return false;
      const a = p.arsenal;
      const pd = a.defOf(a.primary.id);
      const got = a.addReserve('primary', pd.magazine * (pd.crateMags ?? COMBAT.crateMagsPrimary))
        + a.addReserve('secondary', a.defOf(a.secondary.id).magazine * COMBAT.crateMagsSecondary)
        + a.addThrowable('frag', THROWING.cratePerUse) + a.addThrowable('molotov', THROWING.cratePerUse);
      if (got <= 0) {
        this.emit({ type: 'notice', player: id, text: 'AMMUNITION FULL' });
        return false;
      }
      it.supply--;
      p.stats.suppliesCollected++;
      this.emit({ type: 'pickup', player: id, item: 'ammo', amount: got, source: it.id });
      return true;
    }
    if (it.kind === 'supply') {
      if (it.supply <= 0) return false;
      const taken = it.takenBy?.get(id) ?? 0;
      if (taken >= SUPPLY_DROPS.perPlayerLimit) {
        this.emit({ type: 'notice', player: id, text: 'YOU TOOK YOUR SHARE', sub: 'The rest is for the others' });
        return false;
      }
      // Universal rounds: whatever the survivor carries, every weapon is filled up.
      const a = p.arsenal;
      const got = a.addReserve('primary', a.defOf(a.primary.id).maxReserve) + a.addReserve('secondary', a.defOf(a.secondary.id).maxReserve)
        + a.addThrowable('frag', THROWABLES.frag.max) + a.addThrowable('molotov', THROWABLES.molotov.max);
      if (got <= 0) {
        this.emit({ type: 'notice', player: id, text: 'AMMUNITION FULL' });
        return false;
      }
      it.supply--;
      it.takenBy?.set(id, taken + 1);
      p.stats.suppliesCollected++;
      this.emit({ type: 'pickup', player: id, item: 'supply', amount: got, source: it.id });
      const drop = this.drops.find((d) => d.interactable === it.id);
      if (drop && it.supply <= 0) this.emit({ type: 'supplyDrop', drop: drop.id, stage: 'empty', pos: { ...drop.flight.ground } });
      return true;
    }
    if (it.kind === 'serum') {
      if (it.supply <= 0) return false;
      if (p.armor >= SERUM.armor) {
        this.emit({ type: 'notice', player: id, text: 'SERUM STILL WORKING' });
        return false;
      }
      it.supply = 0;
      p.armor = SERUM.armor;
      p.stats.suppliesCollected++;
      this.emit({ type: 'pickup', player: id, item: 'serum', amount: SERUM.armor, source: it.id });
      const drop = this.drops.find((d) => d.serumItem === it.id);
      if (drop) this.emit({ type: 'supplyDrop', drop: drop.id, stage: 'serumTaken', pos: { ...it.pos } });
      this.emit({ type: 'notice', player: null, text: `${p.name.toUpperCase()} TOOK THE ${SERUM.name.toUpperCase()}` });
      return true;
    }
    if (it.kind === 'exclusive') {
      if (it.supply <= 0 || !it.weapon || p.arsenal.action === 'melee') return false;
      if (p.arsenal.primary.id === it.weapon) {
        this.emit({ type: 'notice', player: id, text: 'YOU ALREADY CARRY ONE' });
        return false;
      }
      it.supply = 0;
      this.dropLimb(p, false);
      // Comes loaded with its own ammunition; whatever primary they had stays behind.
      p.arsenal.replacePrimary(it.weapon, true);
      p.stats.suppliesCollected++;
      this.emit({ type: 'pickup', player: id, item: 'weapon', amount: 1, source: it.id, weapon: it.weapon });
      if (p.arsenal.active === 'primary') this.emit({ type: 'draw', player: id, slot: 'primary', weapon: it.weapon });
      const drop = this.drops.find((d) => d.caseItem === it.id);
      if (drop) this.emit({ type: 'supplyDrop', drop: drop.id, stage: 'weaponTaken', pos: { ...it.pos } });
      this.emit({ type: 'notice', player: null, text: `${p.name.toUpperCase()} TOOK THE ${WEAPONS[it.weapon].model}` });
      return true;
    }
    if (it.kind === 'melee') return this.takeMelee(p, it);
    if (it.kind === 'medical') {
      if (it.supply <= 0) return false;
      const room = COMBAT.maxBandages - p.bandages;
      if (room <= 0) {
        this.emit({ type: 'notice', player: id, text: 'BANDAGES FULL' });
        return false;
      }
      const take = Math.min(room, it.supply);
      it.supply -= take;
      p.bandages += take;
      p.stats.suppliesCollected++;
      this.emit({ type: 'pickup', player: id, item: 'bandage', amount: take, source: it.id });
      return true;
    }
    return false;
  }

  /** Swaps the primary at a weapon table. */
  selectPrimary(id: string, weapon: WeaponId): boolean {
    const p = this.players.get(id);
    const it = this.reachable(id).find((x) => x.kind === 'weapons');
    if (!p || !it || !PRIMARY_WEAPONS.includes(weapon)) return false;
    if (p.arsenal.primary.id === weapon || p.arsenal.action === 'melee' || p.arsenal.action === 'throw') return false;
    this.dropLimb(p, false);
    p.arsenal.replacePrimary(weapon);
    this.emit({ type: 'pickup', player: id, item: 'weapon', amount: 1, source: it.id, weapon });
    if (p.arsenal.active === 'primary') this.emit({ type: 'draw', player: id, slot: 'primary', weapon });
    return true;
  }

  /**
   * Fits attachments or a finish to a carried gun, anywhere (the gun in hand is down while it's
   * done). `build` must already be checked against the player's unlocks.
   */
  refit(id: string, weapon: WeaponId, build: WeaponBuild): boolean {
    const p = this.players.get(id);
    if (!p || !p.up || this.phase === 'over') return false;
    if (!p.arsenal.refit(weapon, build)) return false;
    this.emit({ type: 'refit', player: id, weapon, build: encodeBuild(build) });
    return true;
  }

  // ---------------------------------------------------------------- severed arms

  /** Takes the arm off a zombie and sends it flying (`fling` times as hard: blasts). */
  severArm(p: SimPlayer, z: Zombie, arm: ArmZone, cut: ArmCut, dir: Vec3, melee: boolean, damage: number, killed: boolean, fling = 1): void {
    // Where the arm is now: shoulder to hand, cut at the shoulder or the elbow.
    const shape = z.zones(this.zones).find((s) => s.zone === arm);
    if (!shape) return;
    const start = cut === 'shoulder' ? shape.a : along(shape.a, shape.b, LIMBS.elbowAt);
    let ux = shape.b.x - shape.a.x, uy = shape.b.y - shape.a.y, uz = shape.b.z - shape.a.z;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    z.loseArm(arm, cut, dir);
    const length = LIMBS.length[cut] * z.scale;
    const radius = LIMBS.radius * z.scale * Math.sqrt(z.def.girth);
    let center = { x: start.x + ux * length * 0.5, y: start.y + uy * length * 0.5, z: start.z + uz * length * 0.5 };
    // Never start inside a wall the zombie was leaning on.
    const c = z.chest;
    const tx = center.x - c.x, ty = center.y - c.y, tz = center.z - c.z;
    const tl = Math.hypot(tx, ty, tz);
    if (tl > 1e-3) {
      const hit = this.physics.raycast(c.x, c.y, c.z, tx / tl, ty / tl, tz / tl, tl + radius);
      if (hit !== null) {
        const k = Math.max(0, hit - radius - 0.03);
        center = { x: c.x + (tx / tl) * k, y: c.y + (ty / tl) * k, z: c.z + (tz / tl) * k };
      }
    }
    // Blown or hacked away from the blow, spinning end over end.
    const hl = Math.hypot(dir.x, dir.z) || 1;
    const speed = (melee ? 3 : 1.6 + Math.min(3, damage / 14)) * fling;
    const vel = {
      x: z.vel.x + (dir.x / hl) * speed + (this.rand() - 0.5) * 1.2,
      y: 1.4 + this.rand() * 1.4 + (fling > 1 ? Math.max(0, dir.y) * speed : 0),
      z: z.vel.z + (dir.z / hl) * speed + (this.rand() - 0.5) * 1.2,
    };
    const spin = (7 + this.rand() * 8) * Math.min(2, fling);
    // Spin about an axis across the arm.
    let sx = uy * (dir.z / hl) - uz * 0, sy = uz * (dir.x / hl) - ux * (dir.z / hl), sz = ux * 0 - uy * (dir.x / hl);
    const sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-3) { sx = 0; sy = 1; sz = 0; } else { sx /= sl; sy /= sl; sz /= sl; }
    const club = limbClub(cut, z.kind);
    const rot = quatFromUp({ x: -ux, y: -uy, z: -uz });
    const limb: SimLimb = {
      id: this.nextLimbId++, arm, cut, kind: z.kind, look: z.look, scale: z.scale,
      wear: club.wear, maxWear: club.wear, broken: false,
      holder: null, body: null, pos: center, rot, prevPos: { ...center }, prevRot: { ...rot },
      length, radius, bornAt: this.time, looseAt: this.time,
    };
    limb.body = this.limbBody(limb, vel, { x: sx * spin, y: sy * spin, z: sz * spin });
    this.limbs.push(limb);
    p.stats.limbsSevered++;
    this.emit({ type: 'limbSevered', zombie: z.id, limb: limb.id, arm, cut, pos: { ...start }, dir: { ...dir }, by: p.id, melee, killed });
    this.trimLimbs();
  }

  /**
   * Takes a leg off a zombie (at the hip or the knee) and sends it flopping away. Unless the
   * same blow kills it, the zombie goes down and crawls after its prey on its arms. Shots,
   * blades, bloater bursts and grenades all come through here; `killed` is whether the blow
   * that did it also killed it.
   */
  severLeg(p: SimPlayer, z: Zombie, leg: LegZone, cut: LegCut, dir: Vec3, melee: boolean, damage: number, killed: boolean): void {
    if (!z.canLoseLeg(leg)) return;
    // Where the leg is now (before it goes down): hip to foot, cut at the hip or the knee.
    const shape = z.zones(this.zones).find((s) => s.zone === leg);
    if (!shape) return;
    const foot = shape.b;
    const start = cut === 'hip' ? shape.a : along(shape.a, foot, LEGS.kneeAt);
    let ux = foot.x - shape.a.x, uy = foot.y - shape.a.y, uz = foot.z - shape.a.z;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    z.loseLeg(leg, cut);
    const length = LIMBS.length[cut] * z.scale;
    const radius = LIMBS.radius * 1.7 * z.scale * Math.sqrt(z.def.girth);
    let center = { x: start.x + ux * length * 0.5, y: start.y + uy * length * 0.5, z: start.z + uz * length * 0.5 };
    // Its foot was on the ground: the capsule starts clear of it.
    center.y = Math.max(center.y, z.pos.y + Math.abs(uy) * length * 0.5 + radius + 0.02);
    // Never inside a wall the zombie was against.
    const c = z.chest;
    const tx = center.x - c.x, ty = center.y - c.y, tz = center.z - c.z;
    const tl = Math.hypot(tx, ty, tz);
    if (tl > 1e-3) {
      const hit = this.physics.raycast(c.x, c.y, c.z, tx / tl, ty / tl, tz / tl, tl + radius);
      if (hit !== null) {
        const k = Math.max(0, hit - radius - 0.03);
        center = { x: c.x + (tx / tl) * k, y: c.y + (ty / tl) * k, z: c.z + (tz / tl) * k };
      }
    }
    // Heavier than an arm: kicked out from under it rather than flung.
    const hl = Math.hypot(dir.x, dir.z) || 1;
    const speed = melee ? 2.2 : 1.1 + Math.min(2.6, damage / 18);
    const vel = {
      x: z.vel.x * 0.5 + (dir.x / hl) * speed + (this.rand() - 0.5) * 0.9,
      y: 0.8 + this.rand() * 1.2,
      z: z.vel.z * 0.5 + (dir.z / hl) * speed + (this.rand() - 0.5) * 0.9,
    };
    const spin = 4 + this.rand() * 6;
    let sx = uy * (dir.z / hl), sy = uz * (dir.x / hl) - ux * (dir.z / hl), sz = -uy * (dir.x / hl);
    const sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-3) { sx = 1; sy = 0; sz = 0; } else { sx /= sl; sy /= sl; sz /= sl; }
    const club = limbClub(cut, z.kind);
    const rot = quatFromUp({ x: -ux, y: -uy, z: -uz });
    const limb: SimLimb = {
      id: this.nextLimbId++, arm: leg, cut, kind: z.kind, look: z.look, scale: z.scale,
      wear: club.wear, maxWear: club.wear, broken: false,
      holder: null, body: null, pos: center, rot, prevPos: { ...center }, prevRot: { ...rot },
      length, radius, bornAt: this.time, looseAt: this.time,
    };
    limb.body = this.limbBody(limb, vel, { x: sx * spin, y: sy * spin, z: sz * spin });
    this.limbs.push(limb);
    p.stats.limbsSevered++;
    this.emit({ type: 'limbSevered', zombie: z.id, limb: limb.id, arm: leg, cut, pos: { ...start }, dir: { ...dir }, by: p.id, melee, killed });
    this.trimLimbs();
  }

  /** A tumbling physics body for a loose arm at its current pose. */
  private limbBody(l: SimLimb, vel: Vec3, spin: Vec3): RAPIER.RigidBody {
    const w = this.physics.world;
    const body = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(l.pos.x, l.pos.y, l.pos.z)
        .setRotation(l.rot)
        .setLinvel(vel.x, vel.y, vel.z)
        .setAngvel(spin)
        .setLinearDamping(0.15)
        .setAngularDamping(0.8)
        .setCcdEnabled(true),
    );
    const half = Math.max(0.02, l.length / 2 - l.radius);
    const volume = Math.PI * l.radius * l.radius * (2 * half) + (4 / 3) * Math.PI * l.radius ** 3;
    const mass = LIMBS.mass[l.cut] * l.scale ** 3;
    w.createCollider(
      RAPIER.ColliderDesc.capsule(half, l.radius)
        .setDensity(mass / volume)
        .setFriction(0.9)
        .setRestitution(0.12)
        .setCollisionGroups(groups(GROUP.debris, GROUP.static | GROUP.dynamic | GROUP.debris)),
      body,
    );
    return body;
  }

  /** Clears the oldest loose arms beyond the limit. */
  private trimLimbs(): void {
    let loose = this.limbs.filter((l) => !l.holder);
    while (loose.length > LIMBS.maxLoose) {
      const oldest = loose.reduce((a, b) => (b.looseAt < a.looseAt ? b : a));
      this.removeLimb(oldest);
      loose = loose.filter((l) => l !== oldest);
    }
  }

  private removeLimb(l: SimLimb): void {
    if (l.body) this.physics.world.removeRigidBody(l.body);
    l.body = null;
    const i = this.limbs.indexOf(l);
    if (i >= 0) this.limbs.splice(i, 1);
    this.emit({ type: 'limbGone', limb: l.id });
  }

  limb(id: number): SimLimb | undefined {
    return this.limbs.find((l) => l.id === id);
  }

  /** Whether a loose arm is within a player's grab (any point along it counts). */
  limbInReach(id: string, l: SimLimb): boolean {
    const p = this.players.get(id);
    // (A network client's copy of the world has no body for it: lying loose is enough.)
    if (!p || !p.up || l.holder) return false;
    const m = p.motion.pos;
    const dy = l.pos.y - m.y;
    if (dy < -0.6 || dy > LIMBS.reachHeight) return false;
    const axis = rotate(l.rot, { x: 0, y: l.length / 2, z: 0 });
    const ax = l.pos.x - axis.x, az = l.pos.z - axis.z, bx = l.pos.x + axis.x, bz = l.pos.z + axis.z;
    const vx = bx - ax, vz = bz - az;
    const ll = vx * vx + vz * vz;
    const t = ll > 1e-6 ? clamp(((m.x - ax) * vx + (m.z - az) * vz) / ll, 0, 1) : 0.5;
    return Math.hypot(m.x - (ax + vx * t), m.z - (az + vz * t)) <= LIMBS.reach;
  }

  /** Loose arms a player can grab, nearest first. */
  limbsInReach(id: string): SimLimb[] {
    const p = this.players.get(id);
    if (!p || !p.up) return [];
    const m = p.motion.pos;
    return this.limbs.filter((l) => this.limbInReach(id, l)).sort((a, b) => dist2D(a.pos, m) - dist2D(b.pos, m));
  }

  /** Picks up a severed arm to fight with (swapping out one already in hand). */
  grabLimb(id: string, limbId: number): boolean {
    const p = this.players.get(id);
    const l = this.limb(limbId);
    if (!p || !p.up || !l || !this.limbInReach(id, l)) return false;
    const a = p.arsenal;
    if (a.action === 'melee' || a.action === 'bandage' || a.action === 'throw') return false;
    const reloading = a.action === 'reload';
    // Claim it before letting go of the old one (which could otherwise push it over the limit).
    if (l.body) this.physics.world.removeRigidBody(l.body);
    l.body = null;
    l.holder = id;
    this.dropLimb(p, false);
    a.grabLimb(l);
    if (reloading) this.emit({ type: 'reload', player: id, weapon: a.weapon.id, stage: 'cancel' });
    this.emit({ type: 'limbGrabbed', player: id, limb: l.id });
    return true;
  }

  /**
   * Lets go of the arm in a player's hands: dropped at their feet, or `thrown` aside to free the
   * hands for a gun. A worn-through arm just goes.
   */
  dropLimb(p: SimPlayer, thrown: boolean): void {
    const a = p.arsenal;
    const l = a.limb as SimLimb | null;
    if (!l) return;
    a.releaseLimb();
    if (p.up) this.emit({ type: 'draw', player: p.id, slot: a.active, weapon: a.weapon.id });
    const i = this.limbs.indexOf(l);
    if (l.broken || i < 0) return;
    const m = p.motion;
    const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
    const rx = Math.cos(m.yaw), rz = -Math.sin(m.yaw);
    // From the right hand, kept on this side of any wall.
    const c = p.chest;
    let to = { x: m.pos.x + fx * 0.45 + rx * 0.25, y: m.pos.y + (p.up ? 1.05 : 0.6), z: m.pos.z + fz * 0.45 + rz * 0.25 };
    const tx = to.x - c.x, ty = to.y - c.y, tz = to.z - c.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    const hit = this.physics.raycast(c.x, c.y, c.z, tx / tl, ty / tl, tz / tl, tl + l.radius);
    if (hit !== null) {
      const k = Math.max(0, hit - l.radius - 0.03);
      to = { x: c.x + (tx / tl) * k, y: c.y + (ty / tl) * k, z: c.z + (tz / tl) * k };
    }
    l.holder = null;
    l.pos = to;
    l.prevPos = { ...to };
    // Lengthwise across the body, cut end forward, rolled at random.
    const dir = { x: rx * 0.8 + fx * 0.6, y: -0.15, z: rz * 0.8 + fz * 0.6 };
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    l.rot = quatFromUp({ x: dir.x / dl, y: dir.y / dl, z: dir.z / dl });
    l.prevRot = { ...l.rot };
    l.looseAt = this.time;
    const v = thrown ? 2.6 : 0.4;
    l.body = this.limbBody(l, { x: m.vel.x * 0.5 + (fx * 0.5 + rx) * v, y: thrown ? 1.6 : 0.2, z: m.vel.z * 0.5 + (fz * 0.5 + rz) * v }, { x: (this.rand() - 0.5) * 6, y: (this.rand() - 0.5) * 4, z: (this.rand() - 0.5) * 6 });
    this.emit({ type: 'limbDropped', player: p.id, limb: l.id, thrown });
    this.trimLimbs();
  }

  /** Worn through: it comes apart in the hands (the swing in progress finishes empty-handed). */
  private breakLimb(p: SimPlayer, l: HeldLimb, pos: Vec3, dir: Vec3): void {
    l.broken = true;
    l.wear = 0;
    const i = this.limbs.findIndex((x) => x.id === l.id);
    if (i >= 0) this.limbs.splice(i, 1);
    this.emit({ type: 'limbBroke', player: p.id, limb: l.id, pos: { ...pos }, dir: { ...dir } });
  }

  /** Loose arms follow their bodies; old ones nobody is near get cleared away. */
  private updateLimbs(): void {
    for (let i = this.limbs.length - 1; i >= 0; i--) {
      const l = this.limbs[i];
      if (!l.body) continue;
      l.prevPos.x = l.pos.x; l.prevPos.y = l.pos.y; l.prevPos.z = l.pos.z;
      l.prevRot.x = l.rot.x; l.prevRot.y = l.rot.y; l.prevRot.z = l.rot.z; l.prevRot.w = l.rot.w;
      const t = l.body.translation();
      const r = l.body.rotation();
      l.pos.x = t.x; l.pos.y = t.y; l.pos.z = t.z;
      l.rot.x = r.x; l.rot.y = r.y; l.rot.z = r.z; l.rot.w = r.w;
      // Fell out of the world (it should never), or lying unwanted for too long.
      if (t.y < -30) {
        this.removeLimb(l);
        continue;
      }
      if (this.time - l.looseAt > LIMBS.lifetime) {
        let near = false;
        for (const p of this.players.values()) if (p.alive && dist2D(p.motion.pos, l.pos) < 25) near = true;
        if (!near) this.removeLimb(l);
      }
    }
  }

  /** Crosshair ray for the swing in progress: the client's, or straight out of the eyes. */
  private meleeRay(p: SimPlayer): { origin: Vec3; dir: Vec3 } {
    if (p.meleeAim) return p.meleeAim;
    const m = p.motion;
    const cp = Math.cos(m.pitch);
    return { origin: p.eye, dir: { x: -Math.sin(m.yaw) * cp, y: Math.sin(m.pitch), z: -Math.cos(m.yaw) * cp } };
  }

  // ---------------------------------------------------------------- found melee weapons

  /** Rooms found weapons can lie in (bedrooms, basements, the gas station store). */
  get meleeRooms(): PickupRoom[] {
    this.pickupRooms ??= findPickupRooms(this.map, this.nav, this.physics);
    return this.pickupRooms;
  }

  /** Found weapons lying on the map now. */
  get placedMelee(): Interactable[] {
    return this.interactables.filter((it) => it.kind === 'melee' && it.supply > 0);
  }

  /** Keeps up to MELEE_PICKUPS.maxPlaced lying about: the first ones at once, then one now and then. */
  private runPickups(): void {
    const P = MELEE_PICKUPS;
    if (this.time < this.nextPickupAt) return;
    const placed = this.placedMelee;
    if (placed.length >= P.maxPlaced) {
      this.nextPickupAt = Infinity;
      return;
    }
    const first = this.nextPickupAt === 0;
    let made = 0;
    while (placed.length + made < P.maxPlaced && this.placeMelee(!first)) {
      made++;
      if (!first) break;
    }
    const [lo, hi] = P.respawn;
    this.nextPickupAt = this.time + (made || first ? lo + this.pickRand() * (hi - lo) : 8);
  }

  /** A taken weapon starts the clock for another to turn up somewhere. */
  private pickupTaken(): void {
    if (this.nextPickupAt !== Infinity) return;
    const [lo, hi] = MELEE_PICKUPS.respawn;
    this.nextPickupAt = this.time + lo + this.pickRand() * (hi - lo);
  }

  /**
   * Puts a found weapon down in a room with space for one. `hidden`: only out of every survivor's
   * way, so nobody sees it appear. Returns the interactable, or null when nowhere fits.
   */
  placeMelee(hidden = true, weapon?: MeleeId): Interactable | null {
    const P = MELEE_PICKUPS;
    const placed = this.placedMelee;
    const used = new Map<string, number>();
    for (const it of placed) if (it.room) used.set(it.room, (used.get(it.room) ?? 0) + 1);
    const alive = [...this.players.values()].filter((p) => p.alive);
    const open = this.meleeRooms.filter((r) => {
      if ((used.get(r.key) ?? 0) >= P.perRoom[r.room]) return false;
      return !hidden || alive.every((p) => dist2D(p.motion.pos, r.centre) > P.awayFromPlayers);
    });
    if (!open.length) return null;
    // The gas station is the likeliest place, then basements, then bedrooms (there are many: with
    // Oak Street's the store needs 8 to keep its sixth of the draws).
    const weightOf = (r: PickupRoom) => (r.room === 'store' ? 8 : r.room === 'basement' ? 1.6 : 1);
    let x = this.pickRand() * open.reduce((s, r) => s + weightOf(r), 0);
    let room = open[open.length - 1];
    for (const r of open) if ((x -= weightOf(r)) < 0) { room = r; break; }
    const kinds = placed.map((it) => it.weapon).filter((w): w is MeleeId => !!w && isMelee(w));
    const id = weapon ?? pickFoundWeapon(room.room, kinds, this.pickRand);
    // Against a wall when there is one free, never on top of another.
    for (let tries = 0; tries < 24; tries++) {
      const pool = room.walled > 0 && tries < 16 ? room.walled : room.nodes.length;
      const pos = this.nav.nodePos(room.nodes[Math.floor(this.pickRand() * pool)]);
      if (placed.some((it) => Math.hypot(it.pos.x - pos.x, it.pos.z - pos.z) < 1.2 && Math.abs(it.pos.y - P.lift - pos.y) < 1)) continue;
      return this.layMelee(id, pos, room.key);
    }
    return null;
  }

  /** A found weapon lying at `floor` (its reach point sits a little above it). */
  private layMelee(weapon: MeleeId, floor: Vec3, room?: string): Interactable {
    const it: Interactable = {
      id: this.interactables.length, kind: 'melee', pos: { x: floor.x, y: floor.y + MELEE_PICKUPS.lift, z: floor.z },
      supply: 1, range: MELEE_PICKUPS.range, weapon, ...(room ? { room } : {}),
    };
    this.interactables.push(it);
    return it;
  }

  /** Takes a found weapon in place of the machete; one already carried is left where this one lay. */
  private takeMelee(p: SimPlayer, it: Interactable): boolean {
    const a = p.arsenal;
    const weapon = it.weapon;
    if (it.supply <= 0 || !weapon || !isMelee(weapon) || a.action === 'melee' || a.action === 'bandage') return false;
    if (a.meleeId === weapon) {
      this.emit({ type: 'notice', player: p.id, text: `YOU ALREADY CARRY A ${WEAPONS[weapon].model}` });
      return false;
    }
    const swapped = a.meleeId === 'machete' ? null : a.meleeId;
    it.supply = 0;
    a.meleeId = weapon;
    const floor = { x: it.pos.x, y: it.pos.y - MELEE_PICKUPS.lift, z: it.pos.z };
    if (swapped) this.layMelee(swapped, floor, it.room);
    else this.pickupTaken();
    this.emit({ type: 'meleeTaken', player: p.id, item: it.id, weapon, swapped, pos: floor });
    this.emit({ type: 'pickup', player: p.id, item: 'weapon', amount: 1, source: it.id, weapon });
    return true;
  }

  /** A survivor who dies or leaves lets go of a found weapon: it lies where they were. */
  private dropMelee(p: SimPlayer): void {
    const a = p.arsenal;
    if (a.meleeId === 'machete') return;
    const m = p.motion.pos;
    const n = this.nav.nodeAt(m.x, m.y + 0.1, m.z, 1.5);
    const floor = n >= 0 ? this.nav.nodePos(n) : { x: m.x, y: m.y, z: m.z };
    this.layMelee(a.meleeId, floor);
    a.meleeId = 'machete';
  }

  // ---------------------------------------------------------------- zombies

  spawnZombie(kind: ZombieKind, at: Vec3, mode: 'approach' | 'wander' | 'idle' = 'approach'): Zombie {
    const z = new Zombie(this.nextZombieId++, kind, this.lookCounter++, at, this.rand() * Math.PI * 2, Math.floor(this.rand() * 1e9) + 1, this);
    this.zombies.push(z);
    if (mode === 'approach') z.approach();
    else if (mode === 'wander') z.wander();
    this.emit({ type: 'zombieSpawned', zombie: z.id, kind });
    return z;
  }

  zombie(id: number): Zombie | undefined {
    return this.zombies.find((z) => z.id === id);
  }

  /** Outdoor spot out of every survivor's sight, at a distance band from the nearest one. */
  findSpawnPoint(minD: number = SPAWNING.minDistance, maxD: number = SPAWNING.maxDistance): Vec3 | null {
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (!alive.length || !this.outdoorNodes.length) return null;
    for (let tries = 0; tries < 40; tries++) {
      const n = this.outdoorNodes[Math.floor(this.rand() * this.outdoorNodes.length)];
      const pos = this.nav.nodePos(n);
      let nearest = Infinity;
      for (const p of alive) nearest = Math.min(nearest, dist2D(p.motion.pos, pos));
      if (nearest < minD || nearest > maxD) continue;
      let seen = false;
      for (const p of alive) {
        const e = p.eye;
        const dx = pos.x - e.x, dy = pos.y + 1.4 - e.y, dz = pos.z - e.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > 95) continue;
        const hit = this.physics.raycast(e.x, e.y, e.z, dx / d, dy / d, dz / d, d);
        if (hit === null || hit > d - 0.5) {
          seen = true;
          break;
        }
      }
      if (seen) continue;
      // Not inside a crowd.
      if (this.zombies.some((z) => dist2D(z.pos, pos) < 2)) continue;
      return { x: pos.x, y: pos.y + 0.02, z: pos.z };
    }
    return null;
  }

  /** How much bigger the horde gets for the survivors alive (1 to 4, see SPAWNING.playerScale). */
  get playerScale(): number {
    let alive = 0;
    for (const p of this.players.values()) if (p.alive) alive++;
    const s = SPAWNING.playerScale;
    return s[clamp(alive, 1, s.length) - 1];
  }

  /** Target population for the basic spawner (the Phase 5 director replaces this). */
  get populationTarget(): number {
    if (this.phase !== 'survival') return 0;
    const solo = SPAWNING.basePopulation + (SPAWNING.growthPerMinute * this.phaseTime) / 60;
    return Math.min(SPAWNING.maxPopulation, Math.floor(solo * this.playerScale));
  }

  /** True while a horde surge is under way. */
  get surging(): boolean {
    return this.phase === 'survival' && this.horde.stage === 'surge';
  }

  /** What the spawner fills to: the base target, plus the wave's extra during a surge. */
  get spawnTarget(): number {
    const base = this.populationTarget;
    if (!this.surging) return base;
    return Math.min(SPAWNING.maxPopulation, base + Math.floor(hordeBonus(this.horde.wave) * this.playerScale));
  }

  // ---------------------------------------------------------------- the van raid (Raid.ts)

  /**
   * A round's flight against the world. `breakGlass`: window panes it meets shatter and it flies
   * on; otherwise (sight lines) panes are looked through. The first solid hit, or null.
   */
  castRound(o: Vec3, d: Vec3, maxD: number, breakGlass: boolean): RayHit | null {
    if (breakGlass) return this.castThrough(o, d, maxD);
    let from = 0;
    for (let i = 0; i < 6; i++) {
      const hit = this.physics.raycastHit(o.x + d.x * from, o.y + d.y * from, o.z + d.z * from, d.x, d.y, d.z, maxD - from);
      if (!hit) return null;
      if (hit.surface !== 'glass') return { ...hit, distance: hit.distance + from };
      from += hit.distance + 0.12;
      if (from >= maxD) return null;
    }
    return null;
  }

  /** Whether boards hold a door shut (a raider has to kick it in rather than open it). */
  doorBarred(door: DoorBody): boolean {
    return this.doorLocked(door.index);
  }

  /** Starts the van raid now, whatever the clock says (debugging and tests). */
  callRaid(): boolean {
    if (this.phase !== 'survival') return false;
    return this.raid.start();
  }

  /** Removes every zombie body and the shared zombie controller from the physics world. */
  dispose(): void {
    this.raid.dispose();
    for (const d of this.drops) if (d.body) this.physics.world.removeRigidBody(d.body);
    for (const l of this.limbs) if (l.body) this.physics.world.removeRigidBody(l.body);
    this.limbs.length = 0;
    this.explosives.clear();
    for (const z of this.zombies) z.removeBody();
    this.zombies.length = 0;
    this.physics.world.removeCharacterController(this.zombieController);
    this.physics.world.removeCharacterController(this.zombieWalker);
  }

  skipPreparation(): void {
    if (this.phase === 'preparation') this.phaseTime = 0.01;
  }

  // ---------------------------------------------------------------- step

  /**
   * One step of the night. `zombies` false holds every zombie in place this step and saves up its
   * time: the server moves them only on the steps it sends a snapshot, which is what clients see,
   * at a third of the cost.
   */
  step(dt: number, zombies = true): void {
    this.time += dt;
    this.stepDt = dt;
    if (zombies) {
      this.pathBudget = 1 + this.heldSteps;
      this.heldSteps = 0;
    } else {
      this.pathBudget = 0;
      this.heldSteps++;
    }
    if (this.phase === 'preparation') {
      this.phaseTime -= dt;
      if (this.phaseTime <= 0) {
        this.phase = 'survival';
        this.phaseTime = 0;
        this.emit({ type: 'phase', phase: 'survival' });
        this.spawnAt = this.time + 1;
        this.nextDropAt = SUPPLY_DROPS.firstAt;
      }
    } else if (this.phase === 'survival') {
      this.phaseTime += dt;
      this.runHordes();
      this.runSpawner();
      this.runDrops();
      this.raid.update(dt, zombies);
    }

    for (const d of this.doors) d?.update(dt);
    this.updateLimbs();
    if (this.phase !== 'over') this.stepDowned(dt);
    if (this.phase !== 'over') this.runPickups();

    const ticks: ArsenalTick[] = [];
    for (const p of this.players.values()) {
      if (!p.up) continue;
      ticks.length = 0;
      p.arsenal.step(dt, p.motion.aiming, ticks);
      for (const t of ticks) this.onArsenal(p, t);
      this.updateWork(p, dt);
      // Footsteps carry: sprinting is heard much farther than walking; crouching is silent.
      const speed = p.speed;
      p.footstepT -= dt;
      if (p.footstepT <= 0 && speed > 0.8 && p.motion.grounded) {
        const radius = p.motion.crouching ? 1.2 : speed > 4.5 ? 11 : 4.5;
        this.noise(p.motion.pos, radius, p.id);
        p.footstepT = speed > 4.5 ? 0.35 : 0.55;
      }
    }

    this.explosives.step(dt);

    // Zombies far from everyone and not hunting update at a third of the rate.
    for (const z of this.zombies) {
      z.pending += dt;
      if (!zombies) continue;
      if (!z.engaged && z.pending < dt * 3 - 1e-6) {
        let near = false;
        for (const p of this.players.values()) {
          if (p.alive && Math.abs(p.motion.pos.x - z.pos.x) < 45 && Math.abs(p.motion.pos.z - z.pos.z) < 45) near = true;
        }
        if (!near) continue;
      }
      z.update(z.pending);
      z.updatedAt = this.time;
      z.lastDt = z.pending;
      z.pending = 0;
    }

    // Remove the dead and recycle zombies that wandered off far from everyone.
    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const z = this.zombies[i];
      let remove = !z.alive;
      if (!remove && !z.engaged && this.phase === 'survival') {
        let nearest = Infinity;
        for (const p of this.players.values()) if (p.alive) nearest = Math.min(nearest, dist2D(p.motion.pos, z.pos));
        if (nearest > SPAWNING.despawnDistance) {
          remove = true;
          this.emit({ type: 'zombieRemoved', zombie: z.id });
        }
      }
      if (remove) {
        z.removeBody();
        this.zombies.splice(i, 1);
      }
    }

    while (this.noises.length && this.time - this.noises[0].time > 1.5) this.noises.shift();
  }

  private runSpawner(): void {
    if (this.time < this.spawnAt) return;
    const alive = this.zombies.filter((z) => z.alive).length;
    const target = this.spawnTarget;
    if (alive >= target) {
      this.spawnAt = this.time + 1;
      return;
    }
    const at = this.findSpawnPoint();
    // The first arrivals come in quickly; afterwards a steady trickle.
    const [lo, hi] = SPAWNING.interval;
    const surge = this.surging;
    const wait = surge ? HORDES.interval : alive < target * 0.5 ? 0.35 : lo + this.rand() * (hi - lo);
    this.spawnAt = this.time + wait / this.playerScale;
    if (!at) return;
    // A surge comes straight for the survivors.
    this.spawnZombie(this.pickKind(), at, surge || this.rand() < 0.78 ? 'approach' : 'wander');
  }

  /** Kind of the next spawn: walkers, with runners, brutes, screamers and bloaters mixed in as the night goes on. */
  pickKind(): ZombieKind {
    const t = this.phaseTime;
    const share = (m: { from: number; full: number; start: number; end: number }) =>
      t < m.from ? 0 : m.start + (m.end - m.start) * clamp((t - m.from) / (m.full - m.from), 0, 1);
    const r = this.rand();
    const runner = share(SPAWNING.mix.runner) + (this.surging ? hordeRunnerBoost(this.horde.wave) : 0);
    if (r < runner) return 'runner';
    if (r < runner + share(SPAWNING.mix.brute)) {
      const brutes = this.zombies.filter((z) => z.alive && z.kind === 'brute').length;
      if (brutes < Math.floor((SPAWNING.bruteBase + Math.floor(t / SPAWNING.bruteEvery)) * this.playerScale)) return 'brute';
    }
    // Specials, each held to a few at once.
    const special = (kind: 'screamer' | 'bloater', base: number) => {
      const n = this.zombies.filter((z) => z.alive && z.kind === kind).length;
      return n < Math.floor((base + Math.floor(t / SPAWNING.specialEvery)) * this.playerScale);
    };
    const r2 = 1 - r;
    const screamer = share(SPAWNING.mix.screamer);
    if (r2 < screamer) {
      if (special('screamer', SPAWNING.screamerBase)) return 'screamer';
    } else if (r2 < screamer + share(SPAWNING.mix.bloater)) {
      if (special('bloater', SPAWNING.bloaterBase)) return 'bloater';
    }
    return 'walker';
  }

  // ---------------------------------------------------------------- hordes

  /** Moves the night through the horde schedule and announces each change of stage. */
  private runHordes(): void {
    const was = this.horde;
    const now = hordeAt(this.phaseTime);
    this.horde = now;
    if (now.stage === was.stage && now.wave === was.wave) return;
    // A wave was outlasted (the schedule moved on to the next wave).
    if (now.survived > was.survived) {
      for (let w = was.survived + 1; w <= now.survived; w++) this.emit({ type: 'horde', wave: w, stage: 'over', at: this.phaseTime });
      this.nextDropAt = Math.min(this.nextDropAt, this.phaseTime + HORDES.dropAfter);
      this.spawnAt = Math.max(this.spawnAt, this.time + 1);
    }
    if (now.stage === 'warning') {
      this.emit({ type: 'horde', wave: now.wave, stage: 'warning', at: now.start });
    } else if (now.stage === 'surge') {
      this.emit({ type: 'horde', wave: now.wave, stage: 'surge', at: now.end });
      this.callHorde();
    }
  }

  /** The horde turns on the survivors: every zombie close enough comes to the nearest one. */
  private callHorde(): void {
    const R = HORDES.callRadius;
    for (const z of this.zombies) {
      if (!z.alive || z.engaged) continue;
      let best: Vec3 | null = null;
      let bestD: number = R;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const d = dist2D(p.motion.pos, z.pos);
        if (d < bestD) {
          bestD = d;
          best = p.motion.pos;
        }
      }
      if (best) z.investigate(best, 4);
    }
    this.spawnAt = Math.min(this.spawnAt, this.time);
  }

  // ---------------------------------------------------------------- supply drops

  private runDrops(): void {
    const D = SUPPLY_DROPS;
    if (this.phaseTime >= this.nextDropAt) {
      const flight = this.planFlight();
      if (flight) {
        const id = this.drops.length;
        const weapon = this.rollExclusive();
        const serum = this.forceSerum || this.rand() < D.serumChance;
        this.forceSerum = false;
        this.drops.push({ id, flight, stage: 'inbound', interactable: -1, body: null, weapon, caseItem: -1, serum, serumItem: -1 });
        this.emit({ type: 'heli', drop: id, flight, ...(weapon ? { weapon } : {}), ...(serum ? { serum } : {}) });
        const extras = [weapon ? `${WEAPONS[weapon].model} aboard` : '', serum ? `${SERUM.name} aboard` : ''].filter(Boolean);
        if (extras.length) this.emit({ type: 'notice', player: null, text: 'RARE SUPPLY DROP INBOUND', sub: `Universal ammo · ${extras.join(' · ')}` });
        else this.emit({ type: 'notice', player: null, text: 'SUPPLY DROP INBOUND', sub: 'Universal ammo · refills every weapon' });
        const [lo, hi] = D.interval;
        this.nextDropAt = this.phaseTime + lo + this.rand() * (hi - lo);
      } else {
        this.nextDropAt = this.phaseTime + 5;
      }
    }
    for (const d of this.drops) {
      const f = d.flight;
      if (d.stage === 'inbound') {
        if (this.time >= f.arrive && this.time - this.lastDt() < f.arrive) this.noise(f.ground, D.hoverNoise, null);
        if (this.time >= f.release) {
          d.stage = 'falling';
          this.noise(f.ground, D.hoverNoise, null);
          this.emit({ type: 'supplyDrop', drop: d.id, stage: 'released', pos: { x: f.over.x, y: f.ground.y + f.releaseHeight, z: f.over.z } });
        }
      } else if (d.stage === 'falling' && this.time >= f.land) {
        d.stage = 'landed';
        const g = f.ground;
        const alive = [...this.players.values()].filter((p) => p.alive).length;
        d.interactable = this.interactables.length;
        this.interactables.push({
          id: d.interactable, kind: 'supply', pos: { x: g.x, y: g.y + 0.5, z: g.z },
          supply: D.baseUses + alive, range: 2.1, takenBy: new Map(),
        });
        // A solid crate: people walk around it, not through it.
        const w = this.physics.world;
        d.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(g.x, g.y + 0.36, g.z));
        w.createCollider(RAPIER.ColliderDesc.cuboid(0.55, 0.36, 0.38).setCollisionGroups(groups(GROUP.dynamic, 0xffff)), d.body);
        if (d.weapon) {
          const c = caseSpot(f);
          d.caseItem = this.interactables.length;
          this.interactables.push({ id: d.caseItem, kind: 'exclusive', pos: { x: c.x, y: c.y + 0.2, z: c.z }, supply: 1, range: 1.9, weapon: d.weapon });
        }
        if (d.serum) {
          const c = caseSpot(f, -1);
          d.serumItem = this.interactables.length;
          this.interactables.push({ id: d.serumItem, kind: 'serum', pos: { x: c.x, y: c.y + 0.2, z: c.z }, supply: 1, range: 1.9 });
        }
        this.noise(g, D.landNoise, null);
        this.emit({ type: 'supplyDrop', drop: d.id, stage: 'landed', pos: { ...g } });
      } else if (d.stage === 'landed' && this.time - f.land > D.lifetime) {
        this.removeDrop(d);
      }
    }
  }

  /** Whether this drop carries an exclusive weapon, and which: none before five minutes survived. */
  private rollExclusive(): WeaponId | null {
    const D = SUPPLY_DROPS;
    if (this.forceExclusive) {
      const w = this.forceExclusive;
      this.forceExclusive = null;
      return w;
    }
    if (this.phaseTime < D.exclusiveAfter || this.rand() >= D.exclusiveChance) return null;
    const total = D.exclusiveWeights.reduce((s, [, k]) => s + k, 0);
    let x = this.rand() * total;
    for (const [w, k] of D.exclusiveWeights) if ((x -= k) < 0) return w;
    return D.exclusiveWeights[D.exclusiveWeights.length - 1][0];
  }

  private lastDt(): number {
    return this.stepDt;
  }

  private removeDrop(d: SupplyDrop): void {
    if (d.stage === 'gone') return;
    d.stage = 'gone';
    if (d.interactable >= 0) this.interactables[d.interactable].supply = 0;
    if (d.caseItem >= 0) this.interactables[d.caseItem].supply = 0;
    if (d.serumItem >= 0) this.interactables[d.serumItem].supply = 0;
    if (d.body) this.physics.world.removeRigidBody(d.body);
    d.body = null;
    this.emit({ type: 'supplyDrop', drop: d.id, stage: 'gone', pos: { ...d.flight.ground } });
  }

  /** Open ground for a crate to land on: flat walkable cells all around, nothing overhead. */
  private openGround(pos: Vec3): boolean {
    const nav = this.nav;
    const r = SUPPLY_DROPS.clearRadius;
    for (let dz = -r; dz <= r; dz += 0.5) {
      for (let dx = -r; dx <= r; dx += 0.5) {
        if (dx * dx + dz * dz > r * r) continue;
        const m = nav.nodeAt(pos.x + dx, pos.y, pos.z + dz, 0);
        if (!nav.reachable(m) || nav.flags[m] & (NAV_INDOOR | NAV_NEAR_WALL) || Math.abs(nav.nodeY[m] - pos.y) > 0.2) return false;
      }
    }
    for (const o of this.overhead) if (Math.hypot(o.x - pos.x, o.z - pos.z) < o.r + 1.4) return false;
    for (const [dx, dz] of [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) {
      if (this.physics.raycast(pos.x + dx, pos.y + 0.6, pos.z + dz, 0, 1, 0, 60) !== null) return false;
    }
    return true;
  }

  /** Picks a landing spot near the survivors and plans the helicopter's flight over it. */
  private planFlight(): HeliFlight | null {
    const D = SUPPLY_DROPS;
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (!alive.length || !this.outdoorNodes.length) return null;
    for (let tries = 0; tries < 200; tries++) {
      // Somewhere in the distance band around one of the survivors.
      const who = alive[Math.floor(this.rand() * alive.length)].motion.pos;
      const ang = this.rand() * Math.PI * 2, dd = D.minDistance + this.rand() * (D.maxDistance - D.minDistance);
      const n = this.nav.nodeAt(who.x + Math.cos(ang) * dd, 0.1, who.z + Math.sin(ang) * dd, 0.5);
      if (!this.nav.reachable(n) || this.nav.flags[n] & NAV_INDOOR) continue;
      const pos = this.nav.nodePos(n);
      let nearest = Infinity;
      for (const p of alive) nearest = Math.min(nearest, dist2D(p.motion.pos, pos));
      if (nearest < D.minDistance || nearest > D.maxDistance) continue;
      if (!this.openGround(pos)) continue;
      const a = this.rand() * Math.PI * 2;
      const b = a + (this.rand() < 0.5 ? -1 : 1) * (0.5 + this.rand() * 0.6);
      const reach = this.map.halfExtent + 45;
      const over = { x: pos.x, y: pos.y + D.altitude, z: pos.z };
      const from = { x: over.x - Math.cos(a) * reach, y: over.y + 6, z: over.z - Math.sin(a) * reach };
      const to = { x: over.x + Math.cos(b) * reach, y: over.y + 10, z: over.z + Math.sin(b) * reach };
      const start = this.time;
      // Cruise, then a few seconds slowing into the hover (the client eases the same way).
      const arrive = start + dist2D(from, over) / D.speed + 2.5;
      const release = arrive + D.hover;
      const leave = release + D.linger;
      const end = leave + dist2D(over, to) / D.speed + 2.5;
      return {
        from, over, to, start, arrive, release, leave, end,
        ground: { x: pos.x, y: pos.y, z: pos.z }, land: release + D.releaseHeight / D.fallSpeed, releaseHeight: D.releaseHeight,
      };
    }
    return null;
  }

  /** The next drop carries this weapon whatever the roll (debugging and tests). */
  forceExclusive: WeaponId | null = null;

  /** The next drop carries a Lazarus serum whatever the roll (debugging and tests). */
  forceSerum = false;

  /** Starts a supply drop now (debugging and tests); `weapon` puts an exclusive in it, `serum` a serum. */
  callSupplyDrop(weapon?: WeaponId, serum = false): SupplyDrop | null {
    if (weapon && WEAPONS[weapon]?.exclusive) this.forceExclusive = weapon;
    if (serum) this.forceSerum = true;
    if (this.phase !== 'survival') return null;
    this.nextDropAt = this.phaseTime;
    this.runDrops();
    const d = this.drops[this.drops.length - 1];
    return d && d.stage === 'inbound' && d.flight.start === this.time ? d : null;
  }

  private onArsenal(p: SimPlayer, t: ArsenalTick): void {
    const a = p.arsenal;
    switch (t) {
      case 'shell':
        this.emit({ type: 'reload', player: p.id, weapon: a.weapon.id, stage: 'shell' });
        break;
      case 'reloaded':
        this.emit({ type: 'reload', player: p.id, weapon: a.weapon.id, stage: 'end' });
        break;
      case 'bandaged': {
        if (p.bandages <= 0) break;
        p.bandages--;
        const before = p.health;
        p.health = Math.min(PLAYER.maxHealth, p.health + COMBAT.bandageHeal);
        this.emit({ type: 'bandage', player: p.id, stage: 'end' });
        this.emit({ type: 'playerHealed', player: p.id, amount: p.health - before, health: p.health });
        break;
      }
      case 'meleeHit':
        this.resolveMelee(p);
        break;
      case 'thrown':
        this.explosives.release(p, a.throwKind, p.throwAim ?? this.meleeRay(p));
        p.throwAim = null;
        break;
      case 'throwDone':
        this.emit({ type: 'draw', player: p.id, slot: a.active, weapon: a.weapon.id });
        break;
      case 'meleeDone':
        // The arm came apart mid-swing: back to the gun.
        if (a.limb?.broken) this.dropLimb(p, false);
        break;
      default:
        break;
    }
  }

  private resolveMelee(p: SimPlayer): void {
    const a = p.arsenal;
    const m = p.motion;
    const limb = a.meleeWith === 'limb' ? a.limb : null;
    const club = limb ? limbClub(limb.cut, limb.kind) : null;
    const md = MELEE[a.meleeId];
    const reach = club ? club.reach : md.reach;
    const arc = club ? LIMBS.arc : md.arc;
    const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
    const chest = p.chest;
    const targets: { z: Zombie; d: number }[] = [];
    for (const z of this.zombies) {
      if (!z.alive) continue;
      const dx = z.pos.x - m.pos.x, dz = z.pos.z - m.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + z.def.radius || Math.abs(z.pos.y - m.pos.y) > 1.3) continue;
      if (d > 0.3 && Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1)) > arc / 2) continue;
      const zc = z.chest;
      const lx = zc.x - chest.x, ly = zc.y - chest.y, lz = zc.z - chest.z;
      const ll = Math.hypot(lx, ly, lz) || 1;
      const hit = this.physics.raycast(chest.x, chest.y, chest.z, lx / ll, ly / ll, lz / ll, ll);
      if (hit !== null && hit < ll - 0.3) continue;
      targets.push({ z, d });
    }
    targets.sort((a, b) => a.d - b.d);
    this.noise(m.pos, club ? LIMBS.noise : md.noise, p.id);
    // A raider within the swing takes it too (the nearest one).
    let struck = false;
    for (const r of this.raid.raiders) {
      if (!r.alive || struck) continue;
      const dx = r.pos.x - m.pos.x, dz = r.pos.z - m.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + 0.35 || Math.abs(r.pos.y - m.pos.y) > 1.3) continue;
      if (d > 0.3 && Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1)) > arc / 2) continue;
      const dir = { x: dx / (d || 1), y: 0, z: dz / (d || 1) };
      const head = m.pitch > 0.12;
      this.raid.hit(p, r, club ? club.damage : md.damage, head ? 'head' : 'torso', head ? r.eye : r.chest, dir, true);
      struck = true;
    }
    if (struck && !targets.length) {
      this.emit({ type: 'melee', player: p.id, stage: 'hit', limb: !!limb });
      return;
    }
    if (!targets.length) {
      this.emit({ type: 'melee', player: p.id, stage: 'miss', limb: !!limb });
      return;
    }
    const aim = this.meleeRay(p);
    let first: { pos: Vec3; dir: Vec3 } | null = null;
    for (const [i, { z }] of targets.slice(0, club ? club.targets : md.targets).entries()) {
      const zc = z.chest;
      const dir = { x: zc.x - chest.x, y: 0, z: zc.z - chest.z };
      const l = Math.hypot(dir.x, dir.z) || 1;
      dir.x /= l;
      dir.z /= l;
      // What the crosshair is on decides where it lands (an arm in the way gets cut).
      const far = Math.hypot(zc.x - aim.origin.x, zc.y - aim.origin.y, zc.z - aim.origin.z) + 1.2;
      const h = rayZones(aim.origin, aim.dir, z.zones(this.zones), far, 0.06);
      let zone: HitZone;
      let at: Vec3;
      if (h) {
        zone = h.zone;
        at = { x: aim.origin.x + aim.dir.x * h.t, y: aim.origin.y + aim.dir.y * h.t, z: aim.origin.z + aim.dir.z * h.t };
      } else {
        zone = m.pitch > 0.12 ? 'head' : 'torso';
        at = { x: zc.x - dir.x * 0.2, y: zone === 'head' ? z.pos.y + 1.62 * z.scale : zc.y, z: zc.z - dir.z * 0.2 };
      }
      const base = club ? club.damage : md.damage;
      const zoneK = zone === 'head' ? (club ? LIMBS.headBonus : md.head) : zone === 'torso' ? 1 : ZONE_MULTIPLIER[zone];
      const share = i === 0 ? 1 : club ? 0.75 : md.share;
      // Blades cut toward taking the arm off; blunt weapons only bruise it.
      this.hitZombie(p, z, base * zoneK * share, zone, at, dir, true, club ? 1.3 : md.sever > 0 ? 1 : 1.25, {
        along: h?.along ?? 0.5,
        armTally: base * (club ? LIMBS.clubTear : md.sever) * share,
        limb: limb?.id,
        knock: club ? LIMBS.knockback : md.knockback,
        weapon: club ? undefined : a.meleeId,
      });
      first ??= { pos: at, dir };
    }
    this.emit({ type: 'melee', player: p.id, stage: 'hit', limb: !!limb });
    // Every blow that lands tears it up a little more.
    if (limb && first && --limb.wear <= 0) this.breakLimb(p, limb, first.pos, first.dir);
  }
}
