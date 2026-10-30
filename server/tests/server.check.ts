/**
 * End-to-end checks for online play against a real server process: hosting with a private
 * join code, the game list, joining by code, host-only start, snapshots mirrored into a
 * client's copy of the world, shooting a zombie, movement checks, the night ending, runs on
 * the leaderboards, saved survivors and solo run checks. Run with `npm run check -w server`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from 'colyseus.js';
import {
  C2S, Mirror, NEIGHBORHOOD as map, Physics, S2C, Simulation, buildNavGridSync, createDoorBodies, initPhysics, packMotion,
  type BeginMsg, type LobbyMsg, type OverMsg, type SimEvent, type Snapshot, type Vec3,
} from '@dead-hours/shared';

let failures = 0;
let passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}

const PORT = 2611;
const HTTP = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'dh-check-'));
const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), DEAD_HOURS_DEBUG: '1', DATA_FILE: join(dir, 'data.json'), DATABASE_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const api = async (path: string, init: RequestInit & { key?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.key) headers['x-player-key'] = init.key;
  const r = await fetch(HTTP + path, { ...init, headers });
  return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers };
};

/** One player's connection, with everything the server sent. */
class Player {
  room!: Room;
  lobby: LobbyMsg | null = null;
  begin: BeginMsg | null = null;
  snaps: Snapshot[] = [];
  events: SimEvent[] = [];
  over: OverMsg | null = null;
  notices: string[] = [];
  corrections: Vec3[] = [];
  pongs = 0;
  /** Says the scene is up as soon as the night begins (a browser does once it has drawn it). */
  autoLoad = true;
  constructor(readonly name: string, readonly key: string) {}
  attach(room: Room): this {
    this.room = room;
    room.onMessage(S2C.lobby, (m: LobbyMsg) => (this.lobby = m));
    room.onMessage(S2C.begin, (m: BeginMsg) => {
      this.begin = m;
      if (this.autoLoad) room.send(C2S.loaded);
    });
    room.onMessage(S2C.snap, (m: Snapshot) => this.snaps.push(m));
    room.onMessage(S2C.ev, (m: SimEvent[]) => this.events.push(...m));
    room.onMessage(S2C.over, (m: OverMsg) => (this.over = m));
    room.onMessage(S2C.notice, (m: string) => this.notices.push(m));
    room.onMessage(S2C.pos, (m: Vec3) => this.corrections.push(m));
    room.onMessage(S2C.pong, () => this.pongs++);
    return this;
  }
  get options() {
    return { name: this.name, primary: 'ar', appearance: '', token: this.key };
  }
}

try {
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    up = await fetch(`${HTTP}/health`).then((r) => r.ok, () => false);
    if (!up) await sleep(100);
  }
  section('Server');
  check(up, 'server starts and answers /health');
  const health = await api('/health');
  check(health.body?.ok === true && health.body?.store === 'file', 'health reports the file store when DATABASE_URL is unset');
  const pre = await fetch(`${HTTP}/api/rooms`, { method: 'OPTIONS', headers: { origin: 'https://play.example.com' } });
  check(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'API answers cross-origin preflight');
  const mm = await fetch(`${HTTP}/matchmake/joinOrCreate/nothing`, { method: 'OPTIONS', headers: { origin: 'https://play.example.com' } });
  check(mm.headers.get('access-control-allow-origin') === 'https://play.example.com', 'matchmaking allows the game site\'s origin');

  section('Hosting');
  const client = new Client(`ws://127.0.0.1:${PORT}`);
  const a = new Player('Alpha', 'alphaKEY_0123456789abcdef');
  const b = new Player('Bravo', 'bravoKEY_0123456789abcdef');
  const c = new Player('Charlie', 'charlieKEY_0123456789abc');
  a.attach(await client.create('survival', { ...a.options, lobbyName: 'Test house', private: true }));
  check(await until(() => !!a.lobby), 'host gets the lobby');
  const code = a.lobby?.code ?? '';
  check(/^[A-HJ-NP-Z2-9]{5}$/.test(code), `room has a 5-character join code (${code})`);
  check(a.lobby?.host === a.room.sessionId && a.lobby?.name === 'Test house', 'creator hosts, lobby name kept');
  check((await api('/api/rooms')).body?.length === 0, 'a private room stays off the game list');
  const byCode = await api(`/api/code/${code.toLowerCase().split('').join(' ')}`);
  check(byCode.body?.roomId === a.room.roomId, 'join code finds the room (any case, spaces ignored)');
  check((await api('/api/code/ZZZZZ')).status === 404, 'unknown code is refused');
  b.attach(await client.joinById(byCode.body.roomId, b.options));
  check(await until(() => a.lobby?.players.length === 2 && b.lobby?.players.length === 2), 'both see two survivors in the lobby');
  b.room.send(C2S.ready, true);
  check(await until(() => !!a.lobby?.players.find((p) => p.name === 'Bravo')?.ready), 'ready shows for everyone');
  const pub = client.create('survival', { ...c.options, lobbyName: 'Open house' });
  c.attach(await pub);
  await until(() => !!c.lobby);
  const list = (await api('/api/rooms')).body;
  check(list?.length === 1 && list[0].name === 'Open house' && list[0].status === 'lobby' && list[0].players === 1 && list[0].host === 'Charlie', 'a public room is listed with host, players and status');
  await c.room.leave();
  check(await until(() => true, 300) && (await api('/api/rooms')).body?.length === 0, 'an empty room closes');

  section('Starting the night');
  b.room.send(C2S.start);
  check(await until(() => b.notices.length > 0), 'only the host can start');
  b.autoLoad = false;
  a.room.send(C2S.start);
  check(await until(() => !!a.begin && !!b.begin), 'both get the begin message');
  check(!!a.begin && !!b.begin && (a.begin.spawn.x !== b.begin.spawn.x || a.begin.spawn.z !== b.begin.spawn.z), 'survivors start at different spawns');
  check(await until(() => a.lobby?.status === 'playing'), 'lobby shows the night under way');
  const joinLate = await client.joinById(a.room.roomId, { name: 'Late' }).then(() => true, () => false);
  check(!joinLate, 'nobody joins mid-night');

  // A's copy of the world.
  await initPhysics();
  const physics = new Physics(map);
  const doors = createDoorBodies(map, physics);
  const nav = buildNavGridSync(physics, map);
  const puppet = new Simulation({ physics, map, nav, doors, seed: a.begin!.seed });
  const mirror = new Mirror(puppet, a.room.sessionId);
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const spawnA = a.begin!.spawn;
  puppet.addPlayer(a.room.sessionId, 'Alpha', 'ar', 'pistol', spawnA, spawnA.yaw);
  let applied = 0;
  const pump = () => {
    while (applied < a.snaps.length) mirror.apply(a.snaps[applied++], now());
    mirror.tick(now());
  };
  check(await until(() => a.snaps.length >= 10, 3000), 'snapshots arrive (~20 a second)');
  check(b.snaps.length === 0 && b.events.length === 0, 'nothing streams to a survivor still building the scene');
  b.room.send(C2S.loaded);
  b.autoLoad = true;
  check(await until(() => b.snaps.length > 0), 'snapshots start once their scene is up');
  pump();
  check(puppet.players.size === 2 && puppet.players.has(b.room.sessionId), 'mirror has both survivors');
  check(puppet.phase === 'preparation' && puppet.phaseTime > 40, `mirror shows the preparation clock (${puppet.phaseTime.toFixed(1)} s)`);
  check(puppet.interactables.filter(Boolean).length > 3, 'mirror has the crates, first aid and weapon table');
  const t1 = puppet.time;
  await sleep(300);
  pump();
  check(puppet.time - t1 > 0.2 && puppet.time - t1 < 0.4, 'mirror clock follows the server');
  a.room.send(C2S.ping, 1);
  check(await until(() => a.pongs > 0), 'ping is answered');

  section('Moving');
  const me = puppet.players.get(a.room.sessionId)!;
  const motion = (pos: Vec3, trigger = false, aimO: Vec3 = { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimD: Vec3 = { x: 0, y: 0, z: 1 }) => packMotion({
    motion: { pos, vel: { x: 0, y: 0, z: 0 }, yaw: spawnA.yaw, pitch: 0, eyeHeight: 1.6, crouching: false, sprinting: false, aiming: false, grounded: true },
    facing: 0, trigger, aimOrigin: aimO, aimDir: aimD,
  });
  let pos = { x: spawnA.x, y: spawnA.y, z: spawnA.z };
  for (let i = 0; i < 15; i++) {
    pos = { ...pos, x: pos.x - 0.1 };
    a.room.send(C2S.motion, motion(pos));
    await sleep(33);
  }
  await sleep(200);
  pump();
  const bView = new Mirror(new Simulation({ physics, map, nav, doors, seed: 1 }), b.room.sessionId);
  for (const s of b.snaps) bView.apply(s, now());
  const seenByB = bView.sim.players.get(a.room.sessionId)!.motion.pos;
  check(Math.abs(seenByB.x - pos.x) < 0.05, `the other survivor sees the walk (${seenByB.x.toFixed(2)} vs ${pos.x.toFixed(2)})`);
  check(a.corrections.length === 0, 'a normal walk is accepted');
  a.room.send(C2S.motion, motion({ x: pos.x + 30, y: pos.y, z: pos.z }));
  check(await until(() => a.corrections.length === 1), 'a jump of 30 m is refused and the survivor put back');
  check(Math.hypot(a.corrections[0].x - pos.x, a.corrections[0].z - pos.z) < 0.05, 'put back where the server last had them');
  a.room.send(C2S.motion, motion({ x: pos.x + 0.05, y: pos.y, z: pos.z }));
  await sleep(150);
  check(a.corrections.length === 1, 'moves from the corrected spot are accepted again');
  pos = { x: pos.x + 0.05, y: pos.y, z: pos.z };
  // Straight through the safehouse's back wall.
  const wallStart = { ...pos };
  let refused = false;
  for (let i = 0; i < 40 && !refused; i++) {
    pos = { ...pos, z: pos.z - 0.2 };
    a.room.send(C2S.motion, motion(pos));
    await sleep(35);
    refused = a.corrections.length > 1;
  }
  check(refused, `walking through a wall is refused (from z ${wallStart.z.toFixed(1)})`);
  pos = a.corrections[a.corrections.length - 1] ?? wallStart;
  a.room.send(C2S.motion, motion(pos));
  await sleep(100);

  section('Fighting');
  a.room.send(C2S.debug, { cmd: 'skipPreparation' });
  check(await until(() => a.events.some((e) => e.type === 'phase' && e.phase === 'survival')), 'outbreak begins (event to every client)');
  a.room.send(C2S.debug, { cmd: 'spawn', dist: 2.5, angle: 0, kind: 'walker' });
  await until(() => { pump(); return puppet.zombies.length > 0; }, 3000);
  check(puppet.zombies.length === 1, 'a zombie appears in the mirror');
  const z = puppet.zombies[0];
  const eye = { x: pos.x, y: pos.y + 1.6, z: pos.z };
  let killed = false;
  for (let i = 0; i < 40 && !killed; i++) {
    pump();
    const zz = puppet.zombies[0];
    if (!zz) break;
    const head = { x: zz.pos.x - eye.x, y: zz.pos.y + 1.2 - eye.y, z: zz.pos.z - eye.z };
    const l = Math.hypot(head.x, head.y, head.z);
    a.room.send(C2S.act, { a: 'fire', o: eye, d: { x: head.x / l, y: head.y / l, z: head.z / l } });
    await sleep(140);
    killed = a.events.some((e) => e.type === 'zombieDied');
  }
  check(a.events.some((e) => e.type === 'shot' && e.player === a.room.sessionId), 'shots are fired on the server');
  check(a.events.some((e) => e.type === 'zombieHit' && e.by === a.room.sessionId), 'shots hit the zombie');
  check(killed, 'the zombie dies');
  check(b.events.some((e) => e.type === 'zombieDied'), 'the other survivor gets the kill event too');
  await sleep(200);
  pump();
  check(!puppet.zombies.includes(z), 'the dead zombie leaves the mirror');
  check(me.stats.kills === 1 && me.stats.shotsFired > 0, `kills and shots come through snapshots (${me.stats.kills} kill, ${me.stats.shotsFired} shots)`);
  check(me.arsenal.weapon.mag < 30, `magazine count follows the server (${me.arsenal.weapon.mag})`);
  a.room.send(C2S.act, { a: 'reload' });
  check(await until(() => a.events.some((e) => e.type === 'reload' && e.stage === 'start')), 'reload starts');
  a.room.send(C2S.act, { a: 'nonsense', x: 1 });
  a.room.send(C2S.act, { a: 'use', id: 'x' });
  a.room.send(C2S.motion, [1, 2, 3]);
  a.room.send(C2S.act, null);
  await sleep(100);
  check(server.exitCode === null, 'malformed messages are ignored');

  section('Dropped connections');
  const token = b.room.reconnectionToken;
  const bId = b.room.sessionId;
  b.room.connection.close();
  await sleep(500);
  check(serverLog.includes('Bravo lost connection'), 'a dropped survivor keeps their place for a while');
  const back = await client.reconnect(token).then((r) => r, () => null);
  check(!!back && back.sessionId === bId, 'they reconnect as the same survivor');
  if (back) {
    b.attach(back);
    const had = b.snaps.length;
    check(await until(() => b.snaps.length > had), 'snapshots resume after reconnecting');
  }

  section('The night ends');
  a.room.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  check(await until(() => a.events.some((e) => e.type === 'playerDied' && e.player === a.room.sessionId)), 'first survivor dies');
  check(!a.over, 'the night goes on while anyone is alive');
  await sleep(1100);
  b.room.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  check(await until(() => !!a.over && !!b.over), 'everyone dead: both get the results');
  const res = a.over?.results ?? [];
  const ra = res.find((r) => r.name === 'Alpha'), rb = res.find((r) => r.name === 'Bravo');
  check(!!ra && !!rb && ra.stats.kills === 1, 'results list both survivors with their kills');
  check(!!ra && !!rb && rb.survived > ra.survived && ra.survived > 0, `survival times differ by when they fell (${ra?.survived.toFixed(1)} s, ${rb?.survived.toFixed(1)} s)`);
  check(ra?.rankKills === 1 && rb?.rankSurvival === 1, 'leaderboard places come back with the results');
  check(ra?.rankSurvival === 2, `places are counted once every run is in (first to fall: #${ra?.rankSurvival} longest survival)`);
  check(rb?.rankKills === null, 'no kills, no place on the kills board');
  check(await until(() => a.lobby?.status === 'lobby'), 'room is back in the lobby');
  const board = (await api('/api/leaderboard')).body;
  check(board?.survival?.[0]?.name === 'Bravo' && board.survival[0].mode === 'online', 'longest survival board has the online run');
  check(board?.kills?.[0]?.name === 'Alpha' && board.kills[0].value === 1, 'most kills board has the kill');
  a.room.send(C2S.start);
  check(await until(() => a.begin !== null && a.lobby?.status === 'playing'), 'host can start another night');
  await a.room.leave();
  check(await until(() => b.lobby?.host === b.room.sessionId), 'host leaves: the other survivor hosts');
  await b.room.leave();

  section('Saved survivors and solo runs');
  check((await api('/api/profile', { key: 'nobodyKEY_0123456789abcd' })).status === 404, 'no profile before saving');
  const saved = await api('/api/profile', { method: 'PUT', key: a.key, body: JSON.stringify({ name: '  Alpha  One <b>', appearance: 'garbage', primary: 'shotgun' }) });
  check(saved.status === 200 && saved.body?.name === 'Alpha One b' && saved.body?.primary === 'shotgun', 'profile saves (name cleaned)');
  const got = await api('/api/profile', { key: a.key });
  check(got.body?.stats?.runs === 1 && got.body?.stats?.kills === 1 && got.body?.rankKills === 1, 'profile carries run totals and ranks');
  check((await api('/api/profile', { method: 'PUT', body: '{}' })).status === 400, 'saving needs a player key');
  const solo = (survived: number, kills: number) => api('/api/runs', {
    method: 'POST', key: c.key,
    body: JSON.stringify({ name: 'Charlie', appearance: '', survived, stats: { kills, headshots: 0, shotsFired: kills * 3, shotsHit: kills, damageDealt: kills * 50, suppliesCollected: 1, damageTaken: 100, limbsSevered: 0, limbKills: 0 } }),
  });
  check((await solo(10, 400)).status === 422, 'an impossible solo run is refused');
  const ok = await solo(300, 40);
  check(ok.status === 200 && ok.body?.rankSurvival === 1, 'a plausible solo run is ranked');
  check((await solo(320, 41)).status === 429, 'runs can\'t be posted back to back');
  const board2 = (await api('/api/leaderboard')).body;
  check(board2?.survival?.[0]?.name === 'Charlie' && board2.survival[0].mode === 'solo', 'solo runs are marked solo on the board');
} catch (e) {
  failures++;
  console.log('  FAIL threw:', e);
} finally {
  server.kill('SIGTERM');
}
await sleep(300);
if (failures) console.log(serverLog.split('\n').slice(-30).join('\n'));
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
