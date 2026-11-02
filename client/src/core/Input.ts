import { settings, type Action } from './Settings';
import { PadMenus } from '../ui/PadMenus';

/** What the survivor is played with right now (the last one touched). */
export type Device = 'mouse' | 'pad' | 'touch';

/** Standard Gamepad API layout (Xbox names; PlayStation pads report the same indices). */
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;

/** Fixed controller layout for play. Sprint is a click of the left stick (it stays on while moving). */
const PAD_ACTIONS: [Action, number][] = [
  ['fire', B.RT], ['aim', B.LT], ['jump', B.A], ['crouch', B.B], ['reload', B.X],
  ['interact', B.RB], ['heal', B.LB], ['melee', B.RS], ['barricade', B.DOWN], ['inventory', B.BACK],
  ['talk', B.LEFT], ['radio', B.RIGHT],
];

/** Button names shown in prompts while a controller is in use. */
export const PAD_LABELS: Partial<Record<Action, string>> = {
  fire: 'RT', aim: 'LT', jump: 'A', crouch: 'B', prone: 'hold B', reload: 'X', interact: 'RB', heal: 'LB', melee: 'R3',
  flashlight: '↑', shoulder: 'hold ↑', barricade: '↓', inventory: 'VIEW', talk: '←', radio: '→', sprint: 'L3', weapon1: 'Y', weapon2: 'Y', weapon3: 'Y',
};

const STICK_DEAD = 0.14;
const TRIGGER_DOWN = 0.35;
/** Full right-stick tilt turns this fast (rad/s) at sensitivity 1. */
const PAD_TURN = 3.5;
/** D-pad up held this long switches shoulders; a shorter press switches the flashlight. */
const UP_HOLD = 0.4;
/** B held this long goes prone (a tap crouches, or stands back up). */
export const PRONE_HOLD = 0.4;

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

/** Radial dead zone with the response rescaled to start at zero just past it. */
function stick(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < STICK_DEAD) return [0, 0];
  const k = Math.min(1, (m - STICK_DEAD) / (1 - STICK_DEAD)) / m;
  return [x * k, y * k];
}

/**
 * Keyboard/mouse, controller and touch input mapped to actions. Keys and mouse buttons are
 * rebindable ("Mouse<n>" for buttons); the controller and the on-screen thumb controls press
 * actions directly ("Pad:<action>", "Touch:<action>"). Look deltas accumulate between frames
 * and are consumed by the camera: mouse in pixels, sticks and thumbs in radians.
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
  private pauseWanted = false;
  private padIndex = -1;
  private padPrev: boolean[] = [];
  private padSprint = false;
  private padHold = 0;
  /** Seconds D-pad up has been held (-1: not pressed, or its hold already fired). */
  private upT = -1;
  /** Seconds B has been held (-1: not pressed, or it already went prone). */
  private proneT = -1;
  private readonly menus = new PadMenus();

  constructor(target: HTMLElement) {
    this.target = target;
    const opts = { signal: this.abort.signal };
    document.body.classList.toggle('touch-play', current === 'touch');
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') setDevice('touch');
      else if (e.pointerType === 'mouse') setDevice('mouse');
    }, { ...opts, capture: true });
    window.addEventListener('gamepadconnected', (e) => { if (this.padIndex < 0) this.padIndex = e.gamepad.index; }, opts);
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index !== this.padIndex) return;
      this.padIndex = -1;
      this.releaseSource('Pad');
      this.padMove.x = this.padMove.y = 0;
      // The controller went away mid-game: stop and show the pause menu.
      if (current === 'pad') this.pauseWanted = true;
    }, opts);
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

  /** Thumb drag (radians). */
  addTurn(x: number, y: number): void {
    this.turnX += x;
    this.turnY += y;
    this.stickLook = true;
  }

  private releaseSource(source: 'Pad' | 'Touch'): void {
    for (const code of [...this.down]) if (code.startsWith(`${source}:`)) this.virtual(source, code.slice(source.length + 1) as Action, false);
  }

  /** Lets go of everything the thumbs hold (the on-screen controls were hidden). */
  releaseTouch(): void {
    this.releaseSource('Touch');
    this.touchMove.x = this.touchMove.y = 0;
  }

  private gamepad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    if (this.padIndex >= 0 && pads[this.padIndex]?.connected) return pads[this.padIndex];
    for (const p of pads) {
      if (p?.connected && p.mapping === 'standard') {
        this.padIndex = p.index;
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
    if (pad) this.readPad(pad, dt);
    const kx = this.held('right') ? 1 : 0, kxn = this.held('left') ? 1 : 0;
    const ky = this.held('forward') ? 1 : 0, kyn = this.held('back') ? 1 : 0;
    let x = this.padMove.x + this.touchMove.x + kx - kxn;
    let y = this.padMove.y + this.touchMove.y + ky - kyn;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    this.move.x = this.enabled ? x : 0;
    this.move.y = this.enabled ? y : 0;
  }

  private readPad(pad: Gamepad, dt: number): void {
    const btn = (i: number) => {
      const b = pad.buttons[i];
      if (!b) return false;
      return i === B.LT || i === B.RT ? b.value > TRIGGER_DOWN || (b.pressed && b.value === 0) : b.pressed;
    };
    const now = pad.buttons.map((_, i) => btn(i));
    const prev = this.padPrev;
    const edge = (i: number) => now[i] && !prev[i];
    const [lx, ly] = stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const [rx, ry] = stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    if (now.some((v, i) => v && !prev[i]) || lx || ly || rx || ry) setDevice('pad');
    this.padPrev = now;
    if (current !== 'pad') return;

    if (this.captureNext || this.uiNav || !this.enabled) {
      this.releaseSource('Pad');
      this.padMove.x = this.padMove.y = 0;
      this.padSprint = false;
      this.upT = -1;
      this.proneT = -1;
      this.menus.update(dt, now, edge, lx, ly, ry);
      return;
    }

    if (edge(B.START)) this.pauseWanted = true;
    this.triggers.l = pad.buttons[B.LT]?.value ?? 0;
    this.triggers.r = pad.buttons[B.RT]?.value ?? 0;
    for (const [action, i] of PAD_ACTIONS) if (now[i] !== this.down.has(`Pad:${action}`)) this.virtual('Pad', action, now[i]);
    // Y swaps between the two weapons, as the mouse wheel does.
    if (edge(B.Y)) this.swapWeapon();
    // D-pad up: a tap switches the flashlight, a hold switches shoulders.
    if (now[B.UP]) {
      if (edge(B.UP)) this.upT = 0;
      else if (this.upT >= 0) {
        this.upT += dt;
        if (this.upT >= UP_HOLD) {
          this.upT = -1;
          this.tap('Pad', 'shoulder');
        }
      }
    } else if (this.upT >= 0) {
      this.upT = -1;
      this.tap('Pad', 'flashlight');
    }
    // B: crouch on its press (the survivor toggles it), prone once it has been held a moment.
    if (now[B.B]) {
      if (edge(B.B)) this.proneT = 0;
      else if (this.proneT >= 0) {
        this.proneT += dt;
        if (this.proneT >= PRONE_HOLD) {
          this.proneT = -1;
          this.tap('Pad', 'prone');
        }
      }
    } else this.proneT = -1;
    this.padMove.x = lx;
    this.padMove.y = -ly;
    // Sprint latches on a stick click and ends when the stick comes back.
    if (edge(B.LS)) this.padSprint = !this.padSprint;
    if (Math.hypot(lx, ly) < 0.3) this.padSprint = false;
    if (this.padSprint !== this.down.has('Pad:sprint')) this.virtual('Pad', 'sprint', this.padSprint);

    // Turning eases in (fine aim) and speeds up when held hard over (to turn around).
    const m = Math.hypot(rx, ry);
    if (m > 0) {
      this.padHold = m > 0.95 ? this.padHold + dt : 0;
      const boost = 1 + Math.min(1, Math.max(0, this.padHold - 0.25) / 0.35) * 0.6;
      const curve = Math.pow(m, 1.8) / m;
      const rate = PAD_TURN * settings.value.controls.padSensitivity * boost * dt * curve;
      this.turnX += rx * rate;
      this.turnY += ry * rate * 0.75;
      this.stickLook = true;
    } else this.padHold = 0;
  }

  /** Stick and thumb turning since the last call (radians, +x right, +y down). */
  consumeTurn(): { x: number; y: number } {
    const r = { x: this.turnX, y: this.turnY };
    this.turnX = this.turnY = 0;
    return r;
  }

  /** A short rumble on the controller, or a buzz on a phone. */
  rumble(strength: number, ms: number): void {
    if (!settings.value.controls.vibration) return;
    if (current === 'pad') {
      const pad = this.gamepad() as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null;
      void pad?.vibrationActuator?.playEffect?.('dual-rumble', {
        duration: ms, strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.7 + 0.1),
      })?.catch(() => { /* not supported */ });
    } else if (current === 'touch' && strength >= 0.3 && typeof navigator.vibrate === 'function') {
      navigator.vibrate(Math.round(ms * 0.6));
    }
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

/** What to press for an action on the device in use ('' on touch screens: the button is on screen). */
export function actionLabel(action: Action): string {
  if (current === 'pad') return PAD_LABELS[action] ?? '';
  if (current === 'touch') return '';
  const code = settings.value.controls.bindings[action][0];
  return code ? codeLabel(code) : '';
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
