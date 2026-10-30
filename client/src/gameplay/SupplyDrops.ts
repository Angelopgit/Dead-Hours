import * as THREE from 'three';
import { SUPPLY_DROPS, type HeliFlight } from '@dead-hours/shared';
import { createLightConeMaterial } from '../environment/LightCone';

/** Where the helicopter is along its flight, how it is tilted and how fast it goes. */
export interface HeliPose {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  /** 0 cruising .. 1 hovering over the drop (searchlight, rotor sound). */
  hover: number;
}

/** Seconds spent slowing into the hover and speeding up out of it (the simulation plans the same). */
const EASE = 5;

const lerp = THREE.MathUtils.lerp;
const headingOf = (ax: number, az: number, bx: number, bz: number) => Math.atan2(bx - ax, bz - az);
const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/**
 * Pose along a flight at simulation time t: cruise in, brake into a hover over the drop while
 * turning toward the way out, hover, then pull away. Pure function of the flight, so every
 * client draws the same aircraft.
 */
export function heliPose(f: HeliFlight, t: number, out: HeliPose): HeliPose {
  const V = SUPPLY_DROPS.speed;
  const inYaw = headingOf(f.from.x, f.from.z, f.over.x, f.over.z);
  const outYaw = headingOf(f.over.x, f.over.z, f.to.x, f.to.z);
  if (t <= f.arrive) {
    // Distance still to go: cruise, then constant deceleration over the last EASE seconds.
    const left = f.arrive - t;
    const togo = left >= EASE ? V * (left - EASE) + (V * EASE) / 2 : (V * left * left) / (2 * EASE);
    const total = Math.hypot(f.over.x - f.from.x, f.over.z - f.from.z);
    const k = THREE.MathUtils.clamp(1 - togo / total, 0, 1);
    out.pos.set(lerp(f.from.x, f.over.x, k), lerp(f.from.y, f.over.y, k), lerp(f.from.z, f.over.z, k));
    out.speed = left >= EASE ? V : (V * left) / EASE;
    const braking = left < EASE ? Math.sin((1 - left / EASE) * Math.PI) : 0;
    out.yaw = inYaw;
    // Nose down at speed, flared nose-up while braking.
    out.pitch = 0.11 * (out.speed / V) - 0.2 * braking;
    out.roll = 0;
    out.hover = left < EASE ? 1 - left / EASE : 0;
  } else if (t <= f.leave) {
    const k = (t - f.arrive) / Math.max(0.01, f.leave - f.arrive);
    const bob = Math.sin(t * 1.3) * 0.35;
    out.pos.set(f.over.x + Math.sin(t * 0.7) * 0.4, f.over.y + bob, f.over.z + Math.cos(t * 0.6) * 0.4);
    out.speed = 0;
    // Swings round to the way out while it hovers.
    const turn = angleTo(inYaw, outYaw);
    const s = k * k * (3 - 2 * k);
    out.yaw = inYaw + turn * s;
    out.pitch = Math.sin(t * 0.9) * 0.02;
    out.roll = -Math.sign(turn) * Math.sin(k * Math.PI) * 0.06;
    out.hover = 1;
  } else {
    const since = Math.max(0, t - f.leave);
    const gone = since < EASE ? (V * since * since) / (2 * EASE) : (V * EASE) / 2 + V * (since - EASE);
    const total = Math.hypot(f.to.x - f.over.x, f.to.z - f.over.z);
    const k = THREE.MathUtils.clamp(gone / total, 0, 1);
    out.pos.set(lerp(f.over.x, f.to.x, k), lerp(f.over.y, f.to.y, k * k), lerp(f.over.z, f.to.z, k));
    out.speed = since < EASE ? (V * since) / EASE : V;
    out.yaw = outYaw;
    const accel = since < EASE ? Math.sin((since / EASE) * Math.PI) : 0;
    out.pitch = 0.11 * (out.speed / V) + 0.12 * accel;
    out.roll = 0;
    out.hover = since < EASE ? 1 - since / EASE : 0;
  }
  return out;
}

/** Crate height above the ground at time t (hanging under the helicopter before release). */
export function crateHeight(f: HeliFlight, t: number): number {
  if (t >= f.land) return 0;
  if (t >= f.release) return Math.max(0, f.releaseHeight - SUPPLY_DROPS.fallSpeed * (t - f.release));
  return f.releaseHeight;
}

// ---------------------------------------------------------------------------- models

const OLIVE = 0x3b4231;

function std(color: number, roughness = 0.65, metalness = 0.15, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true, ...extra });
}

/** A utility helicopter in drab paint, nose along +Z. */
class Helicopter {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  private readonly rotor = new THREE.Group();
  private readonly tailRotor = new THREE.Group();
  private readonly disc: THREE.Mesh;
  private readonly beacon: THREE.Mesh;
  private readonly strobe: THREE.Mesh;
  readonly materials: THREE.Material[] = [];
  readonly geometries: THREE.BufferGeometry[] = [];
  /** Where the searchlight sits, in body space. */
  readonly lamp = new THREE.Object3D();
  private spin = Math.random() * 10;

  constructor() {
    const paint = this.mat(std(OLIVE, 0.7, 0.2));
    const dark = this.mat(std(0x1f221c, 0.6, 0.4));
    const metal = this.mat(std(0x55585a, 0.4, 0.7));
    const glass = this.mat(std(0x1b2a33, 0.08, 0.6, { transparent: true, opacity: 0.82 }));
    const white = this.mat(std(0xd8d6cc, 0.6, 0.1));
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.body) => {
      this.geometries.push(g);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // Cabin with a rounded nose and a glazed front.
    add(new THREE.BoxGeometry(2.4, 2.1, 4.6), paint, 0, 0, 0.2);
    const nose = add(new THREE.SphereGeometry(1.2, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), paint, 0, 0, 2.5);
    nose.rotation.x = Math.PI / 2;
    nose.scale.set(1, 1.15, 0.88);
    const shield = add(new THREE.SphereGeometry(1.22, 14, 8, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.12, Math.PI * 0.36), glass, 0, 0.12, 2.48);
    shield.scale.set(1, 1.1, 1.2);
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.02, 0.8, 1.6), glass, side * 1.21, 0.35, 1.3);
      // Open cargo door: the crate goes out this side.
      add(new THREE.BoxGeometry(0.03, 1.5, 1.9), dark, side * 1.215, -0.1, -0.6);
    }
    add(new THREE.BoxGeometry(2.6, 0.12, 0.25), white, 0, -0.2, -1.95);
    // Engine and exhausts on top.
    add(new THREE.BoxGeometry(1.5, 0.75, 2.8), paint, 0, 1.38, -0.7);
    for (const side of [-1, 1]) {
      const ex = add(new THREE.CylinderGeometry(0.16, 0.2, 0.6, 8), dark, side * 0.45, 1.6, -2.3);
      ex.rotation.x = Math.PI / 2 - 0.3;
    }
    // Tail boom, fin, stabiliser.
    const boom = add(new THREE.CylinderGeometry(0.2, 0.42, 6.6, 10), paint, 0, 0.45, -5.3);
    boom.rotation.x = Math.PI / 2;
    add(new THREE.BoxGeometry(0.14, 1.7, 1.0), paint, 0, 1.25, -8.4).rotation.x = -0.35;
    add(new THREE.BoxGeometry(2.3, 0.07, 0.55), paint, 0, 0.5, -7.2);
    // Skids.
    for (const side of [-1, 1]) {
      const skid = add(new THREE.CylinderGeometry(0.06, 0.06, 4.6, 6), metal, side * 1.25, -1.62, 0.3);
      skid.rotation.x = Math.PI / 2;
      const tip = add(new THREE.CylinderGeometry(0.06, 0.06, 0.6, 6), metal, side * 1.25, -1.5, 2.8);
      tip.rotation.x = Math.PI / 2 - 0.7;
      for (const z of [-0.9, 1.3]) add(new THREE.BoxGeometry(0.08, 0.6, 0.12), metal, side * 1.12, -1.32, z).rotation.z = side * 0.35;
    }
    // Main rotor: mast, hub, two long blades, and a faint disc when they blur.
    add(new THREE.CylinderGeometry(0.12, 0.12, 0.7, 8), metal, 0, 1.95, 0.0);
    this.rotor.position.set(0, 2.3, 0);
    this.body.add(this.rotor);
    add(new THREE.BoxGeometry(0.5, 0.18, 0.5), dark, 0, 0, 0, this.rotor);
    for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.42, 0.05, 7.1), dark, 0, 0.04, side * 3.7, this.rotor);
    const discG = new THREE.CircleGeometry(7.25, 40);
    discG.rotateX(-Math.PI / 2);
    this.geometries.push(discG);
    const discM = this.mat(new THREE.MeshBasicMaterial({ color: 0x15171a, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }));
    this.disc = new THREE.Mesh(discG, discM);
    this.disc.position.set(0, 2.33, 0);
    this.body.add(this.disc);
    // Tail rotor on the left of the fin.
    this.tailRotor.position.set(0.18, 1.3, -8.55);
    this.body.add(this.tailRotor);
    for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.04, 0.7, 0.14), dark, 0, side * 0.35, 0, this.tailRotor);
    // Navigation lights: red to port (+X), green to starboard, white strobe, red beacon.
    const glow = (c: number) => this.mat(new THREE.MeshBasicMaterial({ color: c }));
    add(new THREE.SphereGeometry(0.09, 6, 4), glow(0xff2a1a), 1.3, -0.4, 0.6);
    add(new THREE.SphereGeometry(0.09, 6, 4), glow(0x26ff5a), -1.3, -0.4, 0.6);
    this.strobe = add(new THREE.SphereGeometry(0.1, 6, 4), glow(0xffffff), 0, 1.15, -8.95);
    this.beacon = add(new THREE.SphereGeometry(0.13, 6, 4), glow(0xff2010), 0, 1.82, -1.6);
    this.lamp.position.set(0, -1.15, 2.4);
    this.body.add(this.lamp);
    this.root.add(this.body);
  }

  private mat<M extends THREE.Material>(m: M): M {
    this.materials.push(m);
    return m;
  }

  update(dt: number, time: number, pose: HeliPose): void {
    this.root.position.copy(pose.pos);
    this.root.rotation.set(0, pose.yaw, 0);
    this.body.rotation.set(pose.pitch, 0, pose.roll);
    this.spin += dt * 31;
    this.rotor.rotation.y = this.spin;
    this.tailRotor.rotation.x = this.spin * 4.6;
    this.beacon.visible = time % 1.1 < 0.16;
    this.strobe.visible = time % 1.6 < 0.06;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

let stencil: THREE.CanvasTexture | null = null;
/** Olive crate side with a yellow stencil, drawn once. */
function stencilTexture(): THREE.CanvasTexture | null {
  if (stencil) return stencil;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#3b4231';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  for (let i = 0; i < 6; i++) g.fillRect(0, i * 22 + 4, 256, 2);
  g.fillStyle = '#d6b23a';
  g.font = 'bold 30px Oswald, Impact, sans-serif';
  g.textAlign = 'center';
  g.fillText('UNIVERSAL', 128, 54);
  g.fillText('AMMUNITION', 128, 92);
  g.fillRect(28, 104, 200, 5);
  stencil = new THREE.CanvasTexture(c);
  stencil.colorSpace = THREE.SRGBColorSpace;
  return stencil;
}

/** The drop itself: a strapped ammunition crate under an orange-and-white chute, with a red flare. */
class CrateModel {
  readonly root = new THREE.Group();
  readonly crate = new THREE.Group();
  readonly chute = new THREE.Group();
  readonly lid = new THREE.Group();
  private readonly canopy: THREE.Mesh;
  private readonly lines: THREE.LineSegments;
  private readonly flare: THREE.Mesh;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  /** Chute collapse after landing, 0..1, and where it drifts to. */
  collapse = 0;
  private readonly drift = new THREE.Vector2();

  constructor() {
    const tex = stencilTexture();
    const side = this.mat(new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.8 }));
    const olive = this.mat(std(OLIVE, 0.8, 0.05));
    const strap = this.mat(std(0x23251f, 0.7, 0.1));
    const metal = this.mat(std(0x77786f, 0.4, 0.7));
    const add = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[], x: number, y: number, z: number, parent: THREE.Object3D = this.crate) => {
      this.geometries.push(g);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // Body (stencil on the long sides), lid on a hinge at the back edge.
    add(new THREE.BoxGeometry(1.1, 0.6, 0.76), [olive, olive, olive, olive, side, side], 0, 0.3, 0);
    this.lid.position.set(0, 0.6, -0.38);
    this.crate.add(this.lid);
    add(new THREE.BoxGeometry(1.12, 0.12, 0.78), olive, 0, 0.06, 0.38, this.lid);
    for (const x of [-0.38, 0.38]) {
      add(new THREE.BoxGeometry(0.07, 0.74, 0.8), strap, x, 0.36, 0);
      add(new THREE.BoxGeometry(0.06, 0.06, 0.06), metal, x, 0.72, 0.4);
    }
    for (const x of [-0.56, 0.56]) add(new THREE.BoxGeometry(0.04, 0.08, 0.3), metal, x, 0.42, 0);
    // Rounds inside, seen when the lid is open.
    const brass = this.mat(std(0xb8913a, 0.35, 0.8));
    for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.22, 0.08, 0.5), brass, -0.36 + i * 0.24, 0.56, 0);
    // Flare on the lid.
    this.flare = add(new THREE.CylinderGeometry(0.04, 0.04, 0.22, 6), this.mat(new THREE.MeshBasicMaterial({ color: 0xff3018 })), 0.42, 0.25, 0.25, this.lid);
    this.root.add(this.crate);

    // Chute: twelve gores, alternating orange and white, and lines down to the crate's corners.
    const gores = 12;
    const cg = new THREE.SphereGeometry(3.1, gores * 2, 6, 0, Math.PI * 2, 0, Math.PI * 0.42).toNonIndexed();
    const pos = cg.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const orange = new THREE.Color(0xd8642a), white = new THREE.Color(0xe6e2d6);
    for (let i = 0; i < pos.count; i += 3) {
      const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      const k = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * gores) % 2;
      const c = k ? orange : white;
      for (let j = i; j < i + 3; j++) col.set([c.r, c.g, c.b], j * 3);
    }
    cg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    cg.computeVertexNormals();
    this.geometries.push(cg);
    this.canopy = new THREE.Mesh(cg, this.mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, flatShading: true })));
    this.canopy.scale.set(1, 0.62, 1);
    this.canopy.castShadow = true;
    this.chute.add(this.canopy);
    const rim = 3.1 * Math.sin(Math.PI * 0.42), rimY = 3.1 * Math.cos(Math.PI * 0.42) * 0.62;
    const pts: number[] = [];
    const corners = [[-0.5, -0.35], [0.5, -0.35], [0.5, 0.35], [-0.5, 0.35]];
    for (let i = 0; i < gores; i++) {
      const a = (i / gores) * Math.PI * 2;
      const [cx, cz] = corners[Math.floor((i / gores) * 4) % 4];
      pts.push(Math.cos(a) * rim, rimY, Math.sin(a) * rim, cx, -6.2 + 0.72, cz);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.geometries.push(lg);
    this.lines = new THREE.LineSegments(lg, this.mat(new THREE.LineBasicMaterial({ color: 0x8a8576, transparent: true, opacity: 0.7 })));
    this.chute.add(this.lines);
    this.chute.position.y = 6.2;
    this.root.add(this.chute);
    this.drift.set(Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(2.2);
  }

  private mat<M extends THREE.Material>(m: M): M {
    this.materials.push(m);
    return m;
  }

  /** `open` 0..1 deploys the chute after release; `collapse` 0..1 lays it down after landing. */
  pose(open: number, collapse: number, time: number, flareOn: boolean, lidOpen: number): void {
    const o = THREE.MathUtils.clamp(open, 0, 1);
    const c = THREE.MathUtils.clamp(collapse, 0, 1);
    const ease = c * c * (3 - 2 * c);
    const breathe = 1 + Math.sin(time * 2.3) * 0.03 * (1 - c);
    this.canopy.scale.set(lerp(0.12, 1, o) * breathe, lerp(0.25, 0.62, o) * (1 - ease * 0.94), lerp(0.12, 1, o) * breathe);
    this.chute.position.set(this.drift.x * ease, lerp(6.2, 0.15, ease), this.drift.y * ease);
    this.chute.rotation.set(this.drift.y * 0.25 * ease, time * 0.15 * (1 - c), -this.drift.x * 0.25 * ease);
    this.lines.visible = c < 0.6 && o > 0.02;
    this.chute.visible = o > 0.02;
    this.flare.visible = flareOn && time % 0.16 < 0.11;
    this.lid.rotation.x = -lidOpen * 1.9;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

// ---------------------------------------------------------------------------- system

interface Drop {
  id: number;
  flight: HeliFlight;
  heli: Helicopter | null;
  crate: CrateModel;
  landed: boolean;
  empty: boolean;
  emptyAt: number;
  smokeT: number;
  pose: HeliPose;
  /** Where the crate hung under the helicopter at release (the fall eases out from there). */
  hang: THREE.Vector3;
}

export interface DropMarker {
  pos: THREE.Vector3;
  stage: 'inbound' | 'falling' | 'landed';
}

/**
 * Supply drops on screen: the helicopter flying its planned route with a searchlight on the
 * drop zone, the crate hanging under it, its fall under the chute, the landing and the red flare
 * that marks it until it is emptied. Lights are created once and kept in the scene (adding
 * lights would recompile every material); only one drop is lit at a time.
 */
export class SupplyDrops {
  private readonly root = new THREE.Group();
  private readonly drops = new Map<number, Drop>();
  private readonly search = new THREE.SpotLight(0xe8f0ff, 0, 95, 0.2, 0.5, 1.1);
  private readonly beam: THREE.Mesh;
  private readonly flareLight = new THREE.PointLight(0xff3a1c, 0, 14, 1.6);
  private readonly tmp = new THREE.Vector3();
  /** Smoke and sparks from the flare. */
  onSmoke: ((pos: THREE.Vector3, strong: boolean) => void) | null = null;
  onLand: ((pos: THREE.Vector3) => void) | null = null;

  constructor(scene: THREE.Scene) {
    this.root.name = 'supply-drops';
    this.search.castShadow = false;
    this.root.add(this.search, this.search.target, this.flareLight);
    const len = 40;
    const g = new THREE.ConeGeometry(len * Math.tan(0.2), len, 18, 1, true);
    g.translate(0, -len / 2, 0);
    this.beam = new THREE.Mesh(g, createLightConeMaterial(0xdfe8ff));
    this.beam.renderOrder = 2;
    this.beam.visible = false;
    this.root.add(this.beam);
    scene.add(this.root);
  }

  /** A helicopter took off for a drop. */
  flight(id: number, f: HeliFlight): void {
    if (this.drops.has(id)) return;
    const heli = new Helicopter();
    const crate = new CrateModel();
    this.root.add(heli.root, crate.root);
    this.drops.set(id, {
      id, flight: f, heli, crate, landed: false, empty: false, emptyAt: 0, smokeT: 0, hang: new THREE.Vector3(f.over.x, f.ground.y + f.releaseHeight, f.over.z),
      pose: { pos: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, speed: 0, hover: 0 },
    });
  }

  emptied(id: number, time: number): void {
    const d = this.drops.get(id);
    if (!d || d.empty) return;
    d.empty = true;
    d.emptyAt = time;
  }

  gone(id: number): void {
    const d = this.drops.get(id);
    if (!d) return;
    d.heli?.dispose();
    d.crate.dispose();
    this.drops.delete(id);
  }

  /** Helicopter positions (for its sound) by drop id, while it flies. */
  helicopters(out: Map<number, { pos: THREE.Vector3; hover: number }>): void {
    out.clear();
    for (const d of this.drops.values()) if (d.heli) out.set(d.id, { pos: d.pose.pos, hover: d.pose.hover });
  }

  /** The drop worth pointing at on the HUD: the newest one that still has ammunition. */
  marker(): DropMarker | null {
    let best: Drop | null = null;
    for (const d of this.drops.values()) if (!d.empty && (!best || d.id > best.id)) best = d;
    if (!best) return null;
    const g = best.flight.ground;
    return { pos: this.tmp.set(g.x, g.y + 0.8, g.z), stage: best.landed ? 'landed' : best.heli && this.timeNow < best.flight.release ? 'inbound' : 'falling' };
  }

  private timeNow = 0;

  update(dt: number, time: number): void {
    this.timeNow = time;
    let lit: Drop | null = null;
    let flare: Drop | null = null;
    for (const d of this.drops.values()) {
      const f = d.flight;
      if (d.heli) {
        heliPose(f, time, d.pose);
        d.heli.update(dt, time, d.pose);
        if (time > f.end) {
          d.heli.dispose();
          d.heli = null;
        } else if (d.pose.hover > 0.05 && (!lit || d.pose.hover > lit.pose.hover)) {
          lit = d;
        }
      }
      // Crate: hangs under the cargo door, then falls under its chute, then sits in the street.
      const g = f.ground;
      const h = crateHeight(f, time);
      if (time < f.release && d.heli) {
        d.heli.root.updateMatrixWorld();
        d.crate.root.position.copy(d.heli.body.localToWorld(this.tmp.set(0, -2.6, -0.5)));
        d.hang.copy(d.crate.root.position);
        d.crate.root.rotation.set(0, d.pose.yaw, 0);
        d.crate.root.visible = time > f.arrive - 3;
        d.crate.pose(0, 0, time, false, 0);
      } else {
        const fall = time - f.release;
        const sway = time < f.land ? Math.sin(fall * 1.7) * 0.5 * Math.min(1, fall / 2) : 0;
        d.crate.root.visible = true;
        d.crate.root.position.set(g.x + sway, g.y + h, g.z + Math.cos(fall * 1.3) * sway * 0.6);
        // Out of the door from where it hung, settling onto the straight fall in the first second.
        const k = Math.max(0, 1 - fall / 1.1);
        if (k > 0 && time < f.land) {
          this.tmp.set(g.x, g.y + f.releaseHeight, g.z);
          d.crate.root.position.addScaledVector(this.tmp.subVectors(d.hang, this.tmp), k * k);
        }
        d.crate.root.rotation.set(sway * 0.06, (d.pose.yaw || 0) + fall * 0.05, 0);
        const open = THREE.MathUtils.smoothstep(fall, 0.3, 1.6);
        const collapse = time >= f.land ? Math.min(1, (time - f.land) / 2.6) : 0;
        d.crate.pose(open, collapse, time, d.landed && !d.empty, d.empty ? Math.min(1, (time - d.emptyAt) / 0.5) : 0);
      }
      if (!d.landed && time >= f.land) {
        d.landed = true;
        this.onLand?.(this.tmp.set(g.x, g.y + 0.2, g.z));
      }
      if (d.landed && !d.empty) {
        if (!flare || d.id > flare.id) flare = d;
        d.smokeT -= dt;
        if (d.smokeT <= 0) {
          d.smokeT = 0.09;
          const p = d.crate.lid.localToWorld(this.tmp.set(0.42, 0.4, 0.25));
          this.onSmoke?.(p, time - f.land < 60);
        }
      }
    }
    // Searchlight on the drop zone from the hovering helicopter.
    if (lit && lit.heli) {
      const lamp = lit.heli.lamp.getWorldPosition(this.tmp);
      this.search.position.copy(lamp);
      const g = lit.flight.ground;
      this.search.target.position.set(g.x + Math.sin(time * 0.8) * 1.5, g.y, g.z + Math.cos(time * 0.6) * 1.5);
      this.search.target.updateMatrixWorld();
      this.search.intensity = 2600 * lit.pose.hover;
      this.beam.visible = true;
      this.beam.position.copy(lamp);
      const dir = this.tmp.subVectors(this.search.target.position, lamp).normalize();
      this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      const m = this.beam.material as THREE.ShaderMaterial;
      m.uniforms.uIntensity.value = 0.9 * lit.pose.hover;
    } else {
      this.search.intensity = 0;
      this.beam.visible = false;
    }
    if (flare) {
      const p = flare.crate.lid.localToWorld(this.tmp.set(0.42, 0.5, 0.25));
      this.flareLight.position.copy(p);
      this.flareLight.intensity = 9 * (0.75 + Math.random() * 0.5);
    } else {
      this.flareLight.intensity = 0;
    }
  }

  clear(): void {
    for (const id of [...this.drops.keys()]) this.gone(id);
  }

  dispose(): void {
    this.clear();
    this.beam.geometry.dispose();
    (this.beam.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }
}
