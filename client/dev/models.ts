/**
 * Dev-only model sheet from pinned cameras: /dev/models.html?gun=ar draws one gun as a flat side
 * view (for laying over a dimension drawing), from the front and rear quarters in daylight, and
 * under the game's night (a sodium lamp, a cold fill, a torch from the camera), with its triangle
 * and draw call counts and its size. `build={"optic":"dot"}` fits attachments, `skin=gold` a finish.
 * The same cameras before and after a change make the before/after shots in docs/art-style.md.
 * `view=2` fills the window with one of the four. `window.__models` holds the numbers once drawn. Not part of the game build.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { VEHICLES, defaultBuild, vehicleKindOf, type PropKind, type PropSpec, type WeaponId } from '@dead-hours/shared';
import { MaterialLibrary } from '../src/rendering/Materials';
import { Kit, type PropBuildResult } from '../src/environment/props/Kit';
import { INTERIOR } from '../src/environment/props/interior';
import { OUTDOOR } from '../src/environment/props/outdoor';
import { createWeaponModel } from '../src/weapons/WeaponModels';

const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Number(q.get('dpr') ?? 1));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setScissorTest(true);
document.body.append(renderer.domElement);
const env = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;

interface Subject { root: THREE.Object3D; label: string }

function gun(): Subject {
  const id = (q.get('gun') ?? 'ar') as WeaponId;
  const build = { ...defaultBuild(id), ...JSON.parse(q.get('build') ?? '{}'), ...(q.get('skin') ? { skin: q.get('skin') } : {}) };
  const m = createWeaponModel(id, build);
  return { root: m.root, label: id };
}

/** `prop=humvee` (with `length`, `variant`, `weapon`): a map prop as its builder makes it, nose toward +Z; a vehicle with a roof gun gets it. */
function prop(): Subject {
  const kind = q.get('prop') as PropKind;
  const spec: PropSpec = { kind, x: 0, z: 0, rotY: 0, variant: Number(q.get('variant') ?? 0), ...(q.get('length') ? { length: Number(q.get('length')) } : {}), ...(q.get('weapon') ? { weapon: q.get('weapon') as WeaponId, stock: 2 } : {}) };
  const lib = new MaterialLibrary(256, 1);
  lib.paintProcedural();
  const out: PropBuildResult = { dynamic: [], anchors: [], landmarks: {}, vehicles: [] };
  const kit = new Kit(lib, out);
  const inner = new THREE.Group(), dyn = new THREE.Group();
  kit.begin(spec, inner, dyn);
  (INTERIOR[kind] ?? OUTDOOR[kind])?.(kit);
  inner.add(dyn);
  const vk = vehicleKindOf({ ...spec, drive: true });
  const ts = vk ? VEHICLES[vk].turret : undefined;
  if (vk && ts) {
    const g = createWeaponModel(ts.weapon);
    const seat = VEHICLES[vk].seats[ts.seat];
    g.root.rotation.y = Math.PI / 2;
    g.root.position.set(seat.x + ts.pivot, ts.y, seat.z);
    inner.add(g.root);
  }
  inner.rotation.y = -Math.PI / 2;
  const root = new THREE.Group();
  root.add(inner);
  root.updateMatrixWorld(true);
  return { root, label: kind };
}

const subject = q.get('prop') ? prop() : gun();
const box = new THREE.Box3().setFromObject(subject.root);
const size = box.getSize(new THREE.Vector3());
const centre = box.getCenter(new THREE.Vector3());
let tris = 0, draws = 0;
subject.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  draws++;
  tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
});

function stage(night: boolean): THREE.Scene {
  const s = new THREE.Scene();
  s.background = new THREE.Color(night ? 0x07090c : 0x565d66);
  s.environment = env;
  s.environmentIntensity = night ? 0.05 : 0.55;
  if (night) {
    // A sodium street lamp above and behind, the cold sky, and a torch from the camera's side.
    const lamp = new THREE.PointLight(0xffa24a, 30, 12, 2);
    lamp.position.copy(centre).add(new THREE.Vector3(-1.2, 1.6, 0.8).multiplyScalar(Math.max(1, size.length())));
    const sky = new THREE.HemisphereLight(0x5a6c8c, 0x101010, 0.5);
    const torch = new THREE.SpotLight(0xdfe8ff, 14, 14, 0.5, 0.6, 2);
    torch.position.copy(centre).add(new THREE.Vector3(1.4, 0.5, -0.9).multiplyScalar(Math.max(1, size.length())));
    torch.target.position.copy(centre);
    s.add(lamp, sky, torch, torch.target);
  } else {
    const sun = new THREE.DirectionalLight(0xfff2e0, 2.4);
    sun.position.set(-2, 5, 3);
    s.add(sun, new THREE.HemisphereLight(0xc8d4e4, 0x4a4238, 0.9));
  }
  return s;
}
const day = stage(false), night = stage(true);

interface View { label: string; scene: THREE.Scene; camera: THREE.Camera }
const views: View[] = [];
const aspect = (innerWidth / 2) / (innerHeight / 2);
// Flat side view (the right side: -X), framed on the model with a margin.
{
  const half = Math.max(size.z / 2, (size.y / 2) * aspect) * 1.08;
  const cam = new THREE.OrthographicCamera(-half, half, half / aspect, -half / aspect, 0.01, 50);
  cam.position.set(centre.x - 5, centre.y, centre.z);
  cam.lookAt(centre);
  views.push({ label: `${subject.label}, side view (right)`, scene: day, camera: cam });
}
const reach = Math.max(size.z, size.y * aspect) * 0.5;
const persp = (label: string, scene: THREE.Scene, dir: THREE.Vector3, fov = 30) => {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.01, 200);
  const d = (reach / Math.tan((fov * Math.PI) / 360) / aspect) * 1.12;
  cam.position.copy(centre).addScaledVector(dir.normalize(), d);
  cam.lookAt(centre);
  views.push({ label, scene, camera: cam });
};
persp('front quarter, day', day, new THREE.Vector3(-1, 0.45, 0.9));
persp('rear quarter (the shooter\'s side), night', night, new THREE.Vector3(0.9, 0.5, -1));
persp('front quarter, night', night, new THREE.Vector3(-1, 0.35, 0.9));

const only = q.get('view');
if (only !== null) views.splice(0, views.length, views[Number(only)]);
const cols = only !== null ? 1 : 2;
const w = innerWidth / cols, h = innerHeight / cols;
views.forEach((v, i) => {
  const x = (i % cols) * w, y = Math.floor(i / cols) * h;
  const el = document.createElement('div');
  el.className = 'label';
  el.style.left = `${x + 6}px`;
  el.style.top = `${y + 6}px`;
  el.textContent = v.label;
  document.body.append(el);
});
const stats = document.createElement('div');
stats.className = 'label';
stats.style.left = '6px';
stats.style.bottom = '6px';
const mm = (n: number) => Math.round(n * 1000);
stats.textContent = `${tris} triangles, ${draws} draw calls, ${mm(size.z)} x ${mm(size.y)} x ${mm(size.x)} mm`;
document.body.append(stats);

function draw(): void {
  views.forEach((v, i) => {
    const x = (i % cols) * w, y = innerHeight - h - Math.floor(i / cols) * h;
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    v.scene.add(subject.root);
    renderer.render(v.scene, v.camera);
  });
}
draw();
(window as unknown as { __models: unknown }).__models = { tris, draws, size: size.toArray(), redraw: draw };
