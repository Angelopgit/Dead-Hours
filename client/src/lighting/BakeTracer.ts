import type { MapDefinition, Rect } from '@dead-hours/shared';
// Straight from their modules, not the package's index: the light bake's workers import this
// file, and the index would bring the physics engine and the whole simulation into them.
import { isDrivable } from '@dead-hours/shared/src/config/vehicles';
import { propColliders, propOccluders } from '@dead-hours/shared/src/map/colliders';

/**
 * A small CPU ray tracer over the map's static collision (boxes rotated about Y, plus
 * sphere proxies for tree crowns) and the terrain plane. Used to bake lighting and to sample
 * light probes at runtime. Rapier could answer the same queries, but a flat BVH in JS avoids
 * the per-call WASM marshalling and is several times faster for millions of short rays.
 */
export class BakeTracer {
  // Primitives: boxes [cx, cy, cz, hx, hy, hz, cos, sin] and spheres [cx, cy, cz, r].
  private readonly boxes: Float32Array;
  private readonly spheres: Float32Array;
  private readonly boxCount: number;
  // BVH over all primitives. Node: bounds (6 floats) + [left|first, count] (count 0 = inner).
  private nodeBounds = new Float32Array(0);
  private nodeData = new Int32Array(0);
  private prims = new Int32Array(0);
  private readonly stack = new Int32Array(128);
  private readonly holes: Rect[];
  private skipSpheres = false;
  /** Result of the last `intersect` call. */
  readonly hit = { t: 0, nx: 0, ny: 0, nz: 0 };

  constructor(map: MapDefinition) {
    const boxes: number[] = [];
    const spheres: number[] = [];
    for (const s of map.solids) {
      if (s.collide === false || s.glass) continue;
      // Long boxes (sidewalks) are chunked so they don't bloat the BVH bounds.
      const nx = Math.max(1, Math.ceil(s.w / 16)), nz = Math.max(1, Math.ceil(s.d / 16));
      for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
        const w = s.w / nx, d = s.d / nz;
        boxes.push(s.x - s.w / 2 + (i + 0.5) * w, s.y, s.z - s.d / 2 + (k + 0.5) * d, w / 2, s.h / 2, d / 2, 1, 0);
      }
    }
    for (const p of map.props) {
      // Vehicles can be driven away: they cast no baked shadow (their own draws one under them).
      if (isDrivable(p)) continue;
      for (const b of propColliders(p)) boxes.push(b.x, b.y, b.z, b.hx, b.hy, b.hz, Math.cos(b.rotY), Math.sin(b.rotY));
      for (const o of propOccluders(p)) spheres.push(o.x, o.y, o.z, o.r);
    }
    this.boxes = new Float32Array(boxes);
    this.spheres = new Float32Array(spheres);
    this.boxCount = boxes.length / 8;
    this.holes = map.excavations;
    this.buildBvh();
  }

  private primBounds(i: number, out: Float32Array, o: number): void {
    if (i < this.boxCount) {
      const b = this.boxes;
      const k = i * 8;
      const c = Math.abs(b[k + 6]), s = Math.abs(b[k + 7]);
      const ex = b[k + 3] * c + b[k + 5] * s;
      const ez = b[k + 3] * s + b[k + 5] * c;
      out[o] = b[k] - ex; out[o + 1] = b[k + 1] - b[k + 4]; out[o + 2] = b[k + 2] - ez;
      out[o + 3] = b[k] + ex; out[o + 4] = b[k + 1] + b[k + 4]; out[o + 5] = b[k + 2] + ez;
    } else {
      const k = (i - this.boxCount) * 4;
      const s = this.spheres;
      out[o] = s[k] - s[k + 3]; out[o + 1] = s[k + 1] - s[k + 3]; out[o + 2] = s[k + 2] - s[k + 3];
      out[o + 3] = s[k] + s[k + 3]; out[o + 4] = s[k + 1] + s[k + 3]; out[o + 5] = s[k + 2] + s[k + 3];
    }
  }

  private buildBvh(): void {
    const n = this.boxCount + this.spheres.length / 4;
    const pb = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) this.primBounds(i, pb, i * 6);
    const prims = new Int32Array(n);
    for (let i = 0; i < n; i++) prims[i] = i;
    const maxNodes = Math.max(1, 2 * n);
    const nb = new Float32Array(maxNodes * 6);
    const nd = new Int32Array(maxNodes * 2);
    let count = 0;
    const centroid = (p: number, axis: number) => (pb[p * 6 + axis] + pb[p * 6 + axis + 3]) * 0.5;
    const build = (start: number, end: number): number => {
      const node = count++;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = start; i < end; i++) {
        const k = prims[i] * 6;
        x0 = Math.min(x0, pb[k]); y0 = Math.min(y0, pb[k + 1]); z0 = Math.min(z0, pb[k + 2]);
        x1 = Math.max(x1, pb[k + 3]); y1 = Math.max(y1, pb[k + 4]); z1 = Math.max(z1, pb[k + 5]);
      }
      nb.set([x0, y0, z0, x1, y1, z1], node * 6);
      if (end - start <= 4) {
        nd[node * 2] = start;
        nd[node * 2 + 1] = end - start;
        return node;
      }
      const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const sub = Array.from(prims.subarray(start, end)).sort((a, b) => centroid(a, axis) - centroid(b, axis));
      prims.set(sub, start);
      const mid = (start + end) >> 1;
      build(start, mid);
      const right = build(mid, end);
      nd[node * 2] = right;
      nd[node * 2 + 1] = 0;
      return node;
    };
    if (n > 0) build(0, n);
    this.nodeBounds = nb.slice(0, count * 6);
    this.nodeData = nd.slice(0, count * 2);
    this.prims = prims;
  }

  private terrain(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number): number {
    // Ground plane y = 0, open where basements are dug out.
    if (Math.abs(dy) < 1e-6) return Infinity;
    const t = -oy / dy;
    if (t < 1e-3 || t > tmax) return Infinity;
    const x = ox + dx * t, z = oz + dz * t;
    for (const h of this.holes) if (x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1) return Infinity;
    return t;
  }

  /**
   * Ray against one primitive. Returns entry distance, or Infinity on a miss. A ray that starts
   * inside a primitive hits it at 0 unless it leaves within `eps` (origins lying on a face).
   */
  private prim(i: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, eps: number, wantNormal: boolean): number {
    if (i < this.boxCount) {
      const b = this.boxes;
      const k = i * 8;
      const c = b[k + 6], s = b[k + 7];
      // World → local: inverse of x' = x*c + z*s, z' = -x*s + z*c.
      const rx = ox - b[k], rz = oz - b[k + 2];
      const lox = rx * c - rz * s, loz = rx * s + rz * c, loy = oy - b[k + 1];
      const ldx = dx * c - dz * s, ldz = dx * s + dz * c;
      const hx = b[k + 3], hy = b[k + 4], hz = b[k + 5];
      let t0 = -Infinity, t1 = Infinity, axis = 0, sign = 0;
      // X slab
      if (Math.abs(ldx) < 1e-9) { if (lox < -hx || lox > hx) return Infinity; } else {
        const inv = 1 / ldx;
        let a = (-hx - lox) * inv, bb = (hx - lox) * inv;
        let sg = -1;
        if (a > bb) { const tmp = a; a = bb; bb = tmp; sg = 1; }
        if (a > t0) { t0 = a; axis = 0; sign = sg; }
        if (bb < t1) t1 = bb;
      }
      if (Math.abs(dy) < 1e-9) { if (loy < -hy || loy > hy) return Infinity; } else {
        const inv = 1 / dy;
        let a = (-hy - loy) * inv, bb = (hy - loy) * inv;
        let sg = -1;
        if (a > bb) { const tmp = a; a = bb; bb = tmp; sg = 1; }
        if (a > t0) { t0 = a; axis = 1; sign = sg; }
        if (bb < t1) t1 = bb;
      }
      if (Math.abs(ldz) < 1e-9) { if (loz < -hz || loz > hz) return Infinity; } else {
        const inv = 1 / ldz;
        let a = (-hz - loz) * inv, bb = (hz - loz) * inv;
        let sg = -1;
        if (a > bb) { const tmp = a; a = bb; bb = tmp; sg = 1; }
        if (a > t0) { t0 = a; axis = 2; sign = sg; }
        if (bb < t1) t1 = bb;
      }
      if (t0 > t1 || t1 <= eps || t0 > tmax) return Infinity;
      const t = Math.max(t0, 0);
      if (wantNormal) {
        // Normal of the entry face, back to world space.
        let nx = 0, ny = 0, nz = 0;
        if (axis === 0) nx = sign; else if (axis === 1) ny = sign; else nz = sign;
        this.hit.nx = nx * c + nz * s;
        this.hit.ny = ny;
        this.hit.nz = -nx * s + nz * c;
      }
      return t;
    }
    const k = (i - this.boxCount) * 4;
    const sp = this.spheres;
    const px = ox - sp[k], py = oy - sp[k + 1], pz = oz - sp[k + 2], r = sp[k + 3];
    const bq = px * dx + py * dy + pz * dz;
    const cq = px * px + py * py + pz * pz - r * r;
    const disc = bq * bq - cq;
    if (disc < 0) return Infinity;
    const sq = Math.sqrt(disc);
    const tEnter = -bq - sq, tExit = -bq + sq;
    if (tExit <= eps || tEnter > tmax) return Infinity;
    const t = Math.max(tEnter, 0);
    if (wantNormal) {
      const inv = 1 / r;
      this.hit.nx = (px + dx * t) * inv; this.hit.ny = (py + dy * t) * inv; this.hit.nz = (pz + dz * t) * inv;
    }
    return t;
  }

  /** Any hit within tmax (shadow and occlusion rays). Direction must be normalized. */
  occluded(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, eps = 0.01, spheres = true): boolean {
    if (this.terrain(ox, oy, oz, dx, dy, dz, tmax) < Infinity) return true;
    this.skipSpheres = !spheres;
    const hit = this.traverse(ox, oy, oz, dx, dy, dz, tmax, eps, true) < Infinity;
    this.skipSpheres = false;
    return hit;
  }

  /** Closest hit within tmax; fills `hit` with distance and surface normal. */
  intersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, eps = 0.01): boolean {
    let best = this.traverse(ox, oy, oz, dx, dy, dz, tmax, eps, false);
    const tg = this.terrain(ox, oy, oz, dx, dy, dz, Math.min(tmax, best));
    if (tg < best) {
      best = tg;
      this.hit.nx = 0; this.hit.ny = dy < 0 ? 1 : -1; this.hit.nz = 0;
    }
    if (best === Infinity) return false;
    this.hit.t = best;
    return true;
  }

  private traverse(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, eps: number, any: boolean): number {
    const nb = this.nodeBounds, nd = this.nodeData, prims = this.prims, stack = this.stack;
    if (!nd.length) return Infinity;
    const ix = 1 / (Math.abs(dx) < 1e-12 ? 1e-12 : dx);
    const iy = 1 / (Math.abs(dy) < 1e-12 ? 1e-12 : dy);
    const iz = 1 / (Math.abs(dz) < 1e-12 ? 1e-12 : dz);
    let best = Infinity;
    let limit = tmax;
    let bnx = 0, bny = 0, bnz = 0;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const k = node * 6;
      let a = (nb[k] - ox) * ix, b = (nb[k + 3] - ox) * ix;
      let t0 = a < b ? a : b, t1 = a < b ? b : a;
      a = (nb[k + 1] - oy) * iy; b = (nb[k + 4] - oy) * iy;
      t0 = Math.max(t0, a < b ? a : b); t1 = Math.min(t1, a < b ? b : a);
      a = (nb[k + 2] - oz) * iz; b = (nb[k + 5] - oz) * iz;
      t0 = Math.max(t0, a < b ? a : b); t1 = Math.min(t1, a < b ? b : a);
      if (t0 > t1 || t1 < 0 || t0 > limit) continue;
      const count = nd[node * 2 + 1];
      if (count > 0) {
        const first = nd[node * 2];
        for (let i = first; i < first + count; i++) {
          if (this.skipSpheres && prims[i] >= this.boxCount) continue;
          const t = this.prim(prims[i], ox, oy, oz, dx, dy, dz, limit, eps, !any);
          if (t < best) {
            if (any) return t;
            best = t;
            limit = t;
            bnx = this.hit.nx; bny = this.hit.ny; bnz = this.hit.nz;
          }
        }
      } else {
        stack[sp++] = node + 1;
        stack[sp++] = nd[node * 2];
      }
    }
    if (best < Infinity) { this.hit.nx = bnx; this.hit.ny = bny; this.hit.nz = bnz; }
    return best;
  }
}
