// npx tsx tests/load.ts — bot lobbies against real server processes. Each lobby: four god-mode bots
// circling and shooting, EXTRA zombies (default 24) set on them, the night running. STEPS lists the
// lobby counts to measure (default 1,5,10,20,30). SERVERS (default 1) starts that many processes
// sharing a local redis-server behind a round-robin balancer, like Render instances. MAX_ROOMS is
// lifted so the cap doesn't stop the test. NODE_FLAGS passes flags to the servers (--cpu-prof).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from 'colyseus.js';
import { C2S, S2C, packMotion, type BeginMsg } from '@dead-hours/shared';

const PORT = 2622;
const SERVERS = Math.max(1, Number(process.env.SERVERS ?? 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'dh-load-'));
const procs: ChildProcess[] = [];
const env: Record<string, string> = { DEAD_HOURS_DEBUG: '1', DATABASE_URL: '', MAX_ROOMS: '1000' };
if (SERVERS > 1) {
  const bin = spawnSync('sh', ['-c', 'command -v redis-server']).stdout.toString().trim();
  if (!bin) throw new Error('SERVERS > 1 needs redis-server');
  procs.push(spawn(bin, ['--port', '6393', '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' }));
  await sleep(400);
  Object.assign(env, { REDIS_URL: 'redis://127.0.0.1:6393', SELF_HOSTNAME: '127.0.0.1' });
}
const ports = Array.from({ length: SERVERS }, (_, i) => (SERVERS > 1 ? PORT + 1 + i : PORT));
const servers = ports.map((port) => {
  const p = spawn(process.execPath, [...(process.env.NODE_FLAGS ?? '').split(' ').filter(Boolean), '--import', 'tsx', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env, PORT: String(port), DATA_FILE: join(dir, `d${port}.json`) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  procs.push(p);
  return p;
});
const cpuOf = (pid: number) => { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return (+f[11] + +f[12]) / 100; };
const cpus = () => servers.map((s) => cpuOf(s.pid!));
const rss = () => servers.reduce((a, s) => a + +readFileSync(`/proc/${s.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)![1] / 1024, 0);
for (const port of ports) for (let i = 0; i < 300; i++) { if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break; await sleep(100); }
if (SERVERS > 1) {
  // Like Render's balancer: each new connection to the next process.
  let turn = 0;
  const lb = createServer((down) => {
    const up = connect(ports[turn++ % ports.length], '127.0.0.1');
    down.pipe(up).pipe(down);
    up.on('error', () => down.destroy());
    down.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => lb.listen(PORT, '127.0.0.1', () => r()));
}
const client = new Client(`ws://127.0.0.1:${PORT}`);
let snaps = 0; const rooms: Room[] = [];
const players: { room: Room; begin: BeginMsg | null }[] = [];
async function addRoom(k: number) {
  const ps: { room: Room; begin: BeginMsg | null }[] = [];
  const opts = (n: number) => ({ name: `B${k}_${n}`, primary: 'ar', appearance: '', token: `tok-${k}-${n}-${'x'.repeat(20)}` });
  const host = await client.create('survival', { ...opts(0), lobbyName: `L${k}`, private: true });
  ps.push({ room: host, begin: null });
  const code = await new Promise<string>((res) => host.onMessage(S2C.lobby, (m: any) => m.code && res(m.code)));
  for (let n = 1; n < 4; n++) ps.push({ room: await client.joinById(host.roomId, opts(n)), begin: null });
  for (const p of ps) {
    p.room.onMessage(S2C.begin, (m: BeginMsg) => { p.begin = m; p.room.send(C2S.loaded); });
    p.room.onMessage(S2C.snap, () => snaps++);
    for (const t of [S2C.ev, S2C.over, S2C.notice, S2C.pos, S2C.pong, S2C.chat, S2C.talk, S2C.rtc, S2C.ice, S2C.lobby]) p.room.onMessage(t, () => {});
    p.room.send(C2S.ready, true);
  }
  await sleep(300);
  host.send(C2S.start);
  while (ps.some((p) => !p.begin)) await sleep(50);
  for (const p of ps) p.room.send(C2S.debug, { cmd: 'god', on: true });
  host.send(C2S.debug, { cmd: 'skipPreparation' });
  for (let z = 0; z < +(process.env.EXTRA ?? 24); z++) ps[z % 4].room.send(C2S.debug, { cmd: 'spawn', dist: 8 + (z % 6), angle: z, kind: (['walker', 'runner', 'brute'] as const)[z % 3] });
  players.push(...ps); rooms.push(host);
  void code;
}
let t = 0;
setInterval(() => { t += 0.05; for (const p of players) { if (!p.begin) continue; const s = p.begin.spawn; const pos = { x: s.x + Math.sin(t) * 1.5, y: s.y, z: s.z + Math.cos(t) * 1.5 }; p.room.send(C2S.motion, packMotion({ motion: { pos, vel: { x: 0, y: 0, z: 0 }, yaw: t, pitch: 0, eyeHeight: 1.6, grounded: true, crouching: false, sprinting: false } as any, trigger: Math.sin(t * 3) > 0.6, facing: t, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: Math.sin(t), y: 0, z: Math.cos(t) } })); } }, 50);
for (const target of (process.env.STEPS ?? "1,5,10,20,30").split(",").map(Number)) {
  while (rooms.length < target) await addRoom(rooms.length);
  await sleep(4000);
  const c0 = cpus(), s0 = snaps, w0 = Date.now();
  await sleep(15000);
  const secs = (Date.now() - w0) / 1000;
  const used = cpus().map((c, i) => ((c - c0[i]) / secs) * 100);
  const each = SERVERS > 1 ? ` (${used.map((u) => `${u.toFixed(0)}%`).join(' + ')})` : '';
  console.log(`rooms=${target} players=${target * 4} serverCPU=${used.reduce((a, b) => a + b, 0).toFixed(0)}% of one core${each}, rss=${rss().toFixed(0)}MB, snaps/player/s=${((snaps - s0) / secs / (target * 4)).toFixed(1)}`);
}
for (const p of servers) p.kill('SIGINT');
await sleep(1500);
for (const p of procs) p.kill('SIGKILL');
process.exit(0);
