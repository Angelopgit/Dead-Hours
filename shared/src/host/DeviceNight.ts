import { encodeBuild } from '../config/progression';
import type { HostDown, HostUp } from '../protocol/messages';
import type { NightWorld } from './Night';
import { NightHost } from './NightHost';

/**
 * A timer the browser is holding back (a hidden tab on some browsers, a machine going to sleep)
 * fires about once a second. The night waits for it to come back rather than crawl along at a
 * tenth of its speed; the others see the snapshots stop and are told the host is away.
 */
export const HOST_STALL_MS = 250;
/** How often the room is told how everyone stands, so a host who vanishes takes nobody's run with them. */
export const HOST_PROGRESS_MS = 3000;

/**
 * The night of a player-hosted game as the host's device runs it: takes what the room sends
 * down (start, a player dropping in or leaving, the players' moves) and hands back what goes up
 * (messages for the players, how everyone stands, the end). The worker in the host's browser
 * owns one and calls tick() from its timer.
 */
export class DeviceNight {
  private readonly host: NightHost;
  private sinceProgress = 0;

  constructor(world: () => NightWorld, private readonly up: (msg: HostUp) => void) {
    this.host = new NightHost(world, { send: (to, t, m) => up({ k: 'out', to: [...to], t, m }) });
    this.host.onRefit = (id, weapon, build) => up({ k: 'refit', id, weapon, build: encodeBuild(build) });
  }

  get playing(): boolean {
    return this.host.playing;
  }

  /** Holds the night still: the host lost its connection to the room, so nobody else can play on. */
  pause(on: boolean): void {
    this.host.pause(on);
  }

  down(msg: HostDown): void {
    const host = this.host;
    switch (msg.k) {
      case 'start':
        host.setDebug(msg.debug);
        host.start(msg.members, msg.seed);
        this.sinceProgress = 0;
        break;
      case 'join':
        host.dropIn(msg.member);
        break;
      case 'left':
        if (host.remove(msg.id) && host.playing) this.over();
        break;
      case 'in':
        host.message(msg.from, msg.t, msg.m);
        break;
      case 'stop':
        if (host.playing) host.finish();
        break;
    }
  }

  /** Call from a timer about 60 times a second, with the real time since the last call (ms). */
  tick(elapsed: number): void {
    const host = this.host;
    if (!host.playing || elapsed > HOST_STALL_MS) return;
    if (host.tick(elapsed)) {
      this.over();
      return;
    }
    this.sinceProgress += elapsed;
    if (this.sinceProgress >= HOST_PROGRESS_MS) {
      this.sinceProgress = 0;
      this.up({ k: 'progress', runs: host.progress(), survived: host.survived, hordes: host.hordes });
    }
  }

  private over(): void {
    this.up({ k: 'over', runs: this.host.finish(), hordes: this.host.hordes });
  }

  dispose(): void {
    this.host.dispose();
  }
}
