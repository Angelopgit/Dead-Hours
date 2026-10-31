/**
 * Checks for running many games: the per-process game cap and its SERVERS FULL refusal, then
 * (when redis-server is installed) two server processes sharing Redis behind a load balancer
 * that, like Render's, hands each connection to either one: games spread over both, codes
 * and the game list work from either, and players reach a game whichever process their
 * connection lands on, through a night, chat and a reconnect. Run with `npm run check:cluster`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from 'colyseus.js';
import { C2S, S2C, SERVERS_FULL, type BeginMsg, type ChatLine, type LobbyMsg } from '@dead-hours/shared';

let failures = 0;
let passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

const dir = mkdtempSync(join(tmpdir(), 'dh-cluster-'));
const children: ChildProcess[] = [];
function gameServer(port: number, env: Record<string, string>): { proc: ChildProcess; log: () => string } {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), DEAD_HOURS_DEBUG: '1', DATA_FILE: join(dir, `data-${port}.json`), DATABASE_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  children.push(proc);
  return { proc, log: () => log };
}
async function healthy(port: number): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json(), () => null);
    if (h?.ok) return h;
    await sleep(100);
  }
  return null;
}
const health = (port: number) => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<any>);
const opts = (name: string, n: number) => ({ name, primary: 'ar', appearance: '', token: `cluster-${name}-${n}-${'k'.repeat(24)}` });
const codeOf = (room: Room) => new Promise<string>((res) => room.onMessage(S2C.lobby, (m: LobbyMsg) => m.code && res(m.code)));
const quiet = (room: Room) => {
  for (const t of [S2C.ev, S2C.over, S2C.notice, S2C.pos, S2C.pong, S2C.chat, S2C.talk, S2C.rtc, S2C.ice, S2C.lobby, S2C.snap, S2C.begin]) room.onMessage(t, () => {});
};
async function refused(p: Promise<unknown>): Promise<number | null> {
  try {
    const r = (await p) as Room;
    void r.leave();
    return null;
  } catch (e) {
    return (e as { code?: number }).code ?? -1;
  }
}

try {
  // ---------------------------------------------------------------- one process, capped
  section('Game cap on one server');
  {
    const port = 2641;
    gameServer(port, { MAX_ROOMS: '2' });
    const h = await healthy(port);
    check(h?.maxGames === 2 && h?.games === 0, `/health reports games against the cap (${h?.games}/${h?.maxGames})`);
    const client = new Client(`ws://127.0.0.1:${port}`);
    const a = await client.create('survival', { ...opts('A', 0), lobbyName: 'One' });
    const b = await client.create('survival', { ...opts('B', 0), lobbyName: 'Two' });
    quiet(a);
    quiet(b);
    const code = await refused(client.create('survival', { ...opts('C', 0), lobbyName: 'Three' }));
    check(code === SERVERS_FULL, `a third game is refused as SERVERS FULL (code ${code})`);
    const joined = await client.joinById(a.roomId, opts('A', 1)).then((r) => (quiet(r), r), () => null);
    check(!!joined, 'players can still join a running game while the server is full');
    void joined?.leave();
    void b.leave();
    await until(() => false, 600);
    const again = await client.create('survival', { ...opts('C', 1), lobbyName: 'Three' }).then((r) => (quiet(r), r), () => null);
    check(!!again, 'once a game closes, a new one can be hosted');
    void again?.leave();
    void a.leave();
  }

  // ---------------------------------------------------------------- two processes, Redis
  section('Two servers sharing Redis behind a load balancer');
  const redisBin = spawnSync('sh', ['-c', 'command -v redis-server']).stdout.toString().trim();
  if (!redisBin) {
    console.log('  skip redis-server is not installed here');
  } else {
    const REDIS = 6391;
    const redis = spawn(redisBin, ['--port', String(REDIS), '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
    children.push(redis);
    await sleep(400);
    const ports = [2642, 2643];
    const env = { REDIS_URL: `redis://127.0.0.1:${REDIS}`, SELF_HOSTNAME: '127.0.0.1', MAX_ROOMS: '2' };
    const servers = ports.map((p) => gameServer(p, env));
    const hs = await Promise.all(ports.map(healthy));
    check(hs.every((h) => h?.ok), 'both servers start with REDIS_URL');
    check(servers.every((s) => /sharing games through Redis; this process is reached at 127\.0\.0\.1:\d+/.test(s.log())), 'each announces its private address');

    // Like Render's balancer: every new connection goes to the next server in turn.
    const LB = 2640;
    let turn = 0;
    const counts = [0, 0];
    const lb = createServer((down: Socket) => {
      const i = turn++ % ports.length;
      counts[i]++;
      const up = connect(ports[i], '127.0.0.1');
      down.pipe(up).pipe(down);
      up.on('error', () => down.destroy());
      down.on('error', () => up.destroy());
    });
    await new Promise<void>((r) => lb.listen(LB, '127.0.0.1', () => r()));
    const client = new Client(`ws://127.0.0.1:${LB}`);

    const hosts: Room[] = [];
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const room = await client.create('survival', { ...opts(`H${i}`, 0), lobbyName: `Game ${i}` }).catch((e) => (console.log(`    game ${i}: ${e?.code} ${e?.message}`), null));
      if (!room) break;
      codes.push(await codeOf(room));
      quiet(room);
      hosts.push(room);
    }
    check(hosts.length === 4, `four games hosted through the balancer (${hosts.length})`);
    if (hosts.length < 4) for (const sv of servers) console.log(sv.log().split('\n').slice(-25).join('\n'));
    await sleep(1500);
    const games = (await Promise.all(ports.map(health))).map((h) => h.games);
    check(games[0] === 2 && games[1] === 2, `the games are spread over both servers (${games.join(' + ')})`);
    const full = await refused(client.create('survival', { ...opts('H4', 0), lobbyName: 'Game 4' }));
    check(full === SERVERS_FULL, `with both servers at their cap, a fifth game is SERVERS FULL (code ${full})`);

    const list = await Promise.all(ports.map((p) => fetch(`http://127.0.0.1:${p}/api/rooms`).then((r) => r.json() as Promise<any[]>)));
    check(list.every((l) => l.length === 4), `each server lists all four games (${list.map((l) => l.length).join(', ')})`);
    let found = 0;
    for (const code of codes) for (const p of ports) {
      const r = await fetch(`http://127.0.0.1:${p}/api/code/${code}`).then((x) => x.json() as Promise<any>);
      if (hosts.some((h) => h.roomId === r.roomId)) found++;
    }
    check(found === codes.length * ports.length, `every join code is found on either server (${found}/${codes.length * ports.length})`);

    // Three players join each game; with the balancer alternating, half of them land on the wrong server first.
    const guests: Room[][] = [];
    let ok = 0;
    for (let g = 0; g < hosts.length; g++) {
      guests.push([]);
      for (let n = 1; n <= 3; n++) {
        const r = await client.joinById(hosts[g].roomId, opts(`H${g}`, n)).catch(() => null);
        if (r) {
          ok++;
          quiet(r);
          guests[g].push(r);
        }
      }
    }
    check(ok === 12, `all 12 joins reach their game whichever server the connection landed on (${ok}/12)`);

    // A night in every game, played over the forwarded connections.
    const snaps = new Map<Room, number>();
    const begun = new Set<Room>();
    for (let g = 0; g < hosts.length; g++) {
      for (const r of [hosts[g], ...guests[g]]) {
        snaps.set(r, 0);
        r.onMessage(S2C.snap, () => snaps.set(r, snaps.get(r)! + 1));
        r.onMessage(S2C.begin, (_m: BeginMsg) => {
          begun.add(r);
          r.send(C2S.loaded);
        });
        r.send(C2S.ready, true);
      }
    }
    await sleep(300);
    for (const h of hosts) h.send(C2S.start);
    check(await until(() => begun.size === 16, 15000), `all four nights begin for all 16 players (${begun.size})`);
    await sleep(3000);
    const counts16 = [...snaps.values()];
    check(counts16.every((n) => n >= 40), `every player gets snapshots (fewest ${Math.min(...counts16)} in 3 s)`);

    // Chat crosses the forwarded connections both ways.
    const heard: string[] = [];
    guests[1][2].onMessage(S2C.chat, (l: ChatLine) => heard.push(l.text));
    guests[1][0].send(C2S.chat, 'anyone on the roof?');
    check(await until(() => heard.includes('anyone on the roof?')), 'chat reaches the others in the game');

    // A dropped connection comes back through the balancer (to either server).
    const dropped = guests[2][0];
    const token = dropped.reconnectionToken;
    dropped.connection.close();
    await sleep(500);
    const back = await client.reconnect(token).catch((e) => (console.log('    reconnect:', e?.message), null));
    if (back) quiet(back);
    let after = 0;
    back?.onMessage(S2C.snap, () => after++);
    check(!!back && (await until(() => after >= 5)), 'a dropped player reconnects and gets the night again');

    check(counts[0] > 0 && counts[1] > 0, `the balancer used both servers (${counts.join(' / ')} connections)`);
    const passed = (await Promise.all(ports.map(health))).map((h) => h.forwarded);
    check(passed[0] + passed[1] > 0, `connections that landed on the wrong server were passed through (${passed.join(' + ')})`);
    const logs = servers.map((s) => s.log());
    check(!logs.some((l) => /Error|error:/.test(l) && !/could not record/.test(l)), 'no errors in either server log');
    if (failures) for (const l of logs) console.log(l.split('\n').slice(-30).join('\n'));
    for (const r of [...hosts, ...guests.flat(), back]) void r?.leave();
    await sleep(300);
    lb.close();
  }
} catch (e) {
  failures++;
  console.log('  FAIL check crashed:', e);
} finally {
  for (const c of children.reverse()) c.kill('SIGINT');
  await sleep(1200);
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
