import RAPIER from '@dimforge/rapier3d-compat';
import { propColliders, type MapDefinition } from '@dead-hours/shared';

export { RAPIER };

/** Collision groups: membership in the high 16 bits, filter in the low 16 bits. */
export const GROUP = {
  static: 0x0001,
  player: 0x0002,
  dynamic: 0x0004,
} as const;

export function groups(member: number, filter: number): number {
  return (member << 16) | filter;
}

let initialized: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  initialized ??= RAPIER.init();
  return initialized;
}

/** Rapier world built from the shared map definition (same source the server uses). */
export class Physics {
  readonly world: RAPIER.World;
  readonly fixedDt = 1 / 60;

  constructor(map: MapDefinition) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedDt;
    const staticGroups = groups(GROUP.static, 0xffff);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    // Ground plane and world boundary.
    const half = map.halfExtent;
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half + 40, 0.5, half + 40).setTranslation(0, -0.5, 0).setCollisionGroups(staticGroups),
      body,
    );
    for (const [x, z, hx, hz] of [
      [0, -half, half, 0.5], [0, half, half, 0.5], [-half, 0, 0.5, half], [half, 0, 0.5, half],
    ] as const) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, 10, hz).setTranslation(x, 10, z).setCollisionGroups(staticGroups),
        body,
      );
    }

    for (const s of map.solids) {
      if (s.collide === false) continue;
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.d / 2).setTranslation(s.x, s.y, s.z).setCollisionGroups(staticGroups),
        body,
      );
    }

    for (const p of map.props) {
      for (const b of propColliders(p)) {
        const q = { x: 0, y: Math.sin(b.rotY / 2), z: 0, w: Math.cos(b.rotY / 2) };
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z).setRotation(q).setCollisionGroups(staticGroups),
          body,
        );
      }
    }
  }

  step(): void {
    this.world.step();
  }

  /** First hit distance along a ray, ignoring the player. */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    filter = groups(0xffff, GROUP.static | GROUP.dynamic),
  ): number | null {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRay(ray, maxDist, true, undefined, filter);
    return hit ? hit.timeOfImpact : null;
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
      shape, 0, maxDist, true, undefined, groups(0xffff, GROUP.static | GROUP.dynamic),
    );
    return hit ? hit.time_of_impact : null;
  }

  dispose(): void {
    this.world.free();
  }
}
