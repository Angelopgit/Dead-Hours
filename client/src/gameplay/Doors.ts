import * as THREE from 'three';
import { createDoorBodies, type DoorBody, type MapDefinition } from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import type { LightField } from '../lighting/LightField';
import { StaticProbe } from '../lighting/Probes';
import { patchProbe } from '../lighting/BakeShader';
import { DoorDamage, pieceCenter } from './DoorDamage';

/** Paint on the wooden leaves (sRGB), and the raised panels' shade of it. */
const WOOD_PAINT: [number, number, number] = [0x3a, 0x2a, 0x1e];
const PANEL_PAINT = 0x30231a;
let plainWood: THREE.DataTexture | null = null;

/**
 * Exterior doors of enterable buildings. Each leaf is a kinematic Rapier body so the
 * character controller (and later zombies) collide with it while it moves. Hinged doors
 * swing away from whoever opens them; roll-up garage doors slide up into the header.
 * Barricading/reinforcement attaches to these in Phase 6.
 */
const tmp = new THREE.Vector3();

export class Door {
  readonly pivot = new THREE.Group();
  readonly center: THREE.Vector3;
  private readonly baseYaw: number;
  private readonly rollup: boolean;
  private shownAngle = NaN;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private probe: StaticProbe | null = null;
  private rollupPanel: THREE.Group | null = null;
  /** Wooden leaves: the slab's and panels' materials, which show the damage. */
  private readonly woodMats: THREE.MeshStandardMaterial[] = [];
  private damage: DoorDamage | null = null;
  private shownPieces = 0;
  /** Called for each piece knocked out while the door is shown (not by `settle`). */
  onPiece: ((door: Door, k: number) => void) | null = null;

  constructor(readonly body: DoorBody, parent: THREE.Object3D) {
    const spec = body.spec;
    const style = spec.style ?? 'wood';
    this.rollup = body.rollup;
    // Leaf extends from the hinge along the wall; the body owns the hinge and the swing.
    this.baseYaw = body.baseYaw;
    this.pivot.position.set(body.hinge.x, body.hinge.y, body.hinge.z);
    this.pivot.rotation.y = this.baseYaw;
    const mat = (color: number, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true, ...extra });
      this.materials.push(m);
      return m;
    };
    const part = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parentObj: THREE.Object3D = this.pivot) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = true;
      parentObj.add(mesh);
      return mesh;
    };
    const thickness = body.thickness;

    if (style === 'wood') {
      // Slab and panels share one damage texture mapped flat across the leaf (see DoorDamage), so
      // holes go through them all; until the door is hurt it is a plain one of the paint colour.
      plainWood ??= DoorDamage.plain(WOOD_PAINT);
      const base = new THREE.Color().setRGB(WOOD_PAINT[0] / 255, WOOD_PAINT[1] / 255, WOOD_PAINT[2] / 255, THREE.SRGBColorSpace);
      const shade = new THREE.Color(PANEL_PAINT);
      const wood = (roughness: number, tint: THREE.Color) => {
        const m = mat(0xffffff, roughness, 0, { map: plainWood, alphaTest: 0.5, side: THREE.DoubleSide });
        m.color.copy(tint);
        this.woodMats.push(m);
        return m;
      };
      const flat = (mesh: THREE.Mesh) => {
        const pos = mesh.geometry.getAttribute('position'), uv = mesh.geometry.getAttribute('uv');
        for (let i = 0; i < pos.count; i++) uv.setXY(i, (mesh.position.x + pos.getX(i)) / spec.w, (mesh.position.y + pos.getY(i)) / spec.h);
        uv.needsUpdate = true;
      };
      flat(part(new THREE.BoxGeometry(spec.w - 0.04, spec.h - 0.02, thickness), wood(0.7, new THREE.Color(1, 1, 1)), spec.w / 2, spec.h / 2, 0));
      const panel = wood(0.75, new THREE.Color(shade.r / base.r, shade.g / base.g, shade.b / base.b));
      for (const py of [0.55, 1.55]) for (const side of [-1, 1]) flat(part(new THREE.BoxGeometry(spec.w * 0.7, 0.7, 0.02), panel, spec.w / 2, py, side * (thickness / 2 + 0.005)));
      const knob = mat(0x8d7a4a, 0.3, 0.9);
      for (const side of [-1, 1]) part(new THREE.SphereGeometry(0.035, 8, 6), knob, spec.w - 0.12, 1.0, side * 0.06);
    } else if (style === 'glass') {
      const frame = mat(0x2a2c2e, 0.45, 0.6);
      const fw = 0.08;
      part(new THREE.BoxGeometry(spec.w - 0.04, fw, thickness), frame, spec.w / 2, spec.h - fw / 2, 0);
      part(new THREE.BoxGeometry(spec.w - 0.04, 0.22, thickness), frame, spec.w / 2, 0.11, 0);
      for (const x of [fw / 2 + 0.02, spec.w - fw / 2 - 0.02]) part(new THREE.BoxGeometry(fw, spec.h, thickness), frame, x, spec.h / 2, 0);
      const glass = new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.2, depthWrite: false });
      this.materials.push(glass);
      const pane = part(new THREE.BoxGeometry(spec.w - 0.2, spec.h - 0.32, 0.015), glass, spec.w / 2, spec.h / 2 + 0.07, 0);
      pane.castShadow = false;
      part(new THREE.BoxGeometry(0.03, 0.5, 0.05), mat(0x9a9a96, 0.3, 0.8), spec.w - 0.16, 1.05, 0.05);
      part(new THREE.BoxGeometry(spec.w * 0.5, 0.12, 0.005), mat(0x8c1c18, 0.6), spec.w / 2, 1.45, thickness / 2 + 0.008);
    } else {
      // Roll-up door: horizontal slats in a panel that slides up.
      const panel = new THREE.Group();
      this.pivot.add(panel);
      this.rollupPanel = panel;
      const slat = mat(0x8a877e, 0.55, 0.3);
      const seam = mat(0x3a3a38, 0.7);
      const n = Math.round(spec.h / 0.25);
      for (let i = 0; i < n; i++) {
        part(new THREE.BoxGeometry(spec.w - 0.02, spec.h / n - 0.015, thickness), slat, spec.w / 2, (i + 0.5) * (spec.h / n), 0, panel);
        part(new THREE.BoxGeometry(spec.w - 0.02, 0.012, thickness + 0.01), seam, spec.w / 2, i * (spec.h / n), 0, panel);
      }
      part(new THREE.BoxGeometry(0.3, 0.05, 0.05), mat(0x2a2a2a, 0.5, 0.6), spec.w / 2, 0.15, 0.06, panel);
    }
    parent.add(this.pivot);
    this.center = new THREE.Vector3(body.center.x, body.center.y, body.center.z);
  }

  get spec() {
    return this.body.spec;
  }

  get open(): boolean {
    return this.body.open;
  }

  /** Lights the leaf from the baked light field at the doorway. */
  applyProbe(field: LightField): void {
    const out = this.spec.axis === 'x' ? new THREE.Vector3(0, 0, this.spec.outward) : new THREE.Vector3(this.spec.outward, 0, 0);
    this.probe = new StaticProbe(field, this.center, out);
    for (const m of this.materials) patchProbe(m, this.probe.uniforms);
  }

  get kind(): 'hinged' | 'rollup' {
    return this.rollup ? 'rollup' : 'hinged';
  }

  /** Opens away from the user so the door never swings into the player. */
  toggle(from: THREE.Vector3): void {
    this.body.toggle(from.x, from.z);
  }

  /** A round through the leaf at a point in the world (its hole goes through both faces). */
  hole(at: THREE.Vector3, seed: number): void {
    if (!this.woodMats.length) return;
    this.pivot.updateWorldMatrix(true, false);
    const p = this.pivot.worldToLocal(tmp.copy(at));
    if (p.x < 0 || p.x > this.spec.w || p.y < 0 || p.y > this.spec.h) return;
    this.wreck().hole(p.x, p.y, seed);
  }

  /** The middle of piece `k` in the world. */
  pieceAt(k: number, out: THREE.Vector3): THREE.Vector3 {
    this.pivot.updateWorldMatrix(true, false);
    return this.pivot.localToWorld(pieceCenter(k, this.spec.w, out));
  }

  /** Shows the pieces already gone without anything flying (joining a night in progress). */
  settle(): void {
    const n = this.woodMats.length ? this.body.pieces : 0;
    if (n < this.shownPieces) this.mend();
    for (let k = this.shownPieces; k < n; k++) this.wreck().piece(k, this.body.index);
    this.shownPieces = n;
  }

  /** Paint back over every hole (a new night). */
  mend(): void {
    this.damage?.clear();
    this.damage?.flush();
    this.shownPieces = 0;
  }

  private wreck(): DoorDamage {
    if (!this.damage) {
      this.damage = new DoorDamage(this.spec.w, this.spec.h, WOOD_PAINT);
      for (const m of this.woodMats) m.map = this.damage.texture;
    }
    return this.damage;
  }

  /** Follows the physical leaf; `stepBody` advances it when no simulation owns the doors (menu). */
  update(dt: number, camera: THREE.Camera, stepBody: boolean): void {
    this.probe?.update(camera);
    if (stepBody) this.body.update(dt);
    const n = this.woodMats.length ? this.body.pieces : 0;
    if (n !== this.shownPieces) {
      if (n < this.shownPieces) this.mend();
      for (let k = this.shownPieces; k < n; k++) {
        this.wreck().piece(k, this.body.index);
        this.onPiece?.(this, k);
      }
      this.shownPieces = n;
    }
    this.damage?.flush();
    const a = this.body.angle;
    if (a === this.shownAngle) return;
    this.shownAngle = a;
    if (this.rollup) {
      // Slats fold into the header as the panel rises.
      const panel = this.rollupPanel!;
      panel.scale.y = Math.max(0.06, 1 - a);
      panel.position.y = this.spec.h * (1 - panel.scale.y);
      return;
    }
    this.pivot.rotation.y = this.baseYaw + a;
  }
}

export class DoorSystem {
  readonly doors: Door[] = [];
  /** Physical doors indexed like the map's door list (null where there is no leaf). */
  readonly bodies: (DoorBody | null)[];

  constructor(map: MapDefinition, physics: Physics, parent: THREE.Object3D) {
    this.bodies = createDoorBodies(map, physics);
    for (const b of this.bodies) if (b) this.doors.push(new Door(b, parent));
  }

  applyProbes(field: LightField): void {
    for (const d of this.doors) d.applyProbe(field);
  }

  nearest(pos: THREE.Vector3, maxDist: number): Door | null {
    let best: Door | null = null;
    let bestD = maxDist;
    for (const d of this.doors) {
      const dist = d.center.distanceTo(pos);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  }

  byIndex(index: number): Door | undefined {
    return this.doors.find((d) => d.body.index === index);
  }

  /** Closes every door instantly and mends them (new session). */
  reset(): void {
    for (const b of this.bodies) b?.reset();
    for (const d of this.doors) d.mend();
  }

  /** Shows every door's missing pieces as they are, quietly (joining a night in progress). */
  settle(): void {
    for (const d of this.doors) d.settle();
  }

  /** Called for each piece knocked out of a door while it is shown. */
  set onPiece(f: ((door: Door, k: number) => void) | null) {
    for (const d of this.doors) d.onPiece = f;
  }

  update(dt: number, camera: THREE.Camera, stepBodies = true): void {
    for (const d of this.doors) d.update(dt, camera, stepBodies);
  }
}
