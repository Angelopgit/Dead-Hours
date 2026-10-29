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

  // ------------------------------------------------------------------ combat

  /** Output chain for a one-shot: spatial when a position is given, with a reverb send. */
  private out(position: THREE.Vector3 | null, reverb = 0, ref = 3): AudioNode {
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
      g.connect(s).connect(this.reverbSend);
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

  private static readonly GUNS: Record<string, { crack: number; hp: number; body: number; boom: number; tail: number; gain: number }> = {
    ar: { crack: 0.9, hp: 1500, body: 150, boom: 0.5, tail: 1.3, gain: 1 },
    smg: { crack: 0.7, hp: 2400, body: 190, boom: 0.35, tail: 0.9, gain: 0.8 },
    shotgun: { crack: 0.75, hp: 900, body: 105, boom: 1, tail: 1.9, gain: 1.2 },
    marksman: { crack: 1.1, hp: 1300, body: 130, boom: 0.7, tail: 2.1, gain: 1.25 },
    pistol: { crack: 0.85, hp: 2600, body: 210, boom: 0.3, tail: 0.9, gain: 0.85 },
  };

  /** Gunshot: crack, body punch, boom and an outdoor echo tail (rooms ring instead). */
  gunshot(weapon: string, position: THREE.Vector3, indoor: boolean, local: boolean): void {
    if (!this.ctx) return;
    const w = AudioEngine.GUNS[weapon] ?? AudioEngine.GUNS.ar;
    const t = this.ctx.currentTime;
    const dest = this.out(position, indoor ? 0.9 : 0.35, local ? 6 : 10);
    const v = w.gain * (local ? 0.55 : 0.7);
    this.burst(dest, t, 'highpass', w.hp * (0.9 + Math.random() * 0.2), 0.7, 0.9 * w.crack * v, 0.001, 0.07);
    this.burst(dest, t, 'bandpass', 700, 0.8, 0.7 * v, 0.002, 0.16 + w.boom * 0.12);
    this.tone(dest, t, 'triangle', w.body * 1.6, w.body * 0.35, 0.9 * v, 0.002, 0.16 + w.boom * 0.1);
    if (w.boom > 0.6) this.tone(dest, t, 'sine', 70, 32, 0.7 * v * w.boom, 0.004, 0.35);
    // Echo off the houses / room ring.
    const tail = indoor ? w.tail * 0.45 : w.tail;
    this.burst(dest, t + (indoor ? 0.012 : 0.07), 'lowpass', indoor ? 1400 : 700, 0.5, (indoor ? 0.3 : 0.22) * v, 0.03, tail, 0.6);
    // Mechanism.
    if (local) this.burst(dest, t + 0.03, 'bandpass', 3200, 3, 0.06, 0.001, 0.03);
  }

  dryFire(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(position);
    this.burst(dest, t, 'bandpass', 2800, 4, 0.25, 0.001, 0.025);
    this.tone(dest, t, 'square', 1900, 1500, 0.04, 0.001, 0.02);
  }

  /** Reload and handling foley. */
  foley(kind: 'magOut' | 'magIn' | 'bolt' | 'pump' | 'slide' | 'shellIn' | 'holster' | 'draw' | 'shellGrab', position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(position, 0.05, 2);
    switch (kind) {
      case 'magOut':
        this.burst(d, t, 'bandpass', 1800, 2, 0.22, 0.002, 0.05);
        this.burst(d, t + 0.06, 'bandpass', 900, 1.5, 0.18, 0.005, 0.12);
        break;
      case 'magIn':
        this.burst(d, t, 'bandpass', 1300, 2, 0.18, 0.003, 0.05);
        this.burst(d, t + 0.07, 'bandpass', 2400, 3, 0.4, 0.001, 0.04);
        this.tone(d, t + 0.07, 'triangle', 420, 260, 0.12, 0.001, 0.05);
        break;
      case 'bolt':
        this.burst(d, t, 'bandpass', 2600, 3, 0.35, 0.001, 0.035);
        this.burst(d, t + 0.09, 'bandpass', 3400, 3, 0.45, 0.001, 0.04);
        this.tone(d, t + 0.09, 'square', 900, 600, 0.05, 0.001, 0.03);
        break;
      case 'pump':
        this.burst(d, t, 'bandpass', 1100, 2, 0.4, 0.002, 0.06);
        this.tone(d, t, 'triangle', 260, 180, 0.15, 0.001, 0.06);
        this.burst(d, t + 0.15, 'bandpass', 1500, 2, 0.45, 0.002, 0.06);
        this.tone(d, t + 0.15, 'triangle', 320, 200, 0.18, 0.001, 0.06);
        break;
      case 'slide':
        this.burst(d, t, 'bandpass', 2200, 2.5, 0.3, 0.002, 0.05);
        this.burst(d, t + 0.07, 'bandpass', 3000, 3, 0.35, 0.001, 0.04);
        break;
      case 'shellIn':
        this.burst(d, t, 'bandpass', 1600, 2.5, 0.25, 0.002, 0.04);
        this.tone(d, t + 0.02, 'triangle', 700, 500, 0.08, 0.001, 0.04);
        break;
      case 'shellGrab':
        this.burst(d, t, 'bandpass', 2400, 1.5, 0.06, 0.01, 0.06);
        break;
      case 'holster':
      case 'draw':
        this.burst(d, t, 'lowpass', 900, 0.7, 0.12, 0.03, 0.14, 1.4);
        this.burst(d, t + 0.1, 'bandpass', 2000, 2, 0.08, 0.002, 0.04);
        break;
    }
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

  zombieAlert(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.voice(position, t, 180 + Math.random() * 60, 320, 900, 0.45, 0.55, 7, 0.12);
    this.voice(position, t + 0.4, 300, 140, 700, 0.7, 0.45, 5, 0.08);
  }

  zombieAttack(position: THREE.Vector3): void {
    if (!this.ctx) return;
    this.voice(position, this.ctx.currentTime, 150, 95, 650, 0.38, 0.5, 28, 0.15);
  }

  zombieHurt(position: THREE.Vector3): void {
    if (!this.ctx) return;
    this.voice(position, this.ctx.currentTime, 130 + Math.random() * 30, 100, 560, 0.18, 0.35, 12);
  }

  zombieDeath(position: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.voice(position, t, 110, 48, 420, 0.9, 0.42, 9, 0.12);
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

  pickup(kind: 'ammo' | 'bandage' | 'weapon'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const d = this.out(null);
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
    g.connect(this.reverbSend);
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
    sg.connect(this.reverbSend);
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
    this.unsub?.();
    void this.ctx?.close();
    this.ctx = null;
  }
}

export const audio = new AudioEngine();
