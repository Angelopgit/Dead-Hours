/**
 * Bicycles on the server, without the network: a rider may go faster than anyone runs or skates
 * (and no faster than a bike goes), the allowance ends soon after they get off, the rider's
 * trigger rings the bell instead of firing, a passenger on the pegs is carried wherever the rider
 * goes (whatever their own browser says about where they are) and shoots from there, getting off
 * the pegs puts them down where their browser stepped down, snapshots show who is on which bike,
 * and a hard hit knocks people off.
 * Run with `npx tsx server/tests/bike.check.ts` (part of `npm run check:bike`).
 */
import { BICYCLE, GROUP, PLAYER, SKATEBOARD, groups, packMotion, type SimEvent, type Snapshot, type Vec3 } from '@dead-hours/shared';
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
const night = new Night(5, 0);
const sim = night.sim;
const unlocks = { level: 1, entitlements: [] };
night.addSurvivor({ id: 'p0', name: 'Rider', primary: 'ar', appearance: '', builds: {}, unlocks }, 0);
night.addSurvivor({ id: 'p1', name: 'Pegs', primary: 'ar', appearance: '', builds: {}, unlocks }, 1);
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

const motionOf = (pos: Vec3, vel: Vec3, bike?: number, trigger = false, aim?: Vec3) => packMotion({
  motion: { pos, vel, yaw: 0, pitch: 0, eyeHeight: 1.6, crouching: false, sprinting: true, aiming: false, grounded: true, bike, pushing: bike !== undefined },
  facing: 0, trigger, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: aim ?? { x: 0, y: 0, z: 1 },
});
const put = (id: string, pos: Vec3) => {
  const p = sim.players.get(id)!;
  sim.setMotion(id, { ...p.motion, pos: { ...pos }, vel: { x: 0, y: 0, z: 0 } });
  advance(1);
};
const LANE = 30;
const run = (id: string, from: Vec3, dir: number, speed: number, seconds: number, riding = false) => {
  let refused = 0;
  const dx = Math.sin(dir), dz = Math.cos(dir);
  for (let i = 1; i <= Math.round(seconds * 30); i++) {
    const d = (speed * i) / 30;
    const leg = Math.floor(d / LANE), along = leg % 2 ? LANE - (d % LANE) : d % LANE;
    const back = leg % 2 ? -1 : 1;
    const pos = { x: from.x + dx * along, y: from.y, z: from.z + dz * along };
    const heading = back > 0 ? dir : dir + Math.PI;
    if (night.motion(id, motionOf(pos, { x: dx * speed * back, y: 0, z: dz * speed * back }, riding ? heading : undefined))) refused++;
    advance(1 / 30);
  }
  return refused;
};

const bike = sim.bicycles.bikes[0];
const WALLS = groups(0xffff, GROUP.static);
const b = sim.map.bounds;
let dir = -1;
for (let k = 0; k < 32 && dir < 0; k++) {
  const a = (k / 32) * Math.PI * 2;
  const end = { x: bike.pos.x + Math.sin(a) * (LANE + 2), z: bike.pos.z + Math.cos(a) * (LANE + 2) };
  if (end.x < b.x0 + 2 || end.x > b.x1 - 2 || end.z < b.z0 + 2 || end.z > b.z1 - 2) continue;
  if (night.physics.raycast(bike.pos.x, bike.pos.y + 0.9, bike.pos.z, Math.sin(a), 0, Math.cos(a), LANE + 2, WALLS) === null) dir = a;
}
const start = { ...bike.pos };
const fast = BICYCLE.sprintTop;
const MAX_FOOT = PLAYER.sprintSpeed * 1.25;
const MAX_BOARD = SKATEBOARD.maxSpeed * 1.25;

section('Speed checks');
check(dir >= 0, `a clear ${LANE} m lane from the safehouse bike (heading ${dir.toFixed(2)})`);
check(fast > MAX_FOOT, `a bike stood up on the pedals (${fast} m/s) outruns the fastest feet the server allows (${MAX_FOOT.toFixed(2)} m/s)`);
put('p1', start);
check(run('p1', start, dir, fast, 6) > 0, 'on foot, that speed is refused');
put('p1', { x: start.x + 4, y: start.y, z: start.z });
put('p0', start);
check(!night.motion('p0', motionOf(start, { x: 0, y: 0, z: 0 })), 'the rider stands by the bike');
night.act('p0', { a: 'bike', id: bike.id, seat: 'rider' });
check(bike.rider === 'p0', 'picks it up');
advance(1 / 60);
check(events.some((e) => e.type === 'bike' && e.player === 'p0' && e.stage === 'on' && e.seat === 'rider'), 'everyone hears about it');
night.act('p1', { a: 'bike', id: bike.id, seat: 'rider' });
check(bike.rider === 'p0', 'someone else asking for the saddle doesn\'t get it');
const RIDE = 10;
const refused = run('p0', start, dir, BICYCLE.maxSpeed, RIDE, true);
check(refused === 0, `riding flat out (${BICYCLE.maxSpeed} m/s, past a skateboard's ${SKATEBOARD.maxSpeed}) for ${RIDE} s is accepted (${refused} refused)`);
const p0 = sim.players.get('p0')!;
const heading = Math.floor((BICYCLE.maxSpeed * RIDE) / LANE) % 2 ? dir + Math.PI : dir;
const turned = Math.abs(Math.atan2(Math.sin(bike.yaw - heading), Math.cos(bike.yaw - heading)));
check(Math.abs(bike.pos.x - p0.motion.pos.x) < 0.01 && turned < 0.01, 'the bike is under them, pointing the way they ride');
advance(0.1);
const row = (snap as Snapshot | null)?.bk?.find((r) => r[0] === bike.id);
check(!!row && row[5] === 'p0', 'snapshots show who rides it');
put('p0', start);
check(run('p0', start, dir, BICYCLE.maxSpeed * 1.6, 6, true) > 0, `even on a bike, ${(BICYCLE.maxSpeed * 1.6).toFixed(0)} m/s is refused`);
check(BICYCLE.maxSpeed * 1.25 > MAX_BOARD, 'the bike allowance is above the skateboard\'s');

section('The rider\'s hands');
put('p0', start);
sim.skipPreparation();
advance(1);
const mag = p0.arsenal.weapon.mag;
const shots = () => events.filter((e) => e.type === 'shot' && e.player === 'p0').length;
const before = shots();
night.act('p0', { a: 'fire', o: p0.eye, d: { x: 0, y: 0, z: 1 } });
night.motion('p0', motionOf(start, { x: 0, y: 0, z: 0 }, dir, true));
advance(0.5);
check(shots() === before && p0.arsenal.weapon.mag === mag, 'pulling the trigger on the bars fires nothing');
events.length = 0;
night.act('p0', { a: 'bell' });
advance(1 / 60);
check(events.some((e) => e.type === 'bike' && e.stage === 'bell' && e.player === 'p0'), 'the bell rings for everyone');
night.act('p0', { a: 'reload' });
check(p0.arsenal.action !== 'reload', 'no reloading on the bars');
night.motion('p0', motionOf(start, { x: 0, y: 0, z: 0 }, dir, false));

section('Two on a bike');
put('p1', { x: start.x + 1.2, y: start.y, z: start.z });
night.motion('p1', motionOf({ x: start.x + 1.2, y: start.y, z: start.z }, { x: 0, y: 0, z: 0 }));
night.act('p1', { a: 'bike', id: bike.id, seat: 'peg' });
check(bike.passenger === 'p1', 'the other survivor hops on the pegs');
const p1 = sim.players.get('p1')!;
// The rider rides off; the passenger's browser keeps saying it is somewhere else entirely.
let pegRefused = 0, onPegs = true, carried = 0;
const dx = Math.sin(dir), dz = Math.cos(dir);
for (let i = 1; i <= 90; i++) {
  const d = (10 * i) / 30;
  const pos = { x: start.x + dx * d, y: start.y, z: start.z + dz * d };
  night.motion('p0', motionOf(pos, { x: dx * 10, y: 0, z: dz * 10 }, dir));
  if (night.motion('p1', motionOf({ x: start.x - 50, y: start.y, z: start.z - 50 }, { x: 0, y: 0, z: 0 }, undefined, false, { x: -dx, y: 0, z: -dz }))) pegRefused++;
  advance(1 / 30);
  const pg = sim.bicycles.pegs(bike);
  if (Math.hypot(p1.motion.pos.x - pg.x, p1.motion.pos.z - pg.z) > 0.01) onPegs = false;
  carried = Math.hypot(p1.motion.pos.x - start.x, p1.motion.pos.z - start.z);
}
check(pegRefused === 0, 'the passenger\'s own moves are never refused while on the pegs');
check(onPegs, 'the server keeps them on the pegs the whole way');
check(carried > 25, `carried ${carried.toFixed(1)} m down the street`);
check(Math.abs(p1.motion.yaw) < 1e-6 && Math.abs(night['extras'].get('p1')!.aimD.x + dx) < 1e-3, 'how they look and aim is still theirs');
// Shooting backwards from the pegs.
const p1Shots = () => events.filter((e) => e.type === 'shot' && e.player === 'p1').length;
const s0 = p1Shots();
const eye = p1.eye;
night.act('p1', { a: 'fire', o: eye, d: { x: -dx, y: 0, z: -dz } });
advance(0.3);
check(p1Shots() > s0, 'and they shoot from the pegs');
const shot = events.filter((e): e is Extract<SimEvent, { type: 'shot' }> => e.type === 'shot' && e.player === 'p1').pop();
check(!!shot && Math.hypot(shot.origin.x - eye.x, shot.origin.z - eye.z) < 0.5, 'from where the server has them on the bike');
// Off the pegs a little way from where the server had them (their browser draws the bike a moment behind).
const pg = sim.bicycles.pegs(bike);
const lx = dz, lz = -dx;
const step = { x: pg.x - dx * 1.2 + lx * 0.6, y: start.y, z: pg.z - dz * 1.2 + lz * 0.6 };
night.act('p1', { a: 'bike', id: -1, at: step });
check(bike.passenger === null, 'hops off the pegs');
check(Math.hypot(p1.motion.pos.x - step.x, p1.motion.pos.z - step.z) < 0.05, 'standing where their browser stepped down');
let offRefused = 0;
for (let i = 1; i <= 15; i++) {
  const pos = { x: step.x + dx * (5 * i) / 30, y: start.y, z: step.z + dz * (5 * i) / 30 };
  if (night.motion('p1', motionOf(pos, { x: dx * 5, y: 0, z: dz * 5 }))) offRefused++;
  advance(1 / 30);
}
check(offRefused === 0, 'running it out from there is accepted');

section('Knocked off');
const here = { ...p0.motion.pos };
put('p1', { x: here.x + 1, y: here.y, z: here.z });
night.motion('p0', motionOf(here, { x: 0, y: 0, z: 0 }, dir));
night.act('p1', { a: 'bike', id: bike.id, seat: 'peg' });
check(bike.passenger === 'p1', 'back on the pegs');
events.length = 0;
night.debug('p0', { cmd: 'hurt', amount: BICYCLE.knockDamage + 3 });
check(bike.rider === null && bike.passenger === null, 'a hard hit on the rider throws both off');
advance(1 / 60);
check(events.some((e) => e.type === 'bike' && e.player === 'p0' && e.stage === 'bail') && events.some((e) => e.type === 'bike' && e.player === 'p1' && e.stage === 'bail'),
  'as bails every client sees');
night.act('p0', { a: 'bike', id: -1 });
check(run('p0', here, dir, fast, 6) > 0, 'on foot again, bike speed is refused once the grace is over');

night.dispose();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
