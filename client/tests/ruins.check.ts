/**
 * Headless checks for how destruction is drawn: rubble (effects/Rubble: pieces that fall as rigid
 * bodies, pile up on the ground and on floor slabs and stay there) and the structure view
 * (gameplay/StructureView), on the real map and the real simulation: a bay blown out leaves the
 * static world with what hung on it, a structure that falls leaves it whole, and the night's end
 * puts everything back.
 * Run with `npx tsx client/tests/ruins.check.ts` (part of `npm run check:destruction`).
 */
import * as THREE from 'three';
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, createDoorBodies, buildNavGrid, Simulation, BREACH, COLLAPSE, STRUCTURE_STATE,
  type NavGrid, type SimEvent,
} from '@dead-hours/shared';
import { Rubble } from '../src/effects/Rubble';
import { StructureView } from '../src/gameplay/StructureView';
import { worldPieces } from '../src/environment/WorldPieces';
import type { BatchPiece } from '../src/rendering/StaticBatcher';
import type { DecalBatch } from '../src/effects/Decals';
import type { Pyro } from '../src/effects/Pyro';

let failures = 0;
let passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n${s}`);
const DT = 1 / 60;

await initPhysics();

section('Rubble');
{
  const rubble = new Rubble();
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const at = (i: number) => {
    rubble.mesh.getMatrixAt(i, m);
    m.decompose(p, q, s);
    // (A piece taken away is a matrix of zeros.)
    return { x: p.x, y: p.y, z: p.z, size: m.elements.slice(0, 11).reduce((n, v) => n + Math.abs(v), 0) };
  };
  let landed = 0;
  rubble.onLand = () => landed++;
  // A floor slab 0.3 m high, 10 m square, and a wall's worth of pieces let go over it and beside it.
  rubble.floor('test', 0, 0, 10, 10, 0.3);
  const grey = new THREE.Color(0x808080);
  const N = 80;
  for (let i = 0; i < N; i++) {
    const over = i < N / 2;
    rubble.drop(
      new THREE.Vector3(over ? (i % 8) - 3.5 : 12 + (i % 8), 1 + Math.floor(i / 8) * 0.5, over ? 0 : 3), new THREE.Vector3(0.6, 0.5, 0.2), new THREE.Quaternion(),
      new THREE.Vector3(Math.sin(i) * 1.5, 0, Math.cos(i) * 1.5), new THREE.Vector3(Math.sin(i * 3) * 4, 0, Math.cos(i * 2) * 4), grey, 2,
    );
  }
  check(rubble.falling === N && rubble.mesh.count === N, `${N} pieces let go are ${rubble.falling} falling bodies`);
  const t0 = performance.now();
  let steps = 0;
  for (; steps < 60 * 12 && rubble.falling > 0; steps++) rubble.update(DT);
  const ms = (performance.now() - t0) / Math.max(1, steps);
  check(rubble.falling === 0, `they all come to rest (${(steps / 60).toFixed(1)} s, ${ms.toFixed(2)} ms a step)`);
  check(ms < 4, 'at a cost a frame can carry');
  let onSlab = 0, onGround = 0, sunk = 0, high = 0;
  for (let i = 0; i < N; i++) {
    const r = at(i);
    const slab = Math.abs(r.x) < 4.7 && Math.abs(r.z) < 4.7;
    if (r.y < (slab ? 0.3 : 0) + 0.05) sunk++;
    if (r.y > (slab ? 0.3 : 0) + 1.6) high++;
    if (slab) onSlab++;
    else onGround++;
  }
  check(sunk === 0 && high === 0, `lying on what they landed on, none sunk in it or left in the air (${onSlab} on the slab, ${onGround} on the ground)`);
  check(onSlab >= N * 0.3 && onGround >= N * 0.4, 'the slab holds what came down over it');
  check(landed > 0, `their landing is heard (${landed} knocks)`);
  // Pieces set down still, and taken away by tag and place.
  const before = rubble.mesh.count;
  for (let i = 0; i < 6; i++) rubble.place(new THREE.Vector3(30 + i, 1, 0), new THREE.Vector3(0.2, 0.3, 0.2), new THREE.Quaternion(), grey, 1);
  check(rubble.mesh.count === before + 6 && rubble.falling === 0, 'pieces can be set down without falling');
  rubble.removeIn(1, new THREE.Vector3(29.5, 0, -1), new THREE.Vector3(32.5, 2, 1));
  const left = [0, 1, 2, 3, 4, 5].filter((i) => at(before + i).size > 1e-6).length;
  check(left === 3, `taking the tagged ones in a box away leaves the rest (${left} of 6)`);
  rubble.removeIn(1, new THREE.Vector3(-20, -1, -20), new THREE.Vector3(20, 5, 20));
  check(at(0).size > 1e-6, 'and never touches pieces with another tag');
  // The oldest make room; too many at once are not all let go.
  for (let i = 0; i < 1200; i++) rubble.drop(new THREE.Vector3(i % 30, 3, 20 + Math.floor(i / 30)), new THREE.Vector3(0.3, 0.3, 0.3), new THREE.Quaternion(), new THREE.Vector3(), new THREE.Vector3(), grey, 2);
  check(rubble.falling <= 320 && rubble.mesh.count <= 900, `no more than ${rubble.falling} fall at once and ${rubble.mesh.count} are ever drawn`);
  rubble.clear();
  check(rubble.falling === 0 && rubble.mesh.count === 0, 'a new night starts with none');
  rubble.dispose();
}

section('Walls and buildings taken out of the world');
{
  const physics = new Physics(map);
  const doors = createDoorBodies(map, physics);
  const gen = buildNavGrid(physics, map);
  let r = gen.next();
  while (!r.done) r = gen.next();
  const nav: NavGrid = r.value;
  const sim = new Simulation({ physics, map, nav, doors, seed: 7, preparation: 0.05 });
  sim.addPlayer('p1', 'One', 'ar', 'pistol', { x: -36, y: 0.02, z: -40 }, 0);
  const market = sim.structures.get('market')!;
  const back = market.parts.filter((p) => p.spec.kind === 'bay' && p.spec.storey === 0 && p.spec.axis === 'x' && p.spec.outward === 1).sort((a, b) => a.spec.x - b.spec.x);
  const bay = back[1];

  // The static world as the batcher leaves it: one mesh, a piece for each bay and pillar, and for
  // the market a shutter on the bay, a strip of trim along the whole wall, and its roof.
  const verts: number[] = [];
  const piece = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BatchPiece => {
    const start = verts.length / 3;
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) verts.push(x, y, z);
    return { mesh: null, start, count: 8, saved: null };
  };
  const groups = new Map<string, BatchPiece[]>();
  for (const part of sim.structures.parts) {
    const p = part.spec;
    const hx = p.kind === 'pillar' || p.axis === 'x' ? p.w / 2 : 0.12, hz = p.kind === 'pillar' || p.axis === 'z' ? p.w / 2 : 0.12;
    groups.set(`part:${part.index}`, [piece(p.x - hx, p.y - p.h / 2, p.z - hz, p.x + hx, p.y + p.h / 2, p.z + hz)]);
  }
  const b = bay.spec;
  const shutter = piece(b.x - 0.5, b.floor + 1, b.z + 0.13, b.x - 0.2, b.floor + 2, b.z + 0.17);
  const trim = piece(market.spec.x - 9, b.floor, b.z + 0.13, market.spec.x + 9, b.floor + 0.15, b.z + 0.16);
  const roof = piece(market.spec.x - 9, market.spec.top - 0.3, market.spec.z - 6, market.spec.x + 9, market.spec.top, market.spec.z + 6);
  groups.set('market', [shutter, trim, roof]);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3)));
  for (const list of groups.values()) for (const p of list) p.mesh = mesh;
  worldPieces.groups = groups;
  const hidden = (p: BatchPiece) => p.saved !== null;

  const rubble = new Rubble();
  let wiped = 0, dust = 0, cracks = 0;
  const decals = { removeIn: () => wiped++, add: () => cracks++ } as unknown as DecalBatch;
  const pyro = { dust: () => dust++ } as unknown as Pyro;
  const view = new StructureView(sim, map, physics, decals, pyro, rubble);
  const heard: string[] = [];
  view.onBreach = (_p, gone) => heard.push(gone ? 'breach' : 'crack');
  view.onCreak = () => heard.push('creak');
  view.onCollapse = () => heard.push('collapse');
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      sim.step(DT, false);
      physics.world.step();
      for (const e of sim.drain() as SimEvent[]) if (e.type === 'breach' || e.type === 'collapse') view.event(e);
      view.update(DT);
      rubble.update(DT);
    }
  };
  const me = sim.players.get('p1')!;
  run(0.2);
  check(!hidden(groups.get(`part:${bay.index}`)![0]) && rubble.mesh.count === 0, 'nothing is touched while everything stands');

  // A grenade cracks it.
  sim.explosives.explode({ x: b.x, y: b.floor + 1, z: b.z + 0.45 }, me);
  run(0.2);
  check(!hidden(groups.get(`part:${bay.index}`)![0]) && cracks >= 3 && heard.includes('crack'), `a blast that cracks a bay leaves cracks on it (${cracks}) and is heard`);
  // A rocket opens it.
  sim.explosives.explode({ x: b.x, y: b.floor + 1, z: b.z + 0.45 }, me, 0, { breach: BREACH.rocket });
  run(0.2);
  check(bay.gone && hidden(groups.get(`part:${bay.index}`)![0]), 'a bay blown out is taken out of the static world');
  check(hidden(shutter), 'with the shutter that hung on it');
  check(!hidden(trim) && !hidden(roof), 'but not the trim that runs past it, or the roof');
  check(!hidden(groups.get(`part:${back[4].index}`)![0]), 'nor any bay still standing');
  check(wiped > 0 && dust > 0 && heard.includes('breach'), 'its marks go with it, in dust and noise');
  const thrown = rubble.falling;
  check(thrown >= 8 && rubble.mesh.count > thrown, `${thrown} pieces of it fly, and ${rubble.mesh.count - thrown} are set as its ragged edge and at its foot`);
  run(9);
  check(rubble.falling === 0, 'they come to rest');

  // The building.
  for (const part of market.parts) {
    if (market.state !== STRUCTURE_STATE.standing) break;
    if (part.gone || part.spec.kind !== 'bay' || part.spec.storey !== 0) continue;
    const o = part.spec.outward * 0.45;
    sim.explosives.explode({ x: part.spec.x + (part.spec.axis === 'z' ? o : 0), y: part.spec.floor + 1, z: part.spec.z + (part.spec.axis === 'x' ? o : 0) }, me, 0, { breach: BREACH.rocket });
  }
  check(market.state === STRUCTURE_STATE.going, 'the market has lost too much');
  run(COLLAPSE.warn - 0.3);
  check(heard.includes('creak') && !hidden(roof), 'it groans, and still stands');
  run(0.6);
  check(market.state === STRUCTURE_STATE.fallen && heard.includes('collapse'), 'it falls, and is heard');
  check(hidden(roof) && hidden(trim) && market.parts.every((p) => hidden(groups.get(`part:${p.index}`)![0])), 'everything of it is taken out of the static world');
  check(worldPieces.fallen.has('market'), 'and it is known as fallen');
  check(rubble.falling >= 120, `it comes down as ${rubble.falling} pieces`);
  const other = sim.structures.get('surplus')!;
  check(other.parts.every((p) => !hidden(groups.get(`part:${p.index}`)![0])), 'the building next door is untouched');
  const t0 = performance.now();
  let steps = 0;
  for (; steps < 60 * 12 && rubble.falling > 0; steps++) rubble.update(DT);
  check(rubble.falling === 0, `the rubble settles (${(steps / 60).toFixed(1)} s more, ${((performance.now() - t0) / Math.max(1, steps)).toFixed(2)} ms a step)`);
  // In the footprint it lies on the slab.
  const m = new THREE.Matrix4(), pos = new THREE.Vector3();
  let low = 0, piled = 0;
  for (let i = 0; i < rubble.mesh.count; i++) {
    rubble.mesh.getMatrixAt(i, m);
    if (Math.abs(m.elements[0]) + Math.abs(m.elements[5]) + Math.abs(m.elements[10]) < 1e-6) continue;
    pos.setFromMatrixPosition(m);
    if (pos.y < -0.01) low++;
    if (pos.y > market.spec.base + 2.2) piled++;
  }
  check(low === 0 && piled === 0, 'none of it under the ground, none left hanging where the walls were');

  // Late to the night: the same holes and ruins from the simulation's state alone.
  for (const list of groups.values()) for (const p of list) if (p.saved) { (mesh.geometry.getAttribute('position').array as Float32Array).set(p.saved, p.start * 3); p.saved = null; }
  worldPieces.fallen.clear();
  const late = new StructureView(sim, map, physics, decals, pyro, new Rubble());
  late.update(DT);
  check(hidden(roof) && market.parts.every((p) => hidden(groups.get(`part:${p.index}`)![0])) && worldPieces.fallen.has('market'), 'a survivor who joins late sees the ruin');
  late.dispose();
  check(!hidden(roof) && !hidden(shutter) && [...groups.values()].every((l) => l.every((p) => !hidden(p))) && worldPieces.fallen.size === 0, 'the night\'s end puts everything back');
  view.dispose();
  rubble.dispose();
  sim.dispose();
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
