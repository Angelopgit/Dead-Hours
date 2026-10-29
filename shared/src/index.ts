export * from './types';
export * from './config/player';
export * from './config/weapons';
export * from './config/game';
export * from './map/builder';
export * from './map/colliders';
export * from './map/maple-hollow';
export * from './protocol/messages';

import { MAPLE_HOLLOW } from './map/maple-hollow';
/** The map every session plays on. */
export const NEIGHBORHOOD = MAPLE_HOLLOW;
