// npx tsx tests/balance.ts — how much a night throws at a team that never misses.
// PLAYERS survivors (default 1, god mode) stand in the safehouse; every zombie that gets within KILL
// metres (default 15) dies on arrival and every raider dies 20 s after it gets out of the van, so
// the spawner, hordes, lulls and drops run as they would for a perfect team. Kills make gunfire
// noise heard NOISE metres away (default 70, the AR; 28 is a suppressed AR). MINUTES of night
// (default 20). Prints per minute: kills by kind, zombie HP that had to be dealt, the most zombies
// within 30 m and alive at once, and the night's hordes, lulls, drops and raid.
import { NO_UNLOCKS, packMotion, ZOMBIES, type ZombieKind } from '@dead-hours/shared';
import { Night } from '../src/game/Night';
import { initWorld } from '../src/game/world';

const PLAYERS = Number(process.env.PLAYERS ?? 1);
const MINUTES = Number(process.env.MINUTES ?? 20);
const KILL = Number(process.env.KILL ?? 15);
const SEED = Number(process.env.SEED ?? 11);
const NOISE = Number(process.env.NOISE ?? 70);
const KINDS: ZombieKind[] = ['walker', 'runner', 'brute', 'screamer', 'bloater', 'crawler'];

await initWorld();
const night = new Night(SEED, 0);
const ids = Array.from({ length: PLAYERS }, (_, i) => `p${i}`);
ids.forEach((id, i) => night.addSurvivor({ id, name: id.toUpperCase(), primary: 'ar', appearance: '', builds: {}, unlocks: NO_UNLOCKS }, i));
for (const id of ids) night.debug(id, { cmd: 'god', on: true });
night.debug(ids[0], { cmd: 'skipPreparation' });
const sim = night.sim;
const shooter = sim.players.get(ids[0])!;
const home = ids.map((id) => ({ ...sim.players.get(id)!.motion.pos }));

interface Row { kills: Partial<Record<ZombieKind, number>>; hp: number; peak30: number; peakAlive: number; events: string[] }
const rows: Row[] = [];
const row = (m: number): Row => (rows[m] ??= { kills: {}, hp: 0, peak30: 0, peakAlive: 0, events: [] });
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const raiderSeen = new Map<unknown, number>();
let t = 0, lastNoise = -1;
for (let i = 0; i < MINUTES * 3600; i++) {
  t += 1 / 60;
  if (i % 3 === 0) {
    ids.forEach((id, p) => {
      const pos = home[p];
      night.motion(id, packMotion({
        motion: { pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 1.6, grounded: true, crouching: false, sprinting: false } as never,
        trigger: false, facing: 0, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: 0, y: 0, z: 1 },
      }));
    });
  }
  const r = night.advance(1 / 60);
  const ph = sim.phaseTime;
  if (sim.phase === 'over') {
    console.log('the night ended at', fmt(ph));
    break;
  }
  if (sim.phase !== 'survival') continue;
  const R = row(Math.floor(ph / 60));
  for (const e of r.events) {
    if (e.type === 'horde' && e.stage !== 'warning') R.events.push(`${fmt(ph)} horde ${e.wave} ${e.stage}`);
    if (e.type === 'lull' && e.stage !== 'ending') R.events.push(`${fmt(ph)} lull ${e.n} ${e.stage}`);
    if (e.type === 'supplyDrop' && e.stage === 'landed') R.events.push(`${fmt(ph)} drop`);
    if (e.type === 'raid' && e.stage !== 'over') R.events.push(`${fmt(ph)} raid ${e.stage}`);
  }
  let near30 = 0, alive = 0;
  for (const z of sim.zombies) {
    if (!z.alive) continue;
    alive++;
    let best = Infinity;
    for (const h of home) best = Math.min(best, Math.hypot(z.pos.x - h.x, z.pos.z - h.z) + Math.abs(z.pos.y - h.y));
    if (best < 30) near30++;
    if (best >= KILL) continue;
    sim.hitZombie(shooter, z, z.health + 1, 'torso', z.chest, { x: 0, y: 0, z: 1 }, false, 1);
    R.kills[z.kind] = (R.kills[z.kind] ?? 0) + 1;
    R.hp += ZOMBIES[z.kind].health;
    if (NOISE > 0 && t - lastNoise > 0.5) {
      sim.noise(home[0], NOISE, ids[0]);
      lastNoise = t;
    }
  }
  for (const rd of sim.raid.raiders) {
    if (!rd.alive) continue;
    const seen = raiderSeen.get(rd) ?? t;
    raiderSeen.set(rd, seen);
    if (t - seen > 20) sim.raid.hit(shooter, rd, 999, 'head', rd.pos, { x: 0, y: 0, z: 1 });
  }
  R.peak30 = Math.max(R.peak30, near30);
  R.peakAlive = Math.max(R.peakAlive, alive);
}
console.log(`${PLAYERS} survivor(s), kill radius ${KILL} m, seed ${SEED}, gunfire heard ${NOISE} m`);
console.log(`min  kills ${KINDS.map((k) => k.padStart(9)).join('')}  HP-dealt  peak<30m  peakAlive  events`);
let total = 0, totalHp = 0;
rows.forEach((R, m) => {
  if (!R) return;
  const n = Object.values(R.kills).reduce((a, b) => a + (b ?? 0), 0);
  total += n;
  totalHp += R.hp;
  console.log(`${String(m).padStart(3)} ${String(n).padStart(6)} ${KINDS.map((k) => String(R.kills[k] ?? 0).padStart(9)).join('')} ${String(R.hp).padStart(9)} ${String(R.peak30).padStart(9)} ${String(R.peakAlive).padStart(10)}  ${R.events.join(', ')}`);
});
console.log(`total kills ${total} (${Math.round(total / PLAYERS)} per survivor), zombie HP ${totalHp}`);
night.dispose();
process.exit(0);
