/**
 * Headless checks for drivable vehicles on the real map collision: which props became vehicles
 * (overturned wrecks stay scenery), their bodies, fuel from the seed, getting in (the wheel first,
 * then the nearest seat), the starter and the engine, driving (pull, top speed, steering, walls),
 * fuel burning down and running out, getting out (not at speed, by a clear door), being thrown out
 * (down, dead, gone), the dead run down or shoved aside, claws through a window, shooting from a
 * seat, spawns kept out of cars, and the wire format (snapshot rows, the client's copy, drive messages).
 * Run with `npm run check:vehicles`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, createDoorBodies, buildNavGrid, Simulation, Mirror, captureSnapshot, packDrive, unpackDrive,
  VEHICLE, VEHICLES, DRIVE_FLAG, RAPIER, driveStep, hullY, isDrivable, vehicleKindOf, seatWorld, outsideBy, groups, GROUP,
  type DriveBody, type DriveInput, type SimEvent, type NavGrid, type Vec3, type Vehicle, type SimPlayer,
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
  for (const s of sims.splice(0)) s.dispose();
  const sim = new Simulation({ physics, map, nav, doors, seed, preparation: 600 });
  sims.push(sim);
  physics.advance(DT);
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
const NONE: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

/** The driver's browser: its own copy of the car's motion, stepped and reported every frame. */
function driver(sim: Simulation, p: SimPlayer, v: Vehicle) {
  const b: DriveBody = { def: v.def, pos: { ...v.pos }, yaw: v.yaw, speed: v.speed, vel: { ...v.vel }, steer: v.steer, body: v.body };
  let crashes = 0;
  return {
    b,
    get crashes() { return crashes; },
    drive(input: DriveInput, seconds: number, events: SimEvent[] = []) {
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        const crash = driveStep(physics, b, input, DT, v.engine);
        if (crash > 1) crashes++;
        const flags = (input.throttle > 0 ? DRIVE_FLAG.throttle : 0) | (input.brake > 0 ? DRIVE_FLAG.brake : 0) | DRIVE_FLAG.lights;
        sim.drive(p.id, { vehicle: v.id, pos: { ...b.pos }, yaw: b.yaw, vel: { ...b.vel }, speed: b.speed, steer: b.steer, input: flags, crash });
        run(sim, DT, events);
      }
      return events;
    },
  };
}

/** A vehicle with a clear run of `ahead` metres in front of it (and a little either side), and `ok` with it. */
function clearLane(sim: Simulation, ahead: number, kind?: string, ok?: (v: Vehicle) => boolean): Vehicle | null {
  for (const v of sim.vehicles.list) {
    if (kind && v.kind !== kind) continue;
    if (ok && !ok(v)) continue;
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    const hit = physics.world.castShape(
      { x: v.pos.x, y: v.pos.y + hullY(v.def), z: v.pos.z }, { x: 0, y: Math.sin(v.yaw / 2), z: 0, w: Math.cos(v.yaw / 2) },
      { x: c * ahead, y: 0, z: -s * ahead }, new RAPIER.Cuboid(v.def.hx, (v.def.low - v.def.clear) / 2, v.def.hz + 0.6), 0, 1, false,
      undefined, groups(GROUP.vehicle, GROUP.static | GROUP.dynamic | GROUP.vehicle), undefined, v.body,
    );
    if (!hit) return v;
  }
  return null;
}
/** Stands a survivor beside a vehicle's driver door. */
function besideDoor(sim: Simulation, p: SimPlayer, v: Vehicle, side = -1) {
  const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
  const lz = side * (v.def.hz + 0.6);
  p.motion.pos = { x: v.pos.x + 0.1 * c + lz * s, y: v.pos.y, z: v.pos.z - 0.1 * s + lz * c };
}

section('Which props drive');
{
  const sim = fresh();
  const drivable = map.props.filter(isDrivable);
  const overturned = map.props.filter((p) => p.kind === 'wreckedCar' && (p.variant ?? 0) >= 10);
  const parkedKinds = ['car', 'policeCar', 'wreckedCar', 'armoredTruck'];
  const all = map.props.filter((p) => parkedKinds.includes(p.kind));
  check(sim.vehicles.list.length === drivable.length && drivable.length >= 6 && drivable.length <= all.length / 2, `only some of the ${all.length} cars, cruisers, wrecks and trucks drive (${drivable.length}, the ones the map marks)`);
  const elm = drivable.filter((p) => Math.abs(p.z) < 30).length;
  const oak = drivable.filter((p) => p.z > 75 && p.z < 112 && p.x > -55).length;
  check(elm >= 2 && oak >= 2, `a few on each street (Hale ${elm}, Kinney ${oak})`);
  check(map.props.filter((p) => p.kind === 'wreckedCar').every((p) => vehicleKindOf(p) === null && vehicleKindOf({ ...p, drive: false }) === null), 'every wreck stays parked');
  check(overturned.length > 0 && overturned.every((p) => vehicleKindOf({ ...p, drive: true }) === null), `wrecks on their roofs never drive, even marked (${overturned.length})`);
  check(sim.vehicles.list.some((v) => v.kind === 'truck') && sim.vehicles.list.some((v) => v.kind === 'police') && sim.vehicles.list.some((v) => v.kind === 'car'), 'cars, cruisers and the armored truck are all there');
  const parked = all.find((p) => !isDrivable(p) && p.kind === 'car')!;
  const roof = physics.raycastHit(parked.x, 3, parked.z, 0, -1, 0, 4);
  check(!!roof && !!roof.collider.parent()?.isFixed() && sim.vehicles.list.every((v) => roof.collider.parent()?.handle !== v.body.handle) && 3 - roof.distance > 0.8, 'a car left parked is solid scenery (a fixed body, not a vehicle)');
  const gasOk = sim.vehicles.list.every((v) => v.gas >= v.def.fuel[0] - 1e-9 && v.gas <= v.def.fuel[1] + 1e-9);
  check(gasOk, 'each tank holds what that kind of vehicle has left (never full)');
  const first = sim.vehicles.list.map((v) => v.gas);
  const again = fresh();
  check(again.vehicles.list.every((v, i) => Math.abs(v.gas - first[i]) < 1e-12), 'the same seed leaves the same fuel in every tank');
  const other = fresh(99);
  check(other.vehicles.list.some((v, i) => Math.abs(v.gas - first[i]) > 1e-6), 'another seed leaves different fuel');
  const v = other.vehicles.list[0];
  const down = physics.raycastHit(v.pos.x, 3, v.pos.z, 0, -1, 0, 4);
  check(!!down && down.collider.parent()?.handle === v.body.handle && down.surface === 'metal', 'a round fired down on a car hits its moving body (metal), not a static copy');
  const cab = v.pos.y + (v.def.low + v.def.cabin.top) / 2;
  const through = physics.raycastHit(v.pos.x - 3 * Math.sin(v.yaw), cab, v.pos.z - 3 * Math.cos(v.yaw), Math.sin(v.yaw), 0, Math.cos(v.yaw), 6);
  check(!through || through.collider.parent()?.handle !== v.body.handle, 'rounds and sight lines pass through the cabin (glass)');
  const n = nav.nodeAt(v.pos.x, v.pos.y, v.pos.z, 0.3);
  check(n < 0, 'the nav grid still treats each parked car as solid (zombies path round it)');
}

section('Getting in');
{
  const sim = fresh();
  const v = clearLane(sim, 30, 'car') ?? sim.vehicles.list[0];
  const a = sim.addPlayer('a', 'A', 'ar', 'pistol', v.pos, 0);
  const b = sim.addPlayer('b', 'B', 'ar', 'pistol', v.pos, 0);
  const c = sim.addPlayer('c', 'C', 'ar', 'pistol', v.pos, 0);
  c.motion.pos = { x: v.pos.x + 30, y: v.pos.y, z: v.pos.z + 30 };
  besideDoor(sim, a, v, -1);
  besideDoor(sim, b, v, 1);
  check(sim.vehicles.inReach(a)[0] === v, 'a car beside you is in reach');
  check(!sim.enterVehicle('c', v.id), 'nobody gets in from across the street');
  const ev: SimEvent[] = [];
  check(sim.enterVehicle('a', v.id), 'getting in by the door');
  ev.push(...sim.drain());
  check(v.seats[0] === 'a' && sim.vehicles.driven('a') === v, 'the first one in takes the wheel');
  check(ev.some((e) => e.type === 'vehicle' && e.stage === 'in' && e.seat === 0) && ev.some((e) => e.type === 'vehicle' && e.stage === 'crank'), 'heard: the door, then the starter');
  check(sim.switchWeapon('b', 'melee') && b.arsenal.meleeOut, 'b holds a melee weapon out before getting in');
  check(sim.enterVehicle('b', v.id) && v.seats[1] === 'b', 'the next one takes the free seat nearest them (passenger side)');
  check(!b.arsenal.meleeOut && !sim.switchWeapon('b', 'melee'), 'no room to swing in a seat: the melee weapon goes away for the gun, and stays away');
  const seat = seatWorld(v, 1);
  check(Math.hypot(b.motion.pos.x - seat.x, b.motion.pos.z - seat.z) < 0.01 && b.motion.eyeHeight === VEHICLE.seatEye, 'a passenger sits in their seat, eyes at seat height');
  check(!sim.enterVehicle('a', v.id), 'someone already in a seat can\'t get in again');
  run(sim, v.def.crank + 0.1, ev);
  check(v.engine && ev.some((e) => e.type === 'vehicle' && e.stage === 'start'), `the engine catches after the starter turns (${v.def.crank}s)`);
  check((v.input & DRIVE_FLAG.lights) !== 0, 'the headlights come on with the engine');
  check(sim.switchSeat('b') && v.seats[2] === 'b' && v.seats[1] === null, 'a passenger moves to the next free seat');
  check(sim.switchSeat('a') && v.seats[0] === null && !v.engine, 'the driver sliding over leaves nobody at the wheel: the engine stops');
  while (v.seats[0] !== 'b' && sim.switchSeat('b'));
  check(v.seats[0] === 'b' && v.crank > 0, 'whoever moves to the wheel turns the starter');
  const noises = sim.noises.length;
  run(sim, 1.2);
  check(sim.noises.length > 0 && noises >= 0, 'a running engine makes noise');
}

section('Driving');
{
  const sim = fresh();
  const v = clearLane(sim, 45, 'car');
  check(!!v, 'found a car with a clear road ahead');
  if (v) {
    const p = sim.addPlayer('d', 'D', 'ar', 'pistol', v.pos, 0);
    besideDoor(sim, p, v);
    check(v.body.isFixed(), 'parked, a car is a fixed body (it costs the physics step no more than a wall)');
    sim.enterVehicle('d', v.id);
    run(sim, v.def.crank + 0.1);
    const start = { ...v.pos };
    const gas0 = v.gas;
    const dr = driver(sim, p, v);
    dr.drive({ ...NONE, throttle: 1 }, 2.5);
    const fwd = (v.pos.x - start.x) * Math.cos(v.yaw) - (v.pos.z - start.z) * Math.sin(v.yaw);
    check(fwd > 12 && v.speed > 9, `the gas pulls it forward (${fwd.toFixed(1)} m in 2.5 s, ${v.speed.toFixed(1)} m/s)`);
    check(v.gas < gas0, `fuel burns as it goes (${((gas0 - v.gas) * 1000).toFixed(2)} ‰)`);
    const seat = seatWorld(v, 0);
    check(Math.hypot(p.motion.pos.x - seat.x, p.motion.pos.z - seat.z) < 0.05, 'the driver is carried along in their seat');
    check(Math.hypot(p.motion.vel.x - v.vel.x, p.motion.vel.z - v.vel.z) < 0.01, 'and moves with the car');
    const bt = v.body.translation();
    check(!v.body.isFixed() && Math.hypot(bt.x - v.pos.x, bt.z - v.pos.z) < 0.5, 'once it moves its collision body goes with it');
    let stopped = Infinity;
    for (let i = 0; i < 100; i++) {
      dr.drive({ ...NONE, brake: 1 }, DT);
      stopped = Math.min(stopped, Math.abs(v.speed));
      if (v.speed < 0) break;
    }
    check(stopped < 0.6, `the brakes stop it`);
    dr.drive({ ...NONE, brake: 1 }, 1.2);
    check(v.speed < -1.5, `holding the brake when stopped backs up (${v.speed.toFixed(1)} m/s)`);
    dr.drive({ ...NONE, throttle: 1 }, 1);
    dr.drive(NONE, 3);
    check(Math.abs(v.speed) < 3, 'off the pedals it slows by itself');
  }
  // Steering and top speed on a bare stretch of the map's own collision.
  const sim2 = fresh();
  const w = sim2.vehicles.list[0];
  void w;
  const b: DriveBody = { def: VEHICLES.car, pos: { x: 0, y: 0, z: 0 }, yaw: 0, speed: 0, vel: { x: 0, y: 0, z: 0 }, steer: 0, body: null };
  // A bare plain, nothing to hit: just the model.
  const lone = new Physics({ ...map, solids: [], props: [], doors: [], excavations: [], bounds: { x0: -3000, x1: 3000, z0: -3000, z1: 3000 } });
  const bb: DriveBody = { ...b, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
  for (let i = 0; i < 60 * 12; i++) driveStep(lone, bb, { ...NONE, throttle: 1 }, DT, true);
  check(bb.speed <= VEHICLES.car.top + 0.01 && bb.speed > VEHICLES.car.top * 0.85, `a car tops out near ${VEHICLES.car.top} m/s (${bb.speed.toFixed(1)})`);
  const tb: DriveBody = { ...b, def: VEHICLES.truck, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, speed: 0, yaw: 0 };
  for (let i = 0; i < 60 * 12; i++) driveStep(lone, tb, { ...NONE, throttle: 1 }, DT, true);
  check(tb.speed < bb.speed, `the armored truck is slower (${tb.speed.toFixed(1)} m/s)`);
  const sb: DriveBody = { ...b, pos: { x: 0, y: 0, z: 0 }, vel: { x: 8, y: 0, z: 0 }, speed: 8, yaw: 0 };
  for (let i = 0; i < 60; i++) driveStep(lone, sb, { ...NONE, throttle: 0.4, steer: 1 }, DT, true);
  check(sb.yaw < -0.5 && sb.pos.z > 1, `steering right turns it toward its right side (yaw ${sb.yaw.toFixed(2)}, z ${sb.pos.z.toFixed(1)})`);
  const dry: DriveBody = { ...b, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, speed: 0 };
  for (let i = 0; i < 60; i++) driveStep(lone, dry, { ...NONE, throttle: 1 }, DT, false);
  check(Math.abs(dry.speed) < 0.01, 'with the engine dead the gas pedal does nothing');
  lone.dispose();
}

section('Walls');
{
  const sim = fresh();
  const v = sim.vehicles.list.find((q) => q.kind === 'car')!;
  const p = sim.addPlayer('d', 'D', 'ar', 'pistol', v.pos, 0);
  besideDoor(sim, p, v);
  sim.enterVehicle('d', v.id);
  run(sim, v.def.crank + 0.1);
  // Aim it at the map's edge wall and floor it.
  const edge = map.bounds;
  v.pos.x = edge.x1 - 14;
  v.pos.z = (edge.z0 + edge.z1) / 2;
  v.yaw = 0;
  sim.vehicles.moveBody(v);
  physics.advance(DT);
  const hurt: SimEvent[] = [];
  const dr = driver(sim, p, v);
  dr.drive({ ...NONE, throttle: 1 }, 4, hurt);
  check(v.pos.x < edge.x1 - v.def.hx + 0.1, `it stops at the wall instead of going through (${(edge.x1 - v.pos.x).toFixed(2)} m from the edge)`);
  check(hurt.some((e) => e.type === 'vehicle' && e.stage === 'crash'), 'hitting it is heard as a crash');
  const health = p.health;
  // Going 21 m/s one moment, stopped dead the next.
  sim.drive('d', { vehicle: v.id, pos: { ...v.pos }, yaw: v.yaw, vel: { x: 21, y: 0, z: 0 }, speed: 21, steer: 0, input: 0, crash: 0 });
  sim.drive('d', { vehicle: v.id, pos: { ...v.pos }, yaw: v.yaw, vel: { x: 0, y: 0, z: 0 }, speed: 0, steer: 0, input: 0, crash: VEHICLE.crashHurt + 8 });
  check(p.health < health, `a hard crash hurts the people inside (${(health - p.health).toFixed(0)})`);
  sim.drive('d', { vehicle: v.id, pos: { ...v.pos }, yaw: v.yaw, vel: { x: 0, y: 0, z: 0 }, speed: 0, steer: 0, input: 0, crash: 500 });
  check(p.health > 0, 'a reported crash is capped by how fast the car was going');
}

section('Fuel');
{
  const sim = fresh();
  const v = clearLane(sim, 30, 'car')!;
  const p = sim.addPlayer('d', 'D', 'ar', 'pistol', v.pos, 0);
  besideDoor(sim, p, v);
  v.gas = 0.0004;
  sim.enterVehicle('d', v.id);
  const ev = run(sim, v.def.crank + 0.1);
  check(v.engine, 'a nearly dry tank still starts');
  const dr = driver(sim, p, v);
  dr.drive({ ...NONE, throttle: 1 }, 3, ev);
  check(!v.engine && v.gas === 0 && ev.some((e) => e.type === 'vehicle' && e.stage === 'empty'), 'it runs dry: the engine dies');
  const coasting = Math.abs(v.speed);
  dr.drive({ ...NONE, throttle: 1 }, 1.5);
  check(Math.abs(v.speed) < coasting, 'out of gas the pedal does nothing: it coasts down');
  sim.switchSeat('d');
  const ev2: SimEvent[] = [];
  sim.switchSeat('d');
  sim.switchSeat('d');
  sim.switchSeat('d');
  run(sim, v.def.crank + 0.3, ev2);
  check(v.seats[0] === 'd' && !v.engine && ev2.some((e) => e.type === 'vehicle' && e.stage === 'dry'), 'a dry tank cranks but won\'t start');
}

/** Which side of a vehicle a point is: -1 the driver's, +1 the passenger's. */
const sideOf = (v: Vehicle, at: Vec3 | null) => (at ? Math.sign((at.x - v.pos.x) * Math.sin(v.yaw) + (at.z - v.pos.z) * Math.cos(v.yaw)) : 0);

section('Getting out');
{
  const sim = fresh();
  // Parked (and stopping) with the driver's door to the curb.
  const v = clearLane(sim, 40, 'car')!;
  const p = sim.addPlayer('d', 'D', 'ar', 'pistol', v.pos, 0);
  const q = sim.addPlayer('e', 'E', 'ar', 'pistol', v.pos, 0);
  besideDoor(sim, p, v);
  besideDoor(sim, q, v, 1);
  sim.enterVehicle('d', v.id);
  sim.enterVehicle('e', v.id);
  run(sim, v.def.crank + 0.1);
  const dr = driver(sim, p, v);
  dr.drive({ ...NONE, throttle: 1 }, 1.5);
  check(!sim.exitVehicle('d') && !sim.exitVehicle('e'), `nobody gets out at ${v.speed.toFixed(0)} m/s`);
  for (let i = 0; i < 120 && v.speed > 0.2; i++) dr.drive({ ...NONE, brake: 1 }, DT);
  dr.drive(NONE, 0.3);
  const ev: SimEvent[] = [];
  check(sim.exitVehicle('d'), `out once it has stopped (${v.speed.toFixed(2)} m/s)`);
  ev.push(...sim.drain());
  const out = ev.find((e) => e.type === 'vehicle' && e.stage === 'out');
  check(!!out && !!out.pos && outsideBy(v, out.pos.x, out.pos.z) > 0.3, 'they stand clear of the bodywork');
  check(sideOf(v, out?.pos ?? null) === -1, 'by the driver\'s door, up on the curb beside it');
  check(!sim.vehicles.seatOf('d') && p.motion.eyeHeight > 1.4 && !v.engine, 'on their feet again, and the engine is off');
  check(sim.enterVehicle('e', v.id) === false && sim.vehicles.seatOf('e')?.[1] === 1, 'the passenger stays put');
  // Down in a seat: thrown out.
  besideDoor(sim, p, v);
  sim.enterVehicle('d', v.id);
  const ev2: SimEvent[] = [];
  sim.damagePlayer(q, 500, q.motion.pos);
  ev2.push(...sim.drain());
  check(!sim.vehicles.seatOf('e') && ev2.some((e) => e.type === 'vehicle' && e.stage === 'thrown' && e.player === 'e'), 'going down (or dying) in a seat throws them out');
  sim.removePlayer('d');
  check(v.seats.every((s) => s === null), 'leaving the game empties their seat');
}

section('The dead in the road');
{
  const sim = fresh();
  const v = clearLane(sim, 45, 'car')!;
  const p = sim.addPlayer('d', 'D', 'ar', 'pistol', v.pos, 0);
  besideDoor(sim, p, v);
  sim.enterVehicle('d', v.id);
  run(sim, v.def.crank + 0.1);
  const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
  const z = sim.spawnZombie('walker', { x: v.pos.x + c * 24, y: v.pos.y + 0.02, z: v.pos.z - s * 24 }, 'idle');
  run(sim, 0.1);
  const ev: SimEvent[] = [];
  const dr = driver(sim, p, v);
  dr.drive({ ...NONE, throttle: 1 }, 3, ev);
  const hit = ev.find((e) => e.type === 'zombieHit' && e.zombie === z.id);
  check(!z.alive && hit?.type === 'zombieHit' && hit.vehicle === v.id && hit.by === 'd', 'running one down at speed kills it, credited to the driver');
  check(p.stats.kills === 1, 'the kill counts for the driver');
  const died = ev.find((e) => e.type === 'zombieDied' && e.zombie === z.id);
  check(!!died && died.type === 'zombieDied' && died.force > 2, 'the body is thrown');
  dr.drive({ ...NONE, brake: 1 }, 2.5);
  // Creeping into one: shoved aside, not hurt, not left inside the car.
  const front = { x: v.pos.x + c * (v.def.hx + 1.2), y: v.pos.y + 0.02, z: v.pos.z - s * (v.def.hx + 1.2) };
  const brute = sim.spawnZombie('brute', front, 'idle');
  run(sim, 0.1);
  const hp = brute.health;
  dr.drive({ ...NONE, throttle: 0.25 }, 1.2);
  dr.drive({ ...NONE, brake: 1 }, 0.5);
  check(brute.alive && brute.health === hp, 'creeping into one only shoves it');
  check(outsideBy(v, brute.pos.x, brute.pos.z) > -0.01 && outsideBy({ ...v, def: { ...v.def, hx: v.def.hx - 0.05, hz: v.def.hz - 0.05 } }, brute.pos.x, brute.pos.z) > 0, 'and never leaves it standing in the bodywork');
}

section('Fighting from a seat');
{
  const sim = fresh();
  const v = clearLane(sim, 30, 'car')!;
  const d = sim.addPlayer('d', 'D', 'ar', 'pistol', v.pos, 0);
  const g = sim.addPlayer('g', 'G', 'ar', 'pistol', v.pos, 0);
  besideDoor(sim, d, v, -1);
  besideDoor(sim, g, v, 1);
  sim.enterVehicle('d', v.id);
  sim.enterVehicle('g', v.id);
  sim.skipPreparation();
  run(sim, 1.5);
  // A zombie off the passenger side.
  const sx = Math.sin(v.yaw), sz = Math.cos(v.yaw);
  const z = sim.spawnZombie('walker', { x: v.pos.x + sx * 6, y: v.pos.y + 0.02, z: v.pos.z + sz * 6 }, 'idle');
  run(sim, 0.1);
  const eye = g.eye;
  const aim = { x: z.chest.x - eye.x, y: z.chest.y - eye.y, z: z.chest.z - eye.z };
  const L = Math.hypot(aim.x, aim.y, aim.z);
  const ev: SimEvent[] = [];
  check(sim.fire('d', d.eye, aim, true, 7) === 'busy', 'the driver can\'t shoot (hands on the wheel)');
  const before = z.health;
  // From the camera behind the passenger (as the client aims): the car's own body doesn't stop it.
  const cam = { x: eye.x - (aim.x / L) * 2.5, y: eye.y + 0.4, z: eye.z - (aim.z / L) * 2.5 };
  const cd = { x: z.chest.x - cam.x, y: z.chest.y - cam.y, z: z.chest.z - cam.z };
  check(sim.fire('g', cam, cd, true, 7) === 'fired', 'a passenger shoots out of the window');
  ev.push(...sim.drain());
  check(z.health < before || !z.alive, 'and hits the zombie outside (their own car\'s body doesn\'t stop the round)');
  check(!sim.melee('g') && !sim.throwItem('g', 'frag', { origin: eye, dir: aim }), 'no swinging or throwing from a seat');
  // Claws through the window.
  const hp = g.health;
  const claw = sim.spawnZombie('walker', { x: v.pos.x + sx * (v.def.hz + 0.35), y: v.pos.y + 0.02, z: v.pos.z + sz * (v.def.hz + 0.35) }, 'idle');
  claw.summon(g);
  run(sim, 3);
  check(g.health < hp, `a zombie at the window claws the passenger (${(hp - g.health).toFixed(0)})`);
  check(claw.alive, '(it is still there)');
}

section('Spawns');
{
  const sim = fresh();
  sim.addPlayer('d', 'D', 'ar', 'pistol', map.playerSpawns[0], 0);
  sim.skipPreparation();
  run(sim, 0.1);
  let inCar = 0;
  for (let i = 0; i < 300; i++) {
    const at = sim.findSpawnPoint(10, 120);
    if (at && sim.vehicles.inside(at.x, at.z, 0.3)) inCar++;
  }
  check(inCar === 0, 'zombies never spawn inside a car');
}

section('Over the wire');
{
  const sim = fresh(23);
  const v = clearLane(sim, 30, 'car')!;
  const p = sim.addPlayer('d', 'D', 'ar', 'pistol', v.pos, 0);
  const q = sim.addPlayer('e', 'E', 'ar', 'pistol', v.pos, 0);
  besideDoor(sim, p, v);
  besideDoor(sim, q, v, 1);
  const snap0 = captureSnapshot(sim, new Map());
  check(!snap0.vh, 'nothing to send while every vehicle is as the map leaves it');
  sim.enterVehicle('d', v.id);
  sim.enterVehicle('e', v.id);
  run(sim, v.def.crank + 0.1);
  const dr = driver(sim, p, v);
  dr.drive({ ...NONE, throttle: 1 }, 1);
  const snap = captureSnapshot(sim, new Map());
  const row = snap.vh?.find((x) => x[0] === v.id);
  check(!!row && snap.vh!.length === 1, 'a vehicle in use is sent (only that one)');
  check(!!row && row[11] === 'd' && row[12] === 'e' && row[13] === 0, 'with who sits where');
  check(!!row && ((row[10] as number) & DRIVE_FLAG.engine) !== 0 && Math.abs((row[9] as number) / 1000 - v.gas) < 0.001, 'the engine running and the fuel left');
  // A client's copy (the passenger's).
  const copy = new Simulation({ physics, map, nav, doors, seed: 23, preparation: 600 });
  const mirror = new Mirror(copy, 'e');
  mirror.apply(snap, 10);
  const cv = copy.vehicles.vehicle(v.id)!;
  check(cv.seats[0] === 'd' && cv.seats[1] === 'e' && copy.vehicles.seatOf('e')?.[1] === 1, 'the copy knows who sits where');
  check(Math.hypot(cv.pos.x - v.pos.x, cv.pos.z - v.pos.z) < 0.02 && Math.abs(cv.yaw - v.yaw) < 0.002 && cv.engine, 'and where the car is, its engine running');
  check(copy.vehicles.list.every((x, i) => x.id === v.id || Math.abs(x.gas - sim.vehicles.list[i].gas) < 1e-12), 'cars nobody touched have the same fuel on both (from the seed)');
  const at = { x: 0, y: 0, z: 0 };
  check(mirror.vehiclePose(v.id, at) !== null, 'a car someone else drives glides between snapshots');
  const own = new Simulation({ physics, map, nav, doors, seed: 23, preparation: 600 });
  const m2 = new Mirror(own, 'd');
  m2.apply(snap, 10);
  check(m2.vehiclePose(v.id, at) === null, 'the driver\'s own copy moves its car itself');
  copy.dispose();
  own.dispose();
  const packed = packDrive({ vehicle: 3, pos: { x: 12.345, y: 0.15, z: -40.5 }, yaw: 7, vel: { x: 3, y: 0, z: -4 }, speed: 5, steer: 0.3, input: DRIVE_FLAG.throttle | DRIVE_FLAG.lights, crash: 2 });
  const back = unpackDrive(packed);
  check(!!back && back.vehicle === 3 && Math.abs(back.pos.x - 12.345) < 0.001 && Math.abs(back.yaw - (7 - Math.PI * 2)) < 0.002 && back.input === (DRIVE_FLAG.throttle | DRIVE_FLAG.lights) && Math.abs(back.crash - 2) < 0.01, 'a drive message reads back as sent');
  check(unpackDrive([1, 2, 3]) === null && unpackDrive([...packed.slice(0, 10), NaN]) === null && unpackDrive([-1, ...packed.slice(1)]) === null, 'malformed drive messages are refused');
  const ev: SimEvent[] = [];
  check(!sim.drive('e', { ...back!, vehicle: v.id }), 'a passenger can\'t drive');
  void ev;
}

for (const s of sims) s.dispose();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
