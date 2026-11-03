/**
 * Headless controller and touch checks: aim assist geometry against a fake world, and the
 * stick response curve. Run with `npm run check:controls`.
 *
 * Aim assist must pull onto a zombie near the crosshair only while the player moves or turns
 * (or just pressed aim), never through a wall, never onto one outside its cone, and never
 * when switched off.
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import * as THREE from 'three';
import type { Simulation } from '@dead-hours/shared';
import type { Physics } from '../src/core/Physics';
import { AimAssist } from '../src/gameplay/AimAssist';

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) console.log('  ok   ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
};

let wall: number | null = null;
const physics = { raycast: () => wall } as unknown as Physics;
const zombie = (x: number, z: number, alive = true) => ({ alive, pos: { x, y: 0, z }, scale: 1, def: { height: 1.75, radius: 0.3 } });

/** Camera at eye height looking down -Z (yaw 0). */
const origin = new THREE.Vector3(0, 1.6, 0);
const dirFor = (yaw: number, pitch: number) => new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
const chestPitch = Math.atan2(1.75 * 0.68 - 1.6, 12);

/** Runs the assist for `secs` at 60 fps, turning the view as the game does; returns the angle left (deg). */
function run(sim: Simulation, start: number, opts: { aiming: boolean; active: boolean; level?: 'off' | 'low' | 'standard'; secs?: number; snap?: boolean }): number {
  const a = new AimAssist(physics);
  if (opts.snap) a.aimPressed();
  let yaw = start, pitch = chestPitch;
  for (let i = 0; i < (opts.secs ?? 1) * 60; i++) {
    const r = a.update(1 / 60, sim, origin, dirFor(yaw, pitch), yaw, pitch, opts.aiming, opts.active, opts.level ?? 'standard');
    if (r) { yaw += r.yaw; pitch += r.pitch; }
  }
  const z = sim.zombies[0];
  const want = Math.atan2(-(z.pos.x - origin.x), -(z.pos.z - origin.z));
  return Math.abs(THREE.MathUtils.radToDeg(want - yaw));
}

const sim = { zombies: [zombie(0, -12)] } as unknown as Simulation;
const off = THREE.MathUtils.degToRad(4);

console.log('Aim assist');
check(run(sim, off, { aiming: true, active: true }) < 0.5, 'aiming and moving: pulls onto a zombie 4° off the crosshair');
check(run(sim, off, { aiming: false, active: true }) < 1, 'hip fire and moving: pulls too, more gently');
check(Math.abs(run(sim, off, { aiming: true, active: false }) - 4) < 0.01, 'standing still with the stick at rest: no pull');
check(run(sim, off, { aiming: true, active: false, snap: true, secs: 0.3 }) < 1.5, 'just pressed aim: snaps onto it even standing still');
check(Math.abs(run(sim, off, { aiming: true, active: true, level: 'off' }) - 4) < 0.01, 'switched off: no pull');
const low = run(sim, off, { aiming: true, active: true, level: 'low', secs: 0.3 });
const std = run(sim, off, { aiming: true, active: true, secs: 0.3 });
check(low < 4 && low > std, `low helps less than standard (${low.toFixed(2)}° vs ${std.toFixed(2)}° left after 0.3 s)`);
const far = THREE.MathUtils.degToRad(15);
check(Math.abs(run(sim, far, { aiming: true, active: true }) - 15) < 0.01, 'a zombie 15° away is left alone');
wall = 5;
check(Math.abs(run(sim, off, { aiming: true, active: true }) - 4) < 0.01, 'behind a wall: no pull');
wall = null;
check(Math.abs(run({ zombies: [zombie(0, -12, false)] } as unknown as Simulation, off, { aiming: true, active: true }) - 4) < 0.01, 'dead zombies are ignored');
check(Math.abs(run({ zombies: [zombie(0, -80)] } as unknown as Simulation, THREE.MathUtils.degToRad(1), { aiming: true, active: true }) - 1) < 0.01, 'out of range (80 m) is ignored');

const a = new AimAssist(physics);
const on = a.update(1 / 60, sim, origin, dirFor(0, chestPitch), 0, chestPitch, true, false, 'standard');
check(!!on && on.friction < 0.6, `on target: turning slows (friction ${on?.friction.toFixed(2)})`);
const none = a.update(1 / 60, { zombies: [] } as unknown as Simulation, origin, dirFor(0, 0), 0, 0, true, false, 'standard');
check(none === null, 'nothing near: full speed');

// Controller: D-pad up taps the flashlight and, held, switches shoulders. Input needs a page,
// so it gets just enough of one (and a fake controller) to read the pad.
{
  const noop = () => {};
  const g = globalThis as Record<string, unknown>;
  g.window = Object.assign(globalThis, { addEventListener: noop, dispatchEvent: noop });
  // Input brings in the pad menus' on-screen keyboard, and with it GSAP, which makes a scratch element as it loads,
  // and the sound engine for its clicks, which lists its recordings with Vite's import.meta.glob (node has none):
  // a silent stand-in takes the engine's place here.
  register('data:text/javascript,' + encodeURIComponent('export async function resolve(s, c, next) { return /\\/audio\\/AudioEngine(\\.ts)?$/.test(s) '
    + "? { url: 'data:text/javascript,export const audio = new Proxy({}, { get: () => () => {} });', shortCircuit: true } : next(s, c); }"));
  const element = () => ({ style: {} });
  g.document = { body: { classList: { toggle: noop, add: noop, remove: noop } }, addEventListener: noop, pointerLockElement: null, getElementById: () => null,
    createElement: element, createElementNS: element, documentElement: { style: {} } };
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const pad = { buttons, axes: [0, 0, 0, 0], connected: true, index: 0, mapping: 'standard', id: 'test pad' };
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [pad], userAgent: 'node' }, configurable: true });
  const { Input } = await import('../src/core/Input');
  const input = new Input({ requestPointerLock: noop } as unknown as HTMLElement);
  input.enabled = true;
  input.uiNav = false;
  const UP = 12;
  /** Holds D-pad up for `secs` at 60 fps, then lets go; which actions were pressed on the way. */
  const hold = (secs: number) => {
    const seen = new Set<string>();
    const frame = (down: boolean) => {
      buttons[UP].pressed = down;
      input.poll(1 / 60);
      for (const a of ['flashlight', 'shoulder'] as const) if (input.pressed(a)) seen.add(a);
      input.endFrame();
    };
    for (let t = 0; t < secs; t += 1 / 60) frame(true);
    frame(false);
    frame(false);
    return [...seen].sort().join(',');
  };
  hold(0.05);
  check(hold(0.12) === 'flashlight', 'controller: a tap of D-pad up switches the flashlight');
  check(hold(0.8) === 'shoulder', 'controller: holding D-pad up switches shoulders (and leaves the light alone)');
  check(hold(0.3) === 'flashlight', 'controller: a slow tap still switches the flashlight');
}

// Online on a phone the chat and the speaking list sit over the move stick's zone. `#ui-root > *` hands
// every overlay pointer events, so the column has to give them back, or touches on a chat line (a third
// of the zone once a few lines came in) never reach the stick. Only the open chat box takes them.
{
  const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  const prop = (sel: string, name: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
    // The last rule with exactly this selector that sets the property.
    const rules = [...css.matchAll(new RegExp(`(?:^|[\\n}])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))];
    const vals = rules.map((r) => r[1].match(new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`))?.[1].trim()).filter(Boolean);
    return vals.at(-1) ?? null;
  };
  const pointer = (sel: string) => prop(sel, 'pointer-events');
  check(pointer('#ui-root > .comms-hud') === 'none', 'touch: the in-game chat column lets touches through to the move stick');
  check(pointer('.chat-game') === 'none', 'touch: closed chat lines let touches through');
  check(pointer('.chat-game.open') === 'auto', 'the open chat box still takes clicks');
  // The opening shot skips on a tap or click on the canvas: its black bars and "TAP TO SKIP" line must
  // let it through (a tap on the line itself, or on a bar, did nothing).
  check(pointer('#ui-root > .letterbox, #ui-root > .skip') === 'none', 'touch: a tap on the intro bars or the skip line skips the opening shot');
  // In a small window (a 960x540 game frame) the centred interaction prompt ran over the chat column's lines.
  // The prompt wraps to the band the column leaves in the middle, so both read the column's width from one place.
  check(prop('.comms-hud', 'width') === 'var(--comms-w)' && /^min\(/.test(prop('#ui-root', '--comms-w') ?? '')
    && /^calc\(100vw - 2 \* \(3vw \+ var\(--comms-w\)\)/.test(prop('.prompt', 'max-width') ?? ''),
    'the interaction prompt wraps beside the chat column instead of printing over its lines');
  // A resize rewraps the chat lines (a smaller window narrows the column, a phone turns or goes fullscreen), and
  // the newest line sat cut off below the log until another came in: the log re-pins itself when it changes size.
  const chat = readFileSync(new URL('../src/ui/ChatBox.ts', import.meta.url), 'utf8');
  check(/new ResizeObserver\([^]*?scrollTop = this\.log\.scrollHeight[^]*?\.observe\(this\.log\)/.test(chat),
    'the in-game chat keeps its newest line in view when the window changes size');
  // Panels centre themselves with a CSS translate(-50%); a slide-in that leaves GSAP's transform behind can freeze
  // that as pixels, and the leaderboard (taller once its rows come in) sat 193 px low with its bottom cut off.
  const slides = ['../src/ui/MainMenu.ts', '../src/ui/PauseMenu.ts', '../src/gameplay/GameSession.ts']
    .flatMap((f) => readFileSync(new URL(f, import.meta.url), 'utf8').match(/gsap\.fromTo\([^;]*\{ opacity: 0, x: 24 \}[^;]*;/g) ?? []);
  check(slides.length === 4 && slides.every((s) => s.includes("clearProps: 'transform'")),
    `menu and table panels hand their centring back to the stylesheet after sliding in (${slides.length} slides)`);
  // The main menu hides when a panel would slice through its words, but that was decided only as the panel opened:
  // a window that shrank afterwards (leaving fullscreen, a phone turning) had the panel printed over menu words.
  const menu = readFileSync(new URL('../src/ui/MainMenu.ts', import.meta.url), 'utf8');
  check(/new ResizeObserver\(\(\) => this\.coverMenu\(\)\)/.test(menu) && /\.observe\(this\.el\)/.test(menu) && /\.observe\(el\)/.test(menu),
    'the main menu re-checks whether a panel covers it when the window or the panel changes size');
  // Boost chips stack up over the health panel, and the online chat column sat at a fixed height above it: with
  // all five running it printed its lines over the chips (54 px deep at 1280x720). The HUD hands the panel's height
  // to the stylesheet and the column lifts clear.
  const hud = readFileSync(new URL('../src/ui/HUD.ts', import.meta.url), 'utf8');
  check(/new ResizeObserver\([^]*?--vitals-h[^]*?\.observe\(vitals\)/.test(hud) && /var\(--vitals-h/.test(prop('.comms-hud', 'bottom') ?? ''),
    'the in-game chat column lifts clear of boost chips stacked over the health panel');
  // On a phone the health bar sits right over the ammo panel, and chips stacked over the name pushed it down into the
  // gun slots: there they take the column under the pause button instead.
  check(prop('body.touch-play .vitals .boosts', 'position') === 'absolute' && prop('body.touch-play .vitals .boosts', 'flex-direction') === 'column',
    'touch: boost chips stack under the pause button, clear of the health bar and the gun slots');
  // The main menu's height bands each fit the column at one window height, and windows just under it (701 px,
  // 1536x864 laptops at about 714, 861 with the name hint) had SETTINGS and CREDITS under the fold with PLAY open,
  // as did half-screen laptop windows (683 px wide), which had no band at all: the bands start at 601 px wide.
  // Each band names the height it fits (holiday logo a bit more) and the column shrinks to it, never under 3/4
  // size at the bottom of a band. `node client/dev/menu-sweep.cjs` measures it in a browser.
  const bands = [...css.matchAll(/@media \(min-width: 601px\) and \(min-height: (\d+)px\)[^{]*\{/g)].map((m) => {
    let depth = 1, i = m.index + m[0].length;
    while (depth && i < css.length) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0, i++;
    const body = css.slice(m.index + m[0].length, i - 1);
    const fit = (sel: string) => Number(body.match(new RegExp(`(?:^|[\\n}])\\s*${sel.replace(/\./g, '\\.')}\\s*\\{\\s*--menu-fit:\\s*(\\d+);`))?.[1]);
    const top = Number(m[0].match(/max-height: (\d+)px/)?.[1] ?? Infinity);
    const low = [501, 701, 861].filter((h) => h <= top).at(-1)!;
    return { low, plain: fit('.menu'), holiday: fit('.menu.holiday'), body };
  });
  const shrink = /font-size:\s*min\(1em, calc\(100vh \* 14 \/ var\(--menu-fit\) \* max\(1, var\(--ui-scale\)\)\)\)/;
  check(bands.length === 3 && shrink.test(bands[0].body) && prop('#ui-root', 'font-size') === 'calc(14px * var(--ui-scale))'
    && bands.every((b) => b.plain > 0 && b.holiday >= b.plain && b.low / b.holiday >= 0.75),
    `the main menu fits every desktop window height with PLAY open (${bands.map((b) => `${b.low}+: ${b.plain}/${b.holiday}`).join(', ')})`);
}

// On a window 860 px wide or less the creator's category strip runs sideways past the edge (at 683 px EARRINGS,
// NECK, BACK, GEAR and SMOKES are off it), and the browser scrolls such a row only for a sideways wheel or Shift:
// with a mouse those tabs were out of reach. The ordinary wheel moves the strip now.
{
  const { wheelScrollsSideways } = await import('../src/ui/dom');
  let on: ((e: WheelEvent) => void) | null = null;
  const row = { scrollWidth: 980, clientWidth: 651, scrollLeft: 0, addEventListener: (_: string, f: (e: WheelEvent) => void) => { on = f; } };
  wheelScrollsSideways(row as unknown as HTMLElement);
  const wheel = (deltaY: number, more: Partial<WheelEvent> = {}) => {
    let used = false;
    on!({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, preventDefault: () => { used = true; }, ...more } as WheelEvent);
    return used;
  };
  const first = wheel(120);
  check(first && row.scrollLeft === 120, `a wheel notch over the creator's category strip moves it sideways (${row.scrollLeft} px)`);
  for (let i = 0; i < 3; i++) wheel(120);
  check(row.scrollLeft === 329 && !wheel(120), 'the strip stops at its last tab, and the wheel goes on to the page from there');
  wheel(-1000);
  check(row.scrollLeft === 0, 'the wheel the other way brings the first tabs back');
  check(!wheel(10, { deltaX: 50 }) && !wheel(120, { ctrlKey: true }) && row.scrollLeft === 0, 'a sideways swipe and a pinch are left to the browser');
  check(wheel(3, { deltaMode: 1 }) && row.scrollLeft === 48, 'a wheel that counts in lines (Firefox) moves it too');
  row.scrollWidth = row.clientWidth;
  row.scrollLeft = 0;
  check(!wheel(120), 'a strip that fits (the wide column layout) leaves the wheel alone');
  const creator = readFileSync(new URL('../src/ui/CharacterCreator.ts', import.meta.url), 'utf8');
  check(/wheelScrollsSideways\(this\.tabsEl\)/.test(creator), 'the creator hands its category strip to the wheel');
}

// The YOU DIED screen after a long run (three lines of unlocks) is about 740 px tall at full size: on a 1366x768
// laptop (about 650 px) RETRY and MAIN MENU sat 60 px under the fold, and in a half-screen window (683 px wide,
// two stat columns) 190 px. The compact sizes reach up to 760 px tall, and three stat columns down to 601 px wide.
{
  const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  const blockWith = (rule: RegExp) => [...css.matchAll(/@media \(max-(height|width): (\d+)px\) \{/g)].map((m) => {
    let depth = 1, i = m.index + m[0].length;
    while (depth && i < css.length) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0, i++;
    return { side: m[1], px: Number(m[2]), body: css.slice(m.index + m[0].length, i - 1) };
  }).filter((b) => rule.test(b.body));
  const compact = blockWith(/\.results \.title \{ font-size: 2\.4em; \}/);
  check(compact.length === 1 && compact[0].side === 'height' && compact[0].px >= 760,
    `the results page takes its compact sizes on windows up to ${compact[0]?.px} px tall (a 1366x768 laptop's 650 px included)`);
  const two = blockWith(/\.results-stats \{ grid-template-columns: repeat\(2, 1fr\); \}/);
  check(two.length === 1 && two[0].side === 'width' && two[0].px <= 600,
    `the results stats keep three columns down to ${(two[0]?.px ?? 0) + 1} px wide (half-screen laptop windows)`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CONTROL CHECKS PASSED');
process.exit(failures ? 1 : 0);
