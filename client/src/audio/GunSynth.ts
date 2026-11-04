/**
 * Offline gun sound synthesis. Every weapon's shot, action and handling sounds, and the echo of
 * the street and of a room, are rendered once into sample buffers from small acoustic models: the
 * muzzle blast pressure wave, the gas jet, the bullet's supersonic crack, the steel ringing and the
 * ground bounce. Pure math with no Web Audio, so Node can render the same buffers to check them.
 */
import { rng } from '@dead-hours/shared';

export type Channels = Float32Array<ArrayBuffer>[];
/** [frequency Hz, decay time constant s, level] of one vibration mode. */
export type Mode = [number, number, number];

type FilterKind = 'lowpass' | 'highpass' | 'bandpass';

/** RBJ cookbook biquad, with coefficients that can move while it runs. */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(private readonly kind: FilterKind, private readonly sr: number, freq: number, private q = 0.707) {
    this.set(freq);
  }

  set(freq: number, q = this.q): void {
    this.q = q;
    const w = (2 * Math.PI * Math.min(freq, this.sr * 0.45)) / this.sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
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
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function filter(buf: Float32Array, kind: FilterKind, sr: number, freq: number, q = 0.707, from = 0): void {
  const f = new Biquad(kind, sr, freq, q);
  for (let i = from; i < buf.length; i++) buf[i] = f.run(buf[i]);
}

function peak(chs: Float32Array[]): number {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
  return p;
}

function scale(chs: Float32Array[], k: number): void {
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= k;
}

/** Drops the silent end of a one-shot so the bank stays small. */
function trim(c: Float32Array): Float32Array<ArrayBuffer> {
  const floor = peak([c]) * 2e-4;
  let end = c.length;
  while (end > 1 && Math.abs(c[end - 1]) < floor) end--;
  return c.slice(0, Math.min(c.length, end + 64));
}

/** Equal-power gains for a pan of -1 (left) .. 1 (right). */
function pan(p: number): [number, number] {
  const a = ((p + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/** Adds damped sine modes starting at t0: the ring of a struck metal part. */
function modes(out: Float32Array, sr: number, t0: number, list: Mode[], gain: number, r: () => number, pitch = 1): void {
  const i0 = Math.round(t0 * sr);
  for (const [f0, tau, g] of list) {
    const f = f0 * pitch * (1 + (r() * 2 - 1) * 0.02);
    const w = (2 * Math.PI * f) / sr;
    const ph = r() * Math.PI * 2;
    const len = Math.min(out.length - i0, Math.ceil(tau * 6 * sr));
    const att = 0.00015 * sr;
    for (let k = 0; k < len; k++) out[i0 + k] += gain * g * Math.exp(-k / (tau * sr)) * Math.min(1, k / att) * Math.sin(w * k + ph);
  }
}

/** Adds a high-passed noise tick: the contact transient of a metal-on-metal hit. */
function tick(out: Float32Array, sr: number, t0: number, gain: number, tau: number, hp: number, r: () => number): void {
  const i0 = Math.round(t0 * sr);
  const f = new Biquad('highpass', sr, hp, 0.7);
  const len = Math.min(out.length - i0, Math.ceil(tau * 7 * sr));
  for (let k = 0; k < len; k++) out[i0 + k] += f.run((r() * 2 - 1) * gain * Math.exp(-k / (tau * sr)));
}

/** Adds band-passed friction noise with a rise-and-fall envelope and a grainy texture. */
function scrape(out: Float32Array, sr: number, t0: number, dur: number, freq: number, gain: number, r: () => number, grain = 0.6): void {
  const i0 = Math.round(t0 * sr);
  const f = new Biquad('bandpass', sr, freq, 1.4);
  const len = Math.min(out.length - i0, Math.ceil(dur * sr));
  let g = 1;
  let target = 1;
  for (let k = 0; k < len; k++) {
    if (k % 48 === 0) target = 1 - grain + grain * r() * 2;
    g += (target - g) * 0.08;
    const env = Math.sin((Math.PI * k) / len) ** 0.7;
    out[i0 + k] += f.run((r() * 2 - 1) * gain * env * g);
  }
}

/** Smooth random 0..1 curve with a new value every `step` seconds, for slow rolling modulation. */
function roll(n: number, sr: number, step: number, r: () => number): Float32Array {
  const out = new Float32Array(n);
  const per = Math.max(1, Math.round(step * sr));
  let a = r();
  let b = r();
  for (let i = 0; i < n; i++) {
    const k = i % per;
    if (k === 0 && i > 0) {
      a = b;
      b = r();
    }
    const x = k / per;
    out[i] = a + (b - a) * x * x * (3 - 2 * x);
  }
  return out;
}

// --------------------------------------------------------------------- shots

export interface ShotSpec {
  /** Positive phase of the muzzle blast pressure wave, s. Big charges push longer. */
  blast: number;
  /** Gas jet roar: decay (s), the lowpass it darkens to (Hz) and level. */
  gasTau: number;
  gasLo: number;
  gas: number;
  /** Bright sizzle of the blast front: decay (s) and level. */
  snapTau: number;
  snap: number;
  /** Supersonic bullet crack: N-wave length (s, 0 for none) and level. */
  crack: number;
  crackGain: number;
  /** Chest thump: pitch glide (Hz), decay (s) and level. */
  boomHi: number;
  boomLo: number;
  boomTau: number;
  boom: number;
  /** Low rumble of the expanding gas cloud: decay (s) and level. */
  rumbleTau: number;
  rumble: number;
  /** The gun's own steel ringing. */
  ring: Mode[];
  /** How hard the blast clips: a real shot overloads every ear and microphone near it. */
  drive: number;
}

/** Renders one close shot as the shooter hears it, without the surroundings. Stereo. */
export function renderShot(s: ShotSpec, sr: number, seed: number): Channels {
  const r = rng(seed);
  const jit = (v: number, a = 0.06) => v * (1 + (r() * 2 - 1) * a);
  const n = Math.round(sr * 0.6);
  const dry = new Float32Array(n);
  const ears = [new Float32Array(n), new Float32Array(n)];

  // Muzzle blast: Friedlander pressure wave, a sharp overpressure and a long shallow suction.
  const blast = jit(s.blast, 0.1);
  for (let i = 0; i < n; i++) {
    const x = i / sr / blast;
    if (x > 60) break;
    dry[i] += (1 - x) * Math.exp(-1.6 * x);
  }

  // Gas jet: noise that starts bright and darkens as the jet slows. Mostly the same in both ears.
  const gasTau = jit(s.gasTau);
  const lp = [new Biquad('lowpass', sr, 9000, 0.6), new Biquad('lowpass', sr, 9000, 0.6)];
  const lc = [new Biquad('highpass', sr, 260, 0.6), new Biquad('highpass', sr, 260, 0.6)];
  const hp = [new Biquad('highpass', sr, 2600, 0.7), new Biquad('highpass', sr, 2600, 0.7)];
  const snapTau = jit(s.snapTau);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = (1 - Math.exp(-t / 0.0002)) * Math.exp(-t / gasTau);
    const senv = Math.exp(-t / snapTau);
    if (env < 1e-5 && t > 0.02) break;
    if (i % 16 === 0) {
      const f = s.gasLo + (9000 - s.gasLo) * Math.exp(-t / (gasTau * 0.5));
      lp[0].set(f);
      lp[1].set(f);
    }
    const c = r() * 2 - 1;
    const cs = r() * 2 - 1;
    for (let ch = 0; ch < 2; ch++) {
      ears[ch][i] += lc[ch].run(lp[ch].run(c * 0.85 + (r() * 2 - 1) * 0.4)) * env * s.gas;
      ears[ch][i] += hp[ch].run(cs * 0.8 + (r() * 2 - 1) * 0.5) * senv * s.snap;
    }
  }

  // Supersonic crack: the bullet's shock cone, an N-wave just after the blast front.
  if (s.crack > 0) {
    const i0 = Math.round(0.0003 * sr);
    const len = Math.max(2, Math.round(jit(s.crack, 0.08) * sr));
    for (let k = 0; k <= len; k++) dry[i0 + k] += s.crackGain * (1 - (2 * k) / len);
  }

  // Chest thump: a falling low tone, and the rumble of the gas cloud under it.
  const boomTau = jit(s.boomTau);
  const hi = jit(s.boomHi, 0.04);
  let ph = 0;
  const lpR = new Biquad('lowpass', sr, 170, 0.7);
  const lpR2 = new Biquad('lowpass', sr, 170, 0.7);
  const rumbleTau = jit(s.rumbleTau);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = s.boomLo + (hi - s.boomLo) * Math.exp(-t / (boomTau * 0.35));
    ph += (2 * Math.PI * f) / sr;
    dry[i] += Math.sin(ph) * (1 - Math.exp(-t / 0.0012)) * Math.exp(-t / boomTau) * s.boom;
    dry[i] += lpR2.run(lpR.run(r() * 2 - 1)) * 4 * (1 - Math.exp(-t / 0.003)) * Math.exp(-t / rumbleTau) * s.rumble;
  }

  modes(dry, sr, 0, s.ring, 1, r);

  // Both ears, then the bounce off the ground a few milliseconds later (a little different per ear).
  const out: Channels = [new Float32Array(n), new Float32Array(n)];
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = dry[i] + (ears[0][i] + ears[1][i]) * 0.5;
  filter(mono, 'lowpass', sr, 2600, 0.6);
  const delay = [Math.round(jit(0.0071, 0.05) * sr), Math.round(jit(0.0078, 0.05) * sr)];
  for (let ch = 0; ch < 2; ch++) {
    const o = out[ch];
    for (let i = 0; i < n; i++) o[i] = dry[i] + ears[ch][i] + (i >= delay[ch] ? mono[i - delay[ch]] * 0.24 : 0);
  }

  // Overload, then clear the DC the blast's long suction leaves behind.
  scale(out, 1 / peak(out));
  const drive = s.drive;
  const norm = Math.tanh(drive);
  for (const o of out) {
    for (let i = 0; i < n; i++) o[i] = Math.tanh(o[i] * drive) / norm;
    filter(o, 'highpass', sr, 28, 0.7);
    const fade = Math.round(0.05 * sr);
    for (let k = 0; k < fade; k++) o[n - 1 - k] *= k / fade;
  }
  scale(out, 0.95 / peak(out));
  return out;
}

/** The action cycling as each round fires, heard only by the shooter. Mono. */
/**
 * A bullet flying past: its shock cone sweeps over the ear as an N-wave, a sharp crack with no
 * low end, then the ground's copy of it a moment later. Mono (it is panned from where it passed).
 * `strength` 0..1 is how far over the speed of sound the round is.
 */
export function renderCrack(nWave: number, strength: number, sr: number, seed: number): Channels {
  const r = rng(seed);
  const n = Math.round(sr * 0.06);
  const out = new Float32Array(n);
  const len = Math.max(3, Math.round(nWave * (1.6 + r() * 0.4) * sr));
  const i0 = Math.round(0.001 * sr);
  for (const [at, g] of [[0, 1], [0.0016 + r() * 0.0015, -0.35]] as const) {
    const j = i0 + Math.round(at * sr);
    for (let k = 0; k <= len && j + k < n; k++) out[j + k] += g * (1 - (2 * k) / len);
  }
  // Air rings briefly behind the shock: a thin, bright sizzle.
  const hiss = new Float32Array(n);
  for (let k = i0; k < n; k++) hiss[k] = (r() * 2 - 1) * 0.12 * Math.exp(-(k - i0) / (0.004 * sr));
  filter(hiss, 'highpass', sr, 3500, 0.7);
  for (let k = 0; k < n; k++) out[k] = (out[k] + hiss[k]) * (0.4 + 0.6 * strength);
  filter(out, 'highpass', sr, 400, 0.7);
  return [out];
}

export interface MechSpec {
  /** [time s, modes, level, contact tick level] for each impact of the moving parts. */
  hits: [number, Mode[], number, number][];
  /** A spring that keeps singing after the parts stop (the AR buffer spring). */
  spring?: { at: number; modes: Mode[]; level: number };
}

export function renderMech(m: MechSpec, sr: number, seed: number): Channels {
  const r = rng(seed);
  const out = new Float32Array(Math.round(sr * 0.32));
  for (const [t, list, g, tk] of m.hits) {
    modes(out, sr, t, list, g, r);
    if (tk > 0) tick(out, sr, t, tk, 0.0007, 2500, r);
  }
  if (m.spring) modes(out, sr, m.spring.at, m.spring.modes, m.spring.level, r);
  scale([out], 0.9 / peak([out]));
  return [trim(out)];
}

export interface GunSound {
  shot: ShotSpec;
  mech: MechSpec | null;
  /** Playback level of the close shot relative to the other guns. */
  level: number;
  /** How hard the shot drives the street and room echo. */
  echo: number;
  /** Level of the action sound under the shot. */
  mechLevel: number;
  /** Muzzle velocity of the round, m/s: faster than sound (343) and it cracks as it flies past. */
  velocity: number;
}

/**
 * Per-gun character. The 12 gauge and the 7.62 NATO rifle push far more gas than a 9 mm, so their
 * blasts are longer, deeper and echo harder; rifles add the bullet's crack; short barrels snap.
 */
export const GUN_SOUNDS: Record<string, GunSound> = {
  // M4A1, 5.56 mm from a 14.5" barrel: sharp and bright, a hard crack and a quick tight body.
  ar: {
    shot: {
      blast: 0.0006, gasTau: 0.012, gasLo: 2200, gas: 0.8, snapTau: 0.004, snap: 0.6,
      crack: 0.0003, crackGain: 0.8, boomHi: 160, boomLo: 60, boomTau: 0.03, boom: 0.2,
      rumbleTau: 0.045, rumble: 0.12, ring: [[1850, 0.012, 0.05], [3150, 0.008, 0.04], [5400, 0.005, 0.03]], drive: 1.8,
    },
    mech: {
      hits: [
        [0.028, [[430, 0.018, 0.5], [1150, 0.01, 0.4], [2300, 0.006, 0.25]], 0.6, 0.3],
        [0.056, [[1900, 0.008, 0.5], [3100, 0.006, 0.4], [4700, 0.004, 0.3]], 0.8, 0.5],
      ],
      spring: { at: 0.026, modes: [[760, 0.09, 0.25], [779, 0.09, 0.2], [1530, 0.05, 0.1]], level: 0.5 },
    },
    level: 0.85, echo: 1, mechLevel: 0.1, velocity: 880,
  },
  // MP5, 9 mm from an 8.9" barrel: a rounder bark with little crack and the roller bolt clacking.
  smg: {
    shot: {
      blast: 0.00045, gasTau: 0.009, gasLo: 1600, gas: 0.75, snapTau: 0.0028, snap: 0.4,
      crack: 0.00014, crackGain: 0.25, boomHi: 190, boomLo: 75, boomTau: 0.025, boom: 0.2,
      rumbleTau: 0.035, rumble: 0.1, ring: [[1450, 0.01, 0.06], [2600, 0.009, 0.05], [4100, 0.006, 0.03]], drive: 1.6,
    },
    mech: {
      hits: [
        [0.022, [[1300, 0.012, 0.5], [2200, 0.009, 0.5], [3500, 0.006, 0.3]], 0.7, 0.4],
        [0.048, [[1700, 0.01, 0.6], [2900, 0.008, 0.5], [4400, 0.005, 0.3]], 1, 0.6],
      ],
    },
    level: 0.7, echo: 0.65, mechLevel: 0.14, velocity: 400,
  },
  // M870, 12 gauge buckshot: a long deep boom, no crack, the heaviest echo.
  shotgun: {
    shot: {
      blast: 0.0013, gasTau: 0.02, gasLo: 1200, gas: 0.85, snapTau: 0.005, snap: 0.45,
      crack: 0, crackGain: 0, boomHi: 130, boomLo: 45, boomTau: 0.05, boom: 0.3,
      rumbleTau: 0.07, rumble: 0.2, ring: [[1100, 0.014, 0.04], [2300, 0.01, 0.03]], drive: 2.2,
    },
    mech: null,
    level: 1, echo: 1.2, mechLevel: 0, velocity: 400,
  },
  // MK14, 7.62 mm NATO from an 18" barrel: the biggest crack and a deep, thundering report.
  marksman: {
    shot: {
      blast: 0.0009, gasTau: 0.016, gasLo: 1700, gas: 0.85, snapTau: 0.0045, snap: 0.65,
      crack: 0.0004, crackGain: 1, boomHi: 145, boomLo: 50, boomTau: 0.042, boom: 0.26,
      rumbleTau: 0.06, rumble: 0.17, ring: [[1350, 0.016, 0.05], [2450, 0.011, 0.04], [4300, 0.007, 0.03]], drive: 2.1,
    },
    mech: {
      hits: [
        [0.03, [[380, 0.025, 0.6], [900, 0.015, 0.5], [1700, 0.01, 0.3]], 0.8, 0.3],
        [0.066, [[1500, 0.012, 0.5], [2600, 0.008, 0.4], [3900, 0.005, 0.25]], 0.8, 0.5],
      ],
    },
    level: 1, echo: 1.3, mechLevel: 0.09, velocity: 840,
  },
  // M17, 9 mm from a 4.7" barrel: a short snappy pop with the slide snapping back and home.
  pistol: {
    shot: {
      blast: 0.00035, gasTau: 0.0075, gasLo: 2400, gas: 0.75, snapTau: 0.003, snap: 0.55,
      crack: 0, crackGain: 0, boomHi: 220, boomLo: 90, boomTau: 0.02, boom: 0.16,
      rumbleTau: 0.03, rumble: 0.08, ring: [[2100, 0.009, 0.06], [3700, 0.006, 0.04], [6000, 0.004, 0.025]], drive: 1.7,
    },
    mech: {
      hits: [
        [0.012, [[2400, 0.006, 0.5], [3900, 0.005, 0.4]], 0.6, 0.4],
        [0.036, [[1800, 0.01, 0.6], [3000, 0.008, 0.5], [5200, 0.004, 0.3]], 1, 0.5],
      ],
    },
    level: 0.75, echo: 0.8, mechLevel: 0.12, velocity: 365,
  },
  // M249, 5.56 mm from a 16" barrel, firing from an open bolt: the AR's crack with a heavier
  // receiver clunk under every round.
  lmg: {
    shot: {
      blast: 0.00065, gasTau: 0.013, gasLo: 2000, gas: 0.82, snapTau: 0.004, snap: 0.6,
      crack: 0.0003, crackGain: 0.82, boomHi: 155, boomLo: 58, boomTau: 0.032, boom: 0.22,
      rumbleTau: 0.05, rumble: 0.13, ring: [[1600, 0.014, 0.05], [2800, 0.01, 0.04], [4900, 0.006, 0.03]], drive: 1.9,
    },
    mech: {
      hits: [
        [0.02, [[320, 0.022, 0.6], [880, 0.014, 0.5], [1900, 0.008, 0.3]], 0.85, 0.4],
        [0.05, [[1500, 0.01, 0.5], [2700, 0.007, 0.4], [4200, 0.004, 0.25]], 0.6, 0.4],
      ],
    },
    level: 0.9, echo: 1.1, mechLevel: 0.13, velocity: 915,
  },
  // SCAR-H, 7.62 mm NATO from a 16" barrel: shorter than the MK14 so a touch more blast and
  // less length, the same hard crack.
  battle: {
    shot: {
      blast: 0.00095, gasTau: 0.015, gasLo: 1800, gas: 0.87, snapTau: 0.0045, snap: 0.7,
      crack: 0.0004, crackGain: 0.95, boomHi: 150, boomLo: 52, boomTau: 0.04, boom: 0.25,
      rumbleTau: 0.055, rumble: 0.16, ring: [[1500, 0.014, 0.05], [2700, 0.01, 0.04], [4600, 0.006, 0.03]], drive: 2.1,
    },
    mech: {
      hits: [
        [0.026, [[400, 0.022, 0.6], [1000, 0.014, 0.5], [1900, 0.009, 0.3]], 0.8, 0.3],
        [0.058, [[1600, 0.011, 0.5], [2800, 0.008, 0.4], [4100, 0.005, 0.25]], 0.8, 0.5],
      ],
    },
    level: 0.97, echo: 1.25, mechLevel: 0.1, velocity: 790,
  },
  // M107, .50 BMG: a huge slow blast thrown sideways by the brake, the deepest thump, and the
  // recoiling barrel slamming back into battery.
  sniper: {
    shot: {
      blast: 0.002, gasTau: 0.026, gasLo: 1000, gas: 0.95, snapTau: 0.006, snap: 0.7,
      crack: 0.0008, crackGain: 1.15, boomHi: 110, boomLo: 34, boomTau: 0.065, boom: 0.4,
      rumbleTau: 0.08, rumble: 0.26, ring: [[900, 0.02, 0.04], [1700, 0.015, 0.035], [3100, 0.01, 0.03]], drive: 2.6,
    },
    mech: {
      hits: [
        [0.04, [[220, 0.04, 0.6], [600, 0.025, 0.5], [1300, 0.012, 0.3]], 1, 0.3],
        [0.09, [[1100, 0.015, 0.5], [2100, 0.01, 0.4], [3500, 0.006, 0.25]], 0.7, 0.4],
      ],
    },
    level: 1.1, echo: 1.6, mechLevel: 0.12, velocity: 890,
  },
  // Custom .338 behind a suppressor: the blast cut down to a hard cough, most of the energy left in
  // the bullet's crack (still supersonic), little for the street to echo.
  wraith: {
    shot: {
      blast: 0.0007, gasTau: 0.008, gasLo: 900, gas: 0.5, snapTau: 0.002, snap: 0.25,
      crack: 0.0006, crackGain: 1.1, boomHi: 120, boomLo: 45, boomTau: 0.03, boom: 0.22,
      rumbleTau: 0.035, rumble: 0.08, ring: [[1250, 0.012, 0.04], [2300, 0.008, 0.03]], drive: 1.4,
    },
    mech: null,
    level: 0.55, echo: 0.35, mechLevel: 0, velocity: 880,
  },
  // RPG-7: the booster charge kicking the rocket out (a deep, long, open-ended thump with the
  // backblast's roar), no crack: the rocket leaves well below the speed of sound.
  rpg: {
    shot: {
      blast: 0.0014, gasTau: 0.026, gasLo: 800, gas: 0.8, snapTau: 0.006, snap: 0.85,
      crack: 0, crackGain: 0, boomHi: 100, boomLo: 34, boomTau: 0.055, boom: 0.3,
      rumbleTau: 0.07, rumble: 0.2, ring: [[600, 0.02, 0.03], [1300, 0.014, 0.025]], drive: 3.4,
    },
    mech: null,
    level: 1.05, echo: 1.5, mechLevel: 0, velocity: 120,
  },
};

// --------------------------------------------------------------- surroundings

function addBands(out: Float32Array, sr: number, r: () => number, from: number, rise: number, bands: [FilterKind, number, number, number][], mod: Float32Array | null): void {
  const n = out.length;
  for (const [kind, freq, t60, g] of bands) {
    const f = new Biquad(kind, sr, freq, kind === 'bandpass' ? 0.8 : 0.7);
    const fall = Math.exp(-6.91 / (t60 * sr));
    let env = g;
    for (let i = 0; i < n; i++, env *= fall) {
      const x = f.run(r() * 2 - 1);
      const t = i / sr;
      if (t < from) continue;
      const on = Math.min(1, (t - from) / rise);
      out[i] += x * env * on * on * (3 - 2 * on) * (mod ? mod[i] : 1);
    }
  }
}

function unitEnergy(chs: Float32Array[]): void {
  let e = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) e += c[i] * c[i];
  scale(chs, 1 / Math.sqrt(e / chs.length));
}

/**
 * Impulse response of the street: the facades of the houses slap the blast back one by one, darker
 * the farther they are, then the whole block rolls on like distant thunder. Stereo, unit energy.
 */
export function streetIR(sr: number, seed: number): Channels {
  const r = rng(seed);
  const n = Math.round(sr * 2.6);
  const out: Channels = [new Float32Array(n), new Float32Array(n)];
  for (let k = 0; k < 16; k++) {
    const delay = 0.045 + r() ** 1.3 * 0.42;
    const near = 0.05 / delay;
    const g = (0.4 + 0.6 * r()) * near ** 0.9;
    const facade = new Float32Array(Math.round(0.05 * sr));
    for (let j = 0, taps = 3 + Math.floor(r() * 4); j < taps; j++) {
      facade[Math.floor(r() ** 2 * 0.007 * sr)] += (j === 0 ? 1 : (r() < 0.65 ? 1 : -1) * (0.25 + 0.5 * r()));
    }
    const cut = 5200 * near ** 0.55;
    filter(facade, 'lowpass', sr, cut, 0.6);
    filter(facade, 'lowpass', sr, cut, 0.6);
    const [gl, gr] = pan(r() * 1.8 - 0.9);
    const i0 = Math.round(delay * sr);
    for (let i = 0; i < facade.length && i0 + i < n; i++) {
      out[0][i0 + i] += facade[i] * g * gl;
      out[1][i0 + i] += facade[i] * g * gr;
    }
  }
  const bands: [FilterKind, number, number, number][] = [
    ['lowpass', 300, 1.9, 0.07],
    ['bandpass', 700, 1.5, 0.09],
    ['bandpass', 1700, 0.8, 0.055],
    ['highpass', 3500, 0.35, 0.012],
  ];
  for (const ch of out) {
    const mod = roll(n, sr, 0.11, r);
    for (let i = 0; i < n; i++) mod[i] = 0.45 + mod[i] * 1.1;
    addBands(ch, sr, r, 0.03, 0.2, bands, mod);
    // Open air keeps little of the deepest boom: it spreads out instead of coming back.
    filter(ch, 'highpass', sr, 110, 0.6);
  }
  unitEnergy(out);
  return out;
}

/** What shapes an enclosed space's answer to a shot. */
interface EnclosureSpec {
  /** Length of the response, s. */
  length: number;
  /** Early reflections: how many, and the range of their delays (s). */
  reflections: number;
  early: [number, number];
  /** How bright the walls send it back (lowpass on the reflections, Hz). */
  wallCut: number;
  /** Diffuse decay per band: [kind, Hz, T60 s, level]. */
  bands: [FilterKind, number, number, number][];
  /** When the diffuse tail starts and how fast it builds, s. */
  tailFrom: number;
  tailRise: number;
  /** The space's own low resonances and how loud they boom. */
  modes: Mode[];
  modeGain: number;
  /** Lowest frequency it keeps, Hz. */
  floor: number;
}

function enclosureIR(sr: number, seed: number, e: EnclosureSpec): Channels {
  const r = rng(seed);
  const n = Math.round(sr * e.length);
  const out: Channels = [new Float32Array(n), new Float32Array(n)];
  const [d0, d1] = e.early;
  for (let k = 0; k < e.reflections; k++) {
    const delay = d0 + r() ** 1.5 * (d1 - d0);
    const g = (0.5 + 0.5 * r()) * (d0 * 1.6 / delay) ** 0.5 * (r() < 0.75 ? 1 : -1);
    const [gl, gr] = pan(r() * 2 - 1);
    const i = Math.round(delay * sr);
    out[0][i] += g * gl;
    out[1][i] += g * gr;
  }
  for (const ch of out) filter(ch, 'lowpass', sr, e.wallCut, 0.6);
  for (const ch of out) {
    addBands(ch, sr, r, e.tailFrom, e.tailRise, e.bands, null);
    modes(ch, sr, e.tailFrom * 0.7, e.modes, e.modeGain, r);
    filter(ch, 'highpass', sr, e.floor, 0.7);
  }
  unitEnergy(out);
  return out;
}

/**
 * The enclosed spaces of Maple Hollow, each answering a shot its own way (stereo, unit energy):
 * - room: a furnished room in a house. Close plaster walls answer within milliseconds, the room
 *   booms at its own low resonances and soft furnishings kill the ring in well under a second.
 * - hall: the Quik-Stop's shop floor or a garage. Farther, harder walls: later reflections and a
 *   longer, brighter ring with weaker low modes.
 * - basement: poured concrete under a low ceiling. Hard, bright, immediate slaps, a long ring for
 *   a small room and a heavy low boom, the harshest place to fire a gun.
 */
export const ENCLOSURES = {
  room: {
    length: 1.2, reflections: 14, early: [0.0025, 0.0325], wallCut: 7000,
    bands: [['lowpass', 400, 0.6, 0.05], ['bandpass', 1200, 0.55, 0.09], ['highpass', 3000, 0.3, 0.035]],
    tailFrom: 0.006, tailRise: 0.015,
    modes: [[38, 0.2, 1], [49, 0.22, 0.9], [69, 0.18, 0.8], [77, 0.16, 0.7], [98, 0.14, 0.6], [118, 0.12, 0.5]], modeGain: 0.004, floor: 75,
  },
  hall: {
    length: 1.9, reflections: 18, early: [0.008, 0.07], wallCut: 8000,
    bands: [['lowpass', 400, 1.3, 0.06], ['bandpass', 1200, 1.1, 0.09], ['highpass', 3000, 0.6, 0.03]],
    tailFrom: 0.014, tailRise: 0.045,
    modes: [[27, 0.32, 0.6], [35, 0.3, 0.5], [46, 0.26, 0.4], [54, 0.22, 0.35]], modeGain: 0.003, floor: 55,
  },
  basement: {
    length: 1.6, reflections: 16, early: [0.002, 0.024], wallCut: 9500,
    bands: [['lowpass', 350, 1.1, 0.07], ['bandpass', 1100, 0.95, 0.1], ['highpass', 3000, 0.7, 0.05]],
    tailFrom: 0.004, tailRise: 0.012,
    modes: [[42, 0.36, 1.2], [56, 0.3, 1], [71, 0.28, 0.9], [88, 0.24, 0.8], [104, 0.2, 0.6]], modeGain: 0.005, floor: 55,
  },
} satisfies Record<string, EnclosureSpec>;

export type Enclosure = keyof typeof ENCLOSURES;

/** Impulse response of an enclosed space (see ENCLOSURES). */
export function enclosedIR(kind: Enclosure, sr: number, seed: number): Channels {
  return enclosureIR(sr, seed, ENCLOSURES[kind] as EnclosureSpec);
}

/** A furnished room in a house (kept for callers that only know rooms). */
export function roomIR(sr: number, seed: number): Channels {
  return enclosedIR('room', sr, seed);
}

// ---------------------------------------------------------------------- foley

/**
 * Handling sounds. Reloads: magazine out and in (a belt box on the M249), the bolt or slide sent home
 * on an empty gun ('bolt' bolt catch, 'charge' charging handle, 'slap' an MP5's handle slapped down,
 * 'opRod' an M14's op rod, 'slide' a pistol's), 'cock' the MP5's bolt locked back first, shells and
 * the pump, the M249's feed cover and belt, the pouch the old magazine goes into and the new one
 * comes out of, and a pistol magazine landing on the floor.
 */
export type FoleyKind =
  | 'magOut' | 'magIn' | 'bolt' | 'charge' | 'cock' | 'slap' | 'opRod' | 'slide'
  | 'pumpBack' | 'pumpFwd' | 'shellIn' | 'shellGrab' | 'coverOpen' | 'coverClose' | 'belt'
  | 'pouch' | 'pouchGrab' | 'magDrop' | 'holster' | 'draw' | 'dryFire';

/** Every handling sound (checks and the startup bank walk this). */
export const FOLEY_KINDS: FoleyKind[] = [
  'magOut', 'magIn', 'bolt', 'charge', 'cock', 'slap', 'opRod', 'slide', 'pumpBack', 'pumpFwd', 'shellIn', 'shellGrab',
  'coverOpen', 'coverClose', 'belt', 'pouch', 'pouchGrab', 'magDrop', 'holster', 'draw', 'dryFire',
];

/** How each gun's parts sound when handled: smaller guns ring higher, heavier ones thud. */
const HANDLING: Record<string, { pitch: number; weight: number }> = {
  ar: { pitch: 1, weight: 1 },
  smg: { pitch: 1.1, weight: 0.95 },
  shotgun: { pitch: 0.9, weight: 1.1 },
  marksman: { pitch: 0.82, weight: 1.25 },
  pistol: { pitch: 1.3, weight: 0.7 },
  lmg: { pitch: 0.88, weight: 1.35 },
  battle: { pitch: 0.86, weight: 1.15 },
  sniper: { pitch: 0.7, weight: 1.6 },
  wraith: { pitch: 0.8, weight: 1.3 },
  rpg: { pitch: 0.65, weight: 1.7 },
};

/**
 * Renders one handling sound for a gun, synthesized: what plays until the recordings are decoded
 * (and the pouch, belt and dropped magazine, which have none). Mono.
 */
export function renderFoley(kind: FoleyKind, weapon: string, sr: number, seed: number): Channels {
  const r = rng(seed);
  const { pitch: p, weight: w } = HANDLING[weapon] ?? HANDLING.ar;
  const out = new Float32Array(Math.round(sr * 0.42));
  const hit = (t: number, list: Mode[], g: number, tk: number) => {
    modes(out, sr, t, list, g, r, p);
    if (tk > 0) tick(out, sr, t, tk, 0.0006, 2200 * p, r);
  };
  switch (kind) {
    case 'dryFire':
      // Hammer or striker falling on an empty chamber.
      hit(0, [[3600, 0.004, 0.6], [5400, 0.003, 0.5], [7900, 0.002, 0.3], [950, 0.006, 0.25]], 1, 0.5);
      hit(0.05, [[4200, 0.002, 0.3]], 0.25, 0.1);
      break;
    case 'magOut':
      // Release button, the magazine sliding out of the well, then clearing it.
      hit(0, [[3000, 0.004, 0.4], [4800, 0.003, 0.3]], 0.5, 0.25);
      scrape(out, sr, 0.008, 0.06 * w, 2400 * p, 0.16, r);
      hit(0.07 * w, [[700, 0.015, 0.4], [1300, 0.01, 0.3]], 0.45 * w, 0.15);
      break;
    case 'magIn':
      // Sliding up the well, seating hard against the catch, and the catch clicking shut.
      scrape(out, sr, 0, 0.05 * w, 1800 * p, 0.3, r);
      hit(0.052 * w, [[520, 0.02, 0.5], [1250, 0.013, 0.6], [2300, 0.009, 0.5], [3900, 0.006, 0.3]], 1, 0.6);
      hit(0.052 * w + 0.014, [[4200, 0.003, 0.3]], 0.35, 0.15);
      break;
    case 'bolt':
      // Charging handle back against the spring, then the bolt slamming home.
      scrape(out, sr, 0, 0.09, 2800 * p, 0.3, r);
      modes(out, sr, 0.01, [[620, 0.06, 0.12]], 1, r, p);
      hit(0.105, [[600, 0.02, 0.4], [1450, 0.014, 0.6], [2600, 0.01, 0.5], [4100, 0.006, 0.4]], 1, 0.7);
      hit(0.122, [[2200, 0.006, 0.3], [3500, 0.004, 0.2]], 0.3, 0.15);
      break;
    case 'charge':
      // Charging handle hauled all the way back, then let go: a long scrape and a heavy slam.
      scrape(out, sr, 0, 0.16 * w, 2400 * p, 0.32, r);
      hit(0.17 * w, [[180, 0.03, 0.3], [560, 0.022, 0.45], [1350, 0.015, 0.6], [2500, 0.01, 0.5], [3900, 0.006, 0.35]], 1, 0.75);
      hit(0.17 * w + 0.018, [[2100, 0.006, 0.3]], 0.3, 0.15);
      break;
    case 'cock':
      // Bolt pulled back and rotated up into its notch: a scrape, then two clicks.
      scrape(out, sr, 0, 0.08, 2600 * p, 0.3, r);
      hit(0.085, [[1700, 0.008, 0.5], [3000, 0.006, 0.5], [4600, 0.004, 0.3]], 0.75, 0.5);
      hit(0.14, [[2300, 0.005, 0.4], [3900, 0.004, 0.3]], 0.5, 0.35);
      break;
    case 'slap':
    case 'opRod':
      // The bolt let fly off the hand: a short rush and a hard slam home.
      scrape(out, sr, 0, 0.025, 3000 * p, 0.25, r);
      hit(0.028, [[480, 0.022, 0.45], [1250, 0.016, 0.6], [2300, 0.011, 0.55], [3700, 0.007, 0.4]], 1, 0.8);
      hit(0.046, [[2600, 0.005, 0.25]], 0.25, 0.1);
      break;
    case 'coverOpen':
      // Latch popped, the hinged cover swinging up to its stop.
      hit(0, [[3300, 0.004, 0.4], [5200, 0.003, 0.3]], 0.5, 0.3);
      scrape(out, sr, 0.01, 0.07, 1800 * p, 0.12, r);
      hit(0.085, [[720, 0.02, 0.5], [1600, 0.014, 0.5], [2900, 0.009, 0.35]], 0.7, 0.3);
      break;
    case 'coverClose':
      // Slammed down and the latch snapping over.
      hit(0, [[650, 0.024, 0.5], [1500, 0.016, 0.6], [2700, 0.011, 0.5], [4100, 0.007, 0.3]], 1, 0.6);
      hit(0.03, [[3600, 0.004, 0.4], [5400, 0.003, 0.3]], 0.45, 0.25);
      break;
    case 'belt':
      // A belt of linked rounds laid across the feed tray: links clinking one after another.
      for (let k = 0; k < 9; k++) {
        const at = 0.012 + k * 0.022 + r() * 0.008;
        hit(at, [[3800 + r() * 900, 0.006, 0.4], [6100 + r() * 900, 0.004, 0.3], [1900, 0.01, 0.15]], 0.35 + r() * 0.35, 0.2);
      }
      break;
    case 'pouch':
    case 'pouchGrab': {
      // A magazine stuffed into (or pulled from) a fabric pouch: cloth rustle, a muffled knock.
      const stow = kind === 'pouch';
      const rustle = new Float32Array(out.length);
      scrape(rustle, sr, 0, stow ? 0.16 : 0.12, 700, 0.55, r, 0.9);
      scrape(rustle, sr, 0.02, stow ? 0.12 : 0.09, 2300, 0.2, r, 0.9);
      filter(rustle, 'lowpass', sr, 3200, 0.7);
      for (let i = 0; i < out.length; i++) out[i] += rustle[i];
      if (stow) modes(out, sr, 0.13, [[260, 0.018, 0.5], [610, 0.012, 0.4], [1200, 0.008, 0.2]], 0.55, r, p);
      break;
    }
    case 'magDrop':
      // An empty polymer magazine hitting the floor and bouncing twice.
      for (const [at, g] of [[0, 1], [0.12, 0.45], [0.19, 0.2]] as const) {
        modes(out, sr, at, [[900, 0.012, 0.5], [1800, 0.009, 0.5], [3100, 0.006, 0.35], [380, 0.02, 0.3]], g, r, p);
        tick(out, sr, at, 0.25 * g, 0.0007, 1500, r);
      }
      break;
    case 'slide':
      // Slide release: a small click, then the slide snapping forward.
      hit(0, [[4500, 0.003, 0.3]], 0.3, 0.15);
      hit(0.02, [[1600, 0.012, 0.5], [2700, 0.009, 0.6], [4300, 0.006, 0.4], [6200, 0.004, 0.2]], 1, 0.6);
      break;
    case 'pumpBack':
      // Shk-: the forend racked back to the stop.
      scrape(out, sr, 0, 0.12, 1500 * p, 0.28, r, 0.75);
      hit(0.125, [[480, 0.025, 0.5], [1100, 0.016, 0.6], [2000, 0.01, 0.4], [260, 0.03, 0.3]], 0.85, 0.45);
      break;
    case 'pumpFwd':
      // -chk: shoved forward to lock.
      scrape(out, sr, 0, 0.12, 1700 * p, 0.25, r, 0.75);
      hit(0.13, [[560, 0.02, 0.6], [1300, 0.014, 0.7], [2400, 0.01, 0.5], [3600, 0.007, 0.3]], 1, 0.6);
      break;
    case 'shellIn':
      // A shell thumbed past the carrier into the tube.
      scrape(out, sr, 0, 0.03, 2000 * p, 0.2, r);
      hit(0.03, [[1900, 0.006, 0.4], [3200, 0.004, 0.3], [350, 0.02, 0.35]], 0.7, 0.3);
      break;
    case 'shellGrab':
      scrape(out, sr, 0, 0.08, 2500, 0.12, r, 0.9);
      break;
    case 'holster':
    case 'draw': {
      // Fabric and sling rustle, then a sling swivel or the grip knocking.
      const rustle = new Float32Array(out.length);
      scrape(rustle, sr, 0, 0.15, 900, 0.5, r, 0.9);
      scrape(rustle, sr, 0.03, 0.11, 2600, 0.18, r, 0.9);
      for (let i = 0; i < out.length; i++) out[i] += rustle[i];
      hit(0.13, [[2800, 0.005, 0.25], [1200, 0.01, 0.2]], 0.5, 0.1);
      break;
    }
  }
  filter(out, 'highpass', sr, 80, 0.7);
  scale([out], 0.9 / peak([out]));
  return [trim(out)];
}
