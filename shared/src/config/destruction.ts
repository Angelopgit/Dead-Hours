import type { PropKind } from '../types/world';

/** A prop with fuel in it: shot enough it catches fire, burns a moment, and blows up. */
export interface VolatileDef {
  /** Gunfire (damage points) it takes before it catches fire. */
  health: number;
  /** Share of a round's damage that counts (the truck's plate turns most of it). */
  armor: number;
  /** Seconds it burns before it goes up, from gunfire: [least, most]. */
  fuse: [number, number];
  /** The blast, against a frag grenade's (radius and damage both scale with it). */
  power: number;
  /** Patches of burning fuel it leaves, and how far they spread (m). */
  fire: number;
  spread: number;
  /** What it stands on when it is gone: a burnt-out shell that still blocks the way, or nothing. */
  shell: boolean;
  /** Middle of the body above the ground it stands on (m): where the blast comes from. */
  centre: number;
  /** Half its length and width (m), for how far a blast is from its bodywork. */
  hx: number;
  hz: number;
}

const CAR = { armor: 1, fire: 7, spread: 3.2, shell: true, centre: 0.85, hx: 2.25, hz: 0.95 };

/**
 * What blows up: every car, cruiser and wreck (parked or driven), the armored truck, the pumps at
 * the gas station and loose oil drums.
 */
export const VOLATILES: Partial<Record<PropKind, VolatileDef>> = {
  car: { ...CAR, health: 480, fuse: [3.2, 4.6], power: 1.25 },
  policeCar: { ...CAR, health: 560, fuse: [3.2, 4.6], power: 1.25 },
  wreckedCar: { ...CAR, health: 300, fuse: [2.4, 3.6], power: 1.05, fire: 5 },
  armoredTruck: { health: 1500, armor: 0.4, fuse: [4, 5.5], power: 1.5, fire: 9, spread: 4, shell: true, centre: 1.3, hx: 3.1, hz: 1.2 },
  pump: { health: 220, armor: 1, fuse: [1.6, 2.4], power: 1.3, fire: 8, spread: 3.4, shell: true, centre: 0.9, hx: 0.45, hz: 0.3 },
  oilDrum: { health: 70, armor: 1, fuse: [0.9, 1.6], power: 0.8, fire: 5, spread: 2.4, shell: false, centre: 0.45, hx: 0.3, hz: 0.3 },
};

/** How far along a volatile prop is: untouched, smoking, on fire, blown. */
export const VOLATILE_STAGE = { fine: 0, smoking: 1, burning: 2, blown: 3 } as const;

export const VOLATILE = {
  /** It starts to smoke with this share of its health left. */
  smoke: 0.55,
  /** A blast's damage to it: a frag's damage to a zombie at that distance, times this. */
  blast: 2.4,
  /** Set off by a blast it burns only this long (seconds): a row of cars goes up one after another. */
  chain: [0.3, 0.8] as [number, number],
  /** Each round into something already burning takes this much off its fuse (seconds). */
  hurry: 0.25,
  /** Damage to each survivor sitting in a car when it blows (they are thrown out). */
  occupant: 85,
  /** The spilled fuel burns this long (seconds). */
  burn: 14,
  /** Zombies hear something catch fire this far (m). */
  noise: 30,
} as const;

/**
 * Blowing holes in walls. A building's outer walls stand as bays (see map/builder BAY); each takes
 * blast until it is gone, and what a blast takes off one falls with its distance to the wall.
 * Rounds do nothing to a wall but mark it.
 */
export const BREACH = {
  /** How much of a bay a blast at the wall takes, by what blew up (1 goes through). */
  rocket: 1.5,
  frag: 0.5,
  /** Times the fuel blast's power: a car against the wall. */
  fuel: 0.6,
  /** In full within `core` metres of the wall, nothing past `reach`. */
  core: 0.5,
  reach: 1.7,
  /** Pillars against bays: a rocket still takes one, a grenade a third. */
  pillar: 0.7,
  /** How far a hole going is heard (m). */
  noise: 45,
  /** What a zombie's path pays to go through a hole (metres of walking). */
  pathCost: 1.5,
  /** Nav link ids of the holes: `linkBase + part`. */
  linkBase: 1 << 20,
} as const;

/** When a structure comes down, and what that does. */
export const COLLAPSE = {
  /** Share of the ground-storey bays gone that brings a building down. */
  walls: 0.34,
  /** Share of its pillars (the water tower's legs, the canopy's posts), and never fewer than this many. */
  pillars: 0.5,
  leastPillars: 2,
  /** A building's own columns (a portico, an awning's posts): all of them gone is this much of the way to falling. */
  porch: 0.5,
  /** Seconds it groans before it goes, once it has lost too much. */
  warn: 2.2,
  /** Hurt to a survivor inside or under it when it lands. */
  crush: 80,
  /** How far it is heard (m). */
  noise: 80,
} as const;

export const STRUCTURE_STATE = { standing: 0, going: 1, fallen: 2 } as const;
