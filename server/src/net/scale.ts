import { lookup } from 'node:dns/promises';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { RedisDriver, RedisPresence, ServerError, matchMaker, type MatchMakerDriver, type Presence } from 'colyseus';
import { SERVERS_FULL } from '@dead-hours/shared';

const positive = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

/**
 * Games one server process runs before new ones go to another process (or, when every process
 * has this many, are refused with SERVERS_FULL). A busy game (four survivors, two dozen zombies)
 * takes about a tenth of a CPU; one in its lobby takes next to nothing.
 */
export const MAX_ROOMS = positive(process.env.MAX_ROOMS, 8);

/** Set by REDIS_URL: several server processes share matchmaking, game codes and the game list. */
export interface Scale {
  presence?: Presence;
  driver?: MatchMakerDriver;
  /** This process's address on the private network (host:port), or null when running alone. */
  address: string | null;
}

/** Marks a connection already passed on once, so two processes can never bounce it between them. */
const FORWARDED = 'x-dead-hours-forwarded';

/**
 * This machine's address on the private network: SELF_HOSTNAME if set; on Render, the address
 * of ours among the service's instances; else the first non-loopback IPv4 address.
 */
async function privateHost(): Promise<string> {
  if (process.env.SELF_HOSTNAME) return process.env.SELF_HOSTNAME;
  const mine = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
  const discovery = process.env.RENDER_DISCOVERY_SERVICE;
  if (discovery) {
    try {
      const all = (await lookup(discovery, { all: true, family: 4 })).map((a) => a.address);
      const found = mine.find((a) => all.includes(a));
      if (found) return found;
    } catch {
      // Not resolvable (yet): fall back to the interface.
    }
  }
  return mine[0] ?? '127.0.0.1';
}

/** Waits for a Redis connection to be ready (or fails with a clear reason after 15 s). */
function ready(conn: { status: string; once: (e: string, f: (err?: Error) => void) => unknown }): Promise<void> {
  if (conn.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('REDIS_URL: no answer from Redis after 15 s')), 15000);
    conn.once('ready', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export async function setupScale(port: number): Promise<Scale> {
  const url = process.env.REDIS_URL;
  if (!url) return { address: null };
  // Colyseus registers each process as "processId/SELF_HOSTNAME:port" (its "colyseus:nodes" set).
  const host = await privateHost();
  process.env.SELF_HOSTNAME = host;
  const presence = new RedisPresence(url);
  // Both connections must be up before Colyseus subscribes: a subscription sent while the
  // listening connection is still checking the server breaks it (ioredis), and with it every
  // message between processes.
  const conns = presence as unknown as { sub: Parameters<typeof ready>[0]; pub: Parameters<typeof ready>[0] };
  await Promise.all([ready(conns.sub), ready(conns.pub)]);
  return { presence, driver: new RedisDriver(url), address: `${host}:${port}` };
}

/** Games running in this process. */
const games = new Set<string>();
/** Each process's games, as `count,time` per process id; entries not renewed for a while are gone. */
const LOAD = 'dh:load';
const STALE_MS = 15000;
let loadTimer: ReturnType<typeof setInterval> | null = null;

export const localGames = () => games.size;
/** Game connections this process passed on to another (since start). */
let forwards = 0;
export const forwarded = () => forwards;

function report(): void {
  void matchMaker.presence.hset(LOAD, matchMaker.processId, `${games.size},${Date.now()}`).catch(() => undefined);
}

/** Once listening: this process counts as a place for games (renewed every few seconds). */
export function reportLoad(): void {
  report();
  if (!loadTimer) {
    loadTimer = setInterval(report, 5000);
    loadTimer.unref();
  }
}

/** Shutting down: no new games here. */
export async function dropLoad(): Promise<void> {
  if (loadTimer) clearInterval(loadTimer);
  loadTimer = null;
  await matchMaker.presence.hdel(LOAD, matchMaker.processId).catch(() => undefined);
}

/** Rooms call these as they open and close, so every process knows where there is space. */
export function gameOpened(roomId: string): void {
  games.add(roomId);
  report();
}

export function gameClosed(roomId: string): void {
  games.delete(roomId);
  report();
}

/**
 * Where a new game goes: the process running the fewest, if it has room (MAX_ROOMS); when every
 * process is full, nobody can host until a night ends somewhere. Counts are written straight
 * away on every change (and every few seconds), and processes that stop writing drop out.
 */
export async function chooseProcess(): Promise<string> {
  const now = Date.now();
  const load = new Map<string, number>();
  for (const [id, v] of Object.entries(await matchMaker.presence.hgetall(LOAD))) {
    const [count, at] = String(v).split(',').map(Number);
    if (now - at < STALE_MS && Number.isFinite(count)) load.set(id, count);
  }
  load.set(matchMaker.processId, games.size);
  const [best] = [...load].filter(([, n]) => n < MAX_ROOMS).sort((a, b) => a[1] - b[1]);
  if (!best) throw new ServerError(SERVERS_FULL, 'SERVERS FULL');
  // Counted at once, so games asked for together don't all pick the same process.
  if (best[0] !== matchMaker.processId) await matchMaker.presence.hset(LOAD, best[0], `${best[1] + 1},${now}`);
  return best[0];
}

/** Where each process listens on the private network, from the set Colyseus keeps in presence. */
class Directory {
  private readonly known = new Map<string, string>();
  private fetched = 0;

  constructor(private readonly presence: Presence) {}

  async addressOf(processId: string): Promise<string | null> {
    const hit = this.known.get(processId);
    if (hit) return hit;
    // A process we haven't heard of: read the set again (at most twice a second).
    if (Date.now() - this.fetched < 500) return null;
    this.fetched = Date.now();
    for (const node of await this.presence.smembers('colyseus:nodes')) {
      const slash = node.indexOf('/');
      if (slash > 0) this.known.set(node.slice(0, slash), node.slice(slash + 1));
    }
    return this.known.get(processId) ?? null;
  }
}

/**
 * A load balancer (Render's) hands each WebSocket to any instance, but a game lives in one
 * process. Connections for a game elsewhere are passed through to that process over the
 * private network, byte for byte; everything else goes to Colyseus as usual.
 */
export function forwardGameConnections(server: HttpServer, scale: Scale): void {
  if (!scale.presence || !scale.address) return;
  const directory = new Directory(scale.presence);
  const own = server.listeners('upgrade').slice(0) as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
  server.removeAllListeners('upgrade');
  const local = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    for (const l of own) l.call(server, req, socket, head);
  };
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const m = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\?|$)/.exec(req.url ?? '');
    const processId = m?.[1];
    if (!m || !processId || processId === matchMaker.processId || matchMaker.getLocalRoomById(m[2]) || req.headers[FORWARDED]) {
      local(req, socket, head);
      return;
    }
    socket.pause();
    void directory.addressOf(processId).then((address) => {
      if (!address || address === scale.address) {
        socket.resume();
        local(req, socket, head);
        return;
      }
      forwards++;
      pipeTo(address, req, socket, head);
    }, () => {
      socket.resume();
      local(req, socket, head);
    });
  });
}

/** Replays the upgrade request to another process and joins the two sockets. */
function pipeTo(address: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const colon = address.lastIndexOf(':');
  const upstream = connect(Number(address.slice(colon + 1)), address.slice(0, colon));
  const lines = [`${req.method ?? 'GET'} ${req.url} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  if (!req.headers['x-forwarded-for']) lines.push(`x-forwarded-for: ${req.socket.remoteAddress ?? ''}`);
  lines.push(`${FORWARDED}: 1`, '', '');
  const fail = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.setNoDelay(true);
  (socket as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
  upstream.setTimeout(10000, fail);
  upstream.once('connect', () => {
    upstream.setTimeout(0);
    upstream.write(lines.join('\r\n'));
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
    socket.resume();
  });
  upstream.on('error', fail);
  socket.on('error', fail);
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}
