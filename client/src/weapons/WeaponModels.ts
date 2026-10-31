import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SKINS, defaultBuild, encodeBuild, type BuildSlot, type WeaponBuild, type WeaponId } from '@dead-hours/shared';

/**
 * A held weapon: merged low-poly parts with vertex colors (a draw call or two each), plus
 * the attachment points animation needs. Model space: +Z is the barrel, +Y the top, and the
 * origin is where the right wrist goes when holding the grip.
 */
export interface WeaponModel {
  readonly id: WeaponId;
  readonly root: THREE.Group;
  /** Detachable magazine (reloads), at rest in its well. */
  readonly mag: THREE.Object3D | null;
  readonly magRest: THREE.Vector3;
  /** Shotgun fore-end / pistol slide: slides along Z when cycling. */
  readonly action: THREE.Object3D | null;
  readonly actionRest: THREE.Vector3;
  readonly muzzle: THREE.Vector3;
  /** Left wrist target on the handguard (or the support grip for pistols). */
  readonly fore: THREE.Vector3;
  readonly eject: THREE.Vector3;
  /** Butt of the stock, seated in the shoulder when aiming (origin for pistols and blades). */
  readonly stock: THREE.Vector3;
  /** Charging handle / slide catch the left hand slaps at the end of a reload. */
  readonly bolt: THREE.Vector3;
  /** Aiming down the sights: where the eye sits behind them (model space). */
  readonly sight: Sight | null;
  /** The fitted build and its wire code (models are rebuilt when it changes). */
  readonly build: WeaponBuild;
  readonly code: string;
  /** Where each fitting sits (model space): the gunsmith's hotspots. */
  readonly points: Record<BuildSlot, THREE.Vector3>;
  readonly materials: THREE.MeshStandardMaterial[];
  dispose(): void;
}

export type Optic = 'iron' | 'dot' | 'scope';

export interface Sight {
  /** Eye position for a correct sight picture; the sight line runs along +Z from here. */
  eye: THREE.Vector3;
  /** Vertical field of view while aiming down the sights. */
  fov: number;
  optic: Optic;
}

type V3 = [number, number, number];
/** Supply-drop exclusives: sights built in, no fittings. */
const FIXED_SIGHTS: Partial<Record<WeaponId, { eye: V3; fov: number; optic: Optic }>> = {
  lmg: { eye: [0, 0.125, -0.2], fov: 48, optic: 'iron' },
  battle: { eye: [0, 0.14, -0.17], fov: 42, optic: 'dot' },
  sniper: { eye: [0, 0.16, -0.22], fov: 7, optic: 'scope' },
};

/** Iron sights each gun comes with: eye position and zoom. */
const IRONS: Partial<Record<WeaponId, { eye: V3; fov: number }>> = {
  ar: { eye: [0, 0.106, -0.2], fov: 50 },
  smg: { eye: [0, 0.1, -0.125], fov: 48 },
  shotgun: { eye: [0, 0.088, -0.26], fov: 50 },
  marksman: { eye: [0, 0.098, -0.15], fov: 50 },
  pistol: { eye: [0, 0.0885, -0.45], fov: 50 },
};

/**
 * Where an optic sits: the top of the rail (y), the optic's middle along the barrel (z), and
 * whether it rides on the slide (the pistol). `onAction` coordinates are slide-local.
 */
const RAILS: Partial<Record<WeaponId, { y: number; z: number; riser: number; onAction?: boolean }>> = {
  ar: { y: 0.08, z: 0.1, riser: 0 },
  smg: { y: 0.09, z: 0.07, riser: 0.02 },
  shotgun: { y: 0.0775, z: 0.06, riser: 0.008 },
  marksman: { y: 0.08, z: 0.075, riser: 0 },
  pistol: { y: 0.017, z: -0.035, riser: 0, onAction: true },
};

/** Optic heights above the rail (sight line), zoom and kind. */
const OPTIC_VIEW: Record<string, { h: number; fov: number; optic: Optic }> = {
  dot: { h: 0.038, fov: 44, optic: 'dot' },
  holo: { h: 0.032, fov: 44, optic: 'dot' },
  acog: { h: 0.042, fov: 26, optic: 'dot' },
  scope: { h: 0.055, fov: 14, optic: 'scope' },
  /** The pistol's mini dot. */
  mini: { h: 0.024, fov: 48, optic: 'dot' },
};

const opticKey = (id: WeaponId, optic: string) => (id === 'pistol' && optic === 'dot' ? 'mini' : optic);

/** Sights of a weapon with a build fitted (null for blades), without building its model. */
export function sightOf(id: WeaponId, build: WeaponBuild = defaultBuild(id)): Sight | null {
  const fixed = FIXED_SIGHTS[id];
  if (fixed) return { eye: new THREE.Vector3(...fixed.eye), fov: fixed.fov, optic: fixed.optic };
  const irons = IRONS[id];
  if (!irons) return null;
  const rail = RAILS[id];
  const view = OPTIC_VIEW[opticKey(id, build.optic)];
  if (!rail || !view || build.optic === 'iron') return { eye: new THREE.Vector3(...irons.eye), fov: irons.fov, optic: 'iron' };
  const base = rail.onAction ? 0.064 : 0;
  return { eye: new THREE.Vector3(0, base + rail.y + rail.riser + view.h, irons.eye[2]), fov: view.fov, optic: view.optic };
}

type Part = { g: THREE.BufferGeometry; color: number; keep: boolean };

/** Parts no finish paints over: bare steel, sight posts, glass. */
const BARE = new Set([0x141516, 0x0e0e0e, 0x8e9296, 0xb6babe]);

class Builder {
  readonly parts: Part[] = [];
  /** While set, parts added are fittings (optics, suppressors): a finish leaves them alone. */
  fitting = false;
  /** Self-lit parts (red dot, tritium and fiber-optic sights), drawn unlit so they read at night. */
  readonly glowParts: Part[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();

  private push(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, glow = false): void {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.deleteAttribute('uv');
    this.q.setFromEuler(this.e.set(rx, ry, rz));
    geo.applyMatrix4(this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(1, 1, 1)));
    (glow ? this.glowParts : this.parts).push({ g: geo, color, keep: this.fitting || BARE.has(color) });
  }

  glow(w: number, h: number, d: number, color: number, x: number, y: number, z: number): this {
    this.push(new THREE.BoxGeometry(w, h, d), color, x, y, z, 0, 0, 0, true);
    return this;
  }

  /** Open ring around the Z axis (sight apertures, hoods, optic bodies) you can look through. */
  ring(r: number, t: number, z0: number, z1: number, color: number, x: number, y: number, segs = 10): this {
    const chord = 2 * (r + t) * Math.tan(Math.PI / segs) + 0.0005;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const c = r + t / 2;
      this.push(new THREE.BoxGeometry(chord, t, Math.abs(z1 - z0)), color, x + Math.cos(a) * c, y + Math.sin(a) * c, (z0 + z1) / 2, 0, 0, a - Math.PI / 2);
    }
    return this;
  }

  box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): this {
    this.push(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx, ry, rz);
    return this;
  }

  /** Cylinder along Z from z0 to z1. */
  tube(r: number, z0: number, z1: number, color: number, x: number, y: number, segs = 8, r1 = r): this {
    this.push(new THREE.CylinderGeometry(r1, r, Math.abs(z1 - z0), segs), color, x, y, (z0 + z1) / 2, Math.PI / 2);
    return this;
  }

  /** Merged geometry with vertex colors; `paint` is a finish's colors (patchwork camo when several). */
  build(glow = false, paint: number[] = []): THREE.BufferGeometry | null {
    const parts = glow ? this.glowParts : this.parts;
    if (parts.length === 0) return null;
    const c = new THREE.Color();
    parts.forEach((p, i) => {
      const n = p.g.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      c.setHex(paint.length && !p.keep ? finish(p.color, paint, i) : p.color);
      for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3);
      p.g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    });
    const merged = mergeGeometries(parts.map((p) => p.g), false)!;
    for (const p of parts) p.g.dispose();
    merged.computeBoundingSphere();
    return merged;
  }
}

/** A part's color under a finish: the finish color picked per part, as light or dark as the part was. */
function finish(color: number, paint: number[], i: number): number {
  const pick = paint[paint.length === 1 ? 0 : ((i * 2654435761) >>> 0) % paint.length];
  const l = (((color >> 16) & 255) + ((color >> 8) & 255) + (color & 255)) / 765;
  const k = THREE.MathUtils.clamp(0.82 + (l - 0.12) * 1.4, 0.7, 1.25);
  const ch = (v: number) => Math.min(255, Math.round(v * k));
  return (ch((pick >> 16) & 255) << 16) | (ch((pick >> 8) & 255) << 8) | ch(pick & 255);
}

const BLACK = 0x1d1e20;
const DARK = 0x26272a;
const STEEL = 0x141516;
const WOOD = 0x5a3b24;
const TAN = 0x6b5f48;
const COYOTE = 0x8b7556;
/** Flat dark earth (SCAR). */
const FDE = 0x8f7a5a;
const OLIVE = 0x3b4231;
const BRASS = 0xb8913a;

interface Spec {
  body: Builder;
  mag?: { b: Builder; at: [number, number, number] };
  action?: { b: Builder; at: [number, number, number] };
  muzzle: [number, number, number];
  fore: [number, number, number];
  eject: [number, number, number];
  stock: [number, number, number];
  bolt: [number, number, number];
  /** Underside of the handguard: grips and lasers mount here. */
  under?: [number, number, number];
  /** Iron sights that fold away under an optic (the rear aperture of rifles that come with optics). */
  irons?: (b: Builder) => void;
  metal?: boolean;
  /** Non-metal parts of a metal weapon (a katana's wrapped grip, tape), or the whole of a wooden one. */
  trim?: Builder;
  trimRough?: number;
}

function m4(): Spec {
  const b = new Builder()
    .box(0.05, 0.06, 0.26, DARK, 0, 0.05, 0.08)
    .box(0.045, 0.05, 0.2, BLACK, 0, 0.0, 0.06)
    .box(0.062, 0.066, 0.24, 0x1a1b1d, 0, 0.05, 0.33)
    .tube(0.011, 0.45, 0.62, STEEL, 0, 0.05)
    .tube(0.015, 0.62, 0.67, STEEL, 0, 0.05, 6)
    // Front sight post (co-witnessed low in the optic) between protective ears.
    .box(0.004, 0.04, 0.006, BLACK, 0, 0.087, 0.43)
    .box(0.03, 0.012, 0.02, BLACK, 0, 0.074, 0.43)
    .box(0.004, 0.03, 0.016, BLACK, 0.011, 0.093, 0.43)
    .box(0.004, 0.03, 0.016, BLACK, -0.011, 0.093, 0.43)
    .box(0.02, 0.016, 0.03, BLACK, 0, 0.085, -0.02)
    .tube(0.016, -0.21, -0.05, BLACK, 0, 0.042)
    .box(0.045, 0.085, 0.11, BLACK, 0, 0.02, -0.22)
    .box(0.05, 0.12, 0.02, 0x121212, 0, 0.01, -0.28)
    .box(0.03, 0.09, 0.035, BLACK, 0, -0.045, 0.035, -0.35)
    .box(0.008, 0.01, 0.06, BLACK, 0, -0.025, 0.08);
  const mag = new Builder().box(0.024, 0.17, 0.062, 0x202124, 0, -0.08, 0.012, 0.18);
  return {
    body: b, mag: { b: mag, at: [0, -0.01, 0.12] },
    muzzle: [0, 0.05, 0.68], fore: [0.035, -0.015, 0.25], eject: [-0.03, 0.06, 0.1], stock: [0, 0.03, -0.29], bolt: [0.02, 0.085, -0.02],
    under: [0, 0.017, 0.33],
    // Flip-up rear aperture, lined up with the front post.
    irons: (r) => r.box(0.02, 0.012, 0.016, BLACK, 0, 0.092, 0.0).ring(0.0035, 0.002, -0.004, 0.004, BLACK, 0, 0.106, 10),
  };
}

function mp5(): Spec {
  const b = new Builder()
    .tube(0.026, -0.08, 0.22, DARK, 0, 0.05, 8)
    .box(0.02, 0.016, 0.22, BLACK, 0, 0.082, 0.07)
    // Rear diopter (a peep ring on its drum) and the hooded front post with a tritium dot.
    .box(0.03, 0.022, 0.03, BLACK, 0, 0.082, -0.05)
    .ring(0.006, 0.004, -0.056, -0.044, BLACK, 0, 0.1, 10)
    .box(0.02, 0.022, 0.022, BLACK, 0, 0.077, 0.24)
    .ring(0.011, 0.003, 0.232, 0.248, BLACK, 0, 0.1, 12)
    .box(0.003, 0.012, 0.004, BLACK, 0, 0.094, 0.24)
    .glow(0.0024, 0.0024, 0.0008, 0x9dff6a, 0, 0.0985, 0.2376)
    .box(0.056, 0.062, 0.14, 0x1b1c1e, 0, 0.04, 0.28)
    .tube(0.012, 0.35, 0.42, STEEL, 0, 0.05, 6)
    .box(0.04, 0.04, 0.13, BLACK, 0, 0.005, 0.03)
    .box(0.03, 0.09, 0.035, BLACK, 0, -0.045, 0.03, -0.25)
    .box(0.008, 0.008, 0.18, STEEL, 0.02, 0.045, -0.16)
    .box(0.008, 0.008, 0.18, STEEL, -0.02, 0.045, -0.16)
    .box(0.05, 0.1, 0.02, BLACK, 0, 0.035, -0.25);
  const mag = new Builder().box(0.022, 0.16, 0.034, 0x202124, 0, -0.075, 0.025, 0.35);
  return {
    body: b, mag: { b: mag, at: [0, -0.0, 0.15] },
    muzzle: [0, 0.05, 0.43], fore: [0.035, -0.01, 0.25], eject: [-0.03, 0.06, 0.08], stock: [0, 0.035, -0.26], bolt: [0.0, 0.08, 0.2],
    under: [0, 0.009, 0.28],
  };
}

function m870(): Spec {
  const b = new Builder()
    .box(0.05, 0.075, 0.2, 0x1f2022, 0, 0.04, 0.06)
    .tube(0.013, 0.16, 0.63, STEEL, 0, 0.066)
    .tube(0.013, 0.16, 0.54, 0x18191a, 0, 0.026)
    .box(0.008, 0.006, 0.01, STEEL, 0, 0.08, 0.62)
    .glow(0.005, 0.005, 0.005, 0xff8a2a, 0, 0.0845, 0.62)
    .box(0.042, 0.1, 0.27, WOOD, 0, -0.005, -0.2, 0.12)
    .box(0.046, 0.13, 0.025, 0x101010, 0, -0.03, -0.345, 0.12)
    .box(0.036, 0.06, 0.09, WOOD, 0, -0.012, -0.035, 0.45)
    .box(0.012, 0.012, 0.06, BLACK, 0, -0.01, 0.06);
  const pump = new Builder()
    .box(0.052, 0.05, 0.17, WOOD, 0, 0, 0)
    .box(0.056, 0.006, 0.17, 0x4a3020, 0, -0.01, 0);
  return {
    body: b, action: { b: pump, at: [0, 0.026, 0.27] },
    muzzle: [0, 0.066, 0.64], fore: [0.035, -0.002, 0.27], eject: [-0.03, 0.05, 0.07], stock: [0, -0.01, -0.35], bolt: [0.035, -0.002, 0.27],
    // The pump slides: the laser rides on the receiver's side.
    under: [0.032, 0.03, 0.12],
  };
}

function mk14(): Spec {
  const b = new Builder()
    .box(0.06, 0.08, 0.42, TAN, 0, 0.04, 0.12)
    .box(0.066, 0.02, 0.3, 0x5d5340, 0, 0.04, 0.2)
    .tube(0.012, 0.33, 0.63, STEEL, 0, 0.06)
    .tube(0.019, 0.63, 0.69, STEEL, 0, 0.06, 6)
    // Front post on the gas block (the rear aperture folds under an optic).
    .box(0.016, 0.014, 0.02, BLACK, 0, 0.077, 0.6)
    .box(0.004, 0.022, 0.005, BLACK, 0, 0.09, 0.6)
    .box(0.04, 0.05, 0.18, TAN, 0, 0.045, -0.18)
    .box(0.03, 0.03, 0.1, TAN, 0, 0.085, -0.17)
    .box(0.05, 0.12, 0.03, BLACK, 0, 0.025, -0.28)
    .box(0.03, 0.09, 0.035, BLACK, 0, -0.045, 0.035, -0.3);
  const mag = new Builder().box(0.03, 0.11, 0.07, 0x1c1c1c, 0, -0.055, 0, 0.05);
  return {
    body: b, mag: { b: mag, at: [0, -0.005, 0.12] },
    muzzle: [0, 0.06, 0.7], fore: [0.04, -0.01, 0.26], eject: [-0.035, 0.06, 0.1], stock: [0, 0.03, -0.3], bolt: [0.035, 0.07, 0.05],
    under: [0, 0.0, 0.26],
    irons: (r) => r.box(0.02, 0.012, 0.018, BLACK, 0, 0.086, -0.05).ring(0.0035, 0.002, -0.054, -0.046, BLACK, 0, 0.098, 10),
  };
}

function m249(): Spec {
  const b = new Builder()
    // Receiver with the feed tray cover on top, handguard and a long barrel under a carry handle.
    .box(0.07, 0.085, 0.36, DARK, 0, 0.045, 0.06)
    .box(0.072, 0.024, 0.2, BLACK, 0, 0.1, 0.03)
    .box(0.074, 0.006, 0.04, STEEL, 0, 0.113, 0.11)
    .box(0.076, 0.06, 0.2, BLACK, 0, 0.03, 0.34)
    .tube(0.014, 0.44, 0.8, STEEL, 0, 0.05)
    .tube(0.019, 0.8, 0.86, STEEL, 0, 0.05, 6)
    .tube(0.009, 0.44, 0.68, STEEL, 0, 0.018)
    .box(0.012, 0.04, 0.012, BLACK, -0.05, 0.08, 0.46)
    .box(0.012, 0.04, 0.012, BLACK, -0.05, 0.08, 0.58)
    .box(0.018, 0.014, 0.15, BLACK, -0.05, 0.105, 0.52)
    // Folded bipod under the barrel.
    .box(0.01, 0.01, 0.28, STEEL, 0.012, 0.0, 0.62)
    .box(0.01, 0.01, 0.28, STEEL, -0.012, 0.0, 0.62)
    .box(0.03, 0.016, 0.03, BLACK, 0, 0.012, 0.76)
    // Hooded front post on the barrel, rear aperture on the cover.
    .box(0.022, 0.035, 0.02, BLACK, 0, 0.073, 0.76)
    .box(0.004, 0.035, 0.005, BLACK, 0, 0.1075, 0.76)
    .box(0.004, 0.03, 0.016, BLACK, 0.012, 0.11, 0.76)
    .box(0.004, 0.03, 0.016, BLACK, -0.012, 0.11, 0.76)
    .box(0.03, 0.006, 0.03, BLACK, 0, 0.115, -0.06)
    .ring(0.006, 0.004, -0.066, -0.054, BLACK, 0, 0.125, 10)
    // Grip, trigger guard, skeleton stock and butt.
    .box(0.03, 0.09, 0.035, BLACK, 0, -0.045, 0.035, -0.3)
    .box(0.008, 0.01, 0.06, BLACK, 0, -0.025, 0.08)
    .box(0.03, 0.025, 0.2, BLACK, 0, 0.065, -0.22)
    .box(0.03, 0.02, 0.2, BLACK, 0, 0.0, -0.22, 0.12)
    .box(0.05, 0.12, 0.022, 0x121212, 0, 0.025, -0.33);
  // The belt box hangs under the left of the receiver, a strip of rounds running up into the feed.
  const mag = new Builder()
    .box(0.075, 0.12, 0.11, OLIVE, -0.005, -0.06, 0)
    .box(0.077, 0.01, 0.112, 0x2c3125, -0.005, -0.004, 0)
    .box(0.028, 0.016, 0.05, BRASS, 0.02, 0.006, 0);
  return {
    body: b, mag: { b: mag, at: [-0.012, 0.0, 0.14] },
    muzzle: [0, 0.05, 0.87], fore: [0.04, -0.005, 0.34], eject: [-0.035, 0.01, 0.1], stock: [0, 0.03, -0.34], bolt: [0.04, 0.05, 0.12],
  };
}

function scarH(): Spec {
  const b = new Builder()
    // Angular FDE upper with a full-length rail, black lower.
    .box(0.058, 0.065, 0.42, FDE, 0, 0.06, 0.13)
    .box(0.026, 0.012, 0.42, BLACK, 0, 0.098, 0.13)
    .box(0.062, 0.03, 0.16, FDE, 0, 0.04, 0.27)
    .box(0.05, 0.05, 0.2, BLACK, 0, 0.005, 0.05)
    .tube(0.013, 0.34, 0.56, STEEL, 0, 0.055)
    .tube(0.019, 0.56, 0.62, STEEL, 0, 0.055, 6)
    // Holographic sight: a rectangular window on the rail, the reticle at its front pane.
    .box(0.036, 0.02, 0.07, BLACK, 0, 0.114, 0.08)
    .box(0.046, 0.006, 0.04, BLACK, 0, 0.158, 0.09)
    .box(0.006, 0.036, 0.04, BLACK, 0.02, 0.14, 0.09)
    .box(0.006, 0.036, 0.04, BLACK, -0.02, 0.14, 0.09)
    .box(0.046, 0.004, 0.04, BLACK, 0, 0.124, 0.09)
    .glow(0.0024, 0.0024, 0.0008, 0xff2414, 0, 0.14, 0.108)
    .glow(0.012, 0.0008, 0.0008, 0xff2414, 0, 0.1465, 0.108)
    .glow(0.012, 0.0008, 0.0008, 0xff2414, 0, 0.1335, 0.108)
    .glow(0.0008, 0.012, 0.0008, 0xff2414, 0.0065, 0.14, 0.108)
    .glow(0.0008, 0.012, 0.0008, 0xff2414, -0.0065, 0.14, 0.108)
    // Charging handle on the left, grip, folding stock with a cheek riser.
    .box(0.03, 0.012, 0.02, BLACK, -0.04, 0.07, 0.2)
    .box(0.03, 0.09, 0.035, BLACK, 0, -0.045, 0.035, -0.3)
    .box(0.008, 0.01, 0.06, BLACK, 0, -0.025, 0.08)
    .box(0.04, 0.06, 0.24, BLACK, 0, 0.045, -0.185)
    .box(0.034, 0.022, 0.12, FDE, 0, 0.085, -0.2)
    .box(0.05, 0.12, 0.025, 0x121212, 0, 0.03, -0.3);
  const mag = new Builder().box(0.03, 0.14, 0.072, 0x1c1c1c, 0, -0.07, 0, 0.1);
  return {
    body: b, mag: { b: mag, at: [0, -0.01, 0.12] },
    muzzle: [0, 0.055, 0.63], fore: [0.035, -0.005, 0.27], eject: [-0.03, 0.06, 0.1], stock: [0, 0.03, -0.31], bolt: [-0.04, 0.07, 0.2],
  };
}

function m107(): Spec {
  const b = new Builder()
    // Long boxy receiver and rail, a heavy barrel ending in a two-port brake.
    .box(0.075, 0.09, 0.55, DARK, 0, 0.05, 0.1)
    .box(0.03, 0.014, 0.5, BLACK, 0, 0.102, 0.1)
    .box(0.08, 0.06, 0.12, BLACK, 0, 0.04, 0.42)
    .tube(0.019, 0.48, 0.98, STEEL, 0, 0.06, 10)
    .box(0.07, 0.05, 0.09, STEEL, 0, 0.06, 1.02)
    .box(0.076, 0.014, 0.014, BLACK, 0, 0.06, 1.0)
    .box(0.076, 0.014, 0.014, BLACK, 0, 0.06, 1.035)
    // A big scope on two rings.
    .tube(0.021, -0.05, 0.2, 0x111214, 0, 0.16, 10)
    .tube(0.031, -0.13, -0.05, 0x111214, 0, 0.16, 10, 0.023)
    .tube(0.023, 0.2, 0.31, 0x111214, 0, 0.16, 10, 0.038)
    .tube(0.026, 0.06, 0.09, 0x111214, 0, 0.16, 8)
    .box(0.03, 0.045, 0.025, BLACK, 0, 0.13, 0.0)
    .box(0.03, 0.045, 0.025, BLACK, 0, 0.13, 0.16)
    // Bipod folded along the barrel.
    .box(0.012, 0.012, 0.34, STEEL, 0.02, 0.02, 0.68)
    .box(0.012, 0.012, 0.34, STEEL, -0.02, 0.02, 0.68)
    .box(0.05, 0.025, 0.04, BLACK, 0, 0.03, 0.5)
    // Grip, trigger guard, stock with butt pad and monopod.
    .box(0.035, 0.1, 0.04, BLACK, 0, -0.05, 0.035, -0.3)
    .box(0.01, 0.012, 0.07, BLACK, 0, -0.02, 0.08)
    .box(0.05, 0.1, 0.24, DARK, 0, 0.03, -0.29)
    .box(0.04, 0.03, 0.14, BLACK, 0, 0.09, -0.3)
    .box(0.056, 0.15, 0.03, 0x101010, 0, 0.02, -0.42)
    .box(0.015, 0.08, 0.015, STEEL, 0, -0.04, -0.36);
  const mag = new Builder()
    .box(0.05, 0.1, 0.12, 0x1a1a1a, 0, -0.05, 0)
    .box(0.03, 0.012, 0.09, BRASS, 0, 0.004, 0);
  return {
    body: b, mag: { b: mag, at: [0, 0.0, 0.16] },
    muzzle: [0, 0.06, 1.07], fore: [0.04, 0.0, 0.32], eject: [-0.04, 0.07, 0.12], stock: [0, 0.03, -0.43], bolt: [0.045, 0.07, 0.15],
  };
}

function m17(): Spec {
  const b = new Builder()
    .box(0.028, 0.025, 0.16, COYOTE, 0, 0.035, 0.1)
    .box(0.03, 0.11, 0.046, COYOTE, 0, -0.015, 0.045, -0.3)
    .box(0.01, 0.01, 0.045, COYOTE, 0, 0.004, 0.1);
  const slide = new Builder()
    .box(0.027, 0.034, 0.19, 0x1b1b1c, 0, 0, 0)
    // Three-dot night sights: front post, rear notch.
    .box(0.004, 0.009, 0.005, 0x0e0e0e, 0, 0.0205, 0.085)
    .glow(0.0022, 0.0022, 0.0008, 0x9dff6a, 0, 0.0215, 0.0822)
    .box(0.0075, 0.01, 0.01, 0x0e0e0e, 0.006, 0.021, -0.088)
    .box(0.0075, 0.01, 0.01, 0x0e0e0e, -0.006, 0.021, -0.088)
    .glow(0.002, 0.002, 0.0008, 0x9dff6a, 0.006, 0.0215, -0.0935)
    .glow(0.002, 0.002, 0.0008, 0x9dff6a, -0.006, 0.0215, -0.0935);
  const mag = new Builder().box(0.024, 0.1, 0.036, 0x161616, 0, -0.045, 0, -0.3).box(0.03, 0.012, 0.045, 0x161616, 0, -0.098, -0.015, -0.3);
  return {
    body: b, action: { b: slide, at: [0, 0.064, 0.1] }, mag: { b: mag, at: [0, 0.02, 0.05] },
    muzzle: [0, 0.064, 0.2], fore: [0.03, -0.035, 0.035], eject: [-0.02, 0.07, 0.1], stock: [0, 0, 0], bolt: [0.0, 0.07, 0.03],
    under: [0, -0.002, 0.13],
  };
}

function machete(): Spec {
  const b = new Builder()
    .tube(0.017, -0.03, 0.11, 0x151515, 0, 0, 8)
    .box(0.014, 0.045, 0.014, 0x2a2a2a, 0, 0.004, 0.115)
    .box(0.004, 0.05, 0.36, 0x8e9296, 0, 0.014, 0.3)
    .box(0.004, 0.034, 0.09, 0x8e9296, 0, 0.022, 0.51, -0.25)
    .box(0.0045, 0.008, 0.36, 0xb6babe, 0, -0.008, 0.3);
  return {
    body: b, metal: true,
    muzzle: [0, 0.01, 0.56], fore: [0, 0, 0], eject: [0, 0, 0], stock: [0, 0, 0], bolt: [0, 0, 0],
  };
}

/** Melee models: origin at the right hand's grip, +Z toward the striking end, +Y the edge's back. */
const MELEE_POINTS = { eject: [0, 0, 0] as V3, stock: [0, 0, 0] as V3, bolt: [0, 0, 0] as V3 };

function katana(): Spec {
  const blade = new Builder();
  // A gently curved blade (sori): short segments rising toward the tip, the back (mune) up.
  const segs = 9, z0 = 0.075, len = 0.7;
  for (let i = 0; i < segs; i++) {
    const u0 = i / segs, u1 = (i + 1) / segs;
    const zc = z0 + len * (u0 + u1) / 2;
    const rise = (u: number) => 0.022 * u * u;
    const yc = (rise(u0) + rise(u1)) / 2;
    const tilt = -Math.atan2(rise(u1) - rise(u0), len / segs);
    const h = 0.03 - 0.006 * u1;
    blade.box(0.0055, h, len / segs + 0.002, 0x9ea4aa, 0, yc + 0.004, zc, tilt);
    // The hardened edge (hamon side): bright steel.
    blade.box(0.0035, 0.008, len / segs + 0.002, 0xd8dde2, 0, yc - h / 2 + 0.006, zc, tilt);
  }
  // Kissaki: the angled point.
  blade.box(0.005, 0.02, 0.05, 0xb9bec4, 0, 0.026, z0 + len + 0.016, -0.55);
  // Habaki (brass collar) and tsuba (guard).
  blade.box(0.012, 0.036, 0.026, 0xb08a3c, 0, 0.003, 0.068);
  blade.tube(0.042, 0.05, 0.057, 0x2a2622, 0, 0.002, 10);
  blade.tube(0.017, -0.245, -0.235, 0x6b5a3a, 0, 0.002, 8);
  const grip = new Builder()
    .tube(0.0155, -0.235, 0.05, 0x1a1817, 0, 0.002, 8, 0.0165);
  // Ito wrap: diamonds along the grip.
  for (let i = 0; i < 9; i++) {
    const z = -0.22 + i * 0.03;
    grip.box(0.034, 0.008, 0.012, 0x2c2622, 0, 0.002, z, 0, 0, 0.7);
    grip.box(0.034, 0.008, 0.012, 0x2c2622, 0, 0.002, z + 0.015, 0, 0, -0.7);
  }
  return {
    body: blade, trim: grip, trimRough: 0.85, metal: true,
    muzzle: [0, 0.03, 0.78], fore: [0, 0, -0.17], ...MELEE_POINTS,
  };
}

function bat(): Spec {
  const ASH = 0xb8915e;
  const b = new Builder()
    // Knob, taped handle, the flare and the barrel.
    .tube(0.026, -0.14, -0.125, 0x9c7a4c, 0, 0, 10, 0.02)
    .tube(0.0145, -0.125, 0.16, ASH, 0, 0, 10, 0.016)
    .tube(0.016, 0.16, 0.42, ASH, 0, 0, 10, 0.03)
    .tube(0.03, 0.42, 0.74, 0xbf9963, 0, 0, 12, 0.034)
    .tube(0.034, 0.74, 0.755, 0xa88352, 0, 0, 12, 0.03);
  // Grip tape spiral and the burnt-in brand.
  for (let i = 0; i < 8; i++) b.box(0.033, 0.006, 0.014, 0x161616, 0, 0, -0.11 + i * 0.026, 0, 0, i % 2 ? 0.5 : -0.5);
  b.box(0.004, 0.02, 0.07, 0x3a2410, 0.031, 0.006, 0.56);
  // Dark, dried stains on the barrel: it has been used.
  b.box(0.006, 0.024, 0.05, 0x3b0d0a, 0.03, -0.01, 0.65, 0, 0, 0.4);
  return {
    body: new Builder(), trim: b, trimRough: 0.62,
    muzzle: [0, 0, 0.75], fore: [0, 0, -0.085], ...MELEE_POINTS,
  };
}

function crowbar(): Spec {
  const RED = 0x8f1d17;
  const b = new Builder()
    // Hex bar, painted, worn to bare iron at the ends.
    .tube(0.0115, -0.13, 0.44, RED, 0, 0, 6)
    .tube(0.0115, -0.2, -0.13, 0x3a3836, 0, 0, 6, 0.0115)
    // Flat chisel end, slightly bent.
    .box(0.026, 0.006, 0.05, 0x4a4744, 0, 0.004, -0.225, 0.15)
    // The goose neck curling back over the top, and its split claw.
    .tube(0.0115, 0.44, 0.48, 0x4a4744, 0, 0, 6);
  const arc = [[0.5, 0.012, 0.5], [0.52, 0.036, 1.05], [0.522, 0.066, 1.6], [0.51, 0.094, 2.2], [0.488, 0.11, 2.75]];
  for (const [z, y, a] of arc) b.box(0.022, 0.022, 0.04, 0x4a4744, 0, y, z, -a);
  b.box(0.03, 0.007, 0.045, 0x3a3836, 0, 0.116, 0.462, -3.0);
  b.box(0.004, 0.012, 0.03, 0x1a1a1a, 0, 0.12, 0.45, -3.0);
  return {
    body: b, metal: true,
    muzzle: [0, 0.1, 0.5], fore: [0, 0, -0.08], ...MELEE_POINTS,
  };
}

function wrench(): Spec {
  const IRON = 0x7a2a22, BARE = 0x55585a;
  const b = new Builder()
    // I-beam handle with a hanging hole at the end.
    .box(0.014, 0.03, 0.3, IRON, 0, 0, 0.06)
    .box(0.026, 0.008, 0.3, IRON, 0, 0.015, 0.06)
    .box(0.026, 0.008, 0.3, IRON, 0, -0.015, 0.06)
    .box(0.03, 0.038, 0.03, BARE, 0, 0, -0.105)
    // The head: fixed hook jaw, knurled adjusting nut, sliding hook jaw.
    .box(0.03, 0.05, 0.06, IRON, 0, 0.012, 0.235)
    .box(0.03, 0.02, 0.05, BARE, 0, 0.05, 0.27)
    .tube(0.017, 0.255, 0.285, BARE, 0, 0.065, 10)
    .box(0.032, 0.11, 0.024, IRON, 0, 0.08, 0.3)
    .box(0.03, 0.022, 0.052, IRON, 0, 0.128, 0.322);
  // Jaw teeth.
  for (let i = 0; i < 4; i++) b.box(0.032, 0.004, 0.006, 0x2a2b2c, 0, 0.115, 0.306 + i * 0.008);
  return {
    body: b, metal: true,
    muzzle: [0, 0.1, 0.33], fore: [0, 0, -0.07], ...MELEE_POINTS,
  };
}

function hockey(): Spec {
  const SHAFT = 0x22262c, BLADE = 0x2c3038;
  const b = new Builder()
    // Composite shaft: the left hand at the taped butt, the right partway down.
    .box(0.03, 0.022, 1.18, SHAFT, 0, 0, 0.29)
    .box(0.031, 0.023, 0.12, 0x101010, 0, 0, -0.25)
    .box(0.036, 0.028, 0.025, 0x101010, 0, 0, -0.31)
    .box(0.0305, 0.0225, 0.25, 0xc8ccd0, 0, 0, 0.55)
    // The heel, then the curved blade off to the side, its tape wrapped white.
    .box(0.03, 0.024, 0.07, BLADE, 0.004, -0.004, 0.9, 0, 0.4);
  const curve = [[0.04, 0.95, 0.75], [0.1, 0.985, 1.05], [0.17, 1.005, 1.28], [0.24, 1.01, 1.5]];
  for (const [x, z, a] of curve) {
    b.box(0.075, 0.07, 0.012, BLADE, x, 0.018, z, 0, a - Math.PI / 2 + 0.1);
    b.box(0.072, 0.03, 0.013, 0xe7e7e2, x, 0.015, z, 0, a - Math.PI / 2 + 0.1);
  }
  return {
    body: new Builder(), trim: b, trimRough: 0.45,
    muzzle: [0.14, 0.02, 1.0], fore: [0, 0, -0.26], ...MELEE_POINTS,
  };
}

const SPECS: Record<WeaponId, () => Spec> = { ar: m4, smg: mp5, shotgun: m870, marksman: mk14, pistol: m17, machete, lmg: m249, battle: scarH, sniper: m107,
  katana, bat, crowbar, wrench, hockey,
};

const v = (a: V3) => new THREE.Vector3(...a);

// ------------------------------------------------------------------ fittings

/** An optic on the rail: `y` is the rail top, `z` the optic's middle; a riser lifts it over integral sights. */
function optic(b: Builder, kind: string, y: number, z: number, riser: number): void {
  if (riser > 0) b.box(0.03, riser, 0.05, BLACK, 0, y + riser / 2, z);
  y += riser;
  switch (kind) {
    case 'dot':
      // An open tube on a mount, the dot floating at its front.
      b.box(0.03, 0.022, 0.05, BLACK, 0, y + 0.007, z)
        .ring(0.021, 0.005, z - 0.03, z + 0.04, STEEL, 0, y + 0.038, 12)
        .ring(0.026, 0.003, z + 0.036, z + 0.044, BLACK, 0, y + 0.038, 12)
        .glow(0.0022, 0.0022, 0.0008, 0xff2414, 0, y + 0.038, z + 0.036);
      break;
    case 'holo': {
      // A square window in a hood over the battery housing; the ring reticle seems to float in it.
      b.box(0.036, 0.012, 0.075, BLACK, 0, y + 0.006, z)
        .box(0.03, 0.009, 0.03, BLACK, 0, y + 0.016, z - 0.024)
        .box(0.004, 0.046, 0.06, DARK, 0.021, y + 0.035, z)
        .box(0.004, 0.046, 0.06, DARK, -0.021, y + 0.035, z)
        .box(0.046, 0.005, 0.06, DARK, 0, y + 0.06, z);
      const r = 0.0062, h = y + 0.032, gz = z + 0.026;
      b.glow(0.0016, 0.0016, 0.0008, 0xff3020, 0, h, gz);
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        b.glow(0.0013, 0.0013, 0.0008, 0xff3020, Math.cos(a) * r, h + Math.sin(a) * r, gz);
      }
      break;
    }
    case 'acog':
      // A short prism tube (open, to see through) with a lit chevron.
      b.box(0.026, 0.016, 0.06, BLACK, 0, y + 0.008, z)
        .ring(0.016, 0.004, z - 0.05, z + 0.03, DARK, 0, y + 0.042, 12)
        .ring(0.021, 0.003, z + 0.03, z + 0.07, DARK, 0, y + 0.042, 12)
        .box(0.012, 0.008, 0.04, 0x2e3a24, 0, y + 0.066, z)
        .glow(0.0016, 0.0032, 0.0008, 0xff4a1a, 0, y + 0.0405, z + 0.01)
        .glow(0.0032, 0.0014, 0.0008, 0xff4a1a, 0, y + 0.042, z + 0.01);
      break;
    case 'scope':
      // Long tube with bells on two rings (looking through it is the scope view, not this model).
      b.tube(0.025, z - 0.095, z + 0.085, 0x111214, 0, y + 0.055, 10)
        .tube(0.031, z - 0.135, z - 0.095, 0x111214, 0, y + 0.055, 10, 0.026)
        .tube(0.026, z + 0.085, z + 0.135, 0x111214, 0, y + 0.055, 10, 0.033)
        .box(0.025, 0.04, 0.02, BLACK, 0, y + 0.02, z - 0.075)
        .box(0.025, 0.04, 0.02, BLACK, 0, y + 0.02, z + 0.055);
      break;
    case 'mini':
      // Pistol dot: a small open window on the slide.
      b.box(0.024, 0.01, 0.034, BLACK, 0, y + 0.005, z)
        .box(0.004, 0.024, 0.012, BLACK, 0.011, y + 0.02, z + 0.008)
        .box(0.004, 0.024, 0.012, BLACK, -0.011, y + 0.02, z + 0.008)
        .box(0.026, 0.004, 0.012, BLACK, 0, y + 0.034, z + 0.008)
        .glow(0.0018, 0.0018, 0.0008, 0xff2414, 0, y + 0.024, z + 0.008);
      break;
    default:
      break;
  }
}

/** A muzzle device; returns how far it moves the muzzle forward. */
function muzzleDevice(b: Builder, kind: string, m: V3, small: boolean): number {
  const [x, y, z] = m;
  if (kind === 'suppressor') {
    const len = small ? 0.13 : 0.17;
    b.tube(small ? 0.016 : 0.021, z - 0.01, z + len, 0x1a1b1d, x, y, 10).tube(small ? 0.012 : 0.016, z + len, z + len + 0.004, 0x0b0b0c, x, y, 10);
    return len;
  }
  if (kind === 'compensator') {
    b.tube(0.015, z - 0.005, z + 0.045, DARK, x, y, 8)
      .box(0.006, 0.005, 0.01, 0x070707, x, y + 0.013, z + 0.014)
      .box(0.006, 0.005, 0.01, 0x070707, x, y + 0.013, z + 0.03);
    return 0.045;
  }
  if (kind === 'choke') {
    b.tube(0.017, z - 0.005, z + 0.03, 0x2a2b2e, x, y, 10);
    return 0.03;
  }
  return 0;
}

/** Grip or laser under the handguard; returns where the support hand goes instead (or null). */
function underbarrel(b: Builder, kind: string, u: V3, fore: V3): V3 | null {
  const [x, y, z] = u;
  if (kind === 'vertical') {
    b.box(0.022, 0.012, 0.04, BLACK, x, y - 0.006, z).box(0.024, 0.075, 0.028, 0x1a1b1d, x, y - 0.048, z, -0.12);
    return [fore[0], y - 0.05, z];
  }
  if (kind === 'angled') {
    b.box(0.024, 0.026, 0.075, 0x1a1b1d, x, y - 0.013, z - 0.01, 0.35);
    return [fore[0], y - 0.02, z - 0.02];
  }
  if (kind === 'laser') {
    b.box(0.02, 0.018, 0.045, DARK, x, y - 0.01, z).glow(0.004, 0.004, 0.0008, 0xff3020, x, y - 0.01, z + 0.0228);
  }
  return null;
}

export function createWeaponModel(id: WeaponId, build: WeaponBuild = defaultBuild(id)): WeaponModel {
  const spec = (SPECS[id] ?? m4)();
  const skin = SKINS.find((k) => k.id === build.skin) ?? SKINS[0];
  const paint = skin.colors;
  const rail = RAILS[id];
  const fore = [...spec.fore] as V3;
  const muzzle = [...spec.muzzle] as V3;
  const points = {} as Record<BuildSlot, THREE.Vector3>;
  // Fittings: built into the body (or the slide) as unpainted parts.
  const body = spec.body;
  body.fitting = true;
  if (rail) {
    const kind = opticKey(id, build.optic);
    const on = rail.onAction && spec.action ? spec.action.b : body;
    on.fitting = true;
    if (build.optic === 'iron') spec.irons?.(body);
    else optic(on, kind, rail.y, rail.z, rail.riser);
    on.fitting = on === body;
    const base: V3 = rail.onAction && spec.action ? spec.action.at : [0, 0, 0];
    points.optic = new THREE.Vector3(base[0], base[1] + rail.y + rail.riser + 0.03, base[2] + rail.z);
  }
  points.muzzle = v(spec.muzzle);
  muzzle[2] += muzzleDevice(body, build.muzzle, spec.muzzle, id === 'pistol');
  if (spec.under) {
    const hand = underbarrel(body, build.grip, spec.under, spec.fore);
    if (hand) fore.splice(0, 3, ...hand);
    points.grip = v(spec.under).add(new THREE.Vector3(0, -0.02, 0));
  }
  if (build.mag === 'extended' && spec.action && !spec.mag) {
    // Tube magazine: an extension past the end of the tube.
    body.tube(0.013, 0.54, 0.6, 0x18191a, 0, 0.026).tube(0.015, 0.6, 0.61, BLACK, 0, 0.026);
  }
  body.fitting = false;
  if (spec.mag && build.mag === 'fast') {
    // Pull tab under the magazine's floor plate.
    const box = new THREE.Box3();
    for (const p of spec.mag.b.parts) {
      p.g.computeBoundingBox();
      box.union(p.g.boundingBox!);
    }
    spec.mag.b.fitting = true;
    spec.mag.b.box(0.012, 0.022, 0.012, 0xb8401c, 0, box.min.y - 0.009, (box.min.z + box.max.z) / 2);
  }
  points.mag = spec.mag ? v(spec.mag.at).add(new THREE.Vector3(0, -0.07, 0)) : spec.under ? v(spec.under).add(new THREE.Vector3(0, -0.02, 0.12)) : v(spec.fore);
  points.skin = id === 'pistol' ? new THREE.Vector3(0, -0.02, 0.045) : v(spec.stock).add(new THREE.Vector3(0, 0, 0.08));

  const root = new THREE.Group();
  root.name = `weapon:${id}`;
  const materials: THREE.MeshStandardMaterial[] = [];
  const glowMaterials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const metallic = spec.metal || skin.metal;
  const mesh = (b: Builder, parent: THREE.Object3D, metal = 0.35, trim = false) => {
    // Trim (wood, tape, rubber) keeps its own colors under a finish.
    const g = b.build(false, trim ? undefined : paint);
    if (!g) return null;
    geometries.push(g);
    // Double-sided: looking down the sights puts the eye inside apertures and optic tubes.
    const mat = trim
      ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: spec.trimRough ?? 0.7, metalness: 0.02, flatShading: true, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: metallic ? 0.32 : 0.55, metalness: metallic ? 0.75 : metal, flatShading: true, side: THREE.DoubleSide });
    if (skin.glow && !trim) mat.emissive.setRGB(0.04, 0.22, 0.2);
    mat.userData.baseEmissive = mat.emissive.getHex();
    materials.push(mat);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    parent.add(m);
    const glow = b.build(true);
    if (glow) {
      geometries.push(glow);
      const gm = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
      glowMaterials.push(gm);
      parent.add(new THREE.Mesh(glow, gm));
    }
    return m;
  };
  mesh(spec.body, root);
  if (spec.trim) mesh(spec.trim, root, 0, true);
  const sub = (s: { b: Builder; at: [number, number, number] } | undefined) => {
    if (!s) return null;
    const o = new THREE.Group();
    o.position.set(...s.at);
    root.add(o);
    mesh(s.b, o);
    return o;
  };
  const mag = sub(spec.mag);
  const action = sub(spec.action);
  // Extended box magazines: longer, growing down out of the well.
  if (mag && build.mag === 'extended') mag.scale.set(1, 1.4, 1.06);
  return {
    id, root, mag, action,
    magRest: mag ? mag.position.clone() : new THREE.Vector3(),
    actionRest: action ? action.position.clone() : new THREE.Vector3(),
    muzzle: v(muzzle), fore: v(fore), eject: v(spec.eject), stock: v(spec.stock), bolt: v(spec.bolt),
    sight: sightOf(id, build),
    build: { ...build },
    code: encodeBuild(build),
    points,
    materials,
    dispose() {
      root.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const m of glowMaterials) m.dispose();
    },
  };
}
