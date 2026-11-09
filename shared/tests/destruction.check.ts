/**
 * Headless checks for destruction on the real map collision: cars, pumps and drums that smoke,
 * catch fire and blow up when they are shot (sim/Volatiles), what their blasts do, chain
 * reactions, a driven car going up with people in it; walls blown open, the ways in that makes,
 * buildings, the gas canopy and the water tower brought down (sim/Structures); the wire format.
 * Run with `npm run check:destruction`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, createDoorBodies, buildNavGrid, Simulation, Mirror, captureSnapshot,
  VOLATILE, VOLATILES, VOLATILE_STAGE, PLAYER, BREACH, COLLAPSE, STRUCTURE_STATE, STORY, WEAPONS,
  NavGrid, type Vec3, type SimEvent, type Volatile, type Part, type Structure,
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

/** A point `off` metres out from the middle of a bay (negative: inside), `up` above its floor. */
const beside = (part: Part, off: number, up = 1.2): Vec3 => {
  const p = part.spec;
  const nx = p.axis === 'x' ? 0 : p.outward, nz = p.axis === 'x' ? p.outward : 0;
  const k = Math.sign(off) * STORY.wall / 2 + off;
  return { x: p.x + nx * k, y: p.floor + up, z: p.z + nz * k };
};
/** Whether anything solid stands between the two sides of a bay, at three heights. */
const blocked = (part: Part): boolean => {
  for (const up of [0.4, 1.2, 2.2]) {
    const a = beside(part, 0.6, up), b = beside(part, -0.6, up);
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (physics.raycast(a.x, a.y, a.z, (b.x - a.x) / L, 0, (b.z - a.z) / L, L) !== null) return true;
  }
  return false;
};
/** Whether the room behind a bay is empty for half a metre (nothing stood against the wall there). */
const roomBehind = (part: Part): boolean => {
  for (const up of [0.4, 1.2]) {
    const a = beside(part, -0.05, up), b = beside(part, -0.7, up);
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (physics.raycast(a.x, a.y, a.z, (b.x - a.x) / L, 0, (b.z - a.z) / L, L) !== null) return false;
  }
  return true;
};
const groundBays = (s: Structure) => s.parts.filter((p) => p.spec.kind === 'bay' && p.spec.storey === 0);
/** A blast against the outside of a bay or pillar. */
const blastAt = (sim: Simulation, part: Part, breach: number | undefined, events: SimEvent[] = []) => {
  sim.explosives.explode(beside(part, 0.3, 1.0), sim.players.get('p1')!, 0, breach === undefined ? {} : { breach });
  return run(sim, 0.1, events);
};
const zombiePath = (sim: Simulation, from: Vec3, to: Vec3) => nav.findPath(from, to, {
  maxExpand: 20000,
  doorCost: () => 40,
  linkCost: (id) => (id >= BREACH.linkBase ? (sim.structures.passable(id) ? BREACH.pathCost : Infinity) : Infinity),
});

section('What can be blown open and brought down');
{
  const sim = fresh({ x: 0, z: 8 });
  const st = sim.structures;
  const buildings = st.list.filter((s) => s.spec.kind === 'building');
  check(buildings.length >= 25 && buildings.every((s) => s.bays >= 10), `${buildings.length} buildings stand as bays of wall (${Math.min(...buildings.map((s) => s.bays))} to ${Math.max(...buildings.map((s) => s.bays))} on the ground storey)`);
  check(!st.get('safehouse') && !st.get('garage') && map.parts.every((p) => p.owner !== 'safehouse' && p.owner !== 'garage'), 'the safehouse and its garage are built to hold: no bays, nothing to bring down');
  check(st.get('gas-canopy')?.pillars === 4 && st.get('water-tower')?.pillars === 4 && st.get('bank')?.pillars === 4, 'the canopy, the water tower and the bank\'s portico stand on four pillars each');
  const walk = st.parts.filter((p) => p.walk).length, ground = st.parts.filter((p) => p.spec.kind === 'bay' && p.spec.storey === 0).length;
  check(walk > ground * 0.8, `${walk} of ${ground} ground-storey bays would be a way in for zombies`);
  check(st.parts.every((p) => !p.gone && p.damage === 0) && st.list.every((s) => s.state === STRUCTURE_STATE.standing), 'everything stands as the night starts');
  check(st.parts.every((p) => !p.structure || p.colliders.length > 0), 'every bay and pillar has its colliders');
  const snap = captureSnapshot(sim, new Map());
  check(snap.bp === undefined && snap.fs === undefined, 'nothing about them in a snapshot until something goes');
  sim.dispose();
}

section('Blowing a hole in a wall');
{
  const sim = fresh({ x: -36, z: -48 });
  const p = sim.players.get('p1')!;
  const diner = sim.structures.get('market')!;
  // Bays of the back wall (it faces south onto the service alley), side by side.
  const back = groundBays(diner).filter((b) => b.spec.axis === 'x' && b.spec.outward === 1).sort((a, b) => a.spec.x - b.spec.x);
  // One to open with grenades, its neighbour, one for a rocket and its neighbour, one for the launcher.
  const [a, b, side, c, d] = [back[1], back[2], back[3], back[5], back[6]];
  check(back.length === 8 && [a, c, side].every((x) => x.walk && roomBehind(x)), `the market's back wall is ${back.length} bays`);
  check(blocked(a) && blocked(c), 'a wall is a wall');
  const inside = beside(a, -2.5, 0.1), outside = beside(a, 3, 0.1);
  const before = zombiePath(sim, outside, inside);
  // Rounds do nothing to it.
  const col = a.colliders[0];
  check(!sim.volatiles.shot(col, 500, p) && a.damage === 0, 'rounds do nothing to a wall');
  // A grenade against it cracks it, a second opens it.
  let ev = blastAt(sim, a, undefined);
  const crack = ev.find((e) => e.type === 'breach' && e.part === a.index);
  check(!a.gone && Math.abs(a.damage - BREACH.frag) < 0.05 && !!crack && crack.type === 'breach' && !crack.gone, `one grenade against it takes ${a.damage.toFixed(2)} of it: cracked, not through`);
  check(blocked(a), 'it still stands');
  ev = blastAt(sim, a, undefined);
  check(a.gone && ev.some((e) => e.type === 'breach' && e.part === a.index && e.gone), 'a second grenade goes through');
  check(!blocked(a), 'and nothing stands in the hole, floor to ceiling');
  check(diner.baysGone === 1 && diner.state === STRUCTURE_STATE.standing, 'the market stands with one bay gone');
  // The way in.
  const after = zombiePath(sim, outside, inside);
  const through = after?.links.some((l) => l.id === BREACH.linkBase + a.index) ?? false;
  check(!!after && after.complete && through, 'a zombie\'s path now goes in through the hole');
  check(!before || !before.complete || before.points.length > (after?.points.length ?? 0), 'which it did not before');
  // A rocket takes a bay at once and shakes the ones beside it.
  const far = sim.structures.parts.filter((x) => x !== c && !x.gone).map((x) => x.damage);
  ev = blastAt(sim, c, BREACH.rocket);
  check(c.gone && !blocked(c), 'a rocket against a bay opens it in one');
  check(!d.gone && d.damage > 0.3 && d.damage < 1 && !b.gone, `the bays beside it are shaken (${d.damage.toFixed(2)}) but stand`);
  const untouched = sim.structures.parts.filter((x) => x.structure !== diner).every((x) => x.damage === 0);
  check(untouched && far.length > 0, 'no other building feels it');
  // The real thing: a rocket fired at the wall.
  p.arsenal.replacePrimary('rpg', true);
  run(sim, WEAPONS.rpg.draw + 0.1);
  check(side.damage === 0, 'a bay four metres off felt nothing');
  const from = beside(side, 9, 1.4);
  sim.setMotion('p1', { pos: { x: from.x, y: ground(from.x, from.z) + 0.02, z: from.z } });
  run(sim, 0.2);
  const eye = p.eye, aim = beside(side, 0, 1.3);
  const fired = sim.fire('p1', eye, { x: aim.x - eye.x, y: aim.y - eye.y, z: aim.z - eye.z }, true, 9000);
  ev = run(sim, 0.3);
  check(fired === 'fired' && side.gone, `a rocket from the launcher blows the bay it hits (${fired})`);
  check(ev.some((e) => e.type === 'explosion') && ev.some((e) => e.type === 'breach' && e.gone), 'with its blast and the breach told to everyone');
  // A zombie comes in by the hole rather than the door.
  sim.setMotion('p1', { pos: { x: inside.x, y: inside.y + 0.02, z: inside.z } });
  const z = sim.spawnZombie('walker', { x: outside.x, y: ground(outside.x, outside.z) + 0.02, z: outside.z }, 'approach');
  let nearest = Infinity, got = false;
  for (let i = 0; i < 60 * 12 && !got; i++) {
    sim.step(DT);
    physics.world.step();
    sim.drain();
    p.health = PLAYER.maxHealth;
    for (const hole of back) if (hole.gone) nearest = Math.min(nearest, Math.hypot(z.pos.x - hole.spec.x, z.pos.z - hole.spec.z));
    got = Math.abs(z.pos.x - diner.spec.x) < diner.spec.w / 2 - 0.4 && Math.abs(z.pos.z - diner.spec.z) < diner.spec.d / 2 - 0.4;
    if (process.env.DEBUG_Z && i % 60 === 0) console.log(i / 60, z.alive, z.state, z.pos.x.toFixed(2), z.pos.y.toFixed(2), z.pos.z.toFixed(2), 'player', p.motion.pos.x.toFixed(2), p.motion.pos.z.toFixed(2), p.alive);
  }
  check(got && nearest < 1.1, `a zombie walks in through a hole (${got ? 'inside' : 'still outside'}, passed ${nearest.toFixed(2)} m from the middle of one)`);
  // The wire.
  const snap = captureSnapshot(sim, new Map());
  check(!!snap.bp && [a, c, side].every((x) => snap.bp!.includes(x.index)) && snap.fs === undefined, 'the snapshot lists the bays that are gone');
  const theirs = new Physics(map);
  const copy = new Simulation({ physics: theirs, map, nav: new NavGrid(nav.buffers()), doors: [], seed: 7, preparation: 0.05 });
  new Mirror(copy, 'p2').apply(JSON.parse(JSON.stringify(snap)));
  const ca = copy.structures.parts[a.index];
  check(ca.gone && ca.colliders.every((x) => theirs.isOff(x)) && copy.structures.parts.every((x, i) => x.gone === sim.structures.parts[i].gone), 'a client\'s copy has the same holes in its own walls');
  copy.dispose();
  sim.dispose();
  // The next night the wall stands again.
  const next = fresh({ x: -36, z: -48 });
  check(blocked(a) && !next.structures.parts[a.index].gone && next.structures.get('market')!.baysGone === 0, 'the next night the wall stands again');
  next.dispose();
}

section('Bringing a building down');
{
  const sim = fresh({ x: -28, z: 30 });
  const p = sim.players.get('p1')!;
  const house = sim.structures.get('house-nw')!;
  const need = Math.ceil(house.bays * COLLAPSE.walls - 1e-9);
  check(need >= 4 && need <= 7, `a house of ${house.bays} bays comes down when ${need} are gone`);
  const { x, z, w, d, base, top } = house.spec;
  const roofed = () => physics.raycast(x + 1.3, top + 3, z + 0.7, 0, -1, 0, top + 6);
  const overhead = roofed();
  check(overhead !== null && overhead < 6, 'it has a roof');
  // A zombie and a survivor inside, a zombie outside.
  const floor = { x: x + 1.5, y: base + 0.02, z: z + 1 };
  const zin = sim.spawnZombie('walker', floor, 'idle');
  const zout = sim.spawnZombie('walker', { x: x, y: 0.02, z: z + d / 2 + 16 }, 'idle');
  const upstairs = nav.nodeAt(x, base + 3.3, z, 3);
  check(upstairs >= 0 && nav.nodeY[upstairs] > base + 2, 'it has an upper floor to walk');
  const events: SimEvent[] = [];
  const bays = groundBays(house);
  let rockets = 0;
  for (const bay of bays) {
    if (house.state !== STRUCTURE_STATE.standing) break;
    if (bay.gone) continue;
    blastAt(sim, bay, BREACH.rocket, events);
    rockets++;
  }
  check(house.state === STRUCTURE_STATE.going && house.baysGone >= need, `${rockets} rockets round its walls and it starts to go (${house.baysGone} bays gone)`);
  check(rockets <= WEAPONS.rpg.magazine + WEAPONS.rpg.startReserve, 'one launcher\'s rockets are enough');
  check(events.some((e) => e.type === 'collapse' && e.structure === house.index && e.stage === STRUCTURE_STATE.going), 'everyone is told it is going');
  check(roofed() === overhead, 'it groans a moment first');
  // The survivor is inside when it lands.
  sim.setMotion('p1', { pos: { x: x - 1.5, y: base + 0.02, z: z - 1 } });
  p.health = PLAYER.maxHealth;
  run(sim, COLLAPSE.warn + 0.2, events);
  check(house.state === STRUCTURE_STATE.fallen && events.some((e) => e.type === 'collapse' && e.stage === STRUCTURE_STATE.fallen), `${COLLAPSE.warn} s later it falls`);
  const sky = roofed();
  check(sky !== null && Math.abs(top + 3 - sky - base) < 0.06, 'the roof and floors are gone: open sky over its floor slab');
  check(bays.every((b) => !blocked(b)), 'no wall is left standing');
  check(!zin.alive && zout.alive, 'the zombie inside is crushed, the one outside is not');
  check(p.alive && Math.abs(PLAYER.maxHealth - p.health - COLLAPSE.crush) < 0.6, `the survivor inside is hurt ${COLLAPSE.crush}`);
  check(house.doors.length > 0 && house.doors.every((i) => doors[i]!.gone && doors[i]!.open), 'its doors are gone with it');
  doors[house.doors[0]]!.setOpen(false, x, z + 20);
  check(doors[house.doors[0]]!.open, 'and can\'t be shut');
  const slots = sim.barricades.slots.filter((s) => s.houseId === house.spec.id);
  check(slots.length > 0 && slots.every((s) => s.ruined && s.max === 0 && !s.glass), 'its windows are no longer openings to board');
  check(nav.isShut(upstairs), 'nothing paths to its upper floor again');
  const way = zombiePath(sim, { x: x + w / 2 + 4, y: 0.1, z }, floor);
  check(!!way && way.complete && way.links.length > 0, 'zombies walk onto the slab over where the walls stood');
  // More blasts change nothing.
  const n = events.length;
  blastAt(sim, bays[0], BREACH.rocket, events);
  check(!events.slice(n).some((e) => e.type === 'breach' || e.type === 'collapse'), 'what is left takes no more harm');
  // The wire.
  const snap = captureSnapshot(sim, new Map());
  check(!!snap.fs && snap.fs.includes(house.index) && !(snap.bp ?? []).some((i) => sim.structures.parts[i].structure === house), 'the snapshot lists it as fallen (and not its bays one by one)');
  const theirs = new Physics(map);
  const theirDoors = createDoorBodies(map, theirs);
  const copy = new Simulation({ physics: theirs, map, nav: new NavGrid(nav.buffers()), doors: theirDoors, seed: 7, preparation: 0.05 });
  new Mirror(copy, 'p2').apply(JSON.parse(JSON.stringify(snap)));
  const ch = copy.structures.list[house.index];
  check(ch.state === STRUCTURE_STATE.fallen && ch.colliders.every((c) => theirs.isOff(c)) && ch.doors.every((i) => theirDoors[i]!.gone), 'a client\'s copy has it down too');
  copy.dispose();
  sim.dispose();
  // The next night it stands.
  const next = fresh({ x: -28, z: 30 });
  const again = next.structures.get('house-nw')!;
  check(again.state === STRUCTURE_STATE.standing && roofed() === overhead && bays.every((b) => blocked(b)), 'the next night it stands again, roof, walls and all');
  check(house.doors.every((i) => !doors[i]!.gone && !doors[i]!.open) && !nav.isShut(upstairs), 'with its doors hung and its upper floor open');
  next.dispose();
}

section('Pillars');
{
  const sim = fresh({ x: 91, z: 20 });
  const canopy = sim.structures.get('gas-canopy')!;
  const tower = sim.structures.get('water-tower')!;
  const events: SimEvent[] = [];
  const under = () => physics.raycast(91, 12, -17, 0, -1, 0, 14);
  check(under() !== null && under()! < 7.5, 'the canopy is overhead at the pumps');
  // Grenades: three to a pillar.
  const post = canopy.parts[0];
  let n = 0;
  while (!post.gone && n < 6) {
    blastAt(sim, post, undefined, events);
    n++;
  }
  check(n === 3, `a pillar takes ${n} grenades`);
  check(canopy.state === STRUCTURE_STATE.standing, 'the canopy stands on three');
  blastAt(sim, canopy.parts[3], BREACH.rocket, events);
  check(canopy.parts[3].gone && canopy.state === STRUCTURE_STATE.going, 'a rocket takes a second and it starts to go');
  run(sim, COLLAPSE.warn + 0.2, events);
  check(canopy.state === STRUCTURE_STATE.fallen && (under() === null || under()! > 11.5), 'the canopy comes down');
  // The water tower: two legs.
  const legs = tower.parts;
  blastAt(sim, legs[0], BREACH.rocket, events);
  check(legs[0].gone && tower.state === STRUCTURE_STATE.standing, 'the water tower stands on three legs');
  const z = sim.spawnZombie('walker', { x: tower.spec.x + 1, y: 0.02, z: tower.spec.z + 1 }, 'idle');
  blastAt(sim, legs[1], BREACH.rocket, events);
  run(sim, COLLAPSE.warn + 0.2, events);
  check(tower.state === STRUCTURE_STATE.fallen, 'and falls with two gone');
  check(!z.alive, 'on whatever stood under it');
  // A building's own columns only help it on its way.
  const bank = sim.structures.get('bank')!;
  for (const col of bank.parts.filter((x) => x.spec.kind === 'pillar')) blastAt(sim, col, BREACH.rocket, events);
  check(bank.pillarsGone === 4 && bank.state === STRUCTURE_STATE.standing && Math.abs(sim.structures.strain(bank) - COLLAPSE.porch) < 0.2, `the bank stands with its portico's columns gone, ${Math.round(sim.structures.strain(bank) * 100)}% of the way to falling`);
  const tank = physics.raycast(tower.spec.x, tower.spec.top + 2, tower.spec.z, 0, -1, 0, tower.spec.top + 4);
  check(tank !== null && tank > tower.spec.top, 'the tank no longer stands over the lot');
  sim.dispose();
  fresh({ x: 91, z: 20 }).dispose();
}

section('Fuel against a wall');
{
  const sim = fresh({ x: 0, z: 8 });
  const p = sim.players.get('p1')!;
  const market = sim.structures.get('market')!;
  const bay = groundBays(market).find((b) => b.walk)!;
  // A car's worth of fuel going up half a metre from it.
  sim.explosives.explode(beside(bay, 0.5, 0.8), p, 0, { kind: 'fuel', power: VOLATILES.car!.power });
  run(sim, 0.1);
  check(!bay.gone && bay.damage > 0.5, `a car going up against a wall leaves it badly cracked (${bay.damage.toFixed(2)})`);
  sim.explosives.explode(beside(bay, 0.5, 0.8), p, 0, { kind: 'fuel', power: VOLATILES.car!.power });
  run(sim, 0.1);
  check(bay.gone, 'a second opens it');
  sim.dispose();
  fresh({ x: 0, z: 8 }).dispose();
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
