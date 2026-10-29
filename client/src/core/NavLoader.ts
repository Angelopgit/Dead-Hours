import { buildNavGrid, NavGrid, type MapDefinition, type NavBuffers } from '@dead-hours/shared';
import type { Physics } from './Physics';

/** Bump when the grid builder changes so cached grids are rebuilt. */
export const NAV_VERSION = 1;

const DB_NAME = 'deadhours-nav';
const STORE = 'grids';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
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

async function get(key: string): Promise<NavBuffers | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as NavBuffers | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function put(key: string, value: NavBuffers): Promise<void> {
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

/**
 * The zombie navigation grid: loaded from IndexedDB when the map hasn't changed, otherwise
 * built from the collision world in slices so the loading screen keeps animating.
 */
export async function loadNavGrid(physics: Physics, map: MapDefinition, onProgress: (f: number) => void): Promise<NavGrid> {
  const { solids, props, doors, excavations, playerSpawns } = map;
  const key = `v${NAV_VERSION}:${fnv(JSON.stringify({ solids, props, doors, excavations, playerSpawns })).toString(16)}`;
  const cached = await get(key);
  if (cached && cached.nodeY?.length && cached.links?.length === cached.nodeY.length * 8) {
    onProgress(1);
    return new NavGrid(cached);
  }
  const it = buildNavGrid(physics, map);
  let last = performance.now();
  for (;;) {
    const r = it.next();
    if (r.done) {
      void put(key, r.value.buffers());
      onProgress(1);
      return r.value;
    }
    onProgress(r.value);
    if (performance.now() - last > 30) {
      await new Promise((res) => setTimeout(res, 0));
      last = performance.now();
    }
  }
}
