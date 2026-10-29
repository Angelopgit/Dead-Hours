export type WeaponSlot = 'primary' | 'secondary' | 'melee';
export type WeaponId = 'ar' | 'smg' | 'shotgun' | 'marksman' | 'pistol' | 'machete';

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
  /** 0..1 summary bars for the loadout screen. */
  stats: { damage: number; fireRate: number; handling: number; range: number };
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  ar: {
    id: 'ar', name: 'Assault Rifle', model: 'M4A1', slot: 'primary',
    description: 'Balanced damage, medium recoil, moderate ammunition.',
    damage: 30, pellets: 1, fireRate: 700, magazine: 30, startReserve: 150, reloadTime: 2.3,
    hipSpread: 3.2, aimSpread: 0.6, recoil: 0.55, range: 120, auto: true,
    stats: { damage: 0.6, fireRate: 0.7, handling: 0.6, range: 0.7 },
  },
  smg: {
    id: 'smg', name: 'Submachine Gun', model: 'MP5', slot: 'primary',
    description: 'High fire rate, low damage, excellent close-range handling.',
    damage: 19, pellets: 1, fireRate: 900, magazine: 32, startReserve: 192, reloadTime: 1.9,
    hipSpread: 2.6, aimSpread: 1.0, recoil: 0.35, range: 60, auto: true,
    stats: { damage: 0.35, fireRate: 0.95, handling: 0.9, range: 0.4 },
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun', model: 'M870', slot: 'primary',
    description: 'Devastating close-range damage, slow reload, limited ammunition.',
    damage: 16, pellets: 9, fireRate: 75, magazine: 6, startReserve: 30, reloadTime: 3.6,
    hipSpread: 6.5, aimSpread: 4.5, recoil: 1.4, range: 25, auto: false,
    stats: { damage: 0.95, fireRate: 0.2, handling: 0.5, range: 0.2 },
  },
  marksman: {
    id: 'marksman', name: 'Marksman Rifle', model: 'MK14 EBR', slot: 'primary',
    description: 'High precision and damage with a slow rate of fire.',
    damage: 85, pellets: 1, fireRate: 150, magazine: 10, startReserve: 50, reloadTime: 2.8,
    hipSpread: 4.5, aimSpread: 0.15, recoil: 1.1, range: 200, auto: false,
    stats: { damage: 0.85, fireRate: 0.3, handling: 0.35, range: 1 },
  },
  pistol: {
    id: 'pistol', name: 'Pistol', model: 'M17', slot: 'secondary',
    description: 'Reliable sidearm for when the primary runs dry.',
    damage: 24, pellets: 1, fireRate: 360, magazine: 15, startReserve: 60, reloadTime: 1.5,
    hipSpread: 2.2, aimSpread: 0.8, recoil: 0.5, range: 50, auto: false,
    stats: { damage: 0.4, fireRate: 0.5, handling: 0.85, range: 0.45 },
  },
  machete: {
    id: 'machete', name: 'Machete', model: 'Machete', slot: 'melee',
    description: 'Silent. Never runs out of ammunition.',
    damage: 55, pellets: 1, fireRate: 80, magazine: 0, startReserve: 0, reloadTime: 0,
    hipSpread: 0, aimSpread: 0, recoil: 0, range: 2, auto: false,
    stats: { damage: 0.6, fireRate: 0.25, handling: 0.7, range: 0.05 },
  },
};

export const PRIMARY_WEAPONS: WeaponId[] = ['ar', 'smg', 'shotgun', 'marksman'];
export const SECONDARY_WEAPONS: WeaponId[] = ['pistol'];
