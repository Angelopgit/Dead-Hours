/**
 * Headless sight-picture checks: aims down the sights of every gun, optic and grip exactly as the
 * game does (ThirdPersonCamera's eye, Humanoid's aim stance, PlayerWeapon's ADS hold and arm IK),
 * draws the survivor's own body and the gun into a coarse depth buffer from the eye, and fails if
 * any of the body (hands, sleeves, arms) shows where the sight picture is.
 * Run with `npm run check:sights` (`-- --verbose` lists every case, `-- --map ar` draws what the
 * eye sees for cases matching "ar": # body, = gun, + body in the sight window; `--bones` letters
 * the body by bone, `--pitch -0.6` maps that pitch).
 *
 * What must stay clear: the sight window in the middle of the screen, everything above the bore
 * line, and the whole lens while looking through a rifle scope (the gun is hidden then, so the
 * hands would be all there is to see). Desktop (16:9) and phone (844x390) screens alike, for men
 * and women, bare hands and bulky gloves and sleeves, looking level, down and up.
 */
import * as THREE from 'three';
import { DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, WEAPONS, buildable, defaultBuild, fitsOf, type Appearance, type WeaponBuild, type WeaponId } from '@dead-hours/shared';
import { Humanoid, survivorLook } from '../src/characters/Humanoid';
import { PlayerWeapon, type HeldState } from '../src/weapons/PlayerWeapon';
import { ThirdPersonCamera } from '../src/gameplay/ThirdPersonCamera';
import { sightOf, type WeaponModel } from '../src/weapons/WeaponModels';
import type { Physics } from '../src/core/Physics';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const mapFilter = args.includes('--map') ? args[args.indexOf('--map') + 1] ?? '' : null;
/** Maps letter the body by bone instead of '#': l/L left upper/lower arm (hand included), r/R right, s spine, t hips. */
const bones = args.includes('--bones');
const mapPitch = args.includes('--pitch') ? Number(args[args.indexOf('--pitch') + 1]) : 0;
let failures = 0;
let checks = 0;
const check = (cond: boolean, msg: string) => {
  checks++;
  if (cond) { if (verbose) console.log('  ok   ' + msg); }
  else { failures++; console.log('  FAIL ' + msg); }
};

/** Open ground: no walls for the camera to back off from, nothing under the crosshair. */
const physics = { sphereCast: () => null, raycast: () => null } as unknown as Physics;

const SCREENS = { desktop: 1280 / 720, phone: 844 / 390 } as const;
/** The sight window: a disc this far out from the middle (fraction of half the screen height). */
const WINDOW = 0.34;
/** The scope's lens (HUD .scope .lens is 94% of the short side across). */
const LENS = 0.94;
/**
 * A handgun is held out at arm's length in both hands, which show under the slide as they do in
 * life: there only the window from just under the sights up has to be clear (the slide's own
 * outline runs down to about -0.2 here).
 */
const HANDGUN_FLOOR = -0.12;
/** Above this (fraction of half the screen height) is past the top of the gun: nothing of the body belongs there. */
const BORE = 0.06;
/**
 * Nothing of the gun itself this close to the eye (m) in the sight window: a stock comb or cheek
 * riser the eye sits in fills the sight picture (the guns are drawn double sided).
 */
const GUN_CLEAR = 0.05;
/** Depth-buffer rows (columns follow the aspect). */
const ROWS = 90;

const BODIES: { name: string; look: Appearance }[] = [
  { name: 'man', look: DEFAULT_APPEARANCE },
  { name: 'woman', look: DEFAULT_FEMALE_APPEARANCE },
  { name: 'broad, work gloves, puffer', look: { ...DEFAULT_APPEARANCE, build: 'broad', gloves: 'work', top: 'puffer' } },
];
const PITCHES = [0, -0.6, 0.5];

type Case = { id: WeaponId; build: WeaponBuild; label: string };
const CASES: Case[] = [];
for (const id of ['ar', 'smg', 'shotgun', 'marksman', 'pistol'] as WeaponId[]) {
  for (const optic of fitsOf(id, 'optic')) {
    for (const grip of fitsOf(id, 'grip')) {
      CASES.push({ id, build: { ...defaultBuild(id), optic: optic.id, grip: grip.id }, label: `${id} ${optic.id}${grip.id !== 'none' ? ` + ${grip.id} grip` : ''}` });
    }
  }
}
// Supply-drop guns: sights built in, no fittings.
for (const id of Object.keys(WEAPONS) as WeaponId[]) {
  if (WEAPONS[id].slot !== 'melee' && !buildable(id) && sightOf(id)) CASES.push({ id, build: defaultBuild(id), label: id });
}

function held(id: WeaponId, build: WeaponBuild): HeldState {
  const pistol = WEAPONS[id].slot === 'secondary';
  return {
    primary: { id: pistol ? 'ar' : id, mag: 30 },
    secondary: { id: pistol ? id : 'pistol', mag: 15 },
    active: pistol ? 'secondary' : 'primary',
    action: 'idle', actionT: 0, actionTotal: 0,
    builds: { [id]: build },
  };
}

// ── A tiny depth rasterizer ─────────────────────────────────────────────────────────────────

const _v = new THREE.Vector4();
type Clip = [number, number, number, number];

class Depth {
  readonly z: Float32Array;
  /** What drew each cell (a tag per triangle, see draw). */
  readonly tag: Uint8Array;
  private t = 0;
  constructor(readonly w: number, readonly h: number) {
    this.z = new Float32Array(w * h).fill(Infinity);
    this.tag = new Uint8Array(w * h);
  }

  /** Draws world-space triangles (`pos` xyz per vertex, three per triangle) seen through `vp`. */
  draw(pos: Float32Array, vp: THREE.Matrix4, cull: boolean, tags?: Uint8Array): void {
    const clip = new Float32Array((pos.length / 3) * 4);
    for (let i = 0, j = 0; i < pos.length; i += 3, j += 4) {
      _v.set(pos[i], pos[i + 1], pos[i + 2], 1).applyMatrix4(vp);
      clip[j] = _v.x; clip[j + 1] = _v.y; clip[j + 2] = _v.z; clip[j + 3] = _v.w;
    }
    for (let t = 0; t < clip.length; t += 12) {
      const tri: Clip[] = [0, 1, 2].map((k) => [clip[t + k * 4], clip[t + k * 4 + 1], clip[t + k * 4 + 2], clip[t + k * 4 + 3]] as Clip);
      // Near plane (z >= -w): clip the polygon.
      const poly: Clip[] = [];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        const da = a[2] + a[3], db = b[2] + b[3];
        if (da >= 0) poly.push(a);
        if ((da >= 0) !== (db >= 0)) {
          const s = da / (da - db);
          poly.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s, a[3] + (b[3] - a[3]) * s]);
        }
      }
      if (poly.length < 3) continue;
      const scr = poly.map((p) => [((p[0] / p[3]) * 0.5 + 0.5) * this.w, ((p[1] / p[3]) * 0.5 + 0.5) * this.h, p[2] / p[3]]);
      // Backface culling (counter-clockwise on screen faces the eye).
      const area = (scr[1][0] - scr[0][0]) * (scr[2][1] - scr[0][1]) - (scr[2][0] - scr[0][0]) * (scr[1][1] - scr[0][1]);
      if (cull && area <= 0) continue;
      this.t = tags ? tags[t / 12] : 0;
      for (let k = 1; k < scr.length - 1; k++) this.fill(scr[0], scr[k], scr[k + 1]);
    }
  }

  private fill(a: number[], b: number[], c: number[]): void {
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(this.w - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(this.h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-9) return;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const i = y * this.w + x;
        if (z < this.z[i]) {
          this.z[i] = z;
          this.tag[i] = this.t;
        }
      }
    }
  }
}

/** The bone each triangle of a skinned mesh mostly follows (its first corner's main bone). */
function boneTags(mesh: THREE.SkinnedMesh): Uint8Array {
  const g = mesh.geometry;
  const si = g.getAttribute('skinIndex');
  const idx = g.index;
  const count = (idx ? idx.count : si.count) / 3;
  const out = new Uint8Array(count);
  for (let t = 0; t < count; t++) out[t] = si.getX(idx ? idx.getX(t * 3) : t * 3);
  return out;
}
/** Map letters per bone (BONE order in rig.ts): hips, spine, head, left arm upper/lower, right arm upper/lower, legs. */
const BONE_CH = 'tsHlLrRgggg';

/** World-space triangle soup of a mesh (skinned meshes posed as they are now). */
function triangles(mesh: THREE.Mesh): Float32Array {
  const g = mesh.geometry;
  const n = g.getAttribute('position').count;
  const verts = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
    verts[i * 3] = v.x; verts[i * 3 + 1] = v.y; verts[i * 3 + 2] = v.z;
  }
  const idx = g.index;
  const count = idx ? idx.count : n;
  const out = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    const i = idx ? idx.getX(k) : k;
    out[k * 3] = verts[i * 3]; out[k * 3 + 1] = verts[i * 3 + 1]; out[k * 3 + 2] = verts[i * 3 + 2];
  }
  return out;
}

interface Pose { body: Float32Array; tags: Uint8Array; gun: Float32Array[]; scoped: boolean; handgun: boolean; camera: THREE.PerspectiveCamera }
interface Seen { window: number; above: number; nearest: number; gunAtEye: number; map: string }

/** Aims for a second and a half at 60 fps (everything settles) and takes the final pose. */
function aim(c: Case, look: Appearance, pitch: number): Pose {
  const scene = new THREE.Scene();
  const h = new Humanoid(survivorLook(look));
  scene.add(h.root);
  const weapon = new PlayerWeapon(scene, h);
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 400);
  scene.add(camera);
  const cam = new ThirdPersonCamera(camera, physics);
  cam.yaw = 0.3;
  cam.pitch = pitch;
  const feet = new THREE.Vector3(0, 0, 0);
  const s = held(c.id, c.build);
  const model = () => (weapon as unknown as { ensure(id: WeaponId): WeaponModel }).ensure(c.id);
  const dt = 1 / 60;
  const frame = () => {
    // The game's order: the body animates, the camera follows, then the gun and arms go on it.
    h.root.position.copy(feet);
    h.root.rotation.y = cam.yaw + Math.PI;
    h.lookPitch = cam.pitch;
    h.update(dt, { speed: 0, crouch: 0, aim: 1, grounded: true, strafe: 0 });
    cam.update(dt, feet, 1.6, true, false, model().sight);
    // The game hides the gun (not the hands) once a rifle scope is up to the eye.
    weapon.hideHeld = model().sight?.optic === 'scope' && cam.ads > 0.9;
    weapon.update(dt, s, { aim: 1, sprinting: false, aimPoint: cam.aimPoint, ads: cam.ads, eye: cam.eye, view: cam.view });
  };
  for (let i = 0; i < 90; i++) frame();
  scene.updateMatrixWorld(true);
  h.mesh.skeleton.update();
  const scoped = model().sight?.optic === 'scope';
  const gun: Float32Array[] = [];
  if (!scoped) model().root.traverse((o) => { if ((o as THREE.Mesh).isMesh) gun.push(triangles(o as THREE.Mesh)); });
  const pose = { body: triangles(h.mesh), tags: boneTags(h.mesh), gun, scoped, handgun: WEAPONS[c.id].hold === 'pistol', camera: camera.clone() };
  weapon.dispose();
  return pose;
}

/** What the eye sees on a screen of this shape: body where it is in front of the gun. */
function see(p: Pose, aspect: number, map: boolean): Seen {
  const camera = p.camera;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const W = Math.round(ROWS * aspect);
  const body = new Depth(W, ROWS);
  body.draw(p.body, vp, true, p.tags);
  const gun = new Depth(W, ROWS);
  for (const g of p.gun) gun.draw(g, vp, false);
  const R = p.scoped ? LENS : WINDOW;
  const floor = p.handgun ? HANDGUN_FLOOR : -Infinity;
  const seen: Seen = { window: 0, above: 0, nearest: Infinity, gunAtEye: 0, map: '' };
  // Depth-buffer z back to metres in front of the eye.
  const n = camera.near, f = camera.far;
  const metres = (z: number) => (2 * n * f) / (f + n - z * (f - n));
  const rows: string[] = [];
  for (let y = ROWS - 1; y >= 0; y--) {
    let row = '';
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const nx = ((x + 0.5) / W) * 2 - 1, ny = ((y + 0.5) / ROWS) * 2 - 1;
      const r = Math.hypot(nx * aspect, ny);
      const shows = body.z[i] < gun.z[i];
      const inWindow = r <= R && ny > floor;
      if (shows && inWindow) seen.window++;
      else if (shows && ny > BORE) seen.above++;
      if (shows && (inWindow || ny > BORE)) seen.nearest = Math.min(seen.nearest, r);
      if (r <= R && gun.z[i] < Infinity && metres(gun.z[i]) < GUN_CLEAR) seen.gunAtEye++;
      if (map) row += shows ? (inWindow || ny > BORE ? '+' : bones ? BONE_CH[body.tag[i]] : '#') : gun.z[i] < Infinity ? '=' : Math.abs(r - R) < 0.03 ? '.' : ' ';
    }
    rows.push(row);
  }
  seen.map = rows.join('\n');
  return seen;
}

console.log('Sight pictures (aiming down the sights, first person)');
for (const c of CASES) {
  for (const b of BODIES) {
    for (const pitch of PITCHES) {
      const pose = aim(c, b.look, pitch);
      for (const [screen, aspect] of Object.entries(SCREENS)) {
        const drawMap = mapFilter !== null && c.label.includes(mapFilter) && b === BODIES[0] && pitch === mapPitch && screen === 'desktop';
        const s = see(pose, aspect, drawMap);
        const where = `${c.label}, ${b.name}, ${screen}, pitch ${pitch}`;
        if (drawMap) console.log(`\n${where}\n${s.map}\n`);
        check(s.window === 0, `${where}: ${pose.scoped ? 'scope lens' : 'sight window'} clear of hands and arms${s.window ? ` (${s.window} cells show the body, nearest ${s.nearest.toFixed(2)} from the middle)` : ''}`);
        check(s.above === 0, `${where}: nothing of the body above the gun${s.above ? ` (${s.above} cells)` : ''}`);
        check(s.gunAtEye === 0, `${where}: the eye is clear of the gun's own stock and comb${s.gunAtEye ? ` (${s.gunAtEye} cells of gun within ${GUN_CLEAR * 100} cm)` : ''}`);
      }
    }
  }
}

console.log(failures ? `\n${failures} of ${checks} sight checks failed` : `\nall ${checks} sight checks passed`);
process.exit(failures ? 1 : 0);
