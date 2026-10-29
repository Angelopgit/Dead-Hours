import * as THREE from 'three';
import type { PropKind } from '@dead-hours/shared';
import { jitter, type Kit, type Surface } from './Kit';

const FABRICS = [0x4a3b33, 0x3c4650, 0x56483a, 0x3d4a3c, 0x5a3a36];
const BLANKETS = [0x5b4a6a, 0x6a4a3a, 0x3e5262, 0x6b6450];
const BOOKS = [0x5d2a24, 0x2a3d55, 0x3f4a2c, 0x6b5a3a, 0x2c2a30, 0x704a24, 0x4a2a44];

type Builder = (k: Kit) => void;

function legs(k: Kit, w: number, d: number, h: number, r: number, m: Surface, inset = 0.06): void {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.block(r, h, r, m, sx * (w / 2 - inset), 0, sz * (d / 2 - inset));
}

export const INTERIOR: Partial<Record<PropKind, Builder>> = {
  sofa(k) {
    const f = k.mat(FABRICS[(k.p.variant ?? Math.floor(k.rand(1) * 5)) % FABRICS.length], 0.95);
    k.block(2.1, 0.42, 0.9, f, 0, 0.04, 0);
    k.block(2.1, 0.5, 0.22, f, 0, 0.42, -0.34);
    for (const sx of [-1, 1]) k.block(0.2, 0.62, 0.9, f, sx * 0.95, 0.04, 0);
    const c = k.mat(0x2a2420, 0.7);
    for (const sx of [-1, 1]) k.block(0.08, 0.06, 0.08, c, sx * 0.95, 0, 0.36);
    for (let i = 0; i < 3; i++) {
      const cush = k.block(0.56, 0.12, 0.62, f, -0.56 + i * 0.56, 0.44, 0.08);
      cush.rotation.z = (k.rand(i) - 0.5) * 0.06;
    }
  },
  armchair(k) {
    const f = k.mat(FABRICS[(k.p.variant ?? Math.floor(k.rand(2) * 5) + 1) % FABRICS.length], 0.95);
    k.block(0.9, 0.42, 0.9, f, 0, 0.04, 0);
    k.block(0.9, 0.55, 0.22, f, 0, 0.42, -0.34);
    for (const sx of [-1, 1]) k.block(0.16, 0.6, 0.9, f, sx * 0.37, 0.04, 0);
  },
  coffeeTable(k) {
    const w = k.mat(0x3a2a1e, 0.6);
    k.block(1.2, 0.05, 0.7, w, 0, 0.4, 0);
    legs(k, 1.2, 0.7, 0.4, 0.05, w);
    k.block(0.24, 0.03, 0.17, k.mat(0x8a8070, 0.9), 0.2, 0.45, 0.05, { ry: 0.4 });
  },
  tvStand(k) {
    const w = k.mat(0x2e241c, 0.7);
    k.block(1.6, 0.5, 0.45, w, 0, 0, 0);
    k.block(1.12, 0.66, 0.06, k.mat(0x0a0b0d, 0.25, 0.4), 0, 0.56, -0.05);
    k.block(0.3, 0.05, 0.18, k.mat(0x111214, 0.5), 0, 0.5, -0.05);
  },
  bed(k) {
    const frame = k.mat(0x3a2a1e, 0.7);
    k.block(2.1, 0.3, 1.5, frame, 0, 0, 0);
    k.block(2.0, 0.22, 1.42, k.mat(0xc8c2b4, 0.95), 0.03, 0.3, 0);
    k.block(0.08, 0.95, 1.55, frame, -1.06, 0, 0);
    const blanket = jitter(new THREE.BoxGeometry(1.4, 0.1, 1.48, 4, 1, 4), 0.04, Math.round(k.p.x * 7));
    k.add(blanket, k.mat(BLANKETS[(k.p.variant ?? 0) % BLANKETS.length], 0.95), 0.32, 0.56, 0);
    k.block(0.4, 0.12, 0.6, k.mat(0xd8d2c4, 0.95), -0.78, 0.52, -0.33);
    if ((k.p.variant ?? 0) === 0) k.block(0.4, 0.12, 0.6, k.mat(0xd8d2c4, 0.95), -0.78, 0.52, 0.33);
  },
  wardrobe(k) {
    const w = k.mat(0x4a3626, 0.7);
    k.block(1.2, 2.0, 0.6, w, 0, 0, 0);
    k.block(0.02, 1.8, 0.01, k.mat(0x1c140e, 0.8), 0, 0.12, 0.305);
    const knob = k.mat(0x8d7a4a, 0.3, 0.9);
    for (const sx of [-1, 1]) k.block(0.03, 0.18, 0.03, knob, sx * 0.07, 1.0, 0.31);
  },
  bookshelf(k) {
    const w = k.mat(0x3a2a1e, 0.7);
    k.block(1.0, 1.9, 0.04, w, 0, 0, -0.155);
    for (const sx of [-1, 1]) k.block(0.04, 1.9, 0.35, w, sx * 0.48, 0, 0);
    for (let i = 0; i < 5; i++) {
      const y = 0.04 + i * 0.45;
      k.block(0.96, 0.03, 0.33, w, 0, y, 0);
      if (i === 4) break;
      let x = -0.44;
      let n = 0;
      while (x < 0.4) {
        const bw = 0.03 + k.rand(i * 50 + n) * 0.05;
        const bh = 0.22 + k.rand(i * 70 + n) * 0.14;
        if (k.rand(i * 90 + n) > 0.12) k.block(bw, bh, 0.24, k.mat(BOOKS[Math.floor(k.rand(n + i * 11) * BOOKS.length)], 0.85), x + bw / 2, y + 0.03, 0.01);
        x += bw + 0.004;
        n++;
      }
    }
  },
  counter(k) {
    const len = k.p.length ?? 2.4;
    k.block(len, 0.84, 0.6, k.mat(0x5a4636, 0.75), 0, 0.02, -0.02);
    k.block(len + 0.02, 0.05, 0.66, k.mat(0x6d6a63, 0.35), 0, 0.86, 0);
    const seam = k.mat(0x2a1f17, 0.8);
    const n = Math.max(1, Math.round(len / 0.5));
    for (let i = 1; i < n; i++) k.block(0.01, 0.74, 0.01, seam, -len / 2 + (i * len) / n, 0.06, 0.285);
    for (let i = 0; i < n; i++) k.block(0.12, 0.02, 0.02, k.mat(0x8a8a86, 0.35, 0.8), -len / 2 + ((i + 0.5) * len) / n, 0.72, 0.29);
  },
  fridge(k) {
    const white = k.mat(0xb8b6ae, 0.4);
    k.block(0.8, 1.8, 0.7, white, 0, 0, 0);
    k.block(0.78, 0.01, 0.01, k.mat(0x3a3a38, 0.6), 0, 1.22, 0.355);
    k.block(0.03, 0.5, 0.04, k.mat(0x9a9a96, 0.3, 0.8), 0.32, 1.35, 0.37);
    k.block(0.03, 0.7, 0.04, k.mat(0x9a9a96, 0.3, 0.8), 0.32, 0.4, 0.37);
  },
  stove(k) {
    const white = k.mat(0xaeaca4, 0.45);
    k.block(0.76, 0.9, 0.65, white, 0, 0, 0);
    k.block(0.76, 0.22, 0.05, white, 0, 0.9, -0.3);
    const burner = k.mat(0x141414, 0.6, 0.4);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(0.09, 0.09, 0.02, 10, burner, sx * 0.18, 0.91, sz * 0.15);
    k.block(0.6, 0.4, 0.01, k.mat(0x1a1a1c, 0.2, 0.3), 0, 0.3, 0.326);
  },
  diningTable(k) {
    const w = k.mat(0x4a3626, 0.6);
    k.block(1.6, 0.05, 0.9, w, 0, 0.72, 0);
    legs(k, 1.6, 0.9, 0.72, 0.06, w, 0.08);
  },
  chair(k) {
    const w = k.mat(0x3e2c1f, 0.7);
    k.block(0.42, 0.04, 0.42, w, 0, 0.44, 0);
    legs(k, 0.42, 0.42, 0.44, 0.035, w, 0.03);
    k.block(0.42, 0.48, 0.04, w, 0, 0.48, -0.19);
  },
  workbench(k) {
    const wood = k.mat(0x5d4630, 0.85);
    const metal = k.mat(0x3a3d40, 0.5, 0.6);
    k.block(2.4, 0.06, 0.75, wood, 0, 0.9, 0);
    legs(k, 2.4, 0.75, 0.9, 0.08, metal, 0.06);
    k.block(2.3, 0.03, 0.65, wood, 0, 0.25, 0);
    // Pegboard with tools: the weapon preparation station.
    k.block(2.4, 1.1, 0.03, k.mat(0x6a5a44, 0.9), 0, 1.0, -0.36);
    const tool = k.mat(0x2a2c2e, 0.5, 0.6);
    for (let i = 0; i < 9; i++) {
      const tw = 0.04 + k.rand(i) * 0.06;
      const th = 0.18 + k.rand(i + 9) * 0.3;
      k.block(tw, th, 0.03, i % 3 ? tool : k.mat(0x7a2a1c, 0.6), -1.0 + i * 0.25, 1.3 + k.rand(i + 20) * 0.35, -0.33);
    }
    // A rifle being stripped, magazines and a box of rounds.
    const gun = k.mat(0x161718, 0.45, 0.5);
    k.block(0.9, 0.06, 0.07, gun, -0.3, 0.97, 0.1, { ry: 0.15 });
    k.block(0.25, 0.1, 0.05, k.mat(0x3a2a1e, 0.7), 0.25, 0.97, 0.03, { ry: 0.15 });
    for (let i = 0; i < 3; i++) k.block(0.04, 0.16, 0.08, gun, 0.55 + i * 0.07, 0.96, 0.15, { rz: 0.1 * i });
    k.block(0.2, 0.08, 0.13, k.mat(0x6b5a2a, 0.8), 0.85, 0.96, -0.05);
    // Vise.
    k.block(0.14, 0.12, 0.16, k.mat(0x24425e, 0.5, 0.5), -1.05, 0.96, 0.3);
    // Gun rack on the pegboard.
    for (let i = 0; i < 2; i++) k.block(1.2, 0.07, 0.06, gun, 0.4, 1.55 + i * 0.22, -0.31, { rz: 0.02 });
  },
  metalShelf(k) {
    const m = k.mat(0x55595c, 0.5, 0.6);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.block(0.04, 1.9, 0.04, m, sx * 0.58, 0, sz * 0.2);
    const ammo = (k.p.variant ?? 0) === 1;
    for (let i = 0; i < 4; i++) {
      const y = 0.08 + i * 0.55;
      k.block(1.2, 0.03, 0.44, m, 0, y, 0);
      if (i === 3 && !ammo) break;
      let x = -0.5;
      let n = 0;
      while (x < 0.45) {
        const w = ammo ? 0.28 : 0.14 + k.rand(i * 31 + n) * 0.2;
        const h = ammo ? 0.18 : 0.12 + k.rand(i * 17 + n) * 0.22;
        if (k.rand(i * 13 + n) > 0.18) {
          const c = ammo ? (n % 3 === 2 ? 0x6b5a2a : 0x3d4530) : [0x6a5a44, 0x7a2a1c, 0x2a3d55, 0x8a8070][Math.floor(k.rand(n + i) * 4)];
          k.block(w, h, 0.3, k.mat(c, 0.8), x + w / 2, y + 0.03, 0);
        }
        x += w + 0.03;
        n++;
      }
    }
  },
  crate(k) {
    const w = k.mat(0x6b5236, 0.9);
    k.block(0.8, 0.6, 0.6, w, 0, 0, 0);
    const dark = k.mat(0x4a3826, 0.9);
    for (const sz of [-1, 1]) for (const y of [0.08, 0.52]) k.block(0.82, 0.08, 0.02, dark, 0, y - 0.04, sz * 0.305);
    for (const sx of [-1, 1]) k.block(0.08, 0.6, 0.62, dark, sx * 0.38, 0, 0);
  },
  ammoCrate(k) {
    const g = k.mat(0x3a4230, 0.75, 0.2);
    k.block(0.9, 0.4, 0.5, g, 0, 0, 0);
    k.block(0.92, 0.06, 0.52, k.mat(0x2e3527, 0.7, 0.2), 0, 0.4, 0);
    k.block(0.5, 0.12, 0.01, k.mat(0xb8a86a, 0.8), 0, 0.2, 0.255);
    const latch = k.mat(0x6a6a64, 0.4, 0.8);
    for (const sx of [-1, 1]) k.block(0.06, 0.1, 0.03, latch, sx * 0.32, 0.32, 0.26);
  },
  washer(k) {
    k.block(0.64, 0.9, 0.64, k.mat(0xb4b2aa, 0.45), 0, 0, 0);
    k.cyl(0.2, 0.2, 0.03, 16, k.mat(0x22272c, 0.15, 0.4), 0, 0.45, 0.32, { rx: Math.PI / 2 });
  },
  waterHeater(k) {
    k.cyl(0.29, 0.29, 1.45, 14, k.mat(0x9e9b92, 0.5, 0.2, false), 0, 0.73, 0);
    const pipe = k.mat(0x8a5a3a, 0.4, 0.8);
    for (const sx of [-1, 1]) k.cyl(0.025, 0.025, 1.2, 6, pipe, sx * 0.12, 2.0, -0.1);
  },
  desk(k) {
    const w = k.mat(0x4a3626, 0.65);
    k.block(1.3, 0.04, 0.65, w, 0, 0.72, 0);
    k.block(0.4, 0.72, 0.6, w, 0.42, 0, 0);
    for (const sx of [-1]) for (const sz of [-1, 1]) k.block(0.05, 0.72, 0.05, w, sx * 0.6, 0, sz * 0.27);
    k.block(0.3, 0.22, 0.24, k.mat(0x1a1b1d, 0.5), -0.25, 0.76, -0.1);
    k.block(0.5, 0.02, 0.35, k.mat(0xd8d2c4, 0.9), 0.2, 0.765, 0.08, { ry: 0.3 });
  },
  dresser(k) {
    const w = k.mat(0x523c2a, 0.7);
    k.block(1.2, 0.85, 0.5, w, 0, 0, 0);
    const knob = k.mat(0x8d7a4a, 0.3, 0.9);
    for (let i = 0; i < 3; i++) {
      k.block(1.12, 0.01, 0.01, k.mat(0x241a12, 0.8), 0, 0.27 + i * 0.27, 0.252);
      for (const sx of [-1, 1]) k.block(0.08, 0.03, 0.03, knob, sx * 0.3, 0.14 + i * 0.27, 0.26);
    }
  },
  rug(k) {
    const len = k.p.length ?? 2.4;
    const m = k.mat([0x5a3a30, 0x3a4252][Math.floor(k.rand(3) * 2)], 1);
    k.block(len, 0.012, len * 0.68, m, 0, 0.012, 0, { cast: false });
    k.block(len - 0.3, 0.013, len * 0.68 - 0.3, k.mat(0x6e5a44, 1), 0, 0.013, 0, { cast: false });
  },
  floorLamp(k) {
    const m = k.mat(0x2a2a28, 0.5, 0.6);
    k.cyl(0.16, 0.18, 0.04, 12, m, 0, 0.02, 0);
    k.cyl(0.015, 0.015, 1.45, 6, m, 0, 0.75, 0);
    k.cyl(0.14, 0.22, 0.26, 12, k.mat(0x8a7a5a, 0.9), 0, 1.5, 0);
  },
  mattress(k) {
    const g = jitter(new THREE.BoxGeometry(1.95, 0.2, 0.9, 4, 1, 2), 0.03, Math.round(k.p.z * 5));
    k.add(g, k.mat(0x9a917c, 0.95), 0, 0.1, 0);
    const blanket = jitter(new THREE.BoxGeometry(1.2, 0.06, 0.95, 3, 1, 3), 0.05, Math.round(k.p.x * 3));
    k.add(blanket, k.mat(BLANKETS[Math.floor(k.rand(5) * BLANKETS.length)], 0.95), 0.3, 0.22, 0.02, { ry: 0.1 });
    k.block(0.35, 0.1, 0.55, k.mat(0xc8c0b0, 0.95), -0.72, 0.2, 0);
  },
  pallet(k) {
    const w = k.mat(0x7a6040, 0.95);
    for (let i = 0; i < 5; i++) k.block(1.2, 0.025, 0.14, w, 0, 0.12, -0.42 + i * 0.21);
    for (const sz of [-1, 0, 1]) k.block(1.2, 0.1, 0.1, w, 0, 0.02, sz * 0.42);
  },
  railing(k) {
    const len = k.p.length ?? 2;
    const w = k.mat(0x3a2a1e, 0.65);
    const n = Math.max(2, Math.round(len / 0.9) + 1);
    for (let i = 0; i < n; i++) k.block(0.06, 0.95, 0.06, w, -len / 2 + (i * len) / (n - 1), 0, 0);
    k.block(len + 0.06, 0.06, 0.08, w, 0, 0.95, 0);
    k.block(len, 0.04, 0.03, w, 0, 0.5, 0);
  },
  ceilingLamp(k) {
    k.box(1.1, 0.05, 0.35, k.mat(0x2a2c30, 0.6), 0, -0.03, 0, { cast: false });
  },
};
