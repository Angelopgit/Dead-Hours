import { HORDES } from '../config/zombies';

/** Where the night is in the horde schedule at some survival time. */
export interface HordeState {
  /** The wave this refers to: the one coming (calm/warning) or the one under way (surge). 1-based. */
  wave: number;
  stage: 'calm' | 'warning' | 'surge';
  /** Survival seconds when that wave starts and ends. */
  start: number;
  end: number;
  /** Waves already over. */
  survived: number;
}

/** Survival second wave `n` (1-based) starts at. */
export function hordeStart(n: number): number {
  let t = HORDES.firstAt;
  for (let i = 1; i < n; i++) t += Math.max(HORDES.minGap, HORDES.gap - HORDES.gapShrink * (i - 1));
  return t;
}

export function hordeDuration(n: number): number {
  return Math.min(HORDES.maxDuration, HORDES.duration + HORDES.durationGrowth * (n - 1));
}

/** Extra zombies over the base target during wave `n`, for one survivor. */
export function hordeBonus(n: number): number {
  return HORDES.bonus + HORDES.bonusGrowth * (n - 1);
}

export function hordeRunnerBoost(n: number): number {
  return Math.min(HORDES.maxRunnerBoost, HORDES.runnerBoost + HORDES.runnerBoostGrowth * (n - 1));
}

/**
 * The schedule is fixed by survival time alone, so clients work it out from the mirrored clock
 * without anything extra on the wire.
 */
export function hordeAt(survived: number): HordeState {
  let n = 1;
  for (;;) {
    const start = hordeStart(n);
    const end = start + hordeDuration(n);
    if (survived < end) {
      const stage = survived >= start ? 'surge' : survived >= start - HORDES.warning ? 'warning' : 'calm';
      return { wave: n, stage, start, end, survived: n - 1 };
    }
    n++;
  }
}
