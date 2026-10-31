/**
 * Dev-only listening tests: renders shots through the game's own AudioEngine into an
 * OfflineAudioContext, on the real map's acoustics, so every clip is exactly what the game plays.
 * window.renderClips() returns { name: base64 WAV }; each clip is also listed with a player.
 * window.renderClips({ synth: true }) plays the synthesized shots in place of the recordings.
 */
import * as THREE from 'three';
import { MAPLE_HOLLOW as map, WEAPONS, type Vec3, type WeaponId } from '@dead-hours/shared';
import { AudioEngine } from '../src/audio/AudioEngine';
import { Acoustics } from '../src/audio/Acoustics';
import { Physics, initPhysics } from '../src/core/Physics';
import { reloadTimeline } from '../src/weapons/reloadScript';

const SR = 48000;
const ear = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y + 1.6, z);
const PLACES = {
  street: ear(-40, 0.15, -4.6),
  room: ear(4.8, 0.32, -22.3),
  basement: ear(-3.5, -2.68, -21),
  store: ear(92, 0.2, -36),
  frontWalk: ear(4.8, 0.15, -6.5),
};

interface Clip {
  name: string;
  seconds: number;
  listener: THREE.Vector3;
  /** Where the listener faces. */
  look: THREE.Vector3;
  shots: { weapon: string; at: THREE.Vector3; local: boolean; bullets?: Vec3[]; delay?: number }[];
  /** Other sounds, played at the start. */
  play?: (eng: AudioEngine) => void;
}

const GUNS = ['ar', 'smg', 'shotgun', 'marksman', 'pistol', 'lmg', 'battle', 'sniper'];

function clips(): Clip[] {
  const out: Clip[] = [];
  for (const gun of GUNS) {
    for (const space of ['street', 'room', 'basement', 'store'] as const) {
      const at = PLACES[space];
      out.push({ name: `${gun}-${space}`, seconds: 2.6, listener: at, look: at.clone().add(new THREE.Vector3(0, 0, -5)), shots: [{ weapon: gun, at, local: true }] });
    }
  }
  const st = PLACES.street;
  const down = new THREE.Vector3(20, st.y, st.z);
  out.push({
    name: 'ar-60m-down-the-street', seconds: 3, listener: st, look: down,
    shots: [{ weapon: 'ar', at: down, local: false, bullets: [{ x: 20, y: st.y, z: 60 }] }],
  });
  const far = new THREE.Vector3(60, st.y, st.z);
  for (const gun of ['ar', 'marksman']) {
    out.push({
      name: `${gun}-flyby-100m`, seconds: 3, listener: st, look: far,
      shots: [{ weapon: gun, at: far, local: false, bullets: [{ x: -200, y: st.y + 0.4, z: st.z + 1.5 }] }],
    });
  }
  out.push({
    name: 'ar-in-house-heard-from-street', seconds: 2.6, listener: PLACES.frontWalk, look: PLACES.room,
    shots: [{ weapon: 'ar', at: PLACES.room, local: false, bullets: [{ x: 4.8, y: PLACES.room.y, z: -40 }] }],
  });
  out.push({
    name: 'ar-on-street-heard-from-house', seconds: 2.6, listener: PLACES.room, look: PLACES.frontWalk,
    shots: [{ weapon: 'ar', at: PLACES.frontWalk, local: false, bullets: [{ x: 60, y: PLACES.frontWalk.y, z: -6.5 }] }],
  });
  // Down the open street, nothing in between.
  const ahead = (m: number) => st.clone().add(new THREE.Vector3(m, -1.1, 0));
  const look = st.clone().add(new THREE.Vector3(5, 0, 0));
  out.push({ name: 'flesh-own-12m', seconds: 1, listener: st, look, shots: [], play: (e) => e.flesh(ahead(12), { damage: 35, head: false, own: true, melee: false }) });
  out.push({ name: 'flesh-head-own-12m', seconds: 1, listener: st, look, shots: [], play: (e) => e.flesh(ahead(12), { damage: 120, head: true, own: true, melee: false }) });
  out.push({ name: 'flesh-other-12m', seconds: 1, listener: st, look, shots: [], play: (e) => e.flesh(ahead(12), { damage: 35, head: false, own: false, melee: false }) });
  out.push({ name: 'flesh-melee-2m', seconds: 1, listener: st, look, shots: [], play: (e) => e.flesh(ahead(2), { damage: 60, head: false, own: true, melee: true }) });
  out.push({
    name: 'shotgun-pellets-8m', seconds: 1.4, listener: st, look, shots: [{ weapon: 'shotgun', at: st, local: true }],
    play: (e) => { for (let k = 0; k < 8; k++) e.flesh(ahead(8).add(new THREE.Vector3(Math.random() * 0.4, Math.random() * 0.6, 0)), { damage: 18, head: false, own: true, melee: false }); },
  });
  for (const gait of ['walker', 'runner', 'brute'] as const) {
    out.push({ name: `steps-${gait}-10m`, seconds: 1.2, listener: st, look, shots: [], play: (e) => e.zombieStep(ahead(10).setY(0.15), gait, 0.5) });
  }
  out.push({ name: 'steps-own', seconds: 1.2, listener: st, look, shots: [], play: (e) => e.footstep(1, false) });
  out.push({ name: 'steps-walker-3m', seconds: 1.2, listener: st, look, shots: [], play: (e) => e.zombieStep(ahead(3).setY(0.15), 'walker', 0.5) });
  out.push({ name: 'groan-15m', seconds: 2.5, listener: st, look, shots: [], play: (e) => e.groan(ahead(15), 1, 1) });
  out.push({ name: 'groan-50m', seconds: 2.5, listener: st, look, shots: [], play: (e) => e.groan(ahead(50), 1, 1) });
  // Reloads, played on the script's timeline: your own (hands just below and right of the eye),
  // and someone else's down the street and through a wall.
  const reload = (gun: string, empty: boolean, hand: THREE.Vector3, own: boolean) => (e: AudioEngine) => {
    const def = WEAPONS[gun as WeaponId];
    const cues = def.perShell ? reloadTimeline(gun, empty, 0, 4, def.reloadTime / def.magazine) : reloadTimeline(gun, empty, def.reloadTime + (empty ? 0.35 : 0));
    for (const c of cues) e.foley(c.cue, hand, gun, c.t + 0.1, own);
  };
  const hands = (at: THREE.Vector3) => at.clone().add(new THREE.Vector3(0.22, -0.4, -0.35));
  const ahead5 = (at: THREE.Vector3) => at.clone().add(new THREE.Vector3(0, 0, -5));
  for (const gun of GUNS) {
    for (const empty of [true, false]) {
      if (gun === 'shotgun' && !empty) continue;
      out.push({ name: `reload-${gun}-${empty ? 'empty' : 'tactical'}-own-room`, seconds: 6.2, listener: PLACES.room, look: ahead5(PLACES.room), shots: [], play: reload(gun, empty, hands(PLACES.room), true) });
    }
  }
  out.push({ name: 'reload-ar-empty-own-street', seconds: 3.2, listener: st, look: ahead5(st), shots: [], play: reload('ar', true, hands(st), true) });
  out.push({ name: 'reload-ar-empty-own-basement', seconds: 3.2, listener: PLACES.basement, look: ahead5(PLACES.basement), shots: [], play: reload('ar', true, hands(PLACES.basement), true) });
  out.push({ name: 'reload-ar-empty-other-6m-street', seconds: 3.2, listener: st, look, shots: [], play: reload('ar', true, ahead(6).setY(st.y - 0.3), false) });
  out.push({ name: 'reload-ar-empty-other-20m-street', seconds: 3.2, listener: st, look, shots: [], play: reload('ar', true, ahead(20).setY(st.y - 0.3), false) });
  out.push({
    name: 'reload-ar-empty-other-in-house-heard-from-street', seconds: 3.2, listener: PLACES.frontWalk, look: PLACES.room, shots: [],
    play: reload('ar', true, PLACES.room.clone().setY(PLACES.room.y - 0.3), false),
  });
  out.push({
    name: 'ar-burst-street', seconds: 2.6, listener: st, look: st.clone().add(new THREE.Vector3(0, 0, -5)),
    shots: [0, 1, 2, 3, 4].map((k) => ({ weapon: 'ar', at: st, local: true, delay: k * 0.075 })),
  });
  return out;
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

async function render(clip: Clip, acoustics: Acoustics, synth: boolean): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.round(SR * clip.seconds), SR);
  const eng = new AudioEngine();
  eng.unlock(ctx);
  await eng.recordingsReady;
  if (synth) (eng as unknown as { recorded: Map<string, AudioBuffer[]> }).recorded.clear();
  // Only the guns: music and the night's ambience stay silent.
  const buses = eng as unknown as Record<'music' | 'ambient', GainNode> & { sends: Record<'music' | 'ambient', GainNode> };
  for (const bus of [buses.music, buses.ambient, buses.sends.music, buses.sends.ambient]) {
    bus.gain.cancelScheduledValues(0);
    bus.gain.value = 0;
  }
  eng.setAcoustics(acoustics);
  const cam = new THREE.PerspectiveCamera();
  cam.position.copy(clip.listener);
  cam.lookAt(clip.look);
  cam.updateMatrixWorld();
  eng.update(0.016, cam);
  // Shots after the first moment are fired when rendering reaches them (the context pauses there).
  const fire = (k: number) => eng.gunshot(clip.shots[k].weapon, clip.shots[k].at, clip.shots[k].local, clip.shots[k].bullets);
  clip.play?.(eng);
  clip.shots.forEach((s, k) => {
    if (!s.delay) fire(k);
    else void ctx.suspend(s.delay).then(() => { fire(k); void ctx.resume(); });
  });
  const out = await ctx.startRendering();
  eng.dispose();
  return out;
}

async function renderClips(opts: { synth?: boolean; only?: string } = {}): Promise<Record<string, string>> {
  await initPhysics();
  const physics = new Physics(map);
  physics.world.step();
  const acoustics = new Acoustics(physics);
  const list = document.getElementById('list')!;
  list.replaceChildren();
  const result: Record<string, string> = {};
  for (const clip of clips()) {
    if (opts.only && !clip.name.includes(opts.only)) continue;
    const buf = await render(clip, acoustics, !!opts.synth);
    result[clip.name] = wav(buf);
    const li = document.createElement('li');
    const player = document.createElement('audio');
    player.controls = true;
    player.src = `data:audio/wav;base64,${result[clip.name]}`;
    const save = document.createElement('a');
    save.href = player.src;
    save.download = `${clip.name}.wav`;
    save.textContent = 'save';
    li.append(`${clip.name} (${acoustics.spaceAt(clip.listener.x, clip.listener.y, clip.listener.z)}) `, player, ' ', save);
    list.append(li);
  }
  return result;
}

const button = document.getElementById('render') as HTMLButtonElement;
button.addEventListener('click', () => {
  button.disabled = true;
  void renderClips().finally(() => (button.disabled = false));
});
Object.assign(window, { renderClips });
