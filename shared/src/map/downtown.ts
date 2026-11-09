import type { HouseSpec, MaterialKey } from '../types/world';
import { MapBuilder, STORY, STREET, door, doorway, storeWin, win, type Opening } from './builder';
import { streetlight } from './dressing';
import { Frame } from './homes';

/**
 * Court Street: Vesper's downtown, one block north of Hale Street.
 *
 * It tees into Pell Lane at the west end and runs east past two rows of storefronts to Court
 * Square and the town's water tower. The north row is the bank, the hardware store, the diner and
 * the laundry; the south row the drugstore, the market, the army surplus and the tavern. Behind
 * the south row a service alley runs to the parking lot, and two dirt paths cut through the belt
 * of trees to Hale Street's back alley.
 *
 * Axes: +X east, +Z south, +Y up (as in maple-hollow.ts).
 */

const RW = STREET.roadHalfWidth;
const SW = STREET.sidewalkWidth;
const CURB = STREET.curbHeight;
const T = STORY.wall;

export const COURT = {
  /** The road's centre line. */
  z: -86,
  /** Pell Lane's centre line, where Court Street tees in. */
  pell: -68,
  /** Where the asphalt ends, at the water tower's lot. */
  end: 46,
  /** The storefront rows end here; the square and the parking lot lie beyond. */
  rowsEnd: 3,
  /** Court Square (north of the road) and the parking lot (south of it). */
  square: { x0: 6, x1: 40, z0: -113, z1: -93 },
  parking: { x0: 6, x1: 40, z0: -79, z1: -60 },
  /** The water tower's fenced lot and the tower's centre. */
  lot: { x0: 48, x1: 68, z0: -97, z1: -75 },
  tower: { x: 58, z: -86 },
  /** The two paths through the trees to Hale Street's back alley. */
  pathX: 22,
  trailX: 70,
} as const;

/** Edges of the two sidewalks on the building side. */
const WALK_N = COURT.z - RW - SW;
const WALK_S = COURT.z + RW + SW;
const LIGHT_N = COURT.z - RW - 0.55;
const LIGHT_S = COURT.z + RW + 0.55;
/** Store floors sit one low step above the sidewalk. */
const FLOOR = 0.2;
const CEILING = 3.6;
const TUBE = 0xdfe8ff;
const WARM = 0xffb070;

/** The bank's portico: the underside and top of the beam its columns carry (the sign is lettered on it). */
export const PORTICO = { beam: 3.5, top: 4.4 } as const;

/** The water tower: four legs under a tank lettered with the town's name. */
export const WATER_TOWER = {
  ...COURT.tower,
  /** Legs stand on the corners of a square this far from the centre. */
  spread: 3.3,
  leg: 0.55,
  /** Underside and top of the tank, and its radius. */
  tankY: 15.5,
  tankTop: 21.5,
  radius: 4.6,
  /** The riser pipe up the middle. */
  riser: 0.45,
} as const;

/** Whether the woods stay clear of a point: the downtown block and the two paths out of it. */
export function downtownClear(x: number, z: number): boolean {
  if (x > -62 && x < 73 && z > -116 && z < -61) return true;
  if (z <= -49 && z >= -61 && (Math.abs(x - COURT.pathX) < 2.2 || Math.abs(x - COURT.trailX) < 2.2)) return true;
  return false;
}

interface ShopSpec {
  id: string;
  /** Centre along the street, width and depth. */
  x: number;
  w: number;
  d: number;
  /** How far the front wall stands back from the sidewalk. */
  setback?: number;
  portico?: number;
  label: string;
  siding: MaterialKey;
  seed: number;
  sign?: number;
  awning?: number;
  interior?: MaterialKey;
  floorMat?: MaterialKey;
  melee?: boolean;
  litWindows?: number;
}

/** A single-storey flat-roofed storefront on the north row (facing the street, south) or the south row. */
function shopSpec(row: 'n' | 's', s: ShopSpec): HouseSpec {
  const set = s.setback ?? 0;
  const z = row === 'n' ? WALK_N - set - s.d / 2 : WALK_S + set + s.d / 2;
  return {
    id: s.id, x: s.x, z, w: s.w, d: s.d, floors: 1, facing: row === 'n' ? 'south' : 'north', siding: s.siding,
    roofColor: 0x2a2b2e, enterable: true, litWindows: s.litWindows ?? 1, seed: s.seed, slab: FLOOR, groundHeight: CEILING,
    roof: 'flat', interior: s.interior ?? 'interiorWall', floorMat: s.floorMat ?? 'tile', label: s.label,
    sign: s.sign, awning: s.awning, melee: s.melee, portico: s.portico,
  };
}

/** Ceiling tube over a shop floor (some have failed, one flickers). */
function tube(k: Frame, u: number, v: number, intensity = 50, flicker = false): void {
  k.b.light({ kind: 'point', x: k.x(u), y: FLOOR + CEILING - 0.08, z: k.z(v), color: TUBE, intensity, range: 10, decay: 2, fixture: 'panel', flicker });
}

function bulb(k: Frame, u: number, v: number, intensity = 7): void {
  k.b.light({ kind: 'point', x: k.x(u), y: FLOOR + CEILING - 0.5, z: k.z(v), color: WARM, intensity, range: 10, decay: 1.7, fixture: 'bulb' });
}

/** A structural column from the floor to the ceiling: bring enough of them down and the roof follows. */
function column(k: Frame, u: number, v: number, size = 0.4, mat: MaterialKey = 'concrete'): void {
  const x = k.x(u), z = k.z(v);
  k.b.pillar(k.s.id, x, z, size, FLOOR, FLOOR + CEILING, mat);
}

/** Plate glass filling a stretch of wall, in panes no wider than `max` with a pier between them. */
function glazing(from: number, to: number, max = 4.4): Opening[] {
  const len = to - from;
  if (len < 1.6) return [];
  const n = Math.ceil(len / max);
  const pier = 0.5;
  const w = (len - pier * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => storeWin(from + w / 2 + i * (w + pier), w));
}

/** The usual storefront: plate glass either side of a glass door. */
function storefront(w: number, doorAt = 0, doorW = 1.8): Opening[] {
  const edge = w / 2 - 0.9;
  return [
    ...glazing(-edge, doorAt - doorW / 2 - 0.7),
    door(doorAt, doorW, 'glass', 2.4),
    ...glazing(doorAt + doorW / 2 + 0.7, edge),
  ];
}

// ---------------------------------------------------------------- north row

/** The bank: a stone front set back behind four columns, tellers across the lobby, the vault at the back. */
function bank(b: MapBuilder): void {
  const s = shopSpec('n', { id: 'bank', x: -52, w: 14, d: 12, setback: 2.6, portico: 2.6, label: 'VESPER SAVINGS BANK', siding: 'stucco', seed: 211, sign: 0x1d2a3a, floorMat: 'tile' });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  const vault = 8.2;
  b.house(s, k.layout({
    front: [win(-4.4, 1.6, 0.9, 2.7), door(0, 2.0, 'glass', 2.5), win(4.4, 1.6, 0.9, 2.7)],
    back: [door(-5.2, 1.0)],
    west: [win(3.4, 1.2, 1.2, 2.6)],
    east: [win(3.4, 1.2, 1.2, 2.6)],
  }), null, {
    partitions: [
      k.across(0, vault, -W, W, [doorway(-1.2, 1.1)]),
      k.lengthwise(0, 1.6, vault + 0.07, D, [doorway(vault + 2.0, 1.0)]),
    ],
  });
  // The portico: a raised stone floor, four columns and the roof they carry.
  const front = k.z(0), edge = WALK_N;
  b.boxMinMax(s.x - 7, 0, Math.min(front, edge), s.x + 7, FLOOR, Math.max(front, edge), 'concrete', { owner: s.id });
  b.boxMinMax(s.x - 7.2, PORTICO.beam, Math.min(front, edge + 0.2), s.x + 7.2, PORTICO.top, Math.max(front, edge + 0.2), 'concrete', { owner: s.id });
  for (const u of [-5.6, -2.0, 2.0, 5.6]) b.pillar(s.id, k.x(u), edge - 0.55, 0.55, FLOOR, PORTICO.beam, 'concrete');

  // Lobby: the tellers' counter across it, a desk for the loans, chairs to wait on.
  for (const u of [-3.6, -1.2, 1.2]) k.prop('storeCounter', u, 5.2, k.run(1, 0), { y: FLOOR });
  k.against('desk', 'u+', W, 2.2, FLOOR);
  k.prop('chair', W - 1.5, 2.2, k.face(1, 0), { y: FLOOR, movable: true });
  k.prop('chair', -W + 0.6, 1.4, k.face(1, 0), { y: FLOOR, movable: true });
  k.prop('chair', -W + 0.6, 2.3, k.face(1, 0.2), { y: FLOOR, movable: true, tipped: true });
  k.prop('rug', 0, 2.4, k.run(0, 1), { y: FLOOR, length: 3.2 });
  k.aidCase('v+', vault - 0.07, -5.0, FLOOR - 0.25);
  tube(k, -3.2, 3.0);
  tube(k, 3.2, 3.0, 50, true);
  tube(k, 0, 6.8, 36);
  // Back office.
  k.against('desk', 'v+', D, -3.6, FLOOR);
  k.prop('chair', -3.6, D - 1.2, k.face(0, 1), { y: FLOOR, movable: true });
  k.against('bookshelf', 'u-', -W, vault + 1.0, FLOOR);
  k.against('metalShelf', 'v-', vault + 0.07, -2.4, FLOOR);
  bulb(k, -3.0, 10, 6);
  // The vault: what the town thought was worth locking up.
  k.against('metalShelf', 'u+', W, D - 1.0, FLOOR, { variant: 1 });
  k.against('ammoCrate', 'v+', D, 4.6, FLOOR);
  k.prop('crate', 2.5, D - 0.6, 0.2, { y: FLOOR, movable: true });
  bulb(k, 4.2, 10, 5);
  k.area(s.label!, -W - T, W + T, -2.6, s.d, -0.1, 6);
}

/** The hardware store: aisles of shelving, the counter by the door, a stock room with a bench. */
function hardware(b: MapBuilder): void {
  const s = shopSpec('n', { id: 'hardware', x: -34, w: 16, d: 12, label: 'VESPER HARDWARE', siding: 'brick', seed: 223, sign: 0x7a1612, awning: 0x7a1612, floorMat: 'concrete', melee: true });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  const stock = 8.6;
  b.house(s, k.layout({
    front: storefront(s.w, -1.5),
    back: [door(5.4, 1.2)],
    west: [],
    east: [win(stock + 1.6, 1.0, 1.3, 2.5)],
  }), null, { partitions: [k.across(0, stock, -W, W, [doorway(-5.6, 1.3), doorway(4.4, 1.3)])] });
  for (const u of [-3.9, 3.9]) column(k, u, 4.5);
  // Aisles run front to back.
  for (const [u, variant] of [[-5.9, 0], [-1.9, 1], [1.9, 0], [5.9, 1]] as const) {
    k.prop('storeShelf', u, 4.9, k.run(0, 1), { y: FLOOR, length: 4.6, variant });
  }
  k.prop('storeCounter', 2.2, 1.1, k.run(1, 0), { y: FLOOR });
  k.prop('crate', -4.2, 1.0, 0.3, { y: FLOOR, movable: true });
  k.prop('oilDrum', -W + 0.5, 0.9, 0, { y: FLOOR, movable: true });
  tube(k, -3.9, 2.6);
  tube(k, 3.9, 2.6, 44);
  tube(k, 0, 6.6, 40);
  // Stock room.
  k.against('workbench', 'v+', D, -3.6, FLOOR);
  k.against('metalShelf', 'v+', D, 0.2, FLOOR);
  k.against('metalShelf', 'v+', D, 1.6, FLOOR, { variant: 1 });
  k.against('metalShelf', 'u-', -W, stock + 1.4, FLOOR);
  k.prop('pallet', 2.6, stock + 1.2, 0.2, { y: FLOOR, movable: true });
  k.prop('crate', 1.4, stock + 1.0, 0.25, { y: FLOOR, movable: true });
  k.prop('tireStack', W - 0.6, stock + 0.7, 0, { y: FLOOR });
  bulb(k, -1.5, stock + 1.6, 7);
  k.area(s.label!, -W - T, W + T, 0, s.d, -0.1, 6);
}

/** The diner: tables down the windows, the counter and the kitchen behind it. */
function diner(b: MapBuilder): void {
  const s = shopSpec('n', { id: 'diner', x: -17.5, w: 13, d: 10, label: 'DOT’S DINER', siding: 'sidingBlue', seed: 229, sign: 0x1f5c66, awning: 0x1f5c66, floorMat: 'tile' });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  const kitchen = 6.4;
  b.house(s, k.layout({
    front: storefront(s.w, 3.4, 1.2),
    back: [door(4.6, 1.0)],
    west: [win(2.6, 2.2, 0.9, 2.5)],
    east: [],
  }), null, { partitions: [k.across(0, kitchen, -W, W, [doorway(4.4, 1.2)])] });
  // Tables by the front windows and along the west wall.
  for (const [u, v] of [[-4.6, 1.5], [-1.9, 1.5], [-4.9, 4.1]] as const) {
    k.prop('diningTable', u, v, k.run(1, 0), { y: FLOOR, movable: true });
    for (const su of [-1, 1]) {
      const c = k.prop('chair', u + su * 1.05, v, k.face(-su, 0) + (k.rand() - 0.5) * 0.4, { y: FLOOR, movable: true });
      if (u === -1.9 && su === 1) c.tipped = true;
    }
  }
  // The counter with its stools.
  k.prop('counter', -0.6, kitchen - 1.25, k.run(1, 0), { y: FLOOR, length: 4.6 });
  for (const u of [-2.2, -1.0, 0.2, 1.4]) k.prop('chair', u, kitchen - 2.05, k.face(0, 1), { y: FLOOR, movable: true });
  k.prop('storeCounter', 4.2, 3.6, k.run(0, 1), { y: FLOOR });
  tube(k, -3.4, 2.8, 46);
  tube(k, 2.6, 2.8, 46);
  // Kitchen.
  k.against('stove', 'v+', D, -4.8, FLOOR);
  k.against('stove', 'v+', D, -3.95, FLOOR);
  k.against('counter', 'v+', D, -2.2, FLOOR, { length: 2.4 });
  k.against('fridge', 'v+', D, 0.1, FLOOR);
  k.against('fridge', 'v+', D, 1.0, FLOOR);
  k.against('counter', 'v-', kitchen + 0.07, -2.4, FLOOR, { length: 3.0 });
  k.aidCase('u+', W, kitchen + 1.6, FLOOR - 0.25);
  k.prop('trashBag', 2.6, D - 0.6, 1.2, { y: FLOOR, variant: 2, movable: true });
  bulb(k, -1.6, kitchen + 1.6, 7);
  k.area(s.label!, -W - T, W + T, 0, s.d, -0.1, 6);
}

/** The laundry: washers down both walls, a folding table, the back door propped for the heat. */
function laundry(b: MapBuilder): void {
  const s = shopSpec('n', { id: 'laundry', x: -3.5, w: 11, d: 10, label: 'SUDS COIN LAUNDRY', siding: 'sidingGreen', seed: 233, sign: 0x2f5d3a, floorMat: 'tile', litWindows: 0.6 });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  b.house(s, k.layout({
    front: storefront(s.w, 0, 1.4),
    back: [door(3.6, 1.0)],
    west: [],
    east: [win(4.6, 1.4, 1.0, 2.5)],
  }), null);
  for (let i = 0; i < 6; i++) k.against('washer', 'u-', -W, 1.4 + i * 0.95, FLOOR);
  for (let i = 0; i < 3; i++) k.against('washer', 'u+', W, 1.4 + i * 0.95, FLOOR);
  k.prop('diningTable', 0.4, 4.6, k.run(0, 1), { y: FLOOR, movable: true });
  k.against('counter', 'v+', D, -1.6, FLOOR, { length: 3.4 });
  k.against('waterHeater', 'v+', D, -4.6, FLOOR);
  k.prop('chair', W - 0.6, 6.4, k.face(-1, 0), { y: FLOOR, movable: true });
  k.prop('chair', W - 0.6, 7.3, k.face(-1, 0.3), { y: FLOOR, movable: true });
  k.prop('trashBag', -1.2, 7.4, 0.4, { y: FLOOR, variant: 1, movable: true });
  tube(k, 0, 2.6, 46, true);
  tube(k, 0, 6.6, 40);
  k.area(s.label!, -W - T, W + T, 0, s.d, -0.1, 6);
}

// ---------------------------------------------------------------- south row

/** The drugstore: shelves, the pharmacy counter across the back, first aid on the wall. */
function drugstore(b: MapBuilder): void {
  const s = shopSpec('s', { id: 'drugstore', x: -53, w: 12, d: 10, label: 'CORNER DRUG', siding: 'brick', seed: 239, sign: 0x24543a, awning: 0x24543a, floorMat: 'tile' });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  const back = 6.6;
  b.house(s, k.layout({
    front: storefront(s.w, 0, 1.6),
    back: [door(4.0, 1.0)],
    west: [win(2.4, 2.0, 0.9, 2.5)],
    east: [],
  }), null, { partitions: [k.across(0, back, -W, W, [doorway(3.9, 1.1)])] });
  k.prop('storeShelf', -2.9, 3.4, k.run(0, 1), { y: FLOOR, length: 3.8 });
  k.prop('storeShelf', 0.5, 3.4, k.run(0, 1), { y: FLOOR, length: 3.8, variant: 1 });
  k.prop('storeCounter', 3.9, 2.0, k.run(0, 1), { y: FLOOR });
  // The pharmacy counter, with what is left behind it.
  k.prop('counter', -1.6, back - 0.6, k.run(1, 0), { y: FLOOR, length: 6.0 });
  k.against('metalShelf', 'v+', D, -4.6, FLOOR, { variant: 1 });
  k.against('metalShelf', 'v+', D, -3.2, FLOOR);
  k.against('fridge', 'v+', D, -1.6, FLOOR);
  k.aidCase('v+', D, 0.4, FLOOR - 0.25);
  k.aidCase('u-', -W, back + 1.4, FLOOR - 0.25);
  k.prop('crate', 2.0, D - 0.7, 0.3, { y: FLOOR, movable: true });
  tube(k, -2.6, 2.4);
  tube(k, 2.6, 2.4, 44);
  bulb(k, -1.2, back + 1.5, 6);
  k.area(s.label!, -W - T, W + T, 0, s.d, -0.1, 6);
}

/** The market: the biggest floor on the street, coolers down one wall, registers by the door. */
function market(b: MapBuilder): void {
  const s = shopSpec('s', { id: 'market', x: -36, w: 18, d: 12, label: 'KLINE’S MARKET', siding: 'sidingBeige', seed: 241, sign: 0x8a5a12, awning: 0x8a5a12, floorMat: 'tile' });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  const stock = 9.0;
  b.house(s, k.layout({
    front: storefront(s.w, 2.0),
    back: [door(-6.4, 1.2)],
    west: [],
    east: [],
  }), null, { partitions: [k.across(0, stock, -W, W, [doorway(-6.2, 1.3), doorway(5.6, 1.3)])] });
  for (const u of [-4.5, 4.5]) column(k, u, 4.6);
  for (const [u, variant] of [[-6.6, 0], [-2.5, 1], [0.9, 0], [6.6, 1]] as const) {
    k.prop('storeShelf', u, 5.0, k.run(0, 1), { y: FLOOR, length: 4.4, variant });
  }
  for (const u of [-1.4, 0.7]) k.against('cooler', 'v+', stock - 0.07, u, FLOOR);
  k.prop('storeCounter', -1.6, 1.2, k.run(1, 0), { y: FLOOR });
  k.prop('storeCounter', -4.8, 1.2, k.run(1, 0), { y: FLOOR });
  k.prop('crate', 6.9, 1.0, 0.2, { y: FLOOR, movable: true });
  k.prop('trashBag', 4.4, 1.4, 2.2, { y: FLOOR, variant: 3, movable: true });
  tube(k, -4.5, 2.6);
  tube(k, 4.5, 2.6, 50, true);
  tube(k, -4.5, 6.8, 40);
  tube(k, 4.5, 6.8, 40);
  // Stock room.
  for (const u of [-3.4, -2.0, 0.4]) k.against('metalShelf', 'v+', D, u, FLOOR);
  k.prop('pallet', 3.0, stock + 1.3, 0.1, { y: FLOOR, movable: true });
  k.prop('crate', 4.2, stock + 0.9, 0.15, { y: FLOOR, movable: true });
  k.prop('crate', 2.0, D - 0.6, 0.6, { y: FLOOR, movable: true });
  k.aidCase('u+', W, stock + 1.4, FLOOR - 0.25);
  bulb(k, 0, stock + 1.3, 7);
  k.area(s.label!, -W - T, W + T, 0, s.d, -0.1, 6);
}

/** The army surplus: racks and crates, and a locked case in the back that still has something in it. */
function surplus(b: MapBuilder): void {
  const s = shopSpec('s', { id: 'surplus', x: -18, w: 13, d: 10, label: 'HOLLIS ARMY SURPLUS', siding: 'sidingGray', seed: 251, sign: 0x3a4a2a, floorMat: 'concrete', melee: true, litWindows: 0.6 });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  const back = 6.6;
  b.house(s, k.layout({
    front: storefront(s.w, -2.2, 1.4),
    back: [door(-4.4, 1.0)],
    west: [],
    east: [win(2.4, 1.6, 1.0, 2.5)],
  }), null, { partitions: [k.across(0, back, -W, W, [doorway(4.2, 1.2)])] });
  k.prop('storeShelf', -2.6, 3.6, k.run(0, 1), { y: FLOOR, length: 3.6, variant: 1 });
  k.prop('storeShelf', 1.2, 3.6, k.run(0, 1), { y: FLOOR, length: 3.6 });
  k.prop('storeCounter', 4.6, 1.3, k.run(1, 0), { y: FLOOR });
  k.against('metalShelf', 'u-', -W, 2.2, FLOOR);
  k.against('metalShelf', 'u-', -W, 3.6, FLOOR, { variant: 1 });
  k.prop('crate', 4.8, 4.9, 0.4, { y: FLOOR, movable: true });
  tube(k, -2.4, 2.6, 44);
  tube(k, 2.8, 2.6, 44, true);
  // The back room.
  k.against('ammoCrate', 'v+', D, 0.6, FLOOR);
  k.against('ammoCrate', 'v+', D, 1.7, FLOOR);
  k.against('workbench', 'v+', D, -2.4, FLOOR);
  k.against('metalShelf', 'u+', W, back + 1.6, FLOOR, { variant: 1 });
  k.prop('crate', -5.2, back + 0.8, 0.1, { y: FLOOR, movable: true });
  k.prop('crate', -5.2, back + 0.8, 0.4, { y: FLOOR + 0.6, movable: true });
  bulb(k, -0.6, back + 1.5, 6);
  k.area(s.label!, -W - T, W + T, 0, s.d, -0.1, 6);
}

/** The tavern: a long bar, a few tables, dark wood and one small window. */
function tavern(b: MapBuilder): void {
  const s = shopSpec('s', { id: 'tavern', x: -4, w: 11, d: 10, label: 'THE LAMPLIGHTER', siding: 'brick', seed: 257, sign: 0x3a2a1c, interior: 'interiorWallBlue', floorMat: 'woodFloor', litWindows: 1 });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  b.house(s, k.layout({
    front: [win(-2.9, 1.6, 1.1, 2.4), door(1.6, 1.2, 'wood', 2.3)],
    back: [door(-3.8, 1.0)],
    west: [],
    east: [win(5.4, 1.2, 1.2, 2.4)],
  }), null);
  // The bar along the west wall, bottles behind it.
  k.prop('counter', -3.3, 4.6, k.run(0, 1), { y: FLOOR, length: 5.6 });
  k.against('bookshelf', 'u-', -W, 3.4, FLOOR);
  k.against('bookshelf', 'u-', -W, 5.2, FLOOR);
  k.against('fridge', 'u-', -W, 6.9, FLOOR);
  for (const v of [2.6, 3.8, 5.0, 6.2]) k.prop('chair', -2.5, v, k.face(-1, 0) + (k.rand() - 0.5) * 0.5, { y: FLOOR, movable: true });
  for (const [u, v, tip] of [[2.6, 3.0, false], [3.0, 6.2, true]] as const) {
    k.prop('diningTable', u, v, k.run(0, 1), { y: FLOOR, movable: true });
    k.prop('chair', u, v - 1.05, k.face(0, 1), { y: FLOOR, movable: true });
    k.prop('chair', u, v + 1.05, k.face(0, -1) + 0.3, { y: FLOOR, movable: true, tipped: tip });
  }
  k.against('sofa', 'v+', D, 1.8, FLOOR, { movable: true });
  k.aidCase('v+', D, -1.4, FLOOR - 0.25);
  bulb(k, -1.8, 3.2, 6);
  bulb(k, 2.4, 6.0, 5);
  k.area(s.label!, -W - T, W + T, 0, s.d, -0.1, 6);
}

// ---------------------------------------------------------------- street, square, tower

/** The road and its sidewalks. Pell Lane's sidewalk breaks for the junction (maple-hollow.ts). */
function roads(b: MapBuilder): void {
  const { z, end } = COURT;
  const x0 = COURT.pell + RW;
  // Asphalt is visual; the terrain collider is the drivable surface.
  b.boxMinMax(x0, 0, z - RW, end, 0.02, z + RW, 'asphalt', { collide: false });
  b.boxMinMax(x0, 0, WALK_N, end, CURB, z - RW, 'sidewalk');
  b.boxMinMax(x0, 0, z + RW, COURT.parking.x0, CURB, WALK_S, 'sidewalk');
  // The south sidewalk drops for the parking lot's entrance, then carries on to the tower's lot.
  b.boxMinMax(COURT.parking.x0 + 9, 0, z + RW, end, CURB, WALK_S, 'sidewalk');
  // The lot: old concrete, cracked.
  const p = COURT.parking;
  b.boxMinMax(p.x0, 0, WALK_S, p.x1, 0.022, p.z1, 'concrete', { collide: false });
  b.boxMinMax(p.x0, 0, z + RW, p.x0 + 9, 0.022, WALK_S, 'concrete', { collide: false });
  // The service alley behind the south row.
  b.boxMinMax(x0 + SW, 0, -66.5, p.x0, 0.03, -62.5, 'gravel', { collide: false });
  // Two dirt paths through the trees to Hale Street's back alley.
  b.boxMinMax(COURT.pathX - 1, 0, p.z1, COURT.pathX + 1, 0.015, -49, 'dirt', { collide: false });
  b.boxMinMax(COURT.trailX - 1, 0, COURT.lot.z1, COURT.trailX + 1, 0.015, -49, 'dirt', { collide: false });
  b.boxMinMax(COURT.lot.x1 - 2, 0, COURT.lot.z1 - 2, COURT.trailX + 1, 0.015, COURT.lot.z1, 'dirt', { collide: false });

  // The junction: Court Street stops for Pell Lane.
  b.prop('stopSign', x0 + 0.6, z + RW + 0.6, Math.PI / 2);
  b.prop('streetSign', x0 + 0.6, z - RW - 0.6, 0, { text: 'PELL LN|COURT ST' });
}

function streetDressing(b: MapBuilder): void {
  const { z } = COURT;
  for (const x of [-46, -8]) streetlight(b, x, LIGHT_N, 0);
  streetlight(b, 30, LIGHT_N, 0, 'flicker');
  for (const x of [-27, 12]) streetlight(b, x, LIGHT_S, Math.PI);
  streetlight(b, 42, LIGHT_S, Math.PI, 'dead');

  // Street furniture stands at the curb, clear of the doors and the alley mouths.
  const curbN = z - RW - 0.6, curbS = z + RW + 0.6;
  for (const [x, hz] of [[-40.5, curbN], [-11, curbS], [4.5, curbN]] as const) b.prop('hydrant', x, hz, 0);
  for (const [x, hz, r] of [[-36, curbN, Math.PI], [-20, curbN, Math.PI], [-39, curbS, 0]] as const) b.prop('bench', x, hz, r);
  for (const [x, hz, v] of [[-54, curbN, 0], [-14.5, curbS, 1], [0.5, curbN, 2]] as const) b.prop('trashBin', x, hz, 0, { variant: v, movable: true });
  for (const [x, hz, r] of [[-57.5, curbN, 0], [-31, curbS, Math.PI]] as const) b.prop('mailbox', x, hz, r);

  // Left where they stopped: the street is half blocked by a pile-up outside the market.
  b.prop('car', -49, z - 2.9, 0.02, { variant: 2 });
  b.prop('wreckedCar', -33.5, z + 0.8, 0.5, { variant: 4 });
  b.prop('car', -29.2, z - 1.4, -0.42, { variant: 0 });
  b.prop('policeCar', -22.5, z + 2.2, Math.PI - 0.25, { flag: true });
  b.prop('car', -6, z + 2.9, Math.PI + 0.03, { variant: 5, drive: true });
  b.prop('car', 16, z - 2.9, 0.04, { variant: 3 });
  b.prop('wreckedCar', 36, z + 1.2, -0.7, { variant: 7 });
  // The parking lot.
  const p = COURT.parking;
  const row = p.z1 - 2.6;
  b.prop('car', 12, row, Math.PI / 2 + 0.03, { variant: 1 });
  b.prop('car', 15, row + 0.2, Math.PI / 2 - 0.04, { variant: 4, drive: true });
  b.prop('wreckedCar', 18.4, row - 0.3, Math.PI / 2 + 0.2, { variant: 9 });
  b.prop('car', 33, row, -Math.PI / 2 + 0.05, { variant: 0 });
  b.prop('car', 36, WALK_S + 3.0, 0.1, { variant: 2 });
  b.prop('policeCar', 27, WALK_S + 5.5, 0.6, { flag: false, drive: true });
  b.prop('parkLamp', 26, p.z1 - 1.0, 0);
  b.light({ kind: 'point', x: 26, y: 3.85, z: p.z1 - 1.0, color: 0xd8e4ff, intensity: 60, range: 14, decay: 2, fixture: 'none' });
  b.prop('dumpster', 8.2, -64.2, Math.PI / 2);
  b.prop('trashBin', 38.8, WALK_S + 1.0, 0.3, { variant: 1, movable: true });

  // The service alley.
  b.prop('dumpster', -44.5, -64.2, 0);
  b.prop('dumpster', -11.5, -64.4, 0.06, { variant: 1 });
  b.prop('pallet', -26.5, -65.6, 0.3, { movable: true });
  b.prop('oilDrum', -24.8, -65.9, 0, { movable: true });
  b.prop('tireStack', -58.6, -64.6, 0);
  for (const [x, az] of [[-43, -63.2], [-30, -65.8], [-9.6, -63.4], [2.4, -65.2]] as const) b.prop('trashBag', x, az, x, { variant: Math.abs(Math.round(x)) % 5, movable: true });
  b.light({ kind: 'point', x: -30, y: 3.0, z: -66.6, color: 0xffb36b, intensity: 7, range: 10, decay: 1.8, fixture: 'none' });
  // Behind the north row.
  b.prop('dumpster', -24, -106.4, 0.04);
  b.prop('pallet', -40, -106.6, 0.5, { movable: true });
  b.prop('trashBag', -9, -104.8, 1, { variant: 2, movable: true });
  b.prop('wreckedCar', 0.6, -107.5, 1.2, { variant: 11 });
  b.light({ kind: 'point', x: -28.6, y: 3.0, z: -105.4, color: 0xffb36b, intensity: 7, range: 10, decay: 1.8, fixture: 'none' });

  // Litter and puddles.
  const bags: [number, number][] = [[-56, z - 5.4], [-38, z + 5.2], [-15, z - 4.6], [9, z + 4.4], [30, z - 5.2]];
  bags.forEach(([x, bz], i) => b.prop('trashBag', x, bz, i * 1.9 + 0.3, { variant: i + 1, movable: true }));
  const puddles: [number, number, number][] = [[-52, z + 1.6, 2.2], [-12, z - 2.0, 1.8], [10, z + 0.8, 2.4], [26, p.z1 - 8, 2.6], [40, z - 1.4, 1.7]];
  puddles.forEach(([x, pz, r], i) => b.prop('puddle', x, pz, i * 1.3, { length: r, variant: i + 5 }));
  const leaves: [number, number][] = [[-8, -64], [14, -96], [34, -108], [44, -76]];
  leaves.forEach(([x, lz], i) => b.prop('leafPile', x, lz, i * 1.4, { variant: i + 4 }));
}

/** Court Square: a paved walk round a lawn, benches, lamps, the flagpole in the middle. */
function square(b: MapBuilder): void {
  const q = COURT.square;
  const cx = (q.x0 + q.x1) / 2, cz = (q.z0 + q.z1) / 2;
  // Walks: round the edge and across the middle both ways.
  b.boxMinMax(q.x0, 0, q.z1 - 2, q.x1, 0.03, q.z1, 'sidewalk', { collide: false });
  b.boxMinMax(q.x0, 0, q.z0, q.x1, 0.03, q.z0 + 2, 'sidewalk', { collide: false });
  b.boxMinMax(q.x0, 0, q.z0 + 2, q.x0 + 2, 0.03, q.z1 - 2, 'sidewalk', { collide: false });
  b.boxMinMax(q.x1 - 2, 0, q.z0 + 2, q.x1, 0.03, q.z1 - 2, 'sidewalk', { collide: false });
  b.boxMinMax(cx - 1, 0, q.z0 + 2, cx + 1, 0.03, q.z1 - 2, 'sidewalk', { collide: false });
  b.boxMinMax(q.x0 + 2, 0, cz - 1, q.x1 - 2, 0.03, cz + 1, 'sidewalk', { collide: false });
  b.boxMinMax(cx - 2.6, 0, cz - 2.6, cx + 2.6, 0.035, cz + 2.6, 'sidewalk', { collide: false });
  // The flagpole on its plinth.
  b.boxMinMax(cx - 0.9, 0, cz - 0.9, cx + 0.9, 0.45, cz + 0.9, 'concrete');
  b.prop('flagpole', cx, cz, 0, { y: 0.45 });
  for (const [x, z, r] of [[cx - 3.4, cz - 1.9, Math.PI / 2], [cx + 3.4, cz + 1.9, -Math.PI / 2], [cx - 1.9, cz + 3.4, Math.PI], [cx + 1.9, cz - 3.4, 0]] as const) b.prop('bench', x, z, r);
  for (const [x, z] of [[q.x0 + 2.6, q.z0 + 2.6], [q.x1 - 2.6, q.z0 + 2.6], [q.x0 + 2.6, q.z1 - 2.6], [q.x1 - 2.6, q.z1 - 2.6]] as const) {
    b.prop('parkLamp', x, z, 0);
    b.light({ kind: 'point', x, y: 3.85, z, color: 0xd8e4ff, intensity: 60, range: 13, decay: 2, fixture: 'none' });
  }
  for (const [x, z, v] of [[cx - 8, cz - 5, 2], [cx + 8, cz - 5, 5], [cx - 8, cz + 4.6, 7], [cx + 8.4, cz + 4.6, 4]] as const) b.prop('tree', x, z, v * 1.3, { variant: v });
  for (const [x, z] of [[cx - 4.2, cz - 6.6], [cx + 4.4, cz - 6.4], [cx - 12.6, cz + 0.2], [cx + 12.6, cz - 0.4]] as const) b.prop('bush', x, z, x, { variant: Math.abs(Math.round(z)) });
  b.prop('picnicTable', cx + 9, cz + 0.4, 0.3, { movable: true });
  b.prop('trashBin', cx + 2.2, q.z1 - 1.2, 0, { variant: 2, movable: true });
  b.prop('boardSign', q.x0 + 4.6, q.z1 - 1.0, 0, { text: 'COURT SQUARE|EST. 1894', variant: 1 });
  b.area('COURT SQUARE', q.x0, q.x1, q.z0, q.z1);
}

/** The water tower on its gravel lot: four legs, a riser, the tank high over the street. */
function waterTower(b: MapBuilder): void {
  const t = WATER_TOWER;
  const l = COURT.lot;
  b.boxMinMax(l.x0, 0, l.z0, l.x1, 0.03, l.z1, 'gravel', { collide: false });
  b.structure({ id: 'water-tower', kind: 'tower', x: t.x, z: t.z, w: t.spread * 2 + 2, d: t.spread * 2 + 2, label: 'THE WATER TOWER', top: t.tankTop + 2, base: 0.35 });
  // Concrete footings, the legs on them, the riser up the middle.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = t.x + sx * t.spread, z = t.z + sz * t.spread;
    b.boxMinMax(x - 0.6, 0, z - 0.6, x + 0.6, 0.35, z + 0.6, 'concrete', { owner: 'water-tower' });
    b.pillar('water-tower', x, z, t.leg, 0.35, t.tankY, 'metal');
  }
  b.boxMinMax(t.x - t.riser, 0, t.z - t.riser, t.x + t.riser, t.tankY, t.z + t.riser, 'metal', { owner: 'water-tower' });
  // The tank itself (drawn by the renderer; this is what rounds and the helicopter's crate hit).
  const r = t.radius * 0.8;
  b.boxMinMax(t.x - r, t.tankY, t.z - r, t.x + r, t.tankTop, t.z + r, 'metal', { visible: false, owner: 'water-tower' });
  // A chain fence round the lot, open on the street side and at the trail.
  b.prop('ironFence', (l.x0 + l.x1) / 2, l.z0, 0, { length: l.x1 - l.x0 });
  b.prop('ironFence', l.x1, (l.z0 + l.z1) / 2 - 1.5, Math.PI / 2, { length: l.z1 - l.z0 - 3 });
  b.prop('ironFence', (l.x0 + l.x1) / 2 - 2, l.z1, 0, { length: l.x1 - l.x0 - 4 });
  b.prop('ironFence', l.x0, l.z0 + 3.5, Math.PI / 2, { length: 7 });
  b.prop('ironFence', l.x0, l.z1 - 3.5, Math.PI / 2, { length: 7 });
  b.prop('boardSign', l.x0 + 0.6, COURT.z - 6.4, -Math.PI / 2, { text: 'VESPER WATER DEPT|KEEP OUT' });
  b.prop('dumpster', l.x1 - 2.4, l.z0 + 2.2, 0.05, { variant: 1 });
  b.prop('oilDrum', l.x1 - 6.4, l.z0 + 1.6, 0, { movable: true });
  b.prop('oilDrum', l.x1 - 7.2, l.z0 + 2.0, 0.6, { movable: true, variant: 1 });
  b.prop('pallet', l.x0 + 3, l.z1 - 2.4, 0.4, { movable: true });
  b.prop('crate', l.x0 + 3, l.z1 - 2.4, 0.5, { y: 0.15, movable: true });
  b.prop('wreckedCar', l.x0 + 5.5, l.z0 + 3.4, 2.5, { variant: 10 });
  // A work lamp on one leg, and the beacon on top (drawn by the renderer).
  b.light({ kind: 'point', x: t.x, y: 4.6, z: t.z + t.riser + 0.3, color: 0xffc58a, intensity: 26, range: 15, decay: 1.8, fixture: 'none' });
  b.area('THE WATER TOWER', l.x0, l.x1, l.z0, l.z1);
}

/** Builds Court Street onto the neighbourhood. */
export function downtown(b: MapBuilder): void {
  roads(b);
  bank(b);
  hardware(b);
  diner(b);
  laundry(b);
  drugstore(b);
  market(b);
  surplus(b);
  tavern(b);
  streetDressing(b);
  square(b);
  waterTower(b);
  b.area('SERVICE ALLEY', COURT.pell + RW, COURT.parking.x0, -67, -62);
  b.area('COURT STREET', COURT.pell + RW, COURT.lot.x1, -116, -60);
}
