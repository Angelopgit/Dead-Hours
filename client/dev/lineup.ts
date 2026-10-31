/**
 * Dev-only outfit lineup: /dev/lineup.html?slot=headwear&view=head renders every item of a slot
 * side by side under studio lights, for checking how pieces fit (`view=head|torso|legs|body`;
 * `base={"body":"female"}` dresses a woman, `items=a,b` picks a few). `slot=zombies` shows walkers,
 * `slot=specials` screamers and bloaters (`scream=0.5` poses them mid-scream), `slot=crawlers` legless
 * zombies crawling (`speed=1` drags them along, `attack=0.55` mid-lunge). Not part of the game build.
 */
import * as THREE from 'three';
import { APPEARANCE_ITEMS, DEFAULT_APPEARANCE, sanitizeAppearance, type Appearance, type AppearanceSlot } from '@dead-hours/shared';
import { Humanoid, survivorLook, zombieLook, zombieLookOf } from '../src/characters/Humanoid';

const q = new URLSearchParams(location.search);
const slot = (q.get('slot') ?? 'top') as AppearanceSlot | 'zombies' | 'specials' | 'kinds' | 'crawlers';
/** `kinds`: how many hits each zombie has taken (0 fresh, more shows wounds and soaked clothes). */
const hits = Number(q.get('hits') ?? 0);
const speed = Number(q.get('speed') ?? 0);
const attack = Number(q.get('attack') ?? -1);
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
  : slot === 'kinds'
  ? (['walker', 'runner', 'brute', 'crawler', 'screamer', 'bloater'] as const).flatMap((kind) => [0, 1].map((i) => ({ label: `${kind} ${i}`, look: zombieLookOf(kind === 'crawler' ? 'walker' : kind, kind === 'crawler' ? i + 5 : i) })))
  : slot === 'crawlers'
  ? Array.from({ length: 8 }, (_, i) => ({ label: `crawler ${i}`, look: zombieLookOf(i === 6 ? 'brute' : i === 7 ? 'runner' : 'walker', i) }))
  : slot === 'specials'
  ? (['screamer', 'bloater'] as const).flatMap((kind) => Array.from({ length: 4 }, (_, i) => ({ label: `${kind} ${i}`, look: zombieLookOf(kind, i) })))
  : (APPEARANCE_ITEMS[slot] as readonly { id: string; label: string }[])
    .filter((it) => !q.get('items') || q.get('items')!.split(',').includes(it.id))
    .map((it) => ({ label: it.label, look: survivorLook({ ...base, [slot]: it.id } as Appearance) }));
const rows = Math.ceil(looks.length / cols);
const people: Humanoid[] = [];
const cellW = innerWidth / cols, cellH = innerHeight / rows;
looks.forEach(({ label, look }, i) => {
  const h = new Humanoid(look);
  h.root.rotation.y = yaw;
  if (slot === 'crawlers') {
    const cuts = [['hip', 'intact'], ['knee', 'knee'], ['hip', 'hip'], ['intact', 'knee'], ['knee', 'hip'], ['hip', 'intact'], ['knee', 'intact'], ['hip', 'knee']] as const;
    h.setLeg('legL', cuts[i][0]);
    h.setLeg('legR', cuts[i][1]);
    if (i === 5) h.setArm('armR', 'shoulder');
    h.crawlTarget = 1;
  }
  h.update(0.016, { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 });
  h.setVisible(false);
  if (q.get('gore') === '0') h.goreShown = false;
  if (slot === 'kinds') {
    h.oldWounds(i * 977 + 5, q.has('old') ? Number(q.get('old')) : 0);
    shoot(h, i);
  }
  scene.add(h.root);
  people.push(h);
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = label;
  el.style.left = `${(i % cols + 0.5) * cellW}px`;
  el.style.top = `${(Math.floor(i / cols) + 1) * cellH - 16}px`;
  document.body.append(el);
});

/** Lineup damage: `hits` shots spread over the body, the same way the game applies them. */
function shoot(h: Humanoid, seed: number): void {
  const zones = ['torso', 'torso', 'armL', 'legR', 'head', 'torso', 'armR', 'legL'] as const;
  h.root.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  for (let k = 0; k < hits; k++) {
    const zone = zones[(k + seed) % zones.length];
    h.wound(zone, 0.1 + 0.25 * 0.6);
    // Where a shot from the camera's side would land on that zone, a little off centre.
    const bone = { head: h.head, torso: h.spine, armL: h.armL.upper, armR: h.armR.lower, legL: h.legL.upper, legR: h.legR.lower }[zone];
    bone.getWorldPosition(p);
    p.y += zone === 'torso' ? 0.12 + ((k * 37) % 5) * 0.06 : zone === 'head' ? 0.1 : -0.12;
    p.x += (((k * 53 + seed * 11) % 7) - 3) * 0.025;
    p.z += 0.3;
    h.woundAt(p, zone, 0.4 + ((k * 13) % 5) * 0.12);
  }
  // Let the blood soak out as it would over the seconds after.
  for (let t = 0; t < 40; t++) h.update(0.25, { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 });
}

// One camera framing a single character; each grid cell renders one of them.
const camera = new THREE.PerspectiveCamera(view === 'head' ? 24 : view === 'body' ? 30 : 28, cellW / cellH, 0.05, 50);
if (view === 'head') {
  camera.position.set(0, 1.78, 1.55);
  camera.lookAt(0, 1.7, 0);
} else if (view === 'torso') {
  camera.position.set(0, 1.42, 2.3);
  camera.lookAt(0, 1.2, 0);
} else if (view === 'legs') {
  camera.position.set(0, 0.8, 2.6);
  camera.lookAt(0, 0.5, 0);
} else if (slot === 'crawlers') {
  camera.position.set(0, 1.3, 3.6);
  camera.lookAt(0, 0.25, -0.2);
} else {
  camera.position.set(0, 1.15, 4.4);
  camera.lookAt(0, 0.92, 0);
}
renderer.setScissorTest(true);
if (slot === 'crawlers') {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0x3b3a36, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
}

function frame(): void {
  people.forEach((h, i) => {
    if (h.gait === 'runner' && slot !== 'crawlers') h.scream = scream;
    if (slot === 'crawlers') h.attack = attack;
    h.update(0.016, { speed, crouch: 0, aim: 0, grounded: true, strafe: 0 });
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
Object.assign(window, { __lineupReady: true, __people: people });
