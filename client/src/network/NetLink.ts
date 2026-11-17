import type { Room } from 'colyseus.js';
import {
  C2S, HOST_IN, S2C, type ActMsg, type BeginMsg, type ChatLine, type DebugMsg, type HostDown, type HostUp, type IceConfig, type LobbyMsg, type OverMsg,
  type RtcIn, type SeenMsg, type SimEvent, type Snapshot, type TalkMsg, type Vec3,
} from '@dead-hours/shared';
import { net } from './Net';
import { Chat } from './Chat';
import { Voice } from './Voice';
import { comms } from './Comms';
import { DeviceHost } from './host/DeviceHost';
import { saneEvents, saneSnapshot } from './host/sane';

/** What arrived for the game in progress, in order. */
export type Inbound =
  | { k: 'snap'; snap: Snapshot; at: number }
  | { k: 'ev'; events: SimEvent[] }
  | { k: 'pos'; pos: Vec3 }
  /** The server refused where this client drove its car: [vehicle, x, y, z (cm), yaw (mrad)]. */
  | { k: 'vpos'; v: number[] };

export interface LinkHandlers {
  lobby?: (m: LobbyMsg) => void;
  begin?: (m: BeginMsg) => void;
  over?: (m: OverMsg) => void;
  notice?: (text: string) => void;
  /** The connection dropped mid-night and is being restored (true), or it came back (false). */
  reconnecting?: (on: boolean) => void;
  /** A player-hosted night stopped arriving: the host's browser is away or their connection is (true), or it is back (false). */
  hostAway?: (on: boolean) => void;
  /** The connection closed (left, kicked, or the server went away). */
  closed?: (code: number) => void;
}

/** Close code of a leave the client asked for (colyseus CloseCode.CONSENTED). */
const CONSENTED = 4000;
/** How long to keep trying after a drop (the server holds the place for 45 s). */
const RECONNECT_FOR = 40;
const MAX_QUEUED_SNAPS = 40;
/** A player-hosted night with no snapshot for this long (they come 20 times a second) has lost its host for now (s). */
const HOST_AWAY_AFTER = 2;
/** How often this browser tells the room how a player-hosted night stands as it sees it (s). */
const SEEN_EVERY = 5;
/** The host's own round trip to the night in its browser (s): a hop between two threads. */
const LOCAL_RTT = 0.02;

const now = () => performance.now() / 1000;
const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/**
 * A joined room: lobby updates and the start of each night go to handlers, the night's
 * snapshots, events and corrections queue up for the session to take each frame (in the order
 * they arrived), and a ping every two seconds keeps the round trip measured. A connection that
 * drops mid-night is restored with the room's reconnection token while the server holds the place.
 * The room's text chat and voice live here too, from the lobby through every night until leaving.
 *
 * In a player-hosted game the night runs in the host's browser instead of on the server, and the
 * room only passes its messages on. For the others nothing changes here. The host's own link
 * also keeps the night itself (DeviceHost): what it sends for this player is taken straight
 * into the queue, the rest goes out through the room, and this player's own moves and actions
 * go straight to it.
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
  /** The night, while this player hosts a player-hosted game on this device. */
  private device: DeviceHost | null = null;
  /** A player-hosted night as a guest: when the last snapshot came, whether the host counts as away, and the last report sent. */
  private lastSnap = 0;
  private away = false;
  private seenAt = 0;
  private readonly watch: ReturnType<typeof setInterval>;
  handlers: LinkHandlers = {};
  room: Room;
  readonly chat: Chat;
  readonly voice: Voice;
  private readonly unblock: () => void;

  constructor(room: Room) {
    this.room = room;
    this.chat = new Chat((type, msg) => this.send(type, msg));
    this.voice = new Voice(() => this.id, (type, msg) => this.send(type, msg));
    this.bind(room);
    // The server keeps blocked players apart (chat, voice and its negotiation).
    const blocks = () => this.send(C2S.blocks, comms.blockList.map(([pid]) => pid));
    blocks();
    this.unblock = comms.subscribe(blocks);
    this.pinger = setInterval(() => this.send(C2S.ping, now()), 2000);
    this.send(C2S.ping, now());
    this.watch = setInterval(() => this.watchHost(), 500);
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this.warnLeaving);
  }

  /** Closing the tab while it runs a night for others: the browser asks first. */
  private readonly warnLeaving = (e: BeforeUnloadEvent) => {
    if (!this.carriesOthers) return;
    e.preventDefault();
    e.returnValue = '';
  };

  /** Where the night runs: on the game server, or in the host player's browser. */
  get hosted(): boolean {
    return this.lobby?.hosting === 'player';
  }

  /** This player's browser is running the night for the room. */
  get hostingHere(): boolean {
    return !!this.device && !this.device.failed;
  }

  /** The night's worker clock, while hosting here (the host test page reads it). */
  get hostDevice(): DeviceHost | null {
    return this.device;
  }

  /** Others are in a night that this browser is running: leaving ends it for them. */
  get carriesOthers(): boolean {
    return !!this.device && this.lobby?.status === 'playing' && (this.lobby?.players.length ?? 0) > 1;
  }

  /** Starts (or lets go of) the night's worker as this player becomes (or stops being) the host of a player-hosted game. */
  private syncDevice(): void {
    const want = !this.left && this.hosted && this.lobby?.host === this.id && DeviceHost.available;
    if (want && !this.device) this.device = new DeviceHost((up) => this.fromNight(up));
    else if (!want && this.device) {
      this.device.dispose();
      this.device = null;
    }
  }

  /** What the night in this browser sends: this player's share is taken here, the rest goes to the room. */
  private fromNight(up: HostUp): void {
    if (up.k !== 'out') {
      this.send(C2S.host, up);
      return;
    }
    const mine = up.to.includes(this.id);
    const rest = mine ? up.to.filter((id) => id !== this.id) : up.to;
    if (rest.length) this.send(C2S.host, { ...up, to: rest } satisfies HostUp);
    if (mine) this.take(up.t, up.m);
  }

  /** From the room to the night in this browser. */
  private toNight(m: HostDown): void {
    if (!this.device) return;
    // A guest's timing ping is answered here: its round trip is then the one the night's messages make.
    if (m.k === 'in' && m.t === C2S.ping) this.send(C2S.host, { k: 'out', to: [m.from], t: S2C.pong, m: m.m } satisfies HostUp);
    else this.device.down(m);
  }

  /** A guest in a player-hosted night: notices the host going quiet, and tells the room what this browser sees. */
  private watchHost(): void {
    if (!this.playing || !this.loaded || !this.hosted || this.device || this.reconnecting) {
      if (this.away) this.setAway(false);
      return;
    }
    if (!this.away && this.lastSnap && now() - this.lastSnap > HOST_AWAY_AFTER) this.setAway(true);
  }

  private setAway(on: boolean): void {
    this.away = on;
    this.handlers.hostAway?.(on);
  }

  /**
   * One of the night's messages, from the room or from the night in this browser. From another
   * player's browser they are checked for shape first: a host is a player, not the game server.
   */
  private take(type: string, m: unknown): void {
    const guest = this.hosted && !this.device;
    switch (type) {
      case S2C.begin: {
        const b = m as BeginMsg;
        this.queue.length = 0;
        this.snaps = 0;
        this.playing = true;
        this.loaded = false;
        this.lastSnap = 0;
        this.seenAt = now();
        this.handlers.begin?.(b);
        break;
      }
      case S2C.snap: {
        if (!this.playing || (guest && !saneSnapshot(m))) return;
        const snap = m as Snapshot;
        this.queue.push({ k: 'snap', snap, at: now() });
        // A hidden tab draws no frames and takes nothing: keep every event, but only the last
        // couple of seconds of snapshots (each one holds the whole state).
        if (++this.snaps > MAX_QUEUED_SNAPS) {
          this.queue.splice(this.queue.findIndex((q) => q.k === 'snap'), 1);
          this.snaps--;
        }
        this.lastSnap = now();
        if (this.away) this.setAway(false);
        if (guest && this.lastSnap - this.seenAt > SEEN_EVERY) {
          this.seenAt = this.lastSnap;
          this.send(C2S.seen, { survived: snap.ph === 1 ? snap.pt / 1000 : 0, kills: snap.p.flatMap((p) => [p.id, p.s.kills]) } satisfies SeenMsg);
        }
        break;
      }
      case S2C.ev:
        if (this.playing && (!guest || saneEvents(m))) this.queue.push({ k: 'ev', events: m as SimEvent[] });
        break;
      case S2C.vpos: {
        const v = m as number[];
        if (this.playing && Array.isArray(v) && v.length === 5 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) this.queue.push({ k: 'vpos', v });
        break;
      }
      case S2C.pos: {
        const pos = m as Vec3 | null;
        if (this.playing && pos && [pos.x, pos.y, pos.z].every((n) => typeof n === 'number' && Number.isFinite(n))) this.queue.push({ k: 'pos', pos: { x: pos.x, y: pos.y, z: pos.z } });
        break;
      }
      case S2C.pong: {
        const r = now() - (m as number);
        if (r >= 0 && r < 5) this.rtt += (r - this.rtt) * 0.3;
        break;
      }
      default:
        break;
    }
  }

  private bind(room: Room): void {
    this.room = room;
    room.onMessage(S2C.lobby, (m: LobbyMsg) => {
      this.lobby = m;
      this.syncDevice();
      this.voice.setMembers(m.players);
      this.handlers.lobby?.(m);
    });
    room.onMessage(S2C.host, (m: HostDown) => this.toNight(m));
    room.onMessage(S2C.chat, (m: ChatLine) => this.chat.receive(m));
    room.onMessage(S2C.talk, (m: TalkMsg) => this.voice.remoteTalk(m));
    room.onMessage(S2C.rtc, (m: RtcIn) => this.voice.signal(m));
    room.onMessage(S2C.ice, (m: IceConfig) => this.voice.setIce(m));
    for (const type of [S2C.begin, S2C.snap, S2C.ev, S2C.vpos, S2C.pos, S2C.pong]) room.onMessage(type, (m: unknown) => this.take(type, m));
    room.onMessage(S2C.over, (m: OverMsg) => this.handlers.over?.(m));
    room.onMessage(S2C.notice, (t: string) => this.handlers.notice?.(t));
    room.onLeave((code) => void this.dropped(room, code));
  }

  /** The socket closed: mid-night and not on purpose, try to get back in; otherwise it's over. */
  private async dropped(room: Room, code: number): Promise<void> {
    if (room !== this.room) return;
    if (!this.left && this.playing && code !== CONSENTED) {
      this.reconnecting = true;
      // Nobody can reach the night in this browser meanwhile: it waits.
      this.device?.pause(true);
      this.handlers.reconnecting?.(true);
      const until = now() + RECONNECT_FOR;
      while (!this.left && now() < until) {
        try {
          const back = await (await net.client()).reconnect(room.reconnectionToken);
          if (this.left) {
            void back.leave(true).catch(() => undefined);
            return;
          }
          this.bind(back);
          this.reconnecting = false;
          this.device?.pause(false);
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
    this.closeComms();
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
    // Hosting here: this player's own part of the night goes straight to it (connection to the room or not).
    if (this.device && !this.left && HOST_IN.includes(type)) {
      if (type === C2S.ping) this.rtt = LOCAL_RTT;
      else this.device.down({ k: 'in', from: this.id, t: type, m: msg });
      return;
    }
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
    this.closeComms();
    this.left = true;
    clearInterval(this.pinger);
    void this.room.leave(true).catch(() => undefined);
  }

  private closeComms(): void {
    clearInterval(this.watch);
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this.warnLeaving);
    this.device?.dispose();
    this.device = null;
    this.unblock();
    this.voice.dispose();
  }
}
