import { RAPIER, type Physics } from '../physics/Physics';
import type { DoorBody } from '../physics/DoorBody';
import { COMBAT, PRIMARY_WEAPONS, WEAPONS, ZONE_MULTIPLIER, type HitZone, type WeaponDef, type WeaponId } from '../config/weapons';
import { GAME } from '../config/game';
import { PLAYER } from '../config/player';
import { SPAWNING, type ZombieKind } from '../config/zombies';
import { decodeAppearance, encodeAppearance } from '../config/appearance';
import type { MapDefinition } from '../types/world';
import { Arsenal, type ArsenalTick } from './Arsenal';
import { NAV_INDOOR, NAV_REACHABLE, type NavGrid } from './NavGrid';
import { zombieZones, rayZones, type ZoneShape } from './hitzones';
import { Zombie } from './Zombie';
import { clamp, dist2D, rng, v3, type Vec3 } from './math';
import type { PelletTrace, SimEvent, SimPhase } from './events';

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
}

export interface PlayerStats {
  kills: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
  suppliesCollected: number;
  damageTaken: number;
}

export class SimPlayer {
  health: number = PLAYER.maxHealth;
  alive = true;
  readonly arsenal: Arsenal;
  bandages: number = COMBAT.startBandages;
  readonly motion: PlayerMotion;
  readonly stats: PlayerStats = { kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0, suppliesCollected: 0, damageTaken: 0 };
  footstepT = 0;
  diedAt = 0;
  /** Wire form of the survivor's look (encodeAppearance), for the clients that render them. */
  appearance = '';

  constructor(readonly id: string, readonly name: string, primary: WeaponId, secondary: WeaponId, spawn: Vec3, yaw: number) {
    this.arsenal = new Arsenal(primary, secondary);
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
}

export interface Noise {
  pos: Vec3;
  radius: number;
  time: number;
  source: string | null;
}

export type InteractKind = 'weapons' | 'ammo' | 'medical';

export interface Interactable {
  id: number;
  kind: InteractKind;
  pos: Vec3;
  /** Uses left (ammo crates, first aid boxes); weapon tables are unlimited. */
  supply: number;
  range: number;
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
  time = 0;
  phase: SimPhase = 'preparation';
  /** Seconds left in preparation, or survived so far. */
  phaseTime: number;
  private events: SimEvent[] = [];
  private nextZombieId = 1;
  private spawnAt = 0;
  private pathBudget = 0;
  private readonly rand: () => number;
  private readonly outdoorNodes: Int32Array;
  private readonly zones: ZoneShape[] = [];
  private lookCounter = 0;

  constructor(opts: SimOptions) {
    this.physics = opts.physics;
    this.map = opts.map;
    this.nav = opts.nav;
    this.doors = opts.doors;
    this.rand = rng(opts.seed ?? 1);
    this.phaseTime = opts.preparation ?? GAME.preparationSeconds;
    const ctrl = this.physics.world.createCharacterController(0.02);
    ctrl.setUp({ x: 0, y: 1, z: 0 });
    ctrl.enableAutostep(0.4, 0.15, false);
    ctrl.enableSnapToGround(0.35);
    ctrl.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    ctrl.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    ctrl.setSlideEnabled(true);
    this.zombieController = ctrl;

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
    }
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

  addPlayer(id: string, name: string, primary: WeaponId, secondary: WeaponId, spawn: Vec3, yaw: number, appearance = ''): SimPlayer {
    const p = new SimPlayer(id, name, primary, secondary, spawn, yaw);
    p.appearance = encodeAppearance(decodeAppearance(appearance));
    this.players.set(id, p);
    return p;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
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
    p.health = Math.max(0, p.health - damage);
    p.stats.damageTaken += damage;
    if (p.arsenal.cancelBandage()) this.emit({ type: 'bandage', player: p.id, stage: 'cancel' });
    this.emit({ type: 'playerHurt', player: p.id, damage, from: { ...from }, health: p.health });
    if (p.health <= 0) {
      p.alive = false;
      p.diedAt = this.time;
      p.arsenal.cancelReload();
      this.emit({ type: 'playerDied', player: p.id });
      if (![...this.players.values()].some((q) => q.alive)) {
        this.phase = 'over';
        this.emit({ type: 'phase', phase: 'over' });
      }
    }
  }

  // ---------------------------------------------------------------- player intents

  /**
   * Fires the active weapon. `origin`/`dir` are the camera ray the client aimed with; the
   * origin is checked against the shooter's position and every round is traced here.
   */
  fire(id: string, origin: Vec3, dir: Vec3, pressed: boolean, seed: number): 'fired' | 'dry' | 'busy' {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase === 'over') return 'busy';
    const a = p.arsenal;
    const def = a.def;
    if (!def.auto && !pressed) return 'busy';
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
    const world = this.physics.raycastHit(o.x, o.y, o.z, d.x, d.y, d.z, maxD);
    const worldD = world ? world.distance : maxD;
    const hits: { z: Zombie; zone: HitZone; t: number }[] = [];
    for (const z of this.zombies) {
      if (!z.alive) continue;
      // Cheap reject: distance from the zombie's middle to the ray.
      const cx = z.pos.x - o.x, cy = z.pos.y + 0.9 * z.scale - o.y, cz = z.pos.z - o.z;
      const along = cx * d.x + cy * d.y + cz * d.z;
      if (along < -1 || along > worldD + 1) continue;
      const px = cx - d.x * along, py = cy - d.y * along, pz = cz - d.z * along;
      if (px * px + py * py + pz * pz > 2.6) continue;
      const h = rayZones(o, d, zombieZones(z.pos, z.facing, z.scale, z.state === 'down' ? 'down' : 'standing', this.zones), worldD);
      if (h) hits.push({ z, zone: h.zone, t: h.t });
    }
    hits.sort((a, b) => a.t - b.t);

    // The camera sees around corners the gun can't: check the line from the eye too.
    const firstT = hits.length ? hits[0].t : worldD;
    const eye = p.eye;
    const tx = o.x + d.x * firstT - eye.x, ty = o.y + d.y * firstT - eye.y, tz = o.z + d.z * firstT - eye.z;
    const L = Math.hypot(tx, ty, tz);
    if (L > 0.6) {
      const ob = this.physics.raycastHit(eye.x, eye.y, eye.z, tx / L, ty / L, tz / L, L - 0.25);
      if (ob) {
        const pos = { x: eye.x + (tx / L) * ob.distance, y: eye.y + (ty / L) * ob.distance, z: eye.z + (tz / L) * ob.distance };
        this.emit({ type: 'impact', pos, normal: { x: ob.nx, y: ob.ny, z: ob.nz }, surface: ob.surface, dir: { x: tx / L, y: ty / L, z: tz / L } });
        return { end: pos, hit: 'world' };
      }
    }

    let pierced = 0;
    for (const h of hits) {
      const pos = { x: o.x + d.x * h.t, y: o.y + d.y * h.t, z: o.z + d.z * h.t };
      const dmg = def.damage * ZONE_MULTIPLIER[h.zone] * FALLOFF(def, h.t) * Math.pow(0.6, pierced);
      this.hitZombie(p, h.z, dmg, h.zone, pos, d, false, def.pellets > 1 ? 0.5 : 1);
      pierced++;
      if (pierced > def.penetration) return { end: pos, hit: 'zombie' };
    }
    if (world) {
      const pos = { x: o.x + d.x * world.distance, y: o.y + d.y * world.distance, z: o.z + d.z * world.distance };
      this.emit({ type: 'impact', pos, normal: { x: world.nx, y: world.ny, z: world.nz }, surface: world.surface, dir: { ...d } });
      return { end: pos, hit: 'world' };
    }
    return { end: { x: o.x + d.x * maxD, y: o.y + d.y * maxD, z: o.z + d.z * maxD }, hit: 'none' };
  }

  private hitZombie(p: SimPlayer, z: Zombie, damage: number, zone: HitZone, pos: Vec3, dir: Vec3, melee: boolean, force: number): void {
    const before = z.health;
    const killed = z.takeHit(damage, zone, dir, p, melee);
    const dealt = Math.min(before, damage);
    p.stats.damageDealt += dealt;
    // Blood sprays out the far side onto whatever is behind.
    let exit: { pos: Vec3; normal: Vec3 } | null = null;
    const back = this.physics.raycastHit(pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, 2.6);
    if (back) exit = { pos: { x: pos.x + dir.x * back.distance, y: pos.y + dir.y * back.distance, z: pos.z + dir.z * back.distance }, normal: { x: back.nx, y: back.ny, z: back.nz } };
    this.emit({ type: 'zombieHit', zombie: z.id, zone, pos, dir: { ...dir }, damage: dealt, killed, by: p.id, melee, exit });
    if (killed) {
      p.stats.kills++;
      if (zone === 'head') p.stats.headshots++;
      this.emit({ type: 'zombieDied', zombie: z.id, zone, dir: { ...dir }, force: (melee ? 1.2 : 0.6 + Math.min(1.4, damage / 60)) * force, by: p.id });
    }
  }

  reload(id: string): boolean {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    if (!p.arsenal.startReload()) return false;
    this.emit({ type: 'reload', player: id, weapon: p.arsenal.weapon.id, stage: 'start' });
    return true;
  }

  switchWeapon(id: string, slot: 'primary' | 'secondary'): boolean {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    const reloading = p.arsenal.action === 'reload';
    const weaponBefore = p.arsenal.weapon.id;
    if (!p.arsenal.switchTo(slot)) return false;
    if (reloading) this.emit({ type: 'reload', player: id, weapon: weaponBefore, stage: 'cancel' });
    this.emit({ type: 'draw', player: id, slot, weapon: p.arsenal.weapon.id });
    return true;
  }

  melee(id: string): boolean {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    const reloading = p.arsenal.action === 'reload';
    if (!p.arsenal.startMelee()) return false;
    if (reloading) this.emit({ type: 'reload', player: id, weapon: p.arsenal.weapon.id, stage: 'cancel' });
    this.emit({ type: 'melee', player: id, stage: 'swing' });
    return true;
  }

  bandage(id: string): boolean {
    const p = this.players.get(id);
    if (!p || !p.alive || p.bandages <= 0 || p.health >= PLAYER.maxHealth) return false;
    if (!p.arsenal.startBandage()) return false;
    this.emit({ type: 'bandage', player: id, stage: 'start' });
    return true;
  }

  /** Whether an interactable is within a player's reach. */
  inReach(id: string, it: Interactable): boolean {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    const c = p.chest;
    return Math.hypot(it.pos.x - c.x, (it.pos.y - c.y) * 1.5, it.pos.z - c.z) < it.range;
  }

  /** Interactables in reach of a player, nearest first. */
  reachable(id: string): Interactable[] {
    const p = this.players.get(id);
    if (!p || !p.alive) return [];
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
    if (!p || !p.alive || !it || !this.inReach(id, it)) return false;
    if (it.kind === 'ammo') {
      if (it.supply <= 0) return false;
      const a = p.arsenal;
      const got = a.addReserve('primary', WEAPONS[a.primary.id].magazine * COMBAT.crateMagsPrimary)
        + a.addReserve('secondary', WEAPONS[a.secondary.id].magazine * COMBAT.crateMagsSecondary);
      if (got <= 0) {
        this.emit({ type: 'notice', player: id, text: 'AMMUNITION FULL' });
        return false;
      }
      it.supply--;
      p.stats.suppliesCollected++;
      this.emit({ type: 'pickup', player: id, item: 'ammo', amount: got, source: it.id });
      return true;
    }
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
    if (p.arsenal.primary.id === weapon) return false;
    p.arsenal.replacePrimary(weapon);
    this.emit({ type: 'pickup', player: id, item: 'weapon', amount: 1, source: it.id, weapon });
    if (p.arsenal.active === 'primary') this.emit({ type: 'draw', player: id, slot: 'primary', weapon });
    return true;
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

  /** Target population for the basic spawner (the Phase 5 director replaces this). */
  get populationTarget(): number {
    if (this.phase !== 'survival') return 0;
    return Math.min(SPAWNING.maxPopulation, Math.floor(SPAWNING.basePopulation + (SPAWNING.growthPerMinute * this.phaseTime) / 60));
  }

  /** Removes every zombie body and the shared zombie controller from the physics world. */
  dispose(): void {
    for (const z of this.zombies) z.removeBody();
    this.zombies.length = 0;
    this.physics.world.removeCharacterController(this.zombieController);
  }

  skipPreparation(): void {
    if (this.phase === 'preparation') this.phaseTime = 0.01;
  }

  // ---------------------------------------------------------------- step

  step(dt: number): void {
    this.time += dt;
    this.pathBudget = 1;
    if (this.phase === 'preparation') {
      this.phaseTime -= dt;
      if (this.phaseTime <= 0) {
        this.phase = 'survival';
        this.phaseTime = 0;
        this.emit({ type: 'phase', phase: 'survival' });
        this.spawnAt = this.time + 1;
      }
    } else if (this.phase === 'survival') {
      this.phaseTime += dt;
      this.runSpawner();
    }

    for (const d of this.doors) d?.update(dt);

    const ticks: ArsenalTick[] = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      ticks.length = 0;
      p.arsenal.step(dt, p.motion.aiming, ticks);
      for (const t of ticks) this.onArsenal(p, t);
      // Footsteps carry: sprinting is heard much farther than walking; crouching is silent.
      const speed = p.speed;
      p.footstepT -= dt;
      if (p.footstepT <= 0 && speed > 0.8 && p.motion.grounded) {
        const radius = p.motion.crouching ? 1.2 : speed > 4.5 ? 11 : 4.5;
        this.noise(p.motion.pos, radius, p.id);
        p.footstepT = speed > 4.5 ? 0.35 : 0.55;
      }
    }

    // Zombies far from everyone and not hunting update at a third of the rate.
    for (const z of this.zombies) {
      z.pending += dt;
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
    const target = this.populationTarget;
    if (alive >= target) {
      this.spawnAt = this.time + 1;
      return;
    }
    const at = this.findSpawnPoint();
    // The first arrivals come in quickly; afterwards a steady trickle.
    const [lo, hi] = SPAWNING.interval;
    this.spawnAt = this.time + (alive < target * 0.5 ? 0.35 : lo + this.rand() * (hi - lo));
    if (!at) return;
    this.spawnZombie('walker', at, this.rand() < 0.78 ? 'approach' : 'wander');
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
      default:
        break;
    }
  }

  private resolveMelee(p: SimPlayer): void {
    const m = p.motion;
    const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
    const chest = p.chest;
    const targets: { z: Zombie; d: number }[] = [];
    for (const z of this.zombies) {
      if (!z.alive) continue;
      const dx = z.pos.x - m.pos.x, dz = z.pos.z - m.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > WEAPONS.machete.range + z.def.radius || Math.abs(z.pos.y - m.pos.y) > 1.3) continue;
      if (d > 0.3 && Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1)) > COMBAT.meleeArc / 2) continue;
      const zc = z.chest;
      const lx = zc.x - chest.x, ly = zc.y - chest.y, lz = zc.z - chest.z;
      const ll = Math.hypot(lx, ly, lz) || 1;
      const hit = this.physics.raycast(chest.x, chest.y, chest.z, lx / ll, ly / ll, lz / ll, ll);
      if (hit !== null && hit < ll - 0.3) continue;
      targets.push({ z, d });
    }
    targets.sort((a, b) => a.d - b.d);
    this.noise(m.pos, WEAPONS.machete.noise, p.id);
    if (!targets.length) {
      this.emit({ type: 'melee', player: p.id, stage: 'miss' });
      return;
    }
    targets.slice(0, 2).forEach(({ z }, i) => {
      const zc = z.chest;
      const dir = { x: zc.x - chest.x, y: 0, z: zc.z - chest.z };
      const l = Math.hypot(dir.x, dir.z) || 1;
      dir.x /= l;
      dir.z /= l;
      const zone: HitZone = m.pitch > 0.12 ? 'head' : 'torso';
      const dmg = WEAPONS.machete.damage * (zone === 'head' ? 1.4 : 1) * (i === 0 ? 1 : 0.6);
      const at = { x: zc.x - dir.x * 0.2, y: zone === 'head' ? z.pos.y + 1.62 * z.scale : zc.y, z: zc.z - dir.z * 0.2 };
      this.hitZombie(p, z, dmg, zone, at, dir, true, 1);
    });
    this.emit({ type: 'melee', player: p.id, stage: 'hit' });
  }
}
