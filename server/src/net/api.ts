import type { IncomingMessage, ServerResponse } from 'node:http';
import { matchMaker } from 'colyseus';
import { COMBAT, GAME, ROOMS, type PlayerStats, type RoomListing } from '@dead-hours/shared';
import { services } from '../services';
import { unlocksOf, type BoardKind } from '../store';
import { roomForCode } from './codes';
import { MAX_ROOMS, forwarded, localGames } from './scale';
import { cleanAppearance, cleanBuildsWire, cleanName, cleanPrimary } from './clean';
import { accountView, authProviders, exchange, logout, ownerFor } from './auth';

/** The game is played from another address (the static site): every route allows any origin. */
function cors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-player-key, authorization');
  res.setHeader('access-control-max-age', '600');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit = 8192): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

/** Public rooms for the game list (private ones are joined by code only). */
async function listRooms(): Promise<RoomListing[]> {
  const rooms = await matchMaker.query({ name: ROOMS.survival });
  return rooms
    .filter((r) => !r.private && r.metadata?.code)
    .map((r) => ({
      roomId: r.roomId, code: r.metadata.code, name: r.metadata.name, host: r.metadata.host,
      players: r.clients, maxPlayers: r.maxClients, status: r.metadata.status, survived: r.metadata.survived ?? 0,
    }))
    .sort((a, b) => Number(a.status !== 'lobby') - Number(b.status !== 'lobby') || b.players - a.players);
}

const STAT_KEYS: (keyof PlayerStats)[] = ['kills', 'headshots', 'shotsFired', 'shotsHit', 'damageDealt', 'suppliesCollected', 'damageTaken', 'limbsSevered', 'limbKills'];

/**
 * A solo run as the browser reports it. Solo games run in the player's browser, so this can't be
 * proven the way online runs are; it is held to what a real run could reach and marked solo.
 */
function plausibleSolo(body: unknown): { survived: number; stats: PlayerStats } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { survived?: unknown; stats?: Record<string, unknown> };
  const survived = b.survived;
  if (typeof survived !== 'number' || !Number.isFinite(survived) || survived < 0 || survived > 6 * 3600) return null;
  if (!b.stats || typeof b.stats !== 'object') return null;
  const stats = {} as PlayerStats;
  for (const k of STAT_KEYS) {
    const v = b.stats[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e7) return null;
    stats[k] = k === 'damageDealt' || k === 'damageTaken' ? Math.round(v) : Math.floor(v);
  }
  const played = survived + GAME.preparationSeconds + 5;
  if (stats.kills > 3 + survived * 1.5) return null;
  if (stats.headshots > stats.kills || stats.limbKills > stats.kills || stats.shotsHit > stats.shotsFired) return null;
  if (stats.shotsFired > played * 16) return null;
  if (stats.limbsSevered > stats.kills * 2 + 6) return null;
  if (stats.suppliesCollected > played / 2 + COMBAT.crateUses * 20) return null;
  return { survived, stats };
}

/** One run every 15 seconds per player, 40 an hour per address. */
const lastRun = new Map<string, number>();
const perAddress = new Map<string, { n: number; since: number }>();
function allowRun(key: string, addr: string): boolean {
  const now = Date.now();
  if (now - (lastRun.get(key) ?? 0) < 15_000) return false;
  const a = perAddress.get(addr);
  if (!a || now - a.since > 3_600_000) perAddress.set(addr, { n: 1, since: now });
  else if (++a.n > 40) return false;
  lastRun.set(key, now);
  return true;
}

/**
 * Plain HTTP beside the game server: /health for the host's checks, the game list, join codes,
 * leaderboards, saved survivors (the signed-in account's profile, else the browser key's) and
 * sign-in (see auth.ts).
 * Returns false for anything that isn't one of these routes.
 */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  if (path === '/health') {
    // Also this process's games against its cap, for load tests and dashboards.
    send(res, 200, { ok: true, version: GAME.version, store: services.store?.kind ?? null, games: localGames(), maxGames: MAX_ROOMS, forwarded: forwarded() });
    return true;
  }
  if (!path.startsWith('/api/')) return false;
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return true;
  }
  const store = services.store;
  try {
    // Who is asking: only the routes that save something need it.
    const who = /^\/api\/(profile|runs|me|debug\/grant)$/.test(path) ? await ownerFor(req) : null;
    const owner = who?.owner ?? null;
    if (path === '/api/rooms' && req.method === 'GET') {
      send(res, 200, await listRooms());
    } else if (path.startsWith('/api/code/') && req.method === 'GET') {
      const roomId = await roomForCode(matchMaker.presence, decodeURIComponent(path.slice('/api/code/'.length)));
      if (roomId) send(res, 200, { roomId });
      else send(res, 404, { error: 'NO GAME WITH THAT CODE' });
    } else if (path === '/api/leaderboard' && req.method === 'GET') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      if (!store) return send(res, 503, { error: 'LEADERBOARDS UNAVAILABLE' }), true;
      const [survival, kills] = await Promise.all((['survival', 'kills'] as BoardKind[]).map((k) => store.board(k, limit)));
      send(res, 200, { survival, kills });
    } else if (path === '/api/profile' && req.method === 'GET') {
      if (!owner) return send(res, 400, { error: 'NO PLAYER KEY' }), true;
      if (!store) return send(res, 503, { error: 'PROFILES UNAVAILABLE' }), true;
      const p = await store.getProfile(owner);
      if (p) send(res, 200, p);
      else send(res, 404, { error: 'NO SAVED SURVIVOR' });
    } else if (path === '/api/profile' && req.method === 'PUT') {
      if (!owner) return send(res, 400, { error: 'NO PLAYER KEY' }), true;
      if (!store) return send(res, 503, { error: 'PROFILES UNAVAILABLE' }), true;
      const b = (await readJson(req)) as Record<string, unknown> | null;
      const name = cleanName(b?.name);
      if (!name) return send(res, 400, { error: 'NAME REQUIRED' }), true;
      // Builds are kept only as far as this profile has unlocked them (left out: the saved ones stay).
      const builds = typeof b?.builds === 'string' ? cleanBuildsWire(b.builds, unlocksOf(await store.getProfile(owner))) : undefined;
      send(res, 200, await store.saveProfile(owner, { name, appearance: cleanAppearance(b?.appearance), primary: cleanPrimary(b?.primary), builds }));
    } else if (path === '/api/runs' && req.method === 'POST') {
      if (!owner) return send(res, 400, { error: 'NO PLAYER KEY' }), true;
      if (!store) return send(res, 503, { error: 'LEADERBOARDS UNAVAILABLE' }), true;
      const b = (await readJson(req)) as Record<string, unknown> | null;
      const run = plausibleSolo(b);
      const name = cleanName(b?.name) || 'Survivor';
      if (!run) return send(res, 422, { error: 'RUN NOT ACCEPTED' }), true;
      if (!allowRun(owner, req.socket.remoteAddress ?? '')) return send(res, 429, { error: 'TOO MANY RUNS' }), true;
      send(res, 200, await store.recordRun({ owner, name, appearance: cleanAppearance(b?.appearance), mode: 'solo', ...run }));
    } else if (path === '/api/auth/providers' && req.method === 'GET') {
      send(res, 200, { providers: store ? authProviders() : [] });
    } else if (path === '/api/auth/exchange' && req.method === 'POST') {
      const r = await exchange((await readJson(req)) as Record<string, unknown> | null);
      send(res, r.status, r.body);
    } else if (path === '/api/auth/logout' && req.method === 'POST') {
      await logout(req);
      send(res, 200, { ok: true });
    } else if (path === '/api/me' && req.method === 'GET') {
      if (who?.account) send(res, 200, accountView(who.account));
      else send(res, 401, { error: 'NOT SIGNED IN' });
    } else if (path === '/api/debug/grant' && req.method === 'POST' && process.env.DEAD_HOURS_DEBUG === '1') {
      // Tests only: stands in for a purchase until the Supporter Pack is sold.
      if (!owner || !store) return send(res, 400, { error: 'NO PLAYER KEY' }), true;
      const b = (await readJson(req)) as Record<string, unknown> | null;
      const g = typeof b?.entitlement === 'string' && /^[a-z0-9-]{1,32}$/.test(b.entitlement) ? b.entitlement : null;
      if (!g) return send(res, 400, { error: 'BAD GRANT' }), true;
      await store.grant(owner, g);
      send(res, 200, await store.getProfile(owner));
    } else {
      send(res, 404, { error: 'NOT FOUND' });
    }
  } catch (e) {
    console.warn('[dead-hours] api error', path, e);
    if (!res.headersSent) send(res, 500, { error: 'SERVER ERROR' });
  }
  return true;
}
