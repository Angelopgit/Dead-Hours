import * as THREE from 'three';
import type { ThrowKind } from '@dead-hours/shared';

/**
 * A frag grenade or a Molotov cocktail, in the hand or in flight. Origin at its middle (it
 * tumbles about that); +Y up along the bottle neck / fuze.
 */
export interface ThrowableModel {
  readonly kind: ThrowKind;
  readonly root: THREE.Group;
  /** Molotov: where the rag burns (model space). */
  readonly wick: THREE.Vector3;
  readonly materials: THREE.MeshStandardMaterial[];
  dispose(): void;
}

let shared: { geos: Record<ThrowKind, { g: THREE.BufferGeometry; m: number }[]>; mats: THREE.MeshStandardMaterial[] } | null = null;

function build(): NonNullable<typeof shared> {
  if (shared) return shared;
  const olive = new THREE.MeshStandardMaterial({ color: 0x3f4a2c, roughness: 0.62, metalness: 0.25 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.35, metalness: 0.85 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x5a7a3a, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.62 });
  const fuel = new THREE.MeshStandardMaterial({ color: 0x8a5a18, roughness: 0.2, transparent: true, opacity: 0.85 });
  const rag = new THREE.MeshStandardMaterial({ color: 0xc8b89a, roughness: 1 });
  const mats = [olive, steel, glass, fuel, rag];

  // M67-style frag: a ball a touch taller than wide, the fuze and spoon on top, the pin ring.
  const body = new THREE.SphereGeometry(0.032, 14, 10).scale(1, 1.1, 1);
  const fuze = new THREE.CylinderGeometry(0.011, 0.013, 0.022, 10).translate(0, 0.039, 0);
  const spoon = new THREE.BoxGeometry(0.012, 0.062, 0.006).translate(0, 0.018, 0.035).rotateX(-0.08);
  const ring = new THREE.TorusGeometry(0.011, 0.0018, 6, 16).rotateY(Math.PI / 2).translate(0.018, 0.046, 0);

  // Molotov: a bottle with fuel sloshing in it and a rag stuffed in the neck.
  const pts: THREE.Vector2[] = [];
  const prof: [number, number][] = [[0, -0.11], [0.034, -0.11], [0.037, -0.1], [0.037, 0.02], [0.03, 0.045], [0.014, 0.07], [0.012, 0.1], [0.013, 0.105], [0, 0.105]];
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
  const bottle = new THREE.LatheGeometry(pts, 14);
  const liquid = new THREE.CylinderGeometry(0.033, 0.033, 0.085, 12).translate(0, -0.066, 0);
  const cloth = new THREE.CylinderGeometry(0.009, 0.013, 0.06, 6, 2).translate(0, 0.125, 0);
  const tail = new THREE.BoxGeometry(0.03, 0.05, 0.004).translate(0.012, 0.13, 0).rotateZ(-0.5);

  shared = {
    geos: {
      frag: [{ g: body, m: 0 }, { g: fuze, m: 1 }, { g: spoon, m: 0 }, { g: ring, m: 1 }],
      molotov: [{ g: liquid, m: 3 }, { g: bottle, m: 2 }, { g: cloth, m: 4 }, { g: tail, m: 4 }],
    },
    mats,
  };
  return shared;
}

export function createThrowableModel(kind: ThrowKind): ThrowableModel {
  const s = build();
  const root = new THREE.Group();
  for (const p of s.geos[kind]) {
    const mesh = new THREE.Mesh(p.g, s.mats[p.m]);
    mesh.castShadow = p.m !== 2 && p.m !== 3;
    mesh.renderOrder = p.m === 2 ? 3 : 0;
    root.add(mesh);
  }
  return {
    kind,
    root,
    wick: new THREE.Vector3(0, 0.15, 0),
    materials: s.mats,
    dispose: () => root.removeFromParent(),
  };
}
