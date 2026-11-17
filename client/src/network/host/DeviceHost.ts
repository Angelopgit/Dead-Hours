import type { HostDown, HostUp } from '@dead-hours/shared';
import { isPhone } from '../../core/Settings';
import type { HostReply, HostRequest } from './HostWorker';

/**
 * This browser hosting a game's nights itself: starts the worker that runs them (HostWorker) and
 * passes messages between it and the room. NetLink owns one while this player is the host of a
 * player-hosted game, from the lobby on, so the worker is ready well before START.
 */
export class DeviceHost {
  /** Timer ticks a second in the worker and the longest wait between two (ms), as of its last report. */
  rate = 0;
  gap = 0;
  /** The worker's world is built: nights can start (a second or two after it is made). */
  ready = false;
  /**
   * The worker's clock over the seconds this tab was hidden, since it started: the slowest
   * second's ticks, the longest wait (ms) and how many seconds were counted. Null until the tab
   * has been hidden. A browser that holds the timer back while hidden shows here.
   */
  hidden: { rate: number; gap: number; seconds: number } | null = null;
  private wasHidden = false;
  private readonly sawHidden = () => {
    if (document.hidden) this.wasHidden = true;
  };
  /** Set when the worker could not start: nights can't run here. */
  failed: string | null = null;
  /** Called with each report of the worker's clock (the host test page). */
  onTicks: ((rate: number, gap: number, playing: boolean) => void) | null = null;
  private readonly worker: Worker;

  /**
   * Whether this browser can host: it needs workers, a build with files of its own (the
   * single-page build has nowhere to keep the worker's), and something sturdier than a phone,
   * which gets hot, drops into the background and uploads over mobile data.
   */
  static get available(): boolean {
    return typeof Worker !== 'undefined' && import.meta.env.MODE !== 'single' && !isPhone();
  }

  constructor(private readonly onUp: (msg: HostUp) => void) {
    this.worker = new Worker(new URL('./HostWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<HostReply>) => {
      const m = e.data;
      if (m.k === 'up') this.onUp(m.msg);
      else if (m.k === 'ticks') {
        this.rate = m.rate;
        this.gap = m.gap;
        // (The first report after coming back still covers the time away.)
        if (document.hidden || this.wasHidden) {
          const h = this.hidden;
          this.hidden = { rate: Math.min(h?.rate ?? m.rate, m.rate), gap: Math.max(h?.gap ?? 0, m.gap), seconds: (h?.seconds ?? 0) + 1 };
          this.wasHidden = document.hidden;
        }
        this.onTicks?.(m.rate, m.gap, m.playing);
      } else if (m.k === 'ready') this.ready = true;
      else if (m.k === 'failed') this.fail(m.message);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.fail(e.message || 'the host worker failed to load');
    };
    this.sawHidden();
    document.addEventListener('visibilitychange', this.sawHidden);
    this.post({ k: 'init' });
  }

  /** The worker's clock in a line of plain words (the lobby and the host test page show it). */
  get clock(): string {
    if (this.failed) return 'The night could not start on this device.';
    if (!this.ready) return 'Getting this device ready to run the night.';
    const now = `This device's night clock: ${this.rate} steps a second.`;
    const h = this.hidden;
    return h ? `${now} While this tab was hidden (${h.seconds} s): ${h.rate} a second at its slowest, longest wait ${h.gap} ms.` : now;
  }

  private fail(message: string): void {
    this.failed = message;
    console.warn('[dead-hours] this browser cannot host a night:', message);
  }

  private post(msg: HostRequest): void {
    this.worker.postMessage(msg);
  }

  /** A message for the night: from the room, or the host's own moves and actions. */
  down(msg: HostDown): void {
    this.post({ k: 'down', msg });
  }

  /** Holds the night still while the host has no connection to the room. */
  pause(on: boolean): void {
    this.post({ k: 'pause', on });
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.sawHidden);
    this.onTicks = null;
    this.worker.terminate();
  }
}
