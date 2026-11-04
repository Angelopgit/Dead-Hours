import * as THREE from 'three';
import { BUILD_SLOTS, WEAPONS, fitsOf, type BuildSlot, type WeaponBuild, type WeaponId } from '@dead-hours/shared';
import { createWeaponModel, type WeaponModel } from './WeaponModels';

/** A fitting's spot on screen (CSS pixels inside the rectangle given), for the gunsmith's labels. */
export interface Hotspot {
  slot: BuildSlot;
  x: number;
  y: number;
  /** In front of the camera and inside the view. */
  visible: boolean;
}

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
/** Drawn after the world (see the overlay option). */
const OVERLAY_ORDER = 50;

/**
 * A gun held up for customizing: shown side-on, turned by dragging, rebuilt the moment a
 * fitting is previewed or applied. The `holder` goes wherever the caller wants it (in front of
 * the game camera in the field and over the workbench, on the armory's own turntable in the
 * menu); `hotspots()` says where each fitting sits on screen for the clickable labels.
 */
export class GunsmithStage {
  readonly holder = new THREE.Group();
  private readonly spin = new THREE.Group();
  private model: WeaponModel | null = null;
  /** The second gun of an akimbo pair, shown behind the first (both carry the same build). */
  private twin: WeaponModel | null = null;
  private yaw = 0;
  private yawTarget = 0;
  private pitch = 0;
  private pitchTarget = 0;
  private drag: { x: number; y: number } | null = null;
  private dragged = 0;
  /** Bounding radius of the gun on show (callers frame it by this). */
  radius = 0.5;
  /** New materials (light probe patching in the game world). */
  onMaterials: ((m: THREE.Material[]) => void) | null = null;

  /**
   * overlay: drawn over the world (held up in front of the game camera, where the player's own
   * body, walls and the workbench would otherwise cut through it). Gun and an invisible mesh that
   * clears the depth buffer go in the transparent pass (still fully opaque and depth-writing), ordered
   * after every world object there, so smoke and particles keep their own occlusion first.
   */
  constructor(private readonly overlay = false) {
    // Side-on: the barrel points to the right of the screen.
    this.spin.rotation.y = Math.PI / 2;
    this.holder.add(this.spin);
    if (overlay) {
      const clear = new THREE.Mesh(new THREE.PlaneGeometry(0.001, 0.001), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, transparent: true }));
      clear.frustumCulled = false;
      clear.renderOrder = OVERLAY_ORDER - 1;
      clear.onBeforeRender = (renderer) => renderer.clearDepth();
      this.holder.add(clear);
    }
  }

  get current(): WeaponModel | null {
    return this.model;
  }

  /** Shows a gun with a build (only rebuilt when something changed). */
  show(id: WeaponId, build: WeaponBuild): void {
    const m = this.model;
    if (m && m.id === id && m.build && BUILD_SLOTS.every((s) => m.build[s] === build[s])) return;
    const fresh = createWeaponModel(id, build);
    // A pair: the left-hand gun (mirrored, like the one in the game) set behind the right one and
    // high enough that the right one's optic still shows against it, barrels the same way.
    const twin = WEAPONS[id].hold === 'akimbo' ? createWeaponModel(id, build) : null;
    if (twin) {
      twin.root.scale.x = -1;
      twin.root.position.set(0.07, 0.115, -0.035);
      fresh.root.add(twin.root);
      fresh.root.updateMatrixWorld(true);
    }
    // Turn about the middle of the gun, not the grip.
    const box = new THREE.Box3().setFromObject(fresh.root);
    const center = box.getCenter(new THREE.Vector3());
    fresh.root.position.copy(center).negate();
    this.radius = box.getSize(new THREE.Vector3()).length() / 2;
    if (this.overlay) {
      fresh.root.traverse((o) => {
        o.renderOrder = OVERLAY_ORDER;
        o.castShadow = false;
        if (o instanceof THREE.Mesh) for (const mat of [o.material].flat() as THREE.Material[]) mat.transparent = true;
      });
    }
    if (m) m.dispose();
    this.twin?.dispose();
    this.model = fresh;
    this.twin = twin;
    this.spin.add(fresh.root);
    this.onMaterials?.(fresh.materials);
    if (twin) this.onMaterials?.(twin.materials);
  }

  /** Pointer handlers for dragging the gun around (attach to whatever element receives the clicks). */
  pointerDown(e: PointerEvent): void {
    this.drag = { x: e.clientX, y: e.clientY };
    this.dragged = 0;
  }

  pointerMove(e: PointerEvent): void {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag = { x: e.clientX, y: e.clientY };
    this.dragged += Math.abs(dx) + Math.abs(dy);
    this.yawTarget += dx * 0.012;
    this.pitchTarget = THREE.MathUtils.clamp(this.pitchTarget + dy * 0.008, -0.9, 0.9);
  }

  /** A controller's right stick turning it (radians this frame, as the stick leans times the frame's time). */
  turnBy(dx: number, dy: number): void {
    this.yawTarget += dx * 3.2;
    this.pitchTarget = THREE.MathUtils.clamp(this.pitchTarget + dy * 2, -0.9, 0.9);
  }

  /** True when the pointer went up after a drag (not a click). */
  pointerUp(): boolean {
    const was = this.drag !== null && this.dragged > 6;
    this.drag = null;
    return was;
  }

  /** Turns to face a fitting (the muzzle swings toward the viewer a little, the skin shows the side). */
  face(slot: BuildSlot): void {
    const yaw: Record<BuildSlot, number> = { optic: -0.35, muzzle: 0.55, grip: -0.2, mag: -0.15, skin: 0 };
    const pitch: Record<BuildSlot, number> = { optic: 0.35, muzzle: 0, grip: -0.3, mag: -0.25, skin: 0 };
    const k = Math.round((this.yawTarget - yaw[slot]) / (Math.PI * 2));
    this.yawTarget = yaw[slot] + k * Math.PI * 2;
    this.pitchTarget = pitch[slot];
  }

  update(dt: number, idleSpin = 0): void {
    if (!this.drag) this.yawTarget += idleSpin * dt;
    const k = 1 - Math.exp(-dt * 8);
    this.yaw += (this.yawTarget - this.yaw) * k;
    this.pitch += (this.pitchTarget - this.pitch) * k;
    this.holder.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /** Where each fitting the gun takes is on screen. */
  hotspots(camera: THREE.Camera, width: number, height: number): Hotspot[] {
    const m = this.model;
    if (!m) return [];
    m.root.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    const out: Hotspot[] = [];
    camera.getWorldPosition(_c);
    for (const slot of BUILD_SLOTS) {
      const p = m.points[slot];
      if (!p || fitsOf(m.id, slot).length < 2) continue;
      m.root.localToWorld(_v.copy(p));
      const ahead = _v.clone().sub(_c).dot(camera.getWorldDirection(new THREE.Vector3())) > 0;
      _v.project(camera);
      out.push({ slot, x: (_v.x * 0.5 + 0.5) * width, y: (-_v.y * 0.5 + 0.5) * height, visible: ahead && Math.abs(_v.x) < 1 && Math.abs(_v.y) < 1 });
    }
    return out;
  }

  dispose(): void {
    this.holder.traverse((o) => {
      if (o instanceof THREE.Mesh && o.parent === this.holder) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.twin?.dispose();
    this.twin = null;
    this.model?.dispose();
    this.model = null;
    this.holder.removeFromParent();
  }
}
