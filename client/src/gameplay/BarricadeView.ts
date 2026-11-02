import * as THREE from 'three';
import { STORY, rng, type BarricadeSlot, type Simulation } from '@dead-hours/shared';
import type { LightField } from '../lighting/LightField';
import { StaticProbe } from '../lighting/Probes';
import { patchProbe } from '../lighting/BakeShader';

const PLANK_H = 0.17;
const PLANK_D = 0.035;

interface SlotView {
  slot: BarricadeSlot;
  group: THREE.Group;
  planks: THREE.Mesh[];
  /** Where each plank rests when it is not being pounded on. */
  rest: { y: number; roll: number; slide: number }[];
  pane: THREE.Mesh | null;
  probe: StaticProbe;
  boards: number;
  glass: boolean;
  damage: number;
  /** Shudder after a blow (seconds left). */
  shake: number;
}

/**
 * Boards nailed across the inside of doors and windows, and the panes of the windows that can
 * be smashed. Follows the simulation's barricade state (solo, or the server's copy online).
 */
export class BarricadeView {
  private readonly root = new THREE.Group();
  private readonly views: SlotView[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(scene: THREE.Scene, sim: Simulation, field: LightField) {
    scene.add(this.root);
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.18, depthWrite: false });
    this.materials.push(glass);
    const woods = [0x6e5638, 0x5c4630, 0x7a6244, 0x52402c];
    for (const slot of sim.barricades.slots) {
      const group = new THREE.Group();
      group.position.set(slot.center.x, slot.center.y, slot.center.z);
      // Local +X along the wall, +Z into the room.
      group.rotation.y = Math.atan2(-slot.normal.x, -slot.normal.z);
      this.root.add(group);
      const inward = new THREE.Vector3(-slot.normal.x, 0, -slot.normal.z);
      const probe = new StaticProbe(field, new THREE.Vector3(slot.center.x, slot.center.y, slot.center.z), inward);
      const rand = rng(slot.index * 7919 + 17);
      const mat = new THREE.MeshStandardMaterial({ color: woods[slot.index % woods.length], roughness: 0.88, flatShading: true });
      patchProbe(mat, probe.uniforms);
      this.materials.push(mat);
      const face = STORY.wall / 2 + 0.02 + PLANK_D / 2;
      const planks: THREE.Mesh[] = [];
      const rest: SlotView['rest'] = [];
      for (let i = 0; i < slot.max; i++) {
        const len = slot.width + 0.3 + rand() * 0.15;
        const g = new THREE.BoxGeometry(len, PLANK_H, PLANK_D);
        this.geometries.push(g);
        const m = new THREE.Mesh(g, mat);
        m.castShadow = m.receiveShadow = true;
        const u = slot.max > 1 ? i / (slot.max - 1) : 0.5;
        // Spread over the opening, the first across the middle, each a little askew.
        const order = [0.5, 0.15, 0.85, 0.32, 0.68][i] ?? u;
        const y = -slot.height / 2 + slot.height * (0.12 + 0.76 * order);
        const roll = (rand() - 0.5) * 0.32;
        const slide = (rand() - 0.5) * 0.12;
        m.position.set(slide, y, face + i * 0.004);
        m.rotation.z = roll;
        m.visible = false;
        group.add(m);
        planks.push(m);
        rest.push({ y, roll, slide });
      }
      let pane: THREE.Mesh | null = null;
      if (slot.kind === 'window') {
        const g = new THREE.BoxGeometry(slot.width, slot.height, 0.02);
        this.geometries.push(g);
        pane = new THREE.Mesh(g, glass);
        pane.renderOrder = 2;
        group.add(pane);
      }
      this.views.push({ slot, group, planks, rest, pane, probe, boards: 0, glass: true, damage: 0, shake: 0 });
    }
  }

  /** A blow landed on the slot's boards: they shudder. */
  hit(slot: number): void {
    const v = this.views[slot];
    if (v) v.shake = 0.35;
  }

  update(dt: number, camera: THREE.Camera): void {
    for (const v of this.views) {
      const s = v.slot;
      if (v.pane && v.glass !== s.glass) {
        v.glass = s.glass;
        v.pane.visible = s.glass;
      }
      if (s.boards === 0 && v.boards === 0 && v.shake <= 0) continue;
      if (v.boards !== s.boards) {
        v.boards = s.boards;
        for (let i = 0; i < v.planks.length; i++) v.planks[i].visible = i < s.boards;
      }
      v.probe.update(camera);
      v.shake = Math.max(0, v.shake - dt);
      // The outermost board works loose as it is pounded.
      const top = s.boards - 1;
      const loose = top >= 0 ? s.damage : 0;
      for (let i = 0; i <= top; i++) {
        const p = v.planks[i], r = v.rest[i];
        const k = i === top ? loose : 0;
        const jitter = v.shake > 0 ? Math.sin(v.shake * 90 + i) * 0.012 * (v.shake / 0.35) : 0;
        p.rotation.z = r.roll + k * 0.45 * Math.sign(r.roll || 1);
        p.position.y = r.y - k * 0.06 + jitter;
        p.position.x = r.slide + jitter * 0.5;
      }
    }
  }

  /** Nearest slot centre within `maxDist` of a point (among those `ok` allows). */
  nearest(pos: THREE.Vector3, maxDist: number, ok?: (slot: BarricadeSlot) => boolean): BarricadeSlot | null {
    let best: BarricadeSlot | null = null;
    let bestD = maxDist;
    for (const v of this.views) {
      const c = v.slot.center;
      const d = Math.hypot(c.x - pos.x, (c.y - pos.y) * 0.5, c.z - pos.z);
      if (d < bestD && (!ok || ok(v.slot))) {
        bestD = d;
        best = v.slot;
      }
    }
    return best;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
