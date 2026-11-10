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
  g.KeyboardEvent = class extends Event { constructor(type: string, init: EventInit) { super(type, init); } };
  // (An empty page for the pad's menus: nothing to focus.)
  g.document = { body: { classList: { toggle: noop, add: noop, remove: noop }, querySelectorAll: () => [], querySelector: () => null, matches: () => false },
    addEventListener: noop, pointerLockElement: null, getElementById: () => null, activeElement: null,
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

  // Every action can be reached on a pad: a press or a hold of some button, or a menu (chat).
  const { settings, ACTION_LABELS } = await import('../src/core/Settings');
  const L = await import('../src/core/PadLayout');
  const { PAD } = L;
  const moves = ['forward', 'back', 'left', 'right', 'chat'];
  const missing = Object.keys(ACTION_LABELS).filter((a) => !moves.includes(a) && !L.PAD_PLAY[a as keyof typeof L.PAD_PLAY]);
  check(!missing.length, missing.length ? `actions with no controller button: ${missing.join(', ')}` : 'controller: every action has a button (moving is the stick, chat is in the pause menu)');
  const taken = new Map<string, string>();
  for (const [a, at] of Object.entries(L.PAD_PLAY)) {
    // Weapon 1/2/3 all ride the one switch button, the throwables the one LB hold.
    const k = `${at!.button}${at!.hold ? 'h' : ''}`;
    const group = a.startsWith('weapon') ? 'weapon' : a === 'grenade' || a === 'molotov' ? 'throw' : a;
    if (taken.has(k) && taken.get(k) !== group) check(false, `controller: ${a} and ${taken.get(k)} share ${k}`);
    taken.set(k, group);
  }
  check(L.PAD_ROWS.every((r) => !L.FIXED_BUTTONS.includes(r.button)) && new Set(L.PAD_ROWS.map((r) => r.button)).size === L.PAD_ROWS.length,
    `controller: the layout list in Settings has each movable button once (${L.PAD_ROWS.length})`);

  // Whose button names: by vendor id first (Chrome), then by the name (Firefox, Safari).
  const ids: [string, string][] = [
    ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'xbox'], ['xinput', 'xbox'], ['045e-02ea-Microsoft X-Box One S pad', 'xbox'],
    ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'playstation'], ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', 'playstation'],
    ['054c-05c4-Wireless Controller', 'playstation'], ['Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'nintendo'],
    ['USB Gamepad (STANDARD GAMEPAD Vendor: 0079 Product: 0006)', 'generic'], ['8BitDo SN30 Pro (Vendor: 2dc8 Product: 6001)', 'generic'],
  ];
  const wrongIds = ids.filter(([id, want]) => L.styleOf(id) !== want).map(([id, want]) => `${id} read as ${L.styleOf(id)}, not ${want}`);
  check(!wrongIds.length, wrongIds.length ? wrongIds.join('; ') : `controller: Xbox, PlayStation, Nintendo and other pads are told apart (${ids.length} ids)`);
  const names = (style: 'auto' | 'xbox' | 'playstation' | 'nintendo' | 'generic') => {
    settings.update((s) => { s.controls.padGlyphs = style; });
    return [L.padLabel('jump'), L.padLabel('prone'), L.padLabel('fire'), L.padLabel('grenade')].map(L.plain).join(' ');
  };
  const want = { xbox: 'A HOLD B RT HOLD LB', playstation: '✕ HOLD ○ R2 HOLD L1', nintendo: 'B HOLD A ZR HOLD L', generic: '▼ HOLD ▶ R2 HOLD L1' } as const;
  const wrongNames = (Object.keys(want) as (keyof typeof want)[]).filter((st) => names(st) !== want[st]).map((st) => `${st}: ${names(st)}`);
  check(!wrongNames.length, wrongNames.length ? `prompt names: ${wrongNames.join('; ')}` : 'controller: prompts name buttons the Xbox, PlayStation, Nintendo or generic way');
  L.setPadModel('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)');
  const auto = names('auto');
  L.setPadModel('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)');
  const share = L.plain(L.padLabel('inventory'));
  L.setPadModel('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)');
  check(auto === want.playstation && share === 'SHARE' && names('auto') === want.xbox,
    `controller: Auto follows the pad plugged in (DualSense ${auto}, a DualShock 4's view button reads ${share})`);
  check(L.menuButtons().ok === PAD.A && (settings.update((s) => { s.controls.padGlyphs = 'nintendo'; }), L.menuButtons().ok === PAD.B),
    'controller: menus confirm with the bottom button, and with A (the right one) on a Nintendo pad');
  settings.update((s) => { s.controls.padGlyphs = 'auto'; });

  /** Runs frames with buttons held (by physical index) and sticks leaned; what was pressed and held, and the wheel. */
  const frames = (secs: number, down: number[], axes = [0, 0, 0, 0]) => {
    const pressed = new Set<string>(), held = new Set<string>();
    let wheel = 0;
    for (let t = 0; t < secs; t += 1 / 60) {
      buttons.forEach((b, i) => { b.pressed = down.includes(i); b.value = b.pressed ? 1 : 0; });
      pad.axes = axes;
      input.poll(1 / 60);
      for (const a of Object.keys(ACTION_LABELS) as (keyof typeof ACTION_LABELS)[]) {
        if (input.pressed(a)) pressed.add(a);
        if (input.held(a)) held.add(a);
      }
      wheel += input.consumeWheel();
      input.endFrame();
    }
    return { pressed, held, wheel, move: { ...input.move }, turn: input.consumeTurn() };
  };
  const rest = () => frames(0.1, []);
  rest();
  const lbTap = frames(0.1, [PAD.LB]);
  const lbTapUp = rest();
  check(!lbTap.pressed.has('heal') && lbTapUp.pressed.has('heal') && !lbTapUp.pressed.has('grenade'), 'controller: a tap of LB puts on a bandage');
  const ready = frames(0.5, [PAD.LB]);
  check(ready.held.has('grenade') && !ready.pressed.has('heal'), 'controller: holding LB readies a grenade (no bandage)');
  const switched = frames(0.15, [PAD.LB, PAD.Y]);
  const back = frames(0.1, [PAD.LB]);
  const thrown = rest();
  check(switched.held.has('molotov') && !switched.held.has('grenade') && switched.wheel === 0 && !switched.pressed.has('gunsmith') && back.wheel === 0,
    'controller: Y with a throw ready switches to the Molotov (and does not switch weapon)');
  check(!thrown.held.has('molotov') && !thrown.held.has('grenade'), 'controller: letting go of LB throws it');
  input.throwPick = () => 'molotov';
  check(frames(0.5, [PAD.LB]).held.has('molotov') && (rest(), true), 'controller: LB readies whichever the game picks (the last kind thrown)');
  input.throwPick = null;
  frames(0.1, [PAD.Y]);
  const yTap = rest();
  const yHold = frames(0.9, [PAD.Y]);
  const yHoldUp = rest();
  check(yTap.wheel === 1 && yHold.pressed.has('gunsmith') && yHold.wheel === 0 && yHoldUp.wheel === 0, 'controller: a tap of Y switches weapon, holding it opens the gunsmith');
  const bTap = frames(0.1, [PAD.B]);
  rest();
  const bHold = frames(0.6, [PAD.B]);
  rest();
  check(bTap.pressed.has('crouch') && !bTap.pressed.has('prone') && bHold.pressed.has('prone'), 'controller: B crouches, held it goes prone');
  // B that skipped the opening shot (a menu's back) is still down as play begins: it must not crouch.
  input.uiNav = true;
  frames(0.1, [PAD.B, PAD.A]);
  input.uiNav = false;
  const carried = frames(0.6, [PAD.B, PAD.A]);
  rest();
  const fresh = frames(0.1, [PAD.B]);
  rest();
  check(!carried.pressed.has('crouch') && !carried.pressed.has('prone') && !carried.pressed.has('jump') && fresh.pressed.has('crouch'),
    'controller: buttons still held from a menu do nothing in play until let go');

  // Moving buttons about: Tactical puts crouch on the right stick's click and melee on B; Start never moves.
  settings.update((s) => { s.controls.padRemap = L.presetMap('tactical'); });
  const rsTactical = frames(0.1, [PAD.RS]);
  rest();
  const bTactical = frames(0.1, [PAD.B]);
  rest();
  check(rsTactical.pressed.has('crouch') && bTactical.pressed.has('melee') && L.currentPreset() === 'tactical' && L.plain(L.padLabel('crouch')) === 'R3',
    'controller: the Tactical layout crouches on R3 and swings on B (and the prompts say so)');
  const moved = L.moveButton(L.remap(), PAD.X, PAD.A);
  settings.update((s) => { s.controls.padRemap = moved; });
  const aReload = frames(0.1, [PAD.A]);
  rest();
  const xJump = frames(0.1, [PAD.X]);
  rest();
  check(aReload.pressed.has('reload') && xJump.pressed.has('jump') && L.currentPreset() === null, 'controller: a button moved onto another swaps the two');
  check(L.moveButton(L.remap(), PAD.RT, PAD.START).every((v, i) => v === moved[i]) && L.moveButton(L.remap(), PAD.START, PAD.A).every((v, i) => v === moved[i]),
    'controller: Start stays the pause button whatever is moved');
  settings.update((s) => { s.controls.padRemap = [3, 3, 3]; });
  check(L.remap().every((v, i) => v === i), 'controller: a broken saved layout falls back to the standard one');

  // Sticks: dead zones, southpaw and invert.
  settings.update((s) => { s.controls.padRemap = []; s.controls.padDeadzoneMove = 0.14; s.controls.padDeadzoneLook = 0.14; });
  const creep = frames(0.1, [], [0, -0.1, 0, 0]);
  const walk = frames(0.1, [], [0, -0.8, 0, 0]);
  settings.update((s) => { s.controls.padDeadzoneMove = 0.3; });
  const drift = frames(0.1, [], [0, -0.25, 0, 0]);
  check(creep.move.y === 0 && walk.move.y > 0.7 && drift.move.y === 0, `controller: the move dead zone holds a resting stick still and can be raised for drift (${walk.move.y.toFixed(2)} at 0.8)`);
  settings.update((s) => { s.controls.padDeadzoneMove = 0.14; s.controls.padSwapSticks = true; });
  const south = frames(0.1, [], [0.9, 0, 0, -0.9]);
  settings.update((s) => { s.controls.padSwapSticks = false; });
  check(south.move.y > 0.7 && south.turn.x > 0 && Math.abs(south.turn.y) < 1e-9, 'controller: swapped sticks move with the right one and look with the left');
  const up = frames(0.1, [], [0, 0, 0, -0.9]).turn.y;
  settings.update((s) => { s.controls.padInvertY = true; });
  const upInv = frames(0.1, [], [0, 0, 0, -0.9]).turn.y;
  settings.update((s) => { s.controls.padInvertY = false; s.controls.invertY = true; });
  const upMouseInv = frames(0.1, [], [0, 0, 0, -0.9]).turn.y;
  settings.update((s) => { s.controls.invertY = false; });
  check(up < 0 && upInv > 0 && upMouseInv < 0, 'controller: its own invert flips the look stick (the mouse invert leaves it alone)');

  // Rumble: scaled by the strength setting, a weaker one never cuts a stronger one short, shots kick the trigger.
  const { Rumble } = await import('../src/core/Rumble');
  const played: { type: string; p: Record<string, number> }[] = [];
  const actuated = { vibrationActuator: { effects: ['dual-rumble', 'trigger-rumble'], playEffect: (type: string, p: Record<string, number>) => { played.push({ type, p }); return Promise.resolve(); } } } as unknown as Gamepad;
  const r = new Rumble();
  settings.update((s) => { s.controls.vibrationStrength = 0.5; });
  r.play(actuated, 1, 400, 'blast', 0);
  const cut = r.play(actuated, 0.3, 80, 'shot', 100);
  const after = r.play(actuated, 0.3, 80, 'shot', 500);
  settings.update((s) => { s.controls.vibration = false; });
  const off = r.play(actuated, 1, 100, '', 1000);
  settings.update((s) => { s.controls.vibration = true; s.controls.vibrationStrength = 1; });
  check(played[0]?.p.strongMagnitude === 0.5 && !cut && after && played[1]?.type === 'trigger-rumble' && played[1].p.rightTrigger > 0 && !off && played.length === 2,
    'controller: rumble follows the strength setting, keeps a blast going through gunfire, kicks the trigger on shots, and stays off when off');

  // Moving a button in Settings: the next button pressed is where it goes; Start leaves it.
  let got: number | null = null;
  input.capturePad = (b) => { got = b; };
  frames(0.1, [PAD.DOWN]);
  rest();
  const first = got;
  input.capturePad = (b) => { got = b; };
  frames(0.1, [PAD.START]);
  rest();
  check(first === PAD.DOWN && got === -1, 'controller: Settings hears the next button pressed when one is being moved (Start backs out)');
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
  // The touch hint said "Turn your phone sideways." to tablets already on their side (1024x768, 1024x600; phones on
  // their side hide the hint): that sentence shows only while the screen is upright.
  check(/h\('span', \{ class: 'upright' \}, ' Turn your phone sideways\.'\)/.test(menu) && prop('.menu-hint .upright', 'display') === 'none'
    && /@media \(orientation: portrait\) \{ \.menu-hint \.upright \{ display: inline; \} \}/.test(css),
    'touch: the menu asks to turn the screen sideways only while it is upright');
  // Settings on an upright phone (390 px): beside the 220 px controls each label got about 46 px and its hint one word
  // a line, and the fifth tab ran off the panel. The one-column rule sat above the .row rules it meant to override.
  const narrow = css.search(/@media \(max-width: 480px\) \{\s*\.row, \.row:has\(\.mic-test\), \.row:has\(\.stick-zone\) \{ grid-template-columns: 1fr;/);
  const rowRules = [...css.matchAll(/(?:^|[\n}])\s*\.row(?::has\(\.(?:mic-test|stick-zone)\))?\s*\{[^}]*grid-template-columns/g)].map((m) => m.index ?? 0);
  check(narrow > 0 && rowRules.length >= 3 && rowRules.every((i) => i < narrow)
    && /@media \(max-width: 480px\) \{[^@]*\.tabs \{ flex-wrap: wrap;/.test(css),
    `settings lay out in one column on upright phones and the tabs wrap (${rowRules.length} row rules before it)`);
  // On an upright phone the Settings panel's bottom edge ran through "Touch controls on." (390x844, 360x780, 412x915):
  // the hint and the build line hide while a panel crosses a line of them, and come back when it closes.
  check(/private coverMenu\(\)[^]*?querySelectorAll\('\.menu-hint, \.menu-footer'\)\)[^\n]*toggle\('under-panel', panelCrossesText\(this\.panel, e\)\)/.test(menu)
    && /private closePanel\(\)[^]*?classList\.remove\('under-panel'\)[^]*?gsap\.to\(p,/.test(menu)
    && prop('.menu-hint.under-panel, .menu-footer.under-panel', 'visibility') === 'hidden',
    'the menu hint and build line hide while a panel runs over them');
  // Held upright, "TURN YOUR PHONE SIDEWAYS TO PLAY" (35 px across the top) hid the creator's title and name box, DONE
  // on a tablet, and half of the armory's BACK: the bar's height is one variable and both screens start below it.
  const turn = css.match(/@media \(orientation: portrait\) and \(pointer: coarse\) \{([^@]*)\n\}/)?.[1] ?? '';
  check(/body\.touch-play \{ --turn-bar: calc\(35px \+ env\(safe-area-inset-top\)\); \}/.test(turn)
    && /body\.touch-play::after \{[^}]*box-sizing: border-box;[^}]*height: var\(--turn-bar\);/.test(turn)
    && /body\.touch-play \.creator, body\.touch-play \.armory \{ top: var\(--turn-bar\); \}/.test(turn),
    'touch: the survivor creator and the armory start below the turn-sideways bar on an upright screen');
  // On a phone the ammo panel is 0.75 of the HUD's letter size, and the item counts (BANDAGE × 2, GRENADE × 2, …)
  // and the fire mode kept the desktop's fraction inside it: 6.7 px letters, too small to read. They keep the
  // desktop's size in HUD letters.
  const em = (sel: string) => parseFloat(prop(sel, 'font-size') ?? 'NaN');
  const phonePanel = em('body.touch-play .weapon-panel');
  const small = [['.w-heal', 'body.touch-play .weapon-panel .w-heal'], ['.w-mode', 'body.touch-play .weapon-panel .w-mode']]
    .map(([desk, phone]) => [em(desk), phonePanel * em(phone)]);
  check(small.every(([desk, phone]) => phone >= desk * 0.98),
    `touch: the item counts and fire mode under the ammo are as big as on a desktop (${small.map(([d, p]) => `${p.toFixed(3)} vs ${d}`).join(', ')} em)`);
  // A boost chip is a syringe and the time left. The needle pokes 4 px out of the syringe's box and the room for it
  // was the name's margin, so on a phone (no name) it ran into the first digit, which was 7 px tall there.
  // Held on a phone, the bag's cards sat under the thumb buttons (SWAP, RELOAD, MELEE, FIRE … over the melee card
  // and the night's stats). The inventory covers them and lets touches through to them.
  check(+(prop('.inventory', 'z-index') ?? 0) > +(prop('.touch-controls', 'z-index') ?? 0)
    && prop('.inventory', 'pointer-events') === 'none !important' && prop('.inventory *', 'pointer-events') === 'none',
    'touch: the held bag covers the thumb buttons and touches still reach them');
  // On a phone the pause menu stands in the HUD's left column: PAUSED was printed over the item counts, and over the
  // ammo at 568x320 (nine crossings). The ammo or the gauges and the boost chips hide under it; health stays.
  check(prop('body.touch-play #ui-root:has(> .pause) :is(.weapon-panel, .car-panel, .vitals .boosts)', 'visibility') === 'hidden',
    'touch: the ammo panel and boost chips hide under the pause menu');
  // Tonight's goals sit at the top left, where the menu's title lands in a short window: online (five items) in a
  // 960x540 or 800x450 frame MENU was printed over the last goal. The card hides under the menu.
  check(prop('#ui-root:has(> .pause) .goals', 'visibility') === 'hidden', "tonight's goals hide under the pause menu");
  // YOU DIED on a phone held sideways: in one column the page ran 488 px on an 844x390 screen and 572 px on 568x320
  // after a long run, RETRY and MAIN MENU under the fold. On short screens the stats stand beside the rest.
  const short = css.match(/@media \(max-height: 500px\) and \(min-width: 560px\) \{([^@]*)\n\}/)?.[1] ?? '';
  check(/\.results-main:not\(\.team\) \{ display: grid; grid-template-columns: [^;]+;/.test(short)
    && /\.results-main:not\(\.team\) > \* \{ grid-column: 1; \}/.test(short)
    && /\.results-main:not\(\.team\) > \.results-stats \{ grid-column: 2; grid-row: 1 \/ span 5;/.test(short)
    && css.indexOf('@media (max-height: 500px) and (min-width: 560px)') > css.indexOf('@media (max-height: 760px)'),
    'touch: the results page keeps RETRY on a sideways phone (stats beside the rest on short screens)');
  // The co-op results row has six cells (the name, four stats and XP). The narrow layout kept five columns from before
  // XP was a cell, so under 861 px XP wrapped beneath the name and each row was 30 px taller. Every layout wide
  // enough for one line a row has a column for each cell.
  const results = readFileSync(new URL('../src/ui/ResultsScreen.ts', import.meta.url), 'utf8');
  const cells = (results.match(/h\('div', \{ class: `team-row[^]*?\n {6}\);/)?.[0].match(/\n {8}h\('div'/g) ?? []).length;
  const columns = [...css.matchAll(/\.team-row \{ (?:display: grid; )?grid-template-columns: ([\d.]+fr) repeat\((\d+), 1fr\)/g)].map((m) => 1 + +m[2]);
  check(cells === 6 && columns.length === 2 && columns.every((n) => n === cells),
    `co-op results: a column for every cell of a survivor's row (${cells} cells, columns ${columns.join(' and ')})`);
  const needle = -parseFloat(prop('.boost-chip .ico::after', 'right') ?? '0');
  const room = parseFloat(prop('.boost-chip .ico', 'margin-right') ?? '0');
  const phoneTime = em('body.touch-play .vitals') * em('body.touch-play .boost-chip') * em('body.touch-play .boost-chip .t');
  check(needle > 0 && room >= needle && phoneTime >= em('.boost-chip') * 0.98,
    `boost chips: the needle clears the time left (${room} px room for ${needle} px), as big on a phone as on a desktop (${phoneTime.toFixed(3)} em)`);
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
    while (depth && i < css.length) { depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0; i++; }
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
    while (depth && i < css.length) { depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0; i++; }
    return { side: m[1], px: Number(m[2]), body: css.slice(m.index + m[0].length, i - 1) };
  }).filter((b) => rule.test(b.body));
  const compact = blockWith(/\.results \.title \{ font-size: 2\.4em; \}/);
  check(compact.length === 1 && compact[0].side === 'height' && compact[0].px >= 760,
    `the results page takes its compact sizes on windows up to ${compact[0]?.px} px tall (a 1366x768 laptop's 650 px included)`);
  const two = blockWith(/\.results-stats \{ grid-template-columns: repeat\(2, 1fr\); \}/);
  check(two.length === 1 && two[0].side === 'width' && two[0].px <= 600,
    `the results stats keep three columns down to ${(two[0]?.px ?? 0) + 1} px wide (half-screen laptop windows)`);
}

// The survivor tab's lifetime TIME SURVIVED was a run clock in minutes: 274 hours read "16460:54". Totals past an
// hour read h:mm:ss now; a single run still reads mm:ss.
{
  const { clock, longClock } = await import('../src/ui/clock');
  const cases: [number, string][] = [[0, '00:00'], [754, '12:34'], [3599, '59:59'], [3600, '1:00:00'], [5025, '1:23:45'], [987654, '274:20:54']];
  const wrong = cases.filter(([s, want]) => longClock(s) !== want).map(([s, want]) => `${s} s read ${longClock(s)}, not ${want}`);
  const board = readFileSync(new URL('../src/ui/LeaderboardPanel.ts', import.meta.url), 'utf8');
  check(!wrong.length && clock(3599) === '59:59' && /stat\('TIME SURVIVED', longClock\(/.test(board),
    wrong.length ? wrong.join('; ') : 'lifetime time survived reads hours past the first (274:20:54, not 16460:54); runs stay mm:ss');
}

// A weapon's model is its label in the HUD strip, prompts, notices and the feed, all in capitals. The machete's
// read "Machete" beside "M4A1" and "M17" ("LEFT THE Machete BEHIND").
{
  const { WEAPONS } = await import('@dead-hours/shared');
  const mixed = Object.values(WEAPONS).filter((w) => w.model !== w.model.toUpperCase()).map((w) => `${w.id} "${w.model}"`);
  check(!mixed.length, mixed.length ? `weapon labels not in capitals: ${mixed.join(', ')}` : `all ${Object.keys(WEAPONS).length} weapon labels are in capitals, as the HUD shows them`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CONTROL CHECKS PASSED');
process.exit(failures ? 1 : 0);
