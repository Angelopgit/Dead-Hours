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
  /**
   * Who the randomizer gives it to. Everything can be worn by either body type in the creator;
   * this only keeps random survivors and zombies plausible (no bearded women in sundresses).
   */
  lean?: BodyType;
  /**
   * Offered to this body type only. "No shirt" is for men: a woman's bare chest is always drawn
   * as a bikini top (sanitizeAppearance swaps it, and the outfit builder never draws it bare).
   */
  only?: BodyType;
}

export type BodyType = 'male' | 'female';

/**
 * Body shape sliders (female bodies): bust, hip width, glutes. Each is a step from 0 to
 * SHAPE_STEPS - 1 with SHAPE_MID the average; the outfit builder keeps the range modest and
 * every outfit fitted at every step.
 */
export const SHAPE_STEPS = 7;
export const SHAPE_MID = 3;
export const SHAPE_LABELS = ['−3', '−2', '−1', 'Average', '+1', '+2', '+3'] as const;
export type ShapeKey = 'bust' | 'hips' | 'glutes';

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

/** Lipstick, eyeshadow and the like (the makeup slot's color). */
export const MAKEUP_COLORS = [
  0xb47a6c, 0xd66f8e, 0xb04a62, 0xb3202e, 0x7c1f3f, 0x5a2a4a, 0xe0705a, 0x6e3b2c, 0x1c1416, 0xc9a24a, 0x3f5fa8, 0x6a3f9a,
] as const;

export const SKIN_LABELS = ['Porcelain', 'Fair', 'Light', 'Warm', 'Tan', 'Olive', 'Brown', 'Deep', 'Rich', 'Ebony'];
export const HAIR_COLOR_LABELS = ['Black', 'Dark brown', 'Brown', 'Light brown', 'Auburn', 'Ginger', 'Dirty blond', 'Blond', 'Platinum',
  'Gray', 'White', 'Dyed red', 'Dyed blue', 'Dyed green', 'Dyed pink', 'Dyed purple'];
export const EYE_COLOR_LABELS = ['Dark brown', 'Brown', 'Hazel', 'Amber', 'Green', 'Blue', 'Gray', 'Ice blue', 'Violet', 'Red'];
export const CLOTH_COLOR_LABELS = ['Charcoal', 'Black', 'White', 'Gray', 'Navy', 'Denim', 'Sky', 'Forest', 'Olive', 'Khaki', 'Tan',
  'Brown', 'Maroon', 'Red', 'Orange', 'Mustard', 'Hi-vis', 'Pink', 'Purple', 'Teal'];
export const MAKEUP_COLOR_LABELS = ['Nude', 'Pink', 'Rose', 'Red', 'Berry', 'Plum', 'Coral', 'Brown', 'Black', 'Gold', 'Blue', 'Purple'];

const H = 'Hats', HL = 'Helmets', F = 'Funny hats', HA = 'Hair accessories';
const M = 'male', W = 'female';

export const APPEARANCE_ITEMS = {
  build: [
    { id: 'slim', label: 'Slim' },
    { id: 'average', label: 'Average' },
    { id: 'broad', label: 'Broad' },
  ],
  hair: [
    { id: 'bald', label: 'Bald', lean: M },
    { id: 'buzz', label: 'Buzz cut' },
    { id: 'short', label: 'Short' },
    { id: 'sidepart', label: 'Side part', lean: M },
    { id: 'messy', label: 'Messy' },
    { id: 'spiky', label: 'Spiky', lean: M },
    { id: 'curly', label: 'Curly' },
    { id: 'afro', label: 'Afro' },
    { id: 'long', label: 'Long' },
    { id: 'ponytail', label: 'Ponytail' },
    { id: 'bun', label: 'Top bun' },
    { id: 'mohawk', label: 'Mohawk' },
    { id: 'mullet', label: 'Mullet', lean: M },
    { id: 'bob', label: 'Bob' },
    { id: 'pixie', label: 'Pixie cut', lean: W },
    { id: 'bangs', label: 'Long with bangs', lean: W },
    { id: 'wavy', label: 'Long waves', lean: W },
    { id: 'shoulder', label: 'Shoulder length', lean: W },
    { id: 'highpony', label: 'High ponytail', lean: W },
    { id: 'braid', label: 'Braid', lean: W },
    { id: 'pigtails', label: 'Pigtails', lean: W },
    { id: 'spacebuns', label: 'Space buns', lean: W },
    { id: 'messybun', label: 'Messy bun', lean: W },
    { id: 'afropuffs', label: 'Afro puffs', lean: W },
    { id: 'boxbraids', label: 'Box braids', lean: W },
  ],
  facialHair: [
    { id: 'none', label: 'Clean shaven' },
    { id: 'stubble', label: 'Stubble', lean: M },
    { id: 'mustache', label: 'Mustache', lean: M },
    { id: 'handlebar', label: 'Handlebar', lean: M },
    { id: 'goatee', label: 'Goatee', lean: M },
    { id: 'beard', label: 'Full beard', lean: M },
    { id: 'chops', label: 'Mutton chops', lean: M },
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
    { id: 'beret', label: 'Beret', group: H, tint: true, color: 12 },
    { id: 'sunhat', label: 'Sun hat', group: H, tint: true, color: 10, lean: W },
    { id: 'headband', label: 'Headband', group: HA, tint: true, lean: W },
    { id: 'hairbow', label: 'Hair bow', group: HA, tint: true, color: 13, lean: W },
    { id: 'clips', label: 'Hair clips', group: HA, tint: true, color: 17, lean: W },
    { id: 'flowercrown', label: 'Flower crown', group: HA, lean: W },
    { id: 'tiara', label: 'Tiara', group: F },
    { id: 'catears', label: 'Cat ears', group: F, tint: true, color: 1 },
    { id: 'witch', label: 'Witch hat', group: F, tint: true, color: 1 },
    { id: 'santa', label: 'Santa hat', group: F, tint: true, color: 13 },
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
    { id: 'croptop', label: 'Crop top', tint: true, lean: W },
    { id: 'cami', label: 'Camisole', tint: true, lean: W },
    { id: 'blouse', label: 'Blouse', tint: true, lean: W },
    { id: 'sportstop', label: 'Sports top', tint: true, accent: 'Trim', lean: W },
    { id: 'turtleneck', label: 'Turtleneck', tint: true },
    { id: 'cardigan', label: 'Cardigan', tint: true, accent: 'Undershirt', lean: W },
    { id: 'sundress', label: 'Sundress', tint: true, accent: 'Flowers', lean: W },
    { id: 'peacoat', label: 'Peacoat', tint: true, accent: 'Undershirt', color: 4 },
    // Swimwear.
    { id: 'shirtless', label: 'No shirt', lean: M, only: M },
    { id: 'bikini', label: 'Bikini top', tint: true, accent: 'Trim', color: 19, lean: W },
    { id: 'swimsuit', label: 'One-piece swimsuit', tint: true, accent: 'Trim', color: 1, lean: W },
    { id: 'rashguard', label: 'Rash guard', tint: true, accent: 'Panels', color: 4 },
  ],
  pants: [
    { id: 'jeans', label: 'Jeans', tint: true, color: 5 },
    { id: 'cargo', label: 'Cargo pants', tint: true },
    { id: 'work', label: 'Work pants', tint: true },
    { id: 'joggers', label: 'Joggers', tint: true },
    { id: 'shorts', label: 'Cargo shorts', tint: true },
    { id: 'camo', label: 'Camo pants', tint: true, color: 8 },
    { id: 'overalls', label: 'Overalls', tint: true },
    { id: 'leggings', label: 'Leggings', tint: true, color: 1, lean: W },
    { id: 'flares', label: 'Flared jeans', tint: true, color: 5, lean: W },
    { id: 'denimshorts', label: 'Denim shorts', tint: true, color: 6, lean: W },
    { id: 'skirt', label: 'Skirt', tint: true, lean: W },
    { id: 'plaidskirt', label: 'Plaid skirt & tights', tint: true, color: 12, lean: W },
    // Swimwear.
    { id: 'swimtrunks', label: 'Swim trunks', tint: true, color: 6, lean: M },
    { id: 'boardshorts', label: 'Board shorts', tint: true, color: 14 },
    { id: 'bikinibottom', label: 'Bikini bottoms', tint: true, color: 19, lean: W },
  ],
  shoes: [
    { id: 'sneakers', label: 'Sneakers', tint: true },
    { id: 'hightops', label: 'High-tops', tint: true },
    { id: 'combat', label: 'Combat boots', tint: true },
    { id: 'work', label: 'Work boots', tint: true, color: 10 },
    { id: 'rain', label: 'Rain boots', tint: true, color: 7 },
    { id: 'kneeboots', label: 'Knee-high boots', tint: true, color: 1, lean: W },
    { id: 'heeledboots', label: 'Heeled ankle boots', tint: true, color: 11, lean: W },
    { id: 'flats', label: 'Flats', tint: true, color: 1, lean: W },
    { id: 'platforms', label: 'Platform sneakers', tint: true, color: 2, lean: W },
    { id: 'flipflops', label: 'Flip-flops', tint: true, color: 6 },
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
    { id: 'cateye', label: 'Cat-eye glasses', tint: true, lean: W },
    { id: 'oversized', label: 'Oversized sunglasses', tint: true, color: 1, lean: W },
    { id: 'heartglasses', label: 'Heart sunglasses', tint: true, color: 17 },
  ],
  neck: [
    { id: 'none', label: 'None' },
    { id: 'scarf', label: 'Scarf', tint: true },
    { id: 'bandana', label: 'Neck bandana', tint: true },
    { id: 'dogtags', label: 'Dog tags' },
    { id: 'headphones', label: 'Headphones', tint: true },
    { id: 'chain', label: 'Gold chain' },
    { id: 'bowtie', label: 'Bow tie', tint: true },
    { id: 'pearls', label: 'Pearl necklace', lean: W },
    { id: 'choker', label: 'Choker', tint: true, color: 1, lean: W },
    { id: 'locket', label: 'Gold locket', lean: W },
  ],
  back: [
    { id: 'none', label: 'None' },
    { id: 'backpack', label: 'Backpack', tint: true },
    { id: 'hiking', label: 'Hiking pack', tint: true },
    { id: 'messenger', label: 'Messenger bag', tint: true },
    { id: 'katana', label: 'Katana', tint: true, color: 1 },
    { id: 'guitar', label: 'Guitar', tint: true, color: 11 },
    { id: 'purse', label: 'Shoulder bag', tint: true, color: 11, lean: W },
    { id: 'minipack', label: 'Mini backpack', tint: true, color: 17, lean: W },
    { id: 'quiver', label: 'Quiver', tint: true, color: 11 },
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
  body: [
    { id: 'male', label: 'Male' },
    { id: 'female', label: 'Female' },
  ],
  ears: [
    { id: 'none', label: 'None' },
    { id: 'studs', label: 'Silver studs' },
    { id: 'goldstuds', label: 'Gold studs' },
    { id: 'hoops', label: 'Gold hoops', lean: W },
    { id: 'silverhoops', label: 'Silver hoops', lean: W },
    { id: 'bighoops', label: 'Big hoops', lean: W },
    { id: 'pearls', label: 'Pearl earrings', lean: W },
    { id: 'drops', label: 'Drop earrings', lean: W },
  ],
  makeup: [
    { id: 'none', label: 'None' },
    { id: 'lipstick', label: 'Lipstick', tint: true, lean: W },
    { id: 'liner', label: 'Winged liner', lean: W },
    { id: 'blush', label: 'Blush', lean: W },
    { id: 'shadow', label: 'Eyeshadow', tint: true, lean: W },
    { id: 'glam', label: 'Full glam', tint: true, lean: W },
    { id: 'smoky', label: 'Smoky eyes', tint: true, lean: W },
    { id: 'eyeblack', label: 'Eye black' },
  ],
  smoke: [
    { id: 'none', label: 'None' },
    { id: 'cigarette', label: 'Cigarette' },
    { id: 'joint', label: 'Joint' },
    { id: 'blunt', label: 'Blunt' },
  ],
} as const satisfies Record<string, readonly AppearanceItem[]>;

export type AppearanceSlot = keyof typeof APPEARANCE_ITEMS;
type ItemId<S extends AppearanceSlot> = (typeof APPEARANCE_ITEMS)[S][number]['id'];

export type PaletteName = 'skin' | 'hair' | 'eye' | 'cloth' | 'makeup';
export const PALETTES: Record<PaletteName, readonly number[]> = {
  skin: SKIN_TONES, hair: HAIR_COLORS, eye: EYE_COLORS, cloth: CLOTH_COLORS, makeup: MAKEUP_COLORS,
};
export const PALETTE_LABELS: Record<PaletteName, readonly string[]> = {
  skin: SKIN_LABELS, hair: HAIR_COLOR_LABELS, eye: EYE_COLOR_LABELS, cloth: CLOTH_COLOR_LABELS, makeup: MAKEUP_COLOR_LABELS,
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
  body: ItemId<'body'>;
  ears: ItemId<'ears'>;
  makeup: ItemId<'makeup'>;
  makeupColor: number;
  /** Lit and held in the mouth: a cigarette, a joint or a blunt, with a glowing tip and smoke. */
  smoke: ItemId<'smoke'>;
  /** Body shape steps (0 to SHAPE_STEPS - 1), used by female bodies. */
  bust: number;
  hips: number;
  glutes: number;
}

type FieldKind = { slot: AppearanceSlot } | { palette: PaletteName } | { steps: number };

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
  // Added with female survivors: older saves and clients simply stop before these (male, none).
  ['body', { slot: 'body' }], ['ears', { slot: 'ears' }], ['makeup', { slot: 'makeup' }], ['makeupColor', { palette: 'makeup' }],
  // Added with smokes: older strings stop before it (none).
  ['smoke', { slot: 'smoke' }],
  // Added with the body shape sliders: older strings stop before these (average).
  ['bust', { steps: SHAPE_STEPS }], ['hips', { steps: SHAPE_STEPS }], ['glutes', { steps: SHAPE_STEPS }],
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
  body: 'male', ears: 'none', makeup: 'none', makeupColor: 2,
  smoke: 'none',
  bust: SHAPE_MID, hips: SHAPE_MID, glutes: SHAPE_MID,
};

/** Where a new female survivor starts (the creator's reset, and switching body type). */
export const DEFAULT_FEMALE_APPEARANCE: Appearance = {
  ...DEFAULT_APPEARANCE,
  body: 'female', build: 'average',
  hair: 'wavy', hairColor: 2, facialHair: 'none',
  eyes: 'almond', eyeColor: 4,
  top: 'openflannel', topColor: 4, topAccent: 2,
  pants: 'jeans', pantsColor: 5,
  shoes: 'combat', shoesColor: 1,
  ears: 'studs', makeup: 'none', makeupColor: 2,
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
    } else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < ('steps' in kind ? kind.steps : PALETTES[kind.palette].length)) {
      out[key] = v;
    }
  }
  // Kept safe for work: a woman is never shirtless, she wears a bikini top instead.
  if (out.body === 'female' && out.top === 'shirtless') out.top = 'bikini';
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
 * A random, plausible survivor, male or female (or the body type asked for). Headwear and
 * accessories are often left off so a crowd of randomized survivors doesn't look like a costume
 * party; funny hats are rarer still. Items leaning to the other body type are left out.
 */
export function randomAppearance(rand: () => number = Math.random, body?: BodyType): Appearance {
  const sex: BodyType = body ?? (rand() < 0.5 ? 'female' : 'male');
  const female = sex === 'female';
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length) % xs.length];
  const ids = (slot: AppearanceSlot, filter: (i: AppearanceItem) => boolean = () => true) =>
    (APPEARANCE_ITEMS[slot] as readonly AppearanceItem[]).filter((i) => (!i.lean || i.lean === sex) && filter(i)).map((i) => i.id);
  const maybe = (slot: AppearanceSlot, chance: number) => (rand() < chance ? pick(ids(slot, (i) => i.id !== 'none')) : 'none');
  const cloth = () => Math.floor(rand() * CLOTH_COLORS.length);
  let headwear = 'none';
  const r = rand();
  if (r < 0.32) headwear = pick(ids('headwear', (i) => i.group === H || i.group === HA));
  else if (r < 0.44) headwear = pick(ids('headwear', (i) => i.group === HL));
  else if (r < 0.5) headwear = pick(ids('headwear', (i) => i.group === F));
  const hairColor = rand() < 0.88 ? Math.floor(rand() * 11) : Math.floor(rand() * HAIR_COLORS.length);
  // Skirts and dresses go with bare legs or tights, not under jeans; a swimsuit with swim bottoms.
  const top = pick(ids('top', (i) => !i.only || i.only === sex));
  const pants = top === 'sundress' ? 'skirt' : top === 'swimsuit' ? 'bikinibottom' : pick(ids('pants'));
  return sanitizeAppearance({
    skin: Math.floor(rand() * SKIN_TONES.length),
    build: pick(ids('build')),
    hair: pick(ids('hair')), hairColor,
    facialHair: !female && rand() < 0.45 ? pick(ids('facialHair')) : 'none',
    eyes: pick(ids('eyes')), eyeColor: Math.floor(rand() * 9),
    headwear, headwearColor: cloth(),
    top, topColor: cloth(), topAccent: cloth(),
    pants, pantsColor: cloth(),
    shoes: pick(ids('shoes')), shoesColor: cloth(),
    gloves: maybe('gloves', 0.3), glovesColor: cloth(),
    face: maybe('face', 0.25), faceColor: cloth(),
    neck: maybe('neck', 0.25), neckColor: cloth(),
    back: maybe('back', 0.55), backColor: cloth(),
    gear: maybe('gear', 0.3), gearColor: cloth(),
    body: sex,
    ears: maybe('ears', female ? 0.6 : 0.12),
    makeup: female ? maybe('makeup', 0.45) : 'none',
    makeupColor: Math.floor(rand() * MAKEUP_COLORS.length),
    // Drawn last, so every field before it comes out as it did before smokes existed.
    smoke: maybe('smoke', 0.12),
    // Mostly near average, now and then toward either end.
    bust: female ? shapeStep(rand) : SHAPE_MID,
    hips: female ? shapeStep(rand) : SHAPE_MID,
    glutes: female ? shapeStep(rand) : SHAPE_MID,
  });
}

/** A random shape step, bunched around the average. */
function shapeStep(rand: () => number): number {
  const t = (rand() + rand() + rand()) / 3;
  return Math.max(0, Math.min(SHAPE_STEPS - 1, Math.round(t * (SHAPE_STEPS - 1))));
}
