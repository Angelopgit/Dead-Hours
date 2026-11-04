import * as THREE from 'three';
import { rng } from '@dead-hours/shared';

/**
 * Tree textures drawn on a canvas at startup (no files, so the single-file build has them too):
 * a leaf atlas with alpha (maple sprigs, a dense maple cluster for the middle distance, pine
 * needle sprays, small bush leaves) and tileable bark for broadleaf and pine trunks with normal
 * maps. Colours are near-grey: species and per-tree tints come from the material, so one atlas
 * serves green, autumn and dry trees.
 */

/**
 * Lets go of a data texture's pixels once they are on the GPU (several MB of heap otherwise kept
 * for nothing: these textures are never re-uploaded).
 */
export function releaseAfterUpload(t: THREE.DataTexture): THREE.DataTexture {
  t.onUpdate = () => {
    (t.image as { data: unknown }).data = null;
    t.onUpdate = null;
  };
  return t;
}

/** Cells of the leaf atlas (2 x 2), as uv rectangles [u0, v0, u1, v1]. */
export const LEAF_CELL = {
  maple: [0, 0.5, 0.5, 1],
  mapleDense: [0.5, 0.5, 1, 1],
  pine: [0, 0, 0.5, 0.5],
  bush: [0.5, 0, 1, 0.5],
} as const satisfies Record<string, readonly [number, number, number, number]>;
export type LeafCell = keyof typeof LEAF_CELL;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}

/** Grey with a small warm/cool cast, as a CSS colour. */
function grey(v: number, warm: number): string {
  const r = Math.round(Math.min(255, v * (1 + warm * 0.08)));
  const g = Math.round(Math.min(255, v));
  const b = Math.round(Math.min(255, v * (1 - warm * 0.12)));
  return `rgb(${r},${g},${b})`;
}

/**
 * Draws into two canvases at once: `col` (colour, every stroke) and `mask` (white where opaque).
 * The colour canvas is pre-filled with the average leaf tone so texels outside the leaves (which
 * mipmaps blend in at the edges) keep a leaf colour instead of black.
 */
class Pair {
  constructor(readonly col: CanvasRenderingContext2D, readonly mask: CanvasRenderingContext2D) {}
  path(build: (c: CanvasRenderingContext2D) => void, fill: string | CanvasGradient | null, stroke?: { style: string; width: number }): void {
    for (const c of [this.col, this.mask]) {
      c.beginPath();
      build(c);
      const isMask = c === this.mask;
      if (fill) {
        c.fillStyle = isMask ? '#fff' : fill;
        c.fill();
      }
      if (stroke) {
        c.strokeStyle = isMask ? '#fff' : stroke.style;
        c.lineWidth = stroke.width;
        c.stroke();
      }
    }
  }
  /** Colour-only detail (veins) that doesn't change coverage. */
  detail(build: (c: CanvasRenderingContext2D) => void, style: string, width: number): void {
    const c = this.col;
    c.beginPath();
    build(c);
    c.strokeStyle = style;
    c.lineWidth = width;
    c.stroke();
  }
}

/** A maple leaf (five pointed lobes) or an ovate leaf, stem at the origin, pointing up (-y). */
function leafPath(c: CanvasRenderingContext2D, size: number, maple: boolean, r: () => number): void {
  if (maple) {
    const n = 40;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      // Five lobes, the side ones shorter; a notch where the stem joins.
      const lobe = Math.pow(Math.abs(Math.cos(a * 2.5)), 0.7);
      const side = 0.75 + 0.25 * Math.cos(a);
      const notch = 1 - 0.55 * Math.exp(-Math.pow((a - Math.PI) * 2.2, 2));
      const rad = size * (0.42 + 0.58 * lobe) * side * notch * (0.92 + r() * 0.1);
      const x = Math.sin(a) * rad;
      const y = -Math.cos(a) * rad - size * 0.55;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
  } else {
    const w = size * (0.42 + r() * 0.12);
    c.moveTo(0, 0);
    c.bezierCurveTo(w, -size * 0.3, w * 0.8, -size * 0.95, 0, -size * 1.25);
    c.bezierCurveTo(-w * 0.8, -size * 0.95, -w, -size * 0.3, 0, 0);
    c.closePath();
  }
}

function drawLeaf(p: Pair, x: number, y: number, ang: number, size: number, maple: boolean, r: () => number, base: number): void {
  const v = base * (0.78 + r() * 0.38);
  const warm = r() * 2 - 0.6;
  const seed = r() * 1e9;
  for (const c of [p.col, p.mask]) {
    c.save();
    c.translate(x, y);
    c.rotate(ang);
  }
  const rr = rng(seed);
  p.path((c) => leafPath(c, size, maple, rr), grey(v, warm));
  // Lighter midrib and side veins, a darker rim.
  p.detail((c) => {
    c.moveTo(0, 0);
    c.lineTo(0, -size * (maple ? 1.25 : 1.15));
    if (maple) {
      for (const s of [-1, 1]) {
        c.moveTo(0, -size * 0.55);
        c.lineTo(s * size * 0.7, -size * 0.95);
        c.moveTo(0, -size * 0.5);
        c.lineTo(s * size * 0.75, -size * 0.35);
      }
    } else {
      for (let k = 1; k < 5; k++) {
        for (const s of [-1, 1]) {
          c.moveTo(0, -size * k * 0.22);
          c.lineTo(s * size * 0.3, -size * (k * 0.22 + 0.16));
        }
      }
    }
  }, grey(v * 1.25, warm), Math.max(1, size * 0.04));
  const rr2 = rng(seed);
  p.detail((c) => leafPath(c, size, maple, rr2), grey(v * 0.6, warm), Math.max(1, size * 0.035));
  for (const c of [p.col, p.mask]) c.restore();
}

function twig(p: Pair, pts: [number, number][], w: number, shade: number): void {
  p.path((c) => {
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  }, null, { style: grey(shade, 1.5), width: w });
}

/** A maple sprig: a forked twig with leaves along and at the ends of each fork. */
function mapleCell(p: Pair, x0: number, y0: number, s: number, r: () => number, dense: boolean): void {
  const cx = x0 + s / 2;
  const forks = dense ? 7 : 5;
  // Dense clusters (middle distance) are bushier and fill more of the card.
  for (let f = 0; f < forks; f++) {
    const ang = -Math.PI / 2 + (f / (forks - 1) - 0.5) * (dense ? 2.2 : 1.6) + (r() - 0.5) * 0.25;
    const len = s * (dense ? 0.34 : 0.4) * (0.8 + r() * 0.35);
    const bx = cx + (r() - 0.5) * s * 0.06, by = y0 + s * 0.98;
    const mx = bx + Math.cos(ang) * len * 0.5, my = by - s * 0.18 + Math.sin(ang) * len * 0.5;
    const ex = bx + Math.cos(ang) * len, ey = by - s * 0.3 + Math.sin(ang) * len;
    twig(p, [[bx, by], [mx, my], [ex, ey]], s * 0.012, 70);
    const leaves = dense ? 7 : 6;
    for (let k = 0; k < leaves; k++) {
      const t = 0.3 + (k / leaves) * 0.8;
      const lx = bx + (ex - bx) * t + (r() - 0.5) * s * 0.07;
      const ly = by + (ey - by) * t + (r() - 0.5) * s * 0.07;
      const la = ang + Math.PI / 2 + (r() - 0.5) * 1.8;
      drawLeaf(p, lx, ly, la, s * (dense ? 0.095 : 0.115) * (0.75 + r() * 0.45), true, r, 205);
    }
  }
  // Fill the middle so a card reads as a mass of leaves, not a few on sticks.
  for (let k = 0; k < (dense ? 20 : 10); k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * s * (dense ? 0.3 : 0.24);
    drawLeaf(p, cx + Math.cos(a) * d, y0 + s * 0.42 + Math.sin(a) * d * 0.9, r() * Math.PI * 2, s * 0.09 * (0.8 + r() * 0.4), true, r, 180);
  }
}

/** A pine spray: the twig runs from the bottom of the cell to the top, needles angled forward. */
function pineCell(p: Pair, x0: number, y0: number, s: number, r: () => number): void {
  const cx = x0 + s / 2;
  const spine = (t: number): [number, number] => [cx + Math.sin(t * 2.2) * s * 0.03, y0 + s * (0.98 - t * 0.94)];
  // Side shoots.
  const shoots: { t: number; side: number; len: number }[] = [];
  for (let i = 0; i < 10; i++) shoots.push({ t: 0.08 + i * 0.085 + r() * 0.03, side: i % 2 ? 1 : -1, len: s * (0.34 - i * 0.022) * (0.85 + r() * 0.3) });
  const needles = (ax: number, ay: number, dx: number, dy: number, len: number, count: number, nl: number) => {
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const px = ax + dx * len * t, py = ay + dy * len * t;
      for (const side of [-1, 1]) {
        const a = Math.atan2(dy, dx) + side * (0.55 + r() * 0.45);
        const l = nl * (0.7 + r() * 0.5) * (1 - t * 0.35);
        const v = 150 + r() * 90;
        p.path((c) => {
          c.moveTo(px, py);
          c.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
        }, null, { style: grey(v, -0.3 + r() * 0.6), width: Math.max(1.5, s * 0.011) });
      }
    }
  };
  for (const sh of shoots) {
    const [ax, ay] = spine(sh.t);
    const a = -Math.PI / 2 + sh.side * (0.75 + r() * 0.3);
    const dx = Math.cos(a), dy = Math.sin(a);
    twig(p, [[ax, ay], [ax + dx * sh.len, ay + dy * sh.len]], s * 0.008, 75);
    needles(ax, ay, dx, dy, sh.len, 12, s * 0.085);
  }
  const pts: [number, number][] = [];
  for (let i = 0; i <= 10; i++) pts.push(spine(i / 10));
  twig(p, pts, s * 0.016, 70);
  needles(pts[0][0], pts[0][1], 0, -1, s * 0.92, 34, s * 0.1);
}

/** Small round leaves packed into a rough ball (hedges and shrubs). */
function bushCell(p: Pair, x0: number, y0: number, s: number, r: () => number): void {
  const cx = x0 + s / 2, cy = y0 + s / 2;
  for (let k = 0; k < 150; k++) {
    const a = r() * Math.PI * 2, d = Math.pow(r(), 0.65) * s * 0.42;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.92;
    const inner = 1 - d / (s * 0.42);
    drawLeaf(p, x, y, r() * Math.PI * 2, s * 0.06 * (0.8 + r() * 0.5), false, r, 170 + 45 * (1 - inner * 0.5));
  }
}

/** Packs colour (with leaf-toned texels outside the leaves) and coverage into one RGBA texture. */
function combine(col: CanvasRenderingContext2D, mask: CanvasRenderingContext2D, w: number, h: number): THREE.DataTexture {
  const c = col.getImageData(0, 0, w, h).data;
  const m = mask.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  // Canvas rows run top-down; textures bottom-up (flipY is off for data textures).
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4, dst = y * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      out[dst + x] = c[src + x];
      out[dst + x + 1] = c[src + x + 1];
      out[dst + x + 2] = c[src + x + 2];
      out[dst + x + 3] = m[src + x];
    }
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return releaseAfterUpload(t);
}

/** The leaf atlas at `size` x `size` (four cells, see LEAF_CELL). */
export function createLeafAtlas(size: number): THREE.DataTexture {
  const [, col] = canvas(size, size);
  const [, mask] = canvas(size, size);
  col.fillStyle = grey(150, 0);
  col.fillRect(0, 0, size, size);
  mask.fillStyle = '#000';
  mask.fillRect(0, 0, size, size);
  col.lineCap = mask.lineCap = 'round';
  col.lineJoin = mask.lineJoin = 'round';
  const p = new Pair(col, mask);
  const s = size / 2;
  // Canvas y runs down: the top half of the canvas is the top half of the texture (v 0.5..1).
  mapleCell(p, 0, 0, s, rng(11), false);
  mapleCell(p, s, 0, s, rng(23), true);
  pineCell(p, 0, s, s, rng(37));
  bushCell(p, s, s, s, rng(41));
  return combine(col, mask, size, size);
}

/** Bark kinds: the two halves of the bark atlas (u 0..0.5 broadleaf, 0.5..1 pine). */
export interface BarkMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
}

/**
 * Tileable bark, broadleaf (left half: long vertical furrows) and pine (right half: flaky plates),
 * with a normal map from the same height field.
 */
export function createBarkAtlas(w: number, h: number): BarkMaps {
  const half = w / 2;
  const height = new Float32Array(w * h);
  const r = rng(7);
  // Broadleaf: ridges between furrows that wander a little and split now and then.
  const ridges = 9;
  const phase = Array.from({ length: ridges }, () => r() * 6.28);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < half; x++) {
      const u = x / half, v = y / h;
      let best = 1;
      for (let i = 0; i < ridges; i++) {
        const cx = (i + 0.5) / ridges + Math.sin(v * Math.PI * 2 * 2 + phase[i]) * 0.025 + Math.sin(v * Math.PI * 2 * 5 + phase[i] * 2) * 0.01;
        let d = Math.abs(u - cx);
        d = Math.min(d, 1 - d);
        best = Math.min(best, d);
      }
      const furrow = Math.min(1, best * ridges * 2);
      const n = Math.sin(u * 90 + v * 7) * Math.sin(v * 160 + u * 13) * 0.08;
      height[y * w + x] = Math.pow(1 - furrow, 0.6) + n;
    }
  }
  // Pine: irregular plates in rows, cracks between them.
  const rows = 14;
  const rowOff = Array.from({ length: rows }, () => r());
  const cols = 5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < half; x++) {
      const u = x / half, v = y / h;
      const ry = v * rows;
      const row = Math.floor(ry);
      const fy = ry - row;
      const cu = (u * cols + rowOff[row % rows] * cols) % cols;
      const fx = cu - Math.floor(cu);
      const edge = Math.min(fx, 1 - fx, fy * 1.6, (1 - fy) * 1.6);
      const plate = Math.min(1, edge * 6);
      const n = Math.sin(u * 140 + v * 30) * Math.sin(v * 120) * 0.06;
      height[y * w + half + x] = plate * (0.75 + 0.25 * Math.sin(row * 2.3 + Math.floor(cu) * 1.7)) + n;
    }
  }
  const color = new Uint8Array(w * h * 4);
  const normal = new Uint8Array(w * h * 4);
  const at = (x: number, y: number, side: number) => height[((y + h) % h) * w + side * half + ((x + half) % half)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const side = x < half ? 0 : 1;
      const lx = x - side * half;
      const hv = at(lx, y, side);
      const i = (y * w + x) * 4;
      // Furrows and cracks darker; a little mottling.
      const mott = 0.9 + 0.1 * Math.sin(lx * 0.31 + y * 0.07) * Math.sin(y * 0.11);
      const g = Math.max(0, Math.min(1, (0.35 + 0.75 * hv) * mott));
      const v = Math.round(255 * Math.pow(g, 1 / 2.2) * 0.9);
      color[i] = Math.min(255, v + (side ? 10 : 4));
      color[i + 1] = v;
      color[i + 2] = Math.max(0, v - (side ? 12 : 6));
      color[i + 3] = 255;
      const dx = (at(lx + 1, y, side) - at(lx - 1, y, side)) * 2.2;
      const dy = (at(lx, y + 1, side) - at(lx, y - 1, side)) * 2.2;
      const len = Math.hypot(dx, dy, 1);
      normal[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      normal[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      normal[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      normal[i + 3] = 255;
    }
  }
  const make = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return releaseAfterUpload(t);
  };
  return { map: make(color, true), normalMap: make(normal, false) };
}
