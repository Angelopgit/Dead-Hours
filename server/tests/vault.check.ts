/**
 * Vaulting through windows on the server, without the network: the vault act smashes the pane
 * the survivor goes through, every move of the vault (sent 30 times a second, as a browser does)
 * passes the server's movement checks, the same moves through a boarded window are refused, and
 * snapshots carry smashed panes to everyone.
 * Run with `npx tsx server/tests/vault.check.ts` (`npm run check:windows`).
 */
import { PLAYER, findVault, packMotion, unpackPanes, vaultAt, type SimEvent, type Snapshot, type Vec3 } from '@dead-hours/shared';
import { Night } from '../src/game/Night';
import { initWorld } from '../src/game/world';

let failures = 0;
let passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

await initWorld();
const night = new Night(5, 0);
const sim = night.sim;
night.addSurvivor({ id: 'p0', name: 'Vaulter', primary: 'ar', appearance: '', builds: {} as never, unlocks: { level: 1, entitlements: [] } }, 0);
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
const motionOf = (pos: Vec3, vaulting: boolean) => packMotion({
  motion: { pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 1.6, crouching: false, sprinting: false, aiming: false, grounded: !vaulting, vaulting },
  facing: 0, trigger: false, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: 0, y: 0, z: 1 },
});
const put = (pos: Vec3) => {
  const p = sim.players.get('p0')!;
  sim.setMotion('p0', { ...p.motion, pos: { ...pos }, vel: { x: 0, y: 0, z: 0 } });
  advance(1);
};
const b = sim.barricades;
const nav = sim.nav;

/** Sends the vault's moves 30 times a second; returns how many the server refused. */
const vaultMoves = (plan: NonNullable<ReturnType<typeof findVault>>['plan'] & object) => {
  let refused = 0;
  const pt = { x: 0, y: 0, z: 0 };
  for (let t = 1 / 30; ; t += 1 / 30) {
    const done = vaultAt(plan, t, pt) === null;
    const at = done ? plan.land ?? plan.over : pt;
    if (night.motion('p0', motionOf({ ...at }, !done))) refused++;
    advance(1 / 30);
    if (done) break;
  }
  return refused;
};

{
  const slot = b.windows.find((s) => s.houseId === 'house-sw' && s.inNode >= 0)!;
  const inside = nav.nodePos(slot.inNode);
  put(inside);
  const v = findVault(sim.physics, b, inside, { x: slot.normal.x, z: slot.normal.z }, PLAYER.height);
  check(v?.slot === slot && !!v.plan?.land && v.plan.smash, 'a way out through the window, through the glass');
  const plan = v!.plan!;
  // Without the vault act first, the pane stops the move.
  let refusedBefore = 0;
  {
    const pt = { x: 0, y: 0, z: 0 };
    vaultAt(plan, plan.times[0] + plan.times[1] * 0.4, pt);
    const mid = { ...pt };
    vaultAt(plan, plan.times[0] + plan.times[1] * 0.9, pt);
    put(mid);
    if (night.motion('p0', motionOf({ ...pt }, true))) refusedBefore++;
    advance(0.5);
    put(inside);
  }
  check(refusedBefore === 1, 'climbing through glass without smashing it is refused');
  events.length = 0;
  night.act('p0', { a: 'vault', slot: slot.index });
  check(!slot.glass, 'the vault smashes the pane on the server');
  const refused = vaultMoves(plan);
  const p = sim.players.get('p0')!;
  check(refused === 0 && b.side(slot, p.motion.pos.x, p.motion.pos.z) > 0, `every move of the vault goes through (${refused} refused), and the survivor is outside`);
  advance(0.2);
  check(events.some((e) => e.type === 'glassBroken' && e.slot === slot.index) && events.some((e) => e.type === 'playerVault' && e.player === 'p0'), 'everyone is told');
  const broken: number[] = [];
  if (snap?.g) unpackPanes(snap.g, (i) => broken.push(i));
  check(broken.includes(slot.index), 'snapshots carry the smashed pane');
  // Back in through the empty frame, then the same with boards up (nailed from inside meanwhile).
  advance(1);
  const out = { ...p.motion.pos };
  const back = findVault(sim.physics, b, out, { x: -slot.normal.x, z: -slot.normal.z }, PLAYER.height);
  check(back?.slot === slot && !!back.plan && !back.plan.smash, 'and a way back in');
  slot.boards = 2;
  check(findVault(sim.physics, b, out, { x: -slot.normal.x, z: -slot.normal.z }, PLAYER.height)?.block === 'boarded', 'boards up: no way in');
  night.act('p0', { a: 'vault', slot: slot.index });
  const cheat = vaultMoves(back!.plan!);
  check(cheat > 0 && b.side(slot, p.motion.pos.x, p.motion.pos.z) > 0, `a client that climbs in anyway is put back (${cheat} moves refused)`);
}

console.log(`\n${passes} passed, ${failures} failed`);
night.dispose();
process.exit(failures ? 1 : 0);
