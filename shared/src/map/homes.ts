import type { HouseSpec, MaterialKey, PropKind, PropSpec, Rect } from '../types/world';
import { MapBuilder, STORY, door, doorway, seededRandom, upWin, win, type Opening, type Partition, type StoreyLayout } from './builder';
import { propHalfExtents } from './colliders';

/**
 * Floor plans for the family homes along Hale Street: a single-storey ranch and a two-storey
 * colonial, each with an optional basement, furnished room by room.
 *
 * Plans are written in a house-local frame so one plan serves houses on both sides of the street
 * and mirrored lots: u runs across the house (east when not mirrored), v is depth measured from
 * the front wall's outer face toward the back. Every wall, opening and prop is placed against
 * the inner faces those coordinates give, which keeps furniture out of walls, windows clear of
 * partition ends and doorways free.
 */

const T = STORY.wall;
/** Half the thickness of an interior partition. */
const PH = 0.07;
const F1 = STORY.slab;
const F2 = STORY.slab + STORY.ground + STORY.floorThickness;
const BASEMENT = -2.7;
/** Clearance between furniture and the wall it stands against. */
const GAP = 0.03;
const BULB = 0xffa35a;

export interface HomePlan {
  spec: HouseSpec;
  layout: 'ranch' | 'twoStorey';
  /** Front door position along the front wall, in the plan's frame. */
  door: number;
  /** Swaps the two sides of the plan so neighbours don't share one layout. */
  mirror?: boolean;
  basement?: boolean;
  /** Ammunition crate in the basement. */
  cache?: boolean;
}

/** Local direction of the wall a piece of furniture backs onto. */
type Wall = 'u+' | 'u-' | 'v+' | 'v-';
const DIRS: Record<Wall, [number, number]> = { 'u+': [1, 0], 'u-': [-1, 0], 'v+': [0, 1], 'v-': [0, -1] };

interface Openings {
  front: Opening[];
  back: Opening[];
  west: Opening[];
  east: Opening[];
}

export class Frame {
  readonly f: 1 | -1;
  readonly m: 1 | -1;
  /** Interior half width and the back wall's inner face. */
  readonly W: number;
  readonly D: number;
  readonly rand: () => number;

  constructor(readonly b: MapBuilder, readonly s: HouseSpec, mirror: boolean) {
    this.f = s.facing === 'south' ? 1 : -1;
    this.m = mirror ? -1 : 1;
    this.W = s.w / 2 - T;
    this.D = s.d - T;
    this.rand = seededRandom(s.seed * 7919 + 13);
  }

  x(u: number): number {
    return this.s.x + this.m * u;
  }
  z(v: number): number {
    return this.s.z + this.f * (this.s.d / 2 - v);
  }
  /** Z offset from the house centre (the builder's coordinate along side walls). */
  oz(v: number): number {
    return this.f * (this.s.d / 2 - v);
  }
  rect(u0: number, u1: number, v0: number, v1: number): Rect {
    const xa = this.x(u0), xb = this.x(u1), za = this.z(v0), zb = this.z(v1);
    return { x0: Math.min(xa, xb), x1: Math.max(xa, xb), z0: Math.min(za, zb), z1: Math.max(za, zb) };
  }
  /** Yaw for a prop whose front faces local (du, dv). */
  face(du: number, dv: number): number {
    return Math.atan2(this.m * du, -this.f * dv);
  }
  /** Yaw for a prop whose length (local +X) runs along local (du, dv). */
  run(du: number, dv: number): number {
    return Math.atan2(this.f * dv, this.m * du);
  }

  layout(o: Openings): StoreyLayout {
    const along = (os: Opening[]) => os.map((p) => ({ ...p, at: this.m * p.at }));
    const side = (os: Opening[]) => os.map((p) => ({ ...p, at: this.oz(p.at) }));
    return {
      front: along(o.front),
      back: along(o.back),
      west: side(this.m === 1 ? o.west : o.east),
      east: side(this.m === 1 ? o.east : o.west),
    };
  }
  /** Partition at depth v running across the house. */
  across(storey: number, v: number, u0: number, u1: number, openings: Opening[]): Partition {
    const a = this.m * u0, c = this.m * u1;
    return { storey, axis: 'x', c: this.oz(v), a0: Math.min(a, c), a1: Math.max(a, c), openings: openings.map((o) => ({ ...o, at: this.m * o.at })) };
  }
  /** Partition at u running from front to back. */
  lengthwise(storey: number, u: number, v0: number, v1: number, openings: Opening[]): Partition {
    const a = this.oz(v0), c = this.oz(v1);
    return { storey, axis: 'z', c: this.m * u, a0: Math.min(a, c), a1: Math.max(a, c), openings: openings.map((o) => ({ ...o, at: this.oz(o.at) })) };
  }

  /** Stairs along v, climbing from v0 (at y0) to v1 (at y1). */
  stairs(v0: number, v1: number, u0: number, u1: number, y0: number, y1: number, mat: MaterialKey): void {
    const xa = this.x(u0), xb = this.x(u1);
    this.b.stairs('z', this.z(v0), this.z(v1), Math.min(xa, xb), Math.max(xa, xb), y0, y1, mat, this.s.id);
  }
  railAlongV(u: number, v0: number, v1: number, y: number): void {
    this.prop('railing', u, (v0 + v1) / 2, this.run(0, 1), { y, length: Math.abs(v1 - v0) });
  }
  railAlongU(v: number, u0: number, u1: number, y: number): void {
    this.prop('railing', (u0 + u1) / 2, v, this.run(1, 0), { y, length: Math.abs(u1 - u0) });
  }
  box(u0: number, u1: number, y0: number, y1: number, v0: number, v1: number, mat: MaterialKey, extra: { collide?: boolean } = {}): void {
    const r = this.rect(u0, u1, v0, v1);
    this.b.boxMinMax(r.x0, y0, r.z0, r.x1, y1, r.z1, mat, extra);
  }

  prop(kind: PropKind, u: number, v: number, rotY: number, extra: Partial<PropSpec> = {}): PropSpec {
    return this.b.prop(kind, this.x(u), this.z(v), rotY, extra);
  }
  /** A prop with its back to a wall: `wall` is where the wall is, `c` its inner face, `at` the position along it. */
  against(kind: PropKind, wall: Wall, c: number, at: number, y: number, extra: Partial<PropSpec> = {}): PropSpec {
    const [, hz] = propHalfExtents(kind, extra.length);
    const [du, dv] = DIRS[wall];
    const off = c - (du + dv) * (hz + GAP);
    return this.prop(kind, du ? off : at, dv ? off : at, this.face(-du, -dv), { y, ...extra });
  }
  /** A bed with its headboard to a wall. */
  bed(wall: Wall, c: number, at: number, y: number, variant: number): void {
    const [hx] = propHalfExtents('bed');
    const [du, dv] = DIRS[wall];
    const off = c - (du + dv) * (hx + GAP);
    this.prop('bed', du ? off : at, dv ? off : at, this.run(-du, -dv), { y, variant });
  }
  /** Wall-mounted first aid case, front out of the wall. */
  aidCase(wall: Wall, c: number, at: number, y: number): void {
    const [du, dv] = DIRS[wall];
    const off = c - (du + dv) * 0.02;
    this.prop('firstAid', du ? off : at, dv ? off : at, this.face(-du, -dv), { y: y + 1.55 });
  }
  /** Ceiling bulb over a room (y is the floor). */
  lamp(u: number, v: number, floor: number, ceiling: number, intensity: number, range = 9.5): void {
    const k = 0.85 + this.rand() * 0.3;
    this.b.light({
      kind: 'point', x: this.x(u), y: floor + ceiling - 0.45, z: this.z(v),
      color: BULB, intensity: intensity * k, range, decay: 1.7, fixture: 'bulb',
    });
  }
  /** Tiled floor over the wood finish (kitchens and bathrooms). */
  tile(u0: number, u1: number, v0: number, v1: number, floor: number): void {
    this.box(u0, u1, floor + 0.012, floor + 0.016, v0, v1, 'tile', { collide: false });
  }
  /** Poured-concrete basement with its walls inside the given outline. */
  basement(u0: number, u1: number, v0: number, v1: number): void {
    const lo = Math.min(u0, u1), hi = Math.max(u0, u1);
    this.b.excavations.push(this.rect(lo, hi, v0, v1));
    this.box(lo, hi, BASEMENT - 0.3, BASEMENT, v0, v1, 'concrete');
    this.box(lo, lo + T, BASEMENT, 0, v0, v1, 'concrete');
    this.box(hi - T, hi, BASEMENT, 0, v0, v1, 'concrete');
    this.box(lo + T, hi - T, BASEMENT, 0, v0, v0 + T, 'concrete');
    this.box(lo + T, hi - T, BASEMENT, 0, v1 - T, v1, 'concrete');
  }
  area(name: string, u0: number, u1: number, v0: number, v1: number, y0: number, y1: number): void {
    const r = this.rect(u0, u1, v0, v1);
    this.b.area(name, r.x0, r.x1, r.z0, r.z1, y0, y1);
  }
}

/** Builds a home from its plan. Returns the front door's offset along X from the house centre. */
export function buildHome(b: MapBuilder, plan: HomePlan): number {
  const k = new Frame(b, plan.spec, !!plan.mirror);
  if (plan.layout === 'ranch') ranch(k, plan);
  else twoStorey(k, plan);
  return k.m * plan.door;
}

/** Back-wall kitchen run from the west corner: fridge, counter, stove and, if it fits, a second counter. */
function kitchenRun(k: Frame, u0: number, u1: number, y: number): number {
  const { D } = k;
  k.against('fridge', 'v+', D, u0 + 0.4 + GAP, y);
  const c0 = u0 + 0.83 + GAP;
  k.against('counter', 'v+', D, c0 + 0.6, y, { length: 1.2 });
  const s0 = c0 + 1.21;
  k.against('stove', 'v+', D, s0 + 0.38, y);
  const rest = u1 - (s0 + 0.77);
  if (rest >= 0.55) k.against('counter', 'v+', D, s0 + 0.77 + rest / 2, y, { length: rest });
  // The window goes over the first counter.
  return c0 + 0.6;
}

function bathroom(k: Frame, u0: number, u1: number, v0: number, v1: number, y: number, aid: boolean, toiletWall: 'u+' | 'u-', vanityV: number): void {
  k.tile(u0, u1, v0, v1, y);
  k.against('bathtub', 'v+', v1, (u0 + u1) / 2, y);
  const [, tubDepth] = propHalfExtents('bathtub');
  const toiletV = v1 - tubDepth * 2 - GAP - 0.5;
  const vanityWall: 'u+' | 'u-' = toiletWall === 'u+' ? 'u-' : 'u+';
  k.against('toilet', toiletWall, toiletWall === 'u+' ? u1 : u0, toiletV, y);
  k.against('vanity', vanityWall, vanityWall === 'u+' ? u1 : u0, vanityV, y);
  // First aid case on the wall facing the sink (the sink has the mirror).
  if (aid) k.aidCase(toiletWall, toiletWall === 'u+' ? u1 : u0, vanityV, y);
}

/** A table along u; chairs all round, at its two ends, or along its front side only (narrow kitchens). */
function diningSet(k: Frame, u: number, v: number, y: number, chairs: 'round' | 'ends' | 'front' = 'round'): void {
  k.prop('diningTable', u, v, k.run(1, 0), { y, movable: true });
  const twist = () => (k.rand() - 0.5) * 0.5;
  if (chairs === 'ends') {
    for (const su of [-1, 1]) k.prop('chair', u + su * 1.04, v, k.face(-su, 0) + twist(), { y, movable: true });
    return;
  }
  const set: PropSpec[] = [];
  for (const sv of chairs === 'front' ? [-1] : [-1, 1]) {
    for (const su of [-1, 1]) set.push(k.prop('chair', u + su * 0.42, v + sv * 0.68, k.face(0, -sv) + twist(), { y, movable: true }));
  }
  // Knocked over in the panic: one chair in most homes (a hash, so the layout's random stream is untouched).
  const pick = Math.floor(spot(set[0].x, set[0].z) * 7);
  if (pick < set.length) set[pick].tipped = true;
}

/** Stable 0..1 from a world position (keeps decorative choices out of the layout's random stream). */
function spot(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Single storey: living room across the front; kitchen, bathroom and bedroom across the back.
 * The basement variant gives up some kitchen for a stairwell behind a doorway off the living room.
 */
function ranch(k: Frame, plan: HomePlan): void {
  const { W, D, s } = k;
  const down = !!plan.basement;
  const vc = s.d >= 10 ? 4.6 : 4.4;
  const back0 = vc + PH;
  const k1 = down ? -1.5 : -0.95;
  const s2 = k1 + 1.3;
  const bath0 = down ? s2 : k1;
  const k2 = bath0 + (down ? 1.94 : 2.1);
  const kc = (-W + k1 - PH) / 2;
  const bathC = (bath0 + k2) / 2;
  const bedU0 = k2 + PH;
  const bedDoor = W - 0.85;
  const sideDoorV = back0 + 0.75;
  const livingV = (T + vc - PH) / 2;

  const across: Opening[] = [doorway(kc, 1.6), doorway(bathC, 1.0), doorway(bedDoor, 1.0)];
  if (down) across.push(doorway((k1 + s2) / 2, 1.0));
  const partitions: Partition[] = [
    k.across(0, vc, -W, W, across),
    k.lengthwise(0, k1, back0, D, []),
    k.lengthwise(0, k2, back0, D, []),
  ];
  if (down) partitions.push(k.lengthwise(0, s2, back0, D, []));

  // Kitchen first so its window can sit over the counter.
  const counterU = kitchenRun(k, -W, k1 - PH, F1);
  const ground: Openings = {
    front: [win(-3.2), door(plan.door), win(3.6)],
    back: [win(counterU, 1.1), win(bathC, 0.7, 1.35, 2.0), win((bedU0 + W) / 2 - 0.3, 1.3)],
    west: [win(livingV), door(sideDoorV, 1.0)],
    // The television has the living room's east wall; the bedroom gets the window.
    east: [win(back0 + 0.95, 1.1)],
  };
  // The stairwell opening ends over the bottom step; the floor carries on above the landing.
  const slabHoles = down ? [k.rect(k1 + PH, s2 - PH, back0, back0 + 0.03 + 4.0)] : [];
  k.b.house(s, k.layout(ground), null, { partitions, slabHoles });

  // Living room: sofa facing a television on the far wall, a reading chair by the other window.
  k.against('tvStand', 'u+', W, livingV, F1);
  k.prop('sofa', W - 3.2, livingV, k.face(1, 0), { y: F1, movable: true });
  k.prop('coffeeTable', W - 1.62, livingV, k.run(0, 1), { y: F1, movable: true });
  k.prop('rug', W - 1.9, livingV, k.run(0, 1), { y: F1, length: 2.6 });
  const lamp = k.prop('floorLamp', W - 3.2, T + 0.6, 0, { y: F1 });
  if (spot(lamp.x, lamp.z) < 0.45) lamp.tipped = true;
  k.prop('armchair', -W + 0.75, livingV - 0.6, k.face(1, 0.25), { y: F1, movable: true });
  k.against('bookshelf', 'v-', T, -1.3, F1, { movable: true });
  k.lamp(-2.6, livingV, F1, 3, 6.5);
  k.lamp(2.6, livingV, F1, 3, 6.5);

  // Kitchen.
  k.tile(-W, k1 - PH, back0, D, F1);
  // End chairs only where they leave a walkway past both ends.
  diningSet(k, kc, Math.max((back0 + D - 0.64) / 2, back0 + 1.95), F1, k1 - PH + W > 4 ? 'ends' : 'front');
  k.lamp(kc, (back0 + D) / 2, F1, 3, 6);

  // Bathroom.
  // The doorway is in the front wall here, so the sink stands back from it.
  bathroom(k, bath0 + PH, k2 - PH, back0, D, F1, k.rand() < 0.6, 'u+', back0 + 1.45);
  k.lamp(bathC, back0 + 1.4, F1, 3, 3.2, 6);

  // Bedroom.
  const bedV = (back0 + D) / 2 + 0.3;
  k.bed('u+', W, bedV, F1, s.seed % 2);
  k.against('wardrobe', 'u-', bedU0, D - 0.75, F1);
  k.against('dresser', 'v-', back0, bedU0 + 0.9, F1, { movable: true });
  k.lamp((bedU0 + W) / 2, (back0 + D) / 2, F1, 3, 5);

  if (down) {
    const st0 = k1 + PH + 0.03, st1 = s2 - PH - 0.03;
    const top = back0 + 0.03;
    k.stairs(top + 4.0, top, st0, st1, BASEMENT, F1, 'concrete');
    const v0 = 2.0;
    k.basement(-W - T, W + T, v0, s.d);
    basementStores(k, -W, W, v0 + T, D, { u0: st0 - 0.3, u1: st1 + 0.3, v0: top - 0.3, v1: D }, !!plan.cache);
    k.lamp(-2.8, (v0 + D) / 2, BASEMENT, 2.7, 8, 9);
    k.lamp(2.8, (v0 + D) / 2, BASEMENT, 2.7, 6.5, 9);
    k.area('BASEMENT', -W - T, W + T, v0, s.d, -3.2, -0.1);
  }
  k.area(s.label ?? 'HOUSE', -W - T, W + T, 0, s.d, -0.1, 6);
}

/**
 * Two storeys. Downstairs a wall runs front to back: dining and kitchen on one side; on the
 * other the living room, with the stairs climbing along that wall, and a den behind it.
 * Upstairs: a main bedroom over the kitchen, a front bedroom, the landing and a bathroom.
 * The basement stairs, when there are any, run down the other face of the same wall.
 */
function twoStorey(k: Frame, plan: HomePlan): void {
  const { W, D, s } = k;
  const down = !!plan.basement;
  const p = -0.8;
  const q = W - 2.35;
  const sU0 = p + 0.13, sU1 = p + 1.28;
  const sV0 = 3.0, sV1 = 8.2;
  const denV = 6.2;
  const denU0 = sU1 + 0.02;
  const denDoor = (denU0 + W) / 2;
  // Upstairs front bedroom wall; the stairwell opens just behind it so a brute clears the ceiling.
  const bedV = 3.5;
  const holeV0 = bedV + PH + 0.03;
  const hallU0 = p + 1.38;
  const hallC = (hallU0 + q - PH) / 2;
  const westU1 = down ? p - 1.38 : p - PH;
  const westC = (-W + westU1) / 2;

  const partitions: Partition[] = [
    k.lengthwise(0, p, T, D, [doorway(1.65, 1.2), doorway(9.0, 1.0)]),
    k.across(0, denV, denU0, W, [doorway(denDoor, 1.0)]),
    k.lengthwise(1, p, T, D, [doorway(9.0, 1.0)]),
    k.across(1, bedV, p + PH, W, [doorway(hallC, 1.0)]),
    k.lengthwise(1, q, bedV + PH, D, [doorway(6.2, 1.0)]),
  ];

  const counterU = kitchenRun(k, -W, down ? p - 2.1 : p - 1.45, F1);
  const ground: Openings = {
    front: [win(-3.5), door(plan.door), win(3.6)],
    back: [win(counterU, 1.1), door(p - 0.87, 1.0), win(denDoor + 0.3)],
    west: [win(2.2), win(7.2)],
    east: [win(1.7), win(8.0)],
  };
  const bathU = (q + PH + W) / 2;
  const upper: Openings = {
    front: [upWin(-3.3), upWin(2.6)],
    back: [upWin(-3.3), upWin(hallC), win(bathU, 0.7, 1.25, 1.9)],
    west: [upWin(1.9), upWin(7.6)],
    east: [upWin(2.0)],
  };
  const upHole = k.rect(p + 0.1, p + 1.3, holeV0, sV1);
  const downHole = k.rect(p - 1.3, p - 0.1, sV0, sV1);
  k.b.house(s, k.layout(ground), k.layout(upper), {
    partitions,
    slabHoles: down ? [downHole] : [],
    ceilingHoles: [[upHole]],
  });

  k.stairs(sV0, sV1, sU0, sU1, F1, F2, 'darkWood');
  k.railAlongV(p + 1.34, holeV0, sV1, F2);

  // Dining room at the front, kitchen behind it.
  diningSet(k, westC, 2.5, F1);
  k.tile(-W, westU1, 6.0, D, F1);
  k.lamp(westC, 2.5, F1, 3, 6);
  k.lamp(westC, 7.6, F1, 3, 5.5);
  if (k.rand() < 0.5) k.aidCase('u-', -W, 5.0, F1);

  // Living room.
  const livingV = 3.4;
  k.against('tvStand', 'u+', W, livingV, F1);
  k.prop('sofa', W - 3.22, livingV, k.face(1, 0), { y: F1, movable: true });
  k.prop('coffeeTable', W - 1.62, livingV, k.run(0, 1), { y: F1, movable: true });
  k.prop('rug', W - 1.9, livingV, k.run(0, 1), { y: F1, length: 2.6 });
  const lamp = k.prop('floorLamp', W - 3.4, 2.0, 0, { y: F1 });
  if (spot(lamp.x, lamp.z) < 0.45) lamp.tipped = true;
  k.prop('armchair', W - 0.78, 0.95, k.face(-0.5, 0.85), { y: F1, movable: true });
  k.against('bookshelf', 'v+', denV - PH, W - 1.0, F1, { movable: true });
  k.lamp((hallU0 + W) / 2, 3.0, F1, 3, 7);

  // Den behind the living room: a study or the laundry.
  if (s.seed % 2) {
    k.against('desk', 'u+', W, 8.0, F1);
    k.prop('chair', W - 1.1, 8.0, k.face(1, 0) + 0.3, { y: F1, movable: true });
    k.against('bookshelf', 'v-', denV + PH, W - 0.8, F1, { movable: true });
  } else {
    k.against('washer', 'v+', D, W - 0.4, F1);
    k.against('washer', 'v+', D, W - 1.12, F1);
    k.against('metalShelf', 'v-', denV + PH, W - 0.75, F1);
    k.prop('trashBag', W - 2.2, D - 0.5, 1.3, { y: F1, movable: true, variant: s.seed % 5 });
  }
  k.lamp((denU0 + W) / 2 + 0.3, (denV + D) / 2, F1, 3, 4.5, 8);

  // Main bedroom over the kitchen.
  k.bed('u-', -W, 4.5, F2, 0);
  k.against('wardrobe', 'u+', p - PH, 2.0, F2);
  k.against('dresser', 'u+', p - PH, 6.6, F2, { movable: true });
  k.against('desk', 'v-', T, -3.3, F2);
  k.prop('chair', -3.3, 1.35, k.face(0, -1) + 0.2, { y: F2, movable: true });
  k.prop('rug', -W + 2.9, 4.5, k.run(0, 1), { y: F2, length: 2.2 });
  k.lamp((-W + p) / 2, 5.0, F2, STORY.upper, 5.5);

  // Front bedroom.
  k.bed('v+', bedV - PH, W - 2.05, F2, 1);
  // The dresser goes on the hall wall: in the corner past the bed's foot it would wall off the strip beside the bed.
  k.against('dresser', 'u-', p + PH, 1.8, F2, { movable: true });
  k.against('bookshelf', 'v-', T, 0.4, F2, { movable: true });
  k.lamp((p + W) / 2, 2.0, F2, STORY.upper, 4.5);

  // Landing and bathroom.
  k.against('bookshelf', 'u+', q - PH, 8.8, F2, { movable: true });
  k.lamp(hallC, 6.4, F2, STORY.upper, 3.5, 7);
  // The doorway is in the side wall the sink stands on: keep the sink in front of it.
  bathroom(k, q + PH, W, bedV + PH, D, F2, k.rand() < 0.6, 'u+', bedV + PH + 0.75);
  k.lamp(bathU, 5.6, F2, STORY.upper, 3, 6);

  if (down) {
    k.stairs(sV1, sV0, p - 1.28, p - 0.13, BASEMENT, F1, 'concrete');
    k.railAlongV(p - 1.34, sV0, sV1, F1);
    k.railAlongU(sV1 + 0.04, p - 1.3, p - 0.1, F1);
    k.basement(-W - T, p + 0.15, 0, s.d);
    basementStores(k, -W, p - 0.1, T, D, { u0: p - 1.6, u1: p - 0.1, v0: sV0 - 1.0, v1: D }, !!plan.cache);
    k.lamp((-W + p) / 2, 5.0, BASEMENT, 2.7, 8, 9);
    k.area('BASEMENT', -W - T, p + 0.15, 0, s.d, -3.2, -0.1);
  }
  k.area(s.label ?? 'HOUSE', -W - T, W + T, 0, s.d, -0.1, 8);
}

/** Storage along a basement's walls, keeping the stairs and their landing (`keep`) clear. */
function basementStores(k: Frame, u0: number, u1: number, v0: number, v1: number, keep: { u0: number; u1: number; v0: number; v1: number }, cache: boolean): void {
  const free = (u: number, hu: number) => u + hu < keep.u0 || u - hu > keep.u1;
  k.against('metalShelf', 'u-', u0, v0 + 1.0, BASEMENT);
  k.against('metalShelf', 'u-', u0, v0 + 2.4, BASEMENT, { variant: cache ? 1 : 0 });
  k.against('waterHeater', 'v+', v1, u0 + 0.38, BASEMENT);
  k.against('washer', 'v+', v1, u0 + 1.12, BASEMENT);
  const benchU = u0 + 2.0;
  if (free(benchU, 1.25)) k.against('workbench', 'v-', v0, benchU, BASEMENT);
  else k.against('crate', 'v-', v0, u0 + 1.4, BASEMENT, { movable: true });
  k.prop('crate', u0 + 1.6, v1 - 1.2, 0.4, { y: BASEMENT, movable: true });
  k.prop('crate', u0 + 1.5, v1 - 1.15, 0.5, { y: BASEMENT + 0.6, movable: true });
  k.prop('mattress', u0 + 1.25, (v0 + v1) / 2 + 0.6, k.run(0, 1) + 0.1, { y: BASEMENT, movable: true });
  if (cache) k.against('ammoCrate', 'u-', u0, v1 - 3.0, BASEMENT);
  const right = u1 - 0.6;
  if (free(right, 0.4)) k.prop('oilDrum', right, v0 + 0.6, 0, { y: BASEMENT, movable: true });
  // A wide basement gets a second row of storage on the far wall.
  if (u1 - keep.u1 > 3) {
    k.against('metalShelf', 'u+', u1, v0 + 2.2, BASEMENT);
    k.against('metalShelf', 'u+', u1, v0 + 3.6, BASEMENT);
    k.prop('tireStack', u1 - 0.6, v1 - 0.6, 0.3, { y: BASEMENT });
    k.prop('crate', u1 - 2.0, v1 - 0.55, -0.1, { y: BASEMENT, movable: true });
  }
}
