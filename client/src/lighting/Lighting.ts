import * as THREE from 'three';
import { settings } from '../core/Settings';

/** Direction toward the moon: low in the south-west so street-facing facades catch grazing light. */
export const MOON_DIR = new THREE.Vector3(-0.7, 0.5, 0.5).normalize();

/**
 * Night lighting rig: cold moonlight key with a camera-following shadow frustum,
 * hemisphere fill, and a lightning controller that drives sky/scene flashes and thunder.
 */
export class Lighting {
  readonly moon: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly moonDir = MOON_DIR.clone();
  private readonly moonBase = 1.35;
  private readonly hemiBase = 1.0;
  flash = 0;
  /** No lightning while set (snow over the holiday menu is quiet); storms resume a while after. */
  calm = false;
  private nextStrike = 12 + Math.random() * 18;
  private strikeQueue: { at: number; power: number }[] = [];
  private time = 0;
  onThunder: ((delay: number, power: number) => void) | null = null;
  private shadowSize = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.hemi = new THREE.HemisphereLight(0x4a5a78, 0x1c1e16, this.hemiBase);
    scene.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0x9db2d4, this.moonBase);
    this.moon.castShadow = true;
    const cam = this.moon.shadow.camera;
    cam.left = -38; cam.right = 38; cam.top = 38; cam.bottom = -38;
    cam.near = 1; cam.far = 160;
    this.moon.shadow.bias = -0.0004;
    this.moon.shadow.normalBias = 0.04;
    this.moon.shadow.radius = 3;
    scene.add(this.moon, this.moon.target);
  }

  setShadowSize(size: number, renderer: THREE.WebGLRenderer): void {
    if (size === this.shadowSize) return;
    this.shadowSize = size;
    renderer.shadowMap.enabled = size > 0;
    this.moon.castShadow = size > 0;
    if (size > 0) {
      this.moon.shadow.mapSize.set(size, size);
      this.moon.shadow.map?.dispose();
      this.moon.shadow.map = null;
    }
    // Materials must recompile when shadows toggle.
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
  }

  /** Keeps the shadow frustum centered on what the camera is looking at, snapped to texels to avoid shimmer. */
  follow(focus: THREE.Vector3): void {
    const texel = (76 / Math.max(this.shadowSize, 512));
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.moon.target.position.set(fx, 0, fz);
    this.moon.position.set(fx + this.moonDir.x * 80, this.moonDir.y * 80, fz + this.moonDir.z * 80);
  }

  /**
   * Readies every shadow-depth program for a frame drawn behind the loading card, until the returned function puts
   * things back. three compiles a depth program for a caster only when it picks one, and it picks one only when the
   * caster comes into a shadow camera right after a caster of another kind (instanced, skinned, mapped, alpha-tested):
   * which pairs meet depends on what the camera holds, so walking up to the park's iron fence compiled two mid-night.
   * The moon's shadow is stretched over the whole map and every caster picks its own program.
   */
  warmShadows(area: { x0: number; x1: number; z0: number; z1: number }): () => void {
    const proto = THREE.Object3D.prototype;
    const hook = proto.onBeforeShadow;
    proto.onBeforeShadow = function (this: THREE.Object3D, ...args: Parameters<THREE.Object3D['onBeforeShadow']>) {
      args[5].needsUpdate = true;
      hook.apply(this, args);
    };
    const cam = this.moon.shadow.camera;
    const was = { l: cam.left, r: cam.right, t: cam.top, b: cam.bottom, far: cam.far, pos: this.moon.position.clone(), at: this.moon.target.position.clone() };
    const cx = (area.x0 + area.x1) / 2, cz = (area.z0 + area.z1) / 2;
    const half = Math.hypot(area.x1 - area.x0, area.z1 - area.z0) / 2 + 10;
    this.moon.target.position.set(cx, 0, cz);
    this.moon.position.set(cx + this.moonDir.x * (half + 80), this.moonDir.y * (half + 80), cz + this.moonDir.z * (half + 80));
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.far = 2 * half + 160;
    cam.updateProjectionMatrix();
    return () => {
      proto.onBeforeShadow = hook;
      cam.left = was.l; cam.right = was.r; cam.top = was.t; cam.bottom = was.b; cam.far = was.far;
      cam.updateProjectionMatrix();
      this.moon.position.copy(was.pos);
      this.moon.target.position.copy(was.at);
    };
  }

  update(dt: number): void {
    this.time += dt;
    if (this.calm) this.nextStrike = Math.max(this.nextStrike, this.time + 10);
    if (this.time > this.nextStrike) {
      const strikes = 1 + Math.floor(Math.random() * 3);
      let at = this.time;
      for (let i = 0; i < strikes; i++) {
        this.strikeQueue.push({ at, power: 0.6 + Math.random() * 0.4 });
        at += 0.08 + Math.random() * 0.18;
      }
      this.onThunder?.(1.2 + Math.random() * 3, 0.5 + Math.random() * 0.5);
      this.nextStrike = this.time + 18 + Math.random() * 35;
    }
    while (this.strikeQueue.length && this.strikeQueue[0].at <= this.time) {
      this.flash = Math.max(this.flash, this.strikeQueue.shift()!.power);
    }
    this.flash = Math.max(0, this.flash - dt * 6);
    const k = settings.value.accessibility.reducedFlashing ? 0.2 : 1;
    const f = this.flash * k;
    this.hemi.intensity = this.hemiBase + f * 2.2;
    this.moon.intensity = this.moonBase + f * 1.5;
  }
}
