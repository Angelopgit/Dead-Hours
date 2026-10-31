/**
 * Dev-only outfit lineup: /dev/lineup.html?slot=headwear&view=head renders every item of a slot
 * side by side under studio lights, for checking how pieces fit. `slot=zombies` shows walkers,
 * `slot=specials` screamers and bloaters (`scream=0.5` poses them mid-scream). Not part of the game build.
 */
import * as THREE from 'three';
import { APPEARANCE_ITEMS, DEFAULT_APPEARANCE, sanitizeAppearance, type Appearance, type AppearanceSlot } from '@dead-hours/shared';
import { Humanoid, survivorLook, zombieLook, zombieLookOf } from '../src/characters/Humanoid';

const q = new URLSearchParams(location.search);
const slot = (q.get('slot') ?? 'top') as AppearanceSlot | 'zombies' | 'specials';
const scream = Number(q.get('scream') ?? -1);
const view = q.get('view') ?? 'body';
const yaw = Number(q.get('yaw') ?? 0.35);
const base: Appearance = sanitizeAppearance({ ...DEFAULT_APPEARANCE, ...JSON.parse(q.get('base') ?? '{}') });
const cols = Number(q.get('cols') ?? 8);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2f36);
scene.add(new THREE.HemisphereLight(0xbcc8d8, 0x30281f, 1.2));
const key = new THREE.DirectionalLight(0xfff0dc, 2.4);
key.position.set(3, 5, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fb8ff, 1.2);
rim.position.set(-4, 3, -5);
scene.add(rim);

const looks = slot === 'zombies'
  ? Array.from({ length: 12 }, (_, i) => ({ label: `zombie ${i}`, look: zombieLook(i) }))
  : slot === 'specials'
  ? (['screamer', 'bloater'] as const).flatMap((kind) => Array.from({ length: 4 }, (_, i) => ({ label: `${kind} ${i}`, look: zombieLookOf(kind, i) })))
  : (APPEARANCE_ITEMS[slot] as readonly { id: string; label: string }[]).map((it) => ({ label: it.label, look: survivorLook({ ...base, [slot]: it.id } as Appearance) }));
const rows = Math.ceil(looks.length / cols);
const people: Humanoid[] = [];
const cellW = innerWidth / cols, cellH = innerHeight / rows;
looks.forEach(({ label, look }, i) => {
  const h = new Humanoid(look);
  h.root.rotation.y = yaw;
  h.update(0.016, { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 });
  h.setVisible(false);
  scene.add(h.root);
  people.push(h);
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = label;
  el.style.left = `${(i % cols + 0.5) * cellW}px`;
  el.style.top = `${(Math.floor(i / cols) + 1) * cellH - 16}px`;
  document.body.append(el);
});

// One camera framing a single character; each grid cell renders one of them.
const camera = new THREE.PerspectiveCamera(view === 'head' ? 24 : 30, cellW / cellH, 0.05, 50);
if (view === 'head') {
  camera.position.set(0, 1.78, 1.55);
  camera.lookAt(0, 1.7, 0);
} else {
  camera.position.set(0, 1.15, 4.4);
  camera.lookAt(0, 0.92, 0);
}
renderer.setScissorTest(true);

function frame(): void {
  people.forEach((h, i) => {
    if (h.gait === 'runner') h.scream = scream;
    h.update(0.016, { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 });
    const x = (i % cols) * cellW, y = innerHeight - (Math.floor(i / cols) + 1) * cellH;
    renderer.setViewport(x, y, cellW, cellH);
    renderer.setScissor(x, y, cellW, cellH);
    h.setVisible(true);
    renderer.render(scene, camera);
    h.setVisible(false);
  });
  requestAnimationFrame(frame);
}
frame();
Object.assign(window, { __lineupReady: true });
