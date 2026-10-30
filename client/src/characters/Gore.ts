import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '@dead-hours/shared';

const MEAT = [0x6e0e0a, 0x8a1611, 0x58090a, 0x9a2219];
const CLOT = 0x2a0404;
const FAT = 0xb89a62;
const SINEW = 0xa8786a;
const BONE_WHITE = 0xe2d8bf;
const MARROW = 0x6a140e;

type Part = { g: THREE.BufferGeometry; color: number | ((i: number) => number) };

function painted(parts: Part[]): THREE.BufferGeometry {
  const c = new THREE.Color();
  const geos = parts.map(({ g, color }) => {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    // Only positions and colors: normals are computed once on the merged mesh (the hand-built
    // parts have none, the primitives do, and merging needs them to match).
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    const n = geo.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 3) {
      // One color per face (flat, like the bodies).
      c.setHex(typeof color === 'function' ? color(i / 3) : color);
      for (let j = i; j < i + 3 && j < n; j++) c.toArray(col, j * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  });
  const merged = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  merged.computeVertexNormals();
  return merged;
}

/**
 * The torn end of an arm, facing -Y (out of the stump, the way the missing part went), for a
 * limb of radius `r`: a ragged dome of meat ringed with fat and torn skin, the bone (or the two
 * forearm bones) snapped off and sticking out, and strands of sinew hanging loose. `seed`
 * changes the tearing so no two look alike.
 */
export function stumpGeometry(r: number, seed: number, bones: 1 | 2): THREE.BufferGeometry {
  const rand = rng(seed * 2654435761 + 7);
  const parts: Part[] = [];
  const N = 11;
  // Meat: a fan from a bulging centre to a jagged rim.
  const rim: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rr = r * (0.82 + rand() * 0.22);
    rim.push(new THREE.Vector3(Math.cos(a) * rr, -r * (0.05 + rand() * 0.3), Math.sin(a) * rr));
  }
  const centre = new THREE.Vector3(0, -r * 0.42, 0);
  const meat: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = rim[i], b = rim[(i + 1) % N];
    // Mid-ring vertex for some lumpiness.
    const m = a.clone().add(b).multiplyScalar(0.5).lerp(centre, 0.45);
    m.y -= r * rand() * 0.18;
    meat.push(...centre.toArray(), ...m.toArray(), ...a.toArray());
    meat.push(...centre.toArray(), ...b.toArray(), ...m.toArray());
  }
  const meatGeo = new THREE.BufferGeometry();
  meatGeo.setAttribute('position', new THREE.Float32BufferAttribute(meat, 3));
  parts.push({ g: meatGeo, color: () => (rand() < 0.15 ? CLOT : MEAT[Math.floor(rand() * MEAT.length)]) });

  // Fat and torn skin: a band from the meat's rim back over the arm, ragged at both edges.
  const band: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = rim[i], b = rim[(i + 1) % N];
    const out = (v: THREE.Vector3, k: number) => new THREE.Vector3(v.x * k, v.y + r * (0.08 + rand() * 0.25), v.z * k);
    const a2 = out(a, 1.14), b2 = out(b, 1.14);
    band.push(...a.toArray(), ...b.toArray(), ...a2.toArray());
    band.push(...b.toArray(), ...b2.toArray(), ...a2.toArray());
  }
  const bandGeo = new THREE.BufferGeometry();
  bandGeo.setAttribute('position', new THREE.Float32BufferAttribute(band, 3));
  parts.push({ g: bandGeo, color: () => (rand() < 0.5 ? FAT : rand() < 0.5 ? MEAT[3] : SINEW) });

  // Flaps of skin and muscle hanging off the rim.
  const flaps: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand() * 0.6;
    const w = r * (0.25 + rand() * 0.3);
    const len = r * (0.35 + rand() * 0.75);
    const x = Math.cos(a), z = Math.sin(a);
    const base = new THREE.Vector3(x * r * 1.02, -r * 0.05, z * r * 1.02);
    const side = new THREE.Vector3(-z, 0, x).multiplyScalar(w / 2);
    const tip = base.clone().add(new THREE.Vector3(x * len * 0.45, -len, z * len * 0.45));
    flaps.push(...base.clone().sub(side).toArray(), ...base.clone().add(side).toArray(), ...tip.toArray());
    flaps.push(...base.clone().add(side).toArray(), ...base.clone().sub(side).toArray(), ...tip.toArray());
  }
  const flapGeo = new THREE.BufferGeometry();
  flapGeo.setAttribute('position', new THREE.Float32BufferAttribute(flaps, 3));
  parts.push({ g: flapGeo, color: () => (rand() < 0.4 ? CLOT : MEAT[Math.floor(rand() * 2)]) });

  // Bone snapped off: a shaft out of the meat, a splintered end, marrow showing.
  const shafts: [number, number][] = bones === 1 ? [[0, 0]] : [[-0.32, 0.05], [0.3, -0.06]];
  const br = r * (bones === 1 ? 0.3 : 0.2);
  for (const [ox, oz] of shafts) {
    const len = r * (0.7 + rand() * 0.6);
    const x = ox * r + (rand() - 0.5) * r * 0.15, z = oz * r + (rand() - 0.5) * r * 0.15;
    const tilt = (rand() - 0.5) * 0.35;
    const shaft = new THREE.CylinderGeometry(br * 0.92, br, len, 7, 1, true).translate(0, -len / 2 - r * 0.15, 0).rotateZ(tilt).translate(x, 0, z);
    parts.push({ g: shaft, color: () => (rand() < 0.2 ? FAT : BONE_WHITE) });
    // Splinters: two broken points off the end.
    const end = new THREE.Vector3(x, -len - r * 0.15, z).applyAxisAngle(new THREE.Vector3(0, 0, 1), tilt);
    for (let k = 0; k < 2; k++) {
      const s = new THREE.ConeGeometry(br * (0.45 + rand() * 0.25), r * (0.25 + rand() * 0.35), 4).rotateX(Math.PI).translate(
        end.x + (k ? 1 : -1) * br * 0.45, end.y - r * 0.12, end.z + (rand() - 0.5) * br,
      );
      parts.push({ g: s, color: BONE_WHITE });
    }
    parts.push({ g: new THREE.CircleGeometry(br * 0.6, 7).rotateX(Math.PI / 2).translate(end.x, end.y + 0.001, end.z), color: MARROW });
  }

  // Sinew and veins dangling.
  for (let i = 0; i < 3; i++) {
    const a = rand() * Math.PI * 2;
    const len = r * (0.6 + rand() * 1.1);
    const g = new THREE.BoxGeometry(r * 0.12, len, r * 0.12)
      .translate(0, -len / 2, 0)
      .rotateX((rand() - 0.5) * 0.5)
      .rotateZ((rand() - 0.5) * 0.5)
      .translate(Math.cos(a) * r * 0.6, -r * 0.2, Math.sin(a) * r * 0.6);
    parts.push({ g, color: i === 0 ? SINEW : MEAT[2] });
  }
  return painted(parts);
}

/** Wet, glistening flesh for stumps and gibs (vertex colored). */
export function goreMaterial(): THREE.MeshStandardMaterial {
  // Both sides: torn flaps are seen from either one.
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0, flatShading: true, side: THREE.DoubleSide });
}

/** Gore turned off: stumps read as dark cloth and shadow instead of meat. */
export function tintGore(m: THREE.MeshStandardMaterial, on: boolean): void {
  const hex = on ? 0xffffff : 0x2e2a28;
  if (m.color.getHex() !== hex) m.color.setHex(hex);
}
