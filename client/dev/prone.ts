/**
 * Dev-only: survivors lying prone, crawling, aiming, reloading and swinging on the ground, mid
 * dolphin dive and getting down, plus a zombie clawing down at one, each with a gun in hand, for
 * checking the poses (`/dev/prone.html?view=side|front|back|top`, `cols=5`). Not part of the game build.
 */
import * as THREE from 'three';
import { DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, WEAPONS, type WeaponId } from '@dead-hours/shared';
import { Humanoid, survivorLook, zombieLook } from '../src/characters/Humanoid';
import { PlayerWeapon, type HeldState } from '../src/weapons/PlayerWeapon';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'side';
const cols = Number(q.get('cols') ?? 5);

interface Cell {
  label: string;
  weapon?: WeaponId;
  /** Prone target, dive target, rise, look pitch, aim, speed. */
  prone?: number; dive?: number; rise?: number; pitch?: number; aim?: number; speed?: number;
  action?: HeldState['action']; progress?: number;
  /** Seconds to run before freezing (mid-transition shots); 0 runs forever. */
  stopAt?: number;
  female?: boolean;
  zombie?: boolean;
  lift?: number;
}
const CELLS: Cell[] = [
  { label: 'standing (reference)', aim: 0 },
  { label: 'prone · ready', prone: 1 },
  { label: 'prone · aiming', prone: 1, aim: 1 },
  { label: 'prone · aiming up 0.6', prone: 1, aim: 1, pitch: 0.6 },
  { label: 'prone · aiming down -0.5', prone: 1, aim: 1, pitch: -0.5 },
  { label: 'prone · crawling', prone: 1, speed: 1 },
  { label: 'prone · pistol aim', prone: 1, aim: 1, weapon: 'pistol', female: true },
  { label: 'prone · reloading', prone: 1, action: 'reload', progress: 0.4 },
  { label: 'prone · melee (risen)', prone: 1, rise: 1, action: 'melee', progress: 0.3 },
  { label: 'dive · in the air', prone: 1, dive: 1, lift: 0.25 },
  { label: 'getting down (0.1 s)', prone: 1, stopAt: 0.1 },
  { label: 'getting down (0.2 s)', prone: 1, stopAt: 0.2 },
  { label: 'dive · leaving the ground', prone: 1, dive: 1, stopAt: 0.07, lift: 0.1 },
  { label: 'zombie claws down at prone', prone: 1, zombie: true },
  { label: 'prone · woman ready', prone: 1, female: true },
];

const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setScissorTest(true);
document.body.append(renderer.domElement);
const rows = Math.ceil(CELLS.length / cols);
const cw = W / cols, ch = H / rows;
const camera = new THREE.PerspectiveCamera(32, cw / ch, 0.05, 60);
if (view === 'front') camera.position.set(0.9, 0.9, 3.6);
else if (view === 'back') camera.position.set(-1.2, 1.4, -3.4);
else if (view === 'top') camera.position.set(0.01, 4.6, 0.3);
else camera.position.set(3.9, 1.0, 0.25);
camera.lookAt(0, 0.35, 0.15);

function held(id: WeaponId, c: Cell): HeldState {
  const pistol = WEAPONS[id].slot === 'secondary';
  const total = c.action === 'melee' ? 0.6 : c.action === 'reload' ? 2.4 : 0;
  return {
    primary: { id: pistol ? 'ar' : id, mag: 30 }, secondary: { id: pistol ? id : 'pistol', mag: 15 },
    active: pistol ? 'secondary' : 'primary', action: c.action ?? 'idle',
    actionT: total * (1 - (c.progress ?? 0)), actionTotal: total,
  };
}

const stages = CELLS.map((c, i) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2f36);
  scene.add(new THREE.HemisphereLight(0xbcc8d8, 0x30281f, 1.3));
  const key = new THREE.DirectionalLight(0xfff0dc, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({ color: 0x45443f, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const grid = new THREE.GridHelper(4, 8, 0x777777, 0x555555);
  grid.position.y = 0.002;
  scene.add(grid);
  const body = new Humanoid(survivorLook(c.female ? DEFAULT_FEMALE_APPEARANCE : DEFAULT_APPEARANCE));
  scene.add(body.root);
  const weapon = new PlayerWeapon(scene, body);
  let zombie: Humanoid | null = null;
  if (c.zombie) {
    zombie = new Humanoid(zombieLook(2));
    zombie.root.position.set(0.15, 0, 1.25);
    zombie.root.rotation.y = Math.PI;
    zombie.attackLow = 1;
    scene.add(zombie.root);
  }
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = c.label;
  el.style.left = `${(i % cols + 0.5) * cw}px`;
  el.style.top = `${(Math.floor(i / cols) + 1) * ch - 16}px`;
  document.body.append(el);
  return { c, scene, body, weapon, zombie, t: 0 };
});

const aimPoint = new THREE.Vector3();
let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stages.forEach((s, i) => {
    const c = s.c;
    if (!c.stopAt || s.t < c.stopAt) {
      const step = c.stopAt ? Math.min(dt, c.stopAt - s.t) : dt;
      s.t += step;
      const b = s.body;
      b.prone = c.prone ?? 0;
      b.dive = c.dive ?? 0;
      b.rise = c.rise ?? 0;
      b.lookPitch = c.pitch ?? 0;
      b.root.position.y = c.lift ?? 0;
      b.update(step, { speed: c.speed ?? 0, crouch: 0, aim: c.aim ?? 0, grounded: !c.dive, strafe: 0, moveAngle: 0, turn: 0 });
      const p = c.pitch ?? 0;
      aimPoint.set(0, 0.45 + (c.prone ? 0 : 1.15) + Math.tan(p) * 20, 20);
      s.weapon.update(step, held(c.weapon ?? 'ar', c), { aim: c.aim ?? 0, sprinting: false, aimPoint });
      if (s.zombie) {
        s.zombie.attack = ((now / 1000) % 1.4) / 1.4;
        s.zombie.update(step, { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 });
      }
    }
    const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
    renderer.setViewport(x, y, cw, ch);
    renderer.setScissor(x, y, cw, ch);
    renderer.render(s.scene, camera);
  });
  requestAnimationFrame(frame);
}
frame();
Object.assign(window, { __proneReady: true, __stages: stages });
