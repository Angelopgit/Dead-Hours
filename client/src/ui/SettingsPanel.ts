import { h } from './dom';
import { settings, ACTION_LABELS, type Action, type SettingsData } from '../core/Settings';
import { codeLabel, type Input } from '../core/Input';
import { audio } from '../audio/AudioEngine';

type Tab = 'graphics' | 'audio' | 'controls' | 'accessibility';

function seg<T extends string | number>(options: [T, string][], get: () => T, set: (v: T) => void): HTMLElement {
  const wrap = h('div', { class: 'seg' });
  const render = () => {
    wrap.replaceChildren(
      ...options.map(([v, label]) =>
        h('button', {
          class: get() === v ? 'on' : '',
          onclick: () => { set(v); audio.ui('click'); render(); },
        }, label),
      ),
    );
  };
  render();
  return wrap;
}

function slider(min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string): HTMLElement {
  const out = h('output', {}, fmt(get()));
  const input = h('input', { type: 'range', min, max, step, value: get() }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    set(v);
  });
  return h('div', { class: 'slider' }, input, out);
}

function toggle(get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const b = h('button', { class: `toggle ${get() ? 'on' : ''}`, 'aria-pressed': String(get()) });
  b.addEventListener('click', () => {
    set(!get());
    b.classList.toggle('on', get());
    b.setAttribute('aria-pressed', String(get()));
    audio.ui('click');
  });
  return b;
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('div', { class: 'row' }, h('label', {}, label, hint ? h('span', { class: 'hint' }, hint) : null), control);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Settings screen shared by the main menu and the pause menu. Everything persists locally. */
export class SettingsPanel {
  readonly el: HTMLElement;
  private tab: Tab = 'graphics';
  private readonly body = h('div');
  private readonly tabs = h('div', { class: 'tabs' });

  constructor(private readonly input: Input, onClose: () => void) {
    this.el = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Settings' },
      h('button', { class: 'panel-close', onclick: () => { audio.ui('back'); onClose(); } }, 'CLOSE ✕'),
      h('h2', {}, 'SETTINGS'),
      this.tabs,
      this.body,
    );
    this.render();
  }

  private g = <K extends keyof SettingsData['graphics']>(k: K) => () => settings.value.graphics[k];
  private setG = <K extends keyof SettingsData['graphics']>(k: K) => (v: SettingsData['graphics'][K]) => settings.update((s) => { s.graphics[k] = v; });

  render(): void {
    const tabs: [Tab, string][] = [['graphics', 'Graphics'], ['audio', 'Audio'], ['controls', 'Controls'], ['accessibility', 'Accessibility']];
    this.tabs.replaceChildren(...tabs.map(([t, label]) =>
      h('button', { class: `tab ${this.tab === t ? 'active' : ''}`, onclick: () => { this.tab = t; audio.ui('click'); this.render(); } }, label)));
    const content: HTMLElement[] = [];
    if (this.tab === 'graphics') {
      content.push(
        row('Resolution scale', slider(0.5, 1, 0.05, this.g('resolutionScale'), this.setG('resolutionScale'), pct)),
        row('Adaptive resolution', toggle(this.g('adaptiveResolution'), this.setG('adaptiveResolution')), 'Lowers render scale when FPS drops'),
        row('Shadow quality', seg([['off', 'Off'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High']], this.g('shadows'), this.setG('shadows'))),
        row('Texture quality', seg([['low', 'Low'], ['medium', 'Med'], ['high', 'High']], this.g('textureQuality'), this.setG('textureQuality')), 'Detail resolution applies on next launch'),
        row('Anti-aliasing (MSAA)', toggle(this.g('antialias'), this.setG('antialias'))),
        row('Bloom', toggle(this.g('bloom'), this.setG('bloom'))),
        row('Film grain', toggle(this.g('filmGrain'), this.setG('filmGrain'))),
        row('Fog quality', seg([['low', 'Low'], ['medium', 'Med'], ['high', 'High']], this.g('fogQuality'), this.setG('fogQuality'))),
        row('Particle quality', seg([['low', 'Low'], ['medium', 'Med'], ['high', 'High']], this.g('particleQuality'), this.setG('particleQuality'))),
        row('Gore', seg([['off', 'Off'], ['reduced', 'Reduced'], ['full', 'Full']], this.g('gore'), this.setG('gore')), 'Blood, wounds and splatter'),
        row('Render distance', slider(80, 300, 10, this.g('renderDistance'), this.setG('renderDistance'), (v) => `${v}m`)),
        row('FPS limit', seg([[0, 'Off'], [30, '30'], [60, '60'], [120, '120'], [144, '144']], this.g('fpsLimit'), this.setG('fpsLimit')), 'Browsers always present with VSync'),
        row('Show FPS', toggle(this.g('showFps'), this.setG('showFps'))),
      );
    } else if (this.tab === 'audio') {
      const a = (k: keyof SettingsData['audio']) => slider(0, 1, 0.01, () => settings.value.audio[k], (v) => settings.update((s) => { s.audio[k] = v; }), pct);
      content.push(row('Master', a('master')), row('Music', a('music')), row('Effects', a('effects')), row('Ambient', a('ambient')));
    } else if (this.tab === 'controls') {
      const c = settings.value.controls;
      content.push(
        row('Mouse sensitivity', slider(0.2, 3, 0.05, () => c.sensitivity, (v) => settings.update((s) => { s.controls.sensitivity = v; }), (v) => v.toFixed(2))),
        row('Invert Y-axis', toggle(() => settings.value.controls.invertY, (v) => settings.update((s) => { s.controls.invertY = v; }))),
        row('Aim behavior', seg([['hold', 'Hold'], ['toggle', 'Toggle']], () => settings.value.controls.aimMode, (v) => settings.update((s) => { s.controls.aimMode = v; }))),
        row('Aim view', seg([['sights', 'Down sights'], ['shoulder', 'Shoulder']], () => settings.value.controls.aimView, (v) => settings.update((s) => { s.controls.aimView = v; })), 'Down sights switches to first person while aiming'),
        h('h3', {}, 'Key bindings'),
      );
      for (const action of Object.keys(ACTION_LABELS) as Action[]) content.push(row(ACTION_LABELS[action], this.bindingControl(action)));
      content.push(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { settings.reset('controls'); this.render(); } }, 'Reset controls')));
    } else {
      const a = settings.value.accessibility;
      content.push(
        row('Reduced camera shake', toggle(() => settings.value.accessibility.reducedShake, (v) => settings.update((s) => { s.accessibility.reducedShake = v; }))),
        row('Reduced flashing', toggle(() => settings.value.accessibility.reducedFlashing, (v) => settings.update((s) => { s.accessibility.reducedFlashing = v; })), 'Softens lightning, strobes and flicker'),
        row('UI scale', slider(0.8, 1.4, 0.05, () => a.uiScale, (v) => settings.update((s) => { s.accessibility.uiScale = v; }), pct)),
      );
    }
    this.body.replaceChildren(...content);
  }

  private bindingControl(action: Action): HTMLElement {
    const wrap = h('div', { class: 'bind' });
    const draw = () => {
      const codes = settings.value.controls.bindings[action];
      wrap.replaceChildren(...[0, 1].map((slot) => {
        const code = codes[slot];
        const b = h('button', { class: `key ${code ? '' : 'empty'}`, title: 'Click, then press a key. Backspace clears.' }, code ? codeLabel(code) : '—');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          b.classList.add('listening');
          b.textContent = 'PRESS…';
          // Defer so this click's mouseup doesn't bind Mouse0.
          setTimeout(() => {
            this.input.captureNext = (newCode) => {
              settings.update((s) => {
                const b = s.controls.bindings;
                if (newCode === 'Backspace' || newCode === 'Escape') {
                  b[action] = b[action].filter((_, i) => i !== slot);
                  return;
                }
                // A key drives one action only: remove it elsewhere first.
                for (const k of Object.keys(b) as Action[]) b[k] = b[k].filter((c) => c !== newCode);
                const list = [...b[action]];
                if (slot < list.length) list[slot] = newCode;
                else list.push(newCode);
                b[action] = list;
              });
              this.render();
            };
          }, 0);
        });
        return b;
      }));
    };
    draw();
    return wrap;
  }
}
