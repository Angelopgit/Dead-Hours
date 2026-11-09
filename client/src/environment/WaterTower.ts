import * as THREE from 'three';
import { WATER_TOWER } from '@dead-hours/shared';
import { worldPieces } from './WorldPieces';
import type { MaterialLibrary } from '../rendering/Materials';
import type { StaticBatcher } from '../rendering/StaticBatcher';
import type { Updatable } from './props/Kit';

/** The tank's paint: off-white steel, the town's name in tall letters on all four sides, rust running down from the seams. */
function tankTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 512;
  const x = c.getContext('2d')!;
  x.fillStyle = '#b9b6aa';
  x.fillRect(0, 0, c.width, c.height);
  // Plates: faint seams every eighth of the way round and two rings.
  x.strokeStyle = 'rgba(40, 38, 34, 0.35)';
  x.lineWidth = 3;
  for (let i = 0; i < 8; i++) {
    x.beginPath();
    x.moveTo(i * 256 + 2, 0);
    x.lineTo(i * 256 + 2, 512);
    x.stroke();
  }
  for (const y of [150, 362]) {
    x.beginPath();
    x.moveTo(0, y);
    x.lineTo(2048, y);
    x.stroke();
  }
  x.fillStyle = '#2f3336';
  x.font = '800 210px "Big Shoulders Display", Impact, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  for (const u of [256, 768, 1280, 1792]) x.fillText('VESPER', u, 262, 430);
  // Rust: streaks from the rim and the seams, heavier toward the bottom.
  let s = 9173;
  const r = () => ((s = (s * 16807) % 2147483647) & 0xffff) / 0xffff;
  for (let i = 0; i < 420; i++) {
    const u = r() * 2048, top = r() < 0.5 ? 0 : [150, 362][Math.floor(r() * 2)];
    const len = 40 + r() * 220, w = 2 + r() * 9;
    const g = x.createLinearGradient(0, top, 0, top + len);
    g.addColorStop(0, `rgba(96, 52, 26, ${0.2 + r() * 0.3})`);
    g.addColorStop(1, 'rgba(96, 52, 26, 0)');
    x.fillStyle = g;
    x.fillRect(u, top, w, len);
  }
  for (let i = 0; i < 900; i++) {
    x.fillStyle = `rgba(30, 26, 22, ${r() * 0.1})`;
    x.fillRect(r() * 2048, r() * 512, 3 + r() * 10, 3 + r() * 10);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 5): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/**
 * Everything of the water tower but its legs and riser (those are map solids): the tank and its
 * roof, the catwalk, the bracing between the legs, the ladder. All static, in the world batch.
 * Returns the beacon on top, which blinks.
 */
export function buildWaterTower(lib: MaterialLibrary, batch: StaticBatcher, scene: THREE.Object3D): Updatable {
  const t = WATER_TOWER;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(t.x + x, y, t.z + z);
  const steel = lib.standard(0x4a4e52, 0.6, 0.5);
  const paint = lib.custom('water-tank', () => new THREE.MeshStandardMaterial({ map: tankTexture(), roughness: 0.7, metalness: 0.15, vertexColors: true }));
  const roofPaint = lib.standard(0x8f8c82, 0.7, 0.2, false);
  const h = t.tankTop - t.tankY;

  // The tank, its shallow cone of a roof, and the dished bottom.
  const tank = new THREE.CylinderGeometry(t.radius, t.radius, h, 32, 3, true);
  // Turned an eighth so each name faces a compass point and the texture's seam a corner.
  tank.rotateY(Math.PI / 4);
  tank.translate(t.x, t.tankY + h / 2, t.z);
  batch.add(tank, paint);
  const roof = new THREE.ConeGeometry(t.radius + 0.12, 1.7, 32, 1, true);
  roof.translate(t.x, t.tankTop + 0.85, t.z);
  batch.add(roof, roofPaint);
  const bottom = new THREE.ConeGeometry(t.radius, 1.5, 32, 1, true);
  bottom.rotateX(Math.PI);
  bottom.translate(t.x, t.tankY - 0.75, t.z);
  batch.add(bottom, roofPaint);
  const vent = new THREE.CylinderGeometry(0.25, 0.3, 0.5, 8);
  vent.translate(t.x, t.tankTop + 1.9, t.z);
  batch.add(vent, steel);

  // The catwalk round the tank's foot, with its rail.
  const walkR = t.radius + 0.75;
  const walk = new THREE.RingGeometry(t.radius - 0.05, walkR, 32, 1);
  walk.rotateX(-Math.PI / 2);
  walk.translate(t.x, t.tankY + 0.1, t.z);
  batch.add(walk, lib.custom('water-walk', () => new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.7, metalness: 0.5, side: THREE.DoubleSide, vertexColors: true })));
  for (const y of [0.6, 1.1]) {
    const rail = new THREE.TorusGeometry(walkR, 0.03, 4, 32);
    rail.rotateX(Math.PI / 2);
    rail.translate(t.x, t.tankY + 0.1 + y, t.z);
    batch.add(rail, steel, false);
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    batch.add(rod(V(Math.cos(a) * walkR, t.tankY + 0.1, Math.sin(a) * walkR), V(Math.cos(a) * walkR, t.tankY + 1.2, Math.sin(a) * walkR), 0.025, 4), steel, false);
  }

  // Bracing: a ring of struts at each level and a cross in every bay between the legs.
  const levels = [0.35, 5.4, 10.4, t.tankY];
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const A = (y: number) => V(ax * t.spread, y, az * t.spread), B = (y: number) => V(bx * t.spread, y, bz * t.spread);
    for (let l = 1; l < levels.length; l++) {
      batch.add(rod(A(levels[l] - 0.1), B(levels[l] - 0.1), 0.07), steel);
      batch.add(rod(A(levels[l - 1] + 0.1), B(levels[l] - 0.2), 0.035, 4), steel);
      batch.add(rod(B(levels[l - 1] + 0.1), A(levels[l] - 0.2), 0.035, 4), steel);
    }
  }
  // The ladder up the riser's south side, caged near the top.
  const lz = t.riser + 0.12;
  for (const sx of [-0.22, 0.22]) batch.add(rod(V(sx, 0.4, lz), V(sx, t.tankY + 1.2, lz), 0.02, 4), steel, false);
  for (let y = 0.7; y < t.tankY + 1.1; y += 0.4) batch.add(rod(V(-0.22, y, lz), V(0.22, y, lz), 0.014, 3), steel, false);

  // The beacon: a red lamp that blinks, so the tower shows through the fog.
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x1a0504, emissive: 0xff2a1a, emissiveIntensity: 0 });
  lampMat.name = 'water-beacon';
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), lampMat);
  lamp.position.set(t.x, t.tankTop + 2.3, t.z);
  lamp.name = 'water-beacon';
  scene.add(lamp);
  return {
    update: (_dt, time) => {
      // Down with the tower.
      lamp.visible = !worldPieces.fallen.has('water-tower');
      lampMat.emissiveIntensity = (time % 2.4) < 0.9 ? 14 : 0.3;
    },
  };
}
