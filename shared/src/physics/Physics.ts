import RAPIER from '@dimforge/rapier3d-compat';
import { propColliders } from '../map/colliders';
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
} as const;

export function groups(member: number, filter: number): number {
  return (member << 16) | filter;
}

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
const CONCRETE_PROPS = new Set<PropKind>(['jerseyBarrier']);
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

/** Filter for bullets and sight lines: the static world and door leaves, never characters. */
export const WORLD_FILTER = groups(0xffff, GROUP.static | GROUP.dynamic);

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

  constructor(readonly map: MapDefinition) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedDt;
    const staticGroups = groups(GROUP.static, 0xffff);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const add = (desc: RAPIER.ColliderDesc, surface: Surface | 'ground') => {
      const c = this.world.createCollider(desc.setCollisionGroups(staticGroups), body);
      this.surfaces.set(c.handle, surface);
    };

    // Ground slab (open where basements are dug out) and world boundary.
    const half = map.halfExtent;
    const ground = { x0: -half - 40, x1: half + 40, z0: -half - 40, z1: half + 40 };
    for (const r of subtractRects(ground, map.excavations)) {
      add(RAPIER.ColliderDesc.cuboid((r.x1 - r.x0) / 2, 2, (r.z1 - r.z0) / 2).setTranslation((r.x0 + r.x1) / 2, -2, (r.z0 + r.z1) / 2), 'ground');
    }
    for (const [x, z, hx, hz] of [
      [0, -half, half, 0.5], [0, half, half, 0.5], [-half, 0, 0.5, half], [half, 0, 0.5, half],
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
      add(RAPIER.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.d / 2).setTranslation(s.x, s.y, s.z), s.glass ? 'glass' : MATERIAL_SURFACE[s.mat]);
    }

    for (const p of map.props) {
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

  /** The terrain slab: nothing walkable lies under it. */
  isGround(collider: RAPIER.Collider): boolean {
    return this.surfaces.get(collider.handle) === 'ground';
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
  ): number | null {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRay(ray, maxDist, true, undefined, filter);
    return hit ? hit.timeOfImpact : null;
  }

  /** Ray hit with surface normal and material (bullets, impact effects). */
  raycastHit(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    filter = WORLD_FILTER,
  ): RayHit | null {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filter);
    if (!hit) return null;
    const d = hit.timeOfImpact;
    let surface = this.surfaces.get(hit.collider.handle) ?? 'concrete';
    const hx = ox + dx * d, hy = oy + dy * d, hz = oz + dz * d;
    if (surface === 'ground') surface = this.groundSurface(hx, hz);
    else if (hit.normal.y > 0.7) surface = this.cover(hx, hy, hz) ?? surface;
    return { distance: d, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, surface, collider: hit.collider };
  }

  /** Swept sphere cast (camera collision). Returns distance travelled before contact. */
  sphereCast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    radius: number,
    maxDist: number,
  ): number | null {
    const shape = new RAPIER.Ball(radius);
    const hit = this.world.castShape(
      { x: ox, y: oy, z: oz }, { x: 0, y: 0, z: 0, w: 1 }, { x: dx, y: dy, z: dz },
      shape, 0, maxDist, true, undefined, WORLD_FILTER,
    );
    return hit ? hit.time_of_impact : null;
  }

  dispose(): void {
    this.world.free();
  }
}
