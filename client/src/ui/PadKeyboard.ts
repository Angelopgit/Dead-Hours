import gsap from 'gsap';
import { h } from './dom';
import { audio } from '../audio/AudioEngine';
import { onDeviceChange } from '../core/Input';
import { PAD, glyph, menuButtons } from '../core/PadLayout';
import { richNodes } from './Glyphs';

/** Character keys, row by row (letters are typed lower case unless shifted). */
const ROWS = ['1234567890', 'qwertyuiop', "asdfghjkl'", 'zxcvbnm-._'];

const isLetter = (c: string) => c.toLowerCase() !== c.toUpperCase();

/**
 * An on-screen keyboard for typing into a text box with a controller (the survivor's name, a join code,
 * a game's name): A on a text box opens it over the bottom of the screen. The D-pad moves between keys
 * and A types; X deletes, Y types a space, B or Start closes it, and DONE closes it and sends Enter, so
 * a join code joins. What is typed goes into the box as a keyboard would put it there (its input event
 * fires). The box's text starts selected: the first key replaces it (a new
 * name, not the old one deleted letter by letter) and DONE keeps it. Letters start a word in capitals,
 * as phone keyboards do; the shift key flips that.
 */
export class PadKeyboard {
  private static current: PadKeyboard | null = null;

  /** The keyboard on screen, if one is. */
  static get active(): PadKeyboard | null {
    return PadKeyboard.current;
  }

  /** `onClose` hears whether it closed with DONE (the in-game chat closes when it is backed out of). */
  static open(input: HTMLInputElement, onClose?: (submitted: boolean) => void): void {
    PadKeyboard.current?.close(false);
    PadKeyboard.current = new PadKeyboard(input, onClose);
  }

  /** Is a keyboard on screen typing into this box? */
  static editing(input: HTMLInputElement): boolean {
    return PadKeyboard.current?.input === input;
  }

  private readonly el: HTMLElement;
  private readonly text = h('span', { class: 'osk-text' });
  private readonly letters: HTMLButtonElement[] = [];
  private readonly shiftKey: HTMLButtonElement;
  private shift = false;
  /** The box's text is still selected: the next key replaces it. */
  private selected: boolean;
  private readonly offDevice: () => void;

  private constructor(private readonly input: HTMLInputElement, private readonly onClose?: (submitted: boolean) => void) {
    this.selected = input.value !== '';
    const key = (label: string, onPress: () => void, cls = '') => h('button', {
      class: `osk-key ${cls}`, type: 'button',
      onmouseenter: () => audio.ui('hover'),
      onclick: () => { audio.ui('click'); onPress(); },
    }, label) as HTMLButtonElement;
    const rows = ROWS.map((row) => h('div', { class: 'osk-row' }, ...[...row].map((c) => {
      const b = key(c, () => this.type(this.shift && isLetter(c) ? c.toUpperCase() : c));
      if (isLetter(c)) this.letters.push(b);
      return b;
    })));
    this.shiftKey = key('⇧', () => this.setShift(!this.shift), 'wide');
    this.shiftKey.setAttribute('aria-label', 'Shift');
    const back = key('⌫', () => this.backspace(), 'wide');
    back.setAttribute('aria-label', 'Delete');
    this.el = h('div', { class: 'osk', role: 'dialog', 'aria-label': 'Keyboard' },
      h('div', { class: 'osk-field' },
        h('span', { class: 'osk-label' }, (input.getAttribute('aria-label') ?? input.placeholder ?? '').toUpperCase()),
        h('span', { class: 'osk-value' }, this.text, h('i', { class: 'osk-caret' })),
      ),
      ...rows,
      h('div', { class: 'osk-row' },
        this.shiftKey,
        key('SPACE', () => this.space(), 'space'),
        back,
        key('DONE', () => this.close(true), 'wide done'),
      ),
      h('div', { class: 'osk-help' }, ...richNodes(`${glyph(menuButtons().ok)} types, ${glyph(PAD.X)} deletes, ${glyph(PAD.Y)} adds a space, ${glyph(menuButtons().back)} closes`)),
    );
    this.shift = this.selected || this.wordStart();
    this.refresh();
    (document.getElementById('ui-root') ?? document.body).append(this.el);
    gsap.fromTo(this.el, { y: 24, opacity: 0.4 }, { y: 0, opacity: 1, duration: 0.25, ease: 'power2.out' });
    // Starts on the first letter, so a name can be typed straight away.
    this.letters[0]?.focus({ preventScroll: true });
    // A real keyboard (or a touch) took over: it types into the box itself.
    this.offDevice = onDeviceChange((d) => { if (d !== 'pad') this.close(false, true); });
  }

  /** B or Start: closes the keyboard and nothing behind it (PadMenus calls this instead of sending Escape). */
  cancel(): void {
    audio.ui('back');
    this.close(false);
  }

  private setShift(on: boolean): void {
    this.shift = on;
    this.refresh();
  }

  /** Puts text into the box as typing would (as much as fits). */
  private write(value: string): void {
    const max = this.input.maxLength > 0 ? this.input.maxLength : Infinity;
    if (value.length > max) {
      audio.ui('back');
      return;
    }
    this.input.value = value;
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    this.refresh();
  }

  /** Capitals at the start of a word. */
  private wordStart(): boolean {
    return this.input.value === '' || this.input.value.endsWith(' ');
  }

  /** What a key adds to: nothing while the text is selected. */
  private base(): string {
    const v = this.selected ? '' : this.input.value;
    this.selected = false;
    return v;
  }

  private type(c: string): void {
    this.write(this.base() + c);
    if (isLetter(c)) this.setShift(false);
  }

  space(): void {
    this.write(`${this.base()} `);
    this.setShift(this.wordStart());
  }

  backspace(): void {
    // Deleting a selection clears it.
    const all = this.selected;
    const v = this.base();
    this.write(all ? '' : v.slice(0, -1));
    this.setShift(this.wordStart());
  }

  private refresh(): void {
    this.text.textContent = this.input.value;
    this.text.classList.toggle('sel', this.selected);
    for (const b of this.letters) b.textContent = this.shift ? b.textContent!.toUpperCase() : b.textContent!.toLowerCase();
    this.shiftKey.classList.toggle('on', this.shift);
  }

  /** Closes it; `submit` also sends Enter to the box (DONE). Focus goes back to the box (where a real keyboard that took over types on). */
  close(submit: boolean, keyboardTookOver = false): void {
    if (PadKeyboard.current !== this) return;
    PadKeyboard.current = null;
    this.offDevice();
    this.el.remove();
    if (!this.input.isConnected) return;
    this.input.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit) this.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    // Back on the box, so the controller carries on from where it was (unless Enter took the box away).
    if (this.input.isConnected) this.input.focus({ preventScroll: true });
    if (!keyboardTookOver) this.onClose?.(submit);
  }
}
