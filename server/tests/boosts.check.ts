/**
 * Boost syringes on the server, without the network: the night's syringes reach every client in
 * the snapshots, a survivor's "use" injects one (first come, first served), the running boost
 * travels with their snapshot row, and a stamina shot lets them move faster than the server would
 * otherwise allow (and only while it runs).
 * Run with `npx tsx server/tests/boosts.check.ts` (`npm run check:boosts`).
 */
import { BOOSTS, BOOST_IDS, BOOST_PICKUPS, GROUP, INJECT, PLAYER, groups, packMotion, type SimEvent, type Snapshot, type Vec3 } from '@dead-hours/shared';
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
night.addSurvivor({ id: 'p0', name: 'Medic', primary: 'ar', appearance: '' }, 0);
night.addSurvivor({ id: 'p1', name: 'Runner', primary: 'ar', appearance: '' }, 1);
const events: SimEvent[] = [];
let snap: Snapshot | null = null;
const advance = (seconds: number) => {
  for (let t = 0; t < seconds - 1e-6; t += 1 / 60) {
    const r = night.advance(1 / 60);
    events.push(...r.events);
    if (r.snapshot) snap = r.snapshot;
  }
};
const motionOf = (pos: Vec3, vel: Vec3, yaw = 0) => packMotion({
  motion: { pos, vel, yaw, pitch: 0, eyeHeight: 1.6, crouching: false, sprinting: true, aiming: false, grounded: true },
  facing: yaw, trigger: false, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: 0, y: 0, z: 1 },
});
const put = (id: string, pos: Vec3, yaw = 0) => {
  const p = sim.players.get(id)!;
  sim.setMotion(id, { ...p.motion, pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, yaw });
  advance(1); // the speed allowance refills
};
const BOOST_KIND = 7; // ITEM_KINDS index of 'boost'
const rowsOf = (s: Snapshot | null) => (s?.i ?? []).filter((r) => r[1] === BOOST_KIND);

section('The night\'s syringes');
advance(0.5);
const placed = sim.placedBoosts;
check(placed.length >= BOOST_PICKUPS.count[0] && placed.length <= BOOST_PICKUPS.count[1], `${placed.length} syringes lie in the houses`);
const rows = rowsOf(snap);
check(rows.length === placed.length, `snapshots carry all of them (${rows.length})`);
check(rows.every((r) => r[9] >= 0 && r[9] < BOOST_IDS.length && placed.some((it) => it.id === r[0] && it.boost === BOOST_IDS[r[9]])), 'each row says which dose it is');

section('Taking one');
const it = placed[0];
const kind = it.boost!;
const spot = sim.boostSpots.find((s) => Math.hypot(s.pos.x - it.pos.x, s.pos.z - it.pos.z) < 0.01)!;
check(!!spot, `the ${kind} syringe lies on a ${spot?.prop}`);
put('p0', spot.stand, Math.atan2(spot.stand.x - spot.pos.x, spot.stand.z - spot.pos.z));
put('p1', spot.stand);
events.length = 0;
night.act('p0', { a: 'use', id: it.id });
night.act('p1', { a: 'use', id: it.id });
advance(1 / 60);
check(it.supply === 0, 'the first survivor to use it has it');
check(events.some((e) => e.type === 'boost' && e.player === 'p0' && e.stage === 'taken' && e.item === it.id), 'everyone hears it was taken');
check(!events.some((e) => e.type === 'boost' && e.player === 'p1'), 'the second, a moment later, gets nothing');
const p0 = sim.players.get('p0')!;
advance(0.1);
const mine = () => (snap as Snapshot | null)?.p.find((r) => r.id === 'p0');
check(mine()?.w[16] === BOOST_IDS.indexOf(kind), 'snapshots show which needle is in their hand');
advance(INJECT.press);
check(sim.boosted(p0, kind) && events.some((e) => e.type === 'boost' && e.player === 'p0' && e.stage === 'start'), `the dose goes in after ${INJECT.press} s`);
advance(0.1);
const bo = mine()?.bo ?? [];
check(bo[0] === BOOST_IDS.indexOf(kind) && Math.abs(bo[1] / 1000 - sim.boostLeft(p0, kind)) < 0.2, `snapshots carry the boost and its time left (${(bo[1] / 1000).toFixed(1)} s)`);
check(rowsOf(snap).find((r) => r[0] === it.id)?.[5] === 0, 'and the empty spot');

section('Stamina and the speed check');
// A straight lane from the safehouse skateboard (out in the open) with nothing in the way.
const WALLS = groups(0xffff, GROUP.static);
const b = sim.map.bounds;
const LANE = 26;
const start = { ...sim.skateboards.boards[0].pos };
let dir = -1;
for (let k = 0; k < 32 && dir < 0; k++) {
  const a = (k / 32) * Math.PI * 2;
  const end = { x: start.x + Math.sin(a) * (LANE + 2), z: start.z + Math.cos(a) * (LANE + 2) };
  if (end.x < b.x0 + 2 || end.x > b.x1 - 2 || end.z < b.z0 + 2 || end.z > b.z1 - 2) continue;
  if (night.physics.raycast(start.x, start.y + 0.9, start.z, Math.sin(a), 0, Math.cos(a), LANE + 2, WALLS) === null) dir = a;
}
check(dir >= 0, `a clear ${LANE} m lane outside the safehouse (heading ${dir.toFixed(2)})`);
/** Sends 30 moves a second at `speed` up and down the lane; returns how many the server refused. */
const run = (id: string, speed: number, seconds: number) => {
  let refused = 0;
  const dx = Math.sin(dir), dz = Math.cos(dir);
  for (let i = 1; i <= Math.round(seconds * 30); i++) {
    const d = (speed * i) / 30;
    const leg = Math.floor(d / LANE), along = leg % 2 ? LANE - (d % LANE) : d % LANE;
    const back = leg % 2 ? -1 : 1;
    const pos = { x: start.x + dx * along, y: start.y, z: start.z + dz * along };
    if (night.motion(id, motionOf(pos, { x: dx * speed * back, y: 0, z: dz * speed * back }))) refused++;
    advance(1 / 30);
  }
  return refused;
};
const boosted = PLAYER.sprintSpeed * BOOSTS.stamina.sprint;
put('p1', start);
// The server lets a burst over its limit through, so a few percent too fast shows only over a long run.
check(run('p1', boosted, 30) > 0, `without a stamina shot, a ${boosted.toFixed(1)} m/s sprint is refused (within 30 s)`);
const st = sim.layBoost('stamina', { x: start.x + 0.5, y: start.y + 0.8, z: start.z });
put('p1', start);
night.act('p1', { a: 'use', id: st.id });
advance(INJECT.duration + 0.1);
const p1 = sim.players.get('p1')!;
check(sim.boosted(p1, 'stamina'), 'the runner injects a stamina shot');
put('p1', start);
const refused = run('p1', boosted, 30);
check(refused === 0, `with it, the same sprint for 30 s is accepted (${refused} refused)`);
put('p1', start);
check(run('p1', boosted * 1.4, 12) > 0, `but not ${(boosted * 1.4).toFixed(1)} m/s`);
p1.boosts.stamina = sim.time; // runs out now
advance(1 / 60);
check(!sim.boosted(p1, 'stamina') && events.some((e) => e.type === 'boost' && e.player === 'p1' && e.boost === 'stamina' && e.stage === 'end'), 'the shot wears off');
put('p1', start);
check(run('p1', boosted, 30) > 0, 'and the fast sprint is refused again');

night.dispose();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
