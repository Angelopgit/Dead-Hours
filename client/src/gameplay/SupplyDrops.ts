import * as THREE from 'three';
import { SUPPLY_DROPS, WEAPONS, caseSpot, type HeliFlight, type WeaponId } from '@dead-hours/shared';
import { createLightConeMaterial } from '../environment/LightCone';
import { createWeaponModel, type WeaponModel } from '../weapons/WeaponModels';
import type { Physics } from '../core/Physics';
import { Parachute } from './Parachute';

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

/** The drop itself: a strapped ammunition crate with a red flare (its chute is a Parachute). */
class CrateModel {
  readonly root = new THREE.Group();
  readonly crate = new THREE.Group();
  readonly lid = new THREE.Group();
  private readonly flare: THREE.Mesh;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

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
    // Lugs on the ends, where the chute's risers are shackled.
    for (const x of [-0.56, 0.56]) add(new THREE.BoxGeometry(0.04, 0.08, 0.3), metal, x, 0.42, 0);
    // Rounds inside, seen when the lid is open.
    const brass = this.mat(std(0xb8913a, 0.35, 0.8));
    for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.22, 0.08, 0.5), brass, -0.36 + i * 0.24, 0.56, 0);
    // Flare on the lid.
    this.flare = add(new THREE.CylinderGeometry(0.04, 0.04, 0.22, 6), this.mat(new THREE.MeshBasicMaterial({ color: 0xff3018 })), 0.42, 0.25, 0.25, this.lid);
    this.root.add(this.crate);
  }

  private mat<M extends THREE.Material>(m: M): M {
    this.materials.push(m);
    return m;
  }

  pose(time: number, flareOn: boolean, lidOpen: number): void {
    this.flare.visible = flareOn && time % 0.16 < 0.11;
    this.lid.rotation.x = -lidOpen * 1.9;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

const cases = new Map<WeaponId, THREE.CanvasTexture>();
/** Black hard-case lid with the gun's name in yellow, drawn once per gun. */
function caseTexture(weapon: WeaponId): THREE.CanvasTexture | null {
  const have = cases.get(weapon);
  if (have) return have;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#17181a';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 9; i++) g.fillRect(0, i * 14 + 3, 512, 3);
  g.fillStyle = '#e6c35a';
  g.font = 'bold 46px Oswald, Impact, sans-serif';
  g.textAlign = 'center';
  g.fillText(WEAPONS[weapon].model, 256, 72);
  g.fillRect(60, 94, 392, 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cases.set(weapon, t);
  return t;
}

/**
 * The rare part of a drop: a hard rifle case lying open beside the crate, the exclusive gun on
 * its foam, a yellow band round it that reads at night. The gun goes when someone takes it.
 */
class WeaponCase {
  readonly root = new THREE.Group();
  private readonly lid = new THREE.Group();
  private readonly band: THREE.Mesh;
  private readonly gun: WeaponModel;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(weapon: WeaponId, flight: HeliFlight) {
    this.gun = createWeaponModel(weapon);
    const box = new THREE.Box3().setFromObject(this.gun.root);
    const len = box.max.z - box.min.z + 0.16;
    const shell = this.mat(std(0x1b1c1e, 0.55, 0.2));
    const foam = this.mat(std(0x2a2b2d, 0.95, 0));
    const metal = this.mat(std(0x77786f, 0.4, 0.7));
    const top = this.mat(new THREE.MeshStandardMaterial({ color: 0xffffff, map: caseTexture(weapon), roughness: 0.6 }));
    const add = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[], x: number, y: number, z: number, parent: THREE.Object3D = this.root) => {
      this.geometries.push(g);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // Base along local Z, foam inside, latches on the front edge.
    add(new THREE.BoxGeometry(0.42, 0.1, len), shell, 0, 0.05, 0);
    add(new THREE.BoxGeometry(0.38, 0.02, len - 0.04), foam, 0, 0.1, 0);
    for (const z of [-len * 0.3, len * 0.3]) add(new THREE.BoxGeometry(0.03, 0.04, 0.06), metal, 0.215, 0.07, z);
    // Lid hinged on the back edge, thrown open; its outside carries the stencil.
    this.lid.position.set(-0.21, 0.1, 0);
    this.root.add(this.lid);
    add(new THREE.BoxGeometry(0.42, 0.06, len), [shell, shell, top, shell, shell, shell], 0.21, 0.03, 0, this.lid);
    this.lid.rotation.z = 1.95;
    // A self-lit yellow band round the base, so it can be found in the dark.
    this.band = add(new THREE.BoxGeometry(0.43, 0.014, len + 0.01), this.mat(new THREE.MeshBasicMaterial({ color: 0xe6c35a })), 0, 0.085, 0);
    this.band.castShadow = false;
    // The gun on its side in the foam, centred on the case.
    const g = this.gun.root;
    g.rotation.set(0, 0, Math.PI / 2);
    g.position.set(0.02, 0.15, -(box.min.z + box.max.z) / 2);
    this.root.add(g);
    const c = caseSpot(flight);
    this.root.position.set(c.x, c.y, c.z);
    this.root.rotation.y = c.yaw;
  }

  private mat<M extends THREE.Material>(m: M): M {
    this.materials.push(m);
    return m;
  }

  taken(): void {
    this.gun.root.visible = false;
  }

  pose(time: number): void {
    (this.band.material as THREE.MeshBasicMaterial).color.setHex(time % 1.4 < 0.7 ? 0xe6c35a : 0x9c8235);
  }

  dispose(): void {
    this.gun.dispose();
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/**
 * A Lazarus serum: a small olive medical case lying open on the far side of the crate, the
 * autoinjector glowing teal on its foam. The injector goes when someone takes it.
 */
class SerumKit {
  readonly root = new THREE.Group();
  private readonly pen = new THREE.Group();
  private readonly glow: THREE.MeshBasicMaterial;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(flight: HeliFlight) {
    const shell = this.mat(std(OLIVE, 0.6, 0.1));
    const foam = this.mat(std(0x2a2b2d, 0.95, 0));
    const white = this.mat(std(0xd8d6cc, 0.5, 0.1));
    const cap = this.mat(std(0xc0392b, 0.5, 0.1));
    this.glow = this.mat(new THREE.MeshBasicMaterial({ color: 0x6fd0bf, toneMapped: false }));
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.root) => {
      this.geometries.push(g);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(0.3, 0.07, 0.42), shell, 0, 0.035, 0);
    add(new THREE.BoxGeometry(0.27, 0.015, 0.39), foam, 0, 0.072, 0);
    const lid = add(new THREE.BoxGeometry(0.3, 0.035, 0.42), shell, -0.15, 0.07, 0);
    lid.geometry.translate(-0.15, 0, 0);
    lid.position.set(-0.15, 0.07, 0);
    lid.rotation.z = 2.0;
    // The pen: a fat white tube, a red safety cap, a glowing teal window full of the dose.
    const body = add(new THREE.CylinderGeometry(0.022, 0.022, 0.2, 10), white, 0, 0, 0, this.pen);
    body.rotation.x = Math.PI / 2;
    const end = add(new THREE.CylinderGeometry(0.024, 0.024, 0.04, 10), cap, 0, 0, -0.12, this.pen);
    end.rotation.x = Math.PI / 2;
    const win = add(new THREE.CylinderGeometry(0.0235, 0.0235, 0.08, 10), this.glow, 0, 0, 0.03, this.pen);
    win.rotation.x = Math.PI / 2;
    win.castShadow = false;
    this.pen.position.set(0.02, 0.1, 0);
    this.root.add(this.pen);
    const c = caseSpot(flight, -1);
    this.root.position.set(c.x, c.y, c.z);
    this.root.rotation.y = c.yaw;
  }

  private mat<M extends THREE.Material>(m: M): M {
    this.materials.push(m);
    return m;
  }

  taken(): void {
    this.pen.visible = false;
  }

  pose(time: number): void {
    const k = 0.6 + 0.4 * Math.sin(time * 3.2);
    this.glow.color.setRGB(0.44 * k, 0.82 * k, 0.75 * k);
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
  chute: Parachute;
  /** The exclusive weapon's case (rare drops), shown once the crate is down. */
  weapon: WeaponCase | null;
  weaponLeft: boolean;
  /** A Lazarus serum (rare), shown once the crate is down. */
  serum: SerumKit | null;
  serumLeft: boolean;
  landed: boolean;
  empty: boolean;
  emptyAt: number;
  smokeT: number;
  pose: HeliPose;
  /** Where the crate hung under the helicopter at release (the fall eases out from there), and its heading then. */
  hang: THREE.Vector3;
  hangYaw: number;
  /** Heading of the way in, and the crate's heading once it is down (the same on every machine). */
  inYaw: number;
  landYaw: number;
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
  private readonly anchor = new THREE.Vector3();
  /** Smoke and sparks from the flare. */
  onSmoke: ((pos: THREE.Vector3, strong: boolean) => void) | null = null;
  onLand: ((pos: THREE.Vector3) => void) | null = null;

  /** `physics` lets a landed canopy find room to lie and drape over curbs (flat ground without it). */
  constructor(scene: THREE.Scene, private readonly physics: Physics | null = null) {
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

  /**
   * A helicopter, a crate, a weapon case and a serum kit, for compiling their shaders before the
   * night (see core/Preload): the first drop would otherwise compile them all mid-fight.
   */
  sample(): { root: THREE.Object3D; dispose: () => void } {
    const o = { x: 0, y: 0, z: 0 };
    const f: HeliFlight = { from: o, over: o, to: o, start: 0, arrive: 1, release: 2, leave: 3, end: 4, ground: o, land: 3, releaseHeight: 10 };
    const heli = new Helicopter();
    const crate = new CrateModel();
    const chute = new Parachute(1);
    const wcase = new WeaponCase('ar', f);
    const kit = new SerumKit(f);
    const root = new THREE.Group();
    root.add(heli.root, crate.root, chute.root, wcase.root, kit.root);
    crate.root.position.x = 3;
    chute.fly(crate.root.position, crate.root.position, 0, 5, 0);
    wcase.root.position.x = -3;
    kit.root.position.x = 5;
    return { root, dispose: () => {
      root.removeFromParent();
      heli.dispose();
      crate.dispose();
      chute.dispose();
      wcase.dispose();
      kit.dispose();
    } };
  }

  /** A helicopter took off for a drop. */
  flight(id: number, f: HeliFlight, weapon: WeaponId | null = null, serum = false): void {
    if (this.drops.has(id)) return;
    const heli = new Helicopter();
    const crate = new CrateModel();
    const chute = new Parachute(id * 7919 + Math.round(f.ground.x * 10) * 31 + Math.round(f.ground.z * 10));
    this.root.add(heli.root, crate.root, chute.root);
    const wcase = weapon ? new WeaponCase(weapon, f) : null;
    if (wcase) {
      wcase.root.visible = false;
      this.root.add(wcase.root);
    }
    const kit = serum ? new SerumKit(f) : null;
    if (kit) {
      kit.root.visible = false;
      this.root.add(kit.root);
    }
    const inYaw = headingOf(f.from.x, f.from.z, f.over.x, f.over.z);
    const landYaw = inYaw + Math.sin(id * 12.9898 + f.ground.x * 0.731) * 0.12;
    this.drops.set(id, {
      id, flight: f, heli, crate, chute, weapon: wcase, weaponLeft: !!wcase, serum: kit, serumLeft: !!kit, landed: false, empty: false, emptyAt: 0, smokeT: 0,
      hang: new THREE.Vector3(f.over.x, f.ground.y + f.releaseHeight, f.over.z), hangYaw: landYaw, inYaw, landYaw,
      pose: { pos: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, speed: 0, hover: 0 },
    });
  }

  emptied(id: number, time: number): void {
    const d = this.drops.get(id);
    if (!d || d.empty) return;
    d.empty = true;
    d.emptyAt = time;
  }

  /** Someone took the exclusive weapon out of its case. */
  weaponTaken(id: number): void {
    const d = this.drops.get(id);
    if (!d || !d.weapon) return;
    d.weaponLeft = false;
    d.weapon.taken();
  }

  /** Someone injected the drop's serum. */
  serumTaken(id: number): void {
    const d = this.drops.get(id);
    if (!d || !d.serum) return;
    d.serumLeft = false;
    d.serum.taken();
  }

  gone(id: number): void {
    const d = this.drops.get(id);
    if (!d) return;
    d.heli?.dispose();
    d.crate.dispose();
    d.chute.dispose();
    d.weapon?.dispose();
    d.serum?.dispose();
    this.drops.delete(id);
  }

  /** Where landed canopies lie, so the lawn grass under them is pressed flat (y is the ground's). */
  pressGrass(add: (x: number, y: number, z: number, r: number) => void): void {
    for (const d of this.drops.values()) {
      if (d.landed) d.chute.pressed((x, z, r) => add(x, d.flight.ground.y, z, r));
    }
  }

  /** Helicopter positions (for its sound) by drop id, while it flies. */
  helicopters(out: Map<number, { pos: THREE.Vector3; hover: number }>): void {
    out.clear();
    for (const d of this.drops.values()) if (d.heli) out.set(d.id, { pos: d.pose.pos, hover: d.pose.hover });
  }

  /** The drop worth pointing at on the HUD: the newest one that still has ammunition. */
  marker(): DropMarker | null {
    let best: Drop | null = null;
    for (const d of this.drops.values()) if ((!d.empty || d.weaponLeft || d.serumLeft) && (!best || d.id > best.id)) best = d;
    if (!best) return null;
    const g = best.flight.ground;
    return { pos: this.tmp.set(g.x, g.y + 0.8, g.z), stage: best.landed ? 'landed' : best.heli && this.timeNow < best.flight.release ? 'inbound' : 'falling' };
  }

  private timeNow = 0;

  /** `view` is the camera position: a canopy lying far from it is left still. */
  update(dt: number, time: number, view: THREE.Vector3 | null = null): void {
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
        d.hangYaw = d.pose.yaw;
        d.crate.root.rotation.set(0, d.pose.yaw, 0);
        d.crate.root.visible = time > f.arrive - 3;
        d.crate.pose(time, false, 0);
        d.chute.hide();
      } else {
        const fall = time - f.release;
        // Swings under the canopy on the way down, coming to rest before it touches down.
        const calm = THREE.MathUtils.clamp((f.land - time) / 1.4, 0, 1);
        const sway = time < f.land ? Math.sin(fall * 1.7) * 0.5 * Math.min(1, fall / 2) * calm : 0;
        const swayZ = Math.cos(fall * 1.3) * sway * 0.6;
        d.crate.root.visible = true;
        d.crate.root.position.set(g.x + sway, g.y + h, g.z + swayZ);
        // Out of the door from where it hung, settling onto the straight fall in the first second.
        const k = Math.max(0, 1 - fall / 1.1);
        if (k > 0 && time < f.land) {
          this.tmp.set(g.x, g.y + f.releaseHeight, g.z);
          d.crate.root.position.addScaledVector(this.tmp.subVectors(d.hang, this.tmp), k * k);
        }
        // Turns from its heading in the door to the one it lands on.
        const turn = THREE.MathUtils.smoothstep(fall, 0, Math.max(0.1, f.land - f.release));
        const yaw = d.hangYaw + angleTo(d.hangYaw, d.landYaw) * turn;
        d.crate.root.rotation.set(sway * 0.06, yaw, 0);
        d.crate.pose(time, d.landed && !d.empty, d.empty ? Math.min(1, (time - d.emptyAt) / 0.5) : 0);
        // Where the canopy will lie is worked out mid-fall, not in the busy landing frame.
        if (fall > 2.5) d.chute.lay(g, d.inYaw, d.landYaw, f.land - f.release, this.physics);
        if (time < f.land) {
          // The canopy swings less than the crate hanging under it.
          this.anchor.copy(d.crate.root.position);
          this.anchor.x -= sway * 0.65;
          this.anchor.z -= swayZ * 0.65;
          // Height free under the helicopter's skids while it is still over the drop.
          let room = Infinity;
          if (d.heli) {
            const hp = d.pose.pos, c = d.crate.root.position;
            if ((hp.x - c.x) ** 2 + (hp.z - c.z) ** 2 < 12 * 12) room = hp.y - 1.62 - 0.6 - c.y;
          }
          d.chute.fly(this.anchor, d.crate.root.position, yaw, fall, time, room);
        } else {
          d.chute.settle(d.crate.root.position, yaw, time - f.land, time, dt, view);
        }
      }
      if (d.weapon) {
        d.weapon.root.visible = time >= f.land;
        d.weapon.pose(time);
      }
      if (d.serum) {
        d.serum.root.visible = time >= f.land;
        d.serum.pose(time);
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
