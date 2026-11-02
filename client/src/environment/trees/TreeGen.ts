import * as THREE from 'three';
import { LEAF_CELL, type LeafCell } from './TreeTextures';

/**
 * Procedural tree models: real trunks and branches (tapered tubes with bark uvs) carrying
 * alpha-tested leaf cards, in two levels of detail per model. Every vertex carries the wind
 * weights the sway shader reads (`aWind`): x how far out on a branch it is (branch sway),
 * y leaf flutter, z the branch's phase, w how far up the tree it is (the whole tree's bend).
 * Leaf normals are bent outward from the crown's centre so a crown shades as one soft mass
 * instead of a pile of flat cards; vertex colours hold the self-shadowing inside the crown.
 */

export type Species = 'broadleaf' | 'pine' | 'bush';

export interface TreeParts {
  bark: THREE.BufferGeometry | null;
  leaves: THREE.BufferGeometry;
}

export interface TreeModel {
  species: Species;
  /** [near, middle distance]. */
  lods: [TreeParts, TreeParts];
  /** Tallest point and widest reach from the trunk (m), for impostors and culling. */
  height: number;
  radius: number;
  /** Where the light probes sit (m above the base): low and high in the crown. */
  probeLow: number;
  probeHigh: number;
}

function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

/** Accumulates one mesh part's vertices. */
class Builder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly wind: number[] = [];
  readonly idx: number[] = [];

  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, shade: THREE.Color | number, sway: number, flutter: number, phase: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    if (typeof shade === 'number') this.col.push(shade, shade, shade);
    else this.col.push(shade.r, shade.g, shade.b);
    this.wind.push(sway, flutter, phase, 0);
    return this.pos.length / 3 - 1;
  }

  get count(): number {
    return this.pos.length / 3;
  }

  /** Sets every vertex's bend weight from its height (0 at the foot, 1 at the top). */
  finish(height: number): THREE.BufferGeometry {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const h = Math.max(0, this.pos[i * 3 + 1]) / height;
      this.wind[i * 4 + 3] = Math.min(1.2, h * h);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 4));
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** The model's real extent (tallest point, widest reach from the trunk) over both levels. */
function extent(lods: TreeParts[]): { height: number; radius: number } {
  let height = 0, radius = 0;
  for (const p of lods) {
    for (const g of [p.bark, p.leaves]) {
      if (!g) continue;
      const a = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) {
        height = Math.max(height, a.getY(i));
        radius = Math.max(radius, Math.hypot(a.getX(i), a.getZ(i)));
      }
    }
  }
  return { height, radius };
}

/** A branch as built: its centre line, how its sway weight grows along it, and its phase. */
interface Limb {
  pts: THREE.Vector3[];
  r0: number;
  r1: number;
  sway0: number;
  sway1: number;
  phase: number;
}

const limbAt = (l: Limb, t: number, out = V()): THREE.Vector3 => {
  const f = t * (l.pts.length - 1);
  const i = Math.min(l.pts.length - 2, Math.floor(f));
  return out.copy(l.pts[i]).lerp(l.pts[i + 1], f - i);
};
const limbDir = (l: Limb, t: number): THREE.Vector3 => {
  const f = t * (l.pts.length - 1);
  const i = Math.min(l.pts.length - 2, Math.floor(f));
  return V().subVectors(l.pts[i + 1], l.pts[i]).normalize();
};
const swayAt = (l: Limb, t: number) => l.sway0 + (l.sway1 - l.sway0) * Math.pow(t, 1.3);

/**
 * A tapered tube along a limb (parallel-transported rings), bark uv: u around (this kind's half of
 * the bark atlas), v along the length in units of the base circumference.
 */
function tube(b: Builder, l: Limb, sides: number, barkU0: number, shade: (p: THREE.Vector3) => number, flare = 0): void {
  const n = l.pts.length;
  let normal = V(1, 0, 0);
  const t0 = V().subVectors(l.pts[1], l.pts[0]).normalize();
  if (Math.abs(t0.dot(normal)) > 0.9) normal.set(0, 0, 1);
  normal = V().crossVectors(t0, normal).normalize();
  let along = 0;
  const circ = Math.max(0.15, Math.PI * 2 * l.r0);
  const first = b.count;
  const tan = V(), bin = V(), off = V(), p = V();
  for (let i = 0; i < n; i++) {
    const a = l.pts[Math.max(0, i - 1)], c = l.pts[Math.min(n - 1, i + 1)];
    tan.subVectors(c, a).normalize();
    // Parallel transport: keep the ring frame from twisting along the limb.
    normal.sub(tan.clone().multiplyScalar(normal.dot(tan))).normalize();
    bin.crossVectors(tan, normal);
    if (i > 0) along += l.pts[i].distanceTo(l.pts[i - 1]);
    const t = i / (n - 1);
    let r = l.r0 + (l.r1 - l.r0) * Math.pow(t, 0.8);
    if (flare > 0) r += flare * Math.exp(-l.pts[i].y * 5);
    for (let j = 0; j <= sides; j++) {
      const ang = (j / sides) * Math.PI * 2;
      off.copy(normal).multiplyScalar(Math.cos(ang)).addScaledVector(bin, Math.sin(ang));
      p.copy(l.pts[i]).addScaledVector(off, r);
      b.vert(p, off, barkU0 + (j / sides) * 0.5, along / circ, shade(p), swayAt(l, t), 0, l.phase);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = first + i * ring + j, c = a + ring;
      b.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
}

/**
 * One leaf card: `along` from the stem end to the tip, `across` its width (both full lengths).
 * Normals blend from the card's own toward `outward(p)`; flutter grows toward the tip.
 */
function card(
  b: Builder, base: THREE.Vector3, along: THREE.Vector3, across: THREE.Vector3, cell: LeafCell,
  outward: (p: THREE.Vector3) => THREE.Vector3, bend: number, shade: (p: THREE.Vector3) => number,
  tint: THREE.Color, sway: number, phase: number,
): void {
  const [u0, v0, u1, v1] = LEAF_CELL[cell];
  const face = V().crossVectors(across, along).normalize();
  const first = b.count;
  const corners: [number, number][] = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
  const p = V(), n = V(), c = new THREE.Color();
  for (const [x, y] of corners) {
    p.copy(base).addScaledVector(across, x).addScaledVector(along, y);
    const out = outward(p);
    // Keep the face's own side: a card facing in still shades like the crown's surface.
    n.copy(face).multiplyScalar(face.dot(out) >= 0 ? 1 : -1).lerp(out, bend).normalize();
    c.copy(tint).multiplyScalar(shade(p));
    b.vert(p, n, x < 0 ? u0 : u1, y === 0 ? v0 : v1, c, sway, y === 0 ? 0.15 : 1, phase);
  }
  b.idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
}

/** A unit vector perpendicular to `d`, rolled by `roll` around it. */
function perp(d: THREE.Vector3, roll: number): THREE.Vector3 {
  const side = V().crossVectors(d, Math.abs(d.y) > 0.95 ? V(1, 0, 0) : UP).normalize();
  const up = V().crossVectors(side, d).normalize();
  return side.multiplyScalar(Math.cos(roll)).addScaledVector(up, Math.sin(roll));
}

/** Slight per-card colour variation (some leaves warmer or paler). */
function cardTint(r: () => number): THREE.Color {
  const k = 0.85 + r() * 0.3;
  const warm = r() < 0.25 ? 0.12 : 0;
  return new THREE.Color(k * (1 + warm), k, k * (1 - warm * 1.4));
}

/** Maple leaves stay above this (m), so nobody walks with their head in a crown. */
const MIN_LEAF_Y = 2.25;

/**
 * A broadleaf (maple) crown: trunk with root flare, main limbs spreading up and out to the crown's
 * edge, twigs off each limb, leaf sprigs along the twigs and at their tips.
 */
export function broadleaf(variant: number): TreeModel {
  const r = rng(1000 + variant * 77);
  const crownY = 4.0 + (variant % 3) * 0.6;
  const R = 2.35 + (variant % 3) * 0.2;
  const Ry = 1.85 + (variant % 3) * 0.2;
  const C = V(0, crownY, 0);
  const trunkTop = crownY + Ry * 0.35;
  const height = crownY + Ry + 0.35;
  const rBase = 0.19 + (variant % 3) * 0.03;
  const lean = V((r() - 0.5) * 0.35, 0, (r() - 0.5) * 0.35);
  const trunk: Limb = { pts: [], r0: rBase, r1: 0.06, sway0: 0, sway1: 0.05, phase: r() };
  for (let i = 0; i <= 9; i++) {
    const t = i / 9;
    trunk.pts.push(V(lean.x * t * t + Math.sin(t * 5 + variant) * 0.04, -0.15 + t * (trunkTop + 0.15), lean.z * t * t + Math.cos(t * 4 + variant) * 0.04));
  }
  const trunkR = (y: number) => rBase + (0.06 - rBase) * Math.pow(Math.min(1, y / trunkTop), 0.8);
  // Ellipsoid crown: how far from C to its edge in a direction.
  const edge = (d: THREE.Vector3) => 1 / Math.sqrt((d.x * d.x + d.z * d.z) / (R * R) + (d.y * d.y) / (Ry * Ry));
  const outward = (p: THREE.Vector3) => V((p.x - C.x) / (R * R), (p.y - C.y) / (Ry * Ry) + 0.15, (p.z - C.z) / (R * R)).normalize();
  const toShell = (o: THREE.Vector3, d: THREE.Vector3) => {
    const q = V((o.x - C.x) / R, (o.y - C.y) / Ry, (o.z - C.z) / R);
    const e = V(d.x / R, d.y / Ry, d.z / R);
    const a = e.lengthSq(), b = q.dot(e), c = q.lengthSq() - 1;
    return (-b + Math.sqrt(Math.max(0, b * b - a * c))) / a;
  };
  // Inside the crown is darker (leaves shade each other); its underside more than its top.
  const leafShade = (p: THREE.Vector3) => {
    const q = Math.sqrt(((p.x - C.x) ** 2 + (p.z - C.z) ** 2) / (R * R) + ((p.y - C.y) ** 2) / (Ry * Ry));
    const up = THREE.MathUtils.clamp((p.y - (C.y - Ry)) / (2 * Ry), 0, 1);
    return (0.38 + 0.62 * THREE.MathUtils.smoothstep(q, 0.2, 1.0)) * (0.72 + 0.28 * up);
  };
  const barkShade = (p: THREE.Vector3) => {
    const inCrown = p.y > C.y - Ry ? 0.72 : 1;
    return (0.62 + 0.38 * THREE.MathUtils.smoothstep(p.y, 0, 1.6)) * inCrown;
  };

  // Main limbs: spread around the trunk (golden angle), lower ones flatter.
  const limbs: Limb[] = [];
  const nLimbs = 7 + (variant % 2);
  const low = Math.max(2.5, crownY - Ry * 0.75);
  for (let i = 0; i < nLimbs; i++) {
    const f = i / (nLimbs - 1);
    const y = low + (trunkTop - 0.25 - low) * f + (r() - 0.5) * 0.2;
    const az = i * 2.39996 + r() * 0.6 + variant;
    const elev = THREE.MathUtils.lerp(0.35, 1.0, f) + (r() - 0.5) * 0.2;
    const o = limbAt(trunk, (y + 0.15) / (trunkTop + 0.15));
    const dir = V(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    // Reach most of the way to the crown's edge (ray from the limb's base to the ellipsoid).
    const len = Math.max(1.0, toShell(o, dir) * (0.78 + r() * 0.14));
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      // Arching: rises early, droops a little at the end.
      pts.push(o.clone().addScaledVector(dir, len * t).add(V(0, Math.sin(t * Math.PI) * len * 0.12 - t * t * len * 0.12, 0)));
    }
    limbs.push({ pts, r0: trunkR(y) * 0.62, r1: 0.022, sway0: 0.05, sway1: 0.55, phase: r() });
  }
  // Twigs off each limb.
  const twigs: Limb[] = [];
  for (const l of limbs) {
    const n = 4 + (r() < 0.5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const t = 0.3 + (k / n) * 0.65 + r() * 0.05;
      const o = limbAt(l, t);
      const d = limbDir(l, t).add(perp(limbDir(l, t), r() * Math.PI * 2).multiplyScalar(0.9)).add(V(0, 0.35, 0)).normalize();
      const len = 0.55 + r() * 0.5;
      const pts = [0, 0.5, 1].map((s) => o.clone().addScaledVector(d, len * s).add(V(0, -s * s * 0.08, 0)));
      twigs.push({ pts, r0: Math.max(0.018, l.r0 * 0.35 * (1 - t * 0.5)), r1: 0.008, sway0: swayAt(l, t), sway1: Math.min(1, swayAt(l, t) + 0.4), phase: l.phase + (r() - 0.5) * 0.3 });
    }
  }

  const parts = (near: boolean): TreeParts => {
    const bark = new Builder();
    tube(bark, trunk, near ? 9 : 6, 0, barkShade, 0.16);
    for (const l of limbs) tube(bark, l, near ? 5 : 4, 0, barkShade);
    if (near) for (const t of twigs) tube(bark, t, 3, 0, barkShade);
    const leaves = new Builder();
    const rr = rng(2000 + variant);
    const sprig = (at: THREE.Vector3, dir: THREE.Vector3, size: number, sway: number, phase: number, cell: LeafCell, cross: boolean) => {
      const out = outward(at);
      // Sprigs point out of the crown, turned toward their twig.
      const along = dir.clone().multiplyScalar(0.55).add(out).add(V((rr() - 0.5) * 0.6, (rr() - 0.3) * 0.5, (rr() - 0.5) * 0.6)).normalize();
      // Under the crown they hang no lower than head height plus a little.
      along.y = Math.max(along.y, -0.25);
      along.normalize();
      const roll = rr() * Math.PI;
      const tint = cardTint(rr);
      const base = at.clone().addScaledVector(along, -size * 0.2);
      base.y = Math.max(base.y, MIN_LEAF_Y + size * 0.55 + Math.max(0, -along.y) * size);
      card(leaves, base, along.clone().multiplyScalar(size), perp(along, roll).multiplyScalar(size * 0.95), cell, outward, 0.72, leafShade, tint, sway, phase);
      if (cross) card(leaves, base, along.clone().multiplyScalar(size), perp(along, roll + Math.PI / 2).multiplyScalar(size * 0.95), cell, outward, 0.72, leafShade, tint, sway, phase);
    };
    if (near) {
      for (const t of twigs) {
        for (const s of [0.45, 0.8, 1]) sprig(limbAt(t, s), limbDir(t, s), 1.1 + rr() * 0.4, swayAt(t, s), t.phase, 'maple', true);
      }
      for (const l of limbs) {
        for (const s of [0.6, 0.85, 1]) sprig(limbAt(l, s), limbDir(l, s), 1.2 + rr() * 0.35, swayAt(l, s), l.phase, 'maple', true);
      }
      // Fill: sprigs pushed out from points along the limbs toward the crown's shell (never floating).
      for (let k = 0; k < 30; k++) {
        const l = limbs[k % limbs.length];
        const s = 0.45 + rr() * 0.55;
        const from = limbAt(l, s);
        const d = V().subVectors(from, C).add(V(rr() - 0.5, rr() * 0.6 - 0.2, rr() - 0.5)).normalize();
        const at = from.clone().addScaledVector(d, Math.min(0.9, toShell(from, d) * 0.6));
        sprig(at, d, 1.15 + rr() * 0.35, swayAt(l, s) + 0.1, l.phase, 'maple', false);
      }
    } else {
      // Middle distance: fewer, bigger, denser clusters on the limbs.
      for (const l of limbs) {
        for (const s of [0.45, 0.75, 1]) sprig(limbAt(l, s), limbDir(l, s), 1.75 + rr() * 0.35, swayAt(l, s), l.phase, 'mapleDense', true);
      }
      for (let k = 0; k < 8; k++) {
        const d = V(rr() - 0.5, (rr() - 0.3) * 0.9, rr() - 0.5).normalize();
        const at = C.clone().addScaledVector(d, edge(d) * 0.6);
        sprig(at, d, 1.9, 0.5, rr(), 'mapleDense', true);
      }
    }
    return { bark: bark.finish(height), leaves: leaves.finish(height) };
  };
  const lods: [TreeParts, TreeParts] = [parts(true), parts(false)];
  return { species: 'broadleaf', lods, ...extent(lods), probeLow: crownY - Ry * 0.6, probeHigh: crownY + Ry * 0.6 };
}

/**
 * A conifer: straight trunk, whorls of drooping branches shortening toward the spire, needle
 * sprays (two crossed cards) along each branch. The lowest whorls in a forest are often dead:
 * `bare` metres at the foot carry bare stubs instead.
 */
export function pine(variant: number): TreeModel {
  const r = rng(3000 + variant * 131);
  const k = 1 + (variant % 3) * 0.15;
  const height = 7.2 * k;
  const y0 = 1.15;
  const rBase = 0.2 * k;
  const trunk: Limb = { pts: [], r0: rBase, r1: 0.025, sway0: 0, sway1: 0.15, phase: r() };
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    trunk.pts.push(V(Math.sin(t * 3 + variant) * 0.05, -0.15 + t * (height + 0.15), Math.cos(t * 2.5 + variant) * 0.05));
  }
  const reach = 2.1 * k;
  const branchLen = (y: number) => 0.3 + reach * Math.pow(Math.max(0, 1 - (y - y0) / (height - y0)), 0.85);
  const outward = (p: THREE.Vector3) => V(p.x, 0.55 + (p.y - y0) / height * 0.4, p.z).normalize();
  const leafShade = (p: THREE.Vector3) => {
    const d = Math.hypot(p.x, p.z) / Math.max(0.4, branchLen(p.y));
    const up = THREE.MathUtils.clamp(p.y / height, 0, 1);
    return (0.52 + 0.48 * THREE.MathUtils.smoothstep(d, 0.15, 1)) * (0.8 + 0.2 * up);
  };
  const barkShade = (p: THREE.Vector3) => (0.55 + 0.45 * THREE.MathUtils.smoothstep(p.y, 0, 1.4)) * (p.y > y0 ? 0.7 : 1);
  interface Branch { limb: Limb; len: number }
  const whorls = (spacing: number, per: number) => {
    const out: Branch[] = [];
    let w = 0;
    for (let y = y0; y < height - 0.45; y += spacing * (0.9 + r() * 0.2), w++) {
      const n = per + (r() < 0.3 ? 1 : 0);
      const len = branchLen(y);
      const hr = (y - y0) / (height - y0);
      for (let i = 0; i < n; i++) {
        const az = (i / n) * Math.PI * 2 + w * 0.9 + (r() - 0.5) * 0.5;
        // Lower branches droop, upper ones reach up.
        const pitch = THREE.MathUtils.lerp(-0.22, 0.35, hr) + (r() - 0.5) * 0.15;
        const dir = V(Math.cos(az) * Math.cos(pitch), Math.sin(pitch), Math.sin(az) * Math.cos(pitch));
        const o = limbAt(trunk, (y + 0.15) / (height + 0.15));
        const pts = [0, 0.35, 0.7, 1].map((t) => o.clone().addScaledVector(dir, len * t).add(V(0, -t * t * len * 0.22, 0)));
        out.push({ len, limb: { pts, r0: Math.max(0.02, rBase * (1 - hr) * 0.32), r1: 0.008, sway0: 0.1 + hr * 0.15, sway1: 0.55 + hr * 0.3, phase: r() } });
      }
    }
    return out;
  };
  const near = whorls(0.42 * k, 5);
  const mid = whorls(0.66 * k, 4);
  const parts = (isNear: boolean): TreeParts => {
    const list = isNear ? near : mid;
    const bark = new Builder();
    tube(bark, trunk, isNear ? 8 : 5, 0.5, barkShade, 0.1);
    if (isNear) for (const b of list) tube(bark, b.limb, 3, 0.5, barkShade);
    const leaves = new Builder();
    const rr = rng(4000 + variant);
    for (const b of list) {
      const d = limbDir(b.limb, 0.5);
      const tint = cardTint(rr);
      const start = limbAt(b.limb, isNear ? 0.12 : 0.05);
      const along = V().subVectors(limbAt(b.limb, 1), start).multiplyScalar(1.12);
      // Sprays wide enough to close the gaps between whorls, crossed in an X around the branch.
      const width = (isNear ? 0.7 : 1.3) + b.len * (isNear ? 0.28 : 0.44);
      // Three sprays in a star round the branch near, two in an X further out: full from any side.
      for (const roll of isNear ? [0.15, 1.2, -0.95] : [0.75, Math.PI - 0.75]) {
        card(leaves, start, along, perp(d, roll + (rr() - 0.5) * 0.3).multiplyScalar(width), 'pine', outward, 0.6, leafShade, tint, swayAt(b.limb, 0.6), b.limb.phase);
      }
    }
    // The spire: crossed upright sprays over the top whorl.
    const top = V(trunk.pts[10].x, height - 1.5 * k, trunk.pts[10].z);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      card(leaves, top, V(0, 1.6 * k, 0), V(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.75 * k), 'pine', outward, 0.5, leafShade, cardTint(rr), 0.6, trunk.phase);
    }
    return { bark: bark.finish(height), leaves: leaves.finish(height) };
  };
  const lods: [TreeParts, TreeParts] = [parts(true), parts(false)];
  return { species: 'pine', lods, ...extent(lods), probeLow: height * 0.3, probeHigh: height * 0.72 };
}

/**
 * The outline pine impostors are drawn with (x -0.5..0.5 across the billboard, y 0..1 up it):
 * full width up to a third of the height, then tapering to the spire.
 */
export const PINE_OUTLINE: [number, number][] = [[-0.5, 0], [0.5, 0], [0.5, 0.32], [0.16, 1], [-0.16, 1], [-0.5, 0.32]];

/** Half-width of PINE_OUTLINE at height y (0..1). */
export function pineOutlineHalf(y: number): number {
  return y <= 0.32 ? 0.5 : 0.5 - (0.34 * (y - 0.32)) / 0.68;
}

/** A shrub: leaf cards around a squashed ball, normals from its centre. */
export function bush(variant: number): TreeModel {
  const height = 1.15 + (variant % 2) * 0.2;
  const R = 0.85 + (variant % 2) * 0.12;
  const C = V(0, height * 0.48, 0);
  const outward = (p: THREE.Vector3) => V((p.x - C.x) / R, (p.y - C.y) / (height * 0.5) + 0.25, (p.z - C.z) / R).normalize();
  const shade = (p: THREE.Vector3) => {
    const q = Math.sqrt(((p.x - C.x) ** 2 + (p.z - C.z) ** 2) / (R * R) + ((p.y - C.y) / (height * 0.55)) ** 2);
    return (0.4 + 0.6 * THREE.MathUtils.smoothstep(q, 0.1, 1)) * (0.65 + 0.35 * THREE.MathUtils.clamp(p.y / height, 0, 1));
  };
  const parts = (near: boolean): TreeParts => {
    const rr = rng(5000 + variant * 17 + (near ? 0 : 1));
    const leaves = new Builder();
    const n = near ? 30 : 11;
    for (let i = 0; i < n; i++) {
      const d = V(rr() - 0.5, rr() * 0.8 - 0.15, rr() - 0.5).normalize();
      const at = C.clone().add(V(d.x * R, d.y * height * 0.5, d.z * R).multiplyScalar(near ? 0.55 + rr() * 0.35 : 0.5));
      const size = near ? 0.6 + rr() * 0.2 : 1.0 + rr() * 0.15;
      const along = d.clone().add(V((rr() - 0.5) * 0.8, 0.3, (rr() - 0.5) * 0.8)).normalize();
      const base = at.clone().addScaledVector(along, -size * 0.45);
      const roll = rr() * Math.PI;
      card(leaves, base, along.clone().multiplyScalar(size), perp(along, roll).multiplyScalar(size), 'bush', outward, 0.8, shade, cardTint(rr), 0.35 + 0.4 * (d.y * 0.5 + 0.5), rr());
      if (!near) card(leaves, base, along.clone().multiplyScalar(size), perp(along, roll + Math.PI / 2).multiplyScalar(size), 'bush', outward, 0.8, shade, cardTint(rr), 0.5, rr());
    }
    return { bark: null, leaves: leaves.finish(height) };
  };
  const lods: [TreeParts, TreeParts] = [parts(true), parts(false)];
  return { species: 'bush', lods, ...extent(lods), probeLow: height * 0.3, probeHigh: height * 0.8 };
}
