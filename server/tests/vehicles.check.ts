/**
 * Vehicles on the server, without the network: getting in (the driver's seat first, then the
 * others), the engine starting, the driver's browser moving the car (as fast as that car goes and
 * no faster, never through a wall, a refused move putting it back), passengers carried along and
 * their own moves ignored, snapshots showing where each car is and who sits where, getting out
 * (not at speed; the server's exit spot then holds), seat changes, crashes, and a survivor who
 * leaves the game emptying their seat.
 * Run with `npx tsx server/tests/vehicles.check.ts` (part of `npm run check:vehicles`).
 */
import {
  GROUP, VEHICLE, groups, packDrive, packMotion, seatWorld, type DriveState, type SimEvent, type Snapshot, type Vec3, type Vehicle,
} from '@dead-hours/shared';
import { Night } from '../src/game/Night';
import { initWorld } from '../src/game/world';

let failures = 0;
let passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n${s}`);

await initWorld();
const night = new Night(11, 0);
const sim = night.sim;
night.addSurvivor({ id: 'p0', name: 'Driver', primary: 'ar', appearance: '' }, 0);
night.addSurvivor({ id: 'p1', name: 'Rider', primary: 'ar', appearance: '' }, 1);
night.addSurvivor({ id: 'p2', name: 'Walker', primary: 'ar', appearance: '' }, 2);
const events: SimEvent[] = [];
let snap: Snapshot | null = null;
const advance = (seconds: number) => {
  for (let t = 0; t < seconds - 1e-6; t += 1 / 60) {
    const r = night.advance(1 / 60);
    events.push(...r.events);
    if (r.snapshot) snap = r.snapshot;
  }
};
advance(0.1);

const motionOf = (pos: Vec3) => packMotion({
  motion: { pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 1.6, crouching: false, sprinting: false, aiming: false, grounded: true },
  facing: 0, trigger: false, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: 0, y: 0, z: 1 },
});
/** Puts a survivor somewhere (as if they had walked there). */
const put = (id: string, pos: Vec3) => {
  const p = sim.players.get(id)!;
  sim.setMotion(id, { ...p.motion, pos: { ...pos }, vel: { x: 0, y: 0, z: 0 } });
  advance(0.5);
};
const WALLS = groups(0xffff, GROUP.static);
const bounds = sim.map.bounds;
const forward = (v: { yaw: number }) => ({ x: Math.cos(v.yaw), z: -Math.sin(v.yaw) });
/** Clear road ahead of a car's nose (m), as far as `max`. */
const clearAhead = (v: Vehicle, max: number) => {
  const f = forward(v);
  const from = { x: v.pos.x + f.x * (v.def.hx + 0.2), z: v.pos.z + f.z * (v.def.hx + 0.2) };
  let d = max;
  for (const side of [-v.def.hz + 0.1, 0, v.def.hz - 0.1]) {
    const ox = from.x + Math.sin(v.yaw) * side, oz = from.z + Math.cos(v.yaw) * side;
    const hit = night.physics.raycast(ox, v.pos.y + 0.6, oz, f.x, 0, f.z, max, groups(0xffff, GROUP.static | GROUP.dynamic | GROUP.vehicle));
    if (hit !== null) d = Math.min(d, hit);
  }
  const end = { x: from.x + f.x * d, z: from.z + f.z * d };
  if (end.x < bounds.x0 + 3 || end.x > bounds.x1 - 3 || end.z < bounds.z0 + 3 || end.z > bounds.z1 - 3) return 0;
  return d;
};

// A family car with a long clear stretch of road ahead of it.
const LANE = 26;
const car = sim.vehicles.list.find((v) => v.kind === 'car' && clearAhead(v, LANE + 4) >= LANE + 4);
section('Getting in');
check(!!car, `a car with ${LANE} m of clear road ahead of it`);
if (!car) {
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(1);
}
const home = { ...car.pos };
const yaw = car.yaw;
const side = (k: number) => ({ x: home.x + Math.sin(yaw) * k, y: home.y, z: home.z + Math.cos(yaw) * k });
put('p0', side(-(car.def.hz + 0.8)));
put('p1', side(car.def.hz + 0.8));
put('p2', side(car.def.hz + 12));
night.act('p2', { a: 'seat', v: car.id });
check(!sim.vehicles.seatOf('p2'), 'from 12 m away, no getting in');
events.length = 0;
night.act('p0', { a: 'seat', v: car.id });
check(car.seats[0] === 'p0', 'the first one in takes the wheel');
night.act('p1', { a: 'seat', v: car.id });
const p1Seat = sim.vehicles.seatOf('p1')?.[1] ?? -1;
check(p1Seat > 0, `the next one takes a passenger seat (seat ${p1Seat})`);
advance(car.def.crank + 0.2);
check(events.some((e) => e.type === 'vehicle' && e.stage === 'in' && e.player === 'p0') && events.some((e) => e.type === 'vehicle' && e.stage === 'crank'), 'everyone hears the doors and the starter');
check(car.engine && events.some((e) => e.type === 'vehicle' && e.stage === 'start'), `the engine catches (gas ${(car.gas * 100).toFixed(0)}%)`);
const sat = seatWorld(car, 0);
const p0 = sim.players.get('p0')!, p1 = sim.players.get('p1')!;
check(Math.hypot(p0.motion.pos.x - sat.x, p0.motion.pos.z - sat.z) < 0.01 && Math.abs(p0.motion.eyeHeight - VEHICLE.seatEye) < 1e-6, 'the driver sits in the driver\'s seat');
check(night.motion('p0', motionOf({ x: home.x + 40, y: home.y, z: home.z })) === null, 'a seated survivor\'s own move is not refused...');
advance(1 / 30);
check(Math.hypot(p0.motion.pos.x - sat.x, p0.motion.pos.z - sat.z) < 0.01, '...and doesn\'t move them out of the seat');

section('Driving');
const f = forward(car);
const drive = (id: string, at: number, speed: number, extra: Partial<DriveState> = {}) => night.drive(id, packDrive({
  vehicle: car.id, pos: { x: home.x + f.x * at, y: home.y, z: home.z + f.z * at }, yaw, vel: { x: f.x * speed, y: 0, z: f.z * speed },
  speed, steer: 0, input: 1 | 16, crash: 0, ...extra,
}));
const gas0 = car.gas;
let refused = 0;
const speed = car.def.top * 0.9;
let along = 0;
for (let i = 1; i <= 30; i++) {
  along = Math.min(LANE, (speed * i) / 30);
  if (drive('p0', along, speed)) refused++;
  advance(1 / 30);
}
check(refused === 0, `driving down the road at ${speed.toFixed(1)} m/s (${along.toFixed(0)} m) is accepted (${refused} refused)`);
check(Math.hypot(car.pos.x - (home.x + f.x * along), car.pos.z - (home.z + f.z * along)) < 0.01, 'the server has the car where the driver put it');
check(car.gas < gas0, `it burned gas (${(gas0 * 100).toFixed(2)}% → ${(car.gas * 100).toFixed(2)}%)`);
const ps = seatWorld(car, p1Seat);
check(Math.hypot(p1.motion.pos.x - ps.x, p1.motion.pos.z - ps.z) < 0.01, 'the passenger is carried along in their seat');
check(drive('p1', along, 0) === null && Math.hypot(car.pos.x - (home.x + f.x * along), car.pos.z - (home.z + f.z * along)) < 0.01, 'a passenger can\'t drive it');
advance(0.15);
const row = (snap as Snapshot | null)?.vh?.find((r) => r[0] === car.id);
check(!!row && Math.abs((row[1] as number) / 100 - car.pos.x) < 0.02 && row[11] === 'p0' && row.slice(11).includes('p1'), 'snapshots show where it is and who sits where');

section('Refused');
const at = along;
// Further in one go than this car could have come since the last report (its whole allowance is ~26 m).
const bad = drive('p0', at - 27, 30);
check(!!bad, '27 m back down the road in one report is refused');
const back = bad ? { x: bad[1] / 100, z: bad[3] / 100 } : { x: 0, z: 0 };
check(car.speed === 0 && Math.hypot(car.pos.x - back.x, car.pos.z - back.z) < 0.02, 'and the car is put back where it was last accepted, stopped');
check(drive('p0', at - 20, 0) === null && Math.hypot(car.pos.x - back.x, car.pos.z - back.z) < 0.02, 'reports sent before the driver heard are dropped');
const backAt = Math.hypot(back.x - home.x, back.z - home.z);
check(drive('p0', backAt, 0) === null, 'from where it was put back, driving goes on');
advance(0.5);
// Through a wall: somewhere a wall stands within 15 m of the car, report it on the far side.
let wall = -1, wallDir = 0;
for (let k = 0; k < 64 && wall < 0; k++) {
  const a = (k / 64) * Math.PI * 2;
  const hit = night.physics.raycast(car.pos.x, car.pos.y + car.def.low * 0.6, car.pos.z, Math.sin(a), 0, Math.cos(a), 12, WALLS);
  if (hit !== null && hit > 3) {
    wall = hit;
    wallDir = a;
  }
}
check(wall > 0, `a wall ${wall.toFixed(1)} m from the car`);
const before = { ...car.pos };
const through = night.drive('p0', packDrive({
  vehicle: car.id, pos: { x: before.x + Math.sin(wallDir) * (wall + 1.5), y: before.y, z: before.z + Math.cos(wallDir) * (wall + 1.5) }, yaw,
  vel: { x: 0, y: 0, z: 0 }, speed: 0, steer: 0, input: 0, crash: 0,
}));
check(!!through && Math.hypot(car.pos.x - before.x, car.pos.z - before.z) < 0.02, 'a move through the wall is refused');
check(night.drive('p0', [1, 2, 3]) === null && night.drive('p0', 'go') === null, 'garbage is ignored');

section('Getting out');
// Back where it was accepted, then rolling fast.
drive('p0', backAt, 0);
advance(2.1);
drive('p0', backAt, 0);
advance(0.2);
car.speed = VEHICLE.exitSpeed + 2;
night.act('p0', { a: 'seat', v: -1 });
check(car.seats[0] === 'p0', `nobody gets out at ${(VEHICLE.exitSpeed + 2).toFixed(0)} m/s`);
drive('p0', backAt, 0);
events.length = 0;
night.act('p0', { a: 'seat', v: -1 });
check(car.seats[0] === null && !sim.vehicles.seatOf('p0'), 'stopped, the driver gets out');
advance(1 / 60);
const out = events.find((e) => e.type === 'vehicle' && e.stage === 'out' && e.player === 'p0');
const spot = out && out.type === 'vehicle' ? out.pos : null;
check(!!spot && Math.hypot(p0.motion.pos.x - spot.x, p0.motion.pos.z - spot.z) < 0.05, 'standing at the spot every client is told');
check(night.motion('p0', motionOf(sat)) === null && !!spot && Math.hypot(p0.motion.pos.x - spot.x, p0.motion.pos.z - spot.z) < 0.05, 'a move from back in the seat (sent before the client heard) is dropped');
check(spot ? night.motion('p0', motionOf(spot)) === null : false, 'from the exit spot, walking goes on');
check(!car.engine, 'nobody at the wheel: the engine stops');

section('Seats');
night.act('p1', { a: 'seat', v: car.id, s: -1 });
const moved = sim.vehicles.seatOf('p1')?.[1] ?? -1;
check(moved >= 0 && moved !== p1Seat, `the passenger moves over (seat ${p1Seat} → ${moved})`);
for (let i = 0; i < 4 && sim.vehicles.seatOf('p1')?.[1] !== 0; i++) night.act('p1', { a: 'seat', v: car.id, s: -1 });
check(car.seats[0] === 'p1', 'round to the wheel, which turns the engine over');
advance(car.def.crank + 0.2);
check(car.engine, 'and it starts again');
check(night.drive('p0', packDrive({ vehicle: car.id, pos: car.pos, yaw: car.yaw, vel: { x: 0, y: 0, z: 0 }, speed: 0, steer: 0, input: 0, crash: 0 })) === null && car.seats[0] === 'p1', 'the one who got out can\'t drive it any more');

section('Crashes');
const hp = p1.health;
events.length = 0;
const pos = { ...car.pos };
night.drive('p1', packDrive({ vehicle: car.id, pos, yaw: car.yaw, vel: { x: 0, y: 0, z: 0 }, speed: 0, steer: 0, input: 0, crash: 2 }));
check(p1.health === hp, 'a bump at walking pace hurts nobody');
car.speed = 22;
night.drive('p1', packDrive({ vehicle: car.id, pos, yaw: car.yaw, vel: { x: 0, y: 0, z: 0 }, speed: 0, steer: 0, input: 0, crash: 22 }));
advance(1 / 60);
check(p1.health < hp, `a wall at 22 m/s hurts the people inside (${hp} → ${p1.health})`);
check(events.some((e) => e.type === 'vehicle' && e.stage === 'crash'), 'and is heard');

section('One car, then another');
{
  const p2 = sim.players.get('p2')!;
  const free = sim.vehicles.list.filter((v) => v !== car && v.kind === 'car' && v.seats.every((s) => s === null) && sim.vehicles.exitSpot(v, 0));
  const a = free[0];
  const b = free.find((v) => Math.hypot(v.pos.x - a.pos.x, v.pos.z - a.pos.z) > 8);
  check(!!a && !!b, 'two more cars apart, each with a clear driver\'s door');
  /** Walks up to a car's driver door, gets in, gets out: where the server says they stand. */
  const ride = (v: Vehicle): Vec3 | null => {
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw), lz = -(v.def.hz + 0.6);
    put('p2', { x: v.pos.x + 0.1 * c + lz * s, y: v.pos.y, z: v.pos.z - 0.1 * s + lz * c });
    night.act('p2', { a: 'seat', v: v.id });
    advance(0.2);
    if (sim.vehicles.seatOf('p2')?.[0] !== v) return null;
    events.length = 0;
    night.act('p2', { a: 'seat', v: -1 });
    advance(1 / 60);
    const e = events.find((x) => x.type === 'vehicle' && x.stage === 'out' && x.player === 'p2');
    return e && e.type === 'vehicle' && e.pos ? e.pos : null;
  };
  if (a && b) {
    const atA = ride(a);
    check(!!atA && Math.hypot(p2.motion.pos.x - atA.x, p2.motion.pos.z - atA.z) < 0.05, 'out of the first car, by its door');
    check(!!atA && night.motion('p2', motionOf(atA)) === null, 'walking on from there');
    const atB = ride(b);
    check(!!atB && Math.hypot(p2.motion.pos.x - atB.x, p2.motion.pos.z - atB.z) < 0.05, 'out of the second car, by its door');
    check(!!atA && !!atB && Math.hypot(atA.x - atB.x, atA.z - atB.z) > 5, 'which is not the first car\'s door');
    check(!!atB && night.motion('p2', motionOf(atB)) === null, 'walking on from the second car\'s door (the server holds that spot, not the first)');
    check(a.seats.every((s) => s === null) && b.seats.every((s) => s === null) && !sim.vehicles.seatOf('p2'), 'both cars empty');
  }
}

section('Leaving the game');
night.removeSurvivor('p1');
check(car.seats.every((s) => s === null) && !car.engine, 'a survivor who leaves empties their seat');

night.dispose();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
