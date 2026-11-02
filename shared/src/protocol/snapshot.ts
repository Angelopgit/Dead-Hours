import { RAPIER, GROUP, groups } from '../physics/Physics';
import type { HitZone, WeaponId } from '../config/weapons';
import type { ArmState, LegState, LimbCut, LimbZone } from '../config/limbs';
import { isMelee } from '../config/melee';
import type { ZombieKind } from '../config/zombies';
import { RAID } from '../config/raid';
import type { ThrowKind } from '../config/throwables';
import type { Arsenal, ArsenalAction, HeldLimb } from '../sim/Arsenal';
import type { InteractKind, PlayerMotion, PlayerStats, Simulation } from '../sim/Simulation';
import { Zombie, type ZombieState } from '../sim/Zombie';
import { Raider, type RaidStage } from '../sim/Raid';
import { noLulls } from '../sim/Lulls';
import type { SimEvent, SimPhase } from '../sim/events';
import { clamp, type Quat, type Vec3 } from '../sim/math';
import { decodeBuild, defaultBuild, encodeBuild } from '../config/progression';
import { VEHICLE } from '../config/vehicles';
import { DRIVE_FLAG, type DriveState } from '../sim/Vehicles';

// Index tables for the wire format (append only: old clients read new numbers otherwise).
const KINDS: ZombieKind[] = ['walker', 'runner', 'brute', 'crawler', 'screamer', 'bloater'];
const STATES: ZombieState[] = ['idle', 'wander', 'approach', 'investigate', 'chase', 'attack', 'bash', 'stagger', 'down', 'dead', 'scream', 'breach', 'vault'];
const PHASES: SimPhase[] = ['preparation', 'survival', 'over'];
const ACTIONS: ArsenalAction[] = ['idle', 'draw', 'reload', 'melee', 'bandage', 'throw'];
const WEAPON_IDS: WeaponId[] = ['ar', 'smg', 'shotgun', 'marksman', 'pistol', 'machete', 'lmg', 'battle', 'sniper', 'katana', 'bat', 'crowbar', 'wrench', 'hockey', 'rpg', 'wraith', 'katanas', 'akimbo'];
const ITEM_KINDS: InteractKind[] = ['weapons', 'ammo', 'medical', 'supply', 'exclusive', 'serum', 'melee'];
const THROWS: ThrowKind[] = ['frag', 'molotov'];
const ARM_STATES: ArmState[] = ['intact', 'elbow', 'shoulder'];
const LEG_STATES: LegState[] = ['intact', 'knee', 'hip'];
/** Which limb a severed limb was (legs came later, hence the name). */
const ARMS: LimbZone[] = ['armL', 'armR', 'legL', 'legR'];
const CUTS: LimbCut[] = ['shoulder', 'elbow', 'hip', 'knee'];
const ZONES: HitZone[] = ['head', 'torso', 'armL', 'armR', 'legL', 'legR'];
const RAID_STAGES: RaidStage[] = ['waiting', 'inbound', 'arrived', 'over'];

const idx = <T>(table: readonly T[], v: T): number => Math.max(0, table.indexOf(v));
const _carAt: Vec3 = { x: 0, y: 0, z: 0 };
const cm = (v: number) => Math.round(v * 100);
const mm = (v: number) => Math.round(v * 1000);
const milli = (v: number) => Math.round(v * 1000);

/** A survivor in a snapshot. Numbers are integers: centimetres, milliradians, milliseconds. */
export interface SnapPlayer {
  id: string;
  /** Name and look (encodeAppearance). */
  n: string;
  a: string;
  /** [x, y, z, vx, vy, vz, yaw, pitch, facing, eyeHeight, flags (MOTION_FLAG)] */
  m: number[];
  /** Health ×10, alive, bandages, died at (ms). */
  hp: number;
  al: number;
  b: number;
  dt: number;
  /** Lazarus serum armor ×10 (left out when none). */
  ar?: number;
  /** [active (1 secondary, +2 melee held out), action, actionT, actionTotal, primary id, mag, reserve, secondary id, mag, reserve, melee with limb, aim ×1000, melee weapon,
   * frags, Molotovs, throw kind] */
  w: number[];
  /** The arm in hand: [id, arm, cut, kind, look, scale ×1000, wear, maxWear, broken], or 0. */
  lb: number[] | 0;
  /** Downed: [bleed left (ms), revive progress (ms), downs], or 0 when on their feet. */
  dn: number[] | 0;
  /** Who is reviving them ('' for nobody). */
  rv: string;
  /** Builds of the primary and secondary: encodeBuild() of each, back to back (absent from older servers). */
  k?: string;
  s: PlayerStats;
}

/**
 * The whole visible world at one server step, sent ~20 times a second. Zombies, arms, doors
 * and interactables are flat number arrays (see captureSnapshot for the layouts).
 */
export interface Snapshot {
  /** Server simulation time (seconds). */
  t: number;
  ph: number;
  /** Phase time (ms): preparation left, or survived so far. */
  pt: number;
  p: SnapPlayer[];
  z: number[][];
  l: (number | string)[][];
  /** [door index, open, target ×1000, ...] */
  d: number[];
  /** Wooden doors with pieces knocked out: [door, pieces]... (left out when none are). */
  dw?: number[];
  i: number[][];
  /** Boarded openings: [slot, boards, damage ×1000, glass in, ...]. */
  b?: number[];
  /** Smashed window panes: one bit per slot (slot i is bit i % 4 of hex digit i / 4), trailing zeros left off. */
  g?: string;
  /** The van raid, while it is on: [route, stage, x, z (cm), yaw (mrad), speed (cm/s), door open]. */
  v?: number[];
  /** Raiders (see captureSnapshot). */
  r?: number[][];
  /** Skateboards: [id, x, y, z (cm), yaw (mrad), rider id or 0, look × 2 + flipped]. */
  sk?: (number | string)[][];
  /** Lulls, once the first has begun: [count, start, end, paused (survival ms)] (see Lulls.ts). */
  lu?: number[];
  /**
   * Vehicles anyone has moved or sat in (the rest are as the map and the seed leave them):
   * [id, x, y, z (cm), yaw (mrad), vx, vz, speed (cm/s), steer (mrad), gas (‰), DRIVE_FLAG bits, then each seat's survivor id or 0].
   */
  vh?: (number | string)[][];
  /** Bicycles: [id, x, y, z (cm), yaw (mrad), rider id or 0, passenger id or 0, look]. */
  bk?: (number | string)[][];
}

/** Bit flags in a motion message and a snapshot's player motion. */
export const MOTION_FLAG = { crouching: 1, sprinting: 2, aiming: 4, grounded: 8, trigger: 16, light: 32, pushing: 64, vaulting: 128, cycling: 256 } as const;

function flagsOf(m: PlayerMotion, trigger = false): number {
  return (m.crouching ? MOTION_FLAG.crouching : 0) | (m.sprinting ? MOTION_FLAG.sprinting : 0) | (m.aiming ? MOTION_FLAG.aiming : 0)
    | (m.grounded ? MOTION_FLAG.grounded : 0) | (trigger ? MOTION_FLAG.trigger : 0) | (m.light ? MOTION_FLAG.light : 0)
    | (m.pushing ? MOTION_FLAG.pushing : 0) | (m.vaulting ? MOTION_FLAG.vaulting : 0) | (m.bike !== undefined && Number.isFinite(m.bike) ? MOTION_FLAG.cycling : 0);
}

/** Smashed panes as a hex bit string (see Snapshot.g). */
export function packPanes(broken: (i: number) => boolean, count: number): string {
  let out = '';
  let end = 0;
  for (let i = 0; i < count; i += 4) {
    let n = 0;
    for (let k = 0; k < 4 && i + k < count; k++) if (broken(i + k)) n |= 1 << k;
    out += n.toString(16);
    if (n) end = out.length;
  }
  return out.slice(0, end);
}

/** Calls `fn` for every slot a hex bit string (Snapshot.g) says is smashed. */
export function unpackPanes(g: string, fn: (i: number) => void): void {
  for (let d = 0; d < g.length; d++) {
    const n = parseInt(g[d], 16);
    if (!n) continue;
    for (let k = 0; k < 4; k++) if (n & (1 << k)) fn(d * 4 + k);
  }
}

/** Captures the world for clients. `facing` is each survivor's body facing (the server keeps it beside the sim). */
export function captureSnapshot(sim: Simulation, facing: ReadonlyMap<string, number>): Snapshot {
  const players: SnapPlayer[] = [];
  for (const p of sim.players.values()) {
    const m = p.motion;
    const a = p.arsenal;
    const l = a.limb;
    players.push({
      id: p.id, n: p.name, a: p.appearance,
      m: [cm(m.pos.x), cm(m.pos.y), cm(m.pos.z), cm(m.vel.x), cm(m.vel.y), cm(m.vel.z), milli(m.yaw), milli(m.pitch), milli(facing.get(p.id) ?? m.yaw + Math.PI), cm(m.eyeHeight), flagsOf(m)],
      hp: Math.round(p.health * 10), al: p.alive ? 1 : 0, b: p.bandages, dt: milli(p.diedAt), ...(p.armor > 0 ? { ar: Math.round(p.armor * 10) } : {}),
      w: [
        (a.active === 'secondary' ? 1 : 0) | (a.meleeOut ? 2 : 0), idx(ACTIONS, a.action), milli(Math.max(0, a.actionT)), milli(a.actionTotal),
        idx(WEAPON_IDS, a.primary.id), a.primary.mag, a.primary.reserve, idx(WEAPON_IDS, a.secondary.id), a.secondary.mag, a.secondary.reserve,
        a.meleeWith === 'limb' ? 1 : 0, milli(a.aim), idx(WEAPON_IDS, a.meleeId),
        a.throwables.frag, a.throwables.molotov, idx(THROWS, a.throwKind),
      ],
      lb: l ? [l.id, idx(ARMS, l.arm), idx(CUTS, l.cut), idx(KINDS, l.kind), l.look, milli(l.scale), l.wear, l.maxWear, l.broken ? 1 : 0] : 0,
      dn: p.downed ? [milli(Math.max(0, p.bleed)), milli(p.revive), p.downs] : 0,
      rv: p.reviver ?? '',
      s: { ...p.stats },
      k: encodeBuild(a.builds[a.primary.id] ?? defaultBuild(a.primary.id)) + encodeBuild(a.builds[a.secondary.id] ?? defaultBuild(a.secondary.id)),
    });
  }
  const zombies: number[][] = [];
  for (const z of sim.zombies) {
    if (!z.alive) continue;
    const h = z.lastHit;
    zombies.push([
      z.id, idx(KINDS, z.kind), z.look, cm(z.pos.x), cm(z.pos.y), cm(z.pos.z), cm(z.vel.x), cm(z.vel.z), milli(z.facing),
      idx(STATES, z.state), milli(z.attackT), cm(z.moveSpeed), milli(z.turnRate), z.grounded ? 1 : 0,
      idx(ARM_STATES, z.arms.armL) * 3 + idx(ARM_STATES, z.arms.armR),
      h ? milli(h.dx) : 0, h ? milli(h.dz) : 0, h ? milli(h.at) : -1, h ? idx(ZONES, h.zone) : 0,
      z.burnUntil > sim.time ? 1 : 0,
      idx(LEG_STATES, z.legs.legL) * 3 + idx(LEG_STATES, z.legs.legR),
    ]);
  }
  const limbs: (number | string)[][] = [];
  for (const l of sim.limbs) {
    limbs.push([
      l.id, idx(ARMS, l.arm), idx(CUTS, l.cut), idx(KINDS, l.kind), l.look, milli(l.scale), l.wear, l.maxWear, l.holder ?? 0,
      mm(l.pos.x), mm(l.pos.y), mm(l.pos.z), Math.round(l.rot.x * 1e4), Math.round(l.rot.y * 1e4), Math.round(l.rot.z * 1e4), Math.round(l.rot.w * 1e4),
      mm(l.length), mm(l.radius), milli(l.bornAt), milli(l.looseAt),
    ]);
  }
  const doors: number[] = [];
  for (const d of sim.doors) if (d) doors.push(d.index, d.open ? 1 : 0, milli(d.targetAngle));
  const wear: number[] = [];
  for (const d of sim.doors) if (d && d.pieces > 0) wear.push(d.index, d.pieces);
  const items: number[][] = [];
  for (const it of sim.interactables) {
    if (!it) continue;
    items.push([it.id, idx(ITEM_KINDS, it.kind), cm(it.pos.x), cm(it.pos.y), cm(it.pos.z), Number.isFinite(it.supply) ? it.supply : -1, cm(it.range), it.weapon ? idx(WEAPON_IDS, it.weapon) : -1, (it.frags ? 1 : 0) | (it.molotovs ? 2 : 0)]);
  }
  const bars: number[] = [];
  for (const b of sim.barricades.slots) {
    if (b.boards > 0) bars.push(b.index, b.boards, milli(b.damage), b.glass ? 1 : 0);
  }
  const slots = sim.barricades.slots;
  const panes = packPanes((i) => slots[i].kind === 'window' && !slots[i].glass, slots.length);
  const boards: (number | string)[][] = [];
  for (const k of sim.skateboards.boards) boards.push([k.id, cm(k.pos.x), cm(k.pos.y), cm(k.pos.z), milli(k.yaw), k.rider ?? 0, k.look * 2 + (k.flipped ? 1 : 0)]);
  const bikes: (number | string)[][] = [];
  for (const k of sim.bicycles.bikes) bikes.push([k.id, cm(k.pos.x), cm(k.pos.y), cm(k.pos.z), milli(k.yaw), k.rider ?? 0, k.passenger ?? 0, k.look]);
  const snap: Snapshot = { t: sim.time, ph: idx(PHASES, sim.phase), pt: milli(sim.phaseTime), p: players, z: zombies, l: limbs, d: doors, i: items, b: bars, sk: boards, bk: bikes };
  const lull = sim.lull;
  if (lull.count > 0) snap.lu = [lull.count, milli(lull.start), milli(lull.end), milli(lull.paused)];
  if (panes) snap.g = panes;
  const cars: (number | string)[][] = [];
  for (const v of sim.vehicles.list) {
    if (!v.touched) continue;
    const flags = v.input | (v.engine ? DRIVE_FLAG.engine : 0) | (v.crank > 0 ? DRIVE_FLAG.cranking : 0);
    cars.push([
      v.id, cm(v.pos.x), cm(v.pos.y), cm(v.pos.z), milli(v.yaw), cm(v.vel.x), cm(v.vel.z), cm(v.speed), milli(v.steer), milli(v.gas), flags,
      ...v.seats.map((id) => id ?? 0),
    ]);
  }
  if (cars.length) snap.vh = cars;
  if (wear.length) snap.dw = wear;
  const raid = sim.raid;
  const van = raid.van;
  if (van) snap.v = [van.route, idx(RAID_STAGES, raid.stage), cm(van.pos.x), cm(van.pos.z), milli(van.yaw), cm(van.speed), van.door ? 1 : 0];
  if (raid.raiders.length) {
    snap.r = raid.raiders.filter((r) => r.alive).map((r) => {
      const m = r.motion, a = r.arsenal, h = r.lastHit;
      return [
        r.num, idx(WEAPON_IDS, r.weapon), r.seed, cm(m.pos.x), cm(m.pos.y), cm(m.pos.z), cm(m.vel.x), cm(m.vel.z), milli(r.facing), milli(m.pitch),
        (m.aiming ? 1 : 0) | (m.sprinting ? 2 : 0) | (m.grounded ? 4 : 0), idx(ACTIONS, a.action), milli(Math.max(0, a.actionT)), milli(a.actionTotal),
        a.weapon.mag, Math.round(r.health * 10), h ? milli(h.at) : -1, h ? milli(h.dx) : 0, h ? milli(h.dz) : 0, h ? idx(ZONES, h.zone) : 0,
      ];
    });
  }
  return snap;
}

// ------------------------------------------------------------------ motion messages

/** A survivor's movement and aim, as the client sends it ~30 times a second. */
export interface MotionFrame {
  motion: PlayerMotion;
  facing: number;
  /** Trigger held (automatic fire continues on the server). */
  trigger: boolean;
  aimOrigin: Vec3;
  aimDir: Vec3;
}

/**
 * [x, y, z (mm), vx, vy, vz (cm/s), yaw, pitch, facing (mrad), eyeHeight (mm), flags, aim origin (mm) ×3, aim dir ×10000 ×3,
 * and while on a skateboard its heading (mrad), or while riding a bicycle its heading (with MOTION_FLAG.cycling)]
 */
export function packMotion(f: MotionFrame): number[] {
  const m = f.motion;
  const out = [
    mm(m.pos.x), mm(m.pos.y), mm(m.pos.z), cm(m.vel.x), cm(m.vel.y), cm(m.vel.z), milli(m.yaw), milli(m.pitch), milli(f.facing),
    mm(m.eyeHeight), flagsOf(m, f.trigger),
    mm(f.aimOrigin.x), mm(f.aimOrigin.y), mm(f.aimOrigin.z), Math.round(f.aimDir.x * 1e4), Math.round(f.aimDir.y * 1e4), Math.round(f.aimDir.z * 1e4),
  ];
  const heading = m.bike !== undefined && Number.isFinite(m.bike) ? m.bike : m.board;
  if (heading !== undefined && Number.isFinite(heading)) out.push(milli(Math.atan2(Math.sin(heading), Math.cos(heading))));
  return out;
}

/** Reads a motion message, or null when it is malformed. */
export function unpackMotion(a: unknown): MotionFrame | null {
  if (!Array.isArray(a) || (a.length !== 17 && a.length !== 18)) return null;
  for (const v of a) if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7) return null;
  const n = a as number[];
  const flags = n[10];
  return {
    motion: {
      pos: { x: n[0] / 1000, y: n[1] / 1000, z: n[2] / 1000 },
      vel: { x: n[3] / 100, y: n[4] / 100, z: n[5] / 100 },
      yaw: n[6] / 1000, pitch: clamp(n[7] / 1000, -1.6, 1.6), eyeHeight: clamp(n[9] / 1000, 0.5, 2),
      crouching: !!(flags & MOTION_FLAG.crouching), sprinting: !!(flags & MOTION_FLAG.sprinting),
      aiming: !!(flags & MOTION_FLAG.aiming), grounded: !!(flags & MOTION_FLAG.grounded),
      light: !!(flags & MOTION_FLAG.light),
      pushing: !!(flags & MOTION_FLAG.pushing),
      vaulting: !!(flags & MOTION_FLAG.vaulting),
      board: n.length === 18 && !(flags & MOTION_FLAG.cycling) ? clamp(n[17] / 1000, -4, 4) : undefined,
      bike: n.length === 18 && flags & MOTION_FLAG.cycling ? clamp(n[17] / 1000, -4, 4) : undefined,
    },
    facing: n[8] / 1000,
    trigger: !!(flags & MOTION_FLAG.trigger),
    aimOrigin: { x: n[11] / 1000, y: n[12] / 1000, z: n[13] / 1000 },
    aimDir: { x: n[14] / 1e4, y: n[15] / 1e4, z: n[16] / 1e4 },
  };
}

/** [vehicle, x, y, z (mm), yaw (mrad), vx, vz, speed (cm/s), steer (mrad), DRIVE_FLAG bits, speed lost in a crash (cm/s)] */
export function packDrive(d: DriveState): number[] {
  return [
    d.vehicle, mm(d.pos.x), mm(d.pos.y), mm(d.pos.z), milli(Math.atan2(Math.sin(d.yaw), Math.cos(d.yaw))),
    cm(d.vel.x), cm(d.vel.z), cm(d.speed), milli(d.steer), d.input, cm(d.crash),
  ];
}

/** Reads a drive message, or null when it is malformed. */
export function unpackDrive(a: unknown): DriveState | null {
  if (!Array.isArray(a) || a.length !== 11) return null;
  for (const v of a) if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7) return null;
  const n = a as number[];
  if (!Number.isInteger(n[0]) || n[0] < 0) return null;
  const top = VEHICLE.maxSpeed * 1.5;
  return {
    vehicle: n[0],
    pos: { x: n[1] / 1000, y: n[2] / 1000, z: n[3] / 1000 },
    yaw: clamp(n[4] / 1000, -4, 4),
    vel: { x: clamp(n[5] / 100, -top, top), y: 0, z: clamp(n[6] / 100, -top, top) },
    speed: clamp(n[7] / 100, -top, top),
    steer: clamp(n[8] / 1000, -1, 1),
    input: n[9] | 0,
    crash: clamp(n[10] / 100, 0, top),
  };
}

// ------------------------------------------------------------------ the client's copy

/** Where a remote survivor is drawn from and heading to (positions rebased on every snapshot). */
interface Track {
  prev: Vec3;
  pos: Vec3;
  at: number;
  span: number;
  facing: number;
}

/** The same for a vehicle someone else drives, with its heading. */
interface CarTrack {
  prev: Vec3;
  pos: Vec3;
  prevYaw: number;
  yaw: number;
  at: number;
  span: number;
}

function nlerp(a: Quat, b: Quat, u: number, out: Quat): Quat {
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  const x = a.x + (b.x * s - a.x) * u, y = a.y + (b.y * s - a.y) * u, z = a.z + (b.z * s - a.z) * u, w = a.w + (b.w * s - a.w) * u;
  const l = Math.hypot(x, y, z, w) || 1;
  out.x = x / l; out.y = y / l; out.z = z / l; out.w = w / l;
  return out;
}

/**
 * A network client's copy of the server's world, kept in a local Simulation that never steps:
 * the renderers draw it exactly as they draw a solo game. Snapshots set zombies, survivors,
 * arms, doors and supplies; every position is rebased so it glides from where it is drawn now
 * to where the server says over one snapshot interval. The client's own survivor keeps its
 * locally simulated movement, and its weapon state while a predicted action is in flight.
 */
export class Mirror {
  /** Local clock minus server clock (latency included), held near the quickest delivery seen. */
  private offset = NaN;
  private lastArrival = NaN;
  /** Seconds between snapshots, smoothed. */
  interval = 0.05;
  private base = { t: 0, phase: 'preparation' as SimPhase, phaseTime: 0 };
  private lastTick = 0;
  private limbAt = 0;
  private limbSpan = 0.05;
  private holdSelfUntil = -Infinity;
  private readonly doorHold = new Map<number, number>();
  private readonly boardHold = new Map<number, number>();
  private readonly bikeHold = new Map<number, number>();
  private readonly tracks = new Map<string, Track>();
  private readonly carTracks = new Map<number, CarTrack>();
  private readonly held = new Map<number, HeldLimb>();
  /** Each survivor's weapons and builds as last applied (snapshots repeat them). */
  private readonly buildSeen = new Map<string, string>();
  private readonly zmap = new Map<number, Zombie>();
  /** Snapshots applied so far. */
  count = 0;

  constructor(readonly sim: Simulation, readonly me: string) {}

  get synced(): boolean {
    return this.count > 0;
  }

  /** Estimated server time at local time `now` (seconds). */
  serverTime(now: number): number {
    return Number.isNaN(this.offset) ? this.sim.time : now - this.offset;
  }

  /** The next snapshot applies this survivor's builds again even if they look unchanged (after a predicted refit). */
  forgetBuilds(id: string): void {
    this.buildSeen.delete(id);
  }

  /** Keeps the client's own weapon state (a predicted action) from being overwritten until `until`. */
  holdSelf(until: number): void {
    this.holdSelfUntil = Math.max(this.holdSelfUntil, until);
  }

  /** Keeps a door the client just toggled as it is until `until`. */
  holdDoor(index: number, until: number): void {
    this.doorHold.set(index, until);
  }

  /** Keeps a skateboard the client just hopped on or off as it is until `until`. */
  holdBoard(id: number, until: number): void {
    this.boardHold.set(id, until);
  }

  /** Keeps a bicycle the client just got on or off as it is until `until`. */
  holdBike(id: number, until: number): void {
    this.bikeHold.set(id, until);
  }

  /** Advances the copy's clock to the estimated server time (call every frame). */
  tick(now: number): void {
    if (Number.isNaN(this.offset)) return;
    const sim = this.sim;
    const t = Math.max(sim.time, now - this.offset);
    const dt = t - this.lastTick;
    this.lastTick = t;
    sim.time = t;
    const b = this.base;
    sim.phase = b.phase;
    const since = t - b.t;
    sim.phaseTime = b.phase === 'preparation' ? Math.max(0, b.phaseTime - since) : b.phase === 'survival' ? b.phaseTime + Math.max(0, since) : b.phaseTime;
    // Swipes and door pounding keep going between snapshots.
    if (dt > 0 && dt < 0.5) for (const z of sim.zombies) if (z.state === 'attack' || z.state === 'bash' || z.state === 'scream' || z.state === 'breach') z.attackT += dt;
  }

  /** Fraction of the way from the previous arm poses to the newest (LimbView's interpolation). */
  get limbAlpha(): number {
    return clamp((this.sim.time - this.limbAt) / this.limbSpan, 0, 1);
  }

  /** Seconds the arms' interpolation spans (their speed for landing splats). */
  get limbStep(): number {
    return this.limbSpan;
  }

  /** Where a remote survivor is drawn now, and their body facing. */
  playerPose(id: string, out: Vec3): number | null {
    const tr = this.tracks.get(id);
    if (!tr) return null;
    const u = clamp((this.sim.time - (tr.at - tr.span)) / tr.span, 0, 1);
    out.x = tr.prev.x + (tr.pos.x - tr.prev.x) * u;
    out.y = tr.prev.y + (tr.pos.y - tr.prev.y) * u;
    out.z = tr.prev.z + (tr.pos.z - tr.prev.z) * u;
    return tr.facing;
  }

  /**
   * Where a vehicle is drawn now (gliding between snapshots), and its heading; null for one
   * nobody has moved, or the one this client drives (both are where the copy has them).
   */
  vehiclePose(id: number, out: Vec3): number | null {
    const tr = this.carTracks.get(id);
    if (!tr) return null;
    const u = clamp((this.sim.time - (tr.at - tr.span)) / tr.span, 0, 1);
    out.x = tr.prev.x + (tr.pos.x - tr.prev.x) * u;
    out.y = tr.prev.y + (tr.pos.y - tr.prev.y) * u;
    out.z = tr.prev.z + (tr.pos.z - tr.prev.z) * u;
    return tr.prevYaw + Math.atan2(Math.sin(tr.yaw - tr.prevYaw), Math.cos(tr.yaw - tr.prevYaw)) * u;
  }

  /** Forgets how a vehicle was gliding (this client took the wheel, or was put back by the server). */
  dropVehicleTrack(id: number): void {
    this.carTracks.delete(id);
  }

  /** Moves every zombie's collision capsule to where it is drawn (the local survivor bumps into them). */
  updateBodies(): void {
    const t = this.sim.time;
    // Vehicles others drive: their bodies follow where they are drawn.
    for (const id of this.carTracks.keys()) {
      const v = this.sim.vehicles.vehicle(id);
      const yaw = v ? this.vehiclePose(id, _carAt) : null;
      if (!v || yaw === null) continue;
      this.sim.vehicles.bodyTo(v, _carAt, yaw);
    }
    for (const r of this.sim.raid.raiders) {
      if (!r.body || !r.alive) continue;
      const u = clamp((t - (r.updatedAt - r.lastDt)) / Math.max(1e-4, r.lastDt), 0, 1);
      r.body.setNextKinematicTranslation({
        x: r.prev.x + (r.pos.x - r.prev.x) * u, y: r.prev.y + (r.pos.y - r.prev.y) * u + RAID.height / 2 + 0.02, z: r.prev.z + (r.pos.z - r.prev.z) * u,
      });
    }
    for (const z of this.sim.zombies) {
      const u = clamp((t - (z.updatedAt - z.lastDt)) / Math.max(1e-4, z.lastDt), 0, 1);
      z.body.setNextKinematicTranslation({
        x: z.prev.x + (z.pos.x - z.prev.x) * u,
        y: z.prev.y + (z.pos.y - z.prev.y) * u + z.bodyHeight / 2 + 0.02,
        z: z.prev.z + (z.pos.z - z.prev.z) * u,
      });
    }
  }

  apply(s: Snapshot, now: number): void {
    const sim = this.sim;
    const sample = now - s.t;
    if (Number.isNaN(this.offset) || sample < this.offset) this.offset = sample;
    // Creeps up slowly in case the server runs behind real time for good.
    else this.offset = Math.min(sample, this.offset + (now - this.lastArrival) * 0.01);
    if (!Number.isNaN(this.lastArrival)) {
      const gap = now - this.lastArrival;
      if (gap > 0 && gap < 0.5) this.interval += (clamp(gap, 0.02, 0.25) - this.interval) * 0.1;
    }
    this.lastArrival = now;
    this.base = { t: s.t, phase: PHASES[s.ph] ?? 'survival', phaseTime: s.pt / 1000 };
    if (this.count === 0) this.lastTick = sim.time = s.t;
    this.tick(now);
    this.count++;
    const T = sim.time;
    const span = this.interval * 1.15;

    // Arms first: an arm in someone's hands is the same object as the one in the world list.
    const limbSeen = new Set<number>();
    const ua = this.limbAlpha;
    for (const r of s.l) {
      const n = r as number[];
      const id = n[0];
      limbSeen.add(id);
      const holder = typeof r[8] === 'string' ? (r[8] as string) : null;
      const x = n[9] / 1000, y = n[10] / 1000, z = n[11] / 1000;
      const q = { x: n[12] / 1e4, y: n[13] / 1e4, z: n[14] / 1e4, w: n[15] / 1e4 };
      nlerp(q, q, 0, q);
      let l = sim.limb(id);
      if (!l) {
        l = {
          id, arm: ARMS[n[1]] ?? 'armL', cut: CUTS[n[2]] ?? 'shoulder', kind: KINDS[n[3]] ?? 'walker', look: n[4], scale: n[5] / 1000,
          wear: n[6], maxWear: n[7], broken: false, holder, body: null,
          pos: { x, y, z }, rot: { ...q }, prevPos: { x, y, z }, prevRot: { ...q },
          length: n[16] / 1000, radius: n[17] / 1000, bornAt: n[18] / 1000, looseAt: n[19] / 1000,
        };
        sim.limbs.push(l);
      } else {
        // From where it is drawn now.
        l.prevPos.x += (l.pos.x - l.prevPos.x) * ua;
        l.prevPos.y += (l.pos.y - l.prevPos.y) * ua;
        l.prevPos.z += (l.pos.z - l.prevPos.z) * ua;
        nlerp(l.prevRot, l.rot, ua, l.prevRot);
        if (holder || l.holder) {
          l.prevPos.x = x; l.prevPos.y = y; l.prevPos.z = z;
          Object.assign(l.prevRot, q);
        }
        l.pos.x = x; l.pos.y = y; l.pos.z = z;
        Object.assign(l.rot, q);
        l.holder = holder;
        l.wear = n[6];
        l.looseAt = n[19] / 1000;
      }
    }
    for (let i = sim.limbs.length - 1; i >= 0; i--) if (!limbSeen.has(sim.limbs[i].id)) sim.limbs.splice(i, 1);
    this.limbAt = T;
    this.limbSpan = span;

    // Zombies.
    this.zmap.clear();
    for (const z of sim.zombies) this.zmap.set(z.id, z);
    const zSeen = new Set<number>();
    for (const r of s.z) {
      const id = r[0];
      zSeen.add(id);
      const x = r[3] / 100, y = r[4] / 100, zz = r[5] / 100;
      let z = this.zmap.get(id);
      if (!z) {
        z = new Zombie(id, KINDS[r[1]] ?? 'walker', r[2], { x, y, z: zz }, r[8] / 1000, id, sim);
        sim.zombies.push(z);
        z.updatedAt = T;
        z.lastDt = span;
      } else {
        const u = clamp((T - (z.updatedAt - z.lastDt)) / Math.max(1e-4, z.lastDt), 0, 1);
        z.prev.x += (z.pos.x - z.prev.x) * u;
        z.prev.y += (z.pos.y - z.prev.y) * u;
        z.prev.z += (z.pos.z - z.prev.z) * u;
        z.pos.x = x; z.pos.y = y; z.pos.z = zz;
        z.updatedAt = T + span;
        z.lastDt = span;
      }
      z.vel.x = r[6] / 100;
      z.vel.y = 0;
      z.vel.z = r[7] / 100;
      z.facing = r[8] / 1000;
      const state = STATES[r[9]] ?? 'idle';
      if (z.state === 'dead') continue;
      if (state !== z.state) {
        z.state = state;
        z.stateT = 0;
      }
      z.attackT = r[10] / 1000;
      z.moveSpeed = r[11] / 100;
      z.turnRate = r[12] / 1000;
      z.grounded = r[13] === 1;
      z.arms.armL = ARM_STATES[Math.floor(r[14] / 3)] ?? 'intact';
      z.arms.armR = ARM_STATES[r[14] % 3] ?? 'intact';
      // Legs (left out by older servers: whole).
      const lg = r[20] ?? 0;
      z.syncLegs(LEG_STATES[Math.floor(lg / 3)] ?? 'intact', LEG_STATES[lg % 3] ?? 'intact');
      z.lastHit = r[17] >= 0 ? { zone: ZONES[r[18]] ?? 'torso', dx: r[15] / 1000, dz: r[16] / 1000, at: r[17] / 1000, amount: 0 } : null;
      // On fire (a snapshot later says otherwise once it is out).
      z.burnUntil = r[19] === 1 ? T + 3600 : 0;
    }
    for (let i = sim.zombies.length - 1; i >= 0; i--) {
      const z = sim.zombies[i];
      if (zSeen.has(z.id)) continue;
      z.removeBody();
      sim.zombies.splice(i, 1);
    }

    // Survivors.
    const pSeen = new Set<string>();
    const heldSeen = new Set<number>();
    const holdSelf = now < this.holdSelfUntil;
    for (const sp of s.p) {
      pSeen.add(sp.id);
      const m = sp.m;
      const pos = { x: m[0] / 100, y: m[1] / 100, z: m[2] / 100 };
      let p = sim.players.get(sp.id);
      if (!p) p = sim.addPlayer(sp.id, sp.n, WEAPON_IDS[sp.w[4]] ?? 'ar', WEAPON_IDS[sp.w[7]] ?? 'pistol', pos, m[6] / 1000, sp.a);
      p.health = sp.hp / 10;
      p.alive = sp.al === 1;
      p.bandages = sp.b;
      p.armor = (sp.ar ?? 0) / 10;
      p.diedAt = sp.dt / 1000;
      p.downed = p.alive && Array.isArray(sp.dn);
      if (Array.isArray(sp.dn)) {
        p.bleed = sp.dn[0] / 1000;
        p.revive = sp.dn[1] / 1000;
        p.downs = sp.dn[2];
      } else p.revive = 0;
      p.reviver = sp.rv || null;
      Object.assign(p.stats, sp.s);
      if (sp.lb) heldSeen.add(sp.lb[0]);
      const mine = sp.id === this.me;
      if (!mine) {
        const mo = p.motion;
        mo.vel.x = m[3] / 100; mo.vel.y = m[4] / 100; mo.vel.z = m[5] / 100;
        mo.yaw = m[6] / 1000;
        mo.pitch = m[7] / 1000;
        mo.eyeHeight = m[9] / 100;
        const f = m[10];
        mo.crouching = !!(f & MOTION_FLAG.crouching);
        mo.sprinting = !!(f & MOTION_FLAG.sprinting);
        mo.aiming = !!(f & MOTION_FLAG.aiming);
        mo.grounded = !!(f & MOTION_FLAG.grounded);
        mo.light = !!(f & MOTION_FLAG.light);
        mo.pushing = !!(f & MOTION_FLAG.pushing);
        mo.vaulting = !!(f & MOTION_FLAG.vaulting);
        let tr = this.tracks.get(sp.id);
        if (!tr) {
          tr = { prev: { ...pos }, pos: { ...pos }, at: T, span, facing: m[8] / 1000 };
          this.tracks.set(sp.id, tr);
        } else {
          const u = clamp((T - (tr.at - tr.span)) / tr.span, 0, 1);
          tr.prev.x += (tr.pos.x - tr.prev.x) * u;
          tr.prev.y += (tr.pos.y - tr.prev.y) * u;
          tr.prev.z += (tr.pos.z - tr.prev.z) * u;
          tr.pos = pos;
          tr.at = T + span;
          tr.span = span;
          tr.facing = m[8] / 1000;
        }
        mo.pos.x = pos.x; mo.pos.y = pos.y; mo.pos.z = pos.z;
      }
      if (!mine || !holdSelf) this.syncArsenal(p.arsenal, sp.w, sp.lb, !mine);
      const seen = sp.k ? `${p.arsenal.primary.id}:${p.arsenal.secondary.id}:${sp.k}` : '';
      if (sp.k && this.buildSeen.get(sp.id) !== seen) {
        this.buildSeen.set(sp.id, seen);
        const a = p.arsenal;
        a.builds = { ...a.builds, [a.primary.id]: decodeBuild(a.primary.id, sp.k.slice(0, 5)), [a.secondary.id]: decodeBuild(a.secondary.id, sp.k.slice(5, 10)) };
      }
    }
    for (const [id, p] of sim.players) {
      if (pSeen.has(id) || id === this.me) continue;
      p.arsenal.limb = null;
      sim.players.delete(id);
      this.tracks.delete(id);
    }
    for (const id of this.held.keys()) if (!heldSeen.has(id)) this.held.delete(id);

    // Doors.
    for (let i = 0; i + 2 < s.d.length; i += 3) {
      const d = sim.doors[s.d[i]];
      if (!d || (this.doorHold.get(d.index) ?? -Infinity) > now) continue;
      d.remote(s.d[i + 1] === 1, s.d[i + 2] / 1000);
    }
    const dw = s.dw ?? [];
    for (const d of sim.doors) if (d) d.pieces = 0;
    for (let i = 0; i + 1 < dw.length; i += 2) {
      const d = sim.doors[dw[i]];
      if (d) d.pieces = dw[i + 1];
    }

    // Boards and broken panes; slots left out are back as the map starts them (nobody re-glazes a window, but boards come off).
    const listed = new Set<number>();
    const bs = s.b ?? [];
    for (let i = 0; i + 3 < bs.length; i += 4) {
      const slot = sim.barricades.slots[bs[i]];
      if (!slot) continue;
      listed.add(slot.index);
      sim.barricades.remote(slot, bs[i + 1], bs[i + 2] / 1000, bs[i + 3] === 1);
    }
    for (const slot of sim.barricades.slots) if (!listed.has(slot.index) && slot.boards > 0) sim.barricades.remote(slot, 0, 0, slot.glass);
    // Smashed panes (nobody re-glazes a window: a pane left out keeps what this copy has).
    if (s.g) {
      unpackPanes(s.g, (i) => {
        const slot = sim.barricades.slots[i];
        if (slot?.glass) sim.barricades.breakGlass(slot);
      });
    }
    this.applyRaid(s, T, span);
    const lu = s.lu;
    sim.lull = lu ? { count: lu[0], start: lu[1] / 1000, end: lu[2] / 1000, paused: lu[3] / 1000 } : noLulls();

    // Skateboards (older servers send none: the copy keeps its own, placed from the same seed).
    if (s.sk) {
      const sk = sim.skateboards;
      for (const r of s.sk) {
        const id = r[0] as number;
        if ((this.boardHold.get(id) ?? -Infinity) > now) continue;
        const rider = typeof r[5] === 'string' && r[5] ? (r[5] as string) : null;
        const lk = r[6] as number;
        sk.remote(id, { x: (r[1] as number) / 100, y: (r[2] as number) / 100, z: (r[3] as number) / 100 }, (r[4] as number) / 1000, rider, lk >> 1, (lk & 1) === 1);
      }
      // Ids run 0..n-1: any the copy placed beyond the server's are gone.
      if (sk.boards.length > s.sk.length) sk.boards.length = s.sk.length;
    }

    // Vehicles (older servers send none: the copy keeps them as the map and the seed leave them).
    for (const r of s.vh ?? []) {
      const id = r[0] as number;
      const v = sim.vehicles.vehicle(id);
      if (!v) continue;
      const n = r as number[];
      const seats: (string | null)[] = [];
      for (let i = 11; i < r.length; i++) seats.push(typeof r[i] === 'string' && r[i] ? (r[i] as string) : null);
      // The car this client drives moves itself; the server's word on it only counts after a correction.
      const mine = seats[0] === this.me;
      const pos = { x: n[1] / 100, y: n[2] / 100, z: n[3] / 100 };
      const yaw = n[4] / 1000;
      if (!mine) {
        let tr = this.carTracks.get(id);
        if (!tr) {
          tr = { prev: { ...pos }, pos: { ...pos }, prevYaw: yaw, yaw, at: T, span };
          this.carTracks.set(id, tr);
        } else {
          const u = clamp((T - (tr.at - tr.span)) / tr.span, 0, 1);
          tr.prev.x += (tr.pos.x - tr.prev.x) * u;
          tr.prev.y += (tr.pos.y - tr.prev.y) * u;
          tr.prev.z += (tr.pos.z - tr.prev.z) * u;
          tr.prevYaw += Math.atan2(Math.sin(tr.yaw - tr.prevYaw), Math.cos(tr.yaw - tr.prevYaw)) * u;
          tr.pos = pos;
          tr.yaw = yaw;
          tr.at = T + span;
          tr.span = span;
        }
      } else this.carTracks.delete(id);
      sim.vehicles.remote(id, !mine, pos, yaw, { x: n[5] / 100, y: 0, z: n[6] / 100 }, n[7] / 100, n[8] / 1000, n[9] / 1000, n[10], seats);
    }

    // Bicycles (older servers send none: the copy keeps its own, placed from the same seed).
    if (s.bk) {
      const bk = sim.bicycles;
      for (const r of s.bk) {
        const id = r[0] as number;
        if ((this.bikeHold.get(id) ?? -Infinity) > now) continue;
        const who = (v: number | string) => (typeof v === 'string' && v ? v : null);
        bk.remote(id, { x: (r[1] as number) / 100, y: (r[2] as number) / 100, z: (r[3] as number) / 100 }, (r[4] as number) / 1000, who(r[5]), who(r[6]), r[7] as number);
      }
      if (bk.bikes.length > s.bk.length) bk.bikes.length = s.bk.length;
    }

    // Ammunition crates, first aid, weapon tables, landed supply crates.
    for (const r of s.i) {
      const id = r[0];
      const supply = r[5] < 0 ? Infinity : r[5];
      const it = sim.interactables[id];
      if (it) it.supply = supply;
      else {
        sim.interactables[id] = { id, kind: ITEM_KINDS[r[1]] ?? 'ammo', pos: { x: r[2] / 100, y: r[3] / 100, z: r[4] / 100 }, supply, range: r[6] / 100 };
        const weapon = r[7] !== undefined && r[7] >= 0 ? WEAPON_IDS[r[7]] : undefined;
        if (weapon) sim.interactables[id].weapon = weapon;
        if (r[8] & 1) sim.interactables[id].frags = true;
        if (r[8] & 2) sim.interactables[id].molotovs = true;
      }
    }
  }

  /** The van and the raiders (glide between snapshots like zombies). */
  private applyRaid(s: Snapshot, T: number, span: number): void {
    const raid = this.sim.raid;
    if (s.v) raid.syncVan(s.v[0], RAID_STAGES[s.v[1]] ?? 'inbound', s.v[2] / 100, s.v[3] / 100, s.v[4] / 1000, s.v[5] / 100, s.v[6] === 1);
    const seen = new Set<number>();
    for (const row of s.r ?? []) {
      const num = row[0];
      seen.add(num);
      const x = row[3] / 100, y = row[4] / 100, z = row[5] / 100;
      let r = raid.raiders.find((q) => q.num === num);
      if (!r) {
        r = new Raider(num, WEAPON_IDS[row[1]] ?? 'ar', { x, y, z }, row[8] / 1000, row[2], raid, this.sim);
        raid.raiders.push(r);
        r.updatedAt = T;
        r.lastDt = span;
      } else {
        const u = clamp((T - (r.updatedAt - r.lastDt)) / Math.max(1e-4, r.lastDt), 0, 1);
        r.prev.x += (r.pos.x - r.prev.x) * u;
        r.prev.y += (r.pos.y - r.prev.y) * u;
        r.prev.z += (r.pos.z - r.prev.z) * u;
        r.pos.x = x; r.pos.y = y; r.pos.z = z;
        r.updatedAt = T + span;
        r.lastDt = span;
      }
      if (!r.alive) continue;
      const m = r.motion;
      m.vel.x = row[6] / 100;
      m.vel.z = row[7] / 100;
      r.facing = row[8] / 1000;
      m.yaw = r.facing + Math.PI;
      m.pitch = row[9] / 1000;
      m.aiming = !!(row[10] & 1);
      m.sprinting = !!(row[10] & 2);
      m.grounded = !!(row[10] & 4);
      const a = r.arsenal;
      const action = ACTIONS[row[11]] ?? 'idle';
      if (a.action !== action || Math.abs(a.actionT - row[12] / 1000) > 0.12) {
        a.action = action;
        a.actionT = row[12] / 1000;
      }
      a.actionTotal = row[13] / 1000;
      a.weapon.mag = row[14];
      r.health = row[15] / 10;
      r.lastHit = row[16] >= 0 ? { zone: ZONES[row[19]] ?? 'torso', dx: row[17] / 1000, dz: row[18] / 1000, at: row[16] / 1000 } : null;
    }
    for (let i = raid.raiders.length - 1; i >= 0; i--) {
      const r = raid.raiders[i];
      if (seen.has(r.num)) continue;
      r.removeBody();
      raid.raiders.splice(i, 1);
    }
  }

  private syncArsenal(a: Arsenal, w: number[], lb: number[] | 0, remote: boolean): void {
    a.active = (w[0] & 1) === 1 ? 'secondary' : 'primary';
    a.meleeOut = (w[0] & 2) !== 0;
    const action = ACTIONS[w[1]] ?? 'idle';
    const t = w[2] / 1000;
    // Small differences in timing are left alone (the animation would hitch on every snapshot).
    if (a.action !== action || Math.abs(a.actionT - t) > 0.12) {
      a.action = action;
      a.actionT = t;
    }
    a.actionTotal = w[3] / 1000;
    const slot = (cur: { id: WeaponId; mag: number; reserve: number }, id: number, mag: number, reserve: number) => {
      const wid = WEAPON_IDS[id] ?? cur.id;
      if (cur.id !== wid) return { id: wid, mag, reserve };
      cur.mag = mag;
      cur.reserve = reserve;
      return cur;
    };
    a.primary = slot(a.primary, w[4], w[5], w[6]);
    a.secondary = slot(a.secondary, w[7], w[8], w[9]);
    a.meleeWith = w[10] === 1 ? 'limb' : 'machete';
    const melee = WEAPON_IDS[w[12]];
    a.meleeId = melee && isMelee(melee) ? melee : 'machete';
    if (w.length >= 16) {
      a.throwables.frag = w[13];
      a.throwables.molotov = w[14];
      a.throwKind = THROWS[w[15]] ?? 'frag';
    }
    if (remote) a.aim = w[11] / 1000;
    a.limb = lb ? this.heldLimb(lb) : null;
  }

  private heldLimb(r: number[]): HeldLimb {
    const id = r[0];
    let l: HeldLimb | undefined = this.sim.limb(id) ?? this.held.get(id);
    if (!l) {
      l = { id, arm: ARMS[r[1]] ?? 'armL', cut: CUTS[r[2]] ?? 'shoulder', kind: KINDS[r[3]] ?? 'walker', look: r[4], scale: r[5] / 1000, wear: r[6], maxWear: r[7], broken: false };
      this.held.set(id, l);
    }
    l.wear = r[6];
    l.broken = r[8] === 1;
    return l;
  }

  /**
   * World changes that come only as events (supply helicopters and the crates they drop), and
   * ones that must show before the next snapshot: the dead stop being drawn standing, an arm
   * picked up leaves the ground, one cleared away is gone.
   */
  event(e: SimEvent): void {
    const sim = this.sim;
    if (e.type === 'raiderDied') {
      const r = sim.raid.raider(e.raider);
      if (r && r.alive) {
        r.alive = false;
        r.state = 'dead';
        r.diedAt = sim.time;
      }
    } else if (e.type === 'raid' && e.stage === 'over') {
      sim.raid.stage = 'over';
    } else if (e.type === 'zombieDied' || e.type === 'zombieRemoved') {
      const z = sim.zombie(e.zombie);
      if (z) z.state = 'dead';
    } else if (e.type === 'limbGrabbed') {
      const l = sim.limb(e.limb);
      if (l) l.holder = e.player;
    } else if (e.type === 'limbGone') {
      const i = sim.limbs.findIndex((l) => l.id === e.limb);
      if (i >= 0) sim.limbs.splice(i, 1);
    } else if (e.type === 'skate') {
      // Who rides what shows at once (a rider thrown off lets go of the board before the next snapshot).
      const b = sim.skateboards.board(e.board);
      if (b && e.stage !== 'trick' && (e.player !== this.me || e.stage === 'bail')) {
        b.rider = e.stage === 'on' ? e.player : null;
        if (e.stage !== 'on') {
          b.pos = { ...e.pos };
          b.yaw = e.yaw;
        }
      }
    } else if (e.type === 'vehicle') {
      // Who sits where shows at once.
      sim.vehicles.heard(e);
    } else if (e.type === 'bike' && e.stage !== 'bell') {
      // Who rides what shows at once (someone thrown off lets go before the next snapshot).
      const b = sim.bicycles.bike(e.bike);
      if (b && (e.player !== this.me || e.stage === 'bail' || (e.seat === 'peg' && e.stage !== 'on'))) {
        if (e.seat === 'rider') {
          b.rider = e.stage === 'on' ? e.player : null;
          if (e.stage !== 'on') {
            b.pos = { ...e.pos };
            b.yaw = e.yaw;
            b.passenger = null;
          }
        } else if (e.stage === 'on') b.passenger = e.player;
        else if (b.passenger === e.player) b.passenger = null;
      }
    } else if (e.type === 'glassBroken') {
      // At once, so the client's own shots and sight lines go through the empty frame.
      const slot = sim.barricades.slots[e.slot];
      if (slot) sim.barricades.breakGlass(slot);
    } else if (e.type === 'heli') {
      if (!sim.drops.some((d) => d.id === e.drop)) sim.drops.push({ id: e.drop, flight: e.flight, stage: 'inbound', interactable: -1, body: null, weapon: e.weapon ?? null, caseItem: -1, serum: !!e.serum, serumItem: -1, frags: false, molotovs: false });
    } else if (e.type === 'supplyDrop') {
      const d = sim.drops.find((x) => x.id === e.drop);
      if (!d) return;
      if (e.stage === 'landed' && !d.body) {
        d.stage = 'landed';
        const g = e.pos;
        const w = sim.physics.world;
        d.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(g.x, g.y + 0.36, g.z));
        w.createCollider(RAPIER.ColliderDesc.cuboid(0.55, 0.36, 0.38).setCollisionGroups(groups(GROUP.dynamic, 0xffff)), d.body);
      } else if (e.stage === 'gone') {
        d.stage = 'gone';
        if (d.body) sim.physics.world.removeRigidBody(d.body);
        d.body = null;
      } else if (e.stage === 'released') {
        d.stage = 'falling';
      }
    }
  }
}
