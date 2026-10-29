/**
 * Survivor appearance: catalog ids and palette indices. The character creator edits it, the
 * profile saves it, and multiplayer sends it as a compact string (encodeAppearance) so every
 * client builds the same survivor. Catalog and palette order is part of that encoding: append
 * new entries, never reorder or remove them.
 */

export interface AppearanceItem {
  id: string;
  label: string;
  /** Sub-heading in the creator (headwear: hats, helmets, funny hats). */
  group?: string;
  /** Uses the slot's color. Items with fixed colors (a traffic cone) ignore it. */
  tint?: boolean;
  /** Tops: uses the accent color (plaid, stripes, undershirt, sleeves). */
  accent?: string;
  /** Cloth color the creator switches to when the item is picked (a yellow hard hat). */
  color?: number;
}

export const SKIN_TONES = [
  0xf0d0b8, 0xe4b897, 0xd6a27c, 0xc68e67, 0xb07955, 0x9a6444, 0x83512f, 0x6c4128, 0x55311e, 0x3f2417,
] as const;

export const HAIR_COLORS = [
  0x141210, 0x2a1d14, 0x47301f, 0x6e4e30, 0x6b2f1a, 0xa1502a, 0x9c7f4f, 0xcfb07a, 0xe3d9c2, 0x8b8985,
  0xdcdcd8, 0x9e1f23, 0x2b4f9e, 0x3d7a3a, 0xd8669c, 0x5e3a8c,
] as const;

export const EYE_COLORS = [
  0x3b2314, 0x6a4024, 0x7d6a33, 0xb07a22, 0x4f7d3c, 0x3f6fae, 0x7d8a94, 0x9cc3de, 0x7a5aa8, 0xb02a2a,
] as const;

export const CLOTH_COLORS = [
  0x2b2d31, 0x18191b, 0xd8d6d0, 0x6b6e72, 0x23304a, 0x3d5a7e, 0x6f93b8, 0x2f4a32, 0x55603a, 0x9a8a62,
  0xb59a72, 0x5a3e2a, 0x5e1f24, 0x9b2a26, 0xc2652a, 0xc4a03a, 0xc7d93a, 0xc77b9a, 0x4e3a6a, 0x2e6a6a,
] as const;

export const SKIN_LABELS = ['Porcelain', 'Fair', 'Light', 'Warm', 'Tan', 'Olive', 'Brown', 'Deep', 'Rich', 'Ebony'];
export const HAIR_COLOR_LABELS = ['Black', 'Dark brown', 'Brown', 'Light brown', 'Auburn', 'Ginger', 'Dirty blond', 'Blond', 'Platinum',
  'Gray', 'White', 'Dyed red', 'Dyed blue', 'Dyed green', 'Dyed pink', 'Dyed purple'];
export const EYE_COLOR_LABELS = ['Dark brown', 'Brown', 'Hazel', 'Amber', 'Green', 'Blue', 'Gray', 'Ice blue', 'Violet', 'Red'];
export const CLOTH_COLOR_LABELS = ['Charcoal', 'Black', 'White', 'Gray', 'Navy', 'Denim', 'Sky', 'Forest', 'Olive', 'Khaki', 'Tan',
  'Brown', 'Maroon', 'Red', 'Orange', 'Mustard', 'Hi-vis', 'Pink', 'Purple', 'Teal'];

const H = 'Hats', HL = 'Helmets', F = 'Funny hats';

export const APPEARANCE_ITEMS = {
  build: [
    { id: 'slim', label: 'Slim' },
    { id: 'average', label: 'Average' },
    { id: 'broad', label: 'Broad' },
  ],
  hair: [
    { id: 'bald', label: 'Bald' },
    { id: 'buzz', label: 'Buzz cut' },
    { id: 'short', label: 'Short' },
    { id: 'sidepart', label: 'Side part' },
    { id: 'messy', label: 'Messy' },
    { id: 'spiky', label: 'Spiky' },
    { id: 'curly', label: 'Curly' },
    { id: 'afro', label: 'Afro' },
    { id: 'long', label: 'Long' },
    { id: 'ponytail', label: 'Ponytail' },
    { id: 'bun', label: 'Top bun' },
    { id: 'mohawk', label: 'Mohawk' },
    { id: 'mullet', label: 'Mullet' },
    { id: 'bob', label: 'Bob' },
  ],
  facialHair: [
    { id: 'none', label: 'Clean shaven' },
    { id: 'stubble', label: 'Stubble' },
    { id: 'mustache', label: 'Mustache' },
    { id: 'handlebar', label: 'Handlebar' },
    { id: 'goatee', label: 'Goatee' },
    { id: 'beard', label: 'Full beard' },
    { id: 'chops', label: 'Mutton chops' },
  ],
  eyes: [
    { id: 'round', label: 'Round' },
    { id: 'almond', label: 'Almond' },
    { id: 'wide', label: 'Wide' },
    { id: 'narrow', label: 'Narrow' },
    { id: 'sleepy', label: 'Sleepy' },
    { id: 'fierce', label: 'Fierce' },
  ],
  headwear: [
    { id: 'none', label: 'None' },
    { id: 'cap', label: 'Baseball cap', group: H, tint: true },
    { id: 'capback', label: 'Backwards cap', group: H, tint: true },
    { id: 'beanie', label: 'Beanie', group: H, tint: true },
    { id: 'pombeanie', label: 'Pom-pom beanie', group: H, tint: true },
    { id: 'bucket', label: 'Bucket hat', group: H, tint: true },
    { id: 'cowboy', label: 'Cowboy hat', group: H, tint: true, color: 11 },
    { id: 'fedora', label: 'Fedora', group: H, tint: true },
    { id: 'flatcap', label: 'Flat cap', group: H, tint: true },
    { id: 'bandana', label: 'Head bandana', group: H, tint: true },
    { id: 'sweatband', label: 'Sweatband', group: H, tint: true },
    { id: 'hardhat', label: 'Hard hat', group: HL, tint: true, color: 15 },
    { id: 'army', label: 'Army helmet', group: HL, tint: true, color: 8 },
    { id: 'moto', label: 'Motorcycle helmet', group: HL, tint: true },
    { id: 'football', label: 'Football helmet', group: HL, tint: true },
    { id: 'bike', label: 'Bike helmet', group: HL, tint: true },
    { id: 'fire', label: 'Firefighter helmet', group: HL, tint: true, color: 13 },
    { id: 'knight', label: 'Knight helmet', group: HL },
    { id: 'cone', label: 'Traffic cone', group: F },
    { id: 'party', label: 'Party hat', group: F, tint: true },
    { id: 'propeller', label: 'Propeller cap', group: F, tint: true },
    { id: 'chef', label: 'Chef hat', group: F },
    { id: 'tophat', label: 'Top hat', group: F, tint: true, color: 1 },
    { id: 'viking', label: 'Viking helmet', group: F },
    { id: 'pot', label: 'Cooking pot', group: F },
    { id: 'foil', label: 'Tinfoil hat', group: F },
    { id: 'crown', label: 'Crown', group: F },
    { id: 'bunny', label: 'Bunny ears', group: F, tint: true, color: 2 },
    { id: 'pirate', label: 'Pirate hat', group: F },
    { id: 'sombrero', label: 'Sombrero', group: F, tint: true, color: 10 },
    { id: 'duck', label: 'Rubber duck', group: F },
    { id: 'lampshade', label: 'Lampshade', group: F, tint: true, color: 10 },
  ],
  top: [
    { id: 'tee', label: 'T-shirt', tint: true },
    { id: 'tank', label: 'Tank top', tint: true },
    { id: 'longsleeve', label: 'Long sleeve', tint: true },
    { id: 'striped', label: 'Striped shirt', tint: true, accent: 'Stripes' },
    { id: 'buttonup', label: 'Button-up shirt', tint: true },
    { id: 'flannel', label: 'Flannel shirt', tint: true, accent: 'Plaid' },
    { id: 'openflannel', label: 'Open flannel', tint: true, accent: 'Plaid' },
    { id: 'hawaiian', label: 'Hawaiian shirt', tint: true, accent: 'Flowers' },
    { id: 'sweater', label: 'Knit sweater', tint: true, accent: 'Chest stripe' },
    { id: 'hoodie', label: 'Hoodie', tint: true, accent: 'Drawstrings' },
    { id: 'ziphoodie', label: 'Zip hoodie', tint: true, accent: 'Undershirt' },
    { id: 'denim', label: 'Denim jacket', tint: true, accent: 'Undershirt', color: 5 },
    { id: 'leather', label: 'Leather jacket', tint: true, accent: 'Undershirt', color: 1 },
    { id: 'varsity', label: 'Varsity jacket', tint: true, accent: 'Sleeves' },
    { id: 'track', label: 'Track jacket', tint: true, accent: 'Stripes' },
    { id: 'puffer', label: 'Puffer jacket', tint: true },
    { id: 'raincoat', label: 'Rain jacket', tint: true, color: 15 },
    { id: 'camo', label: 'Camo jacket', tint: true, accent: 'Camo', color: 8 },
  ],
  pants: [
    { id: 'jeans', label: 'Jeans', tint: true, color: 5 },
    { id: 'cargo', label: 'Cargo pants', tint: true },
    { id: 'work', label: 'Work pants', tint: true },
    { id: 'joggers', label: 'Joggers', tint: true },
    { id: 'shorts', label: 'Cargo shorts', tint: true },
    { id: 'camo', label: 'Camo pants', tint: true, color: 8 },
    { id: 'overalls', label: 'Overalls', tint: true },
  ],
  shoes: [
    { id: 'sneakers', label: 'Sneakers', tint: true },
    { id: 'hightops', label: 'High-tops', tint: true },
    { id: 'combat', label: 'Combat boots', tint: true },
    { id: 'work', label: 'Work boots', tint: true, color: 10 },
    { id: 'rain', label: 'Rain boots', tint: true, color: 7 },
  ],
  gloves: [
    { id: 'none', label: 'None' },
    { id: 'work', label: 'Work gloves', tint: true },
    { id: 'fingerless', label: 'Fingerless gloves', tint: true },
    { id: 'leather', label: 'Leather gloves', tint: true, color: 1 },
    { id: 'latex', label: 'Latex gloves', tint: true, color: 6 },
  ],
  face: [
    { id: 'none', label: 'None' },
    { id: 'glasses', label: 'Glasses', tint: true },
    { id: 'round', label: 'Round glasses', tint: true },
    { id: 'sunglasses', label: 'Sunglasses', tint: true },
    { id: 'aviators', label: 'Aviators' },
    { id: 'goggles', label: 'Ski goggles', tint: true },
    { id: 'eyepatch', label: 'Eyepatch' },
    { id: 'bandanamask', label: 'Bandana mask', tint: true },
    { id: 'surgical', label: 'Surgical mask' },
    { id: 'gasmask', label: 'Gas mask' },
    { id: 'hockey', label: 'Hockey mask' },
    { id: 'clown', label: 'Clown nose' },
  ],
  neck: [
    { id: 'none', label: 'None' },
    { id: 'scarf', label: 'Scarf', tint: true },
    { id: 'bandana', label: 'Neck bandana', tint: true },
    { id: 'dogtags', label: 'Dog tags' },
    { id: 'headphones', label: 'Headphones', tint: true },
    { id: 'chain', label: 'Gold chain' },
    { id: 'bowtie', label: 'Bow tie', tint: true },
  ],
  back: [
    { id: 'none', label: 'None' },
    { id: 'backpack', label: 'Backpack', tint: true },
    { id: 'hiking', label: 'Hiking pack', tint: true },
    { id: 'messenger', label: 'Messenger bag', tint: true },
    { id: 'katana', label: 'Katana', tint: true, color: 1 },
    { id: 'guitar', label: 'Guitar', tint: true, color: 11 },
  ],
  gear: [
    { id: 'none', label: 'None' },
    { id: 'tactical', label: 'Tactical vest', tint: true, color: 8 },
    { id: 'hivis', label: 'Hi-vis vest', tint: true, color: 16 },
    { id: 'bandolier', label: 'Bandolier', tint: true },
    { id: 'belt', label: 'Utility belt', tint: true },
    { id: 'fannypack', label: 'Fanny pack', tint: true },
    { id: 'kneepads', label: 'Knee pads', tint: true },
  ],
} as const satisfies Record<string, readonly AppearanceItem[]>;

export type AppearanceSlot = keyof typeof APPEARANCE_ITEMS;
type ItemId<S extends AppearanceSlot> = (typeof APPEARANCE_ITEMS)[S][number]['id'];

export type PaletteName = 'skin' | 'hair' | 'eye' | 'cloth';
export const PALETTES: Record<PaletteName, readonly number[]> = { skin: SKIN_TONES, hair: HAIR_COLORS, eye: EYE_COLORS, cloth: CLOTH_COLORS };
export const PALETTE_LABELS: Record<PaletteName, readonly string[]> = {
  skin: SKIN_LABELS, hair: HAIR_COLOR_LABELS, eye: EYE_COLOR_LABELS, cloth: CLOTH_COLOR_LABELS,
};

export interface Appearance {
  skin: number;
  build: ItemId<'build'>;
  hair: ItemId<'hair'>;
  hairColor: number;
  facialHair: ItemId<'facialHair'>;
  eyes: ItemId<'eyes'>;
  eyeColor: number;
  headwear: ItemId<'headwear'>;
  headwearColor: number;
  top: ItemId<'top'>;
  topColor: number;
  topAccent: number;
  pants: ItemId<'pants'>;
  pantsColor: number;
  shoes: ItemId<'shoes'>;
  shoesColor: number;
  gloves: ItemId<'gloves'>;
  glovesColor: number;
  face: ItemId<'face'>;
  faceColor: number;
  neck: ItemId<'neck'>;
  neckColor: number;
  back: ItemId<'back'>;
  backColor: number;
  gear: ItemId<'gear'>;
  gearColor: number;
}

type FieldKind = { slot: AppearanceSlot } | { palette: PaletteName };

/** Every field, in wire order, with the catalog or palette its value indexes. */
export const APPEARANCE_FIELDS: readonly (readonly [keyof Appearance, FieldKind])[] = [
  ['skin', { palette: 'skin' }], ['build', { slot: 'build' }],
  ['hair', { slot: 'hair' }], ['hairColor', { palette: 'hair' }], ['facialHair', { slot: 'facialHair' }],
  ['eyes', { slot: 'eyes' }], ['eyeColor', { palette: 'eye' }],
  ['headwear', { slot: 'headwear' }], ['headwearColor', { palette: 'cloth' }],
  ['top', { slot: 'top' }], ['topColor', { palette: 'cloth' }], ['topAccent', { palette: 'cloth' }],
  ['pants', { slot: 'pants' }], ['pantsColor', { palette: 'cloth' }],
  ['shoes', { slot: 'shoes' }], ['shoesColor', { palette: 'cloth' }],
  ['gloves', { slot: 'gloves' }], ['glovesColor', { palette: 'cloth' }],
  ['face', { slot: 'face' }], ['faceColor', { palette: 'cloth' }],
  ['neck', { slot: 'neck' }], ['neckColor', { palette: 'cloth' }],
  ['back', { slot: 'back' }], ['backColor', { palette: 'cloth' }],
  ['gear', { slot: 'gear' }], ['gearColor', { palette: 'cloth' }],
];

export const DEFAULT_APPEARANCE: Appearance = {
  skin: 4, build: 'average',
  hair: 'short', hairColor: 1, facialHair: 'stubble',
  eyes: 'almond', eyeColor: 1,
  headwear: 'none', headwearColor: 13,
  top: 'openflannel', topColor: 13, topAccent: 1,
  pants: 'jeans', pantsColor: 5,
  shoes: 'combat', shoesColor: 11,
  gloves: 'none', glovesColor: 11,
  face: 'none', faceColor: 1,
  neck: 'none', neckColor: 12,
  back: 'backpack', backColor: 8,
  gear: 'none', gearColor: 8,
};

export function appearanceItem<S extends AppearanceSlot>(slot: S, id: string): AppearanceItem | undefined {
  return (APPEARANCE_ITEMS[slot] as readonly AppearanceItem[]).find((i) => i.id === id);
}

/** Palette color (hex) of a field, wrapping out-of-range indices. */
export function paletteColor(palette: PaletteName, index: number): number {
  const p = PALETTES[palette];
  return p[((Math.floor(index) % p.length) + p.length) % p.length];
}

/** A valid appearance from anything (saved profiles, network input): unknown values fall back to the defaults. */
export function sanitizeAppearance(raw: unknown): Appearance {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_APPEARANCE } as Record<keyof Appearance, string | number>;
  for (const [key, kind] of APPEARANCE_FIELDS) {
    const v = src[key];
    if ('slot' in kind) {
      if (typeof v === 'string' && appearanceItem(kind.slot, v)) out[key] = v;
    } else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < PALETTES[kind.palette].length) {
      out[key] = v;
    }
  }
  return out as unknown as Appearance;
}

const WIRE_VERSION = '1';

/** Compact wire form, e.g. "1.4.1.2.1…": one base-36 index per field. */
export function encodeAppearance(a: Appearance): string {
  const parts = [WIRE_VERSION];
  for (const [key, kind] of APPEARANCE_FIELDS) {
    const v = a[key];
    const i = 'slot' in kind ? (APPEARANCE_ITEMS[kind.slot] as readonly AppearanceItem[]).findIndex((it) => it.id === v) : (v as number);
    parts.push(Math.max(0, i).toString(36));
  }
  return parts.join('.');
}

/** Parses the wire form; anything malformed or unknown falls back field by field to the defaults. */
export function decodeAppearance(s: unknown): Appearance {
  if (typeof s !== 'string' || s.length > 200) return { ...DEFAULT_APPEARANCE };
  const parts = s.split('.');
  if (parts[0] !== WIRE_VERSION) return { ...DEFAULT_APPEARANCE };
  const raw: Record<string, unknown> = {};
  APPEARANCE_FIELDS.forEach(([key, kind], n) => {
    const t = parts[n + 1];
    if (t === undefined || !/^[0-9a-z]{1,2}$/.test(t)) return;
    const i = parseInt(t, 36);
    raw[key] = 'slot' in kind ? (APPEARANCE_ITEMS[kind.slot] as readonly AppearanceItem[])[i]?.id : i;
  });
  return sanitizeAppearance(raw);
}

/**
 * A random, plausible survivor. Headwear and accessories are often left off so a crowd of
 * randomized survivors doesn't look like a costume party; funny hats are rarer still.
 */
export function randomAppearance(rand: () => number = Math.random): Appearance {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length) % xs.length];
  const ids = (slot: AppearanceSlot, filter: (i: AppearanceItem) => boolean = () => true) =>
    (APPEARANCE_ITEMS[slot] as readonly AppearanceItem[]).filter(filter).map((i) => i.id);
  const maybe = (slot: AppearanceSlot, chance: number) => (rand() < chance ? pick(ids(slot, (i) => i.id !== 'none')) : 'none');
  const cloth = () => Math.floor(rand() * CLOTH_COLORS.length);
  let headwear = 'none';
  const r = rand();
  if (r < 0.32) headwear = pick(ids('headwear', (i) => i.group === H));
  else if (r < 0.44) headwear = pick(ids('headwear', (i) => i.group === HL));
  else if (r < 0.5) headwear = pick(ids('headwear', (i) => i.group === F));
  const hairColor = rand() < 0.88 ? Math.floor(rand() * 11) : Math.floor(rand() * HAIR_COLORS.length);
  return sanitizeAppearance({
    skin: Math.floor(rand() * SKIN_TONES.length),
    build: pick(ids('build')),
    hair: pick(ids('hair')), hairColor,
    facialHair: rand() < 0.45 ? pick(ids('facialHair')) : 'none',
    eyes: pick(ids('eyes')), eyeColor: Math.floor(rand() * 9),
    headwear, headwearColor: cloth(),
    top: pick(ids('top')), topColor: cloth(), topAccent: cloth(),
    pants: pick(ids('pants')), pantsColor: cloth(),
    shoes: pick(ids('shoes')), shoesColor: cloth(),
    gloves: maybe('gloves', 0.3), glovesColor: cloth(),
    face: maybe('face', 0.25), faceColor: cloth(),
    neck: maybe('neck', 0.25), neckColor: cloth(),
    back: maybe('back', 0.55), backColor: cloth(),
    gear: maybe('gear', 0.3), gearColor: cloth(),
  });
}
