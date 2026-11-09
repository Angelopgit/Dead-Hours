import type { PropKind, PropSpec } from '../types/world';

/** Oriented collision box for a prop, in world space. Half extents; rotated about Y by rotY. */
export interface OrientedBox {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  rotY: number;
}

/** Local box: center (lx, ly, lz) and half extents (hx, hy, hz). Local +X is the long axis, +Z the front. */
type LocalBox = [number, number, number, number, number, number];

/** Single-box props. Anything not listed here and not handled below has no collision. */
const SIMPLE: Partial<Record<PropKind, LocalBox>> = {
  car: [0, 0.75, 0, 2.25, 0.75, 0.95],
  policeCar: [0, 0.75, 0, 2.25, 0.75, 0.95],
  wreckedCar: [0, 0.75, 0, 2.25, 0.75, 0.95],
  armoredTruck: [0, 1.3, 0, 3.1, 1.3, 1.2],
  streetlight: [0, 3, 0, 0.15, 3, 0.15],
  parkLamp: [0, 2, 0, 0.12, 2, 0.12],
  floodlight: [0, 3.8, 0, 0.5, 3.8, 0.5],
  utilityPole: [0, 4.5, 0, 0.17, 4.5, 0.17],
  trashBin: [0, 0.55, 0, 0.36, 0.55, 0.36],
  mailbox: [0, 0.6, 0, 0.12, 0.6, 0.12],
  hydrant: [0, 0.4, 0, 0.18, 0.4, 0.18],
  tree: [0, 2, 0, 0.3, 2, 0.3],
  pine: [0, 2, 0, 0.3, 2, 0.3],
  roadblock: [0, 0.55, 0, 1.6, 0.55, 0.3],
  streetSign: [0, 1.5, 0, 0.06, 1.5, 0.06],
  stopSign: [0, 1.3, 0, 0.06, 1.3, 0.06],
  jerseyBarrier: [0, 0.4, 0, 1.5, 0.4, 0.3],
  cone: [0, 0.35, 0, 0.18, 0.35, 0.18],
  boardSign: [0, 1.0, 0, 1.6, 1.0, 0.12],
  pump: [0, 0.9, 0, 0.45, 0.9, 0.3],
  signPylon: [0, 3.5, 0, 0.9, 3.5, 0.25],
  dumpster: [0, 0.65, 0, 1.0, 0.65, 0.65],
  tireStack: [0, 0.45, 0, 0.4, 0.45, 0.4],
  oilDrum: [0, 0.45, 0, 0.3, 0.45, 0.3],
  iceChest: [0, 0.55, 0, 0.7, 0.55, 0.4],
  merryGoRound: [0, 0.35, 0, 1.2, 0.35, 1.2],
  bench: [0, 0.45, 0, 0.9, 0.45, 0.3],
  picnicTable: [0, 0.4, 0, 1.0, 0.4, 0.8],
  bbq: [0, 0.5, 0, 0.4, 0.5, 0.3],
  patioTable: [0, 0.38, 0, 0.6, 0.38, 0.6],
  trampoline: [0, 0.45, 0, 1.3, 0.45, 1.3],
  woodpile: [0, 0.5, 0, 1.0, 0.5, 0.4],
  doghouse: [0, 0.5, 0, 0.5, 0.5, 0.6],
  sofa: [0, 0.42, 0, 1.05, 0.42, 0.45],
  armchair: [0, 0.42, 0, 0.45, 0.42, 0.45],
  coffeeTable: [0, 0.22, 0, 0.6, 0.22, 0.35],
  tvStand: [0, 0.6, 0, 0.8, 0.6, 0.22],
  bed: [0, 0.3, 0, 1.05, 0.3, 0.75],
  wardrobe: [0, 1.0, 0, 0.6, 1.0, 0.3],
  bookshelf: [0, 0.95, 0, 0.5, 0.95, 0.17],
  fridge: [0, 0.9, 0, 0.4, 0.9, 0.35],
  stove: [0, 0.46, 0, 0.38, 0.46, 0.32],
  diningTable: [0, 0.38, 0, 0.8, 0.38, 0.45],
  chair: [0, 0.45, 0, 0.22, 0.45, 0.22],
  workbench: [0, 0.48, 0, 1.2, 0.48, 0.38],
  metalShelf: [0, 0.95, 0, 0.6, 0.95, 0.22],
  crate: [0, 0.3, 0, 0.4, 0.3, 0.3],
  ammoCrate: [0, 0.22, 0, 0.45, 0.22, 0.25],
  washer: [0, 0.45, 0, 0.32, 0.45, 0.32],
  waterHeater: [0, 0.75, 0, 0.3, 0.75, 0.3],
  desk: [0, 0.38, 0, 0.65, 0.38, 0.32],
  dresser: [0, 0.42, 0, 0.6, 0.42, 0.25],
  floorLamp: [0, 0.8, 0, 0.15, 0.8, 0.15],
  storeCounter: [0, 0.5, 0, 1.2, 0.5, 0.35],
  cooler: [0, 1.0, 0, 1.0, 1.0, 0.4],
  toilet: [0, 0.4, 0, 0.2, 0.4, 0.35],
  bathtub: [0, 0.29, 0, 0.85, 0.29, 0.38],
  vanity: [0, 0.44, 0, 0.45, 0.44, 0.25],
  flagpole: [0, 4.5, 0, 0.07, 4.5, 0.07],
};

/** Half extents of a prop's footprint in its own frame (along its length, front to back). */
export function propHalfExtents(kind: PropKind, length?: number): [number, number] {
  const boxes = propColliders({ kind, x: 0, z: 0, rotY: 0, length });
  if (!boxes.length) return [0, 0];
  let hx = 0, hz = 0;
  for (const b of boxes) {
    hx = Math.max(hx, Math.abs(b.x) + b.hx);
    hz = Math.max(hz, Math.abs(b.z) + b.hz);
  }
  return [hx, hz];
}

/** A wrecked car's open door: hinge at the front of the cabin, swung out on one side. */
export interface WreckDoor {
  /** -1 driver side (local -Z), 1 passenger side. */
  side: -1 | 1;
  /** Opening angle (radians). */
  angle: number;
  /** Door center and yaw in the car's local frame. */
  cx: number;
  cz: number;
  ry: number;
  length: number;
}

/** Which wrecks were abandoned with a door hanging open (overturned ones stay shut). */
export function wreckDoor(p: PropSpec): WreckDoor | null {
  if (p.kind !== 'wreckedCar') return null;
  const v = p.variant ?? 0;
  if (v >= 10 || v % 3 === 1) return null;
  const side: -1 | 1 = v % 2 === 0 ? -1 : 1;
  const angle = 0.85 + (v % 4) * 0.12;
  const length = 1.05;
  const hx = 0.55, hz = side * 0.93;
  const cx = hx - Math.cos(angle) * length / 2;
  const cz = hz + side * Math.sin(angle) * length / 2;
  return { side, angle, cx, cz, ry: side * angle, length };
}

/** Collision for props, built identically on client and server. */
export function propColliders(p: PropSpec): OrientedBox[] {
  const base = p.y ?? 0;
  const c = Math.cos(p.rotY);
  const s = Math.sin(p.rotY);
  // Three.js Y rotation: x' = x*c + z*s, z' = -x*s + z*c
  const at = ([lx, ly, lz, hx, hy, hz]: LocalBox): OrientedBox =>
    ({ x: p.x + lx * c + lz * s, y: base + ly, z: p.z - lx * s + lz * c, hx, hy, hz, rotY: p.rotY });
  if (p.tipped && p.kind === 'chair') return [at([-0.45, 0.22, 0, 0.45, 0.22, 0.22])];
  if (p.tipped && p.kind === 'floorLamp') return [];
  const simple = SIMPLE[p.kind];
  const door = wreckDoor(p);
  if (simple && door) return [at(simple), { ...at([door.cx, 0.72, door.cz, door.length / 2, 0.42, 0.05]), rotY: p.rotY + door.ry }];
  if (simple) return [at(simple)];
  const len = p.length;
  switch (p.kind) {
    case 'fence':
      return [at([0, 0.8, 0, (len ?? 6) / 2, 0.8, 0.06])];
    case 'ironFence':
      return [at([0, 0.75, 0, (len ?? 6) / 2, 0.75, 0.05])];
    case 'railing':
      return [at([0, 0.5, 0, (len ?? 2) / 2, 0.5, 0.04])];
    case 'sandbags':
      return [at([0, 0.375, 0, (len ?? 2.4) / 2, 0.375, 0.3])];
    case 'counter':
      return [at([0, 0.45, 0, (len ?? 2.4) / 2, 0.45, 0.32])];
    case 'storeShelf':
      return [at([0, 0.8, 0, (len ?? 3) / 2, 0.8, 0.45])];
    case 'swingSet':
      return [at([-2.0, 1.2, 0, 0.1, 1.2, 0.8]), at([2.0, 1.2, 0, 0.1, 1.2, 0.8])];
    case 'slide':
      return [at([-1.2, 1.0, 0, 0.5, 1.0, 0.5]), at([0.6, 0.45, 0, 1.3, 0.45, 0.32])];
    case 'clothesline':
      return [at([-2.5, 1.0, 0, 0.06, 1.0, 0.06]), at([2.5, 1.0, 0, 0.06, 1.0, 0.06])];
    case 'gazebo': {
      const boxes: OrientedBox[] = [at([0, 0.15, 0, 2.6, 0.15, 2.6])];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        boxes.push(at([Math.cos(a) * 2.8, 1.45, Math.sin(a) * 2.8, 0.09, 1.3, 0.09]));
      }
      return boxes;
    }
    case 'shed':
      return p.variant === 1
        ? [at([0, 1.2, -1.2, 1.5, 1.2, 0.05]), at([-1.45, 1.2, 0, 0.05, 1.2, 1.25]), at([1.45, 1.2, 0, 0.05, 1.2, 1.25]), at([0, 2.35, 0, 1.5, 0.08, 1.25])]
        : [at([0, 1.2, 0, 1.5, 1.2, 1.25])];
    case 'tent':
      return [at([0, 1.1, -2.4, 2.0, 1.1, 0.05]), at([-2.0, 1.1, 0, 0.05, 1.1, 2.4]), at([2.0, 1.1, 0, 0.05, 1.1, 2.4])];
    default:
      return [];
  }
}

/** Approximate tree crowns, used only to occlude light during the lighting bake. */
export function propOccluders(p: PropSpec): { x: number; y: number; z: number; r: number }[] {
  const v = p.variant ?? 0;
  if (p.kind === 'tree') return [{ x: p.x, y: 4.0 + (v % 3) * 0.6, z: p.z, r: 2.1 }];
  if (p.kind === 'pine') {
    const k = 1 + (v % 3) * 0.15;
    return [{ x: p.x, y: 2.6 * k, z: p.z, r: 1.7 * k }, { x: p.x, y: 4.6 * k, z: p.z, r: 1.1 * k }];
  }
  if (p.kind === 'bush') return [{ x: p.x, y: 0.45, z: p.z, r: 0.75 }];
  return [];
}
