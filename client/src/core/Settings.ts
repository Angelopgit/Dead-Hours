import { DEFAULT_APPEARANCE, type Appearance } from '@dead-hours/shared';

export type ShadowQuality = 'off' | 'low' | 'medium' | 'high';
export type Quality = 'low' | 'medium' | 'high';
export type AimMode = 'hold' | 'toggle';
/** Aiming looks down the sights in first person, or zooms over the shoulder. */
export type AimView = 'sights' | 'shoulder';
export type GoreLevel = 'off' | 'reduced' | 'full';
/** Voice goes out while a key is held, or whenever the microphone hears speech. */
export type VoiceMode = 'ptt' | 'vad';
/** How strongly a stick or a thumb is helped onto a zombie. */
export type AimAssist = 'off' | 'low' | 'standard';
/** On-screen thumb controls: shown on touch screens, or always, or never. */
export type TouchMode = 'auto' | 'on' | 'off';
/** Whose button names the prompts show: the connected controller's (auto), or one picked. */
export type PadGlyphs = 'auto' | 'xbox' | 'playstation' | 'nintendo' | 'generic';
export type GraphicsPreset = 'phone' | 'low' | 'medium' | 'high';
/** Wind-swayed grass on the lawns: how dense and how far it reaches. */
export type GrassQuality = 'off' | 'low' | 'medium' | 'high';
/** Puddles mirror the street (Low: a coarser, shorter-range image), or reflect only the sky and lamps. */
export type ReflectionQuality = 'off' | 'low' | 'high';

export type Action =
  | 'forward' | 'back' | 'left' | 'right'
  | 'sprint' | 'crouch' | 'prone' | 'jump' | 'interact' | 'barricade'
  | 'reload' | 'melee' | 'weapon1' | 'weapon2' | 'weapon3'
  | 'inventory' | 'shoulder' | 'fire' | 'aim' | 'heal'
  | 'talk' | 'radio' | 'chat' | 'gunsmith' | 'grenade' | 'molotov' | 'flashlight';

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward', back: 'Move back', left: 'Move left', right: 'Move right',
  sprint: 'Sprint', crouch: 'Crouch (dive when sprinting)', prone: 'Go prone (dive when sprinting)', jump: 'Jump / Vault', interact: 'Interact', barricade: 'Board up / pry off',
  reload: 'Reload', melee: 'Melee attack', weapon1: 'Primary weapon', weapon2: 'Secondary weapon', weapon3: 'Melee weapon in hand',
  inventory: 'Inventory', shoulder: 'Switch shoulder', fire: 'Fire', aim: 'Aim', heal: 'Use bandage',
  talk: 'Push to talk', radio: 'Team radio', chat: 'Text chat', gunsmith: 'Customize weapon',
  grenade: 'Throw grenade (hold to aim)', molotov: 'Throw Molotov (hold to aim)',
  flashlight: 'Flashlight on / off',
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
    /** Screen-space ambient occlusion (contact shadows). */
    ambientOcclusion: boolean;
    /** Camera motion blur. */
    motionBlur: boolean;
    /** Rain, wet streets and puddles. */
    rain: boolean;
    /** Low fog is flat; medium and high add volumetric light shafts. */
    fogQuality: Quality;
    grass: GrassQuality;
    reflections: ReflectionQuality;
    particleQuality: Quality;
    gore: GoreLevel;
    renderDistance: number;
    fpsLimit: number;
    showFps: boolean;
  };
  audio: { master: number; music: number; effects: number; ambient: number; voice: number };
  voice: {
    enabled: boolean;
    mode: VoiceMode;
    /** Voice activation opens above this microphone level (dBFS). */
    threshold: number;
    /** Microphone deviceId ('' for the system default). */
    device: string;
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
    /** Hear survivors who talk on the team radio. */
    radio: boolean;
    /** Send voice through the server's TURN relay only (strict networks, hides your address). */
    relayOnly: boolean;
  };
  controls: {
    sensitivity: number;
    invertY: boolean;
    aimMode: AimMode;
    aimView: AimView;
    bindings: Record<Action, string[]>;
    /** Right stick turn speed (1 is about 200° a second at full tilt). */
    padSensitivity: number;
    /** Thumb drag turn speed on touch screens. */
    touchSensitivity: number;
    aimAssist: AimAssist;
    /** Controller rumble and phone vibration on shots and hits. */
    vibration: boolean;
    /** How strong the rumble is, 0..1. */
    vibrationStrength: number;
    /** Button names in prompts. */
    padGlyphs: PadGlyphs;
    /** Controller buttons moved about: physical index → the standard button it acts as (empty: the standard layout). */
    padRemap: number[];
    /** Move with the right stick and look with the left. */
    padSwapSticks: boolean;
    /** Up on the look stick looks down. */
    padInvertY: boolean;
    /** How far a stick must lean before it counts (0..1 of its throw), for moving and for looking. */
    padDeadzoneMove: number;
    padDeadzoneLook: number;
    touch: TouchMode;
    /** Size of the on-screen buttons. */
    touchScale: number;
  };
  accessibility: {
    reducedShake: boolean;
    reducedFlashing: boolean;
    uiScale: number;
  };
  profile: {
    name: string; primary: string; secondary: string; appearance: Appearance;
    /** encodeLoadout() of the weapon builds (attachments and finishes). */
    builds: string;
    /** XP earned in solo runs while no server could be reached: counts in this browser only. */
    offlineXp: number;
  };
}

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft'],
  // Ctrl+W closes browser tabs outside fullscreen, so C is offered alongside Ctrl.
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  jump: ['Space'],
  interact: ['KeyE'],
  barricade: ['KeyG'],
  reload: ['KeyR'],
  melee: ['KeyF'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit5'],
  inventory: ['Tab'],
  shoulder: ['KeyV'],
  fire: ['Mouse0'],
  aim: ['Mouse2'],
  heal: ['KeyQ'],
  talk: ['KeyT'],
  radio: ['KeyB'],
  chat: ['Enter'],
  gunsmith: ['KeyH'],
  grenade: ['Digit3'],
  molotov: ['Digit4'],
  flashlight: ['KeyL'],
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
    ambientOcclusion: true,
    motionBlur: true,
    rain: true,
    fogQuality: 'high',
    grass: 'high',
    reflections: 'high',
    particleQuality: 'high',
    gore: 'full',
    renderDistance: 220,
    fpsLimit: 0,
    showFps: false,
  },
  audio: { master: 0.8, music: 0.6, effects: 0.9, ambient: 0.8, voice: 1 },
  voice: {
    enabled: true, mode: 'ptt', threshold: -48, device: '',
    echoCancellation: true, noiseSuppression: true, autoGainControl: true, radio: true, relayOnly: false,
  },
  controls: {
    sensitivity: 1, invertY: false, aimMode: 'hold', aimView: 'sights', bindings: DEFAULT_BINDINGS,
    padSensitivity: 1, touchSensitivity: 1, aimAssist: 'standard', vibration: true, touch: 'auto', touchScale: 1,
    vibrationStrength: 1, padGlyphs: 'auto', padRemap: [], padSwapSticks: false, padInvertY: false, padDeadzoneMove: 0.14, padDeadzoneLook: 0.14,
  },
  accessibility: { reducedShake: false, reducedFlashing: false, uiScale: 1 },
  profile: { name: 'Survivor', primary: 'ar', secondary: 'pistol', appearance: { ...DEFAULT_APPEARANCE }, builds: '1', offlineXp: 0 },
};

/** Graphics settings for each preset. Phone trades shadows, MSAA and bloom for a steady frame rate. */
export const GRAPHICS_PRESETS: Record<GraphicsPreset, Partial<SettingsData['graphics']>> = {
  phone: {
    resolutionScale: 0.7, adaptiveResolution: true, shadows: 'off', textureQuality: 'medium', antialias: false,
    bloom: false, filmGrain: false, ambientOcclusion: false, motionBlur: false, rain: false, fogQuality: 'low', grass: 'low', reflections: 'off',
    particleQuality: 'low', renderDistance: 120, fpsLimit: 30,
  },
  low: {
    resolutionScale: 0.8, adaptiveResolution: true, shadows: 'low', textureQuality: 'medium', antialias: false,
    bloom: false, filmGrain: false, ambientOcclusion: false, motionBlur: false, rain: true, fogQuality: 'low', grass: 'low', reflections: 'off',
    particleQuality: 'low', renderDistance: 150, fpsLimit: 0,
  },
  medium: {
    resolutionScale: 1, adaptiveResolution: true, shadows: 'medium', textureQuality: 'high', antialias: false,
    bloom: true, filmGrain: true, ambientOcclusion: true, motionBlur: false, rain: true, fogQuality: 'medium', grass: 'medium', reflections: 'low',
    particleQuality: 'medium', renderDistance: 200, fpsLimit: 0,
  },
  high: {
    resolutionScale: 1, adaptiveResolution: true, shadows: 'high', textureQuality: 'high', antialias: true,
    bloom: true, filmGrain: true, ambientOcclusion: true, motionBlur: true, rain: true, fogQuality: 'high', grass: 'high', reflections: 'high',
    particleQuality: 'high', renderDistance: 260, fpsLimit: 0,
  },
};

/** A phone or small tablet: a touch screen as the main pointer and a small screen or a mobile browser. */
export function isPhone(): boolean {
  if (typeof window === 'undefined' || typeof matchMedia === 'undefined') return false;
  const coarse = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  const small = Math.min(screen.width, screen.height) <= 820;
  const ua = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return coarse && (small || ua);
}

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
      if (raw) {
        const saved = JSON.parse(raw);
        this.data = deepMerge(this.data, saved);
        // Saved before grass existed: match it to the rest of the graphics (phones and Low get the light grass).
        if (saved?.graphics && !('grass' in saved.graphics)) {
          const p = this.data.graphics.particleQuality;
          this.data.graphics.grass = isPhone() || p === 'low' ? 'low' : p;
        }
        // Saved before reflections had a setting: follow the fog quality the player picked
        // (it tracks the preset), so a Low or Phone setup doesn't start drawing a mirror.
        if (saved?.graphics && !('reflections' in saved.graphics)) {
          this.data.graphics.reflections = ({ low: 'off', medium: 'low', high: 'high' } as const)[this.data.graphics.fogQuality];
        }
        // Saved when one invert setting served the mouse and the controller alike: the controller keeps what it had.
        if (saved?.controls && !('padInvertY' in saved.controls)) this.data.controls.padInvertY = this.data.controls.invertY;
      }
      // First visit on a phone: start from the phone preset (it can be changed in Settings).
      else if (isPhone()) Object.assign(this.data.graphics, GRAPHICS_PRESETS.phone);
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

  applyPreset(preset: GraphicsPreset): void {
    this.update((s) => { Object.assign(s.graphics, GRAPHICS_PRESETS[preset]); });
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
