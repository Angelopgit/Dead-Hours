/**
 * Decides which display refreshes draw a frame under an FPS limit.
 *
 * Draws stay on the limit's own beat: the display's refresh is rarely a multiple of the limit, and
 * starting over from each drawn frame ran under it (60 on a 144 Hz screen drew every third refresh,
 * 48 a second; 60 on 165 Hz, 55). A display at about the limit or slower draws every refresh (its
 * clock drifting a hair fast must not drop a frame every few seconds). A long stall starts a fresh beat.
 */
export class FrameGate {
  private last = 0;
  private lastTick = 0;
  /** Display refresh interval (ms), smoothed from the animation frames. */
  refresh = 1000 / 60;

  /** Called on every animation frame with its timestamp (ms); true when this one should draw. */
  tick(now: number, limit: number): boolean {
    const raw = now - this.lastTick;
    this.lastTick = now;
    if (raw > 0 && raw < 50) this.refresh += (raw - this.refresh) * 0.05;
    const interval = limit > 0 ? 1000 / limit : 0;
    if (this.refresh >= interval * 0.95) {
      this.last = now;
      return true;
    }
    const since = now - this.last;
    if (since < interval - 1) return false;
    this.last = since < interval * 2 ? this.last + interval : now;
    return true;
  }
}
