import * as THREE from 'three';
import { BODY_FILTER, DOWNED, PLAYER, SKATEBOARD, SKATE_TRICKS, TRICK_DELAY, VAULT, VEHICLE, skateTrickFor, vaultAt, type PlayerMotion, type SkateTrick, type Vec3, type VaultPlan } from '@dead-hours/shared';
import { RAPIER, GROUP, groups, type Physics } from '../core/Physics';
import type { Input } from '../core/Input';
import { settings } from '../core/Settings';
import { Humanoid, type HumanoidLook, type SeatPose, type SkatePose } from '../characters/Humanoid';

/** What a survivor on foot bumps into: the world, doors, vehicles (and their cabins), the dead. */
const FEET = groups(GROUP.player, BODY_FILTER | GROUP.zombie);

const capsuleHalf = (height: number) => (height - PLAYER.radius * 2) / 2;
const _vp: Vec3 = { x: 0, y: 0, z: 0 };
/** Eye height above the feet while tucked over a sill (the head ducks under the top of the window). */
const VAULT_EYE = 0.95;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Riding a skateboard: where the deck points, how fast it rolls, the kick and the carve. */
export interface Ride {
  board: number;
  heading: number;
  /** Heading at the previous fixed step (drawn in between). */
  prevHeading: number;
  speed: number;
  /** Smoothed steering, -1..1 (positive turns left). */
  steer: number;
  /** Kick cycle 0..1 while pushing along, or -1. */
  push: number;
  /** Lean into the carve, -1..1. */
  lean: number;
  /** Seconds since the ollie popped, or -1. */
  pop: number;
  /** The flip trick popped with it (null: a plain ollie), seconds since its pop (-1 none), and at the previous fixed step. */
  trick: SkateTrick | null;
  trickT: number;
  prevTrickT: number;
  /** A trick caught in the air, called out when the wheels touch down. */
  caught: SkateTrick | null;
  /** Seconds since hopping on. */
  since: number;
  /** Fixed steps in a row something has blocked the deck. */
  blocked: number;
}

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
  private wish = new THREE.Vector3();
  /** Seconds the body keeps facing the camera after hip fire. */
  private faceT = 0;
  /** Seconds sprinting stays blocked (firing, melee, bandaging). */
  private noSprintT = 0;
  /** Camera pitch, fed to the spine so the upper body follows the aim. */
  lookPitch = 0;
  private turnRate = 0;
  /** Dead: input and movement stop, a ragdoll owns the body. */
  dead = false;
  /** Downed: on their back, dragging themselves along; no sprint, jump or aim. */
  downed = false;
  /** On a skateboard (null on foot). */
  ride: Ride | null = null;
  /** Set when a head-on hit at speed threw the rider off (the session puts the board down). */
  bailed = false;
  /** Set when the back foot touches down for a kick, and when an ollie pops (sounds). */
  kicked = false;
  popped = false;
  /** Set for one frame when a flip trick pops (the others are told), and when one is landed (called out). */
  tricked: SkateTrick | null = null;
  landedTrick: SkateTrick | null = null;
  private readonly skatePose: SkatePose = { yaw: 0, deck: SKATEBOARD.deck, push: -1, lean: 0, air: false, low: false, trickU: -1, flip: 0, spin: 0 };
  /** Vaulting through a window: the way (Vault.ts), seconds into it, and how tucked the body is (0..1). */
  vault: { plan: VaultPlan; t: number; tuck: number } | null = null;
  /** Set when a vault comes down on the far side's floor (the session plays the landing). */
  vaultLanded = false;
  /** Seconds in the air before the last landing (how hard it was). */
  landAir = 0;
  /**
   * In a vehicle's seat (null on foot): which one, and whether at the wheel. The session puts the
   * survivor on the seat every frame (seatAt); the capsule is out of the world meanwhile.
   */
  seated: { vehicle: number; seat: number; driver: boolean } | null = null;
  /** The vehicle's heading as drawn (its yaw: the nose along (cos, -sin)), and its velocity. */
  private seatYaw = 0;
  private readonly seatVel = new THREE.Vector3();
  private readonly seatPose: SeatPose = { yaw: 0 };
  private moveX = 0;
  private moveY = 0;

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
      .setCollisionGroups(FEET);
  }

  get colliderHandle(): RAPIER.Collider {
    return this.collider;
  }

  get eyeHeight(): number {
    if (this.seated) return VEHICLE.seatEye;
    if (this.downed) return DOWNED.eyeHeight;
    const eye = this.height - 0.2;
    return this.vault ? eye - (eye - VAULT_EYE) * this.vault.tuck : eye;
  }

  /** Starts vaulting through a window along a plan from findVault (the session has checked it can). */
  startVault(plan: VaultPlan): void {
    if (this.dead || this.downed || this.ride || this.vault || this.seated) return;
    this.vault = { plan, t: 0, tuck: 0 };
    this.jumpBuffered = 0;
    this.coyote = 0;
    this.sprinting = false;
    this.intent.set(0, 0, 0);
    this.grounded = false;
    this.airTime = 0;
  }

  /** One fixed step of a vault: the feet follow the plan, nothing collides. */
  private vaultStep(dt: number): void {
    const v = this.vault!;
    v.t += dt;
    const tuck = vaultAt(v.plan, v.t, _vp);
    if (tuck === null) {
      // Over: down on the floor and carrying on, or pushed off the sill into the drop.
      const p = v.plan;
      this.place(p.land ?? p.over, dt);
      this.vault = null;
      const speed = p.land ? VAULT.exitSpeed : VAULT.dropSpeed;
      this.intent.set(p.dir.x * speed, 0, p.dir.z * speed);
      this.grounded = !!p.land;
      this.coyote = 0;
      this.airTime = 0;
      if (p.land) this.vaultLanded = true;
    } else {
      v.tuck = tuck;
      this.place(_vp, dt);
      this.grounded = false;
    }
    const want = Math.atan2(v.plan.dir.x, v.plan.dir.z);
    const diff = Math.atan2(Math.sin(want - this.facing), Math.cos(want - this.facing));
    const turned = diff * (1 - Math.exp(-dt * 16));
    this.facing += turned;
    this.turnRate = dt > 0 ? turned / dt : 0;
  }

  /** Moves the capsule's feet straight to a point (no collision), with the velocity it took. */
  private place(at: Vec3, dt: number): void {
    if (dt > 0) this.velocity.set((at.x - this.position.x) / dt, (at.y - this.position.y) / dt, (at.z - this.position.z) / dt);
    this.position.set(at.x, at.y, at.z);
    this.body.setNextKinematicTranslation({ x: at.x, y: at.y + this.height / 2, z: at.z });
  }

  /**
   * Into a vehicle's seat: off any skateboard, standing height (crouching makes no sense in a
   * seat), the capsule out of the world (the car's body is what others bump into).
   */
  sitIn(vehicle: number, seat: number, driver: boolean): void {
    this.ride = null;
    this.vault = null;
    this.sprinting = false;
    this.jumpBuffered = 0;
    if (this.crouching) {
      const t = this.body.translation();
      const feet = t.y - this.height / 2;
      this.physics.world.removeCollider(this.collider, false);
      this.height = PLAYER.height;
      this.collider = this.physics.world.createCollider(this.capsuleDesc(PLAYER.height), this.body);
      this.body.setTranslation({ x: t.x, y: feet + PLAYER.height / 2, z: t.z }, true);
      this.crouching = false;
    }
    this.collider.setEnabled(false);
    this.intent.set(0, 0, 0);
    this.grounded = true;
    this.seated = { vehicle, seat, driver };
  }

  /** Pushed aside by something moving into them (a car): along the ground, never through a wall. */
  shove(dx: number, dz: number): void {
    const d = Math.hypot(dx, dz);
    if (d < 1e-4 || this.seated || this.dead) return;
    const t = this.body.translation();
    const hit = this.physics.raycast(t.x, t.y, t.z, dx / d, 0, dz / d, d + PLAYER.radius, groups(0xffff, GROUP.static | GROUP.dynamic));
    const go = hit === null ? d : Math.max(0, hit - PLAYER.radius - 0.02);
    const next = { x: t.x + (dx / d) * go, y: t.y, z: t.z + (dz / d) * go };
    this.body.setTranslation(next, true);
    this.body.setNextKinematicTranslation(next);
    this.position.x = next.x;
    this.position.z = next.z;
  }

  /** Out of the seat, standing at `pos` (where the simulation let them out). */
  leaveSeat(pos: { x: number; y: number; z: number }): void {
    if (!this.seated) return;
    this.seated = null;
    this.character.seat = null;
    if (!this.dead) this.collider.setEnabled(true);
    this.teleport(pos);
    // Stepping out of a rolling car keeps a little of its way.
    this.intent.set(this.seatVel.x * 0.5, 0, this.seatVel.z * 0.5);
    this.facing = this.seatYaw + Math.PI / 2;
  }

  /**
   * Where the seat is this frame (the cushion, as the vehicle is drawn), which way the vehicle
   * points and how it moves. The survivor is drawn there and reports it.
   */
  seatAt(pos: THREE.Vector3, yaw: number, vel: { x: number; z: number }): void {
    this.position.copy(pos);
    this.prevPosition.copy(pos);
    this.renderPosition.copy(pos);
    this.seatYaw = yaw;
    this.seatVel.set(vel.x, 0, vel.z);
    this.velocity.copy(this.seatVel);
    this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y + this.height / 2, z: pos.z });
  }

  /** Goes down (or gets back up: standing again once there is headroom). */
  setDowned(on: boolean): void {
    if (on === this.downed) return;
    this.downed = on;
    this.character.downTarget = on ? 1 : 0;
    this.sprinting = false;
    this.aiming = false;
    this.aimToggled = false;
    this.jumpBuffered = 0;
    if (on) this.ride = null;
    if (on && !this.crouching) this.setCrouch(true);
  }

  /**
   * Hops onto a skateboard. Running onto it, the deck points the way you were going and keeps
   * the pace; from a standstill it points where the camera looks. `cameraYaw` is the camera's.
   */
  mount(board: number, cameraYaw: number): void {
    if (this.dead || this.downed || this.ride || this.vault) return;
    const hv = Math.hypot(this.velocity.x, this.velocity.z);
    const running = hv > 1.5;
    const heading = running ? Math.atan2(this.velocity.x, this.velocity.z) : cameraYaw + Math.PI;
    this.ride = {
      board, heading, prevHeading: heading, speed: running ? Math.min(hv, SKATEBOARD.pushTop) : 0,
      steer: 0, push: -1, lean: 0, pop: -1, trick: null, trickT: -1, prevTrickT: -1, caught: null, since: 0, blocked: 0,
    };
    this.sprinting = false;
    this.bailed = false;
    if (this.grounded) {
      this.intent.y = SKATEBOARD.mountHop;
      this.grounded = false;
      this.coyote = 0;
    }
  }

  /**
   * Steps off (or is thrown off) the board. Returns where the board comes to rest and which way
   * it points; at speed the survivor runs it out.
   */
  dismount(): { pos: { x: number; y: number; z: number }; yaw: number } | null {
    const r = this.ride;
    if (!r) return null;
    this.ride = null;
    const keep = this.bailed ? 0 : Math.min(r.speed, SKATEBOARD.stepOffSpeed);
    this.intent.x = Math.sin(r.heading) * keep;
    this.intent.z = Math.cos(r.heading) * keep;
    const ahead = this.bailed ? 0.1 : 0.3;
    return { pos: { x: this.position.x + Math.sin(r.heading) * ahead, y: this.position.y, z: this.position.z + Math.cos(r.heading) * ahead }, yaw: r.heading };
  }

  /** How far through its flip trick the board is now, between fixed steps (0 flick .. 1 caught), or -1. */
  trickU(alpha: number): number {
    const r = this.ride;
    if (!r || !r.trick || r.trickT < 0) return -1;
    const t = r.prevTrickT >= 0 ? r.prevTrickT + (r.trickT - r.prevTrickT) * alpha : r.trickT;
    return THREE.MathUtils.clamp((t - TRICK_DELAY) / SKATE_TRICKS[r.trick].time, 0, 1);
  }

  /** Where the deck points now, between fixed steps. */
  rideHeading(alpha: number): number {
    const r = this.ride;
    return r ? r.prevHeading + wrap(r.heading - r.prevHeading) * alpha : this.facing;
  }

  /** Turn the body toward the camera for a moment (hip fire, melee). */
  faceCamera(seconds: number): void {
    this.faceT = Math.max(this.faceT, seconds);
  }

  blockSprint(seconds: number): void {
    this.noSprintT = Math.max(this.noSprintT, seconds);
  }

  /** Current movement state for the simulation (aim, noise, spread). */
  motion(cameraYaw: number, cameraPitch: number): PlayerMotion {
    if (this.seated) {
      return {
        pos: { x: this.position.x, y: this.position.y, z: this.position.z },
        vel: { x: this.seatVel.x, y: 0, z: this.seatVel.z },
        yaw: cameraYaw, pitch: cameraPitch, eyeHeight: VEHICLE.seatEye,
        crouching: false, sprinting: false, aiming: this.aiming && !this.seated.driver, grounded: true, pushing: false,
      };
    }
    return {
      pos: { x: this.position.x, y: this.position.y, z: this.position.z },
      vel: { x: this.velocity.x, y: this.velocity.y, z: this.velocity.z },
      yaw: cameraYaw,
      pitch: cameraPitch,
      eyeHeight: this.eyeHeight,
      crouching: this.crouching,
      sprinting: this.sprinting,
      aiming: this.aiming,
      grounded: this.grounded,
      board: this.ride ? wrap(this.ride.heading) : undefined,
      pushing: !!this.ride && this.ride.push >= 0,
      vaulting: !!this.vault,
    };
  }

  /** Samples input once per frame (pressed events must not be missed between fixed steps). */
  sampleInput(input: Input, cameraYaw: number): void {
    // Keys, the left stick and the thumb stick all arrive as one analog vector.
    const f = input.move.y;
    const r = input.move.x;
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
    this.moveX = r;
    this.moveY = f;
  }
  private crouchHeld = false;
  private sprintHeld = false;
  private forwardAmount = 0;

  clearInput(): void {
    this.wish.set(0, 0, 0);
    this.moveX = this.moveY = 0;
    this.sprintHeld = false;
    this.crouchHeld = false;
    this.aiming = false;
    this.aimToggled = false;
  }

  fixedUpdate(dt: number, cameraYaw: number): void {
    this.prevPosition.copy(this.position);
    if (this.dead) return;
    this.faceT = Math.max(0, this.faceT - dt);
    this.noSprintT = Math.max(0, this.noSprintT - dt);
    if (this.seated) {
      this.seatedStep(dt, cameraYaw);
      return;
    }
    if (this.vault) {
      this.vaultStep(dt);
      return;
    }
    // Hold-to-crouch with Ctrl/C.
    const wantCrouch = this.crouchHeld || this.downed;
    if (wantCrouch !== this.crouching) this.setCrouch(wantCrouch);

    if (this.downed) this.aiming = false;
    const ride = this.ride;
    if (ride) {
      this.sprinting = false;
      this.rideStep(dt);
    } else {
      this.sprinting = this.sprintHeld && !this.downed && !this.crouching && !this.aiming && this.forwardAmount > 0 && this.grounded && this.noSprintT <= 0;
      const speed = this.downed
        ? DOWNED.crawlSpeed
        : this.crouching
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
    }

    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);
    // On the board the jump is an ollie (crouched too: that's how it's done), and with the stick
    // held to a side or back a flip trick off it.
    if (this.jumpBuffered > 0 && this.coyote > 0 && (!this.crouching || ride) && !this.downed) {
      this.intent.y = ride ? SKATEBOARD.ollie : PLAYER.jumpVelocity;
      this.jumpBuffered = 0;
      this.coyote = 0;
      this.grounded = false;
      if (ride) {
        ride.pop = 0;
        this.popped = true;
        const kind = skateTrickFor(this.moveX, this.moveY);
        ride.caught = null;
        ride.trick = kind === 'ollie' ? null : kind;
        ride.trickT = ride.prevTrickT = ride.trick ? 0 : -1;
        if (ride.trick) this.tricked = ride.trick;
      }
    }
    this.intent.y += PLAYER.gravity * dt;
    // No downward push while grounded: snap-to-ground holds the feet down, and a slanted move
    // defeats autostep at slow speeds (crouch-walking would stall on door thresholds).
    if (this.grounded && this.intent.y < 0) this.intent.y = 0;

    const desired = { x: this.intent.x * dt, y: this.intent.y * dt, z: this.intent.z * dt };
    this.controller.computeColliderMovement(this.collider, desired, undefined, FEET);
    const m = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    let grounded = this.controller.computedGrounded();
    if (!grounded && wasGrounded && this.intent.y <= 0) {
      // Without a downward push the controller reports "airborne" on flat floor every other
      // step; a short probe under the feet keeps the survivor grounded unless the floor is gone.
      const t = this.body.translation();
      const feet = t.y + m.y - this.height / 2;
      if (this.physics.raycast(t.x + m.x, feet + 0.05, t.z + m.z, 0, -1, 0, 0.14) !== null) grounded = true;
    }
    this.grounded = grounded;
    if (this.grounded && this.intent.y < 0) this.intent.y = 0;
    // Bonk head on ceilings.
    if (!this.grounded && desired.y > 0 && m.y < desired.y * 0.5) this.intent.y = 0;
    if (ride) this.rideCollide(dt, desired, m);
    if (dt > 0) this.velocity.set(m.x / dt, this.intent.y, m.z / dt);
    const t = this.body.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.body.setNextKinematicTranslation(next);
    this.position.set(next.x, next.y - this.height / 2, next.z);
    // Only a real fall counts as a landing (camera jolt, thud), not a step off a curb.
    const air = this.airTime;
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    if (!wasGrounded && this.grounded && air > 0.18) {
      this.landed = true;
      this.landAir = air;
    }

    // Facing: aim locks body to camera, otherwise turn toward travel direction. On a skateboard
    // the shoulders sit side-on to the deck, opened a little toward the nose.
    const hv = Math.hypot(this.velocity.x, this.velocity.z);
    let desiredFacing = this.facing;
    const toCamera = this.aiming || this.faceT > 0;
    if (toCamera) desiredFacing = cameraYaw + Math.PI;
    else if (this.ride) desiredFacing = this.ride.heading - Math.PI / 2 + 0.55;
    else if (hv > 0.4) desiredFacing = Math.atan2(this.velocity.x, this.velocity.z);
    const diff = Math.atan2(Math.sin(desiredFacing - this.facing), Math.cos(desiredFacing - this.facing));
    const turned = diff * (1 - Math.exp(-dt * (toCamera ? 20 : this.ride ? 9 : 11)));
    this.facing += turned;
    this.turnRate = dt > 0 ? turned / dt : 0;
  }
  landed = false;
  private airTime = 0;

  /**
   * A fixed step in a seat: no walking, crouching or jumping. The driver faces down the road; a
   * passenger turns to where they aim (or shoot), else faces ahead too.
   */
  private seatedStep(dt: number, cameraYaw: number): void {
    const s = this.seated!;
    this.sprinting = false;
    if (s.driver) this.aiming = false;
    this.jumpBuffered = 0;
    this.intent.set(0, 0, 0);
    const ahead = this.seatYaw + Math.PI / 2;
    const toCamera = !s.driver && (this.aiming || this.faceT > 0);
    const desired = toCamera ? cameraYaw + Math.PI : ahead;
    const diff = Math.atan2(Math.sin(desired - this.facing), Math.cos(desired - this.facing));
    const turned = diff * (1 - Math.exp(-dt * (toCamera ? 20 : 14)));
    this.facing += turned;
    this.turnRate = 0;
  }

  /**
   * One fixed step of skating: the stick's sideways axis carves (sharp at walking pace, wide at
   * speed, a little in the air), forward kicks along up to the top speed (higher with sprint
   * held), back brakes, and the board coasts on with only a little rolling resistance.
   */
  private rideStep(dt: number): void {
    const r = this.ride!;
    const S = SKATEBOARD;
    r.since += dt;
    r.prevHeading = r.heading;
    const steerTo = THREE.MathUtils.clamp(-this.moveX, -1, 1);
    r.steer += (steerTo - r.steer) * (1 - Math.exp(-dt * 8));
    const rate = THREE.MathUtils.lerp(S.turnSlow, S.turnFast, THREE.MathUtils.smoothstep(r.speed, 1.5, 8)) * (this.grounded ? 1 : S.airTurn);
    r.heading = wrap(r.heading + r.steer * rate * dt);
    const leanTo = this.grounded ? THREE.MathUtils.clamp(r.steer * THREE.MathUtils.smoothstep(r.speed, 0.5, 5), -1, 1) : 0;
    r.lean += (leanTo - r.lean) * (1 - Math.exp(-dt * 6));

    // Off the pavement the wheels sink in: a board barely rolls on grass or dirt.
    let soft = false;
    if (this.grounded) {
      const g = this.physics.raycastHit(this.position.x, this.position.y + 0.3, this.position.z, 0, -1, 0, 0.6);
      soft = !!g && (g.surface === 'grass' || g.surface === 'dirt');
    }
    const top = this.sprintHeld && this.noSprintT <= 0 ? S.sprintTop : S.pushTop;
    const wantPush = this.moveY > 0.3 && this.grounded && r.speed < top - 0.15;
    if (r.push < 0 && wantPush) r.push = 0;
    if (r.push >= 0) {
      const before = r.push;
      r.push += dt / S.pushPeriod;
      if (before < S.pushFrom && r.push >= S.pushFrom) this.kicked = true;
      if (r.push >= S.pushFrom && r.push < S.pushTo && this.grounded) {
        // Easy from a standstill, harder the nearer the top speed.
        r.speed += S.pushAccel * (soft ? S.offRoadPush : 1) * THREE.MathUtils.clamp(((top - r.speed) / top) * S.pushEase, 0, 1) * dt;
      }
      if (r.push >= 1) r.push = wantPush ? 0 : -1;
    }
    if (this.moveY < -0.3) r.speed -= S.brake * Math.min(1, -this.moveY) * dt;
    if (this.grounded) r.speed -= (S.rolling + (soft ? S.offRoad : 0) + S.drag * r.speed * r.speed * (this.crouching ? 0.6 : 1)) * dt;
    r.speed = THREE.MathUtils.clamp(r.speed, 0, S.maxSpeed);
    if (r.pop >= 0) {
      r.pop += dt;
      if (r.pop > 0.7) r.pop = -1;
    }
    // A flip trick turns through in its time; down on something before the catch (popped onto a
    // curb), the feet stamp it through at once. Caught, it is called out when the wheels touch down.
    r.prevTrickT = r.trickT;
    if (r.trick) {
      r.trickT += dt * (this.grounded && r.trickT > TRICK_DELAY + 0.06 ? 5 : 1);
      if (r.trickT >= TRICK_DELAY + SKATE_TRICKS[r.trick].time) {
        r.caught = r.trick;
        r.trick = null;
        r.trickT = r.prevTrickT = -1;
      }
    }
    if (r.caught && this.grounded && !r.trick) {
      this.landedTrick = r.caught;
      r.caught = null;
    }
    this.intent.x = Math.sin(r.heading) * r.speed;
    this.intent.z = Math.cos(r.heading) * r.speed;
  }

  /**
   * What got in the deck's way this step: a glancing blow scrapes speed off and turns the board
   * along the obstacle; a head-on hit at speed throws the rider (`bailed`). A single blocked step
   * (a curb edge before autostep takes it) counts for nothing.
   */
  private rideCollide(dt: number, desired: { x: number; z: number }, m: { x: number; z: number }): void {
    const r = this.ride!;
    const want = Math.hypot(desired.x, desired.z);
    if (want < 1e-4) {
      r.blocked = 0;
      return;
    }
    const got = Math.hypot(m.x, m.z);
    if (got >= want * 0.85) {
      r.blocked = 0;
      return;
    }
    if (++r.blocked < 2) return;
    const along = m.x * Math.sin(r.heading) + m.z * Math.cos(r.heading);
    if (r.speed > SKATEBOARD.bailSpeed && along < want * SKATEBOARD.bailKeep) {
      this.bailed = true;
      r.speed = 0;
      return;
    }
    r.speed = Math.max(0, along / dt);
    if (got > want * 0.2) r.heading = wrap(r.heading + wrap(Math.atan2(m.x, m.z) - r.heading) * 0.5);
  }

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
        undefined, FEET, this.collider,
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
    if (!this.seated) this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);
    if (this.dead) return;
    this.character.root.position.copy(this.renderPosition);
    if (this.seated) this.character.root.position.y -= 0.88;
    this.character.root.rotation.y = this.facing;
    const hv = Math.hypot(this.velocity.x, this.velocity.z);
    const right = new THREE.Vector3(Math.cos(this.facing), 0, -Math.sin(this.facing));
    const strafe = hv > 0.1 ? (this.velocity.x * right.x + this.velocity.z * right.z) / hv : 0;
    const travel = Math.atan2(this.velocity.x, this.velocity.z) - this.facing;
    const moveAngle = hv > 0.3 ? Math.atan2(Math.sin(travel), Math.cos(travel)) : 0;
    const c = this.character;
    c.lookPitch += ((this.aiming || this.faceT > 0 ? this.lookPitch : this.lookPitch * 0.35) - c.lookPitch) * (1 - Math.exp(-dt * 12));
    const r = this.ride;
    if (r) {
      const sp = this.skatePose;
      sp.yaw = wrap(this.rideHeading(alpha) - this.facing);
      sp.push = r.push;
      sp.lean = r.lean;
      sp.air = !this.grounded;
      sp.low = this.crouching;
      sp.trickU = this.trickU(alpha);
      const T = r.trick ? SKATE_TRICKS[r.trick] : null;
      sp.flip = T ? T.flip : 0;
      sp.spin = T ? T.spin : 0;
    }
    c.skate = r ? this.skatePose : null;
    c.vault = this.vault ? 1 : 0;
    if (this.seated) {
      this.seatPose.yaw = wrap(this.seatYaw + Math.PI / 2 - this.facing);
      c.seat = this.seatPose;
      this.character.update(dt, { speed: 0, crouch: 0, aim: this.aiming ? 1 : 0, grounded: true, strafe: 0, moveAngle: 0, turn: 0 });
      return;
    }
    c.seat = null;
    this.character.update(dt, {
      // Standing on the deck: no stride (the skate pose does the legs).
      speed: r ? 0 : hv,
      crouch: this.crouching ? 1 : 0,
      aim: this.aiming ? 1 : 0,
      grounded: this.grounded,
      strafe: r ? 0 : strafe,
      moveAngle: r ? 0 : moveAngle,
      turn: r ? 0 : this.turnRate,
    });
  }

  /** Puts the survivor somewhere else at once (the server refused a move). */
  teleport(pos: { x: number; y: number; z: number }): void {
    this.position.set(pos.x, pos.y, pos.z);
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    const c = { x: pos.x, y: pos.y + this.height / 2, z: pos.z };
    this.body.setTranslation(c, true);
    this.body.setNextKinematicTranslation(c);
    this.intent.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.vault = null;
    if (this.ride) this.ride.speed = 0;
  }

  /** Back on their feet at `pos` (a lull brought them back), the body facing camera yaw `yaw`. */
  respawn(pos: { x: number; y: number; z: number }, yaw: number): void {
    this.dead = false;
    this.setDowned(false);
    this.ride = null;
    this.collider.setEnabled(true);
    this.teleport(pos);
    this.facing = yaw + Math.PI;
    this.character.resetPose();
  }

  /** Stops movement and removes the capsule so nothing collides with the fallen survivor. */
  kill(): void {
    if (this.dead) return;
    this.dead = true;
    this.ride = null;
    this.vault = null;
    this.seated = null;
    this.character.seat = null;
    this.clearInput();
    this.sprinting = false;
    this.velocity.set(0, 0, 0);
    this.intent.set(0, 0, 0);
    this.prevPosition.copy(this.position);
    this.collider.setEnabled(false);
  }

  dispose(): void {
    this.physics.world.removeCharacterController(this.controller);
    this.physics.world.removeRigidBody(this.body);
    this.character.dispose();
  }
}
