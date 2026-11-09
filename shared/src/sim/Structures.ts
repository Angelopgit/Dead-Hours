import { BREACH, COLLAPSE, STRUCTURE_STATE, VOLATILES } from '../config/destruction';
import { isDrivable } from '../config/vehicles';
import { STORY, ownerAt } from '../map/builder';
import type { RAPIER } from '../physics/Physics';
import type { MapDefinition, PropSpec, StaticBox, StructurePart, StructureSpec } from '../types/world';
import { clamp, type Vec3 } from './math';
import type { SimPlayer, Simulation } from './Simulation';

/** A bay of wall or a pillar: what explosives take out of a structure one piece at a time. */
export interface Part {
  /** Its index in `map.parts`. */
  index: number;
  spec: StructurePart;
  structure: Structure | null;
  colliders: RAPIER.Collider[];
  /** How much blast it has taken, 0..1. It goes at 1. */
  damage: number;
  gone: boolean;
  /** A ground-storey bay zombies can walk through once it is gone (a nav link joins its two sides). */
  walk: boolean;
}

/** Something that can come down: a building, the water tower, the gas station's canopy. */
export interface Structure {
  /** Its index in `map.structures`. */
  index: number;
  spec: StructureSpec;
  parts: Part[];
  /** What holds it up: its ground-storey bays and its pillars, and how many of each are gone. */
  bays: number;
  pillars: number;
  baysGone: number;
  pillarsGone: number;
  /** STRUCTURE_STATE. */
  state: number;
  /** When one that is going lands (simulation time). */
  fallAt: number;
  /** Who brought it down (their kills). */
  by: string | null;
  /** What goes with it besides its parts: its other colliders, the props inside, its doors. */
  colliders: RAPIER.Collider[];
  props: number[];
  doors: number[];
}

/** Whether a solid of a structure is still there after it has fallen (its floor slab, footings, cellar). */
export function standsAfter(s: StaticBox, structure: StructureSpec): boolean {
  return s.part === undefined && s.y + s.h / 2 <= structure.base + 0.05;
}

/**
 * The building a prop goes down with: the one it stands in, above the cellar. Things with fuel in
 * them and cars that drive are their own business (Volatiles, Vehicles).
 */
export function propOwner(map: MapDefinition, p: PropSpec): string | null {
  if (VOLATILES[p.kind] || isDrivable(p)) return null;
  const id = ownerAt(map, p.x, p.z);
  if (!id) return null;
  const s = map.structures.find((x) => x.id === id)!;
  return (p.y ?? 0) >= s.base - 0.5 ? id : null;
}

/** The structure a lamp hangs in or under, above what stays of it: it goes out when that falls. */
export function lightOwner(map: MapDefinition, l: { x: number; y: number; z: number }): string | null {
  for (const s of map.structures) {
    if (Math.abs(l.x - s.x) <= s.w / 2 && Math.abs(l.z - s.z) <= s.d / 2 && l.y > s.base && l.y <= s.top + 0.5) return s.id;
  }
  return null;
}

/** How far a point is from a part's box (0 inside it). */
function distance(p: StructurePart, o: Vec3): number {
  const hx = p.kind === 'pillar' ? p.w / 2 : p.axis === 'x' ? p.w / 2 : STORY.wall / 2;
  const hz = p.kind === 'pillar' ? p.w / 2 : p.axis === 'x' ? STORY.wall / 2 : p.w / 2;
  return Math.hypot(
    Math.max(0, Math.abs(o.x - p.x) - hx),
    Math.max(0, Math.abs(o.y - p.y) - p.h / 2),
    Math.max(0, Math.abs(o.z - p.z) - hz),
  );
}

/**
 * Walls that can be blown open and structures that can be brought down. Explosions wear down the
 * bays of wall and the pillars near them (rounds only mark them); a bay that goes leaves a hole
 * survivors and zombies walk through. A building that has lost about a third of its ground-storey
 * bays, or a structure that has lost half its pillars, groans for a moment and falls: everything
 * above its floor is gone, whoever was inside is crushed. The safehouse is built to hold.
 * Authoritative like the rest of the simulation; clients draw it from 'breach' and 'collapse'
 * events and the snapshot's `bp` and `fs` lists.
 */
export class Structures {
  readonly parts: Part[] = [];
  readonly list: Structure[] = [];
  private readonly byId = new Map<string, Structure>();
  private going = 0;
  /** How many have fallen. */
  private down = 0;
  /** Bumped whenever a part goes or a structure falls: snapshots are packed again then. */
  private version = 0;
  private packed = -1;
  private gone: number[] = [];
  private fallen: number[] = [];

  constructor(private readonly sim: Simulation) {
    const { map, physics, nav } = sim;
    let restored = false;
    const on = (c: RAPIER.Collider) => {
      if (!physics.isOff(c)) return;
      physics.switchOn(c);
      restored = true;
    };
    map.structures.forEach((spec, index) => {
      const s: Structure = {
        index, spec, parts: [], bays: 0, pillars: 0, baysGone: 0, pillarsGone: 0,
        state: STRUCTURE_STATE.standing, fallAt: Infinity, by: null, colliders: [], props: [], doors: [],
      };
      this.list.push(s);
      this.byId.set(spec.id, s);
    });
    map.parts.forEach((spec, index) => {
      const structure = this.byId.get(spec.owner) ?? null;
      const part: Part = { index, spec, structure, colliders: [], damage: 0, gone: false, walk: false };
      this.parts.push(part);
      if (!structure) return;
      structure.parts.push(part);
      if (spec.kind === 'pillar') structure.pillars++;
      else if (spec.storey === 0) structure.bays++;
    });
    map.solids.forEach((solid, i) => {
      const c = physics.solidColliders[i];
      if (!c) return;
      if (solid.part !== undefined) {
        this.parts[solid.part].colliders.push(c);
        // A wall a blast opened on an earlier night stands again. (Smashed panes are the barricades' to put back.)
        on(c);
        return;
      }
      const s = solid.owner ? this.byId.get(solid.owner) : undefined;
      if (!s || standsAfter(solid, s.spec)) return;
      s.colliders.push(c);
      if (!solid.glass) on(c);
    });
    map.props.forEach((p, index) => {
      const s = this.byId.get(propOwner(map, p) ?? '');
      if (!s) return;
      const boxes = physics.propColliders(index);
      if (!boxes.length) return;
      s.props.push(index);
      for (const c of boxes) on(c);
    });
    map.doors.forEach((d, index) => {
      const door = sim.doors[index];
      if (!door) return;
      this.byId.get(d.houseId)?.doors.push(index);
      // One that went down with its building on an earlier night hangs again.
      if (door.gone) door.reset();
    });
    if (restored) physics.sync();

    // A hole in a ground-storey wall is a way in: its two sides are joined for the zombies' paths.
    nav.reopen();
    for (const part of this.parts) {
      const p = part.spec;
      if (!part.structure || p.kind !== 'bay' || p.storey !== 0) continue;
      const nx = p.axis === 'x' ? 0 : p.outward, nz = p.axis === 'x' ? p.outward : 0;
      const side = (sign: number) => {
        const n = nav.nodeAt(p.x + nx * 0.8 * sign, p.floor + 0.2, p.z + nz * 0.8 * sign, 0.6);
        if (n < 0 || !nav.reachable(n) || Math.abs(nav.nodeY[n] - p.floor) > 0.8) return -1;
        const off = (nav.nodeX(n) - p.x) * nx * sign + (nav.nodeZ(n) - p.z) * nz * sign;
        const lateral = Math.abs((nav.nodeX(n) - p.x) * nz) + Math.abs((nav.nodeZ(n) - p.z) * nx);
        return off > 0.3 && off < 1.5 && lateral < p.w / 2 - 0.2 ? n : -1;
      };
      const out = side(1), inn = side(-1);
      if (out < 0 || inn < 0) continue;
      nav.setLink(BREACH.linkBase + part.index, out, inn);
      part.walk = true;
    }
  }

  get(id: string): Structure | undefined {
    return this.byId.get(id);
  }

  /** Whether the hole a nav link stands for is open (see BREACH.linkBase). */
  passable(link: number): boolean {
    const part = this.parts[link - BREACH.linkBase];
    return !!part && part.walk && part.gone;
  }

  /** The structure whose footprint a point is in, if it has fallen. */
  fallenAt(x: number, z: number): Structure | undefined {
    if (!this.down) return undefined;
    for (const s of this.list) {
      if (s.state === STRUCTURE_STATE.fallen && Math.abs(x - s.spec.x) <= s.spec.w / 2 && Math.abs(z - s.spec.z) <= s.spec.d / 2) return s;
    }
    return undefined;
  }

  /** How near it is to coming down, 0..1 and over. */
  strain(s: Structure): number {
    let k = 0;
    if (s.bays) k += s.baysGone / (s.bays * COLLAPSE.walls);
    // What stands on pillars alone goes with half of them; a building's columns only help it on its way.
    if (s.pillars && s.bays) k += (s.pillarsGone / s.pillars) * COLLAPSE.porch;
    else if (s.pillars) k += s.pillarsGone / Math.max(COLLAPSE.leastPillars, s.pillars * COLLAPSE.pillars);
    return k;
  }

  /**
   * A blast at `o`: every bay and pillar near enough takes `strength` at the wall, less with distance
   * (BREACH.core, BREACH.reach, both scaled by the blast's `power`).
   */
  blast(o: Vec3, strength: number, power: number, by: SimPlayer): void {
    if (!(strength > 0)) return;
    const core = BREACH.core * power, reach = BREACH.reach * power;
    for (const part of this.parts) {
      const s = part.structure;
      if (part.gone || !s || s.state === STRUCTURE_STATE.fallen) continue;
      const p = part.spec;
      if (Math.abs(p.x - o.x) > reach + 2 || Math.abs(p.z - o.z) > reach + 2) continue;
      const d = distance(p, o);
      if (d >= reach) continue;
      const k = strength * (p.kind === 'pillar' ? BREACH.pillar : 1) * clamp(1 - (d - core) / (reach - core), 0, 1);
      if (k < 0.04) continue;
      part.damage = Math.min(1, part.damage + k);
      if (part.damage >= 1 - 1e-6) this.open(part, o, by.id);
      else this.sim.emit({ type: 'breach', part: part.index, pos: { ...o }, gone: false, damage: part.damage, by: by.id });
    }
  }

  /** A bay or pillar goes. */
  private open(part: Part, from: Vec3, by: string | null): void {
    const sim = this.sim;
    const s = part.structure!;
    this.take(part);
    sim.noise(part.spec, BREACH.noise, by);
    sim.emit({ type: 'breach', part: part.index, pos: { ...from }, gone: true, damage: 1, by });
    if (s.state !== STRUCTURE_STATE.standing || this.strain(s) < 1) return;
    s.state = STRUCTURE_STATE.going;
    s.fallAt = sim.time + COLLAPSE.warn;
    s.by = by;
    this.going++;
    sim.emit({ type: 'collapse', structure: s.index, stage: s.state, pos: { x: s.spec.x, y: s.spec.base, z: s.spec.z }, by });
  }

  /** Takes a part out of the world (no events). */
  private take(part: Part): void {
    if (part.gone) return;
    part.gone = true;
    part.damage = 1;
    for (const c of part.colliders) this.sim.physics.switchOff(c);
    const s = part.structure;
    if (s) {
      if (part.spec.kind === 'pillar') s.pillarsGone++;
      else if (part.spec.storey === 0) s.baysGone++;
    }
    this.version++;
  }

  step(): void {
    if (!this.going) return;
    const t = this.sim.time;
    for (const s of this.list) if (s.state === STRUCTURE_STATE.going && t >= s.fallAt) this.fall(s);
  }

  /** Whether a point is in or under a structure, above what stays of it. */
  private inside(s: Structure, pos: Vec3): boolean {
    const { x, z, w, d, base, top } = s.spec;
    return Math.abs(pos.x - x) <= w / 2 && Math.abs(pos.z - z) <= d / 2 && pos.y > base - 0.6 && pos.y < top;
  }

  /** It lands. */
  private fall(s: Structure): void {
    const sim = this.sim;
    this.going = Math.max(0, this.going - 1);
    this.level(s);
    const centre = { x: s.spec.x, y: s.spec.base, z: s.spec.z };
    sim.noise(centre, COLLAPSE.noise, s.by);
    sim.emit({ type: 'collapse', structure: s.index, stage: s.state, pos: centre, by: s.by });
    // Whoever was inside or under it. The kills go to whoever brought it down (or anyone still here).
    const by = (s.by ? sim.players.get(s.by) : null) ?? sim.players.values().next().value ?? null;
    for (const p of sim.players.values()) {
      if (p.alive && this.inside(s, p.motion.pos)) sim.damagePlayer(p, COLLAPSE.crush, { x: p.motion.pos.x, y: s.spec.top, z: p.motion.pos.z });
    }
    if (!by) return;
    for (const z of sim.zombies) {
      if (!z.alive || !this.inside(s, z.pos)) continue;
      sim.hitZombie(by, z, z.health + 1000, 'torso', z.chest, { x: 0, y: -1, z: 0 }, false, 1, { armTally: 0, knock: 0, force: 0.4 });
    }
    for (const r of sim.raid.raiders) {
      if (r.alive && this.inside(s, r.pos)) sim.raid.hit(by, r, 1000, 'torso', r.chest, { x: 0, y: -1, z: 0 });
    }
  }

  /** Takes a fallen structure out of the world (no events, nobody hurt: clients' copies use it too). */
  private level(s: Structure): void {
    if (s.state === STRUCTURE_STATE.fallen) return;
    const sim = this.sim;
    const { physics, nav } = sim;
    s.state = STRUCTURE_STATE.fallen;
    this.down++;
    for (const part of s.parts) this.take(part);
    for (const c of s.colliders) physics.switchOff(c);
    for (const i of s.props) for (const c of physics.propColliders(i)) physics.switchOff(c);
    for (const i of s.doors) sim.doors[i]?.takeOut();
    if (s.spec.kind === 'building') sim.barricades.ruin(s.spec.id);
    // Nothing walks its stairs or its upper floor again.
    const { x, z, w, d, base } = s.spec;
    const shut: number[] = [];
    for (let n = 0; n < nav.nodeCount; n++) {
      if (nav.nodeY[n] < base + 0.3) continue;
      if (Math.abs(nav.nodeX(n) - x) <= w / 2 && Math.abs(nav.nodeZ(n) - z) <= d / 2) shut.push(n);
    }
    nav.shut(shut);
    this.version++;
  }

  /** A client's copy: the parts that are gone and the structures that have fallen, as the server lists them. */
  remote(gone: readonly number[], fallen: readonly number[]): void {
    for (const i of fallen) {
      const s = this.list[i];
      if (s) this.level(s);
    }
    for (const i of gone) {
      const part = this.parts[i];
      if (part) this.take(part);
    }
  }

  private pack(): void {
    if (this.packed === this.version) return;
    this.packed = this.version;
    this.fallen = this.list.filter((s) => s.state === STRUCTURE_STATE.fallen).map((s) => s.index);
    this.gone = this.parts.filter((p) => p.gone && p.structure?.state !== STRUCTURE_STATE.fallen).map((p) => p.index);
  }

  /** Snapshot lists: parts gone from structures still standing, and structures fallen. */
  packGone(): readonly number[] {
    this.pack();
    return this.gone;
  }

  packFallen(): readonly number[] {
    this.pack();
    return this.fallen;
  }
}
