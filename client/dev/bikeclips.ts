/**
 * Dev-only listening tests for bicycles: renders riding through the game's own AudioEngine into
 * an OfflineAudioContext (as skateclips.ts does for boards), with a running survivor's footsteps
 * as the level to compare with. window.renderBikeClips() returns { name: base64 WAV }.
 */
import * as THREE from 'three';
import { BICYCLE } from '@dead-hours/shared';
import { AudioEngine } from '../src/audio/AudioEngine';

const SR = 48000;
const FPS = 30;

interface Clip {
  name: string;
  seconds: number;
  /** Called every frame (1/30 s) with the time: where the camera is and what the bikes do. */
  frame: (eng: AudioEngine, t: number, cam: THREE.PerspectiveCamera) => void;
}

/** The rider's own view: the camera behind and above the bike, heading along +x. */
function chase(cam: THREE.PerspectiveCamera, at: THREE.Vector3): void {
  cam.position.set(at.x - 3.4, at.y + 1.8, at.z + 0.4);
  cam.lookAt(at.x + 4, at.y + 1.2, at.z);
  cam.updateMatrixWorld();
}

/** Pedalling off from a standstill toward `top` m/s, as PlayerController's cycleStep does. */
function pedalling(top: number, from = 0) {
  let v = from, x = 0, last = 0;
  return (t: number) => {
    const dt = t - last;
    last = t;
    const ease = Math.max(0, Math.min(1, ((top - v) / top) * BICYCLE.pedalEase));
    v += BICYCLE.pedalAccel * ease * dt;
    v -= (BICYCLE.rolling + BICYCLE.drag * v * v) * dt;
    x += v * dt;
    return { v, x };
  };
}

function seams(eng: AudioEngine, at: THREE.Vector3, v: number, moved: number, state: { seam: number }): void {
  state.seam -= moved;
  if (state.seam > 0) return;
  state.seam = 1.5;
  eng.wheels.bikeSeam(at, Math.min(1, v / 8), (BICYCLE.frontAxle - BICYCLE.rearAxle) / Math.max(1, v));
}

function clips(): Clip[] {
  const out: Clip[] = [];
  for (const [ground, rough] of [['asphalt', 1], ['sidewalk', 0.45], ['grass', 1.4]] as const) {
    const ride = pedalling(BICYCLE.pedalTop);
    const st = { seam: 1.5 };
    let lastX = 0;
    out.push({
      name: `own-pedal-${ground}`, seconds: 5,
      frame: (eng, t, cam) => {
        const s = ride(t);
        const at = new THREE.Vector3(s.x, 0, 0);
        chase(cam, at);
        if (rough < 0.7) seams(eng, at, s.v, s.x - lastX, st);
        lastX = s.x;
        eng.wheels.bikeRoll(s.v > 0.3 ? [{ id: 0, pos: at, speed: s.v, rough, coast: false, skid: 0 }] : []);
      },
    });
  }
  // Coasting at 9 m/s (the freewheel ticks), then a hard stop that skids the back tyre.
  out.push({
    name: 'own-coast-then-skid', seconds: 4,
    frame: (eng, t, cam) => {
      const brake = t > 2.2;
      const v = brake ? Math.max(0, 9 - (t - 2.2) * BICYCLE.brake) : 9 - t * 0.2;
      const x = t < 2.2 ? t * 9 : 2.2 * 9 + (9 * (t - 2.2) - 0.5 * BICYCLE.brake * (t - 2.2) ** 2);
      const at = new THREE.Vector3(x, 0, 0);
      chase(cam, at);
      const skid = brake && v > BICYCLE.skidSpeed ? 1 : 0;
      eng.wheels.bikeRoll(v > 0.3 ? [{ id: 0, pos: at, speed: v, rough: 1, coast: true, skid }] : []);
    },
  });
  // Pick it up, ride off, ring twice, hop and land, get off and let it fall.
  out.push({
    name: 'own-mount-bell-hop-off', seconds: 5,
    frame: (eng, t, cam) => {
      const x = t < 0.5 ? 0 : (t - 0.5) * 7;
      const at = new THREE.Vector3(Math.min(x, 7 * 3.7), 0, 0);
      chase(cam, at);
      const k = Math.round(t * FPS);
      if (k === 1) eng.wheels.bikeMount(at);
      if (k === Math.round(1.2 * FPS) || k === Math.round(1.8 * FPS)) eng.wheels.bikeBell(at.clone().add(new THREE.Vector3(0.5, 1.1, 0)), true);
      if (k === Math.round(2.9 * FPS)) eng.wheels.bikeLand(at, 0.7);
      if (k === Math.round(4.3 * FPS)) eng.wheels.bikeDrop(at);
      const air = t >= 2.5 && t < 2.9;
      eng.wheels.bikeRoll(t > 0.5 && t < 4.2 && !air ? [{ id: 0, pos: at, speed: 7, rough: 1, coast: t > 3.2, skid: 0 }] : []);
    },
  });
  // Someone else rides past at 10 m/s, 4 m out, ringing, while this survivor stands on the sidewalk.
  out.push({
    name: 'other-rider-passes-4m-bell', seconds: 4,
    frame: (eng, t, cam) => {
      cam.position.set(0, 1.75, -4);
      cam.lookAt(0, 1.5, 4);
      cam.updateMatrixWorld();
      const at = new THREE.Vector3(-20 + t * 10, 0, 0);
      if (Math.round(t * FPS) === Math.round(1.5 * FPS)) eng.wheels.bikeBell(at.clone().setY(1.1));
      if (Math.round(t * FPS) === Math.round(0.6 * FPS)) eng.wheels.bikePeg(at);
      eng.wheels.bikeRoll([{ id: 3, pos: at, speed: 10, rough: 1, coast: t > 2.5, skid: 0 }]);
    },
  });
  out.push({
    name: 'other-rider-crashes-6m', seconds: 2.5,
    frame: (eng, t, cam) => {
      cam.position.set(0, 1.75, -6);
      cam.lookAt(0, 1.5, 0);
      cam.updateMatrixWorld();
      if (Math.round(t * FPS) === 3) eng.wheels.bikeCrash(new THREE.Vector3(0, 0, 0));
      eng.wheels.bikeRoll([]);
    },
  });
  // The yardstick: a survivor's own running footsteps (2.6 a second).
  out.push({
    name: 'reference-own-running-steps', seconds: 3,
    frame: (eng, t, cam) => {
      chase(cam, new THREE.Vector3(t * 6, 0, 0));
      if (Math.round(t * FPS) % 11 === 0) eng.footstep(1, false);
    },
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

async function render(clip: Clip): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.round(SR * clip.seconds), SR);
  const eng = new AudioEngine();
  eng.unlock(ctx);
  await eng.recordingsReady;
  // Only the bikes: music and the night's ambience stay silent.
  const buses = eng as unknown as Record<'music' | 'ambient', GainNode> & { sends: Record<'music' | 'ambient', GainNode> };
  for (const bus of [buses.music, buses.ambient, buses.sends.music, buses.sends.ambient]) {
    bus.gain.cancelScheduledValues(0);
    bus.gain.value = 0;
  }
  const cam = new THREE.PerspectiveCamera();
  const step = (t: number) => {
    clip.frame(eng, t, cam);
    eng.update(1 / FPS, cam);
  };
  step(0);
  const frames = Math.floor(clip.seconds * FPS) - 1;
  for (let k = 1; k <= frames; k++) {
    void ctx.suspend(k / FPS).then(() => {
      step(k / FPS);
      void ctx.resume();
    });
  }
  const out = await ctx.startRendering();
  eng.dispose();
  return out;
}

async function renderBikeClips(): Promise<Record<string, string>> {
  const list = document.getElementById('list')!;
  list.replaceChildren();
  const result: Record<string, string> = {};
  for (const clip of clips()) {
    const buf = await render(clip);
    result[clip.name] = wav(buf);
    const li = document.createElement('li');
    const player = document.createElement('audio');
    player.controls = true;
    player.src = `data:audio/wav;base64,${result[clip.name]}`;
    li.append(`${clip.name} `, player);
    list.append(li);
  }
  return result;
}

const button = document.getElementById('render') as HTMLButtonElement;
button.addEventListener('click', () => {
  button.disabled = true;
  void renderBikeClips().finally(() => (button.disabled = false));
});
Object.assign(window, { renderBikeClips });
