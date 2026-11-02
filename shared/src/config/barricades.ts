import type { HouseSpec, WindowSpec } from '../types/world';

/** Boarding up homes: how long it takes, how much pounding boards soak, and which openings take them. */
export const BARRICADE = {
  /** Most boards across a door, and across a window. */
  doorBoards: 4,
  windowBoards: 3,
  /** Seconds to nail one board up, and to pry one off. */
  boardTime: 1.5,
  pryTime: 0.9,
  /** Furthest a survivor's eye can be from the opening's centre while working on it (m). */
  reach: 2.3,
  /**
   * Furthest a survivor's feet can be above or below the floor of the opening's storey (m): work
   * stays on the opening's own floor, never from the basement under a window or the bedroom over it.
   */
  floorReach: 1.0,
  /** Pounding one board soaks before it splits off (a door gives way at 1; walkers hit 0.14). */
  boardStrength: 0.7,
  /** Hammer blows while nailing, and how far each carries to zombie ears (m). */
  hammerEvery: 0.38,
  hammerNoise: 16,
  /** Seconds a zombie takes to climb in through a clear window (brutes take longer). */
  vaultTime: 1.1,
  bruteVaultTime: 1.6,
  /** Smallest opening a zombie climbs through, and the highest sill a board goes on (ground storey only). */
  minWidth: 1.0,
  minHeight: 1.0,
  maxSill: 2.0,
} as const;

/**
 * Whether a window takes boards: a ground-storey window of an enterable building that a zombie
 * could climb through. Bathroom slits and upstairs windows don't.
 */
export function isBarricadeWindow(house: HouseSpec | undefined, w: WindowSpec): boolean {
  return !!house?.enterable && w.w >= BARRICADE.minWidth && w.h >= BARRICADE.minHeight && w.y - w.h / 2 < BARRICADE.maxSill;
}
