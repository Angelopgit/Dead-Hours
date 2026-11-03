import { PadKeyboard } from './PadKeyboard';

/** Standard layout indices used by menu navigation. */
const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, START = 9, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;

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

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) {
    // Off screen inside a scrolling panel still counts: it scrolls into view when chosen.
    if (!el.closest('.panel')) return false;
  }
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.05;
}

function key(code: string, keyName = code): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: keyName, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: keyName, bubbles: true }));
}

/**
 * Menus with a controller: the D-pad or left stick moves focus to the nearest control in that
 * direction, A presses it, B and Start go back (as Escape does), left and right change sliders,
 * and the right stick scrolls long panels. A on a text box opens the on-screen keyboard
 * (PadKeyboard), where X deletes and Y types a space.
 */
export class PadMenus {
  private heldDir: Dir | null = null;
  private heldT = 0;

  update(dt: number, now: boolean[], edge: (i: number) => boolean, lx: number, ly: number, ry: number): void {
    const dir: Dir | null = now[UP] || ly < -0.55 ? 'up' : now[DOWN] || ly > 0.55 ? 'down'
      : now[LEFT] || lx < -0.55 ? 'left' : now[RIGHT] || lx > 0.55 ? 'right' : null;
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
    if (edge(A)) this.press();
    const osk = PadKeyboard.active;
    if (osk && edge(X)) osk.backspace();
    if (osk && edge(Y)) osk.space();
    // Over a keyboard, back closes just the keyboard (an Escape would reach the menu behind it too).
    if (edge(B) || edge(START)) {
      if (osk) osk.cancel();
      else key('Escape');
    }
    if (edge(LB) || edge(RB)) this.tab(edge(RB) ? 1 : -1);
    if (ry) {
      const scroller = this.scope().querySelector('.panel') ?? (this.scope().matches('.panel') ? this.scope() : null);
      (scroller as HTMLElement | null)?.scrollBy({ top: ry * dt * 900 });
    }
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
