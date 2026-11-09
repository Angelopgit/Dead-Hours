import * as THREE from 'three';
import {
  STORY, STRUCTURE_STATE, WATER_TOWER, standsAfter,
  type HouseSpec, type MapDefinition, type MaterialKey, type Part, type SimEvent, type Simulation, type StaticBox, type Structure, type Vec3,
} from '@dead-hours/shared';
import { showPiece, type BatchPiece } from '../rendering/StaticBatcher';
import { worldPieces } from '../environment/WorldPieces';
import type { Physics } from '../core/Physics';
import { DECAL, type DecalBatch } from '../effects/Decals';
import type { Pyro } from '../effects/Pyro';
import type { Rubble } from '../effects/Rubble';

/** What each wall and floor material breaks into (its colour as rubble). */
const TONE: Partial<Record<MaterialKey, number>> = {
  sidingBlue: 0x4a5a6e, sidingGreen: 0x4b5a47, sidingGray: 0x6a6b6a, sidingBeige: 0x8a7e69, brick: 0x6b4234, stucco: 0x8d8574,
  interiorWall: 0x9b9383, interiorWallBlue: 0x6f7c86, woodFloor: 0x6b4a32, carpet: 0x57504a, tile: 0x8a8a84, trim: 0xa9a394,
  darkWood: 0x3e2c1f, fenceWood: 0x5a4632, metal: 0x4d5257, roofFlat: 0x3a3b3d, concrete: 0x6f706b, curb: 0x76766f,
};
/** Rubble tags: the ragged edges of holes (taken away when the wall beside them goes), and everything else. */
const RIM = 1, LOOSE = 2;
/** Most pieces one falling structure is cut into. */
const FALL_PIECES = 250;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _size = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _col = new THREE.Color();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** A seeded stream for what should look the same to everyone (the stumps of a hole, what a ruin is strewn with). */
function seeded(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/**
 * Walls blown open and structures brought down (sim/Structures), as they are seen. A bay of wall
 * that goes is taken out of the static world with whatever hung on it, its edges left ragged, and
 * its pieces thrown through the room as rigid bodies; a blast that only cracks it leaves the
 * cracks. A structure that falls is taken out whole above its floor and comes down as a few
 * hundred tumbling pieces in a cloud of dust, which stay where they land. What is standing is
 * read from the simulation every frame, so a survivor who joins late sees the same holes and
 * ruins; the flying pieces, dust and noise come with the events. Everything is put back when the
 * night ends.
 */
export class StructureView {
  private readonly shown: boolean[];
  private readonly state: number[];
  private readonly hidden = new Set<BatchPiece>();
  private readonly bounds = new Map<BatchPiece, THREE.Box3>();
  /** The solids each part is made of, and each structure's that go when it falls. */
  private readonly partSolids: StaticBox[][];
  private readonly ownSolids = new Map<string, StaticBox[]>();
  /** Structures that are going: when each next creaks. */
  private readonly creaks = new Map<number, number>();
  private time = 0;
  /** Sounds and camera shake are the session's to make. */
  onBreach: ((pos: THREE.Vector3, gone: boolean) => void) | null = null;
  onCreak: ((pos: THREE.Vector3) => void) | null = null;
  onCollapse: ((pos: THREE.Vector3, size: number) => void) | null = null;

  constructor(
    private readonly sim: Simulation, private readonly map: MapDefinition, private readonly physics: Physics,
    private readonly decals: DecalBatch, private readonly pyro: Pyro, private readonly rubble: Rubble,
  ) {
    this.shown = sim.structures.parts.map(() => false);
    this.state = sim.structures.list.map(() => STRUCTURE_STATE.standing);
    this.partSolids = map.parts.map(() => []);
    const specs = new Map(map.structures.map((s) => [s.id, s]));
    for (const s of map.solids) {
      if (s.part !== undefined) this.partSolids[s.part].push(s);
      const spec = s.owner ? specs.get(s.owner) : undefined;
      if (!spec || standsAfter(s, spec)) continue;
      const list = this.ownSolids.get(spec.id) ?? [];
      list.push(s);
      this.ownSolids.set(spec.id, list);
    }
  }

  // ------------------------------------------------------------------ what stands

  update(dt: number): void {
    this.time += dt;
    const st = this.sim.structures;
    for (const s of st.list) {
      if (s.state === this.state[s.index]) continue;
      this.state[s.index] = s.state;
      if (s.state === STRUCTURE_STATE.fallen) this.level(s);
    }
    for (const part of st.parts) {
      if (!part.gone || this.shown[part.index]) continue;
      this.shown[part.index] = true;
      this.hole(part);
    }
    // One that is going groans and sheds dust until it falls.
    for (const [index, next] of this.creaks) {
      const s = st.list[index];
      if (!s || s.state !== STRUCTURE_STATE.going) {
        this.creaks.delete(index);
        continue;
      }
      if (this.time < next) continue;
      this.creaks.set(index, this.time + rand(0.3, 0.6));
      const part = s.parts[Math.floor(Math.random() * s.parts.length)];
      if (!part) continue;
      _a.set(part.spec.x, part.spec.y + part.spec.h * 0.3, part.spec.z);
      this.pyro.dust(_a, _size.set(1.5, 1, 1.5), 0.5);
      this.onCreak?.(_a);
    }
  }

  private hide(pieces: readonly BatchPiece[] | undefined): void {
    if (!pieces) return;
    for (const p of pieces) {
      if (this.hidden.has(p)) continue;
      // Measured while it can still be seen.
      this.box(p);
      showPiece(p, false);
      this.hidden.add(p);
    }
  }

  /** A batch piece's bounding box. */
  private box(p: BatchPiece): THREE.Box3 {
    let b = this.bounds.get(p);
    if (b) return b;
    b = new THREE.Box3();
    const pos = p.mesh?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pos) {
      const arr = p.saved ?? (pos.array as Float32Array);
      const from = p.saved ? 0 : p.start * 3;
      for (let i = 0; i < p.count; i++) b.expandByPoint(_c.set(arr[from + i * 3], arr[from + i * 3 + 1], arr[from + i * 3 + 2]));
    }
    this.bounds.set(p, b);
    return b;
  }

  /** The box a bay or pillar fills, grown by `along` (the wall's run), `across` (through it) and `up`. */
  private span(part: Part, along: number, across: number, up: number): void {
    const p = part.spec;
    const run = p.kind === 'pillar' ? p.w / 2 : p.w / 2, thick = p.kind === 'pillar' ? p.w / 2 : STORY.wall / 2;
    const hx = (p.kind === 'pillar' || p.axis === 'x' ? run + along : thick + across);
    const hz = (p.kind === 'pillar' ? run + along : p.axis === 'x' ? thick + across : run + along);
    _min.set(p.x - hx, p.y - p.h / 2 - up, p.z - hz);
    _max.set(p.x + hx, p.y + p.h / 2 + up, p.z + hz);
  }

  /** A bay or pillar is gone: out of the world, with what hung on it and the marks it carried. */
  private hole(part: Part): void {
    this.hide(worldPieces.groups.get(`part:${part.index}`));
    const s = part.structure;
    if (!s || s.state === STRUCTURE_STATE.fallen) return;
    const p = part.spec;
    // Shutters, pictures, a lamp: whatever of the building sat wholly on this stretch of wall.
    this.span(part, 0.03, 0.5, 0.05);
    for (const piece of worldPieces.groups.get(s.spec.id) ?? []) {
      if (this.hidden.has(piece)) continue;
      const b = this.box(piece);
      if (b.isEmpty() || b.min.x < _min.x || b.max.x > _max.x || b.min.y < _min.y || b.max.y > _max.y || b.min.z < _min.z || b.max.z > _max.z) continue;
      this.hide([piece]);
    }
    this.span(part, 0.05, 0.12, 0.1);
    this.decals.removeIn(_min, _max);
    this.span(part, 0.3, 0.3, 0.3);
    this.rubble.removeIn(RIM, _min, _max);
    if (p.kind === 'pillar') this.stump(part);
    else this.rim(part);
  }

  private tone(mat: MaterialKey, r: () => number, out: THREE.Color): THREE.Color {
    return out.setHex(TONE[mat] ?? 0x777777).multiplyScalar(0.8 + r() * 0.35);
  }

  /** The broken edges of a hole: stumps of wall sticking in from each side and hanging from the top. */
  private rim(part: Part): void {
    const p = part.spec;
    const r = seeded(part.index + 1);
    const solids = this.partSolids[part.index];
    if (!solids.length) return;
    const ax = p.axis === 'x' ? 1 : 0, az = p.axis === 'x' ? 0 : 1;
    const others = this.sim.structures.parts;
    for (const end of [-1, 1]) {
      // No stumps where the bay beside it is gone too.
      const ex = p.x + ax * end * (p.w / 2 + 0.3), ez = p.z + az * end * (p.w / 2 + 0.3);
      if (others.some((o) => o !== part && o.gone && o.spec.kind === 'bay' && o.spec.storey === p.storey && Math.abs(o.spec.x - ex) <= (o.spec.axis === 'x' ? o.spec.w / 2 : 0.3) && Math.abs(o.spec.z - ez) <= (o.spec.axis === 'x' ? 0.3 : o.spec.w / 2))) continue;
      for (let i = 0, n = 7; i < n; i++) {
        const s = solids[Math.floor(r() * solids.length)];
        const len = 0.1 + r() * 0.32, h = 0.22 + r() * 0.4;
        const thick = (p.axis === 'x' ? s.d : s.w) * 0.95;
        const y = p.floor + (i + r()) * (p.h / n);
        const u = end * (p.w / 2 - len / 2 + 0.02);
        _a.set(p.axis === 'x' ? p.x + u : s.x, Math.min(y, p.floor + p.h - h / 2), p.axis === 'x' ? s.z : p.z + u);
        _size.set(p.axis === 'x' ? len : thick, h, p.axis === 'x' ? thick : len);
        _q.setFromEuler(_e.set(p.axis === 'x' ? 0 : (r() - 0.5) * 0.5, 0, p.axis === 'x' ? (r() - 0.5) * 0.5 : 0));
        this.rubble.place(_a, _size, _q, this.tone(s.mat, r, _col), RIM);
      }
    }
    // What hangs from the top of the hole.
    for (let i = 0, n = Math.max(2, Math.round(p.w / 0.45)); i < n; i++) {
      const s = solids[Math.floor(r() * solids.length)];
      const len = 0.2 + r() * 0.3, h = 0.08 + r() * 0.3;
      const thick = (p.axis === 'x' ? s.d : s.w) * 0.95;
      const u = ((i + r()) / n - 0.5) * (p.w - len);
      _a.set(p.axis === 'x' ? p.x + u : s.x, p.floor + p.h - h / 2 + 0.01, p.axis === 'x' ? s.z : p.z + u);
      _size.set(p.axis === 'x' ? len : thick, h, p.axis === 'x' ? thick : len);
      this.rubble.place(_a, _size, _q.identity(), this.tone(s.mat, r, _col), RIM);
    }
    // And what lies at its foot, each side.
    for (const side of [-1, 1]) {
      const nx = p.axis === 'x' ? 0 : side, nz = p.axis === 'x' ? side : 0;
      for (let i = 0; i < 7; i++) {
        const s = solids[Math.floor(r() * solids.length)];
        const off = 0.25 + r() * 0.9, u = (r() - 0.5) * p.w;
        const x = p.x + nx * off + ax * u, z = p.z + nz * off + az * u;
        const d = this.physics.raycast(x, p.floor + 1, z, 0, -1, 0, 3);
        if (d === null) continue;
        _size.set(0.12 + r() * 0.3, 0.05 + r() * 0.1, 0.1 + r() * 0.25);
        _a.set(x, p.floor + 1 - d + _size.y / 2, z);
        _q.setFromEuler(_e.set((r() - 0.5) * 0.3, r() * 6.3, (r() - 0.5) * 0.3));
        this.rubble.place(_a, _size, _q, this.tone(s.mat, r, _col), LOOSE);
      }
    }
  }

  /** What is left of a pillar: a snapped stub on its footing. */
  private stump(part: Part): void {
    const p = part.spec;
    const r = seeded(part.index + 1);
    const mat = this.partSolids[part.index][0]?.mat ?? 'concrete';
    const h = 0.25 + r() * 0.3;
    _a.set(p.x, p.floor + h / 2, p.z);
    _size.set(p.w, h, p.w);
    this.rubble.place(_a, _size, _q.setFromEuler(_e.set((r() - 0.5) * 0.2, 0, (r() - 0.5) * 0.2)), this.tone(mat, r, _col), LOOSE);
  }

  /** A structure has fallen: everything of it above its floor is out of the world. */
  private level(s: Structure): void {
    const { id, x, z, w, d, base, top } = s.spec;
    this.hide(worldPieces.groups.get(id));
    for (const part of s.parts) {
      this.shown[part.index] = true;
      this.hide(worldPieces.groups.get(`part:${part.index}`));
    }
    worldPieces.fallen.add(id);
    _min.set(x - w / 2 - 1.5, base + 0.05, z - d / 2 - 1.5);
    _max.set(x + w / 2 + 1.5, top + 4, z + d / 2 + 1.5);
    this.decals.removeIn(_min, _max);
    this.rubble.removeIn(RIM, _min, _max);
    // What a ruin is strewn with, the same for whoever sees it and whenever they came.
    const r = seeded(s.index + 77);
    const solids = this.ownSolids.get(id) ?? [];
    if (!solids.length) return;
    const n = Math.round(Math.min(70, 18 + (w * d) / 3));
    for (let i = 0; i < n; i++) {
      const src = solids[Math.floor(r() * solids.length)];
      _size.set(0.25 + r() * 0.9, 0.06 + r() * 0.16, 0.2 + r() * 0.7);
      const px = x + (r() - 0.5) * (w + 1.6), pz = z + (r() - 0.5) * (d + 1.6);
      const inside = Math.abs(px - x) < w / 2 && Math.abs(pz - z) < d / 2;
      _a.set(px, (inside ? base : 0.02) + _size.y / 2 + r() * 0.05, pz);
      _q.setFromEuler(_e.set((r() - 0.5) * 0.35, r() * 6.3, (r() - 0.5) * 0.35));
      this.rubble.place(_a, _size, _q, this.tone(src.mat, r, _col).multiplyScalar(0.8), LOOSE);
    }
  }

  // ------------------------------------------------------------------ as it happens

  /** A simulation event (the session passes on 'breach' and 'collapse'). */
  event(e: SimEvent): void {
    if (e.type === 'breach') {
      const part = this.sim.structures.parts[e.part];
      if (!part) return;
      if (e.gone) this.burst(part, e.pos);
      else this.crack(part, e.pos, e.damage);
      this.onBreach?.(_a.set(part.spec.x, part.spec.y, part.spec.z), e.gone);
      return;
    }
    if (e.type !== 'collapse') return;
    const s = this.sim.structures.list[e.structure];
    if (!s) return;
    if (e.stage === STRUCTURE_STATE.going) {
      this.creaks.set(s.index, this.time);
      return;
    }
    if (e.stage === STRUCTURE_STATE.fallen) this.fall(s);
  }

  /** Which side of a part a point is on (+1: the side its outward normal faces). */
  private side(part: Part, from: Vec3): number {
    const p = part.spec;
    return Math.sign(p.axis === 'x' ? (from.z - p.z) * p.outward : (from.x - p.x) * p.outward) || 1;
  }

  /** A blast cracked a bay without opening it: cracks across the face it struck, plaster shaken off the other. */
  private crack(part: Part, from: Vec3, damage: number): void {
    const p = part.spec;
    if (p.kind === 'pillar') return;
    const side = this.side(part, from) * p.outward;
    const ax = p.axis === 'x' ? 1 : 0, az = p.axis === 'x' ? 0 : 1;
    const nx = az * side, nz = ax * side;
    const along = THREE.MathUtils.clamp(p.axis === 'x' ? from.x - p.x : from.z - p.z, -p.w / 2 + 0.2, p.w / 2 - 0.2);
    const y = THREE.MathUtils.clamp(from.y, p.floor + 0.4, p.floor + p.h - 0.4);
    const half = STORY.wall / 2;
    for (const face of [1, -1]) {
      _b.set(nx * face, 0, nz * face);
      for (let i = 0, n = face > 0 ? 3 : 1; i < n; i++) {
        _a.set(p.x + ax * (along + rand(-0.5, 0.5)) + nx * face * half, y + rand(-0.6, 0.6), p.z + az * (along + rand(-0.5, 0.5)) + nz * face * half);
        this.decals.add(DECAL.crack, _a, _b, rand(0.9, 1.5) * (0.6 + damage * 0.6), 0.07, 0.065, 0.06, 0.9, 600);
      }
    }
    _a.set(p.x + ax * along - nx * (half + 0.2), y, p.z + az * along - nz * (half + 0.2));
    this.pyro.dust(_a, _size.set(0.6 + ax, 1.2, 0.6 + az), 0.35, _b.set(-nx * 1.5, 0, -nz * 1.5));
  }

  /** A bay or pillar blown out: its pieces fly away from the blast, in dust. */
  private burst(part: Part, from: Vec3): void {
    const p = part.spec;
    const s = part.structure;
    if (s) this.rubble.floor(s.spec.id, s.spec.x, s.spec.z, s.spec.w, s.spec.d, s.spec.base);
    const side = p.kind === 'pillar' ? 1 : this.side(part, from) * p.outward;
    const ax = p.axis === 'x' ? 1 : 0, az = p.axis === 'x' ? 0 : 1;
    // Away from the blast, through the wall.
    let px = -az * side, pz = -ax * side;
    if (p.kind === 'pillar') {
      const L = Math.hypot(p.x - from.x, p.z - from.z) || 1;
      px = (p.x - from.x) / L;
      pz = (p.z - from.z) / L;
    }
    for (const solid of this.partSolids[part.index]) this.shatter(solid, 0.62, 0.7, (pos) => {
      const near = 1 - Math.min(1, Math.hypot(pos.x - from.x, pos.y - from.y, pos.z - from.z) / 3);
      const v = rand(1.5, 4) + near * rand(2, 6);
      _vel.set(px * v + rand(-1.2, 1.2), rand(0.3, 2.2) + near * 2, pz * v + rand(-1.2, 1.2));
      _spin.set(rand(-7, 7), rand(-7, 7), rand(-7, 7));
    });
    _a.set(p.x, p.y, p.z);
    this.pyro.dust(_a, _size.set(p.kind === 'pillar' ? 1 : 0.8 + ax * p.w, p.h * 0.8, p.kind === 'pillar' ? 1 : 0.8 + az * p.w), p.kind === 'pillar' ? 1 : 2.2, _b.set(px * 2.5, 0, pz * 2.5));
  }

  /**
   * Cuts a box into pieces about `cell` across (its thin way stays whole) and lets `keep` of them
   * go; `launch` sets each one's `_vel` and `_spin` from where it starts.
   */
  private shatter(s: StaticBox, cell: number, keep: number, launch: (pos: THREE.Vector3) => void, tone?: THREE.Color): void {
    const dims = [s.w, s.h, s.d];
    const n = dims.map((v) => (v <= 0.45 ? 1 : Math.max(1, Math.round(v / cell))));
    for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) {
      if (Math.random() > keep) continue;
      const cx = dims[0] / n[0], cy = dims[1] / n[1], cz = dims[2] / n[2];
      _a.set(s.x - s.w / 2 + (i + 0.5) * cx, s.y - s.h / 2 + (j + 0.5) * cy, s.z - s.d / 2 + (k + 0.5) * cz);
      _size.set(cx * rand(0.6, 0.92), cy * rand(0.6, 0.92), cz * rand(0.75, 0.95));
      launch(_a);
      if (tone) _col.copy(tone).multiplyScalar(rand(0.8, 1.1));
      else _col.setHex(TONE[s.mat] ?? 0x777777).multiplyScalar(rand(0.75, 1.15));
      this.rubble.drop(_a, _size, _q.identity(), _vel, _spin, _col, LOOSE);
    }
  }

  /** A structure coming down: what it was built of falls as pieces, in a cloud of dust. */
  private fall(s: Structure): void {
    const { id, x, z, w, d, base, top, kind } = s.spec;
    this.rubble.floor(id, x, z, w, d, base);
    const solids = (this.ownSolids.get(id) ?? []).filter((b) => b.visible !== false && !b.glass && b.mat !== 'invisible');
    const parts = s.parts.flatMap((p) => this.partSolids[p.index]);
    const all = [...solids, ...parts];
    // The water tower goes over toward the legs it lost; everything else straight down, bulging out at the foot.
    let tx = 0, tz = 0;
    if (kind === 'tower') {
      for (const p of s.parts) if (this.shown[p.index] || p.gone) { tx += p.spec.x - x; tz += p.spec.z - z; }
      const L = Math.hypot(tx, tz);
      if (L > 0.1) { tx /= L; tz /= L; } else { tx = 1; tz = 0; }
    }
    const cell = kind === 'building' ? 1.5 : 1.9;
    let count = 0;
    for (const b of all) count += [b.w, b.h, b.d].reduce((n, v) => n * (v <= 0.45 ? 1 : Math.max(1, Math.round(v / cell))), 1);
    const roof = kind === 'building' ? this.map.houses.find((h) => h.id === id) : undefined;
    const roofCount = roof ? Math.round((w * d) / 3.2) : 0;
    const tank = kind === 'tower' ? 54 : 0;
    const keep = Math.min(1, FALL_PIECES / Math.max(1, count + roofCount + tank));
    const launch = (pos: THREE.Vector3) => {
      const dx = pos.x - x, dz = pos.z - z;
      const L = Math.hypot(dx, dz) || 1;
      const low = 1 - Math.min(1, (pos.y - base) / 3.5);
      const out = rand(0, 0.8) + low * rand(0.4, 2.2);
      const lean = kind === 'tower' ? 1.2 + (pos.y / top) * 3.5 : 0;
      _vel.set((dx / L) * out + tx * lean + rand(-0.4, 0.4), rand(-1.5, 0.2), (dz / L) * out + tz * lean + rand(-0.4, 0.4));
      _spin.set(rand(-2, 2), rand(-1.5, 1.5), rand(-2, 2));
    };
    for (const b of all) this.shatter(b, cell, keep, launch);
    if (roof) this.roof(roof, top, keep, launch);
    if (kind === 'tower') this.tank(keep, launch);
    _a.set(x, base + Math.min(3, (top - base) / 2), z);
    this.pyro.dust(_a, _size.set(w + 2, Math.min(5, top - base), d + 2), kind === 'building' ? 16 : 9);
    this.onCollapse?.(_a, kind === 'building' ? 1 : 0.6);
  }

  /** A house's roof (drawn, not built of solids) as plates in its colour. */
  private roof(h: HouseSpec, top: number, keep: number, launch: (pos: THREE.Vector3) => void): void {
    const tone = new THREE.Color(h.roofColor).multiplyScalar(0.9);
    const flat = h.roof === 'flat';
    this.shatter({ x: h.x, y: top - (flat ? 0.2 : 0.9), z: h.z, w: h.w + 0.5, h: 0.14, d: h.d + 0.5, mat: 'roofFlat' }, 1.8, keep, launch, flat ? undefined : tone);
  }

  /** The water tower's tank (drawn, not built of solids): rings of curved plate, its roof and catwalk. */
  private tank(keep: number, launch: (pos: THREE.Vector3) => void): void {
    const t = WATER_TOWER;
    const white = new THREE.Color(0xb9b6ab), dark = new THREE.Color(0x4a4e52);
    const rows = 3, around = 14;
    const h = (t.tankTop - t.tankY) / rows;
    for (let j = 0; j < rows; j++) for (let i = 0; i < around; i++) {
      if (Math.random() > keep) continue;
      const a = (i / around) * Math.PI * 2;
      _a.set(t.x + Math.cos(a) * t.radius, t.tankY + (j + 0.5) * h, t.z + Math.sin(a) * t.radius);
      _size.set(0.1, h * 0.9, ((Math.PI * 2 * t.radius) / around) * 0.9);
      launch(_a);
      this.rubble.drop(_a, _size, _q.setFromEuler(_e.set(0, -a, 0)), _vel, _spin, _col.copy(white).multiplyScalar(rand(0.85, 1.05)), LOOSE);
    }
    for (let i = 0; i < 12; i++) {
      if (Math.random() > keep) continue;
      const a = (i / 12) * Math.PI * 2, top = i % 2 === 0;
      const r = top ? t.radius * 0.55 : t.radius + 0.4;
      _a.set(t.x + Math.cos(a) * r, top ? t.tankTop + 0.6 : t.tankY + 0.1, t.z + Math.sin(a) * r);
      _size.set(top ? 2.2 : 1.6, 0.08, top ? 2.2 : 0.8);
      launch(_a);
      this.rubble.drop(_a, _size, _q.setFromEuler(_e.set(0, -a, 0)), _vel, _spin, _col.copy(top ? white : dark).multiplyScalar(rand(0.7, 0.95)), LOOSE);
    }
  }

  /** Puts everything back as the map built it. */
  dispose(): void {
    for (const p of this.hidden) showPiece(p, true);
    this.hidden.clear();
    worldPieces.fallen.clear();
    this.creaks.clear();
  }
}
