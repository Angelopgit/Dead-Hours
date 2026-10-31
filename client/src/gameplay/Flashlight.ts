import * as THREE from 'three';
import type { ShadowQuality } from '../core/Settings';
import { weatherUniforms } from '../lighting/WetShader';

const INTENSITY = 95;
const RANGE = 30;
const ANGLE = 0.36;

/**
 * The survivor's weapon light. It lives in the scene from boot at zero intensity (adding a light
 * later would recompile every material), lights the world as a real spot, casts shadows when the
 * shadow setting allows, and also drives the rain glints and the volumetric beam.
 */
export class Flashlight {
  readonly light = new THREE.SpotLight(0xffe9cf, 0, RANGE, ANGLE, 0.6, 1.45);
  /** The player's switch (L). */
  on = true;
  private level = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.light.name = 'flashlight';
    this.light.shadow.camera.near = 0.45;
    this.light.shadow.camera.far = RANGE;
    this.light.shadow.bias = -0.0006;
    this.light.shadow.normalBias = 0.03;
    this.light.userData.fogScale = 0.55;
    scene.add(this.light, this.light.target);
  }

  /** Shadows cost a depth render of the scene: only on medium and high. */
  setShadows(q: ShadowQuality): void {
    const cast = q === 'medium' || q === 'high';
    this.light.castShadow = cast;
    // Draw the map once even while the light is off: materials compiled for a shadowed spot
    // sample it, and an unrendered (missing) map binds the wrong texture type.
    this.light.shadow.needsUpdate = true;
    if (cast) {
      const size = q === 'high' ? 1024 : 512;
      if (this.light.shadow.mapSize.x !== size) {
        this.light.shadow.mapSize.set(size, size);
        this.light.shadow.map?.dispose();
        this.light.shadow.map = null;
      }
    }
  }

  get lit(): boolean {
    return this.level > 0.01;
  }

  /** active: in play and alive. origin/dir: where the light sits and points. */
  update(dt: number, active: boolean, origin: THREE.Vector3, dir: THREE.Vector3): void {
    const target = active && this.on ? 1 : 0;
    // A click on, a short fade off.
    this.level = target > this.level ? target : Math.max(target, this.level - dt * 6);
    this.light.intensity = INTENSITY * this.level;
    // Hiding a light would change the light count and recompile every material: dim it instead,
    // and stop redrawing its shadow map while it is off.
    this.light.shadow.autoUpdate = this.level > 0.001;
    this.light.position.copy(origin);
    this.light.target.position.copy(this.tmp.copy(origin).addScaledVector(dir, 10));
    this.light.updateMatrixWorld();
    this.light.target.updateMatrixWorld();
    const u = weatherUniforms;
    u.uTorchPos.value.set(origin.x, origin.y, origin.z, this.level > 0.01 ? 1 : 0);
    u.uTorchDir.value.set(dir.x, dir.y, dir.z, Math.cos(ANGLE));
    const c = this.light.color;
    u.uTorchCol.value.set(c.r, c.g, c.b).multiplyScalar(this.light.intensity * 0.25);
  }
}

let current: Flashlight | null = null;

/** The one flashlight (made at boot by Game, driven by the play session). */
export function setFlashlight(f: Flashlight | null): void {
  current = f;
}

export function flashlight(): Flashlight | null {
  return current;
}
