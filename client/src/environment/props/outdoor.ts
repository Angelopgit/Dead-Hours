import * as THREE from 'three';
import { VEHICLES, isDrivable, type PropKind } from '@dead-hours/shared';
import { arch, dressed, gableRoof, jitter, sidePlate, type Kit } from './Kit';
import { chamferBox, loft, type P2 } from '../../rendering/Solid';

type Builder = (k: Kit) => void;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function lines(text: string | undefined, fallback: string): string[] {
  return (text ?? fallback).split('|');
}

/** Still water in a kiddie pool; picks up the environment map assigned later. */
function water(k: Kit): THREE.MeshStandardMaterial {
  const m = k.lib.custom('pool-water', () => new THREE.MeshStandardMaterial({
    color: 0x111418, roughness: 0.05, metalness: 0.2, envMapIntensity: 1, polygonOffset: true, polygonOffsetFactor: -3,
  }));
  m.userData.envMap = true;
  return m;
}

/**
 * The armored truck's hard points, which the seats, the colliders and the driving assume
 * (shared/src/config/vehicles.ts): 6.2 m long on a 4.4 m wheelbase, 2.4 m wide, 1 m wheels, the
 * two front seats forward of the front axle under a 2.12 m roof, the box 2.6 m inside.
 */
const TRUCK = { nose: 3.1, tail: -3.04, skirt: 0.62, sill: 1.5, cabRoof: 2.12, boxRoof: 2.6, half: 1.2, axle: 2.2, wheelY: 0.5, wheelR: 0.5, archR: 0.62, wall: 1.3 };
/** Where an arch of radius `archR` round a wheel meets the skirt line. */
const TRUCK_ARCH = Math.asin((TRUCK.skirt - TRUCK.wheelY) / TRUCK.archR);

/**
 * The cab of the armored truck: a shell round the two front seats (on the chassis, which is the
 * floor, VEHICLES.truck.floor) with a raked windshield. One that drives has clear glass, seats,
 * a dashboard and the wheel; a parked one has dark glass and nothing behind it.
 */
function truckCab(k: Kit, body: Parameters<Kit['box']>[3], trim: Parameters<Kit['box']>[3], drives: boolean): void {
  const t = TRUCK, def = VEHICLES.truck;
  const top = t.cabRoof, rake = 0.36;
  // Below the windows: each side with its wheel arch, the nose; the roof over them.
  const side: P2[] = [
    [t.wall, t.skirt], [t.wall, t.sill], [3.06, t.sill], [t.nose, 1.42], [t.nose, t.skirt],
    [t.axle + Math.cos(TRUCK_ARCH) * t.archR, t.skirt], ...arch(t.axle, t.wheelY, t.archR, TRUCK_ARCH, Math.PI - TRUCK_ARCH, 8),
  ];
  // Pillars: the raked one beside the windshield, the upright one against the box.
  const front: P2[] = [[3.06, t.sill], [3.06 - rake, top], [2.62, top], [2.96, t.sill]];
  const back: P2[] = [[t.wall, t.sill], [t.wall, top], [1.62, top], [1.62, t.sill]];
  const win: P2[] = [[1.62, t.sill], [1.62, top], [2.62, top], [2.96, t.sill]];
  const dark = k.lib.custom('car-glass', () => new THREE.MeshStandardMaterial({ color: 0x0b0f14, roughness: 0.08, metalness: 0.8 }));
  for (const sz of [-1, 1]) {
    k.add(sidePlate(side, 0.07, 0.015), body, 0, 0, sz * 1.125);
    k.add(sidePlate(front, 0.07, 0.012), body, 0, 0, sz * 1.125);
    k.add(sidePlate(back, 0.07, 0.012), body, 0, 0, sz * 1.125);
    if (drives) k.pane(sidePlate(win, 0.02, 0), 0, 0, sz * 1.125);
    else k.add(sidePlate(win, 0.02, 0), dark, 0, 0, sz * 1.125, { cast: false });
    // Door: its shut lines, the handle, the step under it, the mirror on its arm.
    k.box(0.012, 0.86, 0.012, trim, 1.66, 1.06, sz * 1.163, { cast: false });
    k.box(0.9, 0.012, 0.012, trim, 2.1, 0.66, sz * 1.163, { cast: false });
    k.add(dressed(chamferBox(0.16, 0.035, 0.03, 0.008)), trim, 1.82, 1.36, sz * 1.17, { cast: false });
    k.add(dressed(chamferBox(0.05, 0.05, 0.26, 0.01)), trim, 2.98, 1.62, sz * 1.27, { cast: false });
    k.add(dressed(chamferBox(0.05, 0.3, 0.16, 0.015)), trim, 2.98, 1.76, sz * 1.42, { cast: false });
    // The wheel well, seen through the arch and beside the seat.
    k.block(1.3, 0.56, 0.3, trim, t.axle, 0.6, sz * 0.975);
  }
  k.add(dressed(chamferBox(0.07, t.sill - t.skirt, 2.32, 0.015)), body, 3.065, (t.sill + t.skirt) / 2, 0);
  k.add(dressed(chamferBox(3.06 - rake - t.wall + 0.06, 0.06, 2.32, 0.02)), body, (3.06 - rake + t.wall) / 2 + 0.03, top + 0.03, 0);
  // Windshield, leaning back, with a centre post.
  const glass = new THREE.BoxGeometry(0.02, Math.hypot(rake, top - t.sill), 2.18);
  const lean = Math.atan2(rake, top - t.sill);
  if (drives) k.pane(glass, 3.06 - rake / 2, (top + t.sill) / 2, 0, { rz: lean });
  else k.add(glass, dark, 3.06 - rake / 2, (top + t.sill) / 2, 0, { rz: lean, cast: false });
  k.box(0.03, Math.hypot(rake, top - t.sill), 0.05, body, 3.07 - rake / 2, (top + t.sill) / 2, 0, { rz: lean, cast: false });
  // Grille slats in the nose, the light bar on the roof.
  k.add(dressed(chamferBox(0.03, 0.34, 1.1, 0.01)), trim, 3.105, 1.12, 0, { cast: false });
  for (let i = 0; i < 4; i++) k.box(0.02, 0.03, 1.02, body, 3.125, 1.0 + i * 0.08, 0, { cast: false });
  k.add(dressed(chamferBox(0.26, 0.08, 1.5, 0.02)), trim, 2.2, top + 0.1, 0, { cast: false });
  for (const sz of [-1, 1]) {
    k.box(0.2, 0.05, 0.56, k.mat(0x3a0d0d, 0.25, 0.2), 2.22, top + 0.11, sz * 0.4 - 0.02 * sz, { cast: false });
  }
  k.box(0.2, 0.05, 0.2, k.mat(0x0d1a3a, 0.25, 0.2), 2.22, top + 0.11, 0, { cast: false });
  if (!drives) return;
  // Seats, the dashboard, the wheel.
  const cloth = k.mat(0x2a2722, 0.95);
  const dash = k.mat(0x1a1b1c, 0.8);
  for (const s of def.seats.slice(0, 2)) {
    k.block(0.5, s.y - def.floor, 0.5, cloth, s.x - 0.02, def.floor, s.z);
    k.box(0.13, 0.62, 0.5, cloth, s.x - 0.28, s.y + 0.31, s.z, { rz: 0.14 });
  }
  k.block(0.26, 0.2, 2.1, dash, 2.86, 1.3, 0);
  const w = def.wheel, z = def.seats[0].z, tilt = 0.6;
  const rim = new THREE.TorusGeometry(0.17, 0.022, 6, 20);
  rim.rotateY(Math.PI / 2);
  rim.rotateZ(tilt);
  k.add(rim, dash, w.x, w.y, z, { cast: false });
  k.cyl(0.05, 0.05, 0.05, 8, dash, w.x + 0.01, w.y, z, { rz: tilt - Math.PI / 2, cast: false });
  k.rod(V(w.x + 0.03, w.y - 0.02, z), V(2.8, 1.45, z), 0.03, dash);
}

/** The armored truck's wheels: a tall tire with a groove round it, a steel rim, the hub. */
function truckWheels(k: Kit): void {
  const t = TRUCK, r = t.wheelR;
  const tire = dressed(loft([
    { z: -0.17, rx: 0.3 }, { z: -0.17, rx: r - 0.06 }, { z: -0.13, rx: r }, { z: -0.015, rx: r }, { z: -0.015, rx: r - 0.02 },
    { z: 0.015, rx: r - 0.02 }, { z: 0.015, rx: r }, { z: 0.13, rx: r }, { z: 0.17, rx: r - 0.06 }, { z: 0.17, rx: 0.3 },
  ], { segments: 16, caps: false }));
  const rim = dressed(loft([{ z: -0.155, rx: 0.29 }, { z: -0.13, rx: 0.305 }, { z: 0.13, rx: 0.305 }, { z: 0.155, rx: 0.29 }], { segments: 12 }));
  const hub = dressed(loft([{ z: -0.19, rx: 0.07 }, { z: -0.172, rx: 0.115 }, { z: 0.172, rx: 0.115 }, { z: 0.19, rx: 0.07 }], { segments: 8 }));
  const rubber = k.mat(0x101010, 0.92), steel = k.mat(0x1c1d1f, 0.5, 0.6), bolt = k.mat(0x55585c, 0.4, 0.8);
  for (const wx of [-t.axle, t.axle]) for (const wz of [-1.03, 1.03]) {
    k.add(tire.clone(), rubber, wx, t.wheelY, wz);
    k.add(rim.clone(), steel, wx, t.wheelY, wz, { cast: false });
    k.add(hub.clone(), bolt, wx, t.wheelY, wz, { cast: false });
  }
  tire.dispose(); rim.dispose(); hub.dispose();
}

export const OUTDOOR: Partial<Record<PropKind, Builder>> = {
  // ── Street ────────────────────────────────────────────────────────────────
  streetSign(k) {
    const pole = k.mat(0x6a6d70, 0.5, 0.6);
    k.cyl(0.04, 0.04, 3.0, 6, pole, 0, 1.5, 0);
    const [a, b] = lines(k.p.text, 'HALE ST|PELL LN');
    const blade = (t: string) => k.text([t], { w: 512, h: 96, bg: '#1f5a36', fg: '#e8efe6', border: '#e8efe6' });
    k.box(0.95, 0.18, 0.02, blade(a), 0, 2.86, 0);
    k.box(0.95, 0.18, 0.02, blade(b), 0, 3.08, 0, { ry: Math.PI / 2 });
  },
  stopSign(k) {
    k.cyl(0.04, 0.04, 2.6, 6, k.mat(0x6a6d70, 0.5, 0.6), 0, 1.3, 0);
    const oct = new THREE.CylinderGeometry(0.38, 0.38, 0.025, 8);
    oct.rotateX(Math.PI / 2);
    oct.rotateZ(Math.PI / 8);
    k.add(oct, k.mat(0x8c1c18, 0.6), 0, 2.3, 0.02);
    k.box(0.5, 0.18, 0.005, k.text(['STOP'], { w: 256, h: 96, bg: '#8c1c18', fg: '#f2ece4', border: null }), 0, 2.3, 0.036, { cast: false });
  },
  // Puddles are one blended draw of their own, outside the static batch (see Puddles).
  puddle() {},
  leafPile(k) {
    const colors = [0x4a3418, 0x5a3a14, 0x3a2c18, 0x6a4a1c];
    for (let i = 0; i < 9; i++) {
      const g = new THREE.CircleGeometry(0.2 + k.rand(i) * 0.35, 6);
      g.rotateX(-Math.PI / 2);
      k.add(g, k.mat(colors[i % 4], 1), (k.rand(i + 10) - 0.5) * 2.2, 0.03 + i * 0.002, (k.rand(i + 20) - 0.5) * 1.6, { cast: false, ry: k.rand(i + 30) * 3 });
    }
  },

  // ── Checkpoint ────────────────────────────────────────────────────────────
  jerseyBarrier(k) {
    const c = k.lib.get('concrete').material;
    k.block(3.0, 0.22, 0.6, c, 0, 0, 0);
    const mid = new THREE.BoxGeometry(3.0, 0.58, 0.6);
    const p = mid.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setZ(i, p.getZ(i) * 0.35);
    mid.computeVertexNormals();
    k.add(mid, c, 0, 0.51, 0);
    const stripe = k.mat(0xb8781c, 0.6);
    for (const sx of [-1, 1]) k.box(0.4, 0.12, 0.62, stripe, sx * 0.9, 0.12, 0, { cast: false });
  },
  sandbags(k) {
    const len = k.p.length ?? 2.4;
    const m = k.mat(0x6b6248, 0.95);
    const per = Math.max(2, Math.round(len / 0.55));
    for (let row = 0; row < 3; row++) {
      const n = per - (row === 2 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const g = jitter(new THREE.BoxGeometry(0.55, 0.2, 0.34, 2, 1, 2), 0.05, row * 31 + i + Math.round(k.p.x));
        const x = -len / 2 + 0.28 + (i + (row % 2) * 0.5) * ((len - 0.56) / Math.max(1, per - 1));
        k.add(g, m, Math.min(x, len / 2 - 0.28), 0.12 + row * 0.22, (row % 2 ? 0.08 : -0.08), { ry: (k.rand(i + row * 7) - 0.5) * 0.3 });
      }
    }
  },
  floodlight(k) {
    const steel = k.mat(0x4c5054, 0.6, 0.5);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.rod(V(sx * 0.55, 0, sz * 0.55), V(sx * 0.3, 7.2, sz * 0.3), 0.04, steel);
    for (let i = 1; i < 6; i++) {
      const y = i * 1.25;
      const w = 1.1 - (y / 7.2) * 0.5;
      k.box(w, 0.04, 0.04, steel, 0, y, w / 2);
      k.box(w, 0.04, 0.04, steel, 0, y, -w / 2);
    }
    k.block(1.0, 0.06, 0.8, steel, 0, 7.2, 0);
    const lamp = k.mat(0x2a2c2e, 0.5, 0.5);
    for (const sx of [-1, 1]) {
      k.box(0.55, 0.42, 0.22, lamp, sx * 0.6, 7.45, 0.3, { rx: 0.5 });
      k.box(0.48, 0.34, 0.02, k.glow(0xeaf2ff, 9), sx * 0.6, 7.38, 0.42, { rx: 0.5, cast: false });
    }
    k.block(1.5, 1.0, 0.9, k.mat(0x3d4430, 0.7, 0.2), 1.2, 0, 0.2);
    k.box(0.7, 0.01, 0.01, k.mat(0x111111, 0.8), 1.2, 0.55, 0.66);
  },
  tent(k) {
    const canvas = k.mat(0x4a4a32, 0.95, 0, false);
    k.block(4.0, 2.2, 0.06, canvas, 0, 0, -2.4);
    for (const sx of [-1, 1]) k.block(0.06, 2.2, 4.8, canvas, sx * 2.0, 0, 0);
    const roof = gableRoof(4.8, 4.0, 0.9, 0.2);
    roof.rotateY(Math.PI / 2);
    k.add(roof, canvas, 0, 2.2, 0);
    k.box(4.0, 0.02, 4.8, k.mat(0x2e2e22, 0.95), 0, 2.2, 0, { cast: false });
    k.block(1.9, 0.45, 0.75, k.mat(0x3d4430, 0.8), 1.0, 0, -1.4);
    k.box(0.9, 0.02, 0.7, k.mat(0x6a5a44, 0.9), -1.2, 0.75, -1.6);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.block(0.04, 0.75, 0.04, k.mat(0x3a3a3a, 0.6, 0.5), -1.2 + sx * 0.4, 0, -1.6 + sz * 0.3);
  },
  cone(k) {
    k.block(0.38, 0.03, 0.38, k.mat(0x1a1a1a, 0.8), 0, 0, 0);
    k.cyl(0.03, 0.15, 0.68, 10, k.mat(0xc8561c, 0.6), 0, 0.37, 0);
    k.cyl(0.08, 0.1, 0.1, 10, k.mat(0xd8d8d0, 0.4), 0, 0.42, 0, { cast: false });
  },
  armoredTruck(k) {
    const t = TRUCK;
    const body = k.mat(0x22261f, 0.6, 0.3), trim = k.mat(0x151716, 0.7, 0.2), steel = k.mat(0x2c2e30, 0.45, 0.7);
    const glass = k.lib.custom('car-glass', () => new THREE.MeshStandardMaterial({ color: 0x0b0f14, roughness: 0.08, metalness: 0.8 }));
    // Chassis between the wheels (its top is the floor), axles and the tank under the box.
    k.block(6.0, 0.5, 1.68, trim, 0, 0.45, 0);
    k.block(3.1, 0.5, 2.26, trim, 0, 0.45, 0);
    k.block(1.3, 0.3, 1.68, trim, -t.axle, 0.88, 0);
    k.cyl(0.2, 0.2, 0.9, 10, steel, -0.6, 0.6, 1.0, { rz: Math.PI / 2 });
    // The armored box: one hull with its edges cut back, an arch over each rear wheel.
    k.add(sidePlate([
      [t.tail, t.skirt], [t.tail, 2.5], [t.tail + 0.16, t.boxRoof + 0.06], [t.wall, t.boxRoof + 0.06], [t.wall, t.skirt],
      [-t.axle + Math.cos(TRUCK_ARCH) * t.archR, t.skirt], ...arch(-t.axle, t.wheelY, t.archR, TRUCK_ARCH, Math.PI - TRUCK_ARCH, 8),
    ], 2.4, 0.09), body, 0, 0, 0);
    truckCab(k, body, trim, isDrivable(k.p));
    truckWheels(k);
    k.box(2.0, 0.3, 0.02, k.text(['STATE POLICE'], { w: 512, h: 96, bg: '#22261f', fg: '#c8c2a8', border: null }), -0.15, 1.22, 1.205, { cast: false });
    k.box(2.0, 0.3, 0.02, k.text(['STATE POLICE'], { w: 512, h: 96, bg: '#22261f', fg: '#c8c2a8', border: null }), -0.15, 1.22, -1.205, { cast: false, ry: Math.PI });
    const port = dressed(loft([{ z: -0.014, rx: 0.09 }, { z: 0.006, rx: 0.09 }, { z: 0.014, rx: 0.075 }], { segments: 10 }));
    for (const sz of [-1, 1]) {
      const face = sz * 1.2;
      for (const x of [-2.35, -1.15, 0.05]) {
        // A vision block in its frame, the gun port under it with the cover swung shut.
        k.add(dressed(chamferBox(0.46, 0.26, 0.03, 0.01)), trim, x, 2.0, face, { cast: false });
        k.box(0.36, 0.16, 0.012, glass, x, 2.0, face + sz * 0.012, { cast: false });
        const p = k.add(port.clone(), steel, x, 1.62, face, { cast: false });
        if (sz < 0) p.rotation.y = Math.PI;
        k.box(0.03, 0.05, 0.02, trim, x, 1.74, face + sz * 0.012, { cast: false });
      }
      // Seams between the plates, the side door of the box, a running board.
      for (const x of [-1.75, -0.55]) k.box(0.03, 1.86, 0.014, trim, x, 1.56, face, { cast: false });
      k.box(0.014, 1.5, 0.014, trim, 0.55, 1.42, face, { cast: false });
      k.box(0.014, 1.5, 0.014, trim, 1.24, 1.42, face, { cast: false });
      k.box(0.7, 0.014, 0.014, trim, 0.895, 2.17, face, { cast: false });
      k.add(dressed(chamferBox(0.16, 0.035, 0.03, 0.008)), steel, 0.68, 1.36, face + sz * 0.012, { cast: false });
      k.add(dressed(chamferBox(2.9, 0.05, 0.2, 0.012)), steel, -0.05, 0.56, sz * 1.24);
      // Mud flaps behind the rear wheels, rails along the roof.
      k.box(0.03, 0.42, 0.34, trim, -2.9, 0.62, sz * 1.03, { cast: false });
      k.rod(V(-2.7, 2.74, sz * 0.98), V(1.0, 2.74, sz * 0.98), 0.018, steel);
      for (const x of [-2.7, -0.85, 1.0]) k.box(0.03, 0.08, 0.03, steel, x, 2.7, sz * 0.98, { cast: false });
    }
    port.dispose();
    // Roof: the hatch on its ring, a vent, the aerial.
    k.cyl(0.42, 0.44, 0.06, 14, trim, -0.9, 2.69, 0, { cast: false });
    k.add(dressed(chamferBox(0.62, 0.04, 0.62, 0.015)), body, -0.9, 2.74, 0, { cast: false });
    k.box(0.1, 0.03, 0.03, steel, -0.9, 2.775, 0.2, { cast: false });
    k.add(dressed(chamferBox(0.4, 0.07, 0.4, 0.02)), trim, -2.3, 2.695, 0, { cast: false });
    k.rod(V(-2.85, 2.66, -0.95), V(-2.9, 3.5, -0.95), 0.008, trim, 4);
    // Back: two doors with their hinges and bars, the step.
    k.box(0.012, 1.7, 0.016, trim, t.tail - 0.004, 1.6, 0, { cast: false });
    for (const sz of [-1, 1]) {
      for (const y of [1.0, 1.6, 2.2]) k.add(dressed(chamferBox(0.03, 0.1, 0.05, 0.008)), steel, t.tail - 0.012, y, sz * 1.0, { cast: false });
      k.add(dressed(chamferBox(0.03, 0.04, 0.5, 0.008)), steel, t.tail - 0.014, 1.45, sz * 0.32, { cast: false });
      k.add(dressed(chamferBox(0.014, 0.2, 0.3, 0.004)), trim, t.tail - 0.004, 2.1, sz * 0.5, { cast: false });
      k.box(0.012, 0.12, 0.22, glass, t.tail - 0.012, 2.1, sz * 0.5, { cast: false });
    }
    k.add(dressed(chamferBox(0.2, 0.08, 2.2, 0.02)), steel, t.tail - 0.06, 0.56, 0);
    // The exhaust, out under the step on the passenger's side (VehicleView puffs from its end).
    k.rod(V(-2.5, 0.4, 0.62), V(t.tail - 0.16, 0.4, 0.62), 0.045, steel, 6);
    // Front: the ram bumper with its push bar and tow hooks.
    k.add(dressed(chamferBox(0.14, 0.3, 2.4, 0.03)), steel, 3.13, 0.7, 0);
    for (const sz of [-0.45, 0.45]) {
      k.add(dressed(chamferBox(0.06, 0.62, 0.07, 0.015)), steel, 3.2, 1.0, sz, { cast: false });
      k.add(dressed(chamferBox(0.05, 0.06, 0.1, 0.012)), k.mat(0x7a1a14, 0.5, 0.3), 3.21, 0.62, sz * 1.9, { cast: false });
    }
    for (const y of [0.98, 1.26]) k.add(dressed(chamferBox(0.05, 0.05, 0.97, 0.012)), steel, 3.2, y, 0, { cast: false });
    // Lamps: a headlight either side of the grille, tail lights low on the back doors.
    for (const sz of [-0.82, 0.82]) {
      k.box(0.05, 0.16, 0.3, k.mat(0x9aa0a6, 0.2, 0.5), 3.115, 1.04, sz).userData.lamp = 'head';
      k.box(0.05, 0.14, 0.24, k.glow(0x5a0805, 0.6), t.tail - 0.03, 1.0, sz, { cast: false }).userData.lamp = 'tail';
    }
  },
  boardSign(k) {
    const legs = k.mat(0x3a3a3a, 0.6, 0.5);
    for (const sx of [-1, 1]) k.block(0.08, 1.9, 0.08, legs, sx * 1.4, 0, -0.04);
    const alt = (k.p.variant ?? 0) === 1;
    const t = lines(k.p.text, 'ROAD CLOSED');
    const face = k.text(t, alt
      ? { w: 1024, h: 512, bg: '#e8e2d2', fg: '#8c1c18', border: '#8c1c18' }
      : { w: 1024, h: 512, bg: '#d8a21c', fg: '#141414', border: '#141414' });
    k.box(3.2, 1.5, 0.05, face, 0, 1.25, 0);
    k.box(3.2, 1.5, 0.02, k.mat(0x3a3a3a, 0.7), 0, 1.25, -0.035);
    if (!alt) {
      const lampMat = new THREE.MeshStandardMaterial({ color: 0x110800, emissive: 0xffa020, emissiveIntensity: 0 });
      lampMat.userData.noBake = true;
      for (const sx of [-1, 1]) k.box(0.14, 0.14, 0.14, lampMat, sx * 1.4, 2.08, 0, { dynamic: true, cast: false });
      const ph = k.p.x;
      k.out.dynamic.push({ update: (_dt, time) => { lampMat.emissiveIntensity = ((time + ph) % 1.2) < 0.45 ? 9 : 0.2; } });
    }
  },

  // ── Gas station ───────────────────────────────────────────────────────────
  pump(k) {
    const white = k.mat(0xb8b6ae, 0.5);
    k.block(0.9, 1.6, 0.5, white, 0, 0, 0);
    k.block(0.95, 0.25, 0.55, k.mat(0x8c1c18, 0.5), 0, 1.6, 0);
    for (const sz of [-1, 1]) {
      k.box(0.36, 0.22, 0.01, k.glow(0x3a6a4a, 0.6), 0, 1.2, sz * 0.256, { cast: false });
      k.box(0.6, 0.5, 0.01, k.mat(0x2a2c2e, 0.4), 0, 0.6, sz * 0.256, { cast: false });
      k.box(0.08, 0.3, 0.08, k.mat(0x1a1a1a, 0.6), 0.38, 0.95, sz * 0.3);
    }
    k.rod(V(0.38, 0.85, 0.3), V(0.5, 0.15, 0.55), 0.025, k.mat(0x111111, 0.7));
  },
  signPylon(k) {
    const steel = k.mat(0x3a3d40, 0.5, 0.6);
    for (const sx of [-1, 1]) k.block(0.22, 4.3, 0.22, steel, sx * 0.7, 0, 0);
    const face = k.text(lines(k.p.text, 'FUEL'), { w: 512, h: 512, bg: '#9a1a16', fg: '#f6efe0', border: '#f6efe0', emissive: 1.4 });
    k.block(1.9, 2.0, 0.3, k.mat(0x2a2c2e, 0.6), 0, 4.3, 0);
    for (const sz of [-1, 1]) k.box(1.8, 1.9, 0.01, face, 0, 5.3, sz * 0.156, { cast: false, ry: sz < 0 ? Math.PI : 0 });
    const prices = k.text(['REG  3.89', 'DSL  4.29'], { w: 512, h: 256, bg: '#101010', fg: '#ff9a3a', border: null, emissive: 1.2 });
    for (const sz of [-1, 1]) k.box(1.5, 0.8, 0.01, prices, 0, 3.7, sz * 0.12, { cast: false, ry: sz < 0 ? Math.PI : 0 });
    k.block(1.6, 0.9, 0.2, k.mat(0x2a2c2e, 0.6), 0, 3.25, 0);
  },
  dumpster(k) {
    const green = k.mat(0x2e4a34, 0.65, 0.3);
    const g = new THREE.BoxGeometry(2.0, 1.15, 1.3);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setZ(i, p.getZ(i) * 0.85);
    g.computeVertexNormals();
    k.add(g, green, 0, 0.72, 0);
    const lid = k.box(2.02, 0.05, 1.35, k.mat(0x1a1c1a, 0.7), 0, 1.32, 0);
    if ((k.p.variant ?? 0) === 1) {
      lid.position.set(0, 1.62, -0.85);
      lid.rotation.x = -1.2;
    }
    k.block(2.0, 0.12, 1.1, k.mat(0x151617, 0.7), 0, 0, 0);
    for (let i = 0; i < 3; i++) {
      const bag = jitter(new THREE.IcosahedronGeometry(0.3, 1), 0.1, i + 3);
      bag.scale(1, 0.7, 1);
      k.add(bag, k.mat(0x121315, 0.35, 0.1), -1.3 + i * 0.25, 0.2, 0.9 + (i % 2) * 0.2);
    }
  },
  tireStack(k) {
    const rubber = k.mat(0x141414, 0.85);
    const n = 3 + Math.floor(k.rand(1) * 2);
    for (let i = 0; i < n; i++) {
      const g = new THREE.TorusGeometry(0.3, 0.12, 6, 12);
      g.rotateX(Math.PI / 2);
      k.add(g, rubber, (k.rand(i) - 0.5) * 0.06, 0.12 + i * 0.24, (k.rand(i + 5) - 0.5) * 0.06);
    }
  },
  oilDrum(k) {
    const c = [0x2a4a6a, 0x6a2a1c, 0x5a4a2a][(k.p.variant ?? Math.floor(k.rand(2) * 3)) % 3];
    const m = k.mat(c, 0.55, 0.5, false);
    k.cyl(0.29, 0.29, 0.88, 14, m, 0, 0.44, 0);
    for (const y of [0.3, 0.6]) k.cyl(0.3, 0.3, 0.03, 14, m, 0, y, 0);
  },
  iceChest(k) {
    k.block(1.4, 1.1, 0.8, k.mat(0xc8ccd0, 0.5), 0, 0, 0);
    k.box(1.0, 0.45, 0.01, k.text(['ICE'], { w: 512, h: 256, bg: '#e8eef2', fg: '#2a5a8c', border: '#2a5a8c' }), 0, 0.68, 0.405, { cast: false });
  },
  storeShelf(k) {
    const len = k.p.length ?? 3;
    const steel = k.mat(0x7a7d80, 0.5, 0.4);
    k.block(len, 0.12, 0.9, steel, 0, 0, 0);
    k.block(len, 1.6, 0.05, steel, 0, 0, 0);
    const looted = (k.p.variant ?? 0) === 1;
    const goods = [0xc8a23a, 0x8c2a24, 0x2a5a8c, 0xd8d2c4, 0x3a6a3a, 0xc85a1c, 0x6a3a6a];
    for (let i = 0; i < 4; i++) {
      const y = 0.15 + i * 0.4;
      for (const sz of [-1, 1]) {
        k.block(len, 0.025, 0.42, steel, 0, y, sz * 0.23);
        let x = -len / 2 + 0.05;
        let n = 0;
        while (x < len / 2 - 0.15) {
          const w = 0.1 + k.rand(i * 100 + n + sz * 7) * 0.14;
          const h = 0.12 + k.rand(i * 50 + n + sz * 3) * 0.18;
          if (k.rand(i * 30 + n + sz) > (looted ? 0.65 : 0.25)) {
            k.block(w, h, 0.3, k.mat(goods[Math.floor(k.rand(n * 3 + i + sz) * goods.length)], 0.7), x + w / 2, y + 0.025, sz * 0.23, { cast: false });
          }
          x += w + 0.02;
          n++;
        }
      }
    }
  },
  storeCounter(k) {
    k.block(2.4, 1.0, 0.7, k.mat(0x5a4a3a, 0.7), 0, 0, 0);
    k.block(2.45, 0.04, 0.75, k.mat(0x8a8478, 0.4), 0, 1.0, 0);
    k.block(0.4, 0.15, 0.35, k.mat(0x1a1b1d, 0.5), -0.5, 1.04, 0);
    k.box(0.3, 0.2, 0.03, k.mat(0x0c0d0e, 0.2, 0.3), -0.5, 1.3, 0.05, { rx: -0.3 });
    k.block(0.6, 0.5, 0.25, k.mat(0x6a6058, 0.8), 0.7, 1.04, -0.2);
  },
  cooler(k) {
    const steel = k.mat(0x2a2c2e, 0.5, 0.5);
    k.block(2.0, 2.0, 0.8, steel, 0, 0, 0);
    k.box(1.86, 1.7, 0.01, k.glow(0xbfd8ff, 1.6), 0, 1.05, -0.2, { cast: false });
    const goods = [0x8c2a24, 0x2a5a8c, 0xc8a23a, 0x3a6a3a, 0xd8d2c4];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 10; j++) {
      if (k.rand(i * 10 + j) < 0.3) continue;
      k.block(0.12, 0.26, 0.12, k.mat(goods[(i + j) % goods.length], 0.4), -0.85 + j * 0.19, 0.25 + i * 0.42, 0.1, { cast: false });
    }
    const glass = k.lib.custom('glass-clear', () => new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.18, depthWrite: false }));
    glass.userData.envMap = true;
    k.box(1.9, 1.85, 0.02, glass, 0, 1.05, 0.39, { cast: false });
    for (let i = 0; i < 3; i++) k.block(0.05, 1.85, 0.05, steel, -0.95 + i * 0.95, 0.1, 0.39);
  },

  // ── Park ──────────────────────────────────────────────────────────────────
  swingSet(k) {
    const steel = k.mat(0x3a5a6a, 0.55, 0.5);
    for (const sx of [-1, 1]) {
      k.rod(V(sx * 2.0, 0, -0.8), V(sx * 2.0, 2.4, 0), 0.05, steel);
      k.rod(V(sx * 2.0, 0, 0.8), V(sx * 2.0, 2.4, 0), 0.05, steel);
    }
    k.rod(V(-2.05, 2.4, 0), V(2.05, 2.4, 0), 0.06, steel);
    const chain = k.mat(0x6a6a64, 0.5, 0.8);
    for (const [i, sx] of [-0.8, 0.8].entries()) {
      const swing = k.rand(i) * 0.4 - 0.2;
      for (const cz of [-0.2, 0.2]) k.rod(V(sx + cz, 2.4, 0), V(sx + cz, 0.55, Math.sin(swing) * 1.8), 0.012, chain);
      k.box(0.5, 0.04, 0.18, k.mat(0x1a1a1a, 0.8), sx, 0.55, Math.sin(swing) * 1.8);
    }
  },
  slide(k) {
    const steel = k.mat(0x6a6d70, 0.5, 0.6);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.block(0.06, 1.5, 0.06, steel, -1.2 + sx * 0.45, 0, sz * 0.45);
    k.block(1.0, 0.06, 1.0, k.mat(0x8c5a1c, 0.7), -1.2, 1.5, 0);
    for (const sz of [-1, 1]) k.block(1.0, 0.5, 0.04, k.mat(0x2a5a8c, 0.6), -1.2, 1.56, sz * 0.48);
    for (let i = 0; i < 5; i++) k.box(0.06, 0.04, 0.6, steel, -1.75, 0.3 + i * 0.3, 0);
    const len = Math.hypot(2.6, 1.2);
    const chute = k.box(len, 0.05, 0.6, k.mat(0xc8a21c, 0.35), 0.6, 0.92, 0, { rz: -Math.atan2(1.2, 2.6) });
    void chute;
    for (const sz of [-1, 1]) k.box(len, 0.15, 0.04, k.mat(0xc8a21c, 0.35), 0.6, 1.0, sz * 0.3, { rz: -Math.atan2(1.2, 2.6) });
  },
  merryGoRound(k) {
    const m = k.mat(0x8c2a24, 0.55, 0.3, false);
    k.cyl(1.4, 1.4, 0.1, 24, m, 0, 0.35, 0);
    k.cyl(0.12, 0.12, 0.3, 8, k.mat(0x3a3a3a, 0.5, 0.6), 0, 0.15, 0);
    const bar = k.mat(0xc8a21c, 0.4, 0.5);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.3;
      k.rod(V(Math.cos(a) * 1.2, 0.4, Math.sin(a) * 1.2), V(Math.cos(a) * 0.2, 1.1, Math.sin(a) * 0.2), 0.03, bar);
    }
  },
  sandbox(k) {
    const w = k.mat(0x6a5236, 0.9);
    for (const s of [-1, 1]) {
      k.block(3.0, 0.25, 0.12, w, 0, 0, s * 1.44);
      k.block(0.12, 0.25, 2.76, w, s * 1.44, 0, 0);
    }
    k.box(2.76, 0.01, 2.76, k.mat(0x8a7a5a, 1), 0, 0.15, 0, { cast: false });
    k.cyl(0.12, 0.1, 0.14, 10, k.mat(0xc8561c, 0.6), 0.6, 0.22, -0.4);
  },
  bench(k) {
    const iron = k.mat(0x1c1e1f, 0.5, 0.6);
    const wood = k.mat(0x5a4230, 0.85);
    for (const sx of [-1, 1]) {
      k.block(0.06, 0.45, 0.5, iron, sx * 0.8, 0, 0);
      k.box(0.06, 0.5, 0.06, iron, sx * 0.8, 0.7, -0.24, { rx: -0.15 });
    }
    for (let i = 0; i < 3; i++) k.block(1.8, 0.04, 0.14, wood, 0, 0.45, -0.17 + i * 0.17);
    for (let i = 0; i < 2; i++) k.box(1.8, 0.12, 0.03, wood, 0, 0.65 + i * 0.18, -0.26 - i * 0.03, { rx: -0.15 });
  },
  picnicTable(k) {
    const wood = k.mat(0x6a5236, 0.9);
    k.block(2.0, 0.05, 0.8, wood, 0, 0.72, 0);
    for (const sz of [-1, 1]) k.block(2.0, 0.04, 0.3, wood, 0, 0.42, sz * 0.62);
    for (const sx of [-0.75, 0.75]) for (const sz of [-1, 1]) k.rod(V(sx, 0, sz * 0.75), V(sx, 0.74, sz * 0.15), 0.05, wood, 4);
  },
  flagpole(k) {
    const steel = k.mat(0x8a8d90, 0.45, 0.7);
    k.cyl(0.11, 0.14, 0.3, 8, steel, 0, 0.15, 0);
    k.cyl(0.035, 0.06, 8.6, 8, steel, 0, 4.5, 0);
    k.add(new THREE.SphereGeometry(0.09, 8, 6), k.mat(0xb09a4a, 0.4, 0.8), 0, 8.86, 0, { cast: false });
    // The flag hangs limp and torn, half way down.
    const cloth = k.mat(0x6a2a26, 0.95);
    k.box(0.03, 1.2, 0.9, cloth, 0, 5.4, 0.5, { rx: 0.12, cast: false });
    k.box(0.03, 0.5, 0.5, k.mat(0x2a3350, 0.95), 0.012, 5.75, 0.3, { rx: 0.12, cast: false });
    k.rod(V(0, 0.9, 0.06), V(0, 8.7, 0.06), 0.008, k.mat(0x2a2a2a, 0.8), 3);
  },
  parkLamp(k) {
    const g = k.mat(0x1f2a22, 0.5, 0.5);
    k.cyl(0.12, 0.16, 0.4, 8, g, 0, 0.2, 0);
    k.cyl(0.05, 0.06, 3.5, 8, g, 0, 2.0, 0);
    k.cyl(0.16, 0.12, 0.12, 8, g, 0, 3.7, 0);
    k.add(new THREE.SphereGeometry(0.22, 12, 8), k.glow(0xdfe8ff, 5), 0, 3.95, 0, { cast: false });
    k.cyl(0.04, 0.2, 0.12, 8, g, 0, 4.22, 0);
  },
  gazebo(k) {
    const white = k.mat(0xb8b2a3, 0.75);
    k.cyl(3.1, 3.1, 0.3, 6, k.lib.get('darkWood').material, 0, 0.15, 0);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      k.block(0.18, 2.6, 0.18, white, Math.cos(a) * 2.8, 0.3, Math.sin(a) * 2.8);
      // Railings except on the entrance side facing -Z (between posts 4 and 5).
      if (i !== 4) {
        const b = ((i + 1) / 6) * Math.PI * 2;
        const a3 = V(Math.cos(a) * 2.8, 1.15, Math.sin(a) * 2.8);
        const b3 = V(Math.cos(b) * 2.8, 1.15, Math.sin(b) * 2.8);
        k.rod(a3, b3, 0.04, white, 4);
        k.rod(a3.clone().setY(0.6), b3.clone().setY(0.6), 0.03, white, 4);
      }
    }
    const roof = new THREE.ConeGeometry(3.7, 1.7, 6, 1);
    k.add(roof, k.mat(0x3a2d28, 0.9), 0, 3.75, 0);
    k.cyl(3.4, 3.4, 0.05, 6, k.mat(0x2a2420, 0.9), 0, 2.9, 0, { cast: false });
  },
  ironFence(k) {
    const len = k.p.length ?? 6;
    const iron = k.mat(0x131516, 0.5, 0.6);
    const posts = Math.max(2, Math.round(len / 2.4) + 1);
    for (let i = 0; i < posts; i++) k.block(0.1, 1.6, 0.1, iron, -len / 2 + (i * len) / (posts - 1), 0, 0);
    for (const y of [0.15, 1.3]) k.box(len, 0.05, 0.04, iron, 0, y, 0);
    // Pickets as one alpha-tested panel (cheap to draw and bake).
    const panel = k.lib.custom('iron-pickets', () => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 8;
      const x = c.getContext('2d')!;
      x.fillStyle = '#ffffff';
      x.fillRect(28, 0, 8, 8);
      const t = new THREE.CanvasTexture(c);
      t.wrapS = THREE.RepeatWrapping;
      const m = new THREE.MeshStandardMaterial({ color: 0x131516, roughness: 0.5, metalness: 0.6, alphaMap: t, alphaTest: 0.5, side: THREE.DoubleSide });
      return m;
    });
    const g = new THREE.PlaneGeometry(len, 1.35);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (len / 0.16));
    k.add(g, panel, 0, 0.8, 0);
  },

  // ── Backyards ─────────────────────────────────────────────────────────────
  shed(k) {
    const open = (k.p.variant ?? 0) === 1;
    const walls = k.lib.get(k.rand(1) > 0.5 ? 'sidingGray' : 'fenceWood').material;
    k.block(3.0, 0.1, 2.5, k.lib.get('concrete').material, 0, 0, 0);
    k.block(3.0, 2.3, 0.1, walls, 0, 0.1, -1.2);
    for (const sx of [-1, 1]) k.block(0.1, 2.3, 2.5, walls, sx * 1.45, 0.1, 0);
    if (!open) {
      k.block(3.0, 2.3, 0.1, walls, 0, 0.1, 1.2);
      k.block(1.1, 1.9, 0.03, k.mat(0x3a2e24, 0.8), 0, 0.1, 1.27);
    } else {
      k.block(3.0, 0.35, 0.1, walls, 0, 2.05, 1.2);
      k.block(0.9, 1.3, 0.4, k.mat(0x55595c, 0.5, 0.5), -0.9, 0.1, -0.95);
      k.block(0.6, 0.4, 0.4, k.mat(0x6b5236, 0.9), 0.6, 0.1, -0.9);
      k.cyl(0.25, 0.25, 0.6, 10, k.mat(0x2a4a2a, 0.7), 0.9, 0.4, 0.2);
    }
    const roof = gableRoof(3.0, 2.5, 0.7, 0.2);
    k.add(roof, k.mat(0x2a2624, 0.9), 0, 2.4, 0);
    k.box(2.9, 0.04, 2.4, k.mat(0x2a2420, 0.9), 0, 2.38, 0, { cast: false });
  },
  bbq(k) {
    const black = k.mat(0x141516, 0.5, 0.5, false);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      k.rod(V(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32), V(Math.cos(a) * 0.15, 0.62, Math.sin(a) * 0.15), 0.02, black);
    }
    const bowl = new THREE.SphereGeometry(0.3, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    k.add(bowl, black, 0, 0.78, 0);
    const lid = new THREE.SphereGeometry(0.3, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    k.add(lid, black, 0.12, 0.84, 0, { rz: -0.6 });
  },
  patioTable(k) {
    const m = k.mat(0x2a2c2e, 0.5, 0.5);
    k.cyl(0.6, 0.6, 0.04, 16, k.mat(0x6a6d70, 0.5, 0.3, false), 0, 0.74, 0);
    k.cyl(0.03, 0.03, 0.74, 6, m, 0, 0.37, 0);
    k.cyl(0.3, 0.3, 0.03, 12, m, 0, 0.02, 0);
    k.cyl(0.02, 0.02, 2.2, 6, k.mat(0x8a8478, 0.6), 0, 1.1, 0);
    k.add(new THREE.ConeGeometry(0.16, 1.2, 8), k.mat(0x6a2a24, 0.9), 0, 1.75, 0);
  },
  trampoline(k) {
    const steel = k.mat(0x3a4a5a, 0.5, 0.5);
    const ring = new THREE.TorusGeometry(1.8, 0.05, 6, 28);
    ring.rotateX(Math.PI / 2);
    k.add(ring, steel, 0, 0.85, 0);
    k.add(new THREE.CircleGeometry(1.7, 24).rotateX(-Math.PI / 2), k.mat(0x111214, 0.8), 0, 0.84, 0);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      k.rod(V(Math.cos(a) * 1.8, 0, Math.sin(a) * 1.8), V(Math.cos(a) * 1.8, 0.85, Math.sin(a) * 1.8), 0.03, steel);
    }
  },
  clothesline(k) {
    const steel = k.mat(0x6a6d70, 0.5, 0.6);
    for (const sx of [-1, 1]) {
      k.block(0.06, 2.0, 0.06, steel, sx * 2.5, 0, 0);
      k.box(0.05, 0.05, 1.0, steel, sx * 2.5, 1.95, 0);
    }
    const line = k.mat(0xb8b2a3, 0.8);
    for (const z of [-0.4, 0, 0.4]) k.box(5.0, 0.01, 0.01, line, 0, 1.93, z, { cast: false });
    const cloth = [0xb8b2a3, 0x5a6a7a, 0x8c3a30, 0x4a5a3a, 0xc8c0a8];
    for (let i = 0; i < 6; i++) {
      const w = 0.4 + k.rand(i) * 0.5;
      const h = 0.5 + k.rand(i + 9) * 0.4;
      const z = [-0.4, 0, 0.4][i % 3];
      const g = jitter(new THREE.PlaneGeometry(w, h, 2, 2), 0.04, i + 1);
      k.add(g, k.mat(cloth[i % cloth.length], 0.95, 0, false), -1.8 + i * 0.7, 1.93 - h / 2, z, { ry: Math.PI / 2 * 0 });
    }
  },
  woodpile(k) {
    const bark = k.mat(0x3e2c1e, 0.95);
    const cut = k.mat(0x8a6a44, 0.9);
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < 6 - (row % 2); i++) {
        const x = -0.85 + i * 0.32 + (row % 2) * 0.16;
        k.cyl(0.13, 0.13, 0.75, 7, bark, x, 0.13 + row * 0.24, 0, { rx: Math.PI / 2 });
        k.cyl(0.11, 0.11, 0.01, 7, cut, x, 0.13 + row * 0.24, 0.38, { rx: Math.PI / 2, cast: false });
      }
    }
  },
  doghouse(k) {
    const w = k.mat(0x6a4a2e, 0.9);
    k.block(1.0, 0.8, 1.2, w, 0, 0, 0);
    const roof = gableRoof(1.2, 1.0, 0.4, 0.12);
    roof.rotateY(Math.PI / 2);
    k.add(roof, k.mat(0x2a2624, 0.9), 0, 0.8, 0);
    k.box(0.45, 0.5, 0.02, k.mat(0x0a0a0a, 1), 0, 0.3, 0.6, { ry: Math.PI / 2, cast: false });
    k.box(0.02, 0.5, 0.45, k.mat(0x0a0a0a, 1), 0.505, 0.3, 0, { cast: false });
  },
  kiddiePool(k) {
    const ring = new THREE.TorusGeometry(1.0, 0.13, 6, 20);
    ring.rotateX(Math.PI / 2);
    k.add(ring, k.mat((k.p.variant ?? 0) ? 0x2a6a8c : 0x8c4a6a, 0.5), 0, 0.13, 0);
    const surface = new THREE.CircleGeometry(0.95, 20).rotateX(-Math.PI / 2);
    k.add(surface, water(k), 0, 0.18, 0, { cast: false });
  },
};
