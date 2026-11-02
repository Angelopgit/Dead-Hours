/**
 * Dev-only sight pictures: /dev/sights.html renders what the eye sees aiming down the sights of
 * several guns side by side (the same first-person hold as the game: ThirdPersonCamera's eye,
 * PlayerWeapon's ADS hold and arms), for checking where the hands sit. `guns=ar:dot,pistol:iron`
 * picks gun:optic pairs (`ar:dot:vertical` adds a grip), `pitch=-0.6` looks down, `aspect=2.16`
 * shapes each cell like a phone, `base={"body":"female"}` dresses the survivor. Not part of the
 * game build; `npm run check:sights` is the automatic version.
 */
import * as THREE from 'three';
import { DEFAULT_APPEARANCE, WEAPONS, defaultBuild, sanitizeAppearance, type Appearance, type WeaponId } from '@dead-hours/shared';
import { Humanoid, survivorLook } from '../src/characters/Humanoid';
import { PlayerWeapon, type HeldState } from '../src/weapons/PlayerWeapon';
import { ThirdPersonCamera } from '../src/gameplay/ThirdPersonCamera';
import type { WeaponModel } from '../src/weapons/WeaponModels';
import type { Physics } from '../src/core/Physics';

const q = new URLSearchParams(location.search);
const guns = (q.get('guns') ?? 'ar:iron,ar:dot,ar:holo,ar:acog,smg:iron,shotgun:iron,marksman:iron,marksman:scope,pistol:iron,pistol:dot,lmg:iron,battle:dot')
  .split(',').map((g) => g.split(':'));
const pitch = Number(q.get('pitch') ?? 0);
const aspect = Number(q.get('aspect') ?? 16 / 9);
const base: Appearance = sanitizeAppearance({ ...DEFAULT_APPEARANCE, ...JSON.parse(q.get('base') ?? '{}') });
const cols = Number(q.get('cols') ?? Math.min(4, guns.length));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setScissorTest(true);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x5d6b7a);
scene.fog = new THREE.Fog(0x5d6b7a, 20, 90);
scene.add(new THREE.HemisphereLight(0xc8d4e4, 0x3a3226, 1.4));
const sun = new THREE.DirectionalLight(0xfff0dc, 2.2);
sun.position.set(-3, 6, 4);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 400), new THREE.MeshStandardMaterial({ color: 0x4a4740, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

/** Open ground: nothing for the camera to back off from. */
const physics = { sphereCast: () => null, raycast: () => null } as unknown as Physics;
const SPACING = 60;
const rows = Math.ceil(guns.length / cols);
const rowH = Math.min(innerHeight / rows, innerWidth / cols / aspect);
const cellW = rowH * aspect;

const views = guns.map(([id, optic, grip], i) => {
  const gun = id as WeaponId;
  const at = new THREE.Vector3(i * SPACING, 0, 0);
  // Targets down range: posts at 8, 15 and 30 m.
  for (const [d, x] of [[8, 0], [15, 1.5], [30, -2]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.75, 0.3), new THREE.MeshStandardMaterial({ color: 0x8a3a2a, roughness: 0.8 }));
    post.position.set(at.x + x, 0.875, -d);
    scene.add(post);
  }
  const h = new Humanoid(survivorLook(base));
  scene.add(h.root);
  const weapon = new PlayerWeapon(scene, h);
  const camera = new THREE.PerspectiveCamera(62, aspect, 0.08, 400);
  const cam = new ThirdPersonCamera(camera, physics);
  cam.yaw = 0;
  cam.pitch = pitch;
  const pistol = WEAPONS[gun].slot === 'secondary';
  const build = { ...defaultBuild(gun), ...(optic ? { optic } : {}), ...(grip ? { grip } : {}) };
  const s: HeldState = {
    primary: { id: pistol ? 'ar' : gun, mag: 30 }, secondary: { id: pistol ? gun : 'pistol', mag: 15 },
    active: pistol ? 'secondary' : 'primary', action: 'idle', actionT: 0, actionTotal: 0, builds: { [gun]: build },
  };
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = `${WEAPONS[gun].name} · ${build.optic}${grip ? ` · ${grip}` : ''}`;
  el.style.left = `${(i % cols) * cellW + 6}px`;
  el.style.top = `${Math.floor(i / cols) * rowH + 6}px`;
  document.body.append(el);
  return { gun, at, h, weapon, camera, cam, s };
});

/** The game's frame order: the body animates, the camera follows, then the gun and arms go on it. */
function step(v: (typeof views)[number], dt: number): void {
  const model = (v.weapon as unknown as { ensure(id: WeaponId): WeaponModel }).ensure(v.gun);
  v.h.root.position.copy(v.at);
  v.h.root.rotation.y = v.cam.yaw + Math.PI;
  v.h.lookPitch = v.cam.pitch;
  v.h.update(dt, { speed: 0, crouch: 0, aim: 1, grounded: true, strafe: 0 });
  v.cam.update(dt, v.at, 1.6, true, false, model.sight);
  v.weapon.hideHeld = model.sight?.optic === 'scope' && v.cam.ads > 0.9;
  v.weapon.update(dt, v.s, { aim: 1, sprinting: false, aimPoint: v.cam.aimPoint, ads: v.cam.ads, eye: v.cam.eye, view: v.cam.view });
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
Object.assign(window, { __sightsReady: true });
