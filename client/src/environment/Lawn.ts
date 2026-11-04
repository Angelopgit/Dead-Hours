import { propColliders, type MapDefinition } from '@dead-hours/shared';

/**
 * Where the ground is open lawn, for the grass: the ground plane runs under everything, so the
 * lawn is what is left once roads, sidewalks, driveways, slabs, houses, basements, walls, fences,
 * props and puddles are taken out, fading into the forest floor where the woods begin. Also the
 * woods/dryness formulas the ground's own vertex colours use, so grass and ground agree.
 */

/** Lawn mask resolution (meters per texel). */
export const LAWN_TEXEL = 0.25;

export interface LawnMask {
  /** World position of texel (0, 0)'s outer corner. */
  x0: number;
  z0: number;
  texel: number;
  /** Texels along X and Z. */
  w: number;
  h: number;
  /** Two bytes per texel, rows along X: grass density (0..255) and blade height (128 = 1x, 255 = 2x). */
  data: Uint8Array;
}

/** Distance from a ground point to the nearest forest tree (capped at 12 m), from a 6 m grid of the woods. */
export function forestDistance(map: MapDefinition): (x: number, z: number) => number {
  const cell = 6;
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 4096 + cz;
  for (const p of map.props) {
    if (!p.forest) continue;
    const k = key(Math.floor(p.x / cell), Math.floor(p.z / cell));
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(p.x, p.z);
  }
  return (x, z) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    let best = 144;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const list = grid.get(key(cx + i, cz + j));
        if (!list) continue;
        for (let n = 0; n < list.length; n += 2) best = Math.min(best, (list[n] - x) ** 2 + (list[n + 1] - z) ** 2);
      }
    }
    return Math.sqrt(best);
  };
}

const smooth = (x: number, a: number, b: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 0 on the streets' lawns, 1 on the forest floor. North of Hale and along the sides the forest
 * floor starts on a straight line; south of Hale it follows the trees, so Kinney Street's lots keep
 * their grass. Past the edge of the map it's all woods.
 */
export function woodsAt(map: MapDefinition): (x: number, z: number) => number {
  const nearTree = forestDistance(map);
  const b = map.bounds;
  return (x, z) => Math.max(
    smooth(-z, 50, 60),
    smooth(Math.abs(x), 113, 121),
    z > 40 ? 1 - smooth(nearTree(x, z), 3, 9) : 0,
    smooth(z - b.z1, -4, 2),
  );
}

/** The ground's patchy-dry noise (-1.8..1.8); the grass shader repeats it to tint dry blades. */
export function groundNoise(x: number, z: number): number {
  return Math.sin(x * 0.11) * Math.cos(z * 0.13) + Math.sin(x * 0.031 + z * 0.047) * 0.8;
}

function hash2(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise in 0..1 (deterministic, for lawn patches). */
function valueNoise(x: number, z: number, seed: number): number {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fine-grid cell states: open lawn, flat cover (paving, slabs, puddles), upright (walls, fences, props). */
const OPEN = 0, FLAT = 1, UPRIGHT = 2;

/** Half extents of the props that cover the ground without a collider there (negative: a disc). */
const GROUND_COVER: Partial<Record<string, [number, number]>> = {
  shed: [1.55, 1.3], // the concrete floor (an open shed has colliders on its walls only)
  kiddiePool: [-1.15, 0],
  sandbox: [1.55, 1.55],
  pallet: [0.65, 0.55],
  mattress: [1.0, 0.5],
  trashBag: [-0.35, 0],
};

/**
 * Builds the lawn mask for a map (about 0.25 s for both streets). Everything here is
 * deterministic, so every survivor in a room sees the same lawns.
 */
export function buildLawnMask(map: MapDefinition): LawnMask {
  const b = map.bounds;
  const texel = LAWN_TEXEL;
  const pad = 1;
  const x0 = b.x0 - pad, z0 = b.z0 - pad;
  const w = Math.ceil((b.x1 - b.x0 + pad * 2) / texel), h = Math.ceil((b.z1 - b.z0 + pad * 2) / texel);
  // Rasterize the cover at half a texel (four samples per texel).
  const f = texel / 2, fw = w * 2, fh = h * 2;
  const cells = new Uint8Array(fw * fh);
  const mark = (i: number, j: number, v: number) => {
    const k = j * fw + i;
    if (cells[k] < v) cells[k] = v;
  };
  /** Axis-aligned rectangle (center, half extents) over sample centers. */
  const rect = (cx: number, cz: number, hx: number, hz: number, v: number) => {
    const i0 = Math.max(0, Math.ceil((cx - hx - x0) / f - 0.5)), i1 = Math.min(fw - 1, Math.floor((cx + hx - x0) / f - 0.5));
    const j0 = Math.max(0, Math.ceil((cz - hz - z0) / f - 0.5)), j1 = Math.min(fh - 1, Math.floor((cz + hz - z0) / f - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) mark(i, j, v);
  };
  /** Rotated rectangle (three.js Y rotation, like the colliders). */
  const obb = (cx: number, cz: number, hx: number, hz: number, rotY: number, v: number) => {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const ex = Math.abs(hx * c) + Math.abs(hz * s), ez = Math.abs(hx * s) + Math.abs(hz * c);
    const i0 = Math.max(0, Math.ceil((cx - ex - x0) / f - 0.5)), i1 = Math.min(fw - 1, Math.floor((cx + ex - x0) / f - 0.5));
    const j0 = Math.max(0, Math.ceil((cz - ez - z0) / f - 0.5)), j1 = Math.min(fh - 1, Math.floor((cz + ez - z0) / f - 0.5));
    for (let j = j0; j <= j1; j++) {
      const dz = z0 + (j + 0.5) * f - cz;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) * f - cx;
        // Into the box's frame (inverse of x' = x*c + z*s, z' = -x*s + z*c).
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) mark(i, j, v);
      }
    }
  };
  const ellipse = (cx: number, cz: number, rx: number, rz: number, rotY: number, v: number) => {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const e = Math.max(rx, rz);
    const i0 = Math.max(0, Math.ceil((cx - e - x0) / f - 0.5)), i1 = Math.min(fw - 1, Math.floor((cx + e - x0) / f - 0.5));
    const j0 = Math.max(0, Math.ceil((cz - e - z0) / f - 0.5)), j1 = Math.min(fh - 1, Math.floor((cz + e - z0) / f - 0.5));
    for (let j = j0; j <= j1; j++) {
      const dz = z0 + (j + 0.5) * f - cz;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) * f - cx;
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if ((lx / rx) ** 2 + (lz / rz) ** 2 <= 1) mark(i, j, v);
      }
    }
  };

  // Anything standing on or lying over the ground: roads, sidewalks, curbs, driveways, slabs,
  // porches, steps, walls and fences (invisible colliders too: they stand in for drawn parts).
  for (const s of map.solids) {
    const bottom = s.y - s.h / 2, top = s.y + s.h / 2;
    if (top < -0.05 || bottom > 0.7) continue;
    rect(s.x, s.z, s.w / 2 + 0.04, s.d / 2 + 0.04, s.h > 0.3 ? UPRIGHT : FLAT);
  }
  for (const hs of map.houses) rect(hs.x, hs.z, hs.w / 2 + 0.2, hs.d / 2 + 0.2, UPRIGHT);
  for (const e of map.excavations) rect((e.x0 + e.x1) / 2, (e.z0 + e.z1) / 2, (e.x1 - e.x0) / 2 + 0.15, (e.z1 - e.z0) / 2 + 0.15, UPRIGHT);
  for (const p of map.props) {
    if (p.forest || (p.y ?? 0) > 0.25) continue;
    if (p.kind === 'puddle') {
      // Matches the puddle's outline (CircleGeometry squashed to 0.7 across), a little generous.
      const r = (p.length ?? 1.8) * 0.95;
      ellipse(p.x, p.z, r, r * 0.7, p.rotY, FLAT);
      continue;
    }
    if (p.kind === 'leafPile') {
      ellipse(p.x, p.z, 1.3, 1.0, p.rotY, FLAT);
      continue;
    }
    // Lying on the ground with no collider (or, for the open shed, walls only).
    const flat = GROUND_COVER[p.kind];
    if (flat) {
      if (flat[0] < 0) ellipse(p.x, p.z, -flat[0], -flat[0], 0, FLAT);
      else obb(p.x, p.z, flat[0], flat[1], p.rotY, FLAT);
    }
    for (const o of propColliders(p)) {
      if (o.y - o.hy > 0.6 || o.y + o.hy < 0) continue;
      obb(o.x, o.z, o.hx + 0.05, o.hz + 0.05, o.rotY, UPRIGHT);
    }
  }

  // Per texel: open fraction, and the distance to the nearest upright thing (in texels, chamfer).
  const open = new Float32Array(w * h);
  const dist = new Float32Array(w * h);
  const paveDist = new Float32Array(w * h);
  const FAR = 1e4;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let n = 0, up = false, flat = false;
      for (let q = 0; q < 4; q++) {
        const v = cells[(j * 2 + (q >> 1)) * fw + i * 2 + (q & 1)];
        if (v === OPEN) n++;
        else if (v === UPRIGHT) up = true;
        else flat = true;
      }
      const k = j * w + i;
      open[k] = n / 4;
      dist[k] = up ? 0 : FAR;
      paveDist[k] = flat ? 0 : FAR;
    }
  }
  chamfer(dist, w, h);
  chamfer(paveDist, w, h);

  // Slow-varying fields on a 1 m grid, sampled bilinearly per texel: the woods (the forest lookup is
  // the slow part), shade under the yard trees, worn patches and overgrown stretches.
  const woods = woodsAt(map);
  const trees = map.props.filter((p) => !p.forest && (p.kind === 'tree' || p.kind === 'pine'));
  const cw = Math.ceil(w * texel) + 2, ch = Math.ceil(h * texel) + 2;
  const fields = [new Float32Array(cw * ch), new Float32Array(cw * ch), new Float32Array(cw * ch), new Float32Array(cw * ch)];
  const [woodF, shadeF, patchF, wildF] = fields;
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const x = x0 + i, z = z0 + j, k = j * cw + i;
      woodF[k] = woods(x, z);
      patchF[k] = smooth(valueNoise(x * 0.16, z * 0.16, 11), 0.15, 0.55);
      wildF[k] = valueNoise(x * 0.07, z * 0.07, 23);
    }
  }
  for (const t of trees) {
    // Shade fades from 0.8 m to 3.2 m around each trunk.
    for (let j = Math.max(0, Math.floor(t.z - z0 - 4)); j <= Math.min(ch - 1, Math.ceil(t.z - z0 + 4)); j++) {
      for (let i = Math.max(0, Math.floor(t.x - x0 - 4)); i <= Math.min(cw - 1, Math.ceil(t.x - x0 + 4)); i++) {
        const d = Math.sqrt((x0 + i - t.x) ** 2 + (z0 + j - t.z) ** 2);
        const k = j * cw + i;
        shadeF[k] = Math.max(shadeF[k], 1 - smooth(d, 0.8, 3.2));
      }
    }
  }
  // Bilinear taps into the 1 m grid for every texel column and row.
  const colI = new Int32Array(w), colF = new Float32Array(w), rowK = new Int32Array(h), rowF = new Float32Array(h);
  for (let i = 0; i < w; i++) {
    const u = (i + 0.5) * texel, c = Math.min(cw - 2, Math.floor(u));
    colI[i] = c;
    colF[i] = u - c;
  }
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) * texel, r = Math.min(ch - 2, Math.floor(v));
    rowK[j] = r * cw;
    rowF[j] = v - r;
  }
  let fu = 0, fv = 0, c00 = 0;
  const sample = (f: Float32Array) => {
    const a = f[c00], bb = f[c00 + 1], c = f[c00 + cw], d = f[c00 + cw + 1];
    return (a + (bb - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  };

  const data = new Uint8Array(w * h * 2);
  for (let j = 0; j < h; j++) {
    fv = rowF[j];
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (open[k] === 0) continue;
      fu = colF[i];
      c00 = rowK[j] + colI[i];
      const wood = sample(woodF);
      if (wood > 0.85) continue;
      const under = sample(shadeF);
      // Thinner in a few worn patches and under the yard trees; none into the forest floor.
      const patch = sample(patchF);
      let density = open[k] * (1 - smooth(wood, 0.2, 0.75)) * (0.55 + 0.45 * patch) * (1 - under * 0.45);
      // Never right against a wall or a paving edge (half a texel): blades would poke through.
      density *= smooth(dist[k], 0.4, 1.2) * smooth(paveDist[k], 0.2, 0.9);
      // Unmown: knee-high weeds along walls, fences and posts, a lip of long grass over the curbs,
      // overgrown stretches here and there, shorter under the trees.
      const wall = 1 - smooth(dist[k] * texel, 0.15, 1.1);
      const curb = 1 - smooth(paveDist[k] * texel, 0.1, 0.6);
      const wild = sample(wildF);
      const height = (0.78 + wild * 0.42 + wall * 0.35 + curb * 0.12) * (1 - under * 0.3);
      data[k * 2] = Math.round(Math.min(1, density) * 255);
      data[k * 2 + 1] = Math.round(Math.min(1, height / 2) * 255);
    }
  }
  return { x0, z0, texel, w, h, data };
}

/** In-place two-pass chamfer distance (in texels) to the zero cells. */
function chamfer(d: Float32Array, w: number, h: number): void {
  const D = 1, E = Math.SQRT2;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let v = d[k];
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + D);
      if (j > 0) {
        v = Math.min(v, d[k - w] + D);
        if (i > 0) v = Math.min(v, d[k - w - 1] + E);
        if (i < w - 1) v = Math.min(v, d[k - w + 1] + E);
      }
      d[k] = v;
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      let v = d[k];
      if (v === 0) continue;
      if (i < w - 1) v = Math.min(v, d[k + 1] + D);
      if (j < h - 1) {
        v = Math.min(v, d[k + w] + D);
        if (i < w - 1) v = Math.min(v, d[k + w + 1] + E);
        if (i > 0) v = Math.min(v, d[k + w - 1] + E);
      }
      d[k] = v;
    }
  }
}

/**
 * Grass density (0..1) at a world point, filtered like the GPU's linear sampling of the mask (what
 * the grass shader sees at a blade's root).
 */
export function lawnDensity(mask: LawnMask, x: number, z: number): number {
  const u = (x - mask.x0) / mask.texel - 0.5, v = (z - mask.z0) / mask.texel - 0.5;
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const d = (a: number, b: number) => (a < 0 || b < 0 || a >= mask.w || b >= mask.h ? 0 : mask.data[(b * mask.w + a) * 2] / 255);
  return (d(i, j) * (1 - fu) + d(i + 1, j) * fu) * (1 - fv) + (d(i, j + 1) * (1 - fu) + d(i + 1, j + 1) * fu) * fv;
}
