export type ShadowQuality = 'off' | 'low' | 'medium' | 'high';
export type Quality = 'low' | 'medium' | 'high';
export type AimMode = 'hold' | 'toggle';

export type Action =
  | 'forward' | 'back' | 'left' | 'right'
  | 'sprint' | 'crouch' | 'jump' | 'interact'
  | 'reload' | 'melee' | 'weapon1' | 'weapon2'
  | 'inventory' | 'shoulder' | 'fire' | 'aim';

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward', back: 'Move back', left: 'Move left', right: 'Move right',
  sprint: 'Sprint', crouch: 'Crouch', jump: 'Jump / Vault', interact: 'Interact',
  reload: 'Reload', melee: 'Melee attack', weapon1: 'Primary weapon', weapon2: 'Secondary weapon',
  inventory: 'Inventory', shoulder: 'Switch shoulder', fire: 'Fire', aim: 'Aim',
};

export interface SettingsData {
  graphics: {
    resolutionScale: number;
    adaptiveResolution: boolean;
    shadows: ShadowQuality;
    textureQuality: Quality;
    antialias: boolean;
    bloom: boolean;
    filmGrain: boolean;
    fogQuality: Quality;
    particleQuality: Quality;
    renderDistance: number;
    fpsLimit: number;
    showFps: boolean;
  };
  audio: { master: number; music: number; effects: number; ambient: number };
  controls: {
    sensitivity: number;
    invertY: boolean;
    aimMode: AimMode;
    bindings: Record<Action, string[]>;
  };
  accessibility: {
    reducedShake: boolean;
    reducedFlashing: boolean;
    uiScale: number;
  };
  profile: { name: string; primary: string; secondary: string };
}

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft'],
  // Ctrl+W closes browser tabs outside fullscreen, so C is offered alongside Ctrl.
  crouch: ['ControlLeft', 'KeyC'],
  jump: ['Space'],
  interact: ['KeyE'],
  reload: ['KeyR'],
  melee: ['KeyF'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  inventory: ['Tab'],
  shoulder: ['KeyV'],
  fire: ['Mouse0'],
  aim: ['Mouse2'],
};

export const DEFAULT_SETTINGS: SettingsData = {
  graphics: {
    resolutionScale: 1,
    adaptiveResolution: true,
    shadows: 'medium',
    textureQuality: 'high',
    antialias: true,
    bloom: true,
    filmGrain: true,
    fogQuality: 'high',
    particleQuality: 'high',
    renderDistance: 220,
    fpsLimit: 0,
    showFps: false,
  },
  audio: { master: 0.8, music: 0.6, effects: 0.9, ambient: 0.8 },
  controls: { sensitivity: 1, invertY: false, aimMode: 'hold', bindings: DEFAULT_BINDINGS },
  accessibility: { reducedShake: false, reducedFlashing: false, uiScale: 1 },
  profile: { name: 'Survivor', primary: 'ar', secondary: 'pistol' },
};

const STORAGE_KEY = 'deadhours.settings.v1';

type Listener = (s: SettingsData) => void;

function deepMerge<T>(base: T, patch: unknown): T {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (typeof cur === 'object' && cur !== null && !Array.isArray(cur)) out[k] = deepMerge(cur, v);
    else if (typeof v === typeof cur || (Array.isArray(cur) && Array.isArray(v))) out[k] = v;
  }
  return out as T;
}

/** Persisted, observable settings store. */
export class Settings {
  private data: SettingsData;
  private listeners = new Set<Listener>();

  constructor() {
    this.data = structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.data = deepMerge(this.data, JSON.parse(raw));
    } catch {
      /* storage unavailable (private mode) — defaults are fine */
    }
  }

  get value(): Readonly<SettingsData> {
    return this.data;
  }

  update(mutator: (s: SettingsData) => void): void {
    mutator(this.data);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l(this.data);
  }

  reset(section: keyof SettingsData): void {
    this.update((s) => {
      (s as unknown as Record<string, unknown>)[section] = structuredClone(DEFAULT_SETTINGS[section]);
    });
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const settings = new Settings();
