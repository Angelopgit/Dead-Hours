import type { HouseSpec, MapDefinition, PropKind } from '../types/world';
import { MapBuilder, STORY, STREET, door, doorway, seededRandom, storeWin, upWin, win } from './builder';
import { divider, fenceLine, streetlight } from './dressing';
import { buildHome, type HomePlan } from './homes';
import { OAK, oakClear, oakStreet } from './oak-street';

/**
 * Maple Hollow: a 250 x 300 m suburban neighbourhood on the edge of town.
 *
 * Elm Street runs east-west along z = 0 and Birch Lane crosses it north-south at x = -68.
 * The safehouse sits on the north side of Elm, the gas station and the park on the east end,
 * the police checkpoint closes Elm to the west, gravel alleys run behind both rows of
 * backyards, and woods close the map to the north and south. Oak Street, the next street over,
 * tees into Birch Lane 94 m south of Elm and shares Elm's south alley (oak-street.ts).
 *
 * Axes: +X east, +Z south, +Y up.
 */

const HALF = 125;
/** The south edge sits past Oak Street's back fences and a belt of woods. */
const SOUTH = 175;
const RW = STREET.roadHalfWidth;
const SW = STREET.sidewalkWidth;
const CURB = STREET.curbHeight;
const BIRCH = -68;
const LIGHT_OFFSET = RW + 0.55;
const T = STORY.wall;

const WARM_BULB = 0xffa35a;

function roads(b: MapBuilder): void {
  const far = HALF + 30;
  const farSouth = SOUTH + 30;
  // Asphalt is visual; the terrain collider is the drivable surface.
  b.boxMinMax(-far, 0, -RW, far, 0.02, RW, 'asphalt', { collide: false });
  b.boxMinMax(BIRCH - RW, 0, -far, BIRCH + RW, 0.02, -RW, 'asphalt', { collide: false });
  b.boxMinMax(BIRCH - RW, 0, RW, BIRCH + RW, 0.02, farSouth, 'asphalt', { collide: false });
  // Raised sidewalks (the character controller steps the curb).
  for (const [x0, x1] of [[-far, BIRCH - RW], [BIRCH + RW, far]]) {
    b.boxMinMax(x0, 0, -RW - SW, x1, CURB, -RW, 'sidewalk');
    b.boxMinMax(x0, 0, RW, x1, CURB, RW + SW, 'sidewalk');
  }
  for (const [z0, z1] of [[-far, -RW - SW], [RW + SW, farSouth]]) b.boxMinMax(BIRCH - RW - SW, 0, z0, BIRCH - RW, CURB, z1, 'sidewalk');
  // The east side breaks for Oak Street's junction as well as Elm's.
  for (const [z0, z1] of [[-far, -RW - SW], [RW + SW, OAK.z - RW - SW], [OAK.z + RW + SW, farSouth]]) {
    b.boxMinMax(BIRCH + RW, 0, z0, BIRCH + RW + SW, CURB, z1, 'sidewalk');
  }
  // Gravel back alleys behind both rows of backyards.
  b.boxMinMax(BIRCH + RW + SW, 0, -49, 76, 0.03, -45, 'gravel', { collide: false });
  b.boxMinMax(BIRCH + RW + SW, 0, 45, 66, 0.03, 49, 'gravel', { collide: false });

  // Intersection signage.
  b.prop('stopSign', BIRCH + RW + 0.6, -RW - 0.6, Math.PI / 2);
  b.prop('stopSign', BIRCH - RW - 0.6, RW + 0.6, -Math.PI / 2);
  b.prop('streetSign', BIRCH - RW - 0.6, -RW - 0.6, 0, { text: 'ELM ST|BIRCH LN' });
  b.prop('streetSign', BIRCH + RW + 0.6, RW + 0.6, Math.PI, { text: 'BIRCH LN|ELM ST' });
}

function streetDressing(b: MapBuilder): void {
  // Elm Street lights alternate sides; Birch Lane has a few of its own.
  for (const x of [-84, -40, 46, 86]) streetlight(b, x, -LIGHT_OFFSET, 0);
  streetlight(b, 6, -LIGHT_OFFSET, 0, 'flicker');
  for (const x of [-62, -18, 26, 66]) streetlight(b, x, LIGHT_OFFSET, Math.PI);
  streetlight(b, 106, LIGHT_OFFSET, Math.PI, 'dead');
  streetlight(b, BIRCH - LIGHT_OFFSET, -26, Math.PI / 2);
  streetlight(b, BIRCH + LIGHT_OFFSET, 26, -Math.PI / 2);
  streetlight(b, BIRCH + LIGHT_OFFSET, -64, -Math.PI / 2, 'dead');
  streetlight(b, BIRCH - LIGHT_OFFSET, 66, Math.PI / 2);

  // Utility lines: Elm (0), north alley (1), south alley (2).
  for (const x of [-110, -88, -56, -32, -8, 16, 40, 62, 84, 108]) b.prop('utilityPole', x, RW + SW + 0.9, 0, { variant: 0 });
  for (const x of [-56, -30, -4, 22, 48, 70]) b.prop('utilityPole', x, -44.3, Math.PI, { variant: 1, flag: x === -30 });
  for (const x of [-56, -30, -4, 22, 48]) b.prop('utilityPole', x, 44.3, 0, { variant: 2, flag: x === 22 || x === -4 });

  for (const [x, z] of [[-9.5, -5.1], [30.5, 5.1], [-60.4, -5.1], [78, -5.1], [-80, 5.1]] as const) b.prop('hydrant', x, z, 0);

  // Abandoned traffic.
  b.prop('policeCar', -5.5, 1.6, 0.32, { flag: true, drive: true });
  b.prop('wreckedCar', 15.5, -2.1, -0.22, { variant: 2, flag: true });
  b.prop('car', 31.3, -2.9, Math.PI + 0.03, { variant: 1, drive: true });
  b.prop('car', 9.2, 3.0, 0.02, { variant: 4 });
  b.prop('car', 58.5, 2.6, 0.05, { variant: 5 });
  b.prop('wreckedCar', 101, -2.4, Math.PI - 0.4, { variant: 3 });
  b.prop('car', -38, 2.8, Math.PI, { variant: 2, drive: true });
  b.prop('wreckedCar', -77.5, -1.5, 0.9, { variant: 0 });
  b.prop('car', BIRCH + 2.4, -21, -Math.PI / 2 + 0.05, { variant: 3, drive: true });
  b.prop('car', BIRCH - 2.6, 33, Math.PI / 2, { variant: 0 });
  b.prop('wreckedCar', BIRCH + 1.4, 74, -Math.PI / 2 + 0.5, { variant: 1, flag: false });

  // East end: a pile-up closes Elm Street.
  b.prop('wreckedCar', 117, -2.2, 1.25, { variant: 4 });
  b.prop('wreckedCar', 119.5, 1.6, -0.85, { variant: 1 });
  b.prop('wreckedCar', 115.6, 3.6, 0.3, { variant: 12 });
  b.prop('roadblock', 112.5, -0.8, Math.PI / 2 + 0.2);
  b.prop('cone', 111.6, 2.6, 0);
  b.prop('cone', 111.2, -3.1, 0);
  // Birch Lane dead-ends in the woods both ways.
  b.prop('wreckedCar', BIRCH + 0.8, -117, 0.4, { variant: 5 });
  b.prop('wreckedCar', BIRCH - 1.9, -119.8, -1.1, { variant: 11 });
  b.prop('roadblock', BIRCH, -112, 0.1);
  b.prop('roadblock', BIRCH, 114, -0.1);
  b.prop('policeCar', BIRCH + 1.5, 118, Math.PI / 2 - 0.4, { flag: false });

  // Litter, puddles and leaves along the street.
  const bags: [number, number][] = [[-12, -5.2], [3.5, 5.3], [21, -4.0], [-31, 4.3], [-3.2, -3.4], [40, 3.6], [72, 5.4], [-55, -4.6], [94, 4.9], [BIRCH + 3.8, -40]];
  bags.forEach(([x, z], i) => b.prop('trashBag', x, z, i * 2.1, { variant: i, movable: true }));
  const puddles: [number, number, number][] = [[-14, 1.2, 2.2], [4.5, -2.8, 1.6], [24, 2.2, 2.8], [52, -1.5, 1.8], [-46, -2.4, 2.4], [BIRCH, 16, 2.2], [88, -22, 2.4], [-100, 2.5, 2.0], [-26, 3.1, 1.4], [70, 1.0, 1.9]];
  puddles.forEach(([x, z, r], i) => b.prop('puddle', x, z, i * 0.9, { length: r, variant: i }));
  const leaves: [number, number][] = [[-9, -8.6], [12, -8.8], [-27, 8.4], [24, 8.6], [44, -9.4], [-43, 9.2], [80, 11], [100, 16]];
  leaves.forEach(([x, z], i) => b.prop('leafPile', x, z, i * 1.3, { variant: i }));
}

interface HomeEntry extends HomePlan {
  driveX: number | null;
}

/** The family homes on both sides of Elm Street (the safehouse and the Hendersons' are built by hand). */
function homes(): HomeEntry[] {
  const base = { enterable: true, litWindows: 1 } as const;
  return [
    {
      spec: { ...base, id: 'house-nfw', x: -50, z: -19.5, w: 11, d: 10, floors: 1, facing: 'south', siding: 'sidingGreen',
        roofColor: 0x2a2a28, seed: 95, label: 'THE MILLER HOUSE' },
      layout: 'ranch', door: 1, basement: true, cache: true, driveX: -42.3,
    },
    {
      spec: { ...base, id: 'house-nw', x: -28, z: -19.5, w: 12, d: 10, floors: 2, facing: 'south', siding: 'sidingBlue',
        roofColor: 0x22262c, seed: 21, label: 'THE OKAFOR HOUSE' },
      layout: 'twoStorey', door: 1, basement: true, driveX: -19.8,
    },
    {
      spec: { ...base, id: 'house-nfe', x: 52, z: -19.5, w: 11, d: 10, floors: 2, facing: 'south', siding: 'sidingGray',
        roofColor: 0x24272b, seed: 47, label: 'THE BRANDT HOUSE' },
      layout: 'twoStorey', door: 1.2, mirror: true, driveX: 59.7,
    },
    {
      spec: { ...base, id: 'house-sfw', x: -44, z: 19, w: 11, d: 9, floors: 1, facing: 'north', siding: 'stucco',
        roofColor: 0x2a2a28, seed: 89, label: 'THE REYES HOUSE' },
      layout: 'ranch', door: 1, mirror: true, driveX: -36.3,
    },
    {
      spec: { ...base, id: 'house-sw', x: -18, z: 19.5, w: 12, d: 10, floors: 2, facing: 'north', siding: 'sidingGray',
        roofColor: 0x26282c, seed: 58, label: 'THE COLLINS HOUSE' },
      layout: 'twoStorey', door: 0.5, driveX: -9.8,
    },
    {
      spec: { ...base, id: 'house-s', x: 10, z: 19, w: 11, d: 9, floors: 1, facing: 'north', siding: 'brick',
        roofColor: 0x2a2624, seed: 63, label: 'THE NGUYEN HOUSE' },
      layout: 'ranch', door: 1, driveX: 17.7,
    },
    {
      spec: { ...base, id: 'house-se', x: 38, z: 20, w: 12, d: 10, floors: 2, facing: 'north', siding: 'sidingBlue',
        roofColor: 0x202429, seed: 71, label: 'THE HALVORSEN HOUSE' },
      layout: 'twoStorey', door: 0.5, mirror: true, basement: true, cache: true, driveX: 29.8,
    },
    {
      spec: { ...base, id: 'house-w', x: -90, z: -20, w: 12, d: 10, floors: 2, facing: 'south', siding: 'sidingBeige',
        roofColor: 0x27292d, seed: 103, label: 'THE WALSH HOUSE' },
      layout: 'twoStorey', door: 0.8, mirror: true, basement: true, driveX: -81.8,
    },
  ];
}

function home(b: MapBuilder, e: HomeEntry): void {
  const doorAt = buildHome(b, e);
  const south = e.spec.facing === 'south';
  const curbZ = south ? -(RW + SW) - 0.6 : RW + SW + 0.6;
  b.frontage(e.spec, doorAt, curbZ, e.driveX, south ? -(RW + SW) : RW + SW);
}

/** The safehouse: two storeys, a basement and an attached garage. Spawn point for every session. */
function safehouse(b: MapBuilder): void {
  const spec: HouseSpec = {
    id: 'safehouse', x: 0, z: -20, w: 14, d: 10, floors: 2, facing: 'south', siding: 'sidingBeige',
    roofColor: 0x2b2d33, enterable: true, litWindows: 1, seed: 7, label: 'THE SAFEHOUSE',
  };
  const F1 = STORY.slab;
  const F2 = STORY.slab + STORY.ground + STORY.floorThickness;
  const basementFloor = -2.7;
  // The stairwell opens far enough down the flight for a brute to clear the ceiling.
  const stairHoleUp = { x0: -1.3, x1: -0.1, z0: -23.2, z1: -18.6 };
  const stairHoleDown = { x0: -6.75, x1: -5.5, z0: -22.6, z1: -17.4 };

  b.house(
    spec,
    {
      front: [win(-4.6, 1.8), door(2.4), win(5.3, 1.5)],
      back: [win(-4.6, 1.2), door(-2.4, 1.0), win(1.8), win(5.2)],
      west: [win(-0.5, 1.6)],
      east: [door(-2.5, 1.0)],
    },
    {
      front: [upWin(-4.5), upWin(0.4), upWin(4.5)],
      back: [upWin(-4.2), upWin(3)],
      west: [upWin(0)],
      east: [upWin(1.5)],
    },
    {
      partitions: [
        // Ground floor: kitchen/dining (west) and living room (east).
        { storey: 0, axis: 'z', c: -1.4, a0: -5 + T, a1: 5 - T, openings: [doorway(3.3, 1.3)] },
        // Upper floor: west bedroom, bathroom, front bedroom, open landing over the stairs.
        { storey: 1, axis: 'z', c: -1.45, a0: -5 + T, a1: 5 - T, openings: [doorway(-4.0, 1.0)] },
        { storey: 1, axis: 'x', c: 1.5, a0: -1.45, a1: 7 - T, openings: [doorway(1.2, 1.0), doorway(4.5, 1.0)] },
        { storey: 1, axis: 'z', c: 2.0, a0: 1.57, a1: 5 - T, openings: [] },
      ],
      slabHoles: [stairHoleDown],
      ceilingHoles: [[stairHoleUp]],
    },
  );
  b.frontage(spec, 2.4, -(RW + SW) - 0.6, null, -(RW + SW));

  // Stairs up (along -Z) and down to the basement (rising along +Z).
  b.stairs('z', -18.0, -23.2, -1.27, -0.12, F1, F2, 'darkWood', spec.id);
  b.stairs('z', -22.6, -17.4, -6.75, -5.55, basementFloor, F1, 'concrete', spec.id);
  b.prop('railing', -0.06, -20.9, Math.PI / 2, { y: F2, length: 4.6 });
  b.prop('railing', -5.46, -20.0, Math.PI / 2, { y: F1, length: 5.2 });
  b.prop('railing', -6.12, -22.64, 0, { y: F1, length: 1.25 });

  // Basement: dug out under the kitchen, poured concrete.
  b.excavations.push({ x0: -7, x1: -1.4, z0: -25, z1: -15 });
  b.boxMinMax(-7, -3, -25, -1.4, basementFloor, -15, 'concrete');
  b.boxMinMax(-7, basementFloor, -25, -6.75, 0, -15, 'concrete');
  b.boxMinMax(-1.65, basementFloor, -25, -1.4, 0, -15, 'concrete');
  b.boxMinMax(-6.75, basementFloor, -25, -1.65, 0, -24.75, 'concrete');
  b.boxMinMax(-6.75, basementFloor, -15.25, -1.65, 0, -15, 'concrete');

  // Kitchen and dining.
  b.prop('fridge', -6.3, -24.37, 0);
  b.prop('counter', -5.3, -24.42, 0, { length: 1.0 });
  b.prop('stove', -4.42, -24.42, 0);
  b.prop('counter', -3.5, -24.42, 0, { length: 1.1 });
  b.prop('diningTable', -3.6, -20.0, Math.PI / 2, { movable: true });
  b.prop('chair', -4.42, -20.4, Math.PI / 2, { movable: true });
  b.prop('chair', -4.42, -19.5, Math.PI / 2 + 0.2, { movable: true });
  b.prop('chair', -2.78, -20.5, -Math.PI / 2, { movable: true });
  b.prop('chair', -2.6, -18.9, -Math.PI / 2 - 0.9, { movable: true });
  b.prop('crate', -6.25, -15.72, 0.3, { movable: true });
  b.prop('firstAid', -6.68, -23.05, Math.PI / 2, { y: 1.5 });
  b.light({ kind: 'point', x: -3.8, y: 2.85, z: -20.4, color: WARM_BULB, intensity: 8, range: 11, decay: 1.7, fixture: 'bulb' });

  // Living room.
  b.prop('rug', 3.9, -19.8, Math.PI / 2, { length: 3.0 });
  b.prop('sofa', 2.25, -19.8, Math.PI / 2, { movable: true });
  b.prop('coffeeTable', 3.75, -19.8, Math.PI / 2, { movable: true });
  b.prop('tvStand', 6.47, -19.8, -Math.PI / 2);
  b.prop('armchair', 4.1, -23.7, -0.5, { movable: true });
  b.prop('floorLamp', 0.55, -24.2, 0);
  b.prop('bookshelf', 6.55, -16.9, -Math.PI / 2, { movable: true });
  b.light({ kind: 'point', x: 3.2, y: 2.85, z: -20, color: WARM_BULB, intensity: 10, range: 11, decay: 1.7, fixture: 'bulb' });
  // Porch light.
  b.light({ kind: 'point', x: 2.4, y: 2.75, z: -14.3, color: 0xffb070, intensity: 6, range: 9, decay: 1.8, fixture: 'none' });

  // Upper floor.
  b.prop('bed', -4.6, -16.6, 0, { y: F2 });
  b.prop('wardrobe', -6.42, -21.6, Math.PI / 2, { y: F2 });
  b.prop('dresser', -3.2, -24.48, 0, { y: F2 });
  b.prop('bed', 5.9, -17.1, Math.PI / 2, { y: F2, variant: 1 });
  b.prop('desk', 3.0, -15.6, Math.PI, { y: F2 });
  b.prop('chair', 3.0, -16.3, Math.PI + 0.3, { y: F2, movable: true });
  b.prop('mattress', 4.3, -23.4, 0.08, { y: F2, movable: true });
  b.prop('ammoCrate', 6.1, -24.2, 0.1, { y: F2 });
  b.prop('crate', 1.6, -24.25, 0, { y: F2, movable: true });
  b.light({ kind: 'point', x: 3.2, y: F2 + 2.35, z: -22.0, color: WARM_BULB, intensity: 6.5, range: 9, decay: 1.7, fixture: 'bulb' });
  b.light({ kind: 'point', x: -4.2, y: F2 + 2.35, z: -20.0, color: 0xffb580, intensity: 4.5, range: 8, decay: 1.7, fixture: 'bulb' });

  // Basement: ammunition storage and a last-resort bunk.
  b.prop('metalShelf', -2.15, -21.5, -Math.PI / 2, { y: basementFloor, variant: 1 });
  b.prop('metalShelf', -2.15, -19.9, -Math.PI / 2, { y: basementFloor, variant: 1 });
  b.prop('ammoCrate', -3.0, -24.2, 0, { y: basementFloor });
  b.prop('ammoCrate', -3.0, -24.2, 0.05, { y: basementFloor + 0.45 });
  b.prop('ammoCrate', -4.0, -24.25, -0.1, { y: basementFloor });
  b.prop('crate', -2.4, -16.0, 0.2, { y: basementFloor, movable: true });
  b.prop('washer', -6.3, -15.8, 0, { y: basementFloor });
  b.prop('waterHeater', -6.3, -24.25, 0, { y: basementFloor });
  b.prop('mattress', -4.2, -16.6, Math.PI / 2 + 0.1, { y: basementFloor, movable: true });
  b.light({ kind: 'point', x: -4.0, y: -0.45, z: -20.5, color: 0xffb070, intensity: 8, range: 8, decay: 1.7, fixture: 'bulb' });

  // Garage: weapon preparation.
  const garage: HouseSpec = {
    id: 'garage', x: 10, z: -19.75, w: 6, d: 9.5, floors: 1, facing: 'south', siding: 'sidingBeige',
    roofColor: 0x2b2d33, enterable: true, litWindows: 1, seed: 8, slab: 0.22, groundHeight: 2.9,
    roof: 'gable-z', skipWalls: ['west'], interior: 'concrete', floorMat: 'concrete', label: 'THE SAFEHOUSE',
  };
  b.house(garage, { front: [door(0, 3.2, 'rollup', 2.5)], back: [], west: [], east: [door(-1.75, 1.0), win(1.8, 1.0)] }, null);
  b.boxMinMax(8.2, 0, -15, 11.8, 0.024, -7, 'concrete', { collide: false });
  b.prop('workbench', 10, -23.86, 0, { use: 'weapons' });
  b.prop('firstAid', 11.75, -24.19, 0, { y: 1.5 });
  b.prop('metalShelf', 12.3, -23.2, -Math.PI / 2);
  b.prop('metalShelf', 7.48, -17.6, Math.PI / 2);
  b.prop('ammoCrate', 9.0, -22.7, 0.15);
  b.prop('ammoCrate', 9.95, -22.65, -0.1);
  b.prop('oilDrum', 12.2, -15.9, 0, { movable: true });
  b.prop('tireStack', 12.15, -19.2, 0);
  b.prop('car', 10.1, -11.2, Math.PI / 2 + 0.03, { variant: 4 });
  b.light({ kind: 'point', x: 10, y: 2.75, z: -20.5, color: 0xffc58a, intensity: 9.5, range: 9, decay: 1.7, fixture: 'bulb' });

  // Back patio.
  b.boxMinMax(-6.5, 0, -28.5, 1.5, 0.03, -25, 'concrete', { collide: false });
  b.prop('bbq', -5.2, -27.4, 0.4);
  b.prop('patioTable', -1.6, -27.2, 0, { movable: true });
  b.prop('chair', -2.5, -27.0, Math.PI / 2, { movable: true });
  b.prop('chair', -0.8, -27.6, -Math.PI / 2 - 0.4, { movable: true });
  b.light({ kind: 'point', x: -2.4, y: 2.75, z: -25.7, color: 0xffb070, intensity: 4.5, range: 8, decay: 1.8, fixture: 'none' });

  b.area('BASEMENT', -7, -1.4, -25, -15, -3.2, -0.1);
  b.area('THE SAFEHOUSE', -7, 13, -25, -15, -0.1, 8);
}

/** The single-storey neighbour east of the safehouse, left open in a hurry. */
function houseNe(b: MapBuilder): void {
  const spec: HouseSpec = {
    id: 'house-ne', x: 27, z: -18.5, w: 12, d: 9, floors: 1, facing: 'south', siding: 'sidingGreen',
    roofColor: 0x2e2a27, enterable: true, litWindows: 0.5, seed: 33, label: 'THE HENDERSON HOUSE',
  };
  b.house(
    spec,
    { front: [win(-3.2), door(0.6), win(3.6)], back: [door(-3.4, 1.1), win(2.5)], west: [win(0)], east: [win(0.5)] },
    null,
    { partitions: [{ storey: 0, axis: 'x', c: -0.6, a0: -6 + T, a1: 0, openings: [doorway(-2.6, 1.3)] }] },
  );
  b.frontage(spec, 0.6, -(RW + SW) - 0.6, 35.2, -(RW + SW));
  b.prop('sofa', 30.4, -15.8, Math.PI, { movable: true });
  b.prop('coffeeTable', 30.3, -17.3, 0.3, { movable: true });
  b.prop('armchair', 31.9, -19.6, -Math.PI / 2 - 0.9, { movable: true });
  b.prop('tvStand', 31.4, -22.5, 0.05);
  b.prop('bed', 22.3, -21.45, Math.PI / 2, { variant: 1 });
  b.prop('dresser', 21.62, -17.5, Math.PI / 2, { movable: true });
  b.prop('counter', 26.0, -22.42, 0, { length: 1.6 });
  b.prop('chair', 25.0, -17.0, 1.9, { movable: true });
  b.prop('crate', 22.4, -16.0, 0.6, { movable: true });
  b.prop('firstAid', 24.4, -22.69, 0, { y: 1.5 });
  b.light({ kind: 'point', x: 28.5, y: 2.85, z: -18.0, color: WARM_BULB, intensity: 6.5, range: 11, decay: 1.7, fixture: 'bulb' });
  b.area('THE HENDERSON HOUSE', 21, 33, -23, -14, -0.1, 6);
}

function gasStation(b: MapBuilder): void {
  // Forecourt and canopy.
  b.boxMinMax(72, 0, -33, 110, 0.02, -7, 'concrete', { collide: false });
  b.boxMinMax(81, 5.2, -22, 101, 5.6, -12, 'roofFlat');
  for (const [x, z] of [[83, -14], [99, -14], [83, -20], [99, -20]]) b.boxMinMax(x - 0.25, 0, z - 0.25, x + 0.25, 5.2, z + 0.25, 'metal');
  for (const ix of [86, 96]) {
    b.boxMinMax(ix - 0.6, 0, -20.5, ix + 0.6, 0.2, -13.5, 'curb');
    b.prop('pump', ix, -15.6, Math.PI / 2);
    b.prop('pump', ix, -18.4, Math.PI / 2);
  }
  for (const [x, z] of [[86, -14.6], [86, -19.4], [96, -14.6], [96, -19.4]]) {
    b.light({ kind: 'spot', x, y: 5.12, z, tx: x, ty: 0, tz: z, color: 0xe6eeff, intensity: 420, range: 16, angle: 1.15, penumbra: 0.55, decay: 2, fixture: 'panel' });
  }
  b.prop('signPylon', 77.5, -9.6, 0, { text: 'FUEL' });
  b.prop('car', 88.7, -16.9, Math.PI / 2 + 0.03, { variant: 0, drive: true });
  b.prop('wreckedCar', 104.5, -26.5, 0.7, { variant: 5 });
  b.prop('iceChest', 89.5, -32.2, 0);
  b.prop('tireStack', 82.0, -32.0, 0);
  b.prop('tireStack', 81.2, -31.4, 0.4);

  // Convenience store.
  const store: HouseSpec = {
    id: 'store', x: 92, z: -38, w: 18, d: 10, floors: 1, facing: 'south', siding: 'brick',
    roofColor: 0x2a2b2e, enterable: true, litWindows: 1, seed: 115, slab: 0.2, groundHeight: 3.6,
    roof: 'flat', interior: 'interiorWall', floorMat: 'tile', label: 'QUIK-STOP',
  };
  b.house(
    store,
    {
      front: [storeWin(-5.5, 4.6), door(0, 1.8, 'glass', 2.4), storeWin(5.5, 4.6)],
      back: [door(6, 1.0)],
      west: [win(-2, 1.2, 1.1, 2.4)],
      east: [door(2.0, 1.0)],
    },
    null,
  );
  b.prop('storeCounter', 86.0, -35.6, 0);
  b.prop('storeShelf', 90.0, -38.6, Math.PI / 2, { length: 4.5 });
  b.prop('storeShelf', 94.0, -38.6, Math.PI / 2, { length: 4.5 });
  b.prop('storeShelf', 98.0, -38.6, Math.PI / 2, { length: 4.5, variant: 1 });
  for (const x of [85.6, 87.7, 89.8]) b.prop('cooler', x, -42.33, 0);
  b.prop('crate', 99.6, -41.8, 0.2, { movable: true });
  b.prop('firstAid', 95.6, -42.69, 0, { y: 1.5 });
  b.prop('trashBag', 93.2, -35.2, 1, { variant: 3, movable: true });
  b.prop('ceilingLamp', 92, -38, 0, { y: 3.8 });
  // The east tube is failing: it flickers (realtime, not baked).
  for (const x of [87, 97]) b.light({ kind: 'point', x, y: 3.72, z: -38, color: 0xdfe8ff, intensity: 55, range: 10, decay: 2, fixture: 'panel', flicker: x === 97 });
  // Behind the store.
  b.prop('dumpster', 103.6, -41, Math.PI / 2);
  b.prop('dumpster', 103.6, -37.9, Math.PI / 2 + 0.05, { variant: 1 });
  b.prop('oilDrum', 102.2, -44.2, 0, { movable: true });
  b.prop('oilDrum', 101.5, -44.6, 0.5, { movable: true, variant: 1 });
  b.prop('pallet', 99.5, -44.4, 0.3, { movable: true });
  b.light({ kind: 'point', x: 98, y: 2.9, z: -43.6, color: 0xffb36b, intensity: 6, range: 10, decay: 1.8, fixture: 'bulb' });

  b.area('GAS STATION', 72, 112, -46, -7);
}

function park(b: MapBuilder): void {
  // Paths and playground surface.
  b.boxMinMax(87, 0, 8.6, 89, 0.015, 36, 'dirt', { collide: false });
  b.boxMinMax(70, 0, 34, 108, 0.015, 36, 'dirt', { collide: false });
  b.boxMinMax(99, 0, 36, 101, 0.015, 40, 'dirt', { collide: false });
  b.boxMinMax(71, 0, 14, 85, 0.018, 33, 'gravel', { collide: false });

  b.prop('swingSet', 78, 17.5, 0);
  b.prop('slide', 74.2, 25, Math.PI / 2);
  b.prop('merryGoRound', 81.8, 26, 0);
  b.prop('sandbox', 78.5, 30.4, 0);
  b.prop('gazebo', 100, 42, 0);
  for (const [x, z, r] of [[85.6, 20, Math.PI / 2], [90.4, 20, -Math.PI / 2], [85.6, 27, Math.PI / 2], [94, 33.2, 0], [104, 37.2, Math.PI], [76, 33.2, 0]] as const) {
    b.prop('bench', x, z, r);
  }
  b.prop('picnicTable', 100, 20, 0.2, { movable: true });
  b.prop('picnicTable', 106, 28, -0.5, { movable: true });
  b.prop('picnicTable', 95.5, 15.5, 1.4, { movable: true });
  b.prop('trashBin', 90.6, 33.6, 0, { variant: 2, movable: true });
  for (const [x, z] of [[89.4, 12], [89.4, 30], [96, 36.6], [79, 22.5]]) {
    b.prop('parkLamp', x, z, 0);
    b.light({ kind: 'point', x, y: 3.85, z, color: 0xd8e4ff, intensity: 70, range: 14, decay: 2, fixture: 'none' });
  }
  const trees: [number, number][] = [[70, 12], [108, 13], [72, 44], [110, 47], [94, 50], [84, 42], [106, 22], [70, 38], [92, 25], [110, 34], [80, 49]];
  trees.forEach(([x, z], i) => b.prop(i % 3 === 2 ? 'pine' : 'tree', x, z, i * 1.9, { variant: i + 3 }));
  for (const [x, z] of [[67.5, 20], [67.5, 31], [111, 40], [86, 47]]) b.prop('bush', x, z, x, { variant: Math.round(z) });

  // Iron fence with an entrance off Elm Street and a back gate to the woods.
  b.prop('ironFence', 76, 8.6, 0, { length: 20 });
  b.prop('ironFence', 101, 8.6, 0, { length: 22 });
  b.prop('ironFence', 66, 25.3, Math.PI / 2, { length: 33.4 });
  b.prop('ironFence', 112, 30.3, Math.PI / 2, { length: 43.4 });
  b.prop('ironFence', 76, 52, 0, { length: 20 });
  b.prop('ironFence', 102, 52, 0, { length: 20 });
  b.prop('boardSign', 92.4, 9.6, Math.PI, { text: 'MAPLE HOLLOW PARK', variant: 1 });

  b.area('MAPLE HOLLOW PARK', 66, 112, 8, 52);
}

function checkpoint(b: MapBuilder): void {
  // Jersey-barrier chicane across Elm Street.
  for (const z of [-3.0, 0.0]) b.prop('jerseyBarrier', -98, z, Math.PI / 2);
  for (const z of [0.0, 3.0]) b.prop('jerseyBarrier', -104, z, Math.PI / 2);
  b.prop('jerseyBarrier', -110.5, -2.6, Math.PI / 2 + 0.08);
  for (const z of [-5.8, 5.8]) b.prop('sandbags', -98, z, Math.PI / 2, { length: 2.6 });
  b.prop('sandbags', -98, 9.5, Math.PI / 2 + 0.2, { length: 3.2 });
  b.prop('sandbags', -104, -9.3, Math.PI / 2, { length: 3.4 });
  b.prop('sandbags', -94.6, -9.2, 0.1, { length: 2.4 });

  b.prop('policeCar', -92.6, -2.9, Math.PI / 2 - 0.35, { flag: true, drive: true });
  b.prop('policeCar', -107.5, 3.9, Math.PI / 2 - 0.2, { flag: false });
  b.prop('armoredTruck', -113.5, 1.4, 0.04, { drive: true });
  b.prop('wreckedCar', -117.8, -4.6, 0.6, { variant: 10 });
  for (const [x, z] of [[-89.6, 0.2], [-89.8, 1.9], [-89.6, 3.6], [-101.6, 3.4], [-101, -3.8], [-109, 1.2]]) b.prop('cone', x, z, x);

  // Floodlight tower aimed down the street.
  b.prop('floodlight', -102, -9.0, 0);
  b.light({ kind: 'spot', x: -102.6, y: 7.4, z: -8.6, tx: -97, ty: 0, tz: 1.5, color: 0xe8f0ff, intensity: 950, range: 42, angle: 0.55, penumbra: 0.45, decay: 2, fixture: 'none' });
  b.light({ kind: 'spot', x: -101.4, y: 7.4, z: -8.6, tx: -108, ty: 0, tz: 3, color: 0xe8f0ff, intensity: 950, range: 42, angle: 0.55, penumbra: 0.45, decay: 2, fixture: 'none' });

  // Staging area on the south verge.
  b.prop('tent', -101, 16.5, Math.PI);
  b.prop('crate', -99.5, 15.8, 0.1, { movable: true });
  b.prop('crate', -102.3, 15.4, -0.2, { movable: true });
  b.prop('ammoCrate', -101.2, 14.6, 0.05);
  b.prop('firstAid', -99.5, 15.8, 0.1, { y: 0.74 });
  b.prop('mattress', -102.6, 17.6, 0, { movable: true });
  b.prop('pallet', -96.5, 12.5, 0.2, { movable: true });
  b.prop('crate', -96.4, 12.4, 0.25, { y: 0.15, movable: true });
  b.light({ kind: 'point', x: -101, y: 2.1, z: 16.6, color: 0xffc07a, intensity: 3.5, range: 7, decay: 1.8, fixture: 'bulb' });
  b.prop('boardSign', -91.5, -8.75, Math.PI / 2, { text: 'ROAD CLOSED|QUARANTINE CHECKPOINT' });
  b.prop('boardSign', -91.5, 9.2, Math.PI / 2 - 0.15, { text: 'NO ENTRY|BY ORDER OF THE STATE', variant: 1 });

  b.area('POLICE CHECKPOINT', -125, -86, -13, 24);
}

/** Back fences with gates to the alley, lot dividers with gaps, sheds that make tight passages. */
function backyards(b: MapBuilder): void {
  const westEdge = BIRCH + RW + SW + 0.6;

  // North row.
  fenceLine(b, -42, westEdge, 64, [-50, -28, -2, 26, 52]);
  divider(b, -40, -15, -42, -33);
  divider(b, -14.5, -15, -42, null);
  divider(b, 17, -15, -42, -34.5);
  divider(b, 40, -15, -42, null);
  divider(b, 64, -9, -42, -30);
  // South row.
  fenceLine(b, 42, westEdge, 64, [-44, -18, 10, 38, 55]);
  divider(b, -31, 15, 42, 33);
  divider(b, -4, 15, 42, null);
  divider(b, 24, 15, 42, 30.5);
  divider(b, 47, 15, 42, null);

  // Sheds placed ~1.1 m off a fence leave narrow passages between yards and the alley.
  b.prop('shed', -37.3, -38.4, 0);
  b.prop('shed', -11.85, -37.8, 0, { variant: 1 });
  b.prop('shed', 19.7, -38.2, 0);
  b.prop('shed', 37.3, -37.9, Math.PI);
  b.prop('shed', -33.7, 38.2, Math.PI);
  b.prop('shed', -1.35, 38.4, Math.PI, { variant: 1 });
  b.prop('shed', 44.3, 38.2, Math.PI);

  // Yard clutter.
  b.prop('trampoline', -52, -33, 0);
  b.prop('clothesline', 3.5, -34, 0);
  b.prop('woodpile', 6.4, -27.4, 0);
  b.prop('doghouse', 29.5, -29.5, 0.4);
  b.prop('kiddiePool', 48, -31, 0);
  b.prop('bbq', -26.5, -27.5, -0.3);
  b.prop('patioTable', -21.5, -28.5, 0, { movable: true });
  b.prop('clothesline', -18, 31, Math.PI / 2);
  b.prop('trampoline', 10, 32, 0);
  b.prop('woodpile', -46, 27, Math.PI);
  b.prop('doghouse', 34, 30.5, Math.PI + 0.3);
  b.prop('bbq', 40, 27.5, Math.PI);
  b.prop('kiddiePool', -24, 29, 0, { variant: 1 });
  b.prop('patioTable', 13.5, 26.6, 0.5, { movable: true });
  b.prop('wreckedCar', 55.5, 28, 1.4, { variant: 11 });

  // Alley dressing.
  b.prop('dumpster', -20, -46.2, 0);
  b.prop('dumpster', 31, 46.3, Math.PI, { variant: 1 });
  b.prop('trashBin', 4, -45.6, 0.2, { variant: 1, movable: true });
  b.prop('trashBin', -47, 45.6, 0, { movable: true });
  for (const [x, z] of [[-19, -44.8], [-21.6, -47.4], [32.4, 47.6], [12, -46.2], [-6, 46.6]] as const) b.prop('trashBag', x, z, x, { variant: Math.abs(Math.round(x)) % 5, movable: true });
  b.prop('wreckedCar', 42, -47, Math.PI + 0.1, { variant: 2 });
  b.prop('pallet', -33, 46.2, 0.3, { movable: true });
  // Two alley poles carry a lamp.
  b.light({ kind: 'point', x: -30, y: 6.0, z: -45.25, color: 0xffb36b, intensity: 22, range: 14, decay: 1.8, fixture: 'none' });
  b.light({ kind: 'point', x: 22, y: 6.0, z: 45.25, color: 0xffb36b, intensity: 18, range: 13, decay: 1.8, fixture: 'none' });

  b.area('BACK ALLEY', BIRCH + RW, 76, -50, -44);
  b.area('BACK ALLEY', BIRCH + RW, 66, 44, 50);
  b.area('BACKYARDS', BIRCH + RW, 66, -44, -25);
  b.area('BACKYARDS', BIRCH + RW, 66, 25, 44);
}

function frontYards(b: MapBuilder): void {
  const trees: [PropKind, number, number][] = [
    ['tree', -10, -11.5], ['pine', -36, -11], ['tree', 37, -11.5], ['tree', -27, 11], ['pine', -7, 12.5],
    ['tree', 24.5, 11.5], ['pine', 47, 11.5], ['tree', 44, -11], ['pine', -52, 11.5], ['pine', -8, -28.5],
    ['tree', 62, -10], ['tree', -58, 10], ['tree', -56, -11], ['pine', 54, 12], ['tree', -84, 11],
    ['pine', -82, -11.5], ['tree', -99, -12.5], ['tree', 57, 30], ['pine', 60, 38], ['tree', -58, -30],
    ['tree', -58, 30], ['pine', 15.5, -30], ['tree', -45, -35], ['tree', 28, 36],
  ];
  trees.forEach(([k, x, z], i) => b.prop(k, x, z, i * 1.7, { variant: i }));
  const bushes: [number, number][] = [
    [-6.5, -14.2], [6.2, -14.6], [-21.5, -14.1], [21, -13.6], [-23, 14.1], [4.6, 14.1], [32, 14.6], [-38.5, 14.1],
    [-45.5, -14.0], [46, -14.1], [-84, -14.2], [-12.5, 14.0],
  ];
  bushes.forEach(([x, z], i) => b.prop('bush', x, z, i, { variant: i }));
}

/**
 * Instanced woodland closing the map, with trunk colliders. Leaves the road corridors and Oak
 * Street (its lots, road and trail) clear.
 */
function woods(b: MapBuilder): void {
  const spacing = 5.2;
  const inRoad = (x: number, z: number) => Math.abs(x - BIRCH) < RW + SW + 2 || Math.abs(z) < RW + SW + 3;
  const grow = (r: () => number, x: number, z: number) => {
    const jx = x + (r() - 0.5) * spacing * 0.9;
    const jz = z + (r() - 0.5) * spacing * 0.9;
    const north = jz < -53;
    const south = jz > 54;
    const eastEdge = jx > 115 && Math.abs(jz) > 9;
    const westEdge = jx < -119 && Math.abs(jz) > 9;
    if (!(north || south || eastEdge || westEdge)) return;
    if (inRoad(jx, jz)) return;
    if (r() < 0.12) return; // clearings
    const rot = r() * Math.PI * 2, variant = Math.floor(r() * 6);
    // Drawn whether or not the tree stands, so the woods elsewhere keep their old layout.
    if (oakClear(jx, jz)) return;
    b.prop('pine', jx, jz, rot, { variant, forest: true });
  };
  // The original square, then the belt past Oak Street on the same grid with its own stream.
  const r = seededRandom(4242);
  let z = -HALF + 2;
  for (let x = -HALF + 2; x < HALF - 1; x += spacing) {
    for (z = -HALF + 2; z < HALF - 1; z += spacing) grow(r, x, z);
  }
  const belt = seededRandom(4243);
  for (let x = -HALF + 2; x < HALF - 1; x += spacing) {
    for (let zz = z; zz < SOUTH - 1; zz += spacing) grow(belt, x, zz);
  }
  b.area('THE WOODS', -HALF, HALF, -HALF, -52);
  b.area('THE WOODS', -HALF, HALF, 52, SOUTH);
}

function build(): MapDefinition {
  const b = new MapBuilder();
  roads(b);
  safehouse(b);
  houseNe(b);
  for (const e of homes()) home(b, e);
  streetDressing(b);
  gasStation(b);
  park(b);
  checkpoint(b);
  backyards(b);
  frontYards(b);
  oakStreet(b);
  woods(b);
  b.area('BIRCH LANE', BIRCH - RW - SW, BIRCH + RW + SW, -HALF, SOUTH);
  b.area('ELM STREET', -HALF, HALF, -16, 16);
  b.area('MAPLE HOLLOW', -HALF, HALF, -HALF, SOUTH);

  return b.finish('Maple Hollow', { x0: -HALF, x1: HALF, z0: -HALF, z1: SOUTH }, [
    { x: 4.8, y: 0.35, z: -22.3, yaw: Math.PI },
    { x: 3.0, y: 0.35, z: -17.0, yaw: Math.PI },
    { x: 5.1, y: 0.35, z: -17.3, yaw: Math.PI },
    { x: 0.8, y: 0.35, z: -16.4, yaw: Math.PI },
  ]);
}

export const MAPLE_HOLLOW: MapDefinition = build();
