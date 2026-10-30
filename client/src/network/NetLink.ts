import type { Room } from 'colyseus.js';
import {
  C2S, S2C, type ActMsg, type BeginMsg, type DebugMsg, type LobbyMsg, type OverMsg, type SimEvent, type Snapshot, type Vec3,
} from '@dead-hours/shared';
import { net } from './Net';

/** What arrived for the game in progress, in order. */
export type Inbound =
  | { k: 'snap'; snap: Snapshot; at: number }
  | { k: 'ev'; events: SimEvent[] }
  | { k: 'pos'; pos: Vec3 };

export interface LinkHandlers {
  lobby?: (m: LobbyMsg) => void;
  begin?: (m: BeginMsg) => void;
  over?: (m: OverMsg) => void;
  notice?: (text: string) => void;
  /** The connection dropped mid-night and is being restored (true), or it came back (false). */
  reconnecting?: (on: boolean) => void;
  /** The connection closed (left, kicked, or the server went away). */
  closed?: (code: number) => void;
}

/** Close code of a leave the client asked for (colyseus CloseCode.CONSENTED). */
const CONSENTED = 4000;
/** How long to keep trying after a drop (the server holds the place for 20 s). */
const RECONNECT_FOR = 16;
const MAX_QUEUED_SNAPS = 40;

const now = () => performance.now() / 1000;
const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/**
 * A joined room: lobby updates and the start of each night go to handlers, the night's
 * snapshots, events and corrections queue up for the session to take each frame (in the order
 * they arrived), and a ping every two seconds keeps the round trip measured. A connection that
 * drops mid-night is restored with the room's reconnection token while the server holds the place.
 */
export class NetLink {
  lobby: LobbyMsg | null = null;
  /** Round trip in seconds, smoothed. */
  rtt = 0.1;
  private readonly queue: Inbound[] = [];
  private playing = false;
  private readonly pinger: ReturnType<typeof setInterval>;
  private left = false;
  private loaded = false;
  /** Between a drop and getting back in: nothing is sent (the socket is closed). */
  private reconnecting = false;
  /** Snapshots waiting in the queue. */
  private snaps = 0;
  handlers: LinkHandlers = {};
  room: Room;

  constructor(room: Room) {
    this.room = room;
    this.bind(room);
    this.pinger = setInterval(() => this.send(C2S.ping, now()), 2000);
    this.send(C2S.ping, now());
  }

  private bind(room: Room): void {
    this.room = room;
    room.onMessage(S2C.lobby, (m: LobbyMsg) => {
      this.lobby = m;
      this.handlers.lobby?.(m);
    });
    room.onMessage(S2C.begin, (m: BeginMsg) => {
      this.queue.length = 0;
      this.snaps = 0;
      this.playing = true;
      this.loaded = false;
      this.handlers.begin?.(m);
    });
    room.onMessage(S2C.snap, (snap: Snapshot) => {
      if (!this.playing) return;
      this.queue.push({ k: 'snap', snap, at: now() });
      // A hidden tab draws no frames and takes nothing: keep every event, but only the last
      // couple of seconds of snapshots (each one holds the whole state).
      if (++this.snaps > MAX_QUEUED_SNAPS) {
        this.queue.splice(this.queue.findIndex((m) => m.k === 'snap'), 1);
        this.snaps--;
      }
    });
    room.onMessage(S2C.ev, (events: SimEvent[]) => {
      if (this.playing) this.queue.push({ k: 'ev', events });
    });
    room.onMessage(S2C.pos, (pos: Vec3) => {
      if (this.playing) this.queue.push({ k: 'pos', pos });
    });
    room.onMessage(S2C.over, (m: OverMsg) => this.handlers.over?.(m));
    room.onMessage(S2C.notice, (t: string) => this.handlers.notice?.(t));
    room.onMessage(S2C.pong, (sent: number) => {
      const r = now() - sent;
      if (r >= 0 && r < 5) this.rtt += (r - this.rtt) * 0.3;
    });
    room.onLeave((code) => void this.dropped(room, code));
  }

  /** The socket closed: mid-night and not on purpose, try to get back in; otherwise it's over. */
  private async dropped(room: Room, code: number): Promise<void> {
    if (room !== this.room) return;
    if (!this.left && this.playing && code !== CONSENTED) {
      this.reconnecting = true;
      this.handlers.reconnecting?.(true);
      const until = now() + RECONNECT_FOR;
      while (!this.left && now() < until) {
        try {
          const back = await net.client().reconnect(room.reconnectionToken);
          if (this.left) {
            void back.leave(true).catch(() => undefined);
            return;
          }
          this.bind(back);
          this.reconnecting = false;
          this.handlers.reconnecting?.(false);
          return;
        } catch {
          await wait(1.5);
        }
      }
    }
    this.reconnecting = false;
    this.left = true;
    clearInterval(this.pinger);
    this.handlers.closed?.(code);
  }

  get id(): string {
    return this.room.sessionId;
  }

  get isHost(): boolean {
    return this.lobby?.host === this.id;
  }

  get open(): boolean {
    return !this.left;
  }

  /** Everything queued since the last call, oldest first. */
  drain(): Inbound[] {
    this.snaps = 0;
    return this.queue.splice(0);
  }

  /** This client's scene for the night is up: the server starts streaming it. */
  markLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.send(C2S.loaded);
  }

  /** The night ended for this client (results, or leaving to the lobby). */
  stopPlaying(): void {
    this.playing = false;
    this.queue.length = 0;
    this.snaps = 0;
  }

  send(type: string, msg?: unknown): void {
    if (this.left || this.reconnecting) return;
    try {
      this.room.send(type, msg);
    } catch {
      // Closing: nothing more goes out.
    }
  }

  act(a: ActMsg): void {
    this.send(C2S.act, a);
  }

  motion(m: number[]): void {
    this.send(C2S.motion, m);
  }

  debug(m: DebugMsg): void {
    this.send(C2S.debug, m);
  }

  setReady(ready: boolean): void {
    this.send(C2S.ready, ready);
  }

  start(): void {
    this.send(C2S.start);
  }

  leave(): void {
    if (this.left) return;
    this.left = true;
    clearInterval(this.pinger);
    void this.room.leave(true).catch(() => undefined);
  }
}
