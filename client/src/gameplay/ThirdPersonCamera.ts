import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import type { Input } from '../core/Input';
import { settings } from '../core/Settings';
import { LOOK_BEND } from '../characters/Humanoid';

const BASE_FOV = 62;
const AIM_FOV = 46;
const NEAR = 0.08;
/** Close enough for an optic a hand's width from the eye. */
const ADS_NEAR = 0.025;
/** From the waist, where the survivor bends to look up and down, to the eyes. */
const WAIST_TO_EYE = 0.71;

/** What aiming down the active weapon's sights needs from the camera. */
export interface SightView {
  fov: number;
}

/**
 * Over-the-shoulder camera: mouse look, shoulder swap, aim zoom, sphere-cast collision
 * so the camera never clips into walls, and trauma-based shake. Aiming with sights moves it
 * into the survivor's eye, first person, for a sight picture down the weapon.
 */
export class ThirdPersonCamera {
  yaw = Math.PI;
  pitch = -0.08;
  private shoulder = 1;
  private shoulderSmoothed = 1;
  private aimBlend = 0;
  private adsBlend = 0;
  private adsFov = AIM_FOV;
  private distance = 3.1;
  private trauma = 0;
  private readonly pivot = new THREE.Vector3();
  private readonly smoothPivot = new THREE.Vector3();
  private initialized = false;
  /** World-space point under the crosshair (used for aiming and HUD). */
  readonly aimPoint = new THREE.Vector3();
  /** Aim ray (camera position and forward before shake): what shots are fired along. */
  readonly aimOrigin = new THREE.Vector3();
  readonly aimDir = new THREE.Vector3(0, 0, -1);
  /** Eye position (first person) and unshaken view orientation, for lining up the sights. */
  readonly eye = new THREE.Vector3();
  readonly view = new THREE.Quaternion();
  /** When the player last turned the view themselves (ms, performance.now). */
  private lookedAt = -Infinity;
  /** Recoil climb still to be recovered (radians). */
  private recover = 0;
  private recoverYaw = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly physics: Physics) {}

  /** `friction` (0..1] slows stick and thumb turning while the crosshair is over a target (aim assist). */
  look(input: Input, friction = 1): void {
    const d = input.consumeLook();
    const t = input.consumeTurn();
    const c = settings.value.controls;
    // Zoomed sights turn slower in proportion to the zoom, so the view keeps the same feel.
    const zoom = this.adsBlend > 0.5 ? this.camera.fov / BASE_FOV : this.aimBlend > 0.5 ? 0.7 : 1;
    const sens = 0.0022 * c.sensitivity * zoom;
    const inv = c.invertY ? -1 : 1;
    this.yaw -= d.x * sens + t.x * zoom * friction;
    this.pitch -= (d.y * sens + t.y * zoom * friction) * inv;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.25, 0.95);
    if (d.x || d.y || t.x || t.y) this.lookedAt = performance.now();
    if (input.pressed('shoulder')) this.shoulder *= -1;
  }

  /**
   * Swings the view round behind `heading` (riding a skateboard), only once the player has left
   * the look alone for a moment: turning to look or aim always wins.
   */
  /** 0..1: how fast the survivor is going on wheels (the view widens with it). */
  rush = 0;

  follow(dt: number, heading: number, rate: number): void {
    if (performance.now() - this.lookedAt < 1100 || rate <= 0) return;
    const want = heading + Math.PI;
    this.yaw += Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw)) * (1 - Math.exp(-dt * rate));
  }

  /** Aim assist pull: turns the view by this much (radians, toward the target). */
  nudge(yaw: number, pitch: number): void {
    this.yaw += yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch, -1.25, 0.95);
  }

  /** Muzzle climb: the view kicks up (and a little sideways) and settles most of the way back. */
  addRecoil(pitch: number, yaw: number): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch, -1.25, 0.95);
    this.yaw += yaw;
    this.recover += pitch * 0.65;
    this.recoverYaw += yaw * 0.5;
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  snapNext(): void {
    this.initialized = false;
    this.recover = this.recoverYaw = 0;
  }

  /** `sight` is the active weapon's when aiming should go first person, otherwise null. */
  update(dt: number, target: THREE.Vector3, eyeHeight: number, aiming: boolean, sprinting: boolean, sight: SightView | null = null): void {
    this.aimBlend += ((aiming ? 1 : 0) - this.aimBlend) * (1 - Math.exp(-dt * 12));
    this.adsBlend += ((aiming && sight ? 1 : 0) - this.adsBlend) * (1 - Math.exp(-dt * 14));
    if (this.adsBlend < 0.002) this.adsBlend = 0;
    if (sight) this.adsFov = sight.fov;
    if (this.recover !== 0 || this.recoverYaw !== 0) {
      const k = 1 - Math.exp(-dt * 7);
      const rp = this.recover * k;
      const ry = this.recoverYaw * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch - rp, -1.25, 0.95);
      this.yaw -= ry;
      this.recover -= rp;
      this.recoverYaw -= ry;
      if (Math.abs(this.recover) < 1e-5) this.recover = 0;
      if (Math.abs(this.recoverYaw) < 1e-5) this.recoverYaw = 0;
    }
    this.shoulderSmoothed += (this.shoulder - this.shoulderSmoothed) * (1 - Math.exp(-dt * 10));

    this.pivot.set(target.x, target.y + eyeHeight, target.z);
    if (!this.initialized) {
      this.smoothPivot.copy(this.pivot);
      this.initialized = true;
    } else {
      // Slight lag on the pivot for weight; vertical lag smooths steps.
      this.smoothPivot.x += (this.pivot.x - this.smoothPivot.x) * (1 - Math.exp(-dt * 22));
      this.smoothPivot.z += (this.pivot.z - this.smoothPivot.z) * (1 - Math.exp(-dt * 22));
      this.smoothPivot.y += (this.pivot.y - this.smoothPivot.y) * (1 - Math.exp(-dt * 12));
    }

    const a = this.aimBlend;
    const dist = THREE.MathUtils.lerp(this.distance, 1.35, a);
    const side = THREE.MathUtils.lerp(0.62, 0.55, a) * this.shoulderSmoothed;
    const up = THREE.MathUtils.lerp(0.12, 0.08, a);

    const rot = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    const q = new THREE.Quaternion().setFromEuler(rot);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const upV = new THREE.Vector3(0, 1, 0);

    // Collision: first sweep sideways to the shoulder, then backwards.
    const origin = this.smoothPivot.clone();
    const sideDir = right.clone().multiplyScalar(Math.sign(side) || 1);
    const sideLen = Math.abs(side);
    const r = 0.18;
    const sideHit = this.physics.sphereCast(origin.x, origin.y, origin.z, sideDir.x, sideDir.y, sideDir.z, r, sideLen);
    const shoulderPt = origin.clone().addScaledVector(sideDir, sideHit !== null ? Math.max(0, sideHit - 0.02) : sideLen).addScaledVector(upV, up);
    const backHit = this.physics.sphereCast(shoulderPt.x, shoulderPt.y, shoulderPt.z, back.x, back.y, back.z, r, dist);
    const backDist = backHit !== null ? Math.max(0.15, backHit - 0.02) : dist;
    const camPos = shoulderPt.addScaledVector(back, backDist);

    // First person: the survivor's eyes sit 14 cm above the camera pivot, at the front of the
    // face, cheek on the stock; crouching leans the head forward and keeps it higher than the
    // shortened collider suggests.
    const crouch = Math.max(0, 1.6 - eyeHeight);
    const fwdFlat = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.eye.copy(this.smoothPivot).addScaledVector(fwdFlat, 0.1 + crouch * 0.25).addScaledVector(right, 0.03);
    this.eye.y += 0.14 + crouch * 0.3;
    // Looking up or down bends the survivor at the waist (LOOK_BEND of the pitch) and the eyes go
    // with the head, so the shoulders and arms stay behind the sights instead of swinging in front
    // of them; never into a wall ahead.
    if (this.adsBlend > 0) {
      const bend = -this.pitch * LOOK_BEND;
      const ahead = WAIST_TO_EYE * Math.sin(bend);
      const wall = ahead > 0 ? this.physics.sphereCast(this.eye.x, this.eye.y, this.eye.z, fwdFlat.x, 0, fwdFlat.z, 0.1, ahead) : null;
      this.eye.addScaledVector(fwdFlat, wall !== null ? Math.max(0, wall - 0.02) : ahead);
      this.eye.y -= WAIST_TO_EYE * (1 - Math.cos(bend));
    }
    const ads = this.adsBlend;
    if (ads > 0) camPos.lerp(this.eye, ads * ads * (3 - 2 * ads));

    // Shake.
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const shakeScale = settings.value.accessibility.reducedShake ? 0.25 : 1;
    const s = this.trauma * this.trauma * shakeScale;
    const t = performance.now() * 0.001;
    const sprintBob = sprinting ? Math.sin(t * 13) * 0.012 * shakeScale : 0;

    this.camera.position.copy(camPos);
    this.camera.position.y += sprintBob * (1 - ads);
    this.camera.quaternion.copy(q);
    this.view.copy(q);
    this.eye.copy(this.camera.position);
    this.aimOrigin.copy(this.camera.position);
    this.aimDir.set(0, 0, -1).applyQuaternion(q);
    if (s > 0) {
      this.camera.rotateX((Math.sin(t * 37) * 0.04) * s);
      this.camera.rotateY((Math.sin(t * 41 + 2) * 0.04) * s);
      this.camera.rotateZ((Math.sin(t * 29 + 4) * 0.05) * s);
    }
    const shoulderFov = THREE.MathUtils.lerp(BASE_FOV, AIM_FOV, a) + (sprinting ? 4 : 0) + this.rush * 9 * (1 - a);
    // Zoom follows the eye's move (the blend already eases), so the sights don't swim.
    const fov = THREE.MathUtils.lerp(shoulderFov, this.adsFov, ads);
    const near = ads > 0.05 ? ADS_NEAR : NEAR;
    if (Math.abs(this.camera.fov - fov) > 0.01 || this.camera.near !== near) {
      this.camera.fov = ads > 0 ? fov : this.camera.fov + (fov - this.camera.fov) * (1 - Math.exp(-dt * 10));
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }

    // Crosshair target.
    const o = this.aimOrigin;
    const fwd = this.aimDir;
    const hit = this.physics.raycast(o.x, o.y, o.z, fwd.x, fwd.y, fwd.z, 200);
    this.aimPoint.copy(o).addScaledVector(fwd, hit ?? 200);
  }

  get aimAmount(): number {
    return this.aimBlend;
  }

  /** 0..1 how far into first-person sights the view is. */
  get ads(): number {
    return this.adsBlend;
  }
}
