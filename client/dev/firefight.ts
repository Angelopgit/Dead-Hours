/**
 * Dev-only stress test for online gunfire: a four-player lobby fighting a horde, played through the
 * game's own AudioEngine. Three teammates fire full auto (AR beside you, M249 behind, MP5 down the
 * street) while you fire bursts; rounds go into zombies (flesh, groans, hurt cries), miss into the
 * street, cases bounce and the horde's feet slap the road, at the rates the game sends them.
 *
 * window.firefight({ realtime?, seconds?, empty? }) runs it (empty: the night's ambience alone) and reports:
 * - every teammate shot: played whole, cut short (and how long it had played), or never played;
 * - offline: how long the render took against the audio's length (the audio thread's load);
 * - realtime: underruns (the output going silent because the audio thread fell behind);
 * - the output's peak and how much of it sat deep in the master's soft clipper.
 * offline also returns the mix as a base64 WAV.
 */
import * as THREE from 'three';
import { MAPLE_HOLLOW as map, WEAPONS, type Vec3, type WeaponId } from '@dead-hours/shared';
import { AudioEngine } from '../src/audio/AudioEngine';
import { Acoustics } from '../src/audio/Acoustics';
import { Physics, initPhysics } from '../src/core/Physics';

const SR = 48000;
const FRAME = 1 / 60;
const ear = new THREE.Vector3(-40, 1.75, -4.6);
const look = new THREE.Vector3(-20, 1.75, -4.6);

interface Shooter { id: string; weapon: WeaponId; at: THREE.Vector3; on: number; off: number; local?: boolean }
const SHOOTERS: Shooter[] = [
  { id: 'you', weapon: 'ar', at: ear, on: 1.2, off: 0.8, local: true },
  { id: 'ar-6m', weapon: 'ar', at: new THREE.Vector3(-40, 1.6, -10.6), on: 1.6, off: 0.4 },
  { id: 'lmg-14m', weapon: 'lmg', at: new THREE.Vector3(-48, 1.6, 6.5), on: 6, off: 3 },
  { id: 'smg-23m', weapon: 'smg', at: new THREE.Vector3(-30, 1.6, -25), on: 1, off: 0.5 },
];

type Ev = { t: number; run: (eng: AudioEngine) => void };

/** A seeded random stream, so before and after hear the same fight. */
function rng(seed: number): () => number {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

export interface ShotLog { shooter: string; t: number; dist: number; played: boolean; cutAt: number | null; end: number }

function script(seconds: number, log: ShotLog[], tagShot: (k: number) => void): Ev[] {
  const r = rng(0x5eed);
  const evs: Ev[] = [];
  const zombies = Array.from({ length: 30 }, () => new THREE.Vector3(-25 + r() * 20, 0.15, -14 + r() * 20));
  const chest = (z: THREE.Vector3) => z.clone().setY(1.3 + r() * 0.4);
  const q = (t: number) => Math.ceil(t / FRAME) * FRAME;
  for (const s of SHOOTERS) {
    const def = WEAPONS[s.weapon];
    const gap = 60 / def.fireRate;
    for (let t = 0.05 + r() * 0.2; t < seconds - 0.5; t += s.on + s.off) {
      for (let u = t; u < Math.min(t + s.on, seconds - 0.5); u += gap) {
        const target = zombies[Math.floor(r() * zombies.length)];
        const hit = r() < 0.6;
        const end: Vec3 = hit ? chest(target) : { x: target.x + 4, y: 0.1, z: target.z + (r() - 0.5) * 6 };
        const at = s.at.clone();
        const k = log.length;
        if (!s.local) log.push({ shooter: s.id, t: q(u), dist: at.distanceTo(ear), played: false, cutAt: null, end: 0 });
        evs.push({
          t: q(u), run: (eng) => {
            if (s.local) eng.gunshot(s.weapon, at, true);
            else {
              tagShot(k);
              eng.gunshot(s.weapon, at, false, [end]);
            }
          },
        });
        // What the round did, as the server's next events tell it (a step or two later).
        const land = q(u + 0.03 + r() * 0.03);
        const pos = new THREE.Vector3(end.x, end.y, end.z);
        if (hit) {
          evs.push({ t: land, run: (eng) => eng.flesh(pos, { damage: def.damage, head: r() < 0.15, own: !!s.local, melee: false }) });
          if (r() < 0.4) evs.push({ t: land, run: (eng) => eng.zombieHurt(pos, 0.9 + r() * 0.3) });
          if (r() < 0.08) evs.push({ t: land, run: (eng) => eng.zombieDeath(pos, 0.9 + r() * 0.3) });
        } else evs.push({ t: land, run: (eng) => eng.impact(r() < 0.3 ? 'metal' : 'concrete', pos) });
        // The spent case hits the road.
        const c = at.clone().add(new THREE.Vector3(0.4, -1.4, 0.2));
        evs.push({ t: q(u + 0.35 + r() * 0.2), run: (eng) => eng.casing(c, false, 0.6 + r() * 0.4) });
      }
    }
  }
  // The horde: feet at the game's budget (24 a second), groans, the odd alert.
  for (let t = 0; t < seconds; t += 1 / 24) {
    const z = zombies[Math.floor(r() * zombies.length)];
    const gait = r() < 0.6 ? 'walker' : 'runner';
    evs.push({ t: q(t), run: (eng) => eng.zombieStep(z, gait, 0.5) });
  }
  for (let t = 0; t < seconds; t += 0.35) {
    const z = zombies[Math.floor(r() * zombies.length)];
    evs.push({ t: q(t), run: (eng) => eng.groan(chest(z), 1, 0.9 + r() * 0.2) });
    if (r() < 0.15) evs.push({ t: q(t), run: (eng) => eng.zombieAlert(chest(z), 0.9 + r() * 0.4) });
  }
  // The game throttles impact sounds to one per 35 ms.
  evs.sort((a, b) => a.t - b.t);
  return evs;
}

function wav(buf: AudioBuffer): string {
  const n = buf.length, ch = buf.numberOfChannels;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true); data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); str(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) data.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 0x7fff, true);
  const bytes = new Uint8Array(data.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Hooks the engine's handling of teammates' shots to log what became of each: works on the old
 * engine (claimVoice + voices) and the new one (shotVoices, with its own observer).
 */
function watch(eng: AudioEngine, log: ShotLog[]): (k: number) => void {
  let current = -1;
  const e = eng as unknown as Record<string, unknown>;
  const now = () => eng.ctx!.currentTime;
  if (e.shotVoices) {
    const pool = e.shotVoices as {
      observer: ((ev: { kind: 'play' | 'drop' | 'cut'; tag: unknown; at: number; end?: number }) => void) | null;
      claim: (v: { tag?: unknown; own?: boolean }, now: number) => boolean;
    };
    pool.observer = (ev) => {
      const s = typeof ev.tag === 'number' ? log[ev.tag] : undefined;
      if (!s) return;
      if (ev.kind === 'play') { s.played = true; s.end = ev.end ?? 0; }
      else if (ev.kind === 'cut' && s.cutAt === null) s.cutAt = ev.at;
    };
    const claim = pool.claim.bind(pool);
    pool.claim = (v, t) => {
      if (!v.own && current >= 0) v.tag = current;
      current = -1;
      return claim(v, t);
    };
    return (k) => { current = k; };
  }
  const voices = e.voices as { end: number; dist: number; level: GainNode }[];
  const tags = new Map<GainNode, number>();
  const claim = (e.claimVoice as (d: number, end: number, level: GainNode) => boolean).bind(eng);
  e.claimVoice = (d: number, end: number, level: GainNode): boolean => {
    const before = voices.slice();
    const ok = claim(d, end, level);
    const t = now();
    for (const v of before) {
      if (!voices.includes(v) && v.end >= t) {
        const k = tags.get(v.level);
        if (k !== undefined && log[k].cutAt === null) log[k].cutAt = t;
      }
    }
    if (ok && current >= 0) {
      tags.set(level, current);
      log[current].played = true;
      log[current].end = end;
    }
    return ok;
  };
  return (k) => { current = k; };
}

function measure(buf: AudioBuffer): { peak: number; hot: number } {
  let peak = 0, hot = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) peak = a;
      if (a > 0.9) hot++;
      n++;
    }
  }
  return { peak, hot: hot / n };
}

let acoustics: Acoustics | null = null;
async function world(): Promise<Acoustics> {
  if (acoustics) return acoustics;
  await initPhysics();
  const physics = new Physics(map);
  physics.world.step();
  acoustics = new Acoustics(physics);
  return acoustics;
}

function summary(log: ShotLog[]) {
  const by: Record<string, { shots: number; dropped: number; cut: number; heardMs: number[] }> = {};
  for (const s of log) {
    const b = (by[s.shooter] ??= { shots: 0, dropped: 0, cut: 0, heardMs: [] });
    b.shots++;
    if (!s.played) b.dropped++;
    else if (s.cutAt !== null) {
      b.cut++;
      b.heardMs.push(Math.round((s.cutAt - (s.t + s.dist / 343)) * 1000));
    }
  }
  return Object.fromEntries(Object.entries(by).map(([k, b]) => {
    const h = b.heardMs.sort((x, y) => x - y);
    return [k, { shots: b.shots, dropped: b.dropped, cut: b.cut, cutAfterMedianMs: h.length ? h[h.length >> 1] : null }];
  }));
}

async function firefight(opts: { realtime?: boolean; seconds?: number; wav?: boolean; empty?: boolean; patch?: (eng: AudioEngine) => void } = {}) {
  const seconds = opts.seconds ?? 10;
  const ac = await world();
  const cam = new THREE.PerspectiveCamera();
  cam.position.copy(ear);
  cam.lookAt(look);
  cam.updateMatrixWorld();
  const log: ShotLog[] = [];
  let tag: (k: number) => void = () => undefined;
  const evs = opts.empty ? [] : script(seconds, log, (k) => tag(k));
  const eng = new AudioEngine();
  opts.patch?.(eng);
  if (!opts.realtime) {
    const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
    eng.unlock(ctx);
    await eng.recordingsReady;
    eng.setAcoustics(ac);
    tag = watch(eng, log);
    // Frames: the engine's update and that frame's events, as the game runs them.
    const marks: number[] = [];
    const js: number[] = [];
    const frames = new Map<number, Ev[]>();
    for (const e of evs) {
      const f = Math.round(e.t / FRAME);
      (frames.get(f) ?? frames.set(f, []).get(f)!).push(e);
    }
    for (let f = 1; f * FRAME < seconds - 0.01; f++) {
      const list = frames.get(f) ?? [];
      void ctx.suspend(Math.round((f * FRAME * SR) / 128) * 128 / SR).then(() => {
        const m0 = performance.now();
        marks.push(m0);
        eng.update(FRAME, cam);
        for (const e of list) e.run(eng);
        js.push(performance.now() - m0);
        void ctx.resume();
      });
    }
    eng.update(FRAME, cam);
    const t0 = performance.now();
    const out = await ctx.startRendering();
    const wall = (performance.now() - t0) / 1000;
    eng.dispose();
    // How long each second of audio took to render, second by second.
    const perSecond: number[] = [];
    const jsPerSecond: number[] = [];
    for (let k = 60; k < marks.length; k += 60) {
      perSecond.push(+((marks[k] - marks[k - 60]) / 1000).toFixed(2));
      jsPerSecond.push(+(js.slice(k - 60, k).reduce((a, b) => a + b, 0) / 1000).toFixed(2));
    }
    return { mode: 'offline', seconds, perSecond, jsPerSecond, renderSeconds: +wall.toFixed(2), load: +(wall / seconds).toFixed(3), ...measure(out), shots: summary(log), log, wav: opts.wav ? wav(out) : undefined };
  }
  const ctx = new AudioContext({ sampleRate: SR });
  eng.unlock(ctx);
  await ctx.resume();
  await eng.recordingsReady;
  eng.setAcoustics(ac);
  tag = watch(eng, log);
  eng.update(FRAME, cam);
  const stats = () => {
    const p = (ctx as unknown as { playbackStats?: { underrunEvents: number; underrunDuration: number; totalDuration: number } }).playbackStats;
    return p ? { events: p.underrunEvents, duration: p.underrunDuration, total: p.totalDuration } : null;
  };
  await new Promise((r) => setTimeout(r, 500));
  const s0 = stats();
  const start = ctx.currentTime;
  // Shot times in the log are from the start of the fight; the engine's are the audio clock's.
  for (const s of log) s.t += start;
  let i = 0;
  // Underruns second by second.
  const perSecond: number[] = [];
  let last = s0?.events ?? 0, next = 1;
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      const t = ctx.currentTime - start;
      eng.update(FRAME, cam);
      while (i < evs.length && evs[i].t <= t) evs[i++].run(eng);
      if (t >= next) {
        const e = stats()?.events ?? 0;
        perSecond.push(e - last);
        last = e;
        next++;
      }
      if (t >= seconds) {
        clearInterval(timer);
        done();
      }
    }, FRAME * 1000);
  });
  const s1 = stats();
  eng.dispose();
  return {
    mode: 'realtime', seconds,
    underruns: s0 && s1 ? { events: s1.events - s0.events, seconds: +(s1.duration - s0.duration).toFixed(3), perSecond } : 'playbackStats not supported',
    shots: summary(log), log,
  };
}

Object.assign(window, { firefight, AudioEngine, THREE });
document.getElementById('run')?.addEventListener('click', () => {
  void firefight({ realtime: true }).then((r) => {
    document.getElementById('out')!.textContent = JSON.stringify({ ...r, log: undefined }, null, 2);
  });
});
