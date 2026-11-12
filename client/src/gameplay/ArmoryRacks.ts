import * as THREE from 'three';
import type { Interactable, MapDefinition, PropSpec } from '@dead-hours/shared';
import { createWeaponModel, type WeaponModel } from '../weapons/WeaponModels';
import type { LightField } from '../lighting/LightField';
import { StaticProbe } from '../lighting/Probes';
import { patchProbe } from '../lighting/BakeShader';

/** Top of the shelf the butts stand on, and how far the guns lean back against the bar (radians). */
const SHELF = 0.325, LEAN = 0.09;

interface Rack {
  prop: PropSpec;
  root: THREE.Group;
  guns: WeaponModel[];
  probe: StaticProbe;
  /** Its interactable in the simulation (found by where it is), and how many guns were last shown. */
  item: number;
  shown: number;
}

/**
 * The guns standing in the armory's racks: one real model for each the rack still holds, butt on
 * the shelf, muzzle up. A gun taken is gone from the rack on every screen (the rack's `supply`).
 */
export class ArmoryRacks {
  private readonly racks: Rack[] = [];

  constructor(scene: THREE.Scene, map: MapDefinition, field: LightField) {
    for (const prop of map.props) {
      if (prop.kind !== 'gunRack' || !prop.weapon) continue;
      const root = new THREE.Group();
      root.position.set(prop.x, prop.y ?? 0, prop.z);
      root.rotation.y = prop.rotY;
      root.name = `rack:${prop.weapon}`;
      scene.add(root);
      root.updateMatrixWorld(true);
      const probe = new StaticProbe(field, root.localToWorld(new THREE.Vector3(0, 1.1, 0.25)), new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion), 0.4);
      const n = prop.stock ?? 2;
      const guns: WeaponModel[] = [];
      const box = new THREE.Box3();
      for (let i = 0; i < n; i++) {
        const m = createWeaponModel(prop.weapon);
        // Muzzle up, its left side to the room.
        m.root.rotation.set(-Math.PI / 2 + LEAN, 0, 0);
        m.root.rotation.order = 'YXZ';
        m.root.position.set(0, 0, 0);
        m.root.updateMatrixWorld(true);
        box.setFromObject(m.root);
        const x = n === 1 ? 0 : -0.72 + (1.44 * i) / (n - 1);
        m.root.position.set(x - (box.min.x + box.max.x) / 2, SHELF - box.min.y, 0.02 - (box.min.z + box.max.z) / 2);
        for (const mat of m.materials) patchProbe(mat, probe.uniforms);
        root.add(m.root);
        guns.push(m);
      }
      this.racks.push({ prop, root, guns, probe, item: -1, shown: n });
    }
  }

  get count(): number {
    return this.racks.length;
  }

  /** Every weapon material (for compiling before the night starts). */
  get materials(): THREE.Material[] {
    return this.racks.flatMap((r) => r.guns.flatMap((g) => g.materials));
  }

  /** Shows as many guns in each rack as the simulation says it still holds. */
  update(items: readonly (Interactable | undefined)[], camera: THREE.Camera): void {
    for (const r of this.racks) {
      if (r.item < 0) {
        r.item = items.findIndex((it) => !!it && it.kind === 'exclusive' && Math.abs(it.pos.x - r.prop.x) < 0.01 && Math.abs(it.pos.z - r.prop.z) < 0.01);
        if (r.item < 0) continue;
      }
      const left = Math.max(0, Math.min(r.guns.length, items[r.item]?.supply ?? 0));
      if (left !== r.shown) {
        r.shown = left;
        // The nearest to hand go first.
        r.guns.forEach((g, i) => { g.root.visible = i < left; });
      }
      r.probe.update(camera);
    }
  }

  /** A new night: the racks are looked up again (they are full again). */
  reset(): void {
    for (const r of this.racks) r.item = -1;
  }

  dispose(): void {
    for (const r of this.racks) {
      for (const g of r.guns) g.dispose();
      r.root.removeFromParent();
    }
    this.racks.length = 0;
  }
}
