import { CHAT, type ChatLine } from '@dead-hours/shared';
import { h } from './dom';
import type { NetLink } from '../network/NetLink';

/** Readable name colors, picked by player id so a name keeps its color. */
const COLORS = ['#e8a35a', '#7fc4e8', '#9be07a', '#e38fd0', '#f0d264', '#8fa8f0', '#e87a6a', '#6ad8c0'];

function colorOf(pid: string): string {
  let n = 0;
  for (let i = 0; i < pid.length; i++) n = (n * 31 + pid.charCodeAt(i)) >>> 0;
  return COLORS[n % COLORS.length];
}

/** Lines stay on screen this long in play (s) unless the box is open. */
const SHOW_FOR = 10;
const MAX_LINES = 60;

/**
 * The room's text chat. In the lobby it is a panel with its own input; in play the recent lines
 * show over the game and fade, and the chat key opens the input. Every line is put on the page as
 * text (never parsed as HTML).
 */
export class ChatBox {
  readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly unsub: () => void;
  private readonly fader: ReturnType<typeof setInterval> | null = null;
  private opened = false;

  constructor(private readonly link: NetLink, private readonly mode: 'lobby' | 'game', private readonly onClose?: () => void) {
    this.log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
    this.input = h('input', {
      class: 'chat-input', type: 'text', maxlength: CHAT.maxLength, spellcheck: 'true', autocomplete: 'off',
      placeholder: mode === 'lobby' ? 'Say something…' : 'Say something… (Enter sends, Esc closes)', 'aria-label': 'Chat message',
    }) as HTMLInputElement;
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.input.value;
        if (text.trim() && this.link.chat.say(text)) this.input.value = '';
        if (this.mode === 'game') this.close();
      } else if (e.key === 'Escape' && this.mode === 'game') {
        e.preventDefault();
        this.close();
      }
      // Keys typed here are not game controls.
      e.stopPropagation();
    });
    if (mode === 'lobby') {
      const send = h('button', { class: 'btn', onclick: () => { if (this.link.chat.say(this.input.value)) this.input.value = ''; this.input.focus(); } }, 'SEND');
      this.el = h('div', { class: 'chat chat-lobby' }, this.log, h('div', { class: 'chat-row' }, this.input, send));
    } else {
      this.input.addEventListener('blur', () => this.close());
      this.el = h('div', { class: 'chat chat-game' }, this.log, this.input);
      this.fader = setInterval(() => this.fade(), 500);
    }
    for (const l of link.chat.lines.slice(-MAX_LINES)) this.log.append(this.line(l));
    this.unsub = link.chat.subscribe((l) => {
      const stick = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 8;
      this.log.append(this.line(l));
      while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild?.remove();
      if (stick || this.mode === 'game') this.log.scrollTop = this.log.scrollHeight;
    });
    this.log.scrollTop = this.log.scrollHeight;
    this.fade();
  }

  private line(l: ChatLine & { at: number }): HTMLElement {
    const row = h('div', { class: `chat-line${l.sys ? ' sys' : ''}`, 'data-at': l.at });
    if (!l.sys) {
      const name = h('b', {}, l.name);
      name.style.color = colorOf(l.pid);
      row.append(name, ': ');
    }
    row.append(document.createTextNode(l.text));
    return row;
  }

  /** In play: older lines fade unless the box is open. */
  private fade(): void {
    if (this.mode !== 'game') return;
    const now = performance.now();
    this.el.classList.toggle('open', this.opened);
    for (const el of this.log.children) {
      const at = Number((el as HTMLElement).dataset.at);
      el.classList.toggle('old', !this.opened && now - at > SHOW_FOR * 1000);
    }
  }

  /** Runs a redraw that moves the box (the lobby's), keeping typing focus, caret and scroll. */
  preserve(redraw: () => void): void {
    const focused = document.activeElement === this.input;
    const caret = this.input.selectionStart;
    const scroll = this.log.scrollTop;
    redraw();
    this.log.scrollTop = scroll;
    if (focused) {
      this.input.focus();
      if (caret !== null) this.input.setSelectionRange(caret, caret);
    }
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** In play: show the input and type. */
  open(): void {
    this.opened = true;
    this.fade();
    this.input.focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.input.blur();
    this.fade();
    this.onClose?.();
  }

  dispose(): void {
    this.unsub();
    if (this.fader) clearInterval(this.fader);
    this.el.remove();
  }
}
