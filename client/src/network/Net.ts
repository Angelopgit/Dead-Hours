import { Client } from 'colyseus.js';

const configured = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim().replace(/\/+$/, '');

/**
 * The game server: VITE_SERVER_URL in a build (https:// or wss://, either works), this machine's
 * port 2567 while developing, none otherwise (online play then shows as unavailable).
 */
const base: string | null = configured || (import.meta.env.DEV ? `http://${location.hostname}:2567` : null);
export const HTTP_URL = base ? base.replace(/^ws/, 'http') : null;
export const WS_URL = HTTP_URL ? HTTP_URL.replace(/^http/, 'ws') : null;

export type ServerStatus = 'unknown' | 'online' | 'offline';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let status: ServerStatus = HTTP_URL ? 'unknown' : 'offline';
let checking: Promise<boolean> | null = null;
let client: Client | null = null;

export const net = {
  get status(): ServerStatus {
    return status;
  },

  /** Asks the server whether it is there (cached until `force`). */
  check(force = false): Promise<boolean> {
    if (!HTTP_URL) return Promise.resolve(false);
    if (!force && status !== 'unknown') return Promise.resolve(status === 'online');
    checking ??= (async () => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(`${HTTP_URL}/health`, { signal: ctl.signal });
        clearTimeout(timer);
        status = r.ok ? 'online' : 'offline';
      } catch {
        status = 'offline';
      }
      checking = null;
      return status === 'online';
    })();
    return checking;
  },

  client(): Client {
    if (!WS_URL) throw new Error('No game server configured');
    client ??= new Client(WS_URL);
    return client;
  },

  /** JSON over HTTP to the server's /api routes. */
  async api<T>(path: string, init: { method?: string; body?: unknown; key?: string; session?: string | null } = {}): Promise<T> {
    if (!HTTP_URL) throw new ApiError(0, 'NO SERVER');
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.key) headers['x-player-key'] = init.key;
    if (init.session) headers.authorization = `Bearer ${init.session}`;
    let r: Response;
    try {
      r = await fetch(`${HTTP_URL}${path}`, { method: init.method ?? 'GET', headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
    } catch {
      status = 'offline';
      throw new ApiError(0, 'SERVER UNREACHABLE');
    }
    const body = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!r.ok) throw new ApiError(r.status, body?.error ?? `ERROR ${r.status}`);
    return body as T;
  },
};
