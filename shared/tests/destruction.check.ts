/**
 * Headless checks for destruction on the real map collision: cars, pumps and drums that smoke,
 * catch fire and blow up when they are shot (sim/Volatiles), what their blasts do, chain
 * reactions, a driven car going up with people in it, and the wire format.
 * Run with `npm run check:destruction`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, createDoorBodies, buildNavGrid, Simulation, Mirror, captureSnapshot,
  VOLATILE, VOLATILES, VOLATILE_STAGE, PLAYER,
  type Vec3, type SimEvent, type NavGrid, type Volatile,
} from '../src/index';

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

function fresh(at: Vec3, seed = 7) {
  const sim = new Simulation({ physics, map, nav, doors, seed, preparation: 0.05 });
  sim.addPlayer('p1', 'One', 'ar', 'pistol', { x: at.x, y: ground(at.x, at.z) + 0.02, z: at.z }, 0);
  for (let i = 0; i < 10; i++) sim.step(DT, false);
  sim.drain();
  return sim;
}
const run = (sim: Simulation, seconds: number, events: SimEvent[] = []) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.step(DT, false);
    physics.world.step();
    for (const e of sim.drain()) events.push(e);
  }
  return events;
};
/** The nearest volatile prop of a kind to a point (parked: not one that drives, unless asked). */
const nearest = (sim: Simulation, kind: string, x: number, z: number, driven = false): Volatile => {
  let best: Volatile | null = null;
  let bd = Infinity;
  for (const v of sim.volatiles.list) {
    if (v.kind !== kind || !!v.vehicle !== driven) continue;
    const d = Math.hypot(v.home.x - x, v.home.z - z);
    if (d < bd) { bd = d; best = v; }
  }
  if (!best) throw new Error(`no ${kind} on the map`);
  return best;
};
/** Fires the rifle from the survivor's eye at a point until `until` says stop (the magazine never runs dry). */
const shootAt = (sim: Simulation, target: Vec3, until: () => boolean, events: SimEvent[], max = 200): number => {
  const p = sim.players.get('p1')!;
  let shots = 0;
  for (let i = 0; i < max && !until(); i++) {
    p.arsenal.primary.mag = 30;
    const eye = p.eye;
    const d = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
    if (sim.fire('p1', eye, d, true, 1000 + i) === 'fired') shots++;
    run(sim, 0.1, events);
  }
  return shots;
};

section('What can blow up');
{
  const sim = fresh({ x: 0, z: 8 });
  const list = sim.volatiles.list;
  const count = (k: string) => list.filter((v) => v.kind === k).length;
  const cars = count('car') + count('policeCar') + count('wreckedCar');
  check(cars >= 30, `every car, cruiser and wreck on the map (${cars}), parked or driven`);
  check(count('pump') === 4 && count('oilDrum') >= 5 && count('armoredTruck') >= 1, `the pumps (${count('pump')}), loose oil drums (${count('oilDrum')}) and the armored truck`);
  const driven = list.filter((v) => v.vehicle);
  check(driven.length === sim.vehicles.list.length, `each of the ${sim.vehicles.list.length} cars that drive is one of them`);
  check(list.every((v, i) => v.id === i && v.stage === VOLATILE_STAGE.fine && v.health === v.def.health), 'all untouched as the night starts');
  check(sim.volatiles.pack().length === 0, 'nothing about them in a snapshot until one is shot');
  sim.dispose();
}

section('Shooting a parked car');
{
  // The car parked on the south side of Hale Street, from across the road.
  const sim = fresh({ x: 9, z: -9.5 });
  const p = sim.players.get('p1')!;
  const car = nearest(sim, 'car', 9.2, 3.0);
  const at = sim.volatiles.centre(car);
  check(Math.hypot(car.home.x - 9.2, car.home.z - 3.0) < 0.5, 'the car by the safehouse is there');
  const walker = sim.spawnZombie('walker', { x: car.home.x, y: ground(car.home.x, car.home.z + 2.6) + 0.02, z: car.home.z + 2.6 }, 'idle');
  const far = sim.spawnZombie('walker', { x: car.home.x + 16, y: 0.02, z: car.home.z + 3 }, 'idle');
  const events: SimEvent[] = [];
  const shots1 = shootAt(sim, at, () => car.stage >= VOLATILE_STAGE.smoking, events);
  check(car.stage === VOLATILE_STAGE.smoking && car.health <= car.def.health * VOLATILE.smoke, `it smokes after ${shots1} rifle rounds (${Math.round(car.health)} of ${car.def.health} left)`);
  check(events.some((e) => e.type === 'volatile' && e.id === car.id && e.stage === VOLATILE_STAGE.smoking), 'clients are told it smokes');
  check(events.some((e) => e.type === 'impact' && e.surface === 'metal'), 'the rounds still spark off the bodywork');
  const shots2 = shootAt(sim, at, () => car.stage >= VOLATILE_STAGE.burning, events);
  const total = shots1 + shots2;
  check(car.stage === VOLATILE_STAGE.burning, `it catches fire after ${total} rounds in all`);
  check(total >= 12 && total <= 24, `about half a rifle magazine (${total} rounds for ${car.def.health} points)`);
  const fuse = car.blowAt - sim.time;
  check(fuse > car.def.fuse[0] - 0.2 && fuse <= car.def.fuse[1], `it burns ${fuse.toFixed(1)} s before it goes up (${car.def.fuse[0]} to ${car.def.fuse[1]})`);
  check(events.every((e) => e.type !== 'explosion'), 'no blast yet');
  const hpBefore = p.health;
  const boom = run(sim, fuse + 0.2);
  const ex = boom.find((e) => e.type === 'explosion');
  check(car.stage === VOLATILE_STAGE.blown, 'then it blows up');
  check(ex?.type === 'explosion' && ex.kind === 'fuel' && ex.power === car.def.power, `a fuel blast ${car.def.power} times a frag's`);
  const fire = boom.find((e) => e.type === 'fire');
  check(fire?.type === 'fire' && fire.spill === true && fire.patches.length >= 4, `burning fuel on the road around it (${fire?.type === 'fire' ? fire.patches.length : 0} patches)`);
  check(fire?.type === 'fire' && Math.abs(fire.end - fire.start - VOLATILE.burn) < 0.01, `which burns ${VOLATILE.burn} s`);
  check(!walker.alive, 'a zombie beside it is killed');
  check(far.alive, 'one 16 m off is not');
  check(p.health === hpBefore, `the shooter across the street (${Math.hypot(p.motion.pos.x - car.home.x, p.motion.pos.z - car.home.z).toFixed(1)} m) is unhurt`);
  check(sim.physics.raycast(car.home.x, 0.7, car.home.z - 4, 0, 0, 1, 6) !== null, 'the burnt shell still blocks the way');
  // (Whatever its blast set alight nearby has gone up too by now.)
  run(sim, 2);
  const after: SimEvent[] = [];
  const again = shootAt(sim, at, () => false, after, 3);
  run(sim, 1, after);
  check(again === 3 && car.stage === VOLATILE_STAGE.blown && after.every((e) => e.type !== 'explosion' && e.type !== 'volatile'), 'shooting the shell does nothing more');
  const rows = sim.volatiles.pack();
  const row = rows.indexOf(car.id);
  check(rows.length % 3 === 0 && row % 3 === 0 && rows[row + 1] === VOLATILE_STAGE.blown && rows[row + 2] === 0, `the snapshot carries it: [id, blown, 0] (${rows.length / 3} shot up or scorched in all)`);
  sim.dispose();
}

section('Standing too close');
{
  const sim = fresh({ x: 9.2, z: 6.2 });
  const p = sim.players.get('p1')!;
  const car = nearest(sim, 'car', 9.2, 3.0);
  sim.volatiles.shot(car.colliders[0], car.def.health, p);
  check(car.stage === VOLATILE_STAGE.burning, 'enough damage at once sets it alight straight away');
  const t0 = car.blowAt;
  sim.volatiles.shot(car.colliders[0], 30, p);
  check(Math.abs(t0 - car.blowAt - VOLATILE.hurry) < 1e-6, `each round into the fire brings it on ${VOLATILE.hurry} s sooner`);
  run(sim, car.blowAt - sim.time + 0.2);
  check(car.stage === VOLATILE_STAGE.blown && (!p.up || p.health < PLAYER.maxHealth * 0.2), `a survivor 2 m from it goes down or nearly (health ${Math.round(p.health)}, ${p.up ? 'up' : 'down'})`);
  sim.dispose();
}

section('Blasts and chain reactions');
{
  const sim = fresh({ x: -30, z: 8 });
  const p = sim.players.get('p1')!;
  const car = nearest(sim, 'car', 9.2, 3.0);
  // A grenade against its door.
  sim.explosives.explode({ x: car.home.x, y: 0.1, z: car.home.z + 1.4 }, p);
  check(car.stage === VOLATILE_STAGE.burning, 'a grenade against a car sets it alight');
  const fuse = car.blowAt - sim.time;
  check(fuse <= VOLATILE.chain[1] && fuse >= VOLATILE.chain[0] - 1e-6, `and it goes up within the second (${fuse.toFixed(2)} s)`);
  const ev = run(sim, 1);
  check(ev.some((e) => e.type === 'explosion' && e.kind === 'fuel'), 'its own blast follows');
  sim.dispose();

  // A grenade 7 m away only dents it.
  const sim2 = fresh({ x: -30, z: 8 });
  const p2 = sim2.players.get('p1')!;
  const car2 = nearest(sim2, 'car', 9.2, 3.0);
  sim2.explosives.explode({ x: car2.home.x, y: 0.1, z: car2.home.z + 7.5 }, p2);
  check(car2.stage !== VOLATILE_STAGE.burning && car2.health < car2.def.health && car2.health > 0, `a grenade 6.5 m off only damages it (${Math.round(car2.health)} of ${car2.def.health} left)`);
  sim2.dispose();

  // The drums behind the gas station: one shot up takes its neighbour with it.
  const sim3 = fresh({ x: 96, z: -38 });
  const p3 = sim3.players.get('p1')!;
  const a = nearest(sim3, 'oilDrum', 102.2, -44.2);
  const b = sim3.volatiles.list.find((v) => v !== a && v.kind === 'oilDrum' && Math.hypot(v.home.x - a.home.x, v.home.z - a.home.z) < 2)!;
  check(!!b, 'two drums stand together behind the gas station');
  sim3.volatiles.shot(a.colliders[0], 200, p3);
  const ev3 = run(sim3, a.def.fuse[1] + VOLATILE.chain[1] + 0.4);
  const blasts = ev3.filter((e) => e.type === 'explosion');
  check(a.stage === VOLATILE_STAGE.blown && b.stage === VOLATILE_STAGE.blown && blasts.length === 2, `the first drum sets off the second (${blasts.length} blasts)`);
  check(sim3.physics.isOff(a.colliders[0]) && sim3.physics.raycast(a.home.x - 2, 0.45, a.home.z, 1, 0, 0, 1.9) === null, 'a blown drum is gone: nothing left to walk into');
  sim3.dispose();
  const sim4 = fresh({ x: 96, z: -38 });
  const a4 = nearest(sim4, 'oilDrum', 102.2, -44.2);
  check(a4.stage === VOLATILE_STAGE.fine && !sim4.physics.isOff(a4.colliders[0]) && sim4.physics.raycast(a4.home.x - 2, 0.45, a4.home.z, 1, 0, 0, 1.9) !== null, 'and stands there again the next night');
  sim4.dispose();
}

section('The pumps and the armored truck');
{
  const sim = fresh({ x: 80, z: -8 });
  const p = sim.players.get('p1')!;
  const pump = nearest(sim, 'pump', 86, -15.6);
  const before = sim.volatiles.list.filter((v) => v.kind === 'pump' && v.stage === VOLATILE_STAGE.fine).length;
  sim.volatiles.shot(pump.colliders[0], pump.def.health, p);
  run(sim, pump.def.fuse[1] + 0.3);
  check(pump.stage === VOLATILE_STAGE.blown, 'a pump shot up blows');
  const others = sim.volatiles.list.filter((v) => v.kind === 'pump' && v !== pump);
  check(others.some((v) => v.stage >= VOLATILE_STAGE.burning), `and takes the pump across the island with it (${before} pumps, ${others.filter((v) => v.stage >= VOLATILE_STAGE.burning).length} more alight)`);
  run(sim, 4);
  check(sim.volatiles.list.filter((v) => v.kind === 'pump').every((v) => v.stage === VOLATILE_STAGE.blown), 'the whole forecourt goes up, pump by pump');
  const truck = sim.volatiles.list.find((v) => v.kind === 'armoredTruck')!;
  const h0 = truck.health;
  sim.volatiles.shot(truck.colliders[0], 100, p);
  check(Math.abs(h0 - truck.health - 100 * VOLATILES.armoredTruck!.armor) < 1e-6, `the truck's plate turns ${Math.round((1 - VOLATILES.armoredTruck!.armor) * 100)}% of each round`);
  sim.dispose();
}

section('A car with people in it');
{
  const sim = fresh({ x: -5.5, z: 3.5 });
  const p = sim.players.get('p1')!;
  const cruiser = nearest(sim, 'policeCar', -5.5, 1.6, true);
  const v = cruiser.vehicle!;
  check(sim.enterVehicle('p1', v.id), 'a survivor gets into the cruiser');
  run(sim, v.def.crank + 0.3);
  check(v.engine, 'and starts it');
  sim.volatiles.shot(v.hull, cruiser.def.health, p);
  check(cruiser.stage === VOLATILE_STAGE.burning, 'shot to nothing with them inside, it burns');
  const ev = run(sim, cruiser.blowAt - sim.time + 0.2);
  check(cruiser.stage === VOLATILE_STAGE.blown, 'it blows');
  check(sim.vehicles.seatOf('p1') === null && ev.some((e) => e.type === 'vehicle' && e.stage === 'thrown' && e.player === 'p1'), 'they are thrown out');
  check(p.alive && Math.abs(PLAYER.maxHealth - p.health - VOLATILE.occupant) < 0.6, `hurt ${VOLATILE.occupant}, and spared the blast they sat on (health ${Math.round(p.health)})`);
  check(v.wrecked && !v.engine && v.gas === 0, 'the car is a wreck: engine dead, tank gone');
  run(sim, 1);
  check(!sim.vehicles.canEnter(p, v) && !sim.enterVehicle('p1', v.id), 'nobody gets back into it');
  const snap = captureSnapshot(sim, new Map());
  const at = snap.vo ? snap.vo.indexOf(cruiser.id) : -1;
  check(!!snap.vo && at % 3 === 0 && snap.vo[at + 1] === VOLATILE_STAGE.blown, 'the snapshot says it blew');

  // A client's copy of the night hears about it.
  const copy = new Simulation({ physics: new Physics(map), map, nav, doors: [], seed: 7, preparation: 0.05 });
  const mirror = new Mirror(copy, 'p2');
  mirror.apply(JSON.parse(JSON.stringify(snap)));
  const theirs = copy.volatiles.list[cruiser.id];
  check(theirs.stage === VOLATILE_STAGE.blown && theirs.vehicle!.wrecked, 'a client\'s copy shows the wreck, and its car as one nobody can drive');
  sim.dispose();
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
