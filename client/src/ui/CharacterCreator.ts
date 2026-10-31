import gsap from 'gsap';
import {
  APPEARANCE_ITEMS, DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, PALETTES, PALETTE_LABELS, appearanceItem, randomAppearance, sanitizeAppearance,
  type Appearance, type AppearanceItem, type AppearanceSlot, type BodyType, type PaletteName,
} from '@dead-hours/shared';
import { h } from './dom';
import { settings } from '../core/Settings';
import { audio } from '../audio/AudioEngine';
import { CharacterPreview, type PreviewFocus } from '../characters/CharacterPreview';

type ColorKey = { [K in keyof Appearance]: Appearance[K] extends number ? K : never }[keyof Appearance];

type Section =
  | { kind: 'items'; title: string; slot: AppearanceSlot; groups?: boolean }
  | { kind: 'colors'; title: string; key: ColorKey; palette: PaletteName; when?: (a: Appearance) => string | false };

interface Tab {
  id: string;
  label: string;
  focus: PreviewFocus;
  sections: Section[];
}

/** The color each slot's tint is stored in. */
const SLOT_COLOR: Partial<Record<AppearanceSlot, ColorKey>> = {
  headwear: 'headwearColor', top: 'topColor', pants: 'pantsColor', shoes: 'shoesColor', gloves: 'glovesColor',
  face: 'faceColor', neck: 'neckColor', back: 'backColor', gear: 'gearColor', makeup: 'makeupColor',
};

/** Each body type's starting look (reset), and the hair a switch to it falls back on. */
const BODY_DEFAULTS: Record<BodyType, Appearance> = { male: DEFAULT_APPEARANCE, female: DEFAULT_FEMALE_APPEARANCE };

/** Bottoms that go under a dress; anything else switches to a plain skirt (bare legs) when one is put on. */
const UNDER_DRESS = new Set(['skirt', 'plaidskirt', 'shorts', 'denimshorts', 'leggings']);

/** A slot's color row is shown while the chosen item takes a color, named by what it colors. */
const tinted = (slot: AppearanceSlot, title = 'Color') => (a: Appearance): string | false => {
  const it = appearanceItem(slot, a[slot] as string);
  return it?.tint ? title : false;
};

const TABS: Tab[] = [
  { id: 'body', label: 'Body', focus: 'body', sections: [
    { kind: 'items', title: 'Body type', slot: 'body' },
    { kind: 'colors', title: 'Skin tone', key: 'skin', palette: 'skin' },
    { kind: 'items', title: 'Build', slot: 'build' },
  ] },
  { id: 'face', label: 'Face', focus: 'head', sections: [
    { kind: 'items', title: 'Eye shape', slot: 'eyes' },
    { kind: 'colors', title: 'Eye color', key: 'eyeColor', palette: 'eye' },
    { kind: 'items', title: 'Makeup', slot: 'makeup' },
    { kind: 'colors', title: 'Makeup color', key: 'makeupColor', palette: 'makeup', when: tinted('makeup') },
    { kind: 'items', title: 'Facial hair', slot: 'facialHair' },
  ] },
  { id: 'hair', label: 'Hair', focus: 'head', sections: [
    { kind: 'items', title: 'Style', slot: 'hair' },
    { kind: 'colors', title: 'Hair color', key: 'hairColor', palette: 'hair' },
  ] },
  { id: 'headwear', label: 'Headwear', focus: 'hat', sections: [
    { kind: 'items', title: 'Headwear', slot: 'headwear', groups: true },
    { kind: 'colors', title: 'Color', key: 'headwearColor', palette: 'cloth', when: tinted('headwear') },
  ] },
  { id: 'top', label: 'Tops', focus: 'torso', sections: [
    { kind: 'items', title: 'Shirts & jackets', slot: 'top' },
    { kind: 'colors', title: 'Color', key: 'topColor', palette: 'cloth' },
    { kind: 'colors', title: 'Accent', key: 'topAccent', palette: 'cloth', when: (a) => appearanceItem('top', a.top)?.accent ?? false },
  ] },
  { id: 'pants', label: 'Bottoms', focus: 'legs', sections: [
    { kind: 'items', title: 'Pants', slot: 'pants' },
    { kind: 'colors', title: 'Color', key: 'pantsColor', palette: 'cloth' },
  ] },
  { id: 'shoes', label: 'Shoes', focus: 'feet', sections: [
    { kind: 'items', title: 'Footwear', slot: 'shoes' },
    { kind: 'colors', title: 'Color', key: 'shoesColor', palette: 'cloth' },
  ] },
  { id: 'gloves', label: 'Gloves', focus: 'hands', sections: [
    { kind: 'items', title: 'Gloves', slot: 'gloves' },
    { kind: 'colors', title: 'Color', key: 'glovesColor', palette: 'cloth', when: tinted('gloves') },
  ] },
  { id: 'eyewear', label: 'Eyewear & masks', focus: 'head', sections: [
    { kind: 'items', title: 'Face', slot: 'face' },
    { kind: 'colors', title: 'Color', key: 'faceColor', palette: 'cloth', when: tinted('face') },
  ] },
  { id: 'ears', label: 'Earrings', focus: 'head', sections: [
    { kind: 'items', title: 'Earrings', slot: 'ears' },
  ] },
  { id: 'neck', label: 'Neck', focus: 'torso', sections: [
    { kind: 'items', title: 'Neck', slot: 'neck' },
    { kind: 'colors', title: 'Color', key: 'neckColor', palette: 'cloth', when: tinted('neck') },
  ] },
  { id: 'back', label: 'Back', focus: 'back', sections: [
    { kind: 'items', title: 'Carried on the back', slot: 'back' },
    { kind: 'colors', title: 'Color', key: 'backColor', palette: 'cloth', when: tinted('back') },
  ] },
  { id: 'gear', label: 'Gear', focus: 'body', sections: [
    { kind: 'items', title: 'Vests & belts', slot: 'gear' },
    { kind: 'colors', title: 'Color', key: 'gearColor', palette: 'cloth', when: tinted('gear') },
  ] },
];

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/**
 * Survivor customization: categories on the left, a live 3D preview in the middle, options and
 * colors on the right. Every change is saved to the profile at once; it is what the survivor
 * wears in game and what other players will see.
 */
export class CharacterCreator {
  readonly el: HTMLElement;
  private readonly preview = new CharacterPreview();
  private readonly tabsEl = h('nav', { class: 'creator-tabs', role: 'tablist', 'aria-label': 'Customization categories' });
  private readonly optionsEl = h('div', { class: 'creator-options' });
  private readonly nameInput: HTMLInputElement;
  private tab = TABS[0];
  private a: Appearance;
  private pending = 0;

  constructor(private readonly onClose: () => void) {
    this.a = sanitizeAppearance(settings.value.profile.appearance);
    this.nameInput = h('input', {
      class: 'creator-name', type: 'text', maxlength: 16, spellcheck: 'false', 'aria-label': 'Survivor name',
      value: settings.value.profile.name,
      oninput: () => settings.update((s) => { s.profile.name = this.nameInput.value.trim().slice(0, 16) || 'Survivor'; }),
    });
    const btn = (label: string, onClick: () => void, cls = '') => h('button', {
      class: `creator-btn ${cls}`,
      onmouseenter: () => audio.ui('hover'),
      onclick: () => { audio.ui('click'); onClick(); },
    }, label);

    for (const t of TABS) {
      this.tabsEl.append(h('button', {
        class: 'creator-tab', role: 'tab', 'data-tab': t.id,
        onmouseenter: () => audio.ui('hover'),
        onclick: () => { audio.ui('click'); this.select(t); },
      }, t.label));
    }

    const stage = h('div', { class: 'creator-stage' },
      this.preview.canvas,
      h('div', { class: 'creator-turn' },
        h('button', { class: 'creator-btn round', 'aria-label': 'Turn left', onclick: () => this.preview.turn(-Math.PI / 4) }, '⟲'),
        h('span', {}, 'DRAG TO TURN · SCROLL TO ZOOM'),
        h('button', { class: 'creator-btn round', 'aria-label': 'Turn right', onclick: () => this.preview.turn(Math.PI / 4) }, '⟳'),
      ),
    );

    this.el = h('div', { class: 'creator', role: 'dialog', 'aria-label': 'Customize your survivor' },
      h('header', { class: 'creator-head' },
        h('h2', {}, 'SURVIVOR'),
        h('label', { class: 'creator-name-wrap' }, h('span', {}, 'NAME'), this.nameInput),
        h('div', { class: 'creator-actions' },
          // Both keep the body type picked: a new random survivor, or that body's starting look.
          btn('RANDOMIZE', () => this.apply(randomAppearance(Math.random, this.a.body))),
          btn('RESET', () => this.apply({ ...BODY_DEFAULTS[this.a.body] })),
          btn('DONE', () => { audio.ui('back'); this.onClose(); }, 'primary'),
        ),
      ),
      this.tabsEl,
      stage,
      this.optionsEl,
    );
    this.preview.setAppearance(this.a);
    this.select(this.tab);
  }

  show(parent: HTMLElement): void {
    parent.append(this.el);
    this.preview.start();
    gsap.fromTo(this.el, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: 'power2.out' });
    gsap.fromTo(this.el.querySelectorAll('.creator-tab'), { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: 0.4, stagger: 0.025, ease: 'power2.out' });
  }

  private select(t: Tab): void {
    this.tab = t;
    for (const b of this.tabsEl.children) {
      const on = (b as HTMLElement).dataset.tab === t.id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    this.preview.focus(t.focus);
    this.renderOptions();
  }

  private renderOptions(): void {
    const scroll = this.optionsEl.scrollTop;
    const out: HTMLElement[] = [h('h3', { class: 'creator-tab-title' }, this.tab.label)];
    for (const s of this.tab.sections) {
      if (s.kind === 'items') out.push(...this.itemSection(s.slot, s.title, !!s.groups));
      else {
        const title = s.when ? s.when(this.a) : s.title;
        if (title === false) continue;
        out.push(this.colorSection(s.key, s.palette, s.when && title !== 'Color' ? `${s.title} · ${title}` : s.title));
      }
    }
    this.optionsEl.replaceChildren(...out);
    this.optionsEl.scrollTop = scroll;
  }

  private itemSection(slot: AppearanceSlot, title: string, groups: boolean): HTMLElement[] {
    const items = APPEARANCE_ITEMS[slot] as readonly AppearanceItem[];
    const chip = (it: AppearanceItem) => h('button', {
      class: `creator-chip ${this.a[slot] === it.id ? 'on' : ''}`,
      'aria-pressed': String(this.a[slot] === it.id),
      onmouseenter: () => audio.ui('hover'),
      onclick: () => { audio.ui('click'); this.pick(slot, it); },
    }, it.label);
    if (!groups) return [h('h4', {}, title), h('div', { class: 'creator-chips' }, ...items.map(chip))];
    const out: HTMLElement[] = [];
    const order: (string | undefined)[] = [];
    for (const it of items) if (!order.includes(it.group)) order.push(it.group);
    for (const g of order) {
      out.push(h('h4', {}, g ?? title), h('div', { class: 'creator-chips' }, ...items.filter((it) => it.group === g).map(chip)));
    }
    return out;
  }

  private colorSection(key: ColorKey, palette: PaletteName, title: string): HTMLElement {
    const colors = PALETTES[palette], labels = PALETTE_LABELS[palette];
    return h('div', { class: 'creator-colors' },
      h('h4', {}, title, h('span', { class: 'creator-color-name' }, labels[this.a[key]] ?? '')),
      h('div', { class: 'creator-swatches', role: 'radiogroup', 'aria-label': title },
        ...colors.map((c, i) => h('button', {
          class: `creator-swatch ${this.a[key] === i ? 'on' : ''}`,
          role: 'radio', 'aria-checked': String(this.a[key] === i), 'aria-label': labels[i], title: labels[i],
          style: `--c:${hex(c)}`,
          onmouseenter: () => audio.ui('hover'),
          onclick: () => { audio.ui('click'); this.set(key, i); },
        })),
      ),
    );
  }

  private pick(slot: AppearanceSlot, it: AppearanceItem): void {
    const next = { ...this.a, [slot]: it.id } as Appearance;
    const ck = SLOT_COLOR[slot];
    // Some items come in their usual color first (a yellow hard hat); it can still be changed.
    if (ck && it.color !== undefined && this.a[slot] !== it.id) (next[ck] as number) = it.color;
    if (slot === 'body' && this.a.body !== it.id) this.switchBody(next, it.id as BodyType);
    // A dress goes over bare legs (or tights, shorts, leggings), not jeans.
    if (slot === 'top' && it.id === 'sundress' && !UNDER_DRESS.has(next.pants)) next.pants = 'skirt';
    this.apply(next);
  }

  /**
   * Switching body type keeps the clothes and colors but drops what plainly belonged to the other
   * one: a beard, makeup, and a hairstyle that leans the other way (to that body's default style).
   */
  private switchBody(next: Appearance, body: BodyType): void {
    const hair = appearanceItem('hair', next.hair);
    const other: BodyType = body === 'female' ? 'male' : 'female';
    if (hair?.lean === other || next.hair === BODY_DEFAULTS[other].hair) next.hair = BODY_DEFAULTS[body].hair;
    if (body === 'female') next.facialHair = 'none';
    else next.makeup = 'none';
  }

  private set(key: ColorKey, v: number): void {
    this.apply({ ...this.a, [key]: v });
  }

  private apply(next: Appearance): void {
    this.a = sanitizeAppearance(next);
    const saved = { ...this.a };
    settings.update((s) => { s.profile.appearance = saved; });
    this.renderOptions();
    // Rebuild the preview once per frame however fast the clicks come.
    cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => this.preview.setAppearance(this.a));
  }

  dispose(): void {
    cancelAnimationFrame(this.pending);
    this.preview.dispose();
    this.el.remove();
  }
}
