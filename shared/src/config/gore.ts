import type { WeaponId } from './weapons';

/** Guns whose rounds throw bodies and blow heads apart (melee and blasts have their own numbers). */
export type GoreGun = Extract<WeaponId, 'ar' | 'smg' | 'shotgun' | 'marksman' | 'pistol' | 'lmg' | 'battle' | 'sniper' | 'wraith' | 'akimbo'>;

/**
 * How hard rounds hit bodies, by gun: how far a kill throws the corpse, how far a hit shoves a
 * living zombie, how much meat and blood comes out, and when a head comes apart. The simulation
 * decides throws and head pops (they go out in zombieDied, so every screen shows the same death);
 * the client sizes blood, chunks and sound from `power`.
 */
export const GORE = {
  /**
   * Speed a killing round throws the body at, m/s at the centre of mass (before range falloff).
   * Shotguns and the big rifles knock the dead off their feet; a pistol just drops them.
   */
  throw: { pistol: 1.9, akimbo: 1.9, smg: 1.7, ar: 2.5, lmg: 2.7, battle: 3.6, marksman: 4.4, shotgun: 5.6, wraith: 5.8, sniper: 7.2 } as Record<GoreGun, number>,
  /** Share of the throw that goes upward (off the ground). */
  lift: { pistol: 0.12, akimbo: 0.12, smg: 0.1, ar: 0.14, lmg: 0.14, battle: 0.2, marksman: 0.24, shotgun: 0.3, wraith: 0.28, sniper: 0.32 } as Record<GoreGun, number>,
  /** zombieDied.force is the throw divided by this (melee and blasts use the same scale). */
  forceSpeed: 2.6,
  /** Shotgun throws only carry their full weight up close: full within `near` m, `farShare` of it at `far`. */
  shotgunNear: 5,
  shotgunFar: 16,
  shotgunFarShare: 0.3,
  /**
   * How far a hit that staggers a living zombie shoves it (m/s at the start of the stagger), and
   * for the shotgun the whole volley's damage that always staggers it (within shotgunNear).
   */
  knock: { pistol: 0.7, akimbo: 0.7, smg: 0.6, ar: 0.9, lmg: 1, battle: 1.4, marksman: 1.8, shotgun: 3.2, wraith: 2.2, sniper: 2.8 } as Record<GoreGun, number>,
  shotgunStagger: 40,
  /**
   * A killing head shot doing this much damage blows the head apart: battle rifle, marksman, .338 and
   * .50 head shots always do; pistols, SMGs and rifles never.
   */
  popDamage: 100,
  /** A shotgun volley up close pops the head with this share of popDamage in it (two pellets), whichever pellet killed. */
  shotgunPop: 0.75,
  /** Blood, meat and sound per hit, 0..1.5 (scales the client's sprays, chunks and flesh layers). */
  power: { pistol: 0.4, akimbo: 0.4, smg: 0.32, ar: 0.55, lmg: 0.6, battle: 0.85, marksman: 1, shotgun: 0.5, wraith: 1.25, sniper: 1.5 } as Record<GoreGun, number>,
} as const;

/** True for guns with gore numbers (every firearm but the rocket launcher, which blasts). */
export const isGoreGun = (id: string): id is GoreGun => id in GORE.throw;

/** Range falloff of a shotgun's throw and shove: 1 up close down to farShare at `far`. */
export function shotgunReach(dist: number): number {
  const G = GORE;
  if (dist <= G.shotgunNear) return 1;
  const u = Math.min(1, (dist - G.shotgunNear) / (G.shotgunFar - G.shotgunNear));
  return 1 - (1 - G.shotgunFarShare) * u;
}
