import * as THREE from 'three';
import { paletteColor, type Appearance } from '@dead-hours/shared';
import { BONE } from './rig';

/** Fabric patterns, drawn per pixel by the character material from bind-pose position. */
export const PATTERN = { none: 0, plaid: 1, stripes: 2, camo: 3, floral: 4, knit: 5, denim: 6 } as const;

export interface Surface {
  pattern?: number;
  /** Second pattern color (plaid lines, stripes, flowers). */
  accent?: number;
}

/** Receives one primitive: its bone, color, bone-space transform and optional fabric pattern. */
export type PartSink = (g: THREE.BufferGeometry, bone: number, hex: number, m: THREE.Matrix4, s?: Surface) => void;

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

  put(g: THREE.BufferGeometry, hex: number, p?: V3, r?: V3, s?: V3 | number, surf?: Surface): void {
    this.sink(g, this.bone, hex, this.frame.clone().multiply(mat(p, r, s)), surf);
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

export interface DressOptions {
  zombie: boolean;
  /** Skin color (hex), overriding the palette (zombies). */
  skin?: number;
  rand: () => number;
}

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
  zombie: boolean;
  rand: () => number;
  /** How far the top's outer layer stands off the torso; straps, packs and vests go over it. */
  bulk: number;
}

const BUILD = { slim: [0.9, 0.93, 0.92], average: [1, 1, 1], broad: [1.11, 1.08, 1.1] } as const;
/** Torso radius (x, before build scale) at spine-space height y. */
const torsoR = (y: number) => 0.16 + 0.1 * (y - 0.02);
const frontZ = (b: Body, y: number) => 0.62 * b.bz * torsoR(y);
/** Outer layer thickness of each top (open jackets, coats, puffer rings). */
const TOP_BULK: Record<string, number> = { openflannel: 0.014, ziphoodie: 0.012, denim: 0.02, leather: 0.021, raincoat: 0.015, camo: 0.016, puffer: 0.032 };

/** Where each hair part may go under headwear. */
type Cover = 'none' | 'hat' | 'full';
const COVER: Record<string, Cover> = {
  none: 'none', sweatband: 'none', moto: 'full', knight: 'full',
};
const HIDES_EYES = new Set(['moto', 'knight', 'sunglasses', 'goggles', 'hockey', 'gasmask', 'aviators']);
const COVERS_FACE = new Set(['moto', 'knight']);

/**
 * Builds a survivor (or zombie) from an appearance: body, face, hair, clothing and gear, as
 * primitives on the skeleton's bones. The Humanoid merges them into one skinned mesh.
 */
export function dress(sink: PartSink, a: Appearance, o: DressOptions): DressResult {
  const build = BUILD[a.build] ?? BUILD.average;
  const b: Body = { bx: build[0], bz: build[1], arm: build[2], skin: o.skin ?? paletteColor('skin', a.skin), zombie: o.zombie, rand: o.rand, bulk: TOP_BULK[a.top] ?? 0 };
  const kit = (bone: number) => new Kit(sink, bone);
  const head = kit(BONE.head), spine = kit(BONE.spine), hips = kit(BONE.hips);
  const cloth = (i: number) => paletteColor('cloth', i);
  const hairHex = paletteColor('hair', a.hairColor);
  const covered = COVERS_FACE.has(a.headwear);

  face(head, a, b, hairHex, covered);
  hair(head, a, b, hairHex, COVER[a.headwear] ?? 'hat');
  if (!covered) beard(head, a, b, hairHex);
  headwear(head, a, cloth(a.headwearColor));
  top(spine, kit, a, b);
  pants(hips, spine, kit, a, b);
  shoes(kit, a);
  gloves(kit, a, b);
  if (!covered) faceGear(head, a, b, cloth(a.faceColor));
  neck(spine, a, b, cloth(a.neckColor));
  const backDepth = back(spine, a, b, cloth(a.backColor)) + b.bulk;
  gear(spine, hips, kit, a, b, cloth(a.gearColor));
  return { backDepth, eyesVisible: !o.zombie && !HIDES_EYES.has(a.headwear) && !HIDES_EYES.has(a.face) };
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

function face(h: Kit, a: Appearance, b: Body, hairHex: number, covered: boolean): void {
  const skin = b.skin;
  h.cyl(skin, 0.055, 0.065, 0.12, [0, -0.04, 0], O, 1, { seg: 8 });
  h.put(new THREE.IcosahedronGeometry(1, 2), skin, [0, 0.12, 0], O, [0.117, 0.1404, 0.13]);
  for (const s of [1, -1]) h.ball(shade(skin, 0.94), [0.016, 0.03, 0.022], [s * 0.113, 0.115, -0.008], [0, 0, s * 0.1], undefined, 6, 5);
  h.box(shade(skin, 0.97), [0.024, 0.038, 0.024], [0, 0.102, 0.122], [-0.32, 0, 0]);
  if (b.zombie) {
    // A slack, dark mouth.
    h.ball(0x2a0c0a, [0.026, 0.012, 0.008], [0, 0.058, 0.115], [0.1, 0, 0], undefined, 8, 5);
    return;
  }
  if (covered) return;
  const lip = a.facialHair === 'beard' ? 0.013 : a.facialHair === 'goatee' || a.facialHair === 'stubble' ? 0.004 : 0;
  h.box(mixHex(skin, 0x4a1c1c, 0.55), [0.038, 0.0055, 0.008], [0, 0.063, 0.118 + lip], [-0.15, 0, 0]);
  const e = EYES[a.eyes] ?? EYES.almond;
  const brow = luminance(hairHex) > 0.7 ? shade(hairHex, 0.85) : hairHex;
  for (const s of [1, -1]) {
    h.box(brow, [0.036, 0.0085, 0.009], [s * 0.043, e.browY, 0.114], [-0.25, s * 0.18, s * e.brow]);
    // Upper lid: a shell over the top of the eye, rotated down to cover `lid` of it. It stays put
    // while the eye itself squashes to blink.
    if (e.lid > 0) {
      const tilt = Math.asin(THREE.MathUtils.clamp((2 * e.lid - 1) * e.sy / 0.018, -1, 1));
      h.at([s * EYE_X, EYE_Y, EYE_Z], [0, s * 0.2, s * e.tilt])
        .cap(shade(skin, 0.92), [e.sx * 1.14, e.sy * 1.18, 0.0192], 0, Math.PI / 2, O, [tilt, 0, -s * e.lidTilt], { w: 12, h: 6 });
    }
  }
}

/** Eye geometry (head-bone space, relative to the eye line at EYE_Y): sclera, iris, pupil, glint, lids. */
export function eyeParts(a: Appearance): { g: THREE.BufferGeometry; hex: number; m: THREE.Matrix4 }[] {
  const e = EYES[a.eyes] ?? EYES.almond;
  const iris = paletteColor('eye', a.eyeColor);
  const out: { g: THREE.BufferGeometry; hex: number; m: THREE.Matrix4 }[] = [];
  const add = (g: THREE.BufferGeometry, hex: number, m: THREE.Matrix4) => out.push({ g, hex, m });
  for (const s of [1, -1]) {
    const frame = mat([s * EYE_X, 0, EYE_Z], [0, s * 0.2, s * e.tilt]);
    const at = (p: V3, r: V3, sc: V3 | number) => frame.clone().multiply(mat(p, r, sc));
    add(new THREE.SphereGeometry(1, 12, 8), 0xe9e4dc, at(O, O, [e.sx, e.sy, 0.016]));
    const ir = Math.min(0.0115, e.sy * 0.95);
    add(new THREE.SphereGeometry(1, 12, 8), iris, at([0, 0, 0.0115], O, [ir, ir, 0.0055]));
    add(new THREE.SphereGeometry(1, 10, 6), 0x050505, at([0, 0, 0.0145], O, [ir * 0.45, ir * 0.45, 0.003]));
    add(new THREE.SphereGeometry(1, 6, 4), 0xffffff, at([-s * ir * 0.35 + s * 0.001, ir * 0.4, 0.0168], O, ir * 0.17));
    // Lash line along the top edge of an open eye (lidded eyes have the lid's edge instead).
    if (e.lid === 0) add(new THREE.TorusGeometry(1, 0.1, 3, 14, Math.PI), 0x1a1210, at([0, 0, 0.007], [-0.35, 0, 0], [e.sx * 1.04, e.sy * 1.04, 0.01]));
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
  }
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
  }
}

// ── Clothing ────────────────────────────────────────────────────────────────────────────

type Sleeve = 'none' | 'short' | 'long' | 'jacket' | 'puffy';

/** A torso layer from spine-space height y0 to y1, `inf` meters out, open at the front by `gap` radians. */
function shell(sp: Kit, b: Body, hex: number, inf: number, y0: number, y1: number, gap = 0, surf?: Surface, rbOverride?: number): void {
  const rt = torsoR(y1), rb = rbOverride ?? torsoR(y0);
  const rm = (rt + rb) / 2;
  const sx = (b.bx * rm + inf) / (rm + inf), sz = (0.62 * b.bz * rm + inf) / (rm + inf);
  sp.cyl(hex, rt + inf, rb + inf, y1 - y0, [0, (y0 + y1) / 2, 0], O, [sx, 1, sz], { seg: 14, open: gap > 0, t0: gap / 2, tl: TAU - gap }, surf);
}

function torso(sp: Kit, b: Body, hex: number, surf?: Surface): void {
  sp.cyl(hex, 0.21, 0.16, 0.5, [0, 0.27, 0], O, [b.bx, 1, 0.62 * b.bz], { seg: 14 }, surf);
}

function sleeves(kit: (bone: number) => Kit, b: Body, kind: Sleeve, hex: number, surf?: Surface, cuff?: number): void {
  const skin = b.skin;
  for (const s of [1, -1]) {
    const up = kit(s > 0 ? BONE.armLUpper : BONE.armRUpper), lo = kit(s > 0 ? BONE.armLLower : BONE.armRLower);
    const k = b.arm;
    // Zombie sleeves are often torn off at the elbow.
    const torn = b.zombie && b.rand() < 0.5;
    const inf = kind === 'jacket' ? 0.01 : kind === 'puffy' ? 0.022 : 0;
    const upHex = kind === 'none' || kind === 'short' ? skin : hex;
    const loHex = kind === 'long' || kind === 'jacket' || kind === 'puffy' ? (torn ? skin : hex) : skin;
    up.ball(kind === 'none' ? skin : hex, 0.062 * k + inf, [0, -0.01, 0], O, kind === 'none' ? undefined : surf, 8, 6);
    up.cyl(upHex, (0.055 + inf) * k, (0.045 + inf) * k, 0.31, [0, -0.155, 0], O, 1, { seg: 8 }, upHex === skin ? undefined : surf);
    lo.cyl(loHex, (0.045 + inf * 0.8) * k, (0.038 + inf * 0.8) * k, 0.29, [0, -0.145, 0], O, 1, { seg: 8 }, loHex === skin ? undefined : surf);
    if (kind === 'short') up.cyl(hex, 0.066 * k, 0.06 * k, 0.13, [0, -0.06, 0], O, 1, { seg: 8 }, surf);
    if (kind === 'puffy') for (const y of [-0.1, -0.22]) up.torus(hex, 0.052 * k, 0.018, [0, y, 0], [Math.PI / 2, 0, 0], 1, 4, 10, TAU, surf);
    if (loHex !== skin && cuff !== undefined) lo.cyl(cuff, 0.046 * k + inf * 0.8, 0.046 * k + inf * 0.8, 0.035, [0, -0.272, 0], O, 1, { seg: 8 });
    if (torn && (kind === 'long' || kind === 'jacket')) lo.cyl(hex, 0.05 * k, 0.046 * k, 0.04, [0, -0.02, 0], O, 1, { seg: 7 }, surf);
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
    sp.box(hex, [0.012, 0.012, 0.006], [0, y, frontZ(b, y) + 0.004]);
  }
}

function hood(sp: Kit, hex: number, surf?: Surface): void {
  sp.ball(hex, [0.13, 0.075, 0.09], [0, 0.565, -0.105], [0.35, 0, 0], surf, 12, 7);
  sp.torus(shade(hex, 0.85), 0.085, 0.018, [0, 0.555, -0.03], [Math.PI / 2 - 0.25, 0, 0], [1.05, 1, 0.9], 4, 12, TAU, surf);
}

function lapels(sp: Kit, b: Body, hex: number, gap: number, surf?: Surface, size = 1): void {
  const y = 0.44;
  const r = torsoR(y);
  for (const s of [1, -1]) {
    const t = gap / 2 + 0.05;
    const x = Math.sin(t) * r * b.bx * s, z = Math.cos(t) * 0.62 * b.bz * r + 0.016;
    sp.box(hex, [0.06 * size, 0.17 * size, 0.012], [x + s * 0.02, y, z], [-0.12, s * 0.35, s * 0.32], surf);
  }
}

function pocket(sp: Kit, b: Body, hex: number, x: number, y: number, w = 0.06, h = 0.06, flap = true): void {
  const z = frontZ(b, y) * Math.cos(x / (torsoR(y) * b.bx)) + 0.006;
  sp.box(hex, [w, h, 0.01], [x, y, z]);
  if (flap) sp.box(shade(hex, 0.85), [w + 0.006, 0.018, 0.014], [x, y + h / 2, z + 0.002]);
}

function top(sp: Kit, kit: (bone: number) => Kit, a: Appearance, b: Body): void {
  const main = paletteColor('cloth', a.topColor);
  const acc = paletteColor('cloth', a.topAccent);
  const under = luminance(main) < 0.35 ? 0xd8d6d0 : 0x2b2d31;
  const plaid: Surface = { pattern: PATTERN.plaid, accent: acc };
  const button = shade(main, 1.35);
  switch (a.top) {
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
      pocket(sp, b, main, 0.07, 0.38, 0.055, 0.06, false);
      break;
    case 'flannel':
      torso(sp, b, main, plaid);
      sleeves(kit, b, 'long', main, plaid, shade(main, 0.8));
      collarPoints(sp, b, main, plaid);
      buttons(sp, b, button);
      for (const x of [0.075, -0.075]) pocket(sp, b, shade(main, 0.95), x, 0.37, 0.055, 0.06);
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
        for (const [bone, len, y] of [[s > 0 ? BONE.armLUpper : BONE.armRUpper, 0.31, -0.155], [s > 0 ? BONE.armLLower : BONE.armRLower, 0.29, -0.145]] as const) {
          kit(bone).box(acc, [0.012, len, 0.016], [s * 0.05 * b.arm, y, 0]);
        }
      }
      sp.box(0x9a9ca0, [0.006, 0.46, 0.006], [0, 0.27, frontZ(b, 0.27) + 0.003]);
      sp.cyl(main, 0.075, 0.08, 0.05, [0, 0.535, 0], O, [1, 1, 0.95], { seg: 12 });
      break;
    case 'puffer':
      torso(sp, b, main);
      for (let i = 0; i < 5; i++) {
        const y = 0.06 + i * 0.105;
        const r = torsoR(y);
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
    default:
      torso(sp, b, main);
      sleeves(kit, b, 'short', main);
  }
}

function pants(hp: Kit, sp: Kit, kit: (bone: number) => Kit, a: Appearance, b: Body): void {
  const hex = paletteColor('cloth', a.pantsColor);
  const bp = 0.97 + (b.bx - 1) * 0.5;
  let surf: Surface | undefined;
  if (a.pants === 'jeans' || a.pants === 'overalls') surf = { pattern: PATTERN.denim };
  if (a.pants === 'camo') surf = { pattern: PATTERN.camo, accent: mixHex(hex, 0x9a8a62, 0.55) };
  hp.cyl(hex, 0.17, 0.15, 0.2, [0, 0, 0], O, [bp, 1, 0.7 * bp], { seg: 10 }, surf);
  const shorts = a.pants === 'shorts';
  for (const s of [1, -1]) {
    const up = kit(s > 0 ? BONE.legLUpper : BONE.legRUpper), lo = kit(s > 0 ? BONE.legLLower : BONE.legRLower);
    if (shorts) {
      up.cyl(b.skin, 0.074, 0.058, 0.44, [0, -0.22, 0], O, 1, { seg: 8 });
      up.cyl(hex, 0.088, 0.08, 0.27, [0, -0.125, 0], O, 1, { seg: 8 }, surf);
      lo.cyl(b.skin, 0.058, 0.049, 0.44, [0, -0.22, 0], O, 1, { seg: 8 });
      lo.cyl(0xdcdad4, 0.054, 0.052, 0.08, [0, -0.4, 0], O, 1, { seg: 8 });
    } else {
      const jog = a.pants === 'joggers';
      up.cyl(hex, 0.08, 0.06, 0.44, [0, -0.22, 0], O, 1, { seg: 8 }, surf);
      lo.cyl(hex, 0.06, jog ? 0.046 : 0.051, 0.44, [0, -0.22, 0], O, 1, { seg: 8 }, surf);
      if (jog) lo.cyl(shade(hex, 0.8), 0.049, 0.049, 0.05, [0, -0.42, 0], O, 1, { seg: 8 }, { pattern: PATTERN.knit });
    }
    if (a.pants === 'cargo' || a.pants === 'shorts' || a.pants === 'camo') {
      up.box(shade(hex, 0.92), [0.03, 0.09, 0.08], [s * 0.082, -0.25, 0], O, surf);
      up.box(shade(hex, 0.82), [0.034, 0.02, 0.084], [s * 0.083, -0.205, 0], O, surf);
    }
    if (a.pants === 'work') {
      lo.box(shade(hex, 0.78), [0.075, 0.09, 0.02], [0, -0.04, 0.056]);
      up.box(shade(hex, 0.85), [0.02, 0.12, 0.012], [s * 0.04, -0.22, -0.07]);
    }
  }
  if (a.pants === 'jeans' || a.pants === 'work' || a.pants === 'cargo') {
    hp.cyl(0x2a1d14, 0.172 * bp, 0.172 * bp, 0.032, [0, 0.082, 0], O, [1, 1, 0.71], { seg: 12 });
    hp.box(0xb8a46a, [0.035, 0.026, 0.008], [0, 0.082, 0.124 * bp]);
  }
  if (a.pants === 'joggers') hp.cyl(shade(hex, 0.8), 0.172 * bp, 0.172 * bp, 0.035, [0, 0.082, 0], O, [1, 1, 0.71], { seg: 12 }, { pattern: PATTERN.knit });
  if (a.pants === 'overalls') {
    const y0 = 0.02, y1 = 0.3;
    sp.box(hex, [0.22 * b.bx, y1 - y0, 0.02], [0, (y0 + y1) / 2, frontZ(b, 0.16) - 0.002], [0.05, 0, 0], surf);
    for (const s of [1, -1]) {
      const x = s * 0.075 * b.bx;
      sp.box(hex, [0.032, 0.22, 0.012], [x, 0.41, frontZ(b, 0.41) + 0.003], [-0.1, 0, 0], surf);
      sp.box(hex, [0.032, 0.012, 0.27 * b.bz], [x, 0.522, 0], O, surf);
      sp.box(hex, [0.032, 0.4, 0.012], [x * 0.8, 0.32, -frontZ(b, 0.32) - 0.003], [0.08, 0, -s * 0.12], surf);
      sp.box(0xc9a233, [0.018, 0.018, 0.008], [x, 0.3, frontZ(b, 0.3) + 0.012]);
    }
  }
}

function shoes(kit: (bone: number) => Kit, a: Appearance): void {
  const hex = paletteColor('cloth', a.shoesColor);
  const sole = a.shoes === 'sneakers' || a.shoes === 'hightops' ? 0xe6e3dc : 0x1a1816;
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
        lo.cyl(hex, 0.062, 0.064, 0.11, [0, -0.415, 0], O, 1, { seg: 8 });
        lo.box(sole, [0.106, 0.028, 0.245], [0, -0.508, 0.052]);
        lo.ball(0xeeeae0, [0.002, 0.022, 0.022], [s * 0.052, -0.43, 0.0], O, undefined, 6, 4);
        break;
      case 'combat':
        lo.box(hex, [0.104, 0.08, 0.24], [0, -0.47, 0.05]);
        lo.cyl(hex, 0.064, 0.066, 0.17, [0, -0.375, 0], O, 1, { seg: 8 });
        lo.box(sole, [0.11, 0.03, 0.252], [0, -0.51, 0.052]);
        for (let i = 0; i < 4; i++) lo.box(0x0d0d0d, [0.05, 0.006, 0.006], [0, -0.33 - i * 0.03, 0.064]);
        break;
      case 'work':
        lo.box(hex, [0.108, 0.085, 0.24], [0, -0.468, 0.05]);
        lo.cyl(hex, 0.064, 0.066, 0.11, [0, -0.405, 0], O, 1, { seg: 8 });
        lo.box(shade(hex, 0.7), [0.1, 0.05, 0.06], [0, -0.475, 0.145]);
        lo.box(0x3a2a1e, [0.114, 0.036, 0.255], [0, -0.51, 0.052]);
        break;
      case 'rain':
        lo.box(hex, [0.106, 0.08, 0.24], [0, -0.47, 0.05]);
        lo.cyl(hex, 0.072, 0.069, 0.3, [0, -0.32, 0], O, 1, { seg: 10 });
        lo.box(shade(hex, 0.6), [0.11, 0.025, 0.25], [0, -0.508, 0.052]);
        break;
      default:
        lo.box(hex, [0.1, 0.08, 0.24], [0, -0.48, 0.05]);
    }
  }
}

function gloves(kit: (bone: number) => Kit, a: Appearance, b: Body): void {
  const hex = paletteColor('cloth', a.glovesColor);
  for (const s of [1, -1]) {
    const lo = kit(s > 0 ? BONE.armLLower : BONE.armRLower);
    switch (b.zombie ? 'none' : a.gloves) {
      case 'work':
        lo.box(hex, [0.077, 0.096, 0.057], [0, -0.33, 0]);
        lo.cyl(shade(hex, 0.8), 0.05, 0.048, 0.045, [0, -0.29, 0], O, 1, { seg: 8 });
        break;
      case 'fingerless':
        lo.box(hex, [0.075, 0.056, 0.055], [0, -0.311, 0]);
        lo.box(b.skin, [0.068, 0.04, 0.048], [0, -0.355, 0]);
        break;
      case 'leather':
        lo.box(hex, [0.074, 0.094, 0.054], [0, -0.33, 0]);
        lo.cyl(hex, 0.043, 0.042, 0.03, [0, -0.29, 0], O, 1, { seg: 8 });
        break;
      case 'latex':
        lo.box(hex, [0.072, 0.092, 0.052], [0, -0.33, 0]);
        break;
      default:
        lo.box(b.skin, [0.07, 0.09, 0.05], [0, -0.33, 0]);
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
  }
}

function neck(sp: Kit, a: Appearance, b: Body, hex: number): void {
  if (b.zombie && a.neck !== 'bandana' && a.neck !== 'scarf') return;
  const fz = frontZ(b, 0.5);
  switch (a.neck) {
    case 'scarf': {
      const knit: Surface = { pattern: PATTERN.knit };
      sp.torus(hex, 0.074, 0.03, [0, 0.565, 0.0], [Math.PI / 2, 0, 0], [1, 0.95, 1], 6, 14, TAU, knit);
      sp.box(hex, [0.06, 0.22, 0.024], [0.05, 0.42, fz + 0.02], [0.12, 0, 0.08], knit);
      sp.box(shade(hex, 0.9), [0.06, 0.16, 0.024], [0.0, 0.45, fz + 0.03], [0.1, 0, -0.12], knit);
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
  }
}

/** Returns how far behind the back surface the gear reaches. */
function back(sp: Kit, a: Appearance, b: Body, hex: number): number {
  if (b.zombie && a.back !== 'backpack') return 0;
  const bz = frontZ(b, 0.3) + b.bulk;
  const strap = shade(hex, 0.55);
  const straps = (y0: number) => {
    for (const s of [1, -1]) {
      const x = s * 0.095 * b.bx;
      sp.box(strap, [0.035, 0.32, 0.012], [x, 0.36, frontZ(b, 0.36) + b.bulk + 0.006], [-0.1, 0, 0]);
      sp.box(strap, [0.035, 0.012, 0.27 * b.bz + b.bulk * 2], [x, 0.524 + b.bulk * 0.5, -0.005]);
      sp.box(strap, [0.035, 0.12, 0.012], [x, y0, -bz - 0.012], [0.15, 0, 0]);
    }
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
      sp.cyl(strap, torsoR(0.03) + 0.012 + b.bulk, torsoR(0.03) + 0.012 + b.bulk, 0.04, [0, 0.03, 0], O, [b.bx, 1, 0.66 * b.bz], { seg: 14 });
      return 0.18;
    case 'messenger': {
      sp.box(hex, [0.27, 0.21, 0.075], [-0.07, 0.04, -bz - 0.02], [0, 0.35, 0]);
      sp.box(shade(hex, 0.85), [0.275, 0.1, 0.08], [-0.07, 0.11, -bz - 0.024], [0, 0.35, 0]);
      sp.box(strap, [0.04, 0.62, 0.012], [0.0, 0.3, bz + 0.008], [0, 0, 0.62]);
      sp.box(strap, [0.04, 0.62, 0.012], [0.0, 0.3, -bz - 0.008], [0, 0, -0.62]);
      return 0.02;
    }
    case 'katana': {
      const k = sp.at([0, 0.3, -bz - 0.035], [0, 0, 0.6]);
      k.box(hex, [0.036, 0.72, 0.026], [0, -0.04, 0]);
      k.box(0xc9a233, [0.04, 0.025, 0.03], [0, -0.39, 0]);
      k.cyl(0x18191b, 0.04, 0.04, 0.012, [0, 0.33, 0], O, [1, 1, 0.7], { seg: 10 });
      k.box(0x1b1b1d, [0.03, 0.22, 0.03], [0, 0.45, 0], O, { pattern: PATTERN.plaid, accent: 0x8e1f22 });
      k.box(0xc9a233, [0.034, 0.02, 0.034], [0, 0.56, 0]);
      sp.box(0x2a1d14, [0.03, 0.6, 0.012], [0.0, 0.29, bz + 0.008], [0, 0, -0.6]);
      return 0.06;
    }
    case 'guitar': {
      const g = sp.at([0.0, 0.2, -bz - 0.055], [0, 0, -0.55]);
      g.cyl(hex, 0.14, 0.14, 0.075, [0, -0.06, 0], [Math.PI / 2, 0, 0], [1, 1, 1], { seg: 16 });
      g.cyl(hex, 0.11, 0.11, 0.075, [0, 0.12, 0], [Math.PI / 2, 0, 0], [1, 1, 1], { seg: 16 });
      g.cyl(shade(hex, 0.6), 0.145, 0.145, 0.018, [0, -0.06, 0], [Math.PI / 2, 0, 0], 1, { seg: 16, open: true });
      g.box(0x5a3e2a, [0.045, 0.36, 0.024], [0, 0.38, 0.02]);
      g.box(0x2a1d14, [0.06, 0.09, 0.028], [0, 0.6, 0.02]);
      sp.box(0x18191b, [0.035, 0.62, 0.012], [0.0, 0.3, bz + 0.008], [0, 0, 0.6]);
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
      sp.box(shade(hex, 0.8), [0.07, 0.07, 0.03], [0.09 * b.bx, 0.38, frontZ(b, 0.38) + 0.04 + out]);
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
      sp.box(hex, [0.045, 0.64, 0.014], [0, 0.29, frontZ(b, 0.29) + b.bulk + 0.012], [0, 0, tilt]);
      sp.box(hex, [0.045, 0.64, 0.014], [0, 0.29, -frontZ(b, 0.29) - b.bulk - 0.012], [0, 0, -tilt]);
      for (let i = 0; i < 7; i++) {
        const t = (i - 3) * 0.045;
        const x = dir.x * t, y = 0.29 + dir.y * t;
        const z = frontZ(b, y) * Math.cos(x / (torsoR(y) * b.bx)) + b.bulk + 0.026;
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
        lo.box(hex, [0.09, 0.085, 0.03], [0, -0.03, 0.058], [-0.1, 0, 0]);
        lo.cyl(shade(hex, 0.7), 0.064, 0.064, 0.02, [0, -0.06, 0], O, 1, { seg: 8 });
      }
      break;
  }
}
