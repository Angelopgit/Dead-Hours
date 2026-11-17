import { GAME, Night as HostedNight } from '@dead-hours/shared';
import { createWorld } from './world';

export type { StepResult, Survivor } from '@dead-hours/shared';

/** A night in a room on this server: the shared night over a collision world of its own. */
export class Night extends HostedNight {
  constructor(seed: number, preparation: number = GAME.preparationSeconds) {
    super(createWorld(), seed, preparation);
  }
}
