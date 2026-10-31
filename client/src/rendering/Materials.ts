import * as THREE from 'three';
import type { MaterialKey } from '@dead-hours/shared';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { createTextures, type TextureKey } from './ProceduralTextures';
import type { Quality } from '../core/Settings';

interface MatDef {
  color: number;
  roughness: number;
  metalness?: number;
  tex?: TextureKey;
  /** Meters covered by one texture tile. */
  texScale?: number;
}

const DEFS: Record<Exclude<MaterialKey, 'invisible'>, MatDef> = {
  asphalt: { color: 0x2c2f33, roughness: 0.93, tex: 'asphalt', texScale: 6 },
  sidewalk: { color: 0x6e6f6c, roughness: 0.9, tex: 'sidewalk', texScale: 3 },
  curb: { color: 0x76766f, roughness: 0.9, tex: 'concrete', texScale: 2 },
  concrete: { color: 0x5f605c, roughness: 0.92, tex: 'concrete', texScale: 4 },
  grass: { color: 0x2b3624, roughness: 1, tex: 'grass', texScale: 5 },
  dirt: { color: 0x3d342a, roughness: 1, tex: 'dirt', texScale: 4 },
  gravel: { color: 0x55524b, roughness: 0.97, tex: 'gravel', texScale: 2.5 },
  sidingBlue: { color: 0x4a5a6e, roughness: 0.85, tex: 'siding', texScale: 2 },
  sidingGreen: { color: 0x4b5a47, roughness: 0.85, tex: 'siding', texScale: 2 },
  sidingGray: { color: 0x6a6b6a, roughness: 0.85, tex: 'siding', texScale: 2 },
  sidingBeige: { color: 0x8a7e69, roughness: 0.85, tex: 'siding', texScale: 2 },
  brick: { color: 0x6b4234, roughness: 0.92, tex: 'brick', texScale: 2.4 },
  stucco: { color: 0x8d8574, roughness: 0.95, tex: 'plaster', texScale: 2 },
  interiorWall: { color: 0x9b9383, roughness: 0.9, tex: 'plaster', texScale: 3 },
  interiorWallBlue: { color: 0x6f7c86, roughness: 0.9, tex: 'plaster', texScale: 3 },
  carpet: { color: 0x5a4f48, roughness: 1, tex: 'carpet', texScale: 1.5 },
  woodFloor: { color: 0x6b4a32, roughness: 0.7, tex: 'wood', texScale: 2.5 },
  tile: { color: 0x8f8f88, roughness: 0.45, tex: 'tile', texScale: 1.2 },
  trim: { color: 0xb8b2a3, roughness: 0.7 },
  fenceWood: { color: 0x5a4532, roughness: 0.95, tex: 'fence', texScale: 2 },
  darkWood: { color: 0x3e2c1f, roughness: 0.8, tex: 'wood', texScale: 2 },
  metal: { color: 0x4d5257, roughness: 0.55, metalness: 0.6, tex: 'metal', texScale: 2 },
  roofFlat: { color: 0x3a3b3d, roughness: 0.95, tex: 'concrete', texScale: 4 },
};

/** How hard each set's normal map pushes (1 = as authored). */
const NORMAL_SCALE: Partial<Record<TextureKey, number>> = { plaster: 0.6, carpet: 0.8, grass: 0.9 };
/** Strength of the packed ambient occlusion (only darkens indirect and baked light). */
const AO_INTENSITY = 0.85;
/** Full-color photo sets (manifest `colored`) replace the tint with this neutral gray. */
const COLORED_TINT = 0xc8c8c8;

interface PbrManifest {
  version: number;
  tiers: Record<Quality, { color: number; normal?: number; orm?: number }>;
  sets: Partial<Record<TextureKey, { from: string; colored: boolean }>>;
}

interface PbrSet {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  orm: THREE.Texture | null;
  colored: boolean;
}

/** What a material looked like before PBR maps went on (to restore the procedural fallback). */
interface Original {
  map: THREE.Texture;
  color: number;
  roughness: number;
  metalness: number;
}

export interface MaterialEntry {
  material: THREE.MeshStandardMaterial;
  texScale: number;
}

/** Central material library. Materials are shared to keep draw state changes low. */
export class MaterialLibrary {
  readonly textures: Record<TextureKey, THREE.Texture>;
  private readonly entries = new Map<MaterialKey, MaterialEntry>();
  private readonly extras = new Map<string, THREE.Material>();

  private pbr: Partial<Record<TextureKey, PbrSet>> = {};
  private pbrQuality: Quality | null = null;
  private pbrLoad: Promise<boolean> | null = null;
  private loader: KTX2Loader | null = null;
  private readonly originals = new Map<THREE.MeshStandardMaterial, Original>();
  private anisotropy: number;

  constructor(textureSize: number, anisotropy: number) {
    this.anisotropy = anisotropy;
    this.textures = createTextures(textureSize, anisotropy);
    for (const [key, def] of Object.entries(DEFS) as [MaterialKey, MatDef][]) {
      const m = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: def.roughness,
        metalness: def.metalness ?? 0,
        map: def.tex ? this.textures[def.tex] : null,
        vertexColors: true,
      });
      m.name = key;
      this.entries.set(key, { material: m, texScale: def.texScale ?? 1 });
    }
  }

  get(key: MaterialKey): MaterialEntry {
    const e = this.entries.get(key);
    if (!e) throw new Error(`Unknown material ${key}`);
    return e;
  }

  /** Cached ad-hoc materials for props (keyed by a descriptive id). */
  custom<T extends THREE.Material>(id: string, make: () => T): T {
    let m = this.extras.get(id) as T | undefined;
    if (!m) {
      m = make();
      m.name = id;
      this.extras.set(id, m);
    }
    return m;
  }

  standard(color: number, roughness = 0.8, metalness = 0, flat = true): THREE.MeshStandardMaterial {
    return this.custom(`std-${color}-${roughness}-${metalness}-${flat}`, () =>
      new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: flat }),
    );
  }

  emissive(color: number, intensity: number): THREE.MeshStandardMaterial {
    return this.custom(`emi-${color}-${intensity}`, () =>
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity, roughness: 1 }),
    );
  }

  setAnisotropy(a: number): void {
    this.anisotropy = a;
    for (const t of Object.values(this.textures)) {
      t.anisotropy = a;
      t.needsUpdate = true;
    }
    for (const set of Object.values(this.pbr)) {
      for (const t of [set.map, set.normalMap, set.orm]) if (t) t.anisotropy = a;
    }
  }

  /**
   * Streams the compressed PBR sets (client/public/textures/world, KTX2) for a texture quality and
   * puts them on every material that uses a procedural detail map: color, normal, and packed
   * AO/roughness/metal. Low quality loads color only. Resolves false (procedural maps stay) when the
   * files are missing, as in the single-file build, or the device cannot transcode them.
   */
  loadPbr(renderer: THREE.WebGLRenderer, quality: Quality): Promise<boolean> {
    if (quality === this.pbrQuality && this.pbrLoad) return this.pbrLoad;
    this.pbrQuality = quality;
    const load = this.fetchPbr(renderer, quality).catch((e) => {
      console.warn('PBR textures unavailable, keeping procedural maps:', e);
      return false;
    });
    this.pbrLoad = load;
    return load;
  }

  private async fetchPbr(renderer: THREE.WebGLRenderer, quality: Quality): Promise<boolean> {
    const base = `${import.meta.env.BASE_URL}textures/world/`;
    const res = await fetch(`${base}manifest.json`);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const manifest = (await res.json()) as PbrManifest;
    if (!this.loader) {
      this.loader = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).detectSupport(renderer);
    }
    const loader = this.loader;
    const tier = manifest.tiers[quality];
    const used = new Set<TextureKey>();
    for (const m of this.allStandard()) {
      const key = this.procKey(m);
      if (key && manifest.sets[key]) used.add(key);
    }
    const get = async (key: TextureKey, map: 'color' | 'normal' | 'orm', size: number | undefined, srgb: boolean) => {
      if (!size) return null;
      const t = await loader.loadAsync(`${base}${key}/${map}_${size}.ktx2?v=${manifest.version}`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = this.anisotropy;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.name = `${key}-${map}-${size}`;
      return t;
    };
    const sets = await Promise.all([...used].map(async (key) => {
      const [map, normalMap, orm] = await Promise.all([
        get(key, 'color', tier.color, true), get(key, 'normal', tier.normal, false), get(key, 'orm', tier.orm, false),
      ]);
      return [key, { map: map!, normalMap, orm, colored: !!manifest.sets[key]?.colored }] as const;
    }));
    // A newer quality was asked for while this one loaded: drop this one.
    if (this.pbrQuality !== quality) {
      for (const [, s] of sets) for (const t of [s.map, s.normalMap, s.orm]) t?.dispose();
      return false;
    }
    const old = this.pbr;
    this.pbr = Object.fromEntries(sets);
    for (const m of this.allStandard()) this.applyPbr(m);
    for (const s of Object.values(old)) for (const t of [s.map, s.normalMap, s.orm]) t?.dispose();
    return true;
  }

  /** The procedural texture key a material was built with (null for untextured materials). */
  private procKey(m: THREE.MeshStandardMaterial): TextureKey | null {
    const map = this.originals.get(m)?.map ?? m.map;
    if (!map) return null;
    for (const [k, t] of Object.entries(this.textures) as [TextureKey, THREE.Texture][]) if (t === map) return k;
    return null;
  }

  private allStandard(): THREE.MeshStandardMaterial[] {
    const out: THREE.MeshStandardMaterial[] = [];
    for (const e of this.entries.values()) out.push(e.material);
    for (const m of this.extras.values()) if (m instanceof THREE.MeshStandardMaterial) out.push(m);
    return out;
  }

  private applyPbr(m: THREE.MeshStandardMaterial): void {
    const key = this.procKey(m);
    if (!key) return;
    const set = this.pbr[key];
    let orig = this.originals.get(m);
    if (!orig) {
      orig = { map: m.map!, color: m.color.getHex(), roughness: m.roughness, metalness: m.metalness };
      this.originals.set(m, orig);
    }
    if (!set) {
      m.map = orig.map;
      m.normalMap = m.aoMap = m.roughnessMap = m.metalnessMap = null;
      m.color.setHex(orig.color);
      m.roughness = orig.roughness;
      m.metalness = orig.metalness;
    } else {
      m.map = set.map;
      m.normalMap = set.normalMap;
      const s = NORMAL_SCALE[key] ?? 1;
      m.normalScale.set(s, s);
      m.aoMap = set.orm;
      m.aoMapIntensity = AO_INTENSITY;
      m.roughnessMap = set.orm;
      // The ORM green channel holds absolute roughness; keep the material's old value as a gentle bias.
      m.roughness = set.orm ? THREE.MathUtils.clamp(orig.roughness / 0.85, 0.6, 1.15) : orig.roughness;
      m.metalnessMap = set.orm && orig.metalness > 0 ? set.orm : null;
      m.metalness = m.metalnessMap ? Math.min(1, orig.metalness * 1.3) : orig.metalness;
      m.color.setHex(set.colored ? COLORED_TINT : orig.color);
    }
    m.needsUpdate = true;
  }

  dispose(): void {
    for (const s of Object.values(this.pbr)) for (const t of [s.map, s.normalMap, s.orm]) t?.dispose();
    this.loader?.dispose();
    for (const e of this.entries.values()) e.material.dispose();
    for (const m of this.extras.values()) m.dispose();
    for (const t of Object.values(this.textures)) t.dispose();
  }
}
