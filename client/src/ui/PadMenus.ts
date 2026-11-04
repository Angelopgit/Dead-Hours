import { PadKeyboard } from './PadKeyboard';
import { PAD, glyph, menuButtons } from '../core/PadLayout';

type Dir = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
/** Layers that cover the screen; when one is open only its controls can be reached. */
const LAYERS = '[role="dialog"], .panel, .pause, .results, .creator, .lobby';

/** Boxes typed into: A opens the on-screen keyboard for them. */
const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
const typable = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && TEXT_TYPES.has(el.type);

/** Initial delay and repeat rate when a direction is held. */
const REPEAT_DELAY = 0.38;
const REPEAT_EVERY = 0.11;

/**
 * Cut off by a box around it that doesn't scroll (a collapsed sub-menu: its items are laid out, at full
 * size, under the items after it). Off the edge of a list that scrolls still counts: it scrolls into view.
 */
function clipped(el: Element, r: DOMRect): boolean {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
    const b = p.getBoundingClientRect();
    if (r.bottom > b.top + 1 && r.top < b.bottom - 1 && r.right > b.left + 1 && r.left < b.right - 1) continue;
    const scrolls = /auto|scroll/.test(`${s.overflowX} ${s.overflowY}`) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1);
    if (!scrolls) return true;
  }
  return false;
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) {
    // Off screen inside a scrolling panel still counts: it scrolls into view when chosen.
    if (!el.closest('.panel')) return false;
  }
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none' || s.pointerEvents === 'none' || Number(s.opacity) <= 0.05) return false;
  return !clipped(el, r);
}

function key(code: string, keyName = code): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: keyName, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: keyName, bubbles: true }));
}

/**
 * Something on screen the right stick turns while it is up (the survivor in the creator, a gun on the
 * bench): `turn` gets the stick's lean scaled by time, and says whether it used the up-and-down too
 * (otherwise that scrolls the panel).
 */
export interface PadTurner { el: () => Element | null; turn: (dx: number, dy: number) => boolean }
const turners = new Set<PadTurner>();

export function padTurner(t: PadTurner): () => void {
  turners.add(t);
  return () => turners.delete(t);
}

const shown = (t: PadTurner) => {
  const el = t.el();
  return !!el && el.isConnected && visible(el);
};

/** The button hints for the screen in front of the player (glyphs and words), told when they change. */
let hintText = '';
const hintListeners = new Set<(text: string) => void>();

export function onMenuHints(fn: (text: string) => void): () => void {
  hintListeners.add(fn);
  fn(hintText);
  return () => hintListeners.delete(fn);
}

function setHints(text: string): void {
  if (text === hintText) return;
  hintText = text;
  for (const fn of hintListeners) fn(text);
}

/**
 * Menus with a controller: the D-pad or left stick moves focus to the nearest control in that
 * direction, A presses it, B and Start go back (as Escape does), left and right change sliders,
 * the right stick turns a 3D preview (or scrolls long panels), and LB and RB step through tabs. A
 * on a text box opens the on-screen keyboard (PadKeyboard), where X deletes and Y types a space. A
 * Nintendo pad confirms with its right button and goes back with the bottom one, as its own menus do.
 */
export class PadMenus {
  private heldDir: Dir | null = null;
  private heldT = 0;
  /** Seconds until the hints are looked at again (they need every control measured, so not every frame). */
  private hintsIn = 0;

  update(dt: number, now: boolean[], edge: (i: number) => boolean, lx: number, ly: number, rx: number, ry: number): void {
    const { ok, back } = menuButtons();
    const dir: Dir | null = now[PAD.UP] || ly < -0.55 ? 'up' : now[PAD.DOWN] || ly > 0.55 ? 'down'
      : now[PAD.LEFT] || lx < -0.55 ? 'left' : now[PAD.RIGHT] || lx > 0.55 ? 'right' : null;
    if (dir !== this.heldDir) {
      this.heldDir = dir;
      this.heldT = 0;
      if (dir) this.step(dir);
    } else if (dir) {
      this.heldT += dt;
      if (this.heldT > REPEAT_DELAY) {
        this.heldT -= REPEAT_EVERY;
        this.step(dir);
      }
    }
    if (edge(ok)) this.press();
    if (dir || now.some((v, i) => v && edge(i))) this.hintsIn = 0.05;
    const osk = PadKeyboard.active;
    if (osk && edge(PAD.X)) osk.backspace();
    if (osk && edge(PAD.Y)) osk.space();
    // Over a keyboard, back closes just the keyboard (an Escape would reach the menu behind it too).
    if (edge(back) || edge(PAD.START)) {
      if (osk) osk.cancel();
      else key('Escape');
    }
    if (edge(PAD.LB) || edge(PAD.RB)) this.tab(edge(PAD.RB) ? 1 : -1);
    const turner = [...turners].reverse().find(shown);
    let usedY = false;
    if ((rx || ry) && turner) usedY = turner.turn(rx * dt, ry * dt);
    if (ry && !usedY) {
      const scroller = this.scope().querySelector('.panel') ?? (this.scope().matches('.panel') ? this.scope() : null);
      (scroller as HTMLElement | null)?.scrollBy({ top: ry * dt * 900 });
    }
    this.hintsIn -= dt;
    if (this.hintsIn <= 0) {
      this.hintsIn = 0.3;
      this.hints(!!turner);
    }
  }

  /** The bar of button hints: what A, B, the shoulders and the right stick do here. */
  private hints(turner: boolean): void {
    const { ok, back } = menuButtons();
    const osk = PadKeyboard.active;
    const parts: string[] = [];
    // The on-screen keyboard has its own line of hints.
    if (!osk) {
      const scope = this.scope();
      const cur = this.focused();
      if (cur && (cur instanceof HTMLSelectElement || (cur instanceof HTMLInputElement && cur.type === 'range'))) parts.push(`${glyph(PAD.LEFT)}${glyph(PAD.RIGHT)} Change`);
      if (this.candidates().length) parts.push(`${glyph(ok)} ${cur && typable(cur) ? 'Type' : 'Select'}`);
      if (scope.matches(LAYERS)) parts.push(`${glyph(back)} Back`);
      if (scope.querySelector('.tabs .tab')) parts.push(`${glyph(PAD.LB)}${glyph(PAD.RB)} Tabs`);
      if (turner) parts.push(`${glyph(PAD.RS)} Turn`);
    }
    setHints(parts.join('   '));
  }

  /** Out of the menus (playing): no hints. */
  idle(): void {
    this.hintsIn = 0;
    setHints('');
  }

  /** The topmost open layer, or the whole interface. */
  private scope(): Element {
    const root = document.getElementById('ui-root') ?? document.body;
    const layers = [...root.querySelectorAll(LAYERS)].filter(visible);
    return layers.at(-1) ?? root;
  }

  private candidates(): HTMLElement[] {
    return [...this.scope().querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  }

  private focused(): HTMLElement | null {
    const a = document.activeElement as HTMLElement | null;
    return a && a !== document.body && this.scope().contains(a) && visible(a) ? a : null;
  }

  private focus(el: HTMLElement): void {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    el.dispatchEvent(new MouseEvent('mouseenter'));
  }

  /** Where focus starts: the first control, past text boxes (A on PLAY shouldn't open a keyboard). */
  private first(): HTMLElement | undefined {
    const all = this.candidates();
    return all.find((el) => !typable(el)) ?? all[0];
  }

  private step(dir: Dir): void {
    const cur = this.focused();
    if (!cur) {
      const first = this.first();
      if (first) this.focus(first);
      return;
    }
    // Sliders and selects take left and right.
    if ((dir === 'left' || dir === 'right') && this.adjust(cur, dir === 'right' ? 1 : -1)) return;
    const from = cur.getBoundingClientRect();
    const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of this.candidates()) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const dx = x - cx, dy = y - cy;
      const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (along <= 4) continue;
      const score = along + across * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) this.focus(best);
  }

  private adjust(el: HTMLElement, sign: number): boolean {
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const step = Number(el.step) || 1;
      const v = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) + step * sign));
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el instanceof HTMLSelectElement) {
      el.selectedIndex = Math.min(el.options.length - 1, Math.max(0, el.selectedIndex + sign));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  private press(): void {
    const cur = this.focused();
    if (cur) {
      if (typable(cur)) PadKeyboard.open(cur);
      else cur.click();
      return;
    }
    const first = this.first();
    if (first) this.focus(first);
    // Nothing to press (the opening shot): any key skips it.
    else key('Enter');
  }

  /** Shoulder buttons step through a row of tabs. */
  private tab(sign: number): void {
    const tabs = [...this.scope().querySelectorAll<HTMLElement>('.tabs .tab')].filter(visible);
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.classList.contains('active'));
    const next = tabs[(i + sign + tabs.length) % tabs.length];
    next.click();
    // The panel re-renders its tabs: focus the new active one.
    requestAnimationFrame(() => {
      const active = this.scope().querySelector<HTMLElement>('.tabs .tab.active');
      if (active) this.focus(active);
    });
  }
}
