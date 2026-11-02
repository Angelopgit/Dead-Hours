import { LULLS } from '../config/zombies';
import { hordeAt } from './Hordes';

/**
 * Where the night is with its lulls (Simulation.lull). Online clients get it in every snapshot and
 * work the threat clock out from it and the mirrored survival time.
 */
export interface LullState {
  /** Lulls begun so far: the latest is the one running, or the last one over. */
  count: number;
  /** Survival seconds the latest lull started and ends at (both 0 before the first). */
  start: number;
  end: number;
  /** Survival seconds spent in the lulls before the latest one. */
  paused: number;
}

export function noLulls(): LullState {
  return { count: 0, start: 0, end: 0, paused: 0 };
}

/** How long lull `n` (1-based) lasts. */
export function lullDuration(n: number): number {
  return Math.min(LULLS.maxDuration, LULLS.duration + LULLS.durationGrowth * (n - 1));
}

/** Whether a lull is on at survival second `t`. */
export function inLull(l: LullState, t: number): boolean {
  return l.count > 0 && t >= l.start && t < l.end;
}

/**
 * The threat clock at survival second `t`: survival time with the lulls taken out, so it stands
 * still while one is on. Spawn growth, the zombie mix, the horde schedule and the raid run on it.
 */
export function threatAt(l: LullState, t: number): number {
  const current = l.count > 0 ? Math.min(Math.max(0, t - l.start), l.end - l.start) : 0;
  return Math.max(0, t - l.paused - current);
}

/**
 * The first threat second at or after `due` with no horde siren or surge under way: when a lull
 * that fell due then begins (the van raid can hold it longer; the simulation checks that itself).
 */
export function lullOpening(due: number): number {
  let t = due;
  for (let i = 0; i < 1000; i++) {
    const h = hordeAt(t);
    if (h.stage === 'calm') return t;
    t = h.end;
  }
  return t;
}

/** Survival seconds left in the current lull (0 when none is on). */
export function lullLeft(l: LullState, t: number): number {
  return inLull(l, t) ? l.end - t : 0;
}
