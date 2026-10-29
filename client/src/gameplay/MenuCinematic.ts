import * as THREE from 'three';
import { Humanoid, zombieLook } from '../characters/Humanoid';
import { audio } from '../audio/AudioEngine';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';

/**
 * Slow dolly through the street behind the main menu, with a zombie that occasionally
 * shambles across the road in the background.
 */
export class MenuCinematic {
  private readonly posCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-36, 2.3, 3.2),
    new THREE.Vector3(-22, 1.9, 2.4),
    new THREE.Vector3(-9, 2.2, -0.8),
    new THREE.Vector3(3, 2.0, 1.2),
    new THREE.Vector3(14, 2.5, 2.6),
  ], false, 'centripetal');
  private readonly lookCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-12, 1.7, -1),
    new THREE.Vector3(-3, 1.9, -5),
    new THREE.Vector3(8, 1.6, -4),
    new THREE.Vector3(22, 2.2, -9),
    new THREE.Vector3(36, 2.2, 4),
  ], false, 'centripetal');
  private t = 0;
  private readonly period = 110;
  private readonly zombie: Humanoid;
  private zombieActive = false;
  private zombieStart = new THREE.Vector3();
  private zombieEnd = new THREE.Vector3();
  private zombieProgress = 0;
  private nextZombie = 6;
  private groaned = false;
  readonly focus = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private probe: DynamicProbe | null = null;

  constructor(private readonly camera: THREE.PerspectiveCamera, scene: THREE.Scene) {
    this.zombie = new Humanoid(zombieLook(1));
    this.zombie.setVisible(false);
    scene.add(this.zombie.root);
  }

  /** Lights the background zombie from the baked light field. */
  applyProbe(field: LightField): void {
    this.probe = new DynamicProbe(field);
    this.probe.attach(this.zombie.surfaces());
  }

  /** Current camera pose, used to start the intro transition from where the menu left off. */
  pose(): { position: THREE.Vector3; target: THREE.Vector3 } {
    return { position: this.camera.position.clone(), target: this.look.clone() };
  }

  update(dt: number): void {
    this.t += dt;
    const u = 0.5 - 0.5 * Math.cos((this.t / this.period) * Math.PI * 2);
    this.posCurve.getPoint(u, this.camera.position);
    this.lookCurve.getPoint(u, this.look);
    // Handheld drift.
    this.camera.position.x += Math.sin(this.t * 0.31) * 0.05;
    this.camera.position.y += Math.sin(this.t * 0.47) * 0.04;
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - 50) > 0.01) {
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
    }
    this.focus.copy(this.camera.position).lerp(this.look, 0.6);
    this.updateZombie(dt);
  }

  private updateZombie(dt: number): void {
    if (!this.zombieActive) {
      this.nextZombie -= dt;
      if (this.nextZombie > 0) return;
      // Cross the street 18–28 m ahead of the camera, along its view direction.
      const fwd = this.look.clone().sub(this.camera.position).setY(0).normalize();
      const ahead = this.camera.position.clone().addScaledVector(fwd, 18 + Math.random() * 10);
      const dir = Math.random() < 0.5 ? 1 : -1;
      this.zombieStart.set(ahead.x, 0, -10 * dir);
      this.zombieEnd.set(ahead.x + (Math.random() - 0.5) * 6, 0, 10 * dir);
      this.zombieProgress = 0;
      this.zombieActive = true;
      this.groaned = false;
      this.zombie.setVisible(true);
    }
    const len = this.zombieStart.distanceTo(this.zombieEnd);
    const speed = 0.85;
    this.zombieProgress += (speed * dt) / len;
    const p = this.zombieStart.clone().lerp(this.zombieEnd, this.zombieProgress);
    p.y = Math.abs(p.z) > 4.5 && Math.abs(p.z) < 7 ? 0.15 : 0;
    this.zombie.root.position.copy(p);
    const d = this.zombieEnd.clone().sub(this.zombieStart);
    this.zombie.root.rotation.y = Math.atan2(d.x, d.z);
    this.zombie.update(dt, { speed, crouch: 0, aim: 0, grounded: true, strafe: 0 });
    this.probe?.update(dt, p, this.camera);
    if (!this.groaned && this.zombieProgress > 0.35) {
      this.groaned = true;
      audio.groan(p.clone().setY(1.6), 0.8);
    }
    if (this.zombieProgress >= 1) {
      this.zombieActive = false;
      this.zombie.setVisible(false);
      this.nextZombie = 14 + Math.random() * 10;
    }
  }

  setActive(active: boolean): void {
    if (!active) {
      this.zombie.setVisible(false);
      this.zombieActive = false;
      this.nextZombie = 6;
    }
  }

  dispose(): void {
    this.zombie.dispose();
  }
}
