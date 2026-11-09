import type { PropSpec } from '@dead-hours/shared';
import type { BatchPiece } from '../rendering/StaticBatcher';

/**
 * Parts of the static world that a night can change: what each structure and each prop with fuel
 * in it is drawn from (by owner: a building's id, `prop:<index>` for a car, a pump or a drum),
 * `part:<index>` for a bay of wall or a pillar), the props that have burnt out (their strobes and
 * flashers stay dark) and the structures that have fallen (the water tower's beacon goes with it).
 * Filled in when the world is built; the night's views (Wrecks, StructureView) take pieces out and
 * put them back.
 */
export const worldPieces = {
  groups: new Map<string, BatchPiece[]>(),
  burnt: new Set<PropSpec>(),
  fallen: new Set<string>(),
};
