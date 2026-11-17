/**
 * Shape checks for what a player host sends. On the game server's own nights the sender is the
 * server; in a player-hosted game it is another player's browser, which could be a modified one.
 * These keep a broken or hostile message from freezing or crashing this player's game (huge
 * arrays, numbers that aren't numbers, things where lists should be); they don't judge whether
 * the night it describes is a fair one.
 */

/** Most rows a list in a snapshot may hold (zombies, limbs, items, vehicles...). */
const MAX_ROWS = 2000;
const MAX_ROW = 96;
const MAX_TEXT = 4000;
const MAX_EVENTS = 2000;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e12;
const cell = (v: unknown) => num(v) || (typeof v === 'string' && v.length <= MAX_TEXT);
const row = (v: unknown) => Array.isArray(v) && v.length <= MAX_ROW && v.every(cell);
const rows = (v: unknown) => Array.isArray(v) && v.length <= MAX_ROWS && v.every(row);
const flat = (v: unknown) => Array.isArray(v) && v.length <= MAX_ROWS * 8 && v.every(cell);
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
const rowOrZero = (v: unknown) => v === 0 || row(v);

function sanePlayer(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  const s = p.s as Record<string, unknown> | null;
  return typeof p.id === 'string' && p.id.length <= 64 && typeof p.n === 'string' && p.n.length <= 64 && typeof p.a === 'string' && p.a.length <= 800
    && row(p.m) && (p.m as unknown[]).length >= 11 && (p.m as unknown[]).every(num)
    && num(p.hp) && num(p.al) && num(p.b) && num(p.dt) && optional(p.ar, num) && optional(p.bo, row)
    && row(p.w) && (p.w as unknown[]).length >= 10 && rowOrZero(p.lb) && rowOrZero(p.dn)
    && typeof p.rv === 'string' && p.rv.length <= 64 && optional(p.k, (k) => typeof k === 'string' && k.length <= 400)
    && !!s && typeof s === 'object' && Object.keys(s).length <= 32 && Object.values(s).every(num);
}

/** A snapshot whose every part is the kind of thing the mirror expects, within sane sizes. */
export function saneSnapshot(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return num(s.t) && num(s.ph) && num(s.pt)
    && Array.isArray(s.p) && s.p.length <= 16 && s.p.every(sanePlayer)
    && rows(s.z) && rows(s.l) && flat(s.d) && rows(s.i)
    && optional(s.dw, flat) && optional(s.b, flat) && optional(s.g, (g) => typeof g === 'string' && g.length <= MAX_TEXT)
    && optional(s.v, row) && optional(s.r, rows) && optional(s.sk, rows) && optional(s.lu, row) && optional(s.vh, rows)
    && optional(s.vt, flat) && optional(s.bk, rows) && optional(s.ct, row) && optional(s.vo, flat) && optional(s.bp, flat) && optional(s.fs, flat);
}

/** Whether a value is plain data of a sane size: no deeper than a few levels, no non-finite numbers. */
function plain(v: unknown, depth: number, budget: { left: number }): boolean {
  if (--budget.left < 0) return false;
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= MAX_TEXT;
  if (typeof v !== 'object' || depth <= 0) return false;
  if (Array.isArray(v)) return v.length <= MAX_ROWS && v.every((x) => plain(x, depth - 1, budget));
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  return keys.length <= 64 && keys.every((k) => plain(o[k], depth - 1, budget));
}

/** A step's events: a list of plain objects, each saying what kind it is. */
export function saneEvents(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > MAX_EVENTS) return false;
  const budget = { left: 20000 };
  return v.every((e) => !!e && typeof e === 'object' && !Array.isArray(e) && typeof (e as { type?: unknown }).type === 'string' && plain(e, 6, budget));
}
