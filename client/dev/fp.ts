/**
 * Dev-only first-person view, moving: /dev/fp.html renders what the eye sees down the sights while
 * the survivor stands, walks, turns and fires, stepped at a fixed 60 fps so a page script can
 * capture frames (`__fpStep(n)` advances n frames, `__fpReady` says the scene is up). Same hold as
 * the game: ThirdPersonCamera's eye, PlayerWeapon's ADS hold, arms and recoil.
 * `gun=akimbo` (default), `optic=holo`, `walk=2.5` (m/s), `turn=1.2` (rad/s, eased back and forth),
 * `fire=6` (shots a second), `pitch=0`, `ads=0` for the over-the-shoulder view instead.
 * Not part of the game build.
 */
import * as THREE from 'three';
import { DEFAULT_APPEARANCE, WEAPONS, defaultBuild, sanitizeAppearance, type Appearance, type WeaponId } from '@dead-hours/shared';
import { Humanoid, survivorLook } from '../src/characters/Humanoid';
import { PlayerWeapon, type HeldState } from '../src/weapons/PlayerWeapon';
import { ThirdPersonCamera } from '../src/gameplay/ThirdPersonCamera';
import type { WeaponModel } from '../src/weapons/WeaponModels';
import type { Physics } from '../src/core/Physics';
import { Effects } from '../src/effects/Effects';

const q = new URLSearchParams(location.search);
const gun = (q.get('gun') ?? 'akimbo') as WeaponId;
const optic = q.get('optic');
const walk = Number(q.get('walk') ?? 0);
const turn = Number(q.get('turn') ?? 0);
const fire = Number(q.get('fire') ?? 0);
const ads = q.get('ads') !== '0';
const base: Appearance = sanitizeAppearance({ ...DEFAULT_APPEARANCE, ...JSON.parse(q.get('base') ?? '{}') });
const def = WEAPONS[gun];
const pistol = def.slot === 'secondary';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x5d6b7a);
scene.fog = new THREE.Fog(0x5d6b7a, 20, 90);
scene.add(new THREE.HemisphereLight(0xc8d4e4, 0x3a3226, 1.4));
const sun = new THREE.DirectionalLight(0xfff0dc, 2.2);
sun.position.set(-3, 6, 4);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x4a4740, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
// Posts down range every few metres, so turning and walking read against something.
for (let i = 0; i < 60; i++) {
  const a = (i / 60) * Math.PI * 2, d = 8 + (i % 4) * 6;
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.75, 0.3), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x8a3a2a : 0x6a6e3a, roughness: 0.8 }));
  post.position.set(Math.sin(a) * d, 0.875, -Math.cos(a) * d);
  scene.add(post);
}

const physics = { sphereCast: () => null, raycast: () => null } as unknown as Physics;
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.08, 400);
scene.add(camera);
const cam = new ThirdPersonCamera(camera, physics);
cam.yaw = 0;
cam.pitch = Number(q.get('pitch') ?? 0);
const h = new Humanoid(survivorLook(base));
scene.add(h.root);
const weapon = new PlayerWeapon(scene, h);
const s: HeldState = {
  primary: { id: pistol ? 'ar' : gun, mag: pistol ? 30 : def.magazine }, secondary: { id: pistol ? gun : 'pistol', mag: pistol ? def.magazine : 15 },
  active: pistol ? 'secondary' : 'primary', action: 'idle', actionT: 0, actionTotal: 0,
  builds: { [gun]: { ...defaultBuild(gun), ...(optic ? { optic } : {}) } },
};
const model = () => (weapon as unknown as { ensure(id: WeaponId): WeaponModel }).ensure(gun);
// `fx=1` draws the game's own muzzle flash and barrel smoke.
const fx = q.get('fx') ? new Effects(scene, physics) : null;
const burst = Number(q.get('burst') ?? 0);
const feet = new THREE.Vector3();
let t = 0, nextShot = 0.4;
const DT = 1 / 60;

function step(): void {
  t += DT;
  cam.yaw += turn * Math.sin(t * 1.3) * DT;
  const fwd = new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
  feet.addScaledVector(fwd, walk * DT);
  h.root.position.copy(feet);
  h.root.rotation.y = cam.yaw + Math.PI;
  h.lookPitch = cam.pitch;
  h.update(DT, { speed: walk, crouch: 0, aim: 1, grounded: true, strafe: 0 });
  cam.update(DT, feet, 1.6, true, false, ads ? model().sight : null);
  const a = pistol ? s.secondary : s.primary;
  if (fire > 0 && t >= nextShot) {
    nextShot = t + 1 / fire;
    a.mag = a.mag > 1 ? a.mag - 1 : def.magazine;
    weapon.fired(def, a.mag);
    if (fx) fx.muzzle(weapon.muzzleWorld(new THREE.Vector3()), weapon.muzzleDir(new THREE.Vector3()), gun, true);
    cam.addRecoil((0.006 + def.recoil * 0.014) * 0.75, (Math.random() - 0.5) * def.recoil * 0.008);
  }
  weapon.update(DT, s, { aim: 1, sprinting: false, aimPoint: cam.aimPoint, ads: cam.ads, eye: cam.eye, view: cam.view });
  if (fx) {
    // `burst=1.5` stops the firing after that many seconds, to watch the barrel smoke afterwards.
    if (burst > 0 && t > 0.4 + burst) nextShot = Infinity;
    if (fx.barrelWarm) fx.barrel(weapon.muzzleWorld(new THREE.Vector3()), DT);
    fx.update(DT, camera);
  }
}
for (let i = 0; i < 60; i++) step();
renderer.render(scene, camera);
/** Each gun's grip in camera space (cm) and its muzzle's angle up / left (degrees), for measuring the motion. */
function probe(): number[][] {
  const out: number[][] = [];
  const inv = camera.quaternion.clone().invert();
  for (const m of [model(), weapon.offhandModel]) {
    if (!m) continue;
    const g = m.root.localToWorld(new THREE.Vector3(0, -0.006, 0.043)).sub(camera.position).applyQuaternion(inv);
    const d = new THREE.Vector3(0, 0, 1).applyQuaternion(m.root.quaternion).applyQuaternion(inv);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(m.root.quaternion).applyQuaternion(inv);
    const deg = 180 / Math.PI;
    out.push([g.x * 100, g.y * 100, g.z * 100, Math.asin(d.y) * deg, Math.atan2(-d.x, -d.z) * deg, Math.atan2(-up.x, up.y) * deg]);
  }
  return out;
}
Object.assign(window, {
  __fpProbe: (n: number) => {
    const rows: number[][][] = [];
    for (let i = 0; i < n; i++) {
      step();
      rows.push(probe());
    }
    return rows;
  },
  __fpReady: true,
  __fpStep: (n: number) => {
    for (let i = 0; i < n; i++) step();
    renderer.render(scene, camera);
  },
});
