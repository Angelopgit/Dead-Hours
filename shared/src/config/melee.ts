import type { WeaponId } from './weapons';

/** Melee weapons: the machete every survivor starts with, and the ones found lying around indoors. */
export type MeleeId = 'machete' | 'katana' | 'bat' | 'crowbar' | 'wrench' | 'hockey'
  /** Two katanas, one in each hand (pick up a second katana while carrying one). */
  | 'katanas';

/** How a weapon is swung (the animation and the whoosh): one-handed chop, two-handed cut, bat swing, overhead tool blow. */
export type MeleeStyle = 'blade' | 'katana' | 'club' | 'tool' | 'dual';

/** What it is made of (what a hit sounds like). */
export type MeleeMaterial = 'steel' | 'katana' | 'wood' | 'iron' | 'composite';

export interface MeleeDef {
  id: MeleeId;
  /** Damage of a clean torso hit on the first zombie it meets. */
  damage: number;
  /** The blow lands `windup` seconds in; the whole swing takes `duration`. */
  windup: number;
  duration: number;
  /** Reach from the survivor's centre, metres, and the arc it sweeps, radians. */
  reach: number;
  arc: number;
  /** Zombies one swing can connect with, and the share of damage the ones after the first take. */
  targets: number;
  share: number;
  /** Head hit multiplier (blunt weapons cave skulls in). */
  head: number;
  /** How far the blow shoves a zombie back (stagger push). */
  knockback: number;
  /**
   * Edged weapons count this much of their damage toward taking an arm off (0: blunt, it bruises
   * and breaks but never cuts). See LIMBS.armHealth.
   */
  sever: number;
  /** Zombies hear the swing landing within this many metres. */
  noise: number;
  style: MeleeStyle;
  material: MeleeMaterial;
  /** Sprint is held off this long after a swing starts. */
  recover: number;
}

/**
 * Melee tuning. The machete keeps the numbers it always had. The katana cuts cleanest and
 * takes arms off far quicker; the bat and the hockey stick sweep several zombies back; the
 * crowbar and the wrench are short, brutal and best at heads.
 */
export const MELEE: Record<MeleeId, MeleeDef> = {
  machete: {
    id: 'machete', damage: 55, windup: 0.16, duration: 0.55, reach: 2.0, arc: 1.25, targets: 2, share: 0.6,
    head: 1.4, knockback: 2.2, sever: 1.5, noise: 5, style: 'blade', material: 'steel', recover: 0.6,
  },
  katana: {
    id: 'katana', damage: 78, windup: 0.19, duration: 0.62, reach: 2.45, arc: 1.7, targets: 3, share: 0.7,
    head: 1.6, knockback: 1.8, sever: 2.8, noise: 4, style: 'katana', material: 'katana', recover: 0.6,
  },
  bat: {
    id: 'bat', damage: 52, windup: 0.3, duration: 0.82, reach: 2.3, arc: 1.75, targets: 3, share: 0.75,
    head: 1.9, knockback: 4.4, sever: 0, noise: 9, style: 'club', material: 'wood', recover: 0.85,
  },
  crowbar: {
    id: 'crowbar', damage: 60, windup: 0.24, duration: 0.68, reach: 2.05, arc: 1.3, targets: 2, share: 0.6,
    head: 2.1, knockback: 3.0, sever: 0, noise: 8, style: 'tool', material: 'iron', recover: 0.7,
  },
  wrench: {
    id: 'wrench', damage: 48, windup: 0.2, duration: 0.56, reach: 1.85, arc: 1.15, targets: 1, share: 0,
    head: 2.3, knockback: 2.8, sever: 0, noise: 7, style: 'tool', material: 'iron', recover: 0.6,
  },
  // A blade in each hand, struck in turn: quicker than one katana, each cut a little lighter,
  // sweeping wider and taking limbs off just as clean.
  katanas: {
    id: 'katanas', damage: 66, windup: 0.14, duration: 0.44, reach: 2.4, arc: 2.0, targets: 3, share: 0.75,
    head: 1.6, knockback: 1.6, sever: 2.8, noise: 4, style: 'dual', material: 'katana', recover: 0.45,
  },
  hockey: {
    id: 'hockey', damage: 40, windup: 0.22, duration: 0.64, reach: 2.65, arc: 1.95, targets: 3, share: 0.8,
    head: 1.5, knockback: 4.8, sever: 0, noise: 7, style: 'club', material: 'composite', recover: 0.7,
  },
};

/** The melee weapons that turn up lying around (never in a loadout). */
export const FOUND_MELEE: MeleeId[] = ['katana', 'bat', 'crowbar', 'wrench', 'hockey'];

export function isMelee(id: WeaponId | string): id is MeleeId {
  return id in MELEE;
}

/** Where a found weapon lies: a bedroom, a basement, or the gas station's store. */
export type MeleeRoom = 'bedroom' | 'basement' | 'store';

/** Found melee weapons: how many lie about, where, and how often a taken one is replaced. */
export const MELEE_PICKUPS = {
  /** Never more than this many lying on the map at once. */
  maxPlaced: 7,
  /** A katana put down has this chance of a second one lying beside it (a pair to dual wield). */
  pairChance: 0.45,
  /** At most this many in one room (the store is bigger: two). */
  perRoom: { bedroom: 1, basement: 1, store: 2 } as Record<MeleeRoom, number>,
  /** A taken one is replaced somewhere else after this long (seconds, random in the range). */
  respawn: [100, 170] as [number, number],
  /** Not put down within this distance of a living survivor (no popping in under their nose). */
  awayFromPlayers: 14,
  /** Rooms this close to a survivor spawn (the safehouse) are left empty. */
  awayFromSpawn: 16,
  /** A bed's room: floor this close to the bed, metres. */
  bedRoom: 2.6,
  /** Interact reach, and how high above the floor its reach point sits. */
  range: 1.9,
  lift: 0.45,
  /**
   * What turns up where (relative odds per room). Katanas hang on bedroom walls and get boxed up
   * in basements; tools lie about basements and the store's back room.
   */
  odds: {
    bedroom: { katana: 3, bat: 4, crowbar: 1, wrench: 0.5, hockey: 3 },
    basement: { katana: 1.5, bat: 3, crowbar: 3, wrench: 3, hockey: 2.5 },
    store: { katana: 0.3, bat: 3, crowbar: 3, wrench: 4, hockey: 1 },
  } as Record<MeleeRoom, Partial<Record<MeleeId, number>>>,
} as const;
