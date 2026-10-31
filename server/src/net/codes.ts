import type { Presence } from 'colyseus';

/** Letters and digits that can't be mistaken for each other when read out (no I, O, 0, 1). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 5;
/**
 * Codes are kept in presence (Redis when several servers share the games), so any server can
 * find any game's room. They expire unless renewed, so a server that dies leaves none behind.
 */
export const CODE_TTL = 3600;
const key = (code: string) => `dh:code:${code}`;

/** A fresh join code for a room. */
export async function claimCode(presence: Presence, roomId: string): Promise<string> {
  for (;;) {
    let code = '';
    for (let i = 0; i < LENGTH; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    // The first to count a code owns it.
    if (await presence.incr(`${key(code)}:claim`) === 1) {
      await Promise.all([presence.setex(key(code), roomId, CODE_TTL), presence.expire(`${key(code)}:claim`, CODE_TTL)]);
      return code;
    }
  }
}

/** Keeps a live room's code from expiring. */
export async function renewCode(presence: Presence, code: string): Promise<void> {
  await Promise.all([presence.expire(key(code), CODE_TTL), presence.expire(`${key(code)}:claim`, CODE_TTL)]);
}

export async function releaseCode(presence: Presence, code: string): Promise<void> {
  await Promise.all([presence.del(key(code)), presence.del(`${key(code)}:claim`)]);
}

/** The room a code belongs to (codes are typed in any case, with or without spaces). */
export async function roomForCode(presence: Presence, code: string): Promise<string | null> {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== LENGTH) return null;
  return (await presence.get(key(clean))) ?? null;
}
