import * as THREE from 'three';
import type { AudioEngine, EngineSound } from './AudioEngine';

/**
 * The sounds of things on wheels: skateboards (rolling, pops, landings), cars and the armored truck
 * (engines, starters, horns, doors, crashes) and bicycles (tyres, the freewheel, the bell). Split
 * out of AudioEngine, whose buses and helpers it plays through.
 */
export class WheelSounds {
  constructor(private readonly e: AudioEngine) {}

  // ------------------------------------------------------------------ skateboards

  private readonly skateLoops = new Map<number, {
    src: AudioBufferSourceNode; gain: GainNode; body: BiquadFilterNode; bodyG: GainNode; grit: GainNode; low: GainNode; panner: PannerNode;
  }>();
  /** Built on first use: wheels-on-asphalt texture (looped) and plain white noise for the deck's cracks. */
  private skateBufs: { roll: AudioBuffer; white: AudioBuffer } | null = null;

  skateBuffers(): { roll: AudioBuffer; white: AudioBuffer } {
    if (this.skateBufs) return this.skateBufs;
    const ctx = this.e.ctx!;
    const sr = ctx.sampleRate;
    // Urethane on asphalt: a hiss full of grit (little stones and cracks popping under the wheels),
    // nothing below ~120 Hz. The ends are crossfaded so the loop has no seam of its own.
    const n = Math.round(sr * 1.7), fade = Math.round(sr * 0.08);
    const raw = new Float32Array(n + fade);
    let hp = 0, prev = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      hp = 0.984 * (hp + w - prev);
      prev = w;
      raw[i] = hp * 0.45;
    }
    for (let i = 0; i < raw.length;) {
      i += 1 + Math.round((-Math.log(1 - Math.random()) * sr) / 900);
      const a = Math.pow(Math.random(), 2.4) * 1.1;
      const len = Math.round(sr * (0.0003 + Math.random() * 0.0011));
      for (let k = 0; k < len && i + k < raw.length; k++) raw[i + k] += a * (Math.random() * 2 - 1) * Math.exp((-3 * k) / len);
    }
    const roll = ctx.createBuffer(1, n, sr);
    const d = roll.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = i < fade ? raw[i] * (i / fade) + raw[n + i] * (1 - i / fade) : raw[i];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[i] * d[i];
    const norm = 0.3 / Math.sqrt(sum / n);
    for (let i = 0; i < n; i++) d[i] *= norm;
    const white = ctx.createBuffer(1, sr, sr);
    const wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    this.skateBufs = { roll, white };
    return this.skateBufs;
  }

  /** A sharp, bright hit: white noise through a filter with a fast envelope (wood and wheels on the street). */
  private crack(dest: AudioNode, t: number, type: BiquadFilterType, freq: number, q: number, peak: number, decay: number, attack = 0.0006): void {
    const ctx = this.e.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.skateBuffers().white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + attack + decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.8);
    src.stop(t + attack + decay + 0.05);
    this.e.free(src, f, g);
  }

  /**
   * Wheels rolling: one loop per moving board. The grit runs faster and brighter and louder with
   * speed; asphalt is coarse and loud, smooth concrete and floors hiss, grass and dirt only thud.
   * Boards left out fade away.
   */
  skateRoll(list: { id: number; pos: THREE.Vector3; speed: number; rough: number }[]): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const seen = new Set<number>();
    for (const b of list) {
      seen.add(b.id);
      let l = this.skateLoops.get(b.id);
      if (!l) {
        const src = ctx.createBufferSource();
        src.buffer = this.skateBuffers().roll;
        src.loop = true;
        const body = ctx.createBiquadFilter();
        body.type = 'bandpass';
        body.Q.value = 0.55;
        body.frequency.value = 900;
        const bodyG = ctx.createGain();
        const hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = 2600;
        const grit = ctx.createGain();
        const lpf = ctx.createBiquadFilter();
        lpf.type = 'lowpass';
        lpf.frequency.value = 320;
        const low = ctx.createGain();
        for (const g of [bodyG, grit, low]) g.gain.value = 0;
        const tame = ctx.createBiquadFilter();
        tame.type = 'lowpass';
        tame.frequency.value = 5200;
        tame.Q.value = 0.5;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const panner = this.e.makePanner(b.pos);
        panner.refDistance = 3;
        panner.rolloffFactor = 0.9;
        src.connect(body).connect(bodyG).connect(gain);
        src.connect(hpf).connect(grit).connect(gain);
        src.connect(lpf).connect(low).connect(gain);
        gain.connect(tame).connect(panner).connect(this.e.effects);
        src.start(now, Math.random() * 1.5);
        l = { src, gain, body, bodyG, grit, low, panner };
        this.skateLoops.set(b.id, l);
      }
      const v = b.speed;
      const soft = b.rough > 1.2;
      const k = Math.min(1.25, v / 8);
      l.panner.positionX.setTargetAtTime(b.pos.x, now, 0.03);
      l.panner.positionY.setTargetAtTime(b.pos.y + 0.05, now, 0.03);
      l.panner.positionZ.setTargetAtTime(b.pos.z, now, 0.03);
      l.src.playbackRate.setTargetAtTime(0.62 + 0.42 * Math.min(1.3, v / 8), now, 0.08);
      l.body.frequency.setTargetAtTime(soft ? 260 : 380 + v * 95, now, 0.08);
      l.bodyG.gain.setTargetAtTime(soft ? 0.5 : 0.75 + 0.3 * Math.min(1, b.rough), now, 0.08);
      l.grit.gain.setTargetAtTime(soft ? 0.04 : 0.32 * Math.min(1, b.rough) + 0.06, now, 0.08);
      l.low.gain.setTargetAtTime(soft ? 1.2 : 0.7, now, 0.08);
      l.gain.gain.setTargetAtTime(1.3 * Math.pow(k, 0.75) * (soft ? 0.55 : 1), now, 0.06);
    }
    for (const [id, l] of this.skateLoops) {
      if (seen.has(id)) continue;
      l.gain.gain.setTargetAtTime(0, now, 0.05);
      l.src.stop(now + 0.6);
      this.skateLoops.delete(id);
    }
  }

  /** A sidewalk seam under the wheels: the front truck then the back one clacking over it. */
  skateSeam(position: THREE.Vector3, strength: number): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.12, 3);
    const gap = 0.36 / Math.max(1.5, strength * 8);
    const s = 0.45 + 0.55 * strength;
    for (const [at, k] of [[t, 1], [t + gap, 0.8]] as const) {
      this.crack(d, at, 'bandpass', 1500 + Math.random() * 300, 1.3, 1.6 * s * k, 0.03);
      this.e.tone(d, at, 'sine', 170, 95, 0.32 * s * k, 0.001, 0.05);
    }
  }

  /** An ollie: the tail cracked down on the street. */
  skatePop(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.3, 3);
    this.crack(d, t, 'bandpass', 1350, 1.4, 3, 0.05);
    this.crack(d, t, 'highpass', 3800, 0.7, 0.8, 0.018);
    this.e.tone(d, t, 'triangle', 340, 170, 0.22, 0.001, 0.07);
    this.e.tone(d, t, 'sine', 115, 60, 0.25, 0.002, 0.1);
  }

  /** Four wheels and a deck coming back down (`strength` 0..1 by how long it was in the air). */
  skateLand(position: THREE.Vector3, strength: number): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.35, 3);
    const k = 0.5 + 0.5 * strength;
    this.crack(d, t, 'bandpass', 950, 1.0, 2.8 * k, 0.08);
    this.crack(d, t + 0.012, 'bandpass', 1700, 1.4, 1.8 * k, 0.05);
    this.e.tone(d, t, 'sine', 95, 45, 0.4 * k, 0.002, 0.16);
    // The trucks rattling as it settles.
    for (let i = 1; i <= 3; i++) this.crack(d, t + 0.03 + i * 0.025 + Math.random() * 0.01, 'bandpass', 2400 + Math.random() * 900, 2, 0.9 * k / i, 0.012);
  }

  /** The back foot pushing along: a shoe sole scuffing the street. */
  skateKick(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.05, 2.5);
    this.crack(d, t, 'bandpass', 1900 + Math.random() * 500, 0.7, 0.45, 0.16, 0.035);
    this.crack(d, t, 'bandpass', 520, 0.9, 0.5, 0.05, 0.004);
  }

  /**
   * A flip trick's flick: the shoe dragging up the grip tape and off the edge of the nose (`flip`),
   * or the back foot scooping the tail round (a shove-it), then the board whirring as it turns.
   */
  skateFlick(position: THREE.Vector3, flip: boolean): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.15, 3);
    this.crack(d, t, 'bandpass', flip ? 3300 : 2400, 0.8, 1.1, 0.07, 0.022);
    this.crack(d, t + 0.035, 'highpass', 5200, 0.7, 0.5, 0.03, 0.008);
    if (flip) this.crack(d, t + 0.055, 'bandpass', 1900, 2.2, 0.8, 0.018);
    else this.crack(d, t + 0.02, 'bandpass', 1300, 0.9, 0.7, 0.06, 0.015);
    // The deck cutting the air, a soft pulse each half turn.
    for (let i = 0; i < 3; i++) this.crack(d, t + 0.08 + i * 0.09, 'bandpass', 650 + i * 120, 1.1, 0.32 - i * 0.07, 0.045, 0.03);
  }

  /** Both feet coming down onto the grip to catch a flipped board in the air. */
  skateCatch(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.2, 3);
    this.crack(d, t, 'bandpass', 760, 1.1, 0.9, 0.035);
    this.e.tone(d, t, 'sine', 150, 95, 0.18, 0.002, 0.05);
    this.crack(d, t + 0.028, 'bandpass', 980, 1.2, 0.6, 0.03);
  }

  /** Board slapped down and stepped onto. */
  skateMount(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.25, 3);
    this.crack(d, t, 'bandpass', 900, 1.1, 2.6, 0.06);
    this.e.tone(d, t, 'sine', 150, 85, 0.45, 0.002, 0.1);
    this.crack(d, t + 0.13, 'bandpass', 650, 0.9, 1.8, 0.06);
    this.e.tone(d, t + 0.13, 'sine', 115, 70, 0.35, 0.002, 0.08);
  }

  /** Stepping off: the board's tail tapping down. */
  skateOff(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.2, 3);
    this.crack(d, t, 'bandpass', 1150, 1.3, 2.2, 0.045);
    this.e.tone(d, t, 'sine', 165, 95, 0.32, 0.002, 0.07);
  }

  /** Thrown off: the board clattering away end over end. */
  skateBail(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.45, 4);
    for (let i = 0; i < 6; i++) {
      const at = t + 0.02 + i * 0.1 + Math.random() * 0.06;
      const k = 1 - i * 0.14;
      this.crack(d, at, 'bandpass', 700 + Math.random() * 1400, 1.2, 3 * k, 0.06);
      this.e.tone(d, at, 'sine', 130 + Math.random() * 50, 70, 0.4 * k, 0.002, 0.08);
    }
    // Wheels skidding sideways on the asphalt.
    this.crack(d, t, 'bandpass', 2200, 0.6, 1.2, 0.35, 0.02);
  }

  // ------------------------------------------------------------------ vehicles

  private readonly engineLoops = new Map<number, {
    kind: EngineSound['kind'];
    oscs: OscillatorNode[];
    rumble: AudioBufferSourceNode;
    rumbleG: GainNode;
    gain: GainNode;
    lp: BiquadFilterNode;
    panner: PannerNode;
    horn: OscillatorNode[];
    hornGain: GainNode;
    lfo: OscillatorNode | null;
    rev: number;
  }>();

  /**
   * Running engines and sounding horns of the vehicles nearest the listener (the session sends the
   * nearest few). An engine is a buzz pitched at its firing rate: up through the gears as it
   * gathers speed (dropping at each change), brighter and louder on the throttle; the armored
   * truck's diesel growls lower and rougher, a wreck's misfires. Horns: a car's two-tone blare,
   * the cruiser's wailing siren, the truck's air horn. Whatever leaves the list fades away.
   */
  engines(list: readonly EngineSound[]): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const seen = new Set<number>();
    for (const e of list) {
      seen.add(e.id);
      let l = this.engineLoops.get(e.id);
      if (!l) {
        const truck = e.kind === 'truck';
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = truck ? 2.4 : 1.6;
        lp.frequency.value = 300;
        const panner = this.e.makePanner(e.pos);
        panner.refDistance = 5;
        panner.rolloffFactor = 1;
        panner.maxDistance = 400;
        lp.connect(gain).connect(panner).connect(this.e.effects);
        const send = ctx.createGain();
        send.gain.value = 0.12;
        gain.connect(send).connect(this.e.sends.effects);
        const oscs = [0, 1, 2].map((i) => {
          const o = ctx.createOscillator();
          o.type = i === 1 ? 'square' : i === 2 ? 'sine' : 'sawtooth';
          const og = ctx.createGain();
          og.gain.value = [0.42, truck ? 0.16 : 0.1, 0.5][i];
          o.connect(og).connect(lp);
          o.start(now);
          this.e.free(o, og);
          return o;
        });
        // The block's rough breathing: low noise, more of it on a diesel or a wreck.
        const rumble = this.e.noiseSource();
        const rl = ctx.createBiquadFilter();
        rl.type = 'bandpass';
        rl.frequency.value = truck ? 120 : 180;
        rl.Q.value = 0.8;
        const rumbleG = ctx.createGain();
        rumbleG.gain.value = 0;
        rumble.connect(rl).connect(rumbleG).connect(gain);
        rumble.start(now, Math.random() * 2);
        this.e.free(rumble, rl, rumbleG);
        // The horn, silent until pressed.
        const hornGain = ctx.createGain();
        hornGain.gain.value = 0;
        const hl = ctx.createBiquadFilter();
        hl.type = 'lowpass';
        hl.frequency.value = e.kind === 'police' ? 3200 : 2400;
        hornGain.connect(hl).connect(panner);
        let lfo: OscillatorNode | null = null;
        const horn: OscillatorNode[] = [];
        if (e.kind === 'police') {
          // A wail: one tone swept up and down by a slow oscillator.
          const o = ctx.createOscillator();
          o.type = 'square';
          o.frequency.value = 980;
          lfo = ctx.createOscillator();
          lfo.frequency.value = 0.42;
          const depth = ctx.createGain();
          depth.gain.value = 420;
          lfo.connect(depth).connect(o.frequency);
          const og = ctx.createGain();
          og.gain.value = 0.32;
          o.connect(og).connect(hornGain);
          lfo.start(now);
          o.start(now);
          this.e.free(lfo, depth);
          this.e.free(o, og);
          horn.push(o);
        } else {
          for (const f of truck ? [208, 262] : [405, 512]) {
            const o = ctx.createOscillator();
            o.type = truck ? 'sawtooth' : 'square';
            o.frequency.value = f;
            const og = ctx.createGain();
            og.gain.value = 0.22;
            o.connect(og).connect(hornGain);
            o.start(now);
            this.e.free(o, og);
            horn.push(o);
          }
        }
        this.e.free(horn[0], hornGain, hl, lp, gain, send, panner);
        l = { kind: e.kind, oscs, rumble, rumbleG, gain, lp, panner, horn, hornGain, lfo, rev: 0 };
        this.engineLoops.set(e.id, l);
      }
      l.panner.positionX.setTargetAtTime(e.pos.x, now, 0.03);
      l.panner.positionY.setTargetAtTime(e.pos.y + 0.6, now, 0.03);
      l.panner.positionZ.setTargetAtTime(e.pos.z, now, 0.03);
      const truck = l.kind === 'truck';
      const [idle, top] = truck ? [21, 92] : l.kind === 'wreck' ? [24, 150] : [27, 175];
      // Revs: through four gears with speed, revving in place on the throttle at a standstill.
      const v = Math.abs(e.speed);
      const span = Math.max(1, e.top / 4.2);
      let rev: number;
      if (v < 0.6) rev = e.throttle ? 0.45 : 0;
      else {
        const gear = Math.min(4, Math.floor(v / span));
        rev = 0.22 + 0.62 * Math.min(1, v / span - gear) + gear * 0.04 + (e.throttle ? 0.06 : 0);
      }
      l.rev += (rev - l.rev) * 0.35;
      const f = idle + (top - idle) * l.rev;
      // A wreck stumbles now and then.
      const miss = l.kind === 'wreck' && Math.random() < 0.06 ? 0.7 : 1;
      l.oscs[0].frequency.setTargetAtTime(f * miss, now, 0.06);
      l.oscs[1].frequency.setTargetAtTime(f * 2.003, now, 0.06);
      l.oscs[2].frequency.setTargetAtTime(f * 0.5, now, 0.06);
      l.lp.frequency.setTargetAtTime(240 + l.rev * 1300 + (e.throttle ? 500 : 0), now, 0.08);
      l.rumbleG.gain.setTargetAtTime(e.running ? (truck ? 0.9 : l.kind === 'wreck' ? 0.7 : 0.35) * (0.5 + l.rev) : 0, now, 0.1);
      const level = e.running ? (truck ? 0.55 : 0.4) * (0.55 + 0.45 * l.rev + (e.throttle ? 0.25 : 0)) : 0;
      l.gain.gain.setTargetAtTime(level, now, e.running ? 0.12 : 0.25);
      l.hornGain.gain.setTargetAtTime(e.horn ? (l.kind === 'police' ? 0.5 : 0.42) : 0, now, e.horn ? 0.01 : 0.03);
    }
    for (const [id, l] of this.engineLoops) {
      if (seen.has(id)) continue;
      this.stopEngine(l, now);
      this.engineLoops.delete(id);
    }
  }

  private stopEngine(l: { oscs: OscillatorNode[]; rumble: AudioBufferSourceNode; gain: GainNode; hornGain: GainNode; horn: OscillatorNode[]; lfo: OscillatorNode | null }, now: number): void {
    l.gain.gain.setTargetAtTime(0, now, 0.15);
    l.hornGain.gain.setTargetAtTime(0, now, 0.03);
    for (const o of [...l.oscs, ...l.horn]) o.stop(now + 1);
    l.lfo?.stop(now + 1);
    l.rumble.stop(now + 1);
  }

  /** A car door: the latch, the slam into the frame, the body rocking on its springs. */
  carDoor(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.25, 3);
    this.crack(d, t, 'bandpass', 2900, 2.2, 0.7, 0.02);
    this.e.tone(d, t + 0.015, 'sine', 120, 55, 0.9, 0.003, 0.16);
    this.e.burst(d, t + 0.015, 'lowpass', 520, 0.7, 0.8, 0.002, 0.12);
    this.crack(d, t + 0.02, 'bandpass', 1300, 1.5, 0.45, 0.06);
  }

  /** The starter turning the engine over for `seconds` (it catches, or it doesn't). */
  starter(position: THREE.Vector3, seconds: number): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const d = this.e.out(position, 0.15, 4);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(150, t);
    o.frequency.linearRampToValueAtTime(175, t + seconds);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 1.2;
    // The compression strokes: the whine labours in a chug about nine times a second.
    const chug = ctx.createOscillator();
    chug.type = 'triangle';
    chug.frequency.setValueAtTime(7.5, t);
    chug.frequency.linearRampToValueAtTime(10, t + seconds);
    const depth = ctx.createGain();
    depth.gain.value = 0.32;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.4, t + 0.05);
    g.gain.setValueAtTime(0.4, t + Math.max(0.06, seconds - 0.05));
    g.gain.linearRampToValueAtTime(0, t + seconds + 0.06);
    chug.connect(depth).connect(g.gain);
    o.connect(bp).connect(g).connect(d);
    o.start(t);
    chug.start(t);
    o.stop(t + seconds + 0.1);
    chug.stop(t + seconds + 0.1);
    this.e.free(o, bp, g);
    this.e.free(chug, depth);
  }

  /** The engine catching: a rising roar that settles into the idle. */
  engineCatch(position: THREE.Vector3, truck = false): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.3, 5);
    const f = truck ? 0.8 : 1;
    this.e.tone(d, t, 'sawtooth', 32 * f, 78 * f, 0.5, 0.04, 0.45, 0.2);
    this.e.tone(d, t, 'square', 64 * f, 150 * f, 0.08, 0.04, 0.35, 0.2);
    this.e.burst(d, t, 'lowpass', 380, 0.9, 0.5, 0.03, 0.4);
  }

  /** An engine dying (out of gas), or one that won't catch: a few weak, irregular coughs. */
  sputter(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.25, 4);
    let at = t;
    for (let i = 0; i < 5; i++) {
      const k = 1 - i * 0.17;
      this.e.tone(d, at, 'sawtooth', 58 + Math.random() * 10, 34, 0.45 * k, 0.005, 0.14);
      this.e.burst(d, at, 'lowpass', 600, 0.8, 0.45 * k, 0.003, 0.09);
      at += 0.12 + Math.random() * 0.22 + i * 0.05;
    }
  }

  /** A vehicle hitting something hard: metal folding, a deep thump, glass going at the worst of it (`strength` m/s lost). */
  carCrash(position: THREE.Vector3, strength: number): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const k = Math.min(1, strength / 16);
    const d = this.e.out(position, 0.45, 6);
    this.e.tone(d, t, 'sine', 95, 38, 0.6 + k * 0.7, 0.003, 0.35);
    this.e.burst(d, t, 'lowpass', 900, 0.8, 0.6 + k * 0.8, 0.002, 0.3);
    for (let i = 0; i < 3 + Math.round(k * 4); i++) {
      this.e.burst(d, t + 0.01 + i * 0.03 + Math.random() * 0.02, 'bandpass', 1400 + Math.random() * 2200, 3, 0.35 * (0.5 + k), 0.002, 0.08 + Math.random() * 0.1);
    }
    if (k > 0.55) for (let i = 0; i < 7; i++) this.crack(d, t + 0.05 + i * 0.03 + Math.random() * 0.05, 'highpass', 4500 + Math.random() * 3000, 1.5, 0.35, 0.05);
  }

  /** A body hit by a vehicle: a heavy, dull thump into the bodywork (`strength` 0..1). */
  carHit(position: THREE.Vector3, strength: number): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.3, 5);
    const k = 0.5 + 0.5 * Math.min(1, strength);
    this.e.tone(d, t, 'sine', 85, 40, 0.9 * k, 0.003, 0.22);
    this.e.burst(d, t, 'lowpass', 650, 0.9, 0.9 * k, 0.002, 0.16);
    this.e.burst(d, t + 0.01, 'bandpass', 1700, 2, 0.25 * k, 0.002, 0.06);
  }

  // ------------------------------------------------------------------ bicycles

  private readonly bikeLoops = new Map<number, {
    tyre: AudioBufferSourceNode; ticks: AudioBufferSourceNode; skid: AudioBufferSourceNode;
    body: BiquadFilterNode; bodyG: GainNode; hiss: GainNode; tickG: GainNode; skidG: GainNode; gain: GainNode; panner: PannerNode;
  }>();
  /** Built on first use (or while a night loads): tyres on asphalt (looped), and the freewheel's ratchet (looped, 20 clicks a second at rate 1). */
  private bikeBufs: { tyre: AudioBuffer; ticks: AudioBuffer } | null = null;
  /** Clicks in one pass of the ratchet loop, and pawl clicks per turn of the back wheel. */
  private static readonly TICKS = 20;
  private static readonly PAWLS = 18;

  bikeBuffers(): { tyre: AudioBuffer; ticks: AudioBuffer } {
    if (this.bikeBufs) return this.bikeBufs;
    const ctx = this.e.ctx!;
    const sr = ctx.sampleRate;
    // Pneumatic tyres: a smoother hiss than urethane wheels (rubber and air soak up the grit), with
    // a few soft ticks of stones under the tread, nothing below ~150 Hz. Crossfaded ends.
    const n = Math.round(sr * 2.1), fade = Math.round(sr * 0.1);
    const raw = new Float32Array(n + fade);
    let hp = 0, prev = 0, lp = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      hp = 0.98 * (hp + w - prev);
      prev = w;
      lp += (hp - lp) * 0.55;
      raw[i] = lp * 0.5;
    }
    for (let i = 0; i < raw.length;) {
      i += 1 + Math.round((-Math.log(1 - Math.random()) * sr) / 260);
      const a = Math.pow(Math.random(), 3) * 0.6;
      const len = Math.round(sr * (0.0004 + Math.random() * 0.0008));
      for (let k = 0; k < len && i + k < raw.length; k++) raw[i + k] += a * (Math.random() * 2 - 1) * Math.exp((-3 * k) / len);
    }
    const tyre = ctx.createBuffer(1, n, sr);
    const d = tyre.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = i < fade ? raw[i] * (i / fade) + raw[n + i] * (1 - i / fade) : raw[i];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[i] * d[i];
    const norm = 0.3 / Math.sqrt(sum / n);
    for (let i = 0; i < n; i++) d[i] *= norm;
    // The freewheel: pawls snapping over the ratchet teeth, a tiny bright click with a metallic ring each.
    const T = WheelSounds.TICKS;
    const ticks = ctx.createBuffer(1, sr, sr);
    const td = ticks.getChannelData(0);
    for (let k = 0; k < T; k++) {
      const at = Math.round(((k + (Math.random() - 0.5) * 0.12) / T) * sr);
      const amp = 0.75 + Math.random() * 0.25;
      const f = 4200 + Math.random() * 900, f2 = 7300 + Math.random() * 800;
      const len = Math.round(sr * 0.012);
      for (let j = 0; j < len; j++) {
        const i = (at + j + sr) % sr;
        const t = j / sr;
        const click = j < sr * 0.0006 ? (Math.random() * 2 - 1) * (1 - j / (sr * 0.0006)) : 0;
        td[i] += amp * (click * 0.9 + (Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f2 * t) * 0.3) * Math.exp(-t * 900));
      }
    }
    this.bikeBufs = { tyre, ticks };
    return this.bikeBufs;
  }

  /**
   * Tyres on the street, one loop per moving bike: a hiss that rises and brightens with speed
   * (sidewalk concrete smoother, grass and dirt a soft rumble); the freewheel ticking while
   * coasting, faster with the wheel; the back tyre scrubbing in a hard brake. Bikes left out fade.
   */
  bikeRoll(list: { id: number; pos: THREE.Vector3; speed: number; rough: number; coast: boolean; skid: number }[]): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const seen = new Set<number>();
    for (const b of list) {
      seen.add(b.id);
      let l = this.bikeLoops.get(b.id);
      if (!l) {
        const bufs = this.bikeBuffers();
        const tyre = ctx.createBufferSource();
        tyre.buffer = bufs.tyre;
        tyre.loop = true;
        const body = ctx.createBiquadFilter();
        body.type = 'bandpass';
        body.Q.value = 0.6;
        body.frequency.value = 900;
        const bodyG = ctx.createGain();
        const hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = 3200;
        const hiss = ctx.createGain();
        const ticks = ctx.createBufferSource();
        ticks.buffer = bufs.ticks;
        ticks.loop = true;
        const tickG = ctx.createGain();
        const skid = ctx.createBufferSource();
        skid.buffer = this.skateBuffers().white;
        skid.loop = true;
        const skidF = ctx.createBiquadFilter();
        skidF.type = 'bandpass';
        skidF.frequency.value = 1500;
        skidF.Q.value = 1.1;
        const skidG = ctx.createGain();
        for (const g of [bodyG, hiss, tickG, skidG]) g.gain.value = 0;
        const tame = ctx.createBiquadFilter();
        tame.type = 'lowpass';
        tame.frequency.value = 9000;
        tame.Q.value = 0.5;
        const gain = ctx.createGain();
        gain.gain.value = 1;
        const panner = this.e.makePanner(b.pos);
        panner.refDistance = 3;
        panner.rolloffFactor = 0.9;
        tyre.connect(body).connect(bodyG).connect(gain);
        tyre.connect(hpf).connect(hiss).connect(gain);
        ticks.connect(tickG).connect(gain);
        skid.connect(skidF).connect(skidG).connect(gain);
        gain.connect(tame).connect(panner).connect(this.e.effects);
        tyre.start(now, Math.random() * 1.8);
        ticks.start(now, Math.random() * 0.9);
        skid.start(now, Math.random() * 0.8);
        l = { tyre, ticks, skid, body, bodyG, hiss, tickG, skidG, gain, panner };
        this.bikeLoops.set(b.id, l);
      }
      const v = b.speed;
      const soft = b.rough > 1.2;
      const k = Math.min(1.3, v / 10);
      l.panner.positionX.setTargetAtTime(b.pos.x, now, 0.03);
      l.panner.positionY.setTargetAtTime(b.pos.y + 0.2, now, 0.03);
      l.panner.positionZ.setTargetAtTime(b.pos.z, now, 0.03);
      l.tyre.playbackRate.setTargetAtTime(0.7 + 0.38 * Math.min(1.4, v / 10), now, 0.08);
      l.body.frequency.setTargetAtTime(soft ? 240 : 420 + v * 70, now, 0.08);
      // Pneumatic tyres: about 3 dB under a skateboard's hard wheels at the same speed (measured with dev/bikeclips.html).
      l.bodyG.gain.setTargetAtTime((soft ? 0.9 : 0.75 + 0.25 * Math.min(1, b.rough)) * 0.85 * Math.pow(k, 0.8), now, 0.08);
      l.hiss.gain.setTargetAtTime((soft ? 0.05 : 0.22 * Math.min(1, b.rough) + 0.08) * 0.7 * Math.pow(k, 0.9), now, 0.08);
      // Pawl clicks per second: wheel turns per second × pawls (18), heard while the feet are still.
      const clicks = (v / (2 * Math.PI * 0.33)) * WheelSounds.PAWLS;
      l.ticks.playbackRate.setTargetAtTime(THREE.MathUtils.clamp(clicks / WheelSounds.TICKS, 0.2, 4.6), now, 0.05);
      l.tickG.gain.setTargetAtTime(b.coast && v > 0.4 ? 0.34 * Math.min(1, 0.45 + v / 6) : 0, now, b.coast ? 0.04 : 0.02);
      l.skidG.gain.setTargetAtTime(b.skid * Math.min(1, v / 6) * 0.9, now, 0.04);
    }
    for (const [id, l] of this.bikeLoops) {
      if (seen.has(id)) continue;
      l.gain.gain.setTargetAtTime(0, now, 0.05);
      for (const src of [l.tyre, l.ticks, l.skid]) src.stop(now + 0.6);
      this.bikeLoops.delete(id);
    }
  }

  /** Front then back tyre thumping over a sidewalk seam (`gap`: seconds between the wheels). */
  bikeSeam(position: THREE.Vector3, strength: number, gap: number): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.08, 3);
    const s = 0.4 + 0.6 * strength;
    for (const [at, k] of [[t, 1], [t + Math.min(0.5, gap), 0.85]] as const) {
      this.e.tone(d, at, 'sine', 120, 70, 0.4 * s * k, 0.002, 0.07);
      this.crack(d, at, 'bandpass', 700 + Math.random() * 200, 1.1, 0.7 * s * k, 0.025);
    }
  }

  /** Picked up off the street and straddled: tyres bouncing, the chain slapping the stay. */
  bikeMount(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.2, 3);
    this.e.tone(d, t, 'sine', 115, 70, 0.55, 0.003, 0.12);
    this.crack(d, t, 'bandpass', 850, 1.0, 1.6, 0.05);
    for (let i = 0; i < 4; i++) this.crack(d, t + 0.05 + i * 0.03 + Math.random() * 0.02, 'bandpass', 3000 + Math.random() * 1800, 3, 0.9 - i * 0.15, 0.015);
    // The saddle taking the weight, the bell rung by the jolt.
    this.e.tone(d, t + 0.18, 'sine', 140, 95, 0.3, 0.004, 0.08);
    this.bellPartials(d, t + 0.02, 0.05);
  }

  /** A shoe landing on a peg. */
  bikePeg(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.15, 3);
    this.crack(d, t, 'bandpass', 2600, 2.5, 1.4, 0.03);
    this.e.tone(d, t, 'triangle', 1900, 1700, 0.18, 0.001, 0.09);
    this.e.tone(d, t, 'sine', 130, 80, 0.35, 0.003, 0.08);
  }

  /** Falling over onto its side: pedal and bar end hitting the street, the frame rattling, a spoke ring. */
  bikeDrop(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.3, 3.5);
    this.e.tone(d, t, 'sine', 95, 50, 0.55, 0.003, 0.16);
    this.crack(d, t, 'bandpass', 1300, 1.2, 2.2, 0.06);
    for (let i = 0; i < 5; i++) {
      const at = t + 0.03 + i * 0.045 + Math.random() * 0.03;
      this.crack(d, at, 'bandpass', 1800 + Math.random() * 2600, 2.2, 1.3 * (1 - i * 0.16), 0.03);
    }
    this.e.tone(d, t + 0.01, 'triangle', 2650, 2600, 0.08, 0.001, 0.5);
    this.bellPartials(d, t + 0.04, 0.12);
  }

  /** Both tyres back on the street after a hop (`strength` by how long it was in the air). */
  bikeLand(position: THREE.Vector3, strength: number): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.25, 3);
    const k = 0.5 + 0.5 * strength;
    this.e.tone(d, t, 'sine', 100, 55, 0.6 * k, 0.003, 0.14);
    this.crack(d, t, 'bandpass', 800, 1.0, 1.6 * k, 0.06);
    this.e.tone(d, t + 0.04, 'sine', 120, 65, 0.4 * k, 0.003, 0.1);
    for (let i = 0; i < 3; i++) this.crack(d, t + 0.02 + i * 0.03, 'bandpass', 3200 + Math.random() * 1500, 3, 0.9 * k / (i + 1), 0.015);
  }

  /** Thrown off: the bike going down at speed, scraping along the asphalt, the frame clattering. */
  bikeCrash(position: THREE.Vector3): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.45, 4);
    this.e.tone(d, t, 'sine', 90, 42, 0.8, 0.003, 0.22);
    this.crack(d, t, 'bandpass', 1100, 1.0, 3, 0.08);
    // Scraping: metal and rubber dragged a metre or two.
    this.crack(d, t + 0.03, 'bandpass', 2400, 0.8, 1.3, 0.45, 0.04);
    for (let i = 0; i < 7; i++) {
      const at = t + 0.04 + i * 0.07 + Math.random() * 0.05;
      this.crack(d, at, 'bandpass', 1400 + Math.random() * 3000, 2, 2.2 * (1 - i * 0.12), 0.035);
    }
    this.bellPartials(d, t + 0.05, 0.25);
  }

  /** The rider's bell: two quick strikes of a little steel dome. */
  bikeBell(position: THREE.Vector3, own = false): void {
    if (!this.e.ctx) return;
    const t = this.e.ctx.currentTime;
    const d = this.e.out(position, 0.25, own ? 2 : 4);
    for (const [at, k] of [[t, 1], [t + 0.15, 0.85]] as const) {
      this.crack(d, at, 'highpass', 5000, 0.7, 0.5 * k, 0.004);
      this.bellPartials(d, at, k);
    }
  }

  /** A bicycle bell's ring: the dome's inharmonic partials, a hair detuned so it shimmers. */
  private bellPartials(d: AudioNode, t: number, k: number): void {
    const f = 2080;
    for (const [m, a, decay] of [[1, 0.5, 0.95], [1.004, 0.25, 0.9], [2.33, 0.22, 0.5], [3.92, 0.14, 0.3], [5.6, 0.07, 0.18]] as const) {
      this.e.tone(d, t, 'sine', f * m, f * m * 0.998, a * k, 0.0015, decay);
    }
  }

  dispose(): void {
    for (const l of this.engineLoops.values()) this.stopEngine(l, this.e.ctx?.currentTime ?? 0);
    this.engineLoops.clear();
    for (const l of this.skateLoops.values()) l.src.stop();
    this.skateLoops.clear();
    for (const l of this.bikeLoops.values()) for (const src of [l.tyre, l.ticks, l.skid]) src.stop();
    this.bikeLoops.clear();
  }
}
