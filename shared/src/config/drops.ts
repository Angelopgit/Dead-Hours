import type { WeaponId } from './weapons';

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
  /**
   * Exclusive weapons: a drop has `exclusiveChance` of carrying a weapon case beside the
   * ammunition, one gun for whoever gets there first; before the survivors have lasted
   * `exclusiveAfter` seconds the chance is only `exclusiveEarly`. The weights pick which gun:
   * the two snipers are the rarest.
   */
  exclusiveAfter: 180,
  exclusiveChance: 0.12,
  exclusiveEarly: 0.03,
  exclusiveWeights: [['lmg', 0.25], ['battle', 0.2], ['rpg', 0.25], ['wraith', 0.15], ['sniper', 0.15]] as [WeaponId, number][],
  /** The case lies this far from the crate's centre, across the helicopter's way in. */
  caseOffset: 1.15,
  /** Chance that a drop also carries one Lazarus serum (see SERUM), lying on the crate's other side. */
  serumChance: 0.1,
} as const;

/**
 * Lazarus serum: an experimental immunity shot from the supply drops. Injected, it hardens the
 * survivor against the dead: `absorb` of every zombie hit (claws, bites, a bloater bursting)
 * comes off an armor pool of `armor` points instead of their health, until the pool is spent.
 */
export const SERUM = {
  name: 'Lazarus Serum',
  armor: 100,
  absorb: 0.6,
} as const;

/**
 * Where a drop's weapon case (side 1) or serum (side -1) lies: beside the crate, the same on
 * every machine.
 */
export function caseSpot(f: { from: { x: number; z: number }; over: { x: number; z: number }; ground: { x: number; y: number; z: number } }, side = 1): { x: number; y: number; z: number; yaw: number } {
  const yaw = Math.atan2(f.over.x - f.from.x, f.over.z - f.from.z);
  // Perpendicular to the way in: the crate's long side faces it.
  const r = SUPPLY_DROPS.caseOffset * side;
  return { x: f.ground.x + Math.cos(yaw) * r, y: f.ground.y, z: f.ground.z - Math.sin(yaw) * r, yaw };
}
