import type { DoorSpec, HouseSpec, MapDefinition } from '../types/world';

/**
 * A front porch: a step and a small roof on posts over the wooden front door of a gable-roofed
 * house. Drawn by the client only (nothing collides with it), so things that drop people past it
 * (vaulting out of an upstairs window) have to keep clear of the roof.
 */
export interface Porch {
  door: DoorSpec;
  /** +1 when the house faces south (+z). */
  sign: 1 | -1;
  /** Centre of the step along z. */
  z: number;
  /** The roof: centre, size and top. */
  roof: { x: number; z: number; w: number; d: number; y: number; top: number };
}

/** The porch in front of a house, if it has one. */
export function porchOf(map: MapDefinition, h: HouseSpec): Porch | null {
  const sign: 1 | -1 = h.facing === 'south' ? 1 : -1;
  if ((h.roof ?? 'gable-x') !== 'gable-x') return null;
  const door = map.doors.find((d) => d.houseId === h.id && d.exterior && d.outward === sign && d.axis === 'x' && (d.style ?? 'wood') === 'wood');
  if (!door) return null;
  const z = h.z + sign * (h.d / 2 + 0.9);
  return { door, sign, z, roof: { x: door.x, z: z - sign * 0.05, w: door.w + 1.8, d: 1.9, y: 2.95, top: 3.01 } };
}

/** Every porch on the map. */
export function porches(map: MapDefinition): Porch[] {
  const out: Porch[] = [];
  for (const h of map.houses) {
    const p = porchOf(map, h);
    if (p) out.push(p);
  }
  return out;
}
