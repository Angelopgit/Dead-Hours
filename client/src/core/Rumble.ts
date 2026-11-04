import { settings } from './Settings';

/** What a rumble is for: shots also kick the right trigger on pads that have trigger motors. */
export type RumbleKind = '' | 'shot' | 'hit' | 'blast';

type Actuator = {
  effects?: string[];
  playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
};

/**
 * Controller rumble with a little sense of priority: a burst of gunfire does not cut short the
 * shake of a blast that is still going, and everything is scaled by the vibration strength setting.
 * Pads with motors in the triggers (Xbox One and Series pads in Chrome and Edge on Windows) feel shots
 * in the right trigger too.
 */
export class Rumble {
  private until = 0;
  private level = 0;

  play(pad: Gamepad | null, strength: number, ms: number, kind: RumbleKind = '', now = performance.now()): boolean {
    const c = settings.value.controls;
    const k = Math.min(1, Math.max(0, strength)) * (c.vibration ? c.vibrationStrength : 0);
    if (!pad || k <= 0.01 || ms <= 0) return false;
    // A weaker one while a stronger is still playing would replace it (an effect stops the last): it is left out.
    if (now < this.until && k < this.level * 0.7) return false;
    const act = (pad as Gamepad & { vibrationActuator?: Actuator }).vibrationActuator;
    if (!act?.playEffect) return false;
    const triggers = kind === 'shot' && act.effects?.includes('trigger-rumble');
    const params: Record<string, number> = triggers
      ? { duration: Math.round(ms), strongMagnitude: k * 0.6, weakMagnitude: Math.min(1, k * 0.5 + 0.05), rightTrigger: Math.min(1, k * 1.2), leftTrigger: 0 }
      : { duration: Math.round(ms), strongMagnitude: kind === 'blast' ? k : k * 0.85, weakMagnitude: Math.min(1, k * 0.7 + 0.08) };
    this.until = now + ms;
    this.level = k;
    void act.playEffect(triggers ? 'trigger-rumble' : 'dual-rumble', params)?.catch?.(() => { /* not supported */ });
    return true;
  }

  /** Stops whatever is playing (the game was paused or the pad went away). */
  stop(pad: Gamepad | null): void {
    this.until = 0;
    this.level = 0;
    const act = (pad as (Gamepad & { vibrationActuator?: Actuator & { reset?: () => Promise<unknown> } }) | null)?.vibrationActuator;
    void act?.reset?.()?.catch?.(() => { /* not supported */ });
  }
}
