import type { HouseSpec, PropKind } from '../types/world';
import { MapBuilder, STREET } from './builder';
import { divider, fenceLine, streetlight } from './dressing';
import { buildHome, type HomePlan } from './homes';

/**
 * Oak Street: the next street over, one block south of Elm Street.
 *
 * It tees into Birch Lane at the west end. Its north row backs onto Elm Street's south alley, so
 * that alley serves both streets; its south row backs onto the woods. To the east the road runs
 * out past the last lot and dead-ends in the woods, where a dirt trail comes down from the park's
 * back gate. Ten family homes, built from the same floor plans as Elm Street's, five with
 * basements.
 *
 * Axes: +X east, +Z south, +Y up (as in maple-hollow.ts).
 */

const RW = STREET.roadHalfWidth;
const SW = STREET.sidewalkWidth;
const CURB = STREET.curbHeight;

export const OAK = {
  /** The road's centre line. */
  z: 94,
  /** Birch Lane's centre line, where Oak Street tees in. */
  birch: -68,
  /** Where the asphalt ends (the dead end's curb runs from here). */
  end: 95,
  /** The trail from the park's back gate down to the dead end. */
  trailX: 89,
  /** Back fences: the north row's on the shared alley, the south row's on the woods. */
  northFence: 52,
  southFence: 136,
  /** Lots run east from Birch Lane's sidewalk to here. */
  lotsEnd: 64,
} as const;

/** West edge of the lots (just past Birch Lane's sidewalk). */
const LOTS_START = OAK.birch + RW + SW + 0.6;
/** Front walls of the two rows. */
const FRONT_N = OAK.z - 14.5;
const FRONT_S = OAK.z + 14.5;
/** Edges of the two sidewalks on the lawn side, and the curb line the mailboxes stand on. */
const WALK_N = OAK.z - RW - SW;
const WALK_S = OAK.z + RW + SW;
const LIGHT_N = OAK.z - RW - 0.55;
const LIGHT_S = OAK.z + RW + 0.55;

interface HomeEntry extends HomePlan {
  driveX: number | null;
}

/** A home on the north row (facing the street, south) or the south row (facing north), placed by its front wall. */
function lot(row: 'n' | 's', spec: Omit<HouseSpec, 'z' | 'facing' | 'enterable' | 'floors'> & { floors: 1 | 2 }, plan: Omit<HomeEntry, 'spec'>): HomeEntry {
  const z = row === 'n' ? FRONT_N - spec.d / 2 : FRONT_S + spec.d / 2;
  return { ...plan, spec: { ...spec, z, facing: row === 'n' ? 'south' : 'north', enterable: true } };
}

/** The family homes on both sides of Oak Street. */
export function oakHomes(): HomeEntry[] {
  return [
    lot('n', { id: 'oak-n1', x: -48, w: 11, d: 10, floors: 1, siding: 'sidingBlue', roofColor: 0x2a2a28, litWindows: 1, seed: 131, label: 'THE PATEL HOUSE' },
      { layout: 'ranch', door: 1, basement: true, cache: true, driveX: -39.2 }),
    lot('n', { id: 'oak-n2', x: -22, w: 12, d: 10, floors: 2, siding: 'stucco', roofColor: 0x26282c, litWindows: 1, seed: 138, label: 'THE KOWALSKI HOUSE' },
      { layout: 'twoStorey', door: 1, mirror: true, driveX: -12.8 }),
    lot('n', { id: 'oak-n3', x: 4, w: 11, d: 9, floors: 1, siding: 'brick', roofColor: 0x2a2624, litWindows: 0.6, seed: 149, label: 'THE FISCHER HOUSE' },
      { layout: 'ranch', door: 1, mirror: true, driveX: 12.4 }),
    lot('n', { id: 'oak-n4', x: 29, w: 12, d: 10, floors: 2, siding: 'sidingGreen', roofColor: 0x22262c, litWindows: 1, seed: 151, label: 'THE DELGADO HOUSE' },
      { layout: 'twoStorey', door: 0.8, basement: true, driveX: 37.6 }),
    lot('n', { id: 'oak-n5', x: 53, w: 11, d: 10, floors: 2, siding: 'sidingBeige', roofColor: 0x24272b, litWindows: 1, seed: 158, label: 'THE SULLIVAN HOUSE' },
      { layout: 'twoStorey', door: 1.2, mirror: true, driveX: 44.4 }),
    lot('s', { id: 'oak-s1', x: -45, w: 12, d: 10, floors: 2, siding: 'sidingGray', roofColor: 0x27292d, litWindows: 1, seed: 163, label: 'THE MOREAU HOUSE' },
      { layout: 'twoStorey', door: 0.8, mirror: true, basement: true, driveX: -36.6 }),
    lot('s', { id: 'oak-s2', x: -18, w: 11, d: 9, floors: 1, siding: 'sidingGreen', roofColor: 0x2a2a28, litWindows: 1, seed: 167, label: 'THE JENSEN HOUSE' },
      { layout: 'ranch', door: 1, driveX: -9.6 }),
    lot('s', { id: 'oak-s3', x: 10, w: 12, d: 10, floors: 2, siding: 'sidingBlue', roofColor: 0x202429, litWindows: 0.6, seed: 173, label: 'THE OYELARAN HOUSE' },
      { layout: 'twoStorey', door: 0.5, basement: true, cache: true, driveX: 18.6 }),
    lot('s', { id: 'oak-s4', x: 36, w: 11, d: 10, floors: 1, siding: 'brick', roofColor: 0x2b2d33, litWindows: 1, seed: 179, label: 'THE LINDQVIST HOUSE' },
      { layout: 'ranch', door: 1, mirror: true, basement: true, driveX: 27.2 }),
    lot('s', { id: 'oak-s5', x: 56.5, w: 11, d: 9, floors: 1, siding: 'stucco', roofColor: 0x26282c, litWindows: 1, seed: 181, label: 'THE CASTILLO HOUSE' },
      { layout: 'ranch', door: 1, driveX: 47.5 }),
  ];
}

function home(b: MapBuilder, e: HomeEntry): void {
  const doorAt = buildHome(b, e);
  const north = e.spec.facing === 'south';
  const edge = north ? WALK_N : WALK_S;
  b.frontage(e.spec, doorAt, north ? edge - 0.6 : edge + 0.6, e.driveX, edge);
}

/** The road, its sidewalks and the dead end. Birch Lane's sidewalk breaks for the junction (maple-hollow.ts). */
function roads(b: MapBuilder): void {
  const { z, end } = OAK;
  const x0 = OAK.birch + RW;
  // Asphalt is visual; the terrain collider is the drivable surface.
  b.boxMinMax(x0, 0, z - RW, end, 0.02, z + RW, 'asphalt', { collide: false });
  b.boxMinMax(x0, 0, WALK_N, end, CURB, z - RW, 'sidewalk');
  b.boxMinMax(x0, 0, z + RW, end, CURB, WALK_S, 'sidewalk');
  // The curb turns across the end of the road.
  b.boxMinMax(end, 0, WALK_N, end + SW, CURB, WALK_S, 'sidewalk');
  // The trail: from the park's back gate across the woods to the north sidewalk, and on into the park.
  b.boxMinMax(OAK.trailX - 1, 0, 36, OAK.trailX + 1, 0.015, WALK_N, 'dirt', { collide: false });

  // The junction: Oak Street stops for Birch Lane.
  b.prop('stopSign', x0 + 0.6, z - RW - 0.6, Math.PI / 2);
  b.prop('streetSign', x0 + 0.6, z + RW + 0.6, Math.PI, { text: 'BIRCH LN|OAK ST' });
  // The dead end.
  b.prop('boardSign', end + 1.3, z, -Math.PI / 2, { text: 'DEAD END|NO OUTLET' });
  b.prop('jerseyBarrier', end - 1.4, z - 2.1, Math.PI / 2 + 0.06);
  b.prop('jerseyBarrier', end - 1.2, z + 2.0, Math.PI / 2 - 0.1);
  b.prop('cone', end - 2.6, z + 0.2, 0);
}

function streetDressing(b: MapBuilder): void {
  const { z } = OAK;
  // Lights alternate sides, as on Elm; one has died.
  for (const x of [-35, 17]) streetlight(b, x, LIGHT_N, 0);
  streetlight(b, 64, LIGHT_N, 0, 'dead');
  for (const x of [-4, 45, 82]) streetlight(b, x, LIGHT_S, Math.PI);
  // Birch Lane gets one past the junction.
  streetlight(b, OAK.birch + RW + 0.55, 118, -Math.PI / 2);

  // Utility line along the south side (its own wire run).
  for (const x of [-56, -30, -2, 24, 44, 68, 90]) b.prop('utilityPole', x, WALK_S + 0.9, 0, { variant: 3 });

  for (const [x, hz] of [[-27, z - RW - 0.6], [31, z + RW + 0.6], [58, z - RW - 0.6]] as const) b.prop('hydrant', x, hz, 0);

  // Parked and abandoned cars.
  b.prop('car', -44, z + 2.8, Math.PI, { variant: 1 });
  b.prop('car', -4, z - 2.9, 0.03, { variant: 3, drive: true });
  b.prop('wreckedCar', 21, z + 0.6, 0.35, { variant: 8 });
  b.prop('car', 40, z + 2.9, Math.PI + 0.04, { variant: 5 });
  b.prop('wreckedCar', 72, z - 1.6, -0.5, { variant: 12 });
  // Two left in their driveways.
  b.prop('car', 37.6, FRONT_N + 3.4, Math.PI / 2 + 0.02, { variant: 2, drive: true });
  b.prop('car', 18.6, FRONT_S - 3.5, -Math.PI / 2 + 0.03, { variant: 4 });

  // Litter, puddles and leaves.
  const bags: [number, number][] = [[-50, z - 5.2], [-12, z + 5.3], [8, z - 4.1], [33, z + 4.4], [55, z - 5.4], [76, z + 4.9], [OAK.birch + 3.6, z + 14]];
  bags.forEach(([x, bz], i) => b.prop('trashBag', x, bz, i * 1.7 + 0.4, { variant: i + 2, movable: true }));
  const puddles: [number, number, number][] = [[-36, z + 1.4, 2.0], [6, z - 2.4, 1.6], [28, z + 2.0, 2.4], [62, z - 1.2, 1.8], [86, z + 0.6, 2.1], [OAK.birch, z + 13, 2.0]];
  puddles.forEach(([x, pz, r], i) => b.prop('puddle', x, pz, i * 1.1, { length: r, variant: i + 3 }));
  const leaves: [number, number][] = [[-38, z - 8.6], [14, z + 8.8], [44, z - 9.2], [-21, z + 9.0], [70, z + 8.4]];
  leaves.forEach(([x, lz], i) => b.prop('leafPile', x, lz, i * 1.5, { variant: i + 2 }));
}

/** Back fences with gates, lot dividers with gaps, sheds that make tight passages, yard clutter. */
function backyards(b: MapBuilder): void {
  const n = OAK.northFence, s = OAK.southFence;
  const backN = FRONT_N - 0.5, backS = FRONT_S + 0.5;

  // North row, on the shared alley.
  fenceLine(b, n, LOTS_START, OAK.lotsEnd, [-48, -22, 4, 30, 53]);
  divider(b, -35, backN, n, 61);
  divider(b, -9, backN, n, null);
  divider(b, 17, backN, n, 62.5);
  divider(b, 41, backN, n, null);
  divider(b, OAK.lotsEnd, backN, n, 66);
  // South row, on the woods.
  fenceLine(b, s, LOTS_START, OAK.lotsEnd, [-45, -18, 10, 36, 56]);
  divider(b, -31, backS, s, 127);
  divider(b, -4, backS, s, null);
  divider(b, 23, backS, s, 118.5);
  divider(b, 45, backS, s, null);
  divider(b, OAK.lotsEnd, backS, s, 124);

  // Sheds 2.7 m from a divider leave a narrow passage beside them.
  b.prop('shed', -32.3, n + 3.6, 0);
  b.prop('shed', -6.3, n + 3.8, 0, { variant: 1 });
  b.prop('shed', 19.7, n + 3.6, 0);
  b.prop('shed', 38.3, n + 3.9, Math.PI);
  b.prop('shed', -28.3, s - 3.8, Math.PI);
  b.prop('shed', -1.3, s - 3.6, Math.PI, { variant: 1 });
  b.prop('shed', 42.3, s - 3.8, Math.PI);

  // Yard clutter, north row.
  b.prop('trampoline', -54, 61, 0);
  b.prop('bbq', -46.5, 66, 0.3);
  b.prop('patioTable', -43.5, 65.2, 0, { movable: true });
  b.prop('clothesline', -21, 60, 0);
  b.prop('woodpile', -13.5, 66, 0);
  b.prop('doghouse', 8, 62, 0.4);
  b.prop('kiddiePool', -2.5, 61.5, 0, { variant: 1 });
  b.prop('bbq', 25.5, 65.5, -0.3);
  b.prop('trampoline', 31, 58.5, 0);
  b.prop('kiddiePool', 52, 60, 0);
  b.prop('woodpile', 58.5, 64, Math.PI / 2);
  // South row.
  b.prop('woodpile', -55, 128, Math.PI);
  b.prop('doghouse', -42, 126, Math.PI + 0.3);
  b.prop('trampoline', -17, 128, 0);
  b.prop('clothesline', 10, 128, Math.PI / 2);
  b.prop('bbq', 5.5, 122.5, Math.PI);
  b.prop('patioTable', 14, 123, 0.5, { movable: true });
  b.prop('kiddiePool', 34, 127, 0, { variant: 1 });
  b.prop('doghouse', 38.5, 124.5, Math.PI);
  b.prop('patioTable', 57, 124.5, 0.2, { movable: true });
  b.prop('chair', 58.2, 124.2, -Math.PI / 2 - 0.3, { movable: true });

  // The shared alley gets a lamp on the Oak side and a little more junk.
  b.light({ kind: 'point', x: -4, y: 6.0, z: 45.25, color: 0xffb36b, intensity: 18, range: 13, decay: 1.8, fixture: 'none' });
  b.prop('trashBin', 6.8, 50.6, 0.1, { variant: 2, movable: true });
  b.prop('pallet', 47, 50.4, 0.4, { movable: true });
  b.prop('trashBag', 46, 50.8, 2.2, { variant: 1, movable: true });

  b.area('BACKYARDS', LOTS_START, OAK.lotsEnd, n, FRONT_N - 1);
  b.area('BACKYARDS', LOTS_START, OAK.lotsEnd, FRONT_S + 1, s);
}

function frontYards(b: MapBuilder): void {
  const trees: [PropKind, number, number][] = [
    ['tree', -56, FRONT_N + 3], ['pine', -31, FRONT_N + 3.3], ['tree', -6, FRONT_N + 3.1], ['tree', 7.5, FRONT_N + 3.7],
    ['tree', 22, FRONT_N + 3.5], ['pine', 60, FRONT_N + 3], ['tree', -56, FRONT_S - 3], ['pine', -27, FRONT_S - 3.3],
    ['tree', 2, FRONT_S - 2.9], ['tree', 44, FRONT_S - 3.2], ['pine', 61, FRONT_S - 2.7], ['tree', -36.5, FRONT_N - 15],
    ['tree', 17.5, FRONT_S + 20.5], ['pine', 46, FRONT_N - 22.5],
  ];
  trees.forEach(([k, x, z], i) => b.prop(k, x, z, i * 1.9 + 0.5, { variant: i + 5 }));
  const bushes: [number, number][] = [
    [-52.5, FRONT_N + 0.6], [-17.5, FRONT_N + 0.6], [-0.5, FRONT_N + 0.6], [33.5, FRONT_N + 0.6],
    [-40.5, FRONT_S - 0.6], [-21.5, FRONT_S - 0.6], [5.5, FRONT_S - 0.6], [40, FRONT_S - 0.6], [60.5, FRONT_S - 0.6],
  ];
  bushes.forEach(([x, z], i) => b.prop('bush', x, z, i + 0.3, { variant: i + 3 }));
}

/** Builds Oak Street into the map. Call before the woods, which leave its lots, road and trail clear. */
export function oakStreet(b: MapBuilder): void {
  roads(b);
  for (const e of oakHomes()) home(b, e);
  streetDressing(b);
  backyards(b);
  frontYards(b);
  b.area('OAK STREET', LOTS_START - 0.6, OAK.end + SW + 2, FRONT_N - 1, FRONT_S + 1);
}

/** Ground the woods keep clear for Oak Street: its lots, the road out to the dead end, the trail. */
export function oakClear(x: number, z: number): boolean {
  if (x > LOTS_START - 1.5 && x < OAK.lotsEnd + 1.5 && z > OAK.northFence - 3 && z < OAK.southFence + 1.5) return true;
  if (x > OAK.lotsEnd - 2 && x < OAK.end + SW + 3 && Math.abs(z - OAK.z) < RW + SW + 3.5) return true;
  return Math.abs(x - OAK.trailX) < 2.6 && z > 48 && z < OAK.z;
}
