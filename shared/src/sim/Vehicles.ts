import { RAPIER, GROUP, groups, BODY_FILTER } from '../physics/Physics';
import { VEHICLE, VEHICLES, vehicleKindOf, type VehicleDef, type VehicleKind } from '../config/vehicles';
import { PLAYER } from '../config/player';
import type { PropSpec } from '../types/world';
import { clamp, rng, type Vec3 } from './math';
import { driveStep, hullY, bodyYaw, type DriveBody } from './VehicleDrive';
import type { SimPlayer, Simulation } from './Simulation';
import type { Zombie } from './Zombie';

/** Bits of a driver's controls and a vehicle's state, as drive messages and snapshots carry them. */
export const DRIVE_FLAG = {
  throttle: 1, brake: 2, handbrake: 4, horn: 8, lights: 16,
  /** Snapshots only: the engine runs, the starter turns. */
  engine: 32, cranking: 64,
} as const;

/** One drivable vehicle: where it is, how it moves, what is in its tank, and who sits where. */
export interface Vehicle extends DriveBody {
  id: number;
  kind: VehicleKind;
  def: VehicleDef;
  /** The map prop it started as (its paint, police markings, wreck damage). */
  prop: PropSpec;
  /** Share of a full tank left. */
  gas: number;
  engine: boolean;
  /** Seconds the starter has left to turn (0 when it isn't). */
  crank: number;
  /** The driver's controls as last sent (DRIVE_FLAG bits): brake lights, horn, headlights. */
  input: number;
  /** Who sits in each seat (seat 0 drives). */
  seats: (string | null)[];
  /** Who drove it last (a car rolling on with nobody at the wheel still credits them). */
  lastDriver: string | null;
  /** Moved or used since the night started: snapshots carry it from then on. */
  touched: boolean;
  body: RAPIER.RigidBody;
  hull: RAPIER.Collider;
  cabin: RAPIER.Collider;
  /** Zombie id → when this vehicle last hit it. */
  hits: Map<number, number>;
  noiseT: number;
  /** Where it was before its latest move (run-overs sweep between the two). */
  prev: Vec3;
  prevYaw: number;
}

/** What a driver's browser says about the car it drives (see packDrive). */
export interface DriveState {
  vehicle: number;
  pos: Vec3;
  yaw: number;
  vel: Vec3;
  speed: number;
  steer: number;
  input: number;
  /** Speed lost against something hard since the last report (m/s). */
  crash: number;
}

/** Where a seat is in the world. */
export function seatWorld(v: { pos: Vec3; yaw: number; def: VehicleDef }, seat: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const s = v.def.seats[seat] ?? v.def.seats[0];
  const c = Math.cos(v.yaw), n = Math.sin(v.yaw);
  out.x = v.pos.x + s.x * c + s.z * n;
  out.y = v.pos.y + s.y;
  out.z = v.pos.z - s.x * n + s.z * c;
  return out;
}

/** A point in a vehicle's own frame: x toward the nose, z toward the passenger side. */
export function toLocal(v: { pos: Vec3; yaw: number }, x: number, z: number): { lx: number; lz: number } {
  const dx = x - v.pos.x, dz = z - v.pos.z;
  const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

/** How far a point is outside a vehicle's body, along the ground (0 inside). */
export function outsideBy(v: { pos: Vec3; yaw: number; def: VehicleDef }, x: number, z: number): number {
  const { lx, lz } = toLocal(v, x, z);
  return Math.hypot(Math.max(0, Math.abs(lx) - v.def.hx), Math.max(0, Math.abs(lz) - v.def.hz));
}

const STAND = new RAPIER.Capsule((PLAYER.height - PLAYER.radius * 2) / 2, PLAYER.radius);
const STAND_FILTER = groups(0xffff, BODY_FILTER);
const FLOOR = groups(0xffff, GROUP.static | GROUP.dynamic | GROUP.vehicle);
const WALLS = groups(0xffff, GROUP.static);

/**
 * The night's vehicles: every car, cruiser and wreck parked about the map, and the armored truck,
 * each with what was left in its tank. Survivors get in by any free seat; the driver's own browser
 * moves the car like it moves their feet (DriveState, checked by the server), and this keeps the
 * rest: who sits where, the fuel, the engine, the noise it makes, and what it does to the dead it
 * runs into. A car nobody drives rolls to a stop here.
 */
export class Vehicles {
  readonly list: Vehicle[] = [];
  /** Player id → [vehicle, seat]. */
  private readonly seated = new Map<string, [Vehicle, number]>();

  constructor(private readonly sim: Simulation, seed: number) {
    const rand = rng(((seed >>> 0) * 2654435761 + 0xca7) >>> 0);
    const w = sim.physics.world;
    for (const p of sim.map.props) {
      const kind = vehicleKindOf(p);
      if (!kind) continue;
      const def = VEHICLES[kind];
      const pos = { x: p.x, y: p.y ?? 0, z: p.z };
      // Parked, a car is as cheap as a wall (a fixed body); it turns kinematic the first time it moves.
      const body = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z).setRotation(bodyYaw(p.rotY)));
      const hull = w.createCollider(
        RAPIER.ColliderDesc.cuboid(def.hx, (def.low - def.clear) / 2, def.hz).setTranslation(0, hullY(def), 0).setCollisionGroups(groups(GROUP.vehicle, 0xffff)),
        body,
      );
      const cb = def.cabin;
      const cabin = w.createCollider(
        RAPIER.ColliderDesc.cuboid((cb.x1 - cb.x0) / 2, (cb.top - def.low) / 2, cb.hz)
          .setTranslation((cb.x0 + cb.x1) / 2, (def.low + cb.top) / 2, 0).setCollisionGroups(groups(GROUP.cabin, 0xffff)),
        body,
      );
      sim.physics.setSurface(hull, 'metal');
      sim.physics.setSurface(cabin, 'glass');
      const gas = def.fuel[0] + rand() * (def.fuel[1] - def.fuel[0]);
      this.list.push({
        id: this.list.length, kind, def, prop: p, pos, yaw: p.rotY, speed: 0, vel: { x: 0, y: 0, z: 0 }, steer: 0,
        gas, engine: false, crank: 0, input: 0, seats: def.seats.map(() => null), lastDriver: null, touched: false,
        body, hull, cabin, hits: new Map(), noiseT: 0, prev: { ...pos }, prevYaw: p.rotY,
      });
    }
    w.updateSceneQueries();
  }

  vehicle(id: number): Vehicle | undefined {
    return this.list[id];
  }

  /** The vehicle and seat a survivor sits in, if any. */
  seatOf(player: string): [Vehicle, number] | null {
    return this.seated.get(player) ?? null;
  }

  /** The vehicle a survivor drives, if any. */
  driven(player: string): Vehicle | null {
    const s = this.seated.get(player);
    return s && s[1] === 0 ? s[0] : null;
  }

  driver(v: Vehicle): SimPlayer | null {
    return v.seats[0] ? this.sim.players.get(v.seats[0]) ?? null : null;
  }

  /** Whether a survivor standing here could get into this vehicle (on their feet, close to it, a seat free). */
  canEnter(p: SimPlayer, v: Vehicle): boolean {
    if (!p.up || this.seated.has(p.id) || !v.seats.includes(null)) return false;
    const m = p.motion.pos;
    return Math.abs(m.y - v.pos.y) < 1.6 && outsideBy(v, m.x, m.z) <= VEHICLE.reach;
  }

  /** Vehicles with a free seat within reach of a survivor, nearest first. */
  inReach(p: SimPlayer): Vehicle[] {
    const m = p.motion.pos;
    return this.list.filter((v) => this.canEnter(p, v)).sort((a, b) => outsideBy(a, m.x, m.z) - outsideBy(b, m.x, m.z));
  }

  /**
   * Puts a survivor in a seat: `seat` if it's free, else the driver's seat if free, else the free
   * seat nearest them. The engine turns over when someone takes the wheel.
   */
  enter(p: SimPlayer, id: number, seat?: number): boolean {
    const v = this.list[id];
    if (!v || !this.canEnter(p, v)) return false;
    let s = seat !== undefined && Number.isInteger(seat) && v.seats[seat] === null ? seat : -1;
    if (s < 0 && v.seats[0] === null) s = 0;
    if (s < 0) {
      let best = Infinity;
      const at = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < v.seats.length; i++) {
        if (v.seats[i] !== null) continue;
        seatWorld(v, i, at);
        const d = Math.hypot(at.x - p.motion.pos.x, at.z - p.motion.pos.z);
        if (d < best) {
          best = d;
          s = i;
        }
      }
    }
    if (s < 0) return false;
    this.sim.leaveBoard(p.id);
    this.sim.leaveBike(p.id);
    v.seats[s] = p.id;
    v.touched = true;
    this.seated.set(p.id, [v, s]);
    p.work = null;
    this.place(p, v, s);
    this.sim.emit({ type: 'vehicle', vehicle: v.id, stage: 'in', player: p.id, seat: s });
    if (s === 0) this.takeWheel(v, p);
    return true;
  }

  /** Moves a survivor to the next free seat (from the wheel to the passenger side, and on round). */
  switchSeat(p: SimPlayer): boolean {
    const at = this.seated.get(p.id);
    if (!at || !p.up) return false;
    const [v, from] = at;
    for (let k = 1; k < v.seats.length; k++) {
      const s = (from + k) % v.seats.length;
      if (v.seats[s] !== null) continue;
      v.seats[from] = null;
      v.seats[s] = p.id;
      this.seated.set(p.id, [v, s]);
      this.place(p, v, s);
      this.sim.emit({ type: 'vehicle', vehicle: v.id, stage: 'seat', player: p.id, seat: s });
      if (from === 0) this.leftWheel(v);
      if (s === 0) this.takeWheel(v, p);
      return true;
    }
    return false;
  }

  /**
   * Gets a survivor out by the door nearest their seat (the other side, or off the front or back,
   * when that one is blocked). Not while the car is moving fast. `thrown`: out regardless (they went
   * down or died in there), wherever there is room, or beside the car when there is none.
   */
  exit(p: SimPlayer, thrown = false): boolean {
    const at = this.seated.get(p.id);
    if (!at) return false;
    const [v, s] = at;
    if (!thrown && Math.abs(v.speed) > VEHICLE.exitSpeed) return false;
    const spot = this.exitSpot(v, s);
    if (!spot && !thrown) return false;
    const pos = spot ?? this.fallback(v, s);
    v.seats[s] = null;
    this.seated.delete(p.id);
    const m = p.motion;
    m.pos.x = pos.x;
    m.pos.y = pos.y;
    m.pos.z = pos.z;
    m.vel.x = v.vel.x * 0.5;
    m.vel.y = 0;
    m.vel.z = v.vel.z * 0.5;
    m.eyeHeight = PLAYER.eyeHeight;
    m.grounded = true;
    this.sim.emit({ type: 'vehicle', vehicle: v.id, stage: thrown ? 'thrown' : 'out', player: p.id, seat: s, pos: { ...pos } });
    if (s === 0) this.leftWheel(v);
    return true;
  }

  /** Out of whatever they sit in, regardless (down, dead, gone). */
  eject(p: SimPlayer): void {
    if (this.seated.has(p.id)) this.exit(p, true);
  }

  /** Forgets a survivor who left the game (their seat empties). */
  forget(id: string): void {
    const at = this.seated.get(id);
    if (!at) return;
    const [v, s] = at;
    v.seats[s] = null;
    this.seated.delete(id);
    if (s === 0) this.leftWheel(v);
  }

  private takeWheel(v: Vehicle, p: SimPlayer): void {
    v.lastDriver = p.id;
    if (v.engine || v.crank > 0) return;
    v.crank = v.def.crank;
    this.sim.emit({ type: 'vehicle', vehicle: v.id, stage: 'crank', player: p.id });
  }

  /** Nobody at the wheel: the engine stops and it rolls to a halt. */
  private leftWheel(v: Vehicle): void {
    v.engine = false;
    v.crank = 0;
    v.input = 0;
  }

  /** Where a survivor getting out of a seat can stand, or null when every door is blocked. */
  exitSpot(v: Vehicle, seat: number): Vec3 | null {
    const S = v.def.seats[seat] ?? v.def.seats[0];
    const side = S.z < 0 ? -1 : 1;
    const out = v.def.hz + PLAYER.radius + 0.18;
    const tries: [number, number][] = [
      [S.x, side * out], [S.x - 0.9, side * out], [S.x + 0.9, side * out],
      [S.x, -side * out], [S.x - 0.9, -side * out],
      [-v.def.hx - 0.6, 0], [v.def.hx + 0.6, 0],
    ];
    const c = Math.cos(v.yaw), n = Math.sin(v.yaw);
    const w = this.sim.physics.world;
    const from = seatWorld(v, seat);
    for (const [lx, lz] of tries) {
      const x = v.pos.x + lx * c + lz * n, z = v.pos.z - lx * n + lz * c;
      const top = v.pos.y + 1.6;
      const g = this.sim.physics.raycast(x, top, z, 0, -1, 0, 3.2, FLOOR);
      if (g === null) continue;
      const y = top - g;
      if (Math.abs(y - v.pos.y) > 0.7) continue;
      let blocked = false;
      w.intersectionsWithShape({ x, y: y + PLAYER.height / 2 + 0.04, z }, { x: 0, y: 0, z: 0, w: 1 }, STAND, () => { blocked = true; return false; }, undefined, STAND_FILTER);
      if (blocked) continue;
      // Not through a wall from the seat.
      const dx = x - from.x, dz = z - from.z, d = Math.hypot(dx, dz);
      if (d > 0.05 && this.sim.physics.raycast(from.x, v.pos.y + 0.8, from.z, dx / d, 0, dz / d, d, WALLS) !== null) continue;
      return { x, y: y + 0.02, z };
    }
    return null;
  }

  /** Beside the seat's door, when nowhere is clear. */
  private fallback(v: Vehicle, seat: number): Vec3 {
    const S = v.def.seats[seat] ?? v.def.seats[0];
    const side = S.z < 0 ? -1 : 1;
    const lz = side * (v.def.hz + PLAYER.radius + 0.1);
    const c = Math.cos(v.yaw), n = Math.sin(v.yaw);
    return { x: v.pos.x + S.x * c + lz * n, y: v.pos.y + 0.02, z: v.pos.z - S.x * n + lz * c };
  }

  /** Keeps a survivor in their seat: where they are, how they move, how high their eyes are. */
  private place(p: SimPlayer, v: Vehicle, seat: number): void {
    const m = p.motion;
    seatWorld(v, seat, m.pos);
    m.vel.x = v.vel.x;
    m.vel.y = 0;
    m.vel.z = v.vel.z;
    m.eyeHeight = VEHICLE.seatEye;
    m.grounded = true;
    m.crouching = false;
    m.sprinting = false;
    m.pushing = false;
    m.board = undefined;
  }

  /** Moves a vehicle's body to where it is now. */
  moveBody(v: Vehicle): void {
    this.bodyTo(v, v.pos, v.yaw);
  }

  /** Moves the vehicle's collision body (only) to `pos` facing `yaw`, from the next physics step. */
  bodyTo(v: Vehicle, pos: Vec3, yaw: number): void {
    if (v.body.isFixed()) v.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    v.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
    v.body.setNextKinematicRotation(bodyYaw(yaw));
  }

  /**
   * Where the driver's browser says their car is. Burns fuel for the distance, keeps the controls
   * (brake lights, horn, headlights) and hurts the people inside when it hit something hard.
   */
  drive(p: SimPlayer, d: DriveState): boolean {
    const v = this.list[d.vehicle];
    if (!v || v.seats[0] !== p.id || !p.up) return false;
    const moved = Math.hypot(d.pos.x - v.pos.x, d.pos.z - v.pos.z);
    // How fast it was going before this report: a crash can't lose more than that.
    const was = Math.max(Math.abs(v.speed), Math.hypot(v.vel.x, v.vel.z));
    v.prev.x = v.pos.x;
    v.prev.y = v.pos.y;
    v.prev.z = v.pos.z;
    v.prevYaw = v.yaw;
    v.pos.x = d.pos.x;
    v.pos.y = d.pos.y;
    v.pos.z = d.pos.z;
    v.yaw = d.yaw;
    v.vel.x = d.vel.x;
    v.vel.z = d.vel.z;
    v.speed = clamp(d.speed, -VEHICLE.maxSpeed, VEHICLE.maxSpeed);
    v.steer = clamp(d.steer, -1, 1);
    v.input = d.input & (DRIVE_FLAG.throttle | DRIVE_FLAG.brake | DRIVE_FLAG.handbrake | DRIVE_FLAG.horn | DRIVE_FLAG.lights);
    if (!v.engine) v.input &= ~DRIVE_FLAG.throttle;
    if (moved > 0.001) v.touched = true;
    this.moveBody(v);
    if (v.engine && moved < 5) this.burn(v, moved * v.def.burn);
    if (d.crash > 0) this.crash(v, Math.min(d.crash, was + 2));
    return true;
  }

  private burn(v: Vehicle, amount: number): void {
    v.gas = Math.max(0, v.gas - amount);
    if (v.gas > 0 || !v.engine) return;
    v.engine = false;
    v.input &= ~DRIVE_FLAG.throttle;
    this.sim.emit({ type: 'vehicle', vehicle: v.id, stage: 'empty', pos: { ...v.pos } });
  }

  /** A hard hit: heard, and past a point everyone inside is hurt. */
  private crash(v: Vehicle, lost: number): void {
    if (lost >= VEHICLE.crashSound) this.sim.emit({ type: 'vehicle', vehicle: v.id, stage: 'crash', pos: { ...v.pos }, strength: lost });
    if (lost >= VEHICLE.crashSound) this.sim.noise(v.pos, 20 + lost * 1.5, v.lastDriver);
    if (lost < VEHICLE.crashHurt) return;
    const hurt = Math.round((lost - VEHICLE.crashHurt) * VEHICLE.crashDamage);
    for (const id of v.seats) {
      const q = id ? this.sim.players.get(id) : null;
      if (q?.up && hurt > 0) this.sim.damagePlayer(q, hurt, v.pos);
    }
  }

  /** The speed of the vehicle a survivor sits in (0 on foot). */
  speedOf(player: string): number {
    const s = this.seated.get(player);
    return s ? Math.abs(s[0].speed) : 0;
  }

  /**
   * One step: the starter, the fuel the engine idles away, the noise it makes, passengers carried
   * along, a car with nobody at the wheel rolling to a stop, and anything dead in the way.
   */
  step(dt: number): void {
    const sim = this.sim;
    for (const v of this.list) {
      if (!v.touched) continue;
      if (v.crank > 0) {
        v.crank -= dt;
        if (v.crank <= 0) {
          v.crank = 0;
          if (v.gas > 0 && v.seats[0]) {
            v.engine = true;
            v.input |= DRIVE_FLAG.lights;
            sim.emit({ type: 'vehicle', vehicle: v.id, stage: 'start', player: v.seats[0] });
            sim.noise(v.pos, VEHICLE.noise[1] * 0.7, v.seats[0]);
          } else if (v.seats[0]) {
            sim.emit({ type: 'vehicle', vehicle: v.id, stage: 'dry', player: v.seats[0] });
          }
        }
      }
      if (v.engine) this.burn(v, v.def.idle * dt);
      // Nobody at the wheel: it rolls on and the brakes bring it to a halt.
      if (!v.seats[0] && (Math.abs(v.speed) > 0.02 || Math.hypot(v.vel.x, v.vel.z) > 0.02)) {
        v.prev.x = v.pos.x;
        v.prev.y = v.pos.y;
        v.prev.z = v.pos.z;
        v.prevYaw = v.yaw;
        const lost = driveStep(sim.physics, v, { throttle: 0, brake: 0.6, steer: 0, handbrake: false }, dt, false);
        if (Math.hypot(v.vel.x, v.vel.z) < 0.05) {
          v.speed = 0;
          v.vel.x = v.vel.z = 0;
        }
        this.moveBody(v);
        if (lost >= VEHICLE.crashSound) this.crash(v, lost);
      }
      for (let i = 0; i < v.seats.length; i++) {
        const id = v.seats[i];
        const p = id ? sim.players.get(id) : null;
        if (p) this.place(p, v, i);
      }
      // The engine carries, more the harder it works; the horn brings the whole block.
      v.noiseT -= dt;
      if (v.noiseT <= 0 && (v.engine || v.input & DRIVE_FLAG.horn)) {
        v.noiseT = VEHICLE.noiseEvery;
        const k = clamp(Math.abs(v.speed) / v.def.top, 0, 1);
        const by = v.seats[0] ?? v.lastDriver;
        if (v.engine) sim.noise(v.pos, VEHICLE.noise[0] + (VEHICLE.noise[1] - VEHICLE.noise[0]) * k, by);
        if (v.input & DRIVE_FLAG.horn) sim.noise(v.pos, VEHICLE.hornNoise, by);
      }
      this.runOver(v);
    }
  }

  /**
   * The dead it drives into. Slow, they are shoved aside; fast, they are run down (harder the
   * faster, a truck hardest), credited to whoever drove. Anyone standing in its body is pushed out.
   */
  private runOver(v: Vehicle): void {
    const sim = this.sim;
    const def = v.def;
    const moving = Math.hypot(v.vel.x, v.vel.z) > 0.3;
    const reach = def.hx + 1.2;
    for (const z of sim.zombies) {
      if (!z.alive || Math.abs(z.pos.x - v.pos.x) > reach + 2 || Math.abs(z.pos.z - v.pos.z) > reach + 2) continue;
      if (z.pos.y > v.pos.y + def.low || z.pos.y + z.bodyHeight < v.pos.y + def.clear) continue;
      // Checked where it is now and halfway back along its last move.
      let contact = this.contact(v, z, v.pos, v.yaw);
      if (!contact && moving) {
        const mid = { x: (v.pos.x + v.prev.x) / 2, y: v.pos.y, z: (v.pos.z + v.prev.z) / 2 };
        contact = this.contact(v, z, mid, v.yaw + Math.atan2(Math.sin(v.prevYaw - v.yaw), Math.cos(v.prevYaw - v.yaw)) / 2);
      }
      if (!contact) continue;
      const { nx, nz, depth } = contact;
      const closing = v.vel.x * nx + v.vel.z * nz;
      const last = v.hits.get(z.id) ?? -Infinity;
      if (closing >= VEHICLE.hitMin && sim.time - last >= VEHICLE.hitCooldown) {
        v.hits.set(z.id, sim.time);
        this.strike(v, z, nx, nz, closing);
        if (!z.alive) continue;
      }
      // Out of the bodywork, to the side it is on.
      z.nudge(nx * (depth + 0.03), nz * (depth + 0.03));
    }
    if (v.hits.size > 32) for (const [id, t] of v.hits) if (sim.time - t > 5) v.hits.delete(id);
  }

  /** Whether a zombie overlaps the body at a pose: the way out (the face it is nearest) and how deep. */
  private contact(v: Vehicle, z: Zombie, pos: Vec3, yaw: number): { nx: number; nz: number; depth: number } | null {
    const r = z.def.radius;
    const dx = z.pos.x - pos.x, dz = z.pos.z - pos.z;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const px = v.def.hx + r - Math.abs(lx), pz = v.def.hz + r - Math.abs(lz);
    if (px <= 0 || pz <= 0) return null;
    if (px < pz) {
      const k = lx >= 0 ? 1 : -1;
      return { nx: c * k, nz: -s * k, depth: px };
    }
    const k = lz >= 0 ? 1 : -1;
    return { nx: s * k, nz: c * k, depth: pz };
  }

  /** A zombie hit at `closing` m/s along (nx, nz). */
  private strike(v: Vehicle, z: Zombie, nx: number, nz: number, closing: number): void {
    const sim = this.sim;
    const by = (v.seats[0] ? sim.players.get(v.seats[0]) : null) ?? (v.lastDriver ? sim.players.get(v.lastDriver) : null) ?? null;
    const damage = Math.round(VEHICLE.impact * closing * closing * v.def.ram);
    const dir = { x: nx, y: 0.35, z: nz };
    sim.noise(z.pos, 14, by?.id ?? null);
    if (by) {
      sim.hitZombie(by, z, damage, 'torso', z.chest, dir, false, 1, { knock: 0, force: 1 + closing * 0.2, vehicle: v.id });
    }
    if (!z.alive) return;
    // Knocked flat by a hard hit, staggered by a soft one.
    z.blasted({ x: nx, y: 0, z: nz }, clamp((closing - VEHICLE.hitMin) / 10, 0.1, 1));
  }

  /** A survivor's car, for whoever needs to look through its body (their own shots, their camera). */
  bodyOf(player: string): RAPIER.RigidBody | null {
    return this.seated.get(player)?.[0].body ?? null;
  }

  /** Whether a point lies inside any vehicle's body (spawns stay out of them). */
  inside(x: number, z: number, margin = 0): boolean {
    for (const v of this.list) if (outsideBy(v, x, z) <= margin && Math.abs(v.pos.x - x) < 8 && Math.abs(v.pos.z - z) < 8) return true;
    return false;
  }

  /**
   * A client's copy: sets a vehicle as the server last said. `pose` false keeps the copy's own
   * pose (the car this client drives moves itself).
   */
  remote(id: number, pose: boolean, pos: Vec3, yaw: number, vel: Vec3, speed: number, steer: number, gas: number, flags: number, seats: (string | null)[]): void {
    const v = this.list[id];
    if (!v) return;
    if (pose) {
      v.prev.x = v.pos.x;
      v.prev.y = v.pos.y;
      v.prev.z = v.pos.z;
      v.prevYaw = v.yaw;
      v.pos.x = pos.x;
      v.pos.y = pos.y;
      v.pos.z = pos.z;
      v.yaw = yaw;
      v.vel.x = vel.x;
      v.vel.z = vel.z;
      v.speed = speed;
      v.steer = steer;
      v.input = flags & (DRIVE_FLAG.throttle | DRIVE_FLAG.brake | DRIVE_FLAG.handbrake | DRIVE_FLAG.horn | DRIVE_FLAG.lights);
    }
    v.gas = gas;
    v.engine = !!(flags & DRIVE_FLAG.engine);
    v.crank = flags & DRIVE_FLAG.cranking ? Math.max(v.crank, 0.01) : 0;
    v.touched = true;
    this.seatAll(v, seats);
  }

  /** Sets who sits where in a copy (seat changes the client already heard about stay as they are). */
  seatAll(v: Vehicle, seats: (string | null)[]): void {
    for (let i = 0; i < v.seats.length; i++) {
      const want = seats[i] ?? null;
      const was = v.seats[i];
      if (was === want) continue;
      if (was && this.seated.get(was)?.[0] === v && this.seated.get(was)?.[1] === i) this.seated.delete(was);
      v.seats[i] = want;
      if (want) {
        const old = this.seated.get(want);
        if (old && (old[0] !== v || old[1] !== i) && old[0].seats[old[1]] === want) old[0].seats[old[1]] = null;
        this.seated.set(want, [v, i]);
      }
    }
  }

  /** A client's copy: who got in, moved or got out, as soon as it is heard (snapshots confirm it). */
  heard(e: { vehicle: number; stage: string; player?: string; seat?: number }): void {
    const v = this.list[e.vehicle];
    if (!v || !e.player) return;
    if (e.stage === 'in' || e.stage === 'seat') {
      const old = this.seated.get(e.player);
      if (old) old[0].seats[old[1]] = null;
      const s = e.seat ?? 0;
      v.seats[s] = e.player;
      this.seated.set(e.player, [v, s]);
      v.touched = true;
    } else if (e.stage === 'out' || e.stage === 'thrown') {
      const old = this.seated.get(e.player);
      if (old) old[0].seats[old[1]] = null;
      this.seated.delete(e.player);
    }
  }

  dispose(): void {
    const w = this.sim.physics.world;
    for (const v of this.list) w.removeRigidBody(v.body);
    this.list.length = 0;
    this.seated.clear();
  }
}
