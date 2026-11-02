import type { Physics } from '../physics/Physics';
import { propHalfExtents } from '../map/colliders';
import type { MapDefinition, PropKind, PropSpec } from '../types/world';
import { BOOST_IDS, BOOST_PICKUPS, type BoostId } from '../config/boosts';
import { NAV_REACHABLE, type NavGrid } from './NavGrid';
import type { Vec3 } from './math';

/** A place a syringe can lie: on top of a piece of furniture inside a house. */
export interface BoostSpot {
  /** The house it is in (one syringe per house). */
  house: string;
  /** The furniture it lies on. */
  prop: PropKind;
  /** On the surface (the syringe's underside). */
  pos: Vec3;
  /** Floor in front of the furniture, where a survivor stands to take it. */
  stand: Vec3;
}

/**
 * Furniture a syringe can be left on: the height of its top (as drawn) and free places on it in
 * the prop's own frame (+X along it, +Z its front), clear of what is drawn standing on it and at
 * least 0.1 m from every edge so a syringe lying any way round stays on top.
 */
const SURFACES: Partial<Record<PropKind, { top: number; spots: (p: PropSpec) => [number, number][] }>> = {
  counter: {
    top: 0.91,
    spots: (p) => {
      const half = (p.length ?? 2.4) / 2;
      return half >= 0.45 ? [[-half + 0.3, 0.1], [0, 0.1], [half - 0.3, 0.1]] : [[0, 0.1]];
    },
  },
  dresser: { top: 0.85, spots: () => [[-0.35, 0.06], [0.35, 0.06]] },
  desk: { top: 0.76, spots: () => [[-0.5, 0.17]] },
  vanity: { top: 0.85, spots: () => [[-0.33, 0.1], [0.33, 0.1]] },
  coffeeTable: { top: 0.45, spots: () => [[-0.3, 0.02]] },
  diningTable: { top: 0.77, spots: () => [[-0.4, 0.15], [0.4, -0.15]] },
  workbench: { top: 0.96, spots: () => [[0.62, 0.2]] },
};

const cache = new WeakMap<NavGrid, BoostSpot[]>();

/**
 * Every place a syringe can be left: the tops of counters, dressers, desks, sinks, tables and
 * workbenches in the houses (not the safehouse the survivors start in). Each one has
 * walkable floor in front of it and a clear line from where a survivor stands to it.
 */
export function findBoostSpots(map: MapDefinition, nav: NavGrid, physics: Physics): BoostSpot[] {
  const known = cache.get(nav);
  if (known) return known;
  const found = spotsOf(map, nav, physics);
  cache.set(nav, found);
  return found;
}

function spotsOf(map: MapDefinition, nav: NavGrid, physics: Physics): BoostSpot[] {
  const P = BOOST_PICKUPS;
  const out: BoostSpot[] = [];
  const houseAt = (x: number, z: number) => map.houses.find((h) => h.enterable && Math.abs(x - h.x) < h.w / 2 && Math.abs(z - h.z) < h.d / 2);
  for (const p of map.props) {
    const s = SURFACES[p.kind];
    if (!s || p.use === 'weapons' || p.tipped) continue;
    const house = houseAt(p.x, p.z);
    if (!house) continue;
    const base = p.y ?? 0;
    const c = Math.cos(p.rotY), sn = Math.sin(p.rotY);
    const world = (lx: number, lz: number) => ({ x: p.x + lx * c + lz * sn, z: p.z - lx * sn + lz * c });
    const [, hz] = propHalfExtents(p.kind, p.length);
    for (const [lx, lz] of s.spots(p)) {
      const at = world(lx, lz);
      const pos = { x: at.x, y: base + s.top, z: at.z };
      if (map.playerSpawns.some((sp) => Math.hypot(sp.x - pos.x, sp.z - pos.z) < P.awayFromSpawn)) continue;
      // Somewhere to stand in front of it.
      const front = world(lx, hz + 0.45);
      const n = nav.nodeAt(front.x, base + 0.1, front.z, 0.5);
      if (n < 0 || !(nav.flags[n] & NAV_REACHABLE) || Math.abs(nav.nodeY[n] - base) > 0.5) continue;
      // Nothing over it (a shelf, a cupboard), and its top really is there.
      const down = physics.raycast(pos.x, pos.y + 0.6, pos.z, 0, -1, 0, 0.8);
      if (down === null || down < 0.48 || down > 0.66) continue;
      // In plain view of someone standing in front of it.
      const eye = { x: front.x, y: nav.nodeY[n] + 1.5, z: front.z };
      const dx = pos.x - eye.x, dy = pos.y + 0.12 - eye.y, dz = pos.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      const hit = physics.raycast(eye.x, eye.y, eye.z, dx / d, dy / d, dz / d, d);
      if (hit !== null && hit < d - 0.15) continue;
      out.push({ house: house.id, prop: p.kind, pos, stand: { x: front.x, y: nav.nodeY[n], z: front.z } });
    }
  }
  return out;
}

/** Which kind of syringe to put down next: one not already lying about if there is one. */
export function pickBoost(placed: BoostId[], rand: () => number): BoostId {
  const fresh = BOOST_IDS.filter((id) => !placed.includes(id));
  const pool = fresh.length ? fresh : BOOST_IDS;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

/** The way a syringe lies on its surface (radians), the same on every screen. */
export function boostYaw(id: number): number {
  return (((Math.imul(id + 7, 2246822519) >>> 0) % 6283) / 1000);
}
