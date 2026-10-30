import type { Store } from './store';

/** Things every room and route shares, set up once at startup. */
export const services: { store: Store | null; debug: boolean } = {
  store: null,
  /** Test commands in rooms (skip the preparation, place zombies). Never on a public server. */
  debug: process.env.DEAD_HOURS_DEBUG === '1',
};
