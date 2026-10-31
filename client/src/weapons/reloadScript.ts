import type { FoleyKind } from '../audio/GunSynth';

/**
 * The sounds of each gun's reload, placed on the hand animation in PlayerWeapon (its keyframes, as
 * 0..1 through the reload: rifles reach the magazine at 0.16, stow it in the pouch at 0.42, leave
 * the pouch at 0.52, seat the new one at 0.74 and reach the bolt at 0.86; pistols reach the
 * magazine at 0.15, the pouch 0.35 to 0.5, seat at 0.66, the slide at 0.8). Shell-by-shell guns run
 * their list once per shell. A reload from empty is 0.35 s longer and sends the bolt home; with a
 * round still chambered (a tactical reload) it doesn't.
 */
export interface ReloadStep {
  cue: FoleyKind;
  /** When its main hit lands, 0..1 through the reload (or through the shell). */
  at: number;
  /** Seconds after `at` (an empty magazine landing on the floor). */
  delay?: number;
  /** Only on a reload from empty, or only with a round still in the chamber. */
  only?: 'empty' | 'tactical';
}

/** Rifle magazines: out (the right hand works the release as the left arrives), into the pouch, a fresh one out. */
const rifleSwap = (): ReloadStep[] => [
  { cue: 'magOut', at: 0.2 },
  { cue: 'pouch', at: 0.43 },
  { cue: 'pouchGrab', at: 0.53 },
  { cue: 'magIn', at: 0.74 },
];

export const RELOAD_STEPS: Record<string, ReloadStep[]> = {
  // Empty: the bolt catch slapped and the bolt slams home.
  ar: [...rifleSwap(), { cue: 'bolt', at: 0.87, only: 'empty' }],
  battle: [...rifleSwap(), { cue: 'bolt', at: 0.87, only: 'empty' }],
  // MP5: on an empty gun the bolt is locked back before the magazine comes out, and slapped home at the end.
  smg: [{ cue: 'cock', at: 0.08, only: 'empty' }, ...rifleSwap(), { cue: 'slap', at: 0.87, only: 'empty' }],
  marksman: [...rifleSwap(), { cue: 'opRod', at: 0.87, only: 'empty' }],
  sniper: [...rifleSwap(), { cue: 'charge', at: 0.88, only: 'empty' }],
  // M249: cover up, box out, box in, the belt laid on the tray, cover down; charged when the bolt went home.
  lmg: [
    { cue: 'coverOpen', at: 0.08 }, ...rifleSwap(), { cue: 'belt', at: 0.8 }, { cue: 'coverClose', at: 0.87 },
    { cue: 'charge', at: 0.95, only: 'empty' },
  ],
  // M17: the magazine drops free and lands at the feet, a fresh one from the pouch, slide released when empty.
  pistol: [
    { cue: 'magOut', at: 0.15 }, { cue: 'magDrop', at: 0.15, delay: 0.42 }, { cue: 'pouchGrab', at: 0.43 },
    { cue: 'magIn', at: 0.66 }, { cue: 'slide', at: 0.8, only: 'empty' },
  ],
  // M870, per shell: fingers on a shell at the carrier, thumbed into the tube as the hand reaches the port.
  shotgun: [{ cue: 'shellGrab', at: 0.12 }, { cue: 'shellIn', at: 0.5 }],
};

/** Cues go out this far ahead of their hit (s), so a take's lead-in plays before it lands. */
export const CUE_LEAD = 0.36;

/**
 * The steps of `weapon`'s reload that fall due as it goes from `prev` to `p` (0..1 through the reload,
 * or the shell; -Infinity: everything due so far), each with the time left until its hit lands (s).
 * A step is due CUE_LEAD s before its hit.
 */
export function dueCues(weapon: string, empty: boolean, prev: number, p: number, total: number): { cue: FoleyKind; inS: number }[] {
  const out: { cue: FoleyKind; inS: number }[] = [];
  for (const step of RELOAD_STEPS[weapon] ?? []) {
    if (step.only && (step.only === 'empty') !== empty) continue;
    const hit = step.at + (step.delay ?? 0) / total;
    const due = hit - CUE_LEAD / total;
    if (prev < due && p >= due) out.push({ cue: step.cue, inS: Math.max(0, (hit - p) * total) });
  }
  return out;
}

/** A pump action racked after a shot (or after loading an empty tube): the hits land this long after the rack starts. */
export const PUMP_HITS = { back: 0.26, forward: 0.4 } as const;

/**
 * Every sound of one whole reload and when its hit lands (s from the start): for listening tests
 * and checks. `shells` is the number loaded, for shell-by-shell guns (the first takes 0.4 s, each
 * after it `perShell` s).
 */
export function reloadTimeline(weapon: string, empty: boolean, total: number, shells = 0, perShell = 0): { cue: FoleyKind; t: number }[] {
  const steps = (RELOAD_STEPS[weapon] ?? []).filter((s) => !s.only || (s.only === 'empty') === empty);
  const out: { cue: FoleyKind; t: number }[] = [];
  if (shells > 0) {
    let t0 = 0;
    for (let k = 0; k < shells; k++) {
      const len = k === 0 ? 0.4 : perShell;
      for (const s of steps) out.push({ cue: s.cue, t: t0 + s.at * len + (s.delay ?? 0) });
      t0 += len;
    }
    if (empty) {
      out.push({ cue: 'pumpBack', t: t0 + PUMP_HITS.back - 0.08 }, { cue: 'pumpFwd', t: t0 + PUMP_HITS.forward - 0.08 });
    }
  } else {
    for (const s of steps) out.push({ cue: s.cue, t: s.at * total + (s.delay ?? 0) });
  }
  return out.sort((a, b) => a.t - b.t);
}
