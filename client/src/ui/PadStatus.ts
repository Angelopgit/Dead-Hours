import gsap from 'gsap';
import { h } from './dom';
import { richText, richNodes } from './Glyphs';
import { onMenuHints } from './PadMenus';
import { onPadChange, type PadEvent } from '../core/Input';
import { onGlyphStyle, type GlyphStyle } from '../core/PadLayout';

const FAMILY: Record<GlyphStyle, string> = { xbox: 'Xbox controller', playstation: 'PlayStation controller', nintendo: 'Nintendo controller', generic: 'Controller' };

/** How a controller arriving or leaving is told. */
export function padNotice(e: PadEvent): string {
  if (e.kind === 'disconnected') return e.standard ? `${FAMILY[e.style]} disconnected` : '';
  if (!e.standard) return 'A controller is connected, but this browser can\'t read its buttons. Try a cable, or another browser.';
  return `${FAMILY[e.style]} connected`;
}

/**
 * What the controller shows on every screen: a bar of button hints along the bottom while menus are up
 * (A select, B back, LB RB tabs...), and a short note when a controller is plugged in or goes away.
 * The bar shows only while the controller is in use (body.pad-nav).
 */
export class PadStatus {
  private readonly bar = h('div', { class: 'pad-hints', 'aria-hidden': 'true' });
  private readonly toasts = h('div', { class: 'pad-toasts', role: 'status', 'aria-live': 'polite' });
  private readonly off: (() => void)[] = [];
  private hints = '';

  constructor(parent: HTMLElement) {
    parent.append(this.bar, this.toasts);
    this.off.push(onMenuHints((text) => this.setHints(text)));
    // A different family of pad plugged in: the same hints in its button names.
    this.off.push(onGlyphStyle(() => { this.bar.dataset.rich = ''; this.setHints(this.hints); }));
    this.off.push(onPadChange((e) => {
      const text = padNotice(e);
      if (text) this.toast(text);
    }));
  }

  private setHints(text: string): void {
    this.hints = text;
    this.bar.classList.toggle('show', text !== '');
    richText(this.bar, text);
  }

  toast(text: string): void {
    const t = h('div', { class: 'pad-toast' }, ...richNodes(text));
    this.toasts.append(t);
    while (this.toasts.children.length > 2) this.toasts.firstElementChild?.remove();
    gsap.fromTo(t, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3 });
    gsap.to(t, { opacity: 0, duration: 0.6, delay: 3.4, onComplete: () => t.remove() });
  }

  dispose(): void {
    for (const f of this.off) f();
    this.bar.remove();
    this.toasts.remove();
  }
}
