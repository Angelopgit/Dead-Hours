import * as THREE from 'three';
import { settings } from '../core/Settings';

/**
 * Procedural Web Audio engine. Every sound is synthesized at runtime (no external assets),
 * routed through master → {music, effects, ambient} buses with a spatial listener.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
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
  private nextNote = 0;
  private nextAmbientEvent = 0;
  private nextPulse = 0;
  private time = 0;
  private readonly spatial: { panner: PannerNode; gain: GainNode; level: () => number }[] = [];
  private unsub: (() => void) | null = null;
  /** 0..1 musical tension, driven by the survival director from Phase 5. */
  tension = 0;

  /** Must be called from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
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
    this.reverb.connect(comp);

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
    this.droneGain.connect(this.reverbSend);
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
    lp.connect(this.reverbSend);
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
    g.connect(this.reverbSend);
    src.start(t);
    src.stop(t + 6.5);
  }

  /** Short filtered noise burst for a foot plant. */
  footstep(loudness: number, indoor: boolean): void {
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
    src.connect(bp).connect(g).connect(this.effects);
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

  /** Zombie groan: formant-filtered buzzy voice with pitch wobble, spatialized. */
  groan(position: THREE.Vector3, volume = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 1.2 + Math.random() * 1.3;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const base = 70 + Math.random() * 40;
    o.frequency.setValueAtTime(base, t);
    o.frequency.linearRampToValueAtTime(base * 0.75, t + dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5 + Math.random() * 4;
    const vg = ctx.createGain();
    vg.gain.value = 6;
    vib.connect(vg).connect(o.frequency);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.setValueAtTime(500, t);
    f1.frequency.linearRampToValueAtTime(320, t + dur);
    f1.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5 * volume, t + 0.25);
    g.gain.setTargetAtTime(0, t + dur * 0.7, 0.2);
    const panner = this.makePanner(position);
    o.connect(f1).connect(g).connect(panner).connect(this.effects);
    g.connect(this.reverbSend);
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
      panner.connect(this.reverbSend);
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

  dispose(): void {
    this.unsub?.();
    void this.ctx?.close();
    this.ctx = null;
  }
}

export const audio = new AudioEngine();
