import type { ZombieKind } from './zombies';

/** What a survivor can throw. */
export type ThrowKind = 'frag' | 'molotov';
export const THROW_KINDS: ThrowKind[] = ['frag', 'molotov'];

export interface ThrowableDef {
  kind: ThrowKind;
  name: string;
  /** Carried at the start of a night, and at most. */
  start: number;
  max: number;
  /** Throw speed (m/s) and how far above the crosshair it is lobbed (radians). */
  speed: number;
  lift: number;
  /** Collision radius of the thing in flight. */
  radius: number;
  /** Bounciness and how much sideways speed a bounce keeps. */
  restitution: number;
  friction: number;
}

export const THROWABLES: Record<ThrowKind, ThrowableDef> = {
  frag: { kind: 'frag', name: 'Frag Grenade', start: 2, max: 3, speed: 17, lift: 0.17, radius: 0.045, restitution: 0.34, friction: 0.62 },
  molotov: { kind: 'molotov', name: 'Molotov', start: 1, max: 2, speed: 15, lift: 0.15, radius: 0.05, restitution: 0.25, friction: 0.5 },
};

/** The throwing motion and the flight. */
export const THROWING = {
  /** Seconds the whole throw takes; it leaves the hand `release` seconds in. */
  duration: 0.74,
  release: 0.3,
  gravity: 9.81,
  /** Air drag per second (slight: a grenade is dense). */
  drag: 0.06,
  /** A frag goes off this long after it leaves the hand. */
  fuse: 2.7,
  /** Molotovs break on anything they hit faster than this (m/s); slower they roll and break when they stop. */
  shatterSpeed: 2.2,
  /** Ammunition crates hand out one of each per use (when there is room); supply drops fill them up. */
  cratePerUse: 1,
  /** In flight longer than this (stuck somewhere) it goes off or breaks anyway. */
  maxFlight: 8,
} as const;

/** A frag grenade going off. */
export const BLAST = {
  /** Lethal radius and the core where everything takes full force (m). */
  radius: 8.5,
  inner: 2.4,
  /** Damage to zombies at the core (falls off with distance to the radius). */
  damage: 320,
  /** Damage to survivors at the core: the thrower takes all of it, teammates a share. */
  playerDamage: 115,
  teamShare: 0.5,
  /** Falloff exponent past the core (higher drops faster). */
  falloff: 1.5,
  /** Zombies within this many core radii are knocked off their feet if they live. */
  knockDown: 1.9,
  /** Zombies hear it this far (m). */
  noise: 130,
  /**
   * Dismemberment: how hard the blast hits a body part (0..1 from its distance and cover) above
   * which it may come off, and the chance at full force. Arms tear first, legs need a closer
   * blast, heads the closest; a body caught right at the core comes apart completely.
   */
  sever: {
    arm: { from: 0.1, chance: 0.95 },
    leg: { from: 0.3, chance: 0.85 },
    head: { from: 0.35, chance: 0.75 },
  },
  /** How far from the blast parts can be torn off at all (tearing force falls to nothing here, m). */
  tearRadius: 5.5,
  /** A killed body this close (tearing force above `shred`) comes apart completely. */
  shred: 0.72,
  /** How hard parts are thrown (m/s at full force). */
  fling: 11,
  /** Loose arms and gibs lying around are thrown this hard (impulse per kg at full force). */
  scatter: 9,
} as const;

/** A Molotov's spill of burning fuel, and zombies on fire. */
export const FIRE = {
  /** Seconds the spill burns (dying down over the last `fade`). */
  duration: 11,
  fade: 2.5,
  /** How far the fuel spreads from where the bottle broke, and how many burning patches it makes. */
  spread: 2.8,
  patches: 9,
  /** Radius of one burning patch (m). */
  patchRadius: 1.15,
  /** Burning patches on a step or ledge more than this above or below the break are left out. */
  maxDrop: 0.9,
  /** Seconds between fire damage steps. */
  tick: 0.2,
  /** A zombie that caught fire burns this long after it last touched flames. */
  burnTime: 6.5,
  /** Burn damage per second as a share of the zombie's full health (all die within burnTime). */
  burnRate: { walker: 0.26, runner: 0.3, brute: 0.17, crawler: 0.3 } as Record<ZombieKind, number>,
  /** Burning zombies set others alight: within this distance, at this chance per tick. */
  spreadRange: 1.05,
  spreadChance: 0.35,
  /** Burning zombies move this much faster (panic). */
  panicSpeed: 1.15,
  /** Damage per second to a survivor standing in the flames, and the extra a burning zombie's swipe does. */
  playerDps: 18,
  burningSwipe: 5,
  /** The whoosh is heard this far. */
  noise: 45,
} as const;
