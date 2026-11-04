import { WEAPONS, type WeaponDef, type WeaponId } from './weapons';
import type { PlayerStats } from '../sim/Simulation';
import { GOALS_PER_NIGHT } from '../sim/Contracts';

/**
 * Progression between nights: XP for every run, levels, and what each level unlocks (weapon
 * attachments and weapon skins). The server is the authority: it adds XP from the runs it
 * records and checks every build a survivor brings or fits against their level and grants.
 *
 * Option lists below are part of the wire format (a build is indices into them): append new
 * options, never reorder or remove them.
 */

// ------------------------------------------------------------------ XP and levels

/** XP for one run: survival time, kills and the rest, itemized for the results screen. */
export interface RunXp {
  total: number;
  parts: { label: string; xp: number }[];
}

export const XP = {
  /** Per second survived after the outbreak began. */
  perSecond: 1 / 3,
  kill: 10,
  headshot: 5,
  limbSevered: 4,
  limbKill: 10,
  supply: 5,
  /** Each night goal the team finished (sim/Contracts). */
  goal: 150,
  /** Most a single run can award. */
  maxPerRun: 20000,
} as const;

export function runXp(survived: number, s: Pick<PlayerStats, 'kills' | 'headshots' | 'limbsSevered' | 'limbKills' | 'suppliesCollected'> & { goals?: number }): RunXp {
  const parts = [
    { label: 'Survived', xp: Math.floor(Math.max(0, survived) * XP.perSecond) },
    { label: 'Kills', xp: s.kills * XP.kill },
    { label: 'Headshots', xp: s.headshots * XP.headshot },
    { label: 'Arms severed', xp: s.limbsSevered * XP.limbSevered },
    { label: 'Arm kills', xp: s.limbKills * XP.limbKill },
    { label: 'Supplies', xp: s.suppliesCollected * XP.supply },
    { label: 'Night goals', xp: Math.min(GOALS_PER_NIGHT, s.goals ?? 0) * XP.goal },
  ].filter((p) => p.xp > 0);
  const total = Math.min(XP.maxPerRun, parts.reduce((n, p) => n + p.xp, 0));
  return { total, parts };
}

export const MAX_LEVEL = 50;

/** Total XP at which `level` begins (level 1 at 0, 2 at 300, 5 at 1,800, 10 at 6,300). */
export function levelStart(level: number): number {
  const n = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return 50 * (n - 1) * (n + 4);
}

export function levelFor(xp: number): number {
  let l = 1;
  while (l < MAX_LEVEL && xp >= levelStart(l + 1)) l++;
  return l;
}

/** Where a player stands: level, XP into it, XP the level spans (0 at the top level). */
export function levelProgress(xp: number): { level: number; into: number; span: number } {
  const level = levelFor(xp);
  const span = level >= MAX_LEVEL ? 0 : levelStart(level + 1) - levelStart(level);
  return { level, into: xp - levelStart(level), span };
}

// ------------------------------------------------------------------ attachments and skins

export type BuildSlot = 'optic' | 'muzzle' | 'grip' | 'mag' | 'skin';
export const BUILD_SLOTS: BuildSlot[] = ['optic', 'muzzle', 'grip', 'mag', 'skin'];
export const SLOT_LABELS: Record<BuildSlot, string> = { optic: 'Optic', muzzle: 'Muzzle', grip: 'Underbarrel', mag: 'Magazine', skin: 'Finish' };

/** Who can have an option: anyone who reaches its level, or holders of a grant (the Supporter Pack). */
export type UnlockSource = 'xp' | 'supporter';

export interface BuildOption {
  id: string;
  label: string;
  description: string;
  /** Level that unlocks it (xp options). */
  level: number;
  source: UnlockSource;
}

const opt = (id: string, label: string, level: number, description: string, source: UnlockSource = 'xp'): BuildOption => ({ id, label, level, description, source });

export const OPTICS = [
  opt('iron', 'Iron sights', 1, 'No optic: the open sights the weapon came with.'),
  opt('dot', 'Red dot', 2, 'Fast, clear dot. Slightly tighter aimed spread.'),
  opt('holo', 'Holographic', 6, 'Wide window with a ring reticle. Tighter aimed spread.'),
  opt('acog', '3× prism', 9, 'Magnified 3×. Much tighter aimed spread.'),
  opt('scope', '6× scope', 14, 'Magnified 6×, full scope view. Tightest aimed spread.'),
] as const satisfies readonly BuildOption[];

export const MUZZLES = [
  opt('none', 'Bare muzzle', 1, 'Nothing on the barrel.'),
  opt('suppressor', 'Suppressor', 3, 'Zombies hear shots from far less distance. A little less damage and range.'),
  opt('compensator', 'Compensator', 7, 'Much less recoil, a bit louder.'),
  opt('choke', 'Full choke', 12, 'Shotgun only: a tighter pellet pattern that reaches farther.'),
] as const satisfies readonly BuildOption[];

export const GRIPS = [
  opt('none', 'Bare rail', 1, 'Nothing under the barrel.'),
  opt('vertical', 'Vertical grip', 4, 'Less recoil, a little slower to draw.'),
  opt('angled', 'Angled grip', 10, 'Much faster to draw, slightly less recoil.'),
  opt('laser', 'Laser', 8, 'Tighter spread from the hip.'),
] as const satisfies readonly BuildOption[];

export const MAGS = [
  opt('standard', 'Standard', 1, 'The factory magazine.'),
  opt('extended', 'Extended', 5, 'Half again the rounds (two more shells in a tube). Slower to reload.'),
  opt('fast', 'Fast mag', 11, 'Pull tab and flared well: much quicker reloads.'),
] as const satisfies readonly BuildOption[];

export interface SkinOption extends BuildOption {
  /** Finish colors: one for a solid finish, several for patchwork camo. */
  colors: number[];
  /** Metal finish (gold) instead of the painted one. */
  metal?: boolean;
  /** Glows faintly in the dark (neon). */
  glow?: boolean;
}

const skin = (id: string, label: string, level: number, colors: number[], extra: Partial<SkinOption> = {}, source: UnlockSource = 'xp'): SkinOption => ({
  id, label, level, source, colors, description: source === 'supporter' ? 'Supporter Pack finish.' : `Unlocked at level ${level}.`, ...extra,
});

export const SKINS: SkinOption[] = [
  skin('factory', 'Factory', 1, [], { description: 'The finish it came with.' }),
  skin('olive', 'Olive drab', 2, [0x4a5232]),
  skin('desert', 'Desert tan', 4, [0x9c8660]),
  skin('urban', 'Urban camo', 6, [0x55585c, 0x2c2e31, 0x8a8d90]),
  skin('woodland', 'Woodland camo', 9, [0x3d4a2a, 0x5c4a30, 0x22261a, 0x6b7448]),
  skin('tiger', 'Tiger stripe', 12, [0x6c6a3a, 0x1d1f14, 0x8a6a34]),
  skin('arctic', 'Arctic', 15, [0xd8dcdc, 0xa4aaae, 0xeef0f0]),
  skin('rust', 'Rust', 18, [0x7a3a1c, 0x4a2414, 0x9a5426]),
  skin('bone', 'Bone', 21, [0xd6ccb4, 0xb8ab8c]),
  skin('crimson', 'Crimson', 25, [0x7a1418, 0x3a0a0c]),
  skin('gold', 'Gold', 30, [0xc89a3a], { metal: true }),
  skin('carbon', 'Carbon', 1, [0x18191b, 0x2a2c30], {}, 'supporter'),
  skin('neon', 'Neon', 1, [0x1e6a5e, 0x7a2a8a], { glow: true }, 'supporter'),
  skin('hazard', 'Hazard', 1, [0xd4a514, 0x1a1a1a], {}, 'supporter'),
];

export const BUILD_OPTIONS: Record<BuildSlot, readonly BuildOption[]> = { optic: OPTICS, muzzle: MUZZLES, grip: GRIPS, mag: MAGS, skin: SKINS };

/** One weapon's fitted options (ids from the lists above). */
export interface WeaponBuild {
  optic: string;
  muzzle: string;
  grip: string;
  mag: string;
  skin: string;
}

/** Builds for each gun a survivor has set up (weapons left out use their defaults). */
export type Loadout = Partial<Record<WeaponId, WeaponBuild>>;

interface Fitting {
  optic: string[];
  muzzle: string[];
  grip: string[];
  mag: string[];
}

/** What fits each gun. The first optic is the one it comes with; the rest of the defaults come first too. */
const FITTINGS: Partial<Record<WeaponId, Fitting>> = {
  ar: { optic: ['dot', 'iron', 'holo', 'acog', 'scope'], muzzle: ['none', 'suppressor', 'compensator'], grip: ['none', 'vertical', 'angled', 'laser'], mag: ['standard', 'extended', 'fast'] },
  smg: { optic: ['iron', 'dot', 'holo', 'acog'], muzzle: ['none', 'suppressor', 'compensator'], grip: ['none', 'vertical', 'angled', 'laser'], mag: ['standard', 'extended', 'fast'] },
  shotgun: { optic: ['iron', 'dot', 'holo'], muzzle: ['none', 'choke', 'suppressor'], grip: ['none', 'laser'], mag: ['standard', 'extended'] },
  marksman: { optic: ['scope', 'acog', 'dot', 'iron'], muzzle: ['none', 'suppressor', 'compensator'], grip: ['none', 'vertical', 'angled', 'laser'], mag: ['standard', 'extended', 'fast'] },
  pistol: { optic: ['iron', 'dot', 'holo', 'acog'], muzzle: ['none', 'suppressor', 'compensator'], grip: ['none', 'laser'], mag: ['standard', 'extended', 'fast'] },
  // Both guns of the pair carry the same build (optic, muzzle, laser, magazines and finish).
  akimbo: { optic: ['iron', 'dot', 'holo', 'acog'], muzzle: ['none', 'suppressor', 'compensator'], grip: ['none', 'laser'], mag: ['standard', 'extended', 'fast'] },
};

const NO_FITTING: Fitting = { optic: [], muzzle: [], grip: [], mag: [] };

/** Guns that take builds: every one but blades and the supply-drop exclusives (never loadout choices). */
export function buildable(id: WeaponId): boolean {
  const w = WEAPONS[id] as (WeaponDef & { exclusive?: boolean }) | undefined;
  return !!w && w.slot !== 'melee' && !w.exclusive;
}

/** Options a gun accepts in a slot, the default first. */
export function fitsOf(id: WeaponId, slot: BuildSlot): BuildOption[] {
  if (!buildable(id)) return [];
  if (slot === 'skin') return SKINS;
  const ids = (FITTINGS[id] ?? NO_FITTING)[slot];
  return ids.map((x) => BUILD_OPTIONS[slot].find((o) => o.id === x)!).filter(Boolean);
}

export function defaultBuild(id: WeaponId): WeaponBuild {
  const f = FITTINGS[id] ?? NO_FITTING;
  return { optic: f.optic[0] ?? 'iron', muzzle: f.muzzle[0] ?? 'none', grip: f.grip[0] ?? 'none', mag: f.mag[0] ?? 'standard', skin: 'factory' };
}

/** What a player has: their level and the grants on their profile (`supporter`, ...). */
export interface UnlockState {
  level: number;
  entitlements: readonly string[];
}

export const NO_UNLOCKS: UnlockState = { level: 1, entitlements: [] };

/** Whether a player may fit an option (a gun's own default is always theirs). */
export function owns(o: BuildOption, u: UnlockState): boolean {
  return o.source === 'xp' ? u.level >= o.level : u.entitlements.includes(o.source);
}

/** The build as it may be used: options that don't fit the gun or aren't the player's go back to the default. */
export function sanitizeBuild(id: WeaponId, b: Partial<WeaponBuild> | null | undefined, u: UnlockState): WeaponBuild {
  const def = defaultBuild(id);
  const out = { ...def };
  if (!b) return out;
  for (const slot of BUILD_SLOTS) {
    const want = b[slot];
    if (typeof want !== 'string' || want === def[slot]) continue;
    const o = fitsOf(id, slot).find((x) => x.id === want);
    if (o && owns(o, u)) out[slot] = o.id;
  }
  return out;
}

export function sanitizeLoadout(l: Loadout, u: UnlockState): Loadout {
  const out: Loadout = {};
  for (const id of Object.keys(l) as WeaponId[]) {
    if (!buildable(id)) continue;
    const b = sanitizeBuild(id, l[id], u);
    if (!sameBuild(b, defaultBuild(id))) out[id] = b;
  }
  return out;
}

export const sameBuild = (a: WeaponBuild, b: WeaponBuild): boolean => BUILD_SLOTS.every((s) => a[s] === b[s]);

// ------------------------------------------------------------------ wire format

const BUILD_WIRE = '1';

/** Five base-36 digits: optic, muzzle, grip, mag, skin (indices into the option lists). */
export function encodeBuild(b: WeaponBuild): string {
  return BUILD_SLOTS.map((s) => Math.max(0, BUILD_OPTIONS[s].findIndex((o) => o.id === b[s])).toString(36)).join('');
}

/** Unknown digits fall back to the gun's default (sanitize afterwards for ownership). */
export function decodeBuild(id: WeaponId, code: string): WeaponBuild {
  const out = defaultBuild(id);
  if (typeof code !== 'string') return out;
  BUILD_SLOTS.forEach((s, i) => {
    const n = parseInt(code[i] ?? '', 36);
    const o = Number.isFinite(n) ? BUILD_OPTIONS[s][n] : undefined;
    if (o) out[s] = o.id;
  });
  return out;
}

/** "1.ar:10002.pistol:00010": each customized gun by id. */
export function encodeLoadout(l: Loadout): string {
  const parts = (Object.keys(l) as WeaponId[]).filter((id) => buildable(id) && l[id]).sort().map((id) => `${id}:${encodeBuild(l[id]!)}`);
  return [BUILD_WIRE, ...parts].join('.');
}

export function decodeLoadout(s: unknown): Loadout {
  const out: Loadout = {};
  if (typeof s !== 'string' || s.length > 600) return out;
  const [ver, ...parts] = s.split('.');
  if (ver !== BUILD_WIRE) return out;
  for (const p of parts) {
    const [id, code] = p.split(':');
    if (buildable(id as WeaponId) && code) out[id as WeaponId] = decodeBuild(id as WeaponId, code);
  }
  return out;
}

// ------------------------------------------------------------------ what a build does

/** Each option's effect relative to the gun's stock build (whose numbers are the WEAPONS table). */
const OPTIC_AIM: Record<string, number> = { iron: 1, dot: 0.9, holo: 0.88, acog: 0.8, scope: 0.7 };

const tuned = new Map<string, WeaponDef>();

/** The weapon's numbers with a build fitted (cached; the stock build returns the table entry itself). */
export function tunedWeapon(id: WeaponId, b: WeaponBuild | undefined): WeaponDef {
  const base = WEAPONS[id];
  if (!b || !buildable(id)) return base;
  const key = `${id}:${encodeBuild(b)}`;
  let d = tuned.get(key);
  if (d) return d;
  const stock = defaultBuild(id);
  d = { ...base, stats: { ...base.stats } };
  d.aimSpread *= (OPTIC_AIM[b.optic] ?? 1) / (OPTIC_AIM[stock.optic] ?? 1);
  if (b.muzzle === 'suppressor') {
    d.noise *= 0.4;
    d.damage *= 0.92;
    d.range *= 0.9;
  } else if (b.muzzle === 'compensator') {
    d.recoil *= 0.75;
    d.noise *= 1.1;
  } else if (b.muzzle === 'choke') {
    d.hipSpread *= 0.7;
    d.aimSpread *= 0.7;
    d.range *= 1.2;
  }
  if (b.grip === 'vertical') {
    d.recoil *= 0.8;
    d.draw *= 1.1;
  } else if (b.grip === 'angled') {
    d.recoil *= 0.92;
    d.draw *= 0.8;
  } else if (b.grip === 'laser') d.hipSpread *= 0.72;
  if (b.mag === 'extended') {
    d.magazine = base.perShell ? base.magazine + 2 : Math.round(base.magazine * 1.5);
    d.reloadTime *= base.perShell ? (base.magazine + 2) / base.magazine : 1.15;
    d.draw *= 1.08;
  } else if (b.mag === 'fast') d.reloadTime *= 0.78;
  // Summary bars move with the numbers behind them.
  const s = d.stats;
  s.damage = Math.min(1, base.stats.damage * (d.damage / base.damage));
  s.range = Math.min(1, base.stats.range * (d.range / base.range));
  s.handling = Math.min(1, base.stats.handling * Math.sqrt((base.recoil / Math.max(0.01, d.recoil)) * (base.draw / d.draw)));
  tuned.set(key, d);
  return d;
}

/** Plain-words changes a build makes, for the editor ("+50% magazine", "−60% noise"). */
export function buildEffects(id: WeaponId, b: WeaponBuild): string[] {
  const a = WEAPONS[id];
  const d = tunedWeapon(id, b);
  const out: string[] = [];
  const pct = (label: string, from: number, to: number, lowerIsBetter = false) => {
    if (Math.abs(to - from) / Math.max(1e-6, Math.abs(from)) < 0.005) return;
    const p = Math.round((to / from - 1) * 100);
    const good = lowerIsBetter ? p < 0 : p > 0;
    out.push(`${good ? '▲' : '▼'} ${p > 0 ? '+' : '−'}${Math.abs(p)}% ${label}`);
  };
  if (d.magazine !== a.magazine) out.push(`▲ ${d.magazine} rounds (from ${a.magazine})`);
  pct('aimed spread', a.aimSpread, d.aimSpread, true);
  pct('hip spread', a.hipSpread, d.hipSpread, true);
  pct('recoil', a.recoil, d.recoil, true);
  pct('noise', a.noise, d.noise, true);
  pct('damage', a.damage, d.damage);
  pct('range', a.range, d.range);
  pct('reload time', a.reloadTime, d.reloadTime, true);
  pct('draw time', a.draw, d.draw, true);
  return out;
}

/** Every option and the level it opens at, in level order (the unlock track on the results and armory). */
export function unlockTrack(): { level: number; slot: BuildSlot; option: BuildOption }[] {
  const out: { level: number; slot: BuildSlot; option: BuildOption }[] = [];
  for (const slot of BUILD_SLOTS) {
    for (const o of BUILD_OPTIONS[slot]) if (o.source === 'xp' && o.level > 1) out.push({ level: o.level, slot, option: o });
  }
  return out.sort((a, b) => a.level - b.level);
}

/** Options that open between two levels (after a run: "unlocked: suppressor, desert tan"). */
export function unlockedBetween(from: number, to: number): BuildOption[] {
  return unlockTrack().filter((u) => u.level > from && u.level <= to).map((u) => u.option);
}

/** Seconds to swap an attachment on the weapon in hand (it can't fire meanwhile). */
export const FIT_TIME = 1.2;
