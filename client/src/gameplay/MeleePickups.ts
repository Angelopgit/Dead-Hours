import * as THREE from 'three';
import { MELEE_PICKUPS, isMelee, pickupYaw, type Interactable, type MeleeId, type Simulation } from '@dead-hours/shared';
import { createWeaponModel, type WeaponModel } from '../weapons/WeaponModels';
import type { LightField } from '../lighting/LightField';
import { StaticProbe } from '../lighting/Probes';
import { patchProbe } from '../lighting/BakeShader';

interface View {
  weapon: MeleeId;
  model: WeaponModel;
  probe: StaticProbe;
  glint: THREE.Sprite;
  /** Seconds into the glint cycle (each weapon catches the light at its own moment). */
  phase: number;
}

/** How far each weapon's model sits off the floor lying on its side (half its thickness), and where it catches the light. */
const LIE: Record<MeleeId, { y: number; roll: number; tip: [number, number, number] }> = {
  machete: { y: 0.012, roll: Math.PI / 2, tip: [0, 0.01, 0.5] },
  katana: { y: 0.042, roll: Math.PI / 2, tip: [0, 0.03, 0.72] },
  bat: { y: 0.034, roll: 0, tip: [0, 0.03, 0.6] },
  crowbar: { y: 0.016, roll: -Math.PI / 2, tip: [0, 0.08, 0.48] },
  wrench: { y: 0.017, roll: -Math.PI / 2, tip: [0, 0.07, 0.3] },
  // On the edge of its blade, the curve along the floor.
  hockey: { y: 0.018, roll: 0, tip: [0.1, 0.03, 0.98] },
};

let glintTexture: THREE.CanvasTexture | null = null;

/** A four-pointed star of light (shared by every glint). */
function glintMap(): THREE.CanvasTexture {
  if (glintTexture) return glintTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.12, 'rgba(255,248,230,0.8)');
  r.addColorStop(0.4, 'rgba(255,240,210,0.12)');
  r.addColorStop(1, 'rgba(255,240,210,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,250,235,0.55)';
  g.fillRect(30.5, 2, 3, 60);
  g.fillRect(2, 30.5, 60, 3);
  glintTexture = new THREE.CanvasTexture(c);
  glintTexture.colorSpace = THREE.SRGBColorSpace;
  return glintTexture;
}

/**
 * Found melee weapons lying where the simulation put them (a bedroom floor, a basement, the gas
 * station's store): each weapon's own model on its side, lit by the baked light around it, with
 * light now and then catching its edge so a sharp eye spots it in a dark room.
 */
export class MeleePickups {
  private readonly root = new THREE.Group();
  private readonly views = new Map<number, View>();
  private readonly seen = new Set<number>();
  private time = 0;

  constructor(scene: THREE.Scene, private readonly field: LightField) {
    this.root.name = 'melee-pickups';
    scene.add(this.root);
  }

  /** Adds weapons that turned up and removes ones taken, from the simulation's interactables. */
  update(dt: number, sim: Simulation, camera: THREE.Camera): void {
    this.time += dt;
    this.seen.clear();
    for (const it of sim.interactables) {
      if (!it || it.kind !== 'melee' || it.supply <= 0 || !it.weapon || !isMelee(it.weapon)) continue;
      this.seen.add(it.id);
      let v = this.views.get(it.id);
      if (!v || v.weapon !== it.weapon) {
        if (v) this.remove(it.id);
        v = this.create(it, it.weapon);
      }
      v.probe.update(camera);
      // Light catching the edge: a short flare every few seconds.
      const cycle = (this.time + v.phase) % 3.4;
      const k = cycle < 0.35 ? Math.sin((cycle / 0.35) * Math.PI) : 0;
      const d = camera.position.distanceTo(v.glint.getWorldPosition(_p));
      v.glint.visible = k > 0.01 && d < 22;
      if (v.glint.visible) {
        (v.glint.material as THREE.SpriteMaterial).opacity = k * 0.85;
        const s = 0.07 + 0.09 * k + Math.min(0.12, d * 0.006);
        v.glint.scale.set(s, s, s);
      }
    }
    for (const id of [...this.views.keys()]) if (!this.seen.has(id)) this.remove(id);
  }

  private create(it: Interactable, weapon: MeleeId): View {
    const model = createWeaponModel(weapon);
    const lie = LIE[weapon];
    const floorY = it.pos.y - MELEE_PICKUPS.lift;
    const r = model.root;
    // On its side on the floor, turned the way the simulation says (the same on every screen).
    const centre = model.muzzle.z / 2;
    const yaw = pickupYaw(it.id);
    const holder = new THREE.Group();
    holder.position.set(it.pos.x, floorY + lie.y, it.pos.z);
    holder.rotation.y = yaw;
    r.rotation.set(0, 0, lie.roll);
    r.position.set(0, 0, -centre);
    holder.add(r);
    for (const m of model.root.children) m.castShadow = m.receiveShadow = true;
    const probe = new StaticProbe(this.field, new THREE.Vector3(it.pos.x, floorY + 0.35, it.pos.z), new THREE.Vector3(), 0);
    for (const m of model.materials) patchProbe(m, probe.uniforms);
    const glint = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glintMap(), color: 0xfff2dc, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    }));
    glint.position.set(...lie.tip);
    glint.visible = false;
    r.add(glint);
    this.root.add(holder);
    const v: View = { weapon, model, probe, glint, phase: (it.id * 1.37) % 3.4 };
    this.views.set(it.id, v);
    return v;
  }

  private remove(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    const holder = v.model.root.parent;
    (v.glint.material as THREE.Material).dispose();
    v.model.dispose();
    holder?.removeFromParent();
    this.views.delete(id);
  }

  /** Where a lying weapon is drawn (the pick-up lifts it from there). */
  has(id: number): boolean {
    return this.views.has(id);
  }

  dispose(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
    this.root.removeFromParent();
  }
}

const _p = new THREE.Vector3();
