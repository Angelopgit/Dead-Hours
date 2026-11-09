import { VOLATILE, VOLATILES, VOLATILE_STAGE, type VolatileDef } from '../config/destruction';
import { BLAST } from '../config/throwables';
import type { RAPIER } from '../physics/Physics';
import type { PropKind } from '../types/world';
import type { Vec3 } from './math';
import type { SimPlayer, Simulation } from './Simulation';
import type { Vehicle } from './Vehicles';

/** One prop with fuel in it (see config/destruction.ts). */
export interface Volatile {
  /** Its place in the list: the same on every copy of the night, as the map lists its props. */
  id: number;
  /** Its index in `map.props`. */
  prop: number;
  kind: PropKind;
  def: VolatileDef;
  /** The vehicle it is, when it can be driven (it blows up where it has been driven to). */
  vehicle: Vehicle | null;
  /** Where it stands when it isn't one, and which way it faces. */
  home: Vec3;
  yaw: number;
  health: number;
  /** VOLATILE_STAGE. */
  stage: number;
  /** When a burning one goes up (simulation time). */
  blowAt: number;
  /** Who set it off (their kills). */
  by: string | null;
  /** Its colliders, by handle: its own blast looks out through them. */
  handles: Set<number>;
  colliders: RAPIER.Collider[];
}

/**
 * Things that blow up when they are shot: cars (parked or driven), the armored truck, gas pumps,
 * oil drums. Rounds and blasts wear one down; with about half left it smokes; at nothing it
 * catches fire, burns a few seconds (less the more it is shot) and explodes: a blast bigger than
 * a grenade's, burning fuel on the ground, and whatever else stood near enough set alight in turn.
 * Authoritative like the rest of the simulation; clients draw it from 'volatile' events and the
 * snapshot's `vo` rows.
 */
export class Volatiles {
  readonly list: Volatile[] = [];
  private readonly byCollider = new Map<number, Volatile>();
  private burning = 0;

  constructor(private readonly sim: Simulation) {
    const physics = sim.physics;
    let restored = false;
    sim.map.props.forEach((p, index) => {
      const def = VOLATILES[p.kind];
      if (!def) return;
      const vehicle = sim.vehicles.list.find((v) => v.prop === p) ?? null;
      const colliders = vehicle ? [vehicle.hull] : [...physics.propColliders(index)];
      if (!colliders.length) return;
      // A drum that blew up on an earlier night stands there again.
      for (const c of colliders) {
        if (!physics.isOff(c)) continue;
        physics.switchOn(c);
        restored = true;
      }
      const v: Volatile = {
        id: this.list.length, prop: index, kind: p.kind, def, vehicle, home: { x: p.x, y: p.y ?? 0, z: p.z }, yaw: p.rotY,
        health: def.health, stage: VOLATILE_STAGE.fine, blowAt: Infinity, by: null,
        handles: new Set(colliders.map((c) => c.handle)), colliders,
      };
      if (vehicle) v.handles.add(vehicle.cabin.handle);
      this.list.push(v);
      for (const c of colliders) this.byCollider.set(c.handle, v);
    });
    if (restored) physics.sync();
  }

  /** Where it is now (the ground under its middle). */
  pos(v: Volatile): Vec3 {
    return v.vehicle ? v.vehicle.pos : v.home;
  }

  /** The middle of its body: where its blast comes from. */
  centre(v: Volatile): Vec3 {
    const p = this.pos(v);
    return { x: p.x, y: p.y + v.def.centre, z: p.z };
  }

  /** The volatile prop a collider belongs to, if any. */
  of(collider: RAPIER.Collider): Volatile | undefined {
    return this.byCollider.get(collider.handle);
  }

  /** The one a vehicle is. */
  ofVehicle(vehicle: Vehicle): Volatile | undefined {
    return this.list.find((v) => v.vehicle === vehicle);
  }

  /** A round struck `collider` with `damage` left in it. True when that was something with fuel in it. */
  shot(collider: RAPIER.Collider, damage: number, by: SimPlayer): boolean {
    const v = this.byCollider.get(collider.handle);
    if (!v) return false;
    this.hurt(v, damage * v.def.armor, by.id, false);
    return true;
  }

  /**
   * A blast at `o` reaching `radius`: everything with fuel in it takes the blast's damage at its
   * distance (`force`, 0..1). `source` is the one whose blast this is.
   */
  blast(o: Vec3, radius: number, force: (d: number) => number, scale: number, by: SimPlayer, source: Volatile | null): void {
    for (const v of this.list) {
      if (v === source || v.stage === VOLATILE_STAGE.blown) continue;
      const p = this.pos(v);
      if (Math.abs(p.x - o.x) > radius + 4 || Math.abs(p.z - o.z) > radius + 4) continue;
      // Distance to its bodywork, not its middle.
      const yaw = v.vehicle ? v.vehicle.yaw : v.yaw;
      const dx = o.x - p.x, dz = o.z - p.z;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const top = p.y + v.def.centre * 2;
      const d = Math.hypot(Math.max(0, Math.abs(lx) - v.def.hx), Math.max(0, Math.abs(lz) - v.def.hz), Math.max(0, p.y - o.y, o.y - top));
      if (d > radius) continue;
      const k = force(d);
      if (k <= 0.02) continue;
      this.hurt(v, BLAST.damage * scale * k * VOLATILE.blast, by.id, true);
    }
  }

  private hurt(v: Volatile, damage: number, by: string, blast: boolean): void {
    if (v.stage === VOLATILE_STAGE.blown || !(damage > 0)) return;
    const sim = this.sim;
    v.by = by;
    if (v.stage === VOLATILE_STAGE.burning) {
      // Already alight: more only brings it on sooner.
      v.blowAt = blast ? Math.min(v.blowAt, sim.time + VOLATILE.chain[0]) : v.blowAt - VOLATILE.hurry;
      return;
    }
    v.health = Math.max(0, v.health - damage);
    if (v.health <= 0) {
      const [a, b] = blast ? VOLATILE.chain : v.def.fuse;
      v.stage = VOLATILE_STAGE.burning;
      v.blowAt = sim.time + a + sim.random() * (b - a);
      this.burning++;
      sim.noise(this.pos(v), VOLATILE.noise, by);
      sim.emit({ type: 'volatile', id: v.id, stage: v.stage, pos: { ...this.centre(v) }, by });
    } else if (v.stage === VOLATILE_STAGE.fine && v.health <= v.def.health * VOLATILE.smoke) {
      v.stage = VOLATILE_STAGE.smoking;
      sim.emit({ type: 'volatile', id: v.id, stage: v.stage, pos: { ...this.centre(v) }, by });
    }
  }

  step(): void {
    if (!this.burning) return;
    const t = this.sim.time;
    for (const v of this.list) if (v.stage === VOLATILE_STAGE.burning && t >= v.blowAt) this.blow(v);
  }

  /** It goes up. */
  private blow(v: Volatile): void {
    const sim = this.sim;
    v.stage = VOLATILE_STAGE.blown;
    v.health = 0;
    this.burning = Math.max(0, this.burning - 1);
    const at = this.centre(v);
    const ground = { ...this.pos(v) };
    sim.emit({ type: 'volatile', id: v.id, stage: v.stage, pos: { ...at }, by: v.by });
    // Whoever sat in it is hurt and thrown out; it never runs again.
    const car = v.vehicle;
    const thrown = new Set<string>();
    if (car) {
      for (const id of [...car.seats]) {
        const p = id ? sim.players.get(id) : null;
        if (!p) continue;
        thrown.add(p.id);
        if (p.up) sim.damagePlayer(p, VOLATILE.occupant, at);
        sim.vehicles.eject(p);
      }
      sim.vehicles.wreck(car);
    }
    // A drum is gone; a car's shell stays where it burned.
    if (!v.def.shell) for (const c of v.colliders) sim.physics.switchOff(c);
    // The kills go to whoever set it off (or, if they have left, to anyone still here).
    const by = (v.by ? sim.players.get(v.by) : null) ?? sim.players.values().next().value ?? null;
    if (!by) return;
    sim.explosives.explode({ x: at.x, y: at.y - 0.18, z: at.z }, by, 0, { kind: 'fuel', power: v.def.power, skip: v.handles, source: v, spare: thrown });
    sim.explosives.spill(ground, by, { patches: v.def.fire, spread: v.def.spread, duration: VOLATILE.burn, skip: v.handles });
  }

  /** A client's copy: how far along the server says it is. */
  remote(id: number, stage: number, health: number): void {
    const v = this.list[id];
    if (!v) return;
    v.health = health;
    if (stage === v.stage) return;
    v.stage = stage;
    if (stage !== VOLATILE_STAGE.blown) return;
    if (v.vehicle) this.sim.vehicles.wreck(v.vehicle);
    if (!v.def.shell) for (const c of v.colliders) this.sim.physics.switchOff(c);
  }

  /** Snapshot rows: [id, stage, health] for each that isn't as the map left it. */
  pack(): number[] {
    const out: number[] = [];
    for (const v of this.list) if (v.stage !== VOLATILE_STAGE.fine || v.health < v.def.health) out.push(v.id, v.stage, Math.round(v.health));
    return out;
  }
}
