import type { MapDefinition } from '@dead-hours/shared';
import { LightField } from './LightField';
import { bakePoints, groundAoRows, groundLightRows } from './BakeKernels';

/**
 * One of the light bake's workers (BakePool): builds its own copy of the map's light field, then
 * bakes the slices of ground and surface points it is handed.
 */

export type BakeJob =
  | { kind: 'ao'; id: number; j0: number; j1: number }
  | { kind: 'ground'; id: number; j0: number; j1: number }
  | { kind: 'points'; id: number; pts: Float64Array; foliage: Uint8Array };

export type BakeRequest = { kind: 'init'; map: MapDefinition } | { kind: 'skyGrid'; ao: Float32Array } | BakeJob;

export type BakeReply =
  | { kind: 'ready' }
  | { kind: 'done'; id: number; result: Float32Array | Uint16Array }
  | { kind: 'failed'; message: string };

/** The worker's global scope (the page's DOM types are in scope here, not the worker ones). */
const scope = self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void; onmessage: ((e: MessageEvent<BakeRequest>) => void) | null };
let map: MapDefinition | null = null;
let field: LightField | null = null;
let skyGrid: Float32Array | null = null;

const reply = (msg: BakeReply, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

scope.onmessage = (e: MessageEvent<BakeRequest>) => {
  const m = e.data;
  try {
    if (m.kind === 'init') {
      map = m.map;
      field = new LightField(map);
      reply({ kind: 'ready' });
      return;
    }
    if (m.kind === 'skyGrid') {
      skyGrid = m.ao;
      return;
    }
    if (!field || !map) throw new Error('bake worker used before init');
    let result: Float32Array | Uint16Array;
    if (m.kind === 'ao') {
      result = groundAoRows(field, map, m.j0, m.j1);
    } else if (m.kind === 'ground') {
      if (!skyGrid) throw new Error('ground rows asked for before the sky grid');
      result = groundLightRows(field, map, skyGrid, m.j0, m.j1);
    } else {
      result = new Float32Array(m.foliage.length * 4);
      bakePoints(field, m.pts, m.foliage, result);
    }
    reply({ kind: 'done', id: m.id, result }, [result.buffer]);
  } catch (err) {
    reply({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
};
