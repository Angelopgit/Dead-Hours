import type {
  DoorSpec,
  HouseSpec,
  MapDefinition,
  MaterialKey,
  PropKind,
  PropSpec,
  StaticBox,
  WindowSpec,
} from '../types/world';

/**
 * The neighborhood is authored as data so the client (rendering + prediction) and the
 * server (authoritative simulation) build byte-identical collision from the same source.
 *
 * Axes: +X east, +Z south, +Y up. The main street runs east-west along Z = 0.
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

interface Opening {
  /** Center along the wall axis (absolute world coordinate). */
  at: number;
  width: number;
  bottom: number;
  top: number;
  kind: 'door' | 'window' | 'doorway';
}

interface WallLayer {
  offset: number;
  thickness: number;
  mat: MaterialKey;
}

/** Splits a wall into solid boxes around its openings. */
function wallBoxes(
  out: StaticBox[],
  axis: 'x' | 'z',
  c: number,
  a0: number,
  a1: number,
  y0: number,
  h: number,
  t: number,
  mat: MaterialKey,
  openings: Opening[],
): void {
  const push = (from: number, to: number, yb: number, yt: number) => {
    const len = to - from;
    const hh = yt - yb;
    if (len <= 0.01 || hh <= 0.01) return;
    const mid = (from + to) / 2;
    const y = y0 + (yb + yt) / 2;
    out.push(
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

interface WallPlan {
  axis: 'x' | 'z';
  /** Perpendicular coordinate of the wall center line. */
  c: number;
  a0: number;
  a1: number;
  outward: 1 | -1;
  openings: Opening[];
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

interface Built {
  solids: StaticBox[];
  windows: WindowSpec[];
  doors: DoorSpec[];
}

/** Openings authored per wall as fractions along the wall for one storey. */
interface StoreyLayout {
  front: Opening[];
  back: Opening[];
  west: Opening[];
  east: Opening[];
}

function win(at: number, width = 1.4): Opening {
  return { at, width, bottom: 0.95, top: 2.25, kind: 'window' };
}
function upWin(at: number, width = 1.3): Opening {
  return { at, width, bottom: 0.85, top: 2.05, kind: 'window' };
}
function door(at: number, width = 1.2): Opening {
  return { at, width, bottom: 0, top: 2.25, kind: 'door' };
}

/**
 * Builds a house. Enterable houses get layered exterior walls (siding outside, plaster inside)
 * with real openings; closed houses get a single solid collider and are dressed by the renderer.
 */
function buildHouse(
  spec: HouseSpec,
  ground: StoreyLayout,
  upper: StoreyLayout | null,
  partitions: { axis: 'x' | 'z'; c: number; a0: number; a1: number; openings: Opening[] }[] = [],
): Built {
  const solids: StaticBox[] = [];
  const windows: WindowSpec[] = [];
  const doors: DoorSpec[] = [];
  const { x, z, w, d } = spec;
  const hw = w / 2;
  const hd = d / 2;
  const t = STORY.wall;
  const frontSign: 1 | -1 = spec.facing === 'south' ? 1 : -1;
  const r = rng(spec.seed);

  // Slab / porch step.
  solids.push({ x, y: STORY.slab / 2, z, w, h: STORY.slab, d, mat: 'concrete' });

  const storeys: { y0: number; h: number; layout: StoreyLayout }[] = [
    { y0: STORY.slab, h: STORY.ground, layout: ground },
  ];
  if (spec.floors === 2 && upper) {
    storeys.push({ y0: STORY.slab + STORY.ground + STORY.floorThickness, h: STORY.upper, layout: upper });
  }

  if (!spec.enterable) {
    const totalH =
      spec.floors === 2
        ? STORY.ground + STORY.floorThickness + STORY.upper
        : STORY.ground;
    solids.push({
      x, y: STORY.slab + totalH / 2, z, w, h: totalH, d, mat: spec.siding, visible: false,
    });
  }

  storeys.forEach((storey, si) => {
    const plans: WallPlan[] = [
      // Front and back run along X. Openings are authored relative to house center.
      { axis: 'x', c: z + frontSign * (hd - t / 2), a0: x - hw, a1: x + hw, outward: frontSign,
        openings: storey.layout.front.map((o) => ({ ...o, at: x + o.at })) },
      { axis: 'x', c: z - frontSign * (hd - t / 2), a0: x - hw, a1: x + hw, outward: (-frontSign) as 1 | -1,
        openings: storey.layout.back.map((o) => ({ ...o, at: x + o.at })) },
      { axis: 'z', c: x - (hw - t / 2), a0: z - hd + t, a1: z + hd - t, outward: -1,
        openings: storey.layout.west.map((o) => ({ ...o, at: z + o.at })) },
      { axis: 'z', c: x + (hw - t / 2), a0: z - hd + t, a1: z + hd - t, outward: 1,
        openings: storey.layout.east.map((o) => ({ ...o, at: z + o.at })) },
    ];

    for (const p of plans) {
      if (spec.enterable) {
        const layers: WallLayer[] = [
          { offset: p.outward * (t / 2 - 0.05), thickness: 0.1, mat: spec.siding },
          { offset: -p.outward * 0.05, thickness: t - 0.1, mat: 'interiorWall' },
        ];
        for (const l of layers) {
          wallBoxes(solids, p.axis, p.c + l.offset, p.a0, p.a1, storey.y0, storey.h, l.thickness, l.mat, p.openings);
        }
      }
      for (const o of p.openings) {
        const cy = storey.y0 + (o.bottom + o.top) / 2;
        const px = p.axis === 'x' ? o.at : p.c;
        const pz = p.axis === 'x' ? p.c : o.at;
        if (o.kind === 'window') {
          windows.push({
            id: `${spec.id}-w${windows.length}`,
            houseId: spec.id,
            x: px, y: cy, z: pz, w: o.width, h: o.top - o.bottom,
            axis: p.axis, outward: p.outward,
            lit: r() < spec.litWindows,
          });
          if (spec.enterable) {
            // Glass blocks movement until it is broken.
            solids.push(
              p.axis === 'x'
                ? { x: px, y: cy, z: pz, w: o.width, h: o.top - o.bottom, d: 0.08, mat: 'invisible', visible: false }
                : { x: px, y: cy, z: pz, w: 0.08, h: o.top - o.bottom, d: o.width, mat: 'invisible', visible: false },
            );
          }
        } else {
          doors.push({
            id: `${spec.id}-d${doors.length}`,
            houseId: spec.id,
            x: px, y: storey.y0 + (o.top - o.bottom) / 2, z: pz,
            w: o.width, h: o.top - o.bottom, axis: p.axis, outward: p.outward,
            exterior: o.kind === 'door',
          });
        }
      }
    }

    if (spec.enterable && si === 0) {
      for (const part of partitions) {
        const ops = part.openings.map((o) => ({ ...o, at: (part.axis === 'x' ? x : z) + o.at }));
        wallBoxes(
          solids, part.axis, (part.axis === 'x' ? z : x) + part.c,
          (part.axis === 'x' ? x : z) + part.a0, (part.axis === 'x' ? x : z) + part.a1,
          storey.y0, storey.h, 0.14, 'interiorWall', ops,
        );
        for (const o of ops) {
          doors.push({
            id: `${spec.id}-d${doors.length}`, houseId: spec.id,
            x: part.axis === 'x' ? o.at : x + part.c,
            y: storey.y0 + o.top / 2,
            z: part.axis === 'x' ? z + part.c : o.at,
            w: o.width, h: o.top, axis: part.axis, outward: 1, exterior: false,
          });
        }
      }
    }

    // Ceiling / upper floor slab for enterable houses.
    if (spec.enterable) {
      const y = storey.y0 + storey.h + STORY.floorThickness / 2;
      solids.push({ x, y, z, w, h: STORY.floorThickness, d, mat: 'interiorWall' });
    }
  });

  if (spec.enterable) {
    // Interior floor finish (visual only, sits on the slab).
    solids.push({ x, y: STORY.slab + 0.005, z, w: w - 2 * t, h: 0.01, d: d - 2 * t, mat: 'woodFloor', collide: false });
  }

  return { solids, windows, doors };
}

function prop(kind: PropKind, x: number, z: number, rotY = 0, extra: Partial<PropSpec> = {}): PropSpec {
  return { kind, x, z, rotY, ...extra };
}

function buildNeighborhood(): MapDefinition {
  const solids: StaticBox[] = [];
  const windows: WindowSpec[] = [];
  const doors: DoorSpec[] = [];
  const houses: HouseSpec[] = [];
  const props: PropSpec[] = [];
  const rw = STREET.roadHalfWidth;
  const sw = STREET.sidewalkWidth;

  // Road surface (visual) and raised sidewalks (collide, step-up handled by the controller).
  solids.push({ x: 0, y: 0.01, z: 0, w: STREET.length, h: 0.02, d: rw * 2, mat: 'asphalt', collide: false });
  for (const s of [-1, 1]) {
    solids.push({ x: 0, y: STREET.curbHeight / 2, z: s * (rw + sw / 2), w: STREET.length, h: STREET.curbHeight, d: sw, mat: 'sidewalk' });
  }

  const addHouse = (
    spec: HouseSpec,
    ground: StoreyLayout,
    upper: StoreyLayout | null,
    partitions?: Parameters<typeof buildHouse>[3],
  ) => {
    houses.push(spec);
    const b = buildHouse(spec, ground, upper, partitions);
    solids.push(...b.solids);
    windows.push(...b.windows);
    doors.push(...b.doors);

    // Driveway + front walk connecting the house to the sidewalk.
    const frontZ = spec.z + (spec.facing === 'south' ? spec.d / 2 : -spec.d / 2);
    const walkEnd = spec.facing === 'south' ? -(rw + sw) : rw + sw;
    const walkLen = Math.abs(walkEnd - frontZ);
    const walkZ = (walkEnd + frontZ) / 2;
    const doorX = (ground.front.find((o) => o.kind === 'door')?.at ?? 0) + spec.x;
    solids.push({ x: doorX, y: 0.015, z: walkZ, w: 1.4, h: 0.03, d: walkLen, mat: 'sidewalk', collide: false });
    const driveX = spec.x + spec.w / 2 + 2.2;
    solids.push({ x: driveX, y: 0.012, z: walkZ, w: 3.6, h: 0.024, d: walkLen + 4, mat: 'concrete', collide: false });
    // Mailbox at the curb, trash bin by the driveway.
    const curbZ = spec.facing === 'south' ? -(rw + sw) - 0.6 : rw + sw + 0.6;
    props.push(prop('mailbox', doorX - 1.6, curbZ, spec.facing === 'south' ? 0 : Math.PI));
    props.push(prop('trashBin', driveX + 2.3, curbZ + (spec.facing === 'south' ? -0.4 : 0.4), spec.seed % 3));
  };

  // ── Safehouse: two-storey, fully enterable, faces the street. ──────────────
  addHouse(
    { id: 'safehouse', x: 0, z: -20, w: 14, d: 10, floors: 2, facing: 'south', siding: 'sidingBeige',
      roofColor: 0x2b2d33, enterable: true, litWindows: 1, seed: 7 },
    {
      front: [win(-4.6, 1.8), door(2.4), win(5.3, 1.5)],
      back: [door(-4.2, 1.1), win(1.8), win(5.2)],
      west: [win(-0.5, 1.6)],
      east: [win(1.2, 1.4)],
    },
    {
      front: [upWin(-4.5), upWin(0), upWin(4.5)],
      back: [upWin(-3), upWin(3)],
      west: [upWin(0)],
      east: [upWin(0)],
    },
    [{ axis: 'z', c: -1.4, a0: -5 + STORY.wall, a1: 5 - STORY.wall, openings: [{ at: -0.6, width: 1.5, bottom: 0, top: 2.3, kind: 'doorway' }] }],
  );

  // ── North side ─────────────────────────────────────────────────────────────
  addHouse(
    { id: 'house-nw', x: -28, z: -19.5, w: 12, d: 10, floors: 2, facing: 'south', siding: 'sidingBlue',
      roofColor: 0x22262c, enterable: false, litWindows: 0.15, seed: 21 },
    { front: [win(-3.5), door(1), win(4)], back: [win(-3), win(3)], west: [win(0)], east: [win(-1)] },
    { front: [upWin(-3.5), upWin(3.5)], back: [upWin(0)], west: [upWin(0)], east: [upWin(0)] },
  );
  addHouse(
    { id: 'house-ne', x: 27, z: -18.5, w: 12, d: 9, floors: 1, facing: 'south', siding: 'sidingGreen',
      roofColor: 0x2e2a27, enterable: true, litWindows: 0.5, seed: 33 },
    { front: [win(-3.2), door(0.6), win(3.6)], back: [door(-3.4, 1.1), win(2.5)], west: [win(0)], east: [win(0.5)] },
    null,
    [{ axis: 'x', c: -0.6, a0: -6 + STORY.wall, a1: 0, openings: [{ at: -2.6, width: 1.3, bottom: 0, top: 2.3, kind: 'doorway' }] }],
  );
  addHouse(
    { id: 'house-nfe', x: 52, z: -19.5, w: 11, d: 10, floors: 2, facing: 'south', siding: 'sidingGray',
      roofColor: 0x24272b, enterable: false, litWindows: 0.0, seed: 47 },
    { front: [win(-3), door(1.5), win(3.8, 1.2)], back: [win(0)], west: [win(0)], east: [win(0)] },
    { front: [upWin(-2.5), upWin(2.5)], back: [upWin(0)], west: [], east: [] },
  );

  // ── South side ─────────────────────────────────────────────────────────────
  addHouse(
    { id: 'house-sw', x: -18, z: 19.5, w: 12, d: 10, floors: 2, facing: 'north', siding: 'sidingGray',
      roofColor: 0x26282c, enterable: false, litWindows: 0.2, seed: 58 },
    { front: [win(-3.6), door(0.5), win(3.6)], back: [win(-2), win(2)], west: [win(0)], east: [win(0)] },
    { front: [upWin(-3.5), upWin(0), upWin(3.5)], back: [upWin(0)], west: [upWin(0)], east: [] },
  );
  addHouse(
    { id: 'house-s', x: 10, z: 19, w: 11, d: 9, floors: 1, facing: 'north', siding: 'brick',
      roofColor: 0x2a2624, enterable: false, litWindows: 0.0, seed: 63 },
    { front: [win(-3), door(1), win(3.4)], back: [win(0)], west: [win(0)], east: [win(0)] },
    null,
  );
  addHouse(
    { id: 'house-se', x: 38, z: 20, w: 12, d: 10, floors: 2, facing: 'north', siding: 'sidingBlue',
      roofColor: 0x202429, enterable: false, litWindows: 0.35, seed: 71 },
    { front: [win(-3.5), door(-0.5), win(3.5)], back: [win(0)], west: [win(0)], east: [win(0)] },
    { front: [upWin(-3), upWin(3)], back: [upWin(0)], west: [upWin(0)], east: [upWin(0)] },
  );
  addHouse(
    { id: 'house-sfw', x: -44, z: 19, w: 11, d: 9, floors: 1, facing: 'north', siding: 'sidingGreen',
      roofColor: 0x2a2a28, enterable: false, litWindows: 0.0, seed: 89 },
    { front: [win(-3), door(1), win(3.2)], back: [win(0)], west: [win(0)], east: [win(0)] },
    null,
  );

  // ── Street dressing ────────────────────────────────────────────────────────
  const lightZ = rw + 0.55;
  props.push(prop('streetlight', -40, -lightZ, 0));
  props.push(prop('streetlight', -18, lightZ, Math.PI));
  props.push(prop('streetlight', 6, -lightZ, 0, { flag: true }));
  props.push(prop('streetlight', 26, lightZ, Math.PI));
  props.push(prop('streetlight', 46, -lightZ, 0));

  props.push(prop('policeCar', -5.5, 1.6, 0.32));
  props.push(prop('wreckedCar', 15.5, -2.1, -0.22, { variant: 2, flag: true }));
  props.push(prop('car', -20.2, -10.6, Math.PI / 2, { variant: 0 }));
  props.push(prop('car', 18.3, 11.2, -Math.PI / 2 + 0.06, { variant: 3 }));
  props.push(prop('car', 31.3, -2.9, Math.PI + 0.03, { variant: 1 }));
  props.push(prop('car', 9.2, 3.0, 0.02, { variant: 4 }));

  props.push(prop('roadblock', -56, -1.8, Math.PI / 2 + 0.1));
  props.push(prop('roadblock', -56.4, 2.4, Math.PI / 2 - 0.15));
  props.push(prop('policeCar', -61, -0.5, Math.PI / 2 + 0.6));

  props.push(prop('hydrant', -9.5, -rw - 0.6, 0));
  props.push(prop('hydrant', 30.5, rw + 0.6, 0));

  for (const px of [-48, -24, 0, 24, 48]) props.push(prop('utilityPole', px, rw + sw + 0.9, 0));

  // Lawn trees and shrubs.
  const trees: [PropKind, number, number][] = [
    ['tree', -10, -11.5], ['tree', 11.5, -11], ['pine', -36, -11], ['tree', 37, -11.5],
    ['tree', -27, 11], ['pine', -7, 12.5], ['tree', 24.5, 11.5], ['pine', 47, 11.5],
    ['tree', 44, -11], ['pine', -52, 11.5], ['pine', -8, -28.5], ['pine', 14, -28],
    ['tree', 62, -10], ['tree', -62, 10],
  ];
  trees.forEach(([k, tx, tz], i) => props.push(prop(k, tx, tz, i * 1.7, { variant: i })));
  const bushes: [number, number][] = [
    [-6.5, -15.8], [6.8, -15.8], [-21.5, -14.1], [21, -13.6], [-23, 14.1], [4.6, 14.1], [32, 14.6], [-38.5, 14.1],
  ];
  bushes.forEach(([bx, bz], i) => props.push(prop('bush', bx, bz, i, { variant: i })));

  // Yard fences between properties (north side) and along back lots.
  props.push(prop('fence', -14.5, -20, Math.PI / 2, { length: 12 }));
  props.push(prop('fence', 15, -20.5, Math.PI / 2, { length: 11 }));
  props.push(prop('fence', 40, -20, Math.PI / 2, { length: 12, variant: 1 }));
  props.push(prop('fence', -4, 20.5, Math.PI / 2, { length: 10, variant: 1 }));
  props.push(prop('fence', 24, 21, Math.PI / 2, { length: 10 }));
  props.push(prop('fence', -10, -27, 0, { length: 8 }));
  props.push(prop('fence', 10, -27, 0, { length: 8, variant: 1 }));

  // Litter.
  const bags: [number, number][] = [[-12, -5.2], [3.5, 5.3], [21, -4.0], [-31, 4.3], [-3.2, -3.4], [40, 3.6]];
  bags.forEach(([bx, bz], i) => props.push(prop('trashBag', bx, bz, i * 2.1, { variant: i })));

  return {
    name: 'Maple Hollow',
    halfExtent: 125,
    solids,
    houses,
    windows,
    doors,
    props,
    playerSpawns: [
      { x: 3.0, y: 0.35, z: -19.5, yaw: Math.PI },
      { x: 4.5, y: 0.35, z: -21.5, yaw: Math.PI },
      { x: 1.5, y: 0.35, z: -22.0, yaw: Math.PI },
      { x: 5.0, y: 0.35, z: -18.0, yaw: Math.PI },
    ],
  };
}

export const NEIGHBORHOOD: MapDefinition = buildNeighborhood();

/** Oriented collision box for a prop, in world space. Half extents. */
export interface OrientedBox {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  rotY: number;
}

/** Collision for props. Local +X is the prop's forward/long axis. */
export function propColliders(p: PropSpec): OrientedBox[] {
  const at = (lx: number, ly: number, lz: number, hx: number, hy: number, hz: number): OrientedBox => {
    const c = Math.cos(p.rotY);
    const s = Math.sin(p.rotY);
    // Three.js Y rotation: x' = x*c + z*s, z' = -x*s + z*c
    return { x: p.x + lx * c + lz * s, y: ly, z: p.z - lx * s + lz * c, hx, hy, hz, rotY: p.rotY };
  };
  switch (p.kind) {
    case 'car':
    case 'policeCar':
    case 'wreckedCar':
      return [at(0, 0.75, 0, 2.25, 0.75, 0.95)];
    case 'streetlight':
    case 'utilityPole':
      return [at(0, 3, 0, 0.15, 3, 0.15)];
    case 'trashBin':
      return [at(0, 0.55, 0, 0.36, 0.55, 0.36)];
    case 'mailbox':
      return [at(0, 0.6, 0, 0.12, 0.6, 0.12)];
    case 'hydrant':
      return [at(0, 0.4, 0, 0.18, 0.4, 0.18)];
    case 'tree':
    case 'pine':
      return [at(0, 2, 0, 0.3, 2, 0.3)];
    case 'fence': {
      const len = p.length ?? 6;
      return [at(0, 0.8, 0, len / 2, 0.8, 0.06)];
    }
    case 'roadblock':
      return [at(0, 0.55, 0, 1.6, 0.55, 0.3)];
    case 'bush':
    case 'trashBag':
      return [];
  }
}
