import * as THREE from 'three';
import { settings } from '../core/Settings';
import type { Vec3 } from '@dead-hours/shared';
import { ENCLOSURES, GUN_SOUNDS, enclosedIR, renderCrack, renderFoley, renderMech, renderShot, streetIR, type Channels, type Enclosure, type FoleyKind } from './GunSynth';
import { CLEAR, type Acoustics, type Muffle, type Space } from './Acoustics';

/** Close-shot takes rendered per gun and picked at random, so full auto never repeats one. */
const SHOT_TAKES = 4;
const FOLEY_TAKES = 2;
/** How hard a shot drives the echo of the space it is fired in. */
const SEND: Record<Space, number> = { street: 0.4, room: 0.5, hall: 0.5, basement: 0.55 };
/** A shot inside still sets the street answering faintly through the doors and windows. */
const STREET_INDOORS = 0.18;
/** Sound escaping a building through its openings, and coming into one from the street. */
const LEAK_OUT: Muffle = { gain: 0.6, cutoff: 2500, walls: 1 };
const LEAK_IN: Muffle = { gain: 0.5, cutoff: 1500, walls: 1 };
/** Other people's shots playing at once; past this the farthest gives way. */
const MAX_REMOTE_SHOTS = 10;
const CRACK_TAKES = 2;
const CRACK_LEVEL = 0.55;
/** Slower than this and a round makes no crack worth hearing (m/s). */
const CRACK_SPEED = 380;
const SPEED_OF_SOUND = 343;
/** Playback level of each handling sound. */
const FOLEY_LEVEL: Record<FoleyKind, number> = {
  magOut: 0.3, magIn: 0.42, bolt: 0.45, pump: 0.45, slide: 0.42, shellIn: 0.3, shellGrab: 0.08, holster: 0.16, draw: 0.16, dryFire: 0.3,
};
/** Handling sounds each gun makes, rendered ahead of time. */
const FOLEY_SET: Record<string, FoleyKind[]> = {
  ar: ['draw', 'holster', 'dryFire', 'magOut', 'magIn', 'bolt'],
  smg: ['draw', 'holster', 'dryFire', 'magOut', 'magIn', 'bolt'],
  marksman: ['draw', 'holster', 'dryFire', 'magOut', 'magIn', 'bolt'],
  pistol: ['draw', 'holster', 'dryFire', 'magOut', 'magIn', 'slide'],
  shotgun: ['draw', 'holster', 'dryFire', 'pump', 'shellIn', 'shellGrab'],
};

function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Web Audio engine, routed through master → {music, effects, ambient} buses with a spatial
 * listener. Ambience, music and voices are synthesized live; guns play from a bank of buffers that
 * GunSynth renders at startup, with convolution echo of the street or the room around the listener.
 */
export class AudioEngine {
  ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  private effects!: GainNode;
  private ambient!: GainNode;
  private noise!: AudioBuffer;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private droneGain!: GainNode;
  private pulseGain!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  /** Each bus's share of the shared reverb, scaled by that bus's volume so a muted bus stays silent. */
  private sends!: Record<'music' | 'effects' | 'ambient', GainNode>;
  /** One echo per kind of space, fed by every shot fired in (or heard from) it. */
  private verbs!: Record<Space, ConvolverNode>;
  private acoustics: Acoustics | null = null;
  /** The kind of space the listener is in. */
  private here: Space = 'street';
  private nextSpace = 0;
  private readonly voices: { end: number; dist: number; level: GainNode }[] = [];
  private readonly bank = new Map<string, AudioBuffer>();
  private bankTimer = 0;
  private readonly listenerPos = new THREE.Vector3();
  private rotorBuffer: AudioBuffer | null = null;
  private readonly rotors = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; lp: BiquadFilterNode; panner: PannerNode }>();
  private nextNote = 0;
  private nextAmbientEvent = 0;
  private nextPulse = 0;
  private time = 0;
  private readonly spatial: { panner: PannerNode; gain: GainNode; level: () => number }[] = [];
  private unsub: (() => void) | null = null;
  /** 0..1 musical tension, driven by the survival director from Phase 5. */
  tension = 0;

  /**
   * Must be called from a user gesture. Safe to call repeatedly. `context` renders into another
   * context instead (an OfflineAudioContext for listening tests).
   */
  unlock(context?: BaseAudioContext): void {
    if (this.ctx) {
      if (this.ctx instanceof AudioContext && this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = context ?? new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.connect(this.master);
    this.music = ctx.createGain();
    this.effects = ctx.createGain();
    this.ambient = ctx.createGain();
    for (const b of [this.music, this.effects, this.ambient]) b.connect(comp);

    // Noise buffer shared by wind, footsteps, thunder.
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let b0 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.985 * b0 + 0.015 * white * 6; // soft pinkish
      data[i] = (white * 0.35 + b0 * 0.65) * 0.8;
    }

    // Synthetic reverb tail.
    this.reverb = ctx.createConvolver();
    const irLen = ctx.sampleRate * 3.2;
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2);
    }
    this.reverb.buffer = ir;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.5;
    this.reverbSend.connect(this.reverb);
    this.sends = { music: ctx.createGain(), effects: ctx.createGain(), ambient: ctx.createGain() };
    for (const send of Object.values(this.sends)) send.connect(this.reverbSend);
    this.reverb.connect(comp);

    const verb = () => {
      const v = ctx.createConvolver();
      v.normalize = false;
      v.connect(this.effects);
      return v;
    };
    this.verbs = { street: verb(), room: verb(), hall: verb(), basement: verb() };
    this.prepareGuns();

    this.startWind();
    this.startDrone();
    this.applyVolumes();
    this.unsub = settings.subscribe(() => this.applyVolumes());
    this.nextNote = 3;
    this.nextAmbientEvent = 6;
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const a = settings.value.audio;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(a.master, t, 0.05);
    this.music.gain.setTargetAtTime(a.music, t, 0.05);
    this.effects.gain.setTargetAtTime(a.effects, t, 0.05);
    this.ambient.gain.setTargetAtTime(a.ambient, t, 0.05);
    this.sends.music.gain.setTargetAtTime(a.music, t, 0.05);
    this.sends.effects.gain.setTargetAtTime(a.effects, t, 0.05);
    this.sends.ambient.gain.setTargetAtTime(a.ambient, t, 0.05);
  }

  private noiseSource(loop = true): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    return s;
  }

  private startWind(): void {
    const ctx = this.ctx!;
    const src = this.noiseSource();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.12;
    src.connect(this.windFilter).connect(this.windGain).connect(this.ambient);
    src.start();
    // Leaves rustle layer.
    const rustle = this.noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3200;
    const rg = ctx.createGain();
    rg.gain.value = 0.018;
    rustle.playbackRate.value = 1.3;
    rustle.connect(hp).connect(rg).connect(this.ambient);
    rustle.start();
  }

  private startDrone(): void {
    const ctx = this.ctx!;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    lp.Q.value = 2;
    lp.connect(this.droneGain).connect(this.music);
    this.droneGain.connect(this.sends.music);
    for (const [f, type, g] of [[43.65, 'sawtooth', 0.22], [65.4, 'triangle', 0.3], [43.9, 'sawtooth', 0.18], [98.0, 'sine', 0.06]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(lp);
      o.start();
    }
    // Slow filter breathing.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 110;
    lfo.connect(lfoG).connect(lp.frequency);
    lfo.start();
    this.droneGain.gain.setTargetAtTime(0.32, ctx.currentTime, 4);

    // Heartbeat-like pulse layer for higher tension.
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0;
    this.pulseGain.connect(this.music);
  }

  /** Sparse, detuned piano-like note in D minor. */
  private pianoNote(): void {
    const ctx = this.ctx!;
    const scale = [146.83, 174.61, 196.0, 220.0, 233.08, 293.66, 349.23];
    const f = scale[Math.floor(Math.random() * scale.length)] * (Math.random() < 0.3 ? 0.5 : 1);
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.07, t + 0.01);
    out.gain.exponentialRampToValueAtTime(0.0008, t + 5.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 3);
    out.connect(lp);
    lp.connect(this.music);
    lp.connect(this.sends.music);
    for (const [mult, g] of [[1, 1], [2, 0.35], [3, 0.12], [4.02, 0.06]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult * (1 + (Math.random() - 0.5) * 0.002);
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(out);
      o.start(t);
      o.stop(t + 6);
    }
  }

  /** Low sub thump for the tension pulse layer. */
  private thump(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(this.pulseGain);
    o.start(t);
    o.stop(t + 0.45);
  }

  thunder(delay: number, power: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = this.noiseSource(false);
    src.playbackRate.value = 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900 * power, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.65 * power, t + 0.08);
    g.gain.setTargetAtTime(0.35 * power, t + 0.3, 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, t + 6);
    src.connect(lp).connect(g).connect(this.ambient);
    g.connect(this.sends.ambient);
    src.start(t);
    src.stop(t + 6.5);
  }

  /** Short filtered noise burst for a foot plant (another survivor's when `position` is given). */
  footstep(loudness: number, indoor: boolean, position?: THREE.Vector3): void {
    if (!this.ctx || loudness <= 0.01) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = this.noiseSource(false);
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = indoor ? 260 + Math.random() * 80 : 900 + Math.random() * 600;
    bp.Q.value = indoor ? 1.8 : 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22 * loudness, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + (indoor ? 0.12 : 0.09));
    if (position) src.connect(bp).connect(g).connect(this.makePanner(position)).connect(this.effects);
    else src.connect(bp).connect(g).connect(this.effects);
    src.start(t, Math.random() * 2);
    src.stop(t + 0.2);
  }

  /** Wooden door creak + latch. */
  door(open: boolean): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(open ? 180 : 140, t);
    o.frequency.linearRampToValueAtTime(open ? 120 : 210, t + 0.45);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    o.connect(bp).connect(g).connect(this.effects);
    o.start(t);
    o.stop(t + 0.6);
    const click = this.noiseSource(false);
    const cg = ctx.createGain();
    const ct = open ? t : t + 0.42;
    cg.gain.setValueAtTime(0.3, ct);
    cg.gain.exponentialRampToValueAtTime(0.001, ct + 0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    click.connect(hp).connect(cg).connect(this.effects);
    click.start(ct);
    click.stop(ct + 0.08);
  }

  ui(kind: 'hover' | 'click' | 'back'): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = kind === 'hover' ? 1250 : kind === 'click' ? 620 : 420;
    const g = ctx.createGain();
    g.gain.setValueAtTime(kind === 'hover' ? 0.018 : 0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + (kind === 'hover' ? 0.06 : 0.16));
    o.connect(g).connect(this.effects);
    o.start(t);
    o.stop(t + 0.2);
  }

  /** Zombie groan: formant-filtered buzzy voice with pitch wobble, spatialized. `pitch` scales voice and formants (brutes low, runners high). */
  groan(position: THREE.Vector3, volume = 1, pitch = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 1.2 + Math.random() * 1.3;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const base = (70 + Math.random() * 40) * pitch;
    o.frequency.setValueAtTime(base, t);
    o.frequency.linearRampToValueAtTime(base * 0.75, t + dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5 + Math.random() * 4;
    const vg = ctx.createGain();
    vg.gain.value = 6;
    vib.connect(vg).connect(o.frequency);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.setValueAtTime(500 * Math.sqrt(pitch), t);
    f1.frequency.linearRampToValueAtTime(320 * Math.sqrt(pitch), t + dur);
    f1.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5 * volume, t + 0.25);
    g.gain.setTargetAtTime(0, t + dur * 0.7, 0.2);
    const panner = this.makePanner(position);
    o.connect(f1).connect(g).connect(panner).connect(this.effects);
    g.connect(this.sends.effects);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 1);
    vib.stop(t + dur + 1);
  }

  private makePanner(position: THREE.Vector3): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 3;
    p.rolloffFactor = 1.2;
    p.maxDistance = 120;
    p.positionX.value = position.x;
    p.positionY.value = position.y;
    p.positionZ.value = position.z;
    return p;
  }

  /**
   * One second of helicopter, seamless as a loop: two-blade rotor slap (whole cycles per second),
   * low thump, turbine whine and broadband wash.
   */
  private makeRotorBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const n = sr;
    const buf = ctx.createBuffer(2, n, sr);
    const slapHz = 11;
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let lpA = 0, lpB = 0, wash = 0, seed = 0x1234567;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) / 4294967296) * 2 - 1;
    };
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const ph = (t * slapHz) % 1;
      // Blade slap: a sharp noisy crack with a body, every 1/11 s; alternate blades differ a little.
      const blade = Math.floor(t * slapHz) % 2;
      const env = Math.exp(-ph * (blade ? 30 : 26));
      const noise = rnd();
      lpA += (noise - lpA) * 0.22;
      lpB += (lpA - lpB) * 0.22;
      const slap = lpB * env * (blade ? 1.6 : 1.9);
      const thump = Math.sin(2 * Math.PI * slapHz * t) * 0.5 * Math.exp(-ph * 6) + Math.sin(2 * Math.PI * slapHz * 2 * t) * 0.12;
      wash += (rnd() - wash) * 0.05;
      const whine = Math.sin(2 * Math.PI * 1310 * t) * 0.03 + Math.sin(2 * Math.PI * 2620 * t) * 0.012 + Math.sin(2 * Math.PI * 434 * t) * 0.02;
      const v = slap + thump + wash * 0.9 + whine;
      // A touch of stereo: the tail rotor's buzz leans one way.
      const tail = Math.sin(2 * Math.PI * 57 * t) * 0.05 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
      L[i] = (v + tail) * 0.45;
      R[i] = (v - tail * 0.5 + rnd() * 0.01) * 0.45;
    }
    // Ease the seam so the loop never clicks.
    const fade = Math.floor(sr * 0.004);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      for (const ch of [L, R]) ch[n - fade + i] = ch[n - fade + i] * (1 - k) + ch[i] * k;
    }
    return buf;
  }

  /**
   * Keeps a rotor loop playing for every helicopter in the air, following it. Heard from far
   * off (a low thump), louder and brighter as it comes overhead.
   */
  helicopters(list: Map<number, { pos: THREE.Vector3; hover: number }>): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [id, r] of this.rotors) {
      if (list.has(id)) continue;
      r.gain.gain.setTargetAtTime(0, t, 0.6);
      r.src.stop(t + 3);
      this.rotors.delete(id);
    }
    for (const [id, h] of list) {
      let r = this.rotors.get(id);
      if (!r) {
        this.rotorBuffer ??= this.makeRotorBuffer();
        const src = ctx.createBufferSource();
        src.buffer = this.rotorBuffer;
        src.loop = true;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 0.5;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(1.1, t + 2.5);
        const panner = this.makePanner(h.pos);
        panner.refDistance = 22;
        panner.rolloffFactor = 1;
        panner.maxDistance = 900;
        src.connect(lp).connect(gain).connect(panner).connect(this.effects);
        const send = ctx.createGain();
        send.gain.value = 0.25;
        gain.connect(send).connect(this.sends.effects);
        src.start(t, Math.random());
        r = { src, gain, lp, panner };
        this.rotors.set(id, r);
      }
      r.panner.positionX.setTargetAtTime(h.pos.x, t, 0.05);
      r.panner.positionY.setTargetAtTime(h.pos.y, t, 0.05);
      r.panner.positionZ.setTargetAtTime(h.pos.z, t, 0.05);
      const d = h.pos.distanceTo(this.listenerPos);
      r.lp.frequency.setTargetAtTime(500 + 11000 / (1 + d / 28), t, 0.1);
      // Rotor speeds up a touch under load in the hover.
      r.src.playbackRate.setTargetAtTime(1 + h.hover * 0.04, t, 0.5);
    }
  }

  /** A supply crate hitting the ground. */
  crateLand(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.35, 6);
    this.tone(d, t, 'sine', 120, 42, 0.9, 0.002, 0.25);
    this.burst(d, t, 'lowpass', 700, 0.8, 0.8, 0.002, 0.18);
    this.burst(d, t + 0.02, 'bandpass', 2300, 2, 0.25, 0.001, 0.06);
    // Rattle of the rounds inside.
    for (let i = 0; i < 6; i++) this.burst(d, t + 0.08 + i * 0.035 + Math.random() * 0.02, 'bandpass', 3200 + Math.random() * 1800, 4, 0.12, 0.001, 0.03);
  }

  /** Persistent spatial emitters (streetlight buzz, car hazard tick). */
  addEmitter(kind: 'buzz' | 'alarm', position: THREE.Vector3, level: () => number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const panner = this.makePanner(position);
    panner.refDistance = kind === 'buzz' ? 1.5 : 2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(panner).connect(this.ambient);
    if (kind === 'buzz') {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 120;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      bp.Q.value = 3;
      const og = ctx.createGain();
      og.gain.value = 0.05;
      o.connect(bp).connect(og).connect(gain);
      o.start();
    } else {
      // Hazard relay click, 1.1s period like the visual blinker.
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 1 / 0.55;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2000;
      const og = ctx.createGain();
      og.gain.value = 0.04;
      o.connect(hp).connect(og).connect(gain);
      o.start();
    }
    this.spatial.push({ panner, gain, level });
  }

  update(dt: number, camera: THREE.Camera): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.time += dt;
    const L = ctx.listener;
    const p = camera.position;
    this.listenerPos.copy(p);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (L.positionX) {
      const t = ctx.currentTime;
      L.positionX.setTargetAtTime(p.x, t, 0.02);
      L.positionY.setTargetAtTime(p.y, t, 0.02);
      L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      L.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      L.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      L.upX.setTargetAtTime(up.x, t, 0.02);
      L.upY.setTargetAtTime(up.y, t, 0.02);
      L.upZ.setTargetAtTime(up.z, t, 0.02);
    }
    for (const s of this.spatial) s.gain.gain.setTargetAtTime(s.level(), ctx.currentTime, 0.015);
    if (this.time > this.nextSpace) {
      this.here = this.spaceOf(p);
      this.nextSpace = this.time + 0.2;
    }

    // Wind gusts.
    const gust = 0.1 + Math.max(0, Math.sin(this.time * 0.21) * Math.sin(this.time * 0.53 + 1)) * 0.16;
    this.windGain.gain.setTargetAtTime(gust, ctx.currentTime, 0.4);
    this.windFilter.frequency.setTargetAtTime(320 + gust * 1400, ctx.currentTime, 0.5);

    // Dynamic music: tension raises the pulse layer and opens the drone.
    this.pulseGain.gain.setTargetAtTime(this.tension * 0.35, ctx.currentTime, 2);
    if (this.tension > 0.15 && this.time > this.nextPulse) {
      this.thump();
      this.nextPulse = this.time + THREE.MathUtils.lerp(1.4, 0.55, this.tension);
    }
    if (this.time > this.nextNote) {
      this.pianoNote();
      this.nextNote = this.time + 6 + Math.random() * 12 * (1 - this.tension * 0.6);
    }
    if (this.danger > 0.05 && this.time > this.nextBeat) {
      this.heartbeat();
      this.nextBeat = this.time + THREE.MathUtils.lerp(1.05, 0.55, this.danger);
    }
    if (this.time > this.nextAmbientEvent) {
      this.ambientEvent(camera.position);
      this.nextAmbientEvent = this.time + 9 + Math.random() * 16;
    }
  }

  /** Distant one-shots: dog bark, house creak. */
  private ambientEvent(around: THREE.Vector3): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const angle = Math.random() * Math.PI * 2;
    const far = around.clone().add(new THREE.Vector3(Math.cos(angle) * 60, 2, Math.sin(angle) * 60));
    const panner = this.makePanner(far);
    panner.refDistance = 20;
    const kind = Math.random();
    if (kind < 0.45) {
      // Dog bark: two short tonal-noise barks.
      for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
        const bt = t + i * 0.32;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(520, bt);
        o.frequency.exponentialRampToValueAtTime(260, bt + 0.12);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1100;
        bp.Q.value = 2;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, bt);
        g.gain.linearRampToValueAtTime(0.12, bt + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, bt + 0.16);
        o.connect(bp).connect(g).connect(panner);
        o.start(bt);
        o.stop(bt + 0.2);
      }
      panner.connect(this.ambient);
      panner.connect(this.sends.ambient);
    } else {
      // Wooden creak.
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(90, t);
      o.frequency.linearRampToValueAtTime(70 + Math.random() * 40, t + 1.4);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 650;
      bp.Q.value = 10;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.4);
      g.gain.linearRampToValueAtTime(0, t + 1.5);
      o.connect(bp).connect(g).connect(panner);
      panner.connect(this.ambient);
      o.start(t);
      o.stop(t + 1.6);
    }
  }

  // ------------------------------------------------------------------ combat

  /** Output chain for a one-shot: spatial when a position is given, with a reverb send. */
  private out(position: THREE.Vector3 | null, reverb = 0, ref = 3): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    if (position) {
      const p = this.makePanner(position);
      p.refDistance = ref;
      g.connect(p).connect(this.effects);
    } else {
      g.connect(this.effects);
    }
    if (reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = reverb;
      g.connect(s).connect(this.sends.effects);
    }
    return g;
  }

  /** Filtered noise burst with an attack/decay envelope. */
  private burst(dest: AudioNode, t: number, type: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number, rate = 1): void {
    const ctx = this.ctx!;
    const src = this.noiseSource(false);
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + attack + decay);
    src.connect(f).connect(g).connect(dest);
    // The noise buffer is 3 s long: start early enough that long tails don't run out.
    src.start(t, Math.random() * Math.max(0, 2.9 - (attack + decay) * rate));
    src.stop(t + attack + decay + 0.05);
  }

  /** Oscillator with a pitch glide and a percussive envelope. */
  private tone(dest: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, peak: number, attack: number, decay: number, glide = decay): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + glide);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + attack + decay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  /** A rendered buffer from the bank, rendering it now if the background pass hasn't yet. */
  private sample(key: string, make: () => Channels): AudioBuffer {
    let b = this.bank.get(key);
    if (!b) {
      const chs = make();
      b = this.ctx!.createBuffer(chs.length, chs[0].length, this.ctx!.sampleRate);
      for (let i = 0; i < chs.length; i++) b.copyToChannel(chs[i], i);
      this.bank.set(key, b);
    }
    return b;
  }

  private shotBuffer(id: string, take: number): AudioBuffer {
    const key = `shot:${id}:${take}`;
    return this.sample(key, () => renderShot(GUN_SOUNDS[id].shot, this.ctx!.sampleRate, seedOf(key)));
  }

  private mechBuffer(id: string): AudioBuffer | null {
    const mech = GUN_SOUNDS[id].mech;
    return mech ? this.sample(`mech:${id}`, () => renderMech(mech, this.ctx!.sampleRate, seedOf(id))) : null;
  }

  private foleyBuffer(kind: FoleyKind, id: string, take: number): AudioBuffer {
    const key = `foley:${kind}:${id}:${take}`;
    return this.sample(key, () => renderFoley(kind, id, this.ctx!.sampleRate, seedOf(key)));
  }

  private echo(space: Space): ConvolverNode {
    const v = this.verbs[space];
    if (!v.buffer) {
      v.buffer = this.sample(`ir:${space}`, () => space === 'street'
        ? streetIR(this.ctx!.sampleRate, 7)
        : enclosedIR(space, this.ctx!.sampleRate, 11));
    }
    return v;
  }

  private crackBuffer(id: string, take: number): AudioBuffer {
    const key = `crack:${id}:${take}`;
    const gun = GUN_SOUNDS[id];
    const strength = Math.min(1, (gun.velocity - 343) / 500);
    return this.sample(key, () => renderCrack(gun.shot.crack || 0.00015, strength, this.ctx!.sampleRate, seedOf(key)));
  }

  /** Renders the gun bank one buffer per task, so startup never stalls a frame for long. */
  private prepareGuns(): void {
    const jobs: (() => void)[] = (['street', ...Object.keys(ENCLOSURES) as Enclosure[]] as Space[]).map((s) => () => this.echo(s));
    for (const id of Object.keys(GUN_SOUNDS)) {
      for (let k = 0; k < SHOT_TAKES; k++) jobs.push(() => this.shotBuffer(id, k));
      jobs.push(() => this.mechBuffer(id));
      if (GUN_SOUNDS[id].velocity >= CRACK_SPEED) for (let k = 0; k < CRACK_TAKES; k++) jobs.push(() => this.crackBuffer(id, k));
    }
    for (const [id, kinds] of Object.entries(FOLEY_SET)) {
      for (const kind of kinds) for (let k = 0; k < FOLEY_TAKES; k++) jobs.push(() => this.foleyBuffer(kind, id, k));
    }
    const run = () => {
      const job = jobs.shift();
      if (!job || !this.ctx) return;
      job();
      this.bankTimer = window.setTimeout(run, 0);
    };
    this.bankTimer = window.setTimeout(run, 0);
  }

  /** The map's acoustics (spaces and walls) for the game in progress; null in the menu. */
  setAcoustics(a: Acoustics | null): void {
    this.acoustics = a;
    this.here = 'street';
    this.nextSpace = 0;
  }

  private spaceOf(p: Vec3): Space {
    return this.acoustics?.spaceAt(p.x, p.y, p.z) ?? 'street';
  }

  /** Through walls: darker and quieter (nothing is added when the way is clear). */
  private muffled(from: AudioNode, m: Muffle): AudioNode {
    if (!m.walls) return from;
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = m.cutoff;
    lp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.value = m.gain;
    from.connect(lp).connect(g);
    return g;
  }

  /** Feeds a space's echo (muffling before the convolution is the same as after, and cheaper). */
  private sendTo(from: AudioNode, space: Space, amount: number, m: Muffle = CLEAR): void {
    if (amount <= 0.001) return;
    const g = this.ctx!.createGain();
    g.gain.value = amount;
    this.muffled(from, m).connect(g).connect(this.echo(space));
  }

  /**
   * Someone else's shot takes a voice: when too many fire at once the farthest gives way
   * (false: this one is the farthest and is dropped).
   */
  private claimVoice(dist: number, end: number, level: GainNode): boolean {
    const now = this.ctx!.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].end < now) this.voices.splice(i, 1);
    if (this.voices.length >= MAX_REMOTE_SHOTS) {
      let far = 0;
      for (let i = 1; i < this.voices.length; i++) if (this.voices[i].dist > this.voices[far].dist) far = i;
      if (this.voices[far].dist <= dist) return false;
      this.voices[far].level.gain.setTargetAtTime(0, now, 0.008);
      this.voices.splice(far, 1);
    }
    this.voices.push({ end, dist, level });
    return true;
  }

  /**
   * Gunshot, built the way it reaches the ear:
   * - the report, at the shooter's face for your own gun; for anyone else's, late by the speed of
   *   sound, dulled by the air and panned from where they stand, and darker and quieter through
   *   every wall and closed door in between;
   * - the space the gun is in answering (street, room, store or garage, basement), heard directly
   *   when you're in it and through the walls when you're not; what escapes a building sets the
   *   street ringing, and a shot outside shakes the room you're in a little;
   * - far away the direct sound fades faster than the echo, so distant shots are mostly echo;
   * - a supersonic round passing near you cracks before its report arrives.
   */
  gunshot(weapon: string, position: THREE.Vector3, local: boolean, bullets?: Vec3[]): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const id = GUN_SOUNDS[weapon] ? weapon : 'ar';
    const gun = GUN_SOUNDS[id];
    const L = this.listenerPos;
    const here = this.here;
    const there = local ? here : this.spaceOf(position);
    const d = local ? 0 : position.distanceTo(L);
    const src = ctx.createBufferSource();
    src.buffer = this.shotBuffer(id, Math.floor(Math.random() * SHOT_TAKES));
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.03;
    const level = ctx.createGain();
    level.gain.value = gun.level;
    src.connect(level);
    const t = ctx.currentTime + d / SPEED_OF_SOUND;
    if (!local && !this.claimVoice(d, t + src.buffer.duration, level)) return;
    const echo = gun.echo / (1 + d / 200);
    if (local) {
      // The gun is at the shooter's face: no panning, the shot fills both ears.
      level.connect(this.effects);
      this.sendTo(level, here, echo * SEND[here]);
      if (here !== 'street') this.sendTo(level, 'street', echo * SEND.street * STREET_INDOORS, LEAK_OUT);
    } else {
      const wall = this.acoustics ? this.acoustics.occlusion(position.x, position.y, position.z, L.x, L.y, L.z) : CLEAR;
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = Math.max(1200, 16000 / (1 + d / 30));
      const p = this.makePanner(position);
      p.refDistance = 8;
      level.connect(air);
      this.muffled(air, wall).connect(p).connect(this.effects);
      // Echo finds its way round through doors and windows: less muffled than the straight line.
      const apart = there !== here || wall.walls > 0;
      const leak: Muffle = !apart ? CLEAR : wall.walls
        ? { gain: Math.max(wall.gain, 0.2), cutoff: Math.max(wall.cutoff, 1200), walls: wall.walls }
        : LEAK_IN;
      this.sendTo(level, there, echo * SEND[there], leak);
      if (there !== 'street') this.sendTo(level, 'street', echo * SEND.street * STREET_INDOORS, here === 'street' ? LEAK_OUT : leak);
      else if (here !== 'street') this.sendTo(level, here, echo * SEND[here] * 0.15, LEAK_IN);
      if (bullets && gun.velocity >= CRACK_SPEED) this.flyby(id, position, bullets, ctx.currentTime);
    }
    src.start(t);
    const mech = local ? this.mechBuffer(id) : null;
    if (mech) {
      const m = ctx.createBufferSource();
      m.buffer = mech;
      m.playbackRate.value = src.playbackRate.value;
      const mg = ctx.createGain();
      mg.gain.value = gun.mechLevel;
      m.connect(mg).connect(this.effects);
      m.start(t);
    }
  }

  private readonly flyAt = new THREE.Vector3();

  /**
   * A supersonic bullet passing within a few metres: its shock wave cracks from the point of
   * closest approach as soon as the bullet gets there, ahead of the report from the gun.
   */
  private flyby(id: string, from: THREE.Vector3, ends: Vec3[], now: number): void {
    const ctx = this.ctx!;
    const gun = GUN_SOUNDS[id];
    const L = this.listenerPos;
    let miss = Infinity, along = 0;
    for (const e of ends) {
      const dx = e.x - from.x, dy = e.y - from.y, dz = e.z - from.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-3) continue;
      const s = Math.max(0, Math.min(len, ((L.x - from.x) * dx + (L.y - from.y) * dy + (L.z - from.z) * dz) / len));
      const px = from.x + (dx / len) * s, py = from.y + (dy / len) * s, pz = from.z + (dz / len) * s;
      const m = Math.hypot(L.x - px, L.y - py, L.z - pz);
      if (m < miss) {
        miss = m;
        along = s;
        this.flyAt.set(px, py, pz);
      }
    }
    // Close enough to hear it pass, and past the gun's own blast (which hides it).
    if (miss > 10 || along < 3) return;
    const src = ctx.createBufferSource();
    src.buffer = this.crackBuffer(id, Math.floor(Math.random() * CRACK_TAKES));
    const g = ctx.createGain();
    g.gain.value = CRACK_LEVEL * Math.min(1, (1.2 / Math.max(0.4, miss)) ** 0.75);
    const p = this.makePanner(this.flyAt);
    p.rolloffFactor = 0;
    src.connect(g).connect(p).connect(this.effects);
    src.start(now + along / gun.velocity + miss / SPEED_OF_SOUND);
  }

  dryFire(position: THREE.Vector3, weapon = 'ar'): void {
    this.foley('dryFire', position, weapon);
  }

  /** Reload and handling foley, voiced for the gun in hand. */
  foley(kind: FoleyKind, position: THREE.Vector3, weapon = 'ar'): void {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.foleyBuffer(kind, GUN_SOUNDS[weapon] ? weapon : 'ar', Math.floor(Math.random() * FOLEY_TAKES));
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.04;
    const d = this.out(position, 0.05, 2);
    d.gain.value = FOLEY_LEVEL[kind];
    src.connect(d);
    src.start();
  }

  casing(position: THREE.Vector3, shell: boolean, strength: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.05, 1.5);
    if (shell) {
      this.tone(d, t, 'triangle', 820, 600, 0.08 * strength, 0.001, 0.05);
      this.burst(d, t, 'bandpass', 1400, 2, 0.05 * strength, 0.001, 0.03);
    } else {
      const f = 4200 + Math.random() * 1800;
      this.tone(d, t, 'sine', f, f * 0.98, 0.05 * strength, 0.001, 0.07);
      this.tone(d, t, 'sine', f * 1.51, f * 1.5, 0.025 * strength, 0.001, 0.05);
    }
  }

  /** A round striking the world. */
  impact(surface: string, position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.12, 2.5);
    switch (surface) {
      case 'metal':
        for (const [f, g] of [[1700, 0.12], [2650, 0.08], [4100, 0.05]] as const) this.tone(d, t, 'sine', f * (0.95 + Math.random() * 0.1), f * 0.97, g, 0.001, 0.28);
        this.burst(d, t, 'highpass', 3000, 0.7, 0.2, 0.001, 0.03);
        break;
      case 'glass':
        this.burst(d, t, 'highpass', 2500, 0.7, 0.35, 0.001, 0.12);
        for (let i = 0; i < 6; i++) {
          const f = 3000 + Math.random() * 4500;
          this.tone(d, t + Math.random() * 0.3, 'sine', f, f, 0.03, 0.001, 0.08 + Math.random() * 0.1);
        }
        break;
      case 'wood':
        this.burst(d, t, 'bandpass', 520, 1.2, 0.3, 0.001, 0.07);
        this.tone(d, t, 'triangle', 220, 120, 0.15, 0.001, 0.08);
        break;
      case 'grass':
      case 'dirt':
      case 'fabric':
        this.burst(d, t, 'lowpass', 380, 0.7, 0.3, 0.002, 0.06);
        break;
      default:
        this.burst(d, t, 'bandpass', 2100, 1, 0.3, 0.001, 0.05);
        this.burst(d, t, 'lowpass', 500, 0.7, 0.15, 0.002, 0.07);
        // Occasional ricochet whine.
        if (Math.random() < 0.18) this.tone(d, t + 0.02, 'sine', 3200, 1300, 0.035, 0.01, 0.3);
    }
  }

  /** Wet hit on a body. */
  flesh(position: THREE.Vector3, heavy: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.05, 3);
    this.burst(d, t, 'lowpass', 750, 1, 0.45 * (0.6 + heavy * 0.5), 0.002, 0.07 + heavy * 0.04);
    this.tone(d, t, 'sine', 110, 55, 0.4 * (0.5 + heavy * 0.5), 0.002, 0.09);
    this.burst(d, t + 0.01, 'bandpass', 1200, 3, 0.1, 0.005, 0.08, 0.7);
  }

  /** Hit confirmation ticks (not spatial). */
  hitMarker(kind: 'hit' | 'kill' | 'head'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(null);
    if (kind === 'hit') {
      this.tone(d, t, 'square', 2600, 2400, 0.018, 0.001, 0.025);
    } else if (kind === 'kill') {
      this.tone(d, t, 'triangle', 1500, 1450, 0.06, 0.001, 0.07);
      this.tone(d, t + 0.06, 'triangle', 1100, 1080, 0.06, 0.001, 0.1);
    } else {
      this.tone(d, t, 'sine', 3300, 3250, 0.07, 0.001, 0.22);
      this.tone(d, t, 'sine', 4950, 4900, 0.03, 0.001, 0.15);
    }
  }

  meleeSwing(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const d = this.out(position, 0, 2);
    const src = this.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2.5;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(1800, t + 0.12);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    src.connect(f).connect(g).connect(d);
    src.start(t);
    src.stop(t + 0.3);
  }

  /** Something heavy and limp swung through the air: a low, slow whoosh with a wet flap in it. */
  heavySwing(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const d = this.out(position, 0, 2);
    const src = this.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.6;
    f.frequency.setValueAtTime(180, t);
    f.frequency.exponentialRampToValueAtTime(900, t + 0.22);
    f.frequency.exponentialRampToValueAtTime(260, t + 0.42);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(f).connect(g).connect(d);
    src.start(t);
    src.stop(t + 0.47);
    // The dangling end slapping about.
    this.burst(d, t + 0.08, 'bandpass', 900, 2.5, 0.06, 0.004, 0.05, 0.6);
  }

  /** An arm coming off: bone cracking, sinew ripping, a wet gush. */
  sever(position: THREE.Vector3, melee: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.12, 3.5);
    // Bone: a sharp crack, then splintering.
    this.burst(d, t, 'highpass', 2600, 0.8, 0.55, 0.001, 0.025);
    this.tone(d, t, 'square', 950, 260, 0.08, 0.001, 0.035);
    for (let i = 0; i < 3; i++) this.burst(d, t + 0.015 + Math.random() * 0.05, 'bandpass', 3000 + Math.random() * 2500, 2, 0.12, 0.001, 0.015);
    // Sinew and skin tearing: a run of short wet rips.
    for (let i = 0; i < 9; i++) {
      const at = t + 0.02 + i * 0.018 + Math.random() * 0.012;
      this.burst(d, at, 'bandpass', 700 + Math.random() * 1100, 4, 0.16 + Math.random() * 0.1, 0.002, 0.03, 0.7);
    }
    // The meat of it, and the blood coming out.
    this.burst(d, t, 'lowpass', 650, 0.9, 0.5, 0.002, 0.12);
    this.tone(d, t, 'sine', 150, 55, 0.45, 0.002, 0.14);
    this.burst(d, t + 0.06, 'lowpass', 1100, 0.7, 0.22, 0.03, 0.42, 0.8);
    if (melee) this.tone(d, t, 'sine', 210, 80, 0.4, 0.001, 0.08);
  }

  /** Clubbing with a severed arm: a heavy, wet, meaty thud. */
  clubHit(position: THREE.Vector3, heavy: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.08, 3);
    this.tone(d, t, 'sine', 95, 38, 0.75 * (0.7 + heavy * 0.3), 0.002, 0.16);
    this.burst(d, t, 'lowpass', 420, 0.8, 0.6, 0.002, 0.13);
    this.burst(d, t, 'bandpass', 1500, 1.4, 0.3, 0.001, 0.05);
    this.burst(d, t + 0.02, 'bandpass', 850, 3, 0.22, 0.004, 0.14, 0.6);
    if (Math.random() < 0.5) this.burst(d, t + 0.01, 'highpass', 2400, 1, 0.12, 0.001, 0.02);
  }

  /** A worn-out arm bursting apart in the hands. */
  limbBreak(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.15, 3);
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.03 + Math.random() * 0.02;
      this.burst(d, at, 'highpass', 2200 + Math.random() * 1500, 0.8, 0.35, 0.001, 0.02);
      this.tone(d, at, 'square', 800 + Math.random() * 300, 240, 0.05, 0.001, 0.03);
    }
    this.burst(d, t, 'lowpass', 700, 0.8, 0.6, 0.002, 0.2);
    this.tone(d, t, 'sine', 120, 45, 0.5, 0.002, 0.18);
    // Wet pieces landing all around.
    for (let i = 0; i < 10; i++) this.burst(d, t + 0.2 + Math.random() * 0.45, 'bandpass', 600 + Math.random() * 900, 3, 0.07 + Math.random() * 0.06, 0.003, 0.05, 0.7);
  }

  /** Getting a grip on a severed arm: a cold, wet squelch. */
  limbGrab(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0, 2);
    this.burst(d, t, 'lowpass', 520, 0.8, 0.3, 0.004, 0.09);
    this.burst(d, t + 0.03, 'bandpass', 1100, 4, 0.16, 0.006, 0.16, 0.5);
    this.tone(d, t, 'sine', 130, 70, 0.18, 0.003, 0.07);
  }

  /** A severed arm hitting the ground. */
  limbLand(position: THREE.Vector3, strength: number): void {
    if (!this.ctx || strength < 0.08) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.05, 2.5);
    this.tone(d, t, 'sine', 125, 55, 0.35 * strength, 0.002, 0.1);
    this.burst(d, t, 'lowpass', 480, 0.8, 0.35 * strength, 0.002, 0.08);
    this.burst(d, t + 0.005, 'bandpass', 1300, 2, 0.14 * strength, 0.002, 0.06, 0.7);
  }

  /** Formant-filtered growl for the zombie voices. */
  private voice(position: THREE.Vector3, t: number, f0: number, f1: number, formant: number, dur: number, peak: number, wobble: number, rough = 0): void {
    const ctx = this.ctx!;
    const d = this.out(position, 0.25, 3);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = wobble;
    const vg = ctx.createGain();
    vg.gain.value = f0 * 0.06;
    vib.connect(vg).connect(o.frequency);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = formant;
    bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.min(0.06, dur * 0.2));
    g.gain.setTargetAtTime(0, t + dur * 0.75, dur * 0.15);
    o.connect(bp).connect(g).connect(d);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.5);
    vib.stop(t + dur + 0.5);
    if (rough > 0) this.burst(d, t, 'bandpass', formant * 1.6, 2, rough, 0.03, dur * 0.8);
  }

  zombieAlert(position: THREE.Vector3, pitch = 1): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = Math.sqrt(pitch);
    if (pitch > 1.1) {
      // Runners shriek: a rising scream, then a ragged gasp.
      this.voice(position, t, 260 * pitch, 720 * pitch, 1500, 0.6, 0.6, 11, 0.2);
      this.voice(position, t + 0.55, 520, 220, 1100, 0.35, 0.35, 16, 0.18);
      return;
    }
    this.voice(position, t, (180 + Math.random() * 60) * pitch, 320 * pitch, 900 * f, 0.45 * (2 - f), 0.55, 7, 0.12);
    this.voice(position, t + 0.4, 300 * pitch, 140 * pitch, 700 * f, 0.7 * (2 - f), 0.45, 5, 0.08);
  }

  zombieAttack(position: THREE.Vector3, pitch = 1): void {
    if (!this.ctx) return;
    const f = Math.sqrt(pitch);
    this.voice(position, this.ctx.currentTime, 150 * pitch, 95 * pitch, 650 * f, 0.38 * (2 - f), 0.5, 28, 0.15);
  }

  zombieHurt(position: THREE.Vector3, pitch = 1): void {
    if (!this.ctx) return;
    const f = Math.sqrt(pitch);
    this.voice(position, this.ctx.currentTime, (130 + Math.random() * 30) * pitch, 100 * pitch, 560 * f, 0.18, 0.35, 12);
  }

  zombieDeath(position: THREE.Vector3, pitch = 1): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = Math.sqrt(pitch);
    this.voice(position, t, 110 * pitch, 48 * pitch, 420 * f, 0.9 * (2 - f), 0.42, 9, 0.12);
    this.burst(this.out(position, 0.1, 3), t + 0.5, 'lowpass', 300, 0.7, 0.35, 0.01, 0.2);
  }

  doorPound(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.45, 4);
    this.tone(d, t, 'sine', 90, 45, 0.7, 0.003, 0.18);
    this.burst(d, t, 'lowpass', 420, 0.8, 0.6, 0.002, 0.14);
    this.burst(d, t + 0.01, 'highpass', 2800, 1, 0.12, 0.002, 0.07);
  }

  doorBurst(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.6, 5);
    this.burst(d, t, 'lowpass', 2500, 0.7, 0.9, 0.002, 0.35);
    this.tone(d, t, 'sine', 80, 35, 0.8, 0.003, 0.3);
    for (let i = 0; i < 7; i++) this.burst(d, t + 0.03 + Math.random() * 0.35, 'highpass', 2000 + Math.random() * 3000, 1, 0.2, 0.001, 0.03);
  }

  playerHurt(heavy: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const d = this.out(null);
    this.burst(d, t, 'lowpass', 600, 0.8, 0.5 * (0.6 + heavy * 0.4), 0.002, 0.12);
    this.tone(d, t, 'sine', 95, 45, 0.5, 0.002, 0.15);
    // Grunt.
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(190 + Math.random() * 30, t + 0.02);
    o.frequency.exponentialRampToValueAtTime(130, t + 0.25);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 720;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t + 0.02);
    g.gain.linearRampToValueAtTime(0.16, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(bp).connect(g).connect(d);
    o.start(t + 0.02);
    o.stop(t + 0.3);
  }

  bandage(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(null);
    for (let i = 0; i < 4; i++) this.burst(d, t + i * 0.45, 'highpass', 1800 + Math.random() * 800, 0.8, 0.1, 0.04, 0.3, 1.2);
  }

  pickup(kind: 'ammo' | 'bandage' | 'weapon' | 'supply'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(null);
    if (kind === 'supply') {
      // Lid, then handfuls of loose rounds and magazines going into pouches.
      this.burst(d, t, 'bandpass', 900, 1.5, 0.35, 0.002, 0.07);
      for (let i = 0; i < 10; i++) this.burst(d, t + 0.1 + i * 0.045 + Math.random() * 0.02, 'bandpass', 2400 + Math.random() * 2200, 3, 0.2, 0.001, 0.04);
      this.tone(d, t + 0.55, 'triangle', 260, 170, 0.14, 0.002, 0.12);
      this.burst(d, t + 0.62, 'bandpass', 1500, 2, 0.3, 0.002, 0.06);
      return;
    }
    if (kind === 'ammo') {
      for (let i = 0; i < 5; i++) this.burst(d, t + i * 0.05 + Math.random() * 0.02, 'bandpass', 2600 + Math.random() * 1500, 3, 0.18, 0.001, 0.04);
      this.tone(d, t, 'triangle', 300, 200, 0.12, 0.002, 0.1);
    } else if (kind === 'bandage') {
      this.burst(d, t, 'lowpass', 1200, 0.7, 0.2, 0.02, 0.2);
    } else {
      this.burst(d, t, 'bandpass', 1200, 2, 0.4, 0.002, 0.08);
      this.burst(d, t + 0.12, 'bandpass', 2800, 3, 0.4, 0.001, 0.05);
    }
  }

  /** The outbreak begins: low swelling chord and a far-off siren. */
  outbreak(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(1400, t + 2.5);
    lp.frequency.exponentialRampToValueAtTime(300, t + 6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 1.8);
    g.gain.exponentialRampToValueAtTime(0.001, t + 6.5);
    lp.connect(g);
    g.connect(this.music);
    g.connect(this.sends.music);
    for (const f of [55, 55.4, 82.4, 110.3, 130.8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start(t);
      o.stop(t + 6.6);
    }
    // Civil defense siren across town.
    const s = ctx.createOscillator();
    s.type = 'triangle';
    s.frequency.setValueAtTime(420, t + 0.5);
    for (let i = 0; i < 3; i++) {
      s.frequency.linearRampToValueAtTime(820, t + 1.8 + i * 2.6);
      s.frequency.linearRampToValueAtTime(420, t + 3.1 + i * 2.6);
    }
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t + 0.5);
    sg.gain.linearRampToValueAtTime(0.05, t + 1.5);
    sg.gain.setTargetAtTime(0, t + 7.5, 0.6);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    s.connect(bp).connect(sg).connect(this.ambient);
    sg.connect(this.sends.ambient);
    s.start(t + 0.5);
    s.stop(t + 10);
  }

  /** Death sting. */
  death(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(null, 0.8);
    this.tone(d, t, 'sine', 60, 28, 0.6, 0.01, 2.5);
    this.burst(d, t, 'lowpass', 220, 0.7, 0.4, 0.05, 2);
  }

  /** 0 (healthy) .. 1 (near death): heartbeat and muffled hearing. */
  setVitals(danger: number): void {
    this.danger = danger;
  }
  private danger = 0;
  private nextBeat = 0;

  private heartbeat(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const d = this.out(null);
    const v = 0.25 + this.danger * 0.45;
    this.tone(d, t, 'sine', 62, 40, v, 0.01, 0.12);
    this.tone(d, t + 0.17, 'sine', 55, 36, v * 0.7, 0.01, 0.14);
  }

  dispose(): void {
    for (const r of this.rotors.values()) r.src.stop();
    this.rotors.clear();
    this.unsub?.();
    window.clearTimeout(this.bankTimer);
    this.bank.clear();
    if (this.ctx instanceof AudioContext) void this.ctx.close();
    this.ctx = null;
  }
}

export const audio = new AudioEngine();
