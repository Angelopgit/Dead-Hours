import * as THREE from 'three';
import { rng } from '@dead-hours/shared';

/** Texels per metre of leaf: a round's hole is a few across, its splintered ring a few more. */
const RES = 128;
/** Raw wood under the paint, lighter where the fibres are torn fresh. */
const RAW: [number, number, number] = [150, 112, 74];
const DEEP: [number, number, number] = [104, 74, 48];

/**
 * Where pieces come out of a panelled leaf, in order: [x as a share of the width, y (m), half
 * width as a share of the width, half height (m)]. The thin panels go first, then the latch side
 * and the rails; the stiles round the edge stay, so the door is still a door.
 */
const PIECES: [number, number, number, number][] = [
  [0.5, 1.6, 0.13, 0.17],
  [0.48, 0.5, 0.14, 0.15],
  [0.5, 1.5, 0.27, 0.27],
  [0.93, 1.32, 0.12, 0.2],
  [0.5, 0.6, 0.28, 0.28],
  [0.45, 1.05, 0.2, 0.09],
  [0.2, 1.95, 0.12, 0.17],
];

/** The middle of piece `k` of a leaf `w` wide, in the leaf's own frame (x from the hinge, y up). */
export function pieceCenter(k: number, w: number, out: THREE.Vector3): THREE.Vector3 {
  const p = PIECES[Math.min(k, PIECES.length - 1)];
  return out.set(Math.min(p[0] * w, w - 0.06), p[1], 0);
}

/**
 * The damage painted on one wooden door leaf: a colour-and-cutout texture shared by the slab and
 * its raised panels, mapped flat across the leaf so a hole goes through every layer at once.
 * Alpha 0 is a hole (the materials alpha-test it); around each one the paint is torn back to raw
 * wood. Created the first time the door is hurt; until then the leaf shows a shared plain one.
 */
export class DoorDamage {
  readonly texture: THREE.DataTexture;
  private readonly data: Uint8Array;
  private readonly cols: number;
  private readonly rows: number;
  private dirty = false;

  constructor(private readonly w: number, private readonly h: number, private readonly paint: [number, number, number]) {
    this.cols = Math.max(8, Math.round(w * RES));
    this.rows = Math.max(8, Math.round(h * RES));
    this.data = new Uint8Array(this.cols * this.rows * 4);
    this.texture = DoorDamage.makeTexture(this.data, this.cols, this.rows);
    this.clear();
  }

  /** A 1x1 texture of the paint alone (an undamaged leaf). */
  static plain(paint: [number, number, number]): THREE.DataTexture {
    return DoorDamage.makeTexture(new Uint8Array([paint[0], paint[1], paint[2], 255]), 1, 1);
  }

  private static makeTexture(data: Uint8Array, cols: number, rows: number): THREE.DataTexture {
    const t = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  clear(): void {
    const d = this.data;
    const [r, g, b] = this.paint;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
    this.dirty = true;
  }

  /** A round through the leaf at (x, y) in its own frame (m). */
  hole(x: number, y: number, seed: number): void {
    const rand = rng(seed);
    const r = 0.011 + rand() * 0.005;
    this.blob(x, y, r, r, 2.4, 3.2, rand);
  }

  /** Knocks piece `k` out of the leaf (the same jagged shape on every machine for this door). */
  piece(k: number, door: number): void {
    const p = PIECES[Math.min(k, PIECES.length - 1)];
    const rand = rng(door * 97 + k * 13 + 5);
    const x = p[0] * this.w + (rand() - 0.5) * 0.06;
    const y = p[1] + (rand() - 0.5) * 0.08;
    const s = 0.85 + rand() * 0.3;
    this.blob(x, y, p[2] * this.w * s, p[3] * s, 0.22, 0.45, rand);
  }

  /** Uploads what was painted since the last frame. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }

  /**
   * A jagged hole (rx by ry, m) with torn wood round it: `ring` is how far the raw wood reaches
   * past the edge as a share of the radius, `spike` how far the longest splinters run up and down
   * the grain.
   */
  private blob(cx: number, cy: number, rx: number, ry: number, ring: number, spike: number, rand: () => number): void {
    const N = 20;
    const edge = new Float32Array(N + 1), torn = new Float32Array(N + 1);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      // Wood splits along the grain (up and down): the edge runs further that way.
      const grain = Math.pow(Math.abs(Math.sin(a)), 3);
      edge[i] = 0.7 + rand() * 0.45 + (rand() < 0.3 ? grain * rand() * 0.6 : 0);
      torn[i] = edge[i] + ring * (0.5 + rand()) + grain * spike * rand() * ring;
    }
    edge[N] = edge[0];
    torn[N] = torn[0];
    const reach = Math.max(...torn);
    const x0 = Math.max(0, Math.floor(((cx - rx * reach) / this.w) * this.cols));
    const x1 = Math.min(this.cols - 1, Math.ceil(((cx + rx * reach) / this.w) * this.cols));
    const y0 = Math.max(0, Math.floor(((cy - ry * reach) / this.h) * this.rows));
    const y1 = Math.min(this.rows - 1, Math.ceil(((cy + ry * reach) / this.h) * this.rows));
    const d = this.data;
    for (let row = y0; row <= y1; row++) {
      const ey = (((row + 0.5) / this.rows) * this.h - cy) / ry;
      for (let col = x0; col <= x1; col++) {
        const ex = (((col + 0.5) / this.cols) * this.w - cx) / rx;
        const rho = Math.hypot(ex, ey);
        if (rho > reach) continue;
        const f = ((Math.atan2(ey, ex) / (Math.PI * 2) + 1) % 1) * N;
        const i = Math.floor(f), t = f - i;
        const e = edge[i] + (edge[i + 1] - edge[i]) * t;
        const o = (row * this.cols + col) * 4;
        if (rho < e) {
          d[o + 3] = 0;
          continue;
        }
        const tr = torn[i] + (torn[i + 1] - torn[i]) * t;
        if (rho > tr || d[o + 3] === 0) continue;
        // Darker deep in the break, pale where the paint has just torn off; streaky along the grain.
        const k = Math.min(1, (rho - e) / Math.max(1e-3, tr - e));
        const streak = 0.85 + 0.3 * Math.abs(Math.sin(col * 2.7 + cx * 31));
        for (let c = 0; c < 3; c++) {
          const raw = (DEEP[c] + (RAW[c] - DEEP[c]) * Math.min(1, k * 1.6)) * streak;
          // The outer edge fades back into the paint.
          const fade = k > 0.75 ? (k - 0.75) / 0.25 : 0;
          d[o + c] = Math.round(raw + (d[o + c] - raw) * fade);
        }
      }
    }
    this.dirty = true;
  }
}
