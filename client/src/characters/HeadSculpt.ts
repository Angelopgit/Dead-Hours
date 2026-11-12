/**
 * The head as one sculpted surface: a skull-shaped grid with a brow, eye sockets, a nose with
 * nostrils, lips, a chin and a jaw, instead of a ball with a box for a nose. The cranium is still
 * the ellipsoid every hat and haircut is fitted to (HEAD_C, HEAD_R); the face is that ellipsoid
 * pushed in and out, so `faceZ` says where its surface is for anything laid on it (brows, beards,
 * teeth). Lips, stubble, makeup and rot are painted into the vertices (`paint`), not stuck on.
 *
 * All of it is in head space as built: headSink then narrows the jaw, brings the chin forward and
 * scales the head (OutfitKit.headWarp), the same for the head and everything worn on it.
 */
import * as THREE from 'three';
import { EYE_X, EYE_Y, type V3 } from './OutfitKit';
export { EYE_Z } from './OutfitKit';

export const HEAD_C: V3 = [0, 0.12, 0];
export const HEAD_R: V3 = [0.117, 0.1404, 0.13];
/** How far the eyes turn out to follow the face round. */
export const EYE_YAW = 0.18;
/** The line the lips meet on, and how wide the mouth is to each side. */
export const MOUTH_Y = 0.0605;
export const MOUTH_W = 0.027;

export interface FaceSpec {
  female: boolean;
  zombie: boolean;
  /** 0 a fed face, 1 skin drawn over the skull: deep sockets, hollow cheeks and temples. */
  gaunt: number;
  /** How far the jaw hangs open (radians about its hinge under the ears). */
  jaw: number;
  /** 1 a whole nose; less under a mask that flattens it, or where rot has eaten it. */
  nose: number;
  /** How far the lips have drawn back off the teeth, 0..1 (the dead). */
  lipless: number;
  /** Lip fullness (1 a man's). */
  lips: number;
  /** Height of the brow ridge (m). */
  brow: number;
  /** A cheek torn open: which side (-1, 1), or 0. */
  tear: number;
  /** Zombies are built from fewer rows and columns: there are ninety of them. */
  lite: boolean;
}

export function faceSpec(female: boolean, zombie: boolean): FaceSpec {
  return { female, zombie, gaunt: zombie ? 0.8 : 0, jaw: 0, nose: 1, lipless: 0, lips: female ? 1.35 : 1, brow: female ? 0.002 : 0.0045, tear: 0, lite: zombie };
}

const g2 = (dx: number, dy: number) => Math.exp(-(dx * dx + dy * dy));
const sstep = THREE.MathUtils.smoothstep;

/** The ellipsoid's front at (x, y). */
const ez = (x: number, y: number) => HEAD_R[2] * Math.sqrt(Math.max(0, 1 - (x / HEAD_R[0]) ** 2 - ((y - HEAD_C[1]) / HEAD_R[1]) ** 2));

/** How far the nose's ridge stands off the face at height y: nothing between the brows, most at the tip, tucked back under it. */
function noseRidge(y: number): number {
  if (y >= 0.158) return 0;
  if (y >= 0.097) return (0.003 + 0.0235 * Math.pow(THREE.MathUtils.clamp((0.156 - y) / 0.059, 0, 1), 1.2)) * sstep(0.158 - y, 0, 0.008);
  if (y >= 0.083) return 0.0265 - 0.0215 * Math.pow((0.097 - y) / 0.014, 1.3);
  return 0.005 * (1 - sstep(0.083 - y, 0, 0.007));
}
const noseW = (y: number) => 0.0072 + 0.0058 * sstep(0.15 - y, 0, 0.055);

/** How far the face stands in front of (or behind) the ellipsoid at (x, y). */
function faceDz(f: FaceSpec, x: number, y: number): number {
  const ax = Math.abs(x);
  let d = 0;
  // Eye sockets under the brow, and the brow ridge over them.
  const sock = f.zombie ? 0.012 + 0.005 * f.gaunt : 0.009;
  d -= sock * g2((ax - EYE_X) / 0.025, (y - EYE_Y) / (f.zombie ? 0.019 : 0.016));
  d += f.brow * Math.exp(-(((y - 0.1605) / 0.0105) ** 2)) * Math.exp(-((ax / 0.078) ** 4));
  d -= 0.0035 * g2(ax / 0.014, (y - 0.147) / 0.009);
  // Nose: the ridge, and the wings round the nostrils.
  d += noseRidge(y) * f.nose * Math.exp(-((ax / noseW(y)) ** 2));
  d += 0.011 * f.nose * g2((ax - 0.0132) / 0.0072, (y - 0.0905) / 0.0078);
  // Cheekbones, and the hollows under them.
  d += (0.003 + 0.0035 * f.gaunt) * g2((ax - 0.07) / 0.022, (y - 0.108) / 0.015);
  d -= (0.0015 + 0.012 * f.gaunt) * g2((ax - 0.066) / 0.022, (y - 0.062) / 0.027);
  // The mouth: the muzzle the teeth push out, the two lips and the line between, the fold
  // under the lower lip, the chin.
  const lip = f.lips * (1 - 0.7 * f.lipless);
  d += 0.0055 * g2(ax / 0.036, (y - 0.062) / 0.024);
  d += 0.0032 * lip * g2(ax / 0.021, (y - 0.0668) / 0.0042);
  d += 0.0042 * lip * g2(ax / 0.019, (y - 0.0545) / 0.0048);
  d -= 0.0035 * g2(ax / MOUTH_W, (y - MOUTH_Y) / 0.0022);
  d -= 0.0015 * g2(ax / 0.0035, (y - 0.0745) / 0.005);
  d -= 0.0035 * g2(ax / 0.024, (y - 0.0415) / 0.0065);
  d += (f.female ? 0.004 : 0.0065) * g2(ax / 0.024, (y - 0.02) / 0.017);
  d -= 0.002 * g2((ax - 0.031) / 0.006, (y - MOUTH_Y) / 0.006);
  // Lines from the nose's wings to the corners of the mouth on a wasted face.
  d -= 0.003 * f.gaunt * g2((ax - 0.028 - (0.085 - y) * 0.25) / 0.005, (y - 0.073) / 0.014);
  return d;
}

/** Where the face's surface is at (x, y), as built (mouth shut): brows, beards and teeth sit on this. */
export function faceZ(f: FaceSpec, x: number, y: number): number {
  return ez(x, y) + faceDz(f, x, y);
}

/** The jaw's hinge under the ears: the lower jaw and what is on it turn about this. */
const HINGE: V3 = [0, 0.095, -0.005];

/** Swings a point of the lower jaw open by `angle` about the hinge. */
export function jawSwing(p: THREE.Vector3, angle: number): THREE.Vector3 {
  const y = p.y - HINGE[1], z = p.z - HINGE[2];
  const c = Math.cos(angle), s = Math.sin(angle);
  return p.set(p.x, HINGE[1] + y * c - z * s, HINGE[2] + y * s + z * c);
}

// Grid lines: rows by height (packed round the eyes, nose and lips), columns by where they
// cross the face (packed between the cheekbones), then round the back of the skull.
const ROWS_FULL = [0.252, 0.234, 0.21, 0.186, 0.17, 0.159, 0.15, 0.1435, 0.138, 0.1325, 0.125, 0.114, 0.103, 0.096, 0.0895, 0.084, 0.077, 0.07, 0.0655, 0.0622, MOUTH_Y, 0.0588, 0.054, 0.047, 0.04, 0.029, 0.016, 0.003, -0.011];
const ROWS_LITE = [0.25, 0.212, 0.172, 0.159, 0.148, 0.138, 0.128, 0.114, 0.1, 0.0905, 0.082, 0.071, 0.0622, MOUTH_Y, 0.0588, 0.05, 0.038, 0.02, -0.012];
const COLS_FULL = [...[0, 0.0075, 0.015, 0.024, 0.033, 0.042, 0.051, 0.061, 0.073, 0.086].map((x) => Math.asin(x / HEAD_R[0])), 1.0, 1.2, 1.42, 1.65, 1.95, 2.3, 2.7, Math.PI];
const COLS_LITE = [...[0, 0.011, 0.024, 0.042, 0.061, 0.082].map((x) => Math.asin(x / HEAD_R[0])), 1.0, 1.5, 2.2, Math.PI];

/** What is painted over the skin: color (linear r, g, b) and how much of it, by where on the face. */
export type FacePaint = (x: number, y: number, a: number, out: Float32Array) => void;

/**
 * The head's skin: one closed, smooth surface. `paint` (if given) fills a `paint` attribute the
 * body builder lays over the skin color.
 */
export function headGeometry(f: FaceSpec, paint?: FacePaint): THREE.BufferGeometry {
  const rows = f.lite ? ROWS_LITE : ROWS_FULL;
  const half = f.lite ? COLS_LITE : COLS_FULL;
  // Columns all the way round: the front, down one side, the back, up the other.
  const cols = [...half, ...half.slice(1, -1).reverse().map((a) => -a)];
  const n = cols.length;
  const pos: number[] = [];
  const pnt: number[] = [];
  const v = new THREE.Vector3();
  const px = new Float32Array(4);
  const mouthRow = rows.indexOf(MOUTH_Y);
  // Painted by where a point is on the face as built (mouth shut), wherever the jaw has since taken it.
  const add = (x: number, y: number, z: number, bx: number, by: number, a: number) => {
    pos.push(x, y, z);
    px.fill(0);
    paint?.(bx, by, a, px);
    pnt.push(px[0], px[1], px[2], px[3]);
  };
  add(0, HEAD_C[1] + HEAD_R[1], 0, 0, HEAD_C[1] + HEAD_R[1], 0);
  rows.forEach((by, r) => {
    const st = Math.sqrt(Math.max(0, 1 - ((by - HEAD_C[1]) / HEAD_R[1]) ** 2));
    for (const a of cols) {
      const sa = Math.sin(a), ca = Math.cos(a), aa = Math.abs(a);
      const bx = HEAD_R[0] * st * sa;
      const front = sstep(ca, 0.2, 0.7);
      // The sides: the corner of the jaw under the ear, the temples sunk in beside the brow.
      const side = (f.female ? 0.002 : 0.006) * g2((by - 0.035) / 0.024, (aa - 1.2) / 0.4) - (0.0015 + 0.005 * f.gaunt) * g2((by - 0.166) / 0.03, (aa - 1.05) / 0.3);
      v.set(bx + sa * side, by, HEAD_R[2] * st * ca + ca * side + front * faceDz(f, bx, by));
      // The dead: lips drawn back off the teeth.
      if (f.lipless > 0 && r !== mouthRow) {
        const near = g2(bx / 0.03, (by - MOUTH_Y) / 0.009) * front;
        v.y += Math.sign(by - MOUTH_Y) * 0.0055 * f.lipless * near;
      }
      if (f.jaw > 0) {
        // The lower jaw swings open; the cheeks stretch between it and the skull.
        const w = sstep(ca, -0.15, 0.5);
        if (r > mouthRow) jawSwing(v, f.jaw * w);
        else if (r === mouthRow) {
          // The row between the lips is the back of the open mouth.
          jawSwing(v, f.jaw * w * 0.5);
          v.z -= 0.03 * front * (1 - sstep(Math.abs(bx), 0.018, 0.032));
        }
      }
      add(v.x, v.y, v.z, bx, by, a);
    }
  });
  add(0, HEAD_C[1] - HEAD_R[1], 0.004, 0, HEAD_C[1] - HEAD_R[1], 0);
  const idx: number[] = [];
  const at = (r: number, c: number) => 1 + r * n + ((c + n) % n);
  const last = 1 + rows.length * n;
  for (let c = 0; c < n; c++) {
    idx.push(0, at(0, c), at(0, c + 1));
    idx.push(last, at(rows.length - 1, c + 1), at(rows.length - 1, c));
    for (let r = 0; r + 1 < rows.length; r++) {
      const A = at(r, c), B = at(r, c + 1), C = at(r + 1, c + 1), D = at(r + 1, c);
      // Diagonals mirrored left to right.
      if (cols[c] >= 0 && cols[(c + 1) % n] > 0) idx.push(A, D, B, B, D, C);
      else idx.push(A, D, C, A, C, B);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (paint) g.setAttribute('paint', new THREE.Float32BufferAttribute(pnt, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ── Eyes and lids ────────────────────────────────────────────────────────────────────────

/** The shape of an eye's opening, in its own frame (x toward the outer corner). */
export interface EyeOpening {
  /** Half the width, the height above and below the eye line, and how far the outer corner rides up (slope). */
  a: number;
  up: number;
  down: number;
  tilt: number;
  /** Extra slope of the upper lid alone (a scowl drops its inner end). */
  lidTilt: number;
}

/** The ball of the lids, a little over the eyeball inside it. */
const LID_R: V3 = [0.0235, 0.0135, 0.0128];
export const EYEBALL_R: V3 = [0.0215, 0.0118, 0.0116];

/** Height of the upper and lower lid edges at u (-1 inner corner, 1 outer). */
export const lidUp = (e: EyeOpening, u: number) => e.up * (1 - Math.pow(Math.abs(u), 2.4)) + (e.tilt + e.lidTilt) * u * e.a - e.lidTilt * e.a * 0.4;
export const lidDown = (e: EyeOpening, u: number) => -e.down * (1 - u * u) + e.tilt * u * e.a;

const onBall = (R: V3, x: number, y: number, inf = 0) => (R[2] + inf) * Math.sqrt(Math.max(0, 1 - (x / (R[0] + inf)) ** 2 - (y / (R[1] + inf)) ** 2));

/**
 * One eyelid (eye frame: origin at the eyeball's centre, +Z out of the face, `s` the side): from
 * its edge on the eye back over the ball of the eye into the socket. `edge` paints the rim (the
 * lash line above, the wet rim below).
 */
export function lidGeometry(e: EyeOpening, s: number, upper: boolean, nu: number, edge: THREE.Color): THREE.BufferGeometry {
  const nv = 3;
  const pos: number[] = [], pnt: number[] = [], idx: number[] = [];
  const far = upper ? LID_R[1] * 1.02 : -LID_R[1] * 1.02;
  for (let i = 0; i <= nu; i++) {
    const u = -1 + (2 * i) / nu;
    const y0 = upper ? lidUp(e, u) : lidDown(e, u);
    // The rim, turned in against the eyeball.
    pos.push(s * u * e.a, y0, onBall(LID_R, u * e.a, y0) - 0.0022);
    pnt.push(edge.r, edge.g, edge.b, 1);
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      const x = u * e.a * (1 + 0.24 * t), y = y0 + (far - y0) * Math.pow(t, 0.85);
      pos.push(s * x, y, onBall(LID_R, x, y));
      pnt.push(edge.r, edge.g, edge.b, j === 0 ? 0.55 : 0);
    }
  }
  const w = nv + 2;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j + 1 < w; j++) {
      const A = i * w + j, B = (i + 1) * w + j, C = (i + 1) * w + j + 1, D = i * w + j + 1;
      if ((s > 0) === upper) idx.push(A, B, C, A, C, D);
      else idx.push(A, C, B, A, D, C);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('paint', new THREE.Float32BufferAttribute(pnt, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Both lids shut over the eye (a blink, the dead): one skin from the upper lid's line down to the lower's, the lashes along the join. */
export function shutLidGeometry(e: EyeOpening, s: number, nu: number, skin: THREE.Color, lash: THREE.Color): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const rows = 3;
  for (let i = 0; i <= nu; i++) {
    const u = -1 + (2 * i) / nu;
    const top = lidUp(e, u) + 0.0012, bottom = lidDown(e, u) - 0.0006;
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const y = top + (bottom - top) * t;
      pos.push(s * u * e.a * 1.04, y, onBall(LID_R, u * e.a, y, 0.0005));
      const c = j === rows ? lash : skin;
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < rows; j++) {
      const A = i * (rows + 1) + j, B = (i + 1) * (rows + 1) + j, C = B + 1, D = A + 1;
      if (s > 0) idx.push(A, D, C, A, C, B);
      else idx.push(A, C, D, A, B, C);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * An eyebrow lying on the brow ridge (head space): from near the nose out past the eye, thick
 * where it starts and thin at the tail, arched by `arch`, its outer end raised by `slope`.
 */
export function browGeometry(f: FaceSpec, s: number, y0: number, slope: number, thick: number, arch: number): THREE.BufferGeometry {
  const n = 6;
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = 0.013 + t * 0.057;
    const y = y0 + arch * Math.sin(Math.PI * Math.min(1, t * 1.25)) + slope * (x - 0.04);
    const h = thick * (t < 0.12 ? 0.75 : 1 - 0.72 * sstep(t, 0.3, 1)) * 0.5;
    for (const k of [1, -1]) pos.push(s * x, y + k * h, faceZ(f, x, y + k * h) + 0.0016);
  }
  // The hairs stand off the skin: a second layer in the middle makes it a solid strip from any side.
  for (let i = 0; i < n; i++) {
    const A = i * 2, B = A + 1, C = A + 3, D = A + 2;
    if (s > 0) idx.push(A, B, C, A, C, D);
    else idx.push(A, C, B, A, D, C);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ── Hair grown from the face ─────────────────────────────────────────────────────────────

/**
 * A layer lifted off part of the head's surface (a beard, a mustache): `lift(x, y, a)` is how
 * far it stands off the skin there, 0 or less where there is none. Open at its edges, which
 * taper into the skin.
 */
export function faceLayer(f: FaceSpec, lift: (x: number, y: number, a: number) => number): THREE.BufferGeometry {
  const src = headGeometry({ ...f, jaw: 0, lipless: 0 });
  const P = src.getAttribute('position') as THREE.BufferAttribute, N = src.getAttribute('normal') as THREE.BufferAttribute;
  const up = new Float32Array(P.count);
  const pos = new Float32Array(P.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const a = Math.atan2(x / HEAD_R[0], z / HEAD_R[2]);
    const h = lift(x, y, a);
    up[i] = h;
    const d = Math.max(h, -0.002);
    v.set(x + N.getX(i) * d, y + N.getY(i) * d, z + N.getZ(i) * d);
    if (f.jaw > 0 && y < MOUTH_Y) jawSwing(v, f.jaw * sstep(Math.cos(a), -0.15, 0.5));
    v.toArray(pos, i * 3);
  }
  const idx: number[] = [];
  const I = src.getIndex()!;
  for (let i = 0; i < I.count; i += 3) {
    const a = I.getX(i), b = I.getX(i + 1), c = I.getX(i + 2);
    // A triangle with any corner in the hair is drawn; its bare corners are tucked under the skin.
    if (up[a] > 0 || up[b] > 0 || up[c] > 0) idx.push(a, b, c);
  }
  src.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A row of teeth along the dental arch behind the lips: `upper` hangs from the gum line down,
 * the lower row stands up from the jaw (and swings with it). Each tooth is its own facet, a few
 * of them missing or broken (`rand`).
 */
export function teethGeometry(f: FaceSpec, upper: boolean, rand: () => number): THREE.BufferGeometry {
  const n = f.lite ? 7 : 10;
  const pos: number[] = [], idx: number[] = [], pnt: number[] = [];
  const c = new THREE.Color();
  const z0 = faceZ(f, 0, upper ? 0.064 : 0.057) - 0.0045;
  const gum = upper ? 0.0665 : 0.0535, tip = upper ? 0.0585 : 0.0605;
  const v = new THREE.Vector3();
  const arch = (t: number) => v.set(0.0245 * Math.sin(t), 0, z0 - 0.017 * (1 - Math.cos(t)));
  for (let i = 0; i < n; i++) {
    if (f.zombie && rand() < 0.14) continue;
    const t0 = -1.15 + (2.3 * i) / n, t1 = t0 + (2.3 / n) * 0.86;
    const len = f.zombie ? 0.7 + rand() * 0.35 : 1;
    const y1 = gum + (tip - gum) * len;
    const base = pos.length / 3;
    for (const [t, y] of [[t0, gum], [t1, gum], [t1, y1], [t0, y1]] as const) {
      arch(t);
      v.y = y;
      if (!upper && f.jaw > 0) jawSwing(v, f.jaw);
      pos.push(v.x, v.y, v.z);
    }
    if (upper) idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    else idx.push(base, base + 2, base + 3, base, base + 1, base + 2);
    c.setHex(f.zombie ? [0xb9ad86, 0xa39670, 0xc7bd98, 0x8d7f5c][Math.floor(rand() * 4)] : 0xe4dfd0);
    // Stained dark at the gum.
    for (let k = 0; k < 4; k++) pnt.push(c.r * (k < 2 ? 0.45 : 1), c.g * (k < 2 ? 0.38 : 1), c.b * (k < 2 ? 0.34 : 1), 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('paint', new THREE.Float32BufferAttribute(pnt, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * An ear (frame: its middle on the side of the head, +X out from the skull, +Z forward): the
 * rim, the bowl inside it and the lobe, leaning back and standing a little off the head.
 */
export function earGeometry(s: number, lite: boolean): THREE.BufferGeometry {
  // Outline of the ear seen from the side (z forward, y up), from the lobe round the rim.
  const out: [number, number][] = lite
    ? [[0.004, -0.031], [-0.008, -0.02], [-0.014, 0.004], [-0.011, 0.026], [0.0, 0.034], [0.008, 0.024], [0.008, -0.012]]
    : [[0.005, -0.031], [-0.004, -0.029], [-0.01, -0.018], [-0.0145, -0.002], [-0.0145, 0.014], [-0.011, 0.027], [-0.003, 0.034], [0.005, 0.032], [0.009, 0.022], [0.009, 0.004], [0.008, -0.014]];
  const pos: number[] = [], idx: number[] = [];
  const n = out.length;
  // Rim standing proud, the bowl sunk inside it, a back face so it is solid from behind.
  const rimX = 0.0115, bowlX = 0.0035, backX = 0.004;
  for (const [z, y] of out) pos.push(s * rimX * (0.55 + 0.45 * sstep(-z, -0.01, 0.012)), y, z);
  for (const [z, y] of out) pos.push(s * bowlX, y * 0.62 + 0.002, z * 0.55 + 0.001);
  for (const [z, y] of out) pos.push(s * backX, y * 0.86, z * 0.9 - 0.004);
  const c0 = pos.length / 3;
  pos.push(s * 0.0015, 0.002, 0.0005, -s * 0.002, 0, -0.006);
  const tri = (a: number, b: number, c: number) => (s > 0 ? idx.push(a, b, c) : idx.push(a, c, b));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // Rim down into the bowl, the bowl's floor, the rim round to the back, the back.
    tri(i, j, n + j);
    tri(i, n + j, n + i);
    tri(n + i, n + j, c0);
    tri(j, i, 2 * n + i);
    tri(j, 2 * n + i, 2 * n + j);
    tri(2 * n + j, 2 * n + i, c0 + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
