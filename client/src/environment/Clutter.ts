import * as THREE from 'three';
import { propColliders, rng, type MapDefinition, type OrientedBox, type StaticBox } from '@dead-hours/shared';
import type { MaterialLibrary } from '../rendering/Materials';
import type { StaticBatcher } from '../rendering/StaticBatcher';

/**
 * Visual-only clutter scattered over the map at build time: litter and leaves along the streets and
 * lawns, and papers, books, broken glass and cans inside the homes. Every piece is flat or a few
 * centimeters tall and has no collision, so doors, stairs, windows and zombie paths stay exactly as
 * the map defines them. Everything merges into the static batch (a handful of draw calls) and takes
 * baked light like the floor it lies on.
 */

const FLOORS = new Set(['woodFloor', 'tile', 'carpet', 'concrete']);
const LEAF_COLORS = [0x6b3f1c, 0x7d5222, 0x5a3418, 0x8a5a24, 0x4a3a1c, 0x6e2a16, 0x5b4a22];
const PAPER_COLORS = [0xa8a496, 0x9a947f, 0xb0aa9a, 0x8c897e, 0xa49b78];
const CAN_COLORS = [0x8c1d18, 0x9aa0a6, 0x1d3f8c, 0x2a5a2a, 0xc0a020];
const BOOK_COLORS = [0x5a1e1a, 0x1e3a5a, 0x2e4a2a, 0x6a5a3a, 0x3a2a4a, 0x8a7a5a];

interface Spot { x: number; y: number; z: number }

export class Clutter {
  private readonly r = rng(9173);
  private readonly blockers: OrientedBox[] = [];
  private readonly colliding: StaticBox[];
  private readonly paint: THREE.MeshStandardMaterial;
  private readonly paper: THREE.MeshStandardMaterial;
  private readonly glass: THREE.MeshStandardMaterial;
  private readonly metal: THREE.MeshStandardMaterial;
  private readonly tmp = new THREE.Color();
  /** Pieces placed (for tests and the stats overlay). */
  count = 0;

  constructor(private readonly map: MapDefinition, lib: MaterialLibrary, private readonly batch: StaticBatcher, private readonly density: number) {
    for (const p of map.props) if (!p.forest) this.blockers.push(...propColliders(p));
    this.colliding = map.solids.filter((s) => s.collide !== false);
    const make = (id: string, o: THREE.MeshStandardMaterialParameters) =>
      lib.custom(id, () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, ...o }));
    this.paint = make('clutter-paint', { roughness: 0.92, side: THREE.DoubleSide });
    this.paper = make('clutter-paper', { roughness: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 });
    this.glass = make('clutter-glass', { roughness: 0.05, metalness: 0.6, color: 0x9fb4c0 });
    this.metal = make('clutter-metal', { roughness: 0.35, metalness: 0.7 });
  }

  /** Same for every graphics setting: the pieces are baked static geometry (a change would re-bake). */
  static build(map: MapDefinition, lib: MaterialLibrary, batch: StaticBatcher, density = 1): number {
    const c = new Clutter(map, lib, batch, density);
    c.streets();
    c.interiors();
    return c.count;
  }

  // ---------- placement ----------

  /** Top of the walkable surface under (x, z) at or below `maxY` (the lawn is y = 0). */
  private surface(x: number, z: number, maxY: number, minY = -10): number {
    let best = minY <= 0 && maxY >= 0 ? 0 : -Infinity;
    for (const s of this.map.solids) {
      if (s.mat === 'invisible' || s.rotX || s.rotZ) continue;
      // Thin non-colliding overlays (road asphalt, tiled floors) are still what the pieces lie on.
      if (s.collide === false && s.h > 0.05) continue;
      if (Math.abs(x - s.x) > s.w / 2 || Math.abs(z - s.z) > s.d / 2) continue;
      const top = s.y + s.h / 2;
      if (top <= maxY + 0.02 && top >= minY && top > best) best = top;
    }
    return best;
  }

  /** Nothing solid in the first 1.2 m above the spot (walls, counters, furniture, cars). */
  private clear(x: number, y: number, z: number, margin = 0.08): boolean {
    for (const s of this.colliding) {
      const bottom = s.y - s.h / 2, top = s.y + s.h / 2;
      if (top <= y + 0.03 || bottom > y + 1.2) continue;
      if (Math.abs(x - s.x) < s.w / 2 + margin && Math.abs(z - s.z) < s.d / 2 + margin) return false;
    }
    for (const b of this.blockers) {
      if (b.y + b.hy <= y || b.y - b.hy > y + 1.2) continue;
      const dx = x - b.x, dz = z - b.z;
      const c = Math.cos(b.rotY), s = Math.sin(b.rotY);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < b.hx + margin && Math.abs(lz) < b.hz + margin) return false;
    }
    return true;
  }

  /** Keeps doorways, stair runs and their landings free of clutter (they read as walking lines). */
  private nearOpening(x: number, y: number, z: number): boolean {
    for (const d of this.map.doors) {
      const floor = d.floorY ?? d.y - d.h / 2;
      if (Math.abs(floor - y) > 0.6) continue;
      if (Math.hypot(x - d.x, z - d.z) < d.w / 2 + 0.7) return true;
    }
    for (const s of this.map.stairs) {
      if (y < Math.min(s.y0, s.y1) - 0.4 || y > Math.max(s.y0, s.y1) + 0.4) continue;
      const lo = Math.min(s.from, s.to) - 0.9, hi = Math.max(s.from, s.to) + 0.9;
      const a0 = Math.min(s.a0, s.a1) - 0.3, a1 = Math.max(s.a0, s.a1) + 0.3;
      const along = s.axis === 'x' ? x : z, across = s.axis === 'x' ? z : x;
      if (along > lo && along < hi && across > a0 && across < a1) return true;
    }
    return false;
  }

  // ---------- pieces ----------

  private colorize(g: THREE.BufferGeometry, hex: number, vary = 0.12): THREE.BufferGeometry {
    const k = 1 - vary + this.r() * vary * 2;
    this.tmp.setHex(hex).multiplyScalar(k);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([this.tmp.r, this.tmp.g, this.tmp.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  }

  private place(g: THREE.BufferGeometry, m: THREE.Material, at: Spot, yaw: number, lift: number): void {
    g.rotateY(yaw);
    g.translate(at.x, at.y + lift, at.z);
    this.batch.add(g, m, false, true);
    this.count++;
  }

  /** A crumpled or flat sheet: a slightly bent quad lying on the surface. */
  private sheet(at: Spot, w: number, d: number, hex: number, crumple: number): void {
    const g = new THREE.PlaneGeometry(w, d, 2, 2);
    g.rotateX(-Math.PI / 2);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setY(i, Math.abs(p.getX(i)) * crumple * this.r() + Math.abs(p.getZ(i)) * crumple * this.r());
    g.computeVertexNormals();
    this.place(this.colorize(g, hex, 0.1), this.paper, at, this.r() * Math.PI * 2, 0.006);
  }

  private leaf(at: Spot): void {
    const s = 0.06 + this.r() * 0.07;
    const g = new THREE.BufferGeometry();
    const tip = this.r() * 0.02;
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -s, 0.004, 0, 0, tip, s * 0.42, s, 0.004 + tip, 0, 0, tip * 0.5, -s * 0.42,
    ], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    this.place(this.colorize(g, LEAF_COLORS[Math.floor(this.r() * LEAF_COLORS.length)], 0.25), this.paint, at, this.r() * Math.PI * 2, 0.004);
  }

  private can(at: Spot): void {
    const g = new THREE.CylinderGeometry(0.033, 0.033, 0.12, 7);
    g.rotateZ(Math.PI / 2);
    if (this.r() < 0.4) g.scale(1, 0.55, 1); // crushed
    this.place(this.colorize(g, CAN_COLORS[Math.floor(this.r() * CAN_COLORS.length)], 0.1), this.metal, at, this.r() * Math.PI * 2, 0.02);
  }

  private bottle(at: Spot): void {
    const g = new THREE.CylinderGeometry(0.012, 0.035, 0.24, 6);
    g.rotateZ(Math.PI / 2);
    this.place(this.colorize(g, this.r() < 0.6 ? 0x2a1a08 : 0x123a18, 0.2), this.glass, at, this.r() * Math.PI * 2, 0.035);
  }

  private shards(at: Spot): void {
    for (let i = 0, n = 3 + Math.floor(this.r() * 4); i < n; i++) {
      const s = 0.03 + this.r() * 0.08;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.003, 0, s, 0.003, s * (this.r() - 0.5), s * (this.r() - 0.2), 0.003, s], 3));
      g.computeVertexNormals();
      const spot = { x: at.x + (this.r() - 0.5) * 0.7, y: at.y, z: at.z + (this.r() - 0.5) * 0.7 };
      this.place(this.colorize(g, 0xffffff, 0), this.glass, spot, this.r() * Math.PI * 2, 0.002);
    }
  }

  private book(at: Spot): void {
    const open = this.r() < 0.35;
    const w = 0.15 + this.r() * 0.06, d = 0.2 + this.r() * 0.06;
    const hex = BOOK_COLORS[Math.floor(this.r() * BOOK_COLORS.length)];
    if (open) {
      // Splayed face down: two covers in a shallow tent.
      for (const side of [-1, 1]) {
        const g = new THREE.BoxGeometry(w, 0.012, d);
        g.translate(side * w / 2, 0, 0);
        g.rotateZ(side * -0.18);
        this.place(this.colorize(g, hex, 0.1), this.paint, { ...at }, 0, 0.02);
      }
      return;
    }
    const g = new THREE.BoxGeometry(w, 0.03 + this.r() * 0.02, d);
    this.place(this.colorize(g, hex, 0.1), this.paint, at, this.r() * Math.PI * 2, 0.02);
  }

  // ---------- areas ----------

  /** One piece of street litter: mostly leaves, then paper, cans and bottles. */
  private litter(x: number, z: number, maxY = 0.4): void {
    const y = this.surface(x, z, maxY);
    if (!Number.isFinite(y) || !this.clear(x, y, z, 0.05)) return;
    const roll = this.r();
    if (roll < 0.6) this.leaf({ x, y, z });
    else if (roll < 0.85) this.sheet({ x, y, z }, 0.18 + this.r() * 0.14, 0.22 + this.r() * 0.12, PAPER_COLORS[Math.floor(this.r() * PAPER_COLORS.length)], this.r() * 0.15);
    else if (roll < 0.95) this.can({ x, y, z });
    else this.bottle({ x, y, z });
  }

  /** Gutters (the first meter of road along each curb) and sidewalks collect most of the litter. */
  private curbs(): void {
    for (const s of this.map.solids) {
      if (s.mat !== 'asphalt' && s.mat !== 'sidewalk') continue;
      const alongX = s.w >= s.d;
      const len = alongX ? s.w : s.d, wid = alongX ? s.d : s.w;
      const n = Math.round(len * wid * (s.mat === 'asphalt' ? 0.12 : 0.18) * this.density);
      for (let i = 0; i < n; i++) {
        const a = (this.r() - 0.5) * len;
        let b = (this.r() - 0.5) * wid;
        // On the road, push most pieces into the gutters along either curb.
        if (s.mat === 'asphalt' && this.r() < 0.8) b = (this.r() < 0.5 ? -1 : 1) * (wid / 2 - 0.1 - Math.pow(this.r(), 2) * 1.1);
        const x = s.x + (alongX ? a : b), z = s.z + (alongX ? b : a);
        this.litter(x, z);
      }
    }
  }

  /** Sidewalks, gutters, lawns and the leaf drifts under street trees. */
  private streets(): void {
    this.curbs();
    // Lawn litter over the streets' blocks, not out in the woods: 900 pieces over Elm Street's block
    // (the whole width, 70 m either side of the road), the same density over Oak Street's.
    const b = this.map.bounds;
    const x0 = b.x0 * 0.95, x1 = b.x1 * 0.95, z0 = -70, z1 = Math.min(b.z1 - 30, 140);
    const target = Math.round(900 * ((z1 - z0) / 140) * this.density);
    const houses = this.map.houses;
    let placed = 0;
    for (let tries = 0; placed < target && tries < target * 6; tries++) {
      const x = x0 + this.r() * (x1 - x0), z = z0 + this.r() * (z1 - z0);
      if (houses.some((h) => Math.abs(x - h.x) < h.w / 2 + 0.3 && Math.abs(z - h.z) < h.d / 2 + 0.3)) continue;
      this.litter(x, z);
      placed++;
    }
    // Leaves drift under the yard and street trees.
    for (const t of this.map.props) {
      if (t.kind !== 'tree' && t.kind !== 'bush') continue;
      const n = Math.round((t.kind === 'tree' ? 40 : 8) * this.density);
      for (let i = 0; i < n; i++) {
        const a = this.r() * Math.PI * 2, d = 0.4 + Math.sqrt(this.r()) * (t.kind === 'tree' ? 3.8 : 1.2);
        const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
        const y = this.surface(x, z, 0.4);
        if (Number.isFinite(y) && this.clear(x, y, z, 0.02)) this.leaf({ x, y, z });
      }
    }
  }

  /** Floors inside every enterable building: papers, books, cans; glass under the windows. */
  private interiors(): void {
    for (const h of this.map.houses) {
      if (!h.enterable) continue;
      const inside = (x: number, z: number) => Math.abs(x - h.x) < h.w / 2 - 0.2 && Math.abs(z - h.z) < h.d / 2 - 0.2;
      const floors = this.map.solids.filter((s) => FLOORS.has(s.mat) && s.h <= 0.45 && s.w * s.d > 2 && inside(s.x, s.z));
      for (const f of floors) {
        const top = f.y + f.h / 2;
        const n = Math.round(f.w * f.d * 0.32 * this.density);
        for (let i = 0; i < n; i++) {
          const x = f.x + (this.r() - 0.5) * (f.w - 0.3), z = f.z + (this.r() - 0.5) * (f.d - 0.3);
          // The floor really is the top surface here (not covered by a slab just above).
          if (Math.abs(this.surface(x, z, top + 0.3, top - 0.3) - top) > 0.01) continue;
          if (!this.clear(x, top, z) || this.nearOpening(x, top, z)) continue;
          const roll = this.r();
          const at = { x, y: top, z };
          if (roll < 0.5) this.sheet(at, 0.21, 0.28, PAPER_COLORS[Math.floor(this.r() * PAPER_COLORS.length)], this.r() * 0.05);
          else if (roll < 0.78) this.book(at);
          else if (roll < 0.9) this.can(at);
          else this.bottle(at);
        }
      }
      // Broken glass inside a few ground and upper floor windows.
      for (const w of this.map.windows) {
        if (w.houseId !== h.id || w.plain || this.r() > 0.4 * this.density) continue;
        const sill = w.y - w.h / 2;
        const nx = w.axis === 'x' ? 0 : -w.outward, nz = w.axis === 'x' ? -w.outward : 0;
        const x = w.x + nx * 0.6, z = w.z + nz * 0.6;
        const top = this.surface(x, z, sill - 0.3, sill - 1.5);
        if (!Number.isFinite(top) || !this.clear(x, top, z, 0) || this.nearOpening(x, top, z)) continue;
        this.shards({ x, y: top, z });
      }
    }
  }
}
