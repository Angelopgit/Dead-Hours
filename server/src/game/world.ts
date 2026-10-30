import { NEIGHBORHOOD, NavGrid, Physics, buildNavGridSync, createDoorBodies, initPhysics } from '@dead-hours/shared';

let navBuffers: ReturnType<NavGrid['buffers']> | null = null;

/**
 * Loads the physics engine and builds the zombie navigation grid once at startup (a few
 * seconds); every room then builds its own collision world and shares the grid's data.
 */
export async function initWorld(): Promise<{ nodes: number; ms: number }> {
  await initPhysics();
  const t0 = performance.now();
  const physics = new Physics(NEIGHBORHOOD);
  createDoorBodies(NEIGHBORHOOD, physics);
  const nav = buildNavGridSync(physics, NEIGHBORHOOD);
  navBuffers = nav.buffers();
  physics.dispose();
  return { nodes: nav.nodeCount, ms: performance.now() - t0 };
}

/** A room's own world: collision, door leaves and a navigation grid over the shared data. */
export function createWorld() {
  if (!navBuffers) throw new Error('initWorld() first');
  const physics = new Physics(NEIGHBORHOOD);
  const doors = createDoorBodies(NEIGHBORHOOD, physics);
  return { physics, doors, nav: new NavGrid(navBuffers) };
}
