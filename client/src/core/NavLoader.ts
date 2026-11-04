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

/** Hands the page back for a moment; resolves with how long the next stretch of work may run (ms). */
function pause(urgent: boolean): Promise<number> {
  if (urgent) return new Promise((r) => setTimeout(() => r(30), 0));
  // Idle moments only: what the frame leaves before the next one is due.
  if (typeof requestIdleCallback === 'function') return new Promise((r) => requestIdleCallback((d) => r(Math.max(1, d.timeRemaining() - 2))));
  return new Promise((r) => setTimeout(() => r(4), 32));
}

/**
 * The zombie navigation grid: loaded from IndexedDB when the map hasn't changed, otherwise
 * built from the collision world in slices. While `urgent()` is false (the menu is showing) it
 * works only in the page's idle moments, so the menu keeps its frame rate; once a night waits on
 * it, it takes longer slices that leave just enough room for a loading screen to animate.
 */
export async function loadNavGrid(physics: Physics, map: MapDefinition, onProgress: (f: number) => void, urgent: () => boolean = () => true): Promise<NavGrid> {
  const { solids, props, doors, excavations, playerSpawns } = map;
  const key = `v${NAV_VERSION}:${fnv(JSON.stringify({ solids, props, doors, excavations, playerSpawns })).toString(16)}`;
  const cached = await get(key);
  if (cached && cached.nodeY?.length && cached.links?.length === cached.nodeY.length * 8) {
    onProgress(1);
    return new NavGrid(cached);
  }
  let budget = await pause(urgent());
  let last = performance.now();
  const it = buildNavGrid(physics, map);
  for (;;) {
    const r = it.next();
    if (r.done) {
      void put(key, r.value.buffers());
      onProgress(1);
      return r.value;
    }
    onProgress(r.value);
    if (performance.now() - last > budget) {
      budget = await pause(urgent());
      last = performance.now();
    }
  }
}
