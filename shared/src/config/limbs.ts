import type { ZombieKind } from './zombies';

/** Which arm, by the zombie's own left and right (the hit zones' names). */
export type ArmZone = 'armL' | 'armR';
/** Which leg, likewise. */
export type LegZone = 'legL' | 'legR';
/** Any limb that can come off. */
export type LimbZone = ArmZone | LegZone;

/**
 * Where an arm came off: at the shoulder (the whole arm) or at the elbow (forearm and hand,
 * leaving a stub on the zombie).
 */
export type ArmCut = 'shoulder' | 'elbow';
/** Where a leg came off: at the hip (the whole leg) or at the knee (shin and foot, leaving a thigh stump). */
export type LegCut = 'hip' | 'knee';
/** Where any limb came off. */
export type LimbCut = ArmCut | LegCut;

/** A zombie's arm: whole, cut off at the elbow, or gone from the shoulder. */
export type ArmState = 'intact' | ArmCut;
/** A zombie's leg: whole, cut off at the knee, or gone from the hip. */
export type LegState = 'intact' | LegCut;

export const isLeg = (zone: string): zone is LegZone => zone === 'legL' || zone === 'legR';
export const isArm = (zone: string): zone is ArmZone => zone === 'armL' || zone === 'armR';

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
  armHealth: { walker: 36, runner: 26, brute: 95, crawler: 26, screamer: 22, bloater: 70 } as Record<ZombieKind, number>,
  /** A machete chop counts this much more against an arm (it is made for cutting). */
  chopBonus: 1.5,
  /** A swung arm hitting an arm counts this much (it tears more than it cuts). */
  clubTear: 0.8,
  /** Along the arm from shoulder (0) to hand (1): hits past this take the forearm off at the elbow. */
  elbowAt: 0.52,
  /** Cut end to fingertips for a walker-sized arm, metres (scaled by the zombie's size). */
  length: { shoulder: 0.7, elbow: 0.4, hip: 0.95, knee: 0.52 } as Record<LimbCut, number>,
  radius: 0.055,
  /** Mass in kilograms (walker-sized). */
  mass: { shoulder: 3.4, elbow: 1.6, hip: 11, knee: 4.5 } as Record<LimbCut, number>,
  /** Arms lying around at once; the oldest one nobody holds goes first. */
  maxLoose: 14,
  /** Seconds a loose arm stays when no survivor is near it. */
  lifetime: 150,
  /** Pick-up reach: horizontal distance and height difference from the survivor's feet. */
  reach: 1.55,
  reachHeight: 1.4,
  /** The limb as a club, by where it was cut off. Brutes' limbs hit harder and last longer; a whole leg is the heaviest. */
  club: {
    shoulder: { damage: 46, wear: 8, reach: 2.2, targets: 3 },
    elbow: { damage: 34, wear: 5, reach: 1.9, targets: 2 },
    hip: { damage: 58, wear: 9, reach: 2.45, targets: 3 },
    knee: { damage: 40, wear: 6, reach: 2.05, targets: 2 },
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

/**
 * Severed legs and the crawlers they leave behind. A leg soaks `legHealth` (on top of the
 * zombie's health) before it comes off: above `kneeAt` along the leg it goes at the hip, lower
 * down at the knee. Losing either leg puts the zombie on the ground for good, dragging itself
 * along by its arms until it is killed.
 */
export const LEGS = {
  /** Damage a leg soaks before it comes off, per kind (well under each kind's health). */
  legHealth: { walker: 48, runner: 34, brute: 150, crawler: 30, screamer: 30, bloater: 95 } as Record<ZombieKind, number>,
  /** Along the leg from hip (0) to foot (1): hits past this take it off at the knee. */
  kneeAt: 0.5,
  /**
   * When the blow that takes a leg off would also kill, the zombie lives on as a crawler this
   * often (left with `surviveHealth` of its full health) instead of dying.
   */
  survive: 0.55,
  surviveHealth: 0.3,
  /** Crawling speeds in m/s (rolled per zombie), times `kindSpeed` for its kind. */
  wanderSpeed: [0.3, 0.45] as [number, number],
  chaseSpeed: [0.85, 1.25] as [number, number],
  kindSpeed: { walker: 1, runner: 1.35, brute: 0.75, crawler: 1, screamer: 1.2, bloater: 0.7 } as Record<ZombieKind, number>,
  /** With an arm gone it drags itself slower, and with none it can only squirm. */
  armSpeed: 0.3,
  /** A crawler's swipe and bite: range, and damage as a share of its standing swipe. */
  attackRange: 0.85,
  damage: 0.7,
  /** Door pounding as a share of its standing bash. */
  bash: 0.4,
  /** Seconds it writhes on the spot after a leg comes off before it starts to crawl. */
  shock: [1.1, 1.6] as [number, number],
  /** Eye and chest heights while crawling (walker-sized, metres). */
  eye: 0.5,
  chest: 0.3,
} as const;

/** What to call a severed limb on screen, by where it was cut. */
export const LIMB_NAME: Record<LimbCut, string> = { shoulder: 'SEVERED ARM', elbow: 'SEVERED FOREARM', hip: 'SEVERED LEG', knee: 'SEVERED SHIN' };

/** Club numbers for an arm cut from a zombie of `kind`. */
export function limbClub(cut: LimbCut, kind: ZombieKind): LimbClub {
  const c = LIMBS.club[cut];
  if (kind !== 'brute') return c;
  return { ...c, damage: Math.round(c.damage * LIMBS.bruteDamage), wear: Math.round(c.wear * LIMBS.bruteWear) };
}
