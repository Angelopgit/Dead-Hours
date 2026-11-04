/**
 * Boost syringes: a few autoinjectors left lying about inside the houses each night (on kitchen
 * counters, dressers, desks, bathroom sinks...). Each holds one dose of something that helps for
 * a while: injected, its effect lasts `duration` seconds. The first survivor to grab one has it.
 */

export type BoostId = 'strength' | 'stamina' | 'reload' | 'regen' | 'focus';

/** Wire order (append only: older clients read new numbers otherwise). */
export const BOOST_IDS: BoostId[] = ['strength', 'stamina', 'reload', 'regen', 'focus'];

export interface BoostDef {
  /** What the syringe is called (prompts, notices). */
  name: string;
  /** Its short HUD label. */
  short: string;
  /** What it does, in a line. */
  blurb: string;
  /** The dose's colour (the liquid, the cap, the HUD chip). */
  color: number;
  /** Seconds it lasts once injected. */
  duration: number;
}

export const BOOSTS = {
  /** The dead's hits do `damageTaken` of their damage; melee blows land `meleeDamage` times as hard. */
  strength: {
    name: 'Strength shot', short: 'STRENGTH', blurb: 'The dead hit you half as hard and your swings hit harder',
    color: 0xd8443a, duration: 75, damageTaken: 0.5, meleeDamage: 1.4,
  },
  /** Walking and sprinting speed up; firing or swinging holds the sprint back for `sprintBlock` as long. */
  stamina: {
    name: 'Stamina shot', short: 'STAMINA', blurb: 'Run faster and sprint again straight after firing',
    color: 0xe8b72e, duration: 90, walk: 1.15, sprint: 1.3, sprintBlock: 0.35,
  },
  /** Reloads take `reloadScale` of their time (magazines and shell by shell alike). */
  reload: {
    name: 'Rapid reload shot', short: 'RAPID RELOAD', blurb: 'Reload twice as fast',
    color: 0x3c8ee6, duration: 90, reloadScale: 0.5,
  },
  /** Heals `heal` health a second while on your feet. */
  regen: {
    name: 'Regen shot', short: 'REGEN', blurb: 'Heals 2.5 health a second',
    color: 0x46c46a, duration: 40, heal: 2.5,
  },
  /** Spread and recoil bloom shrink to `spread`; the camera kicks `recoil` as hard. */
  focus: {
    name: 'Focus shot', short: 'FOCUS', blurb: 'Half the spread and recoil',
    color: 0xa46ae6, duration: 75, spread: 0.5, recoil: 0.5,
  },
} as const satisfies Record<BoostId, BoostDef & Record<string, unknown>>;

/** The injection itself: the gun goes down, the needle goes in `press` seconds in, then the gun comes back up. */
export const INJECT = {
  duration: 1.15,
  press: 0.62,
} as const;

/** Where and how many syringes lie about. */
export const BOOST_PICKUPS = {
  /** How many each night (random in the range, all different kinds). The map is kept at that many. */
  count: [4, 5] as [number, number],
  /** At most one per house. */
  perHouse: 1,
  /** A taken one is replaced in another house after this long (seconds, random in the range). */
  respawn: [150, 240] as [number, number],
  /** Not put down within this distance of a living survivor (no popping in under their nose). */
  awayFromPlayers: 14,
  /** Houses this close to a survivor spawn (the safehouse) are left empty. */
  awayFromSpawn: 16,
  /** Interact reach (from the chest), and how high above the surface its reach point sits. */
  range: 1.6,
  lift: 0.03,
  /** The same boost already running with more than this share of its time left: no second dose yet. */
  refreshBelow: 0.5,
} as const;

/** Seconds of a boost a survivor has left (0 when it is not running). */
export function boostLeft(boosts: Partial<Record<BoostId, number>>, id: BoostId, now: number): number {
  return Math.max(0, (boosts[id] ?? 0) - now);
}
