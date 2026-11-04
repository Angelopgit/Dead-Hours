import * as THREE from 'three';
import { settings } from '../core/Settings';
import type { Vec3 } from '@dead-hours/shared';
import { ENCLOSURES, GUN_SOUNDS, enclosedIR, renderCrack, renderFoley, renderMech, renderShot, streetIR, type Channels, type Enclosure, type FoleyKind } from './GunSynth';
import { RELOAD_STEPS } from '../weapons/reloadScript';
import { CLEAR, type Acoustics, type Muffle, type Space } from './Acoustics';
import { renderMeleeHit, renderMeleePickup, renderMeleeSwing } from './MeleeSynth';
import { MELEE, WEAPONS, type BoostId, type MeleeId } from '@dead-hours/shared';
import { RECORDED_HANDLING, RECORDED_SHOTS, groupRecordings, recordingBytes, trimLead } from './Recordings';
import { ShotVoices } from './ShotVoices';
import { RECORDED_FILES } from './recordedFiles';
import { weather } from '../environment/Weather';
import { EMITTER, emitterOn, type EmitterKind } from './Emitters';
import { WheelSounds } from './WheelSounds';
import { FRAGMENTS, THEME, THEME_BEATS, beatSeconds, midiHz, type Note } from './Score';

/** Close-shot takes rendered per gun and picked at random, so full auto never repeats one. */
/** Guns voiced by another's sounds: the akimbo pair is two M17s. */
const SOUND_OF: Record<string, string> = { akimbo: 'pistol' };
/** The GUN_SOUNDS / recordings entry a weapon is heard as ('ar' for anything unknown). */
const soundOf = (weapon: string): string => (GUN_SOUNDS[weapon] ? weapon : SOUND_OF[weapon] ?? 'ar');

const SHOT_TAKES = 4;
const FOLEY_TAKES = 2;
/** Takes rendered of each melee weapon's swing, blow (light and heavy each) and pickup. */
const MELEE_TAKES = { swing: 3, hit: 4, pickup: 2 };
const MELEE_IDS = Object.keys(MELEE) as MeleeId[];
const MELEE_BLOWS = ['light', 'kill', 'head'] as const;
type MeleeBlow = (typeof MELEE_BLOWS)[number];
/** How long the background bank renderer may hold a task (ms), and how long `prepare` may. */
const BANK_SLICE = 4;
const PREPARE_SLICE = 24;
/** How hard a shot drives the echo of the space it is fired in. */
const SEND: Record<Space, number> = { street: 0.4, room: 0.5, hall: 0.5, basement: 0.55 };
/** A shot inside still sets the street answering faintly through the doors and windows. */
const STREET_INDOORS = 0.18;
/** Sound escaping a building through its openings, and coming into one from the street. */
const LEAK_OUT: Muffle = { gain: 0.6, cutoff: 2500, walls: 1 };
const LEAK_IN: Muffle = { gain: 0.5, cutoff: 1500, walls: 1 };
/** Someone else's report at the listener: full level to this distance, then inverse distance (its panner). */
const REMOTE_REF = 8;
const REMOTE_ROLLOFF = 1.2;
/** A report let go to make room (an older one of the same gun's, or the quietest) fades over this (s). */
const SHOT_RELEASE = 0.025;
/** Cases hitting the ground farther off than this (m) are lost under everything else: not played. */
const CASING_RANGE = 15;
/**
 * HRTF panning (true 3D on headphones) for one-shots this close (m), at most HRTF_RATE new ones a
 * second (bursts of HRTF_BURST); the rest pan left-right. Chrome works out each new HRTF panner's
 * filters on the audio thread: dozens a second in a firefight made the output drop out in bursts
 * (measured in dev/firefight: ~110 underruns in 20 s with HRTF on everything, ~5 with this).
 */
const HRTF_RANGE = 10;
const HRTF_RATE = 12;
const HRTF_BURST = 6;
/**
 * Left-right panning brought up to HRTF's level: HRTF plays the engine's sounds louder (measured
 * 2-4 dB for zombie voices, steps and impacts, 2 dB for flesh hits, most in front), so a sound
 * keeps its loudness whichever it gets.
 */
const EQUAL_MAKEUP = 1.4;
const CRACK_TAKES = 2;
const CRACK_LEVEL = 0.55;
/** Slower than this and a round makes no crack worth hearing (m/s). */
const CRACK_SPEED = 380;
const SPEED_OF_SOUND = 343;
/**
 * Guns get their own bus, louder than the rest of the effects (whose volume setting they follow)
 * and past the compressor that holds the rest of the mix down: a compressor flattens the crack of
 * a shot by 15 dB or more, so nothing on their way out compresses them; a soft clipper on the
 * master rounds off whatever goes over.
 */
const GUN_GAIN = 1.6;
/** The master's soft clipper: unity gain below CLIP_KNEE, rounding off to just under full scale. */
const CLIP_KNEE = 0.6;
const CLIP_RANGE = 2;
/** Your own shot pushes everything but guns and voices down for a moment: the ears closing up. */
const DUCK_DEPTH = 0.45;
const DUCK_HOLD = 0.06;
const DUCK_RECOVER = 0.14;
/** Flesh hits this close together in time and place play as one (a load of buckshot). */
const FLESH_GAP = 0.03;
/** A recorded take indoors: the range's own outdoor tail gives way to the room's echo after this. */
const INDOOR_TAIL = 0.12;
/**
 * Zombies carry: full level to ZOMBIE_REF metres, then inverse distance, slower than other
 * sounds, so a groan is still made out at 60 m. Walls between muffle them like gunshots.
 */
const ZOMBIE_REF = 6;
const ZOMBIE_ROLLOFF = 0.85;
const ZOMBIE_LEVEL = 2.4;
/** Zombie groans sounding at once before distant ones are left out. */
const MAX_GROANS = 12;
/** Zombie footsteps by gait: loud enough to hear them coming down the street, not just groaning. */
const STEP_LEVEL = { walker: 1.8, runner: 1.7, brute: 1.2 };
/** Playback level of each synthesized handling sound (recorded ones are levelled in Recordings.ts). */
const FOLEY_LEVEL: Record<FoleyKind, number> = {
  magOut: 0.3, magIn: 0.42, bolt: 0.45, charge: 0.48, cock: 0.38, slap: 0.48, opRod: 0.48, slide: 0.42,
  pumpBack: 0.42, pumpFwd: 0.45, shellIn: 0.3, shellGrab: 0.08, coverOpen: 0.32, coverClose: 0.42, belt: 0.2,
  pouch: 0.09, pouchGrab: 0.07, magDrop: 0.3, holster: 0.16, draw: 0.16, dryFire: 0.3,
};
/** Synthesized handling sounds each gun makes, rendered ahead of time: its reload's, and the pump's. */
const FOLEY_SET: Record<string, FoleyKind[]> = Object.fromEntries(Object.keys(GUN_SOUNDS).map((id) => [id, [
  ...new Set<FoleyKind>(['draw', 'holster', 'dryFire', ...(RELOAD_STEPS[id] ?? []).map((s) => s.cue), ...(id === 'shotgun' ? ['pumpBack', 'pumpFwd'] as const : [])]),
]]));
/** How far someone else's reload carries (m). */
const FOLEY_RANGE = 30;
/** How much a handling sound sets its space ringing: a basement answers a magazine going in, the street hardly. */
const FOLEY_ECHO: Record<Space, number> = { street: 0.01, room: 0.04, hall: 0.05, basement: 0.06 };

const _foleyAt = new THREE.Vector3();

/** Transfer curve for the master's WaveShaper, which sees the signal scaled down by CLIP_RANGE. */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4097;
  const curve = new Float32Array(n);
  const top = 0.98;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * CLIP_RANGE;
    const a = Math.abs(x);
    const y = a < CLIP_KNEE ? a : CLIP_KNEE + (top - CLIP_KNEE) * Math.tanh((a - CLIP_KNEE) / (top - CLIP_KNEE));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

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
  /** Shared with WheelSounds. */
  effects!: GainNode;
  private ambient!: GainNode;
  /** Other players' voices: straight to the master, past the compressor (gunfire doesn't pump them). */
  private voiceBus!: GainNode;
  /** Shots, their echo and fly-by cracks. */
  private guns!: GainNode;
  /** Between the compressed mix (music, effects, ambience) and the master: dips under your own shots. */
  private duck!: GainNode;
  /** Decoded recordings by set name; empty until they are decoded (synthesized sounds stand in). */
  private readonly recorded = new Map<string, AudioBuffer[]>();
  /** Settles once the recordings are decoded, or have failed to (then synthesized sounds play). */
  recordingsReady: Promise<void> = Promise.resolve();
  /** Recent flesh hits, so a load of pellets lands as one wet hit. */
  private fleshes: { t: number; at: THREE.Vector3 }[] = [];
  private noise!: AudioBuffer;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rainGain!: GainNode;
  private rainFilter!: BiquadFilterNode;
  private roofGain!: GainNode;
  private droneGain!: GainNode;
  private pulseGain!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  /** Each bus's share of the shared reverb, scaled by that bus's volume so a muted bus stays silent. */
  /** Shared with WheelSounds. */
  sends!: Record<'music' | 'effects' | 'ambient', GainNode>;
  /** One echo per kind of space, fed by every shot fired in (or heard from) it. */
  private verbs!: Record<Space, ConvolverNode>;
  private acoustics: Acoustics | null = null;
  /** The kind of space the listener is in. */
  private here: Space = 'street';
  private nextSpace = 0;
  /** Every report sounding now, yours and everyone else's: who is heard when many guns fire at once. */
  private readonly shotVoices = new ShotVoices();
  /** Where the Web Audio listener was last put, so it is only moved when the camera moves. */
  private readonly heard = new Float32Array(9).fill(NaN);
  /** HRTF panners that may start now (refilled at HRTF_RATE a second), and when it was last refilled. */
  private hrtfTokens = HRTF_BURST;
  private hrtfAt = 0;
  private readonly bank = new Map<string, AudioBuffer>();
  private bankTimer = 0;
  /** Bank sounds still to render (see prepareGuns), and how many were queued in all. */
  private bankJobs: (() => void)[] = [];
  private bankTotal = 0;
  /** Recording sets being decoded, and how many have finished (or failed). */
  private recordingSets = 0;
  private recordingsDone = 0;
  private readonly listenerPos = new THREE.Vector3();
  /** When each groan now sounding ends. */
  private groaning: number[] = [];
  /** Where in each handling take its main hit is (s): its loudest moment. */
  private readonly hits = new WeakMap<AudioBuffer, number>();
  private rotorBuffer: AudioBuffer | null = null;
  private readonly rotors = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; lp: BiquadFilterNode; panner: PannerNode }>();
  private vanSound: { oscs: OscillatorNode[]; rumble: AudioBufferSourceNode; gain: GainNode; lp: BiquadFilterNode; panner: PannerNode } | null = null;
  private nextNote = 0;
  private nextAmbientEvent = 0;
  private nextPulse = 0;
  private time = 0;
  /** The lamp buzzes and hazard clicks (see Emitters.ts); `on` while connected. */
  private readonly spatial: { panner: PannerNode; gain: GainNode; level: () => number; pos: THREE.Vector3; at: THREE.Vector3; on: boolean }[] = [];
  private unsub: (() => void) | null = null;
  /** 0..1 musical tension (stays 0 until something drives it). */
  tension = 0;
  /** The menu plays the whole theme (audio/Score.ts); a quiet night brings back fragments of it; a fight, none. */
  scene: 'menu' | 'night' | 'fight' = 'menu';
  /** Skateboards, cars and bicycles (audio/WheelSounds.ts). */
  readonly wheels = new WheelSounds(this);

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
    // Guns on top of everything else round off instead of clipping the output.
    const down = ctx.createGain();
    down.gain.value = 1 / CLIP_RANGE;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = '2x';
    this.master.connect(down).connect(clip).connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.duck = ctx.createGain();
    comp.connect(this.duck).connect(this.master);
    this.guns = ctx.createGain();
    this.guns.connect(this.master);
    this.music = ctx.createGain();
    this.effects = ctx.createGain();
    this.ambient = ctx.createGain();
    for (const b of [this.music, this.effects, this.ambient]) b.connect(comp);
    this.voiceBus = ctx.createGain();
    this.voiceBus.connect(this.master);

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
      v.connect(this.guns);
      return v;
    };
    this.verbs = { street: verb(), room: verb(), hall: verb(), basement: verb() };
    this.recordingsReady = this.loadRecordings(ctx);
    this.prepareGuns();

    this.startWind();
    this.startRain();
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
    this.guns.gain.setTargetAtTime(a.effects * GUN_GAIN, t, 0.05);
    this.ambient.gain.setTargetAtTime(a.ambient, t, 0.05);
    this.voiceBus.gain.setTargetAtTime(a.voice, t, 0.05);
    this.sends.music.gain.setTargetAtTime(a.music, t, 0.05);
    this.sends.effects.gain.setTargetAtTime(a.effects, t, 0.05);
    this.sends.ambient.gain.setTargetAtTime(a.ambient, t, 0.05);
  }

  /** Shared with WheelSounds. */
  noiseSource(loop = true): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    return s;
  }

  /**
   * Once a one-shot's source has stopped, cuts it and the nodes only it feeds (`chain`) out of the
   * mix. Chrome keeps rendering a node fed by two or more finished sources until garbage collection
   * gets round to them: every case hitting the road, every zombie step and flesh hit left its panner
   * running, so the audio thread's load climbed through a firefight until the output broke up
   * (measured: two tones into one panner, four a frame, took it from 10 % to over 500 % of real time
   * in 12 s). Disconnected, the shared node they fed is released as soon as its last source ends.
   */
  /** Shared with WheelSounds. */
  free(src: AudioScheduledSourceNode, ...chain: AudioNode[]): void {
    src.addEventListener('ended', () => {
      src.disconnect();
      for (const n of chain) n.disconnect();
    }, { once: true });
  }

  /**
   * Rain: a bright hiss of drops on the street and a low drum on the roof. Outside the hiss is
   * open; inside it dulls behind the walls and the roof drum takes over; a basement hears little.
   */
  private startRain(): void {
    const ctx = this.ctx!;
    const src = this.noiseSource();
    src.playbackRate.value = 1.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'lowpass';
    this.rainFilter.frequency.value = 9000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    src.connect(hp).connect(this.rainFilter).connect(this.rainGain).connect(this.ambient);
    src.start();
    const roof = this.noiseSource();
    roof.playbackRate.value = 0.7;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 260;
    bp.Q.value = 0.8;
    this.roofGain = ctx.createGain();
    this.roofGain.gain.value = 0;
    roof.connect(bp).connect(this.roofGain).connect(this.ambient);
    roof.start();
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

  /** Plays a passage of the score from ctx time `at`: every note scheduled now, on the beat. */
  private playScore(notes: readonly Note[], at: number, gain = 1): void {
    const beat = beatSeconds();
    for (const [b, midi, len, vel] of notes) this.pianoNote(midiHz(midi), at + b * beat, vel * gain, len * beat);
  }

  /** A soft, slightly detuned piano-like note: frequency, start (ctx time), loudness 0..1, held seconds. */
  private pianoNote(f: number, t: number, vel: number, held: number): void {
    const ctx = this.ctx!;
    const ring = Math.max(2.5, held + 2);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.085 * vel, t + 0.012);
    out.gain.exponentialRampToValueAtTime(0.03 * vel + 1e-4, t + Math.min(held, 1.2));
    out.gain.exponentialRampToValueAtTime(0.0008, t + ring);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400 + 1600 * vel, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + ring * 0.6);
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
      this.free(o, og);
      o.start(t);
      o.stop(t + ring + 0.5);
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
    if (position) src.connect(bp).connect(g).connect(this.place(position, this.effects));
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
    // A horde groans all the time: past a dozen at once, only the near ones get a voice.
    this.groaning = this.groaning.filter((end) => end > t);
    if (this.groaning.length >= MAX_GROANS && position.distanceTo(this.listenerPos) > 20) return;
    this.groaning.push(t + dur);
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
    g.gain.linearRampToValueAtTime(0.5 * volume * ZOMBIE_LEVEL, t + 0.25);
    g.gain.setTargetAtTime(0, t + dur * 0.7, 0.2);
    o.connect(f1).connect(g).connect(this.zombieOut(position, 1));
    this.free(o, f1, g);
    this.free(vib, vg);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 1);
    vib.stop(t + dur + 1);
  }

  /** A panner, HRTF unless `hrtf` is false; lasting sounds (rotors, fires, explosions) use it as is. */
  /** Shared with WheelSounds. */
  makePanner(position: THREE.Vector3, hrtf = true): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
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
   * A one-shot's panner, feeding `outs`: HRTF when near and within the rate the audio thread keeps up
   * with (hrtf()), else left-right panning raised by EQUAL_MAKEUP.
   */
  private place(position: THREE.Vector3, ...outs: AudioNode[]): PannerNode {
    const hrtf = this.hrtf(position);
    const p = this.makePanner(position, hrtf);
    let from: AudioNode = p;
    if (!hrtf) {
      const up = this.ctx!.createGain();
      up.gain.value = EQUAL_MAKEUP;
      from = p.connect(up);
    }
    for (const o of outs) from.connect(o);
    return p;
  }

  /** Whether a one-shot here gets HRTF panning (near, and within the rate the audio thread keeps up with). */
  private hrtf(position: THREE.Vector3): boolean {
    if (position.distanceToSquared(this.listenerPos) > HRTF_RANGE * HRTF_RANGE) return false;
    const now = this.ctx!.currentTime;
    this.hrtfTokens = Math.min(HRTF_BURST, this.hrtfTokens + (now - this.hrtfAt) * HRTF_RATE);
    this.hrtfAt = now;
    if (this.hrtfTokens < 1) return false;
    this.hrtfTokens--;
    return true;
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

  /**
   * The raiders' van: a diesel's low growl that rises with its speed, a lazy idle once parked,
   * heard from a long way off down the street. `null` lets it die away.
   */
  van(state: { pos: THREE.Vector3; speed: number; idle: boolean } | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (!state) {
      if (this.vanSound) {
        const v = this.vanSound;
        v.gain.gain.setTargetAtTime(0, t, 0.4);
        for (const o of v.oscs) o.stop(t + 2.5);
        v.rumble.stop(t + 2.5);
        this.vanSound = null;
      }
      return;
    }
    let v = this.vanSound;
    if (!v) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.55, t + 2);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2;
      lp.frequency.value = 300;
      const panner = this.makePanner(state.pos);
      panner.refDistance = 7;
      panner.rolloffFactor = 1;
      panner.maxDistance = 600;
      lp.connect(gain).connect(panner).connect(this.effects);
      const send = ctx.createGain();
      send.gain.value = 0.2;
      gain.connect(send).connect(this.sends.effects);
      const oscs = [0, 1, 2].map((i) => {
        const o = ctx.createOscillator();
        o.type = i === 2 ? 'square' : 'sawtooth';
        const og = ctx.createGain();
        og.gain.value = [0.4, 0.22, 0.08][i];
        o.connect(og).connect(lp);
        o.start(t);
        return o;
      });
      const rumble = ctx.createBufferSource();
      rumble.buffer = this.noise;
      rumble.loop = true;
      const rl = ctx.createBiquadFilter();
      rl.type = 'lowpass';
      rl.frequency.value = 180;
      const rg = ctx.createGain();
      rg.gain.value = 0.5;
      rumble.connect(rl).connect(rg).connect(gain);
      rumble.start(t);
      v = { oscs, rumble, gain, lp, panner };
      this.vanSound = v;
    }
    v.panner.positionX.setTargetAtTime(state.pos.x, t, 0.05);
    v.panner.positionY.setTargetAtTime(state.pos.y, t, 0.05);
    v.panner.positionZ.setTargetAtTime(state.pos.z, t, 0.05);
    // Engine speed: idling, or pulling in the gears.
    const gear = state.speed < 0.3 ? 0 : (state.speed % 4.5) / 4.5;
    const base = state.idle && state.speed < 0.3 ? 26 : 34 + gear * 22 + state.speed * 1.2;
    v.oscs[0].frequency.setTargetAtTime(base, t, 0.15);
    v.oscs[1].frequency.setTargetAtTime(base * 2.01, t, 0.15);
    v.oscs[2].frequency.setTargetAtTime(base * 0.5, t, 0.15);
    v.lp.frequency.setTargetAtTime(220 + state.speed * 55, t, 0.2);
    v.gain.gain.setTargetAtTime(state.idle ? 0.3 : 0.55, t, 0.5);
  }

  /** The raiders show up: a heavy low hit and a sour rising tone. */
  raidSting(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [f, d] of [[55, 0], [58.3, 0.02], [82.4, 0.04]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t + d);
      o.frequency.linearRampToValueAtTime(f * 1.06, t + 2.4);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(160, t + 2.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + d);
      g.gain.linearRampToValueAtTime(0.09, t + d + 0.03);
      g.gain.setTargetAtTime(0, t + 0.9, 0.7);
      o.connect(lp).connect(g).connect(this.music);
      g.connect(this.sends.music);
      o.start(t + d);
      o.stop(t + 4.5);
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
  addEmitter(kind: EmitterKind, position: THREE.Vector3, level: () => number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const panner = this.makePanner(position);
    panner.refDistance = EMITTER[kind].refDistance;
    panner.rolloffFactor = EMITTER.rolloff;
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
      og.gain.value = EMITTER.buzz.gain;
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
      og.gain.value = EMITTER.alarm.gain;
      o.connect(hp).connect(og).connect(gain);
      o.start();
    }
    this.spatial.push({ panner, gain, level, pos: position, at: position.clone(), on: true });
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
    // Set straight, and only when the camera moved: an automated listener (setTargetAtTime every
    // frame) makes every panner in the mix work out its direction sample by sample, which triples
    // their cost and leaves the audio thread behind in a firefight (dropouts).
    const at = [p.x, p.y, p.z, fwd.x, fwd.y, fwd.z, up.x, up.y, up.z];
    let moved = false;
    for (let i = 0; i < 9; i++) if (!(Math.abs(at[i] - this.heard[i]) < 1e-4)) moved = true;
    if (moved) {
      this.heard.set(at);
      if (L.positionX) {
        const params = [L.positionX, L.positionY, L.positionZ, L.forwardX, L.forwardY, L.forwardZ, L.upX, L.upY, L.upZ];
        for (let i = 0; i < 9; i++) params[i].value = at[i];
      } else {
        // Firefox: only the old setters.
        L.setPosition(p.x, p.y, p.z);
        L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
      }
    }
    for (const s of this.spatial) {
      // Out of earshot a chain is cut off, so the audio thread stops working its panner (Emitters.ts).
      const on = emitterOn(s.on, s.pos.distanceToSquared(p));
      if (on !== s.on) {
        s.on = on;
        if (on) {
          s.gain.gain.cancelScheduledValues(ctx.currentTime);
          s.gain.gain.setValueAtTime(0, ctx.currentTime);
          s.gain.connect(s.panner);
          s.panner.connect(this.ambient);
        } else {
          s.gain.disconnect();
          s.panner.disconnect();
        }
      }
      if (!on) continue;
      s.gain.gain.setTargetAtTime(s.level(), ctx.currentTime, 0.015);
      // One on something that moves (a car with its hazards on) follows it.
      if (s.at.distanceToSquared(s.pos) > 0.01) {
        s.at.copy(s.pos);
        s.panner.positionX.value = s.pos.x;
        s.panner.positionY.value = s.pos.y;
        s.panner.positionZ.value = s.pos.z;
      }
    }
    if (this.time > this.nextSpace) {
      this.here = this.spaceOf(p);
      this.nextSpace = this.time + 0.2;
    }

    // Rain, by the space the listener is in.
    const r = weather.rain;
    const inside = this.here !== 'street';
    const deep = this.here === 'basement';
    this.rainGain.gain.setTargetAtTime(r * (deep ? 0.012 : inside ? 0.05 : 0.16), ctx.currentTime, 0.5);
    this.rainFilter.frequency.setTargetAtTime(deep ? 700 : inside ? 1800 : 9000, ctx.currentTime, 0.3);
    this.roofGain.gain.setTargetAtTime(r * (deep ? 0.02 : inside ? 0.12 : 0.03), ctx.currentTime, 0.5);

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
    // The score: the whole theme on the menu, then a long rest; at night a fragment now and
    // then while it is quiet, and nothing while the fighting is loud.
    if (this.time > this.nextNote) {
      const beat = beatSeconds();
      if (this.scene === 'menu') {
        this.playScore(THEME, ctx.currentTime + 0.1);
        this.nextNote = this.time + THEME_BEATS * beat + 14 + Math.random() * 16;
      } else if (this.scene === 'night' && this.tension < 0.45) {
        this.playScore(FRAGMENTS[Math.floor(Math.random() * FRAGMENTS.length)], ctx.currentTime + 0.1, 0.8);
        this.nextNote = this.time + 10 * beat + 25 + Math.random() * 30;
      } else {
        this.nextNote = this.time + 8;
      }
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
    const kind = Math.random();
    const panner = kind < 0.45 ? this.place(far, this.ambient, this.sends.ambient) : this.place(far, this.ambient);
    panner.refDistance = 20;
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
        this.free(o, bp, g);
        o.start(bt);
        o.stop(bt + 0.2);
      }
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
      o.start(t);
      o.stop(t + 1.6);
    }
  }

  // ------------------------------------------------------------------ combat

  /** Output chain for a one-shot: spatial when a position is given, with a reverb send. */
  /** Shared with WheelSounds. */
  out(position: THREE.Vector3 | null, reverb = 0, ref = 3): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    if (position) {
      const p = this.place(position, this.effects);
      p.refDistance = ref;
      g.connect(p);
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
  /** Shared with WheelSounds. */
  burst(dest: AudioNode, t: number, type: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number, rate = 1): void {
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
    this.free(src, f, g);
  }

  /** Oscillator with a pitch glide and a percussive envelope. */
  /** Shared with WheelSounds. */
  tone(dest: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, peak: number, attack: number, decay: number, glide = decay): void {
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
    this.free(o, g);
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

  /**
   * Queues every synthesized sound the game can play (echoes, gun mechanics, cracks, handling,
   * melee swings and hits, the helicopter) and renders them a few milliseconds per task in the
   * background; `prepare` finishes the queue before a night so nothing is rendered mid-fight.
   */
  private prepareGuns(): void {
    const jobs: (() => void)[] = (['street', ...Object.keys(ENCLOSURES) as Enclosure[]] as Space[]).map((s) => () => this.echo(s));
    const later: (() => void)[] = [];
    for (const id of Object.keys(GUN_SOUNDS)) {
      // Recorded guns only need their synthesized shot if the recordings fail to decode.
      const rec = RECORDED_SHOTS[id];
      for (let k = 0; k < SHOT_TAKES; k++) {
        if (!rec) jobs.push(() => this.shotBuffer(id, k));
        else later.push(() => { if (!this.recorded.has(rec.set)) this.shotBuffer(id, k); });
      }
      jobs.push(() => this.mechBuffer(id));
      if (GUN_SOUNDS[id].velocity >= CRACK_SPEED) for (let k = 0; k < CRACK_TAKES; k++) jobs.push(() => this.crackBuffer(id, k));
    }
    for (const [id, kinds] of Object.entries(FOLEY_SET)) {
      for (const kind of kinds) for (let k = 0; k < FOLEY_TAKES; k++) jobs.push(() => this.foleyBuffer(kind, id, k));
    }
    // Found melee weapons: every take of every swing, blow and pickup.
    for (const w of MELEE_IDS) {
      for (let k = 0; k < MELEE_TAKES.swing; k++) jobs.push(() => this.meleeSwingBuffer(w, k));
      for (const blow of MELEE_BLOWS) for (let k = 0; k < MELEE_TAKES.hit; k++) jobs.push(() => this.meleeHitBuffer(w, blow, k));
      for (let k = 0; k < MELEE_TAKES.pickup; k++) jobs.push(() => this.meleePickupBuffer(w, k));
    }
    jobs.push(() => { this.rotorBuffer ??= this.makeRotorBuffer(); });
    this.bankJobs = jobs;
    this.bankTotal = jobs.length;
    // The stand-in shots wait for the recordings to have had their chance to decode.
    void this.recordingsReady.then(() => {
      this.bankJobs.push(...later);
      this.bankTotal += later.length;
      this.pumpBank();
    });
    this.pumpBank();
  }

  /** Renders queued bank sounds for up to `budget` ms; returns whether any are left. */
  private renderBank(budget: number): boolean {
    const end = performance.now() + budget;
    while (this.ctx && this.bankJobs.length && performance.now() < end) this.bankJobs.shift()!();
    return this.bankJobs.length > 0;
  }

  /** The background renderer: a sliver per task, so the menu never stalls a frame for it. */
  private pumpBank(): void {
    if (this.bankTimer) return;
    const run = () => {
      this.bankTimer = 0;
      if (this.ctx && this.renderBank(BANK_SLICE)) this.bankTimer = window.setTimeout(run, 0);
    };
    this.bankTimer = window.setTimeout(run, 0);
  }

  /**
   * Gets every sound ready for a night: the recordings decoded and the whole synthesized bank
   * rendered (in larger slices than the background does, yielding between them so a loading
   * screen keeps moving). `onProgress` gets 0..1. Resolves at once if audio isn't running.
   */
  async prepare(onProgress?: (f: number) => void): Promise<void> {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const report = () => {
      const total = this.bankTotal + this.recordingSets;
      const done = this.bankTotal - this.bankJobs.length + this.recordingsDone;
      onProgress?.(total > 0 ? Math.min(1, done / total) : 1);
    };
    report();
    // The bikes' and boards' loops are built here rather than at the first ride (a hitch otherwise).
    this.wheels.bikeBuffers();
    this.wheels.skateBuffers();
    let decoded = false;
    void this.recordingsReady.then(() => { decoded = true; });
    while (this.ctx === ctx) {
      const left = this.renderBank(PREPARE_SLICE);
      report();
      if (!left && decoded) break;
      await new Promise<void>((r) => setTimeout(r, left ? 0 : 16));
    }
    // The cracks' white noise (skateboards, car doors and crashes): made now, not on the first one.
    if (this.ctx === ctx) this.wheels.skateBuffers();
    report();
  }

  /** Decodes the recordings; each set is used as soon as it is ready. */
  private async loadRecordings(ctx: BaseAudioContext): Promise<void> {
    const sets = Object.entries(groupRecordings(RECORDED_FILES));
    this.recordingSets = sets.length;
    this.recordingsDone = 0;
    const results = await Promise.allSettled(sets.map(async ([set, urls]) => {
      try {
        const takes = await Promise.all(urls.map(async (url) => trimLead(ctx, await ctx.decodeAudioData(await recordingBytes(url)))));
        if (this.ctx === ctx) this.recorded.set(set, takes);
      } finally {
        this.recordingsDone++;
      }
    }));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length) console.warn(`${failed.length} recorded sound sets failed to decode; synthesized sounds stand in`, failed[0].reason);
  }

  /** A random take of a recording set, if it is decoded. */
  private recording(set: string): AudioBuffer | null {
    const takes = this.recorded.get(set);
    return takes?.length ? takes[Math.floor(Math.random() * takes.length)] : null;
  }

  /** A shot for this gun: a recorded take once decoded, else the synthesized one. */
  private shot(id: string): { buffer: AudioBuffer; level: number; rate: number; recorded: boolean } {
    const rec = RECORDED_SHOTS[id];
    const buffer = rec && this.recording(rec.set);
    if (rec && buffer) return { buffer, level: rec.level, rate: rec.rate, recorded: true };
    return { buffer: this.shotBuffer(id, Math.floor(Math.random() * SHOT_TAKES)), level: GUN_SOUNDS[id].level, rate: 1, recorded: false };
  }

  /**
   * Your own shot: a sub-bass kick under the recording, and the rest of the mix dipping under it
   * (`scale` below 1 for a suppressed shot).
   */
  private kick(id: string, t: number, scale = 1): void {
    const weight = (RECORDED_SHOTS[id]?.punch ?? 0.5) * scale;
    this.tone(this.guns, t, 'sine', 78, 36, 0.55 * weight, 0.002, 0.16, 0.12);
    const g = this.duck.gain;
    const depth = 1 - (1 - DUCK_DEPTH) * Math.min(1, 0.5 + weight * 0.5) * scale;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(depth, t, 0.004);
    g.setTargetAtTime(1, t + DUCK_HOLD, DUCK_RECOVER);
  }

  /** The map's acoustics (spaces and walls) for the game in progress; null in the menu. */
  setAcoustics(a: Acoustics | null): void {
    this.acoustics = a;
    this.here = 'street';
    this.nextSpace = 0;
  }

  /** Where other players' voices are mixed in (null until audio is unlocked). */
  get voiceOut(): AudioNode | null {
    return this.ctx ? this.voiceBus : null;
  }

  /** Where the listener (the camera) is. */
  get listener(): Vec3 {
    return this.listenerPos;
  }

  /** What a voice at `from` loses through the walls on its way to the listener. */
  muffle(from: Vec3): Muffle {
    const l = this.listenerPos;
    return this.acoustics?.occlusion(from.x, from.y, from.z, l.x, l.y, l.z) ?? CLEAR;
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
  /**
   * `suppressed`: through a suppressor, a dull thump that barely carries and hardly echoes.
   * `owner`: who fired (a player or raider id), so one gun's reports share their voices (ShotVoices).
   */
  gunshot(weapon: string, position: THREE.Vector3, local: boolean, bullets?: Vec3[], suppressed = false, owner?: string): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const id = soundOf(weapon);
    const gun = GUN_SOUNDS[id];
    const L = this.listenerPos;
    const here = this.here;
    const there = local ? here : this.spaceOf(position);
    const d = local ? 0 : position.distanceTo(L);
    const shot = this.shot(id);
    const src = ctx.createBufferSource();
    src.buffer = shot.buffer;
    src.playbackRate.value = shot.rate * (1 + (Math.random() * 2 - 1) * 0.03);
    const level = ctx.createGain();
    const lv = shot.level * (suppressed ? 0.3 : 1);
    level.gain.value = lv;
    if (suppressed) {
      const can = ctx.createBiquadFilter();
      can.type = 'lowpass';
      can.frequency.value = 2400;
      src.connect(can).connect(level);
    } else src.connect(level);
    const now = ctx.currentTime;
    const who = owner ?? (local ? 'self' : `at:${Math.round(position.x / 2)},${Math.round(position.z / 2)}`);
    // Someone else's shots can arrive bunched up (a network hitch): spread back out at the gun's rate.
    const fire = local ? now : this.shotVoices.fireAt(who, now, 60 / (WEAPONS[weapon as keyof typeof WEAPONS]?.fireRate || 600));
    const t = fire + d / SPEED_OF_SOUND;
    const wall = local || !this.acoustics ? CLEAR : this.acoustics.occlusion(position.x, position.y, position.z, L.x, L.y, L.z);
    const cracks = !local && !!bullets && gun.velocity >= CRACK_SPEED;
    // Recorded outdoors: fired inside, the recording's own tail is cut short and the room answers.
    const indoor = shot.recorded && there !== 'street';
    const end = t + (indoor ? INDOOR_TAIL + 0.5 : src.buffer.duration / src.playbackRate.value);
    const reach = local ? 1 : REMOTE_REF / (REMOTE_REF + REMOTE_ROLLOFF * Math.max(0, d - REMOTE_REF));
    const played = this.shotVoices.claim({
      owner: who,
      start: t, end, loud: lv * reach * wall.gain, own: local,
      release: (from) => {
        level.gain.cancelScheduledValues(from);
        level.gain.setTargetAtTime(0, from, SHOT_RELEASE);
        src.stop(Math.min(end, from + SHOT_RELEASE * 7));
      },
    }, now);
    if (!played) {
      // Too quiet under everything else to be heard; a round passing close still cracks.
      if (cracks) this.flyby(id, position, bullets!, fire);
      return;
    }
    if (indoor) {
      level.gain.setValueAtTime(lv, t + INDOOR_TAIL);
      level.gain.setTargetAtTime(0, t + INDOOR_TAIL, 0.07);
    }
    const echo = (gun.echo / (1 + d / 200)) * (suppressed ? 0.3 : 1);
    if (local) {
      this.kick(id, t, suppressed ? 0.3 : 1);
      // The gun is at the shooter's face: no panning, the shot fills both ears.
      level.connect(this.guns);
      this.sendTo(level, here, echo * SEND[here]);
      if (here !== 'street') this.sendTo(level, 'street', echo * SEND.street * STREET_INDOORS, LEAK_OUT);
    } else {
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = Math.max(1200, 16000 / (1 + d / 30));
      const p = this.place(position, this.guns);
      p.refDistance = REMOTE_REF;
      p.rolloffFactor = REMOTE_ROLLOFF;
      level.connect(air);
      this.muffled(air, wall).connect(p);
      // Echo finds its way round through doors and windows: less muffled than the straight line.
      const apart = there !== here || wall.walls > 0;
      const leak: Muffle = !apart ? CLEAR : wall.walls
        ? { gain: Math.max(wall.gain, 0.2), cutoff: Math.max(wall.cutoff, 1200), walls: wall.walls }
        : LEAK_IN;
      this.sendTo(level, there, echo * SEND[there], leak);
      if (there !== 'street') this.sendTo(level, 'street', echo * SEND.street * STREET_INDOORS, here === 'street' ? LEAK_OUT : leak);
      else if (here !== 'street') this.sendTo(level, here, echo * SEND[here] * 0.15, LEAK_IN);
      if (cracks) this.flyby(id, position, bullets!, fire);
    }
    src.start(t);
    if (indoor) src.stop(end);
    const mech = local ? this.mechBuffer(id) : null;
    if (mech) {
      const m = ctx.createBufferSource();
      m.buffer = mech;
      m.playbackRate.value = src.playbackRate.value;
      const mg = ctx.createGain();
      mg.gain.value = gun.mechLevel;
      m.connect(mg).connect(this.guns);
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
    const p = this.place(this.flyAt, this.guns);
    p.rolloffFactor = 0;
    src.connect(g).connect(p);
    src.start(now + along / gun.velocity + miss / SPEED_OF_SOUND);
  }

  /**
   * A flashlight's clicky tailcap switch, pressed and let go: your own close at hand, another
   * survivor's from their chest (quiet: heard a few metres off).
   */
  flashlight(on: boolean, position?: THREE.Vector3): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const d = position ? this.out(position, 0.03, 1.2) : this.out(null, 0.02);
    d.gain.value = position ? 0.45 : 0.3;
    const take = this.recording('torch');
    // Switching off sounds a touch lower: the spring lets the cap back out.
    const rate = (on ? 1.03 : 0.95) * (1 + (Math.random() * 2 - 1) * 0.02);
    if (take) {
      const src = ctx.createBufferSource();
      src.buffer = take;
      src.playbackRate.value = rate;
      src.connect(d);
      src.start();
      return;
    }
    // Until the recording is decoded: two snaps of plastic and spring.
    const t = ctx.currentTime;
    for (const [at, peak] of [[0, 0.5], [0.12, 0.75]] as const) {
      this.burst(d, t + at, 'highpass', 3200 * rate, 0.8, peak, 0.0004, 0.012);
      this.tone(d, t + at, 'sine', 5400 * rate, 5000 * rate, peak * 0.2, 0.0004, 0.02);
      this.burst(d, t + at, 'bandpass', 1300, 2, peak * 0.3, 0.0008, 0.02);
    }
  }

  dryFire(position: THREE.Vector3, weapon = 'ar', own = false): void {
    this.foley('dryFire', position, weapon, 0, own);
  }

  /**
   * A handling sound (a reload's magazine, bolt or shell, the pump, drawing and holstering) voiced
   * for the gun: a recorded take once decoded, pitched for the size of the gun's parts, else the
   * synthesized one. `inS`: how long until its main hit should land (the magazine seating as the
   * hand pushes it home); the take starts early enough that what leads up to it plays first. Your
   * own (`own`) come from your hands; anyone else's carry FOLEY_RANGE m and are muffled through
   * walls. Each one rings in the space it is made in.
   */
  foley(kind: FoleyKind, position: THREE.Vector3, weapon = 'ar', inS = 0, own = false): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    // A dropped magazine lands at the feet, about 1.1 m under the hand.
    const at = kind === 'magDrop' ? _foleyAt.set(position.x, position.y - 1.1, position.z) : position;
    if (!own && at.distanceTo(this.listenerPos) > FOLEY_RANGE) return;
    const id = soundOf(weapon);
    const voice = RECORDED_HANDLING[id]?.[kind];
    const take = voice ? this.recording(voice.set) : null;
    const buffer = take ?? this.foleyBuffer(kind, id, Math.floor(Math.random() * FOLEY_TAKES));
    const rate = (take ? voice!.rate : 1) * (1 + (Math.random() * 2 - 1) * 0.03);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = (take ? voice!.level : FOLEY_LEVEL[kind]) * (0.92 + Math.random() * 0.16);
    src.connect(g);
    const p = this.place(at, this.effects);
    p.refDistance = own ? 2 : 1.5;
    const m = own ? CLEAR : this.muffle(at);
    this.muffled(g, m).connect(p);
    const space = own ? this.here : this.spaceOf(at);
    this.sendTo(g, space, FOLEY_ECHO[space], m);
    src.start(ctx.currentTime + Math.max(0, inS - this.hitOf(buffer) / rate));
  }

  /** Where a take's main hit is (s from its start): its loudest sample. */
  private hitOf(buf: AudioBuffer): number {
    let at = this.hits.get(buf);
    if (at === undefined) {
      const x = buf.getChannelData(0);
      let k = 0;
      for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[k])) k = i;
      at = k / buf.sampleRate;
      this.hits.set(buf, at);
    }
    return at;
  }

  casing(position: THREE.Vector3, shell: boolean, strength: number): void {
    if (!this.ctx || position.distanceToSquared(this.listenerPos) > CASING_RANGE * CASING_RANGE) return;
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

  /**
   * A round (or a blow) going into a body, heard from where it lands: a recorded impact with a
   * wet layer, a skull hit on headshots and a heavy punch under big or melee hits. Your own hits
   * carry further than other people's. Pellets landing together play as one.
   */
  flesh(position: THREE.Vector3, hit: { damage: number; head: boolean; own: boolean; melee: boolean; power?: number }): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.fleshes = this.fleshes.filter((f) => now - f.t < FLESH_GAP);
    if (this.fleshes.some((f) => f.at.distanceToSquared(position) < 1)) return;
    this.fleshes.push({ t: now, at: position.clone() });
    // Heavy rounds (GORE.power) land like heavy blows whatever damage is left to do.
    const power = hit.power ?? 0;
    const heavy = Math.max(Math.min(1, hit.damage / 60), Math.min(1, power * 0.8));
    const t = now + position.distanceTo(this.listenerPos) / SPEED_OF_SOUND;
    const g = ctx.createGain();
    const p = this.place(position, this.effects);
    p.refDistance = hit.own ? 10 : 4;
    this.muffled(g, this.muffle(position)).connect(p);
    const verb = ctx.createGain();
    verb.gain.value = 0.06;
    g.connect(verb).connect(this.sends.effects);
    const impact = this.recording('flesh');
    if (!impact) {
      // Synthesized until the recordings are decoded.
      this.burst(g, t, 'lowpass', 750, 1, 0.45 * (0.6 + heavy * 0.5), 0.002, 0.07 + heavy * 0.04);
      this.tone(g, t, 'sine', 110, 55, 0.4 * (0.5 + heavy * 0.5), 0.002, 0.09);
      this.burst(g, t + 0.01, 'bandpass', 1200, 3, 0.1, 0.005, 0.08, 0.7);
      return;
    }
    const layer = (buf: AudioBuffer | null, gain: number, rate: number, at = t): void => this.take(buf, g, gain, rate, at);
    layer(impact, 0.65 + heavy * 0.3, hit.melee ? 0.85 : 1);
    // The wet slap of meat under every hit, thicker under heavy rounds.
    layer(this.recording('wet'), 0.26 + heavy * 0.24 + Math.min(0.25, power * 0.2), 1.05 - Math.min(0.15, power * 0.1), t + 0.012);
    if (hit.head) layer(this.recording('head'), 0.5 + Math.min(0.3, power * 0.25), 1.1 - Math.min(0.15, power * 0.1));
    if (hit.melee || heavy > 0.6) layer(this.recording('punch'), hit.melee ? 0.6 : 0.35 * heavy + Math.min(0.25, power * 0.15), 0.9 - Math.min(0.2, power * 0.12));
    // A big round thumps through the whole body.
    if (power >= 0.8) {
      this.tone(g, t, 'sine', 95, 38, 0.28 * Math.min(1.4, power), 0.002, 0.14);
      this.burst(g, t + 0.004, 'lowpass', 520, 0.8, 0.22 * Math.min(1.4, power), 0.002, 0.09);
    }
  }

  /** One recorded take into `dest` at `at`, a little detuned each time. */
  private take(buf: AudioBuffer | null, dest: AudioNode, gain: number, rate: number, at: number): void {
    if (!buf || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * 0.06);
    const lg = this.ctx.createGain();
    lg.gain.value = gain;
    src.connect(lg).connect(dest);
    this.free(src, lg);
    src.start(at);
  }

  /**
   * A head blown apart: the skull cracking open, a heavy wet burst, and the pieces pattering down
   * around it a moment later.
   */
  headPop(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + position.distanceTo(this.listenerPos) / SPEED_OF_SOUND;
    const d = this.bodyOut(position, 0.14, 4.5);
    // The skull: a sharp crack and splintering.
    this.burst(d, t, 'highpass', 2200, 0.8, 0.6, 0.001, 0.03);
    this.tone(d, t, 'square', 720, 170, 0.09, 0.001, 0.04);
    for (let i = 0; i < 3; i++) this.burst(d, t + 0.01 + Math.random() * 0.04, 'bandpass', 2800 + Math.random() * 2400, 2, 0.12, 0.001, 0.015);
    // The burst of it.
    this.take(this.recording('head'), d, 0.95, 0.88, t);
    this.take(this.recording('flesh'), d, 0.7, 0.8, t + 0.004);
    this.take(this.recording('wet'), d, 0.75, 0.78, t + 0.01);
    this.take(this.recording('wet'), d, 0.5, 1.18, t + 0.045);
    this.take(this.recording('punch'), d, 0.45, 0.7, t);
    this.tone(d, t, 'sine', 120, 42, 0.4, 0.002, 0.16);
    // Spatter: a run of short wet rips as it sprays out.
    for (let i = 0; i < 8; i++) this.burst(d, t + 0.02 + i * 0.02 + Math.random() * 0.012, 'bandpass', 650 + Math.random() * 1100, 3.5, 0.13 + Math.random() * 0.08, 0.002, 0.03, 0.7);
    // Pieces coming down around it.
    for (let i = 0; i < 7; i++) this.burst(d, t + 0.28 + Math.random() * 0.5, 'bandpass', 700 + Math.random() * 900, 3, 0.05 + Math.random() * 0.05, 0.003, 0.04, 0.7);
  }

  /** Output for a body's sounds at `position`, muffled through walls (looked for from `lift` m up). */
  private bodyOut(position: THREE.Vector3, reverb: number, ref: number, lift = 0): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const p = this.place(position, this.effects);
    p.refDistance = ref;
    this.muffled(g, this.muffle(lift ? { x: position.x, y: position.y + lift, z: position.z } : position)).connect(p);
    if (reverb > 0) {
      const r = ctx.createGain();
      r.gain.value = reverb;
      g.connect(r).connect(this.sends.effects);
    }
    return g;
  }

  /** When body falls may next play, and how many have this moment (a horde dropping isn't a drum roll). */
  private fallTokens = 6;
  private fallAt = 0;
  private chunkTokens = 10;
  private chunkAt = 0;

  /**
   * A body coming down hard on the ground (or a wall): a dull, heavy thud with a wet slap in it;
   * `strength` 0..1 is how hard it landed.
   */
  bodyFall(position: THREE.Vector3, strength: number): void {
    if (!this.ctx || strength < 0.05) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.fallTokens = Math.min(6, this.fallTokens + (now - this.fallAt) * 6);
    this.fallAt = now;
    if (this.fallTokens < 1 || position.distanceToSquared(this.listenerPos) > 50 * 50) return;
    this.fallTokens--;
    const t = now + position.distanceTo(this.listenerPos) / SPEED_OF_SOUND;
    const d = this.bodyOut(position, 0.08, 4, 0.4);
    const s = 0.45 + strength * 0.55;
    const floor = position.y < -0.5 ? 1.25 : position.y > 0.25 ? 0.8 : 1;
    this.tone(d, t, 'sine', 78 * floor, 32, 0.62 * s, 0.003, 0.24);
    this.burst(d, t, 'lowpass', 380 * floor, 0.8, 0.6 * s, 0.002, 0.15);
    this.take(this.recording('punch'), d, 0.5 * s, 0.6, t);
    this.take(this.recording('wet'), d, 0.18 * s, 0.85, t + 0.006);
    // Clothes and limbs slapping down a beat after the trunk.
    this.burst(d, t + 0.004, 'bandpass', 1100, 2, 0.14 * s, 0.002, 0.05);
    if (strength > 0.45) this.burst(d, t + 0.07 + Math.random() * 0.04, 'lowpass', 520, 0.8, 0.22 * s, 0.002, 0.08);
  }

  /** A piece of a body landing: a small wet slap (meat, brain) or a dry click (bone). */
  chunkLand(position: THREE.Vector3, strength: number, kind: string): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.chunkTokens = Math.min(10, this.chunkTokens + (now - this.chunkAt) * 14);
    this.chunkAt = now;
    if (this.chunkTokens < 1 || position.distanceToSquared(this.listenerPos) > 22 * 22) return;
    this.chunkTokens--;
    const t = now;
    const d = this.out(position, 0.03, 1.6);
    const s = 0.3 + strength * 0.7;
    if (kind === 'bone' || kind === 'skull') {
      this.burst(d, t, 'highpass', 2600, 0.8, 0.12 * s, 0.001, 0.012);
      this.tone(d, t, 'square', 1300 + Math.random() * 500, 700, 0.025 * s, 0.001, 0.02);
      if (kind === 'skull') this.burst(d, t + 0.003, 'bandpass', 900, 2.5, 0.08 * s, 0.002, 0.04, 0.7);
    } else {
      this.burst(d, t, 'bandpass', 700 + Math.random() * 600, 3, 0.16 * s, 0.002, 0.045, 0.7);
      this.tone(d, t, 'sine', 170 + Math.random() * 40, 80, 0.1 * s, 0.002, 0.06);
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
    this.free(src, f, g);
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

  /**
   * Output for a zombie's sounds: carries farther than the rest, muffled through walls. `lift`
   * raises the point walls are looked for from, so a foot on the ground isn't heard through it.
   */
  private zombieOut(position: THREE.Vector3, reverb: number, lift = 0): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const p = this.place(position, this.effects);
    p.refDistance = ZOMBIE_REF;
    p.rolloffFactor = ZOMBIE_ROLLOFF;
    const m = this.muffle(lift ? { x: position.x, y: position.y + lift, z: position.z } : position);
    this.muffled(g, m).connect(p);
    if (reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = reverb;
      g.connect(s).connect(this.sends.effects);
    }
    return g;
  }

  /**
   * A zombie's foot coming down: walkers plant a heel and drag the other foot, runners slap
   * the ground fast, brutes stomp. Floorboards sound hollow, a basement hard, outside dull.
   */
  zombieStep(position: THREE.Vector3, gait: 'walker' | 'runner' | 'brute', loudness: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.zombieOut(position, 0.12, 0.5);
    // The noise bed is mostly rumble: steep high-pass it, so the scuff and slap carry (on small
    // speakers too) and the thump comes from the tone alone.
    const d = ctx.createBiquadFilter();
    const d2 = ctx.createBiquadFilter();
    d.type = d2.type = 'highpass';
    d.frequency.value = d2.frequency.value = gait === 'brute' ? 160 : 260;
    d.connect(d2).connect(out);
    const floor = position.y < -0.5 ? 'concrete' : position.y > 0.25 ? 'wood' : 'ground';
    const tone = floor === 'wood' ? 0.7 : floor === 'concrete' ? 1.5 : 1;
    const l = STEP_LEVEL[gait] * (0.75 + 0.25 * Math.min(1, loudness * 2));
    const j = () => 0.9 + Math.random() * 0.2;
    if (gait === 'brute') {
      this.tone(out, t, 'sine', 72 * j(), 34, 0.5 * l, 0.004, 0.3);
      this.burst(d, t, 'lowpass', 900 * tone, 0.8, 0.9 * l, 0.003, 0.18);
      this.burst(d, t, 'bandpass', 380 * tone * j(), 1, 1 * l, 0.003, 0.14);
      this.burst(d, t + 0.004, 'bandpass', 1600 * tone, 0.9, 0.6 * l, 0.002, 0.07);
      if (floor === 'wood') this.burst(d, t + 0.03, 'bandpass', 260 * j(), 5, 0.3 * l, 0.02, 0.3, 0.6);
    } else if (gait === 'runner') {
      this.burst(d, t, 'bandpass', 1200 * tone * j(), 0.9, 2.4 * l, 0.002, 0.06);
      this.burst(d, t, 'highpass', 2500 * tone, 0.7, 0.4 * l, 0.001, 0.03);
      this.tone(out, t, 'sine', 120 * j(), 70, 0.18 * l, 0.002, 0.06);
    } else {
      this.burst(d, t, 'lowpass', 700 * tone, 0.8, 0.6 * l, 0.004, 0.08);
      this.burst(d, t + 0.002, 'bandpass', 1800 * tone * j(), 0.8, 0.25 * l, 0.002, 0.06);
      this.tone(out, t, 'sine', 90 * j(), 55, 0.15 * l, 0.004, 0.09);
      // The other foot dragged through after it.
      this.burst(d, t + 0.06 + Math.random() * 0.05, 'bandpass', 900 * tone * j(), 1.2, 0.35 * l, 0.07, 0.22, 0.8);
    }
  }

  /** Formant-filtered growl for the zombie voices. */
  private voice(position: THREE.Vector3, t: number, f0: number, f1: number, formant: number, dur: number, peak: number, wobble: number, rough = 0): void {
    const ctx = this.ctx!;
    const d = this.zombieOut(position, 0.25);
    peak *= ZOMBIE_LEVEL;
    rough *= ZOMBIE_LEVEL;
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
    this.free(o, bp, g);
    this.free(vib, vg);
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
    this.burst(this.zombieOut(position, 0.1), t + 0.5, 'lowpass', 300, 0.7, 0.35 * ZOMBIE_LEVEL, 0.01, 0.2);
  }

  /**
   * A screamer's call: a long, rising, tearing shriek in two voices, ragged with noise, then
   * a gasp. Carries far and rings off the houses.
   */
  zombieScream(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.6, 9);
    const shriek = (at: number, f0: number, f1: number, formant: number, dur: number, peak: number, wobble: number) => {
      const ctx = this.ctx!;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(f1, at + dur * 0.35);
      o.frequency.setTargetAtTime(f1 * 0.82, at + dur * 0.55, dur * 0.3);
      const vib = ctx.createOscillator();
      vib.frequency.value = wobble;
      const vg = ctx.createGain();
      vg.gain.value = f1 * 0.05;
      vib.connect(vg).connect(o.frequency);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = formant;
      bp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.12);
      g.gain.setTargetAtTime(0, at + dur * 0.8, dur * 0.12);
      o.connect(bp).connect(g).connect(d);
      this.free(o, bp, g);
      this.free(vib, vg);
      o.start(at);
      vib.start(at);
      o.stop(at + dur + 0.6);
      vib.stop(at + dur + 0.6);
    };
    shriek(t, 380, 1150, 1900, 1.25, 0.75, 9);
    shriek(t + 0.03, 560, 1650, 2700, 1.2, 0.4, 13);
    this.burst(d, t + 0.05, 'bandpass', 3000, 1.2, 0.3, 0.1, 1.1);
    this.burst(d, t + 0.1, 'highpass', 4500, 0.7, 0.12, 0.2, 0.9);
    this.voice(position, t + 1.2, 700, 300, 1300, 0.4, 0.3, 18, 0.25);
  }

  /** A bloater bursting: a deep wet boom, a gas rush, and meat raining down. */
  bloaterBurst(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.5, 7);
    this.tone(d, t, 'sine', 70, 28, 1.0, 0.003, 0.5);
    this.burst(d, t, 'lowpass', 520, 0.7, 1.0, 0.003, 0.4);
    this.burst(d, t, 'bandpass', 900, 1.5, 0.5, 0.002, 0.18, 0.6);
    // Gas tearing out.
    this.burst(d, t + 0.02, 'bandpass', 1600, 0.8, 0.35, 0.05, 0.7, 0.8);
    // Skin splitting and bone cracking.
    for (let i = 0; i < 6; i++) this.burst(d, t + Math.random() * 0.06, 'bandpass', 700 + Math.random() * 1200, 4, 0.25, 0.002, 0.04, 0.7);
    for (let i = 0; i < 3; i++) this.burst(d, t + 0.01 + Math.random() * 0.04, 'highpass', 2600 + Math.random() * 1500, 0.8, 0.25, 0.001, 0.02);
    // Pieces coming down all around.
    for (let i = 0; i < 18; i++) this.burst(d, t + 0.35 + Math.random() * 0.9, 'bandpass', 500 + Math.random() * 900, 3, 0.06 + Math.random() * 0.08, 0.003, 0.05, 0.7);
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

  /** A hammer blow on a nail while boarding up. */
  hammer(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.3, 3);
    const f = 1900 + Math.random() * 400;
    this.tone(d, t, 'square', f, f * 0.96, 0.06, 0.001, 0.05);
    this.tone(d, t, 'sine', 3100 + Math.random() * 300, 3000, 0.04, 0.001, 0.12);
    this.burst(d, t, 'bandpass', 600, 1.4, 0.35, 0.001, 0.06);
    this.tone(d, t, 'triangle', 180, 110, 0.18, 0.001, 0.07);
  }

  /** A board going up (`nailed`), pried off with a squeal of nails, or split off by a zombie. */
  board(position: THREE.Vector3, change: 'nailed' | 'pried' | 'broken'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, change === 'broken' ? 0.55 : 0.35, 4);
    if (change === 'pried') {
      this.tone(d, t, 'sawtooth', 900, 1400, 0.05, 0.02, 0.35);
      this.burst(d, t + 0.32, 'bandpass', 500, 1.2, 0.3, 0.002, 0.08);
      return;
    }
    if (change === 'nailed') {
      this.burst(d, t, 'bandpass', 420, 1.1, 0.3, 0.002, 0.1);
      this.tone(d, t, 'triangle', 160, 90, 0.2, 0.002, 0.1);
      return;
    }
    // Splintering wood and the board clattering down.
    for (let i = 0; i < 5; i++) {
      const at = t + i * 0.025 + Math.random() * 0.02;
      this.burst(d, at, 'bandpass', 900 + Math.random() * 1600, 1.5, 0.35, 0.001, 0.04);
    }
    this.tone(d, t, 'sine', 110, 50, 0.6, 0.002, 0.2);
    this.burst(d, t + 0.35, 'bandpass', 380, 1.4, 0.3, 0.002, 0.09);
    this.burst(d, t + 0.47, 'bandpass', 450, 1.4, 0.18, 0.002, 0.07);
  }

  /**
   * Someone (or a zombie, `heavy` for a brute) going over a window sill: hands slapping down on
   * the sill, clothes dragging across it, a knee knocking the frame, and the shoes scuffing off.
   */
  vault(position: THREE.Vector3, heavy = false): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.3, 4);
    const k = heavy ? 1.4 : 1;
    this.burst(d, t, 'bandpass', 260 + Math.random() * 60, 1.2, 0.5 * k, 0.002, 0.07);
    this.burst(d, t + 0.025, 'bandpass', 520, 1.6, 0.18 * k, 0.002, 0.05);
    this.burst(d, t + 0.06, 'bandpass', 1700 + Math.random() * 500, 0.7, 0.22, 0.05, 0.2);
    this.tone(d, t + 0.16, 'triangle', 150 * (heavy ? 0.7 : 1), 95, 0.25 * k, 0.002, 0.08);
    this.burst(d, t + 0.17, 'bandpass', 700, 1.4, 0.2 * k, 0.002, 0.05);
    this.burst(d, t + 0.3, 'bandpass', 2400, 0.9, 0.12, 0.01, 0.1);
  }

  /**
   * Getting down and up, and the dolphin dive (another survivor's when `position` is given):
   * `leap` is clothes and gear whipping through the air with a grunt of effort; `land` the body
   * slapping down on its front, the kit on it clattering, and the belly slide scraping along;
   * `down` the knees then the elbows going down; `up` a push up off the ground, clothes rustling.
   */
  stance(kind: 'leap' | 'land' | 'down' | 'up', position: THREE.Vector3 | null = null): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const d = this.out(position, kind === 'land' ? 0.25 : 0.1, kind === 'land' ? 5 : 3);
    if (kind === 'leap') {
      const src = this.noiseSource(false);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.4;
      f.frequency.setValueAtTime(320, t);
      f.frequency.exponentialRampToValueAtTime(1500, t + 0.16);
      f.frequency.exponentialRampToValueAtTime(420, t + 0.36);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.32, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
      src.connect(f).connect(g).connect(d);
      src.start(t, Math.random() * 2);
      src.stop(t + 0.42);
      this.free(src, f, g);
      // The push off, and a grunt with it.
      this.burst(d, t, 'bandpass', 520 + Math.random() * 80, 1.3, 0.22, 0.002, 0.06);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(175 + Math.random() * 25, t + 0.01);
      o.frequency.exponentialRampToValueAtTime(120, t + 0.22);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 680;
      bp.Q.value = 3;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, t + 0.01);
      og.gain.linearRampToValueAtTime(0.07, t + 0.04);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      o.connect(bp).connect(og).connect(d);
      o.start(t + 0.01);
      o.stop(t + 0.26);
      this.free(o, bp, og);
      for (let i = 0; i < 3; i++) this.tone(d, t + 0.03 + Math.random() * 0.15, 'triangle', 2400 + Math.random() * 1800, 2200, 0.025, 0.001, 0.05);
    } else if (kind === 'land') {
      // The body hits the ground front first: chest and thighs, then the arms and the gun.
      this.burst(d, t, 'lowpass', 340, 0.8, 0.75, 0.002, 0.13);
      this.tone(d, t, 'sine', 92, 42, 0.5, 0.002, 0.16);
      this.burst(d, t + 0.035, 'bandpass', 230, 1.2, 0.4, 0.002, 0.09);
      this.burst(d, t + 0.05, 'bandpass', 1900 + Math.random() * 600, 1.2, 0.2, 0.002, 0.07);
      this.burst(d, t + 0.09, 'bandpass', 2800, 1.6, 0.14, 0.002, 0.05);
      for (let i = 0; i < 4; i++) this.tone(d, t + 0.04 + Math.random() * 0.12, 'triangle', 1800 + Math.random() * 2400, 1600, 0.03, 0.001, 0.06);
      // Sliding on along the ground.
      const src = this.noiseSource(false);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 0.8;
      f.frequency.setValueAtTime(1300, t + 0.06);
      f.frequency.exponentialRampToValueAtTime(700, t + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + 0.06);
      g.gain.linearRampToValueAtTime(0.22, t + 0.1);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.52);
      src.connect(f).connect(g).connect(d);
      src.start(t + 0.06, Math.random() * 2);
      src.stop(t + 0.56);
      this.free(src, f, g);
    } else if (kind === 'down') {
      this.burst(d, t, 'bandpass', 240 + Math.random() * 40, 1.2, 0.32, 0.002, 0.07);
      this.burst(d, t + 0.05, 'bandpass', 1500, 0.8, 0.12, 0.03, 0.18);
      this.burst(d, t + 0.17, 'bandpass', 300, 1.2, 0.26, 0.002, 0.07);
      this.burst(d, t + 0.19, 'bandpass', 2300, 1.4, 0.08, 0.002, 0.05);
    } else {
      this.burst(d, t, 'bandpass', 1300, 0.8, 0.13, 0.04, 0.2);
      this.burst(d, t + 0.12, 'bandpass', 420, 1.2, 0.22, 0.002, 0.07);
      this.burst(d, t + 0.25, 'bandpass', 900 + Math.random() * 300, 1.0, 0.12, 0.002, 0.06);
    }
  }

  /** A window pane smashing in. */
  glassBreak(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.6, 5);
    this.burst(d, t, 'highpass', 1800, 0.7, 0.8, 0.001, 0.25);
    this.tone(d, t, 'sine', 140, 60, 0.3, 0.002, 0.1);
    // Shards tinkling down onto the sill and the floor.
    for (let i = 0; i < 16; i++) {
      const f = 2600 + Math.random() * 5500;
      this.tone(d, t + 0.05 + Math.random() * 0.7, 'sine', f, f * 0.99, 0.04, 0.001, 0.05 + Math.random() * 0.12);
    }
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
    this.free(o, bp, g);
    o.start(t + 0.02);
    o.stop(t + 0.3);
  }

  bandage(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(null);
    for (let i = 0; i < 4; i++) this.burst(d, t + i * 0.45, 'highpass', 1800 + Math.random() * 800, 0.8, 0.1, 0.04, 0.3, 1.2);
  }

  pickup(kind: 'ammo' | 'bandage' | 'weapon' | 'supply' | 'serum'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(null);
    if (kind === 'serum') {
      // Autoinjector: cap off, the spring-loaded click, the hiss of the dose, a breath of relief.
      this.burst(d, t, 'bandpass', 3200, 3, 0.18, 0.001, 0.03);
      this.burst(d, t + 0.18, 'bandpass', 2600, 4, 0.4, 0.001, 0.025);
      this.burst(d, t + 0.21, 'highpass', 5000, 0.7, 0.16, 0.01, 0.5);
      this.tone(d, t + 0.75, 'sine', 180, 120, 0.06, 0.05, 0.5);
      return;
    }
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

  /**
   * Boost syringes. `cap`: just taken, the cap pops off a moment later. `inject`: the needle goes
   * in, the plunger hisses home, and (for this survivor's own) the dose kicks in, each in its own
   * way: a heavy heartbeat (strength), a sharp breath and a racing pulse (stamina), a bright
   * metallic ring (rapid reload), a warm swell (regen), a high ring clearing to quiet (focus).
   * `end`: their own wore off. Others' are heard where they stand, without the rush.
   */
  syringe(stage: 'cap' | 'inject' | 'end', kind: BoostId, position: THREE.Vector3 | null): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const own = !position;
    const d = this.out(position, 0.05, 2);
    if (!own) d.gain.value = 0.7;
    if (stage === 'cap') {
      // Plastic: the cap's pull, its pop free, and a tick as it lands.
      this.burst(d, t + 0.2, 'bandpass', 3400, 3, 0.14, 0.001, 0.025);
      this.burst(d, t + 0.25, 'bandpass', 1900, 2.5, 0.12, 0.001, 0.035);
      this.burst(d, t + 0.62, 'bandpass', 4400, 4, 0.04, 0.001, 0.02);
      return;
    }
    if (stage === 'end') {
      if (!own) return;
      this.tone(d, t, 'sine', 640, 430, 0.045, 0.02, 0.45);
      this.tone(d, t + 0.18, 'sine', 430, 320, 0.035, 0.02, 0.5);
      return;
    }
    // The needle going in (a dull little thup), then the dose pushed home.
    this.burst(d, t, 'lowpass', 700, 0.8, 0.16, 0.002, 0.05);
    this.burst(d, t + 0.01, 'bandpass', 950, 4, 0.06, 0.002, 0.06);
    this.burst(d, t + 0.04, 'highpass', 4800, 0.7, own ? 0.06 : 0.04, 0.03, 0.28);
    this.tone(d, t + 0.05, 'triangle', 900, 720, 0.012, 0.02, 0.25);
    if (!own) return;
    const r = t + 0.3;
    if (kind === 'strength') {
      for (const k of [0, 0.42, 0.84]) {
        this.tone(d, r + k, 'sine', 64, 44, 0.3, 0.008, 0.16);
        this.tone(d, r + k + 0.13, 'sine', 58, 40, 0.18, 0.008, 0.14);
      }
      this.burst(d, r, 'lowpass', 180, 0.7, 0.08, 0.3, 0.9);
    } else if (kind === 'stamina') {
      this.burst(d, r - 0.05, 'bandpass', 1300, 1.4, 0.1, 0.22, 0.25);
      for (let i = 0; i < 6; i++) this.tone(d, r + 0.3 + i * 0.26, 'sine', 70, 48, 0.2 - i * 0.02, 0.006, 0.11);
    } else if (kind === 'reload') {
      this.tone(d, r, 'sine', 1760, 1740, 0.05, 0.003, 0.7);
      this.tone(d, r, 'sine', 2637, 2600, 0.03, 0.003, 0.5);
      this.burst(d, r, 'bandpass', 5200, 6, 0.06, 0.001, 0.04);
      this.burst(d, r + 0.09, 'bandpass', 3800, 6, 0.05, 0.001, 0.04);
    } else if (kind === 'regen') {
      for (const [f0, f1] of [[220, 330], [277, 415], [330, 494]]) this.tone(d, r, 'sine', f0, f1, 0.035, 0.35, 1.1, 0.6);
    } else {
      this.tone(d, r, 'sine', 2900, 2400, 0.03, 0.02, 1.3);
      this.burst(d, r, 'lowpass', 300, 0.7, 0.06, 0.4, 0.8);
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
      this.free(o);
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

  /** A horde is coming: the town siren winds up twice, far off. */
  hordeWarning(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = ctx.createOscillator();
    s.type = 'triangle';
    s.frequency.setValueAtTime(300, t);
    for (let i = 0; i < 2; i++) {
      s.frequency.linearRampToValueAtTime(760, t + 1.6 + i * 3.2);
      s.frequency.linearRampToValueAtTime(330, t + 3.2 + i * 3.2);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.06, t + 1);
    g.gain.setTargetAtTime(0, t + 6.2, 0.5);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 650;
    s.connect(bp).connect(g).connect(this.ambient);
    g.connect(this.sends.ambient);
    s.start(t);
    s.stop(t + 9);
  }

  /** The horde hits: a low swell under a rush of distant voices, heavier each wave. */
  hordeSurge(wave: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const level = Math.min(0.2, 0.11 + wave * 0.015);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(160, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + 1.2);
    lp.frequency.exponentialRampToValueAtTime(220, t + 4.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.001, t + 5);
    lp.connect(g);
    g.connect(this.music);
    g.connect(this.sends.music);
    for (const f of [41.2, 41.6, 61.7, 82.4]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      this.free(o);
      o.start(t);
      o.stop(t + 5.2);
    }
    // The crowd: band-limited noise that swells and moans.
    const n = this.noiseSource(true);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(280, t);
    bp.frequency.linearRampToValueAtTime(520, t + 1.5);
    bp.frequency.linearRampToValueAtTime(240, t + 4);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(level * 0.5, t + 1.2);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 4.8);
    n.connect(bp).connect(ng).connect(this.ambient);
    ng.connect(this.sends.ambient);
    n.start(t);
    n.stop(t + 5);
  }

  /** A wave outlasted: a short rising chord. */
  hordeOver(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.2);
    g.connect(this.music);
    g.connect(this.sends.music);
    for (const f of [220, 277.2, 329.6]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f * 0.94, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.5);
      o.connect(g);
      this.free(o);
      o.start(t);
      o.stop(t + 3.3);
    }
  }

  /**
   * Downtime begins: a low, open chord that swells slowly and settles, the night letting its
   * breath out. Straight after a wave it comes in under the wave's chord, a moment later.
   */
  lullStart(afterWave = false): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + (afterWave ? 0.9 : 0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.055, t + 1.4);
    g.gain.setTargetAtTime(0, t + 2.6, 1.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1400, t + 1.6);
    lp.frequency.linearRampToValueAtTime(600, t + 6);
    lp.connect(g);
    g.connect(this.music);
    g.connect(this.sends.music);
    // D, A, D, F#: open and major, a little detuned so it breathes.
    for (const [f, type] of [[146.8, 'sine'], [220.4, 'triangle'], [293.2, 'sine'], [370.4, 'sine']] as [number, OscillatorType][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.setValueAtTime(-6, t);
      o.detune.linearRampToValueAtTime(5, t + 7);
      o.connect(lp);
      this.free(o);
      o.start(t);
      o.stop(t + 8.5);
    }
  }

  /** Downtime is ending: three slow low thuds under a dark swell, a warning, not a siren. */
  lullEnding(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.value = 0.16;
    g.connect(this.music);
    g.connect(this.sends.music);
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.85;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(78, at);
      o.frequency.exponentialRampToValueAtTime(42, at + 0.35);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0, at);
      e.gain.linearRampToValueAtTime(1 - i * 0.12, at + 0.02);
      e.gain.exponentialRampToValueAtTime(0.001, at + 0.6);
      o.connect(e).connect(g);
      this.free(o, e);
      o.start(at);
      o.stop(at + 0.65);
    }
    // A minor second, low, rising out of the thuds.
    const s = ctx.createGain();
    s.gain.setValueAtTime(0, t);
    s.gain.linearRampToValueAtTime(0.045, t + 1.8);
    s.gain.setTargetAtTime(0, t + 2.8, 0.6);
    s.connect(this.music);
    s.connect(this.sends.music);
    for (const f of [98, 103.8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 380;
      o.connect(lp).connect(s);
      this.free(o, lp);
      o.start(t);
      o.stop(t + 5.5);
    }
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

  // ------------------------------------------------------------------ melee weapons (MeleeSynth)

  /** Plays a banked melee take, pitch nudged so repeats never sound identical. */
  private meleeBuffer(buffer: AudioBuffer, position: THREE.Vector3, level: number, reverb: number, ref: number, spread = 0.05): void {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * spread;
    const d = this.out(position, reverb, ref);
    d.gain.value = level;
    src.connect(d);
    src.start();
  }

  private meleeSwingBuffer(weapon: MeleeId, take: number): AudioBuffer {
    const k = `mswing:${weapon}:${take}`;
    return this.sample(k, () => [renderMeleeSwing(weapon, this.ctx!.sampleRate, seedOf(k))]);
  }

  /** A blow's take: 'light' (it lives), 'kill' (it drops) or 'head' (the skull gives way). */
  private meleeHitBuffer(weapon: MeleeId, blow: MeleeBlow, take: number): AudioBuffer {
    const k = `mhit:${weapon}:${blow}:${take}`;
    return this.sample(k, () => [renderMeleeHit(weapon, { kill: blow !== 'light', head: blow === 'head' }, this.ctx!.sampleRate, seedOf(k))]);
  }

  private meleePickupBuffer(weapon: MeleeId, take: number): AudioBuffer {
    const k = `mpick:${weapon}:${take}`;
    return this.sample(k, () => [renderMeleePickup(weapon, this.ctx!.sampleRate, seedOf(k))]);
  }

  /** A melee weapon swung through the air (whoosh voiced for the weapon). */
  meleeWhoosh(weapon: MeleeId, position: THREE.Vector3): void {
    if (!this.ctx) return;
    const heavy = weapon === 'bat' || weapon === 'hockey';
    this.meleeBuffer(this.meleeSwingBuffer(weapon, Math.floor(Math.random() * MELEE_TAKES.swing)), position, heavy ? 0.5 : 0.42, 0, 2);
  }

  /** A melee blow landing on a zombie: blades slice and bite, blunt weapons crack and crunch. */
  meleeHit(weapon: MeleeId, position: THREE.Vector3, hit: { kill: boolean; head: boolean; damage: number }): void {
    if (!this.ctx) return;
    const level = 0.62 + Math.min(0.3, hit.damage / 300);
    const blow: MeleeBlow = hit.head ? 'head' : hit.kill ? 'kill' : 'light';
    this.meleeBuffer(this.meleeHitBuffer(weapon, blow, Math.floor(Math.random() * MELEE_TAKES.hit)), position, level, 0.06, 3.2);
  }

  /** Picking a found melee weapon up. */
  meleePickup(weapon: MeleeId, position: THREE.Vector3): void {
    if (!this.ctx) return;
    this.meleeBuffer(this.meleePickupBuffer(weapon, Math.floor(Math.random() * MELEE_TAKES.pickup)), position, 0.45, 0.04, 2);
  }

  // ------------------------------------------------------------------ explosives

  /** Pulling a frag's pin and letting the spoon fly, or flicking a lighter to a Molotov's rag. */
  throwReady(kind: 'frag' | 'molotov', position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.04, 1.5);
    if (kind === 'frag') {
      // Pin out: a scrape and a ring; the spoon: a spring ping.
      this.burst(d, t, 'bandpass', 3800, 3, 0.12, 0.002, 0.06);
      this.tone(d, t + 0.02, 'sine', 5200, 5100, 0.035, 0.001, 0.12);
      this.tone(d, t + 0.26, 'triangle', 2400, 1700, 0.06, 0.001, 0.09);
      this.burst(d, t + 0.26, 'highpass', 4000, 1, 0.08, 0.001, 0.03);
    } else {
      // Flint wheel, then the rag catching.
      for (let i = 0; i < 3; i++) this.burst(d, t + i * 0.012, 'highpass', 5000, 1, 0.07, 0.001, 0.015);
      this.burst(d, t + 0.06, 'bandpass', 900, 0.7, 0.2, 0.05, 0.5, 0.6);
      this.burst(d, t + 0.06, 'lowpass', 320, 0.7, 0.18, 0.08, 0.6, 0.5);
    }
  }

  /** The arm whipping through the throw. */
  throwWhoosh(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const d = this.out(position, 0.03, 1.5);
    const src = this.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(1800, t + 0.12);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(f).connect(g).connect(d);
    src.start(t, Math.random() * 2);
    src.stop(t + 0.35);
  }

  /** A frag or bottle landing and bouncing. */
  thrownBounce(kind: 'frag' | 'molotov', surface: string, position: THREE.Vector3, speed: number): void {
    if (!this.ctx || speed < 0.4) return;
    const t = this.ctx.currentTime;
    const k = Math.min(1, speed / 9);
    const d = this.out(position, 0.06, 2);
    const soft = surface === 'grass' || surface === 'dirt' || surface === 'fabric';
    if (soft) {
      this.burst(d, t, 'lowpass', 420, 0.7, 0.35 * k, 0.002, 0.07);
      return;
    }
    if (kind === 'frag') {
      // Cast iron on hard ground: a dull clank with a short ring.
      this.tone(d, t, 'triangle', 980, 880, 0.16 * k, 0.001, 0.09);
      this.tone(d, t, 'sine', 2350, 2300, 0.06 * k, 0.001, 0.14);
      this.burst(d, t, 'bandpass', 1800, 1.5, 0.22 * k, 0.001, 0.035);
    } else {
      this.tone(d, t, 'sine', 1500, 1450, 0.08 * k, 0.001, 0.1);
      this.burst(d, t, 'bandpass', 2600, 2, 0.12 * k, 0.001, 0.03);
    }
  }

  /**
   * A frag going off, built the way the gunshot is: late by the speed of sound, dulled by air
   * and walls, the space it is in answering. A whip-crack of the blast front, the body of the
   * explosion, a sub-bass punch felt more than heard, a long rumble rolling off the houses, and
   * dirt and fragments pattering down. Close by it leaves the ears ringing.
   */
  explosion(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const L = this.listenerPos;
    const here = this.here;
    const there = this.spaceOf(position);
    const dist = position.distanceTo(L);
    const t = ctx.currentTime + dist / SPEED_OF_SOUND;
    const near = THREE.MathUtils.clamp(1 - dist / 30, 0, 1);
    const level = ctx.createGain();
    level.gain.value = 1;
    const wall = this.acoustics ? this.acoustics.occlusion(position.x, position.y, position.z, L.x, L.y, L.z) : CLEAR;
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = Math.max(700, 18000 / (1 + dist / 25));
    const p = this.makePanner(position);
    p.refDistance = 14;
    p.rolloffFactor = 0.9;
    level.connect(air);
    this.muffled(air, wall).connect(p).connect(this.effects);
    // Blast front.
    this.burst(level, t, 'highpass', 1200, 0.6, 1.1, 0.0008, 0.07);
    this.burst(level, t, 'bandpass', 2600, 0.8, 0.7, 0.0008, 0.12);
    // Body.
    this.burst(level, t, 'lowpass', 1400, 0.6, 1.3, 0.003, 0.5, 0.55);
    this.burst(level, t + 0.02, 'lowpass', 520, 0.7, 1.2, 0.01, 1.1, 0.4);
    // Punch: a sine sweep below 80 Hz (and a second, non-spatial one up close: felt in the chest).
    this.tone(level, t, 'sine', 90, 30, 1.2, 0.004, 0.9, 0.5);
    if (near > 0) {
      const chest = ctx.createGain();
      chest.gain.value = near * near;
      chest.connect(this.effects);
      this.tone(chest, t, 'sine', 70, 26, 0.9, 0.006, 1.0, 0.6);
    }
    // Rumble rolling away.
    this.burst(level, t + 0.08, 'lowpass', 220, 0.7, 0.55, 0.15, 2.6, 0.3);
    // Fragments and dirt coming down.
    for (let i = 0; i < 14; i++) {
      const dt = 0.25 + Math.random() * 1.6;
      this.burst(level, t + dt, 'bandpass', 1800 + Math.random() * 3500, 3, (0.05 + Math.random() * 0.08) * (1 - dt / 2.2), 0.001, 0.025 + Math.random() * 0.03);
    }
    // The space answers (the street echoes off every house front).
    const apart = there !== here || wall.walls > 0;
    const leak: Muffle = !apart ? CLEAR : wall.walls ? { gain: Math.max(wall.gain, 0.25), cutoff: Math.max(wall.cutoff, 900), walls: wall.walls } : LEAK_IN;
    this.sendTo(level, there, 1.1 * SEND[there], leak);
    if (there !== 'street') this.sendTo(level, 'street', 0.8 * SEND.street, here === 'street' ? LEAK_OUT : leak);
    else if (here !== 'street') this.sendTo(level, here, 0.35 * SEND[here], LEAK_IN);
    // Ringing ears.
    if (dist < 9) {
      const k = 1 - dist / 9;
      const ring = ctx.createGain();
      ring.connect(this.effects);
      ring.gain.setValueAtTime(0, t);
      ring.gain.linearRampToValueAtTime(0.035 * k, t + 0.15);
      ring.gain.setTargetAtTime(0, t + 0.6, 1.2 + k * 1.5);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 4600 + Math.random() * 1600;
      o.connect(ring);
      o.start(t);
      o.stop(t + 6);
    }
  }

  /** A Molotov breaking: glass bursting and the fuel going up with a whoomp. */
  molotov(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + position.distanceTo(this.listenerPos) / SPEED_OF_SOUND;
    const d = this.out(position, 0.25, 4);
    this.impact('glass', position);
    this.burst(d, t, 'highpass', 3200, 0.7, 0.4, 0.001, 0.18);
    for (let i = 0; i < 9; i++) {
      const f = 3500 + Math.random() * 5000;
      this.tone(d, t + 0.02 + Math.random() * 0.4, 'sine', f, f * 0.99, 0.025, 0.001, 0.06 + Math.random() * 0.1);
    }
    // Whoomp.
    this.burst(d, t + 0.03, 'lowpass', 380, 0.8, 1.1, 0.06, 0.8, 0.5);
    this.burst(d, t + 0.05, 'bandpass', 900, 0.6, 0.45, 0.08, 0.9, 0.6);
    this.tone(d, t + 0.03, 'sine', 75, 45, 0.5, 0.05, 0.5);
  }

  /** A zombie catching fire. */
  ignite(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.1, 2.5);
    this.burst(d, t, 'lowpass', 600, 0.7, 0.45, 0.04, 0.5, 0.6);
    this.burst(d, t, 'bandpass', 1500, 0.8, 0.15, 0.05, 0.4);
  }

  private readonly fireLoops = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; panner: PannerNode; pop: number; pos: THREE.Vector3 }>();

  /**
   * Fires burning this frame (id, where, 0..1 strength): each a looping roar with crackle
   * and pops. Loops start and stop as fires come and go.
   */
  fires(list: { id: number; pos: THREE.Vector3; strength: number }[], dt: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const seen = new Set<number>();
    for (const f of list) {
      seen.add(f.id);
      let l = this.fireLoops.get(f.id);
      if (!l) {
        const src = this.noiseSource(true);
        src.playbackRate.value = 0.7 + Math.random() * 0.2;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 700;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2400;
        bp.Q.value = 0.8;
        const bpg = ctx.createGain();
        bpg.gain.value = 0.18;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const panner = this.makePanner(f.pos);
        panner.refDistance = 2.5;
        src.connect(lp).connect(gain);
        src.connect(bp).connect(bpg).connect(gain);
        gain.connect(panner).connect(this.effects);
        src.start(now, Math.random() * 2);
        l = { src, gain, panner, pop: 0, pos: f.pos.clone() };
        this.fireLoops.set(f.id, l);
      }
      l.pos.copy(f.pos);
      l.panner.positionX.setTargetAtTime(f.pos.x, now, 0.05);
      l.panner.positionY.setTargetAtTime(f.pos.y, now, 0.05);
      l.panner.positionZ.setTargetAtTime(f.pos.z, now, 0.05);
      l.gain.gain.setTargetAtTime(0.32 * f.strength, now, 0.15);
      // Crackle and pops.
      l.pop -= dt;
      if (l.pop <= 0 && f.strength > 0.1) {
        l.pop = 0.04 + Math.random() * 0.22 / f.strength;
        if (f.pos.distanceTo(this.listenerPos) < 30) {
          const d = this.out(f.pos, 0.02, 2);
          const big = Math.random() < 0.12;
          this.burst(d, now + Math.random() * 0.03, big ? 'bandpass' : 'highpass', big ? 900 : 2500 + Math.random() * 3000, big ? 1.5 : 1, (big ? 0.12 : 0.05) * f.strength, 0.0008, big ? 0.05 : 0.012);
        }
      }
    }
    for (const [id, l] of this.fireLoops) {
      if (seen.has(id)) continue;
      l.gain.gain.setTargetAtTime(0, now, 0.4);
      l.src.stop(now + 2);
      this.fireLoops.delete(id);
    }
  }

  dispose(): void {
    this.wheels.dispose();
    for (const r of this.rotors.values()) r.src.stop();
    this.rotors.clear();
    for (const l of this.fireLoops.values()) l.src.stop();
    this.fireLoops.clear();
    this.unsub?.();
    window.clearTimeout(this.bankTimer);
    this.bank.clear();
    this.recorded.clear();
    if (this.ctx instanceof AudioContext) void this.ctx.close();
    this.ctx = null;
  }
}

/** A vehicle the engine sounds follow (see WheelSounds.engines). */
export interface EngineSound {
  id: number;
  pos: THREE.Vector3;
  kind: 'car' | 'police' | 'wreck' | 'truck';
  /** The engine runs (the horn sounds without it). */
  running: boolean;
  /** Speed (m/s) and the vehicle's top speed (the gears are spread over it). */
  speed: number;
  top: number;
  throttle: boolean;
  horn: boolean;
}

export const audio = new AudioEngine();
