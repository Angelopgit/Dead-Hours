import type { Quality } from '../core/Settings';

/** The night's fog (THREE.FogExp2) density for each fog quality. */
export const FOG_DENSITY: Record<Quality, number> = { low: 0.017, medium: 0.02, high: 0.022 };

/** How much of an object's own colour the fog leaves `d` metres away (FogExp2: e^-(d x density)^2). */
export function fogLeft(d: number, density: number): number {
  return Math.exp(-((d * density) ** 2));
}

/**
 * Loose bikes, skateboards and syringes stop drawing past this: even the thinnest fog leaves under 2% of them
 * there, and seen from the woods they were some 50 draw calls a frame nobody could see.
 */
export const PICKUP_DRAW_RANGE = 120;
