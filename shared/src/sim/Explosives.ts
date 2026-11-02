import { WORLD_FILTER, type Physics, type RAPIER, type Surface } from '../physics/Physics';
import { BLAST, FIRE, THROWABLES, THROWING, type ThrowableDef, type ThrowKind } from '../config/throwables';
import type { HitZone } from '../config/weapons';
import type { ArmZone } from '../config/limbs';
import { PLAYER } from '../config/player';
import { along, type ZoneShape } from './hitzones';
import { clamp, dist2D, type Vec3 } from './math';
import type { Zombie } from './Zombie';
import type { SimPlayer, Simulation } from './Simulation';
import type { GibPart } from './events';

/** Something thrown, in flight or lying where it stopped. */
export interface SimThrowable {
  id: number;
  kind: ThrowKind;
  /** Who threw it (kept even if they leave: kills still count to them). */
  by: SimPlayer;
  pos: Vec3;
  vel: Vec3;
  /** Came to rest on the floor. */
  rest: boolean;
  thrownAt: number;
  /** Frags: when it goes off. */
  fuseAt: number;
  /** When it last bounced (sound and event spacing). */
  bouncedAt: number;
}

/** One burning patch of spilled fuel. */
export interface FirePatch {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** A Molotov's spill: patches of burning fuel on the floor where it broke. */
export interface SimFire {
  id: number;
  by: SimPlayer;
  pos: Vec3;
  patches: FirePatch[];
  start: number;
  end: number;
}

/** Fire strength 0..1 at time `t` (flares up in a moment, dies down over FIRE.fade). */
export function fireStrength(f: { start: number; end: number }, t: number): number {
  if (t < f.start || t >= f.end) return 0;
  return clamp((t - f.start) / 0.35, 0, 1) * clamp((f.end - t) / FIRE.fade, 0, 1);
}

/** Where a throw leaves the hand and how fast, from the eye and aim direction. Same in the sim and the aiming arc. */
export function throwLaunch(physics: Physics, eye: Vec3, dir: Vec3, yaw: number, kind: ThrowKind, carry: Vec3): { pos: Vec3; vel: Vec3 } {
  const def = THROWABLES[kind];
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  let dx = dir.x / dl, dy = dir.y / dl, dz = dir.z / dl;
  // Lobbed a little above the crosshair.
  const pitch = Math.asin(clamp(dy, -1, 1)) + def.lift;
  const h = Math.hypot(dx, dz) || 1;
  const cp = Math.cos(pitch);
  dx = (dx / h) * cp;
  dz = (dz / h) * cp;
  dy = Math.sin(pitch);
  // From over the right shoulder, kept on this side of any wall.
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const ox = rx * 0.22 + dx * 0.25, oy = -0.02, oz = rz * 0.22 + dz * 0.25;
  const ol = Math.hypot(ox, oy, oz);
  const hit = physics.raycast(eye.x, eye.y, eye.z, ox / ol, oy / ol, oz / ol, ol + def.radius + 0.02);
  const k = hit === null ? 1 : Math.max(0, (hit - def.radius - 0.03) / ol);
  return {
    pos: { x: eye.x + ox * k, y: eye.y + oy * k, z: eye.z + oz * k },
    vel: { x: dx * def.speed + carry.x * 0.5, y: dy * def.speed + Math.max(0, carry.y) * 0.5, z: dz * def.speed + carry.z * 0.5 },
  };
}

/** What a flight step ran into. */
export interface FlightContact {
  pos: Vec3;
  normal: Vec3;
  surface: Surface;
  /** Speed into the surface (m/s). */
  speed: number;
}

/**
 * Moves something thrown by one step: gravity, a little drag, bounces off the world (doors
 * included, characters not). Returns the surface it hit hard enough to bounce, if any.
 * Shared by the simulation and the client's aiming arc so the arc shows where it will go.
 */
export function flightStep(
  physics: Physics, f: { pos: Vec3; vel: Vec3; rest: boolean }, def: ThrowableDef, dt: number,
  glass?: (collider: RAPIER.Collider, at: Vec3, dir: Vec3) => boolean,
): FlightContact | null {
  if (f.rest) return null;
  const v = f.vel, p = f.pos;
  v.y -= THROWING.gravity * dt;
  const drag = Math.exp(-THROWING.drag * dt);
  v.x *= drag; v.y *= drag; v.z *= drag;
  const len = Math.hypot(v.x, v.y, v.z) * dt;
  if (len < 1e-7) return null;
  const dx = (v.x * dt) / len, dy = (v.y * dt) / len, dz = (v.z * dt) / len;
  const hit = physics.raycastHit(p.x, p.y, p.z, dx, dy, dz, len + def.radius, WORLD_FILTER);
  // Thrown hard at a window it goes through the glass (`glass` smashes it, or says it would).
  const through = !!hit && !!glass && hit.surface === 'glass' && len / dt > THROWING.glassSpeed
    && glass(hit.collider, { x: p.x + dx * hit.distance, y: p.y + dy * hit.distance, z: p.z + dz * hit.distance }, { x: dx, y: dy, z: dz });
  if (!hit || through) {
    p.x += dx * len; p.y += dy * len; p.z += dz * len;
    return null;
  }
  const travel = Math.max(0, hit.distance - def.radius);
  p.x += dx * travel; p.y += dy * travel; p.z += dz * travel;
  const nx = hit.nx, ny = hit.ny, nz = hit.nz;
  const vn = v.x * nx + v.y * ny + v.z * nz;
  if (vn >= 0) return null;
  const speed = -vn;
  // Split into along the surface and into it.
  let tx = v.x - nx * vn, ty = v.y - ny * vn, tz = v.z - nz * vn;
  if (speed > 1.2) {
    tx *= def.friction; ty *= def.friction; tz *= def.friction;
    v.x = tx + nx * speed * def.restitution;
    v.y = ty + ny * speed * def.restitution;
    v.z = tz + nz * speed * def.restitution;
  } else {
    // Rolling and sliding to a stop.
    const roll = Math.exp(-4.5 * dt);
    v.x = tx * roll; v.y = ty * roll; v.z = tz * roll;
    if (ny > 0.6 && Math.hypot(v.x, v.y, v.z) < 0.35) {
      v.x = v.y = v.z = 0;
      f.rest = true;
    }
  }
  return speed > 1.2 ? { pos: { ...p }, normal: { x: nx, y: ny, z: nz }, surface: hit.surface, speed } : null;
}

const LEGS: ('legL' | 'legR')[] = ['legL', 'legR'];
const ARMS: ArmZone[] = ['armL', 'armR'];

/**
 * Grenades and Molotovs: what is in the air, what is burning, and what they do. Authoritative
 * like the rest of the simulation (solo in the browser, online on the server); clients draw it
 * from the events: 'thrown' and 'bounce' carry the flight, 'explosion' and 'fire' the rest.
 */
export class Explosives {
  readonly thrown: SimThrowable[] = [];
  readonly fires: SimFire[] = [];
  private nextId = 1;
  private tickAt = 0;
  private readonly zones: ZoneShape[] = [];

  constructor(private readonly sim: Simulation) {}

  /** Lets go of a throwable from a survivor's hand. */
  release(p: SimPlayer, kind: ThrowKind, aim: { origin: Vec3; dir: Vec3 }): SimThrowable {
    const sim = this.sim;
    const m = p.motion;
    const { pos, vel } = throwLaunch(sim.physics, p.eye, aim.dir, m.yaw, kind, m.vel);
    const t: SimThrowable = {
      id: this.nextId++, kind, by: p, pos, vel, rest: false, thrownAt: sim.time,
      fuseAt: kind === 'frag' ? sim.time + THROWING.fuse : Infinity, bouncedAt: -1,
    };
    this.thrown.push(t);
    sim.emit({ type: 'thrown', id: t.id, kind, player: p.id, pos: { ...pos }, vel: { ...vel }, fuseAt: Number.isFinite(t.fuseAt) ? t.fuseAt : 0 });
    return t;
  }

  step(dt: number): void {
    const sim = this.sim;
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const t = this.thrown[i];
      const def = THROWABLES[t.kind];
      const hit = flightStep(sim.physics, t, def, dt, (c, at, d) => sim.smashPane(c, at, d));
      if (t.kind === 'molotov') {
        const z = this.zombieAt(t.pos, def.radius);
        if (z || (hit && hit.speed > THROWING.shatterSpeed) || t.rest || sim.time - t.thrownAt > THROWING.maxFlight) {
          this.thrown.splice(i, 1);
          this.shatter(t, hit?.normal ?? { x: 0, y: 1, z: 0 });
          continue;
        }
      } else {
        // A grenade knocks off whoever it hits and drops at their feet.
        const z = !t.rest ? this.zombieAt(t.pos, def.radius) : null;
        if (z) {
          const hl = Math.hypot(t.vel.x, t.vel.z) || 1;
          t.vel.x = (-t.vel.x / hl) * 0.8;
          t.vel.z = (-t.vel.z / hl) * 0.8;
          t.vel.y = Math.min(t.vel.y, 0);
        }
        if (sim.time >= t.fuseAt) {
          this.thrown.splice(i, 1);
          this.explode(t.pos, t.by, t.id);
          continue;
        }
      }
      if (hit && sim.time - t.bouncedAt > 0.05) {
        t.bouncedAt = sim.time;
        sim.emit({ type: 'bounce', id: t.id, pos: { ...t.pos }, vel: { ...t.vel }, surface: hit.surface, speed: hit.speed });
      } else if (t.rest && t.bouncedAt !== -2) {
        t.bouncedAt = -2;
        sim.emit({ type: 'bounce', id: t.id, pos: { ...t.pos }, vel: { x: 0, y: 0, z: 0 }, surface: 'concrete', speed: 0 });
      }
    }

    for (let i = this.fires.length - 1; i >= 0; i--) if (sim.time >= this.fires[i].end) this.fires.splice(i, 1);
    if (sim.time >= this.tickAt) {
      this.tickAt = sim.time + FIRE.tick;
      this.burn(FIRE.tick);
    }
  }

  /** A zombie whose body the point is inside (thrown things hitting someone). */
  private zombieAt(p: Vec3, r: number): Zombie | null {
    for (const z of this.sim.zombies) {
      if (!z.alive) continue;
      const dx = p.x - z.pos.x, dz = p.z - z.pos.z;
      const rr = z.def.radius + r + 0.05;
      if (dx * dx + dz * dz > rr * rr) continue;
      const top = z.state === 'down' ? 0.5 : z.def.height;
      if (p.y < z.pos.y - 0.05 || p.y > z.pos.y + top) continue;
      return z;
    }
    return null;
  }

  // ---------------------------------------------------------------- frag

  /**
   * A blast at `pos` thrown by `by`: damage falling off with distance and cover, survivors hurt
   * too, the living knocked down, the dead torn apart by how close each part was to it.
   */
  explode(pos: Vec3, by: SimPlayer, id = 0): void {
    const sim = this.sim;
    const physics = sim.physics;
    // The centre, lifted off the floor it lies on (sight lines start above it).
    const o = { x: pos.x, y: pos.y + 0.18, z: pos.z };
    const R = BLAST.radius;
    sim.noise(o, BLAST.noise, by.id);
    sim.emit({ type: 'explosion', id, kind: 'frag', pos: { ...pos }, player: by.id });
    sim.blastGlass(o, BLAST.glass);
    const force = (d: number) => (d <= BLAST.inner ? 1 : Math.pow(clamp(1 - (d - BLAST.inner) / (R - BLAST.inner), 0, 1), BLAST.falloff));
    const visible = (p: Vec3) => {
      const dx = p.x - o.x, dy = p.y - o.y, dz = p.z - o.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.3) return true;
      const hit = physics.raycast(o.x, o.y, o.z, dx / d, dy / d, dz / d, d);
      return hit === null || hit > d - 0.25;
    };

    // Zombies, nearest first (arms torn off nearer the blast come off before farther ones die).
    const near: { z: Zombie; d: number }[] = [];
    for (const z of sim.zombies) {
      if (!z.alive) continue;
      const d = Math.hypot(z.pos.x - o.x, z.pos.y + 0.9 * z.scale - o.y, z.pos.z - o.z);
      if (d < R + 1) near.push({ z, d });
    }
    near.sort((a, b) => a.d - b.d);
    for (const { z } of near) {
      if (!z.alive) continue;
      const zones = z.zones(this.zones).map((s) => ({ ...s }));
      const centre = (s: ZoneShape) => along(s.a, s.b, 0.5);
      // Cover: the head, chest and hips each seen from the blast or not.
      const chest = z.chest;
      const hips = { x: z.pos.x, y: z.pos.y + 0.75 * z.scale, z: z.pos.z };
      const head = zones.find((s) => s.zone === 'head')?.a ?? z.eye;
      const seen = [chest, hips, head].filter(visible).length;
      if (!seen) continue;
      const cover = [0, 0.45, 0.8, 1][seen];
      // Distance to the nearest part of the body.
      let best = Infinity;
      let zone: HitZone = 'torso';
      for (const s of zones) {
        const c = centre(s);
        const d = Math.max(0, Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z) - s.r);
        if (d < best) {
          best = d;
          zone = s.zone;
        }
      }
      const k = force(best) * cover;
      if (k <= 0.005) continue;
      const damage = BLAST.damage * k;
      const dir = this.away(o, chest, 0.35);
      const lethal = damage >= z.health;
      // What comes off: each part by how hard the blast tears at it (closer than the damage plateau).
      const partForce = (s: ZoneShape | undefined) => {
        if (!s) return 0;
        const c = centre(s);
        const d = Math.max(0, Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z) - s.r);
        return Math.pow(clamp(1 - d / BLAST.tearRadius, 0, 1), 1.2) * cover;
      };
      const shred = lethal && partForce(zones.find((s) => s.zone === 'torso')) > BLAST.shred;
      const roll = (q: number, rule: { from: number; chance: number }) =>
        shred || (q > rule.from && z.rand() < rule.chance * clamp((q - rule.from) / (1 - rule.from) * 1.6, 0, 1));
      for (const arm of ARMS) {
        const s = zones.find((x) => x.zone === arm);
        if (!s || !z.canLose(arm)) continue;
        const q = partForce(s);
        // Living zombies lose arms only to a close blast; the dead to anything near.
        if (!roll(lethal ? q : q * 0.7, BLAST.sever.arm)) continue;
        const cut = q > 0.7 || z.rand() < 0.5 ? 'shoulder' : 'elbow';
        sim.severArm(by, z, arm, cut, this.away(o, centre(s), 0.6), false, damage, lethal, 1 + q * (BLAST.fling / 4));
      }
      const gibs: GibPart[] = [];
      if (lethal) {
        for (const leg of LEGS) {
          const s = zones.find((x) => x.zone === leg);
          const q = partForce(s);
          if (s && roll(q, BLAST.sever.leg)) gibs.push(this.gib(leg, o, s, q));
        }
        const hs = zones.find((x) => x.zone === 'head');
        const q = partForce(hs);
        if (hs && roll(q, BLAST.sever.head)) gibs.push(this.gib('head', o, hs, q));
      }
      const at = centre(zones.find((s) => s.zone === zone) ?? zones[0]);
      sim.hitZombie(by, z, damage, zone, at, dir, false, 1, {
        armTally: 0, knock: 0,
        death: { cause: 'blast', gibs, shred, blast: { ...o } },
        force: 1.2 + k * 3.2,
      });
      // Survivors of the blast can still lose a leg (through the one leg-severing path) and crawl on.
      if (z.alive) {
        for (const leg of LEGS) {
          const s = zones.find((x) => x.zone === leg);
          if (!s || !z.canLoseLeg(leg)) continue;
          const q = partForce(s);
          if (!roll(q * 0.7, BLAST.sever.leg)) continue;
          sim.severLeg(by, z, leg, q > 0.7 || z.rand() < 0.5 ? 'hip' : 'knee', this.away(o, centre(s), 0.4), false, damage, false);
        }
      }
      if (z.alive && best < BLAST.inner * BLAST.knockDown) z.blasted(dir, k);
    }

    // Survivors: the thrower takes all of it, teammates a share.
    for (const p of sim.players.values()) {
      if (!p.alive) continue;
      const c = p.chest;
      const d = Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z);
      if (d > R) continue;
      const seen = [c, p.eye, { x: p.motion.pos.x, y: p.motion.pos.y + 0.3, z: p.motion.pos.z }].filter(visible).length;
      if (!seen) continue;
      const k = force(Math.max(0, d - PLAYER.radius)) * [0, 0.45, 0.8, 1][seen];
      const dmg = BLAST.playerDamage * k * (p === by ? 1 : BLAST.teamShare);
      if (dmg >= 0.5) sim.damagePlayer(p, dmg, o);
    }

    // Raiders caught in it.
    for (const r of sim.raid.raiders) {
      if (!r.alive) continue;
      const c = r.chest;
      const d = Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z);
      if (d > R) continue;
      const seen = [c, r.eye, { x: r.pos.x, y: r.pos.y + 0.3, z: r.pos.z }].filter(visible).length;
      if (!seen) continue;
      const k = force(Math.max(0, d - PLAYER.radius)) * [0, 0.45, 0.8, 1][seen];
      if (k > 0.01) sim.raid.hit(by, r, BLAST.playerDamage * 1.5 * k, 'torso', c, this.away(o, c, 0.3));
    }

    // Loose arms lying around are thrown about.
    for (const l of sim.limbs) {
      if (!l.body) continue;
      const d = Math.hypot(l.pos.x - o.x, l.pos.y - o.y, l.pos.z - o.z);
      if (d > R) continue;
      const k = force(d);
      const dir = this.away(o, l.pos, 0.5);
      const m = l.body.mass();
      l.body.applyImpulse({ x: dir.x * BLAST.scatter * k * m, y: dir.y * BLAST.scatter * k * m, z: dir.z * BLAST.scatter * k * m }, true);
      const r = sim.random;
      l.body.applyTorqueImpulse({ x: (r() - 0.5) * m * k, y: (r() - 0.5) * m * k, z: (r() - 0.5) * m * k }, true);
    }
  }

  /** Unit direction from the blast to a point, tipped upward by `lift`. */
  private away(o: Vec3, p: Vec3, lift: number): Vec3 {
    let x = p.x - o.x, y = p.y - o.y, z = p.z - o.z;
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y = y / l + lift; z /= l;
    const l2 = Math.hypot(x, y, z) || 1;
    return { x: x / l2, y: y / l2, z: z / l2 };
  }

  private gib(part: GibPart['part'], o: Vec3, s: ZoneShape, q: number): GibPart {
    const c = part === 'head' ? s.a : along(s.a, s.b, 0.5);
    return { part, pos: { ...c }, dir: this.away(o, c, part === 'head' ? 0.9 : 0.5), speed: 2.5 + q * BLAST.fling };
  }

  // ---------------------------------------------------------------- molotov

  /** The bottle breaks: fuel splashes out from where it hit and catches. */
  private shatter(t: SimThrowable, normal: Vec3): void {
    const sim = this.sim;
    const physics = sim.physics;
    // Broken on a wall or a zombie: the fuel runs down to the floor below.
    const p = { ...t.pos };
    const down = physics.raycast(p.x, p.y + 0.05, p.z, 0, -1, 0, 6);
    const floorY = down === null ? p.y : p.y + 0.05 - down;
    const centre = { x: p.x + normal.x * 0.05, y: floorY, z: p.z + normal.z * 0.05 };
    // Spreads farther the way it was going.
    const hl = Math.hypot(t.vel.x, t.vel.z);
    const fx = hl > 0.1 ? t.vel.x / hl : 0, fz = hl > 0.1 ? t.vel.z / hl : 0;
    const rand = sim.random;
    const patches: FirePatch[] = [{ x: centre.x, y: centre.y + 0.02, z: centre.z, r: FIRE.patchRadius * 1.15 }];
    for (let i = 0; i < FIRE.patches * 2 && patches.length < FIRE.patches; i++) {
      const a = rand() * Math.PI * 2;
      const d = FIRE.spread * Math.sqrt(0.15 + rand() * 0.85);
      let x = Math.cos(a) * d, z = Math.sin(a) * d;
      // Stretched along the throw.
      const along = x * fx + z * fz;
      if (along > 0) { x += fx * along * 0.6; z += fz * along * 0.6; }
      const tx = centre.x + x, tz = centre.z + z;
      // Not through walls, not down into another floor.
      const hx = tx - centre.x, hz = tz - centre.z;
      const hd = Math.hypot(hx, hz) || 1;
      const wall = physics.raycast(centre.x, centre.y + 0.25, centre.z, hx / hd, 0, hz / hd, hd + 0.2);
      if (wall !== null) continue;
      const g = physics.raycast(tx, centre.y + 0.8, tz, 0, -1, 0, 0.8 + FIRE.maxDrop);
      if (g === null) continue;
      const y = centre.y + 0.8 - g;
      if (Math.abs(y - centre.y) > FIRE.maxDrop) continue;
      if (patches.some((q) => Math.hypot(q.x - tx, q.z - tz) < FIRE.patchRadius * 0.55)) continue;
      patches.push({ x: tx, y: y + 0.02, z: tz, r: FIRE.patchRadius * (0.7 + rand() * 0.45) });
    }
    const f: SimFire = { id: t.id, by: t.by, pos: centre, patches, start: sim.time, end: sim.time + FIRE.duration };
    this.fires.push(f);
    sim.noise(centre, FIRE.noise, t.by.id);
    sim.emit({
      type: 'fire', id: f.id, player: t.by.id, pos: { ...p }, ground: { ...centre },
      patches: patches.map((q) => [q.x, q.y, q.z, q.r] as [number, number, number, number]), start: f.start, end: f.end,
    });
    // Whoever it broke on is alight at once.
    this.burn(0);
  }

  /** Strength (0..1) of the flames at a point, from every fire burning there. */
  flamesAt(p: Vec3, pad = 0, height = 1.6): number {
    let best = 0;
    const t = this.sim.time;
    for (const f of this.fires) {
      const s = fireStrength(f, t);
      if (s <= 0) continue;
      for (const q of f.patches) {
        if (p.y < q.y - 0.6 || p.y > q.y + height) continue;
        const d = Math.hypot(p.x - q.x, p.z - q.z);
        if (d < q.r * (0.4 + 0.6 * s) + pad) best = Math.max(best, s);
      }
    }
    return best;
  }

  /** Fire damage step: zombies in the flames catch, the burning burn down, survivors in it get hurt. */
  private burn(dt: number): void {
    const sim = this.sim;
    const t = sim.time;
    let anyBurning = false;
    for (const z of sim.zombies) {
      if (!z.alive) continue;
      if (this.fires.length && this.flamesAt(z.pos, z.def.radius) > 0.15) {
        const owner = this.ownerAt(z.pos) ?? z.burnBy;
        z.ignite(t + FIRE.burnTime, owner);
      }
      if (z.burnUntil > t) anyBurning = true;
    }
    if (!anyBurning && !this.fires.length) return;
    if (dt <= 0) return;
    // Burning zombies set those pressed against them alight.
    for (const z of sim.zombies) {
      if (!z.alive || z.burnUntil <= t) continue;
      for (const o of sim.zombies) {
        if (o === z || !o.alive || o.burnUntil > t) continue;
        if (dist2D(o.pos, z.pos) < FIRE.spreadRange && Math.abs(o.pos.y - z.pos.y) < 1 && sim.random() < FIRE.spreadChance) o.ignite(t + FIRE.burnTime * 0.8, z.burnBy);
      }
    }
    for (const z of sim.zombies) {
      if (!z.alive || z.burnUntil <= t) continue;
      const by = z.burnBy ? sim.players.get(z.burnBy.id) ?? z.burnBy : null;
      if (!by) continue;
      const dmg = z.def.health * (FIRE.burnRate[z.kind] ?? 0.26) * dt;
      if (sim.burnZombie(by, z, dmg)) z.burnUntil = 0;
    }
    // Survivors standing in the flames.
    for (const p of sim.players.values()) {
      if (!p.alive) continue;
      const s = this.flamesAt(p.motion.pos, 0.25, 1.2);
      if (s > 0.15) sim.damagePlayer(p, FIRE.playerDps * dt * s, this.nearestPatch(p.motion.pos));
    }
    // Raiders too (whoever lit it gets the credit).
    for (const r of sim.raid.raiders) {
      if (!r.alive) continue;
      const s = this.flamesAt(r.pos, 0.25, 1.2);
      const owner = s > 0.15 ? this.ownerAt(r.pos) : null;
      if (owner) sim.raid.hit(owner, r, FIRE.playerDps * 1.5 * dt * s, 'torso', r.chest, { x: 0, y: 1, z: 0 });
    }
  }

  private ownerAt(p: Vec3): SimPlayer | null {
    const t = this.sim.time;
    for (const f of this.fires) {
      if (fireStrength(f, t) <= 0) continue;
      for (const q of f.patches) if (Math.hypot(p.x - q.x, p.z - q.z) < q.r + 0.4) return f.by;
    }
    return null;
  }

  private nearestPatch(p: Vec3): Vec3 {
    let best: FirePatch | null = null;
    let bd = Infinity;
    for (const f of this.fires) for (const q of f.patches) {
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < bd) { bd = d; best = q; }
    }
    return best ? { x: best.x, y: best.y, z: best.z } : { ...p };
  }

  clear(): void {
    this.thrown.length = 0;
    this.fires.length = 0;
  }
}
