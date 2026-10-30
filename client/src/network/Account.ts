import { decodeAppearance, encodeAppearance, sanitizeAppearance, type PlayerStats } from '@dead-hours/shared';
import { settings } from '../core/Settings';
import { net } from './Net';

const STORAGE_KEY = 'deadhours.player.v1';

/** What the server keeps for a player (see server/src/store.ts). */
export interface ServerProfile {
  name: string;
  appearance: string;
  primary: string;
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

interface Stored {
  key: string;
  /** When this browser last changed the survivor (ms), to tell which copy is newer. */
  savedAt: number;
}

function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
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
  return JSON.stringify({ name: p.name, primary: p.primary, appearance: encodeAppearance(sanitizeAppearance(p.appearance)) });
};

/**
 * The browser's player key and the survivor saved under it on the server. The key is made here
 * and kept in local storage; entering it on another device brings the same survivor and stats
 * there. The survivor is saved again whenever it changes in the creator or loadout.
 */
class Account {
  private stored = load();
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
    this.lastSent = JSON.stringify({ name: p.name, primary: p.primary, appearance: p.appearance });
    settings.update((s) => {
      s.profile.name = p.name;
      s.profile.primary = p.primary;
      s.profile.appearance = decodeAppearance(p.appearance);
    });
    this.lastSent = profileJson();
  }

  /** Saves the survivor on the server. */
  async push(): Promise<void> {
    if (net.status !== 'online') return;
    const body = profileJson();
    try {
      this.profile = await net.api<ServerProfile>('/api/profile', { method: 'PUT', key: this.key, body: JSON.parse(body) });
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
    try {
      const p = await net.api<ServerProfile>('/api/profile', { key: this.key });
      this.profile = p;
      if (p.updatedAt > this.stored.savedAt) this.adopt(p);
      else if (profileJson() !== JSON.stringify({ name: p.name, primary: p.primary, appearance: p.appearance })) await this.push();
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

  /** Puts a finished solo run on the boards (solo runs are marked as such). */
  async reportSolo(survived: number, stats: PlayerStats): Promise<Ranks | null> {
    if (!(await net.check())) return null;
    const p = settings.value.profile;
    try {
      const r = await net.api<Ranks>('/api/runs', {
        method: 'POST', key: this.key,
        body: { name: p.name, appearance: encodeAppearance(sanitizeAppearance(p.appearance)), survived, stats },
      });
      void this.sync();
      return r;
    } catch {
      return null;
    }
  }
}

export const account = new Account();
