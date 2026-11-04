import * as THREE from 'three';
import type { MapDefinition } from '@dead-hours/shared';
import type { LightField } from './LightField';
import { GROUND_BAND, groundBakeRect } from './BakeKernels';
import { InlineRunner, WorkerRunner, type BakeRunner, type BakeTask } from './BakePool';

/** Bump when the bake math changes so cached results are discarded. */
export const BAKE_VERSION = 9;

export { GROUND_BAKE, GROUND_BAND, groundBakeRect } from './BakeKernels';

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
 * The static meshes' vertices to bake, in world space: each mesh's unique (position, normal)
 * pairs once (vertices are shared by many triangles after batching), and per vertex the pair it
 * reads, or -1 for vertices that take no bake (the ground band and unbaked materials).
 */
type BakeResult = CachedBake;

interface BakePoints {
  /** x, y, z, nx, ny, nz per point. */
  pts: Float64Array;
  foliage: Uint8Array;
  count: number;
  perMesh: Int32Array[];
}

/**
 * The (position, normal) pairs a mesh has met, rounded to whole steps (5 mm, 0.05): an
 * open-addressing table over the six integers, so deduplicating 900k vertices allocates nothing.
 */
class PointTable {
  private readonly keys: Int32Array;
  private readonly values: Int32Array;
  private readonly mask: number;
  /** Pairs with a NaN in them (never expected) are kept by their text, as distinct keys. */
  private readonly odd = new Map<string, number>();

  constructor(capacity: number) {
    let n = 16;
    while (n < capacity * 2) n *= 2;
    this.keys = new Int32Array(n * 6);
    this.values = new Int32Array(n).fill(-1);
    this.mask = n - 1;
  }

  /** The index already stored for this key, or -1 after storing `index` for it. */
  find(a: number, b: number, c: number, d: number, e: number, f: number, index: number): number {
    if (a !== a || b !== b || c !== c || d !== d || e !== e || f !== f) {
      const k = `${a},${b},${c},${d},${e},${f}`;
      const prev = this.odd.get(k);
      if (prev !== undefined) return prev;
      this.odd.set(k, index);
      return -1;
    }
    let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791) ^ Math.imul(d, 2654435761) ^ Math.imul(e, 40503) ^ Math.imul(f, 2246822519);
    h = (h ^ (h >>> 15)) & this.mask;
    const keys = this.keys, values = this.values;
    for (;;) {
      const v = values[h];
      const o = h * 6;
      if (v < 0) {
        keys[o] = a; keys[o + 1] = b; keys[o + 2] = c; keys[o + 3] = d; keys[o + 4] = e; keys[o + 5] = f;
        values[h] = index;
        return -1;
      }
      if (keys[o] === a && keys[o + 1] === b && keys[o + 2] === c && keys[o + 3] === d && keys[o + 4] === e && keys[o + 5] === f) return v;
      h = (h + 1) & this.mask;
    }
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
    const rect = groundBakeRect(this.map);
    if (cached && cached.ground?.length === rect.resX * rect.resZ * 4 && meshes.every((m) => cached.meshes[m.name]?.length === m.geometry.getAttribute('position').count * 4)) {
      for (const m of meshes) m.geometry.setAttribute('bake', new THREE.BufferAttribute(cached.meshes[m.name], 4));
      onProgress(1, 'LIGHTING LOADED');
      return this.groundTexture(cached.ground);
    }
    // Every core bakes at once when workers can run; otherwise the page bakes it in slices.
    // Either way each point's light is worked out by the same code from the same inputs.
    const pool = WorkerRunner.open(this.map);
    let result: BakeResult | null = null;
    try {
      result = await this.bakeAll(pool.then((p) => p ?? new InlineRunner(this.field, this.map)), meshes, onProgress);
    } catch (err) {
      console.warn('[bake] a worker failed, baking on the page instead:', err);
    } finally {
      void pool.then((p) => p?.close());
    }
    result ??= await this.bakeAll(Promise.resolve(new InlineRunner(this.field, this.map)), meshes, onProgress);
    for (const m of meshes) m.geometry.setAttribute('bake', new THREE.BufferAttribute(result.meshes[m.name], 4));
    onProgress(1, 'LIGHTING READY');
    void cachePut(key, result);
    return this.groundTexture(result.ground);
  }

  /** The ground bakes (on the runner) while the page gathers the meshes' points, then the points bake. */
  private async bakeAll(runner: Promise<BakeRunner>, meshes: THREE.Mesh[], onProgress: BakeProgress): Promise<BakeResult> {
    const ground = runner.then((r) => this.bakeGround(r, onProgress));
    // Awaited below; a failure meanwhile must not count as unhandled.
    ground.catch(() => undefined);
    const points = await this.collectPoints(meshes, new Slicer());
    const r = await runner;
    return { ground: await ground, meshes: await this.bakeMeshes(r, meshes, points, onProgress) };
  }

  /** Ground lightmap: sky visibility on a 1 m grid first (the light rows upsample it), then the light. */
  private async bakeGround(runner: BakeRunner, onProgress: BakeProgress): Promise<Uint16Array> {
    const { resX, resZ } = groundBakeRect(this.map);
    const aoX = resX / 2, aoZ = resZ / 2;
    const rows = (n: number, kind: 'ao' | 'ground'): { kind: 'ao' | 'ground'; j0: number; j1: number }[] => {
      const out: { kind: 'ao' | 'ground'; j0: number; j1: number }[] = [];
      for (let j = 0; j < n; j += runner.rowsPerTask) out.push({ kind, j0: j, j1: Math.min(n, j + runner.rowsPerTask) });
      return out;
    };
    const ao = new Float32Array(aoX * aoZ);
    const aoTasks = rows(aoZ, 'ao');
    let done = 0;
    await runner.run(aoTasks, (i, r) => {
      ao.set(r, aoTasks[i].j0 * aoX);
      onProgress((++done / aoTasks.length) * 0.6 * 0.45, 'BAKING GROUND LIGHT');
    });
    runner.skyGrid(ao);
    const ground = new Uint16Array(resX * resZ * 4);
    const groundTasks = rows(resZ, 'ground');
    done = 0;
    await runner.run(groundTasks, (i, r) => {
      ground.set(r, groundTasks[i].j0 * resX * 4);
      onProgress((0.6 + (++done / groundTasks.length) * 0.4) * 0.45, 'BAKING GROUND LIGHT');
    });
    return ground;
  }

  /** Each unique surface point's light, then every vertex reads its point's. */
  private async bakeMeshes(runner: BakeRunner, meshes: THREE.Mesh[], points: BakePoints, onProgress: BakeProgress): Promise<Record<string, Float32Array>> {
    const per = runner.pointsPerTask;
    const pointTasks: BakeTask[] = [];
    for (let p = 0; p < points.count; p += per) {
      const q = Math.min(points.count, p + per);
      pointTasks.push({ kind: 'points', pts: points.pts.slice(p * 6, q * 6), foliage: points.foliage.slice(p, q) });
    }
    const light = new Float32Array(points.count * 4);
    let done = 0;
    await runner.run(pointTasks, (i, r) => {
      light.set(r, i * per * 4);
      onProgress(0.45 + (++done / Math.max(1, pointTasks.length)) * 0.55, 'BAKING LIGHT');
    });
    const out: Record<string, Float32Array> = {};
    meshes.forEach((m, k) => {
      const src = points.perMesh[k];
      const bake = new Float32Array(src.length * 4);
      for (let i = 0; i < src.length; i++) {
        const o = i * 4, u = src[i];
        if (u < 0) { bake[o + 3] = 1; continue; }
        bake[o] = light[u * 4]; bake[o + 1] = light[u * 4 + 1]; bake[o + 2] = light[u * 4 + 2]; bake[o + 3] = light[u * 4 + 3];
      }
      out[m.name] = bake;
    });
    return out;
  }

  /** Where the ground lightmap lies, for the shader: (x0, z0, 1 / width, 1 / depth). */
  groundRect(): THREE.Vector4 {
    const r = groundBakeRect(this.map);
    return new THREE.Vector4(r.x0, r.z0, 1 / r.w, 1 / r.d);
  }

  private groundTexture(data: Uint16Array): THREE.DataTexture {
    const r = groundBakeRect(this.map);
    const t = new THREE.DataTexture(data, r.resX, r.resZ, THREE.RGBAFormat, THREE.HalfFloatType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /**
   * World-space vertices of every static mesh, deduplicated within each mesh by position and
   * normal (rounded to 5 mm and 0.05), the first vertex of each pair standing for the rest.
   */
  private async collectPoints(meshes: THREE.Mesh[], slicer: Slicer): Promise<BakePoints> {
    const total = meshes.reduce((a, m) => a + m.geometry.getAttribute('position').count, 0);
    const pts = new Float64Array(total * 6);
    const foliageOf = new Uint8Array(total);
    let count = 0;
    const perMesh: Int32Array[] = [];
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const mesh of meshes) {
      const g = mesh.geometry;
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const nor = g.getAttribute('normal') as THREE.BufferAttribute;
      const src = new Int32Array(pos.count).fill(-1);
      const mat = mesh.material as THREE.Material;
      const skip = mat.userData.noBake === true;
      // Foliage sits inside its own crown proxy: fixed openness, lights traced past crowns.
      const foliage = mat.userData.foliage === true ? 1 : 0;
      const seen = new PointTable(pos.count);
      mesh.updateMatrixWorld();
      const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        if ((i & 1023) === 0) await slicer.tick();
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        if (skip || (n.y > 0.9 && v.y < GROUND_BAND.max && v.y > GROUND_BAND.min)) continue;
        const prev = seen.find(Math.round(v.x * 200), Math.round(v.y * 200), Math.round(v.z * 200), Math.round(n.x * 20), Math.round(n.y * 20), Math.round(n.z * 20), count);
        if (prev >= 0) {
          src[i] = prev;
          continue;
        }
        src[i] = count;
        const o = count * 6;
        pts[o] = v.x; pts[o + 1] = v.y; pts[o + 2] = v.z; pts[o + 3] = n.x; pts[o + 4] = n.y; pts[o + 5] = n.z;
        foliageOf[count++] = foliage;
      }
      perMesh.push(src);
    }
    return { pts: pts.subarray(0, count * 6), foliage: foliageOf.subarray(0, count), count, perMesh };
  }
}
