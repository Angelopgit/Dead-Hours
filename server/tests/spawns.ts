// npx tsx tests/spawns.ts — how a night's zombie numbers climb, and what that costs one room.
// PLAYERS survivors (default 4, god mode) hold the safehouse without firing, so nothing thins the
// horde: the worst case. MINUTES of night (default 15). Every REPORT seconds (default 60) prints
// the zombies alive, the most spawned in any one second and any five seconds since the last line,
// the snapshot size each client receives, and the room's CPU over that stretch.
import { pack } from '@colyseus/msgpackr';
import { NO_UNLOCKS, packMotion } from '@dead-hours/shared';
import { Night } from '../src/game/Night';
import { initWorld } from '../src/game/world';

const PLAYERS = Number(process.env.PLAYERS ?? 4);
const MINUTES = Number(process.env.MINUTES ?? 15);
const REPORT = Number(process.env.REPORT ?? 60);

await initWorld();
const night = new Night(11, 0);
const ids = Array.from({ length: PLAYERS }, (_, i) => `p${i}`);
const spawns = ids.map((id, i) => night.addSurvivor({ id, name: id.toUpperCase(), primary: 'ar', appearance: '', builds: {}, unlocks: NO_UNLOCKS }, i));
for (const id of ids) night.debug(id, { cmd: 'god', on: true });
night.debug(ids[0], { cmd: 'skipPreparation' });

const steps = MINUTES * 60 * 60;
let t = 0, cpu = 0, bytes = 0, snaps = 0, maxBytes = 0, peakAlive = 0, total = 0;
/** Spawns in each of the last few seconds (ring), for the 1 s and 5 s peaks. */
const perSecond: number[] = [];
let sec = -1, peak1 = 0, peak5 = 0;
console.log(`${PLAYERS} survivor(s), ${MINUTES} min, nobody shooting`);
console.log('time   alive  peak/1s  peak/5s  snapshot  CPU of a core');
for (let i = 0; i < steps; i++) {
  t += 1 / 60;
  if (i % 3 === 0) {
    ids.forEach((id, p) => {
      const s = spawns[p];
      const pos = { x: s.x + Math.sin(t + p) * 1.2, y: s.y, z: s.z + Math.cos(t + p) * 1.2 };
      night.motion(id, packMotion({
        motion: { pos, vel: { x: 0, y: 0, z: 0 }, yaw: t, pitch: 0, eyeHeight: 1.6, grounded: true, crouching: false, sprinting: false } as never,
        trigger: false, facing: t, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: Math.sin(t), y: 0, z: Math.cos(t) },
      }));
    });
  }
  const t0 = performance.now();
  const r = night.advance(1 / 60);
  cpu += performance.now() - t0;
  const phase = night.sim.phaseTime;
  const s = Math.floor(phase);
  if (s !== sec) {
    sec = s;
    perSecond.push(0);
    if (perSecond.length > 5) perSecond.shift();
  }
  for (const e of r.events) {
    if (e.type !== 'zombieSpawned') continue;
    perSecond[perSecond.length - 1]++;
    total++;
  }
  peak1 = Math.max(peak1, perSecond[perSecond.length - 1]);
  peak5 = Math.max(peak5, perSecond.reduce((a, b) => a + b, 0));
  if (r.snapshot) {
    const n = pack(r.snapshot).length;
    bytes += n;
    maxBytes = Math.max(maxBytes, n);
    snaps++;
  }
  if (night.sim.phase === 'over') {
    // God mode keeps health up, but a big enough hit in one step can still down a survivor.
    console.log(`the night ended at ${Math.floor(phase / 60)}:${String(Math.round(phase % 60)).padStart(2, '0')}`);
    break;
  }
  const alive = night.sim.zombies.filter((z) => z.alive).length;
  peakAlive = Math.max(peakAlive, alive);
  if ((i + 1) % (REPORT * 60) === 0) {
    const at = Math.round(phase), m = Math.floor(at / 60), ss = at % 60;
    const kb = snaps ? (bytes / snaps / 1024).toFixed(1) : '-';
    console.log(`${String(m).padStart(2)}:${String(ss).padStart(2, '0')}  ${String(alive).padStart(5)}  ${String(peak1).padStart(7)}  ${String(peak5).padStart(7)}  ${kb.padStart(5)} KB  ${((cpu / REPORT) / 10).toFixed(1).padStart(5)}%`);
    cpu = 0; bytes = 0; snaps = 0; peak1 = 0; peak5 = 0;
  }
}
console.log(`peak alive ${peakAlive}, ${total} spawned, biggest snapshot ${(maxBytes / 1024).toFixed(1)} KB (${((maxBytes * 20) / 1024).toFixed(0)} KB/s per client)`);
night.dispose();
