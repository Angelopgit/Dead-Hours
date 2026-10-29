import * as THREE from 'three';
import { STORY, type DoorSpec, type MapDefinition } from '@dead-hours/shared';
import { RAPIER, GROUP, groups, type Physics } from '../core/Physics';
import type { MaterialLibrary } from '../rendering/Materials';

/**
 * Hinged exterior doors of enterable houses. Each door is a kinematic Rapier body so the
 * character controller (and later zombies) collide with it while it swings.
 * Barricading/reinforcement attaches to these in Phase 6.
 */
export class Door {
  readonly pivot = new THREE.Group();
  private readonly body: RAPIER.RigidBody;
  private angle = 0;
  private target = 0;
  open = false;
  readonly center: THREE.Vector3;
  private readonly baseYaw: number;
  private readonly hingeSign: number;

  constructor(readonly spec: DoorSpec, physics: Physics, lib: MaterialLibrary, parent: THREE.Object3D) {
    const thickness = 0.06;
    const along = spec.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    this.hingeSign = -1;
    const hinge = new THREE.Vector3(spec.x, STORY.slab, spec.z).addScaledVector(along, this.hingeSign * spec.w / 2);
    // Leaf extends from the hinge along +along. Yaw so that local +X maps onto `along`.
    this.baseYaw = spec.axis === 'x' ? 0 : -Math.PI / 2;
    this.pivot.position.copy(hinge);
    this.pivot.rotation.y = this.baseYaw;
    const leafMat = lib.standard(0x3a2a1e, 0.7);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(spec.w - 0.04, spec.h - 0.02, thickness), leafMat);
    leaf.position.set(spec.w / 2, spec.h / 2, 0);
    leaf.castShadow = leaf.receiveShadow = true;
    this.pivot.add(leaf);
    // Panels and knob.
    const panel = lib.standard(0x30231a, 0.75);
    for (const py of [0.55, 1.55]) {
      for (const side of [-1, 1]) {
        const pm = new THREE.Mesh(new THREE.BoxGeometry(spec.w * 0.7, 0.7, 0.02), panel);
        pm.position.set(spec.w / 2, py, side * (thickness / 2 + 0.005));
        this.pivot.add(pm);
      }
    }
    const knobMat = lib.standard(0x8d7a4a, 0.3, 0.9);
    for (const side of [-1, 1]) {
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), knobMat);
      knob.position.set(spec.w - 0.12, 1.0, side * 0.06);
      this.pivot.add(knob);
    }
    parent.add(this.pivot);

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(hinge.x, hinge.y, hinge.z).setRotation(this.quat(this.baseYaw)),
    );
    physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(spec.w / 2 - 0.02, spec.h / 2, thickness / 2)
        .setTranslation(spec.w / 2, spec.h / 2, 0)
        .setCollisionGroups(groups(GROUP.dynamic, 0xffff)),
      this.body,
    );
    this.center = new THREE.Vector3(spec.x, STORY.slab + 1.1, spec.z);
  }

  private quat(yaw: number) {
    return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  }

  /** Opens away from the user so the door never swings into the player. */
  toggle(from: THREE.Vector3): void {
    this.open = !this.open;
    if (!this.open) {
      this.target = 0;
      return;
    }
    const n = this.spec.axis === 'x' ? new THREE.Vector3(0, 0, this.spec.outward) : new THREE.Vector3(this.spec.outward, 0, 0);
    const side = Math.sign(from.clone().sub(this.center).dot(n)) || 1;
    // Rotating local +Z toward the side opposite the user.
    const swing = (Math.PI / 2) * 0.95;
    const testDir = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.baseYaw);
    this.target = testDir.dot(n) * side > 0 ? swing : -swing;
  }

  update(dt: number): void {
    const prev = this.angle;
    this.angle += (this.target - this.angle) * (1 - Math.exp(-dt * 7));
    if (Math.abs(this.angle - prev) < 1e-5) return;
    this.pivot.rotation.y = this.baseYaw + this.angle;
    this.body.setNextKinematicRotation(this.quat(this.baseYaw + this.angle));
  }
}

export class DoorSystem {
  readonly doors: Door[] = [];

  constructor(map: MapDefinition, physics: Physics, lib: MaterialLibrary, parent: THREE.Object3D) {
    const enterable = new Set(map.houses.filter((h) => h.enterable).map((h) => h.id));
    for (const d of map.doors) {
      if (d.exterior && enterable.has(d.houseId)) this.doors.push(new Door(d, physics, lib, parent));
    }
  }

  nearest(pos: THREE.Vector3, maxDist: number): Door | null {
    let best: Door | null = null;
    let bestD = maxDist;
    for (const d of this.doors) {
      const dist = d.center.distanceTo(pos);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  }

  update(dt: number): void {
    for (const d of this.doors) d.update(dt);
  }
}
