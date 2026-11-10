/**
 * Dev-only look at the drivable vehicles as the game draws them (PropFactory parts merged by
 * VehicleView), each with survivors seated as the game seats them: from the side at eye height
 * (through the glass), from the front, and low beside the sill to see that no feet come out
 * under the car, and cut open down the driver's side (the door taken away) to see the legs on
 * the floor. A parked car (scenery) is shown for comparison. Not part of the game build.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, NEIGHBORHOOD, VEHICLES, isDrivable, seatDrop, vehicleKindOf, type PropSpec } from '@dead-hours/shared';
import { Humanoid, survivorLook } from '../src/characters/Humanoid';
import { MaterialLibrary } from '../src/rendering/Materials';
import { PropFactory } from '../src/environment/Props';
import { Kit, type PropBuildResult } from '../src/environment/props/Kit';
import { VehicleView } from '../src/gameplay/VehicleView';
import { LightField } from '../src/lighting/LightField';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setScissorTest(true);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x5d6b7a);
scene.add(new THREE.HemisphereLight(0xc8d4e4, 0x3a3226, 1.6));
const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
sun.position.set(-30, 60, 40);
scene.add(sun);
const env = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x3e3d3a, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const map = NEIGHBORHOOD;
const at = (kind: string, x: number, z: number) => map.props.findIndex((p) => p.kind === kind && Math.abs(p.x - x) < 0.5 && Math.abs(p.z - z) < 0.5);
const picks = [at('car', -38, 2.8), at('policeCar', -5.5, 1.6), at('armoredTruck', -113.5, 1.4)];
const lib = new MaterialLibrary(256, 1);
lib.paintProcedural();
const factory = new PropFactory(lib);
const result: PropBuildResult = { dynamic: [], anchors: [], landmarks: {}, vehicles: [] };
const kit = new Kit(lib, result);
const build = factory as unknown as { buildVehicle(k: Kit, p: PropSpec, i: number, out: PropBuildResult): void; buildStreetProp(k: Kit, out: PropBuildResult): void };
for (const i of picks) if (isDrivable(map.props[i])) build.buildVehicle(kit, map.props[i], i, result);
const view = new VehicleView(scene, result.vehicles, new LightField(map));
// A parked car, as the static batch would draw it.
const parkedAt = map.props.findIndex((p) => p.kind === 'car' && !isDrivable(p));
if (parkedAt >= 0) {
  const p = map.props[parkedAt];
  const root = new THREE.Group(), dyn = new THREE.Group();
  root.position.set(p.x, 0, p.z);
  root.rotation.y = p.rotY;
  kit.begin(p, root, dyn);
  build.buildStreetProp(kit, result);
  scene.add(root);
}
scene.traverse((o) => {
  const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
  if (m?.userData?.envMap) m.envMap = env;
});

const looks = [DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, { ...DEFAULT_APPEARANCE, shoes: 'work' as const }];
const people: Humanoid[] = [];
const seatAt = new THREE.Vector3();
for (const i of picks) {
  const p = map.props[i];
  const kind = vehicleKindOf(p);
  const id = result.vehicles.findIndex((v) => v.prop === i);
  if (!kind || id < 0) continue;
  const def = VEHICLES[kind];
  for (let s = 0; s < 3; s++) {
    const h = new Humanoid(survivorLook(looks[s % looks.length]));
    h.seat = { yaw: 0, drop: seatDrop(def, s) };
    if (view.seatPoint(id, s, seatAt) === null) continue;
    h.root.position.copy(seatAt);
    h.root.position.y -= 0.88;
    h.root.rotation.y = p.rotY + Math.PI / 2;
    scene.add(h.root);
    people.push(h);
  }
}
const pose = { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0, moveAngle: 0, turn: 0 };
for (let i = 0; i < 60; i++) for (const h of people) h.update(1 / 60, pose);

type Cell = { label: string; camera: THREE.PerspectiveCamera; cut?: THREE.Plane };
const cells: Cell[] = [];
const cam = (label: string, p: PropSpec, local: [number, number, number], look: [number, number, number], fov = 40, cutZ?: number) => {
  const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
  const w = (v: [number, number, number]) => new THREE.Vector3(p.x + v[0] * c + v[2] * s, v[1], p.z - v[0] * s + v[2] * c);
  const camera = new THREE.PerspectiveCamera(fov, 4 / 3, 0.05, 400);
  camera.position.copy(w(local));
  camera.lookAt(w(look));
  // Keeps what is on the far side of local z = cutZ (the near door and glass go).
  const cut = cutZ === undefined ? undefined : new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(s, 0, c), w([0, 0, cutZ]));
  cells.push({ label, camera, cut });
};
/** `?only=truck`: the whole truck from four sides, then into its cab. */
const onlyTruck = new URLSearchParams(location.search).get('only') === 'truck';
for (const i of picks) {
  const p = map.props[i];
  const name = p.kind === 'armoredTruck' ? 'truck' : p.kind === 'policeCar' ? 'police car' : 'car';
  const truck = p.kind === 'armoredTruck';
  if (onlyTruck && !truck) continue;
  if (onlyTruck) {
    cam('truck · side', p, [0, 1.5, -10], [0, 1.4, 0], 36);
    cam('truck · front quarter', p, [8.2, 3.0, -5.6], [0.3, 1.2, 0], 36);
    cam('truck · rear quarter', p, [-8.2, 3.0, -5.6], [-0.3, 1.2, 0], 36);
    cam('truck · from above', p, [-3.5, 8.5, 5.5], [0, 1.4, 0], 36);
  }
  const x = truck ? 2.1 : -0.2;
  cam(`${name} · driver's side, eye height`, p, [x, 1.65, -4.2], [x, 1.0, 0]);
  cam(`${name} · front, above`, p, [truck ? 7.5 : 5.2, truck ? 3.4 : 2.6, -1.4], [x, truck ? 1.3 : 0.8, 0]);
  cam(`${name} · low, under the sill`, p, [x, 0.12, -3.6], [x, 0.25, 0], 50);
  cam(`${name} · cut open down the driver's side`, p, [truck ? 2.2 : -0.1, truck ? 1.6 : 1.0, -3.4], [truck ? 2.2 : -0.1, truck ? 1.25 : 0.65, 0], 40, truck ? -0.85 : -0.8);
}
if (parkedAt >= 0 && !onlyTruck) cam('parked car (scenery)', map.props[parkedAt], [-0.2, 1.65, -4.2], [-0.2, 1.0, 0]);

const cols = Number(new URLSearchParams(location.search).get('cols') ?? 4);
const rows = Math.ceil(cells.length / cols);
const rowH = Math.min(innerHeight / rows, innerWidth / cols / (4 / 3));
const cellW = rowH * (4 / 3);
cells.forEach((c, i) => {
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = c.label;
  el.style.left = `${(i % cols) * cellW + 6}px`;
  el.style.top = `${Math.floor(i / cols) * rowH + 6}px`;
  document.body.append(el);
});

function frame(): void {
  cells.forEach((c, i) => {
    const x = (i % cols) * cellW, y = innerHeight - (Math.floor(i / cols) + 1) * rowH;
    renderer.setViewport(x, y, cellW, rowH);
    renderer.setScissor(x, y, cellW, rowH);
    renderer.clippingPlanes = c.cut ? [c.cut] : [];
    renderer.render(scene, c.camera);
  });
  requestAnimationFrame(frame);
}
frame();
/** Triangles of each vehicle's merged body, for the budgets in docs/art-style.md. */
function bodyTriangles(): number[] {
  const out: number[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry.getAttribute('pbr')) out.push(m.geometry.getAttribute('position').count / 3);
  });
  return out;
}
Object.assign(window, { __carsReady: true, __carTriangles: bodyTriangles });
