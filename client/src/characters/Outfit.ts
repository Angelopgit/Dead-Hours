import * as THREE from 'three';
import { SHAPE_MID, paletteColor, type Appearance } from '@dead-hours/shared';
import { BONE } from './rig';

/** Fabric patterns, drawn per pixel by the character material from bind-pose position. */
export const PATTERN = { none: 0, plaid: 1, stripes: 2, camo: 3, floral: 4, knit: 5, denim: 6 } as const;

/** Per-vertex soft shading: scales `c` for a vertex at bone-space (x, y, z) (shadow under the jaw, eye sockets). */
export type Shade = (x: number, y: number, z: number, c: THREE.Color) => void;

export interface Surface {
  pattern?: number;
  /** Second pattern color (plaid lines, stripes, flowers). */
  accent?: number;
  /** Soft shading over the part (see Shade). */
  shade?: Shade;
}

/**
 * A limb's joint (elbow, knee): the part's vertices within `band` of bone-space height `y` lean
 * on `bone` as well, up to half at the joint, so the limb bends there in one smooth piece.
 */
export interface SkinBlend {
  bone: number;
  y: number;
  band: number;
}

/** Receives one primitive: its bone, color, bone-space transform, optional fabric pattern and joint blend. */
export type PartSink = (g: THREE.BufferGeometry, bone: number, hex: number, m: THREE.Matrix4, s?: Surface, blend?: SkinBlend) => void;

type V3 = readonly [number, number, number];
const O: V3 = [0, 0, 0];
const TAU = Math.PI * 2;
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

function mat(p: V3 = O, r: V3 = O, s: V3 | number = 1): THREE.Matrix4 {
  _p.set(p[0], p[1], p[2]);
  _q.setFromEuler(_e.set(r[0], r[1], r[2]));
  if (typeof s === 'number') _s.setScalar(s);
  else _s.set(s[0], s[1], s[2]);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

const _c1 = new THREE.Color(), _c2 = new THREE.Color();
export function mixHex(a: number, b: number, t: number): number {
  return _c1.setHex(a).lerp(_c2.setHex(b), t).getHex();
}
/** Darker (k < 1) or lighter (k > 1) version of a color. */
export function shade(hex: number, k: number): number {
  return k < 1 ? mixHex(hex, 0x000000, 1 - k) : mixHex(hex, 0xffffff, k - 1);
}
function luminance(hex: number): number {
  return ((hex >> 16 & 255) * 0.299 + (hex >> 8 & 255) * 0.587 + (hex & 255) * 0.114) / 255;
}

interface CylOpts { seg?: number; open?: boolean; t0?: number; tl?: number }

/** Places primitives on one bone, inside an optional local frame. */
class Kit {
  constructor(readonly sink: PartSink, readonly bone: number, readonly frame = new THREE.Matrix4()) {}

  at(p: V3 = O, r: V3 = O, s: V3 | number = 1): Kit {
    return new Kit(this.sink, this.bone, this.frame.clone().multiply(mat(p, r, s)));
  }

  put(g: THREE.BufferGeometry, hex: number, p?: V3, r?: V3, s?: V3 | number, surf?: Surface, blend?: SkinBlend): void {
    this.sink(g, this.bone, hex, this.frame.clone().multiply(mat(p, r, s)), surf, blend);
  }

  /**
   * A limb's surface turned from `rings` (radii scaled by `rk`, `inf` out from them), `seg` sides,
   * closed at the top and/or bottom; `blend` bends it with the next bone at a joint.
   */
  lathe(hex: number, rings: readonly Ring[], rk: number, inf: number, seg: number, caps: { top?: boolean; bottom?: boolean }, surf?: Surface, blend?: SkinBlend): void {
    this.put(latheGeometry(rings, rk, inf, seg, !!caps.top, !!caps.bottom), hex, O, O, 1, surf, blend);
  }

  /** Oriented so local +Y points along `dir`. */
  putAlong(g: THREE.BufferGeometry, hex: number, p: V3, dir: THREE.Vector3, s: V3 | number = 1, surf?: Surface): void {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const sc = typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
    this.sink(g, this.bone, hex, this.frame.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...p), q, sc)), surf);
  }

  box(hex: number, size: V3, p?: V3, r?: V3, surf?: Surface): void {
    this.put(new THREE.BoxGeometry(size[0], size[1], size[2]), hex, p, r, 1, surf);
  }

  ball(hex: number, radii: V3 | number, p?: V3, r?: V3, surf?: Surface, w = 10, h = 7): void {
    const s: V3 = typeof radii === 'number' ? [radii, radii, radii] : radii;
    this.put(new THREE.SphereGeometry(1, w, h), hex, p, r, s, surf);
  }

  ico(hex: number, radius: number, p?: V3, r?: V3, s: V3 | number = 1, detail = 1, surf?: Surface): void {
    this.put(new THREE.IcosahedronGeometry(radius, detail), hex, p, r, s, surf);
  }

  cyl(hex: number, rt: number, rb: number, h: number, p?: V3, r?: V3, s?: V3 | number, o: CylOpts = {}, surf?: Surface): void {
    this.put(new THREE.CylinderGeometry(rt, rb, h, o.seg ?? 10, 1, o.open ?? false, o.t0 ?? 0, o.tl ?? TAU), hex, p, r, s, surf);
  }

  /** Open tube seen from both sides (a crown, a lampshade): the mirrored copy faces inward. */
  tube(hex: number, rt: number, rb: number, h: number, p?: V3, r?: V3, s: V3 = [1, 1, 1], seg = 12, surf?: Surface): void {
    this.cyl(hex, rt, rb, h, p, r, s, { seg, open: true }, surf);
    this.cyl(shade(hex, 0.7), rt * 0.985, rb * 0.985, h, p, r, [-s[0], s[1], s[2]], { seg, open: true }, surf);
  }

  cone(hex: number, radius: number, h: number, p?: V3, r?: V3, s?: V3 | number, seg = 8, surf?: Surface): void {
    this.put(new THREE.ConeGeometry(radius, h, seg), hex, p, r, s, surf);
  }

  torus(hex: number, R: number, tube: number, p?: V3, r?: V3, s?: V3 | number, rs = 5, ts = 14, arc = TAU, surf?: Surface): void {
    this.put(new THREE.TorusGeometry(R, tube, rs, ts, arc), hex, p, r, s, surf);
  }

  /** Ellipsoid segment: theta from the top (t0, tl), phi around Y (p0, pl; +Z is pl centered on PI/2). */
  cap(hex: number, radii: V3, t0: number, tl: number, p?: V3, r?: V3, o: { p0?: number; pl?: number; w?: number; h?: number } = {}, surf?: Surface): void {
    this.put(new THREE.SphereGeometry(1, o.w ?? 14, o.h ?? 7, o.p0 ?? 0, o.pl ?? TAU, t0, tl), hex, p, r, radii, surf);
  }

  /** Segment of the ellipsoid facing +Z, `width` radians wide. */
  front(hex: number, radii: V3, t0: number, tl: number, width: number, p?: V3, r?: V3, surf?: Surface, w = 12, h = 5): void {
    this.cap(hex, radii, t0, tl, p, r, { p0: Math.PI / 2 - width / 2, pl: width, w, h }, surf);
  }
}

/** Crumples a geometry deterministically (vertices at the same spot move together). */
function crumple(g: THREE.BufferGeometry, amount: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = Math.sin(x * 91.7 + y * 47.3 + z * 13.1) * 43758.5453;
    const n = (k - Math.floor(k)) * 2 - 1;
    const len = Math.hypot(x, z) || 1;
    pos.setXYZ(i, x + (x / len) * n * amount, y + n * amount * 0.5, z + (z / len) * n * amount);
  }
  return g;
}

// ── Limbs ───────────────────────────────────────────────────────────────────────────────

/**
 * One ring of a limb's surface: height down its bone (y, negative), radius, how far forward it
 * sits (calves bulge behind, thighs in front). `fine` rings round out joints and muscles on
 * survivors; zombies (there are a lot of them) skip them.
 */
export type Ring = readonly [y: number, r: number, z?: number, fine?: 1];

/** Bone lengths of the rig (Humanoid builds its limbs from these). */
export const ARM = { upper: 0.31, lower: 0.29 } as const;
export const LEG = { upper: 0.44, lower: 0.44 } as const;
/** How far each side of an elbow or knee the skin bends with both bones. */
const BEND = 0.07;

/** Shoulder down to the elbow: deltoid, biceps, narrowing into the elbow. */
const ARM_UP: readonly Ring[] = [[0.015, 0.05], [-0.04, 0.057], [-0.11, 0.055, 0.002, 1], [-0.19, 0.049], [-0.25, 0.044, 0, 1], [-0.285, 0.042, 0, 1], [-0.31, 0.041]];
/** Elbow to the wrist: the forearm's swell just below the elbow, thin at the wrist. */
const ARM_LO: readonly Ring[] = [[0, 0.041], [-0.025, 0.043, 0, 1], [-0.07, 0.046], [-0.14, 0.041, 0, 1], [-0.22, 0.034], [-0.29, 0.03]];
/** Hip to knee and knee to ankle, bare: a full thigh, a calf swelling out behind, slim ankles. */
const LEG_UP: Record<'male' | 'female', readonly Ring[]> = {
  male: [[0.03, 0.078], [-0.05, 0.083, 0.004], [-0.16, 0.078, 0.005, 1], [-0.28, 0.068, 0.002], [-0.37, 0.059, 0, 1], [-0.41, 0.0555, 0, 1], [-0.44, 0.054]],
  female: [[0.03, 0.084], [-0.05, 0.09, 0.004], [-0.16, 0.082, 0.005, 1], [-0.28, 0.068, 0.002], [-0.37, 0.057, 0, 1], [-0.41, 0.0535, 0, 1], [-0.44, 0.052]],
};
const LEG_LO: Record<'male' | 'female', readonly Ring[]> = {
  male: [[0, 0.054], [-0.03, 0.0555, -0.001, 1], [-0.08, 0.059, -0.005], [-0.15, 0.06, -0.007, 1], [-0.25, 0.049, -0.004], [-0.35, 0.04, 0, 1], [-0.44, 0.036]],
  female: [[0, 0.052], [-0.03, 0.0535, -0.001, 1], [-0.08, 0.057, -0.005], [-0.15, 0.057, -0.007, 1], [-0.25, 0.046, -0.004], [-0.35, 0.037, 0, 1], [-0.44, 0.033]],
};

/** Radius and forward offset of a ring list at height y (linear between rings, clamped). */
export function ringAt(rings: readonly Ring[], y: number): { r: number; z: number } {
  if (y >= rings[0][0]) return { r: rings[0][1], z: rings[0][2] ?? 0 };
  for (let i = 1; i < rings.length; i++) {
    const [y1, r1, z1 = 0] = rings[i];
    if (y >= y1) {
      const [y0, r0, z0 = 0] = rings[i - 1];
      const t = (y - y0) / (y1 - y0);
      return { r: r0 + (r1 - r0) * t, z: z0 + (z1 - z0) * t };
    }
  }
  const l = rings[rings.length - 1];
  return { r: l[1], z: l[2] ?? 0 };
}

/** The rings a body is built with (zombies skip the fine ones). */
const ringsFor = (b: Body, rings: readonly Ring[]): readonly Ring[] => (b.zombie ? rings.filter((r) => !r[3]) : rings);

/** Turned surface through `rings` (see Kit.lathe): smooth normals, optional end caps. */
function latheGeometry(rings: readonly Ring[], rk: number, inf: number, seg: number, top: boolean, bottom: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const at = (i: number, j: number) => i * (seg + 1) + j;
  rings.forEach(([y, r, z = 0], i) => {
    const R = r * rk + inf;
    // The surface's slope here (-dR/dy), so normals lean with a swelling muscle.
    const prev = rings[Math.max(0, i - 1)], next = rings[Math.min(rings.length - 1, i + 1)];
    const dy = next[0] - prev[0], dr = (next[1] - prev[1]) * rk;
    const slope = dy !== 0 ? -dr / dy : 0;
    const l = Math.hypot(1, slope);
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg) * TAU;
      const sx = Math.sin(t), cz = Math.cos(t);
      pos.push(sx * R, y, cz * R + z * rk);
      nor.push(sx / l, slope / l, cz / l);
    }
  });
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < seg; j++) {
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j + 1), d = at(i + 1, j);
      idx.push(a, d, c, a, c, b);
    }
  }
  const cap = (i: number, up: boolean) => {
    const [y, , z = 0] = rings[i];
    const c = pos.length / 3;
    pos.push(0, y, z * rk);
    nor.push(0, up ? 1 : -1, 0);
    const base = pos.length / 3;
    for (let j = 0; j <= seg; j++) {
      pos.push(pos[at(i, j) * 3], pos[at(i, j) * 3 + 1], pos[at(i, j) * 3 + 2]);
      nor.push(0, up ? 1 : -1, 0);
    }
    for (let j = 0; j < seg; j++) {
      if (up) idx.push(c, base + j, base + j + 1);
      else idx.push(c, base + j + 1, base + j);
    }
  };
  if (top) cap(0, true);
  if (bottom) cap(rings.length - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** Rings `inf` out from another list's, sampled at `ys` (a sleeve or hem over the limb). */
function over(rings: readonly Ring[], ys: readonly number[], inf: number): Ring[] {
  return ys.map((y) => {
    const { r, z } = ringAt(rings, y);
    return [y, r + inf, z] as const;
  });
}

/** A strip (track-suit stripe) down the outer side of a limb, following its surface. */
function stripe(k: Kit, rings: readonly Ring[], rk: number, inf: number, side: number, hex: number, w: number): void {
  for (let i = 0; i + 1 < rings.length; i++) {
    const [y0, r0] = rings[i], [y1, r1] = rings[i + 1];
    const a = new THREE.Vector3(side * (r0 * rk + inf + 0.002), y0, 0), b = new THREE.Vector3(side * (r1 * rk + inf + 0.002), y1, 0);
    const d = b.clone().sub(a);
    const m = a.clone().add(b).multiplyScalar(0.5);
    k.putAlong(new THREE.BoxGeometry(0.006, d.length() + 0.004, w), hex, [m.x, m.y, m.z], d);
  }
}

/**
 * A hand at the end of the forearm (lower arm bone space, wrist at -ARM.lower): the palm facing
 * the body's midline, the thumb forward, the fingers curled as round a grip (zombies' clawing,
 * half open). `fingers` colors fingers and thumb (bare under fingerless gloves).
 */
function hand(lo: Kit, s: number, b: Body, palm: number, fingers: number, inf: number): void {
  const h = lo.at([0, -ARM.lower, 0], O, b.hand);
  const i2 = inf * 2;
  h.box(palm, [0.032 + i2, 0.076 + inf, 0.07 + i2], [s * 0.002, -0.034, 0.002]);
  // Survivors' fingers half closed (round a grip, or relaxed at the side), zombies' clawing.
  const [c1, c2] = b.zombie ? [0.38, 0.55] : [0.42, 0.55];
  // Each knuckle's box reaches back into the one before, so bending opens no notch.
  const k1 = h.at([s * 0.001, -0.068, 0.001], [0, 0, -s * c1]);
  k1.box(fingers, [0.023 + i2, 0.05, 0.068 + i2], [0, -0.016, 0]);
  const k2 = k1.at([0, -0.04, 0], [0, 0, -s * c2]);
  k2.box(fingers, [0.02 + i2, 0.034, 0.064 + i2], [0, -0.012, 0]);
  // Thumb from the heel of the hand on the front edge, wrapped round toward the fingers.
  const dir = b.zombie ? new THREE.Vector3(-s * 0.25, -0.75, 0.5) : new THREE.Vector3(-s * 0.42, -0.82, 0.3);
  dir.normalize();
  const base = new THREE.Vector3(-s * 0.004, -0.024, 0.031).addScaledVector(dir, 0.025);
  if (b.zombie) h.putAlong(new THREE.BoxGeometry(0.019 + i2, 0.05, 0.02 + i2), fingers, [base.x, base.y, base.z], dir);
  else h.putAlong(new THREE.CylinderGeometry(0.0095 + inf, 0.0118 + inf, 0.05, 5), fingers, [base.x, base.y, base.z], dir);
}

// ── Head ────────────────────────────────────────────────────────────────────────────────

/**
 * The head and everything on it is drawn this much smaller than it is built (about the neck),
 * so bodies stand a little over seven heads tall.
 */
export const HEAD_K = 0.92;

/** How much of the jaw narrowing applies at head-space height y: none at the cheekbones, all of it at the chin. */
const jawK = (y: number) => THREE.MathUtils.smoothstep(-y, -0.1, 0.005);

const _w = new THREE.Vector3();
/** A head-space point as built to where it is drawn: the jawline narrowing, then HEAD_K (see headSink). */
function headWarp(v: THREE.Vector3): THREE.Vector3 {
  const j = jawK(v.y);
  return v.set(v.x * (1 - 0.12 * j) * HEAD_K, v.y * HEAD_K, (v.z < 0 ? v.z * (1 - 0.06 * j) : v.z) * HEAD_K);
}

/**
 * Head bone parts go through here: a jawline (the lower face narrowing toward the chin, the back
 * of the jaw tucking in under the skull), then shrunk by HEAD_K. Everything on the head (beards,
 * masks, makeup, helmets) is warped alike, so whatever sat on the face still does.
 */
function headSink(sink: PartSink): PartSink {
  return (g, bone, hex, m, surf, blend) => {
    g.applyMatrix4(m);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      headWarp(_w.fromBufferAttribute(pos, i));
      pos.setXYZ(i, _w.x, _w.y, _w.z);
    }
    pos.needsUpdate = true;
    const shade = surf?.shade;
    const s = shade ? { ...surf, shade: (x: number, y: number, z: number, c: THREE.Color) => shade(x / HEAD_K, y / HEAD_K, z / HEAD_K, c) } : surf;
    sink(g, bone, hex, new THREE.Matrix4(), s, blend);
  };
}

const gauss = (d2: number) => Math.exp(-d2);

/**
 * Soft shading on the face (head space, as built): shadow under the jaw and chin, eye sockets,
 * beside and under the nose, toward the temples; warmth on the cheeks, nose and ears.
 */
const faceShade: Shade = (x, y, z, c) => {
  const ax = Math.abs(x);
  const front = THREE.MathUtils.smoothstep(z, 0.02, 0.09);
  let k = 1;
  // Under the jaw: the bottom of the head falls into shadow, deepest toward the neck (the chin's
  // front much less, or it reads as stubble).
  k *= 1 - 0.3 * THREE.MathUtils.smoothstep(-y, -0.045, 0.005) * (1 - 0.65 * front);
  // Eye sockets, under the brow.
  k *= 1 - 0.17 * front * gauss(((ax - 0.042) / 0.03) ** 2 + ((y - 0.142) / 0.024) ** 2);
  // Beside the nose, and the little shadow under it.
  k *= 1 - 0.12 * front * gauss(((ax - 0.021) / 0.012) ** 2 + ((y - 0.1) / 0.022) ** 2);
  k *= 1 - 0.08 * front * gauss((x / 0.016) ** 2 + ((y - 0.08) / 0.008) ** 2);
  // Temples and the sides of the face turn away.
  k *= 1 - 0.07 * THREE.MathUtils.smoothstep(ax, 0.075, 0.115);
  c.multiplyScalar(k);
  // Blood under the skin: cheeks, nose tip, ears.
  const warm = 0.9 * front * gauss(((ax - 0.066) / 0.026) ** 2 + ((y - 0.092) / 0.022) ** 2) + 0.7 * front * gauss((x / 0.014) ** 2 + ((y - 0.098) / 0.014) ** 2) + 0.6 * gauss(((ax - 0.113) / 0.012) ** 2 + ((y - 0.115) / 0.03) ** 2);
  c.r *= 1 + 0.07 * warm;
  c.g *= 1 - 0.025 * warm;
  c.b *= 1 - 0.04 * warm;
};

/** The neck in the jaw's shadow at the top, lighter where it meets the shoulders. */
const neckShade: Shade = (_x, y, z, c) => {
  const k = 1 - 0.3 * THREE.MathUtils.smoothstep(y, -0.07, 0.01) * (0.55 + 0.45 * THREE.MathUtils.smoothstep(z, -0.02, 0.05));
  c.multiplyScalar(k);
};

export interface DressOptions {
  zombie: boolean;
  /** Skin color (hex), overriding the palette (zombies). */
  skin?: number;
  rand: () => number;
  /** Widens torso and limbs beyond the broadest build (brutes). */
  girth?: number;
  /** What the infection made of the special zombies. */
  mutation?: Mutation;
}

/** Screamers: a jaw hanging open. Bloaters: a gut bursting out of the shirt, boils. */
export type Mutation = 'screamer' | 'bloater';

export interface DressResult {
  /** How far behind the back the carried gear reaches, so a slung rifle sits on top of it. */
  backDepth: number;
  /** False when a helmet, mask or dark lenses hide the eyes. */
  eyesVisible: boolean;
}

interface Body {
  bx: number;
  bz: number;
  arm: number;
  skin: number;
  /** Female body: narrower shoulders and waist, wider hips, a bust, slimmer arms and hands. */
  female: boolean;
  /** Hand size (gloves). */
  hand: number;
  /** Bust depth and spread over the average (the body shape sliders; 1 for men). */
  bustK: number;
  bustR: number;
  /** Hip width over the average, at the hips and the tops of the thighs. */
  hipW: number;
  /** How far the glutes round out behind the pelvis (0 for men). */
  seat: number;
  /** Leg thickness (heavier builds have heavier legs). */
  leg: number;
  /** Sides of each limb's surface. */
  seg: number;
  zombie: boolean;
  rand: () => number;
  /** How far the top's outer layer stands off the torso; straps, packs and vests go over it. */
  bulk: number;
  /** What covers the shins, once the legs are dressed (knee pads go over it). */
  shins?: Shins;
}

const BUILD = { slim: [0.9, 0.93, 0.92], average: [1, 1, 1], broad: [1.11, 1.08, 1.1] } as const;
/**
 * Female torso radius at spine-space heights: hips flaring below, a waist, ribs widening up to
 * shoulders narrower than a man's. Linear in between, clamped outside.
 */
const FEMALE_TORSO: readonly (readonly [number, number])[] = [[-0.2, 0.194], [0.02, 0.171], [0.13, 0.142], [0.52, 0.188]];
/** Torso radius (x, before build scale) at spine-space height y. */
function torsoR(b: Body, y: number): number {
  if (!b.female) return 0.16 + 0.1 * (y - 0.02);
  const k = FEMALE_TORSO, hip = hipF(b, y + SPINE_Y);
  if (y <= k[0][0]) return k[0][1] * hip;
  for (let i = 1; i < k.length; i++) {
    if (y <= k[i][0]) return (k[i - 1][1] + (k[i][1] - k[i - 1][1]) * (y - k[i - 1][0]) / (k[i][0] - k[i - 1][0])) * hip;
  }
  return k[k.length - 1][1];
}

/**
 * How far the body shape sliders reach. Bust: depth (x0.55 to x1.45) and spread (x0.88 to
 * x1.12). Hips: width at the hips and thigh tops (x0.91 to x1.09). Seat: the glutes' depth
 * behind the pelvis (nearly flat to 3.4 cm). Kept modest on purpose.
 */
const SHAPE = { bust: 0.45, bustSpread: 0.12, hips: 0.09, seat: 0.018, seatRange: 0.016 } as const;
/** The spine bone sits this far above the hips bone (Humanoid): spine-space y + SPINE_Y is hip space. */
const SPINE_Y = 0.08;
/** Hip width factor at hip-space height y: none at the waist, all of it from the hips down. */
const hipF = (b: Body, y: number) => 1 + (b.hipW - 1) * THREE.MathUtils.smoothstep(-y, -0.09, 0.04);
/** Front-to-back depth over width: a woman's hips are rounder, so coats reaching them get deeper there. */
const depthK = (b: Body, y: number) => (b.female ? 0.62 + 0.09 * THREE.MathUtils.clamp((0.07 - y) / 0.15, 0, 1) : 0.62);
const frontZ = (b: Body, y: number) => depthK(b, y) * b.bz * torsoR(b, y);
/** Shoulder joints' distance from the spine (the Humanoid's arm bones). */
export const SHOULDER_X = { male: 0.22, female: 0.205 } as const;
/** Outer layer thickness of each top (open jackets, coats, puffer rings). */
const TOP_BULK: Record<string, number> = {
  openflannel: 0.014, ziphoodie: 0.012, denim: 0.02, leather: 0.021, raincoat: 0.015, camo: 0.016, puffer: 0.032, cardigan: 0.014, peacoat: 0.018,
};

// ── Female torso ────────────────────────────────────────────────────────────────────────

/**
 * The bust is sculpted into the female torso's surface (and every layer worn over it) rather
 * than stuck on: two smooth swells, gentle above and rounder below, that fade into the chest.
 */
const BUST = { x: 0.05, y: 0.335, rx: 0.074, up: 0.1, down: 0.064, depth: 0.04 };
/** Rows the female torso surface is built from: dense over the chest, where it curves most. */
const FEMALE_ROWS = [-0.16, -0.08, 0.02, 0.08, 0.13, 0.19, 0.23, 0.255, 0.275, 0.295, 0.315, 0.335, 0.355, 0.38, 0.41, 0.44, 0.48, 0.52];

/** How far the bust stands out of the chest at (x, y). */
function bustBump(b: Body, x: number, y: number): number {
  if (!b.female) return 0;
  let f = 0;
  for (const s of [1, -1]) {
    const u = (x - s * BUST.x * b.bx) / (BUST.rx * b.bx * b.bustR);
    const v = (y - BUST.y) / ((y > BUST.y ? BUST.up : BUST.down) * b.bustR);
    const w = 1 - u * u - v * v;
    if (w > 0) f = Math.max(f, Math.pow(w, 1.6));
  }
  return f * BUST.depth * b.bustK * b.bz;
}

/** Lower edge of the bust (spine space), for tops that must cover it. */
const bustBottom = (b: Body) => BUST.y - BUST.down * b.bustR;

/**
 * The glutes, sculpted into the back of the female pelvis (and every layer over it) like the
 * bust: two rounded swells, hip-space centre SEAT.y, fading up into the small of the back and
 * curving under at the bottom.
 */
const SEAT = { x: 0.066, y: -0.055, rx: 0.088, up: 0.09, down: 0.06 };

/** How far the glutes stand out behind the pelvis at hip-space (x, y). */
function seatBump(b: Body, x: number, y: number): number {
  if (!b.female || b.seat <= 0) return 0;
  const sx = b.bx * b.hipW;
  let f = 0;
  for (const s of [1, -1]) {
    const u = (x - s * SEAT.x * sx) / (SEAT.rx * sx);
    const v = (y - SEAT.y) / (y > SEAT.y ? SEAT.up : SEAT.down);
    const w = 1 - u * u - v * v;
    if (w > 0) f = Math.max(f, Math.pow(w, 1.5));
  }
  return f * b.seat;
}

/** Pelvis width scale with the build (pants, belts). */
const pelvisK = (b: Body) => 0.97 + (b.bx - 1) * 0.5;

/** Female pelvis half-width (x) at hip-space y: the hips flaring down, rounding under at the bottom. */
function pelvisR(b: Body, y: number): number {
  const base = 0.172 + 0.014 * THREE.MathUtils.clamp((0.1 - y) / 0.2, 0, 1);
  const under = y < -0.1 ? 1 - 0.32 * Math.pow(Math.min(1, (-0.1 - y) / 0.035), 1.4) : 1;
  return base * under * pelvisK(b) * hipF(b, y);
}
/** Front-to-back over side-to-side of the pelvis. */
const PELVIS_DEPTH = 0.7;
/** Rows the female pelvis is built from (hip space), top to bottom. */
const PELVIS_ROWS = [0.1, 0.07, 0.04, 0.01, -0.02, -0.045, -0.07, -0.09, -0.1, -0.112, -0.124, -0.135];

/** Front of the torso at (x, y) without the bust. */
const torsoZ = (b: Body, x: number, y: number) => frontZ(b, y) * Math.cos(x / (torsoR(b, y) * b.bx));

/** How far forward the chest reaches at (x, y), over the bust. */
const chestZ = (b: Body, x: number, y: number) => torsoZ(b, x, y) + bustBump(b, x, y);

/** The furthest forward the chest reaches at height y across -w..w (a flat bib or panel there). */
const chestMax = (b: Body, y: number, w: number) => Math.max(...[-1, -0.5, 0, 0.5, 1].map((t) => chestZ(b, t * w, y)));

/**
 * One layer of the female torso (skin, a shirt, an open jacket) from y0 up to y1, `inf` out from
 * the body, open at the front by `gap` radians: a lathed surface following the waist, hips and
 * bust, so whatever is worn hugs the same shape.
 */
function femaleLayer(sp: Kit, b: Body, hex: number, inf: number, y0: number, y1: number, gap: number, surf?: Surface, rb0?: number): void {
  const ys = [y0, ...FEMALE_ROWS.filter((y) => y > y0 + 0.008 && y < y1 - 0.008), y1];
  const g = sculpt(ys, gap, gap === 0, 32, (y, i) => {
    const r = i === 0 && rb0 !== undefined ? Math.max(rb0, torsoR(b, y)) : torsoR(b, y);
    return { ax: r * b.bx + inf, az: depthK(b, y) * b.bz * r + inf };
  }, (x, y, z) => (z > 0 ? z + bustBump(b, x, y) : z - seatBump(b, x, y + SPINE_Y)));
  sp.put(g, hex, O, O, 1, surf);
}

/** One layer of the female pelvis (hip space, from y0 up to y1), `inf` out from the body, over the glutes. */
function pelvisLayer(hp: Kit, b: Body, hex: number, inf: number, y0: number, y1: number, surf?: Surface): void {
  const ys = [y0, ...PELVIS_ROWS.filter((y) => y > y0 + 0.006 && y < y1 - 0.006).reverse(), y1];
  const g = sculpt(ys, 0, true, b.zombie ? 16 : 24, (y) => {
    const r = pelvisR(b, y);
    return { ax: r + inf, az: PELVIS_DEPTH * r + inf };
  }, (x, y, z) => (z < 0 ? z - seatBump(b, x, y) : z));
  hp.put(g, hex, O, O, 1, surf);
}

/**
 * A surface turned through heights `ys` (bottom to top): each row an ellipse of half-widths
 * ax, az, then reshaped by `z` (a bust, glutes), open at the front by `gap` radians. Diagonals
 * mirrored left to right so the facets are symmetric about the middle.
 */
function sculpt(
  ys: readonly number[], gap: number, caps: boolean, around: number,
  ringOf: (y: number, i: number) => { ax: number; az: number }, zOf: (x: number, y: number, z: number) => number,
  drape = false,
): THREE.BufferGeometry {
  const tl = TAU - gap, seg = Math.max(4, Math.round(tl / (TAU / around)));
  const ring = ys.map((y, i) => {
    const { ax, az } = ringOf(y, i);
    const pts: number[][] = [];
    for (let j = 0; j <= seg; j++) {
      const t = gap / 2 + (j / seg) * tl;
      const x = Math.sin(t) * ax;
      pts.push([x, y, zOf(x, y, Math.cos(t) * az)]);
    }
    return pts;
  });
  // Cloth hanging free (a skirt) never comes back in below where it was pushed out (hips,
  // glutes): from the top row down, each point stays at least as far out as the one above.
  if (drape) {
    for (let i = ring.length - 2; i >= 0; i--) {
      for (let j = 0; j <= seg; j++) {
        const p = ring[i][j], q = ring[i + 1][j];
        if (Math.abs(q[0]) > Math.abs(p[0])) p[0] = q[0];
        if (Math.abs(q[2]) > Math.abs(p[2]) && Math.sign(q[2]) === Math.sign(p[2])) p[2] = q[2];
      }
    }
  }
  const pos: number[] = [];
  const tri = (a: number[], c: number[], d: number[]) => pos.push(...a, ...c, ...d);
  for (let i = 0; i + 1 < ring.length; i++) {
    for (let j = 0; j < seg; j++) {
      const A = ring[i][j], B = ring[i][j + 1], C = ring[i + 1][j + 1], D = ring[i + 1][j];
      // Diagonals mirrored left to right, so the facets are symmetric about the middle.
      if (A[0] + B[0] < 0) {
        tri(A, B, D);
        tri(B, C, D);
      } else {
        tri(A, B, C);
        tri(A, C, D);
      }
    }
  }
  if (caps) {
    const last = ring.length - 1;
    const bot = [0, ys[0], 0], top = [0, ys[last], 0];
    for (let j = 0; j < seg; j++) {
      tri(bot, ring[0][j + 1], ring[0][j]);
      tri(top, ring[last][j], ring[last][j + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A strap lying down the front of the chest from (x, y1) to (x, y0), `out` off the surface. */
function frontStrap(sp: Kit, b: Body, hex: number, x: number, y0: number, y1: number, w: number, out: number, n = 6): void {
  let prev = new THREE.Vector3(x, y1, chestZ(b, x, y1) + out);
  for (let i = 1; i <= n; i++) {
    const y = y1 + (y0 - y1) * (i / n);
    const p = new THREE.Vector3(x, y, chestZ(b, x, y) + out);
    const d = p.clone().sub(prev);
    const mid = prev.clone().add(p).multiplyScalar(0.5);
    sp.putAlong(new THREE.BoxGeometry(w, d.length() + 0.006, 0.012), hex, [mid.x, mid.y, mid.z], d);
    prev = p;
  }
}

/** Where each hair part may go under headwear. */
type Cover = 'none' | 'hat' | 'full';
const COVER: Record<string, Cover> = {
  none: 'none', sweatband: 'none', moto: 'full', knight: 'full',
  headband: 'none', hairbow: 'none', clips: 'none', flowercrown: 'none', tiara: 'none', catears: 'none',
};
const HIDES_EYES = new Set(['moto', 'knight', 'sunglasses', 'goggles', 'hockey', 'gasmask', 'aviators', 'oversized', 'heartglasses']);
const COVERS_FACE = new Set(['moto', 'knight']);

/**
 * Builds a survivor (or zombie) from an appearance: body, face, hair, clothing and gear, as
 * primitives on the skeleton's bones. The Humanoid merges them into one skinned mesh.
 */
export function dress(sink: PartSink, a: Appearance, o: DressOptions): DressResult {
  const build = BUILD[a.build] ?? BUILD.average;
  const g = o.girth ?? 1;
  const female = a.body === 'female';
  // Shape sliders, -1 to 1 around the average; modest at either end (see SHAPE).
  const shape = (v: number) => (female ? THREE.MathUtils.clamp((v - SHAPE_MID) / SHAPE_MID, -1, 1) : 0);
  const bs = shape(a.bust), hs = shape(a.hips), gs = shape(a.glutes);
  const b: Body = {
    bx: build[0] * g, bz: build[1] * g, arm: build[2] * g * (female ? 0.9 : 1), skin: o.skin ?? paletteColor('skin', a.skin),
    female, hand: female ? 0.9 : 1, leg: 1 + (build[0] * g - 1) * 0.6, seg: o.zombie ? 7 : 10,
    bustK: 1 + SHAPE.bust * bs, bustR: 1 + SHAPE.bustSpread * bs, hipW: 1 + SHAPE.hips * hs,
    seat: female ? (SHAPE.seat + SHAPE.seatRange * gs) * build[1] * g : 0,
    zombie: o.zombie, rand: o.rand, bulk: TOP_BULK[a.top] ?? 0,
  };
  const kit = (bone: number) => new Kit(sink, bone);
  // The neck keeps its length; the head on it is shaped and scaled (headSink).
  const neckKit = kit(BONE.head), head = new Kit(headSink(sink), BONE.head), spine = kit(BONE.spine), hips = kit(BONE.hips);
  const cloth = (i: number) => paletteColor('cloth', i);
  const hairHex = paletteColor('hair', a.hairColor);
  const covered = COVERS_FACE.has(a.headwear);

  face(head, neckKit, a, b, hairHex, covered);
  hair(head, a, b, hairHex, COVER[a.headwear] ?? 'hat');
  earrings(head, a, COVER[a.headwear] ?? 'hat');
  if (!covered) beard(head, a, b, hairHex);
  headwear(head, a, cloth(a.headwearColor));
  top(spine, kit, a, b);
  b.shins = pants(hips, spine, kit, a, b);
  shoes(kit, a, b, b.shins);
  gloves(kit, a, b);
  if (!covered) faceGear(head, a, b, cloth(a.faceColor));
  smokable(head, a, b);
  neck(spine, a, b, cloth(a.neckColor));
  const backDepth = back(spine, a, b, cloth(a.backColor)) + b.bulk;
  gear(spine, hips, kit, a, b, cloth(a.gearColor));
  if (o.mutation) mutate(head, spine, kit, b, o.mutation);
  return { backDepth, eyesVisible: !o.zombie && !HIDES_EYES.has(a.headwear) && !HIDES_EYES.has(a.face) };
}

// ── Mutations ──────────────────────────────────────────────────────────────────────────

function mutate(head: Kit, spine: Kit, kit: (bone: number) => Kit, b: Body, m: Mutation): void {
  const skin = b.skin;
  if (m === 'screamer') {
    // The jaw hangs open in a permanent scream.
    head.ball(0x1c0606, [0.034, 0.05, 0.012], [0, 0.045, 0.114], [0.12, 0, 0], undefined, 10, 7);
    head.ball(0x5a1a14, [0.024, 0.008, 0.02], [0, 0.012, 0.108], O, undefined, 8, 5);
    return;
  }
  // A gut swollen with gas, split skin and boils, straining out under the shirt.
  const gut = mixHex(skin, 0xb7b06a, 0.3);
  const rx = 0.24 * b.bx, rz = 0.2 * b.bz, cz = 0.1 * b.bz;
  spine.ball(gut, [rx, 0.23, rz], [0, 0.13, cz], O, undefined, 16, 12);
  spine.ball(mixHex(gut, 0x5a2d3d, 0.4), [0.07, 0.012, 0.03], [0.05, 0.1, cz + rz * 0.97], [0.4, 0, 0.5], undefined, 8, 5);
  const boil = 0xc8b84a;
  // Boils on the gut, and on the back where the shirt rides up.
  for (const [x, y] of [[0.12, 0.2], [-0.16, 0.1], [0.05, 0.02], [-0.08, 0.26]] as const) {
    const ey = (y - 0.13) / 0.23;
    const z = cz + rz * Math.sqrt(Math.max(0, 1 - (x * b.bx / rx) ** 2 - ey * ey));
    spine.ico(boil, 0.022 + b.rand() * 0.016, [x * b.bx, y, z], O, 1, 1);
  }
  for (const [x, y] of [[0.1, 0.32], [-0.08, 0.4]] as const) spine.ico(boil, 0.02 + b.rand() * 0.012, [x * b.bx, y, -0.62 * b.bz * torsoR(b, y) - 0.005], O, 1, 1);
  for (const bone of [BONE.armLUpper, BONE.armRUpper]) kit(bone).ico(boil, 0.024, [0.03, -0.12, 0.03], O, 1, 1);
  head.ico(boil, 0.02, [0.07, 0.17, 0.08], O, 1, 1);
}

// ── Face ────────────────────────────────────────────────────────────────────────────────

interface EyeShape { sx: number; sy: number; tilt: number; lid: number; lidTilt: number; brow: number; browY: number }
const EYES: Record<string, EyeShape> = {
  round: { sx: 0.019, sy: 0.019, tilt: 0, lid: 0, lidTilt: 0, brow: -0.04, browY: 0.176 },
  almond: { sx: 0.023, sy: 0.0145, tilt: 0.14, lid: 0, lidTilt: 0, brow: 0.05, browY: 0.17 },
  wide: { sx: 0.024, sy: 0.021, tilt: 0, lid: 0, lidTilt: 0, brow: -0.1, browY: 0.181 },
  narrow: { sx: 0.022, sy: 0.0095, tilt: 0.06, lid: 0, lidTilt: 0, brow: 0.12, browY: 0.164 },
  sleepy: { sx: 0.021, sy: 0.018, tilt: -0.08, lid: 0.55, lidTilt: -0.12, brow: -0.14, browY: 0.172 },
  fierce: { sx: 0.022, sy: 0.016, tilt: 0.24, lid: 0.32, lidTilt: 0.42, brow: 0.42, browY: 0.165 },
};
export const EYE_Y = 0.135;
const EYE_X = 0.042;
const EYE_Z = 0.107;

/**
 * A patch painted on the head's surface (makeup) around head-space (x, y) on the face, `w` wide
 * and `hgt` tall, standing `inf` off the skin.
 */
function facePatch(h: Kit, hex: number, x: number, y: number, w: number, hgt: number, inf = 0.0022): void {
  const theta = Math.acos(THREE.MathUtils.clamp((y - 0.12) / 0.1404, -1, 1));
  const sinT = Math.max(0.2, Math.sin(theta));
  const phi = Math.acos(THREE.MathUtils.clamp(-(x / 0.117) / sinT, -1, 1));
  const dt = hgt / 0.1404 / 2, dp = w / (0.123 * sinT) / 2;
  h.cap(hex, [0.117 + inf, 0.1404 + inf, 0.13 + inf], theta - dt, 2 * dt, [0, 0.12, 0], O, { p0: phi - dp, pl: 2 * dp, w: 5, h: 3 });
}

/** Lip, lid and cheek colors the makeup gives (undefined: bare). */
function makeupColors(a: Appearance, b: Body): { lips?: number; lids?: number; cheeks?: number } {
  if (b.zombie) return {};
  const mc = paletteColor('makeup', a.makeupColor);
  switch (a.makeup) {
    case 'lipstick': return { lips: mixHex(mc, b.skin, 0.12) };
    case 'shadow': return { lids: mixHex(mc, b.skin, 0.3) };
    case 'blush': return { cheeks: mixHex(b.skin, 0xd8505f, 0.3) };
    case 'glam': return { lips: mixHex(mc, b.skin, 0.12), lids: mixHex(mc, b.skin, 0.5), cheeks: mixHex(b.skin, 0xd8505f, 0.26) };
    case 'smoky': return { lips: mixHex(mc, b.skin, 0.3), lids: mixHex(0x2b2228, b.skin, 0.12) };
    default: return {};
  }
}

function face(h: Kit, neck: Kit, a: Appearance, b: Body, hairHex: number, covered: boolean): void {
  const skin = b.skin;
  const soft: Surface = { shade: faceShade };
  // A neck that narrows up into the jaw.
  if (b.female) neck.cyl(skin, 0.042, 0.055, 0.12, [0, -0.04, 0.004], O, [1, 1, 0.95], { seg: 10 }, { shade: neckShade });
  else neck.cyl(skin, 0.05, 0.063, 0.12, [0, -0.04, 0.004], O, [1, 1, 0.95], { seg: 10 }, { shade: neckShade });
  h.put(new THREE.IcosahedronGeometry(1, 2), skin, [0, 0.12, 0], O, [0.117, 0.1404, 0.13], soft);
  for (const s of [1, -1]) h.ball(shade(skin, 0.94), [0.016, 0.03, 0.022], [s * 0.113, 0.115, -0.008], [0, 0, s * 0.1], soft, 6, 5);
  h.box(shade(skin, 0.97), [0.024, 0.038, 0.024], [0, 0.102, 0.122], [-0.32, 0, 0], soft);
  if (b.zombie) {
    // A slack, dark mouth.
    h.ball(0x2a0c0a, [0.026, 0.012, 0.008], [0, 0.058, 0.115], [0.1, 0, 0], undefined, 8, 5);
    return;
  }
  if (covered) return;
  const lip = a.facialHair === 'beard' ? 0.013 : a.facialHair === 'goatee' || a.facialHair === 'stubble' ? 0.004 : 0;
  const mk = makeupColors(a, b);
  if (b.female || mk.lips !== undefined) {
    // Fuller lips: upper and lower, natural or painted, with the line between them.
    const lipHex = mk.lips ?? mixHex(skin, 0xa04a58, 0.3);
    h.ball(lipHex, [0.0205, 0.0062, 0.0085], [0, 0.0672, 0.1165 + lip], [-0.25, 0, 0], undefined, 10, 5);
    h.ball(shade(lipHex, 1.06), [0.0185, 0.0074, 0.0092], [0, 0.0566, 0.1148 + lip], [0.2, 0, 0], undefined, 10, 5);
    h.box(mixHex(lipHex, 0x2a0c10, 0.65), [0.031, 0.0022, 0.006], [0, 0.0622, 0.1215 + lip], [-0.15, 0, 0]);
  } else {
    h.box(mixHex(skin, 0x4a1c1c, 0.55), [0.038, 0.0055, 0.008], [0, 0.063, 0.118 + lip], [-0.15, 0, 0]);
  }
  const e = EYES[a.eyes] ?? EYES.almond;
  const brow = luminance(hairHex) > 0.7 ? shade(hairHex, 0.85) : hairHex;
  for (const s of [1, -1]) {
    if (b.female) {
      // Thinner, arched brows: the body rising from the nose, the tail falling away.
      h.box(brow, [0.03, 0.0058, 0.008], [s * 0.039, e.browY + 0.003, 0.1145], [-0.25, s * 0.18, s * (e.brow - 0.12)]);
      h.box(brow, [0.017, 0.0048, 0.0075], [s * 0.061, e.browY + 0.0015, 0.108], [-0.22, s * 0.35, s * (e.brow - 0.62)]);
    } else {
      h.box(brow, [0.036, 0.0085, 0.009], [s * 0.043, e.browY, 0.114], [-0.25, s * 0.18, s * e.brow]);
    }
    // Upper lid: a shell over the top of the eye, rotated down to cover `lid` of it. It stays put
    // while the eye itself squashes to blink.
    if (e.lid > 0) {
      const tilt = Math.asin(THREE.MathUtils.clamp((2 * e.lid - 1) * e.sy / 0.018, -1, 1));
      const lidHex = mk.lids !== undefined ? mixHex(mk.lids, skin, 0.2) : shade(skin, 0.92);
      h.at([s * EYE_X, EYE_Y, EYE_Z], [0, s * 0.2, s * e.tilt])
        .cap(lidHex, [e.sx * 1.14, e.sy * 1.18, 0.0192], 0, Math.PI / 2, O, [tilt, 0, -s * e.lidTilt], { w: 12, h: 6 });
    }
    // Makeup painted on: lids between eye and brow, cheeks, or a footballer's eye black.
    if (mk.lids !== undefined) {
      const y0 = EYE_Y + e.sy * (e.lid > 0 ? 1.2 : 0.95), y1 = e.browY - 0.004;
      if (y1 > y0 + 0.004) facePatch(h, mk.lids, s * (EYE_X + 0.004), (y0 + y1) / 2, 0.044, y1 - y0);
    }
    if (mk.cheeks !== undefined) facePatch(h, mk.cheeks, s * 0.074, 0.094, 0.036, 0.022, 0.0026);
    if (a.makeup === 'eyeblack' && !b.zombie) facePatch(h, 0x141214, s * 0.046, EYE_Y - e.sy - 0.014, 0.034, 0.009, 0.0026);
  }
}

/** Earrings at the lobes (hidden under full helmets). */
function earrings(h: Kit, a: Appearance, cover: Cover): void {
  if (cover === 'full' || a.ears === 'none') return;
  const gold = 0xd8b04a, silver = 0xc8ccd2;
  for (const s of [1, -1]) {
    const x = s * 0.1235, y = 0.09, z = 0.001;
    switch (a.ears) {
      case 'studs':
      case 'goldstuds':
        h.ico(a.ears === 'studs' ? silver : gold, 0.0048, [x, y, z], O, 1, 1);
        break;
      case 'hoops':
      case 'silverhoops':
      case 'bighoops': {
        const big = a.ears === 'bighoops';
        const R = big ? 0.025 : 0.0135;
        h.torus(a.ears === 'silverhoops' ? silver : gold, R, big ? 0.0024 : 0.0019, [x + s * 0.002, y - R + 0.003, z], [0, Math.PI / 2, 0], 1, 4, 18);
        break;
      }
      case 'pearls':
        h.ball(0xf1ebde, 0.0074, [x, y - 0.006, z], O, undefined, 8, 6);
        break;
      case 'drops':
        h.ico(gold, 0.0042, [x, y, z], O, 1, 0);
        h.box(gold, [0.0016, 0.016, 0.0016], [x, y - 0.01, z]);
        h.put(new THREE.OctahedronGeometry(0.008, 0), 0x7fc8dc, [x, y - 0.024, z], O, [0.75, 1.4, 0.75]);
        break;
    }
  }
}

/** One piece of the eyes; `iris` pieces (iris, pupil, glint) move together when the eyes look about. */
export interface EyePart { g: THREE.BufferGeometry; hex: number; m: THREE.Matrix4; iris?: boolean }

/** Eye geometry (head-bone space as built, relative to the eye line at EYE_Y): sclera, iris, pupil, glint, lids. */
export function eyeParts(a: Appearance): EyePart[] {
  const e = EYES[a.eyes] ?? EYES.almond;
  const iris = paletteColor('eye', a.eyeColor);
  const out: EyePart[] = [];
  const add = (g: THREE.BufferGeometry, hex: number, m: THREE.Matrix4, moves = false) => out.push({ g, hex, m, iris: moves });
  for (const s of [1, -1]) {
    const frame = mat([s * EYE_X, 0, EYE_Z], [0, s * 0.2, s * e.tilt]);
    const at = (p: V3, r: V3, sc: V3 | number) => frame.clone().multiply(mat(p, r, sc));
    add(new THREE.SphereGeometry(1, 12, 8), 0xe9e4dc, at(O, O, [e.sx, e.sy, 0.016]));
    const ir = Math.min(0.0115, e.sy * 0.95);
    add(new THREE.SphereGeometry(1, 12, 8), iris, at([0, 0, 0.0115], O, [ir, ir, 0.0055]), true);
    add(new THREE.SphereGeometry(1, 10, 6), 0x050505, at([0, 0, 0.0145], O, [ir * 0.45, ir * 0.45, 0.003]), true);
    add(new THREE.SphereGeometry(1, 6, 4), 0xffffff, at([-s * ir * 0.35 + s * 0.001, ir * 0.4, 0.0168], O, ir * 0.17), true);
    // Lash line along the top edge of an open eye (lidded eyes have the lid's edge instead).
    const female = a.body === 'female';
    const liner = a.makeup === 'liner' || a.makeup === 'glam' || a.makeup === 'smoky';
    if (e.lid === 0) {
      add(new THREE.TorusGeometry(1, liner ? 0.17 : female ? 0.14 : 0.1, 3, 14, Math.PI), liner ? 0x0b0909 : 0x1a1210, at([0, 0, 0.007], [-0.35, 0, 0], [e.sx * 1.04, e.sy * 1.04, 0.01]));
      // Lashes flicking up at the outer corner.
      if (female) {
        for (let i = 0; i < 3; i++) {
          const t = 0.42 + i * 0.2;
          add(new THREE.ConeGeometry(0.0022, 0.008, 3), 0x120d0b,
            at([s * Math.cos(t) * e.sx * 1.02, Math.sin(t) * e.sy * 1.05 + 0.002, 0.009], [0.3, 0, -s * (0.35 + (1.2 - t) * 0.6)], 1));
        }
      }
    }
    // Winged liner sweeping up past the outer corner.
    if (liner) add(new THREE.BoxGeometry(0.016, 0.0026, 0.004), 0x0b0909, at([s * (e.sx + 0.005), e.sy * 0.32, 0.006], [0, 0, s * 0.42], 1));
  }
  return out;
}

// ── Hair ────────────────────────────────────────────────────────────────────────────────

function hair(h: Kit, a: Appearance, b: Body, hx: number, cover: Cover): void {
  const crown = cover === 'none';
  const scalpOk = cover !== 'full';
  const shaved = mixHex(hx, b.skin, 0.38);
  const scalp = (inf: number, theta: number, tilt: number, hex = hx) => {
    if (scalpOk) h.cap(hex, [0.117 + inf, 0.14 + inf, 0.13 + inf], 0, theta, [0, 0.12, 0], [-tilt, 0, 0], { w: 20, h: 9 });
  };
  const fringe = (p: V3, s: V3, r: V3 = O) => { if (crown) h.ball(hx, s, p, r, undefined, 8, 5); };
  const onScalp = (theta: number, phi: number, inf: number) => {
    const d = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    const p: V3 = [d.x * (0.117 + inf), 0.12 + d.y * (0.14 + inf), -0.004 + d.z * (0.13 + inf)];
    return { d, p };
  };
  switch (a.hair) {
    case 'bald':
      break;
    case 'buzz':
      scalp(0.009, 1.5, 0.5, shaved);
      break;
    case 'short':
      scalp(0.012, 1.55, 0.5);
      fringe([0, 0.21, 0.075], [0.075, 0.022, 0.04], [0.55, 0, 0]);
      break;
    case 'sidepart':
      scalp(0.012, 1.55, 0.5);
      fringe([0.03, 0.232, 0.05], [0.085, 0.03, 0.07], [0.35, 0, -0.25]);
      fringe([-0.065, 0.212, 0.06], [0.045, 0.022, 0.045], [0.45, 0, 0.3]);
      break;
    case 'messy':
      scalp(0.016, 1.55, 0.5);
      for (let i = 0; i < 9; i++) {
        const { d, p } = onScalp(0.2 + b.rand() * 0.85, b.rand() * TAU, 0.012);
        const tilt = new THREE.Vector3(b.rand() - 0.5, 0, b.rand() - 0.5).multiplyScalar(0.8);
        if (crown && d.z < 0.75) h.putAlong(new THREE.ConeGeometry(0.03, 0.075, 4), hx, p, d.add(tilt));
      }
      fringe([0.01, 0.21, 0.077], [0.07, 0.024, 0.04], [0.55, 0, -0.1]);
      break;
    case 'spiky':
      scalp(0.01, 1.5, 0.5);
      if (crown) {
        for (let i = 0; i < 11; i++) {
          const theta = i === 0 ? 0 : 0.55 + (i % 2) * 0.35;
          const { d, p } = onScalp(theta, (i / 10) * TAU + 0.3, 0.008);
          h.putAlong(new THREE.ConeGeometry(0.026, 0.1, 4), hx, p, d);
        }
      }
      break;
    case 'curly':
      scalp(0.018, 1.6, 0.45);
      if (crown) {
        for (let i = 0; i < 34; i++) {
          const theta = Math.acos(1 - (i / 34) * 1.25);
          const { p } = onScalp(theta, i * 2.4, 0.016);
          if (p[2] > 0.08 && p[1] < 0.215) continue;
          h.ico(hx, 0.034, p, [i, i * 2, 0], 1, 1);
        }
      }
      break;
    case 'afro':
      scalp(0.02, 1.62, 0.45);
      if (crown) h.ico(hx, 0.178, [0, 0.235, -0.058], [0.3, 0.2, 0], [1.05, 0.9, 0.92], 2);
      break;
    case 'long':
      scalp(0.014, 1.6, 0.5);
      h.ball(hx, [0.116, 0.2, 0.06], [0, 0.03, -0.088], [0.12, 0, 0], undefined, 12, 7);
      for (const s of [1, -1]) h.ball(hx, [0.028, 0.13, 0.055], [s * 0.104, 0.065, -0.01], [0.05, 0, s * 0.06], undefined, 8, 6);
      fringe([0, 0.212, 0.072], [0.08, 0.024, 0.04], [0.55, 0, 0]);
      break;
    case 'ponytail':
      scalp(0.012, 1.55, 0.55);
      h.torus(shade(hx, 0.6), 0.02, 0.008, [0, 0.165, -0.13], [1.0, 0, 0], 1, 4, 10);
      h.ball(hx, [0.035, 0.12, 0.035], [0, 0.07, -0.165], [-0.3, 0, 0], undefined, 8, 6);
      break;
    case 'bun':
      scalp(0.012, 1.55, 0.5);
      if (crown) {
        h.ico(hx, 0.055, [0, 0.282, -0.035], O, 1, 1);
        h.torus(shade(hx, 0.6), 0.03, 0.008, [0, 0.24, -0.02], [Math.PI / 2 - 0.3, 0, 0], 1, 4, 10);
      }
      break;
    case 'mohawk':
      scalp(0.009, 1.5, 0.5, shaved);
      if (crown) {
        for (let i = 0; i < 7; i++) {
          const theta = -0.85 + i * 0.36;
          const { d, p } = onScalp(Math.abs(theta), theta < 0 ? Math.PI / 2 : -Math.PI / 2, 0.004);
          h.putAlong(new THREE.ConeGeometry(0.04, 0.12 - Math.abs(i - 2.5) * 0.012, 4), hx, p, d, [0.35, 1, 1]);
        }
      }
      break;
    case 'mullet':
      scalp(0.012, 1.5, 0.5);
      h.ball(hx, [0.1, 0.13, 0.05], [0, 0.0, -0.1], [0.2, 0, 0], undefined, 10, 6);
      fringe([0, 0.21, 0.075], [0.075, 0.022, 0.04], [0.55, 0, 0]);
      break;
    case 'bob':
      scalp(0.018, 1.7, 0.3);
      h.cyl(hx, 0.13, 0.145, 0.14, [0, 0.07, -0.006], O, [1, 1, 1.06], { seg: 14, open: false, t0: 0.62, tl: TAU - 1.24 });
      fringe([0, 0.214, 0.07], [0.095, 0.026, 0.045], [0.6, 0, 0]);
      break;
    case 'pixie':
      scalp(0.013, 1.55, 0.5);
      // Swept to one side over the forehead, wisps in front of the ears, short at the nape.
      fringe([0.025, 0.218, 0.074], [0.095, 0.028, 0.048], [0.5, 0, -0.32]);
      fringe([-0.06, 0.226, 0.055], [0.05, 0.024, 0.05], [0.4, 0, 0.35]);
      for (const s of [1, -1]) h.ball(hx, [0.011, 0.03, 0.016], [s * 0.111, 0.132, 0.042], [0.1, 0, s * 0.08], undefined, 6, 5);
      break;
    case 'bangs':
      scalp(0.015, 1.6, 0.5);
      longBack(h, hx, 0.2);
      for (const s of [1, -1]) h.ball(hx, [0.03, 0.15, 0.055], [s * 0.106, 0.05, -0.01], [0.04, 0, s * 0.05], undefined, 8, 6);
      // Blunt bangs straight across the forehead, down to the brows.
      if (crown) h.front(hx, [0.128, 0.152, 0.142], 0.5, 0.66, 2.1, [0, 0.12, -0.002], [-0.06, 0, 0], undefined, 14, 4);
      break;
    case 'wavy': {
      scalp(0.016, 1.62, 0.5);
      // Loose waves down the back: one fall of hair with waves breaking its edges and ends.
      longBack(h, hx, 0.21);
      for (let i = 0; i < 4; i++) {
        for (const s of [1, -1]) h.ball(hx, [0.036, 0.052, 0.05], [s * (0.1 + ((i + (s > 0 ? 0 : 1)) % 2) * 0.016), 0.12 - i * 0.085, -0.075], [0.1, 0, s * 0.3], undefined, 8, 6);
      }
      for (const k of [-1, 0, 1]) h.ball(hx, [0.048, 0.036, 0.042], [k * 0.06, -0.17 + Math.abs(k) * 0.025, -0.088], [0.2, 0, k * 0.4], undefined, 8, 6);
      for (const s of [1, -1]) {
        h.ball(hx, [0.032, 0.09, 0.055], [s * 0.107, 0.085, -0.008], [0.05, 0, s * 0.1], undefined, 8, 6);
        h.ball(hx, [0.036, 0.06, 0.055], [s * 0.117, -0.015, -0.025], [0.05, 0, -s * 0.18], undefined, 8, 6);
      }
      fringe([0.03, 0.222, 0.068], [0.1, 0.03, 0.05], [0.45, 0, -0.35]);
      fringe([-0.075, 0.2, 0.06], [0.04, 0.05, 0.045], [0.25, 0, 0.5]);
      break;
    }
    case 'shoulder':
      scalp(0.017, 1.7, 0.35);
      h.cyl(hx, 0.132, 0.158, 0.22, [0, 0.04, -0.008], O, [1, 1, 1.05], { seg: 16, open: false, t0: 0.72, tl: TAU - 1.44 });
      fringe([0.035, 0.222, 0.065], [0.1, 0.03, 0.05], [0.45, 0, -0.38]);
      break;
    case 'highpony':
      scalp(0.012, 1.55, 0.55);
      // Pulled up tight to a tie high on the crown, then a long tail arcing down the back.
      h.torus(shade(hx, 0.55), 0.022, 0.009, [0, 0.262, -0.085], [0.4, 0, 0], 1, 4, 10);
      for (const [y, z, r, rx] of [[0.27, -0.12, 0.04, 0.6], [0.2, -0.165, 0.042, 0.25], [0.09, -0.18, 0.038, -0.05], [-0.03, -0.165, 0.03, -0.2], [-0.12, -0.15, 0.02, -0.3]] as const) {
        h.ball(hx, [r, 0.075, r * 0.9], [0, y, z], [rx, 0, 0], undefined, 8, 6);
      }
      break;
    case 'braid': {
      scalp(0.012, 1.55, 0.55);
      h.torus(shade(hx, 0.6), 0.02, 0.008, [0, 0.16, -0.13], [1.0, 0, 0], 1, 4, 10);
      // Plaited segments down the back, narrowing, tied off with a tuft.
      for (let i = 0; i < 8; i++) {
        const y = 0.13 - i * 0.042;
        h.ico(hx, 0.027 - i * 0.0012, [(i % 2 ? 1 : -1) * 0.007, y, -0.152 + i * 0.004], [i * 0.7, 0, (i % 2 ? 1 : -1) * 0.5], [1, 1.25, 0.85], 1);
      }
      h.torus(shade(hx, 0.6), 0.012, 0.006, [0, -0.215, -0.122], [Math.PI / 2, 0, 0], 1, 4, 8);
      h.cone(hx, 0.02, 0.05, [0, -0.25, -0.12], [Math.PI, 0, 0], 1, 6);
      break;
    }
    case 'pigtails':
      scalp(0.013, 1.6, 0.45);
      fringe([0, 0.214, 0.072], [0.09, 0.026, 0.045], [0.55, 0, 0]);
      for (const s of [1, -1]) {
        h.torus(shade(hx, 0.55), 0.018, 0.008, [s * 0.112, 0.14, -0.075], [0, s * 0.9, 0], 1, 4, 10);
        h.ball(hx, [0.036, 0.11, 0.038], [s * 0.14, 0.05, -0.09], [0.15, 0, s * 0.28], undefined, 8, 6);
      }
      break;
    case 'spacebuns':
      scalp(0.013, 1.6, 0.45);
      fringe([0, 0.214, 0.072], [0.09, 0.026, 0.045], [0.55, 0, 0]);
      if (crown) {
        for (const s of [1, -1]) {
          h.ico(hx, 0.052, [s * 0.078, 0.25, -0.03], [s, 0.5, 0], 1, 1);
          h.torus(shade(hx, 0.6), 0.03, 0.008, [s * 0.07, 0.218, -0.025], [Math.PI / 2 - 0.2, 0, -s * 0.5], 1, 4, 10);
        }
      }
      break;
    case 'messybun':
      scalp(0.015, 1.58, 0.5);
      // A loose bun at the back of the head, strands escaping it and framing the face.
      h.put(crumple(new THREE.IcosahedronGeometry(0.058, 1), 0.01), hx, [0, 0.2, -0.15], [0.4, 0.3, 0], [1, 0.85, 0.95]);
      for (let i = 0; i < 4; i++) {
        const t = i * 1.6;
        h.putAlong(new THREE.ConeGeometry(0.012, 0.05, 4), hx, [Math.sin(t) * 0.04, 0.215 + Math.cos(t) * 0.03, -0.17], new THREE.Vector3(Math.sin(t), Math.cos(t) + 0.3, -0.6));
      }
      for (const s of [1, -1]) h.ball(hx, [0.007, 0.05, 0.01], [s * 0.106, 0.115, 0.06], [0.1, 0, s * 0.1], undefined, 6, 5);
      fringe([0.02, 0.222, 0.066], [0.085, 0.026, 0.045], [0.5, 0, -0.2]);
      break;
    case 'afropuffs':
      scalp(0.018, 1.6, 0.45);
      if (crown) {
        for (const s of [1, -1]) {
          h.ico(hx, 0.088, [s * 0.112, 0.245, -0.035], [s, 0.4, 0.2], [1, 0.95, 0.95], 2);
          h.torus(shade(hx, 0.55), 0.045, 0.009, [s * 0.085, 0.2, -0.03], [Math.PI / 2 - 0.2, 0, -s * 0.75], 1, 4, 12);
        }
      }
      break;
    case 'boxbraids': {
      scalp(0.014, 1.6, 0.5);
      // Thin braids falling from the hairline round the back and sides, longest at the back.
      for (let i = 0; i < 17; i++) {
        const phi = 1.4 + (i / 16) * (TAU - 2.8);
        const sx = Math.sin(phi), cz = Math.cos(phi);
        const back = Math.max(0, -cz);
        const len = 0.2 + back * 0.17;
        const x = sx * 0.128, z = cz * 0.142 - 0.006;
        h.cyl(hx, 0.009, 0.007, len, [x, 0.13 - len / 2, z], [cz * 0.05, 0, -sx * 0.05], 1, { seg: 5 });
        h.ball(shade(hx, 0.7), 0.009, [x, 0.13 - len, z], O, undefined, 5, 4);
      }
      fringe([0, 0.216, 0.07], [0.085, 0.024, 0.042], [0.55, 0, 0]);
      break;
    }
  }
}

/** The long fall of hair down the back (long styles), `len` down from the crown. */
function longBack(h: Kit, hx: number, len: number): void {
  h.ball(hx, [0.118, len, 0.062], [0, 0.23 - len, -0.09], [0.12, 0, 0], undefined, 12, 7);
}

function beard(h: Kit, a: Appearance, b: Body, hx: number): void {
  if (b.zombie && a.facialHair !== 'beard') return;
  const r = (inf: number): V3 => [0.117 + inf, 0.1404 + inf, 0.13 + inf];
  const stache = (thick = 1) => {
    for (const s of [1, -1]) h.ball(hx, [0.021, 0.0085 * thick, 0.011], [s * 0.016, 0.077, 0.119], [-0.2, 0, s * -0.25], undefined, 8, 5);
  };
  switch (a.facialHair) {
    case 'stubble':
      h.front(mixHex(hx, b.skin, 0.72), r(0.0025), 1.82, 0.9, 2.3, [0, 0.12, 0]);
      break;
    case 'mustache':
      stache(1.3);
      break;
    case 'handlebar':
      stache(1.1);
      for (const s of [1, -1]) h.cone(hx, 0.006, 0.028, [s * 0.04, 0.084, 0.11], [0, 0, -s * 0.9]);
      break;
    case 'goatee':
      stache();
      h.ball(hx, [0.022, 0.026, 0.013], [0, 0.026, 0.104], [0.3, 0, 0], undefined, 8, 6);
      break;
    case 'beard':
      h.front(hx, r(0.01), 1.8, 0.95, 3.0, [0, 0.12, 0]);
      h.ball(hx, [0.055, 0.042, 0.04], [0, 0.012, 0.07], O, undefined, 10, 6);
      stache(1.2);
      break;
    case 'chops':
      for (const s of [1, -1]) h.ball(hx, [0.022, 0.055, 0.045], [s * 0.1, 0.07, 0.035], [0, 0, s * 0.15], undefined, 8, 6);
      stache();
      break;
  }
}

// ── Headwear ────────────────────────────────────────────────────────────────────────────

const DOME_C: V3 = [0, 0.125, -0.005];
const domeR = (inf: number): V3 => [0.122 + inf, 0.145 + inf, 0.135 + inf];

function headwear(h: Kit, a: Appearance, hex: number): void {
  const dome = (k: Kit, color: number, inf: number, theta: number, surf?: Surface) => k.cap(color, domeR(inf), 0, theta, O, O, { w: 18, h: 8 }, surf);
  /** Frame at the dome center tilted so the front rim rides higher than the back. */
  const frame = (tilt: number) => h.at(DOME_C, [-tilt, 0, 0]);
  const rim = (inf: number, theta: number): { y: number; rx: number; rz: number } => {
    const R = domeR(inf);
    return { y: Math.cos(theta) * R[1], rx: Math.sin(theta) * R[0], rz: Math.sin(theta) * R[2] };
  };
  const dark = shade(hex, 0.55);
  switch (a.headwear) {
    case 'none':
      break;
    case 'cap':
    case 'capback': {
      const f = h.at([0, 0, 0], [0, a.headwear === 'capback' ? Math.PI : 0, 0]).at(DOME_C, [-0.3, 0, 0]);
      dome(f, hex, 0.02, 1.38);
      const rr = rim(0.02, 1.38);
      f.cyl(hex, 0.105, 0.105, 0.012, [0, rr.y + 0.004, rr.rz - 0.012], [0.32, 0, 0], [1, 1, 0.85], { seg: 12, t0: -Math.PI / 2, tl: Math.PI });
      f.ball(dark, 0.012, [0, domeR(0.02)[1], 0], O, undefined, 6, 4);
      break;
    }
    case 'beanie':
    case 'pombeanie': {
      const f = frame(0.22);
      dome(f, hex, 0.019, 1.78, { pattern: PATTERN.knit });
      const rr = rim(0.019, 1.78);
      f.cyl(hex, rr.rx + 0.008, rr.rx + 0.01, 0.045, [0, rr.y + 0.02, 0], O, [1, 1, rr.rz / rr.rx], { seg: 18 }, { pattern: PATTERN.knit });
      if (a.headwear === 'pombeanie') f.ico(mixHex(hex, 0xf2efe8, 0.6), 0.042, [0, domeR(0.019)[1] + 0.02, 0], O, 1, 1);
      break;
    }
    case 'bucket':
      h.cyl(hex, 0.112, 0.13, 0.1, [0, 0.235, -0.005], O, [1, 1, 1.08], { seg: 16 });
      h.cyl(hex, 0.135, 0.205, 0.035, [0, 0.175, -0.005], O, [1, 1, 1.05], { seg: 18 });
      h.cyl(dark, 0.131, 0.131, 0.018, [0, 0.198, -0.005], O, [1, 1, 1.08], { seg: 16 });
      break;
    case 'cowboy':
      h.cyl(hex, 0.1, 0.122, 0.13, [0, 0.26, -0.005], O, [1, 1, 1.18], { seg: 16 });
      h.box(shade(hex, 0.8), [0.03, 0.02, 0.2], [0, 0.325, -0.005]);
      h.cyl(0x2a1d14, 0.123, 0.123, 0.024, [0, 0.21, -0.005], O, [1, 1, 1.18], { seg: 16 });
      // Brim halves tilted up at the sides: the curl of a cowboy brim.
      for (const s of [1, -1]) h.cyl(hex, 0.27, 0.27, 0.014, [0, 0.2, -0.01], [0, 0, s * 0.2], [1, 1, 0.86], { seg: 12, t0: s > 0 ? 0 : Math.PI, tl: Math.PI });
      break;
    case 'fedora':
      h.cyl(hex, 0.102, 0.122, 0.12, [0, 0.255, -0.005], O, [1, 1, 1.12], { seg: 16 });
      h.box(shade(hex, 0.8), [0.025, 0.018, 0.17], [0, 0.315, 0]);
      h.cyl(0x1b1b1d, 0.123, 0.123, 0.026, [0, 0.21, -0.005], O, [1, 1, 1.12], { seg: 16 });
      h.cyl(hex, 0.19, 0.19, 0.012, [0, 0.198, 0.0], [0.12, 0, 0], [1, 1, 0.92], { seg: 20 });
      break;
    case 'flatcap': {
      const f = frame(0.3);
      f.cap(hex, [0.14, 0.11, 0.165], 0, 1.4, [0, 0.02, 0.012], O, { w: 18, h: 7 });
      f.cyl(dark, 0.09, 0.09, 0.01, [0, 0.03, 0.15], [0.22, 0, 0], [1, 1, 0.55], { seg: 12, t0: -Math.PI / 2, tl: Math.PI });
      break;
    }
    case 'bandana': {
      const f = frame(0.4);
      dome(f, hex, 0.01, 1.45, { pattern: PATTERN.floral, accent: 0xe8e2d6 });
      h.ico(hex, 0.022, [0, 0.12, -0.15], O, 1, 1, { pattern: PATTERN.floral, accent: 0xe8e2d6 });
      for (const s of [1, -1]) h.box(hex, [0.03, 0.08, 0.008], [s * 0.02, 0.07, -0.152], [-0.2, 0, s * 0.25], { pattern: PATTERN.floral, accent: 0xe8e2d6 });
      break;
    }
    case 'sweatband':
      h.cyl(hex, 0.127, 0.129, 0.034, [0, 0.19, -0.004], O, [0.97, 1, 1.06], { seg: 18 }, { pattern: PATTERN.knit });
      break;
    case 'hardhat': {
      const f = frame(0.12);
      dome(f, hex, 0.032, Math.PI / 2);
      const R = domeR(0.032);
      f.cyl(hex, R[0] + 0.02, R[0] + 0.035, 0.014, [0, 0.0, 0.015], O, [1, 1, 1.18], { seg: 20 });
      f.box(shade(hex, 0.9), [0.03, 0.02, 0.24], [0, R[1] - 0.004, 0]);
      break;
    }
    case 'army': {
      const f = frame(0.15);
      dome(f, hex, 0.035, 1.7, { pattern: PATTERN.camo, accent: shade(hex, 0.7) });
      const rr = rim(0.035, 1.7);
      f.cyl(shade(hex, 0.85), rr.rx + 0.02, rr.rx + 0.028, 0.016, [0, rr.y, 0], O, [1, 1, rr.rz / rr.rx], { seg: 20 });
      h.torus(0x3a3226, 0.1, 0.004, [0, 0.06, 0.0], [0, Math.PI / 2, 0], [1, 1.1, 1], 3, 12, Math.PI);
      break;
    }
    case 'moto':
      h.ball(hex, [0.16, 0.172, 0.172], [0, 0.12, -0.008], O, undefined, 18, 12);
      h.front(0x0e1116, [0.166, 0.178, 0.178], 1.15, 0.75, 2.1, [0, 0.12, -0.008], O, undefined, 14, 4);
      h.box(dark, [0.2, 0.012, 0.03], [0, 0.04, 0.15], [0.2, 0, 0]);
      break;
    case 'football': {
      const f = frame(0.18);
      dome(f, hex, 0.04, 1.95);
      const R = domeR(0.04);
      f.box(0xe8e6e0, [0.03, 0.01, 0.3], [0, R[1], 0], [0, 0, 0]);
      for (const y of [0.04, 0.085]) h.torus(0x9a9ca0, 0.115, 0.0055, [0, y, 0.035], [Math.PI / 2, 0, 0], [1.05, 1, 1.15], 4, 12, Math.PI);
      h.cyl(0x9a9ca0, 0.006, 0.006, 0.07, [0, 0.07, 0.165]);
      for (const s of [1, -1]) h.cyl(shade(hex, 0.8), 0.04, 0.04, 0.02, [s * 0.15, 0.1, 0.0], [0, 0, Math.PI / 2], 1, { seg: 10 });
      break;
    }
    case 'bike': {
      const f = frame(0.25);
      f.cap(hex, [0.15, 0.17, 0.19], 0, 1.35, [0, 0, -0.02], O, { w: 18, h: 7 });
      for (const x of [-0.05, 0, 0.05]) f.box(shade(hex, 0.55), [0.018, 0.008, 0.16], [x, 0.165, -0.02]);
      f.box(0x16181b, [0.16, 0.01, 0.04], [0, 0.05, 0.17], [0.4, 0, 0]);
      h.torus(0x1b1d20, 0.1, 0.003, [0, 0.06, 0], [0, Math.PI / 2, 0], [1, 1.1, 1], 3, 12, Math.PI);
      break;
    }
    case 'fire': {
      const f = frame(0.1);
      dome(f, hex, 0.035, 1.5);
      f.cyl(hex, 0.2, 0.21, 0.014, [0, 0.01, -0.06], [-0.08, 0, 0], [1, 1, 1.25], { seg: 22 });
      f.box(shade(hex, 0.85), [0.035, 0.03, 0.3], [0, domeR(0.035)[1] - 0.005, -0.02]);
      f.box(0xc9a233, [0.07, 0.085, 0.012], [0, 0.11, 0.155], [-0.35, 0, 0]);
      break;
    }
    case 'knight':
      h.cyl(0x8c9096, 0.148, 0.152, 0.27, [0, 0.12, -0.005], O, [1, 1, 1.02], { seg: 16 });
      h.cap(0x8c9096, [0.148, 0.05, 0.151], 0, Math.PI / 2, [0, 0.255, -0.005], O, { w: 16, h: 4 });
      h.box(0x0a0a0b, [0.2, 0.016, 0.02], [0, 0.145, 0.146]);
      h.box(0x6d7177, [0.014, 0.17, 0.012], [0, 0.07, 0.152]);
      for (let i = 0; i < 6; i++) h.cyl(0x0a0a0b, 0.0045, 0.0045, 0.01, [(i % 3 - 1) * 0.03 + 0.06, 0.07 - Math.floor(i / 3) * 0.025, 0.148], [Math.PI / 2, 0, 0], 1, { seg: 5 });
      break;
    case 'cone':
      h.at([0.01, 0, 0], [0, 0, -0.12]).cyl(0xe2561c, 0.018, 0.13, 0.38, [0, 0.44, 0], O, 1, { seg: 14 });
      h.at([0.01, 0, 0], [0, 0, -0.12]).cyl(0xf2f0ea, 0.064, 0.082, 0.05, [0, 0.48, 0], O, 1.02, { seg: 14, open: true });
      h.at([0.01, 0, 0], [0, 0, -0.12]).cyl(0xf2f0ea, 0.035, 0.05, 0.04, [0, 0.57, 0], O, 1.02, { seg: 14, open: true });
      h.at([0.01, 0, 0], [0, 0, -0.12]).box(0x1d1d1f, [0.27, 0.025, 0.27], [0, 0.255, 0]);
      break;
    case 'party':
      h.at([0.03, 0, 0], [0.05, 0, -0.22]).cone(hex, 0.075, 0.21, [0, 0.36, 0], O, 1, 12, { pattern: PATTERN.stripes, accent: 0xf2efe6 });
      h.at([0.03, 0, 0], [0.05, 0, -0.22]).ico(0xf2c81c, 0.022, [0, 0.47, 0], O, 1, 1);
      h.torus(0xd8d6d0, 0.1, 0.002, [0, 0.07, 0.0], [0, Math.PI / 2, 0], [1, 1.25, 1], 3, 12, Math.PI);
      break;
    case 'propeller': {
      const f = frame(0.25);
      const colors = [hex, 0xf2c81c, hex, 0x2b4f9e];
      for (let i = 0; i < 4; i++) f.cap(colors[i], domeR(0.018), 0, 1.4, O, O, { p0: i * Math.PI / 2, pl: Math.PI / 2, w: 5, h: 7 });
      const top = domeR(0.018)[1];
      f.cyl(0x9a9ca0, 0.006, 0.006, 0.05, [0, top + 0.02, 0]);
      f.box(0xd21f1f, [0.24, 0.006, 0.035], [0, top + 0.046, 0], [0.12, 0.5, 0]);
      f.box(0x2b4f9e, [0.24, 0.006, 0.035], [0, top + 0.046, 0], [-0.12, 0.5 + Math.PI / 2, 0]);
      f.cyl(0x1d1d1f, 0.09, 0.09, 0.01, [0, 0.03, 0.12], [0.22, 0, 0], [1, 1, 0.5], { seg: 12, t0: -Math.PI / 2, tl: Math.PI });
      break;
    }
    case 'chef':
      h.cyl(0xf3f1ec, 0.123, 0.12, 0.16, [0, 0.27, -0.005], O, [1, 1, 1.08], { seg: 16 });
      for (let i = 0; i < 6; i++) {
        const t = (i / 6) * TAU;
        h.ico(0xf3f1ec, 0.07, [Math.sin(t) * 0.07, 0.37, Math.cos(t) * 0.07 - 0.005], [i, 0, 0], 1, 1);
      }
      h.ico(0xf3f1ec, 0.08, [0, 0.39, -0.005], O, 1, 1);
      h.cyl(0xe2ded5, 0.127, 0.127, 0.035, [0, 0.205, -0.005], O, [1, 1, 1.08], { seg: 16 });
      break;
    case 'tophat':
      h.cyl(hex, 0.1, 0.098, 0.22, [0, 0.355, -0.005], O, [1, 1, 1.12], { seg: 16 });
      h.cyl(0x8e1f22, 0.102, 0.102, 0.034, [0, 0.265, -0.005], O, [1, 1, 1.12], { seg: 16 });
      h.cyl(hex, 0.17, 0.17, 0.012, [0, 0.245, -0.005], O, [1, 1, 1.0], { seg: 20 });
      break;
    case 'viking': {
      const f = frame(0.1);
      dome(f, 0x8d9197, 0.03, 1.6);
      const rr = rim(0.03, 1.6);
      f.cyl(0x5a3e2a, rr.rx + 0.012, rr.rx + 0.012, 0.03, [0, rr.y + 0.012, 0], O, [1, 1, rr.rz / rr.rx], { seg: 20 });
      f.box(0x6d7177, [0.03, 0.18, 0.012], [0, 0.11, 0.12], [-0.6, 0, 0]);
      for (const s of [1, -1]) {
        f.put(new THREE.ConeGeometry(0.028, 0.1, 8), 0xe8dcc0, [s * 0.16, 0.06, 0], [0, 0, -s * 1.1]);
        f.put(new THREE.ConeGeometry(0.018, 0.08, 8), 0xe8dcc0, [s * 0.215, 0.13, 0], [0, 0, -s * 0.3]);
      }
      break;
    }
    case 'pot':
      h.cyl(0xa7abb0, 0.15, 0.138, 0.14, [0, 0.245, -0.005], O, [1, 1, 1.04], { seg: 18 });
      h.cyl(0xb8bcc2, 0.158, 0.158, 0.014, [0, 0.18, -0.005], O, [1, 1, 1.04], { seg: 18 });
      h.box(0x18191b, [0.2, 0.022, 0.04], [0.24, 0.2, -0.005], [0, 0, 0.1]);
      h.cyl(0x18191b, 0.02, 0.02, 0.03, [0, 0.325, -0.005]);
      break;
    case 'foil':
      h.put(crumple(new THREE.ConeGeometry(0.14, 0.24, 7, 3), 0.012), 0xc8cdd2, [0, 0.31, -0.005], [0.06, 0, 0.04], [1, 1, 1.05]);
      break;
    case 'crown':
      h.tube(0xd3a628, 0.11, 0.115, 0.06, [0, 0.245, -0.005], O, [1, 1, 1.08], 12);
      for (let i = 0; i < 8; i++) {
        const t = (i / 8) * TAU;
        h.cone(0xd3a628, 0.02, 0.055, [Math.sin(t) * 0.108, 0.3, Math.cos(t) * 0.116 - 0.005], [Math.cos(t) * -0.15, 0, Math.sin(t) * 0.15], 1, 4);
        h.ball(i % 2 ? 0x2b4f9e : 0xb01e2a, 0.011, [Math.sin(t) * 0.118, 0.245, Math.cos(t) * 0.126 - 0.005], O, undefined, 6, 4);
      }
      break;
    case 'bunny':
      h.torus(hex, 0.13, 0.008, [0, 0.12, 0.02], O, [1, 1.12, 1], 4, 16, Math.PI);
      for (const s of [1, -1]) {
        h.ball(hex, [0.032, 0.12, 0.014], [s * 0.05, 0.39, 0.02], [0, 0, -s * 0.18], undefined, 10, 7);
        h.ball(0xe9a3b6, [0.018, 0.09, 0.006], [s * 0.05, 0.385, 0.031], [0, 0, -s * 0.18], undefined, 8, 6);
      }
      break;
    case 'pirate':
      h.cap(0x141416, domeR(0.02), 0, 1.4, DOME_C, [-0.15, 0, 0], { w: 16, h: 7 });
      h.cyl(0x141416, 0.25, 0.14, 0.075, [0, 0.245, 0], [0, 0, 0], [1, 1, 0.95], { seg: 3 });
      h.cyl(0xc9a233, 0.253, 0.253, 0.006, [0, 0.283, 0], O, [1, 1, 0.95], { seg: 3, open: true });
      h.ball(0xeeeae0, [0.022, 0.02, 0.008], [0, 0.24, 0.2], [0, 0, 0], undefined, 8, 5);
      for (const s of [1, -1]) h.box(0xeeeae0, [0.05, 0.007, 0.006], [0, 0.215, 0.205], [0, 0, s * 0.6]);
      break;
    case 'sombrero':
      h.cyl(hex, 0.4, 0.4, 0.016, [0, 0.205, -0.005], O, 1, { seg: 28 });
      h.tube(hex, 0.44, 0.4, 0.06, [0, 0.235, -0.005], O, [1, 1, 1], 28);
      h.cyl(hex, 0.06, 0.13, 0.2, [0, 0.31, -0.005], O, 1, { seg: 16 });
      h.cyl(0x8e1f22, 0.112, 0.126, 0.04, [0, 0.235, -0.005], O, 1.02, { seg: 16, open: true }, { pattern: PATTERN.stripes, accent: 0x2f8a4a });
      break;
    case 'duck':
      h.ico(0xf2c81c, 0.09, [0, 0.31, -0.02], O, [1, 0.72, 1.25], 1);
      h.ico(0xf2c81c, 0.056, [0, 0.4, 0.06], O, 1, 1);
      h.box(0xe0701c, [0.05, 0.014, 0.05], [0, 0.395, 0.12], [0.1, 0, 0]);
      for (const s of [1, -1]) h.ball(0x0a0a0a, 0.008, [s * 0.03, 0.415, 0.103], O, undefined, 5, 4);
      h.cone(0xf2c81c, 0.03, 0.06, [0, 0.35, -0.13], [-1.0, 0, 0], 1, 6);
      break;
    case 'lampshade':
      h.at([0.02, 0, 0], [0.08, 0, -0.16]).tube(hex, 0.095, 0.17, 0.19, [0, 0.33, 0], O, [1, 1, 1], 14);
      h.at([0.02, 0, 0], [0.08, 0, -0.16]).cyl(0xc9a233, 0.098, 0.098, 0.012, [0, 0.42, 0], O, 1, { seg: 14, open: true });
      break;
    case 'beret': {
      // A soft disc slouched over to one side, with the little stalk on top.
      const f = h.at([0.022, 0.228, -0.012], [-0.12, 0, -0.26]);
      f.ball(hex, [0.158, 0.052, 0.152], [0, 0.012, 0], O, undefined, 18, 8);
      f.cyl(shade(hex, 0.8), 0.118, 0.122, 0.022, [0, -0.025, 0], O, [1, 1, 1.05], { seg: 16 });
      f.cyl(shade(hex, 0.7), 0.006, 0.008, 0.024, [0, 0.07, 0]);
      break;
    }
    case 'sunhat': {
      const f = frame(0.12);
      dome(f, hex, 0.026, 1.45, { pattern: PATTERN.knit });
      // A wide, soft brim drooping at the edge, and a ribbon round the crown.
      h.cyl(hex, 0.25, 0.3, 0.016, [0, 0.188, -0.005], [0.06, 0, 0], [1, 1, 0.96], { seg: 24 }, { pattern: PATTERN.knit });
      h.cyl(0x1b1b1d, 0.141, 0.143, 0.026, [0, 0.21, -0.005], [0.06, 0, 0], [1, 1, 1.05], { seg: 18 });
      h.ico(0x1b1b1d, 0.016, [0.13, 0.205, -0.07], O, [0.6, 1, 1.4], 0);
      break;
    }
    case 'headband':
      h.torus(hex, 0.139, 0.0125, [0, 0.12, 0.035], [-0.28, 0, 0], [1, 1.12, 1.25], 4, 18, Math.PI);
      break;
    case 'hairbow': {
      // A big bow on the top of the head, off to one side.
      const f = h.at([0.07, 0.262, -0.035], [0.25, 0.35, -0.42]);
      for (const s of [1, -1]) f.cone(hex, 0.045, 0.07, [s * 0.038, 0, 0], [0, 0, s * Math.PI / 2], [1, 1, 0.5], 6);
      f.ico(shade(hex, 0.8), 0.019, O, O, [1, 1, 0.75], 1);
      for (const s of [1, -1]) f.box(hex, [0.02, 0.055, 0.006], [s * 0.014, -0.034, -0.006], [0, 0, s * 0.35]);
      break;
    }
    case 'clips':
      // Three snap clips in a row above the temple, holding the hair back.
      for (let i = 0; i < 3; i++) {
        const t = 0.62 + i * 0.2;
        h.box(i === 1 ? shade(hex, 0.8) : hex, [0.01, 0.014, 0.05], [Math.sin(t) * 0.148, 0.125 + Math.cos(t) * 0.16, 0.05 - i * 0.004], [0.25, 0, -t]);
      }
      break;
    case 'flowercrown': {
      // A green vine round the head with flowers and leaves woven in.
      h.torus(0x3d6a34, 0.135, 0.007, [0, 0.215, -0.012], [Math.PI / 2 - 0.25, 0, 0], [1, 1.07, 1], 4, 22);
      const petals = [0xf2efe8, 0xe9a3c0, 0xf2c81c, 0xb59ad8, 0xe9a3c0, 0xf2efe8, 0xd8669c, 0xf2c81c];
      for (let i = 0; i < 10; i++) {
        const t = (i / 10) * TAU + 0.3;
        const x = Math.sin(t) * 0.137, z = Math.cos(t) * 0.147 - 0.012;
        const y = 0.215 + Math.cos(t) * 0.035;
        h.ico(petals[i % petals.length], 0.019, [x, y, z], [i, i * 2, 0], [1, 0.7, 1], 0);
        h.ball(0xe0b030, 0.007, [x * 1.08, y + 0.004, z * 1.08], O, undefined, 5, 4);
        h.ball(0x4f7d3c, [0.016, 0.004, 0.008], [Math.sin(t + 0.3) * 0.14, y - 0.008, Math.cos(t + 0.3) * 0.15 - 0.012], [0, t, 0.4], undefined, 6, 3);
      }
      break;
    }
    case 'tiara': {
      // A gold band across the front of the crown, peaks rising to a jewel in the middle.
      const f = h.at([0, 0.245, -0.01], [0.25, 0, 0]);
      const arc = 2.1;
      f.torus(0xd3a628, 1, 0.006, O, [-Math.PI / 2, 0, -Math.PI / 2 - arc / 2], [0.142, 0.155, 1], 3, 18, arc);
      for (let i = -3; i <= 3; i++) {
        const phi = i * 0.27;
        const x = Math.sin(phi) * 0.142, z = Math.cos(phi) * 0.155;
        const hgt = i === 0 ? 0.055 : Math.abs(i) === 2 ? 0.038 : 0.026;
        f.put(new THREE.ConeGeometry(0.013, hgt, 3), 0xd3a628, [x, hgt / 2, z], [0, phi, 0], [1, 1, 0.35]);
        f.ico(i === 0 ? 0xb01e2a : 0xe8f2ff, i === 0 ? 0.01 : 0.0055, [x * 1.04, 0.012, z * 1.04], O, 1, 0);
      }
      break;
    }
    case 'catears':
      h.torus(hex, 0.134, 0.007, [0, 0.12, 0.015], [-0.12, 0, 0], [1, 1.13, 1], 4, 16, Math.PI);
      for (const s of [1, -1]) {
        h.cone(hex, 0.04, 0.07, [s * 0.075, 0.278, 0.0], [0, 0, -s * 0.38], [1, 1, 0.4], 3);
        h.cone(0xe9a3b6, 0.024, 0.042, [s * 0.075, 0.272, 0.009], [0, 0, -s * 0.38], [1, 1, 0.25], 3);
      }
      break;
    case 'witch': {
      // Wide brim, a tall cone that bends over near the tip, and an orange band.
      h.cyl(hex, 0.3, 0.3, 0.012, [0, 0.2, -0.005], [0.05, 0, 0], 1, { seg: 26 });
      h.cyl(hex, 0.085, 0.135, 0.17, [0, 0.29, -0.01], [0.05, 0, 0], [1, 1, 1.05], { seg: 16 });
      h.at([0, 0.37, -0.02], [-0.25, 0, 0.12]).cone(hex, 0.088, 0.2, [0, 0.09, 0], O, 1, 14);
      h.at([0, 0.37, -0.02], [-0.25, 0, 0.12]).at([0, 0.17, 0], [-0.5, 0, 0.3]).cone(hex, 0.035, 0.1, [0, 0.045, 0], O, 1, 10);
      h.cyl(0xe2701c, 0.138, 0.138, 0.032, [0, 0.225, -0.005], [0.05, 0, 0], [1, 1, 1.05], { seg: 16 });
      h.box(0xd3a628, [0.034, 0.03, 0.008], [0, 0.225, 0.14], [0.05, 0, 0]);
      break;
    }
  }
}

// ── Clothing ────────────────────────────────────────────────────────────────────────────

type Sleeve = 'none' | 'short' | 'long' | 'jacket' | 'puffy';

/** A torso layer from spine-space height y0 to y1, `inf` meters out, open at the front by `gap` radians. */
function shell(sp: Kit, b: Body, hex: number, inf: number, y0: number, y1: number, gap = 0, surf?: Surface, rbOverride?: number): void {
  if (b.female) {
    femaleLayer(sp, b, hex, inf, y0, y1, gap, surf, rbOverride);
    return;
  }
  const rt = torsoR(b, y1), rb = rbOverride ?? torsoR(b, y0);
  const rm = (rt + rb) / 2;
  const sx = (b.bx * rm + inf) / (rm + inf), sz = (0.62 * b.bz * rm + inf) / (rm + inf);
  sp.cyl(hex, rt + inf, rb + inf, y1 - y0, [0, (y0 + y1) / 2, 0], O, [sx, 1, sz], { seg: 14, open: gap > 0, t0: gap / 2, tl: TAU - gap }, surf);
}

function torso(sp: Kit, b: Body, hex: number, surf?: Surface): void {
  if (b.female) {
    femaleLayer(sp, b, hex, 0, 0.02, 0.52, 0, surf);
    return;
  }
  sp.cyl(hex, 0.21, 0.16, 0.5, [0, 0.27, 0], O, [b.bx, 1, 0.62 * b.bz], { seg: 14 }, surf);
}

/** Elbow and knee balls' size relative to the joint ring: inside the limb's flat sides while it is straight. */
const jointK = (b: Body) => Math.cos(Math.PI / b.seg) * 0.97;

/** Rings of the arm a body is built with (upper arm, forearm). */
const armRings = (b: Body) => ({ up: ringsFor(b, ARM_UP), lo: ringsFor(b, ARM_LO) });

/**
 * Both arms in a sleeve style: upper arm and forearm each one tapered surface, bending smoothly
 * at the elbow (the two meet in the same ring and share it between both bones there), with a
 * ball at the elbow that keeps its point when it bends far.
 */
function sleeves(kit: (bone: number) => Kit, b: Body, kind: Sleeve, hex: number, surf?: Surface, cuff?: number): void {
  const skin = b.skin;
  const { up: UP, lo: LO } = armRings(b);
  for (const s of [1, -1]) {
    const ub = s > 0 ? BONE.armLUpper : BONE.armRUpper, lb = ub + 1;
    const up = kit(ub), lo = kit(lb);
    const k = b.arm;
    // Zombie sleeves are often torn off at the elbow.
    const torn = b.zombie && b.rand() < 0.5;
    const inf = kind === 'jacket' ? 0.01 : kind === 'puffy' ? 0.022 : kind === 'long' ? 0.003 : 0;
    const upHex = kind === 'none' || kind === 'short' ? skin : hex;
    const loHex = kind === 'long' || kind === 'jacket' || kind === 'puffy' ? (torn ? skin : hex) : skin;
    const upInf = upHex === skin ? 0 : inf, loInf = loHex === skin ? 0 : inf;
    const upSurf = upHex === skin ? undefined : surf, loSurf = loHex === skin ? undefined : surf;
    up.ball(kind === 'none' ? skin : hex, 0.062 * k + inf, [0, -0.01, 0], O, kind === 'none' ? undefined : surf, 8, 6);
    // A sleeve ending at the elbow is closed off there (the bare forearm runs on inside it).
    up.lathe(upHex, UP, k, upInf, b.seg, { top: true, bottom: upInf !== loInf }, upSurf, { bone: lb, y: -ARM.upper, band: BEND });
    lo.lathe(loHex, LO, k, loInf, b.seg, { top: upInf !== loInf, bottom: true }, loSurf, { bone: ub, y: 0, band: BEND });
    lo.ball(loHex, ringAt(LO, 0).r * k * jointK(b) + loInf, [0, 0, 0], O, loSurf, b.seg, b.zombie ? 3 : 5);
    if (kind === 'short') up.lathe(hex, [[0.01, 0.065], [-0.06, 0.064], [-0.125, 0.06]], k, 0, b.seg, { top: true, bottom: true }, surf);
    if (kind === 'puffy') for (const y of [-0.1, -0.22]) up.torus(hex, ringAt(UP, y).r * k + inf - 0.006, 0.018, [0, y, 0], [Math.PI / 2, 0, 0], 1, 4, 10, TAU, surf);
    if (loHex !== skin && cuff !== undefined) {
      const r = ringAt(LO, -0.272).r * k + loInf + 0.004;
      lo.cyl(cuff, r, r, 0.035, [0, -0.272, 0], O, 1, { seg: b.seg });
    }
    if (torn && (kind === 'long' || kind === 'jacket')) {
      const r = ringAt(LO, -0.02).r * k;
      lo.cyl(hex, r + 0.01, r + 0.007, 0.04, [0, -0.02, 0], O, 1, { seg: 7 }, surf);
    }
  }
}

function collarRing(sp: Kit, hex: number, surf?: Surface): void {
  sp.torus(hex, 0.068, 0.011, [0, 0.522, 0.0], [Math.PI / 2, 0, 0], [1, 0.9, 1], 4, 12, TAU, surf);
}

/** Shirt collar points at the front of the neck. */
function collarPoints(sp: Kit, b: Body, hex: number, surf?: Surface, spread = 0.5): void {
  for (const s of [1, -1]) sp.box(hex, [0.06, 0.012, 0.055], [s * 0.04, 0.522, frontZ(b, 0.52) - 0.02], [-0.25, s * 0.2, s * spread], surf);
}

function buttons(sp: Kit, b: Body, hex: number, y0 = 0.08, y1 = 0.46, n = 5): void {
  for (let i = 0; i < n; i++) {
    const y = y0 + (i / (n - 1)) * (y1 - y0);
    sp.box(hex, [0.012, 0.012, 0.006], [0, y, chestZ(b, 0, y) + 0.004]);
  }
}

function hood(sp: Kit, hex: number, surf?: Surface): void {
  sp.ball(hex, [0.13, 0.075, 0.09], [0, 0.565, -0.105], [0.35, 0, 0], surf, 12, 7);
  sp.torus(shade(hex, 0.85), 0.085, 0.018, [0, 0.555, -0.03], [Math.PI / 2 - 0.25, 0, 0], [1.05, 1, 0.9], 4, 12, TAU, surf);
}

function lapels(sp: Kit, b: Body, hex: number, gap: number, surf?: Surface, size = 1): void {
  const y = 0.44;
  const r = torsoR(b, y);
  for (const s of [1, -1]) {
    const t = gap / 2 + 0.05;
    const x = Math.sin(t) * r * b.bx * s, z = Math.cos(t) * 0.62 * b.bz * r + 0.016;
    sp.box(hex, [0.06 * size, 0.17 * size, 0.012], [x + s * 0.02, y, z], [-0.12, s * 0.35, s * 0.32], surf);
  }
}

function pocket(sp: Kit, b: Body, hex: number, x: number, y: number, w = 0.06, h = 0.06, flap = true): void {
  const z = chestZ(b, x, y) + 0.006;
  sp.box(hex, [w, h, 0.01], [x, y, z]);
  if (flap) sp.box(shade(hex, 0.85), [w + 0.006, 0.018, 0.014], [x, y + h / 2, z + 0.002]);
}

function top(sp: Kit, kit: (bone: number) => Kit, a: Appearance, b: Body): void {
  const main = paletteColor('cloth', a.topColor);
  const acc = paletteColor('cloth', a.topAccent);
  const under = luminance(main) < 0.35 ? 0xd8d6d0 : 0x2b2d31;
  const plaid: Surface = { pattern: PATTERN.plaid, accent: acc };
  const button = shade(main, 1.35);
  // Kept safe for work: a woman is never drawn bare chested, whatever the look says.
  const kind = a.top === 'shirtless' && b.female ? 'bikini' : a.top;
  switch (kind) {
    case 'tee':
      torso(sp, b, main);
      sleeves(kit, b, 'short', main);
      collarRing(sp, shade(main, 0.85));
      break;
    case 'tank':
      torso(sp, b, main);
      sleeves(kit, b, 'none', main);
      sp.ball(b.skin, [0.075, 0.05, 0.02], [0, 0.5, frontZ(b, 0.5) - 0.004], O, undefined, 8, 5);
      break;
    case 'longsleeve':
      torso(sp, b, main);
      sleeves(kit, b, 'long', main, undefined, shade(main, 0.85));
      collarRing(sp, shade(main, 0.85));
      break;
    case 'striped': {
      const st: Surface = { pattern: PATTERN.stripes, accent: acc };
      torso(sp, b, main, st);
      sleeves(kit, b, 'short', main, st);
      collarRing(sp, acc);
      break;
    }
    case 'buttonup':
      torso(sp, b, main);
      sleeves(kit, b, 'long', main, undefined, main);
      collarPoints(sp, b, main);
      sp.box(shade(main, 0.9), [0.024, 0.46, 0.006], [0, 0.27, frontZ(b, 0.27) + 0.002]);
      buttons(sp, b, button);
      if (!b.female) pocket(sp, b, main, 0.07, 0.38, 0.055, 0.06, false);
      break;
    case 'flannel':
      torso(sp, b, main, plaid);
      sleeves(kit, b, 'long', main, plaid, shade(main, 0.8));
      collarPoints(sp, b, main, plaid);
      buttons(sp, b, button);
      if (!b.female) for (const x of [0.075, -0.075]) pocket(sp, b, shade(main, 0.95), x, 0.37, 0.055, 0.06);
      break;
    case 'openflannel': {
      const gap = 0.75;
      torso(sp, b, under);
      collarRing(sp, shade(under, 0.9));
      shell(sp, b, main, 0.014, -0.03, 0.52, gap, plaid);
      sleeves(kit, b, 'jacket', main, plaid, shade(main, 0.8));
      lapels(sp, b, main, gap, plaid, 0.8);
      break;
    }
    case 'hawaiian': {
      const fl: Surface = { pattern: PATTERN.floral, accent: acc };
      torso(sp, b, main, fl);
      sleeves(kit, b, 'short', main, fl);
      sp.ball(b.skin, [0.05, 0.06, 0.02], [0, 0.49, frontZ(b, 0.49) - 0.003], O, undefined, 8, 5);
      collarPoints(sp, b, main, fl, 0.9);
      buttons(sp, b, 0xeeeae0, 0.08, 0.38, 4);
      break;
    }
    case 'sweater': {
      const knit: Surface = { pattern: PATTERN.knit };
      torso(sp, b, main, knit);
      shell(sp, b, acc, 0.004, 0.33, 0.4, 0, knit);
      sleeves(kit, b, 'long', main, knit, shade(main, 0.85));
      collarRing(sp, shade(main, 0.85), knit);
      shell(sp, b, shade(main, 0.85), 0.006, 0.0, 0.05, 0, knit);
      break;
    }
    case 'hoodie':
      torso(sp, b, main);
      sleeves(kit, b, 'long', main, undefined, shade(main, 0.85));
      hood(sp, main);
      pocket(sp, b, shade(main, 0.92), 0, 0.12, 0.2, 0.09, false);
      for (const s of [1, -1]) sp.box(acc, [0.007, 0.1, 0.007], [s * 0.03, 0.44, frontZ(b, 0.44) + 0.006]);
      shell(sp, b, shade(main, 0.85), 0.006, 0.0, 0.05);
      break;
    case 'ziphoodie': {
      const gap = 0.3;
      torso(sp, b, acc);
      shell(sp, b, main, 0.012, 0.0, 0.52, gap);
      sleeves(kit, b, 'jacket', main, undefined, shade(main, 0.85));
      hood(sp, main);
      for (const s of [1, -1]) {
        sp.box(0x9a9ca0, [0.006, 0.44, 0.006], [s * Math.sin(gap / 2 + 0.02) * 0.19 * b.bx, 0.27, frontZ(b, 0.27) + 0.014]);
        sp.box(0xd8d6d0, [0.007, 0.1, 0.007], [s * 0.05, 0.44, frontZ(b, 0.44) + 0.016]);
      }
      break;
    }
    case 'denim': {
      const gap = 0.55;
      const den: Surface = { pattern: PATTERN.denim };
      torso(sp, b, acc);
      collarRing(sp, shade(acc, 0.9));
      shell(sp, b, main, 0.016, 0.0, 0.52, gap, den);
      sleeves(kit, b, 'jacket', main, den, shade(main, 0.85));
      lapels(sp, b, main, gap, den, 0.85);
      for (const s of [1, -1]) pocket(sp, b, main, s * 0.115 * b.bx, 0.37, 0.06, 0.06);
      shell(sp, b, shade(main, 0.88), 0.02, 0.0, 0.05, gap, den);
      break;
    }
    case 'leather': {
      const gap = 0.5;
      torso(sp, b, acc);
      collarRing(sp, shade(acc, 0.9));
      shell(sp, b, main, 0.017, -0.01, 0.52, gap);
      sleeves(kit, b, 'jacket', main, undefined, shade(main, 0.8));
      lapels(sp, b, main, gap, undefined, 1.1);
      sp.box(0x9a9ca0, [0.006, 0.4, 0.006], [Math.sin(gap / 2 + 0.03) * 0.19 * b.bx, 0.23, frontZ(b, 0.23) + 0.015]);
      shell(sp, b, shade(main, 0.8), 0.021, -0.01, 0.03, gap);
      break;
    }
    case 'varsity': {
      torso(sp, b, main);
      sleeves(kit, b, 'jacket', acc, undefined, main);
      const rib: Surface = { pattern: PATTERN.stripes, accent: acc };
      collarRing(sp, main, rib);
      shell(sp, b, main, 0.006, 0.0, 0.06, 0, rib);
      sp.box(0x9a9ca0, [0.004, 0.44, 0.004], [0, 0.27, frontZ(b, 0.27) + 0.003]);
      sp.box(acc, [0.055, 0.065, 0.008], [0.08, 0.38, frontZ(b, 0.38) - 0.002]);
      break;
    }
    case 'track':
      torso(sp, b, main);
      sleeves(kit, b, 'long', main, undefined, main);
      for (const s of [1, -1]) {
        const { up, lo } = armRings(b);
        stripe(kit(s > 0 ? BONE.armLUpper : BONE.armRUpper), up, b.arm, 0.003, s, acc, 0.016);
        stripe(kit(s > 0 ? BONE.armLLower : BONE.armRLower), lo, b.arm, 0.003, s, acc, 0.016);
      }
      sp.box(0x9a9ca0, [0.006, 0.46, 0.006], [0, 0.27, frontZ(b, 0.27) + 0.003]);
      sp.cyl(main, 0.075, 0.08, 0.05, [0, 0.535, 0], O, [1, 1, 0.95], { seg: 12 });
      break;
    case 'puffer':
      torso(sp, b, main);
      for (let i = 0; i < 5; i++) {
        const y = 0.06 + i * 0.105;
        const r = torsoR(b, y);
        sp.torus(main, r * b.bx, 0.032, [0, y, 0], [Math.PI / 2, 0, 0], [1, (0.62 * b.bz * r + 0.008) / (r * b.bx), 1], 5, 16);
      }
      sleeves(kit, b, 'puffy', main, undefined, shade(main, 0.7));
      sp.cyl(main, 0.085, 0.095, 0.07, [0, 0.54, 0], O, [1, 1, 0.95], { seg: 12 });
      sp.box(0x9a9ca0, [0.006, 0.48, 0.006], [0, 0.27, frontZ(b, 0.27) + 0.034]);
      break;
    case 'raincoat':
      torso(sp, b, main);
      shell(sp, b, main, 0.015, -0.16, 0.52, 0, undefined, 0.168);
      sleeves(kit, b, 'jacket', main, undefined, shade(main, 0.85));
      hood(sp, main);
      for (let i = 0; i < 4; i++) {
        const y = 0.02 + i * 0.13;
        sp.box(shade(main, 0.6), [0.02, 0.01, 0.008], [0, y, frontZ(b, Math.max(y, 0.02)) + 0.018]);
      }
      for (const s of [1, -1]) pocket(sp, b, main, s * 0.1 * b.bx, 0.06, 0.07, 0.06);
      break;
    case 'camo': {
      const gap = 0.5;
      const cam: Surface = { pattern: PATTERN.camo, accent: acc };
      torso(sp, b, 0x2b2d31);
      collarRing(sp, 0x2b2d31);
      shell(sp, b, main, 0.016, -0.02, 0.52, gap, cam);
      sleeves(kit, b, 'jacket', main, cam, shade(main, 0.75));
      lapels(sp, b, main, gap, cam, 0.85);
      for (const s of [1, -1]) pocket(sp, b, main, s * 0.115 * b.bx, 0.36, 0.06, 0.065);
      break;
    }
    case 'croptop':
      // Bare midriff under a short, fitted tee.
      torso(sp, b, b.skin);
      navel(sp, b);
      shell(sp, b, main, 0.004, 0.25, 0.52);
      shell(sp, b, shade(main, 0.85), 0.007, 0.25, 0.275);
      sleeves(kit, b, 'short', main);
      collarRing(sp, shade(main, 0.85));
      break;
    case 'cami':
      torso(sp, b, b.skin);
      shell(sp, b, main, 0.004, 0.0, 0.44);
      shell(sp, b, shade(main, 0.85), 0.006, 0.425, 0.445);
      straps(sp, b, main, 0.06, 0.008);
      sleeves(kit, b, 'none', main);
      break;
    case 'sportstop':
      // Racer-back sports top over a bare midriff, a contrast band under the bust.
      torso(sp, b, b.skin);
      navel(sp, b);
      shell(sp, b, main, 0.004, 0.27, 0.48);
      shell(sp, b, acc, 0.007, 0.265, 0.3);
      straps(sp, b, main, 0.07, 0.03, true);
      sleeves(kit, b, 'none', main);
      break;
    case 'blouse': {
      torso(sp, b, main);
      sleeves(kit, b, 'short', main);
      // Puffed shoulders, a soft ruffled collar and a little bow at the throat.
      for (const bone of [BONE.armLUpper, BONE.armRUpper]) kit(bone).ball(main, 0.074 * b.arm, [0, -0.035, 0], O, undefined, 10, 7);
      for (let i = 0; i < 14; i++) {
        const t = (i / 14) * TAU;
        sp.ico(shade(main, 1.08), 0.02, [Math.sin(t) * 0.075, 0.52 + (Math.cos(t) > 0 ? -0.005 : 0.005), Math.cos(t) * 0.07], [i, 0, 0], [1, 0.55, 1], 0);
      }
      const z = chestZ(b, 0, 0.475);
      for (const s of [1, -1]) sp.cone(shade(main, 0.8), 0.016, 0.026, [s * 0.014, 0.475, z + 0.008], [0, 0, s * Math.PI / 2], [1, 1, 0.5], 4);
      buttons(sp, b, shade(main, 1.25), 0.1, 0.43, 5);
      break;
    }
    case 'turtleneck': {
      const knit: Surface = { pattern: PATTERN.knit };
      torso(sp, b, main, knit);
      sleeves(kit, b, 'long', main, knit, shade(main, 0.88));
      sp.cyl(main, 0.066, 0.076, 0.085, [0, 0.556, 0.003], O, [1, 1, 0.94], { seg: 12 }, knit);
      shell(sp, b, shade(main, 0.88), 0.006, 0.0, 0.045, 0, knit);
      break;
    }
    case 'cardigan': {
      const gap = 0.62;
      const knit: Surface = { pattern: PATTERN.knit };
      torso(sp, b, acc);
      collarRing(sp, shade(acc, 0.9));
      shell(sp, b, main, 0.014, -0.02, 0.52, gap, knit);
      shell(sp, b, shade(main, 0.85), 0.018, -0.02, 0.03, gap, knit);
      sleeves(kit, b, 'jacket', main, knit, shade(main, 0.85));
      // Buttons down the right front edge.
      const ex = Math.sin(gap / 2 + 0.05) * 0.175 * b.bx;
      for (let i = 0; i < 5; i++) {
        const y = 0.05 + i * 0.085;
        sp.ball(0xe8e2d6, [0.008, 0.008, 0.004], [-ex, y, chestZ(b, -ex, y) + 0.016], O, undefined, 6, 4);
      }
      break;
    }
    case 'sundress': {
      // A floral dress: scoop neck on thick straps, fitted to the waist, and a flared skirt.
      const fl: Surface = { pattern: PATTERN.floral, accent: acc };
      torso(sp, b, b.skin);
      shell(sp, b, main, 0.004, -0.02, 0.45, 0, fl);
      straps(sp, b, main, 0.065, 0.02);
      sleeves(kit, b, 'none', main);
      shell(sp, b, shade(main, 0.8), 0.008, 0.1, 0.13, 0);
      skirt(kit(BONE.hips), b, main, 0.06, -0.33, 0.183, 0.275, fl);
      break;
    }
    case 'peacoat': {
      // A long, double-breasted wool coat, open into a V at the top over what's underneath.
      torso(sp, b, acc);
      collarRing(sp, shade(acc, 0.9));
      shell(sp, b, main, 0.018, -0.16, 0.33, 0, undefined, 0.17);
      shell(sp, b, main, 0.018, 0.33, 0.52, 0.8);
      sleeves(kit, b, 'jacket', main, undefined, shade(main, 0.8));
      lapels(sp, b, main, 0.8, undefined, 1.15);
      for (const x of [0.05, -0.05]) {
        for (const y of [0.08, 0.18, 0.28]) sp.ball(shade(main, 0.6), [0.009, 0.009, 0.004], [x * b.bx, y, chestZ(b, x * b.bx, y) + 0.022], O, undefined, 6, 4);
      }
      for (const s of [1, -1]) pocket(sp, b, main, s * 0.1 * b.bx, 0.0, 0.08, 0.012, false);
      break;
    }
    case 'shirtless':
      // Bare chested (men only, above), a hint of definition: the line under the chest and down the middle.
      torso(sp, b, b.skin);
      sleeves(kit, b, 'none', b.skin);
      navel(sp, b);
      for (const s of [1, -1]) {
        const x = s * 0.052 * b.bx, y = 0.37;
        sp.box(shade(b.skin, 0.9), [0.08 * b.bx, 0.005, 0.004], [x, y, torsoZ(b, x, y) - 0.002], [0, -s * 0.35, s * 0.14]);
      }
      sp.box(shade(b.skin, 0.92), [0.004, 0.17, 0.004], [0, 0.27, frontZ(b, 0.27) - 0.0015]);
      break;
    case 'bikini': {
      // A bikini top with full cups on a band under the bust, halter straps up over the shoulders.
      torso(sp, b, b.skin);
      navel(sp, b);
      const y0 = bustBottom(b) - 0.016, y1 = BUST.y + 0.05;
      shell(sp, b, main, 0.003, y0, y1);
      shell(sp, b, acc, 0.0055, y0, y0 + 0.014);
      shell(sp, b, acc, 0.0055, y1 - 0.009, y1 + 0.001);
      const cy = BUST.y - 0.01;
      sp.box(acc, [0.012, 0.036, 0.006], [0, cy, chestZ(b, 0, cy) + 0.006]);
      for (const s of [1, -1]) {
        const x = s * 0.06 * b.bx;
        frontStrap(sp, b, acc, x, y1 - 0.004, 0.522, 0.014, 0.004, 4);
        sp.box(acc, [0.014, 0.012, 0.27 * b.bz], [x, 0.522, 0]);
        sp.box(acc, [0.014, 0.12, 0.01], [x * 0.8, 0.462, -frontZ(b, 0.462) - 0.004], [0.06, 0, -s * 0.15]);
      }
      sleeves(kit, b, 'none', main);
      break;
    }
    case 'swimsuit': {
      // A one-piece: scoop neck, racer back. Its bottom half is the bikini bottoms, in its color
      // (see pants); over shorts, a skirt or jeans it tucks in at the waist.
      torso(sp, b, b.skin);
      shell(sp, b, main, 0.004, a.pants === 'bikinibottom' ? -0.035 : 0.02, 0.44);
      shell(sp, b, acc, 0.0065, 0.425, 0.445);
      straps(sp, b, main, 0.07, 0.03, true);
      sleeves(kit, b, 'none', main);
      break;
    }
    case 'rashguard':
      // A fitted long-sleeve swim shirt: contrast band across the chest, cuffs and collar, short zip.
      torso(sp, b, main);
      sleeves(kit, b, 'long', main, undefined, acc);
      shell(sp, b, acc, 0.004, 0.33, 0.37);
      collarRing(sp, acc);
      sp.box(shade(acc, 0.7), [0.008, 0.07, 0.004], [0, 0.49, chestZ(b, 0, 0.49) + 0.004]);
      break;
    default:
      torso(sp, b, main);
      sleeves(kit, b, 'short', main);
  }
}

function navel(sp: Kit, b: Body): void {
  sp.ball(shade(b.skin, 0.7), [0.006, 0.008, 0.003], [0, 0.13, chestZ(b, 0, 0.13) - 0.001], O, undefined, 6, 4);
}

/** Shoulder straps (camisoles, dresses): front of the chest, over the shoulder, down the back. */
function straps(sp: Kit, b: Body, hex: number, x: number, w: number, racer = false): void {
  for (const s of [1, -1]) {
    const sx = s * x * b.bx;
    const top = 0.522;
    if (b.female) frontStrap(sp, b, hex, sx, 0.43, top, w, 0.003, 3);
    else sp.box(hex, [w, top - 0.43, 0.01], [sx, (top + 0.43) / 2, frontZ(b, 0.47) + 0.002], [-0.08, 0, 0]);
    sp.box(hex, [w, 0.012, 0.27 * b.bz], [sx, top, 0]);
    if (racer) sp.box(hex, [w, 0.22, 0.012], [s * 0.03, 0.4, -frontZ(b, 0.4) - 0.002], [0.08, 0, -s * 0.35]);
    else sp.box(hex, [w, 0.14, 0.012], [sx, 0.455, -frontZ(b, 0.455) - 0.002], [0.08, 0, 0]);
  }
}

/**
 * A strap across the chest from the top of one shoulder down to the other side at height `y0`
 * (`tilt` from vertical), following the chest's shape, then over the shoulder to the back.
 */
function chestSash(sp: Kit, b: Body, hex: number, tilt: number, w: number, out: number, y0 = 0.04, thick = 0.012): void {
  const top = 0.515, len = (top - y0) / Math.cos(tilt);
  const at = (i: number) => {
    const t = (1 - i / 8) * len;
    const x = -Math.sin(tilt) * (t - len / 2), y = y0 + Math.cos(tilt) * t;
    return new THREE.Vector3(x, y, chestZ(b, x, y) + out);
  };
  for (let i = 0; i < 8; i++) {
    const p0 = at(i), p1 = at(i + 1);
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    sp.putAlong(new THREE.BoxGeometry(w, p0.distanceTo(p1) + 0.008, thick), hex, [mid.x, mid.y, mid.z], p1.clone().sub(p0));
  }
  const x = at(0).x;
  sp.box(hex, [w, 0.012, 0.27 * b.bz + out * 2], [x, top + 0.008 + out * 0.5, -0.005]);
}

/** A skirt from the hips (hip-space y0 down to y1), flaring from radius r0 to r1. */
function skirt(hp: Kit, b: Body, hex: number, y0: number, y1: number, r0: number, r1: number, surf?: Surface, seg = 16): void {
  const bp = pelvisK(b) * (b.female ? 1.03 : 1);
  // Open at the hem and lined, so it reads from below too.
  if (!b.female) {
    hp.tube(hex, r0, r1, y0 - y1, [0, (y0 + y1) / 2, 0], O, [bp, 1, 0.8 * bp], seg, surf);
    return;
  }
  // A woman's skirt hangs clear of her hips and glutes whatever their shape (`ease` at least).
  const ease = 0.008, n = Math.max(6, Math.round((y0 - y1) / 0.03));
  const ys = Array.from({ length: n + 1 }, (_, i) => y1 + ((y0 - y1) * i) / n);
  const ringOf = (y: number) => {
    const r = (r0 + ((r1 - r0) * (y0 - y)) / (y0 - y1)) * bp;
    const p = y > -0.135 ? pelvisR(b, y) : 0;
    return { ax: Math.max(r, p + ease), az: Math.max(0.8 * r, PELVIS_DEPTH * p + ease) };
  };
  const zOf = (x: number, y: number, z: number) => {
    if (z >= 0 || y <= -0.135) return z;
    const ax = pelvisR(b, y), az = PELVIS_DEPTH * ax;
    if (Math.abs(x) >= ax) return z;
    const back = -az * Math.sqrt(1 - (x / ax) ** 2) - seatBump(b, x, y);
    return Math.min(z, back - ease);
  };
  hp.put(sculpt(ys, 0, false, seg, ringOf, zOf, true), hex, O, O, 1, surf);
  hp.put(sculpt(ys, 0, false, seg, ringOf, zOf, true), shade(hex, 0.7), O, O, [-0.985, 1, 0.985], surf);
}

/**
 * Trouser legs over bare ones: `ease` looser all round, half the muscle showing through, and
 * below the knee hanging straight (or tapering, or flaring) toward a `hem` (null: skin tight).
 */
function trouserRings(thigh: readonly Ring[], shin: readonly Ring[], ease: number, hem: number | null): { up: Ring[]; lo: Ring[] } {
  const up = thigh.map(([y, r, z = 0, f]): Ring => [y, r + ease, z * 0.5, f]);
  const knee = up[up.length - 1][1];
  const lo = shin.map(([y, r, z = 0, f]): Ring => {
    if (hem === null) return [y, r + ease, z * 0.5, f];
    const t = -y / LEG.lower;
    return [y, Math.max(r + ease * 0.6, knee + (hem - knee) * t), z * 0.35, f];
  });
  return { up, lo };
}

/** What covers the shins (for boots to fit over): rings and their scale. */
interface Shins {
  rings: readonly Ring[];
  k: number;
}

function pants(hp: Kit, sp: Kit, kit: (bone: number) => Kit, a: Appearance, b: Body): Shins {
  // Bikini bottoms under a one-piece are the swimsuit's own bottom half, in its color.
  const suit = a.top === 'swimsuit' && a.pants === 'bikinibottom';
  const hex = paletteColor('cloth', suit ? a.topColor : a.pantsColor);
  const bp = pelvisK(b);
  const F = b.female;
  let surf: Surface | undefined;
  if (a.pants === 'jeans' || a.pants === 'overalls' || a.pants === 'flares' || a.pants === 'denimshorts') surf = { pattern: PATTERN.denim };
  if (a.pants === 'camo') surf = { pattern: PATTERN.camo, accent: mixHex(hex, 0x9a8a62, 0.55) };
  if (a.pants === 'plaidskirt') surf = { pattern: PATTERN.plaid, accent: mixHex(hex, 0x101010, 0.62) };
  const skirted = a.pants === 'skirt' || a.pants === 'plaidskirt';
  const swim = a.pants === 'swimtrunks' || a.pants === 'boardshorts' || a.pants === 'bikinibottom';
  // Bare legs (shorts, skirts, swimwear) or tights under the plaid skirt.
  const bare = a.pants === 'shorts' || a.pants === 'denimshorts' || a.pants === 'skirt' || swim;
  const legHex = a.pants === 'plaidskirt' ? 0x1f1d22 : b.skin;
  // Women's legs: fuller thighs, slimmer knees, calves and ankles; wider hips fill out the thigh tops.
  const body = F ? 'female' : 'male';
  const thighs = (rings: readonly Ring[]): readonly Ring[] => (!F || b.hipW === 1 ? rings
    : rings.map(([y, r, z, f]): Ring => [y, r * (1 + (b.hipW - 1) * 1.3 * THREE.MathUtils.clamp((y + 0.3) / 0.33, 0, 1)), z, f]));
  const skinUp = thighs(ringsFor(b, LEG_UP[body])), skinLo = ringsFor(b, LEG_LO[body]);
  const lk = b.leg;
  /** The pelvis from hip-space y0 up to y1 (women: shaped over the hips and glutes). */
  const pelvis = (c: number, y0: number, y1: number, s?: Surface, inf = 0) => {
    if (F) pelvisLayer(hp, b, c, inf, y0, y1, s);
    else hp.cyl(c, 0.17 - 0.02 * (0.1 - y1) / 0.2 + inf, 0.17 - 0.02 * (0.1 - y0) / 0.2 + inf, y1 - y0, [0, (y0 + y1) / 2, 0], O, [bp, 1, 0.7 * bp], { seg: 10 }, s);
  };
  const bottom = F ? -0.135 : -0.1;
  if (skirted) {
    if (F) pelvisLayer(hp, b, shade(hex, 0.45), -0.004, bottom, 0.1);
    else hp.cyl(shade(hex, 0.45), 0.16, 0.15, 0.2, [0, 0, 0], O, [bp, 1, 0.7 * bp], { seg: 10 });
    // Under a dress only the dress's own skirt shows (this one would poke out at the waist).
    if (a.top !== 'sundress') {
      skirt(hp, b, hex, 0.1, -0.24, 0.172, a.pants === 'plaidskirt' ? 0.25 : 0.235, surf, a.pants === 'plaidskirt' ? 20 : 16);
      hp.cyl(shade(hex, 0.8), 0.174 * bp * (F ? 1.03 : 1), 0.174 * bp * (F ? 1.03 : 1), 0.03, [0, 0.085, 0], O, [1, 1, 0.8], { seg: 16 }, surf);
    }
  } else if (a.pants === 'bikinibottom') {
    // Full-coverage briefs, skin above them to the waist, a trim band along the top (all one
    // piece up to the waist under a swimsuit).
    if (suit) pelvis(hex, bottom, 0.1);
    else {
      pelvis(hex, bottom, 0.05);
      pelvis(b.skin, 0.05, 0.1);
      pelvis(shade(hex, 0.78), 0.036, 0.054, undefined, 0.003);
    }
  } else if (F) {
    pelvisLayer(hp, b, hex, 0, bottom, 0.1, surf);
  } else {
    hp.cyl(hex, 0.17, 0.15, 0.2, [0, 0, 0], O, [bp, 1, 0.7 * bp], { seg: 10 }, surf);
  }
  if (a.pants === 'swimtrunks' || a.pants === 'boardshorts') {
    // An elastic or laced waistband, drawstring ends hanging at the front.
    pelvis(shade(hex, 0.82), 0.07, 0.098, undefined, 0.004);
    const z = (F ? PELVIS_DEPTH * pelvisR(b, 0.075) : 0.7 * bp * 0.168) + 0.006;
    for (const x of [0.012, -0.012]) hp.box(0xeeeae0, [0.006, 0.05, 0.004], [x, 0.055, z], [0, 0, x * 8]);
    if (a.pants === 'boardshorts') hp.box(shade(hex, 0.6), [0.012, 0.06, 0.004], [0, 0.03, z - 0.002]);
  }
  const jog = a.pants === 'joggers';
  const tight = a.pants === 'leggings';
  const hem = a.pants === 'flares' ? 0.078 : jog ? 0.047 : tight ? null : F ? 0.053 : 0.056;
  const legs = bare || skirted ? { up: skinUp, lo: skinLo } : trouserRings(skinUp, skinLo, tight ? 0.003 : F ? 0.007 : 0.008, hem);
  const legColor = bare || skirted ? legHex : hex;
  const legSurf = bare || skirted ? undefined : surf;
  for (const s of [1, -1]) {
    const ub = s > 0 ? BONE.legLUpper : BONE.legRUpper, lb = ub + 1;
    const up = kit(ub), lo = kit(lb);
    // Thigh and shin bend together at the knee (see sleeves), a ball there for a deep crouch.
    up.lathe(legColor, legs.up, lk, 0, b.seg, { top: true }, legSurf, { bone: lb, y: -LEG.upper, band: BEND });
    lo.lathe(legColor, legs.lo, lk, 0, b.seg, { bottom: true }, legSurf, { bone: ub, y: 0, band: BEND });
    lo.ball(legColor, legs.lo[0][1] * lk * jointK(b), [0, 0, 0], O, legSurf, b.seg, b.zombie ? 3 : 5);
    if (a.pants === 'shorts') {
      up.lathe(hex, over(skinUp, [0.03, -0.08, -0.18, -0.27], 0.013), lk, 0, b.seg, { top: true, bottom: true }, surf);
      if (a.shoes !== 'flipflops') lo.lathe(0xdcdad4, over(skinLo, [-0.33, -0.39, -0.44], 0.005), lk, 0, b.seg, { top: true, bottom: true });
    } else if (a.pants === 'denimshorts') {
      up.lathe(hex, over(skinUp, [0.03, -0.05, -0.105], 0.008), lk, 0, b.seg, { top: true, bottom: true }, surf);
      up.lathe(mixHex(hex, 0xf2efe8, 0.55), over(skinUp, [-0.1, -0.116], 0.0095), lk, 0, b.seg, { top: true, bottom: true });
    } else if (a.pants === 'bikinibottom') {
      // The briefs' leg openings, level all round just below the hip.
      up.lathe(hex, over(skinUp, [0.03, -0.03, -0.072], 0.0035), lk, 0, b.seg, { top: true, bottom: true });
      if (!suit) up.lathe(shade(hex, 0.78), over(skinUp, [-0.064, -0.074], 0.005), lk, 0, b.seg, { top: true, bottom: true });
    } else if (a.pants === 'swimtrunks') {
      // Short, loose swim trunks.
      up.lathe(hex, over(skinUp, [0.03, -0.06, -0.15], 0.014), lk, 0, b.seg, { top: true, bottom: true });
      up.lathe(shade(hex, 0.82), over(skinUp, [-0.142, -0.156], 0.0155), lk, 0, b.seg, { top: true, bottom: true });
    } else if (a.pants === 'boardshorts') {
      // Long board shorts to just above the knee, a contrast stripe down the outside.
      up.lathe(hex, over(skinUp, [0.03, -0.1, -0.22, -0.32], 0.017), lk, 0, b.seg, { top: true, bottom: true });
      const stripe = mixHex(hex, 0xf4f1ea, 0.65), ys = [0.0, -0.08, -0.16, -0.24, -0.31];
      const at = (y: number) => new THREE.Vector3(s * (ringAt(skinUp, y).r + 0.017) * lk + s * 0.001, y, 0);
      for (let i = 0; i + 1 < ys.length; i++) {
        const p0 = at(ys[i]), p1 = at(ys[i + 1]), mid = p0.clone().add(p1).multiplyScalar(0.5);
        up.putAlong(new THREE.BoxGeometry(0.006, p0.distanceTo(p1) + 0.004, 0.026), stripe, [mid.x, mid.y, mid.z], p1.clone().sub(p0));
      }
    } else if (jog) {
      lo.lathe(shade(hex, 0.8), over(legs.lo, [-0.395, -0.445], 0.003), lk, 0, b.seg, { top: true, bottom: true }, { pattern: PATTERN.knit });
    }
    if (a.pants === 'cargo' || a.pants === 'shorts' || a.pants === 'camo') {
      const out = (ringAt(a.pants === 'shorts' ? over(skinUp, [-0.25], 0.013) : legs.up, -0.25).r - 0.068) * lk;
      up.box(shade(hex, 0.92), [0.024, 0.09, 0.075], [s * (0.078 + out), -0.25, 0], O, surf);
      up.box(shade(hex, 0.82), [0.028, 0.02, 0.079], [s * (0.079 + out), -0.205, 0], O, surf);
    }
    if (a.pants === 'work') {
      lo.box(shade(hex, 0.78), [0.075, 0.09, 0.02], [0, -0.04, ringAt(legs.lo, -0.04).r * lk - 0.004]);
      up.box(shade(hex, 0.85), [0.02, 0.12, 0.012], [s * 0.04, -0.22, -Math.sqrt(Math.max(0, (ringAt(legs.up, -0.22).r * lk) ** 2 - 0.04 ** 2))]);
    }
  }
  const belt = (F ? 0.176 : 0.172) * bp;
  // A dress covers the waistband.
  const dress = a.top === 'sundress';
  if (!dress && (a.pants === 'jeans' || a.pants === 'work' || a.pants === 'cargo' || a.pants === 'flares' || a.pants === 'denimshorts')) {
    hp.cyl(0x2a1d14, belt, belt, 0.032, [0, 0.082, 0], O, [1, 1, 0.71], { seg: 12 });
    hp.box(0xb8a46a, [0.035, 0.026, 0.008], [0, 0.082, (F ? 0.127 : 0.124) * bp]);
  }
  if (!dress && (a.pants === 'joggers' || a.pants === 'leggings')) hp.cyl(shade(hex, 0.8), belt, belt, 0.035, [0, 0.082, 0], O, [1, 1, 0.71], { seg: 12 }, { pattern: PATTERN.knit });
  if (a.pants === 'overalls') {
    const y0 = 0.02, y1 = 0.3;
    if (F) {
      // Leaning out from the belly to clear the bust at its top edge.
      const zb = frontZ(b, y0 + 0.04) + 0.008, zt = Math.max(frontZ(b, 0.16), chestMax(b, y1, 0.1 * b.bx)) - 0.004;
      sp.box(hex, [0.21 * b.bx, Math.hypot(y1 - y0, zt - zb), 0.02], [0, (y0 + y1) / 2, (zb + zt) / 2], [Math.atan2(zt - zb, y1 - y0), 0, 0], surf);
    }
    else sp.box(hex, [0.22 * b.bx, y1 - y0, 0.02], [0, (y0 + y1) / 2, frontZ(b, 0.16) - 0.002], [0.05, 0, 0], surf);
    for (const s of [1, -1]) {
      const x = s * 0.075 * b.bx;
      if (F) frontStrap(sp, b, hex, x, 0.3, 0.522, 0.032, 0.003, 5);
      else sp.box(hex, [0.032, 0.22, 0.012], [x, 0.41, frontZ(b, 0.41) + 0.003], [-0.1, 0, 0], surf);
      sp.box(hex, [0.032, 0.012, 0.27 * b.bz], [x, 0.522, 0], O, surf);
      sp.box(hex, [0.032, 0.4, 0.012], [x * 0.8, 0.32, -frontZ(b, 0.32) - 0.003], [0.08, 0, -s * 0.12], surf);
      sp.box(0xc9a233, [0.018, 0.018, 0.008], [x, 0.3, (F ? chestZ(b, x, 0.3) : frontZ(b, 0.3)) + 0.012]);
    }
  }
  return { rings: legs.lo, k: lk };
}

function shoes(kit: (bone: number) => Kit, a: Appearance, b: Body, shin: Shins): void {
  const hex = paletteColor('cloth', a.shoesColor);
  const sole = a.shoes === 'sneakers' || a.shoes === 'hightops' ? 0xe6e3dc : 0x1a1816;
  /** A boot shaft's radius over shin heights y0..y1: at least `r`, and clear of the calf or trousers inside. */
  const fit = (r: number, y0: number, y1: number) => {
    let m = r;
    for (let i = 0; i <= 4; i++) {
      const q = ringAt(shin.rings, y0 + ((y1 - y0) * i) / 4);
      m = Math.max(m, (q.r + Math.abs(q.z)) * shin.k + 0.004);
    }
    return m;
  };
  for (const s of [1, -1]) {
    const lo = kit(s > 0 ? BONE.legLLower : BONE.legRLower);
    switch (a.shoes) {
      case 'sneakers':
        lo.box(hex, [0.1, 0.07, 0.23], [0, -0.47, 0.05]);
        lo.box(sole, [0.106, 0.026, 0.245], [0, -0.507, 0.052]);
        lo.box(0xeeeae0, [0.05, 0.008, 0.09], [0, -0.434, 0.085]);
        break;
      case 'hightops':
        lo.box(hex, [0.1, 0.075, 0.23], [0, -0.47, 0.05]);
        { const r = fit(0.062, -0.36, -0.44); lo.cyl(hex, r, r + 0.002, 0.11, [0, -0.415, 0], O, 1, { seg: 8 }); }
        lo.box(sole, [0.106, 0.028, 0.245], [0, -0.508, 0.052]);
        lo.ball(0xeeeae0, [0.002, 0.022, 0.022], [s * 0.052, -0.43, 0.0], O, undefined, 6, 4);
        break;
      case 'combat':
        lo.box(hex, [0.104, 0.08, 0.24], [0, -0.47, 0.05]);
        {
          const r = fit(0.064, -0.29, -0.44);
          lo.cyl(hex, r, r + 0.002, 0.17, [0, -0.375, 0], O, 1, { seg: 8 });
          for (let i = 0; i < 4; i++) lo.box(0x0d0d0d, [0.05, 0.006, 0.006], [0, -0.33 - i * 0.03, r]);
        }
        lo.box(sole, [0.11, 0.03, 0.252], [0, -0.51, 0.052]);
        break;
      case 'work':
        lo.box(hex, [0.108, 0.085, 0.24], [0, -0.468, 0.05]);
        { const r = fit(0.064, -0.35, -0.44); lo.cyl(hex, r, r + 0.002, 0.11, [0, -0.405, 0], O, 1, { seg: 8 }); }
        lo.box(shade(hex, 0.7), [0.1, 0.05, 0.06], [0, -0.475, 0.145]);
        lo.box(0x3a2a1e, [0.114, 0.036, 0.255], [0, -0.51, 0.052]);
        break;
      case 'rain':
        lo.box(hex, [0.106, 0.08, 0.24], [0, -0.47, 0.05]);
        { const r = fit(0.072, -0.17, -0.44); lo.cyl(hex, r, r - 0.003, 0.3, [0, -0.32, 0], O, 1, { seg: 10 }); }
        lo.box(shade(hex, 0.6), [0.11, 0.025, 0.25], [0, -0.508, 0.052]);
        break;
      case 'kneeboots':
        // Tall, fitted boots up to just under the knee, on a low block heel.
        lo.box(hex, [0.094, 0.07, 0.225], [0, -0.472, 0.052]);
        {
          const rt = fit(0.068, -0.07, -0.2), rb = fit(0.06, -0.3, -0.44);
          lo.cyl(hex, rt, rb, 0.4, [0, -0.27, 0], O, 1, { seg: 10 });
          lo.cyl(shade(hex, 0.8), rt + 0.003, rt + 0.003, 0.025, [0, -0.08, 0], O, 1, { seg: 10 });
          lo.box(0x9a9ca0, [0.006, 0.3, 0.006], [s * (rt + (rb - rt) * 0.55 - 0.004), -0.29, -0.02]);
        }
        lo.box(0x141210, [0.098, 0.016, 0.16], [0, -0.511, 0.085]);
        lo.box(0x141210, [0.07, 0.03, 0.05], [0, -0.503, -0.035]);
        break;
      case 'heeledboots':
        // Ankle boots with a pointed toe and a heel.
        lo.box(hex, [0.09, 0.07, 0.2], [0, -0.468, 0.035]);
        lo.box(hex, [0.068, 0.05, 0.06], [0, -0.478, 0.155]);
        lo.cyl(hex, fit(0.062, -0.335, -0.4), fit(0.058, -0.4, -0.44), 0.13, [0, -0.4, 0], O, 1, { seg: 8 });
        lo.box(0x141210, [0.092, 0.012, 0.15], [0, -0.508, 0.09]);
        lo.cyl(0x141210, 0.02, 0.016, 0.05, [0, -0.49, -0.04], O, [1.2, 1, 1], { seg: 6 });
        break;
      case 'flats':
        // Low shoes showing the top of the foot.
        lo.box(b.skin, [0.084, 0.05, 0.16], [0, -0.465, 0.03]);
        lo.box(hex, [0.092, 0.036, 0.232], [0, -0.49, 0.052]);
        lo.box(hex, [0.088, 0.02, 0.06], [0, -0.467, 0.14]);
        lo.box(shade(hex, 0.6), [0.094, 0.01, 0.236], [0, -0.511, 0.052]);
        lo.box(shade(hex, 1.3), [0.03, 0.008, 0.012], [0, -0.47, 0.115]);
        break;
      case 'flipflops': {
        // Bare feet on a thin sole, a thong strap from between the toes over each side of the foot.
        lo.box(b.skin, [0.082, 0.05, 0.19], [0, -0.474, 0.035]);
        lo.ball(b.skin, [0.043, 0.024, 0.05], [0, -0.478, 0.125], O, undefined, 8, 5);
        lo.box(hex, [0.098, 0.014, 0.245], [0, -0.505, 0.05]);
        lo.box(shade(hex, 0.6), [0.1, 0.006, 0.247], [0, -0.514, 0.05]);
        const post = new THREE.Vector3(-s * 0.012, -0.452, 0.13);
        for (const side of [1, -1]) {
          const pts = [post, new THREE.Vector3(side * 0.036, -0.447, 0.07), new THREE.Vector3(side * 0.045, -0.496, 0.05)];
          for (let i = 0; i + 1 < pts.length; i++) {
            const d = pts[i + 1].clone().sub(pts[i]), mid = pts[i].clone().add(pts[i + 1]).multiplyScalar(0.5);
            lo.putAlong(new THREE.BoxGeometry(0.016, d.length() + 0.004, 0.006), hex, [mid.x, mid.y, mid.z], d);
          }
        }
        break;
      }
      case 'platforms':
        lo.box(hex, [0.1, 0.06, 0.22], [0, -0.445, 0.05]);
        lo.box(0xeeeae0, [0.108, 0.058, 0.245], [0, -0.497, 0.052]);
        lo.box(shade(0xeeeae0, 0.8), [0.11, 0.008, 0.248], [0, -0.505, 0.052]);
        lo.box(0xeeeae0, [0.05, 0.008, 0.09], [0, -0.413, 0.085]);
        break;
      default:
        lo.box(hex, [0.1, 0.08, 0.24], [0, -0.48, 0.05]);
    }
  }
}

/** Hands, bare or gloved: the same hand (see hand), the glove a little fuller, with a cuff at the wrist. */
function gloves(kit: (bone: number) => Kit, a: Appearance, b: Body): void {
  const hex = paletteColor('cloth', a.glovesColor);
  const wrist = ringAt(ARM_LO, -ARM.lower).r * b.arm;
  for (const s of [1, -1]) {
    const lo = kit(s > 0 ? BONE.armLLower : BONE.armRLower);
    switch (b.zombie ? 'none' : a.gloves) {
      case 'work':
        hand(lo, s, b, hex, hex, 0.004);
        lo.cyl(shade(hex, 0.8), wrist + 0.011, wrist + 0.009, 0.045, [0, -ARM.lower + 0.006, 0], O, 1, { seg: 8 });
        break;
      case 'fingerless':
        hand(lo, s, b, hex, b.skin, 0.002);
        lo.cyl(hex, wrist + 0.005, wrist + 0.005, 0.02, [0, -ARM.lower + 0.004, 0], O, 1, { seg: 8 });
        break;
      case 'leather':
        hand(lo, s, b, hex, hex, 0.0025);
        lo.cyl(hex, wrist + 0.007, wrist + 0.006, 0.03, [0, -ARM.lower + 0.006, 0], O, 1, { seg: 8 });
        break;
      case 'latex':
        hand(lo, s, b, hex, hex, 0.0012);
        break;
      default:
        hand(lo, s, b, b.skin, b.skin, 0);
    }
  }
}

// ── Accessories ─────────────────────────────────────────────────────────────────────────

function temples(h: Kit, hex: number, y = 0.14): void {
  for (const s of [1, -1]) h.box(hex, [0.004, 0.005, 0.12], [s * 0.112, y, 0.07], [0, s * -0.08, 0]);
}

function faceGear(h: Kit, a: Appearance, b: Body, hex: number): void {
  if (b.zombie && a.face !== 'surgical') return;
  switch (a.face) {
    case 'glasses':
      for (const s of [1, -1]) h.torus(hex, 0.0215, 0.0028, [s * 0.042, EYE_Y + 0.001, 0.134], [0, 0, Math.PI / 4], [1.2, 0.82, 1], 4, 4);
      h.box(hex, [0.022, 0.004, 0.004], [0, EYE_Y + 0.008, 0.136]);
      temples(h, hex);
      break;
    case 'round':
      for (const s of [1, -1]) h.torus(hex, 0.019, 0.0025, [s * 0.041, EYE_Y, 0.134], O, 1, 4, 14);
      h.torus(hex, 0.012, 0.0022, [0, EYE_Y + 0.004, 0.136], O, 1, 3, 8, Math.PI);
      temples(h, hex);
      break;
    case 'sunglasses':
      for (const s of [1, -1]) h.box(0x0c0e11, [0.044, 0.026, 0.006], [s * 0.042, EYE_Y - 0.002, 0.133], [0, s * 0.12, 0]);
      h.box(hex, [0.13, 0.008, 0.009], [0, EYE_Y + 0.013, 0.134]);
      temples(h, hex, EYE_Y + 0.01);
      break;
    case 'aviators':
      for (const s of [1, -1]) {
        h.ball(0x2c2418, [0.023, 0.02, 0.004], [s * 0.041, EYE_Y - 0.004, 0.133], [0, s * 0.12, s * -0.2], undefined, 12, 6);
        h.torus(0xc9a233, 0.022, 0.0018, [s * 0.041, EYE_Y - 0.004, 0.134], [0, s * 0.12, s * -0.2], [1.05, 0.95, 1], 3, 14);
      }
      h.box(0xc9a233, [0.03, 0.003, 0.003], [0, EYE_Y + 0.011, 0.136]);
      temples(h, 0xc9a233, EYE_Y + 0.008);
      break;
    case 'goggles':
      h.cyl(0x18191b, 0.142, 0.142, 0.028, [0, EYE_Y + 0.004, -0.004], O, [0.935, 1, 1.0], { seg: 20, open: true });
      h.front(hex, [0.13, 0.03, 0.142], Math.PI / 2 - 0.6, 1.2, 1.9, [0, EYE_Y + 0.004, 0], O, undefined, 14, 3);
      h.front(0xd07a2a, [0.134, 0.024, 0.146], Math.PI / 2 - 0.6, 1.2, 1.6, [0, EYE_Y + 0.004, 0], O, undefined, 12, 3);
      break;
    case 'eyepatch':
      h.ball(0x0d0d0e, [0.024, 0.021, 0.007], [-0.042, EYE_Y, 0.127], [0, -0.2, 0], undefined, 10, 6);
      h.torus(0x0d0d0e, 0.133, 0.0028, [0, 0.16, -0.004], [Math.PI / 2 - 0.05, 0.0, 0.5], [0.92, 1, 1.02], 3, 22);
      break;
    case 'bandanamask': {
      const fl: Surface = { pattern: PATTERN.floral, accent: 0xe8e2d6 };
      h.front(hex, [0.126, 0.15, 0.142], 1.62, 0.95, 2.9, [0, 0.12, 0], O, fl);
      h.cone(hex, 0.075, 0.085, [0, -0.015, 0.11], [Math.PI + 0.35, 0, 0], [1, 1, 0.35], 4, fl);
      break;
    }
    case 'surgical':
      h.front(0xa9cfe0, [0.124, 0.148, 0.139], 1.7, 0.75, 2.3, [0, 0.12, 0], O, { pattern: PATTERN.stripes, accent: 0x9bc2d4 });
      for (const s of [1, -1]) h.torus(0xe8ecee, 0.028, 0.0018, [s * 0.112, 0.1, 0.0], [0, Math.PI / 2, 0], 1, 3, 10);
      break;
    case 'gasmask':
      h.front(0x23262a, [0.128, 0.152, 0.145], 1.2, 1.38, 2.6, [0, 0.12, 0]);
      for (const s of [1, -1]) {
        h.cyl(0x2c3a40, 0.022, 0.022, 0.012, [s * 0.043, EYE_Y, 0.137], [Math.PI / 2, 0, 0], 1, { seg: 12 });
        h.torus(0x15171a, 0.023, 0.004, [s * 0.043, EYE_Y, 0.143], O, 1, 4, 12);
      }
      h.cyl(0x55603a, 0.034, 0.03, 0.055, [0, 0.048, 0.165], [Math.PI / 2 + 0.35, 0, 0], 1, { seg: 12 });
      h.cyl(0x15171a, 0.024, 0.024, 0.02, [0, 0.055, 0.14], [Math.PI / 2 + 0.35, 0, 0], 1, { seg: 10 });
      h.torus(0x15171a, 0.135, 0.006, [0, 0.15, -0.01], [Math.PI / 2, 0, 0], [0.92, 1, 1], 3, 20);
      break;
    case 'hockey':
      h.front(0xe8e4da, [0.129, 0.152, 0.142], 0.8, 1.85, 2.3, [0, 0.12, 0]);
      for (const s of [1, -1]) {
        h.ball(0x0d0d0e, [0.017, 0.012, 0.004], [s * 0.042, EYE_Y, 0.1335], [0, s * 0.3, 0], undefined, 8, 4);
        for (const [dy, dz] of [[0.035, 0.1], [0.06, 0.085]] as const) h.box(0xb01e2a, [0.018, 0.005, 0.004], [s * 0.05, EYE_Y + dy, dz + 0.035], [0, s * 0.3, s * 0.6]);
      }
      for (let i = 0; i < 6; i++) h.ball(0x0d0d0e, 0.0035, [(i % 3 - 1) * 0.018, 0.06 - Math.floor(i / 3) * 0.018, 0.141], O, undefined, 5, 3);
      break;
    case 'clown':
      h.ico(0xd21f1f, 0.022, [0, 0.1, 0.142], O, 1, 1);
      break;
    case 'cateye':
      // Frames sweeping up into points at the outer corners.
      for (const s of [1, -1]) {
        h.torus(hex, 0.021, 0.0034, [s * 0.042, EYE_Y + 0.001, 0.134], [0, 0, s * 0.12], [1.15, 0.8, 1], 4, 14);
        h.cone(hex, 0.007, 0.022, [s * 0.066, EYE_Y + 0.016, 0.131], [0, s * 0.3, -s * 1.0], [1, 1, 0.5], 3);
      }
      h.box(hex, [0.022, 0.004, 0.004], [0, EYE_Y + 0.008, 0.136]);
      temples(h, hex, EYE_Y + 0.01);
      break;
    case 'oversized':
      for (const s of [1, -1]) {
        h.ball(0x0c0e11, [0.03, 0.027, 0.005], [s * 0.044, EYE_Y - 0.004, 0.135], [0, s * 0.14, 0], undefined, 14, 6);
        h.torus(hex, 0.029, 0.003, [s * 0.044, EYE_Y - 0.004, 0.136], [0, s * 0.14, 0], [1.03, 0.93, 1], 4, 16);
      }
      h.box(hex, [0.02, 0.004, 0.004], [0, EYE_Y + 0.012, 0.138]);
      temples(h, hex, EYE_Y + 0.012);
      break;
    case 'heartglasses':
      // Heart-shaped lenses: two lobes over a point.
      for (const s of [1, -1]) {
        const lens = mixHex(hex, 0x000000, 0.35);
        for (const k of [1, -1]) h.ball(lens, [0.0125, 0.0125, 0.004], [s * 0.042 + k * 0.01, EYE_Y + 0.005, 0.134], O, undefined, 10, 6);
        h.put(new THREE.ConeGeometry(0.021, 0.028, 4), lens, [s * 0.042, EYE_Y - 0.012, 0.133], [Math.PI, Math.PI / 4, 0], [1, 1, 0.2]);
      }
      h.box(hex, [0.022, 0.004, 0.004], [0, EYE_Y + 0.009, 0.137]);
      temples(h, hex, EYE_Y + 0.01);
      break;
  }
}

// ── Smokes ──────────────────────────────────────────────────────────────────────────────

export type SmokeKind = 'cigarette' | 'joint' | 'blunt';

interface SmokeShape {
  /** Length from where it sits in the lips to the lit end; radius at the lips and at the lit end. */
  len: number;
  r0: number;
  r1: number;
  /** How far it droops from straight out (radians), and how far it turns out past the mouth's corner. */
  droop: number;
  yaw: number;
}

const SMOKES: Record<SmokeKind, SmokeShape> = {
  cigarette: { len: 0.074, r0: 0.0042, r1: 0.0042, droop: 0.3, yaw: 0.3 },
  // Rolled cone: thin at the crutch, fat where it burns.
  joint: { len: 0.07, r0: 0.0034, r1: 0.006, droop: 0.24, yaw: 0.26 },
  blunt: { len: 0.088, r0: 0.0063, r1: 0.0069, droop: 0.2, yaw: 0.22 },
};

/** Faces that cover the mouth: nothing to hold a smoke with. */
const COVERS_MOUTH = new Set(['bandanamask', 'surgical', 'gasmask', 'hockey']);
/** The lit end, glowing (Humanoid draws it, so it can flare on a drag). */
const EMBER_LEN = 0.005;
const CHAR = 0x3a3330;

/** Who holds a lit smoke in the mouth (living survivors whose mouth isn't covered), and which one. */
function smokeKind(a: Appearance, zombie: boolean): SmokeKind | null {
  if (zombie || a.smoke === 'none' || !(a.smoke in SMOKES)) return null;
  if (COVERS_MOUTH.has(a.face) || COVERS_FACE.has(a.headwear)) return null;
  return a.smoke as SmokeKind;
}

/** Head-space frame of the smoke: origin in the lips at the right corner of the mouth, +Z out along it. */
function smokeFrame(h: Kit, a: Appearance, s: SmokeShape): Kit {
  const lip = a.facialHair === 'beard' ? 0.013 : a.facialHair === 'goatee' || a.facialHair === 'stubble' ? 0.004 : 0;
  return h.at([-0.0135, 0.0615, 0.112 + lip], [s.droop, -s.yaw, 0]);
}

/** A section of the smoke from z0 to z1 out of the lips, radius ra to rb. */
function smokeSeg(f: Kit, hex: number, z0: number, z1: number, ra: number, rb: number, seg = 8): void {
  f.cyl(hex, rb, ra, z1 - z0, [0, 0, (z0 + z1) / 2], [Math.PI / 2, 0, 0], 1, { seg });
}

/** A cigarette, joint or blunt hanging from the corner of the mouth, up to its charred, lit end. */
function smokable(h: Kit, a: Appearance, b: Body): void {
  const kind = smokeKind(a, b.zombie);
  if (!kind) return;
  const s = SMOKES[kind];
  const f = smokeFrame(h, a, s);
  const r = (z: number) => s.r0 + (s.r1 - s.r0) * (z / s.len);
  const end = s.len - 0.003;
  switch (kind) {
    case 'cigarette':
      // Cork filter, a thin gold band, white paper.
      smokeSeg(f, 0xc4874c, 0, 0.026, s.r0, s.r0);
      smokeSeg(f, 0xd6bf72, 0.026, 0.0275, s.r0 * 1.02, s.r0 * 1.02);
      smokeSeg(f, 0xeeeae2, 0.0275, end, s.r0, s.r0);
      break;
    case 'joint':
      // A rolled card crutch, then papers twisting wider toward the lit end.
      smokeSeg(f, 0xd8c79f, 0, 0.011, s.r0 * 1.06, s.r0 * 1.06);
      smokeSeg(f, 0xf1ede0, 0.011, end, r(0.011), r(end));
      break;
    case 'blunt':
      // Wet, darker end at the lips; a tobacco-leaf wrap with its seam spiralling round.
      smokeSeg(f, 0x48301c, 0, 0.008, s.r0, r(0.008), 10);
      smokeSeg(f, 0x6a4527, 0.008, end, r(0.008), r(end), 10);
      for (const z of [0.024, 0.042, 0.06, 0.076]) f.torus(0x50331d, r(z) + 0.0002, 0.0008, [0, 0, z], [0.5, 0, 0], 1, 3, 12);
      break;
  }
  smokeSeg(f, CHAR, end, s.len, r(end) * 1.02, r(s.len) * 1.02);
}

/** Where a survivor's smoke burns, in head-bone space as drawn (HEAD_K and the jawline applied). */
export interface SmokeRig {
  kind: SmokeKind;
  /** The glowing end. */
  ember: THREE.BufferGeometry;
  /** Tip of the lit end, and the way the smoke points. */
  tip: THREE.Vector3;
  dir: THREE.Vector3;
  /** Where breath leaves the mouth. */
  mouth: THREE.Vector3;
}

/** The lit end of the smoke an appearance holds (null: none, or a mask over the mouth). */
export function smokeRig(a: Appearance): SmokeRig | null {
  const kind = smokeKind(a, false);
  if (!kind) return null;
  const s = SMOKES[kind];
  const parts: THREE.BufferGeometry[] = [];
  const capture: PartSink = (g) => { parts.push(g); };
  const f = smokeFrame(new Kit(headSink(capture), BONE.head), a, s);
  const r = s.r1 * 0.98;
  smokeSeg(f, 0, s.len, s.len + EMBER_LEN, r, r * 0.8);
  const tip = headWarp(new THREE.Vector3(0, 0, s.len + EMBER_LEN).applyMatrix4(f.frame));
  const dir = new THREE.Vector3(0, 0, 1).transformDirection(f.frame);
  const lip = a.facialHair === 'beard' ? 0.013 : 0;
  const mouth = headWarp(new THREE.Vector3(0.004, 0.062, 0.122 + lip));
  return { kind, ember: parts[0], tip, dir, mouth };
}

function neck(sp: Kit, a: Appearance, b: Body, hex: number): void {
  if (b.zombie && a.neck !== 'bandana' && a.neck !== 'scarf') return;
  const fz = frontZ(b, 0.5);
  switch (a.neck) {
    case 'scarf': {
      const knit: Surface = { pattern: PATTERN.knit };
      sp.torus(hex, 0.074, 0.03, [0, 0.565, 0.0], [Math.PI / 2, 0, 0], [1, 0.95, 1], 6, 14, TAU, knit);
      // Over a bust the ends hang further out and lean forward at the bottom.
      const lift = b.female ? chestZ(b, 0.05, 0.37) - fz + 0.004 : 0, lean = b.female ? -0.22 : 0;
      sp.box(hex, [0.06, 0.22, 0.024], [0.05, 0.42, fz + 0.02 + lift], [0.12 + lean, 0, 0.08], knit);
      sp.box(shade(hex, 0.9), [0.06, 0.16, 0.024], [0.0, 0.45, fz + 0.03 + lift * 0.6], [0.1 + lean, 0, -0.12], knit);
      break;
    }
    case 'bandana': {
      const fl: Surface = { pattern: PATTERN.floral, accent: 0xe8e2d6 };
      sp.torus(hex, 0.07, 0.015, [0, 0.56, 0.0], [Math.PI / 2, 0, 0], [1, 0.95, 1], 4, 12, TAU, fl);
      sp.cone(hex, 0.085, 0.09, [0, 0.49, fz - 0.005], [Math.PI - 0.25, 0, 0], [1, 1, 0.28], 4, fl);
      break;
    }
    case 'dogtags':
      sp.torus(0xa7abb0, 0.08, 0.0026, [0, 0.475, 0.072], [1.2, 0, 0], [1, 1, 1], 3, 18);
      sp.box(0xc0c4c9, [0.022, 0.034, 0.003], [0.004, 0.43, frontZ(b, 0.43) + 0.004], [-0.15, 0, 0.1]);
      sp.box(0xa7abb0, [0.022, 0.034, 0.003], [-0.006, 0.425, frontZ(b, 0.43) + 0.007], [-0.15, 0, -0.15]);
      break;
    case 'headphones':
      sp.torus(hex, 0.088, 0.011, [0, 0.565, 0.0], [-Math.PI / 2, 0, 0], [1, 0.95, 1], 4, 12, Math.PI);
      for (const s of [1, -1]) {
        sp.cyl(hex, 0.036, 0.036, 0.028, [s * 0.09, 0.56, 0.035], [0, 0, Math.PI / 2], 1, { seg: 12 });
        sp.cyl(0x18191b, 0.03, 0.03, 0.012, [s * 0.072, 0.56, 0.035], [0, 0, Math.PI / 2], 1, { seg: 12 });
      }
      break;
    case 'chain':
      sp.torus(0xd3a628, 0.08, 0.005, [0, 0.475, 0.075], [1.2, 0, 0], 1, 4, 20);
      sp.cyl(0xd3a628, 0.014, 0.014, 0.005, [0, 0.43, frontZ(b, 0.43) + 0.005], [Math.PI / 2 - 0.15, 0, 0], 1, { seg: 10 });
      break;
    case 'bowtie':
      for (const s of [1, -1]) sp.cone(hex, 0.022, 0.035, [s * 0.019, 0.535, 0.108], [0, 0, s * Math.PI / 2], [1, 1, 0.6], 4);
      sp.box(shade(hex, 0.8), [0.013, 0.017, 0.012], [0, 0.535, 0.113]);
      break;
    case 'pearls': {
      // A strand draped round the base of the neck and dipping at the front.
      const tilt = new THREE.Euler(1.2, 0, 0);
      for (let i = 0; i < 22; i++) {
        const t = (i / 22) * TAU;
        const p = new THREE.Vector3(Math.sin(t) * 0.082, Math.cos(t) * 0.082, 0).applyEuler(tilt);
        sp.ball(0xf1ebde, 0.0085, [p.x, 0.475 + p.y, 0.072 + p.z], O, undefined, 6, 4);
      }
      break;
    }
    case 'choker':
      sp.torus(hex, 0.056, 0.007, [0, 0.565, 0.004], [Math.PI / 2, 0, 0], [1, 0.95, 1], 4, 16);
      sp.ico(0xc8ccd2, 0.007, [0, 0.555, 0.06], O, 1, 0);
      break;
    case 'locket':
      sp.torus(0xd3a628, 0.078, 0.0022, [0, 0.475, 0.07], [1.2, 0, 0], 1, 3, 20);
      sp.cyl(0xd3a628, 0.013, 0.013, 0.006, [0, 0.44, chestZ(b, 0, 0.44) + 0.006], [Math.PI / 2 - 0.15, 0, 0], [1, 1, 1.2], { seg: 10 });
      break;
  }
}

/** Returns how far behind the back surface the gear reaches. */
function back(sp: Kit, a: Appearance, b: Body, hex: number): number {
  if (b.zombie && a.back !== 'backpack') return 0;
  const bz = frontZ(b, 0.3) + b.bulk;
  const strap = shade(hex, 0.55);
  const straps = (y0: number, w = 0.035) => {
    for (const s of [1, -1]) {
      const x = s * 0.095 * b.bx;
      if (b.female) frontStrap(sp, b, strap, x, 0.2, 0.52, w, b.bulk + 0.006);
      else sp.box(strap, [w, 0.32, 0.012], [x, 0.36, frontZ(b, 0.36) + b.bulk + 0.006], [-0.1, 0, 0]);
      sp.box(strap, [w, 0.012, 0.27 * b.bz + b.bulk * 2], [x, 0.524 + b.bulk * 0.5, -0.005]);
      sp.box(strap, [w, 0.12, 0.012], [x, y0, -bz - 0.012], [0.15, 0, 0]);
    }
  };
  /** A strap from one shoulder across the chest to the other hip (shoulder bags, quivers). */
  const sash = (hex: number, tilt: number, w = 0.04) => {
    if (b.female) chestSash(sp, b, hex, tilt, w, b.bulk + 0.008, 0.02);
    else sp.box(hex, [w, 0.62, 0.012], [0.0, 0.3, bz + 0.008], [0, 0, tilt]);
    sp.box(hex, [w, 0.62, 0.012], [0.0, 0.3, -bz - 0.008], [0, 0, -tilt]);
  };
  switch (a.back) {
    case 'backpack':
      sp.box(hex, [0.27, 0.34, 0.12], [0, 0.3, -bz - 0.065], [0.04, 0, 0]);
      sp.cyl(hex, 0.06, 0.06, 0.27, [0, 0.46, -bz - 0.065], [0, 0, Math.PI / 2], [1, 1, 1], { seg: 10 });
      sp.box(shade(hex, 0.85), [0.19, 0.13, 0.04], [0, 0.2, -bz - 0.14], [0.04, 0, 0]);
      sp.box(0x9a9ca0, [0.2, 0.006, 0.006], [0, 0.4, -bz - 0.128]);
      straps(0.47);
      return 0.13;
    case 'hiking':
      sp.box(hex, [0.3, 0.52, 0.16], [0, 0.32, -bz - 0.085], [0.05, 0, 0]);
      sp.box(shade(hex, 0.85), [0.22, 0.14, 0.05], [0, 0.2, -bz - 0.18], [0.05, 0, 0]);
      sp.cyl(0x9a8a62, 0.06, 0.06, 0.36, [0, 0.62, -bz - 0.1], [0, 0, Math.PI / 2], 1, { seg: 10 });
      for (const s of [1, -1]) sp.cyl(0x3d5a7e, 0.03, 0.03, 0.12, [s * 0.17, 0.12, -bz - 0.09], O, 1, { seg: 8 });
      straps(0.5);
      sp.cyl(strap, torsoR(b, 0.03) + 0.012 + b.bulk, torsoR(b, 0.03) + 0.012 + b.bulk, 0.04, [0, 0.03, 0], O, [b.bx, 1, 0.66 * b.bz], { seg: 14 });
      return 0.18;
    case 'messenger': {
      sp.box(hex, [0.27, 0.21, 0.075], [-0.07, 0.04, -bz - 0.02], [0, 0.35, 0]);
      sp.box(shade(hex, 0.85), [0.275, 0.1, 0.08], [-0.07, 0.11, -bz - 0.024], [0, 0.35, 0]);
      sash(strap, 0.62);
      return 0.02;
    }
    case 'katana': {
      const k = sp.at([0, 0.3, -bz - 0.035], [0, 0, 0.6]);
      k.box(hex, [0.036, 0.72, 0.026], [0, -0.04, 0]);
      k.box(0xc9a233, [0.04, 0.025, 0.03], [0, -0.39, 0]);
      k.cyl(0x18191b, 0.04, 0.04, 0.012, [0, 0.33, 0], O, [1, 1, 0.7], { seg: 10 });
      k.box(0x1b1b1d, [0.03, 0.22, 0.03], [0, 0.45, 0], O, { pattern: PATTERN.plaid, accent: 0x8e1f22 });
      k.box(0xc9a233, [0.034, 0.02, 0.034], [0, 0.56, 0]);
      if (b.female) sash(0x2a1d14, -0.6, 0.03);
      else sp.box(0x2a1d14, [0.03, 0.6, 0.012], [0.0, 0.29, bz + 0.008], [0, 0, -0.6]);
      return 0.06;
    }
    case 'guitar': {
      const g = sp.at([0.0, 0.2, -bz - 0.055], [0, 0, -0.55]);
      g.cyl(hex, 0.14, 0.14, 0.075, [0, -0.06, 0], [Math.PI / 2, 0, 0], [1, 1, 1], { seg: 16 });
      g.cyl(hex, 0.11, 0.11, 0.075, [0, 0.12, 0], [Math.PI / 2, 0, 0], [1, 1, 1], { seg: 16 });
      g.cyl(shade(hex, 0.6), 0.145, 0.145, 0.018, [0, -0.06, 0], [Math.PI / 2, 0, 0], 1, { seg: 16, open: true });
      g.box(0x5a3e2a, [0.045, 0.36, 0.024], [0, 0.38, 0.02]);
      g.box(0x2a1d14, [0.06, 0.09, 0.028], [0, 0.6, 0.02]);
      if (b.female) sash(0x18191b, 0.6, 0.035);
      else sp.box(0x18191b, [0.035, 0.62, 0.012], [0.0, 0.3, bz + 0.008], [0, 0, 0.6]);
      return 0.11;
    }
    case 'purse': {
      // A small bag worn across the body, hanging at the left hip in front.
      sash(strap, 0.62, 0.022);
      const x = 0.15 * b.bx, y = -0.07;
      const z = torsoZ(b, x, 0.02) + b.bulk + 0.04;
      const bag = sp.at([x, y, z], [0, 0.45, 0]);
      bag.box(hex, [0.17, 0.12, 0.05]);
      bag.box(shade(hex, 0.85), [0.172, 0.06, 0.054], [0, 0.032, 0.002]);
      bag.box(0xd3a628, [0.016, 0.012, 0.006], [0, 0.005, 0.03]);
      return 0;
    }
    case 'minipack':
      sp.box(hex, [0.2, 0.23, 0.09], [0, 0.34, -bz - 0.05], [0.04, 0, 0]);
      sp.cyl(hex, 0.045, 0.045, 0.2, [0, 0.455, -bz - 0.05], [0, 0, Math.PI / 2], [1, 1, 1], { seg: 10 });
      sp.box(shade(hex, 0.85), [0.14, 0.09, 0.03], [0, 0.27, -bz - 0.105], [0.04, 0, 0]);
      sp.box(0x9a9ca0, [0.15, 0.005, 0.005], [0, 0.43, -bz - 0.097]);
      straps(0.42, 0.024);
      return 0.1;
    case 'quiver': {
      // A leather quiver slung diagonally on the back, fletched arrows over the shoulder.
      const q = sp.at([0, 0.32, -bz - 0.05], [0.08, 0, -0.45]);
      q.cyl(hex, 0.05, 0.042, 0.52, [0, 0, 0], O, [1, 1, 0.8], { seg: 10 });
      q.cyl(shade(hex, 0.7), 0.053, 0.053, 0.03, [0, 0.25, 0], O, [1, 1, 0.8], { seg: 10 });
      q.cyl(shade(hex, 0.7), 0.046, 0.046, 0.03, [0, -0.24, 0], O, [1, 1, 0.8], { seg: 10 });
      const fletch = [0xb01e2a, 0xe8e2d6, 0x2b4f9e, 0xb01e2a, 0xe8e2d6];
      for (let i = 0; i < 5; i++) {
        const x = (i - 2) * 0.016, z = (i % 2 ? 0.012 : -0.01);
        q.cyl(0x8a6a44, 0.0035, 0.0035, 0.16, [x, 0.32, z], [0, 0, x * 2], 1, { seg: 4 });
        q.box(fletch[i], [0.004, 0.06, 0.022], [x + x * 0.32, 0.37, z], [0, 0.4 * i, x * 2]);
      }
      sash(0x2a1d14, -0.45, 0.03);
      return 0.11;
    }
  }
  return 0;
}

function gear(sp: Kit, hp: Kit, kit: (bone: number) => Kit, a: Appearance, b: Body, hex: number): void {
  if (b.zombie && a.gear !== 'hivis' && a.gear !== 'tactical') return;
  switch (a.gear) {
    case 'tactical': {
      const inf = Math.max(0.028, b.bulk + 0.014), out = inf - 0.028;
      shell(sp, b, hex, inf, 0.08, 0.5);
      for (const x of [-0.075, 0, 0.075]) sp.box(shade(hex, 0.85), [0.055, 0.1, 0.035], [x * b.bx, 0.18, frontZ(b, 0.18) + 0.045 + out]);
      const pz = b.female ? Math.max(frontZ(b, 0.38) + 0.04 + out, chestZ(b, 0.09 * b.bx, 0.38) + inf + 0.016) : frontZ(b, 0.38) + 0.04 + out;
      sp.box(shade(hex, 0.8), [0.07, 0.07, 0.03], [0.09 * b.bx, 0.38, pz]);
      for (const s of [1, -1]) sp.box(hex, [0.07, 0.02 + out, 0.26 * b.bz + out * 2], [s * 0.1 * b.bx, 0.52 + out * 0.5, 0]);
      break;
    }
    case 'hivis': {
      const gap = 0.42, inf = Math.max(0.022, b.bulk + 0.01);
      shell(sp, b, hex, inf, 0.06, 0.51, gap);
      for (const y of [0.18, 0.3]) shell(sp, b, 0xd8dadc, inf + 0.004, y - 0.016, y + 0.016, gap);
      break;
    }
    case 'bandolier': {
      // Shoulder to hip across the chest and back, shotgun shells along the front.
      const tilt = 0.62;
      const dir = new THREE.Vector2(-Math.sin(tilt), Math.cos(tilt));
      if (b.female) chestSash(sp, b, hex, tilt, 0.045, b.bulk + 0.012, 0.04, 0.014);
      else sp.box(hex, [0.045, 0.64, 0.014], [0, 0.29, frontZ(b, 0.29) + b.bulk + 0.012], [0, 0, tilt]);
      sp.box(hex, [0.045, 0.64, 0.014], [0, 0.29, -frontZ(b, 0.29) - b.bulk - 0.012], [0, 0, -tilt]);
      for (let i = 0; i < 7; i++) {
        const t = (i - 3) * 0.045;
        const x = dir.x * t, y = 0.29 + dir.y * t;
        const z = chestZ(b, x, y) + b.bulk + 0.026;
        sp.box(0x9e1f23, [0.04, 0.014, 0.014], [x, y, z], [0, 0, tilt]);
        sp.box(0xc9a233, [0.012, 0.0145, 0.0145], [x + Math.cos(tilt) * 0.022, y + Math.sin(tilt) * 0.022, z], [0, 0, tilt]);
      }
      break;
    }
    case 'belt': {
      const bp = 0.97 + (b.bx - 1) * 0.5;
      hp.cyl(hex, 0.178 * bp, 0.178 * bp, 0.045, [0, 0.07, 0], O, [1, 1, 0.72], { seg: 12 });
      for (const t of [0.9, -0.9, 2.2, -2.2, Math.PI]) hp.box(shade(hex, 0.85), [0.06, 0.07, 0.035], [Math.sin(t) * 0.18 * bp, 0.06, Math.cos(t) * 0.13 * bp], [0, t, 0]);
      hp.box(0x9a9ca0, [0.04, 0.032, 0.01], [0, 0.07, 0.132 * bp]);
      break;
    }
    case 'fannypack': {
      const bp = 0.97 + (b.bx - 1) * 0.5;
      hp.cyl(shade(hex, 0.6), 0.176 * bp, 0.176 * bp, 0.02, [0, 0.07, 0], O, [1, 1, 0.72], { seg: 12 });
      hp.box(hex, [0.17, 0.08, 0.06], [0, 0.04, 0.14 * bp]);
      hp.box(0x9a9ca0, [0.15, 0.005, 0.005], [0, 0.065, 0.171 * bp]);
      break;
    }
    case 'kneepads':
      for (const bone of [BONE.legLLower, BONE.legRLower]) {
        const lo = kit(bone);
        const knee = b.shins ? ringAt(b.shins.rings, -0.06).r * b.shins.k : 0.06;
        lo.box(hex, [0.09, 0.085, 0.03], [0, -0.03, knee], [-0.1, 0, 0]);
        lo.cyl(shade(hex, 0.7), knee + 0.004, knee + 0.004, 0.02, [0, -0.06, 0], O, 1, { seg: 8 });
      }
      break;
  }
}
