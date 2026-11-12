import type { HouseSpec } from '../types/world';
import { MapBuilder, STORY, STREET, door, win } from './builder';
import { Frame } from './homes';

/**
 * Camp Tolliver: the Ohio National Guard's forward post for the Vesper quarantine, dug into the
 * woods west of Pell Lane across from Court Street. Concrete T-walls all the way round, one gate
 * on the lane with a guard tower over it, and a stretch of the south wall the dead brought down
 * (the quiet way in, from the checkpoint). Inside: the barracks, the armory with what the Guard
 * left on its racks, and the motor pool with two Humvees that still run.
 *
 * Axes as everywhere: +X east, +Z south.
 */
export const BASE = {
  name: 'CAMP TOLLIVER',
  x0: -121, x1: -80, z0: -118, z1: -62,
  /** The gate: an opening in the east wall, centred on Court Street's line. */
  gate: { z: -86, half: 4 },
  /** The breach in the south wall. */
  breach: { x0: -99.5, x1: -94.5 },
  /** The guard tower's deck: its centre, half its size and its height. */
  tower: { x: -83.2, z: -79.5, half: 2.2, deck: 4.0 },
  /** The slab a Humvee is parked on. */
  pool: { x0: -119.5, x1: -100.5, z0: -80.5, z1: -64 },
} as const;

const RW = STREET.roadHalfWidth;
const SW = STREET.sidewalkWidth;
const PELL = -68;
const FLOOR = 0.2;
const CEILING = 3.2;
const TUBE = 0xdfe8ff;
const FLOOD = 0xe8f0ff;

/** Ground the woods leave clear: the camp and a strip around its walls, its road and the path to the breach. */
export function baseClear(x: number, z: number): boolean {
  if (x < BASE.x1 + 2.5 && z > BASE.z0 - 3 && z < BASE.z1 + 2.5) return true;
  if (x >= BASE.x1 && x < PELL && Math.abs(z - BASE.gate.z) < BASE.gate.half + 2.5) return true;
  return x > BASE.breach.x0 - 1 && x < BASE.breach.x1 + 1 && z >= BASE.z1 && z < -50;
}

/** Where Pell Lane's west sidewalk breaks for the camp's road. */
export const BASE_ROAD = { z0: BASE.gate.z - 3.5, z1: BASE.gate.z + 3.5 } as const;

/** A run of T-wall along X or Z, in sections of about six metres. */
function wall(b: MapBuilder, axis: 'x' | 'z', c: number, from: number, to: number): void {
  const len = to - from;
  const n = Math.max(1, Math.round(len / 6));
  const each = len / n;
  for (let i = 0; i < n; i++) {
    const mid = from + each * (i + 0.5);
    if (axis === 'x') b.prop('tWall', mid, c, 0, { length: each, variant: i });
    else b.prop('tWall', c, mid, Math.PI / 2, { length: each, variant: i });
  }
}

function perimeter(b: MapBuilder): void {
  const { x0, x1, z0, z1, gate, breach } = BASE;
  wall(b, 'x', z0, x0, x1);
  wall(b, 'z', x0, z0, z1);
  wall(b, 'z', x1, z0, gate.z - gate.half);
  wall(b, 'z', x1, gate.z + gate.half, z1);
  wall(b, 'x', z1, x0, breach.x0);
  wall(b, 'x', z1, breach.x1, x1);
  // What is left of the stretch that fell: a section on its face, and the dirt worn through it.
  b.prop('jerseyBarrier', breach.x0 + 1.2, z1 + 1.6, 0.5);
  b.prop('sandbags', breach.x1 - 0.9, z1 - 1.5, 1.1, { length: 2.4 });
  b.boxMinMax(breach.x0 + 0.4, 0, z1 - 2, breach.x1 - 0.4, 0.035, -52, 'dirt', { collide: false });
}

function ground(b: MapBuilder): void {
  const { x0, x1, z0, z1, gate, pool } = BASE;
  b.boxMinMax(x0, 0, z0, x1, 0.025, z1, 'gravel', { collide: false });
  // The road in from Pell Lane, and the drive it becomes.
  b.boxMinMax(x0 + 12, 0, gate.z - 3.5, PELL - RW, 0.04, gate.z + 3.5, 'asphalt', { collide: false });
  b.boxMinMax(pool.x0, 0, pool.z0, pool.x1, 0.045, pool.z1, 'concrete', { collide: false });
  // Parade square in front of the barracks.
  b.boxMinMax(-110, 0, -102.5, -90, 0.04, -91, 'concrete', { collide: false });
}

function gate(b: MapBuilder): void {
  const { x1, gate: g } = BASE;
  const z = g.z;
  // The barrier stands open: whoever left last did not stop to lower it.
  b.prop('gateArm', x1 + 0.9, z + g.half - 0.5, Math.PI / 2);
  // Blast baskets either side of the road outside, a staggered pair of barriers inside.
  for (const s of [-1, 1]) {
    b.prop('hesco', x1 + 2.5, z + s * (g.half + 1.0), 0, { length: 4.0 });
  }
  b.prop('hesco', x1 - 2.2, z - g.half - 1.0, 0, { length: 3.3, variant: 1 });
  b.prop('jerseyBarrier', x1 - 6.5, z - 2.5, Math.PI / 2);
  b.prop('jerseyBarrier', x1 - 11.5, z + 2.5, Math.PI / 2);
  b.prop('sandbags', x1 - 15.5, z - 4.6, 0, { length: 3.2 });
  b.prop('boardSign', x1 + 5.4, z - g.half - 2.6, Math.PI / 2, { text: 'CAMP TOLLIVER|OHIO NATIONAL GUARD' });
  b.prop('boardSign', x1 + 5.4, z + g.half + 2.6, Math.PI / 2, { text: 'RESTRICTED AREA|DEADLY FORCE AUTHORIZED', variant: 1 });
  b.prop('cone', x1 + 2.2, z - 2.9, 0.4);
  b.prop('cone', x1 + 2.6, z + 3.0, 1.2);
}

/** The guard tower: a concrete deck on four legs over the gate, stairs up along the wall, a roof on posts. */
function tower(b: MapBuilder): void {
  const { x, z, half, deck } = BASE.tower;
  const x0 = x - half, x1 = x + half, z0 = z - half, z1 = z + half;
  const leg = 0.36;
  for (const [lx, lz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
    b.boxMinMax(lx - (lx === x0 ? 0 : leg), 0, lz - (lz === z0 ? 0 : leg), lx + (lx === x0 ? leg : 0), deck - 0.22, lz + (lz === z0 ? leg : 0), 'concrete');
  }
  b.boxMinMax(x0, deck - 0.22, z0, x1, deck, z1, 'concrete');
  // Stairs up from the south, against the perimeter wall.
  const sx0 = x1 - 1.35, sx1 = x1 - 0.1;
  b.stairs('z', z1 + 6.6, z1, sx0, sx1, 0, deck, 'concrete');
  // Parapet (the gap is the head of the stairs).
  const top = deck + 1.05, t = 0.16;
  b.boxMinMax(x0, deck, z0, x1, top, z0 + t, 'concrete');
  b.boxMinMax(x0, deck, z0, x0 + t, top, z1, 'concrete');
  b.boxMinMax(x1 - t, deck, z0, x1, top, z1, 'concrete');
  b.boxMinMax(x0, deck, z1 - t, sx0 - 0.05, top, z1, 'concrete');
  // Roof.
  for (const [px, pz] of [[x0 + 0.1, z0 + 0.1], [x1 - 0.1, z0 + 0.1], [x0 + 0.1, z1 - 0.1], [x1 - 0.1, z1 - 0.1]]) {
    b.boxMinMax(px - 0.06, top, pz - 0.06, px + 0.06, deck + 2.35, pz + 0.06, 'metal', { collide: false });
  }
  b.boxMinMax(x0 - 0.3, deck + 2.35, z0 - 0.3, x1 + 0.3, deck + 2.47, z1 + 0.3, 'metal');
  b.prop('sandbags', x + 0.3, z0 + 0.55, 0, { y: deck, length: 2.4 });
  b.prop('ammoCrate', x0 + 0.75, z + 0.4, Math.PI / 2, { y: deck });
  // Its lamp still burns over the gate.
  b.light({ kind: 'spot', x: x1 - 0.2, y: deck + 2.2, z: z0 + 0.3, tx: BASE.x1 + 4, ty: 0, tz: BASE.gate.z, color: FLOOD, intensity: 900, range: 38, angle: 0.6, penumbra: 0.5, decay: 2, fixture: 'none' });
  b.area('GUARD TOWER', x0, x1, z0, z1, deck - 0.3, deck + 3);
}

function tube(k: Frame, u: number, v: number, intensity = 46, flicker = false): void {
  k.b.light({ kind: 'point', x: k.x(u), y: FLOOR + CEILING - 0.08, z: k.z(v), color: TUBE, intensity, range: 10, decay: 2, fixture: 'panel', flicker });
}

function spec(s: Pick<HouseSpec, 'id' | 'x' | 'z' | 'w' | 'd' | 'facing' | 'label' | 'seed' | 'siding'> & Partial<HouseSpec>): HouseSpec {
  return {
    floors: 1, roofColor: 0x3a3d35, enterable: true, litWindows: 0.5, slab: FLOOR, groundHeight: CEILING,
    roof: 'flat', interior: 'interiorWall', floorMat: 'concrete', sign: 0x2f3a26, ...s,
  };
}

/** The barracks: one long room of bunks and lockers, a table by the door. */
function barracks(b: MapBuilder): void {
  const s = spec({ id: 'barracks', x: -100, z: -108, w: 18, d: 9, facing: 'south', label: 'BARRACKS', seed: 911, siding: 'sidingGreen' });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  b.house(s, k.layout({
    front: [win(-6.6, 1.4), win(-3.2, 1.4), door(0, 1.3), win(3.2, 1.4), win(6.6, 1.4)],
    back: [],
    west: [],
    east: [door(2.2, 1.1)],
  }), null);
  // Six double bunks down the back wall, a locker between each pair.
  for (let i = 0; i < 6; i++) {
    const u = -7.2 + i * 2.88;
    k.against('bunk', 'v+', D, u, FLOOR, { variant: i });
    if (i < 5) k.against('locker', 'v+', D, u + 1.44, FLOOR, { variant: i });
  }
  for (const u of [-8.1, -5.0, 5.0]) k.against('locker', 'v-', STORY.wall, u, FLOOR, { variant: 2 });
  k.against('bunk', 'u-', -W, 3.2, FLOOR, { variant: 7 });
  k.prop('diningTable', 2.6, 3.4, k.run(1, 0), { y: FLOOR });
  k.prop('chair', 1.7, 2.6, k.face(0, 1), { y: FLOOR, movable: true });
  k.prop('chair', 3.4, 4.3, k.face(0, -1), { y: FLOOR, movable: true });
  k.prop('chair', 4.4, 2.5, 0.6, { y: FLOOR, movable: true, tipped: true });
  k.prop('crate', -6.2, 5.6, 0.2, { y: FLOOR, movable: true });
  k.prop('crate', -0.6, 5.7, -0.3, { y: FLOOR, movable: true });
  k.prop('mattress', -3.4, 3.2, 0.4, { y: FLOOR, movable: true });
  k.against('ammoCrate', 'u+', W, 6.6, FLOOR);
  k.aidCase('v-', STORY.wall, 1.6, FLOOR);
  tube(k, -5.4, 4.4);
  tube(k, 0, 4.4, 40, true);
  tube(k, 5.4, 4.4);
  k.area(s.label!, -W - 0.3, W + 0.3, 0, s.d, -0.1, 6);
}

/** The armory: poured concrete, a roll-up door, the racks along the back wall. */
function armory(b: MapBuilder): void {
  const s = spec({ id: 'armory', x: -90.5, z: -69.6, w: 12, d: 8.4, facing: 'north', label: 'ARMORY', seed: 947, siding: 'concrete', reinforced: true, litWindows: 0 });
  const k = new Frame(b, s, false);
  const { W, D } = k;
  b.house(s, k.layout({
    front: [door(-2.6, 3.0, 'rollup', 2.6), door(3.6, 1.1)],
    back: [],
    west: [],
    east: [],
  }), null);
  // What the Guard left: rockets, belt-fed guns, .50 calibre rifles and grenade launchers.
  k.against('gunRack', 'v+', D, -4.35, FLOOR, { weapon: 'at4', stock: 4 });
  k.against('gunRack', 'v+', D, -1.45, FLOOR, { weapon: 'lmg', stock: 2 });
  k.against('gunRack', 'v+', D, 1.45, FLOOR, { weapon: 'sniper', stock: 2 });
  k.against('gunRack', 'v+', D, 4.35, FLOOR, { weapon: 'mgl', stock: 2 });
  k.against('ammoCrate', 'u-', -W, 2.2, FLOOR);
  k.against('ammoCrate', 'u-', -W, 3.6, FLOOR);
  k.against('ammoCrate', 'u+', W, 5.4, FLOOR);
  k.against('metalShelf', 'u+', W, 3.4, FLOOR, { variant: 1 });
  k.against('locker', 'u-', -W, 5.6, FLOOR);
  k.prop('crate', -1.2, 3.4, 0.15, { y: FLOOR, movable: true });
  k.prop('crate', -0.3, 3.9, -0.4, { y: FLOOR, movable: true });
  k.prop('pallet', 2.2, 3.0, 0.1, { y: FLOOR, movable: true });
  k.prop('ammoCrate', 0.9, 2.2, 0.4, { y: FLOOR });
  k.aidCase('v-', STORY.wall, 5.0, FLOOR);
  tube(k, -3, 4.2, 52);
  tube(k, 3, 4.2, 52);
  k.area(s.label!, -W - 0.3, W + 0.3, 0, s.d, -0.1, 6);
}

/** The motor pool: two Humvees that still start, fuel drums, spare tyres. */
function motorPool(b: MapBuilder): void {
  const p = BASE.pool;
  // Nose to the drive.
  b.prop('humvee', -115.2, -72.6, Math.PI / 2, { drive: true });
  b.prop('humvee', -109.4, -73.4, Math.PI / 2 + 0.06, { drive: true, variant: 1 });
  for (const [x, z] of [[-102.2, -65.4], [-103.0, -65.2], [-102.5, -66.1]]) b.prop('oilDrum', x, z, x);
  b.prop('tireStack', -118.6, -65.2, 0.3);
  b.prop('tireStack', -117.7, -65.0, 1.1);
  b.prop('pallet', -105.4, -65.6, 0.1, { movable: true });
  b.prop('crate', -105.4, -65.6, 0.3, { y: 0.15, movable: true });
  b.prop('cone', -112.3, -79.4, 0.2);
  b.prop('cone', -106.4, -79.6, 0.9);
  b.prop('floodlight', p.x0 + 1.0, p.z0 + 1.2, 0);
  b.light({ kind: 'spot', x: p.x0 + 1.4, y: 7.4, z: p.z0 + 1.6, tx: -111, ty: 0, tz: -72, color: FLOOD, intensity: 900, range: 40, angle: 0.6, penumbra: 0.5, decay: 2, fixture: 'none' });
  b.area('MOTOR POOL', p.x0, p.x1, p.z0, p.z1);
}

function yard(b: MapBuilder): void {
  // Two squad tents and the colours on the square.
  b.prop('tent', -86.4, -111.5, -Math.PI / 2);
  b.prop('tent', -86.4, -104.2, -Math.PI / 2);
  b.prop('mattress', -86.0, -111.2, 0.2, { movable: true });
  b.prop('crate', -85.4, -104.8, 0.3, { movable: true });
  b.prop('firstAid', -85.4, -104.8, 0.3, { y: 0.6 });
  b.prop('flagpole', -92.5, -93.2, 0);
  // A sandbagged position covering the gate from inside, and blast baskets round the fuel.
  b.prop('sandbags', -93.2, -80.4, 0.2, { length: 3.0 });
  b.prop('hesco', -113.5, -94.5, 0, { length: 4.4 });
  b.prop('hesco', -116.2, -97.2, Math.PI / 2, { length: 4.4, variant: 1 });
  b.prop('oilDrum', -114.6, -96.6, 0.4);
  b.prop('oilDrum', -113.7, -96.9, 1.3);
  b.prop('oilDrum', -114.2, -97.6, 2.0);
  b.prop('pallet', -112.0, -97.4, 0.3, { movable: true });
  b.prop('ammoCrate', -106.5, -90.6, 0.1);
  b.prop('floodlight', -118.6, -115.6, 0);
  b.light({ kind: 'spot', x: -118.2, y: 7.4, z: -115.2, tx: -104, ty: 0, tz: -98, color: FLOOD, intensity: 900, range: 40, angle: 0.6, penumbra: 0.5, decay: 2, fixture: 'none' });
}

export function militaryBase(b: MapBuilder): void {
  ground(b);
  perimeter(b);
  gate(b);
  tower(b);
  barracks(b);
  armory(b);
  motorPool(b);
  yard(b);
  b.garrisons.push({
    name: BASE.name, x: (BASE.x0 + BASE.x1) / 2, z: (BASE.z0 + BASE.z1) / 2, range: 62,
    posts: [
      // The gate and the drive.
      { x: -84.5, y: 0, z: -86.5 }, { x: -90, y: 0, z: -84.2 }, { x: -97.5, y: 0, z: -87.6 }, { x: -105, y: 0, z: -85.4 },
      // The square and the tents.
      { x: -96, y: 0, z: -96.5 }, { x: -103.5, y: 0, z: -98 }, { x: -89.5, y: 0, z: -100.5 }, { x: -89.8, y: 0, z: -97.6 },
      // Inside the barracks.
      { x: -104.5, y: FLOOR, z: -107.2 }, { x: -98, y: FLOOR, z: -108.6 }, { x: -94, y: FLOOR, z: -106.4 },
      // The motor pool.
      { x: -112.3, y: 0, z: -76.5 }, { x: -105.5, y: 0, z: -70 }, { x: -117, y: 0, z: -84 },
      // The armory and what is around it.
      { x: -93.5, y: FLOOR, z: -69 }, { x: -86.6, y: FLOOR, z: -67.2 }, { x: -88.5, y: 0, z: -77.5 }, { x: -98.2, y: 0, z: -67 },
      // The far corners.
      { x: -115, y: 0, z: -106 }, { x: -113.5, y: 0, z: -113.5 },
    ],
  });
  b.area(BASE.name, BASE.x0 - 0.5, BASE.x1 + 8, BASE.z0 - 0.5, BASE.z1 + 0.5);
}

/** Pell Lane's west sidewalk, in the stretches the camp's road leaves (see roads() in maple-hollow.ts). */
export function pellWestWalk(far: number, farSouth: number): [number, number][] {
  return [[-far, BASE_ROAD.z0], [BASE_ROAD.z1, -RW - SW], [RW + SW, farSouth]];
}
