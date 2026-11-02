/**
 * Headless walkthrough of every enterable building in the shared map. Run with
 * `npm run check:houses`.
 *
 * Checks that walls have no gaps (solid wall everywhere except real openings, glass in every
 * window), that every floor and ceiling is whole except over stairs, that floorboards cover
 * every room and door threshold, that nothing blocks a doorway, a staircase or the inside of a
 * window, that furniture stands on a floor, that every room can be walked to, that every
 * storey has a light, and that none of the renderer's house dressing hangs in a stairwell.
 */
import {
  MAPLE_HOLLOW as map, NAV_REACHABLE, Physics, STORY, buildNavGridSync, propColliders, storeyFloors, houseTop,
  type HouseSpec, type StaticBox, type StairSpec,
} from '@dead-hours/shared';
import * as THREE from 'three';
import { RAPIER, initPhysics } from '../src/core/Physics';
import { dressHouses } from '../src/environment/Houses';
import type { MaterialLibrary } from '../src/rendering/Materials';
import type { StaticBatcher } from '../src/rendering/StaticBatcher';

let failures = 0;
const fail = (msg: string) => { failures++; console.log('  FAIL ' + msg); };
const ok = (msg: string) => console.log('  ok   ' + msg);
const f2 = (n: number) => n.toFixed(2);

const houses = map.houses.filter((h) => h.enterable);
const solid = map.solids.filter((s) => s.collide !== false);
const finish = map.solids.filter((s) => s.collide === false);
const inBox = (s: StaticBox, x: number, y: number, z: number, pad = 0) =>
  Math.abs(x - s.x) <= s.w / 2 + pad && Math.abs(y - s.y) <= s.h / 2 + pad && Math.abs(z - s.z) <= s.d / 2 + pad;
const near = (h: HouseSpec, s: StaticBox) => Math.abs(s.x - h.x) < h.w / 2 + s.w / 2 + 0.5 && Math.abs(s.z - h.z) < h.d / 2 + s.d / 2 + 0.5;
const storeyHeight = (h: HouseSpec, i: number) => (i === 0 ? h.groundHeight ?? STORY.ground : STORY.upper);
/** Stairs footprint (with the few centimetres a stairwell is cut wider than its steps). */
const overStairs = (st: StairSpec, x: number, z: number, pad = 0.1) => {
  const lo = Math.min(st.from, st.to) - pad, hi = Math.max(st.from, st.to) + pad;
  const along = st.axis === 'z' ? z : x, across = st.axis === 'z' ? x : z;
  return along >= lo && along <= hi && across >= st.a0 - pad && across <= st.a1 + pad;
};

await initPhysics();
const phys = new Physics(map);

// Props only, for clearance checks.
const propWorld = new RAPIER.World({ x: 0, y: 0, z: 0 });
const propBody = propWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const propOf: string[] = [];
for (const p of map.props) {
  for (const b of propColliders(p)) {
    const c = propWorld.createCollider(
      RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z).setRotation({ x: 0, y: Math.sin(b.rotY / 2), z: 0, w: Math.cos(b.rotY / 2) }),
      propBody,
    );
    propOf[c.handle] = `${p.kind} @(${f2(p.x)}, ${f2(p.y ?? 0)}, ${f2(p.z)})`;
  }
}
propWorld.step();
/** Props intersecting an axis-aligned box. */
const propsIn = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, ignore: (name: string) => boolean = () => false): string[] => {
  const found: string[] = [];
  const shape = new RAPIER.Cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2);
  propWorld.intersectionsWithShape({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 }, { x: 0, y: 0, z: 0, w: 1 }, shape, (c) => {
    const name = propOf[c.handle];
    if (!ignore(name)) found.push(name);
    return true;
  });
  return found;
};

console.log(`Walls: solid everywhere but their openings, glass in every window (${houses.length} buildings)`);
for (const h of houses) {
  const local = solid.filter((s) => near(h, s));
  const frontSign = h.facing === 'south' ? 1 : -1;
  const skip = new Set(h.skipWalls ?? []);
  const t = STORY.wall;
  let gaps = 0, blind = 0, samples = 0;
  storeyFloors(h).forEach((y0, si) => {
    const hgt = storeyHeight(h, si);
    const walls = [
      { side: 'front', axis: 'x' as const, c: h.z + frontSign * (h.d / 2 - t / 2), a0: h.x - h.w / 2, a1: h.x + h.w / 2, out: frontSign },
      { side: 'back', axis: 'x' as const, c: h.z - frontSign * (h.d / 2 - t / 2), a0: h.x - h.w / 2, a1: h.x + h.w / 2, out: -frontSign },
      { side: 'west', axis: 'z' as const, c: h.x - (h.w / 2 - t / 2), a0: h.z - h.d / 2, a1: h.z + h.d / 2, out: -1 },
      { side: 'east', axis: 'z' as const, c: h.x + (h.w / 2 - t / 2), a0: h.z - h.d / 2, a1: h.z + h.d / 2, out: 1 },
    ];
    for (const w of walls) {
      if (skip.has(w.side as never)) continue;
      const openings = [
        ...map.windows.filter((o) => o.houseId === h.id && o.axis === w.axis && o.outward === w.out && Math.abs(o.y - (y0 + hgt / 2)) < hgt / 2)
          .map((o) => ({ at: w.axis === 'x' ? o.x : o.z, half: o.w / 2, y0: o.y - o.h / 2, y1: o.y + o.h / 2, glass: true })),
        ...map.doors.filter((o) => o.houseId === h.id && o.exterior && o.axis === w.axis && o.outward === w.out && Math.abs((o.floorY ?? 0.3) - y0) < 0.05)
          .map((o) => ({ at: w.axis === 'x' ? o.x : o.z, half: o.w / 2, y0: o.y - o.h / 2, y1: o.y + o.h / 2, glass: false })),
      ];
      for (let a = w.a0 + 0.04; a < w.a1 - 0.03; a += 0.1) {
        for (let y = y0 + 0.04; y < y0 + hgt - 0.03; y += 0.15) {
          // Stay clear of the opening edges (sampling exactly on a seam proves nothing).
          const o = openings.find((op) => Math.abs(a - op.at) < op.half + 0.02 && y > op.y0 - 0.02 && y < op.y1 + 0.02);
          if (o && (Math.abs(Math.abs(a - o.at) - o.half) < 0.03 || Math.abs(y - o.y0) < 0.03 || Math.abs(y - o.y1) < 0.03)) continue;
          samples++;
          const x = w.axis === 'x' ? a : w.c, z = w.axis === 'x' ? w.c : a;
          const hits = local.filter((s) => inBox(s, x, y, z));
          if (o) {
            const glass = hits.some((s) => s.glass);
            const wall = hits.some((s) => !s.glass);
            if ((o.glass && !glass) || wall) {
              blind++;
              if (blind <= 3) fail(`${h.id} ${w.side} wall storey ${si}: opening at ${f2(a)} y ${f2(y)} ${wall ? 'is walled over' : 'has no glass'}`);
            }
          } else if (!hits.some((s) => !s.glass)) {
            gaps++;
            if (gaps <= 3) fail(`${h.id} ${w.side} wall storey ${si}: gap at (${f2(x)}, ${f2(y)}, ${f2(z)})`);
          }
        }
      }
    }
  });
  if (!gaps && !blind) ok(`${h.id}: ${samples} wall samples, no gaps, every opening clear and glazed`);
  else fail(`${h.id}: ${gaps} gap samples, ${blind} bad opening samples`);
}

console.log('Interior doorways: wall on both sides, a lintel above and floor beneath');
for (const d of map.doors.filter((dd) => !dd.exterior && houses.some((h) => h.id === dd.houseId))) {
  const floor = d.floorY ?? 0.3;
  const along = (o: number) => (d.axis === 'x' ? [d.x + o, d.z] : [d.x, d.z + o]);
  const problems: string[] = [];
  for (const sgn of [-1, 1]) {
    const [x, z] = along(sgn * (d.w / 2 + 0.06));
    if (!solid.some((s) => inBox(s, x, floor + 1.2, z))) problems.push(`no wall at the ${sgn < 0 ? 'low' : 'high'} side`);
  }
  const [cx, cz] = along(0);
  const top = floor + d.h;
  const ceiling = floor + storeyHeight(map.houses.find((h) => h.id === d.houseId)!, floor > 2 ? 1 : 0);
  if (top < ceiling - 0.05 && !solid.some((s) => inBox(s, cx, top + 0.05, cz))) problems.push('no lintel');
  if (solid.some((s) => inBox(s, cx, floor + 1.0, cz))) problems.push('opening blocked');
  if (!solid.some((s) => inBox(s, cx, floor - 0.02, cz))) problems.push('no floor');
  if (!finish.some((s) => inBox(s, cx, floor + 0.006, cz))) problems.push('no floorboards');
  if (problems.length) fail(`${d.id} at (${f2(d.x)}, ${f2(d.z)}): ${problems.join(', ')}`);
}
ok('interior doorways framed (failures listed above)');

console.log('Floors, floorboards and ceilings: whole except over stairs');
for (const h of houses) {
  const t = STORY.wall;
  const stairs = map.stairs.filter((s) => s.houseId === h.id || (Math.abs(s.from - h.z) < h.d && Math.abs(s.a0 - h.x) < h.w));
  const local = solid.filter((s) => near(h, s));
  const localFinish = finish.filter((s) => near(h, s));
  const floors = storeyFloors(h);
  let holes = 0, bare = 0, loose = 0, sky = 0, n = 0;
  floors.forEach((y0, si) => {
    const ceiling = y0 + storeyHeight(h, si);
    for (let x = h.x - h.w / 2 + t + 0.06; x < h.x + h.w / 2 - t - 0.05; x += 0.25) {
      for (let z = h.z - h.d / 2 + t + 0.06; z < h.z + h.d / 2 - t - 0.05; z += 0.25) {
        n++;
        const stair = stairs.some((s) => overStairs(s, x, z));
        // Inside a wall or partition: nothing to check.
        if (local.some((s) => !s.glass && inBox(s, x, y0 + 1.0, z))) continue;
        const slab = local.some((s) => inBox(s, x, y0 - 0.02, z));
        const boards = localFinish.some((s) => inBox(s, x, y0 + 0.006, z));
        const roof = local.some((s) => inBox(s, x, ceiling + 0.05, z));
        if (!slab && !stair) { holes++; if (holes <= 3) fail(`${h.id} storey ${si}: hole in the floor at (${f2(x)}, ${f2(z)})`); }
        if (!boards && slab && !stair) { bare++; if (bare <= 3) fail(`${h.id} storey ${si}: no floorboards at (${f2(x)}, ${f2(z)})`); }
        if (boards && !slab) { loose++; if (loose <= 3) fail(`${h.id} storey ${si}: floorboards over a hole at (${f2(x)}, ${f2(z)})`); }
        if (!roof && !stair) { sky++; if (sky <= 3) fail(`${h.id} storey ${si}: open ceiling at (${f2(x)}, ${f2(z)})`); }
      }
    }
  });
  // Door thresholds: floorboards across the wall under every exterior door.
  for (const d of map.doors.filter((dd) => dd.houseId === h.id && dd.exterior)) {
    const y = (d.floorY ?? 0.3) + 0.006;
    if (!localFinish.some((s) => inBox(s, d.x, y, d.z))) fail(`${d.id}: no threshold under the door`);
  }
  if (!holes && !bare && !loose && !sky) ok(`${h.id}: ${n} floor samples over ${floors.length} storey(s), all covered`);
}

console.log('Basements: floor, four walls and a ceiling');
for (const r of map.excavations) {
  let bad = 0;
  for (let x = r.x0 + 0.4; x < r.x1 - 0.3; x += 0.3) {
    for (let z = r.z0 + 0.4; z < r.z1 - 0.3; z += 0.3) {
      const st = map.stairs.find((s) => overStairs(s, x, z, 0.02));
      const floor = solid.some((s) => inBox(s, x, -2.72, z));
      const ceiling = solid.some((s) => inBox(s, x, 0.02, z));
      if (!floor || (!ceiling && !st)) { bad++; if (bad <= 3) fail(`basement (${f2(r.x0)}..${f2(r.x1)}, ${f2(r.z0)}..${f2(r.z1)}): ${floor ? 'open ceiling' : 'no floor'} at (${f2(x)}, ${f2(z)})`); }
    }
  }
  // The walls: probe just inside each edge at mid height.
  const mid = -1.4;
  const probes = [
    ...[0.25, 0.5, 0.75].map((k) => [r.x0 + 0.12, r.z0 + (r.z1 - r.z0) * k]),
    ...[0.25, 0.5, 0.75].map((k) => [r.x1 - 0.12, r.z0 + (r.z1 - r.z0) * k]),
    ...[0.25, 0.5, 0.75].map((k) => [r.x0 + (r.x1 - r.x0) * k, r.z0 + 0.12]),
    ...[0.25, 0.5, 0.75].map((k) => [r.x0 + (r.x1 - r.x0) * k, r.z1 - 0.12]),
  ];
  for (const [x, z] of probes) if (!solid.some((s) => inBox(s, x, mid, z))) { bad++; fail(`basement wall missing near (${f2(x)}, ${f2(z)})`); }
  if (!bad) ok(`basement (${f2(r.x0)}..${f2(r.x1)}, ${f2(r.z0)}..${f2(r.z1)}) closed`);
}

console.log('Nothing blocks a doorway, a window from inside, or the ends of a staircase');
{
  let n = 0;
  const outdoor = new Set(['mailbox', 'trashBin', 'bush', 'tree', 'pine', 'car', 'fence', 'bbq', 'patioTable', 'chair']);
  for (const d of map.doors) {
    const h = houses.find((hh) => hh.id === d.houseId);
    if (!h) continue;
    const floor = d.floorY ?? 0.3;
    const thick = d.exterior ? STORY.wall : 0.14;
    for (const side of [-1, 1]) {
      // Outside an exterior door only the step matters; yard furniture can stand a little way off.
      const depth = d.exterior && side === d.outward ? 0.6 : 0.9;
      const half = d.w / 2 - 0.05;
      const n0 = thick / 2 + 0.02, n1 = thick / 2 + depth;
      const [lo, hi] = side > 0 ? [n0, n1] : [-n1, -n0];
      const box = d.axis === 'x'
        ? [d.x - half, floor + 0.12, d.z + lo, d.x + half, floor + 1.8, d.z + hi]
        : [d.x + lo, floor + 0.12, d.z - half, d.x + hi, floor + 1.8, d.z + half];
      const hits = propsIn(box[0], box[1], box[2], box[3], box[4], box[5], (name) => d.exterior && side === d.outward && outdoor.has(name.split(' ')[0]));
      for (const name of hits) { n++; fail(`${d.id}: ${name} blocks the ${side === d.outward ? 'outer' : 'inner'} side`); }
    }
  }
  for (const w of map.windows) {
    const h = houses.find((hh) => hh.id === w.houseId);
    if (!h || w.plain) continue;
    const inward = -w.outward;
    const n0 = STORY.wall / 2 + 0.01, n1 = STORY.wall / 2 + 0.45;
    const [lo, hi] = inward > 0 ? [n0, n1] : [-n1, -n0];
    const y0 = w.y - w.h / 2 + 0.08, y1 = w.y + w.h / 2;
    const half = w.w / 2 - 0.05;
    const box = w.axis === 'x' ? [w.x - half, y0, w.z + lo, w.x + half, y1, w.z + hi] : [w.x + lo, y0, w.z - half, w.x + hi, y1, w.z + half];
    for (const name of propsIn(box[0], box[1], box[2], box[3], box[4], box[5], (nm) => nm.startsWith('railing'))) {
      n++;
      fail(`${w.id}: ${name} stands in front of the window`);
    }
  }
  for (const st of map.stairs) {
    const dir = Math.sign(st.to - st.from);
    for (const [end, y, sgn] of [[st.from, st.y0, -1], [st.to, st.y1, 1]] as const) {
      const a = end + sgn * dir * 0.02, b = end + sgn * dir * 0.9;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const box = st.axis === 'z' ? [st.a0 + 0.05, y + 0.12, lo, st.a1 - 0.05, y + 1.8, hi] : [lo, y + 0.12, st.a0 + 0.05, hi, y + 1.8, st.a1 - 0.05];
      for (const name of propsIn(box[0], box[1], box[2], box[3], box[4], box[5])) {
        n++;
        fail(`stairs ${st.houseId} (${f2(st.from)}->${f2(st.to)}): ${name} blocks the ${sgn < 0 ? 'bottom' : 'top'}`);
      }
      // Nor any wall.
      const [cx, cz] = st.axis === 'z' ? [(st.a0 + st.a1) / 2, (lo + hi) / 2] : [(lo + hi) / 2, (st.a0 + st.a1) / 2];
      if (solid.some((s) => !s.glass && inBox(s, cx, y + 1.0, cz) && s.mat !== 'darkWood' && s.mat !== 'concrete')) {
        n++;
        fail(`stairs ${st.houseId} (${f2(st.from)}->${f2(st.to)}): wall at the ${sgn < 0 ? 'bottom' : 'top'}`);
      }
    }
  }
  if (!n) ok(`${map.doors.length} doorways, ${map.windows.length} windows and ${map.stairs.length} staircases clear`);
}

console.log('Furniture stands on a floor and inside its building');
{
  let n = 0;
  const hanging = new Set(['firstAid', 'ceilingLamp', 'railing', 'rug']);
  for (const p of map.props) {
    const h = houses.find((hh) => Math.abs(p.x - hh.x) < hh.w / 2 && Math.abs(p.z - hh.z) < hh.d / 2);
    if (!h || hanging.has(p.kind)) continue;
    const y = p.y ?? 0;
    const floors = [...storeyFloors(h), -2.7];
    const onFloor = floors.some((f) => Math.abs(y - f) < 0.02);
    // Or stacked on another prop.
    const stacked = !onFloor && propsIn(p.x - 0.05, y - 0.08, p.z - 0.05, p.x + 0.05, y - 0.02, p.z + 0.05).length > 0;
    const ground = solid.some((s) => inBox(s, p.x, y - 0.03, p.z));
    if (!onFloor && !stacked) { n++; fail(`${p.kind} @(${f2(p.x)}, ${f2(y)}, ${f2(p.z)}) floats at ${f2(y)} in ${h.id}`); }
    else if (onFloor && !ground) { n++; fail(`${p.kind} @(${f2(p.x)}, ${f2(y)}, ${f2(p.z)}) stands over a hole in ${h.id}`); }
    // Every collision box inside the outer walls' inner faces.
    for (const b of propColliders(p)) {
      const c = Math.abs(Math.cos(b.rotY)), s = Math.abs(Math.sin(b.rotY));
      const ex = b.hx * c + b.hz * s, ez = b.hx * s + b.hz * c;
      const inX = h.w / 2 - STORY.wall + 0.03, inZ = h.d / 2 - STORY.wall + 0.03;
      if (Math.abs(b.x - h.x) + ex > inX || Math.abs(b.z - h.z) + ez > inZ) {
        n++;
        fail(`${p.kind} @(${f2(p.x)}, ${f2(y)}, ${f2(p.z)}) pokes through the outer wall of ${h.id}`);
      }
    }
  }
  if (!n) ok('all interior props on a floor, inside their walls');
}

console.log('Lights in every storey and basement');
for (const h of houses) {
  const floors = storeyFloors(h);
  const top = houseTop(h);
  floors.forEach((y0, si) => {
    const y1 = si + 1 < floors.length ? floors[si + 1] : top;
    const lit = map.lights.some((l) => Math.abs(l.x - h.x) < h.w / 2 && Math.abs(l.z - h.z) < h.d / 2 && l.y > y0 + 1.5 && l.y < y1);
    if (!lit) fail(`${h.id} storey ${si} has no light`);
  });
}
for (const r of map.excavations) {
  const lit = map.lights.some((l) => l.x > r.x0 && l.x < r.x1 && l.z > r.z0 && l.z < r.z1 && l.y > -1.5 && l.y < 0);
  if (!lit) fail(`basement (${f2(r.x0)}..${f2(r.x1)}, ${f2(r.z0)}..${f2(r.z1)}) has no light`);
}
ok('lights checked (failures listed above)');

console.log('Every room can be walked to from the safehouse');
{
  const t0 = Date.now();
  const nav = buildNavGridSync(phys, map);
  console.log(`  (nav grid built in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const h of houses) {
    const levels = [...storeyFloors(h)];
    if (map.excavations.some((r) => h.x > r.x0 - h.w / 2 && h.x < r.x1 + h.w / 2 && h.z > r.z0 - h.d / 2 && h.z < r.z1 + h.d / 2 && r.x0 >= h.x - h.w / 2 - 0.01 && r.x1 <= h.x + h.w / 2 + 0.01)) levels.push(-2.7);
    let total = 0, cut = 0;
    const cutAt: string[] = [];
    for (const y of levels) {
      let here = 0;
      for (let x = h.x - h.w / 2 + 0.5; x < h.x + h.w / 2 - 0.4; x += 0.5) {
        for (let z = h.z - h.d / 2 + 0.5; z < h.z + h.d / 2 - 0.4; z += 0.5) {
          const c = Math.floor((z - nav.z0) / 0.5) * nav.cols + Math.floor((x - nav.x0) / 0.5);
          for (let i = nav.colStart[c]; i < nav.colStart[c + 1]; i++) {
            if (Math.abs(nav.nodeY[i] - y) > 0.1) continue;
            total++;
            here++;
            if (!(nav.flags[i] & NAV_REACHABLE)) {
              cut++;
              if (cutAt.length < 6) cutAt.push(`(${f2(nav.nodeX(i))}, ${f2(y)}, ${f2(nav.nodeZ(i))})`);
            }
          }
        }
      }
      if (!here) fail(`${h.id}: no walkable floor at y ${y}`);
    }
    // A cell or two boxed in behind furniture is harmless; a room is not.
    if (cut > 3) fail(`${h.id}: ${cut} of ${total} floor cells unreachable, e.g. ${cutAt.join(' ')}`);
    else ok(`${h.id}: ${total - cut}/${total} floor cells reachable over ${levels.length} level(s)`);
  }
}

console.log('Stairwells: no house dressing (trim, frames, roofs) inside a stairwell');
{
  // The renderer's dressing, built without a GPU: stand-in materials, a canvas that draws nothing.
  const flat = () => new THREE.MeshBasicMaterial();
  const lib = { get: () => ({ material: flat(), texScale: 1 }), custom: flat, standard: flat, textures: {} } as unknown as MaterialLibrary;
  const pen = new Proxy({}, { get: () => () => ({ width: 0 }), set: () => true });
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => pen }) };
  const meshes: THREE.Mesh[] = [];
  const add = (g: THREE.BufferGeometry) => meshes.push(new THREE.Mesh(g));
  dressHouses(map, lib, { add, addPiece: (g: THREE.BufferGeometry) => (add(g), { mesh: null, start: 0, count: 0, saved: null }) } as unknown as StaticBatcher);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  let n = 0;
  for (const st of map.stairs) {
    const len = Math.abs(st.to - st.from), dir = Math.sign(st.to - st.from);
    const steps = Math.max(2, Math.round((st.y1 - st.y0) / 0.19));
    const top = Math.max(st.y0, st.y1) + 1.8;
    let hits = 0;
    for (let s = 0.1; s < len - 0.05; s += 0.2) {
      // Top of the step under this point (steps rise from `from`).
      const tread = st.y0 + (Math.min(steps - 1, Math.floor((s / len) * steps)) + 1) * (st.y1 - st.y0) / steps;
      // Kept clear of the side walls, where a window stool may stand out over a stairwell.
      for (const across of [st.a0 + 0.2, (st.a0 + st.a1) / 2, st.a1 - 0.2]) {
        const along = st.from + dir * s;
        const o = st.axis === 'z' ? new THREE.Vector3(across, top, along) : new THREE.Vector3(along, top, across);
        ray.set(o, down);
        ray.far = top - tread - 0.02;
        const hit = ray.intersectObjects(meshes, false)[0];
        if (hit && ++hits <= 2) fail(`stairs ${st.houseId} (${f2(st.from)}->${f2(st.to)}): dressing at (${f2(hit.point.x)}, ${f2(hit.point.y)}, ${f2(hit.point.z)}) over the steps`);
      }
    }
    if (hits) n++;
  }
  if (!n) ok(`${map.stairs.length} staircases: nothing of the dressing between the steps and ${f2(1.8)} m above the top`);
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL HOUSE CHECKS PASSED');
process.exit(failures ? 1 : 0);
