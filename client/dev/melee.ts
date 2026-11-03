/**
 * Dev-only melee gallery: /dev/melee.html shows a survivor with every melee weapon, one row each,
 * through the hold and the swing (held out ready, wound up, the blow landing, the follow-through),
 * from a fixed camera: `view=front|side|back|player` (player: the over-the-shoulder game camera),
 * `close=1` on the hands, `weapons=machete,katana`, `cols=` phases per row (`phases=ready,up,hit,through,end`),
 * `base={"body":"female"}`. Not part of the game build.
 */
import * as THREE from 'three';
import { DEFAULT_APPEARANCE, MELEE, sanitizeAppearance, type Appearance, type MeleeId, type WeaponId } from '@dead-hours/shared';
import { Humanoid, survivorLook } from '../src/characters/Humanoid';
import { PlayerWeapon, MELEE_PHASES, type HeldState } from '../src/weapons/PlayerWeapon';
import { ThirdPersonCamera } from '../src/gameplay/ThirdPersonCamera';
import type { Physics } from '../src/core/Physics';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'front';
const close = q.get('close') === '1';
/** How far the close-up camera is, as a share of the normal distance. */
const near = Number(q.get('near') ?? 0.3);
const base: Appearance = sanitizeAppearance({ ...DEFAULT_APPEARANCE, ...JSON.parse(q.get('base') ?? '{}') });
const WEAPON_ROWS: (MeleeId | 'quick')[] = (q.get('weapons')?.split(',') as (MeleeId | 'quick')[] | undefined)
  ?? ['machete', 'katana', 'katanas', 'bat', 'hockey', 'crowbar', 'wrench', 'quick'];
const PHASES = (q.get('phases')?.split(',') ?? ['ready', 'up', 'hit', 'through', 'end']) as (keyof ReturnType<typeof MELEE_PHASES>)[];

type Cell = { label: string; s: Partial<HeldState>; melee: MeleeId };
const CELLS: Cell[] = [];
for (const row of WEAPON_ROWS) {
  // 'quick': the machete swung from a rifle in the hands (the rifle held up out of the way).
  const id: MeleeId = row === 'quick' ? 'machete' : row;
  const d = MELEE[id];
  const at = MELEE_PHASES(id);
  for (const ph of PHASES) {
    const p = at[ph];
    const swing: Partial<HeldState> = ph === 'ready' ? {} : { action: 'melee', actionTotal: d.duration, actionT: d.duration * (1 - p), meleeWith: 'machete' };
    CELLS.push({
      label: `${row === 'quick' ? 'machete (from rifle)' : id} · ${ph}${ph === 'ready' ? '' : ` ${p.toFixed(2)}`}`,
      s: { ...swing, meleeId: id, meleeOut: row !== 'quick' },
      melee: id,
    });
  }
}
const cols = Number(q.get('cols') ?? PHASES.length);

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
  const camera = new THREE.PerspectiveCamera(close ? 30 : 40, aspect, 0.03, 400);
  const gameCam = new THREE.PerspectiveCamera(62, aspect, 0.08, 400);
  const cam = new ThirdPersonCamera(gameCam, physics);
  cam.yaw = 0;
  cam.pitch = -0.08;
  const s: HeldState = {
    primary: { id: 'ar' as WeaponId, mag: 30 }, secondary: { id: 'pistol' as WeaponId, mag: 15 },
    active: 'primary', action: 'idle', actionT: 0, actionTotal: 0, ...c.s,
  };
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = c.label;
  el.style.left = `${(i % cols) * cellW + 6}px`;
  el.style.top = `${Math.floor(i / cols) * rowH + 6}px`;
  document.body.append(el);
  return { c, at, h, weapon, camera, cam, gameCam, s };
});

function step(v: (typeof views)[number], dt: number): void {
  v.h.root.position.copy(v.at);
  v.h.root.rotation.y = v.cam.yaw + Math.PI;
  v.h.lookPitch = v.cam.pitch;
  v.h.update(dt, { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 });
  v.cam.update(dt, v.at, 1.6, false, false, null);
  v.weapon.update(dt, v.s, { aim: 0, sprinting: false, aimPoint: v.cam.aimPoint, ads: 0, eye: v.cam.eye, view: v.cam.view });
  if (view === 'player') {
    v.camera.position.copy(v.gameCam.position);
    v.camera.quaternion.copy(v.gameCam.quaternion);
    v.camera.fov = 62;
    v.camera.updateProjectionMatrix();
    return;
  }
  // A fixed camera on the survivor (who faces -Z): from the front-right, the side or behind.
  const target = new THREE.Vector3(v.at.x, 1.3, v.at.z - 0.15);
  if (close) {
    // On the fist (a hand's length past the wrist), or between the two fists of a two-handed hold.
    const fist = (arm: typeof v.h.armR) => arm.lower.localToWorld(new THREE.Vector3(0, -arm.lowerLen - 0.08, 0));
    target.copy(fist(v.h.armR));
    if (MELEE[v.c.melee].style === 'katana' || MELEE[v.c.melee].style === 'club') target.lerp(fist(v.h.armL), 0.5);
  }
  const off = view === 'side' ? new THREE.Vector3(2.6, 0.15, -0.3) : view === 'left' ? new THREE.Vector3(-2.6, 0.15, -0.3)
    : view === 'back' ? new THREE.Vector3(0.9, 0.35, 2.4) : view === 'top' ? new THREE.Vector3(0.3, 2.8, -0.4) : new THREE.Vector3(1.6, 0.2, -2.1);
  v.camera.position.copy(target).addScaledVector(off, close ? near : 1);
  v.camera.lookAt(target);
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
Object.assign(window, { __meleeReady: true });
