import { h } from './dom';
import { settings } from '../core/Settings';

/** Longest name the name boxes take (the server keeps up to 20). */
export const NAME_MAX = 16;
/** What a survivor who never picked a name is called. */
export const DEFAULT_NAME = 'Survivor';

/**
 * A name as typed, as it is saved: printable, single-spaced, trimmed, at most NAME_MAX characters, and the
 * default name when nothing is left. The server cleans it the same way (server/src/net/clean.ts cleanName).
 */
export function profileName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return name || DEFAULT_NAME;
}

/** Whether the survivor still has the name every new player starts with. */
export const unnamed = (): boolean => settings.value.profile.name === DEFAULT_NAME;

/** What a box shows for a name: the default one only as its faint placeholder, so typing doesn't go after it. */
const shown = (name: string): string => (name === DEFAULT_NAME ? '' : name);

export interface NameField {
  readonly el: HTMLInputElement;
  dispose(): void;
}

/**
 * A text box for the survivor's name, saved to the profile as it is typed (the account sends it on to the
 * server). Every box shows the saved name, so the main menu's and the creator's always agree; a box keeps
 * what is being typed into it (a trailing space, an emptied box) until the name it stands for changes,
 * and shows the name as saved once it is left. A survivor still called "Survivor" gets an empty box with
 * that as its placeholder, ready to type a name into. Enter and Escape leave it.
 */
export function nameField(cls: string, onChange?: () => void): NameField {
  const el = h('input', {
    class: cls, type: 'text', maxlength: NAME_MAX, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'words',
    enterkeyhint: 'done', placeholder: DEFAULT_NAME, 'aria-label': 'Survivor name',
    value: shown(settings.value.profile.name),
  }) as HTMLInputElement;
  el.addEventListener('input', () => {
    const name = profileName(el.value);
    if (name !== settings.value.profile.name) settings.update((s) => { s.profile.name = name; });
  });
  const tidy = () => {
    const want = shown(settings.value.profile.name);
    if (el.value !== want) el.value = want;
  };
  el.addEventListener('change', tidy);
  el.addEventListener('blur', tidy);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      // Escape only leaves the box: the panel or creator behind it stays open.
      e.stopPropagation();
      el.blur();
    }
  });
  let last = settings.value.profile.name;
  const off = settings.subscribe((s) => {
    const name = s.profile.name;
    if (name === last) return;
    last = name;
    if (profileName(el.value) !== name) el.value = shown(name);
    onChange?.();
  });
  return { el, dispose: off };
}
