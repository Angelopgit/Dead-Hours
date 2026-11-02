/**
 * Which gunshots are heard when a lot of guns fire at once. Every report is a recording a second or
 * two long with its own panner and echo sends, so the engine can't let them pile up without end:
 * four teammates on full auto would start hundreds a minute, and the audio thread falls behind.
 *
 * - A gun firing again hides its own older reports' tails: past PER_GUN sounding at once, the oldest
 *   fades out as the new report lands. No shot is ever dropped for the shooter's own earlier ones.
 * - Past MAX_SHOTS in all, the quietest one left (far away, or long since faded) gives way; a new
 *   shot is only left out when it would be quieter than everything already playing.
 * - Reports that arrive bunched (several in one network message after a hitch) are spread back
 *   out at nearly the gun's rate, so a burst doesn't land as one loud flam and then a gap.
 *
 * Kept free of Web Audio so the rules can be checked headless (check:audio).
 */

/** Reports one gun keeps sounding at once (four at 700 rpm is a third of a second of each tail). */
export const PER_GUN = 4;
/** Reports sounding at once from every gun together. */
export const MAX_SHOTS = 18;
/** How fast a report dies away once it lands (s), for judging which one is quietest now. */
export const SHOT_DECAY = 0.15;
/** Bunched reports are spaced at this share of the gun's interval between shots... */
export const RESPACE = 0.85;
/** ...but never put off by more than this (s). */
export const RESPACE_MAX = 0.12;

export interface ShotVoice<T = unknown> {
  /** Who fired: one gun's reports cover each other. */
  owner: string;
  /** When the report reaches the listener (audio clock, s). */
  start: number;
  /** When it has finished playing. */
  end: number;
  /** How loud it lands (linear gain at the listener). */
  loud: number;
  /** Your own shots are never left out. */
  own?: boolean;
  /** Fades it out from `at` and stops it. */
  release: (at: number) => void;
  /** Anything the caller wants back in the observer. */
  tag?: T;
}

export type ShotEvent = { kind: 'play' | 'drop' | 'cut'; tag: unknown; at: number; end?: number };

export class ShotVoices {
  readonly playing: ShotVoice[] = [];
  /** When each gun's last report was fired, after spacing (audio clock). */
  private readonly fired = new Map<string, number>();
  /** Told what became of every shot (the firefight test listens here). */
  observer: ((e: ShotEvent) => void) | null = null;

  constructor(readonly max = MAX_SHOTS, readonly perGun = PER_GUN) {}

  /** How loud a report still is at `now`: all of it until it lands, then dying away. */
  static audible(v: ShotVoice, now: number): number {
    const age = now - v.start;
    return age <= 0 ? v.loud : v.loud * Math.exp(-age / SHOT_DECAY);
  }

  /**
   * When a shot that arrives `now` should be fired: now, unless the same gun's last one went off
   * less than RESPACE of its `interval` (s between shots) ago, then that much after it.
   */
  fireAt(owner: string, now: number, interval: number): number {
    const last = this.fired.get(owner);
    let at = now;
    if (last !== undefined && last + interval * RESPACE > now) at = Math.min(last + interval * RESPACE, now + RESPACE_MAX);
    this.fired.set(owner, at);
    if (this.fired.size > 64) for (const [k, t] of this.fired) if (t < now - 1) this.fired.delete(k);
    return at;
  }

  /** A new report wants to play: true if it does (and older ones may have been let go to make room). */
  claim(v: ShotVoice, now: number): boolean {
    const list = this.playing;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].end <= now) list.splice(i, 1);
    // The tails let go fade as the new report lands, so a far gun never goes quiet in between.
    const at = Math.max(now, v.start);
    let mine = 0;
    for (const p of list) if (p.owner === v.owner) mine++;
    while (mine >= this.perGun) {
      let oldest = -1;
      for (let i = 0; i < list.length; i++) if (list[i].owner === v.owner && (oldest < 0 || list[i].start < list[oldest].start)) oldest = i;
      this.cut(oldest, at);
      mine--;
    }
    if (list.length >= this.max) {
      let quiet = -1, q = Infinity;
      for (let i = 0; i < list.length; i++) {
        const a = ShotVoices.audible(list[i], at);
        if (a < q) {
          q = a;
          quiet = i;
        }
      }
      if (!v.own && q >= v.loud) {
        this.observer?.({ kind: 'drop', tag: v.tag, at: now });
        return false;
      }
      this.cut(quiet, at);
    }
    list.push(v);
    this.observer?.({ kind: 'play', tag: v.tag, at: now, end: v.end });
    return true;
  }

  private cut(i: number, at: number): void {
    const [v] = this.playing.splice(i, 1);
    if (v.end <= at) return;
    v.release(at);
    this.observer?.({ kind: 'cut', tag: v.tag, at });
  }
}
