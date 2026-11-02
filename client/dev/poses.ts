/**
 * Dev-only pose gallery: /dev/poses.html shows a survivor holding one gun through every pose the
 * hands take (ready, hip aim, down the sights, sprint, a reload frozen at several points, a
 * machete swing, the draw), from a fixed camera beside them, plus the first-person sight picture.
 * `gun=akimbo` (default) or any gun id, `optic=holo`, `view=front|side|back`, `base={"body":"female"}`.
 * Not part of the game build.
 */
import * as THREE from 'three';
import { DEFAULT_APPEARANCE, WEAPONS, defaultBuild, sanitizeAppearance, type Appearance, type WeaponId } from '@dead-hours/shared';
import { Humanoid, survivorLook } from '../src/characters/Humanoid';
import { PlayerWeapon, type HeldState } from '../src/weapons/PlayerWeapon';
import { ThirdPersonCamera } from '../src/gameplay/ThirdPersonCamera';
import type { WeaponModel } from '../src/weapons/WeaponModels';
import type { Physics } from '../src/core/Physics';

const q = new URLSearchParams(location.search);
const gun = (q.get('gun') ?? 'akimbo') as WeaponId;
const optic = q.get('optic');
const view = q.get('view') ?? 'front';
/** Closer in, on the hands. */
const close = q.get('close') === '1';
const base: Appearance = sanitizeAppearance({ ...DEFAULT_APPEARANCE, ...JSON.parse(q.get('base') ?? '{}') });
const def = WEAPONS[gun];
const pistol = def.slot === 'secondary';
const build = { ...defaultBuild(gun), ...(optic ? { optic } : {}) };
const total = def.reloadTime + 0.35;

type Cell = { label: string; s: Partial<HeldState>; aim?: number; sprint?: boolean; ads?: boolean; mag?: number };
const reloadAt = (p: number): Partial<HeldState> => ({ action: 'reload', actionTotal: total, actionT: total * (1 - p) });
const CELLS: Cell[] = [
  { label: 'ready', s: {} },
  { label: 'hip aim', s: {}, aim: 1 },
  { label: 'down the sights', s: {}, aim: 1, ads: true },
  { label: 'sprint', s: {}, sprint: true },
  { label: 'reload 0.10 (mags drop)', s: reloadAt(0.1), mag: 0 },
  { label: 'reload 0.40 (to the belt)', s: reloadAt(0.4), mag: 0 },
  { label: 'reload 0.50 (right seats)', s: reloadAt(0.5), mag: 0 },
  { label: 'reload 0.62 (left seats)', s: reloadAt(0.62), mag: 0 },
  { label: 'reload 0.82 (slides)', s: reloadAt(0.82), mag: 0 },
  { label: 'empty, slides locked', s: {}, aim: 1, mag: 0 },
  { label: 'machete swing', s: { action: 'melee', actionTotal: 0.55, actionT: 0.55 * 0.62 } },
  { label: 'draw 0.5', s: { action: 'draw', actionTotal: def.draw, actionT: def.draw * 0.5 } },
  { label: 'machete held out', s: { meleeOut: true } },
  { label: 'katana held out', s: { meleeOut: true, meleeId: 'katana' } },
];
const cols = Number(q.get('cols') ?? 4);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setScissorTest(true);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x5d6b7a);
scene.add(new THREE.HemisphereLight(0xc8d4e4, 0x3a3226, 1.5));
const sun = new THREE.DirectionalLight(0xfff0dc, 2.2);
sun.position.set(-3, 6, 4);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 400), new THREE.MeshStandardMaterial({ color: 0x4a4740, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const physics = { sphereCast: () => null, raycast: () => null } as unknown as Physics;
const SPACING = 40;
const rows = Math.ceil(CELLS.length / cols);
const aspect = 4 / 3;
const rowH = Math.min(innerHeight / rows, innerWidth / cols / aspect);
const cellW = rowH * aspect;

const views = CELLS.map((c, i) => {
  const at = new THREE.Vector3(i * SPACING, 0, 0);
  const h = new Humanoid(survivorLook(base));
  scene.add(h.root);
  const weapon = new PlayerWeapon(scene, h);
  const camera = new THREE.PerspectiveCamera(c.ads ? 62 : 38, aspect, 0.03, 400);
  const cam = new ThirdPersonCamera(new THREE.PerspectiveCamera(62, aspect, 0.08, 400), physics);
  cam.yaw = 0;
  cam.pitch = 0;
  const mag = c.mag ?? def.magazine;
  const s: HeldState = {
    primary: { id: pistol ? 'ar' : gun, mag: pistol ? 30 : mag }, secondary: { id: pistol ? gun : 'pistol', mag: pistol ? mag : 15 },
    active: pistol ? 'secondary' : 'primary', action: 'idle', actionT: 0, actionTotal: 0, builds: { [gun]: build }, ...c.s,
  };
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = `${def.model} · ${c.label}`;
  el.style.left = `${(i % cols) * cellW + 6}px`;
  el.style.top = `${Math.floor(i / cols) * rowH + 6}px`;
  document.body.append(el);
  return { c, at, h, weapon, camera, cam, s };
});

function step(v: (typeof views)[number], dt: number): void {
  const model = (v.weapon as unknown as { ensure(id: WeaponId): WeaponModel }).ensure(gun);
  v.h.root.position.copy(v.at);
  v.h.root.rotation.y = v.cam.yaw + Math.PI;
  v.h.lookPitch = v.cam.pitch;
  const aim = v.c.aim ?? 0;
  v.h.update(dt, { speed: v.c.sprint ? 6 : 0, crouch: 0, aim, grounded: true, strafe: 0 });
  v.cam.update(dt, v.at, 1.6, aim > 0, !!v.c.sprint, v.c.ads ? model.sight : null);
  v.weapon.update(dt, v.s, { aim, sprinting: !!v.c.sprint, aimPoint: v.cam.aimPoint, ads: v.c.ads ? v.cam.ads : 0, eye: v.cam.eye, view: v.cam.view });
  if (v.c.ads) {
    v.camera.position.copy(v.cam.eye);
    v.camera.quaternion.copy(v.cam.view);
    v.camera.fov = model.sight?.fov ?? 50;
    v.camera.updateProjectionMatrix();
  } else {
    // A fixed camera on the survivor (who faces -Z): from the front-right, the side or behind.
    const chest = new THREE.Vector3(v.at.x, close ? 1.15 : 1.25, v.at.z - (close ? 0.25 : 0));
    const off = view === 'side' ? new THREE.Vector3(2.4, 0.1, -0.3) : view === 'back' ? new THREE.Vector3(0.9, 0.35, 2.2) : new THREE.Vector3(1.5, 0.15, -1.9);
    v.camera.position.copy(chest).addScaledVector(off, close ? 0.42 : 1);
    v.camera.lookAt(chest);
  }
}
for (let i = 0; i < 90; i++) for (const v of views) step(v, 1 / 60);

function frame(): void {
  views.forEach((v, i) => {
    step(v, 1 / 60);
    const x = (i % cols) * cellW, y = innerHeight - (Math.floor(i / cols) + 1) * rowH;
    renderer.setViewport(x, y, cellW, rowH);
    renderer.setScissor(x, y, cellW, rowH);
    renderer.render(scene, v.camera);
  });
  requestAnimationFrame(frame);
}
frame();
Object.assign(window, { __posesReady: true });
