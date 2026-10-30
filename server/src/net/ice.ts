import { createHmac } from 'node:crypto';
import type { IceConfig, IceServer } from '@dead-hours/shared';

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** How long time-limited TURN credentials stay valid (seconds). */
export const TURN_TTL = 24 * 3600;

/**
 * How browsers find each other for voice. STUN_URLS (comma separated; a public Google STUN server
 * when unset, none when set empty) lets players behind ordinary routers connect directly. TURN_URLS
 * adds a relay for strict networks, with either TURN_SECRET (coturn's static-auth-secret: each
 * player gets credentials that expire after a day) or a fixed TURN_USERNAME and TURN_CREDENTIAL.
 */
export function iceConfig(user: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): IceConfig {
  const stun = env.STUN_URLS === undefined ? ['stun:stun.l.google.com:19302'] : list(env.STUN_URLS);
  const turn = list(env.TURN_URLS);
  const servers: IceServer[] = stun.length ? [{ urls: stun }] : [];
  if (turn.length && env.TURN_SECRET) {
    const username = `${Math.floor(now / 1000) + TURN_TTL}:${user}`;
    const credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: turn, username, credential });
  } else if (turn.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    servers.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  return { iceServers: servers, relay: servers.some((s) => s.urls.some((u) => /^turns?:/.test(u))) };
}
