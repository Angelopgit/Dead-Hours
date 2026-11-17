import { COMBAT, GAME, type PlayerStats } from '@dead-hours/shared';

const STAT_KEYS: (keyof PlayerStats)[] = ['kills', 'headshots', 'shotsFired', 'shotsHit', 'damageDealt', 'suppliesCollected', 'damageTaken', 'limbsSevered', 'limbKills'];

/** A run with nothing in it. */
export const NO_STATS: PlayerStats = { ...Object.fromEntries(STAT_KEYS.map((k) => [k, 0])), revives: 0, goals: 0 } as PlayerStats;

/**
 * A run as a browser reports it: a solo night, or a night hosted on a player's own device. Those
 * run in a player's browser, so they can't be proven the way the server's own nights are; they
 * are held to what a real run could reach and marked SOLO or HOSTED on the boards.
 */
export function plausibleRun(body: unknown): { survived: number; stats: PlayerStats } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { survived?: unknown; stats?: Record<string, unknown> };
  const survived = b.survived;
  if (typeof survived !== 'number' || !Number.isFinite(survived) || survived < 0 || survived > 6 * 3600) return null;
  if (!b.stats || typeof b.stats !== 'object') return null;
  const stats = {} as PlayerStats;
  for (const k of STAT_KEYS) {
    const v = b.stats[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e7) return null;
    stats[k] = k === 'damageDealt' || k === 'damageTaken' ? Math.round(v) : Math.floor(v);
  }
  // Night goals came later: older clients leave them out.
  const goals = b.stats.goals;
  stats.goals = typeof goals === 'number' && Number.isFinite(goals) ? Math.max(0, Math.min(3, Math.floor(goals))) : 0;
  const played = survived + GAME.preparationSeconds + 5;
  // Teammates picked up (none alone): each takes a few seconds of holding.
  const revives = b.stats.revives;
  stats.revives = typeof revives === 'number' && Number.isFinite(revives) ? Math.max(0, Math.min(Math.floor(played / 4), Math.floor(revives))) : 0;
  if (stats.kills > 3 + survived * 1.5) return null;
  if (stats.headshots > stats.kills || stats.limbKills > stats.kills || stats.shotsHit > stats.shotsFired) return null;
  if (stats.shotsFired > played * 16) return null;
  if (stats.limbsSevered > stats.kills * 2 + 6) return null;
  if (stats.suppliesCollected > played / 2 + COMBAT.crateUses * 20) return null;
  return { survived, stats };
}
