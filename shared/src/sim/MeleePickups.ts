import type { Physics } from '../physics/Physics';
import type { MapDefinition } from '../types/world';
import { FOUND_MELEE, MELEE_PICKUPS, type MeleeId, type MeleeRoom } from '../config/melee';
import { NAV_INDOOR, NAV_NEAR_WALL, NAV_REACHABLE, type NavGrid } from './NavGrid';
import type { Vec3 } from './math';

/** A room a found weapon can lie in: its kind and the floor cells to put it on. */
export interface PickupRoom {
  key: string;
  room: MeleeRoom;
  /** Nav nodes on the room's floor, the ones against a wall first. */
  nodes: number[];
  /** How many of them are against a wall (a weapon leaning or dropped by the wall looks right). */
  walled: number;
  /** Middle of the room (distance checks). */
  centre: Vec3;
}

/**
 * Finds the rooms found weapons turn up in: every bedroom (the floor around each bed, on this
 * side of its walls), every basement, and the gas station's store. Rooms near where survivors
 * spawn are left out. Built from the nav grid, so a weapon always lies somewhere walkable.
 */
export function findPickupRooms(map: MapDefinition, nav: NavGrid, physics: Physics): PickupRoom[] {
  // Every night on a server shares the map and its grid: work the rooms out once.
  const known = cache.get(nav);
  if (known) return known;
  const found = roomsOf(map, nav, physics);
  cache.set(nav, found);
  return found;
}

const cache = new WeakMap<NavGrid, PickupRoom[]>();

function roomsOf(map: MapDefinition, nav: NavGrid, physics: Physics): PickupRoom[] {
  const P = MELEE_PICKUPS;
  const rooms = new Map<string, { room: MeleeRoom; wall: number[]; open: number[] }>();
  const add = (key: string, room: MeleeRoom, n: number) => {
    let r = rooms.get(key);
    if (!r) rooms.set(key, (r = { room, wall: [], open: [] }));
    (nav.flags[n] & NAV_NEAR_WALL ? r.wall : r.open).push(n);
  };
  const beds = map.props.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'bed');
  // Keep stairs, their ends and doorways clear. A stair's keep-clear box, as x0, x1, z0, z1:
  const stairBox = (s: MapDefinition['stairs'][number]) => {
    const lo = Math.min(s.from, s.to) - 0.9, hi = Math.max(s.from, s.to) + 0.9;
    return s.axis === 'x' ? [lo, hi, s.a0 - 0.4, s.a1 + 0.4] : [s.a0 - 0.4, s.a1 + 0.4, lo, hi];
  };
  // Each house with the stairs, doors and beds that can matter to a spot inside it (in map order), so
  // the walk over every nav cell (about 300k) tests a few of each, not every one on the map.
  const near = (h: { x: number; z: number; w: number; d: number }, x: number, z: number, reach: number) =>
    Math.abs(x - h.x) < h.w / 2 + reach && Math.abs(z - h.z) < h.d / 2 + reach;
  const houses = map.houses.map((h) => ({
    h,
    stairs: map.stairs.filter((s) => {
      const [x0, x1, z0, z1] = stairBox(s);
      return x1 > h.x - h.w / 2 && x0 < h.x + h.w / 2 && z1 > h.z - h.d / 2 && z0 < h.z + h.d / 2;
    }),
    doors: map.doors.filter((d) => near(h, d.x, d.z, d.w / 2 + 0.7)),
    beds: beds.filter(({ p }) => near(h, p.x, p.z, P.bedRoom)),
  }));
  const houseAt = (x: number, z: number) => houses.find(({ h }) => Math.abs(x - h.x) < h.w / 2 && Math.abs(z - h.z) < h.d / 2);
  const onStairs = (stairs: MapDefinition['stairs'], x: number, z: number, y: number) => stairs.some((s) => {
    const [x0, x1, z0, z1] = stairBox(s);
    return x > x0 && x < x1 && z > z0 && z < z1 && y > Math.min(s.y0, s.y1) - 0.5 && y < Math.max(s.y0, s.y1) + 0.5;
  });
  const inDoorway = (doors: MapDefinition['doors'], x: number, z: number, y: number) => doors.some((d) => Math.hypot(d.x - x, d.z - z) < d.w / 2 + 0.7 && Math.abs((d.floorY ?? d.y - d.h / 2) - y) < 1.5);
  for (let n = 0, count = nav.nodeCount; n < count; n++) {
    const f = nav.flags[n];
    if (!(f & NAV_REACHABLE) || !(f & NAV_INDOOR)) continue;
    const x = nav.nodeX(n), y = nav.nodeY[n], z = nav.nodeZ(n);
    const at = houseAt(x, z);
    if (!at) continue;
    const house = at.h;
    if (onStairs(at.stairs, x, z, y) || inDoorway(at.doors, x, z, y)) continue;
    if (house.id === 'store') {
      add('store', 'store', n);
      continue;
    }
    // The hardware store and the army surplus: tools and blades among the stock.
    if (house.melee) {
      add(`store:${house.id}`, 'store', n);
      continue;
    }
    if (y < -1) {
      add(`basement:${house.id}`, 'basement', n);
      continue;
    }
    for (const { p, i } of at.beds) {
      const by = p.y ?? 0;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > P.bedRoom || Math.abs(y - by) > 0.8 || d < 0.3) continue;
      // Same room as the bed: nothing solid between them at chest height.
      const h = y + 1.3;
      const hit = physics.raycast(x, h, z, (p.x - x) / d, 0, (p.z - z) / d, d);
      if (hit !== null && hit < d - 0.35) continue;
      add(`bed:${i}`, 'bedroom', n);
      break;
    }
  }
  const out: PickupRoom[] = [];
  for (const [key, r] of rooms) {
    const nodes = [...r.wall, ...r.open];
    if (nodes.length < 4) continue;
    let cx = 0, cy = 0, cz = 0;
    for (const n of nodes) {
      cx += nav.nodeX(n);
      cy += nav.nodeY[n];
      cz += nav.nodeZ(n);
    }
    const centre = { x: cx / nodes.length, y: cy / nodes.length, z: cz / nodes.length };
    if (map.playerSpawns.some((s) => Math.hypot(s.x - centre.x, s.z - centre.z) < P.awayFromSpawn)) continue;
    out.push({ key, room: r.room, nodes, walled: r.wall.length, centre });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Which found weapon turns up in a room of this kind, favouring ones not already lying about. */
export function pickFoundWeapon(room: MeleeRoom, placed: MeleeId[], rand: () => number): MeleeId {
  const odds = MELEE_PICKUPS.odds[room];
  const w = FOUND_MELEE.map((id) => (odds[id] ?? 0) / (1 + 1.5 * placed.filter((p) => p === id).length));
  const total = w.reduce((s, k) => s + k, 0);
  let x = rand() * total;
  for (let i = 0; i < w.length; i++) if ((x -= w[i]) < 0) return FOUND_MELEE[i];
  return FOUND_MELEE[FOUND_MELEE.length - 1];
}

/** The way a found weapon lies on the floor (radians), the same on every screen. */
export function pickupYaw(id: number): number {
  return (((Math.imul(id + 1, 2654435761) >>> 0) % 6283) / 1000);
}
