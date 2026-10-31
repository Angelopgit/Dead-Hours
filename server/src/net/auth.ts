import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { services } from '../services';
import { ownerOfKey, secretHash, type Account, type Identity } from '../store';
import { cleanName, cleanToken } from './clean';

/**
 * Sign-in with Google or Discord (OAuth 2 code flow on the server; each is free to use).
 *
 *  1. The game opens  /auth/<provider>/start?return=<game page>&nonce=<random>  (in a popup).
 *  2. The server sends the player to the service with a signed state, and the service back to
 *     /auth/<provider>/callback with a code, which the server trades for who they are.
 *  3. The server makes a one-time sign-in code (a minute, single use, tied to the nonce) and hands
 *     it to the game page: postMessage to the opener, else a redirect to <game page>#dh_login=<code>.
 *  4. The game trades it at POST /api/auth/exchange (with the nonce and its guest key) for a
 *     session, and the guest's browser profile is folded into the account.
 *
 * The return address must be one of CLIENT_ORIGINS (localhost is allowed while developing), so
 * a sign-in can't be handed to another site. The nonce stops someone signing a player into the
 * wrong account with a link.
 *
 * Environment: AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET, AUTH_DISCORD_ID + AUTH_DISCORD_SECRET (either
 * pair or both), CLIENT_ORIGINS, AUTH_SECRET (signs the state; needed with several servers),
 * PUBLIC_URL (this server's https address; Railway's RAILWAY_PUBLIC_DOMAIN, then the request's
 * forwarded host, are used when unset).
 */

interface Provider {
  id: 'google' | 'discord';
  clientId: string;
  secret: string;
  authorize: string;
  token: string;
  user: string;
  scope: string;
  /** Who the service says the player is, from its user endpoint. */
  identity(u: Record<string, unknown>): Identity | null;
}

/** Test endpoints instead of the real services (server checks only; needs DEAD_HOURS_DEBUG=1). */
const MOCK = services.debug ? process.env.AUTH_MOCK_URL?.replace(/\/+$/, '') : undefined;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function providers(): Map<string, Provider> {
  const env = process.env;
  const list: Provider[] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    list.push({
      id: 'google', clientId: env.AUTH_GOOGLE_ID, secret: env.AUTH_GOOGLE_SECRET,
      authorize: MOCK ? `${MOCK}/google/authorize` : 'https://accounts.google.com/o/oauth2/v2/auth',
      token: MOCK ? `${MOCK}/google/token` : 'https://oauth2.googleapis.com/token',
      user: MOCK ? `${MOCK}/google/user` : 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
      identity: (u) => {
        const subject = str(u.sub);
        if (!subject) return null;
        const email = u.email_verified === true ? str(u.email).toLowerCase() || null : null;
        return { provider: 'google', subject, name: cleanName(u.name, 40) || cleanName(str(u.email).split('@')[0], 40), email };
      },
    });
  }
  if (env.AUTH_DISCORD_ID && env.AUTH_DISCORD_SECRET) {
    list.push({
      id: 'discord', clientId: env.AUTH_DISCORD_ID, secret: env.AUTH_DISCORD_SECRET,
      authorize: MOCK ? `${MOCK}/discord/authorize` : 'https://discord.com/oauth2/authorize',
      token: MOCK ? `${MOCK}/discord/token` : 'https://discord.com/api/oauth2/token',
      user: MOCK ? `${MOCK}/discord/user` : 'https://discord.com/api/users/@me',
      scope: 'identify email',
      identity: (u) => {
        const subject = str(u.id);
        if (!subject) return null;
        const email = u.verified === true ? str(u.email).toLowerCase() || null : null;
        return { provider: 'discord', subject, name: cleanName(u.global_name, 40) || cleanName(u.username, 40), email };
      },
    });
  }
  return new Map(list.map((p) => [p.id, p]));
}

const PROVIDERS = providers();

/** The services players can sign in with on this server. */
export const authProviders = (): string[] => [...PROVIDERS.keys()];

const SECRET = process.env.AUTH_SECRET || randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET && PROVIDERS.size && process.env.REDIS_URL) {
  console.warn('[dead-hours] AUTH_SECRET is unset: with several servers, sign-ins that come back to another server will fail');
}

const SESSION_DAYS = 180;
const CODE_MS = 60_000;
const STATE_MS = 10 * 60_000;

/** Addresses the game is served from. A sign-in only ever returns to one of these. */
const ORIGINS = new Set((process.env.CLIENT_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean));

function allowedReturn(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  // Developing on this machine works without setting anything; a public server lists its sites.
  if (!ORIGINS.has(u.origin) && !(local && (ORIGINS.size === 0 || services.debug))) return null;
  u.hash = '';
  return u.toString();
}

const sign = (body: string): string => createHmac('sha256', SECRET).update(body).digest('base64url');

function makeState(s: { p: string; r: string; n: string }): string {
  const body = Buffer.from(JSON.stringify({ ...s, e: Date.now() + STATE_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readState(state: string): { p: string; r: string; n: string } | null {
  const [body, mac] = state.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { p: string; r: string; n: string; e: number };
    return s.e > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/** This server's own address, for the address the services send players back to. */
function publicUrl(req: IncomingMessage): string {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const set = process.env.PUBLIC_URL || (domain ? `https://${domain}` : process.env.RENDER_EXTERNAL_URL);
  if (set) return set.replace(/\/+$/, '');
  const proto = str(req.headers['x-forwarded-proto']).split(',')[0] || 'http';
  return `${proto}://${req.headers.host}`;
}

const callbackUrl = (req: IncomingMessage, p: Provider) => `${publicUrl(req)}/auth/${p.id}/callback`;

const nonceOk = (v: string): boolean => /^[A-Za-z0-9_-]{16,64}$/.test(v);

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' });
  res.end();
}

/**
 * The page the service returns the player to: gives the game its sign-in code and closes. The
 * code goes only to the game's own address (postMessage target, or the redirect).
 */
function handBack(res: ServerResponse, returnTo: string, fields: Record<string, string>): void {
  const target = new URL(returnTo);
  const to = `${target.toString()}#${new URLSearchParams(fields)}`;
  // Values inside the script, with no way to close the tag.
  const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  const page = `<!doctype html><meta charset="utf-8"><title>Dead Hours</title>
<body style="background:#0b0d10;color:#ccc;font:16px sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<p>Signing in…</p>
<script>
try { if (window.opener && window.name === 'dh-signin') { window.opener.postMessage(${js({ deadHoursLogin: fields })}, ${js(target.origin)}); window.close(); } } catch (e) {}
setTimeout(function () { location.replace(${js(to)}); }, 400);
</script>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
  });
  res.end(page);
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`token endpoint ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

async function whoIs(p: Provider, code: string, redirectUri: string): Promise<Identity | null> {
  const t = await postForm(p.token, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: p.clientId, client_secret: p.secret,
  });
  const access = str(t.access_token);
  if (!access) return null;
  const r = await fetch(p.user, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  return p.identity((await r.json()) as Record<string, unknown>);
}

/** GET /auth/<provider>/start and /auth/<provider>/callback. Returns false for other paths. */
export async function handleAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  const m = /^\/auth\/([a-z]+)\/(start|callback)$/.exec(url.pathname);
  if (!m || req.method !== 'GET') return false;
  const p = PROVIDERS.get(m[1]);
  if (!p) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('That sign-in is not set up on this server.');
    return true;
  }
  if (m[2] === 'start') {
    const returnTo = allowedReturn(str(url.searchParams.get('return')));
    const nonce = str(url.searchParams.get('nonce'));
    if (!returnTo || !nonceOk(nonce)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('This sign-in link is not valid.');
      return true;
    }
    const q = new URLSearchParams({
      client_id: p.clientId, redirect_uri: callbackUrl(req, p), response_type: 'code', scope: p.scope,
      state: makeState({ p: p.id, r: returnTo, n: nonce }), prompt: p.id === 'google' ? 'select_account' : 'none',
    });
    redirect(res, `${p.authorize}?${q}`);
    return true;
  }
  // The callback.
  const state = readState(str(url.searchParams.get('state')));
  if (!state || state.p !== p.id || !allowedReturn(state.r)) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('This sign-in has expired. Close this window and try again.');
    return true;
  }
  const code = str(url.searchParams.get('code'));
  if (!code) {
    // Cancelled at the service (error=access_denied) or something went wrong there.
    handBack(res, state.r, { dh_login_error: url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed' });
    return true;
  }
  const store = services.store;
  try {
    const who = store ? await whoIs(p, code, callbackUrl(req, p)) : null;
    if (!store || !who) throw new Error('no identity');
    const acct = await store.accountFor(who);
    const login = randomBytes(24).toString('base64url');
    await store.createLoginCode(secretHash(login), acct.id, state.n, Date.now() + CODE_MS);
    handBack(res, state.r, { dh_login: login });
  } catch (e) {
    console.warn(`[dead-hours] ${p.id} sign-in failed:`, e instanceof Error ? e.message : e);
    handBack(res, state.r, { dh_login_error: 'failed' });
  }
  return true;
}

/** The session in an Authorization: Bearer header (not checked). */
function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(str(req.headers.authorization));
  return m ? m[1] : null;
}

/** The account a session belongs to (null when missing, expired or signed out). */
export async function sessionAccount(session: unknown): Promise<Account | null> {
  const store = services.store;
  if (!store || typeof session !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(session)) return null;
  return store.sessionAccount(secretHash(session)).catch(() => null);
}

export interface Owner {
  /** The profile everything this player does counts for. */
  owner: string;
  account: Account | null;
}

/** Whose profile a request or room member plays as: their account when signed in, else their browser key. */
export async function resolveOwner(session: unknown, key: unknown): Promise<Owner | null> {
  const account = await sessionAccount(session);
  if (account) return { owner: account.profileKey, account };
  const token = cleanToken(key);
  return token ? { owner: ownerOfKey(token), account: null } : null;
}

export const ownerFor = (req: IncomingMessage): Promise<Owner | null> => resolveOwner(bearer(req), req.headers['x-player-key']);

/** What the game is told about the signed-in player. */
export const accountView = (a: Account) => ({ id: a.id, name: a.name, email: a.email, providers: a.providers });

/**
 * POST /api/auth/exchange {code, nonce, guestKey}: a sign-in code for a session. The guest's
 * browser profile (if any) is folded into the account, so nothing played before signing in is lost.
 */
export async function exchange(body: Record<string, unknown> | null): Promise<{ status: number; body: unknown }> {
  const store = services.store;
  if (!store) return { status: 503, body: { error: 'ACCOUNTS UNAVAILABLE' } };
  const code = str(body?.code);
  const nonce = str(body?.nonce);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code) || !nonceOk(nonce)) return { status: 400, body: { error: 'SIGN-IN NOT VALID' } };
  const c = await store.takeLoginCode(secretHash(code));
  if (!c) return { status: 401, body: { error: 'SIGN-IN EXPIRED' } };
  const a = Buffer.from(c.nonce);
  const b = Buffer.from(nonce);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { status: 401, body: { error: 'SIGN-IN NOT VALID' } };
  const account = await store.getAccount(c.accountId);
  if (!account) return { status: 401, body: { error: 'SIGN-IN EXPIRED' } };
  const guest = cleanToken(body?.guestKey);
  if (guest) await store.mergeProfiles(ownerOfKey(guest), account.profileKey);
  const session = randomBytes(32).toString('base64url');
  await store.createSession(secretHash(session), account.id, Date.now() + SESSION_DAYS * 86_400_000);
  return { status: 200, body: { session, account: accountView(account) } };
}

/** POST /api/auth/logout: ends the session in the Authorization header. */
export async function logout(req: IncomingMessage): Promise<void> {
  const s = bearer(req);
  if (s) await services.store?.deleteSession(secretHash(s));
}
