import { h } from './dom';
import { settings, ACTION_LABELS, GRAPHICS_PRESETS, type Action, type GraphicsPreset, type SettingsData } from '../core/Settings';
import { codeLabel, type Input } from '../core/Input';
import {
  PAD_PRESETS, PAD_ROWS, currentPreset, detectedStyle, glyph, moveButton, physicalOf, presetMap, remap, type GlyphStyle,
} from '../core/PadLayout';
import { richNodes } from './Glyphs';
import { audio } from '../audio/AudioEngine';
import { MicTest } from '../network/Voice';
import { comms } from '../network/Comms';

type Tab = 'graphics' | 'audio' | 'voice' | 'controls' | 'accessibility';

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

/** The current graphics settings are exactly this preset's. */
function matchesPreset(p: GraphicsPreset): boolean {
  const g = settings.value.graphics as unknown as Record<string, unknown>;
  return Object.entries(GRAPHICS_PRESETS[p]).every(([k, v]) => g[k] === v);
}

const STYLE_NAMES: Record<GlyphStyle, string> = { xbox: 'Xbox', playstation: 'PlayStation', nintendo: 'Nintendo', generic: 'Generic' };

/** A controller is plugged in (and the browser has seen a button pressed on it). */
function padConnected(): Gamepad | null {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  return [...pads].find((p) => p?.connected && p.mapping === 'standard') ?? null;
}

/**
 * How far a stick leans right now against its dead zone, live: a stick that drifts shows its lean at rest
 * (the bar past the mark means it would move the survivor or the view on its own).
 */
function stickMeter(which: 'move' | 'look'): HTMLElement {
  const fill = h('i');
  const mark = h('b');
  const out = h('output', {}, '');
  const wrap = h('div', { class: 'mic-meter-row' }, h('div', { class: 'mic-meter' }, fill, mark), out);
  const loop = () => {
    if (!wrap.isConnected) return;
    const c = settings.value.controls;
    const dead = which === 'move' ? c.padDeadzoneMove : c.padDeadzoneLook;
    mark.style.left = `${dead * 100}%`;
    const pad = padConnected();
    const left = (which === 'move') !== c.padSwapSticks;
    const lean = pad ? Math.min(1, Math.hypot(pad.axes[left ? 0 : 2] ?? 0, pad.axes[left ? 1 : 3] ?? 0)) : 0;
    fill.style.width = `${lean * 100}%`;
    fill.classList.toggle('past', lean > dead);
    out.textContent = pad ? `${Math.round(lean * 100)}%` : 'No controller';
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return wrap;
}

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
    const tabs: [Tab, string][] = [['graphics', 'Graphics'], ['audio', 'Audio'], ['voice', 'Voice'], ['controls', 'Controls'], ['accessibility', 'Accessibility']];
    this.tabs.replaceChildren(...tabs.map(([t, label]) =>
      h('button', { class: `tab ${this.tab === t ? 'active' : ''}`, onclick: () => { this.tab = t; audio.ui('click'); this.render(); } }, label)));
    const content: HTMLElement[] = [];
    if (this.tab === 'graphics') {
      const presets: [GraphicsPreset, string][] = [['phone', 'Phone'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
      content.push(
        row('Preset', h('div', { class: 'seg' }, ...presets.map(([p, label]) => h('button', {
          class: matchesPreset(p) ? 'on' : '',
          onclick: () => { settings.applyPreset(p); audio.ui('click'); this.render(); },
        }, label))), 'Phone favors a steady 30 FPS on mobile GPUs'),
        row('Resolution scale', slider(0.5, 1, 0.05, this.g('resolutionScale'), this.setG('resolutionScale'), pct)),
        row('Adaptive resolution', toggle(this.g('adaptiveResolution'), this.setG('adaptiveResolution')), 'Lowers render scale when FPS drops'),
        row('Shadow quality', seg([['off', 'Off'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High']], this.g('shadows'), this.setG('shadows'))),
        row('Texture quality', seg([['low', 'Low'], ['medium', 'Med'], ['high', 'High']], this.g('textureQuality'), this.setG('textureQuality')), 'Detail resolution applies on next launch'),
        row('Anti-aliasing (MSAA)', toggle(this.g('antialias'), this.setG('antialias'))),
        row('Bloom', toggle(this.g('bloom'), this.setG('bloom'))),
        row('Film grain', toggle(this.g('filmGrain'), this.setG('filmGrain'))),
        row('Ambient occlusion', toggle(this.g('ambientOcclusion'), this.setG('ambientOcclusion')), 'Contact shadows in corners and under bodies'),
        row('Motion blur', toggle(this.g('motionBlur'), this.setG('motionBlur')), 'Blurs fast camera turns'),
        row('Rain', toggle(this.g('rain'), this.setG('rain')), 'Rain, wet streets and puddles'),
        row('Fog quality', seg([['low', 'Low'], ['medium', 'Med'], ['high', 'High']], this.g('fogQuality'), this.setG('fogQuality')), 'Medium and High add volumetric light shafts'),
        row('Grass', seg([['off', 'Off'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High']], this.g('grass'), this.setG('grass')), 'Lawn grass that sways in the wind'),
        row('Reflections', seg([['off', 'Off'], ['low', 'Low'], ['high', 'High']], this.g('reflections'), this.setG('reflections')), 'Puddles mirror the street around them'),
        row('Particle quality', seg([['low', 'Low'], ['medium', 'Med'], ['high', 'High']], this.g('particleQuality'), this.setG('particleQuality'))),
        row('Gore', seg([['off', 'Off'], ['reduced', 'Reduced'], ['full', 'Full']], this.g('gore'), this.setG('gore')), 'Blood, wounds and splatter'),
        row('Render distance', slider(80, 300, 10, this.g('renderDistance'), this.setG('renderDistance'), (v) => `${v}m`)),
        row('FPS limit', seg([[0, 'Off'], [30, '30'], [60, '60'], [120, '120'], [144, '144']], this.g('fpsLimit'), this.setG('fpsLimit')), 'Browsers always present with VSync'),
        row('Show FPS', toggle(this.g('showFps'), this.setG('showFps'))),
      );
    } else if (this.tab === 'audio') {
      const a = (k: keyof SettingsData['audio']) => slider(0, 1, 0.01, () => settings.value.audio[k], (v) => settings.update((s) => { s.audio[k] = v; }), pct);
      content.push(row('Master', a('master')), row('Music', a('music')), row('Effects', a('effects')), row('Ambient', a('ambient')), row('Voice chat', a('voice')));
    } else if (this.tab === 'voice') {
      content.push(...this.voiceRows());
    } else if (this.tab === 'controls') {
      const c = settings.value.controls;
      const set = (fn: (s: SettingsData['controls']) => void) => settings.update((s) => fn(s.controls));
      content.push(
        row('Mouse sensitivity', slider(0.2, 3, 0.05, () => c.sensitivity, (v) => set((s) => { s.sensitivity = v; }), (v) => v.toFixed(2))),
        row('Invert Y-axis', toggle(() => settings.value.controls.invertY, (v) => set((s) => { s.invertY = v; })), 'Mouse and touch. The controller has its own below'),
        row('Aim behavior', seg([['hold', 'Hold'], ['toggle', 'Toggle']], () => settings.value.controls.aimMode, (v) => set((s) => { s.aimMode = v; }))),
        row('Aim view', seg([['sights', 'Down sights'], ['shoulder', 'Shoulder']], () => settings.value.controls.aimView, (v) => set((s) => { s.aimView = v; })), 'Down sights switches to first person while aiming'),
        row('Aim assist', seg([['off', 'Off'], ['low', 'Low'], ['standard', 'Standard']], () => settings.value.controls.aimAssist, (v) => set((s) => { s.aimAssist = v; })), 'Controller and touch only, never the mouse'),
        row('Vibration', toggle(() => settings.value.controls.vibration, (v) => set((s) => { s.vibration = v; })), 'Controller rumble, and phone buzz on hits'),
        row('Vibration strength', h('div', { class: 'mic-test' },
          slider(0.1, 1, 0.05, () => c.vibrationStrength, (v) => set((s) => { s.vibrationStrength = v; }), pct),
          h('button', { class: 'btn', onclick: () => { audio.ui('click'); this.input.testRumble(); } }, 'Test'))),
        ...this.padRows(),
        h('h3', {}, 'Touch'),
        row('Touch look speed', slider(0.3, 2.5, 0.05, () => c.touchSensitivity, (v) => set((s) => { s.touchSensitivity = v; }), (v) => v.toFixed(2))),
        row('On-screen controls', seg([['auto', 'Auto'], ['on', 'Always'], ['off', 'Off']], () => settings.value.controls.touch, (v) => set((s) => { s.touch = v; })), 'Auto shows them when you play by touch'),
        row('Button size', slider(0.75, 1.4, 0.05, () => c.touchScale, (v) => set((s) => { s.touchScale = v; }), pct)),
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
    // Redrawn in place (a preset picked, a button moved): the controller keeps its place in the list.
    const controls = () => [...this.el.querySelectorAll<HTMLElement>('button, input, select')];
    const was = controls().indexOf(document.activeElement as HTMLElement);
    this.body.replaceChildren(...content);
    if (was >= 0) controls()[was]?.focus({ preventScroll: true });
  }

  private v = <K extends keyof SettingsData['voice']>(k: K) => () => settings.value.voice[k];
  private setV = <K extends keyof SettingsData['voice']>(k: K) => (val: SettingsData['voice'][K]) => settings.update((s) => { s.voice[k] = val; });

  /** Voice chat in online games: how it sends, the microphone and its processing, the relay, blocked players. */
  private voiceRows(): HTMLElement[] {
    const blocked = comms.blockList;
    return [
      row('Voice chat', toggle(this.v('enabled'), this.setV('enabled')), 'Talk with the others in online games'),
      row('Transmit', seg([['ptt', 'Push to talk'], ['vad', 'Voice activation']], this.v('mode'), (m) => { this.setV('mode')(m); this.render(); })),
      row('Push to talk', this.bindingControl('talk'), 'Heard by survivors near you, from where you stand'),
      row('Team radio', this.bindingControl('radio'), 'Heard by the whole team, wherever they are'),
      row('Text chat', this.bindingControl('chat')),
      row('Microphone', this.deviceSelect()),
      row('Mic level', this.micMeter(), settings.value.voice.mode === 'vad' ? 'Speak: the bar turns green where voice activation opens' : 'Speak to see your level'),
      row('Activation level', slider(-70, -20, 1, this.v('threshold'), this.setV('threshold'), (x) => `${x} dB`), 'Voice activation sends above this level'),
      row('Echo cancellation', toggle(this.v('echoCancellation'), this.setV('echoCancellation')), 'Headphones still work best'),
      row('Noise suppression', toggle(this.v('noiseSuppression'), this.setV('noiseSuppression'))),
      row('Automatic gain', toggle(this.v('autoGainControl'), this.setV('autoGainControl'))),
      row('Hear team radio', toggle(this.v('radio'), this.setV('radio'))),
      row('Relay only (TURN)', toggle(this.v('relayOnly'), this.setV('relayOnly')), 'For strict networks, and hides your address from other players. Needs a game server with a TURN relay'),
      h('h3', {}, 'Blocked players'),
      blocked.length
        ? h('div', { class: 'blocked-list' }, ...blocked.map(([pid, name]) => h('div', { class: 'row' }, h('label', {}, name),
          h('button', { class: 'btn', onclick: () => { comms.setBlocked(pid, name, false); audio.ui('click'); this.render(); } }, 'UNBLOCK'))))
        : h('p', { class: 'hint' }, 'Nobody. Block a player from the lobby or the pause menu\'s Players list.'),
    ];
  }

  private deviceSelect(): HTMLElement {
    const select = h('select', { class: 'device-select', 'aria-label': 'Microphone' }) as HTMLSelectElement;
    const fill = async () => {
      const list = navigator.mediaDevices?.enumerateDevices ? await navigator.mediaDevices.enumerateDevices().catch(() => []) : [];
      const mics = list.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
      const current = settings.value.voice.device;
      select.replaceChildren(
        h('option', { value: '' }, 'System default'),
        ...mics.map((d, i) => h('option', { value: d.deviceId }, d.label || `Microphone ${i + 1} (names show after allowing the mic)`)),
      );
      select.value = mics.some((d) => d.deviceId === current) ? current : '';
    };
    select.addEventListener('change', () => this.setV('device')(select.value));
    void fill();
    navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (select.isConnected) void fill(); });
    this.refillDevices = fill;
    return select;
  }

  private refillDevices: (() => Promise<void>) | null = null;

  /** Live microphone level against the activation level (stops when the panel closes). */
  private micMeter(): HTMLElement {
    const fill = h('i');
    const mark = h('b');
    const out = h('output', {}, '');
    const bar = h('div', { class: 'mic-meter' }, fill, mark);
    const btn = h('button', { class: 'btn' }, 'TEST MIC');
    const wrap = h('div', { class: 'mic-test' }, bar, out, btn);
    const at = (db: number) => `${Math.min(100, Math.max(0, ((db + 80) / 80) * 100))}%`;
    let test: MicTest | null = null;
    const stop = () => {
      test?.stop();
      test = null;
      btn.textContent = 'TEST MIC';
      fill.style.width = '0%';
    };
    const loop = () => {
      const threshold = settings.value.voice.threshold;
      mark.style.left = at(threshold);
      if (!test) return;
      if (!wrap.isConnected) {
        stop();
        return;
      }
      if (test.state === 'on') {
        const db = test.read();
        fill.style.width = at(db);
        fill.classList.toggle('open', db > threshold);
        out.textContent = `${Math.max(-99, Math.round(db))} dB`;
      } else out.textContent = test.state === 'denied' ? 'BLOCKED' : test.state === 'unsupported' ? 'NO MIC ACCESS' : 'ASKING…';
      requestAnimationFrame(loop);
    };
    btn.addEventListener('click', () => {
      audio.ui('click');
      if (test) {
        stop();
        return;
      }
      audio.unlock();
      test = new MicTest();
      btn.textContent = 'STOP';
      void test.start().then(() => this.refillDevices?.());
      loop();
    });
    loop();
    return wrap;
  }

  /** The controller: whose button names, look speed and feel, the layout (presets, sticks, any button moved). */
  private padRows(): HTMLElement[] {
    const c = settings.value.controls;
    const set = (fn: (s: SettingsData['controls']) => void) => settings.update((s) => fn(s.controls));
    const pad = padConnected();
    const preset = currentPreset();
    const presets = Object.entries(PAD_PRESETS) as [keyof typeof PAD_PRESETS, (typeof PAD_PRESETS)[keyof typeof PAD_PRESETS]][];
    const auto = pad ? `Auto names the buttons the way your ${STYLE_NAMES[detectedStyle()]} controller does` : 'No controller connected. Press a button on one to wake it';
    const rows: HTMLElement[] = [
      h('h3', {}, 'Controller'),
      row('Button prompts', seg([['auto', 'Auto'], ['xbox', 'Xbox'], ['playstation', 'PS'], ['nintendo', 'Nintendo'], ['generic', 'Generic']],
        () => settings.value.controls.padGlyphs, (v) => { set((s) => { s.padGlyphs = v; }); this.render(); }), auto),
      row('Look speed', slider(0.3, 2.5, 0.05, () => c.padSensitivity, (v) => set((s) => { s.padSensitivity = v; }), (v) => v.toFixed(2))),
      row('Invert look', toggle(() => settings.value.controls.padInvertY, (v) => set((s) => { s.padInvertY = v; })), 'Push the look stick up to look down'),
      row('Move stick dead zone', h('div', { class: 'stick-zone' },
        slider(0.03, 0.35, 0.01, () => c.padDeadzoneMove, (v) => set((s) => { s.padDeadzoneMove = v; }), pct), stickMeter('move')),
      'Raise it if the survivor creeps with the stick let go'),
      row('Look stick dead zone', h('div', { class: 'stick-zone' },
        slider(0.03, 0.35, 0.01, () => c.padDeadzoneLook, (v) => set((s) => { s.padDeadzoneLook = v; }), pct), stickMeter('look')),
      'Raise it if the view drifts with the stick let go'),
      row('Layout', h('div', { class: 'seg' }, ...presets.map(([name, p]) => h('button', {
        class: preset === name ? 'on' : '',
        onclick: () => { audio.ui('click'); set((s) => { s.padRemap = presetMap(name); s.padSwapSticks = p.sticks; }); this.render(); },
      }, p.label))), preset ? 'Tactical crouches on the right stick and swings on B. Southpaw moves with the right stick' : 'Custom: buttons moved below'),
      row('Swap sticks', toggle(() => settings.value.controls.padSwapSticks, (v) => { set((s) => { s.padSwapSticks = v; }); this.render(); }), 'Move with the right stick, look with the left'),
      h('p', { class: 'hint pad-move-hint' }, 'Pick a button, then press the one it should be. The two swap. Start always pauses.'),
    ];
    for (const r of PAD_ROWS) rows.push(row(r.hold ? `${r.press}. Hold: ${r.hold.charAt(0).toLowerCase()}${r.hold.slice(1)}` : r.press, this.padButton(r.button)));
    rows.push(h('div', { class: 'actions' }, h('button', {
      class: 'btn',
      onclick: () => { audio.ui('click'); set((s) => { s.padRemap = []; s.padSwapSticks = false; }); this.render(); },
    }, 'Standard layout')));
    return rows;
  }

  /** One of the controller's buttons in the layout list: pick it, then press where it should go. */
  private padButton(logical: number): HTMLElement {
    const b = h('button', { class: 'key pad-key', title: 'Pick, then press a controller button' }, ...richNodes(glyph(physicalOf(logical))));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.ui('click');
      b.classList.add('listening');
      b.replaceChildren('PRESS A BUTTON…');
      const done = () => {
        clearTimeout(giveUp);
        if (this.input.capturePad === take) this.input.capturePad = null;
        this.render();
      };
      const take = (button: number) => {
        if (button >= 0) settings.update((s) => { s.controls.padRemap = moveButton(remap(), logical, button); });
        done();
      };
      const giveUp = setTimeout(done, 6000);
      this.input.capturePad = take;
    });
    return b;
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
