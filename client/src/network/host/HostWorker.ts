import {
  DeviceNight, NEIGHBORHOOD, NavGrid, Physics, buildNavGridSync, createDoorBodies, initPhysics, type HostDown, type HostUp,
} from '@dead-hours/shared';

/**
 * The night of a player-hosted game, in a worker of the host's browser: the same night the game
 * server's rooms run (DeviceNight over NightHost), with its own collision world and navigation
 * grid. It keeps its own clock here, off the page's, so a slow frame (or the page not drawing at
 * all) on the host's screen doesn't hold the night up for everyone else. DeviceHost on the page
 * passes messages between it and the room.
 */

export type HostRequest =
  | { k: 'init' }
  /** From the room (or, for the host's own moves, straight from the page). */
  | { k: 'down'; msg: HostDown }
  /** Hold the night still: the host lost its connection to the room, so nobody else can play on. */
  | { k: 'pause'; on: boolean };

export type HostReply =
  | { k: 'ready'; ms: number; nodes: number }
  | { k: 'failed'; message: string }
  | { k: 'up'; msg: HostUp }
  /** Once a second: timer ticks in that second, the longest wait between two (ms), and whether a night is running. */
  | { k: 'ticks'; rate: number; gap: number; playing: boolean };

/** The worker's global scope (the page's DOM types are in scope here, not the worker ones). */
const scope = self as unknown as { postMessage(msg: HostReply): void; onmessage: ((e: MessageEvent<HostRequest>) => void) | null };

const STEP_MS = 1000 / 60;

let nav: ReturnType<NavGrid['buffers']> | null = null;
const night = new DeviceNight(() => {
  if (!nav) throw new Error('the host worker is not ready');
  const physics = new Physics(NEIGHBORHOOD);
  return { physics, doors: createDoorBodies(NEIGHBORHOOD, physics), nav: new NavGrid(nav), map: NEIGHBORHOOD };
}, (msg) => scope.postMessage({ k: 'up', msg }));

/** The physics engine and the zombies' navigation grid, once (a second or two; the page isn't held up). */
async function init(): Promise<void> {
  const t0 = performance.now();
  await initPhysics();
  const physics = new Physics(NEIGHBORHOOD);
  createDoorBodies(NEIGHBORHOOD, physics);
  const grid = buildNavGridSync(physics, NEIGHBORHOOD);
  nav = grid.buffers();
  physics.dispose();
  scope.postMessage({ k: 'ready', ms: performance.now() - t0, nodes: grid.nodeCount });
}

let last = performance.now();
let ticks = 0, gap = 0, second = 0;

function tick(): void {
  const now = performance.now();
  const elapsed = now - last;
  last = now;
  ticks++;
  gap = Math.max(gap, elapsed);
  second += elapsed;
  if (second >= 1000) {
    scope.postMessage({ k: 'ticks', rate: Math.round((ticks * 1000) / second), gap: Math.round(gap), playing: night.playing });
    ticks = 0;
    gap = 0;
    second = 0;
  }
  night.tick(elapsed);
}

// Messages are handled in the order they came, and only once the world is ready.
let ready: Promise<void> | null = null;
scope.onmessage = (e: MessageEvent<HostRequest>) => {
  const req = e.data;
  if (req.k === 'init') {
    ready ??= init().then(() => {
      last = performance.now();
      setInterval(tick, STEP_MS);
    }).catch((err: unknown) => {
      scope.postMessage({ k: 'failed', message: err instanceof Error ? err.message : String(err) });
      throw err;
    });
    return;
  }
  void ready?.then(() => {
    if (req.k === 'down') night.down(req.msg);
    else if (req.k === 'pause') night.pause(req.on);
  }, () => undefined);
};
