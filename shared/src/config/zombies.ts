export type ZombieKind = 'walker' | 'runner' | 'brute' | 'crawler' | 'screamer' | 'bloater';

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
  /** Body width relative to its height (brutes are broad): hit zones and the rendered body. */
  girth: number;
}

/**
 * Zombie types. Walkers are most of the dead; runners sprint once they spot someone (still
 * slower than a sprinting survivor); brutes are slow, take a magazine to put down, hit hard
 * and break doors in a few blows. Crawlers are legless walkers dragging themselves along (any zombie
 * whose leg is shot off becomes one). Screamers are
 * frail and quick, and stop to call the dead down on whoever they see; bloaters are slow, swollen
 * and burst when killed (see SPECIALS).
 */
export const ZOMBIES: Record<ZombieKind, ZombieDef> = {
  walker: {
    kind: 'walker', health: 100, wanderSpeed: [0.55, 0.9], chaseSpeed: [1.45, 2.15], damage: [11, 16],
    attackRange: 1.15, windup: 0.5, cooldown: 1.25, sightRange: 26, hearing: 1, radius: 0.3, height: 1.75,
    staggerAt: 34, turnRate: 4.2, bash: 0.14, girth: 1,
  },
  runner: {
    kind: 'runner', health: 70, wanderSpeed: [0.8, 1.1], chaseSpeed: [4.3, 5.2], damage: [8, 12],
    attackRange: 1.15, windup: 0.32, cooldown: 0.9, sightRange: 32, hearing: 1.2, radius: 0.3, height: 1.72,
    staggerAt: 26, turnRate: 7, bash: 0.12, girth: 0.92,
  },
  brute: {
    kind: 'brute', health: 420, wanderSpeed: [0.45, 0.6], chaseSpeed: [1.2, 1.5], damage: [28, 36],
    attackRange: 1.45, windup: 0.85, cooldown: 1.8, sightRange: 24, hearing: 0.9, radius: 0.38, height: 2.1,
    staggerAt: 120, turnRate: 2.4, bash: 0.5, girth: 1.22,
  },
  crawler: {
    // A walker that lost its legs before it found anyone: born crawling (see LEGS for its speeds).
    kind: 'crawler', health: 55, wanderSpeed: [0.3, 0.45], chaseSpeed: [0.85, 1.25], damage: [9, 13],
    attackRange: 0.85, windup: 0.4, cooldown: 1.0, sightRange: 18, hearing: 1.1, radius: 0.3, height: 1.75,
    staggerAt: 30, turnRate: 6, bash: 0.08, girth: 1,
  },
  screamer: {
    kind: 'screamer', health: 60, wanderSpeed: [0.7, 1.0], chaseSpeed: [2.5, 3.1], damage: [6, 9],
    attackRange: 1.1, windup: 0.38, cooldown: 1.0, sightRange: 36, hearing: 1.35, radius: 0.28, height: 1.8,
    staggerAt: 20, turnRate: 6.5, bash: 0.08, girth: 0.86,
  },
  bloater: {
    kind: 'bloater', health: 170, wanderSpeed: [0.4, 0.55], chaseSpeed: [1.05, 1.35], damage: [16, 22],
    attackRange: 1.35, windup: 0.75, cooldown: 1.7, sightRange: 22, hearing: 0.9, radius: 0.38, height: 1.86,
    staggerAt: 80, turnRate: 2.6, bash: 0.3, girth: 1.5,
  },
};

/** What makes the special zombies special. */
export const SPECIALS = {
  screamer: {
    /** Seconds in the scream state: it rears back, lets out the call at `callAt`, then recovers. */
    duration: 2.1,
    callAt: 0.75,
    /** Only screams at someone it can see between these distances. */
    minRange: 3.5,
    maxRange: 32,
    /** Seconds between screams; a scream cut short (staggered before the call) retries sooner. */
    cooldown: 15,
    interruptedCooldown: 4,
    /** Screams before it just hunts like any other. */
    maxScreams: 3,
    /** How far the scream is heard (noise radius), and how far the dead it calls come from. */
    noise: 70,
    callRadius: 55,
    /** Fresh dead that come running from out of sight per scream, and from how far. */
    reinforcements: [2, 3] as [number, number],
    reinforceDistance: [26, 48] as [number, number],
    /** Share of those that are runners. */
    reinforceRunners: 0.35,
    /** Called reinforcements alive at once, beyond the night's normal population. */
    reinforceCap: 8,
  },
  bloater: {
    /** Blast radius (m): full damage at the centre falling to `edge` of it at the rim. */
    radius: 5.2,
    edge: 0.2,
    /** Damage at the centre to survivors and to other zombies. */
    playerDamage: 75,
    zombieDamage: 260,
    /** Shove (m/s) given to zombies caught in it. */
    knock: 3.4,
    /** Arms caught in the blast inside this distance are torn off. */
    severWithin: 2.6,
    /** How far the bang carries. */
    noise: 36,
  },
} as const;

/** Spawner tuning: how many of the dead are out at once, and how that grows over a night. */
/** The dead that hold a place on the map (MapDefinition.garrisons): how many turn out. */
export const GARRISON = {
  /** For one survivor, and more for each teammate (never more than the place has posts). */
  base: 11,
  perPlayer: 3,
  /** Share of them that run. */
  runners: 0.22,
  /** The post (by index) a brute holds. */
  bruteAt: 5,
} as const;

export const SPAWNING = {
  /**
   * Population when the outbreak starts, and how it grows (for one survivor). Kept low on purpose:
   * the night starts with a handful and builds, so a lobby never meets a crowd in its first minutes.
   */
  basePopulation: 5,
  growthPerMinute: 1.5,
  /**
   * Hard cap on zombies alive at once, whatever the player count. Each one costs a lobby's server
   * about 0.3% of a core and every client ~45 bytes of each snapshot (server/tests/spawns.ts).
   */
  maxPopulation: 90,
  /**
   * Multiplier on the population target, the spawn rate and the brute cap by survivors alive,
   * index 0 for one survivor up to index 3 for four (more count as four).
   */
  playerScale: [1, 1.35, 1.65, 1.9] as readonly number[],
  /**
   * A bigger team's extra zombies ease in with time: the night opens with `start` of the extra
   * and reaches the full player scale `full` seconds into the outbreak.
   */
  teamRamp: { start: 0.4, full: 600 },
  /** Seconds between spawns while below target (divided by the team scale). */
  interval: [1.6, 3.4] as [number, number],
  /** The same while fewer than half the target are out (the first arrivals come in quicker). */
  fillInterval: 0.9,
  /** Never two spawns closer together than this, whatever the team or a horde surge. */
  minInterval: 0.45,
  minDistance: 42,
  maxDistance: 85,
  /** Zombies farther than this from every player, unaware of anyone, are recycled. */
  despawnDistance: 115,
  /** Corpses stay this long before sinking into the ground. */
  corpseTime: 30,
  /**
   * Share of new spawns per kind over survival time: each kind starts at `from` seconds with
   * `start` and grows linearly to `end` at `full` seconds. Walkers make up the rest.
   */
  mix: {
    runner: { from: 20, full: 360, start: 0.14, end: 0.26 },
    brute: { from: 60, full: 480, start: 0.07, end: 0.12 },
    screamer: { from: 75, full: 480, start: 0.04, end: 0.07 },
    bloater: { from: 45, full: 420, start: 0.05, end: 0.09 },
  },
  /** Brutes alive at once: `bruteBase` plus one more every `bruteEvery` seconds. */
  bruteBase: 1,
  bruteEvery: 150,
  /** Specials alive at once: the base plus one more every `specialEvery` seconds. */
  screamerBase: 1,
  bloaterBase: 2,
  specialEvery: 180,
} as const;

/**
 * Horde surges: every few minutes the town sends a wave, each bigger, longer and faster than the
 * last. The siren warns `warning` seconds ahead. Times are survival seconds after the outbreak.
 */
export const HORDES = {
  /**
   * First wave starts here; later waves come `gap` seconds apart, `gapShrink` less each time, down
   * to `minGap` (160, 148, 136, 124, then 120). The floor stays above the longest surge plus the
   * siren, so a wave is always over before the next siren.
   */
  firstAt: 150,
  gap: 160,
  gapShrink: 12,
  minGap: 120,
  warning: 25,
  /** Surge length: `duration` plus `durationGrowth` per wave after the first, up to `maxDuration`. */
  duration: 40,
  durationGrowth: 8,
  maxDuration: 90,
  /** Extra zombies over the base target (for one survivor; scaled by the team scale like the rest). */
  bonus: 6,
  bonusGrowth: 4,
  /**
   * Seconds between surge spawns while below the surge target (divided by the team scale, never
   * under SPAWNING.minInterval): a wave pours in over several seconds instead of all at once.
   */
  interval: 0.6,
  /** Extra runner share during a surge, plus this much more per wave, up to `maxRunnerBoost`. */
  runnerBoost: 0.1,
  runnerBoostGrowth: 0.03,
  maxRunnerBoost: 0.3,
  /** When a surge starts, every zombie within this many metres of a survivor hears them. */
  callRadius: 70,
  /** A supply drop comes this many seconds after a wave is survived (sooner if one is due). */
  dropAfter: 12,
} as const;

/**
 * Downtime: after every few minutes of fighting the dead fall back for a minute or two, announced
 * to everyone, so survivors can regroup, scavenge ammo and patch themselves up. The night's threat
 * clock (Simulation.threatTime: spawn growth, the zombie mix, horde waves, the van raid) stands
 * still while one is on, so the fight picks up where it left off. Rules: shared/src/sim/Lulls.ts.
 */
export const LULLS = {
  /**
   * Fighting seconds (threat clock) before the first lull is due, and from the start of one to the
   * next being due. One that falls due during a horde's siren or surge waits for the wave to be
   * over, and one never starts while the van raid is on.
   */
  every: 300,
  /** The first lull's length, `durationGrowth` longer with each one after, up to `maxDuration` (s). */
  duration: 60,
  durationGrowth: 15,
  maxDuration: 120,
  /** "Downtime ending" goes out this many seconds before the dead come back. */
  warning: 15,
  /**
   * While one is on, idle zombies farther than this from every survivor and out of everyone's
   * sight slip away (checked every `clearEvery` seconds). Ones already hunting someone keep
   * coming: the stragglers are the survivors' to deal with.
   */
  clearDistance: 40,
  clearEvery: 1.5,
  /** Afterwards the spawner climbs back from `returnStart` of its target to all of it over `returnTime` seconds. */
  returnStart: 0.35,
  returnTime: 45,
  /** A supply drop comes this many seconds into each lull (sooner if one is due anyway). */
  dropAfter: 8,
} as const;
