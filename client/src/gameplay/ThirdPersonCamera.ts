import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import type { Input } from '../core/Input';
import { settings } from '../core/Settings';

const BASE_FOV = 62;
const AIM_FOV = 46;

/**
 * Over-the-shoulder camera: mouse look, shoulder swap, aim zoom, sphere-cast collision
 * so the camera never clips into walls, and trauma-based shake.
 */
export class ThirdPersonCamera {
  yaw = Math.PI;
  pitch = -0.08;
  private shoulder = 1;
  private shoulderSmoothed = 1;
  private aimBlend = 0;
  private distance = 3.1;
  private trauma = 0;
  private readonly pivot = new THREE.Vector3();
  private readonly smoothPivot = new THREE.Vector3();
  private initialized = false;
  /** World-space point under the crosshair (used for aiming and HUD). */
  readonly aimPoint = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly physics: Physics) {}

  look(input: Input): void {
    const d = input.consumeLook();
    const c = settings.value.controls;
    const sens = 0.0022 * c.sensitivity * (this.aimBlend > 0.5 ? 0.7 : 1);
    this.yaw -= d.x * sens;
    this.pitch -= d.y * sens * (c.invertY ? -1 : 1);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.25, 0.95);
    if (input.pressed('shoulder')) this.shoulder *= -1;
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  snapNext(): void {
    this.initialized = false;
  }

  update(dt: number, target: THREE.Vector3, eyeHeight: number, aiming: boolean, sprinting: boolean): void {
    this.aimBlend += ((aiming ? 1 : 0) - this.aimBlend) * (1 - Math.exp(-dt * 12));
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

    // Shake.
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const shakeScale = settings.value.accessibility.reducedShake ? 0.25 : 1;
    const s = this.trauma * this.trauma * shakeScale;
    const t = performance.now() * 0.001;
    const sprintBob = sprinting ? Math.sin(t * 13) * 0.012 * shakeScale : 0;

    this.camera.position.copy(camPos);
    this.camera.position.y += sprintBob;
    this.camera.quaternion.copy(q);
    if (s > 0) {
      this.camera.rotateX((Math.sin(t * 37) * 0.04) * s);
      this.camera.rotateY((Math.sin(t * 41 + 2) * 0.04) * s);
      this.camera.rotateZ((Math.sin(t * 29 + 4) * 0.05) * s);
    }
    const fov = THREE.MathUtils.lerp(BASE_FOV, AIM_FOV, a) + (sprinting ? 4 : 0);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 10));
      this.camera.updateProjectionMatrix();
    }

    // Crosshair target.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const hit = this.physics.raycast(camPos.x, camPos.y, camPos.z, fwd.x, fwd.y, fwd.z, 200);
    this.aimPoint.copy(camPos).addScaledVector(fwd, hit ?? 200);
  }

  get aimAmount(): number {
    return this.aimBlend;
  }
}
