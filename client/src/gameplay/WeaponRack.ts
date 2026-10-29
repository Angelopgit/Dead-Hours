import * as THREE from 'three';
import { PRIMARY_WEAPONS, type PropSpec, type WeaponId } from '@dead-hours/shared';
import { createWeaponModel, type WeaponModel } from '../weapons/WeaponModels';
import type { LightField } from '../lighting/LightField';
import { StaticProbe } from '../lighting/Probes';
import { patchProbe } from '../lighting/BakeShader';

/** Bench-local layout: two rows of two, barrels toward +X, lying on their left side. */
const SLOTS: [number, number][] = [[-0.62, 0.17], [0.38, 0.17], [-0.62, -0.15], [0.38, -0.15]];

/**
 * The garage weapon table: the four primaries laid out on the workbench as real models, a
 * highlight for the one under the cursor, and the camera pose used while choosing.
 */
export class WeaponRack {
  readonly root = new THREE.Group();
  private readonly models = new Map<WeaponId, WeaponModel>();
  private readonly probe: StaticProbe;
  private highlighted: WeaponId | null = null;
  /** Camera pose looking down at the bench (world space). */
  readonly view: { position: THREE.Vector3; target: THREE.Vector3 };

  constructor(scene: THREE.Scene, bench: PropSpec, field: LightField) {
    this.root.position.set(bench.x, bench.y ?? 0, bench.z);
    this.root.rotation.y = bench.rotY ?? 0;
    scene.add(this.root);
    const lie = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)),
    );
    this.root.updateMatrixWorld(true);
    const center = this.root.localToWorld(new THREE.Vector3(0, 1.1, 0.2));
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.quaternion);
    this.probe = new StaticProbe(field, center, normal, 0.4);
    PRIMARY_WEAPONS.forEach((id, i) => {
      const m = createWeaponModel(id);
      const [x, z] = SLOTS[i];
      m.root.quaternion.copy(lie);
      // Model center sits ~0.2 m ahead of the grip.
      m.root.position.set(x - 0.15, 0.965, z);
      for (const mat of m.materials) patchProbe(mat, this.probe.uniforms);
      this.root.add(m.root);
      this.models.set(id, m);
    });
    // Looking down at ~36° from 2.9 m, aimed right of the layout so the weapons sit in the
    // left half of the screen, clear of the selection panel on the right.
    this.view = {
      position: this.root.localToWorld(new THREE.Vector3(1.0, 2.66, 2.35)),
      target: this.root.localToWorld(new THREE.Vector3(1.0, 0.95, 0.0)),
    };
  }

  /** Which weapon model a screen ray points at (for hover/click on the table). */
  pick(raycaster: THREE.Raycaster): WeaponId | null {
    let best: WeaponId | null = null;
    let bestD = Infinity;
    for (const [id, m] of this.models) {
      const hits = raycaster.intersectObject(m.root, true);
      if (hits.length && hits[0].distance < bestD) {
        bestD = hits[0].distance;
        best = id;
      }
    }
    return best;
  }

  highlight(id: WeaponId | null, carried: WeaponId): void {
    this.highlighted = id;
    for (const [wid, m] of this.models) {
      const on = wid === id;
      for (const mat of m.materials) {
        mat.emissive.setHex(on ? 0x5a3c18 : wid === carried ? 0x10160c : 0x000000);
        mat.emissiveIntensity = on ? 0.6 : 1;
      }
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    this.probe.update(camera);
    for (const [id, m] of this.models) {
      const target = id === this.highlighted ? 0.995 : 0.965;
      m.root.position.y += (target - m.root.position.y) * (1 - Math.exp(-dt * 12));
    }
  }

  dispose(): void {
    for (const m of this.models.values()) m.dispose();
    this.root.removeFromParent();
  }
}
