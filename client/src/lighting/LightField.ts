import * as THREE from 'three';
import type { LightSpec, MapDefinition } from '@dead-hours/shared';
import { BakeTracer } from './BakeTracer';

/** A static light in linear color, premultiplied by intensity. */
interface FieldLight {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  range: number;
  decay: number;
  spot: boolean;
  dx: number; dy: number; dz: number;
  cosOuter: number;
  cosInner: number;
}

/** Cosine-weighted hemisphere directions around +Y (Hammersley), shared by every sample point. */
function hemisphere(n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let bits = i;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    const u = (i + 0.5) / n;
    const v = bits / 4294967296;
    const r = Math.sqrt(u);
    const phi = 2 * Math.PI * v + 0.37;
    out[i * 3] = r * Math.cos(phi);
    out[i * 3 + 1] = Math.sqrt(Math.max(0, 1 - u));
    out[i * 3 + 2] = r * Math.sin(phi);
  }
  return out;
}

/** Uniform sphere directions (Fibonacci), for scattering light into virtual point lights. */
function sphere(n: number): Float32Array {
  const out = new Float32Array(n * 3);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out[i * 3] = Math.cos(ga * i) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(ga * i) * r;
  }
  return out;
}

/** Uniform spatial hash of indices for range queries. */
class Grid {
  private readonly cells = new Map<number, number[]>();
  constructor(private readonly size: number) {}
  private key(ix: number, iy: number, iz: number): number {
    return ((ix + 512) * 1024 + (iz + 512)) * 64 + (iy + 32);
  }
  insertSphere(i: number, x: number, y: number, z: number, r: number): void {
    const s = this.size;
    for (let ix = Math.floor((x - r) / s); ix <= Math.floor((x + r) / s); ix++)
      for (let iy = Math.floor((y - r) / s); iy <= Math.floor((y + r) / s); iy++)
        for (let iz = Math.floor((z - r) / s); iz <= Math.floor((z + r) / s); iz++) {
          const k = this.key(ix, iy, iz);
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(i);
        }
  }
  query(x: number, y: number, z: number): number[] | undefined {
    const s = this.size;
    return this.cells.get(this.key(Math.floor(x / s), Math.floor(y / s), Math.floor(z / s)));
  }
}

const AO_DIRS = hemisphere(10);
const AO_DIRS_FAST = hemisphere(8);

/** Albedo assumed for first-bounce light. */
const BOUNCE_ALBEDO = 0.65;
const LIGHT_RADIUS = 0.6;
/** Upward direction cosines over which a lamp shade cuts the light off. */
const SHADE_RIM = [-0.15, 0.25] as const;
const VPL_RANGE = 5.5;

/**
 * Everything needed to evaluate static lighting at a point: sky visibility (ambient occlusion),
 * direct light from the map's static lights with ray-traced shadows, and one bounce of
 * indirect light through virtual point lights.
 */
export class LightField {
  readonly tracer: BakeTracer;
  readonly lights: FieldLight[] = [];
  private readonly lightGrid = new Grid(8);
  // VPL: position, normal, flux rgb.
  private vpl = new Float32Array(0);
  private vplCount = 0;
  private readonly vplGrid = new Grid(VPL_RANGE);
  private readonly tmp = new THREE.Color();
  private readonly tx = new Float32Array(3);
  private readonly ty = new Float32Array(3);

  constructor(map: MapDefinition) {
    this.tracer = new BakeTracer(map);
    for (const l of map.lights) this.addLight(l);
    this.buildVpls();
  }

  private addLight(l: LightSpec): void {
    const c = this.tmp.setHex(l.color);
    const spot = l.kind === 'spot';
    let dx = 0, dy = -1, dz = 0;
    if (spot) {
      dx = (l.tx ?? l.x) - l.x; dy = (l.ty ?? 0) - l.y; dz = (l.tz ?? l.z) - l.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
    }
    const angle = l.angle ?? Math.PI / 3;
    const fl: FieldLight = {
      x: l.x, y: l.y, z: l.z,
      r: c.r * l.intensity, g: c.g * l.intensity, b: c.b * l.intensity,
      range: l.range, decay: l.decay ?? 2, spot, dx, dy, dz,
      cosOuter: Math.cos(angle), cosInner: Math.cos(angle * (1 - (l.penumbra ?? 0))),
    };
    this.lightGrid.insertSphere(this.lights.length, l.x, l.y, l.z, l.range);
    this.lights.push(fl);
  }

  /** Three.js punctual light falloff (physically based mode) times the spot cone. */
  private falloff(l: FieldLight, d: number, ux: number, uy: number, uz: number): number {
    // Fixtures have size: clamp the near field so surfaces right next to a bulb don't blow out.
    let f = 1 / Math.max(Math.pow(Math.max(d, LIGHT_RADIUS), l.decay), 0.01);
    const q = d / l.range;
    const w = Math.max(0, 1 - q * q * q * q);
    f *= w * w;
    if (l.spot) {
      const cosA = ux * l.dx + uy * l.dy + uz * l.dz;
      if (cosA <= l.cosOuter) return 0;
      const t = Math.min(1, (cosA - l.cosOuter) / Math.max(1e-4, l.cosInner - l.cosOuter));
      f *= t * t * (3 - 2 * t);
    } else {
      // Shades and fixture housings send point light downward: full strength below the rim,
      // nothing above it. Ceilings are then lit by the bounce, which is smooth at vertex density.
      const t = Math.min(1, Math.max(0, (uy - SHADE_RIM[0]) / (SHADE_RIM[1] - SHADE_RIM[0])));
      f *= 1 - t * t * (3 - 2 * t);
    }
    return f;
  }

  /** Scatters each light into the scene once and records where it lands as virtual point lights. */
  private buildVpls(): void {
    const data: number[] = [];
    const tr = this.tracer;
    for (const l of this.lights) {
      // Uniform directions; each accepted ray carries the light's flux through its solid angle.
      const dirs = sphere(l.spot ? 384 : 64);
      const omega = (4 * Math.PI) / (dirs.length / 3);
      for (let i = 0; i < dirs.length / 3; i++) {
        const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
        if (l.spot && dx * l.dx + dy * l.dy + dz * l.dz <= l.cosOuter) continue;
        if (!tr.intersect(l.x, l.y, l.z, dx, dy, dz, l.range, 0.0)) continue;
        const h = tr.hit;
        const d = Math.max(h.t, 0.05);
        const f = this.falloff(l, d, dx, dy, dz) * d * d;
        if (f <= 0) continue;
        const k = f * omega * BOUNCE_ALBEDO;
        if (k * (l.r + l.g + l.b) < 1e-3) continue;
        data.push(l.x + dx * d + h.nx * 0.05, l.y + dy * d + h.ny * 0.05, l.z + dz * d + h.nz * 0.05, h.nx, h.ny, h.nz, l.r * k, l.g * k, l.b * k);
      }
    }
    this.vpl = new Float32Array(data);
    this.vplCount = data.length / 9;
    for (let i = 0; i < this.vplCount; i++) this.vplGrid.insertSphere(i, this.vpl[i * 9], this.vpl[i * 9 + 1], this.vpl[i * 9 + 2], VPL_RANGE);
  }

  private frame(nx: number, ny: number, nz: number): void {
    // Tangent frame from the normal (deterministic, so coplanar points share it).
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(ny) > 0.95) { ax = 1; ay = 0; az = 0; }
    let tx = ay * nz - az * ny, ty = az * nx - ax * nz, tz = ax * ny - ay * nx;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    this.tx[0] = tx; this.tx[1] = ty; this.tx[2] = tz;
    this.ty[0] = ny * tz - nz * ty; this.ty[1] = nz * tx - nx * tz; this.ty[2] = nx * ty - ny * tx;
  }

  /** Fraction of the hemisphere above the surface that is open (cosine weighted). */
  ao(px: number, py: number, pz: number, nx: number, ny: number, nz: number, maxDist: number, fast = false): number {
    const dirs = fast ? AO_DIRS_FAST : AO_DIRS;
    const n = dirs.length / 3;
    this.frame(nx, ny, nz);
    const t = this.tx, b = this.ty;
    const ox = px + nx * 0.02, oy = py + ny * 0.02, oz = pz + nz * 0.02;
    let open = 0;
    for (let i = 0; i < n; i++) {
      const u = dirs[i * 3], v = dirs[i * 3 + 1], w = dirs[i * 3 + 2];
      const dx = t[0] * u + nx * v + b[0] * w;
      const dy = t[1] * u + ny * v + b[1] * w;
      const dz = t[2] * u + nz * v + b[2] * w;
      if (!this.tracer.occluded(ox, oy, oz, dx, dy, dz, maxDist)) open++;
    }
    return open / n;
  }

  /** Direct irradiance from static lights at a surface point (ray-traced shadows). */
  direct(px: number, py: number, pz: number, nx: number, ny: number, nz: number, out: Float32Array, crowns = true): void {
    out[0] = out[1] = out[2] = 0;
    const list = this.lightGrid.query(px, py, pz);
    if (!list) return;
    const ox = px + nx * 0.03, oy = py + ny * 0.03, oz = pz + nz * 0.03;
    for (const i of list) {
      const l = this.lights[i];
      let lx = l.x - px, ly = l.y - py, lz = l.z - pz;
      const d = Math.hypot(lx, ly, lz);
      if (d >= l.range || d < 1e-4) continue;
      lx /= d; ly /= d; lz /= d;
      const ndl = nx * lx + ny * ly + nz * lz;
      if (ndl <= 0) continue;
      const f = this.falloff(l, d, -lx, -ly, -lz) * ndl;
      if (f * (l.r + l.g + l.b) < 1e-4) continue;
      if (this.tracer.occluded(ox, oy, oz, lx, ly, lz, d - 0.12, 0.01, crowns)) continue;
      out[0] += l.r * f; out[1] += l.g * f; out[2] += l.b * f;
    }
  }

  /** One-bounce indirect irradiance from the virtual point lights (no shadow rays; cosine-limited). */
  indirect(px: number, py: number, pz: number, nx: number, ny: number, nz: number, out: Float32Array, add = true): void {
    if (!add) out[0] = out[1] = out[2] = 0;
    const list = this.vplGrid.query(px, py, pz);
    if (!list) return;
    const v = this.vpl;
    for (const i of list) {
      const k = i * 9;
      let dx = px - v[k], dy = py - v[k + 1], dz = pz - v[k + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > VPL_RANGE * VPL_RANGE) continue;
      const d = Math.sqrt(d2) || 1e-4;
      dx /= d; dy /= d; dz /= d;
      const emit = v[k + 3] * dx + v[k + 4] * dy + v[k + 5] * dz;
      if (emit <= 0) continue;
      const recv = -(nx * dx + ny * dy + nz * dz);
      if (recv <= 0) continue;
      const q = d / VPL_RANGE;
      const win = (1 - q * q) * (1 - q * q);
      const f = (emit * recv * win) / (Math.PI * Math.max(d2, 0.6));
      out[0] += v[k + 6] * f; out[1] += v[k + 7] * f; out[2] += v[k + 8] * f;
    }
  }

  /**
   * Lighting at a free point (no surface): sky visibility, and each visible light's irradiance
   * on a surface facing it. Used for character probes and auto-exposure.
   */
  probe(px: number, py: number, pz: number, out: { ao: number; ambient: Float32Array; dirs: { x: number; y: number; z: number; r: number; g: number; b: number }[] }): void {
    let open = 0;
    const n = AO_DIRS.length / 3;
    for (let i = 0; i < n; i++) {
      // Upper hemisphere for the sky term.
      if (!this.tracer.occluded(px, py, pz, AO_DIRS[i * 3], AO_DIRS[i * 3 + 1], AO_DIRS[i * 3 + 2], 8, 0)) open++;
    }
    out.ao = open / n;
    out.ambient[0] = out.ambient[1] = out.ambient[2] = 0;
    out.dirs.length = 0;
    const list = this.lightGrid.query(px, py, pz);
    if (list) {
      for (const i of list) {
        const l = this.lights[i];
        let lx = l.x - px, ly = l.y - py, lz = l.z - pz;
        const d = Math.hypot(lx, ly, lz);
        if (d >= l.range || d < 1e-4) continue;
        lx /= d; ly /= d; lz /= d;
        const f = this.falloff(l, d, -lx, -ly, -lz);
        if (f * (l.r + l.g + l.b) < 1e-4) continue;
        if (this.tracer.occluded(px, py, pz, lx, ly, lz, d - 0.12, 0)) continue;
        out.dirs.push({ x: lx, y: ly, z: lz, r: l.r * f, g: l.g * f, b: l.b * f });
      }
    }
    // Indirect: average over a few receiver orientations.
    const acc = out.ambient;
    const tmp = new Float32Array(3);
    for (const [nx, ny, nz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]] as const) {
      this.indirect(px, py, pz, nx, ny, nz, tmp, false);
      acc[0] += tmp[0] / 6; acc[1] += tmp[1] / 6; acc[2] += tmp[2] / 6;
    }
  }

  get vplTotal(): number {
    return this.vplCount;
  }
}
