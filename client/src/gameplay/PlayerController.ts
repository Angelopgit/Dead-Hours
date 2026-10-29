import * as THREE from 'three';
import { PLAYER } from '@dead-hours/shared';
import { RAPIER, GROUP, groups, type Physics } from '../core/Physics';
import type { Input } from '../core/Input';
import { settings } from '../core/Settings';
import { Humanoid, type HumanoidLook } from '../characters/Humanoid';

const capsuleHalf = (height: number) => (height - PLAYER.radius * 2) / 2;

/**
 * Locally simulated third-person character on Rapier's kinematic character controller.
 * Runs at the physics fixed rate; the visual is interpolated between fixed steps.
 * In Phase 4 the same step function drives client-side prediction against server state.
 */
export class PlayerController {
  readonly character: Humanoid;
  readonly position = new THREE.Vector3();
  private readonly prevPosition = new THREE.Vector3();
  readonly renderPosition = new THREE.Vector3();
  /** Actual displacement per second after collision (animation, footsteps, facing). */
  readonly velocity = new THREE.Vector3();
  /**
   * Velocity the player is trying to move at. Kept separate from the collided result so
   * a step edge that briefly stops the capsule doesn't also zero the push that climbs it.
   */
  private readonly intent = new THREE.Vector3();
  private readonly body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  grounded = true;
  crouching = false;
  sprinting = false;
  aiming = false;
  private aimToggled = false;
  /** Body facing yaw (radians). Camera yaw is owned by the camera. */
  facing = 0;
  private height: number = PLAYER.height;
  private jumpBuffered = 0;
  private coyote = 0;
  health: number = PLAYER.maxHealth;
  private wish = new THREE.Vector3();

  constructor(private readonly physics: Physics, spawn: { x: number; y: number; z: number; yaw: number }, look: HumanoidLook) {
    this.position.set(spawn.x, spawn.y, spawn.z);
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    // Spawn yaw is a camera yaw; the body faces the camera forward direction.
    this.facing = spawn.yaw + Math.PI;
    const w = physics.world;
    this.body = w.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + PLAYER.height / 2, spawn.z),
    );
    this.collider = w.createCollider(this.capsuleDesc(PLAYER.height), this.body);
    this.controller = w.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(PLAYER.maxStepHeight, 0.15, false);
    this.controller.enableSnapToGround(0.35);
    this.controller.setMaxSlopeClimbAngle((PLAYER.maxSlopeDeg * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.controller.setSlideEnabled(true);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.character = new Humanoid(look);
  }

  private capsuleDesc(height: number): RAPIER.ColliderDesc {
    return RAPIER.ColliderDesc.capsule(capsuleHalf(height), PLAYER.radius)
      .setTranslation(0, 0, 0)
      .setCollisionGroups(groups(GROUP.player, GROUP.static | GROUP.dynamic));
  }

  get colliderHandle(): RAPIER.Collider {
    return this.collider;
  }

  get eyeHeight(): number {
    return this.height - 0.2;
  }

  /** Samples input once per frame (pressed events must not be missed between fixed steps). */
  sampleInput(input: Input, cameraYaw: number): void {
    const f = (input.held('forward') ? 1 : 0) - (input.held('back') ? 1 : 0);
    const r = (input.held('right') ? 1 : 0) - (input.held('left') ? 1 : 0);
    // Camera forward is -Z rotated by yaw.
    const fx = -Math.sin(cameraYaw);
    const fz = -Math.cos(cameraYaw);
    const rx = Math.cos(cameraYaw);
    const rz = -Math.sin(cameraYaw);
    this.wish.set(fx * f + rx * r, 0, fz * f + rz * r);
    if (this.wish.lengthSq() > 1) this.wish.normalize();

    if (input.pressed('jump')) this.jumpBuffered = 0.15;
    this.crouchHeld = input.held('crouch');
    const aimMode = settings.value.controls.aimMode;
    if (aimMode === 'toggle') {
      if (input.pressed('aim')) this.aimToggled = !this.aimToggled;
      this.aiming = this.aimToggled;
    } else {
      this.aiming = input.held('aim');
    }
    this.sprintHeld = input.held('sprint');
    this.forwardAmount = f;
  }
  private crouchHeld = false;
  private sprintHeld = false;
  private forwardAmount = 0;

  clearInput(): void {
    this.wish.set(0, 0, 0);
    this.sprintHeld = false;
    this.crouchHeld = false;
    this.aiming = false;
    this.aimToggled = false;
  }

  fixedUpdate(dt: number, cameraYaw: number): void {
    this.prevPosition.copy(this.position);
    // Hold-to-crouch with Ctrl/C.
    const wantCrouch = this.crouchHeld;
    if (wantCrouch !== this.crouching) this.setCrouch(wantCrouch);

    this.sprinting = this.sprintHeld && !this.crouching && !this.aiming && this.forwardAmount > 0 && this.grounded;
    const speed = this.crouching
      ? PLAYER.crouchSpeed
      : this.aiming
        ? PLAYER.aimSpeed
        : this.sprinting
          ? PLAYER.sprintSpeed
          : PLAYER.walkSpeed;
    const target = this.wish.clone().multiplyScalar(speed);
    const accel = this.grounded ? PLAYER.acceleration : PLAYER.acceleration * PLAYER.airControl;
    const k = 1 - Math.exp(-accel * dt);
    this.intent.x += (target.x - this.intent.x) * k;
    this.intent.z += (target.z - this.intent.z) * k;

    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);
    if (this.jumpBuffered > 0 && this.coyote > 0 && !this.crouching) {
      this.intent.y = PLAYER.jumpVelocity;
      this.jumpBuffered = 0;
      this.coyote = 0;
      this.grounded = false;
    }
    this.intent.y += PLAYER.gravity * dt;
    if (this.grounded && this.intent.y < 0) this.intent.y = -1;

    const desired = { x: this.intent.x * dt, y: this.intent.y * dt, z: this.intent.z * dt };
    this.controller.computeColliderMovement(this.collider, desired, undefined, groups(GROUP.player, GROUP.static | GROUP.dynamic));
    const m = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.intent.y < 0) this.intent.y = 0;
    // Bonk head on ceilings.
    if (!this.grounded && desired.y > 0 && m.y < desired.y * 0.5) this.intent.y = 0;
    if (dt > 0) this.velocity.set(m.x / dt, this.intent.y, m.z / dt);
    const t = this.body.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.body.setNextKinematicTranslation(next);
    this.position.set(next.x, next.y - this.height / 2, next.z);
    if (!wasGrounded && this.grounded) this.landed = true;

    // Facing: aim locks body to camera, otherwise turn toward travel direction.
    const hv = Math.hypot(this.velocity.x, this.velocity.z);
    let desiredFacing = this.facing;
    if (this.aiming) desiredFacing = cameraYaw + Math.PI;
    else if (hv > 0.4) desiredFacing = Math.atan2(this.velocity.x, this.velocity.z);
    const diff = Math.atan2(Math.sin(desiredFacing - this.facing), Math.cos(desiredFacing - this.facing));
    this.facing += diff * (1 - Math.exp(-dt * (this.aiming ? 20 : 11)));
  }
  landed = false;

  private setCrouch(on: boolean): void {
    const newHeight = on ? PLAYER.crouchHeight : PLAYER.height;
    if (!on) {
      // Only stand up if there is headroom.
      const t = this.body.translation();
      const feet = t.y - this.height / 2;
      const shape = new RAPIER.Capsule(capsuleHalf(PLAYER.height), PLAYER.radius - 0.02);
      let blocked = false;
      this.physics.world.intersectionsWithShape(
        { x: t.x, y: feet + PLAYER.height / 2 + 0.02, z: t.z }, { x: 0, y: 0, z: 0, w: 1 }, shape,
        () => { blocked = true; return false; },
        undefined, groups(GROUP.player, GROUP.static | GROUP.dynamic), this.collider,
      );
      if (blocked) return;
    }
    const t = this.body.translation();
    const feet = t.y - this.height / 2;
    this.physics.world.removeCollider(this.collider, false);
    this.height = newHeight;
    this.collider = this.physics.world.createCollider(this.capsuleDesc(newHeight), this.body);
    const p = { x: t.x, y: feet + newHeight / 2, z: t.z };
    this.body.setTranslation(p, true);
    this.body.setNextKinematicTranslation(p);
    this.crouching = on;
  }

  /** Interpolates the render transform between fixed steps and animates the rig. */
  render(dt: number, alpha: number): void {
    this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);
    this.character.root.position.copy(this.renderPosition);
    this.character.root.rotation.y = this.facing;
    const hv = Math.hypot(this.velocity.x, this.velocity.z);
    const right = new THREE.Vector3(Math.cos(this.facing), 0, -Math.sin(this.facing));
    const strafe = hv > 0.1 ? (this.velocity.x * right.x + this.velocity.z * right.z) / hv : 0;
    this.character.update(dt, {
      speed: hv,
      crouch: this.crouching ? 1 : 0,
      aim: this.aiming ? 1 : 0,
      grounded: this.grounded,
      strafe,
    });
  }

  dispose(): void {
    this.physics.world.removeCharacterController(this.controller);
    this.physics.world.removeRigidBody(this.body);
    this.character.dispose();
  }
}
