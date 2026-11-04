import type { MapDefinition } from '@dead-hours/shared';
import type { LightField } from './LightField';
import { bakePoints, groundAoRows, groundLightRows } from './BakeKernels';
import type { BakeJob, BakeReply, BakeRequest } from './BakeWorker';

/** A slice of bake work: ground rows (sky visibility or light) or a run of surface points. */
export type BakeTask =
  | { kind: 'ao'; j0: number; j1: number }
  | { kind: 'ground'; j0: number; j1: number }
  | { kind: 'points'; pts: Float64Array; foliage: Uint8Array };

export type BakeResult = Float32Array | Uint16Array;

/** Runs bake tasks: on the page between frames, or spread over workers. */
export interface BakeRunner {
  /** How much one task should hold: ground rows and surface points. */
  readonly rowsPerTask: number;
  readonly pointsPerTask: number;
  /** Hands out the ground's whole sky-visibility grid, which the light rows read. */
  skyGrid(ao: Float32Array): void;
  /** Runs every task; `done` gets each result with its task's index, in any order. */
  run(tasks: BakeTask[], done: (index: number, result: BakeResult) => void): Promise<void>;
  close(): void;
}

/** Bakes on the page in short slices, so the loading screen keeps animating. */
export class InlineRunner implements BakeRunner {
  readonly rowsPerTask = 1;
  readonly pointsPerTask = 256;
  private ao: Float32Array | null = null;
  private last = performance.now();
  constructor(private readonly field: LightField, private readonly map: MapDefinition) {}

  skyGrid(ao: Float32Array): void {
    this.ao = ao;
  }

  async run(tasks: BakeTask[], done: (index: number, result: BakeResult) => void): Promise<void> {
    for (let i = 0; i < tasks.length; i++) {
      done(i, runTask(this.field, this.map, this.ao, tasks[i]));
      if (performance.now() - this.last >= 30) {
        await new Promise((r) => setTimeout(r, 0));
        this.last = performance.now();
      }
    }
  }

  close(): void {}
}

function runTask(field: LightField, map: MapDefinition, ao: Float32Array | null, t: BakeTask): BakeResult {
  if (t.kind === 'ao') return groundAoRows(field, map, t.j0, t.j1);
  if (t.kind === 'ground') {
    if (!ao) throw new Error('ground rows before the sky grid');
    return groundLightRows(field, map, ao, t.j0, t.j1);
  }
  const out = new Float32Array(t.foliage.length * 4);
  bakePoints(field, t.pts, t.foliage, out);
  return out;
}

/** Workers for a bake: as many as the device has cores, at most 8 (each holds its own light field). */
function workerCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(2, Math.min(8, cores));
}

/**
 * Bakes on every core: each worker builds the map's light field once, then takes tasks two at a
 * time (so it never waits on the page between tasks). Results are the same as baking on the page.
 */
export class WorkerRunner implements BakeRunner {
  readonly rowsPerTask = 4;
  readonly pointsPerTask = 2048;
  private failure: ((err: Error) => void) | null = null;

  private constructor(private readonly workers: Worker[]) {}

  /** Starts the workers; null when workers can't run here (no Worker, file missing, a crash). */
  static async open(map: MapDefinition, timeoutMs = 20000): Promise<WorkerRunner | null> {
    // The single-page build (`--mode single`) has nowhere to put the worker's file: bake on the page.
    if (typeof Worker === 'undefined' || import.meta.env.MODE === 'single') return null;
    const workers: Worker[] = [];
    try {
      for (let i = workerCount(); i > 0; i--) workers.push(new Worker(new URL('./BakeWorker.ts', import.meta.url), { type: 'module' }));
      await Promise.all(workers.map((w) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bake worker did not start')), timeoutMs);
        w.onmessage = (e: MessageEvent<BakeReply>) => {
          clearTimeout(timer);
          if (e.data.kind === 'ready') resolve();
          else reject(new Error(e.data.kind === 'failed' ? e.data.message : 'bake worker: unexpected reply'));
        };
        w.onerror = (e) => { clearTimeout(timer); e.preventDefault(); reject(new Error(e.message || 'bake worker failed to load')); };
        w.postMessage({ kind: 'init', map } satisfies BakeRequest);
      })));
      return new WorkerRunner(workers);
    } catch (err) {
      console.warn('[bake] workers unavailable, baking on the page:', err);
      for (const w of workers) w.terminate();
      return null;
    }
  }

  skyGrid(ao: Float32Array): void {
    for (const w of this.workers) w.postMessage({ kind: 'skyGrid', ao } satisfies BakeRequest);
  }

  run(tasks: BakeTask[], done: (index: number, result: BakeResult) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let next = 0, finished = 0;
      if (!tasks.length) { resolve(); return; }
      this.failure = reject;
      const give = (w: Worker) => {
        if (next >= tasks.length) return;
        const id = next++;
        const t = tasks[id];
        const job: BakeJob = t.kind === 'points' ? { kind: 'points', id, pts: t.pts, foliage: t.foliage } : { kind: t.kind, id, j0: t.j0, j1: t.j1 };
        w.postMessage(job satisfies BakeRequest, t.kind === 'points' ? [t.pts.buffer, t.foliage.buffer] : []);
      };
      for (const w of this.workers) {
        w.onmessage = (e: MessageEvent<BakeReply>) => {
          const m = e.data;
          if (m.kind === 'failed') { this.fail(new Error(m.message)); return; }
          if (m.kind !== 'done') return;
          done(m.id, m.result);
          if (++finished === tasks.length) { this.failure = null; resolve(); return; }
          give(w);
        };
        w.onerror = (e) => { e.preventDefault(); this.fail(new Error(e.message || 'bake worker crashed')); };
        give(w);
        give(w);
      }
    });
  }

  private fail(err: Error): void {
    const f = this.failure;
    this.failure = null;
    f?.(err);
  }

  close(): void {
    for (const w of this.workers) w.terminate();
  }
}
