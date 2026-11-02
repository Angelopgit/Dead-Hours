import { SKATEBOARD, type SkateTrick } from '../config/skateboards';
import { NAV_INDOOR, NAV_NEAR_WALL, NAV_REACHABLE } from './NavGrid';
import { clamp, dist2D, rng, type Vec3 } from './math';
import type { SimPlayer, Simulation } from './Simulation';

/** One skateboard: lying somewhere (wheels down or flipped over) or under a rider's feet. */
export interface Skateboard {
  id: number;
  /** Where it lies (the ground under its wheels), or under the rider while ridden. */
  pos: Vec3;
  /** Which way the nose points (radians, the same convention as a survivor's facing). */
  yaw: number;
  rider: string | null;
  /** Deck graphic and wheel colour (0..SKATEBOARD.looks-1). */
  look: number;
  /** Lying wheels-up where it was left (until someone rides it). */
  flipped: boolean;
}

/** Why a rider came off: stepped off, thrown by a hit or a wall, or went down. */
export type SkateOff = 'off' | 'bail';

const PAVED = new Set(['asphalt', 'concrete']);

/**
 * The boards of one night: a few placed at random on pavement (roads, sidewalks, driveways, the
 * gas station's lot) with one near the safehouse, the rider each one has, and what riding does
 * in the simulation (quiet rolling noise, being knocked off). How a board moves is the rider's
 * own browser's business, like walking: the server only checks the speed.
 */
export class Skateboards {
  readonly boards: Skateboard[] = [];
  private readonly noiseT = new Map<string, number>();

  constructor(private readonly sim: Simulation, seed: number, outdoor: Int32Array) {
    this.place(rng(((seed >>> 0) * 2246822519 + 0x5ca7e) >>> 0), outdoor);
  }

  /** Lays the night's boards: the same spots for the same seed on every machine. */
  private place(rand: () => number, outdoor: Int32Array): void {
    const sim = this.sim;
    const nav = sim.nav;
    const spawn = sim.map.playerSpawns[0];
    const S = SKATEBOARD;
    const spots: Vec3[] = [];
    // A clear run of pavement under the board: not by a wall, outdoors, on asphalt or concrete.
    const spotAt = (n: number): Vec3 | null => {
      const f = nav.flags[n];
      if (!(f & NAV_REACHABLE) || f & NAV_INDOOR || f & NAV_NEAR_WALL) return null;
      const x = nav.nodeX(n), z = nav.nodeZ(n), y = nav.nodeY[n];
      const b = sim.map.bounds;
      if (x < b.x0 + 6 || x > b.x1 - 6 || z < b.z0 + 6 || z > b.z1 - 6) return null;
      const hit = sim.physics.raycastHit(x, y + 0.6, z, 0, -1, 0, 1.2);
      if (!hit || hit.ny < 0.95 || !PAVED.has(hit.surface)) return null;
      return { x, y: y + 0.6 - hit.distance, z };
    };
    const free = (p: Vec3, gap: number) => spots.every((s) => dist2D(s, p) >= gap);
    if (spawn) {
      // Every spot in the ring around the safehouse, tried in a random order until one will do.
      const ring: number[] = [];
      for (const n of outdoor) {
        const d = Math.hypot(nav.nodeX(n) - spawn.x, nav.nodeZ(n) - spawn.z);
        if (d >= S.nearSafehouse[0] && d <= S.nearSafehouse[1]) ring.push(n);
      }
      for (let left = ring.length; left > 0 && !spots.length; left--) {
        const k = Math.floor(rand() * left);
        const p = spotAt(ring[k]);
        ring[k] = ring[left - 1];
        if (p) spots.push(p);
      }
    }
    for (let tries = 0; tries < 6000 && spots.length < S.count && outdoor.length; tries++) {
      const n = outdoor[Math.floor(rand() * outdoor.length)];
      const p = spotAt(n);
      if (!p || (spawn && Math.hypot(p.x - spawn.x, p.z - spawn.z) < S.spacing) || !free(p, S.spacing)) continue;
      spots.push(p);
    }
    for (const p of spots) {
      this.boards.push({ id: this.boards.length, pos: p, yaw: rand() * Math.PI * 2, rider: null, look: Math.floor(rand() * S.looks), flipped: rand() < 0.35 });
    }
  }

  board(id: number): Skateboard | undefined {
    return this.boards[id];
  }

  /** The board a survivor is riding, if any. */
  ridden(player: string): Skateboard | null {
    for (const b of this.boards) if (b.rider === player) return b;
    return null;
  }

  /** Whether a survivor standing here can hop on this board (in reach, nobody on it). */
  canRide(p: SimPlayer, b: Skateboard): boolean {
    if (!p.up || b.rider !== null || this.ridden(p.id)) return false;
    const m = p.motion.pos;
    return dist2D(m, b.pos) <= SKATEBOARD.reach + 0.6 && Math.abs(m.y - b.pos.y) <= SKATEBOARD.reachUp;
  }

  /** Boards free to hop on within reach of a survivor, nearest first. */
  inReach(p: SimPlayer): Skateboard[] {
    const m = p.motion.pos;
    return this.boards
      .filter((b) => b.rider === null && dist2D(m, b.pos) <= SKATEBOARD.reach && Math.abs(m.y - b.pos.y) <= SKATEBOARD.reachUp)
      .sort((a, b) => dist2D(m, a.pos) - dist2D(m, b.pos));
  }

  /** Hops a survivor onto a board. Returns false when they can't (taken, out of reach, down). */
  ride(p: SimPlayer, id: number): boolean {
    const b = this.boards[id];
    if (!b || !this.canRide(p, b)) return false;
    b.rider = p.id;
    b.flipped = false;
    b.pos = { ...p.motion.pos };
    this.noiseT.set(p.id, SKATEBOARD.noiseEvery);
    this.sim.emit({ type: 'skate', player: p.id, board: b.id, stage: 'on', pos: { ...b.pos }, yaw: b.yaw });
    return true;
  }

  /**
   * Takes a survivor off their board, which comes to rest on the ground where they were (or at
   * `at`, where their own browser put it, when that is close by). `bail`: thrown off.
   */
  hopOff(p: SimPlayer, how: SkateOff = 'off', at?: Vec3, yaw?: number): Skateboard | null {
    const b = this.ridden(p.id);
    if (!b) return null;
    const m = p.motion.pos;
    const spot = at && Number.isFinite(at.x) && Number.isFinite(at.z) && dist2D(at, m) < 2.5 && Math.abs((at.y ?? m.y) - m.y) < 1.5 ? at : m;
    b.rider = null;
    b.pos = this.ground(spot.x, Math.max(spot.y, m.y), spot.z);
    if (yaw !== undefined && Number.isFinite(yaw)) b.yaw = yaw;
    this.noiseT.delete(p.id);
    this.sim.emit({ type: 'skate', player: p.id, board: b.id, stage: how, pos: { ...b.pos }, yaw: b.yaw });
    if (how === 'bail') this.sim.noise(b.pos, SKATEBOARD.landNoise, p.id);
    return b;
  }

  /** A rider popped a flip trick: everyone is told, so they see it. */
  trick(p: SimPlayer, kind: SkateTrick): boolean {
    const b = this.ridden(p.id);
    if (!b || !p.up) return false;
    this.sim.emit({ type: 'skate', player: p.id, board: b.id, stage: 'trick', pos: { ...b.pos }, yaw: b.yaw, trick: kind });
    return true;
  }

  /** A hit this hard throws a rider off. */
  hit(p: SimPlayer, damage: number): void {
    if (damage >= SKATEBOARD.knockDamage && this.ridden(p.id)) this.hopOff(p, 'bail');
  }

  /** The floor under a point (the board settles onto it). */
  private ground(x: number, y: number, z: number): Vec3 {
    const d = this.sim.physics.raycast(x, y + 0.5, z, 0, -1, 0, 3);
    return { x, y: d !== null ? y + 0.5 - d : y, z };
  }

  /** Ridden boards go where their riders go and make their noise; a rider who went down or left comes off. */
  step(dt: number): void {
    for (const b of this.boards) {
      if (!b.rider) continue;
      const p = this.sim.players.get(b.rider);
      if (!p || !p.up) {
        if (p) this.hopOff(p, 'off');
        else b.rider = null;
        continue;
      }
      const m = p.motion;
      b.pos.x = m.pos.x;
      b.pos.y = m.pos.y;
      b.pos.z = m.pos.z;
      if (m.board !== undefined && Number.isFinite(m.board)) b.yaw = m.board;
      else if (Math.hypot(m.vel.x, m.vel.z) > 0.5) b.yaw = Math.atan2(m.vel.x, m.vel.z);
      // Wheels on the street: heard a little way off, more the faster they roll.
      const speed = Math.hypot(m.vel.x, m.vel.z);
      let t = (this.noiseT.get(p.id) ?? 0) - dt;
      if (t <= 0) {
        t = SKATEBOARD.noiseEvery;
        if (speed > 1.2 && m.grounded) this.sim.noise(m.pos, clamp(speed / SKATEBOARD.pushTop, 0.3, 1.15) * SKATEBOARD.noise, p.id);
      }
      this.noiseT.set(p.id, t);
    }
  }

  /** A client's copy: sets a board as the server last said. */
  remote(id: number, pos: Vec3, yaw: number, rider: string | null, look: number, flipped: boolean): void {
    let b = this.boards[id];
    if (!b) {
      b = { id, pos: { ...pos }, yaw, rider, look, flipped };
      this.boards[id] = b;
      return;
    }
    b.pos.x = pos.x;
    b.pos.y = pos.y;
    b.pos.z = pos.z;
    b.yaw = yaw;
    b.rider = rider;
    b.look = look;
    b.flipped = flipped;
  }
}
