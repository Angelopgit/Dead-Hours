/**
 * Dev-only listening tests for skateboards: renders riding through the game's own AudioEngine
 * into an OfflineAudioContext (as gunclips.ts does for guns), with a running survivor's footsteps
 * as the level to compare with. window.renderSkateClips() returns { name: base64 WAV }.
 */
import * as THREE from 'three';
import { SKATEBOARD } from '@dead-hours/shared';
import { AudioEngine } from '../src/audio/AudioEngine';

const SR = 48000;
const FPS = 30;

interface Clip {
  name: string;
  seconds: number;
  /** Called every frame (1/30 s) with the time: where the camera is and what the boards do. */
  frame: (eng: AudioEngine, t: number, cam: THREE.PerspectiveCamera) => void;
}

/** The rider's own view: the camera 3.2 m behind and 1.4 m above the board, heading along +x. */
function chase(cam: THREE.PerspectiveCamera, at: THREE.Vector3): void {
  cam.position.set(at.x - 3.2, at.y + 1.6, at.z + 0.4);
  cam.lookAt(at.x + 4, at.y + 1.2, at.z);
  cam.updateMatrixWorld();
}

/** Pushing off from a standstill to `top` m/s, the speed a real push gives (as PlayerController). */
function pushing(top: number) {
  let v = 0, push = 0, x = 0, last = 0;
  return (t: number) => {
    const dt = t - last;
    last = t;
    const before = push;
    push += dt / SKATEBOARD.pushPeriod;
    const kick = before < SKATEBOARD.pushFrom && push >= SKATEBOARD.pushFrom;
    if (push >= SKATEBOARD.pushFrom && push < SKATEBOARD.pushTo) v += SKATEBOARD.pushAccel * Math.max(0, Math.min(1, ((top - v) / top) * SKATEBOARD.pushEase)) * dt;
    if (push >= 1) push = 0;
    v -= (SKATEBOARD.rolling + SKATEBOARD.drag * v * v) * dt;
    x += v * dt;
    return { v, x, kick };
  };
}

function clips(): Clip[] {
  const out: Clip[] = [];
  for (const [ground, rough] of [['asphalt', 1], ['sidewalk', 0.45]] as const) {
    const ride = pushing(SKATEBOARD.sprintTop);
    let seam = 1.5, lastX = 0;
    out.push({
      name: `own-push-${ground}`, seconds: 5,
      frame: (eng, t, cam) => {
        const s = ride(t);
        const at = new THREE.Vector3(s.x, 0, 0);
        chase(cam, at);
        if (s.kick) eng.skateKick(at.clone().add(new THREE.Vector3(-0.2, 0, 0.17)));
        if (rough < 0.7) {
          seam -= s.x - lastX;
          if (seam <= 0) {
            seam = 1.5;
            eng.skateSeam(at, Math.min(1, s.v / 7));
          }
        }
        lastX = s.x;
        eng.skateRoll(s.v > 0.3 ? [{ id: 0, pos: at, speed: s.v, rough }] : []);
      },
    });
  }
  // Hop on, roll at 8 m/s, ollie, land, step off.
  out.push({
    name: 'own-mount-ollie-land-off', seconds: 4,
    frame: (eng, t, cam) => {
      const x = t < 0.4 ? 0 : (t - 0.4) * 8;
      const at = new THREE.Vector3(x, 0, 0);
      chase(cam, at);
      const k = Math.round(t * FPS);
      if (k === 1) eng.skateMount(at);
      if (k === Math.round(1.6 * FPS)) eng.skatePop(at);
      if (k === Math.round(2.1 * FPS)) eng.skateLand(at, 0.8);
      if (k === Math.round(3.4 * FPS)) eng.skateOff(at);
      const air = t >= 1.6 && t < 2.1;
      eng.skateRoll(t > 0.4 && t < 3.4 && !air ? [{ id: 0, pos: at, speed: 8, rough: 1 }] : []);
    },
  });
  // Rolling at 7 m/s: a kickflip (pop, flick, catch, land), then a pop shove-it (the scoop).
  out.push({
    name: 'own-kickflip-then-shove-it', seconds: 4,
    frame: (eng, t, cam) => {
      const at = new THREE.Vector3(t * 7, 0, 0);
      chase(cam, at);
      const k = Math.round(t * FPS);
      const trick = (from: number, flip: boolean, time: number) => {
        if (k === Math.round(from * FPS)) eng.skatePop(at);
        if (k === Math.round((from + 0.05) * FPS)) eng.skateFlick(at, flip);
        if (k === Math.round((from + 0.05 + time) * FPS)) eng.skateCatch(at);
        if (k === Math.round((from + 0.51) * FPS)) eng.skateLand(at, 0.85);
        return t >= from && t < from + 0.51;
      };
      const air = trick(0.8, true, 0.36) || trick(2.5, false, 0.32);
      eng.skateRoll(air ? [] : [{ id: 0, pos: at, speed: 7, rough: 1 }]);
    },
  });
  // Someone else rolls past at 9 m/s, 4 m out, while this survivor stands on the sidewalk.
  out.push({
    name: 'other-rider-passes-4m', seconds: 4,
    frame: (eng, t, cam) => {
      cam.position.set(0, 1.75, -4);
      cam.lookAt(0, 1.5, 4);
      cam.updateMatrixWorld();
      const at = new THREE.Vector3(-18 + t * 9, 0, 0);
      if (Math.round(t * FPS) % 15 === 0) eng.skateKick(at);
      eng.skateRoll([{ id: 3, pos: at, speed: 9, rough: 1 }]);
    },
  });
  out.push({
    name: 'other-rider-bails-6m', seconds: 2,
    frame: (eng, t, cam) => {
      cam.position.set(0, 1.75, -6);
      cam.lookAt(0, 1.5, 0);
      cam.updateMatrixWorld();
      if (Math.round(t * FPS) === 3) eng.skateBail(new THREE.Vector3(0, 0, 0));
      eng.skateRoll([]);
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
  // Only the boards: music and the night's ambience stay silent.
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

async function renderSkateClips(): Promise<Record<string, string>> {
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
  void renderSkateClips().finally(() => (button.disabled = false));
});
Object.assign(window, { renderSkateClips });
