/**
 * Skateboards on the server, without the network: a rider may roll faster than anyone runs (and
 * no faster than a board goes), the allowance ends soon after they step off, a board has one
 * rider, snapshots show who is on which board, and a hard hit throws the rider off.
 * Run with `npx tsx server/tests/skate.check.ts` (part of `npm run check:skate`).
 */
import { GROUP, PLAYER, SKATEBOARD, groups, packMotion, type SimEvent, type Snapshot, type Vec3 } from '@dead-hours/shared';
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
night.addSurvivor({ id: 'p0', name: 'Rider', primary: 'ar', appearance: '' }, 0);
night.addSurvivor({ id: 'p1', name: 'Walker', primary: 'ar', appearance: '' }, 1);
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

const motionOf = (pos: Vec3, vel: Vec3, board?: number) => packMotion({
  motion: { pos, vel, yaw: 0, pitch: 0, eyeHeight: 1.6, crouching: false, sprinting: true, aiming: false, grounded: true, board, pushing: board !== undefined },
  facing: 0, trigger: false, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: 0, y: 0, z: 1 },
});
/** Puts a survivor somewhere (as if they had walked there). */
const put = (id: string, pos: Vec3) => {
  const p = sim.players.get(id)!;
  sim.setMotion(id, { ...p.motion, pos: { ...pos }, vel: { x: 0, y: 0, z: 0 } });
  advance(1); // the speed allowance refills
};
const LANE = 30;
/**
 * Sends 30 moves a second at `speed` for `seconds`, up and down a clear lane LANE m long (the
 * server allows a short burst over the limit, so a cheat shows only over a few seconds); returns
 * how many moves were refused.
 */
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

// A straight lane from the safehouse board with nothing in the way.
const board = sim.skateboards.boards[0];
const WALLS = groups(0xffff, GROUP.static);
const b = sim.map.bounds;
let dir = -1;
for (let k = 0; k < 32 && dir < 0; k++) {
  const a = (k / 32) * Math.PI * 2;
  const end = { x: board.pos.x + Math.sin(a) * (LANE + 2), z: board.pos.z + Math.cos(a) * (LANE + 2) };
  if (end.x < b.x0 + 2 || end.x > b.x1 - 2 || end.z < b.z0 + 2 || end.z > b.z1 - 2) continue;
  if (night.physics.raycast(board.pos.x, board.pos.y + 0.9, board.pos.z, Math.sin(a), 0, Math.cos(a), LANE + 2, WALLS) === null) dir = a;
}
const start = { ...board.pos };
const fast = SKATEBOARD.sprintTop;
const MAX_FOOT = PLAYER.sprintSpeed * 1.25;

section('Speed checks');
check(dir >= 0, `a clear ${LANE} m lane from the safehouse board (heading ${dir.toFixed(2)})`);
check(fast > MAX_FOOT, `a pushed board (${fast} m/s) outruns the fastest feet the server allows (${MAX_FOOT.toFixed(2)} m/s)`);
put('p1', start);
check(run('p1', start, dir, fast, 6) > 0, 'on foot, that speed is refused');
put('p1', { x: start.x + 4, y: start.y, z: start.z });
put('p0', start);
check(!night.motion('p0', motionOf(start, { x: 0, y: 0, z: 0 })), 'the rider stands by the board');
night.act('p0', { a: 'board', id: board.id });
check(board.rider === 'p0', 'hops on');
advance(1 / 60);
check(events.some((e) => e.type === 'skate' && e.player === 'p0' && e.stage === 'on'), 'everyone hears about it');
night.act('p1', { a: 'board', id: board.id });
check(board.rider === 'p0', 'someone else asking for the same board doesn\'t get it');
const RIDE = 10;
const refused = run('p0', start, dir, fast, RIDE, true);
const rolled = fast * RIDE;
check(refused === 0, `riding at ${fast} m/s for ${RIDE} s (${rolled.toFixed(0)} m up and down the lane) is accepted (${refused} refused)`);
// Where that leaves them on the lane, and which way they were rolling at the end.
const leg = Math.floor(rolled / LANE), along = leg % 2 ? LANE - (rolled % LANE) : rolled % LANE;
const heading = leg % 2 ? dir + Math.PI : dir;
const p0 = sim.players.get('p0')!;
const away = Math.hypot(p0.motion.pos.x - start.x, p0.motion.pos.z - start.z);
check(Math.abs(away - along) < 0.05, `the server has the rider where they rolled to (${away.toFixed(1)} m along the lane)`);
const turned = Math.abs(Math.atan2(Math.sin(board.yaw - heading), Math.cos(board.yaw - heading)));
check(Math.abs(board.pos.x - p0.motion.pos.x) < 0.01 && turned < 0.01, 'the board is under them, pointing the way they roll');
advance(0.1);
const row = (snap as Snapshot | null)?.sk?.find((r) => r[0] === board.id);
check(!!row && row[5] === 'p0', 'snapshots show who rides it');
put('p0', start);
check(run('p0', start, dir, SKATEBOARD.maxSpeed * 1.6, 6, true) > 0, `even on a board, ${(SKATEBOARD.maxSpeed * 1.6).toFixed(0)} m/s is refused`);

section('Stepping off');
put('p0', start);
night.act('p0', { a: 'board', id: -1, at: { x: start.x + 0.3, y: start.y, z: start.z }, yaw: 1.2 });
check(board.rider === null, 'steps off');
check(Math.abs(board.pos.x - (start.x + 0.3)) < 0.01 && Math.abs(board.yaw - 1.2) < 1e-6, 'the board rests where their browser put it');
check(run('p0', start, dir, fast, 6) > 0, 'on foot again, board speed is refused once the grace is over');
put('p0', start);
night.act('p0', { a: 'board', id: board.id });
check(board.rider === 'p0', 'back on');
night.act('p0', { a: 'board', id: -1, at: { x: start.x + 30, y: start.y, z: start.z } });
check(board.rider === null && Math.hypot(board.pos.x - start.x, board.pos.z - start.z) < 0.5, 'a step-off spot far away is ignored (the board stays at the rider)');

section('Tricks');
events.length = 0;
put('p0', start);
night.act('p0', { a: 'trick', kind: 'kickflip' });
advance(1 / 60);
const tricks = () => events.filter((e) => e.type === 'skate' && e.stage === 'trick');
check(tricks().length === 0, 'on foot a trick is ignored');
night.act('p0', { a: 'board', id: board.id });
events.length = 0;
night.act('p0', { a: 'trick', kind: 'kickflip' });
night.act('p0', { a: 'trick', kind: 'heelflip' });
advance(1 / 60);
check(tricks().length === 1 && (tricks()[0] as Extract<SimEvent, { type: 'skate' }>).trick === 'kickflip', 'on the board everyone hears of the kickflip (and only one trick per ollie)');
advance(SKATEBOARD.trickEvery);
events.length = 0;
night.act('p0', { a: 'trick', kind: 'backflip' } as unknown as Parameters<typeof night.act>[1]);
night.act('p0', { a: 'trick', kind: 'ollie' });
advance(1 / 60);
check(tricks().length === 0, 'made-up tricks (and plain ollies) are not passed on');
night.act('p0', { a: 'trick', kind: 'treflip' });
advance(1 / 60);
check(tricks().length === 1 && board.rider === 'p0', 'the next one is, and the rider stays on');
night.act('p0', { a: 'board', id: -1 });

section('Thrown off');
night.act('p0', { a: 'board', id: board.id });
events.length = 0;
night.debug('p0', { cmd: 'hurt', amount: SKATEBOARD.knockDamage + 3 });
check(board.rider === null, 'a hard hit throws the rider off');
advance(1 / 60);
check(events.some((e) => e.type === 'skate' && e.player === 'p0' && e.stage === 'bail'), 'as a bail every client sees');
night.act('p1', { a: 'board', id: board.id });
check(board.rider === null, 'the walker, 4 m away, can\'t reach it');
put('p1', board.pos);
night.act('p1', { a: 'board', id: board.id });
check(board.rider === 'p1', 'once close, the walker takes it');

night.dispose();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
