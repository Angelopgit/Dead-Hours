import { BICYCLE } from '../config/bicycles';
import { NAV_INDOOR, NAV_NEAR_WALL, NAV_REACHABLE } from './NavGrid';
import { clamp, dist2D, rng, type Vec3 } from './math';
import type { SimPlayer, Simulation } from './Simulation';

/** One bicycle: lying on its side somewhere, or under a rider (with maybe someone on its pegs). */
export interface Bicycle {
  id: number;
  /** Where it lies (the ground under the saddle), or under the rider while ridden. */
  pos: Vec3;
  /** Which way the front wheel points (radians, the same convention as a survivor's facing). */
  yaw: number;
  rider: string | null;
  /** Standing on the pegs over the back wheel (only while someone rides it). */
  passenger: string | null;
  /** Frame colour (0..BICYCLE.looks-1). */
  look: number;
}

/** Where a survivor is on a bike. */
export type BikeSeat = 'rider' | 'peg';

/** Why someone came off: got off, or thrown (a hit, a wall, going down). */
export type BikeOff = 'off' | 'bail';

const PAVED = new Set(['asphalt', 'concrete']);

/**
 * The bikes of one night: a few laid at random on pavement with one near the safehouse, who rides
 * each one and who stands on its pegs, and what riding does in the simulation (quiet tyre noise,
 * being knocked off, the bell). How a bike moves is the rider's own browser's business, like
 * walking: the server only checks the speed. A passenger goes where the bike goes: here, every
 * step, they are put on its pegs (their own browser only says where they look and shoot).
 */
export class Bicycles {
  readonly bikes: Bicycle[] = [];
  private readonly noiseT = new Map<number, number>();
  private readonly bellAt = new Map<string, number>();

  constructor(private readonly sim: Simulation, seed: number, outdoor: Int32Array, avoid: readonly Vec3[]) {
    this.place(rng(((seed >>> 0) * 3266489917 + 0xb1c7c1e) >>> 0), outdoor, avoid);
  }

  /** Lays the night's bikes: the same spots for the same seed on every machine. */
  private place(rand: () => number, outdoor: Int32Array, avoid: readonly Vec3[]): void {
    const sim = this.sim;
    const nav = sim.nav;
    const spawn = sim.map.playerSpawns[0];
    const B = BICYCLE;
    const spots: Vec3[] = [];
    // A clear run of pavement: outdoors, not by a wall, on asphalt or concrete, flat under both wheels.
    const spotAt = (n: number): Vec3 | null => {
      const f = nav.flags[n];
      if (!(f & NAV_REACHABLE) || f & NAV_INDOOR || f & NAV_NEAR_WALL) return null;
      const x = nav.nodeX(n), z = nav.nodeZ(n), y = nav.nodeY[n];
      const b = sim.map.bounds;
      if (x < b.x0 + 6 || x > b.x1 - 6 || z < b.z0 + 6 || z > b.z1 - 6) return null;
      const hit = sim.physics.raycastHit(x, y + 0.6, z, 0, -1, 0, 1.2);
      if (!hit || hit.ny < 0.95 || !PAVED.has(hit.surface)) return null;
      if (avoid.some((a) => dist2D(a, { x, y, z }) < B.clearOfBoards)) return null;
      return { x, y: y + 0.6 - hit.distance, z };
    };
    const free = (p: Vec3, gap: number) => spots.every((s) => dist2D(s, p) >= gap);
    if (spawn) {
      const ring: number[] = [];
      for (const n of outdoor) {
        const d = Math.hypot(nav.nodeX(n) - spawn.x, nav.nodeZ(n) - spawn.z);
        if (d >= B.nearSafehouse[0] && d <= B.nearSafehouse[1]) ring.push(n);
      }
      for (let left = ring.length; left > 0 && !spots.length; left--) {
        const k = Math.floor(rand() * left);
        const p = spotAt(ring[k]);
        ring[k] = ring[left - 1];
        if (p) spots.push(p);
      }
    }
    for (let tries = 0; tries < 6000 && spots.length < B.count && outdoor.length; tries++) {
      const n = outdoor[Math.floor(rand() * outdoor.length)];
      const p = spotAt(n);
      if (!p || (spawn && Math.hypot(p.x - spawn.x, p.z - spawn.z) < B.spacing) || !free(p, B.spacing)) continue;
      spots.push(p);
    }
    for (const p of spots) {
      // Lying along whichever way the clear ground runs longest, so neither wheel is in a wall.
      const start = rand() * Math.PI * 2;
      let best = start, room = -1;
      for (let k = 0; k < 8; k++) {
        const yaw = start + (k * Math.PI) / 8;
        const fx = Math.sin(yaw), fz = Math.cos(yaw);
        const ahead = sim.physics.raycast(p.x, p.y + 0.4, p.z, fx, 0, fz, 1.4) ?? 1.4;
        const behind = sim.physics.raycast(p.x, p.y + 0.4, p.z, -fx, 0, -fz, 1.4) ?? 1.4;
        const r = Math.min(ahead, behind);
        if (r > room) {
          room = r;
          best = yaw;
        }
        if (r >= 1.4) break;
      }
      this.bikes.push({ id: this.bikes.length, pos: p, yaw: best, rider: null, passenger: null, look: Math.floor(rand() * B.looks) });
    }
  }

  bike(id: number): Bicycle | undefined {
    return this.bikes[id];
  }

  /** The bike a survivor pedals, if any. */
  ridden(player: string): Bicycle | null {
    for (const b of this.bikes) if (b && b.rider === player) return b;
    return null;
  }

  /** The bike whose pegs a survivor stands on, if any. */
  carrying(player: string): Bicycle | null {
    for (const b of this.bikes) if (b && b.passenger === player) return b;
    return null;
  }

  /** Where a survivor is on a bike, if they are on one. */
  seatOf(player: string): { bike: Bicycle; seat: BikeSeat } | null {
    for (const b of this.bikes) {
      if (!b) continue;
      if (b.rider === player) return { bike: b, seat: 'rider' };
      if (b.passenger === player) return { bike: b, seat: 'peg' };
    }
    return null;
  }

  /** On a bike in either seat. */
  onBike(player: string): boolean {
    return this.seatOf(player) !== null;
  }

  private near(p: SimPlayer, b: Bicycle, slack = 0): boolean {
    const m = p.motion.pos;
    return dist2D(m, b.pos) <= BICYCLE.reach + slack && Math.abs(m.y - b.pos.y) <= BICYCLE.reachUp;
  }

  /** How fast a ridden bike goes (its rider's speed). */
  speedOf(b: Bicycle): number {
    const r = b.rider ? this.sim.players.get(b.rider) : undefined;
    return r ? Math.hypot(r.motion.vel.x, r.motion.vel.z) : 0;
  }

  /** What a survivor standing here could do with this bike: pick it up, hop on its pegs, or nothing. */
  offer(p: SimPlayer, b: Bicycle, slack = 0): BikeSeat | null {
    if (!p.up || this.onBike(p.id) || this.sim.skateboards.ridden(p.id) || !this.near(p, b, slack)) return null;
    if (b.rider === null) return 'rider';
    if (b.passenger === null && b.rider !== p.id && this.speedOf(b) <= BICYCLE.pegMaxSpeed + slack * 2) return 'peg';
    return null;
  }

  /** Bikes within reach that a survivor could get on (pick up, or hop on the pegs), nearest first. */
  inReach(p: SimPlayer): { bike: Bicycle; seat: BikeSeat }[] {
    const m = p.motion.pos;
    const out: { bike: Bicycle; seat: BikeSeat }[] = [];
    for (const b of this.bikes) {
      if (!b) continue;
      const seat = this.offer(p, b);
      if (seat) out.push({ bike: b, seat });
    }
    return out.sort((a, b) => dist2D(m, a.bike.pos) - dist2D(m, b.bike.pos));
  }

  /**
   * Gets a survivor on a bike: picks up a free one (`rider`), or hops on the pegs of one someone
   * rides (`peg`). Returns false when they can't (taken, out of reach, too fast, down).
   */
  mount(p: SimPlayer, id: number, seat: BikeSeat): boolean {
    const b = this.bikes[id];
    // A little slack: the client offered it from where it drew the bike a moment ago.
    if (!b || this.offer(p, b, 0.6) !== seat) return false;
    if (seat === 'rider') {
      b.rider = p.id;
      b.pos = { ...p.motion.pos };
      this.noiseT.set(b.id, BICYCLE.noiseEvery);
    } else {
      b.passenger = p.id;
      this.placePassenger(b, p);
    }
    this.sim.emit({ type: 'bike', player: p.id, bike: b.id, stage: 'on', seat, pos: { ...b.pos }, yaw: b.yaw });
    return true;
  }

  /**
   * Takes a survivor off their bike. A rider's bike falls over where they leave it (at `at`, where
   * their own browser put it, when that is close by) and whoever stood on the pegs comes off too;
   * a passenger steps down beside it (at `at` when close by). `bail`: thrown off.
   */
  getOff(p: SimPlayer, how: BikeOff = 'off', at?: Vec3, yaw?: number): Bicycle | null {
    const on = this.seatOf(p.id);
    if (!on) return null;
    const b = on.bike;
    const m = p.motion.pos;
    const close = (q: Vec3 | undefined, from: Vec3, d: number): q is Vec3 =>
      !!q && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && dist2D(q, from) < d && Math.abs(q.y - from.y) < 1.5;
    if (on.seat === 'rider') {
      const spot = close(at, m, 2.5) ? at : m;
      b.rider = null;
      b.pos = this.ground(spot.x, Math.max(spot.y, m.y), spot.z);
      if (yaw !== undefined && Number.isFinite(yaw)) b.yaw = yaw;
      this.noiseT.delete(b.id);
      this.sim.emit({ type: 'bike', player: p.id, bike: b.id, stage: how, seat: 'rider', pos: { ...b.pos }, yaw: b.yaw });
      if (how === 'bail') this.sim.noise(b.pos, BICYCLE.crashNoise, p.id);
      const q = b.passenger ? this.sim.players.get(b.passenger) : undefined;
      if (q) this.dropPassenger(b, q, how);
      else b.passenger = null;
    } else {
      // Off the pegs: down beside the back wheel (or where their own browser stepped down, when that is close by).
      const spot = close(at, m, 3.2) ? this.ground(at.x, at.y, at.z) : this.beside(b);
      b.passenger = null;
      this.putDown(p, spot);
      this.sim.emit({ type: 'bike', player: p.id, bike: b.id, stage: how, seat: 'peg', pos: { ...spot }, yaw: b.yaw });
    }
    return b;
  }

  /** The bike's rider left it (or was thrown): whoever stood on the pegs steps down beside it. */
  private dropPassenger(b: Bicycle, q: SimPlayer, how: BikeOff): void {
    b.passenger = null;
    const spot = this.beside(b);
    this.putDown(q, spot);
    this.sim.emit({ type: 'bike', player: q.id, bike: b.id, stage: how, seat: 'peg', pos: { ...spot }, yaw: b.yaw });
  }

  /** On the ground beside the back wheel (the left side, or the right when a wall is there). */
  private beside(b: Bicycle): Vec3 {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const lx = fz, lz = -fx;
    const px = b.pos.x - fx * BICYCLE.pegBack, pz = b.pos.z - fz * BICYCLE.pegBack, y = b.pos.y;
    for (const side of [1, -1]) {
      const room = this.sim.physics.raycast(px, y + 0.9, pz, lx * side, 0, lz * side, 1.1);
      if (room === null) return this.ground(px + lx * side * 0.7, y + 0.3, pz + lz * side * 0.7);
    }
    return this.ground(px, y + 0.3, pz);
  }

  private putDown(p: SimPlayer, spot: Vec3): void {
    const m = p.motion;
    m.pos = { ...spot };
    m.grounded = true;
  }

  /** A hit this hard knocks a survivor off their bike (either seat). */
  hit(p: SimPlayer, damage: number): void {
    if (damage >= BICYCLE.knockDamage && this.onBike(p.id)) this.getOff(p, 'bail');
  }

  /** The rider rings the bell (heard down the street, by zombies too). */
  ring(p: SimPlayer): boolean {
    const b = this.ridden(p.id);
    if (!b || !p.up) return false;
    const t = this.sim.time;
    if (t - (this.bellAt.get(p.id) ?? -Infinity) < BICYCLE.bellEvery) return false;
    this.bellAt.set(p.id, t);
    this.sim.emit({ type: 'bike', player: p.id, bike: b.id, stage: 'bell', seat: 'rider', pos: { ...b.pos }, yaw: b.yaw });
    this.sim.noise(b.pos, BICYCLE.bellNoise, p.id);
    return true;
  }

  /** Where the pegs are on a bike: the passenger's feet (and position). */
  pegs(b: Bicycle, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    out.x = b.pos.x - Math.sin(b.yaw) * BICYCLE.pegBack;
    out.y = b.pos.y + BICYCLE.pegHeight;
    out.z = b.pos.z - Math.cos(b.yaw) * BICYCLE.pegBack;
    return out;
  }

  private placePassenger(b: Bicycle, q: SimPlayer): void {
    const m = q.motion;
    m.pos = this.pegs(b, { x: 0, y: 0, z: 0 });
    const r = b.rider ? this.sim.players.get(b.rider) : undefined;
    m.vel = r ? { ...r.motion.vel } : { x: 0, y: 0, z: 0 };
    m.grounded = true;
    m.sprinting = false;
  }

  /** The floor under a point (a bike settles onto it). */
  private ground(x: number, y: number, z: number): Vec3 {
    const d = this.sim.physics.raycast(x, y + 0.5, z, 0, -1, 0, 3);
    return { x, y: d !== null ? y + 0.5 - d : y, z };
  }

  /**
   * Ridden bikes go where their riders go and make their noise; passengers are put on the pegs;
   * a rider or passenger who went down or left comes off.
   */
  step(dt: number): void {
    for (const b of this.bikes) {
      if (!b) continue;
      if (b.passenger && (!b.rider || !this.sim.players.get(b.passenger)?.up)) {
        const q = this.sim.players.get(b.passenger);
        if (q && b.rider) this.getOff(q, 'off');
        else if (q) this.dropPassenger(b, q, 'off');
        else b.passenger = null;
      }
      if (!b.rider) continue;
      const p = this.sim.players.get(b.rider);
      if (!p || !p.up) {
        if (p) this.getOff(p, 'off');
        else {
          b.rider = null;
          const q = b.passenger ? this.sim.players.get(b.passenger) : undefined;
          if (q) this.dropPassenger(b, q, 'off');
          b.passenger = null;
        }
        continue;
      }
      const m = p.motion;
      b.pos.x = m.pos.x;
      b.pos.y = m.pos.y;
      b.pos.z = m.pos.z;
      if (m.bike !== undefined && Number.isFinite(m.bike)) b.yaw = m.bike;
      else if (Math.hypot(m.vel.x, m.vel.z) > 0.5) b.yaw = Math.atan2(m.vel.x, m.vel.z);
      const q = b.passenger ? this.sim.players.get(b.passenger) : undefined;
      if (q) this.placePassenger(b, q);
      // Tyres hiss and the freewheel ticks: heard a few metres off, more the faster it goes.
      const speed = Math.hypot(m.vel.x, m.vel.z);
      let t = (this.noiseT.get(b.id) ?? 0) - dt;
      if (t <= 0) {
        t = BICYCLE.noiseEvery;
        if (speed > 1.5 && m.grounded) this.sim.noise(m.pos, clamp(speed / BICYCLE.pedalTop, 0.3, 1.15) * BICYCLE.noise, p.id);
      }
      this.noiseT.set(b.id, t);
    }
  }

  /** A client's copy: sets a bike as the server last said. */
  remote(id: number, pos: Vec3, yaw: number, rider: string | null, passenger: string | null, look: number): void {
    let b = this.bikes[id];
    if (!b) {
      b = { id, pos: { ...pos }, yaw, rider, passenger, look };
      this.bikes[id] = b;
      return;
    }
    b.pos.x = pos.x;
    b.pos.y = pos.y;
    b.pos.z = pos.z;
    b.yaw = yaw;
    b.rider = rider;
    b.passenger = passenger;
    b.look = look;
  }
}
