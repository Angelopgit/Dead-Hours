/**
 * Dev-only: the in-game HUD at its busiest, drawn without a night behind it, for checking the layout
 * at any window size, UI scale and button size in a moment (`/dev/hud.html?scene=foot&ui=1.4&tc=1`).
 *
 * - `scene`: `foot` (everything at once: timer, warning, notice, feed, prompt, five boosts, armor, every
 *   weapon row, chat and voices online), `skate` (a trick landing), `car` (driving), `ride` (a passenger),
 *   `downed`, `dead` (watching a teammate) or `lost` (`foot` with CONNECTION LOST).
 * - `ui`: the UI scale (0.8..1.4), `tc`: the touch button size (0.75..1.4), `touch=0` for the desktop
 *   HUD, `online=0` for solo (no chat, no TALK), `fps=1` shows the frame rate line.
 *
 * `window.__hudAudit()` lists every two pieces of the HUD whose letters or buttons overlap (letters are
 * measured by their ink, not their line boxes), and every piece that runs off the screen or into a notch.
 * `node client/dev/hud-sweep.cjs` runs it across phone sizes, UI scales and button sizes; not part of the
 * game build.
 */
import '../src/ui/styles.css';
import gsap from 'gsap';
import { WEAPONS, type ChatLine } from '@dead-hours/shared';
import { HUD } from '../src/ui/HUD';
import { TouchControls } from '../src/ui/TouchControls';
import { ChatBox } from '../src/ui/ChatBox';
import { Input } from '../src/core/Input';
import { settings } from '../src/core/Settings';
import { h } from '../src/ui/dom';
import type { NetLink } from '../src/network/NetLink';

const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'foot';
const ui = Number(q.get('ui') ?? 1);
const tc = Number(q.get('tc') ?? 1);
const touch = q.get('touch') !== '0';
const online = q.get('online') !== '0';
const NAME = 'ALEXANDRA MORGAN';
const MATE = 'CHRISTOPHER LEE';

document.documentElement.style.setProperty('--ui-scale', String(ui));
const root = document.getElementById('ui-root')!;
const input = new Input(document.getElementById('viewport')!);
document.body.classList.toggle('touch-play', touch);

const hud = new HUD(NAME);
root.append(hud.el);

const now = performance.now();
if (online) {
  const lines: (ChatLine & { at: number })[] = [
    { pid: 'a', name: MATE, text: 'brute on the porch, coming round the back', at: now + 1e9 },
    { pid: 'b', name: 'SAM', text: 'got ammo in the garage', at: now + 1e9 },
    { pid: 'c', name: 'RIVERA', text: 'omw', at: now + 1e9 },
  ];
  const link = { chat: { lines, subscribe: () => () => {}, say: () => false } } as unknown as NetLink;
  const chat = new ChatBox(link, 'game');
  const vox = h('div', { class: 'vox-list' },
    h('div', { class: 'vox' }, h('i'), MATE),
    h('div', { class: 'vox radio' }, h('i'), 'SAM · RADIO'));
  root.append(h('div', { class: 'comms-hud' }, vox, chat.el));
}

// The button size setting, without saving it (the buttons still fit it to the screen).
(settings.value.controls as { touchScale: number }).touchScale = tc;
const tcs = new TouchControls(input, online);
tcs.setVisible(touch && scene !== 'dead');
root.append(tcs.el);
hud.onPrompt = (action, text) => tcs.setUse(action, text);

hud.setHealth(64, 100);
hud.setTimer('DOWNTIME — 00:45 LEFT · SURVIVED 59:59', true);
hud.setWarning('OUT OF AMMUNITION · USE YOUR HOCKEY STICK');
for (const line of ['SOMEONE ELSE GOT TO THAT SKATEBOARD', 'HANDS ON THE BARS · USE TO GET OFF', 'LEFT THE M107 .50 CAL BEHIND', `${MATE} REVIVED ${NAME}`]) hud.feedLine(line);
hud.weapon({
  model: 'M107 .50 CAL', mag: 100, magazine: 100, reserve: 400, mode: 'SEMI', reload: 0.45, slot: 'primary',
  primaryModel: 'M107 .50 CAL', secondaryModel: 'AKIMBO M17', meleeModel: 'HOCKEY STICK',
  bandages: 9, healing: null, frags: 3, molotovs: 2, light: true,
});
hud.setArmor(60, 100);
hud.setBoosts([
  { id: 'strength', label: 'STRENGTH', color: 0xd8443a, left: 70, total: 75 },
  { id: 'stamina', label: 'STAMINA', color: 0xe8b72e, left: 80, total: 90 },
  { id: 'reload', label: 'RAPID RELOAD', color: 0x3c8ee6, left: 85, total: 90 },
  { id: 'regen', label: 'REGEN', color: 0x46c46a, left: 37, total: 40 },
  { id: 'focus', label: 'FOCUS', color: 0x9b6ae0, left: 72, total: 75 },
]);

if (scene === 'foot' || scene === 'lost') {
  hud.setStance('GRENADE READY');
  hud.notify(`${WEAPONS.sniper.model} EQUIPPED`, WEAPONS.sniper.description, 999, 'rare');
  hud.setPrompt('interact', `PRY A BOARD OFF THE WINDOW · 3/4 · HOLD ${touch ? 'BOARD' : 'G'} TO ADD ONE`);
} else if (scene === 'skate') {
  hud.setStance('');
  hud.notify('SKATEBOARD', touch ? 'STICK UP PUSHES · DOWN BRAKES · SIDEWAYS CARVES · JUMP OLLIES · USE HOPS OFF'
    : 'W PUSH · S BRAKE · A/D CARVE · SPACE OLLIE · SHIFT PUSH HARDER · E HOP OFF', 999);
  hud.setPrompt('interact', 'HOP OFF THE SKATEBOARD');
  hud.trickCall('VARIAL HEELFLIP', 3);
} else if (scene === 'ride') {
  tcs.setSeat('passenger');
  hud.setStance('');
  hud.setVehicle({ name: 'POLICE CAR', seat: 'PASSENGER', mph: 48, gas: 0.5, state: '' });
  hud.notify('PASSENGER', touch ? 'SHOOT FROM THE WINDOWS · SEAT MOVES OVER · USE GETS OUT' : 'SHOOT FROM THE WINDOWS · G CHANGE SEAT · E GET OUT', 999);
  hud.setPrompt('interact', 'GET OUT · SEAT MOVES OVER');
} else if (scene === 'car') {
  tcs.setSeat('driver');
  hud.setStance('');
  hud.setVehicle({ name: 'ARMORED TRUCK', seat: 'DRIVING', mph: 48, gas: 0.08, state: 'LIGHTS OFF' });
  hud.notify('DRIVING · WATCH THE GAS', touch
    ? 'STICK UP GAS · DOWN BRAKE AND REVERSE · SIDEWAYS STEERS · BRAKE BUTTON HANDBRAKE · HORN · USE GETS OUT'
    : 'W GAS · S BRAKE AND REVERSE · A/D STEER · SPACE HANDBRAKE · F HORN · L LIGHTS · E GET OUT', 999);
  hud.setPrompt('interact', 'SLOW DOWN TO GET OUT · SEAT MOVES OVER');
} else if (scene === 'downed') {
  hud.setStance('DOWN');
  hud.notify('YOU ARE DOWN', 'ONE MORE AND YOU ARE DEAD · HOLD ON', 999, 'danger');
  root.append(h('div', { class: 'downed-panel' }, h('div', { class: 'dp-text' }, `${MATE} IS GETTING YOU UP`),
    h('div', { class: 'dp-bar' }, h('i', { style: 'width:40%' }))));
} else if (scene === 'dead') {
  hud.el.style.opacity = '0';
  root.append(h('div', { class: 'spectate' }, `WATCHING ${MATE} · ${touch ? 'TAP HERE' : 'ESC'} FOR RESULTS`));
}
if (scene === 'lost') root.append(h('div', { class: 'spectate net-lost' }, 'CONNECTION LOST · RECONNECTING'));
// (The setting is off by default: the line is written straight in.)
if (q.get('fps') === '1') root.querySelector('.fps')!.textContent = online ? '58 FPS · 42 MS' : '58 FPS';

// Every fade in done, then held still (the notice letters settle, the feed lines stay up).
gsap.globalTimeline.totalTime(gsap.globalTimeline.totalTime() + 1);
gsap.globalTimeline.pause();
document.body.dataset.ready = '1';

// ------------------------------------------------------------------ audit

interface Piece { name: string; group: string; rects: DOMRect[] }

const ctx = document.createElement('canvas').getContext('2d')!;

/** How much of an element shows: its opacity times every parent's, 0 when hidden. */
function shown(el: Element): number {
  let k = 1;
  for (let e: Element | null = el; e; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
    k *= Number(cs.opacity);
  }
  return k;
}

/** `r` cut to what its scrolled or clipped parents let show (a chat line scrolled up out of the log is not there). */
function clip(el: Element, r: DOMRect): DOMRect | null {
  let l = r.left, t = r.top, rt = r.right, b = r.bottom;
  for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const c = e.getBoundingClientRect();
    l = Math.max(l, c.left); t = Math.max(t, c.top); rt = Math.min(rt, c.right); b = Math.min(b, c.bottom);
  }
  return rt - l > 0.5 && b - t > 0.5 ? new DOMRect(l, t, rt - l, b - t) : null;
}

/** The ink of the letters under `el`: each line of each text, from the top of its tallest letter to the bottom of its lowest. */
function ink(el: Element): DOMRect[] {
  const out: DOMRect[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.textContent ?? '';
    const parent = n.parentElement!;
    if (!text.trim() || shown(parent) < 0.1) continue;
    const cs = getComputedStyle(parent);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = ctx.measureText(text.trim());
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 1) continue;
      const base = r.top + m.fontBoundingBoxAscent;
      const c = clip(parent, new DOMRect(r.left, base - m.actualBoundingBoxAscent, r.width, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent));
      if (c) out.push(c);
    }
  }
  return out;
}

function box(el: Element): DOMRect[] {
  if (shown(el) < 0.1) return [];
  const r = clip(el, el.getBoundingClientRect());
  return r ? [r] : [];
}

function pieces(): Piece[] {
  const list: Piece[] = [];
  const add = (group: string, name: string, rects: DOMRect[]) => { if (rects.length) list.push({ group, name, rects }); };
  const all = (sel: string) => Array.from(root.querySelectorAll(sel));
  const one = (sel: string) => root.querySelector(sel);
  const text = (group: string, name: string, sel: string) => { const e = one(sel); if (e) add(group, name, ink(e)); };
  text('timer', 'timer', '.phase-timer');
  text('warning', 'warning', '.warning');
  text('notice', 'notice', '.notice');
  text('trick', 'trick', '.trick-call');
  all('.feed > div').forEach((e, i) => add('feed', `feed ${i + 1}`, ink(e)));
  const prompt = one('.prompt');
  if (prompt) add('prompt', 'prompt', [...ink(prompt), ...all('.prompt .k').flatMap(box)]);
  text('vitals', 'name and health', '.vitals .name');
  const bar = one('.vitals .hbar');
  if (bar) add('vitals', 'health bar', box(bar));
  const armor = one('.vitals .armor');
  if (armor && shown(armor) > 0.1) add('vitals', 'armor', [...ink(armor), ...box(armor.querySelector('.abar')!)]);
  text('stance', 'stance', '.vitals .stance');
  all('.boost-chip').forEach((e, i) => add('chips', `boost ${i + 1}`, box(e)));
  all('.w-slot').forEach((e, i) => add('weapon', `slot ${i + 1}`, ink(e)));
  text('weapon', 'gun', '.w-model');
  text('weapon', 'ammo', '.w-ammo');
  text('weapon', 'fire mode', '.w-mode');
  const wbar = one('.w-bar.show');
  if (wbar) add('weapon', 'reload bar', box(wbar));
  all('.w-heal').forEach((e) => add('weapon', (e.textContent ?? '').split(' ')[0].toLowerCase(), ink(e)));
  const car = one('.car-panel');
  if (car && shown(car) > 0.1) add('car', 'vehicle', [...ink(car), ...box(car.querySelector('.gbar')!)]);
  text('fps', 'fps', '.fps');
  all('.vox').forEach((e, i) => add('comms', `talking ${i + 1}`, ink(e)));
  all('.chat-line').forEach((e, i) => add('comms', `chat ${i + 1}`, ink(e)));
  const down = one('.downed-panel');
  if (down) add('downed', 'downed', [...ink(down), ...box(down.querySelector('.dp-bar')!)]);
  all('.spectate').forEach((e) => add('spectate', e.classList.contains('net-lost') ? 'connection lost' : 'watching', ink(e)));
  for (const b of all('.tc-btn')) add(`button ${b.classList[1]}`, `${(b.getAttribute('aria-label') ?? '').toUpperCase()} button`, box(b));
  // The crosshair (its lines at the widest a still gun spreads them).
  if (one('.crosshair') && scene !== 'dead' && scene !== 'car') {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    add('crosshair', 'crosshair', [new DOMRect(cx - 14, cy - 14, 28, 28)]);
  }
  return list;
}

function insets(): { top: number; right: number; bottom: number; left: number } {
  const probe = h('div', { style: 'position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' });
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const r = { top: parseFloat(cs.paddingTop), right: parseFloat(cs.paddingRight), bottom: parseFloat(cs.paddingBottom), left: parseFloat(cs.paddingLeft) };
  probe.remove();
  return r;
}

export interface Finding { kind: 'overlap' | 'offscreen' | 'notch'; a: string; b?: string; w: number; h: number }

function audit(): Finding[] {
  const ps = pieces();
  const out: Finding[] = [];
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (a.group === b.group) continue;
      let best = { w: 0, h: 0 };
      for (const ra of a.rects) for (const rb of b.rects) {
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const hh = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 0.5 && hh > 0.5 && w * hh > best.w * best.h) best = { w, h: hh };
      }
      if (best.w > 0) out.push({ kind: 'overlap', a: a.name, b: b.name, w: Math.round(best.w), h: Math.round(best.h) });
    }
  }
  const safe = insets();
  for (const p of ps) {
    let off = 0, notch = 0;
    for (const r of p.rects) {
      off = Math.max(off, -r.left, -r.top, r.right - innerWidth, r.bottom - innerHeight);
      notch = Math.max(notch, safe.left - r.left, r.right - (innerWidth - safe.right), r.bottom - (innerHeight - safe.bottom));
    }
    if (off > 0.5) out.push({ kind: 'offscreen', a: p.name, w: Math.round(off), h: 0 });
    else if (notch > 0.5) out.push({ kind: 'notch', a: p.name, w: Math.round(notch), h: 0 });
  }
  return out;
}

Object.assign(window, { __hudAudit: audit, __hudPieces: () => pieces().map((p) => ({ ...p, rects: p.rects.map((r) => [r.left, r.top, r.width, r.height].map(Math.round)) })) });
