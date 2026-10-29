import * as THREE from 'three';
import { STORY, type HouseSpec, type MapDefinition } from '@dead-hours/shared';
import type { MaterialLibrary } from '../rendering/Materials';
import type { StaticBatcher } from '../rendering/StaticBatcher';
import { worldBox } from '../rendering/GeometryUtils';

/** Quad from four corners (counter-clockwise when viewed from the front) with metric UVs. */
function quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, texScale: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const ab = a.distanceTo(b) / texScale;
  const ad = a.distanceTo(d) / texScale;
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray()], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, ab, 0, ab, ad, 0, 0, ab, ad, 0, ad], 2));
  g.computeVertexNormals();
  return g;
}

function tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, uvOf: (v: THREE.Vector3) => [number, number]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray(), ...c.toArray()], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([...uvOf(a), ...uvOf(b), ...uvOf(c)], 2));
  g.computeVertexNormals();
  return g;
}

export function wallTopY(h: HouseSpec): number {
  return h.floors === 2
    ? STORY.slab + STORY.ground + STORY.floorThickness + STORY.upper
    : STORY.slab + STORY.ground;
}

/** Visual dressing for houses: closed-house shells, gable roofs, trim, windows and doors. */
export function dressHouses(map: MapDefinition, lib: MaterialLibrary, batch: StaticBatcher): void {
  const trim = lib.get('trim').material;
  const darkWood = lib.standard(0x2e241c, 0.75);
  const darkGlass = lib.custom('glass-dark', () => new THREE.MeshStandardMaterial({
    color: 0x0d1218, roughness: 0.12, metalness: 0.75, envMapIntensity: 0.6,
  }));
  const clearGlass = lib.custom('glass-clear', () => new THREE.MeshStandardMaterial({
    color: 0x9fb4c8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.18, depthWrite: false,
  }));
  const warm = lib.custom('window-warm', () => new THREE.MeshStandardMaterial({
    color: 0x1a120a, emissive: 0xffa456, emissiveIntensity: 1.6, roughness: 0.9,
  }));
  const warmDim = lib.custom('window-warm-dim', () => new THREE.MeshStandardMaterial({
    color: 0x120c08, emissive: 0xd0782f, emissiveIntensity: 0.7, roughness: 0.9,
  }));
  const curtain = lib.standard(0x3b2f2a, 0.95);
  const chimney = lib.get('brick');

  for (const h of map.houses) {
    const top = wallTopY(h);
    const siding = lib.get(h.siding);

    if (!h.enterable) {
      // Shell walls for closed houses (collision is a single invisible box from the shared map).
      batch.add(worldBox(h.x, STORY.slab + (top - STORY.slab) / 2, h.z, h.w - 0.02, top - STORY.slab, h.d - 0.02, siding.texScale), siding.material);
    }
    if (h.floors === 2) {
      // Floor band trim between storeys.
      const y = STORY.slab + STORY.ground + STORY.floorThickness / 2;
      batch.add(worldBox(h.x, y, h.z, h.w + 0.08, 0.22, h.d + 0.08, 1, null), trim);
    }
    // Corner boards.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      batch.add(worldBox(h.x + sx * (h.w / 2), (STORY.slab + top) / 2, h.z + sz * (h.d / 2), 0.16, top - STORY.slab, 0.16, 1, null), trim);
    }

    // Gable roof, ridge along X.
    const oh = 0.55;
    const rise = h.d * 0.34;
    const x0 = h.x - h.w / 2 - oh;
    const x1 = h.x + h.w / 2 + oh;
    const zf = h.z + h.d / 2 + oh;
    const zb = h.z - h.d / 2 - oh;
    const eaveY = top - oh * (rise / (h.d / 2));
    const ridgeY = top + rise;
    const roofMat = lib.custom(`roof-${h.roofColor}`, () => new THREE.MeshStandardMaterial({
      color: h.roofColor, roughness: 0.92, map: lib.textures.roof, vertexColors: true,
    }));
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    batch.add(quad(V(x0, eaveY, zf), V(x1, eaveY, zf), V(x1, ridgeY, h.z), V(x0, ridgeY, h.z), 3), roofMat);
    batch.add(quad(V(x1, eaveY, zb), V(x0, eaveY, zb), V(x0, ridgeY, h.z), V(x1, ridgeY, h.z), 3), roofMat);
    // Roof underside (soffit) so the roof reads from below and from inside the safehouse.
    const soffit = lib.standard(0x1f1c19, 0.95);
    batch.add(quad(V(x1, eaveY - 0.01, zf), V(x0, eaveY - 0.01, zf), V(x0, ridgeY - 0.12, h.z), V(x1, ridgeY - 0.12, h.z), 3), soffit, false);
    batch.add(quad(V(x0, eaveY - 0.01, zb), V(x1, eaveY - 0.01, zb), V(x1, ridgeY - 0.12, h.z), V(x0, ridgeY - 0.12, h.z), 3), soffit, false);
    // Gable ends.
    const ex0 = h.x - h.w / 2;
    const ex1 = h.x + h.w / 2;
    const hz0 = h.z - h.d / 2;
    const hz1 = h.z + h.d / 2;
    const s = siding.texScale;
    batch.add(tri(V(ex0, top, hz1), V(ex0, ridgeY - 0.02, h.z), V(ex0, top, hz0), (v) => [v.z / s, v.y / s]), siding.material);
    batch.add(tri(V(ex1, top, hz0), V(ex1, ridgeY - 0.02, h.z), V(ex1, top, hz1), (v) => [-v.z / s, v.y / s]), siding.material);
    // Fascia boards.
    batch.add(worldBox(h.x, eaveY - 0.08, zf, x1 - x0, 0.2, 0.08, 1, null), trim);
    batch.add(worldBox(h.x, eaveY - 0.08, zb, x1 - x0, 0.2, 0.08, 1, null), trim);
    // Chimney on some houses.
    if (h.seed % 2 === 1) {
      const cx = h.x - h.w * 0.28;
      batch.add(worldBox(cx, ridgeY - 0.2, h.z - h.d * 0.12, 0.9, rise + 1.4, 0.9, chimney.texScale, null), chimney.material);
    }

    // Front porch: step and a small roof over the door.
    const frontSign = h.facing === 'south' ? 1 : -1;
    const frontDoor = map.doors.find((d) => d.houseId === h.id && d.exterior && d.outward === frontSign && d.axis === 'x');
    if (frontDoor) {
      const pz = h.z + frontSign * (h.d / 2 + 0.9);
      batch.add(worldBox(frontDoor.x, 0.12, pz, frontDoor.w + 1.6, 0.24, 1.8, 3, null), lib.get('concrete').material);
      batch.add(worldBox(frontDoor.x, 2.95, pz - frontSign * 0.05, frontDoor.w + 1.8, 0.12, 1.9, 1, null), trim);
      for (const sx of [-1, 1]) {
        batch.add(worldBox(frontDoor.x + sx * (frontDoor.w / 2 + 0.8), 1.55, pz + frontSign * 0.75, 0.14, 2.7, 0.14, 1, null), trim);
      }
    }
  }

  // Windows and doors.
  for (const w of map.windows) {
    const house = map.houses.find((h) => h.id === w.houseId)!;
    const along = w.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const out = w.axis === 'x' ? new THREE.Vector3(0, 0, w.outward) : new THREE.Vector3(w.outward, 0, 0);
    // Closed houses: windows sit on the shell surface. Enterable: inside the wall opening.
    const surface = house.enterable ? STORY.wall / 2 : 0.01;
    const c = new THREE.Vector3(w.x, w.y, w.z).addScaledVector(out, house.enterable ? 0 : 0);
    const frameAt = (offAlong: number, offY: number, lenAlong: number, lenY: number, depth: number, push: number) => {
      const p = c.clone().addScaledVector(along, offAlong).addScaledVector(out, push);
      const sx = w.axis === 'x' ? lenAlong : depth;
      const sz = w.axis === 'x' ? depth : lenAlong;
      return worldBox(p.x, p.y + offY, p.z, sx, lenY, sz, 1, null);
    };
    const ft = 0.09;
    const push = surface + 0.02;
    batch.add(frameAt(0, w.h / 2 + ft / 2, w.w + ft * 2, ft, 0.1, push), trim);
    batch.add(frameAt(0, -w.h / 2 - 0.04, w.w + ft * 3, 0.08, 0.18, push + 0.03), trim);
    batch.add(frameAt(-w.w / 2 - ft / 2, 0, ft, w.h, 0.1, push), trim);
    batch.add(frameAt(w.w / 2 + ft / 2, 0, ft, w.h, 0.1, push), trim);
    // Mullions.
    batch.add(frameAt(0, 0, 0.045, w.h, 0.05, house.enterable ? 0.0 : push - 0.01), trim, false);
    batch.add(frameAt(0, w.h * 0.08, w.w, 0.045, 0.05, house.enterable ? 0.0 : push - 0.01), trim, false);
    // Glass.
    const glassPush = house.enterable ? 0 : 0.015;
    const pane = frameAt(0, 0, w.w, w.h, 0.02, glassPush);
    if (house.enterable) {
      batch.add(pane, clearGlass, false, false);
    } else if (w.lit) {
      batch.add(pane, (w.x * 7 + w.z * 3) % 2 > 1 ? warm : warmDim, false, false);
      // Half-drawn curtain silhouettes.
      batch.add(frameAt(-w.w * 0.32, 0, w.w * 0.34, w.h, 0.03, glassPush + 0.01), curtain, false);
    } else {
      batch.add(pane, darkGlass, false);
    }
  }

  for (const d of map.doors) {
    const house = map.houses.find((h) => h.id === d.houseId)!;
    if (!d.exterior) continue;
    const out = d.axis === 'x' ? new THREE.Vector3(0, 0, d.outward) : new THREE.Vector3(d.outward, 0, 0);
    const push = house.enterable ? STORY.wall / 2 + 0.03 : 0.04;
    const c = new THREE.Vector3(d.x, d.y, d.z).addScaledVector(out, push);
    const box = (offAlong: number, offY: number, lenAlong: number, lenY: number, depth: number) => {
      const p = c.clone();
      if (d.axis === 'x') p.x += offAlong; else p.z += offAlong;
      return d.axis === 'x'
        ? worldBox(p.x, p.y + offY, p.z, lenAlong, lenY, depth, 1, null)
        : worldBox(p.x, p.y + offY, p.z, depth, lenY, lenAlong, 1, null);
    };
    batch.add(box(0, d.h / 2 + 0.06, d.w + 0.24, 0.12, 0.12), trim);
    batch.add(box(-d.w / 2 - 0.06, 0, 0.12, d.h, 0.12), trim);
    batch.add(box(d.w / 2 + 0.06, 0, 0.12, d.h, 0.12), trim);
    if (!house.enterable) {
      batch.add(box(0, 0, d.w, d.h, 0.05), darkWood);
    }
  }
}
