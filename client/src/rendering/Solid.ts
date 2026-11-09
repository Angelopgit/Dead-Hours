import * as THREE from 'three';

/**
 * Modeling primitives for the code-built hard-surface models (guns, cars): outlines traced from
 * a real object's side view and extruded with chamfered edges, lofted tubes with stepped
 * profiles, chamfered boxes, and occlusion baked into the vertices when a model is built.
 * Everything comes out non-indexed with its own normals (flat faces stay flat, tubes are smooth
 * around) and an `edge` attribute that is 1 on chamfers, where paint wears through first.
 * See docs/art-style.md.
 */
export type P2 = [number, number];

class Mesher {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly edge: number[] = [];
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly n = new THREE.Vector3();

  /** A flat triangle, wound so it faces along `hint`. */
  tri(p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, hint: THREE.Vector3, edge = 0): void {
    this.n.crossVectors(this.a.subVectors(q, p), this.b.subVectors(r, p));
    if (this.n.lengthSq() < 1e-16) return;
    this.n.normalize();
    const flip = this.n.dot(hint) < 0;
    if (flip) this.n.negate();
    const order = flip ? [p, r, q] : [p, q, r];
    for (const v of order) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(this.n.x, this.n.y, this.n.z);
      this.edge.push(edge);
    }
  }

  quad(p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, s: THREE.Vector3, hint: THREE.Vector3, edge = 0): void {
    this.tri(p, q, r, hint, edge);
    this.tri(p, r, s, hint, edge);
  }

  /** A triangle with a normal of its own at each corner (smooth surfaces). */
  smooth(p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, np: THREE.Vector3, nq: THREE.Vector3, nr: THREE.Vector3): void {
    this.n.crossVectors(this.a.subVectors(q, p), this.b.subVectors(r, p));
    if (this.n.lengthSq() < 1e-16) return;
    const flip = this.n.dot(np) + this.n.dot(nq) + this.n.dot(nr) < 0;
    const vs = flip ? [p, r, q] : [p, q, r];
    const ns = flip ? [np, nr, nq] : [np, nq, nr];
    for (let i = 0; i < 3; i++) {
      this.pos.push(vs[i].x, vs[i].y, vs[i].z);
      this.nor.push(ns[i].x, ns[i].y, ns[i].z);
      this.edge.push(0);
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('edge', new THREE.Float32BufferAttribute(this.edge, 1));
    return g;
  }
}

function signedArea(o: P2[]): number {
  let s = 0;
  for (let i = 0; i < o.length; i++) {
    const [x0, y0] = o[i], [x1, y1] = o[(i + 1) % o.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

/** The outline moved inward by `d` (mitred corners, kept from shooting off at sharp ones). */
function inset(o: P2[], d: number): P2[] {
  const n = o.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = o[(i + n - 1) % n], c = o[i], q = o[(i + 1) % n];
    // Inward normals of the two edges at this corner (the outline is counter-clockwise).
    let ax = -(c[1] - p[1]), ay = c[0] - p[0];
    let bx = -(q[1] - c[1]), by = q[0] - c[0];
    const al = Math.hypot(ax, ay) || 1, bl = Math.hypot(bx, by) || 1;
    ax /= al; ay /= al; bx /= bl; by /= bl;
    const k = d / Math.max(0.35, 1 + ax * bx + ay * by);
    out.push([c[0] + (ax + bx) * k, c[1] + (ay + by) * k]);
  }
  return out;
}

export interface PlateOptions {
  /** Centre across the width. */
  x?: number;
  /** Chamfer along both faces' edges. */
  bevel?: number;
  /** A different outline scale on the far faces is not supported; use two plates. */
}

/**
 * A closed outline, given as [z, y] points (the side view), extruded across X by `width`, with a
 * chamfer of `bevel` along the edges of both faces.
 */
export function plate(outline: P2[], width: number, opts: PlateOptions = {}): THREE.BufferGeometry {
  const o = signedArea(outline) < 0 ? [...outline].reverse() : outline;
  const n = o.length;
  const x = opts.x ?? 0;
  const bevel = Math.min(opts.bevel ?? 0, width / 2 - 1e-5);
  const m = new Mesher();
  const inner = bevel > 0 ? inset(o, bevel) : o;
  const hw = width / 2;
  const V = (p: P2, px: number) => new THREE.Vector3(x + px, p[1], p[0]);
  const hint = new THREE.Vector3();
  // Faces.
  const contour = inner.map((p) => new THREE.Vector2(p[0], p[1]));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const side of [1, -1]) {
    hint.set(side, 0, 0);
    for (const f of faces) m.tri(V(inner[f[0]], side * hw), V(inner[f[1]], side * hw), V(inner[f[2]], side * hw), hint);
  }
  for (let i = 0; i < n; i++) {
    const a = o[i], b = o[(i + 1) % n];
    // Outward normal of this edge, in the side view.
    const ny = -(b[0] - a[0]), nz = b[1] - a[1];
    const l = Math.hypot(ny, nz) || 1;
    hint.set(0, ny / l, nz / l);
    const w = hw - bevel;
    m.quad(V(a, w), V(b, w), V(b, -w), V(a, -w), hint);
    if (bevel > 0) {
      const ia = inner[i], ib = inner[(i + 1) % n];
      for (const side of [1, -1]) {
        hint.set(side, ny / l, nz / l);
        m.quad(V(a, side * w), V(b, side * w), V(ib, side * hw), V(ia, side * hw), hint, 1);
      }
    }
  }
  return m.geometry();
}

/** A box with every edge chamfered. */
export function chamferBox(w: number, h: number, d: number, bevel: number): THREE.BufferGeometry {
  const b = Math.min(bevel, w / 2 - 1e-5, h / 2 - 1e-5, d / 2 - 1e-5);
  if (b <= 0) {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    g.deleteAttribute('uv');
    g.setAttribute('edge', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count), 1));
    return g;
  }
  const m = new Mesher();
  const half = [w / 2, h / 2, d / 2];
  /** The corner at signs s, pulled in along every axis but `keep`. */
  const P = (s: number[], keep: number) => {
    const c = [0, 1, 2].map((k) => s[k] * (half[k] - (k === keep ? 0 : b)));
    return new THREE.Vector3(c[0], c[1], c[2]);
  };
  const hint = new THREE.Vector3();
  const signs = [-1, 1];
  // Faces.
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const s of signs) {
      const at = (su: number, sv: number) => {
        const k = [0, 0, 0];
        k[axis] = s; k[u] = su; k[v] = sv;
        return P(k, axis);
      };
      hint.set(0, 0, 0).setComponent(axis, s);
      m.quad(at(-1, -1), at(1, -1), at(1, 1), at(-1, 1), hint);
    }
  }
  // Edges: along `axis`, between the faces of the other two.
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const su of signs) for (const sv of signs) {
      const at = (sa: number, keep: number) => {
        const k = [0, 0, 0];
        k[axis] = sa; k[u] = su; k[v] = sv;
        return P(k, keep);
      };
      hint.set(0, 0, 0).setComponent(u, su).setComponent(v, sv);
      m.quad(at(-1, u), at(1, u), at(1, v), at(-1, v), hint, 1);
    }
  }
  // Corners.
  for (const sx of signs) for (const sy of signs) for (const sz of signs) {
    const s = [sx, sy, sz];
    hint.set(sx, sy, sz);
    m.tri(P(s, 0), P(s, 1), P(s, 2), hint, 1);
  }
  return m.geometry();
}

/** One station along a lofted tube: where along Z, its half-width and half-height, and its centre height. */
export interface Ring {
  z: number;
  rx: number;
  ry?: number;
  y?: number;
  x?: number;
}

export interface LoftOptions {
  segments?: number;
  /** Flat discs closing the ends (default both). */
  caps?: boolean | [boolean, boolean];
  /** Blend the shading across stations that bend by less than this (radians); 0 keeps every step crisp. */
  smooth?: number;
  /** Squarer than an ellipse: 2 is an ellipse, 4 a rounded box. */
  power?: number;
}

/**
 * A tube along Z through elliptical (or squarer) stations: barrels with their steps, handguards,
 * scopes, car bodies. Smooth around, crisp at every step unless `smooth` says otherwise. Two
 * stations at the same Z make a shoulder.
 */
export function loft(rings: Ring[], opts: LoftOptions = {}): THREE.BufferGeometry {
  const segs = opts.segments ?? 10;
  const power = opts.power ?? 2;
  const m = new Mesher();
  const unit: P2[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const k = 2 / power;
    unit.push([Math.sign(c) * Math.abs(c) ** k, Math.sign(s) * Math.abs(s) ** k]);
  }
  const at = (r: Ring, i: number) => new THREE.Vector3((r.x ?? 0) + unit[i][0] * r.rx, (r.y ?? 0) + unit[i][1] * (r.ry ?? r.rx), r.z);
  // Each span's own normals: around the section, tipped by how the tube widens along it. The
  // sense is set once, from the first span that runs along the tube, so a profile that comes
  // back inside itself (a sight tube's bore) faces inward there.
  let sense = 0;
  const raw = rings.slice(0, -1).map((r0, k) => {
    const r1 = rings[k + 1];
    return unit.map((_, i) => {
      const p0 = at(r0, i), p1 = at(r1, i);
      const wide = r0.rx >= r1.rx ? r0 : r1;
      const around = new THREE.Vector3().subVectors(at(wide, (i + 1) % segs), at(wide, (i + segs - 1) % segs));
      const n = new THREE.Vector3().crossVectors(around, new THREE.Vector3().subVectors(p1, p0));
      if (n.lengthSq() < 1e-20) return n.set(0, 0, 0);
      n.normalize();
      if (sense === 0 && Math.abs(r1.z - r0.z) > 1e-9) sense = n.x * unit[i][0] + n.y * unit[i][1] < 0 ? -1 : 1;
      return n;
    });
  });
  const spanNormals = raw.map((span) => span.map((n) => n.multiplyScalar(sense || 1)));
  const limit = opts.smooth ?? 0;
  const normalAt = (span: number, end: 0 | 1, i: number): THREE.Vector3 => {
    const own = spanNormals[span][i];
    const other = end === 0 ? span - 1 : span + 1;
    if (limit <= 0 || other < 0 || other >= spanNormals.length) return own;
    const o = spanNormals[other][i];
    if (own.angleTo(o) > limit) return own;
    return new THREE.Vector3().addVectors(own, o).normalize();
  };
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      const a = at(rings[k], i), b = at(rings[k], j), c = at(rings[k + 1], j), d = at(rings[k + 1], i);
      const na = normalAt(k, 0, i), nb = normalAt(k, 0, j), nc = normalAt(k, 1, j), nd = normalAt(k, 1, i);
      m.smooth(a, b, c, na, nb, nc);
      m.smooth(a, c, d, na, nc, nd);
    }
  }
  const caps = opts.caps ?? true;
  const [cap0, cap1] = Array.isArray(caps) ? caps : [caps, caps];
  const dir = Math.sign(rings[rings.length - 1].z - rings[0].z) || 1;
  const hint = new THREE.Vector3();
  const cap = (r: Ring, s: number) => {
    const c = new THREE.Vector3(r.x ?? 0, r.y ?? 0, r.z);
    hint.set(0, 0, s);
    for (let i = 0; i < segs; i++) m.tri(c, at(r, i), at(r, (i + 1) % segs), hint);
  };
  if (cap0) cap(rings[0], -dir);
  if (cap1) cap(rings[rings.length - 1], dir);
  return m.geometry();
}

/**
 * Occlusion per vertex, 1 open to 0 buried: the model's own surfaces are marked in a coarse grid
 * and a few short rays from every vertex ask how much of the space around it is taken. It finds
 * the dark where parts meet (a magazine in its well, a rail on a receiver, a wheel in its arch),
 * which is what makes separate parts read as one object. `reach` is how far a surface shades.
 */
export function bakeOcclusion(position: ArrayLike<number>, normal: ArrayLike<number>, reach: number): Float32Array {
  const count = position.length / 3;
  const out = new Float32Array(count).fill(1);
  if (count === 0) return out;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i++) {
    const k = i % 3;
    if (position[i] < min[k]) min[k] = position[i];
    if (position[i] > max[k]) max[k] = position[i];
  }
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  // Fine enough to tell a rail's teeth from its gaps on a rifle, coarse enough to stay a few hundred thousand cells.
  const cell = Math.max(reach / 6, size / 260, 1e-4);
  const pad = 2;
  const dim = [0, 1, 2].map((k) => Math.ceil((max[k] - min[k]) / cell) + 1 + pad * 2);
  if (dim[0] * dim[1] * dim[2] > 6_000_000) return out;
  const grid = new Uint8Array(dim[0] * dim[1] * dim[2]);
  const index = (x: number, y: number, z: number): number => {
    const ix = Math.floor((x - min[0]) / cell) + pad, iy = Math.floor((y - min[1]) / cell) + pad, iz = Math.floor((z - min[2]) / cell) + pad;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= dim[0] || iy >= dim[1] || iz >= dim[2]) return -1;
    return (iz * dim[1] + iy) * dim[0] + ix;
  };
  // Mark every cell a triangle passes through.
  const step = cell * 0.6;
  for (let t = 0; t < count; t += 3) {
    const ax = position[t * 3], ay = position[t * 3 + 1], az = position[t * 3 + 2];
    const bx = position[t * 3 + 3], by = position[t * 3 + 4], bz = position[t * 3 + 5];
    const cx = position[t * 3 + 6], cy = position[t * 3 + 7], cz = position[t * 3 + 8];
    const ab = Math.hypot(bx - ax, by - ay, bz - az), ac = Math.hypot(cx - ax, cy - ay, cz - az);
    const nu = Math.max(1, Math.ceil(ab / step)), nv = Math.max(1, Math.ceil(ac / step));
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      for (let j = 0; j <= nv; j++) {
        const v = (j / nv) * (1 - u);
        const k = index(ax + (bx - ax) * u + (cx - ax) * v, ay + (by - ay) * u + (cy - ay) * v, az + (bz - az) * u + (cz - az) * v);
        if (k >= 0) grid[k] = 1;
      }
    }
  }
  // Rays: two rings around the normal, weighted by how square they meet the surface.
  const rays: [number, number, number][] = [];
  for (const [el, n] of [[0.42, 6], [1.05, 5]] as const) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + el;
      rays.push([Math.cos(a) * Math.cos(el), Math.sin(a) * Math.cos(el), Math.sin(el)]);
    }
  }
  rays.push([0, 0, 1]);
  const total = rays.reduce((s, r) => s + r[2], 0);
  const steps = [1.5, 2.6, 4, 5.6];
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    n.set(normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]);
    if (Math.abs(n.x) < 0.9) t1.set(1, 0, 0); else t1.set(0, 1, 0);
    t2.crossVectors(n, t1).normalize();
    t1.crossVectors(t2, n);
    const ox = position[i * 3] + n.x * cell * 1.7, oy = position[i * 3 + 1] + n.y * cell * 1.7, oz = position[i * 3 + 2] + n.z * cell * 1.7;
    let shade = 0;
    for (const r of rays) {
      const dx = t1.x * r[0] + t2.x * r[1] + n.x * r[2], dy = t1.y * r[0] + t2.y * r[1] + n.y * r[2], dz = t1.z * r[0] + t2.z * r[1] + n.z * r[2];
      for (let s = 0; s < steps.length; s++) {
        const d = steps[s] * cell;
        const k = index(ox + dx * d, oy + dy * d, oz + dz * d);
        if (k >= 0 && grid[k]) {
          shade += r[2] * (1 - s / (steps.length + 1));
          break;
        }
      }
    }
    out[i] = 1 - shade / total;
  }
  return out;
}

/** Texture coordinates from position, each face flattened along the axis it faces most: for tiling detail maps. */
export function boxProject(position: ArrayLike<number>, normal: ArrayLike<number>, perMetre: number): Float32Array {
  const count = position.length / 3;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = position[i * 3], y = position[i * 3 + 1], z = position[i * 3 + 2];
    const ax = Math.abs(normal[i * 3]), ay = Math.abs(normal[i * 3 + 1]), az = Math.abs(normal[i * 3 + 2]);
    let u = x, v = y;
    if (ax >= ay && ax >= az) { u = z; v = y; }
    else if (ay >= az) { u = x; v = z; }
    uv[i * 2] = u * perMetre;
    uv[i * 2 + 1] = v * perMetre;
  }
  return uv;
}

/** Repeatable 0..1 noise at a point, smooth over `scale` metres (wear patches, dirt). */
export function patchNoise(x: number, y: number, z: number, scale: number): number {
  const h = (i: number, j: number, k: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const fx = x / scale, fy = y / scale, fz = z / scale;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const s = (t: number) => t * t * (3 - 2 * t);
  const ux = s(fx - ix), uy = s(fy - iy), uz = s(fz - iz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(h(ix, iy, iz), h(ix + 1, iy, iz), ux), lerp(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), ux), uy),
    lerp(lerp(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), ux), lerp(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), ux), uy),
    uz,
  );
}
