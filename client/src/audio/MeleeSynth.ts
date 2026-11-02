/**
 * Offline melee sound synthesis: the swing through the air, the blow landing on a zombie and the
 * weapon being picked up, for the machete and every weapon found lying around. Each is built from
 * small physical pieces (the edge biting, flesh parting, the struck object's own ringing modes,
 * the body's thump, bone giving way, blood) and rendered once into a sample buffer. Pure math
 * with no Web Audio, so Node can render the same buffers to check them.
 */
import type { MeleeId } from '@dead-hours/shared';
import { rng } from './GunSynth';

/** [frequency Hz, decay time constant s, level] of one ringing mode. */
type Mode = [number, number, number];

class Filter {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;

  constructor(private readonly kind: 'lowpass' | 'highpass' | 'bandpass', private readonly sr: number, freq: number, private q = 0.707) {
    this.set(freq);
  }

  set(freq: number, q = this.q): void {
    this.q = q;
    const w = (2 * Math.PI * Math.min(Math.max(freq, 20), this.sr * 0.45)) / this.sr;
    const cos = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
    if (this.kind === 'lowpass') {
      this.b0 = this.b2 = (1 - cos) / 2 / a0;
      this.b1 = (1 - cos) / a0;
    } else if (this.kind === 'highpass') {
      this.b0 = this.b2 = (1 + cos) / 2 / a0;
      this.b1 = -(1 + cos) / a0;
    } else {
      this.b0 = alpha / a0;
      this.b1 = 0;
      this.b2 = -alpha / a0;
    }
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** How each weapon sounds: what it is made of and how it moves. */
interface Voice {
  /** Swing: peak whoosh frequency, its sharpness (Q), length, and a thin edge whistle (blades). */
  whoosh: number;
  q: number;
  swingLen: number;
  whistle: number;
  /** Hit: how much of it is an edge cutting flesh (0 blunt .. 1 blade), and how clean the cut is. */
  cut: number;
  clean: number;
  /** The weapon's own ringing as it strikes, damped by the body it sinks into. */
  modes: Mode[];
  ring: number;
  /** The body's thump (weight behind the blow) and bone giving way. */
  thump: number;
  bone: number;
}

const VOICES: Record<MeleeId, Voice> = {
  machete: {
    whoosh: 1700, q: 2.6, swingLen: 0.3, whistle: 0.25, cut: 1, clean: 0.55,
    modes: [[2150, 0.05, 0.6], [4420, 0.035, 0.45], [6900, 0.022, 0.3], [9300, 0.014, 0.18]], ring: 0.35,
    thump: 0.65, bone: 0.55,
  },
  katana: {
    whoosh: 2500, q: 4.2, swingLen: 0.34, whistle: 0.6, cut: 1, clean: 1,
    modes: [[2870, 0.09, 0.55], [5230, 0.06, 0.45], [8100, 0.04, 0.3], [11200, 0.025, 0.15]], ring: 0.45,
    thump: 0.4, bone: 0.4,
  },
  // Two blades cutting in turn: a shorter, tighter hiss each, the same clean edge.
  katanas: {
    whoosh: 2750, q: 4.6, swingLen: 0.26, whistle: 0.65, cut: 1, clean: 1,
    modes: [[2870, 0.08, 0.55], [5230, 0.055, 0.45], [8100, 0.036, 0.3], [11200, 0.022, 0.15]], ring: 0.42,
    thump: 0.35, bone: 0.4,
  },
  bat: {
    whoosh: 620, q: 1.3, swingLen: 0.46, whistle: 0, cut: 0, clean: 0,
    modes: [[410, 0.035, 0.7], [1180, 0.022, 0.5], [2330, 0.014, 0.35], [3600, 0.008, 0.2]], ring: 0.85,
    thump: 1, bone: 0.8,
  },
  crowbar: {
    whoosh: 1050, q: 1.9, swingLen: 0.34, whistle: 0.08, cut: 0.12, clean: 0,
    modes: [[960, 0.07, 0.55], [2620, 0.05, 0.6], [4830, 0.035, 0.45], [7310, 0.022, 0.3]], ring: 0.7,
    thump: 0.85, bone: 1,
  },
  wrench: {
    whoosh: 1150, q: 1.7, swingLen: 0.3, whistle: 0, cut: 0, clean: 0,
    modes: [[720, 0.05, 0.6], [1930, 0.04, 0.55], [3610, 0.026, 0.4], [5900, 0.016, 0.25]], ring: 0.75,
    thump: 0.95, bone: 1,
  },
  hockey: {
    whoosh: 900, q: 1.5, swingLen: 0.4, whistle: 0.05, cut: 0, clean: 0,
    modes: [[620, 0.022, 0.6], [1460, 0.016, 0.55], [2950, 0.01, 0.4], [4700, 0.006, 0.25]], ring: 0.8,
    thump: 0.75, bone: 0.45,
  },
};

const env = (t: number, attack: number, decay: number) => (t < 0 ? 0 : t < attack ? t / attack : Math.exp(-(t - attack) / decay));

function normalize(out: Float32Array, target: number): Float32Array<ArrayBuffer> {
  let p = 0;
  for (let i = 0; i < out.length; i++) p = Math.max(p, Math.abs(out[i]));
  const k = p > 1e-6 ? target / p : 0;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  // A short fade at the very end so a cut-off tail never clicks.
  const fade = Math.min(out.length, 256);
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out as Float32Array<ArrayBuffer>;
}

/** Ringing modes struck at `t0`. */
function modes(out: Float32Array, sr: number, t0: number, list: Mode[], gain: number, r: () => number, damp = 1): void {
  for (const [f0, tau, lvl] of list) {
    const f = f0 * (1 + (r() - 0.5) * 0.04);
    const d = tau * damp;
    const ph = r() * Math.PI * 2;
    const start = Math.round(t0 * sr), end = Math.min(out.length, start + Math.round(d * 7 * sr));
    for (let i = start; i < end; i++) {
      const t = (i - start) / sr;
      out[i] += Math.sin(2 * Math.PI * f * t + ph) * Math.exp(-t / d) * lvl * gain * Math.min(1, t * sr / 6);
    }
  }
}

/** Filtered noise with an envelope; `sweep` moves the filter from f0 to f1 over the burst. */
function noise(out: Float32Array, sr: number, t0: number, kind: 'lowpass' | 'highpass' | 'bandpass', f0: number, f1: number, q: number,
  gain: number, attack: number, decay: number, r: () => number, grain = 0): void {
  const flt = new Filter(kind, sr, f0, q);
  const start = Math.round(t0 * sr), len = Math.round((attack + decay * 6) * sr), end = Math.min(out.length, start + len);
  let g = 1;
  for (let i = start; i < end; i++) {
    const t = (i - start) / sr;
    if ((i - start) % 32 === 0) {
      const u = Math.min(1, t / (attack + decay * 2.5));
      flt.set(f0 * Math.pow(f1 / f0, u));
      // Grain: wet, uneven tearing rather than a smooth hiss.
      if (grain > 0) g = 1 - grain + grain * (r() < 0.5 ? r() * 2.2 : r() * 0.3);
    }
    out[i] += flt.run(r() * 2 - 1) * env(t, attack, decay) * gain * g;
  }
}

/** A low sine pitch-dropping thump (mass hitting mass). */
function thump(out: Float32Array, sr: number, t0: number, f0: number, f1: number, gain: number, decay: number): void {
  const start = Math.round(t0 * sr), end = Math.min(out.length, start + Math.round(decay * 7 * sr));
  let ph = 0;
  for (let i = start; i < end; i++) {
    const t = (i - start) / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / (decay * 0.6));
    ph += (2 * Math.PI * f) / sr;
    out[i] += Math.sin(ph) * env(t, 0.0015, decay) * gain;
  }
}

/** Tiny sharp clicks scattered over a span (bone splintering, gristle snapping). */
function crackle(out: Float32Array, sr: number, t0: number, span: number, count: number, freq: number, gain: number, r: () => number): void {
  for (let k = 0; k < count; k++) {
    const at = t0 + Math.pow(r(), 1.6) * span;
    noise(out, sr, at, 'bandpass', freq * (0.7 + r() * 0.8), freq * (0.6 + r() * 0.5), 1.4, gain * (0.4 + r() * 0.6), 0.0004, 0.0025 + r() * 0.003, r);
  }
}

/** A weapon cutting the air: a band of noise whose pitch rises and falls with the blade's speed. */
export function renderMeleeSwing(weapon: MeleeId, sr: number, seed: number): Float32Array<ArrayBuffer> {
  const v = VOICES[weapon];
  const r = rng(seed);
  const len = v.swingLen * (0.94 + r() * 0.12);
  const out = new Float32Array(Math.round(sr * (len + 0.05)));
  const flt = new Filter('bandpass', sr, v.whoosh, v.q);
  const low = new Filter('lowpass', sr, v.whoosh * 2.2, 0.7);
  const peakAt = len * (0.42 + r() * 0.08);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    // Speed profile: accelerates into the strike and dies away after it.
    const s = t < peakAt ? Math.pow(t / peakAt, 1.8) : Math.exp(-(t - peakAt) / (len * 0.22));
    if (i % 24 === 0) flt.set(v.whoosh * (0.35 + 0.75 * s), v.q * (0.7 + 0.5 * s));
    // Air buffeting: the slow flutter of a flat or long thing swung hard.
    const flutter = 1 + 0.18 * Math.sin(2 * Math.PI * (22 + 30 * s) * t + r() * 0.2);
    out[i] = low.run(flt.run(r() * 2 - 1)) * s * flutter;
  }
  if (v.whistle > 0) {
    // A thin edge singing through the air at the fastest point.
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const s = Math.exp(-(((t - peakAt) / (len * 0.12)) ** 2));
      ph += (2 * Math.PI * v.whoosh * (1.6 + 0.5 * s)) / sr;
      out[i] += Math.sin(ph) * s * v.whistle * 0.12;
    }
  }
  return normalize(out, 0.9);
}

export interface MeleeHitOpts {
  /** The blow killed it, landed on the head, or took an arm off. */
  kill: boolean;
  head: boolean;
}

/**
 * A blow landing on a zombie. Blades: the edge biting with a bright tick, a wet ripping slice
 * as it opens the flesh, the thump of the body, a grind of bone when it goes deep, blood, and the
 * edge dragging free. Blunt weapons: the weapon's own crack or clank, the heavy thud of a body
 * hit hard and the crunch of bone, the skull caving in on a head blow.
 */
export function renderMeleeHit(weapon: MeleeId, opts: MeleeHitOpts, sr: number, seed: number): Float32Array<ArrayBuffer> {
  const v = VOICES[weapon];
  const r = rng(seed);
  const out = new Float32Array(Math.round(sr * 0.62));
  const heavy = opts.kill || opts.head;
  if (v.cut > 0.5) {
    // The edge meets skin: a tiny bright tick, then its steel rings briefly before flesh chokes it.
    noise(out, sr, 0, 'highpass', 5200, 7500, 0.8, 0.9, 0.0004, 0.0018, r);
    modes(out, sr, 0.0005, v.modes, v.ring * 0.5, r, 0.55 + 0.25 * v.clean);
    // The slice: a wet rip falling in pitch as the blade goes in, gritty with tearing tissue.
    const sliceLen = 0.055 + (1 - v.clean) * 0.035 + (heavy ? 0.02 : 0);
    noise(out, sr, 0.002, 'bandpass', 3800 + v.clean * 1400, 900, 1.6, 0.85, 0.004, sliceLen * 0.45, r, 0.55);
    noise(out, sr, 0.004, 'bandpass', 1500, 520, 2.2, 0.55, 0.006, sliceLen * 0.6, r, 0.7);
    // Skin parting: a fast run of small wet snaps right behind the edge.
    crackle(out, sr, 0.004, sliceLen, 10 + Math.round(v.clean * 6), 2300, 0.38, r);
    // The weight behind it: the body taking the blow.
    thump(out, sr, 0.003, 150, 58, 0.75 * v.thump, 0.05);
    noise(out, sr, 0.002, 'lowpass', 520, 300, 0.8, 0.5 * v.thump, 0.002, 0.04, r);
    // Deep enough to meet bone: a hard grind and splinter.
    if (heavy || r() < 0.4) {
      const b = 0.012 + r() * 0.014;
      noise(out, sr, b, 'bandpass', 1900, 1300, 2.5, 0.45 * v.bone, 0.0008, 0.012, r);
      modes(out, sr, b, [[1150, 0.012, 0.6], [2050, 0.009, 0.45], [3300, 0.006, 0.3]], 0.35 * v.bone, r);
      crackle(out, sr, b + 0.003, 0.03, 6, 3600, 0.3 * v.bone, r);
    }
    // Blood: a gush and a few glugs after the cut opens.
    noise(out, sr, 0.03, 'bandpass', 900, 600, 1.4, heavy ? 0.42 : 0.26, 0.02, heavy ? 0.12 : 0.07, r, 0.65);
    for (let k = 0; k < (heavy ? 4 : 2); k++) {
      const at = 0.06 + r() * 0.16;
      noise(out, sr, at, 'bandpass', 700 + r() * 500, 420, 4, 0.14 + r() * 0.08, 0.006, 0.03, r);
    }
    // The edge dragged back out through the wound.
    noise(out, sr, 0.11 + r() * 0.04, 'bandpass', 3200 * (0.85 + v.clean * 0.3), 2200, 3, 0.16, 0.012, 0.035, r, 0.4);
  } else {
    // The weapon's own crack or clank as it strikes, quickly smothered by the body.
    noise(out, sr, 0, 'highpass', 2600, 3600, 0.8, 0.55, 0.0005, 0.003, r);
    modes(out, sr, 0.0003, v.modes, v.ring, r, 0.7);
    // A heavy body thud: the meat of the sound.
    thump(out, sr, 0.001, 120, 44, 1.0 * v.thump, 0.075);
    noise(out, sr, 0, 'lowpass', 420, 240, 0.8, 0.85 * v.thump, 0.0015, 0.055, r);
    noise(out, sr, 0.002, 'bandpass', 1100, 700, 1.6, 0.35, 0.002, 0.03, r, 0.5);
    // Wet slap of skin and the squelch under it.
    noise(out, sr, 0.004, 'bandpass', 1600, 900, 2, 0.3, 0.003, 0.05, r, 0.6);
    // Bones: ribs cracking, a skull caving in on a head blow.
    const crunch = (opts.head ? 1 : heavy ? 0.6 : 0.3) * v.bone;
    if (crunch > 0.25 || r() < 0.5) {
      crackle(out, sr, 0.003, 0.05, Math.round(6 + 12 * crunch), 2600, 0.32 + 0.3 * crunch, r);
      modes(out, sr, 0.004, [[880, 0.014, 0.5], [1620, 0.01, 0.45], [2750, 0.007, 0.3]], 0.4 * crunch, r);
    }
    if (opts.head) {
      // Skull giving: a sharp, hollow crack and wet collapse.
      noise(out, sr, 0.006, 'bandpass', 2100, 1500, 3, 0.4 * v.bone, 0.0006, 0.01, r);
      noise(out, sr, 0.03, 'lowpass', 900, 500, 0.9, 0.3, 0.01, 0.08, r, 0.6);
    }
    if (opts.kill) noise(out, sr, 0.05, 'bandpass', 800, 550, 1.4, 0.2, 0.015, 0.07, r, 0.6);
  }
  return normalize(out, 0.95);
}

/** Picking a weapon up: steel scraping off the floor and a click in the hand, or wood knocking. */
export function renderMeleePickup(weapon: MeleeId, sr: number, seed: number): Float32Array<ArrayBuffer> {
  const v = VOICES[weapon];
  const r = rng(seed);
  const out = new Float32Array(Math.round(sr * 0.5));
  if (weapon === 'katana' || weapon === 'katanas') {
    // A blade drawn an inch from its collar: the long bright ring of a good edge.
    noise(out, sr, 0, 'bandpass', 4200, 6200, 4, 0.35, 0.03, 0.06, r, 0.3);
    modes(out, sr, 0.05, [[3140, 0.35, 0.5], [5870, 0.22, 0.35], [8200, 0.14, 0.2]], 0.55, r);
    // The second blade: the two edges kissing, a slightly sharper ring just after.
    if (weapon === 'katanas') modes(out, sr, 0.12, [[3420, 0.3, 0.5], [6310, 0.2, 0.35], [8900, 0.12, 0.2]], 0.45, r);
  } else {
    // Scraped up off the floor.
    noise(out, sr, 0, 'bandpass', v.cut > 0.5 || v.ring > 0.6 ? 3000 : 1400, 2200, 2.5, 0.35, 0.02, 0.05, r, 0.5);
    modes(out, sr, 0.005, v.modes, v.ring * 0.4, r, 1.4);
  }
  // Settling into the grip.
  modes(out, sr, 0.16, v.modes.map(([f, d, l]) => [f * 0.9, d * 0.6, l] as Mode), 0.3, r, 1);
  noise(out, sr, 0.16, 'lowpass', 600, 400, 0.8, 0.25, 0.003, 0.03, r);
  return normalize(out, 0.85);
}

/** Every voice the engine renders (checks). */
export const MELEE_VOICES = Object.keys(VOICES) as MeleeId[];
