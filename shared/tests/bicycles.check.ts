/**
 * Headless checks for bicycles on the real map collision: where the night's bikes lie (pavement,
 * outdoors, one by the safehouse, spread out, clear of skateboards, the same for the same seed),
 * getting on and off (reach, one rider, one passenger on the pegs, the pegs only on a slow bike,
 * where a bike falls and a passenger steps down), what the rider's hands can't do (the trigger
 * rings the bell), the passenger carried on the pegs and shooting from them, being knocked or
 * thrown off (hits, going down, dying, leaving: either seat), the noise zombies hear, and the wire
 * format (snapshot rows, the client's copy, the motion message's heading).
 * Run with `npm run check:bike`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, createDoorBodies, buildNavGrid, Simulation, Mirror, captureSnapshot, packMotion, unpackMotion,
  BICYCLE, NAV_INDOOR, PLAYER, outsideBy, rng, type SimEvent, type NavGrid, type Vec3,
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

const sims: Simulation[] = [];
function fresh(seed = 11): Simulation {
  const sim = new Simulation({ physics, map, nav, doors, seed, preparation: 600 });
  sims.push(sim);
  return sim;
}
const run = (sim: Simulation, seconds: number, events: SimEvent[] = []) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.step(DT);
    for (const e of sim.drain()) events.push(e);
  }
  return events;
};
const d2 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const spawn = map.playerSpawns[0];
const bikeEvents = (ev: SimEvent[]) => ev.filter((e): e is Extract<SimEvent, { type: 'bike' }> => e.type === 'bike');

section('Where the bikes lie');
{
  const seeds = Array.from({ length: 40 }, (_, i) => ((i + 1) * 2654435761) >>> 0);
  let allPaved = true, allOutdoor = true, allSpaced = true, allNear = true, allBounds = true, allFlat = true, allClear = true, allRoom = true, allCars = true;
  let counts = true;
  for (const seed of seeds) {
    const sim = fresh(seed);
    const bs = sim.bicycles.bikes;
    if (bs.length !== BICYCLE.count) counts = false;
    const first = bs[0];
    const dn = first ? d2(first.pos, spawn) : Infinity;
    if (!(dn >= BICYCLE.nearSafehouse[0] - 0.5 && dn <= BICYCLE.nearSafehouse[1] + 0.5)) allNear = false;
    for (const b of bs) {
      const hit = physics.raycastHit(b.pos.x, b.pos.y + 0.5, b.pos.z, 0, -1, 0, 1);
      if (!hit || (hit.surface !== 'asphalt' && hit.surface !== 'concrete')) allPaved = false;
      if (!hit || Math.abs(0.5 - hit.distance) > 0.05) allFlat = false;
      const n = nav.nodeAt(b.pos.x, b.pos.y, b.pos.z, 0.6);
      if (n < 0 || nav.flags[n] & NAV_INDOOR) allOutdoor = false;
      const B = map.bounds;
      if (b.pos.x < B.x0 || b.pos.x > B.x1 || b.pos.z < B.z0 || b.pos.z > B.z1) allBounds = false;
      for (const o of bs) {
        if (o === b || b === first || o === first) continue;
        if (d2(o.pos, b.pos) < BICYCLE.spacing - 0.01) allSpaced = false;
      }
      if (b !== first && d2(b.pos, spawn) < BICYCLE.spacing - 0.01) allSpaced = false;
      if (sim.skateboards.boards.some((k) => d2(k.pos, b.pos) < BICYCLE.clearOfBoards - 0.01)) allClear = false;
      // Neither wheel in a wall: clear ground along the frame both ways.
      const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
      const ahead = physics.raycast(b.pos.x, b.pos.y + 0.4, b.pos.z, fx, 0, fz, 1.1);
      const behind = physics.raycast(b.pos.x, b.pos.y + 0.4, b.pos.z, -fx, 0, -fz, 0.8);
      if (ahead !== null || behind !== null) allRoom = false;
      // Not under or against a parked car (front wheel, middle, back wheel).
      for (const k of [-0.9, 0, 0.9]) if (sim.vehicles.list.some((v) => outsideBy(v, b.pos.x + fx * k, b.pos.z + fz * k) < 0.2)) allCars = false;
    }
  }
  check(counts, `${BICYCLE.count} bikes every night (${seeds.length} nights)`);
  check(allPaved, 'every bike lies on asphalt or concrete');
  check(allFlat, 'every bike rests on the surface under it');
  check(allOutdoor, 'every bike is outdoors');
  check(allNear, `one lies ${BICYCLE.nearSafehouse[0]}-${BICYCLE.nearSafehouse[1]} m from the safehouse spawn`);
  check(allSpaced, `the others are at least ${BICYCLE.spacing} m from the spawn and from each other`);
  check(allClear, `none lies within ${BICYCLE.clearOfBoards} m of a skateboard`);
  check(allRoom, 'each lies along clear ground (no wheel in a wall)');
  check(allCars, 'none lies under or against a parked car');
  check(allBounds, 'all inside the map');
  const key = (sim: Simulation) => sim.bicycles.bikes.map((b) => `${b.pos.x.toFixed(2)},${b.pos.z.toFixed(2)},${b.yaw.toFixed(3)},${b.look}`).join('|');
  check(key(fresh(77)) === key(fresh(77)), 'the same seed lays them in the same spots (every machine agrees)');
  check(key(fresh(77)) !== key(fresh(78)), 'another seed lays them somewhere else');
  const boards = (sim: Simulation) => sim.skateboards.boards.map((b) => `${b.pos.x.toFixed(2)},${b.pos.z.toFixed(2)}`).join('|');
  check(boards(fresh(5)) === boards(fresh(5)), 'the skateboards lie where they always did');
  const z1 = fresh(5).random(), z2 = rng(5)();
  check(z1 === z2, 'placing bikes leaves the simulation\'s own random numbers alone');
  const sim = fresh(11);
  const near = sim.bicycles.bikes[0];
  const path = nav.findPath({ x: spawn.x, y: spawn.y, z: spawn.z }, near.pos, { maxExpand: 200000 });
  check(!!path && path.complete, 'the safehouse bike can be walked to from the spawn');
}

section('Getting on and off');
{
  const sim = fresh(11);
  const b = sim.bicycles.bikes[1];
  const p = sim.addPlayer('p1', 'One', 'ar', 'pistol', { x: b.pos.x + 3, y: b.pos.y, z: b.pos.z }, 0);
  const q = sim.addPlayer('p2', 'Two', 'ar', 'pistol', { x: b.pos.x + 30, y: b.pos.y, z: b.pos.z }, 0);
  check(!sim.rideBike('p1', b.id, 'rider'), 'out of reach (3 m): can\'t pick it up');
  check(sim.bicycles.inReach(p).length === 0, 'and it isn\'t offered');
  p.motion.pos = { x: b.pos.x + 1.2, y: b.pos.y, z: b.pos.z };
  const offered = sim.bicycles.inReach(p);
  check(offered[0]?.bike === b && offered[0].seat === 'rider', 'within reach a free bike is offered to ride');
  check(!sim.rideBike('p1', b.id, 'peg'), 'nobody rides it: no pegs to hop on');
  const ev: SimEvent[] = [];
  check(sim.rideBike('p1', b.id, 'rider'), 'picks it up in reach');
  for (const e of sim.drain()) ev.push(e);
  check(bikeEvents(ev).some((e) => e.stage === 'on' && e.seat === 'rider' && e.player === 'p1' && e.bike === b.id), 'a bike event says so');
  check(b.rider === 'p1' && d2(b.pos, p.motion.pos) < 0.01, 'the bike is theirs, under them');
  q.motion.pos = { x: b.pos.x - 1, y: b.pos.y, z: b.pos.z };
  check(!sim.rideBike('p2', b.id, 'rider'), 'nobody else can take the saddle');
  const other = sim.bicycles.bikes[2];
  p.motion.pos = { x: other.pos.x + 0.5, y: other.pos.y, z: other.pos.z };
  check(!sim.rideBike('p1', other.id, 'rider'), 'one bike at a time');
  const board = sim.skateboards.boards[1];
  p.motion.pos = { x: board.pos.x + 0.3, y: board.pos.y, z: board.pos.z };
  check(!sim.rideBoard('p1', board.id), 'and no skateboard from the saddle');
  // Riding: the bike goes where they go and points where their browser says.
  p.motion.pos = { x: b.pos.x + 5, y: b.pos.y, z: b.pos.z + 2 };
  p.motion.vel = { x: 6, y: 0, z: 0 };
  p.motion.bike = 1.2;
  run(sim, 0.1);
  check(d2(b.pos, p.motion.pos) < 0.01, 'the bike stays under the rider');
  check(Math.abs(b.yaw - 1.2) < 1e-6, 'and points the way the rider\'s browser says');
  p.motion.bike = undefined;
  p.motion.vel = { x: 0, y: 0, z: 5 };
  run(sim, 0.05);
  check(Math.abs(b.yaw) < 1e-6, 'without a heading it follows the way they ride');
  // Getting off: it falls where the browser put it when that is close.
  const at = { x: p.motion.pos.x + 0.45, y: p.motion.pos.y, z: p.motion.pos.z };
  ev.length = 0;
  check(sim.leaveBike('p1', at, 0.4), 'gets off');
  for (const e of sim.drain()) ev.push(e);
  check(b.rider === null && d2(b.pos, at) < 0.01 && Math.abs(b.yaw - 0.4) < 1e-6, 'the bike lies where they left it, pointing their way');
  check(bikeEvents(ev).some((e) => e.stage === 'off' && e.seat === 'rider'), 'a bike event says they got off');
  const g = physics.raycast(b.pos.x, b.pos.y + 1, b.pos.z, 0, -1, 0, 3);
  check(g !== null && Math.abs(1 - g) < 0.02, 'on the ground under it');
  p.motion.pos = { x: b.pos.x + 0.5, y: b.pos.y, z: b.pos.z };
  check(sim.rideBike('p1', b.id, 'rider'), 'back on');
  sim.leaveBike('p1', { x: b.pos.x + 30, y: b.pos.y, z: b.pos.z }, 0);
  check(d2(b.pos, p.motion.pos) < 0.01, 'a spot far from the rider is ignored: the bike falls by them');
  check(!sim.leaveBike('p1'), 'getting off with no bike does nothing');
}

section('Hands on the bars');
{
  const sim = fresh(11);
  sim.skipPreparation();
  const b = sim.bicycles.bikes[1];
  const p = sim.addPlayer('p1', 'One', 'ar', 'pistol', { ...b.pos }, 0);
  sim.addPlayer('p2', 'Two', 'ar', 'pistol', { x: b.pos.x + 30, y: b.pos.y, z: b.pos.z }, 0);
  run(sim, 1);
  p.arsenal.weapon.mag = 3;
  sim.reload('p1');
  check(p.arsenal.action === 'reload', '(reloading on foot)');
  sim.drain();
  check(sim.rideBike('p1', b.id, 'rider'), 'picks a bike up mid-reload');
  const ev = sim.drain();
  check(p.arsenal.action !== 'reload' && ev.some((e) => e.type === 'reload' && e.stage === 'cancel'), 'both hands to the bars: the reload stops');
  run(sim, 1);
  const eye = p.eye;
  const mag = p.arsenal.weapon.mag;
  check(sim.fire('p1', eye, { x: 0, y: 0, z: 1 }, true, 7) === 'busy' && p.arsenal.weapon.mag === mag, 'the rider can\'t shoot');
  check(!sim.reload('p1'), 'or reload');
  check(!sim.melee('p1', { origin: eye, dir: { x: 0, y: 0, z: 1 } }), 'or swing');
  check(!sim.throwItem('p1', 'frag', { origin: eye, dir: { x: 0, y: 0, z: 1 } }), 'or throw');
  check(!sim.switchWeapon('p1', 'secondary'), 'or change guns');
  p.health = 50;
  check(!sim.bandage('p1'), 'or dress a wound');
  sim.drain();
  check(sim.ringBell('p1'), 'the trigger rings the bell instead');
  const rang = sim.drain();
  check(rang.some((e) => e.type === 'bike' && e.stage === 'bell' && e.player === 'p1'), 'heard as a bell event');
  check(sim.noises.some((n) => n.source === 'p1' && Math.abs(n.radius - BICYCLE.bellNoise) < 0.01), `and by zombies ${BICYCLE.bellNoise} m round`);
  check(!sim.ringBell('p1'), `not again for ${BICYCLE.bellEvery} s`);
  run(sim, BICYCLE.bellEvery + 0.05);
  check(sim.ringBell('p1'), 'then again');
  sim.leaveBike('p1');
  check(!sim.ringBell('p1'), 'no bell off the bike');
  check(sim.fire('p1', p.eye, { x: 0, y: 0, z: 1 }, true, 7) === 'fired', 'off the bike the gun works again');
}

section('Two on a bike');
{
  const sim = fresh(11);
  sim.skipPreparation();
  const b = sim.bicycles.bikes[1];
  const p = sim.addPlayer('p1', 'Rider', 'ar', 'pistol', { ...b.pos }, 0);
  const q = sim.addPlayer('p2', 'Pegs', 'ar', 'pistol', { x: b.pos.x + 4, y: b.pos.y, z: b.pos.z }, 0);
  const s = sim.addPlayer('p3', 'Third', 'ar', 'pistol', { x: b.pos.x + 40, y: b.pos.y, z: b.pos.z }, 0);
  sim.rideBike('p1', b.id, 'rider');
  check(!sim.rideBike('p2', b.id, 'peg'), 'out of reach: no hopping on the pegs');
  q.motion.pos = { x: b.pos.x + 1.4, y: b.pos.y, z: b.pos.z };
  p.motion.vel = { x: BICYCLE.pegMaxSpeed + 2, y: 0, z: 0 };
  check(sim.bicycles.inReach(q).length === 0, `the pegs aren't offered while it goes faster than ${BICYCLE.pegMaxSpeed} m/s`);
  check(!sim.rideBike('p2', b.id, 'peg'), 'and can\'t be hopped onto');
  p.motion.vel = { x: 1, y: 0, z: 0 };
  const off = sim.bicycles.inReach(q);
  check(off[0]?.bike === b && off[0].seat === 'peg', 'slowed down, the pegs are offered');
  check(!sim.rideBike('p2', b.id, 'rider'), 'the saddle is taken');
  sim.drain();
  check(sim.rideBike('p2', b.id, 'peg'), 'hops on the pegs');
  const ev = sim.drain();
  check(bikeEvents(ev).some((e) => e.stage === 'on' && e.seat === 'peg' && e.player === 'p2'), 'a bike event says so (seat: peg)');
  check(b.passenger === 'p2' && sim.bicycles.carrying('p2') === b, 'the bike carries them');
  s.motion.pos = { x: b.pos.x + 1, y: b.pos.y, z: b.pos.z };
  check(!sim.rideBike('p3', b.id, 'peg') && sim.bicycles.inReach(s).length === 0, 'room for one on the pegs');
  check(!sim.rideBike('p2', sim.bicycles.bikes[0].id, 'rider'), 'on the pegs you can\'t pick up another bike');
  // Carried along: wherever the rider goes, the passenger stands on the pegs over the back wheel.
  p.motion.pos = { x: b.pos.x + 6, y: b.pos.y, z: b.pos.z + 3 };
  p.motion.bike = 0.7;
  p.motion.vel = { x: Math.sin(0.7) * 9, y: 0, z: Math.cos(0.7) * 9 };
  q.motion.pos = { x: 999, y: 50, z: 999 };
  run(sim, 0.05);
  const pegs = sim.bicycles.pegs(b);
  check(d2(q.motion.pos, pegs) < 0.01 && Math.abs(q.motion.pos.y - (b.pos.y + BICYCLE.pegHeight)) < 0.01, 'the passenger is on the pegs, whatever their own browser said');
  check(Math.abs(d2(q.motion.pos, p.motion.pos) - BICYCLE.pegBack) < 0.01, `${BICYCLE.pegBack} m behind the rider`);
  const behind = (q.motion.pos.x - p.motion.pos.x) * Math.sin(0.7) + (q.motion.pos.z - p.motion.pos.z) * Math.cos(0.7);
  check(behind < -BICYCLE.pegBack + 0.01, 'behind, along the way the bike points');
  check(Math.abs(q.speed - 9) < 0.01, 'moving at the bike\'s speed');
  // The passenger shoots from the pegs; the bike's speed shakes their aim less than running would.
  q.arsenal.weapon.mag = 30;
  const hip = (speed: number) => q.arsenal.spread({ speed, crouching: false, grounded: true, aiming: false });
  const dir = { x: Math.sin(0.7), y: 0, z: Math.cos(0.7) };
  let fired = false;
  for (let i = 0; i < 30 && !fired; i++) {
    fired = sim.fire('p2', q.eye, dir, true, 11 + i) === 'fired';
    run(sim, 0.05);
  }
  check(fired, 'the passenger fires while riding');
  check(hip(9 * BICYCLE.spreadSpeed) < hip(9), `their shots spread as at ${(9 * BICYCLE.spreadSpeed).toFixed(1)} m/s, not 9`);
  check(sim.revive('p2', 'p3') === false, 'no reviving from a moving bike');
  // Off the pegs: down beside the back wheel, or where their browser stepped down when close.
  const step = { x: q.motion.pos.x + 0.6, y: b.pos.y, z: q.motion.pos.z };
  ev.length = 0;
  check(sim.leaveBike('p2', step), 'hops off the pegs');
  for (const e of sim.drain()) ev.push(e);
  check(b.passenger === null && b.rider === 'p1', 'the rider rides on');
  const under = physics.raycast(step.x, step.y + 1.5, step.z, 0, -1, 0, 4);
  check(d2(q.motion.pos, step) < 0.01 && under !== null && Math.abs(q.motion.pos.y - (step.y + 1.5 - under)) < 0.02, 'they stand where they stepped down, on the ground');
  check(bikeEvents(ev).some((e) => e.player === 'p2' && e.seat === 'peg' && e.stage === 'off'), 'a bike event says so');
  // The rider getting off takes the passenger off too.
  p.motion.vel = { x: 0, y: 0, z: 0 };
  q.motion.pos = { x: b.pos.x + 1, y: b.pos.y, z: b.pos.z };
  check(sim.rideBike('p2', b.id, 'peg'), 'back on the pegs');
  sim.drain();
  ev.length = 0;
  sim.leaveBike('p1');
  for (const e of sim.drain()) ev.push(e);
  check(b.rider === null && b.passenger === null, 'the rider gets off: nobody is left on the bike');
  const down = bikeEvents(ev).find((e) => e.player === 'p2');
  check(!!down && down.stage === 'off' && down.seat === 'peg', 'the passenger is told they are off');
  check(!!down && d2(q.motion.pos, down.pos) < 0.01 && d2(q.motion.pos, b.pos) < 1.6 && d2(q.motion.pos, b.pos) > 0.3, 'stepped down beside the bike');
  const floor = physics.raycast(q.motion.pos.x, q.motion.pos.y + 1, q.motion.pos.z, 0, -1, 0, 3);
  check(floor !== null && Math.abs(1 - floor) < 0.05, 'on the ground');
}

section('Knocked and thrown off');
{
  const setup = () => {
    const sim = fresh(11);
    const b = sim.bicycles.bikes[1];
    const p = sim.addPlayer('p1', 'Rider', 'ar', 'pistol', { ...b.pos }, 0);
    const q = sim.addPlayer('p2', 'Pegs', 'ar', 'pistol', { x: b.pos.x + 1, y: b.pos.y, z: b.pos.z }, 0);
    sim.addPlayer('p3', 'Far', 'ar', 'pistol', { x: b.pos.x + 60, y: b.pos.y, z: b.pos.z }, 0);
    sim.rideBike('p1', b.id, 'rider');
    sim.rideBike('p2', b.id, 'peg');
    sim.drain();
    return { sim, b, p, q };
  };
  {
    const { sim, b, p } = setup();
    sim.damagePlayer(p, BICYCLE.knockDamage - 1, b.pos);
    check(b.rider === 'p1' && b.passenger === 'p2', `a light hit (${BICYCLE.knockDamage - 1}) leaves them both on`);
    sim.damagePlayer(p, BICYCLE.knockDamage + 2, b.pos);
    const ev = bikeEvents(sim.drain());
    check(b.rider === null && b.passenger === null, `a hard hit (${BICYCLE.knockDamage + 2}) on the rider throws both off`);
    check(ev.some((e) => e.player === 'p1' && e.stage === 'bail') && ev.some((e) => e.player === 'p2' && e.stage === 'bail'), 'as bails');
    check(sim.noises.some((n) => n.source === 'p1' && Math.abs(n.radius - BICYCLE.crashNoise) < 0.01), `the crash is heard ${BICYCLE.crashNoise} m round`);
  }
  {
    const { sim, b, q } = setup();
    sim.damagePlayer(q, BICYCLE.knockDamage + 2, b.pos);
    check(b.passenger === null && b.rider === 'p1', 'a hard hit on the passenger knocks only them off');
  }
  {
    const { sim, b, p } = setup();
    sim.damagePlayer(p, 500, b.pos);
    check(p.downed && b.rider === null && b.passenger === null, 'the rider going down drops the bike and the passenger');
  }
  {
    const { sim, b, q } = setup();
    sim.damagePlayer(q, 500, b.pos);
    check(q.downed && b.passenger === null && b.rider === 'p1', 'the passenger going down falls off; the rider rides on');
  }
  {
    const { sim, b } = setup();
    sim.removePlayer('p1');
    check(b.rider === null && b.passenger === null, 'the rider leaving the game drops the bike and the passenger');
  }
  {
    const { sim, b } = setup();
    sim.removePlayer('p2');
    run(sim, 0.05);
    check(b.passenger === null && b.rider === 'p1', 'the passenger leaving frees the pegs');
  }
  {
    const { sim, b, p } = setup();
    sim.leaveBike('p1', undefined, undefined, true);
    const ev = bikeEvents(sim.drain());
    check(b.rider === null && ev.some((e) => e.player === 'p2' && e.stage === 'bail'), 'a crash into a wall (the rider\'s browser says) throws the passenger too');
    p.health = 1;
  }
  {
    const sim = fresh(11);
    const b = sim.bicycles.bikes[0];
    const p = sim.addPlayer('p1', 'Alone', 'ar', 'pistol', { ...b.pos }, 0);
    sim.rideBike('p1', b.id, 'rider');
    sim.damagePlayer(p, 500, b.pos);
    check(!p.alive && b.rider === null, 'dying alone drops the bike');
    check(!sim.rideBike('p1', b.id, 'rider'), 'the dead don\'t ride');
  }
}

section('Noise');
{
  const sim = fresh(11);
  const b = sim.bicycles.bikes[1];
  const p = sim.addPlayer('p1', 'One', 'ar', 'pistol', { ...b.pos }, 0);
  sim.rideBike('p1', b.id, 'rider');
  p.motion.vel = { x: BICYCLE.pedalTop, y: 0, z: 0 };
  p.motion.grounded = true;
  sim.noises.length = 0;
  run(sim, 1.5);
  const mine = sim.noises.filter((n) => n.source === 'p1');
  const loudest = Math.max(0, ...mine.map((n) => n.radius));
  check(mine.length >= 3, `riding is heard (${mine.length} noises in 1.5 s)`);
  check(loudest <= BICYCLE.noise * 1.2 && loudest >= BICYCLE.noise * 0.8, `about ${BICYCLE.noise} m at full pedal (${loudest.toFixed(1)} m), quieter than a skateboard (7 m) or sprinting feet (11 m)`);
  p.motion.vel = { x: 0.5, y: 0, z: 0 };
  sim.noises.length = 0;
  run(sim, 1.5);
  check(sim.noises.filter((n) => n.source === 'p1').length === 0, 'standing still in the saddle is silent (no footsteps either)');
}

section('Wire format');
{
  const sim = fresh(11);
  const b = sim.bicycles.bikes[2];
  sim.addPlayer('p1', 'One', 'ar', 'pistol', { ...b.pos }, 0);
  sim.addPlayer('p2', 'Two', 'ar', 'pistol', { x: b.pos.x + 1, y: b.pos.y, z: b.pos.z }, 0);
  sim.rideBike('p1', b.id, 'rider');
  sim.rideBike('p2', b.id, 'peg');
  run(sim, 0.05);
  const snap = captureSnapshot(sim, new Map());
  check(Array.isArray(snap.bk) && snap.bk.length === BICYCLE.count, 'snapshots list every bike');
  const row = snap.bk!.find((x) => x[0] === b.id)!;
  check(row[5] === 'p1' && row[6] === 'p2', 'with its rider and passenger');
  const copy = fresh(999);
  copy.addPlayer('me', 'Me', 'ar', 'pistol', { x: 0, y: 0, z: 0 }, 0);
  const mirror = new Mirror(copy, 'me');
  mirror.apply(JSON.parse(JSON.stringify(snap)), 1);
  const cb = copy.bicycles.bikes[b.id];
  check(cb.rider === 'p1' && cb.passenger === 'p2' && d2(cb.pos, b.pos) < 0.02 && Math.abs(cb.yaw - b.yaw) < 0.002, 'the client copy has the rider, passenger, spot and heading');
  const free = sim.bicycles.bikes.find((x) => x.rider === null)!;
  const cf = copy.bicycles.bikes[free.id];
  check(cf.rider === null && cf.passenger === null && cf.look === free.look && d2(cf.pos, free.pos) < 0.02, 'and the lying bikes as they lie');
  mirror.holdBike(free.id, 5);
  cf.rider = 'me';
  mirror.apply(JSON.parse(JSON.stringify({ ...snap, t: snap.t + 0.05 })), 2);
  check(cf.rider === 'me', 'a bike this client just picked up is held as predicted');
  mirror.apply(JSON.parse(JSON.stringify({ ...snap, t: snap.t + 0.1 })), 6);
  check(cf.rider === null, 'after the hold the server\'s word stands');
  mirror.event({ type: 'bike', player: 'p2', bike: b.id, stage: 'bail', seat: 'peg', pos: { x: 1, y: 0, z: 2 }, yaw: 0.5 });
  check(cb.passenger === null && cb.rider === 'p1', 'a passenger thrown off shows before the next snapshot');
  mirror.event({ type: 'bike', player: 'p1', bike: b.id, stage: 'bail', seat: 'rider', pos: { x: 3, y: 0, z: 4 }, yaw: 0.25 });
  check(cb.rider === null && cb.pos.x === 3 && cb.yaw === 0.25, 'and a rider thrown off, with where the bike fell');
  mirror.event({ type: 'bike', player: 'p1', bike: b.id, stage: 'bell', seat: 'rider', pos: { x: 9, y: 0, z: 9 }, yaw: 0 });
  check(cb.pos.x === 3, 'a bell changes nothing');
  const frame = {
    motion: { pos: { x: 1, y: 0, z: 2 }, vel: { x: 7, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 1.6, crouching: false, sprinting: false, aiming: false, grounded: true, bike: -2.5, pushing: true },
    facing: 0, trigger: false, aimOrigin: { x: 0, y: 1, z: 0 }, aimDir: { x: 0, y: 0, z: 1 },
  };
  const packed = packMotion(frame);
  const back = unpackMotion(packed);
  check(packed.length === 18 && !!back && Math.abs((back.motion.bike ?? 0) + 2.5) < 0.002 && back.motion.board === undefined && back.motion.pushing === true,
    'the motion message carries the bike\'s heading (not a board\'s) and the pedalling');
  const board = unpackMotion(packMotion({ ...frame, motion: { ...frame.motion, bike: undefined, board: 1.25 } }));
  check(!!board && Math.abs((board.motion.board ?? 0) - 1.25) < 0.002 && board.motion.bike === undefined, 'a skateboard\'s heading still reads as a board\'s');
  const foot = unpackMotion(packMotion({ ...frame, motion: { ...frame.motion, bike: undefined, pushing: false } }));
  check(!!foot && foot.motion.bike === undefined && foot.motion.board === undefined && packMotion({ ...frame, motion: { ...frame.motion, bike: undefined } }).length === 17, 'on foot neither (17 numbers, as before)');
}

for (const s of sims) s.dispose();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
