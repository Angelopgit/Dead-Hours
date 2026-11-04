/**
 * Night goals (sim/Contracts): three per night from the seed with boarding up always first,
 * counted from simulation events, scaled to the team when the outbreak begins, paid out as XP,
 * and carried to clients in the snapshot. Run with `npm run check:goals`.
 */
import { Contracts, GOAL_KINDS, GOALS_PER_NIGHT, runXp, XP, type SimEvent, type Simulation } from '../src';

let failures = 0;
let passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n${s}`);

/** Just what Contracts reads of a simulation. */
function fakeSim(players: number) {
  const events: SimEvent[] = [];
  const sim = {
    phase: 'preparation',
    players: new Map(Array.from({ length: players }, (_, i) => [`p${i}`, { stats: { goals: 0 } }])),
    zombies: [] as { id: number; kind: string }[],
    emit(e: SimEvent) { events.push(e); sim.contracts?.observe(e); },
    contracts: null as Contracts | null,
  };
  return { sim, events, as: sim as unknown as Simulation };
}

section('picking');
{
  const seen = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const { as } = fakeSim(1);
    const c = new Contracts(as, seed);
    const kinds = c.goals.map((g) => g.kind);
    if (seed === 1) check(kinds.length === GOALS_PER_NIGHT, `${GOALS_PER_NIGHT} goals a night`);
    if (kinds[0] !== 'boards' || new Set(kinds).size !== kinds.length) { check(false, `seed ${seed}: boards first, no repeats (${kinds})`); break; }
    seen.add(kinds.slice(1).join(','));
  }
  check(seen.size > 15, `nights differ: ${seen.size} different pairs in 60 seeds`);
  const a = new Contracts(fakeSim(1).as, 7).goals.map((g) => g.kind).join();
  const b = new Contracts(fakeSim(1).as, 7).goals.map((g) => g.kind).join();
  check(a === b, 'the same seed picks the same goals (server and client agree)');
}

section('counting and paying out');
{
  const f = fakeSim(2);
  const c = new Contracts(f.as, 3);
  f.sim.contracts = c;
  const boards = c.goals[0];
  const before = boards.target;
  for (let i = 0; i < 3; i++) f.sim.emit({ type: 'barricade', slot: i, boards: 1, change: 'nailed', player: 'p0', pos: { x: 0, y: 0, z: 0 } });
  f.sim.emit({ type: 'barricade', slot: 9, boards: 0, change: 'broken', player: null, pos: { x: 0, y: 0, z: 0 } });
  check(boards.progress === 3, `nailed boards count, broken ones don't (${boards.progress})`);
  f.sim.phase = 'survival';
  f.sim.emit({ type: 'phase', phase: 'survival' });
  check(boards.target === before + 2, `a second survivor raises the target when the outbreak begins (${before} to ${boards.target})`);
  while (!c.done(boards)) f.sim.emit({ type: 'barricade', slot: 1, boards: 2, change: 'nailed', player: 'p1', pos: { x: 0, y: 0, z: 0 } });
  const p0 = f.sim.players.get('p0')!;
  check(p0.stats.goals === 1 && f.sim.players.get('p1')!.stats.goals === 1, 'finishing a goal counts for everyone in the night');
  check(f.events.some((e) => e.type === 'notice' && e.text === 'GOAL DONE'), 'and says so');
  const extra = boards.progress;
  f.sim.emit({ type: 'barricade', slot: 1, boards: 3, change: 'nailed', player: 'p1', pos: { x: 0, y: 0, z: 0 } });
  check(boards.progress === extra && p0.stats.goals === 1, 'a finished goal stays finished and pays once');
}

section('every kind can be finished');
for (const kind of GOAL_KINDS) {
  const f = fakeSim(1);
  const c = new Contracts(f.as, 1);
  f.sim.contracts = c;
  c.goals.splice(0, c.goals.length, { kind, progress: 0, target: 1 });
  f.sim.zombies.push({ id: 5, kind: kind === 'brutes' ? 'brute' : 'screamer' });
  const at = { x: 0, y: 0, z: 0 };
  const e: Record<string, SimEvent> = {
    boards: { type: 'barricade', slot: 0, boards: 1, change: 'nailed', player: 'p0', pos: at },
    headshots: { type: 'zombieDied', zombie: 5, zone: 'head', dir: at, force: 1, by: 'p0' },
    melee: { type: 'zombieHit', zombie: 5, zone: 'torso', pos: at, dir: at, damage: 50, killed: true, by: 'p0', melee: true },
    arms: { type: 'limbSevered', zombie: 5, limb: 1, arm: 'armL', cut: 'elbow', pos: at, dir: at, by: 'p0', melee: false, killed: false },
    screamers: { type: 'zombieDied', zombie: 5, zone: 'torso', dir: at, force: 1, by: 'p0' },
    brutes: { type: 'zombieDied', zombie: 5, zone: 'torso', dir: at, force: 1, by: 'p0' },
    hordes: { type: 'horde', wave: 1, stage: 'over', at: 0 },
    drops: { type: 'supplyDrop', drop: 0, stage: 'empty', pos: at },
    raiders: { type: 'raiderDied', raider: 'r1', zone: 'head', dir: at, by: 'p0', weapon: 'ar', left: 0 },
    blasts: { type: 'zombieDied', zombie: 5, zone: 'torso', dir: at, force: 1, by: 'p0', cause: 'blast' },
  };
  f.sim.emit(e[kind]);
  check(c.done(c.goals[0]), `${kind}: ${c.text(c.goals[0])}`);
}

section('wire and XP');
{
  const f = fakeSim(1);
  const c = new Contracts(f.as, 11);
  c.goals[1].progress = 4;
  const copy = new Contracts(fakeSim(1).as, 99);
  copy.mirrored = true;
  copy.sync(c.pack());
  check(JSON.stringify(copy.goals) === JSON.stringify(c.goals), 'a client copy matches the server after one snapshot');
  copy.observe({ type: 'horde', wave: 1, stage: 'over', at: 0 });
  check(JSON.stringify(copy.goals) === JSON.stringify(c.goals), 'and counts nothing itself');
  const base = { kills: 0, headshots: 0, limbsSevered: 0, limbKills: 0, suppliesCollected: 0 };
  check(runXp(0, { ...base, goals: 2 }).total === 2 * XP.goal, `two goals pay ${2 * XP.goal} XP`);
  check(runXp(0, { ...base, goals: 9 }).total === GOALS_PER_NIGHT * XP.goal, 'never more than a night has');
  check(runXp(0, base).total === 0, 'runs from before goals still add up');
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
