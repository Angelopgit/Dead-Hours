export type WeaponSlot = 'primary' | 'secondary' | 'melee';
export type WeaponId = 'ar' | 'smg' | 'shotgun' | 'marksman' | 'pistol' | 'machete' | 'lmg' | 'battle' | 'sniper';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  model: string;
  slot: WeaponSlot;
  description: string;
  damage: number;
  pellets: number;
  /** Rounds per minute. */
  fireRate: number;
  magazine: number;
  startReserve: number;
  reloadTime: number;
  /** Degrees of spread when hip firing / aiming. */
  hipSpread: number;
  aimSpread: number;
  recoil: number;
  range: number;
  auto: boolean;
  /** HUD fire mode label. */
  mode: 'AUTO' | 'SEMI' | 'PUMP' | 'MELEE';
  /** Zombies hear the shot within this many meters. */
  noise: number;
  /** Seconds to draw the weapon. */
  draw: number;
  /** Zombies a round can pass through (each costs damage). */
  penetration: number;
  /** Shells loaded one at a time (shotgun): reloadTime is the time for a full tube. */
  perShell?: boolean;
  /** Carry limit for reserve ammunition. */
  maxReserve: number;
  /** Magazines an ammunition crate hands out (default COMBAT.crateMagsPrimary). */
  crateMags?: number;
  /** Only found in supply drops: never on the loadout screen or a weapon table. */
  exclusive?: boolean;
  /** How the model is held: two-handed long gun, pistol, or blade. */
  hold: 'rifle' | 'pistol' | 'melee';
  /** 0..1 summary bars for the loadout screen. */
  stats: { damage: number; fireRate: number; handling: number; range: number };
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  ar: {
    id: 'ar', name: 'Assault Rifle', model: 'M4A1', slot: 'primary',
    description: 'Balanced damage, medium recoil, moderate ammunition.',
    damage: 30, pellets: 1, fireRate: 700, magazine: 30, startReserve: 150, reloadTime: 2.3,
    hipSpread: 3.2, aimSpread: 0.6, recoil: 0.55, range: 120, auto: true,
    mode: 'AUTO', noise: 70, draw: 0.55, penetration: 0, maxReserve: 240, hold: 'rifle',
    stats: { damage: 0.6, fireRate: 0.7, handling: 0.6, range: 0.7 },
  },
  smg: {
    id: 'smg', name: 'Submachine Gun', model: 'MP5', slot: 'primary',
    description: 'High fire rate, low damage, excellent close-range handling.',
    damage: 19, pellets: 1, fireRate: 900, magazine: 32, startReserve: 192, reloadTime: 1.9,
    hipSpread: 2.6, aimSpread: 1.0, recoil: 0.35, range: 60, auto: true,
    mode: 'AUTO', noise: 55, draw: 0.45, penetration: 0, maxReserve: 288, hold: 'rifle',
    stats: { damage: 0.35, fireRate: 0.95, handling: 0.9, range: 0.4 },
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun', model: 'M870', slot: 'primary',
    description: 'Devastating close-range damage, slow reload, limited ammunition.',
    damage: 16, pellets: 9, fireRate: 75, magazine: 6, startReserve: 30, reloadTime: 3.6,
    hipSpread: 6.5, aimSpread: 4.5, recoil: 1.4, range: 25, auto: false,
    mode: 'PUMP', noise: 75, draw: 0.6, penetration: 0, perShell: true, maxReserve: 48, hold: 'rifle',
    stats: { damage: 0.95, fireRate: 0.2, handling: 0.5, range: 0.2 },
  },
  marksman: {
    id: 'marksman', name: 'Marksman Rifle', model: 'MK14 EBR', slot: 'primary',
    description: 'High precision and damage with a slow rate of fire.',
    damage: 85, pellets: 1, fireRate: 150, magazine: 10, startReserve: 50, reloadTime: 2.8,
    hipSpread: 4.5, aimSpread: 0.15, recoil: 1.1, range: 200, auto: false,
    mode: 'SEMI', noise: 85, draw: 0.65, penetration: 1, maxReserve: 80, hold: 'rifle',
    stats: { damage: 0.85, fireRate: 0.3, handling: 0.35, range: 1 },
  },
  pistol: {
    id: 'pistol', name: 'Pistol', model: 'M17', slot: 'secondary',
    description: 'Reliable sidearm for when the primary runs dry.',
    damage: 24, pellets: 1, fireRate: 360, magazine: 15, startReserve: 60, reloadTime: 1.5,
    hipSpread: 2.2, aimSpread: 0.8, recoil: 0.5, range: 50, auto: false,
    mode: 'SEMI', noise: 50, draw: 0.35, penetration: 0, maxReserve: 105, hold: 'pistol',
    stats: { damage: 0.4, fireRate: 0.5, handling: 0.85, range: 0.45 },
  },
  machete: {
    id: 'machete', name: 'Machete', model: 'Machete', slot: 'melee',
    description: 'Silent. Never runs out of ammunition.',
    damage: 55, pellets: 1, fireRate: 80, magazine: 0, startReserve: 0, reloadTime: 0,
    hipSpread: 0, aimSpread: 0, recoil: 0, range: 2, auto: false,
    mode: 'MELEE', noise: 5, draw: 0.3, penetration: 0, maxReserve: 0, hold: 'melee',
    stats: { damage: 0.6, fireRate: 0.25, handling: 0.7, range: 0.05 },
  },
  // Supply drop exclusives: rare finds that outclass the loadout guns at a price in handling.
  lmg: {
    id: 'lmg', name: 'Light Machine Gun', model: 'M249 SAW', slot: 'primary', exclusive: true,
    description: 'A 100-round belt of 5.56 mm. Holds a street on its own, slow to reload and to raise.',
    damage: 31, pellets: 1, fireRate: 800, magazine: 100, startReserve: 200, reloadTime: 5.4,
    hipSpread: 4.4, aimSpread: 0.95, recoil: 0.6, range: 115, auto: true,
    mode: 'AUTO', noise: 80, draw: 0.95, penetration: 0, maxReserve: 400, crateMags: 1, hold: 'rifle',
    stats: { damage: 0.6, fireRate: 0.85, handling: 0.2, range: 0.7 },
  },
  battle: {
    id: 'battle', name: 'Battle Rifle', model: 'SCAR-H', slot: 'primary', exclusive: true,
    description: 'Full-auto 7.62 mm: drops anything in two or three rounds and punches through.',
    damage: 50, pellets: 1, fireRate: 600, magazine: 20, startReserve: 100, reloadTime: 2.5,
    hipSpread: 3.4, aimSpread: 0.45, recoil: 0.85, range: 150, auto: true,
    mode: 'AUTO', noise: 78, draw: 0.6, penetration: 1, maxReserve: 180, hold: 'rifle',
    stats: { damage: 0.75, fireRate: 0.65, handling: 0.5, range: 0.85 },
  },
  sniper: {
    id: 'sniper', name: '.50 Cal Sniper', model: 'M107 .50 CAL', slot: 'primary', exclusive: true,
    description: 'Very rare. One .50 BMG round goes through a line of the dead; a head shot drops a brute.',
    damage: 270, pellets: 1, fireRate: 55, magazine: 10, startReserve: 30, reloadTime: 3.8,
    hipSpread: 7.5, aimSpread: 0.05, recoil: 2.2, range: 320, auto: false,
    mode: 'SEMI', noise: 120, draw: 1.0, penetration: 4, maxReserve: 50, hold: 'rifle',
    stats: { damage: 1, fireRate: 0.12, handling: 0.15, range: 1 },
  },
};

export const PRIMARY_WEAPONS: WeaponId[] = ['ar', 'smg', 'shotgun', 'marksman'];
export const SECONDARY_WEAPONS: WeaponId[] = ['pistol'];
/** Primaries that only come out of supply drops. */
export const EXCLUSIVE_WEAPONS: WeaponId[] = ['lmg', 'battle', 'sniper'];

/** Hit zones on a zombie and their damage multipliers. */
export type HitZone = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR';

export const ZONE_MULTIPLIER: Record<HitZone, number> = {
  head: 2.5, torso: 1, armL: 0.6, armR: 0.6, legL: 0.7, legR: 0.7,
};

/** Combat tuning shared by the client and the server. */
export const COMBAT = {
  /** Seconds to blend into aim (spread follows this, not the camera). */
  aimTime: 0.22,
  /** Damage stays full to this fraction of range, then falls to `falloffMin` at full range. */
  falloffStart: 0.5,
  falloffMin: 0.5,
  /** Bullets travel this multiple of range, at a quarter damage past range. */
  maxRangeFactor: 1.6,
  /** Fire is refused if the claimed origin is farther than this from the shooter's eye. */
  maxOriginOffset: 4.6,
  meleeWindup: 0.16,
  meleeDuration: 0.55,
  meleeArc: 1.25,
  meleeKnockback: 2.2,
  bandageTime: 2.6,
  bandageHeal: 40,
  maxBandages: 3,
  startBandages: 2,
  /** Ammunition crate: rounds handed out per use, as magazines. */
  crateMagsPrimary: 2,
  crateMagsSecondary: 1,
  crateUses: 2,
  /** First aid boxes hold this many bandages. */
  aidBoxBandages: 2,
  interactRange: 1.8,
} as const;
