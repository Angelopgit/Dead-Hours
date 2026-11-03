/**
 * Dev-only: a supply drop frozen at moments of its fall and landing, for checking the parachute
 * (`/dev/parachute.html?cols=4`, `&play=1` runs each cell on from its moment, `&night=1` for a
 * dark street look). Uses the real SupplyDrops system on flat ground. Not part of the game build.
 */
import * as THREE from 'three';
import { SUPPLY_DROPS, type HeliFlight } from '@dead-hours/shared';
import { SupplyDrops } from '../src/gameplay/SupplyDrops';

const q = new URLSearchParams(location.search);
const cols = Number(q.get('cols') ?? 4);
const play = q.get('play') === '1';
const night = q.get('night') === '1';
const only = q.get('only');

const ground = { x: 0, y: 0, z: 0 };
const release = 12.6;
const land = release + SUPPLY_DROPS.releaseHeight / SUPPLY_DROPS.fallSpeed;
const flight: HeliFlight = {
  from: { x: 0, y: 34, z: -240 }, over: { x: 0, y: 34, z: 0 }, to: { x: 240, y: 34, z: 60 },
  start: 0, arrive: 10, release, leave: 13.8, end: 40, ground, land, releaseHeight: SUPPLY_DROPS.releaseHeight,
};
const heightAt = (t: number) => (t >= land ? 0 : Math.max(0, SUPPLY_DROPS.releaseHeight - SUPPLY_DROPS.fallSpeed * (t - release)));

interface Cell { label: string; t: number; cam: [number, number, number]; look?: [number, number, number]; fov?: number }
const air = (dt: number, label: string, cam: [number, number, number] = [15, 0, 9], fov = 45): Cell => {
  const t = release + dt;
  const y = heightAt(t);
  return { label, t, cam: [cam[0], y + 3 + cam[1], cam[2]], look: [0, y + 4.6, 0], fov };
};
const down = (s: number, label: string, cam: [number, number, number] = [-6, 4.2, -8], look: [number, number, number] = [0, 0.6, 2], fov = 42): Cell => ({ label, t: land + s, cam, look, fov });
const CELLS: Cell[] = [
  air(0.5, 'streamer · 0.5 s after release'),
  air(1.4, 'blossoming · 1.4 s'),
  air(2.2, 'nearly open · 2.2 s'),
  air(4.5, 'open, falling · 4.5 s', [12, 0.5, 9]),
  { label: 'from the street, looking up', t: release + 4.5, cam: [9, 1.7, 6], look: [0, heightAt(release + 4.5) + 8, 0], fov: 55 },
  down(0.35, 'landed · 0.35 s', [-12, 5, -14], [0, 3, 2], 45),
  down(0.8, 'collapsing · 0.8 s', [-12, 5, -14], [0, 2.5, 2], 45),
  down(1.3, 'tipping over · 1.3 s', [-12, 5, -14], [0, 1.6, 2], 45),
  down(1.8, 'settling · 1.8 s', [-10, 4.5, -7], [0, 0.8, 2]),
  down(2.3, 'settling · 2.3 s', [-10, 4.5, -7], [0, 0.6, 2]),
  down(6, 'on the ground', [-6, 4.2, -5]),
  down(6, 'on the ground · from the side', [6.5, 2.4, 3], [0, 0.3, 3]),
  down(6, 'on the ground · top', [0.01, 10, 3], [0, 0, 3], 45),
  down(6, 'on the ground · eye height', [2.5, 1.65, -3.5], [0, 0.3, 2.8], 55),
  down(6, 'on the ground · from the crown end', [1.5, 2.2, 10], [0, 0.3, 1.5], 50),
  down(6, 'on the ground · low', [-4, 0.6, 5], [0, 0.2, 3.2], 55),
].filter((c, i) => !only || only.split(',').includes(String(i)));
// `?seq=land` / `?seq=air`: one camera, the landing or the opening every quarter second.
const seq = q.get('seq');
if (seq === 'land') {
  CELLS.length = 0;
  for (let s = 0; s <= 3.01; s += 0.25) CELLS.push(down(s, `landing + ${s.toFixed(2)} s`, [-9, 4.5, -4], [0, 1.6, 2.5], 50));
} else if (seq === 'air') {
  CELLS.length = 0;
  for (let s = 0.25; s <= 3.3; s += 0.25) CELLS.push(air(s, `release + ${s.toFixed(2)} s`, [15, 0, 9], 45));
}

const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setScissorTest(true);
document.body.append(renderer.domElement);
const rows = Math.ceil(CELLS.length / cols);
const cw = W / cols, ch = H / rows;

const stages = CELLS.map((c, i) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(night ? 0x0b0e14 : 0x7d8a99);
  scene.add(new THREE.HemisphereLight(night ? 0x3a4660 : 0xc8d4e4, 0x2a241c, night ? 0.5 : 1.4));
  const key = new THREE.DirectionalLight(night ? 0x9fb3d9 : 0xfff0dc, night ? 0.8 : 2.4);
  key.position.set(14, 30, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -12;
  sc.right = sc.top = 12;
  sc.far = 80;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  scene.add(key);
  if (night) {
    const lamp = new THREE.PointLight(0xffc27a, 60, 25, 1.6);
    lamp.position.set(-5, 6, 4);
    scene.add(lamp);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x3d3f42, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(20, 20, 0x666666, 0x4a4a4a);
  grid.position.y = 0.003;
  scene.add(grid);
  const drops = new SupplyDrops(scene);
  drops.flight(1, flight);
  const camera = new THREE.PerspectiveCamera(c.fov ?? 40, cw / ch, 0.1, 200);
  camera.position.set(...c.cam);
  camera.lookAt(...(c.look ?? [0, 0, 0]));
  // Run up to the moment so the drop's own state (landing, hang point) is what the game has.
  for (let t = 0; t < c.t; t += 1 / 30) drops.update(1 / 30, t, camera.position);
  drops.update(1 / 30, c.t, camera.position);
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = c.label;
  el.style.left = `${(i % cols + 0.5) * cw}px`;
  el.style.top = `${(Math.floor(i / cols) + 1) * ch - 16}px`;
  document.body.append(el);
  return { c, scene, drops, camera, t: c.t };
});

let last = performance.now();
let frames = 0;
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stages.forEach((s, i) => {
    if (play) {
      s.t += dt;
      s.drops.update(dt, s.t, s.camera.position);
    }
    const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
    renderer.setViewport(x, y, cw, ch);
    renderer.setScissor(x, y, cw, ch);
    renderer.render(s.scene, s.camera);
  });
  frames++;
  requestAnimationFrame(frame);
}
frame();
Object.assign(window, { __chuteReady: () => frames > 2, __stages: stages });
