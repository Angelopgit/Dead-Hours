import { h } from './dom';
import { settings, type Action } from '../core/Settings';
import type { Input } from '../core/Input';

/** Thumb travel (px) for a full push of the move stick. */
const STICK_RADIUS = 56;
/** Past this push forward the survivor sprints. */
const SPRINT_PUSH = 0.92;
/** Radians per pixel of thumb drag at sensitivity 1. */
const DRAG_TURN = 0.0058;

type Mode = 'hold' | 'latch' | 'tap';

interface ButtonDef {
  action: Action | 'swap' | 'pause';
  label: string;
  cls: string;
  mode: Mode;
}

const BUTTONS: ButtonDef[] = [
  { action: 'fire', label: 'FIRE', cls: 'fire', mode: 'hold' },
  { action: 'aim', label: 'AIM', cls: 'aim', mode: 'latch' },
  { action: 'reload', label: 'RELOAD', cls: 'reload', mode: 'tap' },
  { action: 'jump', label: 'JUMP', cls: 'jump', mode: 'tap' },
  { action: 'crouch', label: 'CROUCH', cls: 'crouch', mode: 'latch' },
  { action: 'melee', label: 'MELEE', cls: 'melee', mode: 'tap' },
  { action: 'interact', label: 'USE', cls: 'use', mode: 'hold' },
  { action: 'barricade', label: 'BOARD', cls: 'board', mode: 'hold' },
  { action: 'swap', label: 'SWAP', cls: 'swap', mode: 'tap' },
  { action: 'heal', label: 'HEAL', cls: 'heal', mode: 'tap' },
  { action: 'inventory', label: 'BAG', cls: 'bag', mode: 'hold' },
  { action: 'talk', label: 'TALK', cls: 'talk', mode: 'hold' },
  { action: 'pause', label: 'II', cls: 'pause', mode: 'tap' },
];

/**
 * On-screen thumb controls for phones and tablets: a floating move stick on the left half
 * (pushed to the edge it sprints), drag anywhere on the right half to look, and buttons on the
 * right. The fire button can be dragged to keep turning while shooting. Aim and crouch latch
 * on and off with a tap. Multi-touch throughout; each finger is tracked by its pointer id.
 */
export class TouchControls {
  readonly el: HTMLElement;
  private readonly base = h('div', { class: 'tc-stick' }, h('div', { class: 'tc-knob' }));
  private readonly knob: HTMLElement;
  private readonly buttons = new Map<string, HTMLElement>();
  private stickId = -1;
  private stickX = 0;
  private stickY = 0;
  /** Fingers turning the view: pointer id → last position. */
  private readonly lookers = new Map<number, { x: number; y: number }>();
  private readonly latched = new Set<Action>();
  private readonly abort = new AbortController();
  private shown = false;
  private readonly unsub: () => void;

  constructor(private readonly input: Input, online: boolean) {
    this.knob = this.base.firstElementChild as HTMLElement;
    const lookZone = h('div', { class: 'tc-look' });
    const moveZone = h('div', { class: 'tc-move' });
    const pad = h('div', { class: 'tc-buttons' });
    for (const def of BUTTONS) {
      if (def.action === 'talk' && !online) continue;
      const b = h('div', { class: `tc-btn ${def.cls}`, role: 'button', 'aria-label': def.label }, def.label);
      this.buttons.set(def.action, b);
      this.bindButton(b, def);
      if (def.action === 'pause') moveZone.append(b);
      else pad.append(b);
    }
    this.el = h('div', { class: 'touch-controls hidden' }, moveZone, lookZone, this.base, pad);
    const sig = { signal: this.abort.signal };
    moveZone.addEventListener('pointerdown', (e) => this.stickStart(e), sig);
    lookZone.addEventListener('pointerdown', (e) => this.lookStart(e), sig);
    window.addEventListener('pointermove', (e) => this.onMove(e), sig);
    window.addEventListener('pointerup', (e) => this.onUp(e), sig);
    window.addEventListener('pointercancel', (e) => this.onUp(e), sig);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault(), sig);
    this.applyScale();
    this.unsub = settings.subscribe(() => this.applyScale());
  }

  private applyScale(): void {
    this.el.style.setProperty('--tc-scale', String(settings.value.controls.touchScale));
  }

  private bindButton(b: HTMLElement, def: ButtonDef): void {
    const sig = { signal: this.abort.signal };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.setPointerCapture?.(e.pointerId);
      goFullscreen();
      if (def.action === 'pause') {
        this.input.requestPause();
        return;
      }
      if (def.action === 'swap') {
        this.input.swapWeapon();
        b.classList.add('on');
        setTimeout(() => b.classList.remove('on'), 120);
        return;
      }
      const action = def.action;
      // Aim follows the player's hold/toggle choice; in hold mode a tap latches it on screens.
      const latch = def.mode === 'latch' && !(action === 'aim' && settings.value.controls.aimMode === 'toggle');
      if (latch) {
        const on = !this.latched.has(action);
        if (on) this.latched.add(action);
        else this.latched.delete(action);
        this.input.virtual('Touch', action, on);
        b.classList.toggle('on', on);
        return;
      }
      this.input.virtual('Touch', action, true);
      b.classList.add('on');
      if (action === 'fire') this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const up = () => {
        this.input.virtual('Touch', action, false);
        b.classList.remove('on');
        this.lookers.delete(e.pointerId);
      };
      if (def.mode === 'tap') {
        // Held for at least one frame so the game sees the press.
        setTimeout(up, 60);
        return;
      }
      const end = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        up();
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      window.addEventListener('pointerup', end, sig);
      window.addEventListener('pointercancel', end, sig);
    }, sig);
  }

  private stickStart(e: PointerEvent): void {
    if (this.stickId !== -1) return;
    e.preventDefault();
    goFullscreen();
    this.stickId = e.pointerId;
    this.stickX = e.clientX;
    this.stickY = e.clientY;
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.classList.add('active');
    this.knob.style.transform = '';
  }

  private lookStart(e: PointerEvent): void {
    e.preventDefault();
    goFullscreen();
    this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      const r = STICK_RADIUS * settings.value.controls.touchScale;
      let dx = e.clientX - this.stickX, dy = e.clientY - this.stickY;
      const m = Math.hypot(dx, dy);
      if (m > r) {
        // The base follows a thumb that slides past the rim.
        this.stickX += dx * (1 - r / m);
        this.stickY += dy * (1 - r / m);
        this.base.style.left = `${this.stickX}px`;
        this.base.style.top = `${this.stickY}px`;
        dx *= r / m;
        dy *= r / m;
      }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const x = dx / r, y = -dy / r;
      this.input.setTouchMove(x, y);
      const sprint = y > SPRINT_PUSH * 0.85 && Math.hypot(x, y) > SPRINT_PUSH;
      this.input.virtual('Touch', 'sprint', sprint);
      this.base.classList.toggle('sprint', sprint);
      return;
    }
    const last = this.lookers.get(e.pointerId);
    if (!last) return;
    const k = DRAG_TURN * settings.value.controls.touchSensitivity;
    this.input.addTurn((e.clientX - last.x) * k, (e.clientY - last.y) * k);
    last.x = e.clientX;
    last.y = e.clientY;
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      this.stickId = -1;
      this.input.setTouchMove(0, 0);
      this.input.virtual('Touch', 'sprint', false);
      this.base.classList.remove('active', 'sprint');
    }
    this.lookers.delete(e.pointerId);
  }

  /** Shown only while playing; hiding lets go of every finger. */
  setVisible(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.el.classList.toggle('hidden', !on);
    if (!on) this.reset();
  }

  /** Lights the USE or BOARD button when there is something to do, with what it does. */
  setUse(action: Action | null, text: string): void {
    const use = this.buttons.get('interact');
    const board = this.buttons.get('barricade');
    if (use) {
      use.classList.toggle('ready', action === 'interact');
      use.textContent = action === 'interact' ? shortUse(text) : 'USE';
    }
    board?.classList.toggle('ready', action === 'barricade' || (action === 'interact' && /BOARD/.test(text)));
  }

  private reset(): void {
    this.stickId = -1;
    this.lookers.clear();
    this.latched.clear();
    this.base.classList.remove('active', 'sprint');
    for (const b of this.buttons.values()) b.classList.remove('on');
    this.input.releaseTouch();
  }

  dispose(): void {
    this.reset();
    this.unsub();
    this.abort.abort();
    this.el.remove();
  }
}

/** First words of a prompt ("OPEN DOOR", "TAKE AMMUNITION · 3 LEFT" → "TAKE AMMUNITION"). */
function shortUse(text: string): string {
  return text.split('·')[0].trim().split(' ').slice(0, 2).join(' ');
}

let askedFullscreen = false;
/** Phones play best full screen and sideways; asked once, from a touch (browsers require one). */
function goFullscreen(): void {
  if (askedFullscreen) return;
  askedFullscreen = true;
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    const p = el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.();
    void Promise.resolve(p).then(() => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      return o?.lock?.('landscape');
    }).catch(() => { /* not allowed here (iOS Safari); the rotate hint covers it */ });
  } catch {
    /* ignore */
  }
}
