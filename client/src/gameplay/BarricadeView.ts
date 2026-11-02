import * as THREE from 'three';
import { STORY, rng, type BarricadeSlot, type Simulation } from '@dead-hours/shared';
import type { LightField } from '../lighting/LightField';
import { StaticProbe } from '../lighting/Probes';
import { patchProbe } from '../lighting/BakeShader';
import { windowBars } from '../environment/Houses';
import { showPiece } from '../rendering/StaticBatcher';

const PLANK_H = 0.17;
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const PLANK_D = 0.035;

interface SlotView {
  slot: BarricadeSlot;
  group: THREE.Group;
  planks: THREE.Mesh[];
  /** Where each plank rests when it is not being pounded on. */
  rest: { y: number; roll: number; slide: number }[];
  probe: StaticProbe;
  boards: number;
  damage: number;
  /** Shudder after a blow (seconds left). */
  shake: number;
}

/**
 * Boards nailed across the inside of doors and windows, and the glass of every window of the
 * enterable buildings (one instanced mesh), which goes, frame bars and all, when it is smashed.
 * Follows the simulation's barricade state (solo, or the server's copy online).
 */
export class BarricadeView {
  private readonly root = new THREE.Group();
  /** Board views by slot index (openings that take boards). */
  private readonly views: SlotView[] = [];
  private readonly boarded: SlotView[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly panes: THREE.InstancedMesh;
  /** Window slots and the glass each pane shows (instance i is windows[i]). */
  private readonly windows: BarricadeSlot[];
  private readonly glassShown: boolean[];

  constructor(scene: THREE.Scene, sim: Simulation, field: LightField) {
    scene.add(this.root);
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.18, depthWrite: false });
    this.materials.push(glass);
    this.windows = sim.barricades.windows;
    this.glassShown = this.windows.map(() => true);
    const box = new THREE.BoxGeometry(1, 1, 0.02);
    this.geometries.push(box);
    this.panes = new THREE.InstancedMesh(box, glass, Math.max(1, this.windows.length));
    this.panes.count = this.windows.length;
    this.panes.renderOrder = 2;
    this.panes.castShadow = this.panes.receiveShadow = false;
    this.windows.forEach((_, i) => this.placePane(i, true));
    this.root.add(this.panes);
    // Frame bars a smashed window lost last time are back in.
    for (const bars of windowBars) for (const b of bars ?? []) showPiece(b, true);
    const woods = [0x6e5638, 0x5c4630, 0x7a6244, 0x52402c];
    for (const slot of sim.barricades.slots) {
      if (!sim.barricades.boardable(slot)) continue;
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
      const view: SlotView = { slot, group, planks, rest, probe, boards: 0, damage: 0, shake: 0 };
      this.views[slot.index] = view;
      this.boarded.push(view);
    }
  }

  /** Shows or hides window `i`'s pane (a zero-size instance when smashed). */
  private placePane(i: number, shown: boolean): void {
    const s = this.windows[i];
    const m = _m.makeRotationY(Math.atan2(-s.normal.x, -s.normal.z));
    if (shown) m.scale(_s.set(s.width, s.height, 1));
    else m.scale(_s.set(0, 0, 0));
    m.setPosition(s.center.x, s.center.y, s.center.z);
    this.panes.setMatrixAt(i, m);
    this.panes.instanceMatrix.addUpdateRange(i * 16, 16);
    this.panes.instanceMatrix.needsUpdate = true;
  }

  /** A blow landed on the slot's boards: they shudder. */
  hit(slot: number): void {
    const v = this.views[slot];
    if (v) v.shake = 0.35;
  }

  update(dt: number, camera: THREE.Camera): void {
    for (let i = 0; i < this.windows.length; i++) {
      const s = this.windows[i];
      if (this.glassShown[i] === s.glass) continue;
      this.glassShown[i] = s.glass;
      this.placePane(i, s.glass);
      // The sash bars break out with the glass.
      for (const b of windowBars[s.ref] ?? []) showPiece(b, s.glass);
    }
    for (const v of this.boarded) {
      const s = v.slot;
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

  /** Nearest opening that takes boards within `maxDist` of a point (among those `ok` allows). */
  nearest(pos: THREE.Vector3, maxDist: number, ok?: (slot: BarricadeSlot) => boolean): BarricadeSlot | null {
    let best: BarricadeSlot | null = null;
    let bestD = maxDist;
    for (const v of this.boarded) {
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
    this.panes.dispose();
    for (const bars of windowBars) for (const b of bars ?? []) showPiece(b, true);
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
