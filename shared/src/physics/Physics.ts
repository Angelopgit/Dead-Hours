import RAPIER from '@dimforge/rapier3d-compat';
import { propColliders } from '../map/colliders';
import { isDrivable } from '../config/vehicles';
import { subtractRects } from '../map/builder';
import type { MapDefinition, MaterialKey, PropKind } from '../types/world';

export { RAPIER };

/** Collision groups: membership in the high 16 bits, filter in the low 16 bits. */
export const GROUP = {
  static: 0x0001,
  player: 0x0002,
  /** Door leaves and other moving world pieces. */
  dynamic: 0x0004,
  zombie: 0x0008,
  /** Loose body parts: they land on the world and doors, but bullets, sight lines and characters ignore them. */
  debris: 0x0010,
  /** A drivable vehicle's lower body (doors, hood, trunk): stops bullets, sight lines and bodies. */
  vehicle: 0x0020,
  /** The cabin over it (glass and roof): only bodies bump into it; rounds and sight go through. */
  cabin: 0x0040,
} as const;

export function groups(member: number, filter: number): number {
  return (member << 16) | filter;
}

/** The map's own colliders: static, and everything may touch them. */
const STATIC_GROUPS = groups(GROUP.static, 0xffff);

/** What a bullet hit, for impact effects and sounds. */
export type Surface = 'concrete' | 'asphalt' | 'brick' | 'plaster' | 'wood' | 'metal' | 'glass' | 'grass' | 'dirt' | 'fabric' | 'flesh';

const MATERIAL_SURFACE: Record<MaterialKey, Surface> = {
  asphalt: 'asphalt', sidewalk: 'concrete', curb: 'concrete', concrete: 'concrete', grass: 'grass', dirt: 'dirt', gravel: 'dirt',
  sidingBlue: 'wood', sidingGreen: 'wood', sidingGray: 'wood', sidingBeige: 'wood', brick: 'brick', stucco: 'plaster',
  interiorWall: 'plaster', interiorWallBlue: 'plaster', woodFloor: 'wood', carpet: 'fabric', tile: 'concrete', trim: 'wood',
  fenceWood: 'wood', darkWood: 'wood', metal: 'metal', roofFlat: 'concrete', invisible: 'concrete',
};

const METAL_PROPS = new Set<PropKind>([
  'car', 'policeCar', 'wreckedCar', 'armoredTruck', 'streetlight', 'parkLamp', 'floodlight', 'mailbox', 'hydrant', 'streetSign',
  'stopSign', 'pump', 'signPylon', 'dumpster', 'oilDrum', 'swingSet', 'slide', 'merryGoRound', 'metalShelf', 'fridge', 'stove',
  'washer', 'waterHeater', 'ironFence', 'bbq', 'trampoline', 'cooler', 'storeShelf', 'patioTable', 'floorLamp',
]);
const SOFT_PROPS = new Set<PropKind>(['sofa', 'armchair', 'bed', 'mattress', 'tent', 'cone', 'trashBin', 'iceChest', 'tireStack', 'trashBag']);
const CONCRETE_PROPS = new Set<PropKind>(['jerseyBarrier', 'toilet', 'bathtub', 'vanity']);
const DIRT_PROPS = new Set<PropKind>(['sandbags']);

function propSurface(kind: PropKind): Surface {
  if (METAL_PROPS.has(kind)) return 'metal';
  if (SOFT_PROPS.has(kind)) return 'fabric';
  if (CONCRETE_PROPS.has(kind)) return 'concrete';
  if (DIRT_PROPS.has(kind)) return 'dirt';
  return 'wood';
}

let initialized: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  initialized ??= RAPIER.init();
  return initialized;
}

export interface RayHit {
  distance: number;
  nx: number;
  ny: number;
  nz: number;
  surface: Surface;
  collider: RAPIER.Collider;
}

/** Filter for bullets and sight lines: the static world, door leaves and vehicle bodies, never characters. */
export const WORLD_FILTER = groups(0xffff, GROUP.static | GROUP.dynamic | GROUP.vehicle);

let warnedRay = false;
/** A ray with a NaN in it stops Rapier dead (a WASM panic); it hits nothing instead, and is reported once, with where it came from. */
function finiteRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): boolean {
  if (Number.isFinite(ox + oy + oz + dx + dy + dz) && maxDist === maxDist) return true;
  if (!warnedRay) {
    warnedRay = true;
    console.warn(`NaN ray (${ox}, ${oy}, ${oz}) -> (${dx}, ${dy}, ${dz}) x ${maxDist}`, new Error().stack);
  }
  return false;
}

let warnedBody = 0;
/**
 * A NaN or infinite position or rotation must never reach a body either: the broad phase takes
 * it and the next ray cast through it panics the whole engine. The write is dropped and reported
 * (the first few, with where they came from), so one bad number costs a step of movement, not the night.
 */
function guardBodies(): void {
  type Vec = { x: number; y: number; z: number; w?: number };
  const proto = RAPIER.RigidBody.prototype as unknown as Record<string, (v: Vec, ...rest: unknown[]) => unknown>;
  if (proto.__finiteGuard) return;
  proto.__finiteGuard = () => true;
  for (const name of ['setTranslation', 'setNextKinematicTranslation', 'setRotation', 'setNextKinematicRotation']) {
    const orig = proto[name];
    proto[name] = function (this: unknown, v: Vec, ...rest: unknown[]) {
      if (Number.isFinite(v.x + v.y + v.z + (v.w ?? 0))) return orig.call(this, v, ...rest);
      if (warnedBody++ < 4) console.warn(`non-finite ${name} (${v.x}, ${v.y}, ${v.z}${v.w === undefined ? '' : `, ${v.w}`}) dropped`, new Error().stack);
      return undefined;
    };
  }
}

/** What survivors and zombies walk into: the world, doors, each other, and vehicles (bodywork and cabin). */
export const BODY_FILTER = GROUP.static | GROUP.dynamic | GROUP.vehicle | GROUP.cabin;

/**
 * Whether the character controller's last move touched something upright below `top` (world
 * height): a door threshold, a stair or a curb it may have to step or ride up onto. Contact points
 * come back in world space.
 */
export function touchedLedge(ctrl: RAPIER.KinematicCharacterController, top: number, hit?: RAPIER.CharacterCollision): boolean {
  const n = ctrl.numComputedCollisions();
  for (let i = 0; i < n; i++) {
    const c = ctrl.computedCollision(i, hit);
    if (c && Math.abs(c.normal1.y) < 0.7 && c.witness2.y < top) return true;
  }
  return false;
}

/** Whether the controller's last move got less than half as far sideways as `move` asked. */
export function stalled(ctrl: RAPIER.KinematicCharacterController, move: { x: number; z: number }): boolean {
  const ask = Math.hypot(move.x, move.z);
  if (ask < 1e-5) return false;
  const m = ctrl.computedMovement();
  return Math.hypot(m.x, m.z) < ask * 0.5;
}

/**
 * The same move with a hair of upward intent, for a body walking into a low edge. Rapier up to 0.19
 * let a sideways push ride a capsule up the rounded contact with an edge (a doorstep met at an angle,
 * or by a brute with no headroom left to autostep under a door header); from 0.20 only a move that
 * points upward may climb what is too steep to walk, so without this they stall on the edge. Kept
 * to moves that touched a ledge: on open ground an upward move would turn off snap-to-ground.
 */
export function climbing(move: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return move.y < 0 ? move : { x: move.x, y: Math.max(move.y, 1e-4), z: move.z };
}

/**
 * Rapier world built from the shared map definition. The client and the server construct the
 * same one, so movement, sight lines and bullets agree everywhere.
 */
export class Physics {
  readonly world: RAPIER.World;
  readonly fixedDt = 1 / 60;
  private readonly surfaces = new Map<number, Surface | 'ground'>();
  /** Visual-only ground covers (roads, gravel, patios) that decide what the terrain is made of. */
  private readonly covers: { x0: number; x1: number; z0: number; z1: number; top: number; surface: Surface }[] = [];
  /** Window glass colliders of enterable buildings (smashed panes are switched off). */
  private readonly panes: { x: number; y: number; z: number; collider: RAPIER.Collider }[] = [];

  constructor(readonly map: MapDefinition) {
    guardBodies();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedDt;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const add = (desc: RAPIER.ColliderDesc, surface: Surface | 'ground') => {
      const c = this.world.createCollider(desc.setCollisionGroups(STATIC_GROUPS), body);
      this.surfaces.set(c.handle, surface);
      return c;
    };

    // Ground slab (open where basements are dug out) and world boundary.
    const { x0, x1, z0, z1 } = map.bounds;
    const ground = { x0: x0 - 40, x1: x1 + 40, z0: z0 - 40, z1: z1 + 40 };
    for (const r of subtractRects(ground, map.excavations)) {
      add(RAPIER.ColliderDesc.cuboid((r.x1 - r.x0) / 2, 2, (r.z1 - r.z0) / 2).setTranslation((r.x0 + r.x1) / 2, -2, (r.z0 + r.z1) / 2), 'ground');
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hw = (x1 - x0) / 2, hd = (z1 - z0) / 2;
    for (const [x, z, hx, hz] of [
      [cx, z0, hw, 0.5], [cx, z1, hw, 0.5], [x0, cz, 0.5, hd], [x1, cz, 0.5, hd],
    ] as const) {
      add(RAPIER.ColliderDesc.cuboid(hx, 10, hz).setTranslation(x, 10, z), 'concrete');
    }

    for (const s of map.solids) {
      if (s.collide === false) {
        if (s.visible !== false && s.h < 0.1) {
          this.covers.push({ x0: s.x - s.w / 2, x1: s.x + s.w / 2, z0: s.z - s.d / 2, z1: s.z + s.d / 2, top: s.y + s.h / 2, surface: MATERIAL_SURFACE[s.mat] });
        }
        continue;
      }
      const c = add(RAPIER.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.d / 2).setTranslation(s.x, s.y, s.z), s.glass ? 'glass' : MATERIAL_SURFACE[s.mat]);
      if (s.glass) this.panes.push({ x: s.x, y: s.y, z: s.z, collider: c });
    }

    for (const p of map.props) {
      // Vehicles that can be driven get moving bodies of their own (sim/Vehicles).
      if (isDrivable(p)) continue;
      for (const b of propColliders(p)) {
        const q = { x: 0, y: Math.sin(b.rotY / 2), z: 0, w: Math.cos(b.rotY / 2) };
        add(RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z).setRotation(q), propSurface(p.kind));
      }
    }
    // Builds the query structures so ray casts work before the first simulation step.
    this.world.step();
  }

  step(): void {
    this.world.step();
  }

  /**
   * Brings the world `dt` seconds on in one step: kinematic bodies (zombies, survivors, doors, crates)
   * land where they were sent and a loose arm falls `dt`. The server calls it once per snapshot.
   * Since Rapier 0.20 the broad phase (which is also the query tree) leaves resting colliders alone,
   * so a step on this mostly static map costs ~0.01 ms; 0.14 rebuilt the whole tree, ~1.4 ms.
   * (0.21 adds ~0.7 ms back: its World.step re-wraps every collider in JS. Bench before bumping:
   * `npm run bench:physics -w server`.)
   */
  advance(dt: number): void {
    const w = this.world;
    w.timestep = dt;
    w.step();
    w.timestep = this.fixedDt;
  }

  /**
   * Makes colliders created or switched back on since the last step show up in ray and shape casts.
   * Only a step updates the query tree, so this is one step of the world: for setting a night up
   * (cars parked, panes put back), not for the middle of one. Mid-step, use `switchOff`.
   */
  sync(): void {
    this.world.step();
  }

  /**
   * Takes a world collider (a window pane) out at once: casts made before the next step already go
   * through it. A disabled collider stays in the query tree until the next step, but every cast here
   * filters by collision groups, and the groups are read as the cast runs.
   */
  switchOff(collider: RAPIER.Collider): void {
    collider.setCollisionGroups(0);
    collider.setEnabled(false);
  }

  /** Puts a collider `switchOff` took out back (in casts after the next step or `sync`). */
  switchOn(collider: RAPIER.Collider): void {
    collider.setCollisionGroups(STATIC_GROUPS);
    collider.setEnabled(true);
  }

  /** The terrain slab: nothing walkable lies under it. */
  isGround(collider: RAPIER.Collider): boolean {
    return this.surfaces.get(collider.handle) === 'ground';
  }

  /** The glass collider filling the window centred at a point, if any. */
  paneAt(x: number, y: number, z: number): RAPIER.Collider | null {
    for (const p of this.panes) if (Math.abs(p.x - x) < 0.05 && Math.abs(p.y - y) < 0.05 && Math.abs(p.z - z) < 0.05) return p.collider;
    return null;
  }

  /** Registers what a collider created elsewhere (door leaves) is made of. */
  setSurface(collider: RAPIER.Collider, surface: Surface): void {
    this.surfaces.set(collider.handle, surface);
  }

  /** Finish laid over a floor at a point (road over terrain, floorboards over a slab), if any. */
  private cover(x: number, y: number, z: number): Surface | null {
    for (let i = this.covers.length - 1; i >= 0; i--) {
      const c = this.covers[i];
      if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1 && Math.abs(c.top - y) < 0.08) return c.surface;
    }
    return null;
  }

  /** Material at a world point on the terrain. */
  groundSurface(x: number, z: number): Surface {
    return this.cover(x, 0, z) ?? 'grass';
  }

  /** First hit distance along a ray, ignoring characters. */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    filter = WORLD_FILTER,
    exclude?: RAPIER.RigidBody | null,
  ): number | null {
    if (!finiteRay(ox, oy, oz, dx, dy, dz, maxDist)) return null;
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRay(ray, maxDist, true, undefined, filter, undefined, exclude ?? undefined);
    return hit ? hit.timeOfImpact : null;
  }

  /** Ray hit with surface normal and material (bullets, impact effects). */
  raycastHit(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    filter = WORLD_FILTER,
    exclude?: RAPIER.RigidBody | null,
  ): RayHit | null {
    if (!finiteRay(ox, oy, oz, dx, dy, dz, maxDist)) return null;
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filter, undefined, exclude ?? undefined);
    if (!hit) return null;
    const d = hit.timeOfImpact;
    let surface = this.surfaces.get(hit.collider.handle) ?? 'concrete';
    const hx = ox + dx * d, hy = oy + dy * d, hz = oz + dz * d;
    if (surface === 'ground') surface = this.groundSurface(hx, hz);
    else if (hit.normal.y > 0.7) surface = this.cover(hx, hy, hz) ?? surface;
    return { distance: d, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, surface, collider: hit.collider };
  }

  /**
   * Materials of everything a straight line crosses between two points, each piece once and at most
   * eight (sound through walls).
   */
  crossings(ax: number, ay: number, az: number, bx: number, by: number, bz: number, filter = WORLD_FILTER): Surface[] {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const out: Surface[] = [];
    if (len < 1e-3) return out;
    const ray = new RAPIER.Ray({ x: ax, y: ay, z: az }, { x: dx / len, y: dy / len, z: dz / len });
    this.world.intersectionsWithRay(ray, len, true, (hit) => {
      const s = this.surfaces.get(hit.collider.handle) ?? 'concrete';
      out.push(s === 'ground' ? 'dirt' : s);
      return out.length < 8;
    }, undefined, filter);
    return out;
  }

  /**
   * Whether an upright capsule `height` tall standing at a point (feet) is clear of the world
   * (walls, props, door leaves; never characters). `exclude` is left out of the test.
   */
  capsuleFree(x: number, feetY: number, z: number, height: number, radius: number, exclude?: RAPIER.Collider | null): boolean {
    const half = Math.max(0.01, (height - radius * 2) / 2);
    let free = true;
    this.world.intersectionsWithShape(
      { x, y: feetY + height / 2, z }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Capsule(half, radius),
      () => { free = false; return false; },
      undefined, WORLD_FILTER, exclude ?? undefined,
    );
    return free;
  }

  /** Distance along a ray to the world, leaving `exclude` out (a pane about to be smashed). */
  raycastExcept(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, exclude: RAPIER.Collider | null): number | null {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRay(ray, maxDist, true, undefined, WORLD_FILTER, exclude ?? undefined);
    return hit ? hit.timeOfImpact : null;
  }

  /** Swept sphere cast (camera collision). Returns distance travelled before contact. `exclude`: a body to see through (the car you sit in). */
  sphereCast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    radius: number,
    maxDist: number,
    exclude?: RAPIER.RigidBody | null,
  ): number | null {
    const shape = new RAPIER.Ball(radius);
    const hit = this.world.castShape(
      { x: ox, y: oy, z: oz }, { x: 0, y: 0, z: 0, w: 1 }, { x: dx, y: dy, z: dz },
      shape, 0, maxDist, true, undefined, WORLD_FILTER, undefined, exclude ?? undefined,
    );
    return hit ? hit.time_of_impact : null;
  }

  dispose(): void {
    this.world.free();
  }
}
