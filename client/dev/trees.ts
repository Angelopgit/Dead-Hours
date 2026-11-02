/**
 * Dev-only tree lineup: /dev/trees.html renders every tree model (maples, pines, shrubs) in a row
 * under the night rig (moon with shadows, hemisphere, a street lamp), fog and wind, through the
 * real Trees system (levels of detail, impostors). `tier=high|medium|low`, `cam=x,y,z`,
 * `look=x,y,z`, `wind=2.6` (gust strength), `t=12` (wind time, paused), `lod=0|1|2` forces a level
 * (shifts the LOD bands so every tree is drawn at it), `forest=1` adds a patch of woods behind,
 * `fog=0.022`, `wet=1` (rain-soaked). window.__trees exposes { renderer, scene, camera, trees, render(t) }.
 * Not part of the game build.
 */
import * as THREE from 'three';
import type { MapDefinition, PropSpec } from '@dead-hours/shared';
import { Trees, type TreeTier } from '../src/environment/trees/Trees';
import { treeUniforms } from '../src/environment/trees/TreeMaterials';
import { updateWind } from '../src/environment/Wind';
import { MOON_DIR } from '../src/lighting/Lighting';
import { weatherUniforms } from '../src/lighting/WetShader';

const q = new URLSearchParams(location.search);
const tier = (q.get('tier') ?? 'high') as TreeTier;
const vec = (s: string | null, d: [number, number, number]) => (s ? (s.split(',').map(Number) as [number, number, number]) : d);
const camAt = vec(q.get('cam'), [0, 3.2, 17]);
const lookAt = vec(q.get('look'), [0, 3.6, 0]);
const wind = Number(q.get('wind') ?? 1.4);
const fixedT = q.get('t');
const lod = q.get('lod');
weatherUniforms.uWetness.value = Number(q.get('wet') ?? 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.45;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x252e3c);
scene.fog = new THREE.FogExp2(0x252e3c, Number(q.get('fog') ?? 0.022));
scene.add(new THREE.HemisphereLight(0x4a5a78, 0x1c1e16, 1.0));
const moon = new THREE.DirectionalLight(0x9db2d4, 1.35);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
Object.assign(moon.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 160 });
moon.shadow.bias = -0.0004;
moon.shadow.normalBias = 0.04;
moon.position.copy(MOON_DIR).multiplyScalar(80);
scene.add(moon, moon.target);
const lamp = new THREE.PointLight(0xffc27a, 60, 16, 2);
lamp.position.set(-4.5, 6.5, 3);
scene.add(lamp);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x2c3326, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const props: PropSpec[] = [];
const row: [PropSpec['kind'], number][] = [['tree', 0], ['tree', 1], ['tree', 2], ['pine', 0], ['pine', 1], ['pine', 2], ['bush', 0], ['bush', 1]];
row.forEach(([kind, v], i) => props.push({ kind, x: (i - 3.5) * 5.6, z: kind === 'bush' ? 4 : 0, rotY: i * 1.3, variant: v } as PropSpec));
if (q.get('forest')) {
  for (let i = 0; i < 160; i++) {
    const x = ((i * 37) % 23 - 11) * 5.2 + Math.sin(i) * 1.5, z = -14 - Math.floor(i / 12) * 5.2 + Math.cos(i * 3) * 1.5;
    props.push({ kind: 'pine', x, z, rotY: i, variant: i % 6, forest: true } as PropSpec);
  }
}
const map = { props } as unknown as MapDefinition;
const trees = new Trees(map, tier);
scene.add(trees.root);
trees.setShadows(true);
trees.prepare(renderer);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.08, 400);
camera.position.set(...camAt);
camera.lookAt(...lookAt);

function forceLod(): void {
  if (lod === null) return;
  const b = treeUniforms.uLodBand.value;
  const k = Number(lod);
  for (let i = 0; i < b.length; i++) b[i].set(-2, -1, 1e5, 1e5 + 1);
  // Hide the other levels: a band that ends before 0 never shows.
  for (const i of [0, 1, 2]) if (i !== k) b[i].set(-2, -1, -1, -0.5);
  for (const i of [5, 6, 7]) if (i - 5 !== k) b[i].set(-2, -1, -1, -0.5);
  for (const i of [3, 4]) if (i - 3 !== Math.min(k, 1)) b[i].set(-2, -1, -1, -0.5);
}
forceLod();

const info = document.getElementById('info')!;
let t = 0;
function render(at?: number): void {
  if (at !== undefined) t = at;
  updateWind(t, new THREE.Vector3(1.2, 0, 0.5), wind);
  trees.update(camera);
  renderer.render(scene, camera);
  const s = trees.stats();
  info.textContent = `tier ${tier}  near ${s.near}  mid ${s.mid}  impostor ${s.impostor}  draws ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`;
}
const clock = new THREE.Timer();
function loop(): void {
  clock.update();
  if (fixedT === null) t += clock.getDelta();
  render();
  requestAnimationFrame(loop);
}
if (fixedT !== null) render(Number(fixedT));
else loop();
Object.assign(window, { __trees: { renderer, scene, camera, trees, render, THREE } });
