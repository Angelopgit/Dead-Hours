import * as THREE from 'three';
import type { MapDefinition } from '@dead-hours/shared';
import type { LightField } from './LightField';

/** Bump when the bake math changes so cached results are discarded. */
export const BAKE_VERSION = 8;

/** Ground lightmap: covers the play area at 0.5 m per texel. */
export const GROUND_BAKE = { half: 128, res: 512 } as const;

/** Up-facing surfaces in this height band read the ground lightmap instead of their vertices. */
export const GROUND_BAND = { min: -0.3, max: 0.17 } as const;

export type BakeProgress = (fraction: number, label: string) => void;

interface CachedBake {
  ground: Uint16Array;
  meshes: Record<string, Float32Array>;
}

const DB_NAME = 'deadhours-bake';
const STORE = 'bakes';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    // Some embedded or private contexts never answer; bake without the cache rather than hang.
    setTimeout(() => resolve(null), 2000);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cacheGet(key: string): Promise<CachedBake | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as CachedBake | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cachePut(key: string, value: CachedBake): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function fnv(str: string, h = 0x811c9dc5): number {
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cooperative scheduler: yields to the browser every few milliseconds so the loading screen stays alive. */
class Slicer {
  private last = performance.now();
  async tick(): Promise<void> {
    if (performance.now() - this.last < 30) return;
    await new Promise((r) => setTimeout(r, 0));
    this.last = performance.now();
  }
}

/**
 * Bakes static lighting into the world: a ground lightmap texture for roads, lawns and
 * sidewalks, and a per-vertex `bake` attribute (rgb = light irradiance, a = sky visibility)
 * for every other static surface. Results are cached in IndexedDB, keyed by the map and
 * the geometry, so the bake only runs on the first visit or after the map changes.
 */
export class LightBaker {
  constructor(private readonly field: LightField, private readonly map: MapDefinition) {}

  private key(meshes: THREE.Mesh[]): string {
    const { solids, props, lights, excavations } = this.map;
    let h = fnv(JSON.stringify({ solids, props, lights, excavations }));
    for (const m of meshes) {
      const p = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      let sum = 0;
      for (let i = 0; i < p.array.length; i += 97) sum += p.array[i] * ((i % 13) + 1);
      h = fnv(`${m.name}:${p.count}:${sum.toFixed(2)}`, h);
    }
    return `v${BAKE_VERSION}:${h.toString(16)}`;
  }

  async bake(meshes: THREE.Mesh[], onProgress: BakeProgress): Promise<THREE.DataTexture> {
    const key = this.key(meshes);
    const cached = await cacheGet(key);
    if (cached && meshes.every((m) => cached.meshes[m.name]?.length === m.geometry.getAttribute('position').count * 4)) {
      for (const m of meshes) m.geometry.setAttribute('bake', new THREE.BufferAttribute(cached.meshes[m.name], 4));
      onProgress(1, 'LIGHTING LOADED');
      return this.groundTexture(cached.ground);
    }
    const slicer = new Slicer();
    const ground = await this.bakeGround(slicer, (f) => onProgress(f * 0.45, 'BAKING GROUND LIGHT'));
    const total = meshes.reduce((a, m) => a + m.geometry.getAttribute('position').count, 0);
    let done = 0;
    const out: Record<string, Float32Array> = {};
    for (const m of meshes) {
      out[m.name] = await this.bakeMesh(m, slicer, (n) => onProgress(0.45 + ((done + n) / total) * 0.55, 'BAKING LIGHT'));
      done += m.geometry.getAttribute('position').count;
      m.geometry.setAttribute('bake', new THREE.BufferAttribute(out[m.name], 4));
    }
    onProgress(1, 'LIGHTING READY');
    void cachePut(key, { ground, meshes: out });
    return this.groundTexture(ground);
  }

  private groundTexture(data: Uint16Array): THREE.DataTexture {
    const t = new THREE.DataTexture(data, GROUND_BAKE.res, GROUND_BAKE.res, THREE.RGBAFormat, THREE.HalfFloatType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  private async bakeGround(slicer: Slicer, progress: (f: number) => void): Promise<Uint16Array> {
    const { half, res } = GROUND_BAKE;
    const texel = (half * 2) / res;
    const tr = this.field.tracer;
    // Surface height under each texel (ray down from above curbs and islands).
    const surface = (x: number, z: number): number | null => {
      if (!tr.intersect(x, 0.6, z, 0, -1, 0, 1.0, 0)) return -1;
      return tr.hit.t <= 1e-4 ? null : 0.6 - tr.hit.t;
    };
    // Sky visibility on a 1 m grid, upsampled.
    const aoRes = res / 2;
    const ao = new Float32Array(aoRes * aoRes);
    for (let j = 0; j < aoRes; j++) {
      for (let i = 0; i < aoRes; i++) {
        const x = -half + (i + 0.5) * texel * 2;
        const z = -half + (j + 0.5) * texel * 2;
        const y = surface(x, z);
        ao[j * aoRes + i] = y === null ? 0 : this.field.ao(x, y, z, 0, 1, 0, 7, true);
      }
      progress((j / aoRes) * 0.6);
      await slicer.tick();
    }
    const sampleAo = (u: number, v: number) => {
      const fx = Math.min(Math.max(u * aoRes - 0.5, 0), aoRes - 1);
      const fy = Math.min(Math.max(v * aoRes - 0.5, 0), aoRes - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, aoRes - 1), y1 = Math.min(y0 + 1, aoRes - 1);
      const tx = fx - x0, ty = fy - y0;
      const a = ao[y0 * aoRes + x0] * (1 - tx) + ao[y0 * aoRes + x1] * tx;
      const b = ao[y1 * aoRes + x0] * (1 - tx) + ao[y1 * aoRes + x1] * tx;
      return a * (1 - ty) + b * ty;
    };
    const data = new Uint16Array(res * res * 4);
    const rgb = new Float32Array(3);
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = -half + (i + 0.5) * texel;
        const z = -half + (j + 0.5) * texel;
        const o = (j * res + i) * 4;
        let a = sampleAo((i + 0.5) / res, (j + 0.5) / res);
        rgb[0] = rgb[1] = rgb[2] = 0;
        const y = surface(x, z);
        if (y === null) {
          a = 0;
        } else {
          this.field.direct(x, y, z, 0, 1, 0, rgb);
          this.field.indirect(x, y, z, 0, 1, 0, rgb);
        }
        data[o] = toHalf(rgb[0]);
        data[o + 1] = toHalf(rgb[1]);
        data[o + 2] = toHalf(rgb[2]);
        data[o + 3] = toHalf(a);
      }
      progress(0.6 + (j / res) * 0.4);
      await slicer.tick();
    }
    return data;
  }

  private async bakeMesh(mesh: THREE.Mesh, slicer: Slicer, progress: (n: number) => void): Promise<Float32Array> {
    const g = mesh.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const out = new Float32Array(pos.count * 4);
    const mat = mesh.material as THREE.Material;
    const skip = mat.userData.noBake === true;
    // Foliage sits inside its own crown proxy: fixed openness, lights traced past crowns.
    const foliage = mat.userData.foliage === true;
    // Vertices are shared by many triangles after batching: bake each unique (position, normal) once.
    const seen = new Map<string, number>();
    const rgb = new Float32Array(3);
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    mesh.updateMatrixWorld();
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      const o = i * 4;
      if (skip || (n.y > 0.9 && v.y < GROUND_BAND.max && v.y > GROUND_BAND.min)) {
        out[o + 3] = 1;
        continue;
      }
      const k = `${Math.round(v.x * 200)},${Math.round(v.y * 200)},${Math.round(v.z * 200)},${Math.round(n.x * 20)},${Math.round(n.y * 20)},${Math.round(n.z * 20)}`;
      const prev = seen.get(k);
      if (prev !== undefined) {
        out[o] = out[prev]; out[o + 1] = out[prev + 1]; out[o + 2] = out[prev + 2]; out[o + 3] = out[prev + 3];
        continue;
      }
      seen.set(k, o);
      out[o + 3] = foliage ? 0.8 : this.field.ao(v.x, v.y, v.z, n.x, n.y, n.z, 6);
      this.field.direct(v.x, v.y, v.z, n.x, n.y, n.z, rgb, !foliage);
      this.field.indirect(v.x, v.y, v.z, n.x, n.y, n.z, rgb);
      out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2];
      if ((i & 255) === 0) {
        progress(i);
        await slicer.tick();
      }
    }
    return out;
  }
}
