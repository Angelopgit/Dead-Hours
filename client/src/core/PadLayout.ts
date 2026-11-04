import { settings, type Action, type PadGlyphs } from './Settings';

/**
 * The controller's buttons by their standard Gamepad API index. Every pad the browser reports with the
 * "standard" mapping puts its buttons at these places, whatever is printed on them: 0 is always the
 * bottom face button, 1 the right one, and so on.
 */
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 } as const;
export const PAD_BUTTONS = 17;

/** Whose button names the prompts use. */
export type GlyphStyle = Exclude<PadGlyphs, 'auto'>;

/**
 * Button names in each style, by standard index. A generic pad's face buttons are named by where they sit
 * (▼ is the bottom one); the prompts draw them as a diamond of four with that one lit.
 */
const NAMES: Record<GlyphStyle, readonly string[]> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'VIEW', 'MENU', 'L3', 'R3', '↑', '↓', '←', '→', 'HOME'],
  playstation: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'CREATE', 'OPTIONS', 'L3', 'R3', '↑', '↓', '←', '→', 'PS'],
  nintendo: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', 'L3', 'R3', '↑', '↓', '←', '→', 'HOME'],
  generic: ['▼', '▶', '◀', '▲', 'L1', 'R1', 'L2', 'R2', 'SELECT', 'START', 'L3', 'R3', '↑', '↓', '←', '→', 'HOME'],
};

/** Which family a controller belongs to, from the id the browser gives it (vendor ids first: names vary by browser). */
export function styleOf(id: string): GlyphStyle {
  const s = id.toLowerCase();
  if (/054c|playstation|dualsense|dualshock|ps[345] controller/.test(s) || /^wireless controller/.test(s)) return 'playstation';
  if (/057e|nintendo|pro controller|joy-?con|switch/.test(s)) return 'nintendo';
  if (/045e|xbox|xinput|microsoft|x-box|0e6f|24c6/.test(s)) return 'xbox';
  return 'generic';
}

/** A DualShock 4 calls its left middle button SHARE (a DualSense calls it CREATE). */
const isDualShock4 = (id: string) => /054c/i.test(id) && /05c4|09cc|0ba0/i.test(id);

let detected: GlyphStyle = 'xbox';
let share = false;
const styleListeners = new Set<() => void>();

/** The controller in use now (its id), or null when none is: the prompts follow its family. */
export function setPadModel(id: string | null): void {
  const next = id ? styleOf(id) : detected;
  const ds4 = !!id && isDualShock4(id);
  if (next === detected && ds4 === share) return;
  detected = next;
  share = ds4;
  for (const fn of styleListeners) fn();
}

export function onGlyphStyle(fn: () => void): () => void {
  styleListeners.add(fn);
  return () => styleListeners.delete(fn);
}

/** The family whose button names are shown: the one picked in Settings, or the connected pad's. */
export function glyphStyle(): GlyphStyle {
  const s = settings.value.controls.padGlyphs;
  return s === 'auto' ? detected : s;
}

/** The style the connected controller was recognized as (for Settings' "Auto" line). */
export function detectedStyle(): GlyphStyle {
  return detected;
}

/**
 * Glyphs travel inside ordinary strings between two invisible separators, so a prompt can be put
 * together anywhere ("HOLD " + glyph + " TO BOARD UP") and the HUD can still draw the button as a
 * button. Anything that writes the string as plain text shows just its name.
 */
export const GLYPH = '⁣';

export function nameOf(button: number, style = glyphStyle()): string {
  if (style === 'playstation' && button === PAD.BACK && share) return 'SHARE';
  return NAMES[style][button] ?? `B${button}`;
}

/** A physical button as a glyph. */
export function glyph(button: number): string {
  return `${GLYPH}${nameOf(button)}${GLYPH}`;
}

/** Which physical button a glyph's name is in the given style (-1: none). */
export function buttonNamed(name: string, style = glyphStyle()): number {
  if (style === 'playstation' && name === 'SHARE') return PAD.BACK;
  return NAMES[style].indexOf(name);
}

/** Drops the glyph markers (for text that is compared or read aloud). */
export function plain(text: string): string {
  return text.split(GLYPH).join('');
}

// ------------------------------------------------------------------ the layout

/**
 * What each button does in play, by logical button (the default layout is the standard one; a remap
 * moves a whole button, its press and its hold together, to another physical button). An action is
 * done by a button's press, or by holding it.
 */
export const PAD_PLAY: Partial<Record<Action, { button: number; hold?: true }>> = {
  fire: { button: PAD.RT }, aim: { button: PAD.LT },
  jump: { button: PAD.A }, crouch: { button: PAD.B }, prone: { button: PAD.B, hold: true },
  reload: { button: PAD.X },
  weapon1: { button: PAD.Y }, weapon2: { button: PAD.Y }, weapon3: { button: PAD.Y }, gunsmith: { button: PAD.Y, hold: true },
  interact: { button: PAD.RB }, heal: { button: PAD.LB }, grenade: { button: PAD.LB, hold: true }, molotov: { button: PAD.LB, hold: true },
  melee: { button: PAD.RS }, sprint: { button: PAD.LS },
  flashlight: { button: PAD.UP }, shoulder: { button: PAD.UP, hold: true },
  barricade: { button: PAD.DOWN }, talk: { button: PAD.LEFT }, radio: { button: PAD.RIGHT },
  inventory: { button: PAD.BACK },
};

/** The buttons in Settings' layout list, in that order, with what a press and a hold do. */
export const PAD_ROWS: { button: number; press: string; hold?: string }[] = [
  { button: PAD.RT, press: 'Fire' },
  { button: PAD.LT, press: 'Aim' },
  { button: PAD.A, press: 'Jump, vault, get up' },
  { button: PAD.B, press: 'Crouch on or off (dive while sprinting)', hold: 'Go prone' },
  { button: PAD.X, press: 'Reload' },
  { button: PAD.Y, press: 'Switch weapon', hold: 'Customize weapon' },
  { button: PAD.RB, press: 'Interact', hold: 'Pry a board off' },
  { button: PAD.LB, press: 'Use bandage', hold: 'Ready a grenade or Molotov, let go to throw' },
  { button: PAD.RS, press: 'Melee attack' },
  { button: PAD.LS, press: 'Sprint' },
  { button: PAD.UP, press: 'Flashlight on or off', hold: 'Switch shoulder' },
  { button: PAD.DOWN, press: 'Board up' },
  { button: PAD.LEFT, press: 'Push to talk' },
  { button: PAD.RIGHT, press: 'Team radio' },
  { button: PAD.BACK, press: 'Inventory (hold)' },
];

/** Start always pauses (it can't be moved, so the menu can always be reached). */
export const FIXED_BUTTONS: readonly number[] = [PAD.START, PAD.HOME];

/** Ready-made layouts: each is a list of button swaps from the standard one. */
export const PAD_PRESETS: Record<'standard' | 'tactical' | 'southpaw', { label: string; swaps: [number, number][]; sticks: boolean }> = {
  standard: { label: 'Standard', swaps: [], sticks: false },
  // Crouch on the right stick's click and melee on B, as many shooters do (no thumb off the stick to crouch).
  tactical: { label: 'Tactical', swaps: [[PAD.B, PAD.RS]], sticks: false },
  // Move on the right stick, look on the left; the stick clicks follow their sticks.
  southpaw: { label: 'Southpaw', swaps: [[PAD.LS, PAD.RS]], sticks: true },
};

/** physical → logical, for every button (the saved remap, or the standard layout). */
export function remap(): number[] {
  const saved = settings.value.controls.padRemap;
  const out = Array.from({ length: PAD_BUTTONS }, (_, i) => i);
  if (saved.length === PAD_BUTTONS && [...saved].sort((a, b) => a - b).every((v, i) => v === i)) {
    for (let i = 0; i < PAD_BUTTONS; i++) out[i] = saved[i];
  }
  return out;
}

/** The physical button that does what the standard layout's `logical` button does. */
export function physicalOf(logical: number): number {
  const r = remap();
  const i = r.indexOf(logical);
  return i < 0 ? logical : i;
}

/** Moves a logical button to the physical `button`, swapping with whatever was there (a new remap). */
export function moveButton(map: number[], logical: number, button: number): number[] {
  const out = map.slice();
  const from = out.indexOf(logical);
  if (from < 0 || from === button || FIXED_BUTTONS.includes(button) || FIXED_BUTTONS.includes(from)) return out;
  [out[from], out[button]] = [out[button], out[from]];
  return out;
}

/** The remap a preset makes. */
export function presetMap(name: keyof typeof PAD_PRESETS): number[] {
  let map = Array.from({ length: PAD_BUTTONS }, (_, i) => i);
  for (const [a, b] of PAD_PRESETS[name].swaps) map = moveButton(map, a, b);
  return map;
}

/** Which preset the current layout is, if it is one. */
export function currentPreset(): keyof typeof PAD_PRESETS | null {
  const map = remap();
  const sticks = settings.value.controls.padSwapSticks;
  for (const name of Object.keys(PAD_PRESETS) as (keyof typeof PAD_PRESETS)[]) {
    if (PAD_PRESETS[name].sticks === sticks && presetMap(name).every((v, i) => v === map[i])) return name;
  }
  return null;
}

/** What to press for an action on a controller, as a glyph ("HOLD" in front of the ones held down, as HUD lines are in capitals); '' if none. */
export function padLabel(action: Action): string {
  const at = PAD_PLAY[action];
  if (!at) return '';
  const g = glyph(physicalOf(at.button));
  return at.hold ? `HOLD ${g}` : g;
}

/** The menus' confirm and back buttons: a Nintendo pad confirms with its right button (A), as its own menus do. */
export function menuButtons(): { ok: number; back: number } {
  return glyphStyle() === 'nintendo' ? { ok: PAD.B, back: PAD.A } : { ok: PAD.A, back: PAD.B };
}
