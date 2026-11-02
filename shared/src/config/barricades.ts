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
 * Survivors vaulting through windows (jump at one in reach): the pane smashes if it is still in,
 * boards stop them. Ground-storey windows land on the floor; upstairs ones drop to the ground.
 */
export const VAULT = {
  /** Smallest window a survivor gets through (bathroom slits are too small). */
  minWidth: 0.9,
  minHeight: 1.0,
  /** Furthest the survivor's centre can be from the middle of the wall (m), and the nearest. */
  reach: 1.35,
  near: 0.15,
  /** Past the window's edge a survivor still counts as in front of it (m). */
  side: 0.2,
  /** Highest a sill can be above the feet (m), and lowest below them. */
  maxRise: 1.65,
  minRise: -0.5,
  /** Seconds: onto the sill, across it, and down the other side. */
  upTime: 0.22,
  overTime: 0.28,
  downTime: 0.18,
  /** Where the survivor's centre crosses the sill and lands, from the middle of the wall (m). */
  clear: 0.56,
  land: [0.62, 0.95, 1.3] as readonly number[],
  /** Deepest the far side's floor can be under the sill and still be stepped down to (m); deeper is a drop. */
  maxStep: 1.7,
  /** Deepest drop out of a window (upstairs to the ground is about 4.5 m). */
  maxDrop: 6.5,
  /** Speed carried out of the vault (m/s): on along the floor, or pushed off the sill into a drop. */
  exitSpeed: 2.2,
  dropSpeed: 1.6,
  /** Heard this far (m): a scramble over the sill, or crashing through the glass. */
  noise: 9,
  smashNoise: 18,
  /** Slack the server allows on reach (latency) (m). */
  slack: 0.9,
} as const;

/** Whether a survivor fits through a window. */
export function isVaultWindow(house: HouseSpec | undefined, w: WindowSpec): boolean {
  return !!house?.enterable && w.w >= VAULT.minWidth && w.h >= VAULT.minHeight;
}

/**
 * Whether a window takes boards: a ground-storey window of an enterable building that a zombie
 * could climb through. Bathroom slits and upstairs windows don't.
 */
export function isBarricadeWindow(house: HouseSpec | undefined, w: WindowSpec): boolean {
  return !!house?.enterable && w.w >= BARRICADE.minWidth && w.h >= BARRICADE.minHeight && w.y - w.h / 2 < BARRICADE.maxSill;
}
