import { RAPIER, GROUP, groups, type Physics } from './Physics';
import { STORY } from '../map/builder';
import type { DoorSpec, MapDefinition } from '../types/world';

/** A closed (or closing) leaf blocks everyone. */
const CLOSED_GROUPS = groups(GROUP.dynamic, 0xffff);
/**
 * An open leaf still stops players and bullets, but zombies walk past it: the nav grid can't
 * see door leaves, and a leaf standing out into a room or a porch is exactly what crowds used
 * to snag on.
 */
const OPEN_GROUPS = groups(GROUP.dynamic, 0xffff & ~GROUP.zombie);

/**
 * The physical part of an exterior door: a kinematic leaf that characters collide with,
 * its open/closed state and how hard zombies have pounded on it. The client wraps it with
 * the visible leaf; the server (Phase 4) runs the same object.
 */
export class DoorBody {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  angle = 0;
  private target = 0;
  open = false;
  readonly rollup: boolean;
  readonly baseYaw: number;
  readonly hinge: { x: number; y: number; z: number };
  readonly center: { x: number; y: number; z: number };
  /** Outward normal of the wall the door sits in. */
  readonly normal: { x: number; z: number };
  readonly thickness: number;
  /** Accumulated pounding, 0..1. The door bursts open at 1 (barricades extend this in Phase 6). */
  strain = 0;
  /** Set when the state changes so observers (sound, visuals) can react. */
  changed = false;

  constructor(readonly index: number, readonly spec: DoorSpec, physics: Physics) {
    this.rollup = spec.style === 'rollup';
    const floor = spec.floorY ?? STORY.slab;
    const ax = spec.axis === 'x' ? 1 : 0, az = spec.axis === 'x' ? 0 : 1;
    this.hinge = { x: spec.x - ax * spec.w / 2, y: floor, z: spec.z - az * spec.w / 2 };
    this.baseYaw = spec.axis === 'x' ? 0 : -Math.PI / 2;
    this.center = { x: spec.x, y: floor + 1.1, z: spec.z };
    this.normal = spec.axis === 'x' ? { x: 0, z: spec.outward } : { x: spec.outward, z: 0 };
    this.thickness = this.rollup ? 0.08 : 0.06;
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.hinge.x, this.hinge.y, this.hinge.z).setRotation(this.quat(this.baseYaw)),
    );
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(spec.w / 2 - 0.02, spec.h / 2, this.thickness / 2)
        .setTranslation(spec.w / 2, spec.h / 2, 0)
        .setCollisionGroups(CLOSED_GROUPS),
      this.body,
    );
    physics.setSurface(this.collider, this.rollup ? 'metal' : spec.style === 'glass' ? 'glass' : 'wood');
  }

  private quat(yaw: number) {
    return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  }

  /** Which side of the door a point is on (+1 outside, -1 inside). */
  side(x: number, z: number): number {
    return Math.sign((x - this.center.x) * this.normal.x + (z - this.center.z) * this.normal.z) || 1;
  }

  /** Opens away from whoever opens it so the leaf never swings into them. */
  setOpen(open: boolean, fromX: number, fromZ: number): void {
    if (open === this.open) return;
    this.open = open;
    this.changed = true;
    this.collider.setCollisionGroups(open ? OPEN_GROUPS : CLOSED_GROUPS);
    if (!open) this.strain = Math.max(0, this.strain - 0.35);
    if (this.rollup) {
      this.target = open ? 1 : 0;
      return;
    }
    if (!open) {
      this.target = 0;
      return;
    }
    const side = this.side(fromX, fromZ);
    // Local +Z of the leaf rotated by the base yaw; swing so it points away from the user.
    const tz = { x: Math.sin(this.baseYaw), z: Math.cos(this.baseYaw) };
    const facing = tz.x * this.normal.x + tz.z * this.normal.z;
    const swing = (Math.PI / 2) * 0.95;
    this.target = facing * side > 0 ? swing : -swing;
  }

  toggle(fromX: number, fromZ: number): void {
    this.setOpen(!this.open, fromX, fromZ);
  }

  /** Zombie pounding. Returns true when the door gives way. */
  pound(amount: number, fromX: number, fromZ: number): boolean {
    if (this.open) return false;
    this.strain += amount;
    if (this.strain < 1) return false;
    this.strain = 0;
    this.setOpen(true, fromX, fromZ);
    return true;
  }

  /** True when the leaf is mostly out of the opening. */
  get passable(): boolean {
    return this.rollup ? this.angle > 0.8 : Math.abs(this.angle) > 1.0;
  }

  update(dt: number): boolean {
    const prev = this.angle;
    this.angle += (this.target - this.angle) * (1 - Math.exp(-dt * (this.rollup ? 3.2 : 7)));
    if (Math.abs(this.angle - prev) < 1e-5) return false;
    if (this.rollup) {
      this.body.setNextKinematicTranslation({ x: this.hinge.x, y: this.hinge.y + this.spec.h * this.angle * 0.98, z: this.hinge.z });
    } else {
      this.body.setNextKinematicRotation(this.quat(this.baseYaw + this.angle));
    }
    return true;
  }

  /** Snaps closed with no animation (new session). */
  reset(): void {
    this.open = false;
    this.target = 0;
    this.angle = 0;
    this.strain = 0;
    this.collider.setCollisionGroups(CLOSED_GROUPS);
    this.body.setTranslation({ x: this.hinge.x, y: this.hinge.y, z: this.hinge.z }, true);
    this.body.setRotation(this.quat(this.baseYaw), true);
    this.body.setNextKinematicTranslation({ x: this.hinge.x, y: this.hinge.y, z: this.hinge.z });
    this.body.setNextKinematicRotation(this.quat(this.baseYaw));
  }
}

/** Exterior doors of enterable buildings, in map order (indices match the nav grid's door cells). */
export function createDoorBodies(map: MapDefinition, physics: Physics): (DoorBody | null)[] {
  const enterable = new Set(map.houses.filter((h) => h.enterable).map((h) => h.id));
  return map.doors.map((d, i) => (d.exterior && enterable.has(d.houseId) ? new DoorBody(i, d, physics) : null));
}
