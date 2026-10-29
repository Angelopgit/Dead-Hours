import type {
  AreaSpec,
  DoorSpec,
  HouseSpec,
  LightSpec,
  MapDefinition,
  MaterialKey,
  PropKind,
  PropSpec,
  Rect,
  StaticBox,
  WallSide,
  WindowSpec,
} from '../types/world';

/**
 * Data-driven construction kit for the neighborhood. Everything here produces plain data
 * so the client (rendering + prediction) and the server (authoritative simulation)
 * build identical collision from the same source.
 *
 * Axes: +X east, +Z south, +Y up.
 */

export const STREET = {
  roadHalfWidth: 4.5,
  sidewalkWidth: 2.5,
  curbHeight: 0.15,
  length: 250,
} as const;

export const STORY = {
  slab: 0.3,
  ground: 3.0,
  floorThickness: 0.25,
  upper: 2.75,
  wall: 0.25,
} as const;

export interface Opening {
  /** Center along the wall axis, relative to the house center. */
  at: number;
  width: number;
  bottom: number;
  top: number;
  kind: 'door' | 'window' | 'doorway';
  style?: DoorSpec['style'];
  plain?: boolean;
}

export function win(at: number, width = 1.4, bottom = 0.95, top = 2.25): Opening {
  return { at, width, bottom, top, kind: 'window' };
}
export function upWin(at: number, width = 1.3): Opening {
  return { at, width, bottom: 0.85, top: 2.05, kind: 'window' };
}
export function storeWin(at: number, width: number): Opening {
  return { at, width, bottom: 0.45, top: 2.75, kind: 'window', plain: true };
}
export function door(at: number, width = 1.2, style: DoorSpec['style'] = 'wood', top = 2.25): Opening {
  return { at, width, bottom: 0, top, kind: 'door', style };
}
export function doorway(at: number, width = 1.3, top = 2.3): Opening {
  return { at, width, bottom: 0, top, kind: 'doorway' };
}

export interface StoreyLayout {
  front: Opening[];
  back: Opening[];
  west: Opening[];
  east: Opening[];
}

export interface Partition {
  storey: number;
  axis: 'x' | 'z';
  /** Perpendicular coordinate relative to the house center. */
  c: number;
  a0: number;
  a1: number;
  openings: Opening[];
}

export interface HouseExtras {
  partitions?: Partition[];
  /** Holes in the ground slab (absolute coordinates), e.g. a basement stairwell. */
  slabHoles?: Rect[];
  /** Holes in the ceiling slab of each storey (absolute coordinates), e.g. the stairwell to the upper floor. */
  ceilingHoles?: Rect[][];
}

/** Subtracts axis-aligned holes from a rectangle, returning the remaining pieces. */
export function subtractRects(r: Rect, holes: Rect[]): Rect[] {
  let pieces = [r];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const p of pieces) {
      if (h.x1 <= p.x0 || h.x0 >= p.x1 || h.z1 <= p.z0 || h.z0 >= p.z1) {
        next.push(p);
        continue;
      }
      const hx0 = Math.max(h.x0, p.x0), hx1 = Math.min(h.x1, p.x1);
      const hz0 = Math.max(h.z0, p.z0), hz1 = Math.min(h.z1, p.z1);
      if (hx0 > p.x0) next.push({ x0: p.x0, x1: hx0, z0: p.z0, z1: p.z1 });
      if (hx1 < p.x1) next.push({ x0: hx1, x1: p.x1, z0: p.z0, z1: p.z1 });
      if (hz0 > p.z0) next.push({ x0: hx0, x1: hx1, z0: p.z0, z1: hz0 });
      if (hz1 < p.z1) next.push({ x0: hx0, x1: hx1, z0: hz1, z1: p.z1 });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.x1 - p.x0 > 0.01 && p.z1 - p.z0 > 0.01);
}

/** Top of the highest wall of a house (where the roof starts). */
export function houseTop(spec: HouseSpec): number {
  const slab = spec.slab ?? STORY.slab;
  const ground = spec.groundHeight ?? STORY.ground;
  return spec.floors === 2 ? slab + ground + STORY.floorThickness + STORY.upper : slab + ground;
}

/** Floor height of each storey of a house. */
export function storeyFloors(spec: HouseSpec): number[] {
  const slab = spec.slab ?? STORY.slab;
  const ground = spec.groundHeight ?? STORY.ground;
  return spec.floors === 2 ? [slab, slab + ground + STORY.floorThickness] : [slab];
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** Small props that sit on raised pavement instead of sinking into it. */
const CURB_PROPS = new Set<PropKind>([
  'hydrant', 'mailbox', 'pump', 'trashBin', 'bench', 'stopSign', 'streetSign', 'boardSign', 'streetlight', 'utilityPole', 'cone', 'trashBag',
]);

export class MapBuilder {
  readonly solids: StaticBox[] = [];
  readonly windows: WindowSpec[] = [];
  readonly doors: DoorSpec[] = [];
  readonly houses: HouseSpec[] = [];
  readonly props: PropSpec[] = [];
  readonly lights: LightSpec[] = [];
  readonly excavations: Rect[] = [];
  readonly areas: AreaSpec[] = [];

  box(b: StaticBox): void {
    this.solids.push(b);
  }

  /** Box from min/max corners. */
  boxMinMax(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: MaterialKey, extra: Partial<StaticBox> = {}): void {
    this.solids.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, w: x1 - x0, h: y1 - y0, d: z1 - z0, mat, ...extra });
  }

  slab(r: Rect, y0: number, y1: number, mat: MaterialKey, holes: Rect[] = [], extra: Partial<StaticBox> = {}): void {
    for (const p of subtractRects(r, holes)) this.boxMinMax(p.x0, y0, p.z0, p.x1, y1, p.z1, mat, extra);
  }

  prop(kind: PropKind, x: number, z: number, rotY = 0, extra: Partial<PropSpec> = {}): PropSpec {
    const p: PropSpec = { kind, x, z, rotY, ...extra };
    this.props.push(p);
    return p;
  }

  light(l: LightSpec): void {
    this.lights.push(l);
  }

  area(name: string, x0: number, x1: number, z0: number, z1: number, y0?: number, y1?: number): void {
    this.areas.push({ name, x0, x1, z0, z1, y0, y1 });
  }

  /** Splits a wall into solid boxes around its openings (absolute coordinates). */
  wall(axis: 'x' | 'z', c: number, a0: number, a1: number, y0: number, h: number, t: number, mat: MaterialKey, openings: { at: number; width: number; bottom: number; top: number }[]): void {
    const push = (from: number, to: number, yb: number, yt: number) => {
      const len = to - from;
      const hh = yt - yb;
      if (len <= 0.01 || hh <= 0.01) return;
      const mid = (from + to) / 2;
      const y = y0 + (yb + yt) / 2;
      this.solids.push(
        axis === 'x'
          ? { x: mid, y, z: c, w: len, h: hh, d: t, mat }
          : { x: c, y, z: mid, w: t, h: hh, d: len, mat },
      );
    };
    const sorted = [...openings].sort((p, q) => p.at - q.at);
    let cursor = a0;
    for (const o of sorted) {
      const s = o.at - o.width / 2;
      const e = o.at + o.width / 2;
      push(cursor, s, 0, h);
      push(s, e, 0, o.bottom);
      push(s, e, o.top, h);
      cursor = e;
    }
    push(cursor, a1, 0, h);
  }

  /**
   * Straight staircase as stacked solid steps (the character controller climbs them with autostep).
   * The run goes from `from` (bottom step) to `to` (top) along `axis`; `a0..a1` is the width.
   */
  stairs(axis: 'x' | 'z', from: number, to: number, a0: number, a1: number, y0: number, y1: number, mat: MaterialKey = 'darkWood'): void {
    const rise = y1 - y0;
    const n = Math.max(2, Math.round(rise / 0.19));
    const dir = Math.sign(to - from);
    const run = Math.abs(to - from) / n;
    for (let i = 0; i < n; i++) {
      const s0 = from + dir * i * run;
      const s1 = from + dir * (i + 1) * run;
      const top = y0 + ((i + 1) * rise) / n;
      const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
      if (axis === 'z') this.boxMinMax(a0, y0, lo, a1, top, hi, mat);
      else this.boxMinMax(lo, y0, a0, hi, top, a1, mat);
    }
  }

  /**
   * Builds a house. Enterable houses get layered exterior walls (siding outside, plaster inside)
   * with real openings, floors and ceilings; closed houses get a single solid collider and are
   * dressed by the renderer.
   */
  house(spec: HouseSpec, ground: StoreyLayout, upper: StoreyLayout | null, extras: HouseExtras = {}): void {
    this.houses.push(spec);
    const { x, z, w, d } = spec;
    const hw = w / 2;
    const hd = d / 2;
    const t = STORY.wall;
    const slab = spec.slab ?? STORY.slab;
    const groundH = spec.groundHeight ?? STORY.ground;
    const frontSign: 1 | -1 = spec.facing === 'south' ? 1 : -1;
    const r = rng(spec.seed);
    const interior = spec.interior ?? 'interiorWall';
    const skip = new Set<WallSide>(spec.skipWalls ?? []);

    this.slab({ x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd }, 0, slab, 'concrete', extras.slabHoles ?? []);

    const storeys: { y0: number; h: number; layout: StoreyLayout }[] = [{ y0: slab, h: groundH, layout: ground }];
    if (spec.floors === 2 && upper) storeys.push({ y0: slab + groundH + STORY.floorThickness, h: STORY.upper, layout: upper });

    if (!spec.enterable) {
      const top = storeys[storeys.length - 1].y0 + storeys[storeys.length - 1].h;
      this.solids.push({ x, y: (slab + top) / 2, z, w, h: top - slab, d, mat: spec.siding, visible: false });
    }

    storeys.forEach((storey, si) => {
      const plans: { side: WallSide; axis: 'x' | 'z'; c: number; a0: number; a1: number; outward: 1 | -1; openings: Opening[] }[] = [
        { side: 'front', axis: 'x', c: z + frontSign * (hd - t / 2), a0: x - hw, a1: x + hw, outward: frontSign,
          openings: storey.layout.front.map((o) => ({ ...o, at: x + o.at })) },
        { side: 'back', axis: 'x', c: z - frontSign * (hd - t / 2), a0: x - hw, a1: x + hw, outward: (-frontSign) as 1 | -1,
          openings: storey.layout.back.map((o) => ({ ...o, at: x + o.at })) },
        { side: 'west', axis: 'z', c: x - (hw - t / 2), a0: z - hd + t, a1: z + hd - t, outward: -1,
          openings: storey.layout.west.map((o) => ({ ...o, at: z + o.at })) },
        { side: 'east', axis: 'z', c: x + (hw - t / 2), a0: z - hd + t, a1: z + hd - t, outward: 1,
          openings: storey.layout.east.map((o) => ({ ...o, at: z + o.at })) },
      ];

      for (const p of plans) {
        if (skip.has(p.side)) continue;
        if (spec.enterable) {
          this.wall(p.axis, p.c + p.outward * (t / 2 - 0.05), p.a0, p.a1, storey.y0, storey.h, 0.1, spec.siding, p.openings);
          this.wall(p.axis, p.c - p.outward * 0.05, p.a0, p.a1, storey.y0, storey.h, t - 0.1, interior, p.openings);
        }
        for (const o of p.openings) {
          const cy = storey.y0 + (o.bottom + o.top) / 2;
          const px = p.axis === 'x' ? o.at : p.c;
          const pz = p.axis === 'x' ? p.c : o.at;
          if (o.kind === 'window') {
            this.windows.push({
              id: `${spec.id}-w${this.windows.length}`, houseId: spec.id,
              x: px, y: cy, z: pz, w: o.width, h: o.top - o.bottom,
              axis: p.axis, outward: p.outward, lit: r() < spec.litWindows, plain: o.plain,
            });
            if (spec.enterable) {
              this.solids.push(
                p.axis === 'x'
                  ? { x: px, y: cy, z: pz, w: o.width, h: o.top - o.bottom, d: 0.08, mat: 'invisible', visible: false, glass: true }
                  : { x: px, y: cy, z: pz, w: 0.08, h: o.top - o.bottom, d: o.width, mat: 'invisible', visible: false, glass: true },
              );
            }
          } else {
            this.doors.push({
              id: `${spec.id}-d${this.doors.length}`, houseId: spec.id,
              x: px, y: storey.y0 + (o.top - o.bottom) / 2, z: pz,
              w: o.width, h: o.top - o.bottom, axis: p.axis, outward: p.outward,
              exterior: o.kind === 'door', style: o.style, floorY: storey.y0,
            });
          }
        }
      }

      if (spec.enterable) {
        for (const part of (extras.partitions ?? []).filter((pp) => pp.storey === si)) {
          const base = part.axis === 'x' ? x : z;
          const ops = part.openings.map((o) => ({ ...o, at: base + o.at }));
          const c = (part.axis === 'x' ? z : x) + part.c;
          this.wall(part.axis, c, base + part.a0, base + part.a1, storey.y0, storey.h, 0.14, interior, ops);
          for (const o of ops) {
            this.doors.push({
              id: `${spec.id}-d${this.doors.length}`, houseId: spec.id,
              x: part.axis === 'x' ? o.at : c, y: storey.y0 + o.top / 2, z: part.axis === 'x' ? c : o.at,
              w: o.width, h: o.top, axis: part.axis, outward: 1, exterior: o.kind === 'door', style: o.style, floorY: storey.y0,
            });
          }
        }
        // Ceiling slab (the floor of the storey above).
        const y = storey.y0 + storey.h;
        this.slab({ x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd }, y, y + STORY.floorThickness, interior, extras.ceilingHoles?.[si] ?? []);
        // Floor finish (visual only).
        const holes = si === 0 ? extras.slabHoles ?? [] : extras.ceilingHoles?.[si - 1] ?? [];
        this.slab({ x0: x - hw + t, x1: x + hw - t, z0: z - hd + t, z1: z + hd - t }, storey.y0, storey.y0 + 0.012,
          spec.floorMat ?? 'woodFloor', holes, { collide: false });
      }
    });
  }

  /** Front walk + driveway from a house to the sidewalk, with a mailbox and a bin at the curb. */
  frontage(spec: HouseSpec, doorAt: number, curbZ: number, driveX: number | null, sidewalkEdge: number): void {
    const frontZ = spec.z + (spec.facing === 'south' ? spec.d / 2 : -spec.d / 2);
    const walkLen = Math.abs(sidewalkEdge - frontZ);
    const walkZ = (sidewalkEdge + frontZ) / 2;
    const doorX = spec.x + doorAt;
    this.solids.push({ x: doorX, y: 0.015, z: walkZ, w: 1.4, h: 0.03, d: walkLen, mat: 'sidewalk', collide: false });
    if (driveX !== null) {
      this.solids.push({ x: driveX, y: 0.012, z: walkZ, w: 3.6, h: 0.024, d: walkLen + 4, mat: 'concrete', collide: false });
      this.prop('trashBin', driveX + 2.3, curbZ + (spec.facing === 'south' ? -0.4 : 0.4), spec.seed % 3, { variant: spec.seed % 3, movable: true });
    }
    this.prop('mailbox', doorX - 1.6, curbZ, spec.facing === 'south' ? 0 : Math.PI);
  }

  finish(name: string, halfExtent: number, playerSpawns: MapDefinition['playerSpawns']): MapDefinition {
    // Props placed inside an enterable building without an explicit height stand on its floor.
    for (const p of this.props) {
      if (p.y !== undefined) continue;
      const h = this.houses.find((hs) => hs.enterable && Math.abs(p.x - hs.x) < hs.w / 2 && Math.abs(p.z - hs.z) < hs.d / 2);
      if (h) {
        p.y = h.slab ?? STORY.slab;
        continue;
      }
      // Street furniture on a sidewalk, curb or pump island stands on top of it.
      if (!CURB_PROPS.has(p.kind)) continue;
      for (const s of this.solids) {
        const top = s.y + s.h / 2;
        if (s.collide === false || top < 0.05 || top > 0.35) continue;
        if (Math.abs(p.x - s.x) < s.w / 2 && Math.abs(p.z - s.z) < s.d / 2) p.y = Math.max(p.y ?? 0, top);
      }
    }
    return {
      name, halfExtent,
      solids: this.solids, houses: this.houses, windows: this.windows, doors: this.doors,
      props: this.props, lights: this.lights, excavations: this.excavations, areas: this.areas, playerSpawns,
    };
  }
}

export { rng as seededRandom };
