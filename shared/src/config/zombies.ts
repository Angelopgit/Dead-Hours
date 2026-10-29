export type ZombieKind = 'walker' | 'runner' | 'brute' | 'crawler';

export interface ZombieDef {
  kind: ZombieKind;
  health: number;
  /** Speed ranges in m/s; each zombie rolls its own within the range. */
  wanderSpeed: [number, number];
  chaseSpeed: [number, number];
  /** Damage per landed swipe. */
  damage: [number, number];
  /** Center-to-center distance at which it starts a swipe. */
  attackRange: number;
  /** Seconds from the start of a swipe to the moment it lands. */
  windup: number;
  /** Seconds between swipes. */
  cooldown: number;
  sightRange: number;
  /** Multiplier on how far it hears noises. */
  hearing: number;
  radius: number;
  height: number;
  /** Damage in one hit that makes it stagger. */
  staggerAt: number;
  /** Turn rate in radians per second. */
  turnRate: number;
  /** Door bashing per second (doors give way at 1). */
  bash: number;
}

/**
 * Zombie types. Phase 3 puts walkers in the neighbourhood; the survival director (Phase 5)
 * introduces the others over time.
 */
export const ZOMBIES: Record<ZombieKind, ZombieDef> = {
  walker: {
    kind: 'walker', health: 100, wanderSpeed: [0.55, 0.9], chaseSpeed: [1.45, 2.15], damage: [11, 16],
    attackRange: 1.15, windup: 0.5, cooldown: 1.25, sightRange: 26, hearing: 1, radius: 0.3, height: 1.75,
    staggerAt: 34, turnRate: 4.2, bash: 0.14,
  },
  runner: {
    kind: 'runner', health: 70, wanderSpeed: [0.8, 1.1], chaseSpeed: [4.3, 5.2], damage: [8, 12],
    attackRange: 1.15, windup: 0.32, cooldown: 0.9, sightRange: 32, hearing: 1.2, radius: 0.3, height: 1.72,
    staggerAt: 26, turnRate: 7, bash: 0.12,
  },
  brute: {
    kind: 'brute', health: 420, wanderSpeed: [0.45, 0.6], chaseSpeed: [1.2, 1.5], damage: [28, 36],
    attackRange: 1.45, windup: 0.85, cooldown: 1.8, sightRange: 24, hearing: 0.9, radius: 0.45, height: 2.1,
    staggerAt: 120, turnRate: 2.4, bash: 0.5,
  },
  crawler: {
    kind: 'crawler', health: 55, wanderSpeed: [0.4, 0.6], chaseSpeed: [2.6, 3.4], damage: [7, 10],
    attackRange: 0.95, windup: 0.3, cooldown: 0.8, sightRange: 18, hearing: 1.1, radius: 0.3, height: 0.7,
    staggerAt: 30, turnRate: 6, bash: 0.08,
  },
};

/** Survival tuning that Phase 5's director will replace with a full escalation model. */
export const SPAWNING = {
  /** Population when the outbreak starts, and how it grows. */
  basePopulation: 6,
  growthPerMinute: 2.2,
  maxPopulation: 26,
  /** Seconds between spawns while below target. */
  interval: [1.6, 3.4] as [number, number],
  minDistance: 42,
  maxDistance: 85,
  /** Zombies farther than this from every player, unaware of anyone, are recycled. */
  despawnDistance: 115,
  /** Corpses stay this long before sinking into the ground. */
  corpseTime: 30,
} as const;
