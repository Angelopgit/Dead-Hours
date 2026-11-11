import { settings, type Action } from './Settings';
import { PadMenus } from '../ui/PadMenus';
import { PAD, PAD_BUTTONS, padLabel, plain, remap, setPadModel, styleOf, type GlyphStyle } from './PadLayout';
import { Rumble, type RumbleKind } from './Rumble';

/** What the survivor is played with right now (the last one touched). */
export type Device = 'mouse' | 'pad' | 'touch';

/** Buttons whose action is held while the button is (by the standard layout's button; a remap moves them). */
const PAD_HELD: [Action, number][] = [
  ['fire', PAD.RT], ['aim', PAD.LT], ['jump', PAD.A], ['crouch', PAD.B], ['reload', PAD.X],
  ['interact', PAD.RB], ['melee', PAD.RS], ['barricade', PAD.DOWN], ['inventory', PAD.BACK],
  ['talk', PAD.LEFT], ['radio', PAD.RIGHT],
];

const TRIGGER_DOWN = 0.35;
/** A stick has to lean this far to take over from the keyboard or the thumbs (drift never does). */
const STICK_CLAIM = 0.5;
/** Full right-stick tilt turns this fast (rad/s) at sensitivity 1. */
const PAD_TURN = 3.5;
/** D-pad up held this long switches shoulders; a shorter press switches the flashlight. */
const UP_HOLD = 0.4;
/** B held this long goes prone (a tap crouches, or stands back up). */
export const PRONE_HOLD = 0.4;
/** LB held this long readies a throw (a tap is a bandage). */
export const THROW_HOLD = 0.22;
/** Y held this long opens the gunsmith (a tap switches weapon). */
export const GUNSMITH_HOLD = 0.6;
/** Mouse travel (px) within a short while that counts as picking the mouse up again. */
const MOUSE_CLAIM = 40;

let current: Device = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
const deviceListeners = new Set<(d: Device) => void>();

/** The device in use now, for prompts and on-screen controls. */
export function inputDevice(): Device {
  return current;
}

export function onDeviceChange(fn: (d: Device) => void): () => void {
  deviceListeners.add(fn);
  return () => deviceListeners.delete(fn);
}

function setDevice(d: Device): void {
  if (d === current) return;
  current = d;
  document.body.classList.toggle('pad-nav', d === 'pad');
  document.body.classList.toggle('touch-play', d === 'touch');
  for (const fn of deviceListeners) fn(d);
}

/** A controller came or went (`style` is how its buttons are named; `standard` is false for a layout the browser doesn't know). */
export interface PadEvent { kind: 'connected' | 'disconnected'; id: string; style: GlyphStyle; standard: boolean }
const padListeners = new Set<(e: PadEvent) => void>();

export function onPadChange(fn: (e: PadEvent) => void): () => void {
  padListeners.add(fn);
  return () => padListeners.delete(fn);
}

/** Radial dead zone with the response rescaled to start at zero just past it. */
export function stick(x: number, y: number, dead: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < dead || m === 0) return [0, 0];
  const k = Math.min(1, (m - dead) / (1 - dead)) / m;
  return [x * k, y * k];
}

/**
 * Keyboard/mouse, controller and touch input mapped to actions. Keys and mouse buttons are
 * rebindable ("Mouse<n>" for buttons); the controller and the on-screen thumb controls press
 * actions directly ("Pad:<action>", "Touch:<action>"), the controller through its own layout
 * (PadLayout: buttons can be moved about, and the prompts name them the way the pad does). Look
 * deltas accumulate between frames and are consumed by the camera: mouse in pixels, sticks and
 * thumbs in radians.
 */
export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private wheel = 0;
  /** Mouse moves to drop right after pointer lock is taken (browsers report a jump there). */
  private settleMoves = 0;
  enabled = false;
  private readonly target: HTMLElement;
  private readonly abort = new AbortController();
  /** When set, the next key/button press is delivered here instead of to gameplay (rebinding). */
  captureNext: ((code: string) => void) | null = null;
  /** When set, the next controller button pressed is delivered here (its physical index), not to the menus (moving a button). */
  capturePad: ((button: number) => void) | null = null;
  /** Analog movement from a stick or thumb (x right, y forward, length ≤ 1); keys add to it. */
  readonly move = { x: 0, y: 0 };
  /** How far the controller's triggers are pulled, 0..1 (driving: throttle and brake). */
  readonly triggers = { l: 0, r: 0 };
  private padMove = { x: 0, y: 0 };
  private touchMove = { x: 0, y: 0 };
  /** Turning from a stick or thumb this frame (radians), which aim assist may bend. */
  private turnX = 0;
  private turnY = 0;
  /** A stick or thumb turned the view this frame. */
  stickLook = false;
  /** Menus are on screen: the controller moves focus and presses buttons instead of playing. */
  uiNav = true;
  /**
   * Which throwable a held LB readies (the game knows what is in the pockets): a grenade unless
   * there are none and a Molotov is there.
   */
  throwPick: (() => 'grenade' | 'molotov') | null = null;
  private pauseWanted = false;
  private padIndex = -1;
  /** Logical buttons down last frame (after the remap), and the physical ones. */
  private padPrev: boolean[] = [];
  private physPrev: boolean[] = [];
  private padSprint = false;
  private padHold = 0;
  /** Seconds each button with a hold has been down (-1: not pressed, or its hold already fired). */
  private readonly holds = new Map<number, number>();
  /** The throwable LB is holding ready, if it is. */
  private throwDown: 'grenade' | 'molotov' | null = null;
  /**
   * Buttons still held from a menu (B that skipped the opening shot, A that pressed RESUME): play leaves
   * them alone until they come up, or they would crouch or jump as play begins.
   */
  private padHeldOver: boolean[] = [];
  /** When the controller was last read (ms), for timing holds through slow frames. */
  private lastPoll = 0;
  private readonly menus = new PadMenus();
  private readonly rumbler = new Rumble();
  /** Recent mouse travel while something else is in use (px), and when it started. */
  private mouseTravel = 0;
  private mouseTravelAt = 0;

  constructor(target: HTMLElement) {
    this.target = target;
    const opts = { signal: this.abort.signal };
    document.body.classList.toggle('touch-play', current === 'touch');
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') setDevice('touch');
      else if (e.pointerType === 'mouse') setDevice('mouse');
    }, { ...opts, capture: true });
    // Picking the mouse up again (moving it a hand's width, not a nudge of the desk) brings its cursor and prompts back.
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || current === 'mouse') return;
      const now = performance.now();
      if (now - this.mouseTravelAt > 300) {
        this.mouseTravel = 0;
        this.mouseTravelAt = now;
      }
      this.mouseTravel += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (this.mouseTravel > MOUSE_CLAIM) setDevice('mouse');
    }, opts);
    window.addEventListener('gamepadconnected', (e) => {
      const g = e.gamepad;
      const standard = g.mapping === 'standard';
      if (this.padIndex < 0 && standard) {
        this.padIndex = g.index;
        setPadModel(g.id);
      }
      for (const fn of padListeners) fn({ kind: 'connected', id: g.id, style: styleOf(g.id), standard });
    }, opts);
    window.addEventListener('gamepaddisconnected', (e) => {
      const g = e.gamepad;
      if (g.index === this.padIndex) {
        this.padIndex = -1;
        this.releasePad();
        // The controller went away mid-game: stop and show the pause menu.
        if (current === 'pad') this.pauseWanted = true;
        // Another one plugged in takes over (its buttons named its way).
        const next = this.gamepad();
        if (next) setPadModel(next.id);
      }
      for (const fn of padListeners) fn({ kind: 'disconnected', id: g.id, style: styleOf(g.id), standard: g.mapping === 'standard' });
    }, opts);
    // Held pad buttons and sticks let go when another device takes over (a trigger held as the mouse moved kept firing).
    const offDevice = onDeviceChange((d) => {
      if (d !== 'pad') {
        this.releasePad();
        this.rumbler.stop(this.gamepad());
      }
    });
    this.abort.signal.addEventListener('abort', offDevice);
    window.addEventListener('keydown', (e) => this.onKey(e, true), opts);
    window.addEventListener('keyup', (e) => this.onKey(e, false), opts);
    window.addEventListener('mousedown', (e) => this.onButton(e, true), opts);
    window.addEventListener('mouseup', (e) => this.onButton(e, false), opts);
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      if (this.settleMoves > 0) {
        this.settleMoves--;
        return;
      }
      // A single event far beyond what a hand can do is a pointer-lock glitch, not a flick.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    }, opts);
    document.addEventListener('pointerlockchange', () => {
      this.lookX = this.lookY = 0;
      this.settleMoves = this.locked ? 2 : 0;
    }, opts);
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { ...opts, passive: true });
    window.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); }, opts);
    window.addEventListener('blur', () => this.down.clear(), opts);
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  /** Playing with the input in hand: the mouse is captured, or a controller or thumbs drive. */
  get engaged(): boolean {
    return current !== 'mouse' || this.locked;
  }

  get device(): Device {
    return current;
  }

  /** The controller's Start or the on-screen pause button was pressed (read once). */
  pausePressed(): boolean {
    const p = this.pauseWanted;
    this.pauseWanted = false;
    return p;
  }

  requestPause(): void {
    this.pauseWanted = true;
  }

  // ------------------------------------------------------------------ controller and thumbs

  /** An on-screen control or the controller pressed or let go of an action. */
  virtual(source: 'Pad' | 'Touch', action: Action, isDown: boolean): void {
    const code = `${source}:${action}`;
    if ((action === 'talk' || action === 'radio') && isDown !== this.down.has(code)) {
      window.dispatchEvent(new CustomEvent('deadhours:voice', { detail: { kind: action, down: isDown } }));
    }
    this.setState(code, isDown);
  }

  /** A press and release seen as one press this frame. */
  tap(source: 'Pad' | 'Touch', action: Action): void {
    this.virtual(source, action, true);
    this.virtual(source, action, false);
  }

  /** Switch to the other weapon (as one notch of the mouse wheel). */
  swapWeapon(): void {
    this.wheel += 1;
  }

  setTouchMove(x: number, y: number): void {
    this.touchMove.x = x;
    this.touchMove.y = y;
  }

  /** Thumb drag (radians). Up and down follow the invert setting the mouse uses. */
  addTurn(x: number, y: number): void {
    this.turnX += x;
    this.turnY += y * (settings.value.controls.invertY ? -1 : 1);
    this.stickLook = true;
  }

  private releaseSource(source: 'Pad' | 'Touch'): void {
    for (const code of [...this.down]) if (code.startsWith(`${source}:`)) this.virtual(source, code.slice(source.length + 1) as Action, false);
  }

  /** Lets go of everything the controller holds (it went away, or another device took over). */
  private releasePad(): void {
    this.releaseSource('Pad');
    this.padMove.x = this.padMove.y = 0;
    this.padSprint = false;
    this.holds.clear();
    this.throwDown = null;
  }

  /** Lets go of everything the thumbs hold (the on-screen controls were hidden). */
  releaseTouch(): void {
    this.releaseSource('Touch');
    this.touchMove.x = this.touchMove.y = 0;
  }

  /** The controller in use: the one picked, or the first one the browser lays out the standard way. */
  private gamepad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    if (this.padIndex >= 0 && pads[this.padIndex]?.connected) return pads[this.padIndex];
    for (const p of pads) {
      if (p?.connected && p.mapping === 'standard') {
        this.padIndex = p.index;
        setPadModel(p.id);
        return p;
      }
    }
    return null;
  }

  /** Call once at the start of every frame: reads the controller. */
  poll(dt: number): void {
    const pad = this.gamepad();
    this.stickLook = this.turnX !== 0 || this.turnY !== 0;
    this.triggers.l = this.triggers.r = 0;
    // Holds are timed by the clock as well as the frame (a frame step is capped, and a hitch shouldn't stretch a hold).
    const t = typeof performance !== 'undefined' ? performance.now() : 0;
    const real = this.lastPoll ? (t - this.lastPoll) / 1000 : dt;
    this.lastPoll = t;
    if (pad) this.readPad(pad, dt, Math.max(dt, Math.min(real, 0.5)));
    const kx = this.held('right') ? 1 : 0, kxn = this.held('left') ? 1 : 0;
    const ky = this.held('forward') ? 1 : 0, kyn = this.held('back') ? 1 : 0;
    let x = this.padMove.x + this.touchMove.x + kx - kxn;
    let y = this.padMove.y + this.touchMove.y + ky - kyn;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    this.move.x = this.enabled ? x : 0;
    this.move.y = this.enabled ? y : 0;
  }

  /**
   * A button with a press and a hold: `onTap` when it comes up before `limit` seconds (null: the press
   * is handled elsewhere), `onHold` once it has been down that long.
   */
  private holdButton(b: number, now: boolean[], dt: number, limit: number, onTap: (() => void) | null, onHold: () => void): void {
    const t = this.holds.get(b) ?? -1;
    if (now[b]) {
      if (!this.padPrev[b]) this.holds.set(b, 0);
      else if (t >= 0) {
        if (t + dt >= limit) {
          this.holds.set(b, -1);
          onHold();
        } else this.holds.set(b, t + dt);
      }
    } else if (this.padPrev[b]) {
      this.holds.set(b, -1);
      if (t >= 0) onTap?.();
    }
  }

  private readPad(pad: Gamepad, dt: number, holdDt: number): void {
    const c = settings.value.controls;
    const raw = (i: number) => {
      const b = pad.buttons[i];
      if (!b) return false;
      // Triggers count from a firm squeeze (some pads report a pressed trigger with no value).
      return i === PAD.LT || i === PAD.RT ? b.value > TRIGGER_DOWN || (b.pressed && b.value === 0) : b.pressed;
    };
    const phys = Array.from({ length: Math.max(PAD_BUTTONS, pad.buttons.length) }, (_, i) => raw(i));
    const physPrev = this.physPrev;
    this.physPrev = phys;
    const physEdge = (i: number) => phys[i] && !physPrev[i];
    let [lxr, lyr, rxr, ryr] = [pad.axes[0] ?? 0, pad.axes[1] ?? 0, pad.axes[2] ?? 0, pad.axes[3] ?? 0];
    // Southpaw: the right stick moves and the left one looks.
    if (c.padSwapSticks) [lxr, lyr, rxr, ryr] = [rxr, ryr, lxr, lyr];
    const [lx, ly] = stick(lxr, lyr, c.padDeadzoneMove);
    const [rx, ry] = stick(rxr, ryr, c.padDeadzoneLook);
    const lean = Math.max(Math.hypot(lxr, lyr), Math.hypot(rxr, ryr));
    if (phys.some((v, i) => v && !physPrev[i]) || lean > STICK_CLAIM) setDevice('pad');

    // The buttons as the standard layout's (a remap moves them about).
    const map = remap();
    const now: boolean[] = new Array(PAD_BUTTONS).fill(false);
    for (let i = 0; i < PAD_BUTTONS; i++) now[map[i]] = phys[i];
    const prev = this.padPrev;
    const edge = (i: number) => now[i] && !prev[i];
    if (current !== 'pad') {
      this.padPrev = now;
      return;
    }

    // Moving a button in Settings: the first one pressed is where it goes (Start leaves it where it was).
    if (this.capturePad) {
      const hit = phys.findIndex((v, i) => v && !physPrev[i]);
      if (hit >= 0) {
        const cb = this.capturePad;
        this.capturePad = null;
        cb(hit === PAD.START ? -1 : hit);
      }
      this.padPrev = now;
      return;
    }

    if (this.captureNext || this.uiNav || !this.enabled) {
      this.releasePad();
      this.padPrev = now;
      this.padHeldOver = now.slice();
      // Menus use the buttons where they are (A picks, B goes back), whatever the layout in play.
      this.menus.update(dt, phys, physEdge, lx, ly, rx, ry);
      return;
    }

    this.menus.idle();
    // Buttons held over from a menu count as up until they are let go.
    for (let i = 0; i < PAD_BUTTONS; i++) {
      if (!this.padHeldOver[i]) continue;
      if (now[i]) now[i] = false;
      else this.padHeldOver[i] = false;
    }
    if (edge(PAD.START)) this.pauseWanted = true;
    const valueAt = (logical: number) => pad.buttons[map.indexOf(logical)]?.value ?? 0;
    this.triggers.l = valueAt(PAD.LT);
    this.triggers.r = valueAt(PAD.RT);
    for (const [action, i] of PAD_HELD) if (now[i] !== this.down.has(`Pad:${action}`)) this.virtual('Pad', action, now[i]);
    // D-pad up: a tap switches the flashlight, a hold switches shoulders.
    this.holdButton(PAD.UP, now, holdDt, UP_HOLD, () => this.tap('Pad', 'flashlight'), () => this.tap('Pad', 'shoulder'));
    // B: crouch on its press (the survivor toggles it, above), prone once it has been held a moment.
    this.holdButton(PAD.B, now, holdDt, PRONE_HOLD, null, () => this.tap('Pad', 'prone'));
    // LB: a tap is a bandage; held, a grenade (or a Molotov) is readied and goes when it is let go.
    this.holdButton(PAD.LB, now, holdDt, THROW_HOLD, () => this.tap('Pad', 'heal'), () => {
      this.throwDown = this.throwPick?.() ?? 'grenade';
      this.virtual('Pad', this.throwDown, true);
    });
    if (this.throwDown && !now[PAD.LB]) {
      this.virtual('Pad', this.throwDown, false);
      this.throwDown = null;
    }
    // Y: a tap switches weapon, a hold opens the gunsmith. With a throw ready it switches grenade and Molotov.
    if (this.throwDown && edge(PAD.Y)) {
      const other = this.throwDown === 'grenade' ? 'molotov' : 'grenade';
      this.virtual('Pad', other, true);
      this.virtual('Pad', this.throwDown, false);
      this.throwDown = other;
      this.holds.set(PAD.Y, -1);
    } else this.holdButton(PAD.Y, now, holdDt, GUNSMITH_HOLD, () => this.swapWeapon(), () => this.tap('Pad', 'gunsmith'));
    this.padMove.x = lx;
    this.padMove.y = -ly;
    // Sprint latches on a stick click and ends when the stick comes back.
    if (edge(PAD.LS)) this.padSprint = !this.padSprint;
    if (Math.hypot(lx, ly) < 0.3) this.padSprint = false;
    if (this.padSprint !== this.down.has('Pad:sprint')) this.virtual('Pad', 'sprint', this.padSprint);
    this.padPrev = now;

    // Turning eases in (fine aim) and speeds up when held hard over (to turn around).
    const m = Math.hypot(rx, ry);
    if (m > 0) {
      this.padHold = m > 0.95 ? this.padHold + dt : 0;
      const boost = 1 + Math.min(1, Math.max(0, this.padHold - 0.25) / 0.35) * 0.6;
      const curve = Math.pow(m, 1.8) / m;
      const rate = PAD_TURN * c.padSensitivity * boost * dt * curve;
      this.turnX += rx * rate;
      this.turnY += ry * rate * 0.75 * (c.padInvertY ? -1 : 1);
      this.stickLook = true;
    } else this.padHold = 0;
  }

  /** Stick and thumb turning since the last call (radians, +x right, +y down). */
  consumeTurn(): { x: number; y: number } {
    const r = { x: this.turnX, y: this.turnY };
    this.turnX = this.turnY = 0;
    return r;
  }

  /**
   * A short rumble on the controller, or a buzz on a phone. `kind` 'shot' also kicks the right trigger
   * on pads with trigger motors; a weaker rumble never cuts short a stronger one still playing.
   */
  rumble(strength: number, ms: number, kind: RumbleKind = ''): void {
    const c = settings.value.controls;
    if (!c.vibration) return;
    if (current === 'pad') this.rumbler.play(this.gamepad(), strength, ms, kind);
    else if (current === 'touch' && strength * c.vibrationStrength >= 0.3 && typeof navigator.vibrate === 'function') {
      navigator.vibrate(Math.round(ms * 0.6));
    }
  }

  /** A rumble on the connected controller whatever is in use (Settings' test button). */
  testRumble(): void {
    this.rumbler.play(this.gamepad(), 0.9, 350, 'blast');
  }

  /** Stops any rumble (the game paused, the night ended). */
  stopRumble(): void {
    this.rumbler.stop(this.gamepad());
  }

  requestLock(): void {
    if (this.locked) return;
    const p = this.target.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => { /* user gesture required; the next click retries */ });
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  private onKey(e: KeyboardEvent, isDown: boolean): void {
    // Keys the controller sends to menus are synthetic; a real key means the keyboard is in use.
    if (isDown && e.isTrusted) setDevice('mouse');
    if (isDown && this.captureNext) {
      e.preventDefault();
      const cb = this.captureNext;
      this.captureNext = null;
      cb(e.code);
      return;
    }
    if (!this.enabled) return;
    // Typing in a text box (chat) is not playing.
    if (isDown && typing(e)) return;
    if (e.code === 'Tab' || e.code === 'Space' || (e.ctrlKey && e.code !== 'KeyW')) e.preventDefault();
    this.setState(e.code, isDown);
  }

  private onButton(e: MouseEvent, isDown: boolean): void {
    const code = `Mouse${e.button}`;
    if (isDown && this.captureNext) {
      const cb = this.captureNext;
      this.captureNext = null;
      cb(code);
      return;
    }
    if (!this.enabled || !this.locked) return;
    this.setState(code, isDown);
  }

  private setState(code: string, isDown: boolean): void {
    if (isDown) {
      if (!this.down.has(code)) this.pressedThisFrame.add(code);
      this.down.add(code);
    } else {
      this.down.delete(code);
    }
  }

  private codes(action: Action): string[] {
    return settings.value.controls.bindings[action] ?? [];
  }

  held(action: Action): boolean {
    if (!this.enabled) return false;
    return this.down.has(`Pad:${action}`) || this.down.has(`Touch:${action}`) || this.codes(action).some((c) => this.down.has(c));
  }

  pressed(action: Action): boolean {
    if (!this.enabled) return false;
    const p = this.pressedThisFrame;
    return p.has(`Pad:${action}`) || p.has(`Touch:${action}`) || this.codes(action).some((c) => p.has(c));
  }

  consumeLook(): { x: number; y: number } {
    const r = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return r;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  clear(): void {
    for (const code of this.down) {
      if (code.endsWith(':talk') || code.endsWith(':radio')) {
        window.dispatchEvent(new CustomEvent('deadhours:voice', { detail: { kind: code.slice(code.indexOf(':') + 1), down: false } }));
      }
    }
    this.down.clear();
    this.pressedThisFrame.clear();
    this.lookX = this.lookY = 0;
    this.turnX = this.turnY = 0;
    this.touchMove.x = this.touchMove.y = this.padMove.x = this.padMove.y = 0;
    this.move.x = this.move.y = 0;
    this.padSprint = false;
    this.holds.clear();
    this.throwDown = null;
  }

  dispose(): void {
    this.abort.abort();
  }
}

/** The key went to a text field (chat, names), not to the game. */
export function typing(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/**
 * What to press for an action on the device in use ('' on touch screens: the button is on screen). On a
 * controller it is a glyph (see PadLayout) that the HUD draws as the button itself.
 */
export function actionLabel(action: Action): string {
  if (current === 'pad') return padLabel(action);
  if (current === 'touch') return '';
  const code = settings.value.controls.bindings[action][0];
  return code ? codeLabel(code) : '';
}

/**
 * How to talk on the device in use, for the player's own line in PLAYERS. A phone has no keys and
 * no radio: it talks with the TALK button, which is only on screen during the night.
 */
export function talkHint(openMic: boolean, inNight: boolean, device: Device = current): string {
  if (device === 'touch') {
    if (openMic) return 'YOUR MIC OPENS WHEN YOU TALK';
    return inNight ? 'HOLD THE TALK BUTTON TO TALK' : 'THE TALK BUTTON SHOWS WHEN THE NIGHT STARTS';
  }
  // On a controller its D-pad (named plainly: this line is text, not drawn buttons).
  const key = (a: 'talk' | 'radio') => (device === 'pad' ? plain(padLabel(a)) : codeLabel(settings.value.controls.bindings[a][0] ?? '')) || '—';
  return openMic ? `YOUR MIC OPENS WHEN YOU TALK. ${key('radio')} FOR RADIO` : `HOLD ${key('talk')} TO TALK, ${key('radio')} FOR RADIO`;
}

export function codeLabel(code: string): string {
  if (code.startsWith('Mouse')) return ['LMB', 'MMB', 'RMB', 'M4', 'M5'][Number(code.slice(5))] ?? code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt', Space: 'Space', Tab: 'Tab', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    CapsLock: 'Caps', Backquote: '`', Enter: 'Enter',
  };
  return map[code] ?? code;
}
