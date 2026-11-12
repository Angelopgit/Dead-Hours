/**
 * Headless checks for Camp Tolliver on the real map collision: the wall stands all the way round
 * but for the gate and the breach, both of which the nav grid walks through; the armory's racks
 * hand out their weapons a few each and no more; the AT4 and the grenade launcher (a lobbed shell
 * that bursts on what it hits); the Humvees and their roof gun (who mans it, what it fires, its
 * own ammunition, the snapshot rows that carry it); and the dead that hold the base, who stand to
 * once when a survivor first comes near.
 * Run with `npm run check:base`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, createDoorBodies, buildNavGrid, Simulation, Mirror, captureSnapshot,
  WEAPONS, ARMORY_WEAPONS, VEHICLES, GARRISON, mansTurret, seatStands,
  type SimEvent, type NavGrid, type Vec3,
} from '../src/index';
import { BASE } from '../src/map/base';

let failures = 0;
let passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) {
    passes++;
    console.log('  ok   ' + msg);
  } else {
    failures++;
    console.log('  FAIL ' + msg);
  }
};
const section = (s: string) => console.log(`\n${s}`);
const DT = 1 / 60;

await initPhysics();
const physics = new Physics(map);
const doors = createDoorBodies(map, physics);
const gen = buildNavGrid(physics, map);
let r = gen.next();
while (!r.done) r = gen.next();
const nav: NavGrid = r.value;

const ground = (x: number, z: number, from = 3) => {
  const d = physics.raycast(x, from, z, 0, -1, 0, 10);
  return d === null ? 0 : from - d;
};
const sims: Simulation[] = [];
/** A night with one survivor standing at `at` (the outbreak already on unless `preparation` says otherwise). */
function fresh(at: { x: number; z: number }, seed = 7, preparation = 0.05): Simulation {
  for (const s of sims.splice(0)) s.dispose();
  const sim = new Simulation({ physics, map, nav, doors, seed, preparation });
  sims.push(sim);
  sim.addPlayer('p1', 'One', 'ar', 'pistol', { x: at.x, y: ground(at.x, at.z) + 0.02, z: at.z }, 0);
  return sim;
}
const run = (sim: Simulation, seconds: number, events: SimEvent[] = []) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.step(DT);
    physics.advance(DT);
    for (const e of sim.drain()) events.push(e);
  }
  return events;
};
const armory = map.houses.find((h) => h.id === 'armory')!;
const barracks = map.houses.find((h) => h.id === 'barracks')!;
const racks = map.props.filter((p) => p.kind === 'gunRack');
const humvees = map.props.filter((p) => p.kind === 'humvee');

section('The camp on the map');
{
  check(!!armory && !!barracks && armory.enterable && barracks.enterable, 'a barracks and an armory, both enterable');
  check(armory.reinforced === true, 'the armory is built to hold (explosives do not bring it down)');
  check(map.areas.some((a) => a.name === BASE.name), `the place is named on arrival (${BASE.name})`);
  check(map.props.filter((p) => p.kind === 'bunk').length >= 6, 'bunks in the barracks');
  const kinds = new Set(racks.map((p) => p.weapon));
  check(ARMORY_WEAPONS.every((w) => kinds.has(w)), `the racks hold ${ARMORY_WEAPONS.map((w) => WEAPONS[w].model).join(', ')}`);
  check(map.props.some((p) => p.kind === 'ammoCrate' && Math.abs(p.x - armory.x) < armory.w / 2 && Math.abs(p.z - armory.z) < armory.d / 2), 'ammunition in the armory');
  check(humvees.length >= 2 && humvees.every((p) => p.drive), `${humvees.length} Humvees in the motor pool, all of them run`);

  // The wall: a body walking at it from outside is stopped everywhere but the gate and the breach.
  const blocked = (x: number, z: number, dx: number, dz: number) => physics.raycast(x, ground(x, z) + 1.0, z, dx, 0, dz, 6) !== null;
  let gaps = 0;
  let tested = 0;
  for (let z = BASE.z0 + 1.5; z < BASE.z1 - 1; z += 1.5) {
    tested += 2;
    if (!blocked(BASE.x0 - 3, z, 1, 0)) gaps++;
    if (Math.abs(z - BASE.gate.z) > BASE.gate.half + 0.6 && !blocked(BASE.x1 + 3, z, -1, 0)) gaps++;
  }
  for (let x = BASE.x0 + 1.5; x < BASE.x1 - 1; x += 1.5) {
    tested += 2;
    if (!blocked(x, BASE.z0 - 3, 0, 1)) gaps++;
    if ((x < BASE.breach.x0 - 0.6 || x > BASE.breach.x1 + 0.6) && !blocked(x, BASE.z1 + 3, 0, -1)) gaps++;
  }
  check(gaps === 0, `the wall stands all the way round (${tested} probes, ${gaps} got through)`);
  check(!blocked(BASE.x1 + 3, BASE.gate.z + 2.2, -1, 0) || !blocked(BASE.x1 + 3, BASE.gate.z - 2.2, -1, 0), 'the gate is open to walk through');
  const bx = (BASE.breach.x0 + BASE.breach.x1) / 2;
  check(!blocked(bx, BASE.z1 + 3, 0, -1), 'and so is the breach in the far wall');
}

section('Paths in and out');
{
  const street = { x: 0, y: ground(0, 8), z: 8 };
  const reach = (x: number, z: number): boolean => {
    const path = nav.findPath({ x, y: ground(x, z), z }, street, { maxExpand: 400000 });
    return !!path && path.complete;
  };
  check(reach(BASE.x1 - 6, BASE.gate.z), 'the dead in the yard can walk out to the street');
  check(reach(armory.x, armory.z + 0.6), 'and from inside the armory');
  check(reach(barracks.x + 2, barracks.z), 'and from inside the barracks');
}

section('Armory racks');
{
  const rackProp = racks.find((p) => p.weapon === 'at4')!;
  const sim = fresh({ x: armory.x, z: armory.z }, 7, 600);
  const p = sim.players.get('p1')!;
  const items = sim.interactables.filter((it) => it.rack);
  check(items.length === racks.length && items.every((it) => it.kind === 'exclusive' && sim.interactables[it.id] === it), 'every rack is something to use, in the list at its own id');
  const it = items.find((i) => i.weapon === 'at4')!;
  const stock = rackProp.stock ?? 2;
  check(it.supply === stock, `the AT4 rack holds ${stock}`);
  sim.setMotion('p1', { pos: { x: 0, y: ground(0, 8), z: 8 } });
  run(sim, 0.1);
  check(!sim.use('p1', it.id), 'out of reach from the street');
  sim.setMotion('p1', { pos: { x: it.pos.x, y: it.pos.y - 1.1, z: it.pos.z + (it.pos.z > armory.z ? -1 : 1) } });
  run(sim, 0.1);
  const events: SimEvent[] = [];
  const took = sim.use('p1', it.id);
  for (const e of sim.drain()) events.push(e);
  check(took && p.arsenal.primary.id === 'at4' && p.arsenal.primary.mag === WEAPONS.at4.magazine, 'taking one puts a loaded AT4 in their hands');
  check(it.supply === stock - 1, 'and leaves one fewer on the rack');
  check(events.some((e) => e.type === 'pickup' && e.item === 'weapon' && e.weapon === 'at4' && e.source === it.id), 'everyone hears of it');
  check(!sim.use('p1', it.id) && it.supply === stock - 1, 'nobody takes a second of what they already carry');
  // The others empty it.
  for (let i = 2; it.supply > 0 && i < 12; i++) {
    sim.addPlayer(`p${i}`, `P${i}`, 'ar', 'pistol', { ...p.motion.pos }, 0);
    run(sim, 0.05);
    sim.use(`p${i}`, it.id);
  }
  sim.addPlayer('late', 'Late', 'ar', 'pistol', { ...p.motion.pos }, 0);
  run(sim, 0.05);
  check(it.supply === 0 && !sim.use('late', it.id) && sim.players.get('late')!.arsenal.primary.id === 'ar', 'an empty rack gives nothing');
  const snap = captureSnapshot(sim, new Map());
  const copy = new Simulation({ physics, map, nav, doors, seed: 7, preparation: 600 });
  new Mirror(copy, 'late').apply(snap, 10);
  check(copy.interactables[it.id].supply === 0 && copy.players.get('p1')?.arsenal.primary.id === 'at4', 'a client sees the rack empty and the AT4 carried');
  copy.dispose();
}

section('AT4 and grenade launcher');
{
  const spot = { x: 0, z: 8 };
  const sim = fresh(spot);
  const p = sim.players.get('p1')!;
  run(sim, 0.5);
  p.arsenal.replacePrimary('at4', true);
  run(sim, 1.2);
  const z = sim.spawnZombie('walker', { x: spot.x, y: ground(spot.x, spot.z + 14) + 0.02, z: spot.z + 14 }, 'idle');
  const far = sim.spawnZombie('walker', { x: spot.x + 30, y: ground(spot.x + 30, spot.z) + 0.02, z: spot.z }, 'idle');
  const aim = (to: Vec3) => {
    const e = p.eye;
    const d = { x: to.x - e.x, y: to.y - e.y, z: to.z - e.z };
    const l = Math.hypot(d.x, d.y, d.z);
    return { x: d.x / l, y: d.y / l, z: d.z / l };
  };
  let events: SimEvent[] = [];
  check(sim.fire('p1', p.eye, aim({ x: z.pos.x, y: z.pos.y + 1, z: z.pos.z }), true, 3) === 'fired', 'the AT4 fires');
  run(sim, 1.5, events);
  check(!z.alive && far.alive, 'its rocket kills what it hits and spares what is far off');
  check(events.some((e) => e.type === 'explosion'), 'with a blast');
  check(p.arsenal.primary.mag === 0, 'one tube, one rocket');

  p.arsenal.replacePrimary('mgl', true);
  run(sim, 1.2);
  const t = sim.spawnZombie('walker', { x: spot.x, y: ground(spot.x, spot.z + 18) + 0.02, z: spot.z + 18 }, 'idle');
  events = [];
  const mag = p.arsenal.primary.mag;
  check(mag === WEAPONS.mgl.magazine && mag === 6, 'the launcher holds six');
  check(sim.fire('p1', p.eye, aim({ x: t.pos.x, y: t.pos.y + 1.3, z: t.pos.z }), true, 4) === 'fired', 'and fires');
  for (const e of sim.drain()) events.push(e);
  const thrown = events.find((e) => e.type === 'thrown');
  check(!!thrown && thrown.type === 'thrown' && thrown.shell === true, 'a shell leaves the barrel (the clients draw it)');
  check(events.some((e) => e.type === 'shot' && e.weapon === 'mgl' && e.pellets.length === 0), 'nothing is traced: the shot carries no bullet');
  check(t.alive, 'nothing is hurt before it lands');
  run(sim, 2, events);
  check(!t.alive && events.some((e) => e.type === 'explosion'), 'it bursts on the walker it hits');
  check(p.arsenal.primary.mag === mag - 1, 'one shell gone from the cylinder');
  // Lobbed: aimed level, it comes down on the road a good way off rather than flying on forever.
  events = [];
  sim.fire('p1', p.eye, { x: 0, y: 0, z: 1 }, true, 5);
  run(sim, 4, events);
  const boom = events.find((e) => e.type === 'explosion');
  const dist = boom && boom.type === 'explosion' ? Math.hypot(boom.pos.x - spot.x, boom.pos.z - spot.z) : 0;
  check(dist > 12 && dist < 60, `aimed level, a shell comes down ${dist.toFixed(0)} m off`);
  check(WEAPONS.mgl.blast! < WEAPONS.at4.blast!, 'a 40 mm shell is a smaller blast than a rocket');
}

section('The Humvee and its gun');
{
  const sim = fresh({ x: BASE.x1 - 10, z: BASE.gate.z }, 9, 600);
  const p = sim.players.get('p1')!;
  const list = sim.vehicles.list.filter((v) => v.def.kind === 'humvee');
  check(list.length === humvees.length, 'each Humvee on the map is a vehicle');
  const v = list[0];
  const def = VEHICLES.humvee;
  check(!!def.turret && seatStands(def, def.turret.seat) && mansTurret(def, def.turret.seat) && !mansTurret(def, 0), 'one seat stands in the roof hatch and mans the gun');
  check(!!v.gun && v.gun.id === 'm2' && v.gun.mag === WEAPONS.m2.magazine, 'the gun is loaded');
  sim.setMotion('p1', { pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z + def.hz + 0.7 } });
  run(sim, 0.1);
  check(sim.enterVehicle('p1', v.id) && sim.vehicles.seatOf('p1')?.[1] === 0, 'getting in takes the wheel');
  check(sim.vehicles.manning('p1') === null && p.arsenal.weapon.id !== 'm2', 'the driver has no gun');
  check(sim.fire('p1', p.eye, { x: 1, y: 0, z: 0 }, true, 1) === 'busy', 'and can\'t shoot');
  check(sim.switchSeat('p1') && sim.vehicles.seatOf('p1')?.[1] === def.turret!.seat, 'the next seat is the gunner\'s');
  check(sim.vehicles.manning('p1') === v && sim.vehicles.gunner(v) === p && p.arsenal.weapon.id === 'm2', 'in the hatch their weapon is the .50');
  run(sim, 0.3);
  check(p.eye.y > v.pos.y + def.turret!.ring, 'their head is above the roof');
  const before = v.gun!.mag;
  const own = p.arsenal.primary.mag;
  const events: SimEvent[] = [];
  let fired = 0;
  for (let i = 0; i < 40; i++) {
    if (sim.fire('p1', p.eye, { x: Math.cos(v.yaw), y: 0, z: Math.sin(v.yaw) }, i === 0, 20 + i) === 'fired') fired++;
    run(sim, DT, events);
  }
  check(fired >= 4 && v.gun!.mag === before - fired, `held down it fires automatically (${fired} rounds in ${(40 * DT).toFixed(2)} s), from the gun's own belt`);
  check(p.arsenal.primary.mag === own, 'their rifle is untouched');
  check(events.some((e) => e.type === 'shot' && e.weapon === 'm2' && e.player === 'p1'), 'the shots are the .50\'s');
  // The wire.
  const snap = captureSnapshot(sim, new Map());
  const row = snap.vt;
  check(!!row && row.length % 3 === 0 && row.includes(v.id), 'the snapshot carries each roof gun\'s ammunition');
  const copy = new Simulation({ physics, map, nav, doors, seed: 9, preparation: 600 });
  new Mirror(copy, 'p1').apply(snap, 10);
  const cv = copy.vehicles.vehicle(v.id)!;
  check(cv.gun!.mag === v.gun!.mag && cv.gun!.reserve === v.gun!.reserve, 'a client\'s copy has the same rounds left');
  check(copy.vehicles.manning('p1') === cv && copy.players.get('p1')!.arsenal.weapon.id === 'm2', 'and knows who is on the gun');
  copy.dispose();
  // Leaving the gun.
  check(sim.switchSeat('p1') && sim.vehicles.manning('p1') === null && p.arsenal.weapon.id !== 'm2', 'moving on gives them their own weapon back');
  sim.enterVehicle('p1', v.id, def.turret!.seat);
  check(sim.exitVehicle('p1') && p.arsenal.weapon.id !== 'm2' && sim.vehicles.gunner(v) === null, 'and so does getting out');
  // Kill power: a .50 round drops a walker in one.
  check(WEAPONS.m2.damage >= 90 && WEAPONS.m2.mounted === true, 'the .50 is a mounted weapon nobody carries');
  check(!ARMORY_WEAPONS.includes('m2'), 'and no rack hands it out');
}

section('The dead that hold the camp');
{
  const g = map.garrisons?.find((x) => x.name === BASE.name);
  check(!!g && g.posts.length >= GARRISON.base, `a garrison of up to ${g?.posts.length} posts`);
  if (g) {
    const standing = g.posts.every((at) => Math.abs(ground(at.x, at.z, at.y + 1.5) - at.y) < 0.6);
    check(standing, 'every post is on a floor');
    const sim = fresh({ x: 0, z: 8 });
    run(sim, 2);
    const inCamp = () => sim.zombies.filter((z) => z.alive && z.pos.x > BASE.x0 && z.pos.x < BASE.x1 && z.pos.z > BASE.z0 && z.pos.z < BASE.z1).length;
    check(inCamp() === 0 && sim.garrisoned.size === 0, 'nobody stands there while the survivors are far off (it costs nothing)');
    sim.setMotion('p1', { pos: { x: BASE.x1 + 12, y: ground(BASE.x1 + 12, BASE.gate.z), z: BASE.gate.z } });
    run(sim, 0.2);
    const n = inCamp();
    check(sim.garrisoned.size === 1 && n >= GARRISON.base && n <= g.posts.length, `they stand to when one comes near (${n} for a lone survivor)`);
    check(sim.zombies.some((z) => z.alive && z.kind === 'brute' && z.pos.x > BASE.x0 && z.pos.x < BASE.x1), 'a brute among them');
    sim.setMotion('p1', { pos: { x: 0, y: ground(0, 8), z: 8 } });
    run(sim, 0.5);
    sim.setMotion('p1', { pos: { x: BASE.x1 + 12, y: ground(BASE.x1 + 12, BASE.gate.z), z: BASE.gate.z } });
    run(sim, 0.5);
    check(sim.garrisoned.size === 1, 'once a night: coming back does not call out more');
  }
}

for (const s of sims) s.dispose();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
