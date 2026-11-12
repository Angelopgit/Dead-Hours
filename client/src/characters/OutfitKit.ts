/**
 * The shared kit for building outfits: fabric patterns, colour helpers, the part sink that
 * collects geometry by surface, and the head and smoking constants that Outfit.ts and
 * OutfitHead.ts both read.
 */
import * as THREE from 'three';
import type { EyeOpening, FaceSpec } from './HeadSculpt';

/** Fabric patterns, drawn per pixel by the character material from bind-pose position. */
export const PATTERN = { none: 0, plaid: 1, stripes: 2, camo: 3, floral: 4, knit: 5, denim: 6, digital: 7 } as const;

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

export type V3 = readonly [number, number, number];
export const O: V3 = [0, 0, 0];
export const TAU = Math.PI * 2;
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

export function mat(p: V3 = O, r: V3 = O, s: V3 | number = 1): THREE.Matrix4 {
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
export function luminance(hex: number): number {
  return ((hex >> 16 & 255) * 0.299 + (hex >> 8 & 255) * 0.587 + (hex & 255) * 0.114) / 255;
}

interface CylOpts { seg?: number; open?: boolean; t0?: number; tl?: number }

/** Places primitives on one bone, inside an optional local frame. */
export class Kit {
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
export function crumple(g: THREE.BufferGeometry, amount: number): THREE.BufferGeometry {
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

/**
 * The head and everything on it is built on a ball-like ellipsoid and drawn as a real head's
 * oval: HEAD_K of its built height, narrower from ear to ear (HEAD_X) and a little shallower
 * front to back (HEAD_Z). At 1 a 1.84 m survivor stands 6.6 heads tall, the head of the faceted
 * reference figure (docs/art-style.md): larger than a tape measure gives (7.6), so the face
 * reads from across a street. It has been 0.8 and 0.9; both read as too small.
 */
export const HEAD_K = 1;
export const HEAD_X = 0.9;
export const HEAD_Z = 0.95;
/** How far the chin is brought forward of the ellipsoid it was built on. */
const CHIN_FWD = 0.03;
/** How far the back of the head tucks in toward the neck below the ears (of its depth): a skull, not a ball. */
const NAPE = 0.2;

/** How much of the jaw's tuck under the skull applies at head-space height y: none at the cheekbones, all of it at the chin. */
const jawK = (y: number) => THREE.MathUtils.smoothstep(-y, -0.1, 0.005);
/**
 * How wide the head is drawn at height y, of the ellipsoid it was built on: all of it across the
 * skull, less at the cheekbones, less again at the corners of the jaw and at the chin. A ball is
 * widest at the nose, which is a moon face; a skull is widest above the ears.
 */
const faceW = (y: number) => 1 - 0.07 * THREE.MathUtils.smoothstep(-y, -0.168, -0.105) - 0.07 * THREE.MathUtils.smoothstep(-y, -0.105, -0.03) - 0.05 * THREE.MathUtils.smoothstep(-y, -0.03, 0.01);
/** How much of the chin's reach applies at height y (none above the mouth), and how far forward of the ears a point must be to move with it. */
const chinK = (y: number) => THREE.MathUtils.smoothstep(0.075 - y, 0, 0.075);
const chinZ = (z: number) => THREE.MathUtils.smoothstep(z, -0.05, 0.05);

const _w = new THREE.Vector3();
/**
 * A head-space point as built to where it is drawn: the jaw narrowing toward the chin and
 * tucking in under the skull, the chin and lower face brought forward, then the head's oval.
 */
export function headWarp(v: THREE.Vector3): THREE.Vector3 {
  const j = jawK(v.y);
  const z = (v.z < 0 ? v.z * (1 - NAPE * j) : v.z) + CHIN_FWD * chinK(v.y) * chinZ(v.z);
  return v.set(v.x * faceW(v.y) * HEAD_K * HEAD_X, v.y * HEAD_K, z * HEAD_K * HEAD_Z);
}

/** The other way: a drawn head-space point back to where it was built. */
export function headUnwarp(v: THREE.Vector3): THREE.Vector3 {
  const y = v.y / HEAD_K, j = jawK(y), c = CHIN_FWD * chinK(y);
  const zt = v.z / (HEAD_K * HEAD_Z);
  let z = zt;
  for (let i = 0; i < 8; i++) {
    const g = zt - c * chinZ(z);
    z = g < 0 ? g / (1 - NAPE * j) : g;
  }
  return v.set(v.x / (faceW(y) * HEAD_K * HEAD_X), y, z);
}

/**
 * Head bone parts go through here and are warped as one (headWarp): the head's own skin and
 * everything on it (beards, masks, makeup, helmets), so whatever sat on the face still does.
 */
export function headSink(sink: PartSink): PartSink {
  return (g, bone, hex, m, surf, blend) => {
    g.applyMatrix4(m);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pos.count; i++) {
      _w.fromBufferAttribute(pos, i);
      const wide = faceW(_w.y);
      headWarp(_w);
      pos.setXYZ(i, _w.x, _w.y, _w.z);
      if (nor) {
        // Squeezed from the sides, a surface turns to face more sideways.
        _w.fromBufferAttribute(nor, i);
        _w.set(_w.x / (wide * HEAD_X), _w.y, _w.z / HEAD_Z).normalize();
        nor.setXYZ(i, _w.x, _w.y, _w.z);
      }
    }
    pos.needsUpdate = true;
    const shade = surf?.shade;
    const s = shade ? { ...surf, shade: (x: number, y: number, z: number, c: THREE.Color) => { headUnwarp(_w.set(x, y, z)); shade(_w.x, _w.y, _w.z, c); } } : surf;
    sink(g, bone, hex, new THREE.Matrix4(), s, blend);
  };
}

const gauss = (d2: number) => Math.exp(-d2);

/**
 * Soft shading on the face (head space, as built). The sculpted face makes its own shadows now;
 * this is what the lamps don't give: the dark under the jaw, the nostrils, the socket's depth,
 * and blood under the skin of the cheeks, nose and ears.
 */
export const faceShade: Shade = (x, y, z, c) => {
  const ax = Math.abs(x);
  const front = THREE.MathUtils.smoothstep(z, 0.02, 0.09);
  let k = 1;
  // Under the jaw: the bottom of the head falls into shadow, deepest toward the neck.
  k *= 1 - 0.28 * THREE.MathUtils.smoothstep(-y, -0.03, 0.012) * (1 - 0.7 * front);
  // Eye sockets, deepest at the inner corners by the nose.
  k *= 1 - 0.14 * front * gauss(((ax - 0.036) / 0.024) ** 2 + ((y - 0.141) / 0.014) ** 2);
  // Nostrils, and the shadow under the nose and the lower lip.
  k *= 1 - 0.5 * front * gauss(((ax - 0.0085) / 0.0045) ** 2 + ((y - 0.0845) / 0.004) ** 2);
  k *= 1 - 0.1 * front * gauss((x / 0.02) ** 2 + ((y - 0.079) / 0.006) ** 2);
  k *= 1 - 0.1 * front * gauss((x / 0.022) ** 2 + ((y - 0.042) / 0.007) ** 2);
  c.multiplyScalar(k);
  // Blood under the skin: cheeks, nose tip, ears.
  const warm = 0.8 * front * gauss(((ax - 0.064) / 0.026) ** 2 + ((y - 0.094) / 0.022) ** 2) + 0.7 * front * gauss((x / 0.014) ** 2 + ((y - 0.098) / 0.014) ** 2) + 0.6 * gauss(((ax - 0.113) / 0.014) ** 2 + ((y - 0.115) / 0.035) ** 2);
  c.r *= 1 + 0.06 * warm;
  c.g *= 1 - 0.025 * warm;
  c.b *= 1 - 0.04 * warm;
};

/** The neck in the jaw's shadow at the top, lighter where it meets the shoulders. */
export const neckShade: Shade = (_x, y, z, c) => {
  const k = 1 - 0.3 * THREE.MathUtils.smoothstep(y, -0.07, 0.01) * (0.55 + 0.45 * THREE.MathUtils.smoothstep(z, -0.02, 0.05));
  c.multiplyScalar(k);
};

export interface Body {
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
  /** The face's build: the head, and the brows, beards and teeth laid on it, share it. */
  face: FaceSpec;
  /** The balaclava or wrap worn over the head, if any. */
  mask?: MaskShape;
}

/** Where each hair part may go under headwear. */
export type Cover = 'none' | 'hat' | 'full';
export const COVERS_FACE = new Set(['moto', 'knight']);

/** An eye shape: its opening between the lids (HeadSculpt.EyeOpening), and the brow over it (slope of its outer end, height). */
interface EyeShape extends EyeOpening { brow: number; browY: number }
export const EYES: Record<string, EyeShape> = {
  round: { a: 0.0196, up: 0.007, down: 0.0066, tilt: 0, lidTilt: 0, brow: -0.03, browY: 0.1635 },
  almond: { a: 0.0205, up: 0.0062, down: 0.0058, tilt: 0.04, lidTilt: 0, brow: 0.04, browY: 0.162 },
  wide: { a: 0.0205, up: 0.0088, down: 0.0072, tilt: 0, lidTilt: 0, brow: -0.08, browY: 0.166 },
  narrow: { a: 0.0205, up: 0.0054, down: 0.0046, tilt: 0.02, lidTilt: 0, brow: 0.1, browY: 0.1595 },
  sleepy: { a: 0.02, up: 0.0046, down: 0.0058, tilt: -0.07, lidTilt: -0.06, brow: -0.1, browY: 0.1625 },
  fierce: { a: 0.02, up: 0.0058, down: 0.005, tilt: 0.06, lidTilt: 0.2, brow: 0.34, browY: 0.159 },
};
/** The eyes: height of the eye line, half the distance between them, the eyeballs' centres behind the lids (head space as built). */
export const EYE_Y = 0.138;
export const EYE_X = 0.045;
export const EYE_Z = 0.099;

/** One piece of the eyes; `iris` pieces (iris, pupil, glint) move together when the eyes look about. */
export interface EyePart { g: THREE.BufferGeometry; hex: number; m: THREE.Matrix4; iris?: boolean }

export const DOME_C: V3 = [0, 0.125, -0.005];
export const domeR = (inf: number): V3 => [0.122 + inf, 0.145 + inf, 0.135 + inf];

/**
 * A tube along a smooth path through `points` that narrows from radius r0 to r1 (a floppy hat).
 * Open at both ends: the brim and the pom-pom cover them.
 */
export function taperTube(points: readonly V3[], r0: number, r1: number, segs = 18, radial = 16): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const c = new THREE.Vector3();
  // TubeGeometry lays out (radial + 1) vertices per ring, unit radius around the curve point.
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, c);
    const r = r1 + (r0 - r1) * Math.pow(1 - t, 1.15);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * r, c.y + (pos.getY(k) - c.y) * r, c.z + (pos.getZ(k) - c.z) * r);
    }
  }
  return g;
}

// ── Clothing ────────────────────────────────────────────────────────────────────────────

/** What covers the shins (for boots to fit over): rings and their scale. */
export interface Shins {
  rings: readonly Ring[];
  k: number;
}

export type SmokeKind = 'cigarette' | 'joint' | 'blunt';

export interface SmokeShape {
  /** Length from where it sits in the lips to the lit end; radius at the lips and at the lit end. */
  len: number;
  r0: number;
  r1: number;
  /** How far it droops from straight out (radians), and how far it turns out past the mouth's corner. */
  droop: number;
  yaw: number;
}

export const SMOKES: Record<SmokeKind, SmokeShape> = {
  cigarette: { len: 0.074, r0: 0.0042, r1: 0.0042, droop: 0.3, yaw: 0.3 },
  // Rolled cone: thin at the crutch, fat where it burns.
  joint: { len: 0.07, r0: 0.0034, r1: 0.006, droop: 0.24, yaw: 0.26 },
  blunt: { len: 0.088, r0: 0.0063, r1: 0.0069, droop: 0.2, yaw: 0.22 },
};

/**
 * Cloth worn over the head and face (the mask slot): what each hides. `bare(x, y, a)` is true
 * where the head is left uncovered (head space as built; `a` the angle round from the nose).
 */
export interface MaskShape {
  /** Covers the mouth (no smoke, no beard showing) and the scalp, brows and ears. */
  mouth: boolean;
  scalp: boolean;
  brows: boolean;
  ears: boolean;
  bare: (x: number, y: number, a: number) => boolean;
}
const eyeSlit = (x: number, y: number, a: number) => Math.abs(a) < 1.3 && Math.abs(x) < 0.07 && y > 0.12 && y < 0.155;
export const MASKS: Record<string, MaskShape> = {
  balaclava: { mouth: true, scalp: true, brows: true, ears: true, bare: eyeSlit },
  skull: { mouth: true, scalp: true, brows: true, ears: true, bare: eyeSlit },
  openbalaclava: { mouth: false, scalp: true, brows: false, ears: true, bare: (x, y, a) => Math.abs(a) < 1.3 && Math.abs(x) < 0.07 && y > 0.05 && y < 0.165 },
  shemaghwrap: { mouth: true, scalp: true, brows: false, ears: true, bare: (x, y, a) => Math.abs(a) < 1.4 && Math.abs(x) < 0.095 && y > 0.118 && y < 0.17 },
  gaiter: { mouth: true, scalp: false, brows: false, ears: false, bare: (_x, y) => y > 0.112 },
};

/** Faces that cover the mouth: nothing to hold a smoke with. */
export const COVERS_MOUTH = new Set(['bandanamask', 'surgical', 'gasmask', 'hockey']);
/** The lit end, glowing (Humanoid draws it, so it can flare on a drag). */
export const EMBER_LEN = 0.005;
export const CHAR = 0x3a3330;

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

