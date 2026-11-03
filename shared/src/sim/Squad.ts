import { PLAYER } from '../config/player';
import { WEAPONS } from '../config/weapons';
import type { ThrowKind } from '../config/throwables';
import { clamp, dist2D, rng, type Vec3 } from './math';
import type { SimPlayer, Simulation } from './Simulation';
import type { Zombie } from './Zombie';

/**
 * Computer-driven survivors: a sim player walked along a path, aimed and fired at the dead by
 * code instead of a browser. Movement is scripted (the bot goes where it is told, no collision:
 * paths are laid along open ground), fighting is not: it picks the nearest zombie it can see,
 * shoulders the gun, fires in bursts with a little error, reloads when the magazine runs dry
 * and goes back to looking where it was told. Used by the trailer; made for friendly teammates
 * in a solo night later.
 */
export interface BotOrders {
  /** Waypoints to walk, in order; the bot holds at the last one. */
  path?: Vec3[];
  /** Sprint between waypoints instead of walking. */
  run?: boolean;
  /** Engage zombies within this distance (m); 0 never fires. */
  range?: number;
  /** Where to look when nothing is in range (default: the way it walks, then ahead). */
  face?: Vec3;
  crouch?: boolean;
  /** Shoulder the gun even with nothing in sight. */
  aim?: boolean;
  light?: boolean;
  /** Hits land this share of the time (the rest are near misses). */
  accuracy?: number;
}

const WALK = PLAYER.walkSpeed;
const SPRINT = PLAYER.sprintSpeed;

/** Yaw of a survivor looking from `from` toward `to` (forward is (-sin yaw, -cos yaw)). */
export function yawToward(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

export class SquadBot {
  orders: BotOrders = {};
  /** Index of the next waypoint. */
  private leg = 0;
  private burstLeft = 0;
  private pauseT = 0;
  private trigger = false;
  private readonly rand: () => number;
  /** The zombie last fired at (kept a moment so the aim doesn't flick between two). */
  private targetId = -1;
  private targetT = 0;
  private yaw: number;
  private pitch = 0;

  constructor(readonly sim: Simulation, readonly id: string, seed: number) {
    this.rand = rng(seed);
    const p = this.player;
    this.yaw = p ? p.motion.yaw : 0;
  }

  get player(): SimPlayer | undefined {
    return this.sim.players.get(this.id);
  }

  /** New orders; the path starts from its first point. */
  order(o: BotOrders): void {
    this.orders = o;
    this.leg = 0;
  }

  /** Puts the bot down at `pos`, facing `yaw`, standing still. */
  place(pos: Vec3, yaw: number): void {
    const p = this.player;
    if (!p) return;
    this.yaw = yaw;
    this.pitch = 0;
    this.sim.setMotion(this.id, { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, yaw, pitch: 0, grounded: true, sprinting: false, crouching: false, aiming: false });
  }

  /** Throws a grenade or a Molotov at `at` (a lob: aimed a little over it). */
  throwAt(kind: ThrowKind, at: Vec3): boolean {
    const p = this.player;
    if (!p) return false;
    const eye = p.eye;
    const d = dist2D(eye, at);
    const dir = { x: at.x - eye.x, y: at.y - eye.y + d * 0.35, z: at.z - eye.z };
    this.yaw = yawToward(eye, at);
    this.sim.setMotion(this.id, { yaw: this.yaw });
    return this.sim.throwItem(this.id, kind, { origin: eye, dir });
  }

  /** One fixed step: walk the path, pick a target, shoot. */
  update(dt: number): void {
    const p = this.player;
    if (!p || !p.up) return;
    const o = this.orders;
    const m = p.motion;
    const pos = m.pos;
    // Walking.
    const vel = { x: 0, y: 0, z: 0 };
    let travelYaw: number | null = null;
    const path = o.path;
    if (path && this.leg < path.length) {
      const goal = path[this.leg];
      const dx = goal.x - pos.x, dz = goal.z - pos.z;
      const d = Math.hypot(dx, dz);
      const speed = o.run ? SPRINT : o.crouch ? PLAYER.crouchSpeed : WALK;
      if (d <= speed * dt) {
        pos.x = goal.x;
        pos.y = goal.y;
        pos.z = goal.z;
        this.leg++;
      } else {
        vel.x = (dx / d) * speed;
        vel.z = (dz / d) * speed;
        pos.x += vel.x * dt;
        pos.z += vel.z * dt;
        pos.y += (goal.y - pos.y) * Math.min(1, (speed * dt) / d);
        travelYaw = Math.atan2(-dx, -dz);
      }
    }
    const moving = vel.x !== 0 || vel.z !== 0;
    const running = moving && !!o.run;

    // Fighting.
    const range = o.range ?? 0;
    const target = range > 0 && !running ? this.pick(p, range) : null;
    let lookYaw: number;
    let lookPitch = 0;
    if (target) {
      const chest = target.chest;
      const eye = p.eye;
      lookYaw = yawToward(eye, chest);
      lookPitch = Math.atan2(chest.y - eye.y, dist2D(eye, chest));
    } else if (o.face && !moving) {
      lookYaw = yawToward(pos, o.face);
      lookPitch = Math.atan2(o.face.y - (pos.y + m.eyeHeight), dist2D(pos, o.face));
    } else if (travelYaw !== null) lookYaw = travelYaw;
    else lookYaw = this.yaw;
    // Turning takes a moment (a snap would look like a glitch on the body).
    const turn = target ? 12 : 6;
    const dy = Math.atan2(Math.sin(lookYaw - this.yaw), Math.cos(lookYaw - this.yaw));
    this.yaw += dy * (1 - Math.exp(-dt * turn));
    this.pitch += (lookPitch - this.pitch) * (1 - Math.exp(-dt * turn));
    const aiming = !!target || (!!o.aim && !running);
    this.sim.setMotion(this.id, {
      vel, yaw: this.yaw, pitch: this.pitch, grounded: true, sprinting: running,
      crouching: !!o.crouch && !moving, aiming, eyeHeight: o.crouch && !moving ? PLAYER.crouchHeight - 0.2 : PLAYER.eyeHeight,
      light: !!o.light,
    });

    const a = p.arsenal;
    if (a.weapon.mag <= 0 && a.action === 'idle') {
      this.sim.reload(this.id);
      this.trigger = false;
      return;
    }
    if (!target) {
      this.trigger = false;
      this.burstLeft = 0;
      // Topped up between fights.
      if (a.action === 'idle' && a.weapon.mag < a.def.magazine * 0.4 && a.weapon.reserve > 0) this.sim.reload(this.id);
      return;
    }
    // Shooting: bursts from an automatic, single shots from the rest, each with a short pause.
    this.pauseT -= dt;
    if (this.pauseT > 0) {
      this.trigger = false;
      return;
    }
    const def = a.def;
    if (this.burstLeft <= 0) {
      this.burstLeft = def.auto ? 3 + Math.floor(this.rand() * 5) : 1;
    }
    const eye = p.eye;
    const chest = target.chest;
    const hit = this.rand() < (o.accuracy ?? 0.75);
    // A hit goes for the body (now and then the head); a miss goes wide of it.
    const aimY = hit ? (this.rand() < 0.3 ? target.eye.y : chest.y) : chest.y + (this.rand() - 0.5) * 1.2;
    const side = hit ? (this.rand() - 0.5) * 0.2 : (this.rand() < 0.5 ? -1 : 1) * (0.5 + this.rand() * 0.6);
    const d = dist2D(eye, chest) || 1;
    const nx = -(chest.z - eye.z) / d, nz = (chest.x - eye.x) / d;
    const dir = { x: chest.x + nx * side - eye.x, y: aimY - eye.y, z: chest.z + nz * side - eye.z };
    const pressed = !this.trigger;
    const r = this.sim.fire(this.id, eye, dir, pressed, (this.rand() * 2 ** 31) | 1);
    this.trigger = true;
    if (r === 'fired') {
      this.burstLeft--;
      if (!def.auto) this.pauseT = 0.25 + this.rand() * 0.35 + (def.pellets > 1 ? 0.3 : 0);
      else if (this.burstLeft <= 0) {
        this.pauseT = 0.25 + this.rand() * 0.5;
        this.trigger = false;
      }
    } else if (r === 'dry') this.trigger = false;
  }

  /** The nearest zombie in range it has a clear line to (the one it shot at last, while it lives). */
  private pick(p: SimPlayer, range: number): Zombie | null {
    const sim = this.sim;
    const eye = p.eye;
    let best: Zombie | null = null;
    let bestD = Infinity;
    const keep = this.targetId >= 0 && sim.time - this.targetT < 1.5 ? sim.zombie(this.targetId) : undefined;
    for (const z of sim.zombies) {
      if (!z.alive) continue;
      const c = z.chest;
      const d = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
      if (d > range) continue;
      const score = z === keep ? d * 0.6 : d;
      if (score >= bestD) continue;
      const hit = sim.physics.raycast(eye.x, eye.y, eye.z, (c.x - eye.x) / d, (c.y - eye.y) / d, (c.z - eye.z) / d, d);
      if (hit !== null && hit < d - 0.5) continue;
      bestD = score;
      best = z;
    }
    if (best && best.id !== this.targetId) {
      this.targetId = best.id;
      this.targetT = sim.time;
    }
    return best;
  }
}

/** A handful of looks and names for a squad, so a trailer or a solo night gets a varied team. */
export const SQUAD_NAMES = ['MAYA', 'DEV', 'RUIZ', 'KOFI', 'LENA', 'JAX'] as const;

/** Weapons a squad carries, primary and secondary, one entry per member. */
export const SQUAD_LOADOUTS: readonly [keyof typeof WEAPONS, keyof typeof WEAPONS][] = [
  ['ar', 'pistol'], ['shotgun', 'pistol'], ['lmg', 'pistol'], ['smg', 'pistol'], ['marksman', 'pistol'], ['ar', 'pistol'],
];

export const clampAccuracy = (a: number): number => clamp(a, 0, 1);
