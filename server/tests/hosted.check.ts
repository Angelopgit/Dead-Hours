/**
 * End-to-end checks for player-hosted games against a real server process. The night runs in
 * this process, in the same DeviceNight the worker in a host's browser runs, and reaches the
 * other players only through the room on the server: hosting while the server's own games are
 * full, the version check, who the room listens to, the relay both ways (snapshots, events,
 * moves, corrections, pings), fighting, dropping in and leaving, a dropped guest coming back,
 * the night ending with HOSTED runs on the boards, counts a host made up, the host leaving
 * mid-night, and the host's place passing on. Run with `npm run check:hosted`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from 'colyseus.js';
import {
  C2S, DeviceNight, GAME, HOST_IN, HOST_PROGRESS_MS, Mirror, ROOMS, S2C, SERVERS_FULL, Simulation, VERSION_MISMATCH, packMotion,
  type BeginMsg, type ChatLine, type HostDown, type HostUp, type LobbyMsg, type OverMsg, type RoomListing, type SeenMsg, type SimEvent,
  type Snapshot, type Vec3,
} from '@dead-hours/shared';
import { saneEvents, saneSnapshot } from '../../client/src/network/host/sane';
import { createWorld, initWorld } from '../src/game/world';

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
async function untilAsync(fn: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(100);
  }
  return fn();
}

const PORT = 2621;
const HTTP = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'dh-hosted-'));

// One game of its own is all this server will run: player-hosted games must not need a place.
const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), DEAD_HOURS_DEBUG: '1', MAX_ROOMS: '1', DATA_FILE: join(dir, 'data.json'), DATABASE_URL: '', REDIS_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const api = async (path: string) => {
  const r = await fetch(HTTP + path);
  return (await r.json().catch(() => null)) as any;
};

/** One player's connection, with everything that reached them. */
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
  /** What the room sent down for the night (only a host gets any). */
  down: HostDown[] = [];
  /** Snapshots and event lists that would not pass a guest's shape checks. */
  insane = 0;
  /** The night, while this player hosts it here (what the worker is in a browser). */
  night: DeviceNight | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(readonly name: string, readonly key: string, readonly canHost = true) {}

  attach(room: Room): this {
    this.room = room;
    room.onMessage(S2C.lobby, (m: LobbyMsg) => (this.lobby = m));
    for (const type of [S2C.begin, S2C.snap, S2C.ev, S2C.pos, S2C.vpos, S2C.pong]) room.onMessage(type, (m: unknown) => this.take(type, m));
    room.onMessage(S2C.over, (m: OverMsg) => (this.over = m));
    room.onMessage(S2C.notice, (m: string) => this.notices.push(m));
    room.onMessage(S2C.chat, (m: ChatLine) => this.chat.push(m));
    room.onMessage(S2C.ice, () => undefined);
    room.onMessage(S2C.host, (m: HostDown) => {
      this.down.push(m);
      // As NetLink does: a guest's ping is answered on the page, the rest goes to the night.
      if (m.k === 'in' && m.t === C2S.ping) room.send(C2S.host, { k: 'out', to: [m.from], t: S2C.pong, m: m.m } satisfies HostUp);
      else this.night?.down(m);
    });
    return this;
  }

  /** One of the night's messages: from the room, or (hosting) straight from the night here. */
  private take(type: string, m: unknown): void {
    if (type === S2C.begin) {
      this.begin = m as BeginMsg;
      this.send(C2S.loaded);
    } else if (type === S2C.snap) {
      if (!saneSnapshot(m)) this.insane++;
      this.snaps.push(m as Snapshot);
    } else if (type === S2C.ev) {
      if (!saneEvents(m)) this.insane++;
      this.events.push(...(m as SimEvent[]));
    } else if (type === S2C.pos) this.corrections.push(m as Vec3);
    else if (type === S2C.pong) this.pongs++;
  }

  /** Runs the nights of this player's game here, the way a host's browser does. */
  host(): this {
    const id = this.room.sessionId;
    this.night = new DeviceNight(createWorld, (up) => {
      if (up.k !== 'out') {
        this.room.send(C2S.host, up);
        return;
      }
      const rest = up.to.filter((to) => to !== id);
      if (rest.length) this.room.send(C2S.host, { ...up, to: rest } satisfies HostUp);
      if (rest.length !== up.to.length) this.take(up.t, up.m);
    });
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.night?.tick(now - last);
      last = now;
    }, 1000 / 60);
    return this;
  }

  /** A message about the night: a host's own go straight to the night, everyone else's to the room. */
  send(type: string, msg?: unknown): void {
    if (this.night && HOST_IN.includes(type)) this.night.down({ k: 'in', from: this.room.sessionId, t: type, m: msg });
    else this.room.send(type, msg);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.night?.dispose();
    this.night = null;
  }

  get id(): string {
    return this.room.sessionId;
  }

  get options() {
    return { name: this.name, primary: 'ar', appearance: '', token: this.key, v: GAME.version, canHost: this.canHost };
  }
}

const hosts: Player[] = [];
try {
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    up = await fetch(`${HTTP}/health`).then((r) => r.ok, () => false);
    if (!up) await sleep(100);
  }
  await initWorld();
  const client = new Client(`ws://127.0.0.1:${PORT}`);
  const said = (p: Player, text: string) => p.chat.some((l) => !!l.sys && l.text === text);
  const motionAt = (pos: Vec3, yaw: number) => packMotion({
    motion: { pos, vel: { x: 0, y: 0, z: 0 }, yaw, pitch: 0, eyeHeight: 1.6, crouching: false, sprinting: false, aiming: false, grounded: true },
    facing: 0, trigger: false, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: 0, y: 0, z: 1 },
  });

  section('Hosting on a full server');
  check(up, 'server starts');
  const filler = new Player('Filler', 'fillerKEY_0123456789abcde');
  filler.attach(await client.create(ROOMS.survival, { ...filler.options, private: true }));
  const full = await client.create(ROOMS.survival, { ...filler.options, private: true }).then(() => null, (e: { code?: number }) => e);
  check(full?.code === SERVERS_FULL, `the server's own games are full (refused with ${full?.code})`);
  const a = new Player('Alpha', 'alphaKEY_0123456789abcdef');
  const b = new Player('Bravo', 'bravoKEY_0123456789abcdef');
  a.attach(await client.create(ROOMS.hosted, { ...a.options, lobbyName: 'Porch light' }));
  hosts.push(a.host());
  check(await until(() => !!a.lobby), 'a player-hosted game opens all the same');
  check(a.lobby?.hosting === 'player' && a.lobby.host === a.id, 'the lobby says its host runs the nights');
  const health = await api('/health');
  check(health?.games === 1 && health.maxGames === 1, `it takes none of the server's places (${health?.games} of ${health?.maxGames})`);
  const listed = ((await api('/api/rooms')) as RoomListing[]).find((r) => r.roomId === a.room.roomId);
  check(listed?.hosting === 'player' && listed.name === 'Porch light', 'the game list marks it as hosted by a player');

  section('Who gets in, and who the room listens to');
  const old = await client.joinById(a.room.roomId, { ...b.options, v: '0.0.1' }).then(() => null, (e: { code?: number }) => e);
  check(old?.code === VERSION_MISMATCH, `another version of the game is refused (${old?.code})`);
  b.attach(await client.joinById(a.room.roomId, b.options));
  check(await until(() => a.lobby?.players.length === 2 && b.lobby?.hosting === 'player'), 'the same version joins');
  b.room.send(C2S.start);
  check(await until(() => b.notices.length > 0) && !a.down.length, 'only the host can start');
  b.room.send(C2S.host, { k: 'out', to: [a.id], t: S2C.begin, m: { seed: 1, t: 0, spawn: { x: 0, y: 0, z: 0, yaw: 0 } } } satisfies HostUp);
  b.room.send(C2S.host, { k: 'over', runs: [], hordes: 9 } satisfies HostUp);
  await sleep(200);
  check(!a.begin && !a.over && a.lobby?.status === 'lobby', 'night messages from anyone but the host go nowhere');
  a.room.send(C2S.host, { k: 'out', to: [b.id], t: S2C.begin, m: { seed: 1, t: 0, spawn: { x: 0, y: 0, z: 0, yaw: 0 } } } satisfies HostUp);
  await sleep(200);
  check(!b.begin, 'nor the host\'s own while no night is on');

  section('Starting the night');
  a.room.send(C2S.start);
  check(await until(() => a.down.some((m) => m.k === 'start')), 'the room hands the night to the host');
  const started = a.down.find((m) => m.k === 'start');
  check(started?.k === 'start' && started.members.length === 2 && started.debug === true && Number.isFinite(started.seed), 'with the seed and both survivors');
  check(await until(() => !!a.begin && !!b.begin), 'both get the begin message');
  check(!!a.begin && !!b.begin && a.begin.seed === b.begin.seed && (a.begin.spawn.x !== b.begin.spawn.x || a.begin.spawn.z !== b.begin.spawn.z), 'the same night, at different spawns');
  check(await until(() => b.lobby?.status === 'playing'), 'lobby shows the night under way');
  check(await until(() => a.snaps.length >= 10 && b.snaps.length >= 10, 3000), 'snapshots reach the host from its own night and the guest through the room');
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const world = createWorld();
  const view = new Mirror(new Simulation({ ...world, seed: b.begin!.seed }), b.id);
  view.sim.addPlayer(b.id, 'Bravo', 'ar', 'pistol', b.begin!.spawn, b.begin!.spawn.yaw);
  let applied = 0;
  const pump = () => {
    while (applied < b.snaps.length) view.apply(b.snaps[applied++], now());
    view.tick(now());
  };
  pump();
  check(view.sim.players.size === 2 && view.sim.players.has(a.id), 'the guest\'s copy of the world has both survivors');
  check(view.sim.phase === 'preparation' && view.sim.phaseTime > 40, `and the preparation clock (${view.sim.phaseTime.toFixed(1)} s)`);
  const had = b.snaps.length;
  await sleep(1000);
  const rate = b.snaps.length - had;
  check(rate >= 17 && rate <= 23, `the guest gets about 20 snapshots a second (${rate})`);
  b.room.send(C2S.ping, 7);
  check(await until(() => b.pongs > 0) && a.down.some((m) => m.k === 'in' && m.t === C2S.ping), 'a guest\'s ping goes round by the host');

  section('Moving');
  const spawnB = b.begin!.spawn;
  let pos = { x: spawnB.x, y: spawnB.y, z: spawnB.z };
  for (let i = 0; i < 15; i++) {
    pos = { ...pos, x: pos.x - 0.1 };
    b.send(C2S.motion, motionAt(pos, spawnB.yaw));
    await sleep(33);
  }
  await sleep(250);
  const hostView = new Mirror(new Simulation({ ...createWorld(), seed: 1 }), a.id);
  for (const s of a.snaps) hostView.apply(s, now());
  const seenByHost = hostView.sim.players.get(b.id)!.motion.pos;
  check(Math.abs(seenByHost.x - pos.x) < 0.05, `the host's night has the guest's walk (${seenByHost.x.toFixed(2)} vs ${pos.x.toFixed(2)})`);
  check(b.corrections.length === 0, 'a normal walk is accepted');
  b.send(C2S.motion, motionAt({ x: pos.x + 30, y: pos.y, z: pos.z }, spawnB.yaw));
  check(await until(() => b.corrections.length === 1), 'a jump of 30 m is refused by the host\'s night and the guest put back');
  check(!!b.corrections[0] && Math.hypot(b.corrections[0].x - pos.x, b.corrections[0].z - pos.z) < 0.05, 'put back where the night last had them');
  const before = a.down.length;
  for (let i = 0; i < 1500; i++) b.send(C2S.motion, motionAt(pos, spawnB.yaw));
  await sleep(400);
  const through = a.down.length - before;
  check(through > 100 && through < 400, `a flood of moves is held back by the room (${through} of 1500 passed on)`);
  await sleep(1200);

  section('Fighting');
  b.send(C2S.debug, { cmd: 'skipPreparation' });
  check(await until(() => a.events.some((e) => e.type === 'phase' && e.phase === 'survival') && b.events.some((e) => e.type === 'phase' && e.phase === 'survival')), 'outbreak begins for both');
  b.send(C2S.motion, motionAt(pos, spawnB.yaw));
  // Behind the guest, in the room with them. Straight ahead (angle 0) is the house wall, 1.8 m off: the zombie rose
  // in the yard and every shot hit the wall until it wandered past the window, which a busy machine did not always
  // see happen before the magazine ran out.
  b.send(C2S.debug, { cmd: 'spawn', dist: 2.5, angle: Math.PI, kind: 'walker' });
  await until(() => { pump(); return view.sim.zombies.length > 0; }, 3000);
  check(view.sim.zombies.length === 1, 'a zombie appears in the guest\'s copy');
  const eye = { x: pos.x, y: pos.y + 1.6, z: pos.z };
  let killed = false;
  for (let i = 0; i < 40 && !killed; i++) {
    pump();
    const z = view.sim.zombies[0];
    if (!z) break;
    const head = { x: z.pos.x - eye.x, y: z.pos.y + 1.2 - eye.y, z: z.pos.z - eye.z };
    const l = Math.hypot(head.x, head.y, head.z);
    b.send(C2S.act, { a: 'fire', o: eye, d: { x: head.x / l, y: head.y / l, z: head.z / l } });
    await sleep(140);
    killed = b.events.some((e) => e.type === 'zombieDied');
  }
  check(b.events.some((e) => e.type === 'shot' && e.player === b.id), 'the guest\'s shots are fired in the host\'s night');
  check(killed && a.events.some((e) => e.type === 'zombieDied'), 'the zombie dies, for both');
  await sleep(200);
  pump();
  const me = view.sim.players.get(b.id)!;
  check(me.stats.kills === 1 && me.stats.shotsFired > 0, `the kill and the shots come back in snapshots (${me.stats.kills} kill, ${me.stats.shotsFired} shots)`);
  check(a.insane === 0 && b.insane === 0, `every snapshot and event list passes a guest's shape checks (${b.snaps.length} snapshots, ${b.events.length} events)`);
  b.send(C2S.act, { a: 'nonsense', x: 1 });
  b.send(C2S.motion, [1, 2, 3]);
  b.send(C2S.act, null);
  b.room.send(C2S.host, null);
  a.room.send(C2S.host, { k: 'out', to: 'everyone', t: S2C.snap });
  a.room.send(C2S.host, { k: 'out', to: [b.id], t: S2C.over, m: { results: [], hordes: 0 } });
  a.room.send(C2S.host, { k: 'out', to: [b.id], t: S2C.chat, m: { id: '', pid: '', name: '', text: 'made up', sys: true } });
  await sleep(200);
  check(server.exitCode === null && !!a.night?.playing && !b.over && !b.chat.some((l) => l.text === 'made up'), 'malformed messages are ignored, and a host can only pass on the night\'s own kinds');

  section('Dropping in, leaving, and a dropped connection');
  const late = new Player('Late', 'lateKEY_0123456789abcdefg');
  late.attach(await client.joinById(a.room.roomId, late.options));
  check(await until(() => !!late.begin), 'a friend can drop into the night under way');
  check(late.begin?.late === true && late.begin.seed === a.begin!.seed && a.down.some((m) => m.k === 'join'), 'the host\'s night takes them in, marked as joined late');
  check(await until(() => late.snaps.at(-1)?.p.length === 3), 'they are in the night beside the others');
  check(await until(() => said(b, 'Late joined the night')), 'the others are told someone dropped in');
  const token = b.room.reconnectionToken;
  b.room.connection.close();
  await sleep(500);
  check(serverLog.includes('Bravo lost connection'), 'a dropped guest keeps their place for a while');
  const back = await client.reconnect(token).then((r) => r, () => null);
  check(!!back && back.sessionId === b.id, 'they reconnect as the same survivor');
  if (back) {
    b.attach(back);
    const n = b.snaps.length;
    check(await until(() => b.snaps.length > n), 'snapshots resume after reconnecting');
  }
  const hostToken = a.room.reconnectionToken;
  // (As NetLink does: nobody can reach the night meanwhile, so it waits.)
  a.night!.pause(true);
  a.room.connection.close();
  await sleep(500);
  const stalled = b.snaps.length;
  await sleep(500);
  check(serverLog.includes('Alpha lost connection') && b.snaps.length === stalled && b.lobby?.status === 'playing', 'a host whose connection drops keeps their place, and the night waits');
  const hostBack = await client.reconnect(hostToken).then((r) => r, () => null);
  if (hostBack) {
    a.attach(hostBack);
    a.night!.pause(false);
  }
  check(!!hostBack && hostBack.sessionId === a.id && await until(() => b.snaps.length > stalled + 5), 'the host reconnects and the night goes on for everyone');
  // What each browser sees, for the room to hold the host's count against.
  const seen = (p: Player): SeenMsg => {
    const s = p.snaps.at(-1)!;
    return { survived: s.ph === 1 ? s.pt / 1000 : 0, kills: s.p.flatMap((x) => [x.id, x.s.kills]) };
  };
  await sleep(HOST_PROGRESS_MS + 300);
  late.room.send(C2S.seen, seen(late));
  await late.room.leave();
  check(await until(() => a.down.some((m) => m.k === 'left' && m.id === late.id)), 'the host\'s night is told when a guest leaves');
  check(await until(() => a.snaps.at(-1)?.p.length === 2), 'and takes them out');
  const onBoard = async () => (((await api('/api/leaderboard'))?.survival ?? []) as { name: string; mode: string }[]).some((r) => r.name === 'Late' && r.mode === 'hosted');
  check(await untilAsync(onBoard, 3000), 'their run is on the boards, marked hosted');

  section('The night ends');
  b.room.send(C2S.seen, seen(b));
  b.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  await sleep(300);
  b.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  check(await until(() => b.events.some((e) => e.type === 'playerDied' && e.player === b.id)), 'the guest falls');
  check(!a.over && !!a.night?.playing, 'the night goes on while the host is alive');
  await sleep(1100);
  b.room.send(C2S.seen, seen(b));
  a.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  await sleep(300);
  a.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  check(await until(() => !!a.over && !!b.over), 'everyone dead: both get the results from the room');
  check(a.night?.playing === false, 'and the host\'s night has stopped');
  const res = b.over?.results ?? [];
  const ra = res.find((r) => r.name === 'Alpha'), rb = res.find((r) => r.name === 'Bravo');
  check(!!ra && !!rb && rb.stats.kills === 1 && ra.stats.kills === 0, 'results list both survivors with their kills');
  check(!!ra && !!rb && ra.survived > rb.survived && rb.survived > 0, `survival times differ by when they fell (${rb?.survived.toFixed(1)} s, ${ra?.survived.toFixed(1)} s)`);
  check(rb?.rankKills === 1 && !!ra?.rankSurvival, 'leaderboard places come back with the results');
  check(await until(() => a.lobby?.status === 'lobby'), 'room is back in the lobby');
  const board = await api('/api/leaderboard');
  const top = (board?.kills ?? [])[0];
  check(top?.name === 'Bravo' && top.value === 1 && top.mode === 'hosted', `the kills board has the run, marked hosted (${top?.mode})`);
  check((board?.survival ?? []).every((r: { mode: string }) => r.mode === 'hosted'), 'every run of the night is marked hosted');

  section('The host leaves mid-night');
  const c = new Player('Charlie', 'charlieKEY_0123456789abc', false);
  c.attach(await client.joinById(a.room.roomId, c.options));
  check(await until(() => a.lobby?.players.length === 3), 'a third survivor joins the lobby');
  b.begin = null;
  b.over = null;
  a.room.send(C2S.start);
  check(await until(() => !!b.begin && !!c.begin), 'another night starts');
  b.send(C2S.debug, { cmd: 'skipPreparation' });
  check(await until(() => (b.snaps.at(-1)?.ph ?? 0) === 1), 'the outbreak begins');
  await sleep(HOST_PROGRESS_MS + 500);
  b.room.send(C2S.seen, seen(b));
  c.room.send(C2S.seen, seen(c));
  await sleep(100);
  a.stop();
  await a.room.leave();
  check(await until(() => !!b.over && !!c.over), 'the night ends for everyone, with results');
  check(said(b, 'The host left: the night is over'), 'the room says why');
  const rb2 = b.over?.results.find((r) => r.name === 'Bravo');
  check(!!rb2 && rb2.survived > 2 && rb2.survived < 6, `each keeps what they had reached when the host last reported (${rb2?.survived.toFixed(1)} s)`);
  check(await until(() => b.lobby?.status === 'lobby' && b.lobby.host === b.id && b.lobby.hosting === 'player'), 'the lobby stays, and the next player who can host does');
  hosts.push(b.host());
  b.begin = null;
  c.begin = null;
  b.room.send(C2S.start);
  check(await until(() => !!b.begin && !!c.begin && c.snaps.at(-1)?.p.length === 2, 6000), 'the new host can run the next night');
  b.over = null;
  c.over = null;
  b.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  c.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  await sleep(300);
  b.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  c.send(C2S.debug, { cmd: 'hurt', amount: 500 });
  check(await until(() => !!c.over && c.lobby?.status === 'lobby'), 'and it ends as usual');

  section('Nobody left can host');
  b.stop();
  await b.room.leave();
  check(await until(() => c.lobby?.host === c.id), 'the host leaves a player whose device can\'t host');
  check(c.lobby?.hosting === 'player', 'the game stays player-hosted while the server has no place for it');
  c.room.send(C2S.start);
  check(await until(() => c.notices.some((n) => n.includes('CAN\'T RUN A NIGHT'))), 'and they are told this device can\'t run a night');
  const d = new Player('Delta', 'deltaKEY_0123456789abcdef', false);
  d.attach(await client.joinById(c.room.roomId, d.options));
  check(await until(() => c.lobby?.players.length === 2), 'another player who can\'t host joins');
  await filler.room.leave();
  check(await untilAsync(async () => (await api('/health'))?.games === 0), 'a place opens on the server');
  await c.room.leave();
  check(await until(() => d.lobby?.host === d.id && d.lobby.hosting === 'server'), 'the host leaves: the server runs the nights from here on');
  check(said(d, 'Nobody here can host on their own device: the game server runs the nights now'), 'and the room says so');
  check((await api('/health'))?.games === 1, 'the game now takes one of the server\'s places');
  d.begin = null;
  d.snaps = [];
  d.room.send(C2S.start);
  check(await until(() => !!d.begin && d.snaps.length > 5), 'the server runs the next night');
  await d.room.leave();

  section('A host who makes up the count');
  const m = new Player('Mallory', 'malloryKEY_0123456789abcd');
  const v = new Player('Victor', 'victorKEY_0123456789abcde');
  m.attach(await client.create(ROOMS.hosted, { ...m.options, private: true }));
  v.attach(await client.joinById(m.room.roomId, v.options));
  check(await until(() => m.lobby?.players.length === 2), 'a host who runs no real night, and a guest');
  m.room.send(C2S.start);
  check(await until(() => m.down.some((x) => x.k === 'start')), 'the night is handed to them');
  await sleep(2000);
  v.room.send(C2S.seen, { survived: 1.5, kills: [m.id, 1, v.id, 2] } satisfies SeenMsg);
  await sleep(100);
  const stats = (kills: number, extra: object = {}) => ({ kills, headshots: kills, shotsFired: kills * 2, shotsHit: kills, damageDealt: kills * 100, suppliesCollected: 0, damageTaken: 0, limbsSevered: 0, limbKills: 0, revives: 0, goals: 0, ...extra });
  m.room.send(C2S.host, {
    k: 'over', hordes: 12,
    runs: [
      // Could be a real run, but not this one: an hour in a night that began two seconds ago, 4000 kills the guest never saw.
      { id: m.id, survived: 3000, stats: stats(4000) },
      // Could not be any run: more hits than shots.
      { id: v.id, survived: 3000, stats: stats(50, { shotsHit: 500 }) },
      { id: 'nobody', survived: 10, stats: stats(1) },
    ],
  } satisfies HostUp);
  check(await until(() => !!v.over), 'they report the night over');
  const rm = v.over?.results.find((r) => r.name === 'Mallory'), rv = v.over?.results.find((r) => r.name === 'Victor');
  check(!!rm && rm.survived < 10, `survival is held to the clock on the wall and what the guest saw (${rm?.survived.toFixed(1)} s, claimed 3000)`);
  check(!!rm && rm.stats.kills <= 5 && rm.stats.headshots <= rm.stats.kills, `kills are held to what the guest's browser saw (${rm?.stats.kills}, claimed 4000)`);
  check(!!rv && rv.survived === 0 && rv.stats.kills === 0 && rv.rankSurvival === null, 'a count that can\'t be real is thrown out');
  check(v.over?.results.length === 2, 'a run for somebody who isn\'t there is ignored');
  const after = await api('/api/leaderboard');
  check(!(after?.survival ?? []).some((r: { name: string }) => r.name === 'Victor'), 'and never reaches the boards');
  check((after?.survival ?? []).every((r: { value: number }) => r.value < 60), 'no made-up hour on the survival board');
  await m.room.leave();
  await v.room.leave();
} catch (e) {
  failures++;
  console.log('  FAIL threw:', e);
} finally {
  for (const h of hosts) h.stop();
  server.kill('SIGTERM');
}
await sleep(300);
if (failures) console.log(serverLog.split('\n').slice(-30).join('\n'));
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
