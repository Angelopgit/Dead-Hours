/**
 * Helicopter supply drops during survival: a helicopter crosses the neighbourhood, hovers over
 * open ground near the survivors and lets a crate of universal ammunition down on a chute.
 * The crate refills every weapon's reserve, whatever the survivor carries. The noise draws
 * the dead to it, so going for it is a gamble.
 */
export const SUPPLY_DROPS = {
  /** Survival seconds until the first drop, then seconds between drops. */
  firstAt: 70,
  interval: [105, 150] as [number, number],
  /** Cruise height and speed; slows into a hover over the drop. */
  altitude: 34,
  speed: 24,
  /** Seconds spent hovering before the crate goes out, and after. */
  hover: 2.6,
  linger: 1.2,
  /** The crate leaves the helicopter this far above the ground and sinks at this speed. */
  releaseHeight: 31,
  fallSpeed: 4.4,
  /** Distance band from the nearest survivor, and open ground needed around the landing spot. */
  minDistance: 15,
  maxDistance: 36,
  clearRadius: 2,
  /** Uses: two, plus one more per survivor; nobody takes more than two. */
  baseUses: 2,
  perPlayerLimit: 2,
  /** Crates left this long are taken away (keeps the map from filling up). */
  lifetime: 360,
  /** Noise radius of the rotors over the drop, and of the crate landing. */
  hoverNoise: 48,
  landNoise: 26,
} as const;
