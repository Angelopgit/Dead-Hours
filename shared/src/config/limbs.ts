import type { ZombieKind } from './zombies';

/** Which arm, by the zombie's own left and right (the hit zones' names). */
export type ArmZone = 'armL' | 'armR';

/**
 * Where an arm came off: at the shoulder (the whole arm) or at the elbow (forearm and hand,
 * leaving a stub on the zombie).
 */
export type LimbCut = 'shoulder' | 'elbow';

/** A zombie's arm: whole, cut off at the elbow, or gone from the shoulder. */
export type ArmState = 'intact' | LimbCut;

export interface LimbClub {
  /** Damage per hit to the body and torso (head hits do more). */
  damage: number;
  /** Hits it takes before it falls apart in the hands. */
  wear: number;
  /** Reach from the survivor's centre, metres. */
  reach: number;
  /** Zombies one swing can connect with. */
  targets: number;
}

/** Severed arms: when they come off, how they fall, and what they do as a club. */
export const LIMBS = {
  /** Damage an arm soaks before it comes off (on top of the zombie's health), per kind. */
  armHealth: { walker: 36, runner: 26, brute: 95, crawler: 26 } as Record<ZombieKind, number>,
  /** A machete chop counts this much more against an arm (it is made for cutting). */
  chopBonus: 1.5,
  /** A swung arm hitting an arm counts this much (it tears more than it cuts). */
  clubTear: 0.8,
  /** Along the arm from shoulder (0) to hand (1): hits past this take the forearm off at the elbow. */
  elbowAt: 0.52,
  /** Cut end to fingertips for a walker-sized arm, metres (scaled by the zombie's size). */
  length: { shoulder: 0.7, elbow: 0.4 } as Record<LimbCut, number>,
  radius: 0.055,
  /** Mass in kilograms (walker-sized). */
  mass: { shoulder: 3.4, elbow: 1.6 } as Record<LimbCut, number>,
  /** Arms lying around at once; the oldest one nobody holds goes first. */
  maxLoose: 14,
  /** Seconds a loose arm stays when no survivor is near it. */
  lifetime: 150,
  /** Pick-up reach: horizontal distance and height difference from the survivor's feet. */
  reach: 1.55,
  reachHeight: 1.4,
  /** The arm as a club, by where it was cut off. Brutes' arms hit harder and last longer. */
  club: {
    shoulder: { damage: 46, wear: 8, reach: 2.2, targets: 3 },
    elbow: { damage: 34, wear: 5, reach: 1.9, targets: 2 },
  } as Record<LimbCut, LimbClub>,
  bruteDamage: 1.3,
  bruteWear: 1.5,
  /** Swing timing: the blow lands `windup` seconds in; the whole swing takes `duration`. */
  windup: 0.27,
  duration: 0.78,
  /** Swing arc in radians. */
  arc: 1.6,
  knockback: 3.1,
  headBonus: 1.5,
  /** Wet thuds carry about this far. */
  noise: 9,
  /** Seconds to get a grip on it. */
  grab: 0.4,
  /** Damage dealt per missing arm, as a share of the full swipe (an elbow stub counts half). */
  attackLoss: 0.25,
  /** Door pounding lost per missing arm. */
  bashLoss: 0.3,
} as const;

/** Club numbers for an arm cut from a zombie of `kind`. */
export function limbClub(cut: LimbCut, kind: ZombieKind): LimbClub {
  const c = LIMBS.club[cut];
  if (kind !== 'brute') return c;
  return { ...c, damage: Math.round(c.damage * LIMBS.bruteDamage), wear: Math.round(c.wear * LIMBS.bruteWear) };
}
