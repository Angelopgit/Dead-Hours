import * as THREE from 'three';
import { STORY, houseTop, isBarricadeWindow, type HouseSpec, type MapDefinition } from '@dead-hours/shared';
import type { MaterialLibrary } from '../rendering/Materials';
import type { StaticBatcher } from '../rendering/StaticBatcher';
import { worldBox } from '../rendering/GeometryUtils';

/** Tessellation for large static faces so baked lighting has vertices to live on. */
export const BAKE_CELL = 1.25;
/** The trim band between storeys: how far it stands out of the siding, and its depth into the wall. */
const BAND_OUT = 0.04;
const BAND_DEPTH = 0.12;

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

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface HouseMats {
  trim: THREE.Material;
  soffit: THREE.Material;
  roof: (h: HouseSpec) => THREE.Material;
}

/** Gable roof; `alongZ` puts the ridge along Z (garage), default along X. */
function gable(h: HouseSpec, top: number, lib: MaterialLibrary, batch: StaticBatcher, m: HouseMats, alongZ: boolean): number {
  const oh = 0.55;
  const span = alongZ ? h.w : h.d;
  const len = alongZ ? h.d : h.w;
  const rise = span * 0.34;
  const k = rise / (span / 2);
  // No overhang on a side that abuts another building.
  const skip = new Set(h.skipWalls ?? []);
  const ohLo = alongZ && skip.has('west') ? 0 : oh;
  const ohHi = alongZ && skip.has('east') ? 0 : oh;
  const eaveLo = top - ohLo * k;
  const eaveHi = top - ohHi * k;
  const ridgeY = top + rise;
  // Work in a frame where the ridge runs along local "a" and slopes fall along local "b".
  const P = (a: number, y: number, b: number) => (alongZ ? V(h.x + b, y, h.z + a) : V(h.x + a, y, h.z + b));
  const a0 = -len / 2 - oh, a1 = len / 2 + oh;
  const b0 = -span / 2 - ohLo, b1 = span / 2 + ohHi;
  const roof = m.roof(h);
  // Slopes (winding flips when the frame is mirrored by the axis swap).
  const q = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, mat: THREE.Material, cast = true) =>
    batch.add(alongZ ? quad(p1, p0, p3, p2, 3) : quad(p0, p1, p2, p3, 3), mat, cast);
  q(P(a0, eaveHi, b1), P(a1, eaveHi, b1), P(a1, ridgeY, 0), P(a0, ridgeY, 0), roof);
  q(P(a1, eaveLo, b0), P(a0, eaveLo, b0), P(a0, ridgeY, 0), P(a1, ridgeY, 0), roof);
  q(P(a1, eaveHi - 0.01, b1), P(a0, eaveHi - 0.01, b1), P(a0, ridgeY - 0.12, 0), P(a1, ridgeY - 0.12, 0), m.soffit, false);
  q(P(a0, eaveLo - 0.01, b0), P(a1, eaveLo - 0.01, b0), P(a1, ridgeY - 0.12, 0), P(a0, ridgeY - 0.12, 0), m.soffit, false);
  // Gable ends.
  const siding = lib.get(h.siding);
  const s = siding.texScale;
  const e0 = -len / 2, e1 = len / 2;
  const hb0 = -span / 2, hb1 = span / 2;
  const t = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3) =>
    batch.add(alongZ ? tri(p2, p1, p0, (v) => [v.x / s, v.y / s]) : tri(p0, p1, p2, (v) => [v.z / s, v.y / s]), siding.material);
  t(P(e0, top, hb1), P(e0, ridgeY - 0.02, 0), P(e0, top, hb0));
  t(P(e1, top, hb0), P(e1, ridgeY - 0.02, 0), P(e1, top, hb1));
  // Fascia boards.
  const fasciaLen = a1 - a0;
  for (const [b, eave, o] of [[b0, eaveLo, ohLo], [b1, eaveHi, ohHi]] as const) {
    if (o === 0) continue;
    const c = P(0, eave - 0.08, b);
    batch.add(alongZ ? worldBox(c.x, c.y, c.z, 0.08, 0.2, fasciaLen, 1, null) : worldBox(c.x, c.y, c.z, fasciaLen, 0.2, 0.08, 1, null), m.trim);
  }
  return ridgeY;
}

/** Flat roof with a parapet; storefronts get a lettered fascia. */
function flatRoof(h: HouseSpec, top: number, lib: MaterialLibrary, batch: StaticBatcher, m: HouseMats): void {
  const roof = lib.get('roofFlat');
  batch.add(worldBox(h.x, top + 0.1, h.z, h.w + 0.3, 0.2, h.d + 0.3, roof.texScale, null, BAKE_CELL), roof.material);
  const par = lib.get(h.siding);
  const pt = 0.25, ph = 0.7;
  for (const sz of [-1, 1]) batch.add(worldBox(h.x, top + ph / 2, h.z + sz * (h.d / 2 + 0.15 - pt / 2), h.w + 0.3, ph, pt, par.texScale, null, BAKE_CELL), par.material);
  for (const sx of [-1, 1]) batch.add(worldBox(h.x + sx * (h.w / 2 + 0.15 - pt / 2), top + ph / 2, h.z, pt, ph, h.d + 0.3, par.texScale, null, BAKE_CELL), par.material);
  const frontSign = h.facing === 'south' ? 1 : -1;
  batch.add(worldBox(h.x, top + ph + 0.04, h.z, h.w + 0.36, 0.08, h.d + 0.36, 1, null), m.trim);
  if (h.label) {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = '#7a1612';
    x.fillRect(0, 0, 1024, 128);
    x.fillStyle = '#f6efe0';
    x.font = '700 92px Oswald, Impact, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(h.label, 512, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = lib.custom(`fascia-${h.id}`, () => new THREE.MeshStandardMaterial({
      map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9, roughness: 0.6,
    }));
    sign.userData.noBake = true;
    const z = h.z + frontSign * (h.d / 2 + 0.19);
    batch.add(worldBox(h.x, top - 0.45, z, h.w * 0.62, 0.75, 0.06, 1, null), sign, false);
  }
}

/** Visual dressing for houses: closed-house shells, roofs, trim, windows and doors. */
export function dressHouses(map: MapDefinition, lib: MaterialLibrary, batch: StaticBatcher): void {
  const trim = lib.get('trim').material;
  const darkWood = lib.standard(0x2e241c, 0.75);
  const darkGlass = lib.custom('glass-dark', () => new THREE.MeshStandardMaterial({
    color: 0x0d1218, roughness: 0.12, metalness: 0.75, envMapIntensity: 0.6,
  }));
  darkGlass.userData.envMap = true;
  const clearGlass = lib.custom('glass-clear', () => new THREE.MeshStandardMaterial({
    color: 0x9fb4c8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.18, depthWrite: false,
  }));
  clearGlass.userData.envMap = true;
  const warm = lib.custom('window-warm', () => new THREE.MeshStandardMaterial({
    color: 0x1a120a, emissive: 0xffa456, emissiveIntensity: 1.6, roughness: 0.9,
  }));
  const warmDim = lib.custom('window-warm-dim', () => new THREE.MeshStandardMaterial({
    color: 0x120c08, emissive: 0xd0782f, emissiveIntensity: 0.7, roughness: 0.9,
  }));
  warm.userData.noBake = warmDim.userData.noBake = true;
  const curtain = lib.standard(0x3b2f2a, 0.95);
  const chimney = lib.get('brick');
  const mats: HouseMats = {
    trim,
    soffit: lib.standard(0x1f1c19, 0.95),
    roof: (h) => lib.custom(`roof-${h.roofColor}`, () => new THREE.MeshStandardMaterial({
      color: h.roofColor, roughness: 0.92, map: lib.textures.roof, vertexColors: true,
    })),
  };

  for (const h of map.houses) {
    const top = houseTop(h);
    const slab = h.slab ?? STORY.slab;
    const ground = h.groundHeight ?? STORY.ground;
    const siding = lib.get(h.siding);
    const skip = new Set(h.skipWalls ?? []);

    if (!h.enterable) {
      // Shell walls for closed houses (collision is a single invisible box from the shared map).
      batch.add(worldBox(h.x, slab + (top - slab) / 2, h.z, h.w - 0.02, top - slab, h.d - 0.02, siding.texScale, { groundY: slab, strength: 0.4 }, BAKE_CELL), siding.material);
    }
    if (h.floors === 2) {
      // Band between the storeys: four strips sunk into the walls' siding. (One box over the whole
      // footprint used to hide inside the floor and show as a slab over the stairwell.)
      const y = slab + ground + STORY.floorThickness / 2;
      for (const s of [-1, 1]) {
        batch.add(worldBox(h.x, y, h.z + s * (h.d / 2 - BAND_DEPTH / 2 + BAND_OUT), h.w + BAND_OUT * 2, 0.22, BAND_DEPTH, 1, null), trim);
        batch.add(worldBox(h.x + s * (h.w / 2 - BAND_DEPTH / 2 + BAND_OUT), y, h.z, BAND_DEPTH, 0.22, h.d + BAND_OUT * 2, 1, null), trim);
      }
    }
    // Corner boards (not on walls shared with a neighbour).
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if ((sx < 0 && skip.has('west')) || (sx > 0 && skip.has('east'))) continue;
      batch.add(worldBox(h.x + sx * (h.w / 2), (slab + top) / 2, h.z + sz * (h.d / 2), 0.16, top - slab, 0.16, 1, null), trim);
    }

    const roofKind = h.roof ?? 'gable-x';
    if (roofKind === 'flat') {
      flatRoof(h, top, lib, batch, mats);
    } else {
      const ridgeY = gable(h, top, lib, batch, mats, roofKind === 'gable-z');
      if (roofKind === 'gable-x' && h.seed % 2 === 1) {
        const rise = h.d * 0.34;
        const cx = h.x - h.w * 0.28;
        batch.add(worldBox(cx, ridgeY - 0.2, h.z - h.d * 0.12, 0.9, rise + 1.4, 0.9, chimney.texScale, null), chimney.material);
      }
    }

    // Front porch: step and a small roof over a wooden front door.
    const frontSign = h.facing === 'south' ? 1 : -1;
    const frontDoor = map.doors.find((d) => d.houseId === h.id && d.exterior && d.outward === frontSign && d.axis === 'x' && (d.style ?? 'wood') === 'wood');
    if (frontDoor && roofKind === 'gable-x') {
      const pz = h.z + frontSign * (h.d / 2 + 0.9);
      batch.add(worldBox(frontDoor.x, 0.12, pz, frontDoor.w + 1.6, 0.24, 1.8, 3, null), lib.get('concrete').material);
      batch.add(worldBox(frontDoor.x, 2.95, pz - frontSign * 0.05, frontDoor.w + 1.8, 0.12, 1.9, 1, null), trim);
      for (const sx of [-1, 1]) {
        batch.add(worldBox(frontDoor.x + sx * (frontDoor.w / 2 + 0.8), 1.55, pz + frontSign * 0.75, 0.14, 2.7, 0.14, 1, null), trim);
      }
    }
  }

  // Windows.
  for (const w of map.windows) {
    const house = map.houses.find((h) => h.id === w.houseId)!;
    const along = w.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const out = w.axis === 'x' ? new THREE.Vector3(0, 0, w.outward) : new THREE.Vector3(w.outward, 0, 0);
    const surface = house.enterable ? STORY.wall / 2 : 0.01;
    const c = new THREE.Vector3(w.x, w.y, w.z);
    const frameAt = (offAlong: number, offY: number, lenAlong: number, lenY: number, depth: number, push: number) => {
      const p = c.clone().addScaledVector(along, offAlong).addScaledVector(out, push);
      const sx = w.axis === 'x' ? lenAlong : depth;
      const sz = w.axis === 'x' ? depth : lenAlong;
      return worldBox(p.x, p.y + offY, p.z, sx, lenY, sz, 1, null);
    };
    const ft = w.plain ? 0.06 : 0.09;
    const push = surface + 0.02;
    const frame = w.plain ? lib.standard(0x2a2c2e, 0.5, 0.6) : trim;
    batch.add(frameAt(0, w.h / 2 + ft / 2, w.w + ft * 2, ft, 0.1, push), frame);
    batch.add(frameAt(0, -w.h / 2 - 0.04, w.w + ft * 3, 0.08, 0.18, push + 0.03), frame);
    batch.add(frameAt(-w.w / 2 - ft / 2, 0, ft, w.h, 0.1, push), frame);
    batch.add(frameAt(w.w / 2 + ft / 2, 0, ft, w.h, 0.1, push), frame);
    if (w.plain) {
      batch.add(frameAt(0, 0, 0.05, w.h, 0.06, 0), frame, false);
    } else {
      batch.add(frameAt(0, 0, 0.045, w.h, 0.05, house.enterable ? 0.0 : push - 0.01), trim, false);
      batch.add(frameAt(0, w.h * 0.08, w.w, 0.045, 0.05, house.enterable ? 0.0 : push - 0.01), trim, false);
    }
    const glassPush = house.enterable ? 0 : 0.015;
    const pane = frameAt(0, 0, w.w, w.h, 0.02, glassPush);
    if (house.enterable) {
      // Panes that can be smashed are drawn by the barricades, which take them out when they break.
      if (!isBarricadeWindow(house, w)) batch.add(pane, clearGlass, false, false);
    } else if (w.lit) {
      batch.add(pane, (w.x * 7 + w.z * 3) % 2 > 1 ? warm : warmDim, false, false);
      batch.add(frameAt(-w.w * 0.32, 0, w.w * 0.34, w.h, 0.03, glassPush + 0.01), curtain, false);
    } else {
      batch.add(pane, darkGlass, false);
    }
  }

  // Inside window trim of enterable buildings: casing, a stool to rest on and the apron under it.
  const metalFrame = lib.standard(0x2a2c2e, 0.5, 0.6);
  for (const w of map.windows) {
    const house = map.houses.find((h) => h.id === w.houseId)!;
    if (!house.enterable) continue;
    const inward = w.axis === 'x' ? new THREE.Vector3(0, 0, -w.outward) : new THREE.Vector3(-w.outward, 0, 0);
    const along = w.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const at = (offAlong: number, offY: number, lenAlong: number, lenY: number, depth: number, push: number) => {
      const p = new THREE.Vector3(w.x, w.y + offY, w.z).addScaledVector(along, offAlong).addScaledVector(inward, push);
      return w.axis === 'x' ? worldBox(p.x, p.y, p.z, lenAlong, lenY, depth, 1, null) : worldBox(p.x, p.y, p.z, depth, lenY, lenAlong, 1, null);
    };
    const face = STORY.wall / 2;
    const cw = w.plain ? 0.05 : 0.08;
    const frame = w.plain ? metalFrame : trim;
    batch.add(at(0, w.h / 2 + cw / 2, w.w + cw * 2, cw, 0.024, face + 0.012), frame);
    for (const sx of [-1, 1]) batch.add(at(sx * (w.w / 2 + cw / 2), 0, cw, w.h, 0.024, face + 0.012), frame);
    if (w.plain) {
      batch.add(at(0, -w.h / 2 - cw / 2, w.w + cw * 2, cw, 0.024, face + 0.012), frame);
      continue;
    }
    batch.add(at(0, -w.h / 2 - 0.02, w.w + cw * 2 + 0.08, 0.04, 0.16, face + 0.05), trim);
    batch.add(at(0, -w.h / 2 - 0.1, w.w + cw * 2, 0.12, 0.02, face + 0.01), trim);
  }

  // Interior doorways: casings on both faces of the partition (the openings have no leaves).
  for (const d of map.doors) {
    if (d.exterior) continue;
    const house = map.houses.find((h) => h.id === d.houseId)!;
    if (!house.enterable) continue;
    const floor = d.floorY ?? d.y - d.h / 2;
    for (const side of [-1, 1]) {
      const n = 0.07 + 0.012;
      const cx = d.axis === 'x' ? d.x : d.x + side * n;
      const cz = d.axis === 'x' ? d.z + side * n : d.z;
      const box = (offAlong: number, y: number, lenAlong: number, lenY: number) => d.axis === 'x'
        ? worldBox(cx + offAlong, y, cz, lenAlong, lenY, 0.024, 1, null)
        : worldBox(cx, y, cz + offAlong, 0.024, lenY, lenAlong, 1, null);
      batch.add(box(0, floor + d.h + 0.045, d.w + 0.18, 0.09), trim);
      for (const sx of [-1, 1]) batch.add(box(sx * (d.w / 2 + 0.045), floor + d.h / 2, 0.09, d.h), trim);
    }
  }

  // Exterior door frames (leaves of enterable houses are dynamic, see Doors.ts).
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
    const frame = d.style === 'glass' || d.style === 'rollup' ? metalFrame : trim;
    batch.add(box(0, d.h / 2 + 0.06, d.w + 0.24, 0.12, 0.12), frame);
    batch.add(box(-d.w / 2 - 0.06, 0, 0.12, d.h, 0.12), frame);
    batch.add(box(d.w / 2 + 0.06, 0, 0.12, d.h, 0.12), frame);
    if (!house.enterable) {
      batch.add(box(0, 0, d.w, d.h, 0.05), darkWood);
      continue;
    }
    // Casing on the inside face too.
    const inside = c.clone().addScaledVector(out, -(push + STORY.wall / 2 + 0.012));
    const ibox = (offAlong: number, offY: number, lenAlong: number, lenY: number) => d.axis === 'x'
      ? worldBox(inside.x + offAlong, inside.y + offY, inside.z, lenAlong, lenY, 0.024, 1, null)
      : worldBox(inside.x, inside.y + offY, inside.z + offAlong, 0.024, lenY, lenAlong, 1, null);
    batch.add(ibox(0, d.h / 2 + 0.05, d.w + 0.2, 0.1), frame);
    for (const sx of [-1, 1]) batch.add(ibox(sx * (d.w / 2 + 0.05), 0, 0.1, d.h), frame);
  }
}
