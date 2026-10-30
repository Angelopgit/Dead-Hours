/** Who this player has muted or blocked, and how loud each voice is: kept in the browser by lasting player id. */
interface CommsData {
  /** Voices not played (the connection stays, so unmuting is instant). */
  mutedVoice: string[];
  /** Text lines hidden. */
  mutedText: string[];
  /** No chat or voice either way, enforced by the server too. Names are kept for the Settings list. */
  blocked: Record<string, string>;
  /** Voice volume per player, 0..2 (1 when unset). */
  volume: Record<string, number>;
}

const KEY = 'deadhours.comms.v1';

function load(): CommsData {
  const empty: CommsData = { mutedVoice: [], mutedText: [], blocked: {}, volume: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<CommsData> | null;
    if (!raw || typeof raw !== 'object') return empty;
    return {
      mutedVoice: Array.isArray(raw.mutedVoice) ? raw.mutedVoice.filter((p) => typeof p === 'string') : [],
      mutedText: Array.isArray(raw.mutedText) ? raw.mutedText.filter((p) => typeof p === 'string') : [],
      blocked: raw.blocked && typeof raw.blocked === 'object' ? { ...raw.blocked } : {},
      volume: raw.volume && typeof raw.volume === 'object' ? { ...raw.volume } : {},
    };
  } catch {
    return empty;
  }
}

class Comms {
  private data = load();
  private readonly listeners = new Set<() => void>();

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Private mode: the choices last for this visit.
    }
    for (const l of this.listeners) l();
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  voiceMuted(pid: string): boolean {
    return this.data.mutedVoice.includes(pid);
  }

  textMuted(pid: string): boolean {
    return this.data.mutedText.includes(pid);
  }

  blocked(pid: string): boolean {
    return pid in this.data.blocked;
  }

  get blockList(): [pid: string, name: string][] {
    return Object.entries(this.data.blocked);
  }

  volume(pid: string): number {
    const v = this.data.volume[pid];
    return typeof v === 'number' && v >= 0 && v <= 2 ? v : 1;
  }

  setVoiceMuted(pid: string, on: boolean): void {
    this.data.mutedVoice = this.data.mutedVoice.filter((p) => p !== pid);
    if (on) this.data.mutedVoice.push(pid);
    this.save();
  }

  setTextMuted(pid: string, on: boolean): void {
    this.data.mutedText = this.data.mutedText.filter((p) => p !== pid);
    if (on) this.data.mutedText.push(pid);
    this.save();
  }

  setBlocked(pid: string, name: string, on: boolean): void {
    if (on) this.data.blocked[pid] = name;
    else delete this.data.blocked[pid];
    this.save();
  }

  setVolume(pid: string, v: number): void {
    if (Math.abs(v - 1) < 0.01) delete this.data.volume[pid];
    else this.data.volume[pid] = Math.min(2, Math.max(0, v));
    // Volume drags often: no listeners, just the store.
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // ignore
    }
  }
}

export const comms = new Comms();
