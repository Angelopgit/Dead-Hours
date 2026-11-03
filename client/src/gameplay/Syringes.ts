import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BOOSTS, boostYaw, type BoostId, type Interactable, type Simulation } from '@dead-hours/shared';
import type { LightField } from '../lighting/LightField';
import { StaticProbe } from '../lighting/Probes';
import { patchProbe } from '../lighting/BakeShader';
import { PICKUP_DRAW_RANGE } from '../environment/FogRange';

/** The model is drawn this much bigger than life, so it reads on a counter across a dark room. */
const SCALE = 0.86;
/** Barrel: half length and radius (metres, before SCALE). Local +Z is the needle end. */
const HALF = 0.05;
const RADIUS = 0.012;
/** How far the stopper travels from full to empty. */
const STROKE = 0.088;

let haloTexture: THREE.CanvasTexture | null = null;

/** A soft round glow (shared by every syringe's halo). */
function haloMap(): THREE.CanvasTexture {
  if (haloTexture) return haloTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,0.9)');
  r.addColorStop(0.18, 'rgba(255,255,255,0.45)');
  r.addColorStop(0.5, 'rgba(255,255,255,0.1)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  haloTexture = new THREE.CanvasTexture(c);
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  return haloTexture;
}

/**
 * A boost syringe: a white plastic barrel full of the dose's coloured liquid, a black rubber
 * stopper on a white plunger, a finger flange, and a needle under a cap in the dose's colour.
 * The liquid glows gently (never past the bloom knee). `setFill` pushes the plunger home.
 */
export class SyringeModel {
  readonly root = new THREE.Group();
  readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly liquidMat: THREE.MeshBasicMaterial;
  private readonly capMat: THREE.MeshStandardMaterial;
  private readonly hubMat: THREE.MeshStandardMaterial;
  private readonly liquid: THREE.Mesh;
  private readonly plunger = new THREE.Group();
  private readonly cap: THREE.Mesh;
  private readonly needle: THREE.Mesh;
  private readonly color = new THREE.Color();
  kind: BoostId;
  private fill = 1;

  constructor(kind: BoostId) {
    this.kind = kind;
    const white = this.mat(new THREE.MeshStandardMaterial({ color: 0xe4e6e2, roughness: 0.35, metalness: 0 }));
    const rubber = this.mat(new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.8, metalness: 0 }));
    const steel = this.mat(new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.25, metalness: 0.9 }));
    this.capMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.55, metalness: 0 }));
    this.hubMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.45, metalness: 0 }));
    this.liquidMat = this.mat(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    const along = (g: THREE.BufferGeometry) => g.rotateX(Math.PI / 2);
    const add = (g: THREE.BufferGeometry, m: THREE.Material, z: number, parent: THREE.Object3D = this.root) => {
      this.geometries.push(g);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.z = z;
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // Parts of one material that sit still together are one mesh (one draw): each piece moved to its place along Z.
    const at = (g: THREE.BufferGeometry, z: number) => g.translate(0, 0, z);
    const one = (parts: THREE.BufferGeometry[]) => {
      const g = mergeGeometries(parts, false)!;
      for (const p of parts) p.dispose();
      return g;
    };
    // The dose: a cylinder from the stopper face to the tip, shortened as the plunger goes in.
    this.liquid = add(along(new THREE.CylinderGeometry(RADIUS * 0.93, RADIUS * 0.93, 1, 12).translate(0, 0.5, 0)), this.liquidMat, -HALF);
    this.liquid.castShadow = false;
    // Barrel rims, the graduated end and the tip cone, and the finger flange across the open end.
    add(one([
      at(along(new THREE.CylinderGeometry(RADIUS, RADIUS, 0.008, 12)), -HALF + 0.004),
      at(along(new THREE.CylinderGeometry(RADIUS, RADIUS * 0.55, 0.012, 12)), HALF + 0.006),
      at(new THREE.BoxGeometry(0.046, 0.007, 0.004), -HALF - 0.002),
    ]), white, 0);
    // The dark rings round the barrel.
    const marks: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) marks.push(at(along(new THREE.CylinderGeometry(RADIUS * 1.01, RADIUS * 1.01, 0.0016, 12)), -0.02 + i * 0.02));
    add(one(marks), rubber, 0).castShadow = false;
    // Needle hub, needle and its cap.
    add(along(new THREE.CylinderGeometry(0.005, 0.0065, 0.012, 10)), this.hubMat, HALF + 0.018);
    this.needle = add(along(new THREE.CylinderGeometry(0.0007, 0.0007, 0.034, 6)), steel, HALF + 0.041);
    this.needle.castShadow = false;
    this.cap = add(along(new THREE.CylinderGeometry(0.0045, 0.0052, 0.038, 10)), this.capMat, HALF + 0.043);
    // Stopper, plunger rod (a cross) and thumb rest: they move together.
    add(along(new THREE.CylinderGeometry(RADIUS * 0.96, RADIUS * 0.96, 0.007, 12)), rubber, 0.0035, this.plunger);
    add(one([
      at(new THREE.BoxGeometry(0.0055, 0.0016, 0.064), -0.032),
      at(new THREE.BoxGeometry(0.0016, 0.0055, 0.064), -0.032),
      at(along(new THREE.CylinderGeometry(0.013, 0.013, 0.004, 12)), -0.066),
    ]), white, 0, this.plunger);
    this.root.add(this.plunger);
    this.root.scale.setScalar(SCALE);
    this.setKind(kind);
    this.setFill(1);
  }

  private mat<M extends THREE.Material>(m: M): M {
    this.materials.push(m);
    return m;
  }

  /** Recolours it for another dose. */
  setKind(kind: BoostId): void {
    this.kind = kind;
    this.color.setHex(BOOSTS[kind].color);
    this.capMat.color.copy(this.color);
    this.hubMat.color.copy(this.color).multiplyScalar(0.8);
    this.setGlow(0.8);
  }

  /** Brightness of the liquid (0..1; 1 stays just under the bloom knee). */
  setGlow(k: number): void {
    this.liquidMat.color.copy(this.color).multiplyScalar(0.25 + 0.6 * k);
  }

  /** 1 full, 0 the plunger all the way home. */
  setFill(f: number): void {
    this.fill = THREE.MathUtils.clamp(f, 0, 1);
    const stopper = -HALF + 0.004 + (1 - this.fill) * STROKE;
    this.plunger.position.z = stopper;
    this.liquid.position.z = stopper + 0.007;
    this.liquid.scale.z = Math.max(0.001, HALF - 0.002 - (stopper + 0.007));
    this.liquid.visible = this.fill > 0.01;
  }

  /** The needle's cap on or off. */
  setCap(on: boolean): void {
    this.cap.visible = on;
    this.needle.visible = !on;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

interface View {
  kind: BoostId;
  model: SyringeModel;
  probe: StaticProbe;
  halo: THREE.Sprite;
  pool: THREE.Mesh;
  phase: number;
}

const POOL = new THREE.CircleGeometry(0.14, 20).rotateX(-Math.PI / 2);

/**
 * Boost syringes lying where the simulation left them (counters, dressers, desks, sinks): each
 * syringe lit by the baked light around it, its dose glowing softly with a halo and a little pool
 * of coloured light on the furniture, breathing slowly, so a dark kitchen gives it away.
 */
export class SyringePickups {
  private readonly root = new THREE.Group();
  private readonly views = new Map<number, View>();
  private readonly seen = new Set<number>();
  private time = 0;

  constructor(scene: THREE.Scene, private readonly field: LightField) {
    this.root.name = 'boost-syringes';
    scene.add(this.root);
  }

  /** Adds syringes that turned up and removes ones taken, from the simulation's interactables. */
  update(dt: number, sim: Simulation, camera: THREE.Camera): void {
    this.time += dt;
    this.seen.clear();
    for (const it of sim.interactables) {
      if (!it || it.kind !== 'boost' || it.supply <= 0 || !it.boost) continue;
      this.seen.add(it.id);
      let v = this.views.get(it.id);
      if (!v || v.kind !== it.boost) {
        if (v) this.remove(it.id);
        v = this.create(it, it.boost);
      }
      v.probe.update(camera);
      const k = 0.5 + 0.5 * Math.sin((this.time + v.phase) * 2.1);
      v.model.setGlow(0.55 + 0.45 * k);
      const d = camera.position.distanceTo(v.model.root.position);
      v.model.root.visible = v.pool.visible = d < PICKUP_DRAW_RANGE;
      v.halo.visible = d < 28;
      if (v.halo.visible) {
        // A touch bigger far off, so it stays a point of colour rather than shrinking to nothing.
        const s = 0.16 + 0.06 * k + Math.min(0.22, d * 0.009);
        v.halo.scale.set(s, s, s);
        (v.halo.material as THREE.SpriteMaterial).opacity = 0.26 + 0.2 * k;
      }
      (v.pool.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.12 * k;
    }
    for (const id of [...this.views.keys()]) if (!this.seen.has(id)) this.remove(id);
  }

  private create(it: Interactable, kind: BoostId): View {
    const v = this.build(kind, new THREE.Vector3(it.pos.x, it.pos.y - 0.03, it.pos.z), boostYaw(it.id), it.id);
    this.views.set(it.id, v);
    return v;
  }

  /** A syringe lying on a surface at `at`, turned `yaw`. */
  private build(kind: BoostId, at: THREE.Vector3, yaw: number, id: number): View {
    const model = new SyringeModel(kind);
    model.setCap(true);
    const r = model.root;
    // Lying flat (the flange too), lifted by the thumb rest's radius.
    r.position.set(at.x, at.y + 0.013 * SCALE, at.z);
    r.rotation.set(0, yaw, 0);
    const probe = new StaticProbe(this.field, new THREE.Vector3(at.x, at.y + 0.3, at.z), new THREE.Vector3(), 0);
    for (const m of model.materials) patchProbe(m, probe.uniforms);
    const color = new THREE.Color(BOOSTS[kind].color);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: haloMap(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    }));
    halo.position.set(at.x, at.y + 0.03, at.z);
    const pool = new THREE.Mesh(POOL, new THREE.MeshBasicMaterial({
      map: haloMap(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    pool.position.set(at.x, at.y + 0.002, at.z);
    pool.renderOrder = 2;
    this.root.add(r, halo, pool);
    return { kind, model, probe, halo, pool, phase: (id * 1.91) % 6 };
  }

  private remove(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.drop(v);
    this.views.delete(id);
  }

  private drop(v: View): void {
    v.model.dispose();
    v.halo.removeFromParent();
    (v.halo.material as THREE.Material).dispose();
    v.pool.removeFromParent();
    (v.pool.material as THREE.Material).dispose();
  }

  /** One syringe of every kind with its glow, for compiling their shaders before the night (see GameSession.prewarm). */
  sample(): { root: THREE.Group; dispose: () => void } {
    const root = new THREE.Group();
    const made: View[] = [];
    (Object.keys(BOOSTS) as BoostId[]).forEach((kind, i) => {
      const v = this.build(kind, new THREE.Vector3(i * 0.3, 0.8, 0), i, i);
      root.add(v.model.root, v.halo, v.pool);
      made.push(v);
    });
    return { root, dispose: () => { for (const v of made) this.drop(v); root.removeFromParent(); } };
  }

  dispose(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
    this.root.removeFromParent();
  }
}
