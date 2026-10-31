/**
 * End-to-end checks for online play against a real server process: hosting with a private
 * join code, the game list, joining by code, host-only start, snapshots mirrored into a
 * client's copy of the world, shooting a zombie, movement checks, the night ending, runs on
 * the leaderboards, saved survivors and solo run checks, text chat (cleaning, filter, limits,
 * blocks), the voice negotiation relay, and sign-in with Google and Discord against stand-in
 * services (accounts, sessions, folding a guest's profile in). Run with `npm run check -w server`.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from 'colyseus.js';
import {
  C2S, Mirror, NEIGHBORHOOD as map, Physics, S2C, Simulation, buildNavGridSync, createDoorBodies, initPhysics, packMotion,
  type BeginMsg, type ChatLine, type IceConfig, type LobbyMsg, type OverMsg, type RtcIn, type SimEvent, type Snapshot,
  type TalkMsg, type Vec3,
} from '@dead-hours/shared';
import { TURN_TTL, iceConfig } from '../src/net/ice';

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

/**
 * Stand-ins for Google and Discord: the token endpoint hands back the code as the access token,
 * and the user endpoint answers with the person that token names.
 */
const MOCK_PORT = 2612;
const people: Record<string, Record<string, unknown>> = {
  g1: { sub: 'google-1', email: 'Dana@Example.com', email_verified: true, name: 'Dana G' },
  d1: { id: 'discord-1', username: 'dana', global_name: 'Dana D', email: 'dana@example.com', verified: true },
  d2: { id: 'discord-2', username: 'eve', email: 'dana@example.com', verified: false },
};
const tokenCalls: string[] = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (v: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url?.endsWith('/token') && req.method === 'POST') {
      const f = new URLSearchParams(body);
      tokenCalls.push(`${f.get('client_id')}|${f.get('client_secret')}|${f.get('redirect_uri')}`);
      return people[f.get('code') ?? ''] ? json({ access_token: f.get('code'), token_type: 'Bearer' }) : json({ error: 'invalid_grant' }, 400);
    }
    if (req.url?.endsWith('/user')) {
      const who = people[(req.headers.authorization ?? '').replace('Bearer ', '')];
      return who ? json(who) : json({ error: 'unauthorized' }, 401);
    }
    json({ error: 'not found' }, 404);
  });
}).listen(MOCK_PORT);

const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env, PORT: String(PORT), DEAD_HOURS_DEBUG: '1', DATA_FILE: join(dir, 'data.json'),
    // CHECK_DATABASE_URL runs the same checks on an empty Postgres database instead of a file.
    DATABASE_URL: process.env.CHECK_DATABASE_URL ?? '',
    AUTH_GOOGLE_ID: 'gid', AUTH_GOOGLE_SECRET: 'gsecret', AUTH_DISCORD_ID: 'did', AUTH_DISCORD_SECRET: 'dsecret',
    AUTH_MOCK_URL: `http://127.0.0.1:${MOCK_PORT}`, CLIENT_ORIGINS: 'https://play.example.com', PUBLIC_URL: '', RENDER_EXTERNAL_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const api = async (path: string, init: RequestInit & { key?: string; session?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.key) headers['x-player-key'] = init.key;
  if (init.session) headers.authorization = `Bearer ${init.session}`;
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
  chat: ChatLine[] = [];
  talk: TalkMsg[] = [];
  rtc: RtcIn[] = [];
  ice: IceConfig | null = null;
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
    room.onMessage(S2C.chat, (m: ChatLine) => this.chat.push(m));
    room.onMessage(S2C.talk, (m: TalkMsg) => this.talk.push(m));
    room.onMessage(S2C.rtc, (m: RtcIn) => this.rtc.push(m));
    room.onMessage(S2C.ice, (m: IceConfig) => (this.ice = m));
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
  const wantStore = process.env.CHECK_DATABASE_URL ? 'postgres' : 'file';
  check(health.body?.ok === true && health.body?.store === wantStore, `health reports the ${wantStore} store`);
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

  section('Text chat');
  const said = (p: Player, from: Player) => p.chat.filter((l) => l.id === from.room.sessionId).map((l) => l.text);
  check(a.chat.some((l) => l.sys && l.text === 'Bravo joined'), 'the room says who joined');
  const pa = a.lobby?.players.find((p) => p.name === 'Alpha')?.pid ?? '', pb = a.lobby?.players.find((p) => p.name === 'Bravo')?.pid ?? '';
  check(/^[A-Za-z0-9_-]{12}$/.test(pa) && pa !== pb && !pa.includes('alpha'), `lobby gives each player a lasting id that isn't their key (${pa})`);
  a.room.send(C2S.chat, '  hello\u202e   there\n\u200b ');
  check(await until(() => said(b, a).length === 1), 'a chat line reaches the other player');
  const first = b.chat.find((l) => l.id === a.room.sessionId);
  check(first?.text === 'hello there' && first.name === 'Alpha' && first.pid === pa, `cleaned: direction marks, invisible and control characters, extra spaces ("${first?.text}")`);
  check(said(a, a)[0] === 'hello there', 'the sender sees their own line from the server');
  a.room.send(C2S.chat, 'what the fuck, sh1t');
  a.room.send(C2S.chat, 'x'.repeat(400));
  a.room.send(C2S.chat, { evil: true });
  check(await until(() => said(b, a).length === 3), 'lines arrive in order');
  check(said(b, a)[1] === 'what the ****, ****', `profanity is filtered on the server ("${said(b, a)[1]}")`);
  check(said(b, a)[2]?.length === 160, 'a line is cut to 160 characters');
  for (let i = 0; i < 7; i++) b.room.send(C2S.chat, `spam ${i}`);
  await sleep(400);
  check(said(a, b).length === 4, `rate limit: 4 at once, then one every 1.5 s (${said(a, b).length} of 7 delivered)`);
  check(b.chat.filter((l) => l.sys && l.text.startsWith('Slow down')).length === 1, 'the sender is told to slow down, once');
  await sleep(1600);
  b.room.send(C2S.chat, 'again');
  b.room.send(C2S.chat, 'again');
  await sleep(400);
  check(said(a, b).filter((t) => t === 'again').length === 1, 'a repeated line is dropped');

  section('Blocking');
  a.room.send(C2S.blocks, [pb, 42, '../../etc']);
  await sleep(200);
  await sleep(1600);
  const before = said(a, b).length;
  b.room.send(C2S.chat, 'can you hear me');
  a.room.send(C2S.chat, 'not you');
  await sleep(400);
  check(said(a, b).length === before, 'a blocked player\'s lines don\'t reach the blocker');
  check(!said(b, a).includes('not you'), 'and the blocker\'s lines don\'t reach them either');
  b.room.send(C2S.talk, 'near');
  b.room.send(C2S.rtc, { to: a.room.sessionId, description: { type: 'offer', sdp: 'v=0' } });
  await sleep(300);
  check(a.talk.length === 0 && a.rtc.length === 0, 'no voice or negotiation passes between them');
  a.room.send(C2S.blocks, []);
  await sleep(1600);
  b.room.send(C2S.chat, 'better now');
  check(await until(() => said(a, b).includes('better now')), 'unblocking lets lines through again');

  section('Voice negotiation');
  check(a.ice?.iceServers[0]?.urls[0] === 'stun:stun.l.google.com:19302' && a.ice.relay === false, 'joining sends the STUN server (no TURN configured)');
  a.room.send(C2S.rtc, { to: b.room.sessionId, description: { type: 'offer', sdp: 'v=0 offer' }, evil: 'x' });
  check(await until(() => b.rtc.length === 1), 'an offer is passed to the one survivor it is for');
  const offer = b.rtc[0];
  check(offer?.from === a.room.sessionId && offer.description?.sdp === 'v=0 offer' && !('evil' in offer), 'it comes from the sender\'s id, unknown fields dropped');
  a.room.send(C2S.rtc, { to: b.room.sessionId, candidate: { candidate: 'candidate:1 1 udp 2122260223 10.0.0.2 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  a.room.send(C2S.rtc, { to: b.room.sessionId, candidate: null });
  check(await until(() => b.rtc.length === 3), 'ICE candidates and the end of candidates pass');
  a.room.send(C2S.rtc, { to: b.room.sessionId, description: { type: 'evil', sdp: 'x' } });
  a.room.send(C2S.rtc, { to: b.room.sessionId, description: { type: 'offer', sdp: 'x'.repeat(13000) } });
  a.room.send(C2S.rtc, { to: a.room.sessionId, description: { type: 'offer', sdp: 'v=0' } });
  a.room.send(C2S.rtc, { to: 'nobody', description: { type: 'offer', sdp: 'v=0' } });
  await sleep(300);
  check(b.rtc.length === 3 && a.rtc.length === 0, 'malformed, oversized, self and unknown targets are dropped');
  a.room.send(C2S.talk, 'radio');
  a.room.send(C2S.talk, 'shout');
  check(await until(() => b.talk.length === 2), `talk state reaches the others (${JSON.stringify(b.talk)} ${JSON.stringify(a.talk)})`);
  check(b.talk[0]?.mode === 'radio' && b.talk[1]?.mode === null && b.talk[0].id === a.room.sessionId, 'radio passes, anything else means stopped');
  const at = 1_700_000_000_000;
  const secret = iceConfig('pid1', { TURN_URLS: 'turn:turn.example.com:3478, turns:turn.example.com:5349', TURN_SECRET: 's3cret' }, at);
  const turn = secret.iceServers[1];
  const user = `${at / 1000 + TURN_TTL}:pid1`;
  check(secret.relay && turn?.urls.length === 2 && turn.username === user && turn.credential === createHmac('sha1', 's3cret').update(user).digest('base64'),
    'TURN_SECRET gives coturn-style credentials that expire in a day');
  const fixed = iceConfig('pid1', { TURN_URLS: 'turn:t.example.com', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p', STUN_URLS: '' });
  check(fixed.relay && fixed.iceServers.length === 1 && fixed.iceServers[0].username === 'u', 'fixed TURN credentials, STUN turned off');
  check(!iceConfig('pid1', { TURN_URLS: 'turn:t.example.com' }).relay, 'a TURN address without credentials is not offered');

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
  check(board2?.survival?.[0]?.signedIn === false, 'guest runs are not marked as signed in');

  section('Sign-in accounts');
  const providers = (await api('/api/auth/providers')).body?.providers;
  check(JSON.stringify(providers) === '["google","discord"]', `both sign-ins are offered when configured (${providers})`);
  const GAME_PAGE = 'http://localhost:5173/';
  const start = (provider: string, ret: string, nonce: string) =>
    fetch(`${HTTP}/auth/${provider}/start?${new URLSearchParams({ return: ret, nonce })}`, { redirect: 'manual' });
  check((await start('google', 'https://evil.example.com/', 'n'.repeat(20))).status === 400, 'a sign-in can\'t return to another site');
  check((await start('google', GAME_PAGE, 'short')).status === 400, 'a sign-in needs a nonce');
  check((await start('github', GAME_PAGE, 'n'.repeat(20))).status === 404, 'a service that isn\'t set up is refused');
  /** Runs a whole sign-in up to the page the service returns to; returns that page and the state. */
  const signInAs = async (provider: string, person: string, nonce: string, ret = GAME_PAGE) => {
    const r = await start(provider, ret, nonce);
    const to = new URL(r.headers.get('location') ?? 'http://none/');
    const state = to.searchParams.get('state') ?? '';
    const cb = new URL(to.searchParams.get('redirect_uri') ?? 'http://none/');
    const page = await fetch(`${cb}?${new URLSearchParams({ code: person, state })}`).then((x) => x.text());
    return { redirected: r.status === 302 && to.pathname === `/${provider}/authorize`, to, cb, state, page, code: /dh_login=([A-Za-z0-9_-]+)/.exec(page)?.[1] ?? '' };
  };
  const nonceA = 'nonceA_0123456789abcdef';
  const g = await signInAs('google', 'g1', nonceA);
  check(g.redirected && g.to.searchParams.get('client_id') === 'gid' && g.to.searchParams.get('scope') === 'openid email profile', 'start sends the player to Google with the client id and scopes');
  check(g.cb.toString() === `${HTTP}/auth/google/callback`, `callback address is this server's (${g.cb})`);
  check(tokenCalls.at(-1) === `gid|gsecret|${HTTP}/auth/google/callback`, 'the code is traded with the client secret and the same callback');
  check(g.code.length > 20 && g.page.includes('postMessage') && g.page.includes('"http://localhost:5173"'), 'the return page hands a one-time code to the game page only');
  const bad = await fetch(`${g.cb}?${new URLSearchParams({ code: 'g1', state: g.state.slice(0, -2) + 'xx' })}`);
  check(bad.status === 400, 'a tampered state is refused');
  const wrong = await api('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ code: g.code, nonce: 'someoneElse_0123456789', guestKey: a.key }) });
  check(wrong.status === 401, 'a code with another sign-in\'s nonce is refused (no signing someone into your account by link)');
  const g2 = await signInAs('google', 'g1', nonceA);
  const ex = await api('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ code: g2.code, nonce: nonceA, guestKey: a.key }) });
  const session = ex.body?.session as string;
  check(ex.status === 200 && typeof session === 'string' && ex.body?.account?.name === 'Dana G', 'the code and nonce trade for a session');
  check((await api('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ code: g2.code, nonce: nonceA }) })).status === 401, 'a sign-in code works only once');
  const whoAmI = await api('/api/me', { session });
  check(whoAmI.body?.email === 'dana@example.com' && JSON.stringify(whoAmI.body?.providers) === '["google"]', 'the session knows who is signed in');
  const acctProfile = await api('/api/profile', { session });
  check(acctProfile.body?.name === 'Alpha One b' && acctProfile.body?.stats?.runs === got.body?.stats?.runs && acctProfile.body?.stats?.kills === 1,
    'the guest\'s browser survivor and stats became the account\'s');
  check((await api('/api/profile', { key: a.key })).status === 404, 'and are no longer under the old browser key');
  const charlieBefore = (await api('/api/profile', { key: c.key })).body;
  const nonceB = 'nonceB_0123456789abcdef';
  const d = await signInAs('discord', 'd1', nonceB);
  check(d.redirected && d.to.searchParams.get('scope') === 'identify email', 'Discord sign-in asks for identity and email');
  const ex2 = await api('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ code: d.code, nonce: nonceB, guestKey: c.key }) });
  check(ex2.body?.account?.id === ex.body?.account?.id && JSON.stringify(ex2.body?.account?.providers) === '["discord","google"]',
    'Discord with the same verified email signs in to the same account');
  const merged = (await api('/api/profile', { session: ex2.body?.session })).body;
  check(merged?.stats?.runs === acctProfile.body.stats.runs + charlieBefore.stats.runs && merged?.stats?.bestSurvived === 300 && merged?.name === 'Alpha One b',
    'a second guest profile is folded in: totals add up, bests keep the better, the account\'s survivor stays');
  const d2 = await signInAs('discord', 'd2', 'nonceC_0123456789abcdef');
  const ex3 = await api('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ code: d2.code, nonce: 'nonceC_0123456789abcdef' }) });
  check(ex3.status === 200 && ex3.body?.account?.id !== ex.body?.account?.id, 'an unverified email does not join an existing account');
  const board3 = (await api('/api/leaderboard')).body;
  check(board3?.survival?.[0]?.name === 'Alpha One b' && board3.survival[0].signedIn === true, 'boards mark signed-in players');
  const saveAcct = await api('/api/profile', { method: 'PUT', session, body: JSON.stringify({ name: 'Dana', appearance: '', primary: 'ar' }) });
  check(saveAcct.status === 200 && (await api('/api/profile', { session: ex2.body?.session })).body?.name === 'Dana', 'saving while signed in saves the account\'s survivor (seen from the other session)');
  const sessionRoom = await client.create('survival', { name: 'Dana', primary: 'ar', appearance: '', session, private: true });
  check(!!sessionRoom.sessionId, 'a signed-in player joins a room with their session');
  await sessionRoom.leave();
  const cancelled = await signInAs('google', 'nobody', 'nonceD_0123456789abcdef');
  check(cancelled.page.includes('dh_login_error=failed') && !cancelled.code, 'a sign-in the service won\'t confirm comes back as failed');
  const cb = `${g.cb}?${new URLSearchParams({ error: 'access_denied', state: g2.state })}`;
  check((await fetch(cb).then((x) => x.text())).includes('dh_login_error=cancelled'), 'cancelling at the service comes back as cancelled');
  const prod = await signInAs('google', 'g1', 'nonceE_0123456789abcdef', 'https://play.example.com/');
  check(!!prod.code && prod.page.includes('"https://play.example.com"'), 'a listed game site (CLIENT_ORIGINS) can sign in');
  check((await api('/api/auth/logout', { method: 'POST', session })).status === 200 && (await api('/api/me', { session })).status === 401, 'signing out ends the session');
  check((await api('/api/me', { session: ex2.body?.session })).status === 200, 'other sessions of the account stay signed in');
} catch (e) {
  failures++;
  console.log('  FAIL threw:', e);
} finally {
  server.kill('SIGTERM');
  mock.close();
}
await sleep(300);
if (failures) console.log(serverLog.split('\n').slice(-30).join('\n'));
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
