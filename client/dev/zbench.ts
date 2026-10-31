/**
 * Dev-only crowd bench: /dev/zbench.html?n=200&detail=lite renders `n` shot-up zombies of
 * every kind walking toward the camera and reports GPU+CPU frame time (window.__bench).
 * Not part of the game build.
 */
import * as THREE from 'three';
import type { HitZone, ZombieKind } from '@dead-hours/shared';
import { Humanoid, zombieLookOf } from '../src/characters/Humanoid';
import * as Decay from '../src/characters/Decay';

const q = new URLSearchParams(location.search);
const n = Number(q.get('n') ?? 200);
const frames = Number(q.get('frames') ?? 40);
if (q.get('detail') === 'lite') (Decay as { setZombieDetail?: (d: 'lite' | 'full') => void }).setZombieDetail?.('lite');

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
scene.add(new THREE.HemisphereLight(0xbcc8d8, 0x30281f, 1.1));
const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
key.position.set(3, 6, 8);
scene.add(key);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 1.7, 4);
camera.lookAt(0, 1.2, -10);

const kinds: ZombieKind[] = ['walker', 'walker', 'runner', 'brute', 'screamer', 'bloater'];
const zones: HitZone[] = ['torso', 'head', 'armL', 'legR', 'torso', 'armR'];
const crowd: Humanoid[] = [];
const p = new THREE.Vector3();
for (let i = 0; i < n; i++) {
  const kind = kinds[i % kinds.length];
  const h = new Humanoid(zombieLookOf(kind, i));
  const row = Math.floor(i / 14), col = i % 14;
  h.root.position.set((col - 6.5) * 1.1 + (row % 2) * 0.5, 0, -row * 1.6);
  h.root.updateMatrixWorld(true);
  const hh = h as Humanoid & { woundAt?: (p: THREE.Vector3, z: HitZone, s: number) => void; oldWounds?: (s: number, c: number) => void };
  hh.oldWounds?.(i * 31, 2);
  for (let k = 0; k < 4; k++) {
    const zone = zones[(i + k) % zones.length];
    h.wound(zone, 0.25);
    h.spine.getWorldPosition(p);
    p.z += 0.3;
    p.y += (k - 1.5) * 0.15;
    hh.woundAt?.(p, zone, 0.6);
  }
  scene.add(h.root);
  crowd.push(h);
}

const gl = renderer.getContext();
const px = new Uint8Array(4);
const state = { speed: 1.2, crouch: 0, aim: 0, grounded: true, strafe: 0 };
let f = 0, cpu = 0, total = 0;
function frame(): void {
  const t0 = performance.now();
  for (const h of crowd) h.update(1 / 30, state);
  const t1 = performance.now();
  renderer.render(scene, camera);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t2 = performance.now();
  // The first frames compile shaders.
  if (f >= 5) {
    cpu += t1 - t0;
    total += t2 - t0;
  }
  if (++f < frames + 5) requestAnimationFrame(frame);
  else Object.assign(window, { __bench: { n, frames, cpuMs: cpu / frames, frameMs: total / frames, calls: renderer.info.render.calls } });
}
frame();
