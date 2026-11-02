import {
  BICYCLE, GAME, GROUP, NEIGHBORHOOD, PLAYER, PRIMARY_WEAPONS, RAPIER, SKATEBOARD, Simulation, captureSnapshot, groups, isSkateTrick, unpackMotion, unpackDrive,
  BUILD_SLOTS, decodeBuild, sanitizeBuild,
  type ActMsg, type DebugMsg, type DoorBody, type Loadout, type Physics, type SimEvent, type Snapshot, type UnlockState, type Vec3,
  type WeaponBuild, type WeaponId, type ZombieKind,
} from '@dead-hours/shared';
import { createWorld } from './world';

/** Fastest a survivor can legitimately move (sprint, plus slack for timing). */
const MAX_SPEED = PLAYER.sprintSpeed * 1.25;
/** The same on a skateboard (and for a moment after coming off one, while the client hears about it). */
const BOARD_SPEED = SKATEBOARD.maxSpeed * 1.25;
const BOARD_GRACE = 0.8;
/** On a bicycle (either seat), and for the same moment after getting off. */
const BIKE_SPEED = BICYCLE.maxSpeed * 1.25;
/** Fastest climb (stairs, jumps). */
const MAX_CLIMB = 5.5;
/** Movement that can be banked when messages arrive bunched together (seconds' worth). */
const BANK = 0.8;
/** Walls only: door leaves move on the server a moment behind the clients. */
const WALLS = groups(0xffff, GROUP.static);
const STEP = 1 / 60;
/** Steps per snapshot (20 a second). Zombies and the collision world move on these steps only. */
const SNAPSHOT_EVERY = 3;

export interface Survivor {
  id: string;
  name: string;
  primary: WeaponId;
  /** The sidearm (the M17 when left out). */
  secondary?: WeaponId;
  appearance: string;
  /** Weapon builds, already checked against `unlocks`. */
  builds: Loadout;
  /** What the survivor's profile has unlocked: every refit during the night is checked against it. */
  unlocks: UnlockState;
}

/** What the server keeps about a survivor beside the simulation. */
interface Extra {
  facing: number;
  trigger: boolean;
  aimO: Vec3;
  aimD: Vec3;
  /** Trigger press waiting for the weapon to be ready (seconds left), and its aim. */
  press: number;
  pressO: Vec3;
  pressD: Vec3;
  budget: number;
  climb: number;
  /** Put back here after a refused move; moves are ignored until the client is there. */
  correcting: Vec3 | null;
  correctedAt: number;
  /** Last simulation time they were on a skateboard, popped a trick on one, and were on a bicycle. */
  boardAt: number;
  trickAt: number;
  bikeAt: number;
  /** Driving: distance the car may still cover (banked like `budget`), and where the server put it back after a refused move. */
  carBudget: number;
  carCorrecting: { id: number; pos: Vec3 } | null;
  carCorrectedAt: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export interface StepResult {
  events: SimEvent[];
  snapshot: Snapshot | null;
}

const isVec = (v: unknown): v is Vec3 => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return [o.x, o.y, o.z].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e5);
};
const vec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/**
 * One night in a room: the authoritative simulation with its own collision world. Clients send
 * where they are (checked against how far they could have gone) and what they do; every step's
 * events and a snapshot every third step go back to everyone.
 */
export class Night {
  readonly physics: Physics;
  readonly sim: Simulation;
  private readonly doors: (DoorBody | null)[];
  private readonly extras = new Map<string, Extra>();
  private readonly facing = new Map<string, number>();
  private readonly unlocks = new Map<string, UnlockState>();
  /** A survivor's refit that went through (the room keeps it for their next night). */
  onRefit: ((id: string, weapon: WeaponId, build: WeaponBuild) => void) | null = null;
  private steps = 0;
  private acc = 0;
  /** Test only (DEAD_HOURS_DEBUG): survivors whose health stays full. */
  private readonly gods = new Set<string>();
  private readonly rand: () => number;

  constructor(readonly seed: number, preparation: number = GAME.preparationSeconds) {
    const w = createWorld();
    this.physics = w.physics;
    this.doors = w.doors;
    this.sim = new Simulation({ physics: w.physics, map: NEIGHBORHOOD, nav: w.nav, doors: w.doors, seed, preparation });
    let s = seed >>> 0 || 1;
    this.rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  }

  get time(): number {
    return this.sim.time;
  }

  /** Puts a survivor at one of the safehouse spawns; returns where (camera yaw). */
  addSurvivor(s: Survivor, index: number): { x: number; y: number; z: number; yaw: number } {
    const spawns = NEIGHBORHOOD.playerSpawns;
    const sp = spawns[index % spawns.length];
    const p = this.sim.addPlayer(s.id, s.name, s.primary, s.secondary ?? 'pistol', { x: sp.x, y: sp.y, z: sp.z }, sp.yaw, s.appearance, s.builds);
    this.unlocks.set(s.id, s.unlocks);
    // A capsule zombies bump into, like the one the survivor's own browser moves.
    const w = this.physics.world;
    const half = (PLAYER.height - PLAYER.radius * 2) / 2;
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(sp.x, sp.y + PLAYER.height / 2, sp.z));
    const collider = w.createCollider(
      RAPIER.ColliderDesc.capsule(half, PLAYER.radius).setCollisionGroups(groups(GROUP.player, GROUP.static | GROUP.dynamic | GROUP.zombie)),
      body,
    );
    const eye = p.eye;
    this.extras.set(s.id, {
      facing: sp.yaw + Math.PI, trigger: false, aimO: eye, aimD: { x: -Math.sin(sp.yaw), y: 0, z: -Math.cos(sp.yaw) },
      press: 0, pressO: eye, pressD: { x: 0, y: 0, z: -1 }, budget: MAX_SPEED * BANK, climb: MAX_CLIMB * BANK,
      correcting: null, correctedAt: 0, boardAt: -Infinity, trickAt: -Infinity, bikeAt: -Infinity, body, collider,
      carBudget: 0, carCorrecting: null, carCorrectedAt: 0,
    });
    this.facing.set(s.id, sp.yaw + Math.PI);
    return { x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw };
  }

  removeSurvivor(id: string): void {
    const x = this.extras.get(id);
    if (x) this.physics.world.removeRigidBody(x.body);
    this.extras.delete(id);
    this.facing.delete(id);
    this.unlocks.delete(id);
    this.sim.removePlayer(id);
  }

  /**
   * What a survivor who drops in mid-night missed and can't see in a snapshot: supply drops already
   * flying or on the ground (their helicopter, crate and cases), told as the events that made them.
   */
  catchUp(): SimEvent[] {
    const out: SimEvent[] = [];
    const sim = this.sim;
    for (const d of sim.drops) {
      if (d.stage === 'gone') continue;
      const f = d.flight;
      out.push({ type: 'heli', drop: d.id, flight: f, ...(d.weapon ? { weapon: d.weapon } : {}), ...(d.serum ? { serum: true } : {}) });
      if (d.stage === 'inbound') continue;
      out.push({ type: 'supplyDrop', drop: d.id, stage: 'released', pos: { x: f.over.x, y: f.ground.y + f.releaseHeight, z: f.over.z } });
      if (d.stage !== 'landed') continue;
      out.push({ type: 'supplyDrop', drop: d.id, stage: 'landed', pos: { ...f.ground } });
      const it = sim.interactables;
      if (d.interactable >= 0 && (it[d.interactable]?.supply ?? 0) <= 0) out.push({ type: 'supplyDrop', drop: d.id, stage: 'empty', pos: { ...f.ground } });
      if (d.caseItem >= 0 && (it[d.caseItem]?.supply ?? 0) <= 0) out.push({ type: 'supplyDrop', drop: d.id, stage: 'weaponTaken', pos: { ...it[d.caseItem].pos } });
      if (d.serumItem >= 0 && (it[d.serumItem]?.supply ?? 0) <= 0) out.push({ type: 'supplyDrop', drop: d.id, stage: 'serumTaken', pos: { ...it[d.serumItem].pos } });
    }
    return out;
  }

  /** Everyone still here is dead (the last survivor may have left instead of dying). */
  get allDead(): boolean {
    const ps = [...this.sim.players.values()];
    return ps.length > 0 && !ps.some((p) => p.alive);
  }

  /**
   * A survivor's movement. Returns where to put them back when the move is refused (faster than
   * they can go, through a wall, off the map), else null.
   */
  motion(id: string, raw: unknown): Vec3 | null {
    const p = this.sim.players.get(id);
    const x = this.extras.get(id);
    const f = unpackMotion(raw);
    if (!p || !x || !f || !p.alive) return null;
    const seated = !!this.sim.vehicles.seatOf(id);
    if (seated || this.sim.bicycles.carrying(id)) {
      if (seated) {
        // In a seat the car carries them: only where they look and aim counts.
        const m = f.motion;
        Object.assign(p.motion, { yaw: m.yaw, pitch: m.pitch, aiming: m.aiming, light: m.light });
        x.correcting = null;
        x.budget = MAX_SPEED * BANK;
      } else {
        // On someone's pegs: the bike puts them where they stand (Bicycles.step); only how they look and aim is theirs.
        // Stepping (or being dropped) off it, they get a rider's allowance to catch up with where the bike was drawn.
        x.correcting = null;
        x.bikeAt = this.sim.time;
        x.budget = BIKE_SPEED * BANK;
        x.climb = MAX_CLIMB * BANK;
        const { pos: _pos, vel: _vel, grounded: _grounded, ...look } = f.motion;
        this.sim.setMotion(id, { ...look, sprinting: false, board: undefined, bike: undefined });
      }
      x.facing = f.facing;
      this.facing.set(id, f.facing);
      x.trigger = f.trigger;
      x.aimO = f.aimOrigin;
      x.aimD = f.aimDir;

      return null;
    }
    const from = p.motion.pos;
    const to = f.motion.pos;
    if (x.correcting) {
      // Moves sent before the client got the correction are dropped (resent if it seems lost).
      if (Math.hypot(to.x - x.correcting.x, to.y - x.correcting.y, to.z - x.correcting.z) > 1) {
        if (this.sim.time - x.correctedAt > 2) {
          x.correctedAt = this.sim.time;
          return vec(x.correcting);
        }
        return null;
      }
      x.correcting = null;
      x.budget = this.maxSpeed(id, x) * BANK;
      x.climb = MAX_CLIMB * BANK;
    }
    const edge = NEIGHBORHOOD.bounds, m = 0.4;
    const dh = Math.hypot(to.x - from.x, to.z - from.z);
    const up = Math.max(0, to.y - from.y);
    let ok = to.x > edge.x0 + m && to.x < edge.x1 - m && to.z > edge.z0 + m && to.z < edge.z1 - m && to.y > -12 && to.y < 30 && dh <= x.budget + 0.05 && up <= x.climb + 0.05;
    if (ok && dh > 0.02) {
      const ay = from.y + 0.9, by = to.y + 0.9;
      const len = Math.hypot(to.x - from.x, by - ay, to.z - from.z);
      const hit = this.physics.raycast(from.x, ay, from.z, (to.x - from.x) / len, (by - ay) / len, (to.z - from.z) / len, len, WALLS);
      if (hit !== null && hit < len - 0.05) ok = false;
      // Boards aren't solid to the physics: nobody gets through a boarded-up window.
      else if (this.sim.barricades.crossesBoards(from, to)) ok = false;
    }
    if (!ok) {
      x.correcting = vec(from);
      x.correctedAt = this.sim.time;
      x.trigger = false;
      return vec(from);
    }
    x.budget -= dh;
    x.climb -= up;
    this.sim.setMotion(id, f.motion);
    x.facing = f.facing;
    this.facing.set(id, f.facing);
    x.trigger = f.trigger;
    x.aimO = f.aimOrigin;
    x.aimD = f.aimDir;
    return null;
  }

  /**
   * Where a driver's browser says their car is. Returns where to put it back (stopped) when the
   * move is refused: faster than that car goes, through a wall, off the map.
   */
  drive(id: string, raw: unknown): number[] | null {
    const p = this.sim.players.get(id);
    const x = this.extras.get(id);
    const d = unpackDrive(raw);
    const v = d ? this.sim.vehicles.driven(id) : null;
    if (!p || !x || !d || !v || v.id !== d.vehicle || !p.up) return null;
    const to = d.pos;
    const back = (): number[] => [v.id, Math.round(v.pos.x * 100), Math.round(v.pos.y * 100), Math.round(v.pos.z * 100), Math.round(v.yaw * 1000)];
    if (x.carCorrecting) {
      const c = x.carCorrecting.pos;
      if (x.carCorrecting.id === v.id && Math.hypot(to.x - c.x, to.z - c.z) > 1.5) {
        if (this.sim.time - x.carCorrectedAt > 2) {
          x.carCorrectedAt = this.sim.time;
          return back();
        }
        return null;
      }
      x.carCorrecting = null;
      x.carBudget = this.carSpeed(v) * BANK;
    }
    const from = v.pos;
    const edge = NEIGHBORHOOD.bounds, m = 1;
    const dh = Math.hypot(to.x - from.x, to.z - from.z);
    let ok = to.x > edge.x0 + m && to.x < edge.x1 - m && to.z > edge.z0 + m && to.z < edge.z1 - m && Math.abs(to.y - from.y) < 1.2 && dh <= x.carBudget + 0.1;
    if (ok && dh > 0.02) {
      const y = Math.max(from.y, to.y) + v.def.low * 0.6;
      const hit = this.physics.raycast(from.x, y, from.z, (to.x - from.x) / dh, 0, (to.z - from.z) / dh, dh, WALLS);
      if (hit !== null && hit < dh - 0.05) ok = false;
    }
    if (!ok) {
      v.speed = 0;
      v.vel.x = v.vel.z = 0;
      x.carCorrecting = { id: v.id, pos: vec(from) };
      x.carCorrectedAt = this.sim.time;
      return back();
    }
    x.carBudget -= dh;
    this.sim.drive(id, d);
    return null;
  }

  /** Fastest a car may be moved (its top speed, with slack for timing). */
  private carSpeed(v: { def: { top: number } }): number {
    return v.def.top * 1.25 + 3;
  }

  /** One thing a survivor does; the simulation checks whether they can. */
  act(id: string, raw: unknown): void {
    const p = this.sim.players.get(id);
    const x = this.extras.get(id);
    if (!p || !x || !raw || typeof raw !== 'object') return;
    const m = raw as ActMsg;
    const sim = this.sim;
    switch (m.a) {
      case 'fire':
        if (isVec(m.o) && isVec(m.d)) {
          x.press = 0.18;
          x.pressO = vec(m.o);
          x.pressD = vec(m.d);
        }
        break;
      case 'reload':
        sim.reload(id);
        break;
      case 'switch':
        if (m.slot === 'primary' || m.slot === 'secondary' || m.slot === 'melee') sim.switchWeapon(id, m.slot);
        break;
      case 'melee':
        sim.melee(id, isVec(m.o) && isVec(m.d) ? { origin: vec(m.o), dir: vec(m.d) } : undefined);
        break;
      case 'bandage':
        sim.bandage(id);
        break;
      case 'use':
        if (Number.isInteger(m.id)) sim.use(id, m.id);
        break;
      case 'primary':
        if (PRIMARY_WEAPONS.includes(m.weapon)) sim.selectPrimary(id, m.weapon);
        break;
      case 'refit': {
        if (typeof m.weapon !== 'string' || typeof m.build !== 'string') break;
        const a = p.arsenal;
        if (m.weapon !== a.primary.id && m.weapon !== a.secondary.id) break;
        // Every option must be one this survivor has unlocked: a locked one refuses the whole refit.
        const want = decodeBuild(m.weapon, m.build);
        const u = this.unlocks.get(id) ?? { level: 1, entitlements: [] };
        const ok = sanitizeBuild(m.weapon, want, u);
        if (!BUILD_SLOTS.every((s) => ok[s] === want[s])) break;
        if (sim.refit(id, m.weapon, ok)) this.onRefit?.(id, m.weapon, ok);
        break;
      }
      case 'grab':
        if (Number.isInteger(m.limb)) sim.grabLimb(id, m.limb);
        break;
      case 'revive':
        if (m.target === null || typeof m.target === 'string') sim.revive(id, m.target);
        break;
      case 'throw':
        if ((m.kind === 'frag' || m.kind === 'molotov') && isVec(m.o) && isVec(m.d)) sim.throwItem(id, m.kind, { origin: vec(m.o), dir: vec(m.d) });
        break;
      case 'board':
        if (!Number.isInteger(m.id)) break;
        if (m.id >= 0) {
          if (sim.rideBoard(id, m.id)) x.boardAt = sim.time;
        } else {
          sim.leaveBoard(id, isVec(m.at) ? vec(m.at) : undefined, typeof m.yaw === 'number' && Number.isFinite(m.yaw) ? m.yaw : undefined, m.bail === true);
        }
        break;
      case 'trick':
        // One at a time (a trick takes a whole ollie): a client sending more is ignored.
        if (!isSkateTrick(m.kind) || m.kind === 'ollie' || sim.time - x.trickAt < SKATEBOARD.trickEvery) break;
        if (sim.skateTrick(id, m.kind)) x.trickAt = sim.time;
        break;
      case 'seat':
        if (!Number.isInteger(m.v)) break;
        if (m.v < 0) sim.exitVehicle(id);
        else if (m.s === -1) sim.switchSeat(id);
        else if (sim.enterVehicle(id, m.v, Number.isInteger(m.s) ? m.s : undefined)) {
          const v = sim.vehicles.driven(id);
          if (v) x.carBudget = this.carSpeed(v) * BANK;
        }
        break;
      case 'bike':
        if (!Number.isInteger(m.id)) break;
        if (m.id >= 0) {
          if ((m.seat === 'rider' || m.seat === 'peg') && sim.rideBike(id, m.id, m.seat)) {
            x.bikeAt = sim.time;
            x.correcting = null;
          }
        } else if (sim.leaveBike(id, isVec(m.at) ? vec(m.at) : undefined, typeof m.yaw === 'number' && Number.isFinite(m.yaw) ? m.yaw : undefined, m.bail === true)) {
          // Running it out (or stepping down off the pegs a little way from where the server had them).
          x.bikeAt = sim.time;
          x.budget = BIKE_SPEED * BANK;
          x.climb = MAX_CLIMB * BANK;
        }
        break;
      case 'bell':
        sim.ringBell(id);
        break;
      case 'door': {
        const d = Number.isInteger(m.door) ? this.doors[m.door] : null;
        const e = p.eye;
        if (d && p.up && !sim.doorLocked(d.index) && Math.hypot(d.center.x - e.x, d.center.y - e.y, d.center.z - e.z) < 2.6) d.toggle(p.motion.pos.x, p.motion.pos.z);
        break;
      }
      case 'vault':
        if (Number.isInteger(m.slot)) sim.vault(id, m.slot);
        break;
      case 'barricade':
        if (m.k === 'stop' || !Number.isInteger(m.slot)) p.work = null;
        else if (m.k === 'board' || m.k === 'pry') sim.barricade(id, m.slot, m.k);
        break;
      default:
        break;
    }
  }

  /** Test commands (DEAD_HOURS_DEBUG=1 only). */
  debug(id: string, raw: unknown): void {
    const m = raw as DebugMsg;
    const p = this.sim.players.get(id);
    if (!m || !p) return;
    if (m.cmd === 'skipPreparation') this.sim.skipPreparation();
    else if (m.cmd === 'supplyDrop') this.sim.callSupplyDrop(typeof m.weapon === 'string' ? m.weapon : undefined, m.serum === true);
    else if (m.cmd === 'raid') this.sim.callRaid();
    else if (m.cmd === 'lull') this.sim.startLull();
    else if (m.cmd === 'hurt' && Number.isFinite(m.amount)) this.sim.damagePlayer(p, Math.max(0, m.amount), p.motion.pos);
    else if (m.cmd === 'god') {
      if (m.on) this.gods.add(id);
      else this.gods.delete(id);
    }
    else if (m.cmd === 'spawn' && Number.isFinite(m.dist) && Number.isFinite(m.angle)) {
      const yaw = p.motion.yaw + m.angle;
      const kind = (['walker', 'runner', 'brute', 'screamer', 'bloater'] as const).includes(m.kind as 'walker') ? (m.kind as ZombieKind) : 'walker';
      const at = { x: p.motion.pos.x - Math.sin(yaw) * m.dist, y: p.motion.pos.y + 0.02, z: p.motion.pos.z - Math.cos(yaw) * m.dist };
      this.sim.spawnZombie(kind, at, 'approach');
    }
  }

  /** Runs the fixed steps `elapsed` seconds of real time call for. */
  advance(elapsed: number): StepResult {
    const events: SimEvent[] = [];
    this.acc += Math.min(elapsed, 0.25);
    let n = 0;
    let due = false;
    while (this.acc >= STEP && n < 6) {
      this.acc -= STEP;
      n++;
      const snap = ++this.steps % SNAPSHOT_EVERY === 0;
      this.step(snap);
      for (const e of this.sim.drain()) {
        events.push(e);
        if (e.type === 'playerRespawned') this.respawned(e.player);
        // Out of a car: they stand by its door now, and moves from the seat are dropped until the client is there.
        if (e.type === 'vehicle' && (e.stage === 'out' || e.stage === 'thrown') && e.player && e.pos) {
          const x = this.extras.get(e.player);
          if (x) {
            x.correcting = vec(e.pos);
            x.correctedAt = this.sim.time;
          }
        }
      }
      if (snap) due = true;
      for (const id of this.gods) {
        const p = this.sim.players.get(id);
        if (p?.up) p.health = PLAYER.maxHealth;
      }
    }
    if (n === 6) this.acc = 0;
    // Taken after every step this call ran, so it never shows something an event already ended.
    return { events, snapshot: due ? captureSnapshot(this.sim, this.facing) : null };
  }

  /** A lull brought them back: their body is solid again and their moves count from the new spot. */
  private respawned(id: string): void {
    const p = this.sim.players.get(id);
    const x = this.extras.get(id);
    if (!p || !x) return;
    const m = p.motion.pos;
    x.correcting = null;
    x.budget = MAX_SPEED * BANK;
    x.climb = MAX_CLIMB * BANK;
    x.trigger = false;
    x.press = 0;
    x.facing = p.motion.yaw + Math.PI;
    this.facing.set(id, x.facing);
    x.body.setTranslation({ x: m.x, y: m.y + PLAYER.height / 2, z: m.z }, true);
    x.collider.setEnabled(true);
  }

  /** How fast this survivor may move now: faster on a skateboard, faster still on a bicycle. */
  private maxSpeed(id: string, x: Extra): number {
    const t = this.sim.time;
    if (this.sim.skateboards.ridden(id)) x.boardAt = t;
    if (this.sim.bicycles.onBike(id)) x.bikeAt = t;
    if (t - x.bikeAt < BOARD_GRACE) return BIKE_SPEED;
    return t - x.boardAt < BOARD_GRACE ? BOARD_SPEED : MAX_SPEED;
  }

  /** `world` on snapshot steps: zombies move and the collision world catches up (see Simulation.step). */
  private step(world: boolean): void {
    const sim = this.sim;
    for (const [id, x] of this.extras) {
      const p = sim.players.get(id);
      const seat = p ? sim.vehicles.seatOf(id) : null;
      if (!p || !p.alive) {
        x.collider.setEnabled(false);
        continue;
      }
      // In a car the car's body is what the dead bump into.
      if (x.collider.isEnabled() === !!seat) x.collider.setEnabled(!seat);
      if (seat && seat[1] === 0) {
        const cs = this.carSpeed(seat[0]);
        x.carBudget = Math.min(cs * BANK, x.carBudget + cs * STEP);
      }
      const max = this.maxSpeed(id, x);
      x.budget = Math.min(max * BANK, x.budget + max * STEP);
      x.climb = Math.min(MAX_CLIMB * BANK, x.climb + MAX_CLIMB * STEP);
      // Same trigger handling as solo: a press fires as soon as the gun is ready, holding keeps an
      // automatic going (not on an empty magazine, which clicks once).
      const a = p.arsenal;
      if (x.press > 0) {
        const r = sim.fire(id, x.pressO, x.pressD, true, (this.rand() * 2 ** 31) | 1);
        x.press = r === 'busy' ? x.press - STEP : 0;
      } else if (x.trigger && !a.limb && a.def.auto && a.weapon.mag > 0) {
        sim.fire(id, x.aimO, x.aimD, false, (this.rand() * 2 ** 31) | 1);
      }
      const m = p.motion.pos;
      x.body.setNextKinematicTranslation({ x: m.x, y: m.y + PLAYER.height / 2, z: m.z });
    }
    sim.step(STEP, world);
    if (world) this.physics.advance(STEP * SNAPSHOT_EVERY);
  }

  dispose(): void {
    this.sim.dispose();
    this.physics.dispose();
  }
}
