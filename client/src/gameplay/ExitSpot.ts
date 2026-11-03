import type { SimEvent, Vec3 } from '@dead-hours/shared';

type VehicleEvent = Extract<SimEvent, { type: 'vehicle' }>;

/**
 * Online: where the server let this survivor out of a vehicle, kept from the moment it is heard
 * until the session stands them there.
 *
 * Online the 'out' event arrives while this survivor is still shown in that car, and the seat sync
 * that follows it in the same frame uses the spot. In a solo night the simulation has already put
 * them by the door (and the session already took them out of the seat) when the event is heard, so
 * nothing is kept then: a spot kept after the fact would be used the next time they got out of any
 * car, standing them by the first car's door instead.
 */
export class ExitSpot {
  private at: Vec3 | null = null;

  /** A vehicle event. `shownIn`: the vehicle the session shows this survivor sitting in (null on foot). */
  heard(e: VehicleEvent, me: string, shownIn: number | null): void {
    if ((e.stage !== 'out' && e.stage !== 'thrown') || e.player !== me || !e.pos) return;
    if (shownIn !== e.vehicle) return;
    this.at = { ...e.pos };
  }

  /** Into a seat: nothing kept from getting out of an earlier one still applies. */
  sat(): void {
    this.at = null;
  }

  /** Out of the seat: where to stand them (the spot the server gave, else `fallback`, where the simulation has them). */
  take(fallback: Vec3): Vec3 {
    const at = this.at ?? fallback;
    this.at = null;
    return at;
  }
}
