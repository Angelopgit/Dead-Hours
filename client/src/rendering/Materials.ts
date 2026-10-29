import * as THREE from 'three';
import type { MaterialKey } from '@dead-hours/shared';
import { createTextures, type TextureKey } from './ProceduralTextures';

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
  dirt: { color: 0x3a3127, roughness: 1, tex: 'concrete', texScale: 4 },
  sidingBlue: { color: 0x4a5a6e, roughness: 0.85, tex: 'siding', texScale: 2 },
  sidingGreen: { color: 0x4b5a47, roughness: 0.85, tex: 'siding', texScale: 2 },
  sidingGray: { color: 0x6a6b6a, roughness: 0.85, tex: 'siding', texScale: 2 },
  sidingBeige: { color: 0x8a7e69, roughness: 0.85, tex: 'siding', texScale: 2 },
  brick: { color: 0x6b4234, roughness: 0.92, tex: 'brick', texScale: 2.4 },
  interiorWall: { color: 0x9b9383, roughness: 0.9, tex: 'plaster', texScale: 3 },
  woodFloor: { color: 0x6b4a32, roughness: 0.7, tex: 'wood', texScale: 2.5 },
  tile: { color: 0x8c8c86, roughness: 0.5, tex: 'sidewalk', texScale: 1 },
  trim: { color: 0xb8b2a3, roughness: 0.7 },
  fenceWood: { color: 0x5a4532, roughness: 0.95, tex: 'fence', texScale: 2 },
};

export interface MaterialEntry {
  material: THREE.MeshStandardMaterial;
  texScale: number;
}

/** Central material library. Materials are shared to keep draw state changes low. */
export class MaterialLibrary {
  readonly textures: Record<TextureKey, THREE.Texture>;
  private readonly entries = new Map<MaterialKey, MaterialEntry>();
  private readonly extras = new Map<string, THREE.Material>();

  constructor(textureSize: number, anisotropy: number) {
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
    for (const t of Object.values(this.textures)) {
      t.anisotropy = a;
      t.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const e of this.entries.values()) e.material.dispose();
    for (const m of this.extras.values()) m.dispose();
    for (const t of Object.values(this.textures)) t.dispose();
  }
}
