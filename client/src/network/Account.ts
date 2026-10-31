import {
  decodeAppearance, decodeLoadout, encodeAppearance, encodeLoadout, levelFor, runXp, sanitizeAppearance, sanitizeLoadout,
  type Loadout, type PlayerStats, type UnlockState,
} from '@dead-hours/shared';
import { settings } from '../core/Settings';
import { HTTP_URL, net } from './Net';

const STORAGE_KEY = 'deadhours.player.v1';
/** The sign-in session and who it is (see server/src/net/auth.ts). */
const SESSION_KEY = 'deadhours.session.v1';
/** The nonce of a sign-in under way, and where a sign-in popup leaves its code for this page. */
const NONCE_KEY = 'deadhours.signin-nonce';
const RESULT_KEY = 'deadhours.signin-result';
const POPUP_NAME = 'dh-signin';

/** What the server keeps for a player (see server/src/store.ts). */
export interface ServerProfile {
  name: string;
  appearance: string;
  primary: string;
  /** encodeLoadout() as the server keeps it (checked against the unlocks). */
  builds: string;
  xp: number;
  level: number;
  /** Grants such as 'supporter'. */
  entitlements: string[];
  updatedAt: number;
  stats: {
    runs: number;
    kills: number;
    headshots: number;
    limbsSevered: number;
    timeSurvived: number;
    bestSurvived: number;
    bestKills: number;
  };
  rankSurvival: number | null;
  rankKills: number | null;
}

export interface Ranks {
  rankSurvival: number | null;
  rankKills: number | null;
}

/** A signed-in player, as the server describes them. */
export interface SignedIn {
  id: string;
  name: string;
  email: string | null;
  /** The services they have signed in with ('google', 'discord'). */
  providers: string[];
}

export type Provider = 'google' | 'discord';

interface StoredSession {
  session: string;
  account: SignedIn;
}

/** A solo run once reported: its places and the XP it earned (saved on the server, or offline in this browser). */
export interface SoloOutcome extends Ranks {
  gained: number;
  offline: boolean;
}

interface Stored {
  key: string;
  /** When this browser last changed the survivor (ms), to tell which copy is newer. */
  savedAt: number;
}

function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function write(key: string, v: unknown): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Not saved; it still works for this visit.
  }
}

function loadSession(): StoredSession | null {
  const s = read<StoredSession>(SESSION_KEY);
  return s && typeof s.session === 'string' && s.account && typeof s.account.id === 'string' ? s : null;
}

/** The sign-in code a finished sign-in left in the page address (#dh_login=…), if any. */
function loginInHash(): { code?: string; error?: string } | null {
  if (!location.hash.includes('dh_login')) return null;
  const q = new URLSearchParams(location.hash.slice(1));
  const code = q.get('dh_login') ?? undefined;
  const error = q.get('dh_login_error') ?? undefined;
  return code || error ? { code, error } : null;
}

function load(): Stored {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Stored | null;
    if (s && typeof s.key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s.key)) return { key: s.key, savedAt: Number(s.savedAt) || 0 };
  } catch {
    // Storage unavailable: a key for this visit only.
  }
  return { key: newKey(), savedAt: 0 };
}

const profileJson = () => {
  const p = settings.value.profile;
  return JSON.stringify({ name: p.name, primary: p.primary, appearance: encodeAppearance(sanitizeAppearance(p.appearance)), builds: p.builds });
};

const serverJson = (p: ServerProfile) => JSON.stringify({ name: p.name, primary: p.primary, appearance: p.appearance, builds: p.builds ?? '1' });

/**
 * Who is playing and the survivor saved for them on the server.
 *
 * Everyone has a browser player key, made here and kept in local storage (guest play; entering
 * it on another device brings the same survivor there). Signing in with Google or Discord ties
 * the survivor, stats and places to an account instead: the guest's progress is folded into it
 * at sign-in, and every device signed in to it plays as the same survivor. The survivor is saved
 * again whenever it changes in the creator or loadout.
 */
class Account {
  private stored = load();
  private signed = loadSession();
  private providerList: Promise<Provider[]> | null = null;
  /** Says how the last sign-in went (for the account panel). */
  lastSignIn: 'ok' | 'cancelled' | 'failed' | null = null;
  private lastSent = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The latest copy from the server (stats and ranks), when it has been reached. */
  profile: ServerProfile | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    this.persist();
    this.lastSent = profileJson();
    settings.subscribe(() => this.changed());
  }

  get key(): string {
    return this.stored.key;
  }

  /** The sign-in session (null playing as a guest). */
  get session(): string | null {
    return this.signed?.session ?? null;
  }

  /** The signed-in player (null playing as a guest). */
  get signedIn(): SignedIn | null {
    return this.signed?.account ?? null;
  }

  private get auth() {
    return { key: this.key, session: this.session };
  }

  /** The key shown to the player, grouped for reading out. */
  get displayKey(): string {
    return this.stored.key.replace(/(.{6})(?=.)/g, '$1 ');
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stored));
    } catch {
      // Not saved; it still works for this visit.
    }
  }

  private changed(): void {
    const now = profileJson();
    if (now === this.lastSent) return;
    this.stored.savedAt = Date.now();
    this.persist();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.push(), 1500);
  }

  private adopt(p: ServerProfile): void {
    this.lastSent = serverJson(p);
    settings.update((s) => {
      s.profile.name = p.name;
      s.profile.primary = p.primary;
      s.profile.appearance = decodeAppearance(p.appearance);
      if (p.builds) s.profile.builds = p.builds;
    });
    this.lastSent = profileJson();
  }

  /**
   * XP that counts: the server's once it has answered (it awards XP for every run it records),
   * else what this browser earned offline.
   */
  get xp(): number {
    return this.profile ? this.profile.xp ?? 0 : settings.value.profile.offlineXp;
  }

  get unlocks(): UnlockState {
    return { level: levelFor(this.xp), entitlements: this.profile?.entitlements ?? [] };
  }

  /** The saved builds as they may be used now. */
  get loadout(): Loadout {
    return sanitizeLoadout(decodeLoadout(settings.value.profile.builds), this.unlocks);
  }

  /** Saves one gun's build (the server keeps it only as far as it's unlocked). */
  setLoadout(l: Loadout): void {
    const code = encodeLoadout(sanitizeLoadout(l, this.unlocks));
    if (code !== settings.value.profile.builds) settings.update((s) => { s.profile.builds = code; });
  }

  /** Saves the survivor on the server. */
  async push(): Promise<void> {
    if (net.status !== 'online') return;
    const body = profileJson();
    try {
      this.profile = await net.api<ServerProfile>('/api/profile', { method: 'PUT', ...this.auth, body: JSON.parse(body) });
      this.lastSent = body;
      this.emit();
    } catch {
      // Tried again on the next change.
    }
  }

  /**
   * Fetches what the server has: the newer of the two copies of the survivor wins (so a key
   * entered from another device brings its survivor along).
   */
  async sync(): Promise<void> {
    if (!(await net.check())) return;
    if (this.signed) {
      try {
        this.signed.account = await net.api<SignedIn>('/api/me', { session: this.session });
        write(SESSION_KEY, this.signed);
      } catch (e) {
        // Signed out elsewhere or expired: back to playing as a guest.
        if ((e as { status?: number }).status === 401) this.setSession(null);
      }
    }
    try {
      const p = await net.api<ServerProfile>('/api/profile', this.auth);
      this.profile = p;
      if (p.updatedAt > this.stored.savedAt) this.adopt(p);
      else if (profileJson() !== serverJson(p)) await this.push();
      this.emit();
    } catch {
      // Nothing saved under this key yet.
      await this.push();
    }
  }

  /** Switches to a key from another device. Returns false when it isn't a valid key. */
  async useKey(raw: string): Promise<boolean> {
    const key = raw.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return false;
    this.stored = { key, savedAt: 0 };
    this.persist();
    this.profile = null;
    await this.sync();
    this.emit();
    return true;
  }

  /**
   * Puts a finished solo run on the boards (solo runs are marked as such) and its XP on the
   * profile. With no server to reach, the XP is kept in this browser instead.
   */
  async reportSolo(survived: number, stats: PlayerStats): Promise<SoloOutcome> {
    const offline = (): SoloOutcome => {
      const gained = runXp(survived, stats).total;
      settings.update((s) => { s.profile.offlineXp += gained; });
      this.emit();
      return { rankSurvival: null, rankKills: null, gained, offline: true };
    };
    if (!(await net.check())) return offline();
    const p = settings.value.profile;
    try {
      const r = await net.api<Ranks & { gained?: number; xp?: number }>('/api/runs', {
        method: 'POST', ...this.auth,
        body: { name: p.name, appearance: encodeAppearance(sanitizeAppearance(p.appearance)), survived, stats },
      });
      if (this.profile && typeof r.xp === 'number') this.profile.xp = r.xp;
      void this.sync();
      return { rankSurvival: r.rankSurvival, rankKills: r.rankKills, gained: r.gained ?? 0, offline: false };
    } catch {
      // Refused (too many runs, not plausible): nothing saved.
      return { rankSurvival: null, rankKills: null, gained: 0, offline: false };
    }
  }

  private setSession(s: StoredSession | null): void {
    this.signed = s;
    write(SESSION_KEY, s);
    this.profile = null;
    this.emit();
  }

  /** The services this server lets players sign in with (none when it is offline or not set up). */
  providers(): Promise<Provider[]> {
    this.providerList ??= net.check().then(async (up) => {
      if (!up) return [];
      try {
        return (await net.api<{ providers: Provider[] }>('/api/auth/providers')).providers;
      } catch {
        return [];
      }
    }).then((l) => {
      if (!l.length) this.providerList = null;
      return l;
    });
    return this.providerList;
  }

  /**
   * Starts signing in: a popup with the service's sign-in, or (when popups are blocked) the whole
   * page goes there and comes back. The popup's code arrives through listen().
   */
  signIn(provider: Provider): void {
    if (!HTTP_URL) return;
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const nonce = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
    write(NONCE_KEY, nonce);
    write(RESULT_KEY, null);
    const back = `${location.origin}${location.pathname}${location.search}`;
    const url = `${HTTP_URL}/auth/${provider}/start?${new URLSearchParams({ return: back, nonce })}`;
    const w = 480;
    const hgt = 680;
    const popup = window.open(url, POPUP_NAME,
      `popup,width=${w},height=${hgt},left=${Math.round(screenX + (outerWidth - w) / 2)},top=${Math.round(screenY + (outerHeight - hgt) / 2)}`);
    if (!popup) location.assign(url);
  }

  /** A code handed back by the sign-in popup (postMessage from the server's page, or via storage). */
  private listen(): void {
    const serverOrigin = HTTP_URL ? new URL(HTTP_URL).origin : '';
    window.addEventListener('message', (e) => {
      const d = (e.data as { deadHoursLogin?: { dh_login?: string; dh_login_error?: string } } | null)?.deadHoursLogin;
      if (!d || (e.origin !== serverOrigin && e.origin !== location.origin)) return;
      void this.finish(d.dh_login, d.dh_login_error);
    });
    window.addEventListener('storage', (e) => {
      if (e.key !== RESULT_KEY || !e.newValue) return;
      const d = read<{ code?: string; error?: string }>(RESULT_KEY);
      write(RESULT_KEY, null);
      if (d) void this.finish(d.code, d.error);
    });
  }

  /**
   * Called first thing on page load. In the sign-in popup (when the server's page couldn't reach
   * this window directly) it passes the code on and closes, and returns true: nothing else should
   * start. After a whole-page sign-in it finishes signing in here.
   */
  takeSignInFromAddress(): boolean {
    this.listen();
    const got = loginInHash();
    if (!got) return false;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (window.name === POPUP_NAME && window.opener) {
      write(RESULT_KEY, got);
      try {
        (window.opener as Window).postMessage({ deadHoursLogin: { dh_login: got.code, dh_login_error: got.error } }, location.origin);
      } catch {
        // The storage note above reaches it instead.
      }
      window.close();
      return true;
    }
    void this.finish(got.code, got.error);
    return false;
  }

  private finishing = false;

  /** Trades a sign-in code for a session; the guest's survivor and stats go into the account. */
  private async finish(code: string | undefined, error: string | undefined): Promise<void> {
    const nonce = read<string>(NONCE_KEY);
    if (this.finishing || (!code && !error)) return;
    if (!code || !nonce) {
      this.lastSignIn = error === 'cancelled' ? 'cancelled' : 'failed';
      this.emit();
      return;
    }
    this.finishing = true;
    try {
      const r = await net.api<StoredSession>('/api/auth/exchange', { method: 'POST', body: { code, nonce, guestKey: this.key } });
      write(NONCE_KEY, null);
      this.lastSignIn = 'ok';
      this.setSession(r);
      // The account's survivor wins over this browser's copy (it already has this guest's runs).
      this.stored.savedAt = 0;
      this.persist();
      await this.sync();
    } catch {
      this.lastSignIn = 'failed';
      this.emit();
    } finally {
      this.finishing = false;
    }
  }

  /** Back to playing as a guest on this browser (the account keeps its survivor). */
  async signOut(): Promise<void> {
    const session = this.session;
    this.lastSignIn = null;
    this.setSession(null);
    // A fresh guest key: the old one's progress now belongs to the account.
    this.stored = { key: newKey(), savedAt: Date.now() };
    this.persist();
    if (session) await net.api('/api/auth/logout', { method: 'POST', session }).catch(() => undefined);
    await this.sync();
  }

  /** After an online night: the server has added the XP, fetch the new total. */
  async refresh(): Promise<void> {
    await this.sync();
  }
}

export const account = new Account();
