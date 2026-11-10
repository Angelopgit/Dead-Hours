/**
 * Dev-only look at blood drying: the same spatter and pool five times over, each older than the
 * one before (the ages are on the labels), on a street lit like a flashlight would light it, seen
 * from a standing survivor's eye. `?day=1` lights it evenly. Not part of the game build.
 */
import * as THREE from 'three';
import { DECAL, DecalBatch } from '../src/effects/Decals';

const AGES = [70, 40, 20, 8, 0];
const day = new URLSearchParams(location.search).get('day') === '1';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(day ? 0x5d6b7a : 0x05070a);
scene.add(new THREE.HemisphereLight(0xc8d4e4, 0x3a3226, day ? 1.6 : 0.12));
if (day) {
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
  sun.position.set(-3, 6, 4);
  scene.add(sun);
}
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 100);
// `?close=1`: down on one knee by the 20 and 8 second old ones (no labels: they are placed for the standing view).
const close = new URLSearchParams(location.search).get('close') === '1';
if (close) {
  camera.position.set(0.9, 0.9, -1.6);
  camera.lookAt(1.2, 0, -3.8);
} else {
  camera.position.set(0, 1.6, 0);
  camera.lookAt(0, 0, -4.2);
}
if (!day) {
  const torch = new THREE.SpotLight(0xfff0dc, 45, 30, 0.95, 0.7, 1.2);
  torch.position.set(0.2, 1.4, 0.2);
  torch.target.position.set(0, 0, -4.4);
  scene.add(torch, torch.target);
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x4c4c4a, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 4), new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.9 }));
wall.position.set(0, 2, -7);
scene.add(wall);

const decals = new DecalBatch(64);
scene.add(decals.mesh);
const UP = new THREE.Vector3(0, 1, 0), OUT = new THREE.Vector3(0, 0, 1), ALONG = new THREE.Vector3(1, 0, -0.4);
const BLOOD: [number, number, number] = [0.34, 0.03, 0.025];
let clock = 0;
AGES.forEach((age, i) => {
  // Oldest first: the clock runs on between them, so each is `age` old when the last has landed.
  const wait = AGES[0] - age - clock;
  for (let t = 0; t < wait; t += 0.5) decals.update(0.5);
  clock += wait;
  const x = (i - (AGES.length - 1) / 2) * 1.5;
  decals.add(DECAL.pool, new THREE.Vector3(x, 0, -3.4), UP, 1.0, BLOOD[0] * 0.85, BLOOD[1], BLOOD[2], 0.9, 400, 0, undefined, 60);
  decals.add(DECAL.splat, new THREE.Vector3(x, 0, -5.2), UP, 0.9, BLOOD[0], BLOOD[1], BLOOD[2], 0.92, 400, 0, ALONG, 22);
  decals.add(DECAL.splat, new THREE.Vector3(x, 1.5, -6.99), OUT, 0.9, BLOOD[0], BLOOD[1], BLOOD[2], 0.92, 400, 0, ALONG, 22);
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = `${age} s old`;
  el.style.left = `${((i + 0.5) / AGES.length) * 100 - 3}%`;
  el.style.bottom = '8px';
  if (!close) document.body.append(el);
});
decals.update(0);
renderer.render(scene, camera);
Object.assign(window, { __bloodReady: true });
