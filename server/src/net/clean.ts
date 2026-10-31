import {
  PRIMARY_WEAPONS, decodeAppearance, decodeLoadout, encodeAppearance, encodeLoadout, sanitizeLoadout, type Loadout, type UnlockState, type WeaponId,
} from '@dead-hours/shared';

/** A display name: printable, single-spaced, at most 20 characters ('' when nothing is left). */
export function cleanName(v: unknown, max = 20): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The look as the game would draw it (unknown parts fall back to defaults). */
export function cleanAppearance(v: unknown): string {
  return encodeAppearance(decodeAppearance(typeof v === 'string' ? v.slice(0, 400) : ''));
}

export function cleanPrimary(v: unknown): WeaponId {
  return PRIMARY_WEAPONS.includes(v as WeaponId) ? (v as WeaponId) : 'ar';
}

/** A browser's player key: random letters made by the client. */
export function cleanToken(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null;
}

/** Weapon builds as the player may use them: unknown or locked options go back to the defaults. */
export function cleanBuilds(v: unknown, u: UnlockState): Loadout {
  return sanitizeLoadout(decodeLoadout(typeof v === 'string' ? v.slice(0, 600) : ''), u);
}

export const cleanBuildsWire = (v: unknown, u: UnlockState): string => encodeLoadout(cleanBuilds(v, u));
