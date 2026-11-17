import { createHash } from 'node:crypto';
import { Room, ServerError, type Client } from 'colyseus';
import {
  BUILD_SLOTS, C2S, CHAT, GAME, HOST_IN, HOST_OUT, NightHost, ROOMS, S2C, VERSION_MISMATCH, censor, cleanChat, decodeBuild, sanitizeBuild,
  type ChatLine, type CreateOptions, type HostDown, type HostMember, type HostRun, type HostUp, type Hosting, type JoinOptions, type LobbyMsg,
  type Loadout, type OverMsg, type PlayerStats, type RoomStatus, type RtcIn, type RunResult, type TalkMsg, type UnlockState, type WeaponId,
  NO_UNLOCKS, PRIMARY_WEAPONS, SECONDARY_WEAPONS, levelFor,
} from '@dead-hours/shared';
import { createWorld } from '../game/world';
import { claimCode, releaseCode, renewCode } from '../net/codes';
import { resolveOwner, type Owner } from '../net/auth';
import { cleanAppearance, cleanBuilds, cleanName, cleanPrimary, cleanSecondary } from '../net/clean';
import { iceConfig } from '../net/ice';
import { Bucket } from '../net/limit';
import { NO_STATS, plausibleRun } from '../net/plausible';
import { MAX_ROOMS, gameClosed, gameOpened, localGames } from '../net/scale';
import { services } from '../services';
import { unlocksOf, type Ranks, type RunOutcome } from '../store';

interface Member {
  id: string;
  /** Lasting player id shared with the others (mute and block lists): from their profile, else per connection. */
  pid: string;
  name: string;
  primary: WeaponId;
  secondary: WeaponId;
  appearance: string;
  /** The profile their runs count for: the signed-in account's, else the browser key's (null: not recorded). */
  owner: string | null;
  signedIn: boolean;
  /** Weapon builds (checked against `unlocks`, kept up to date with refits made during a night). */
  builds: Loadout;
  /** What the player's saved profile has unlocked (none without a profile or a store). */
  unlocks: UnlockState;
  ready: boolean;
  /** This night's run once it ended for them (died or left), and its leaderboard places. */
  run: { survived: number; stats: PlayerStats; ranks: Promise<Ranks | RunOutcome> } | null;
  /** Player ids this player blocks: no chat, voice or negotiation passes between them either way. */
  blocks: Set<string>;
  limits: { chat: Bucket; talk: Bucket; rtc: Bucket; relay: Bucket };
  /** Their browser could run a night itself: the host's place in a player-hosted game can pass to them. */
  canHost: boolean;
  /** A player-hosted night: in the night under way since this moment (ms; 0: not in it). */
  inNight: number;
  /** A player-hosted night as this player's own browser last saw it (see SeenMsg), and when (ms). */
  seen: { survived: number; kills: Map<string, number>; at: number } | null;
  /** Last chat line and when (repeats are dropped), and when they were last told to slow down. */
  said: { text: string; at: number; warned: number };
}

/** Longest WebRTC description and candidate passed on (a voice-only SDP is 2 to 6 kB; messages are capped at 16 kB). */
const MAX_SDP = 12000;
const MAX_CANDIDATE = 1000;

/** A lasting id that others may see: derived from the player's profile key, which itself never leaves the server. */
function publicId(owner: string | null, session: string): string {
  return owner ? createHash('sha256').update(`dead-hours player id:${owner}`).digest('base64url').slice(0, 12) : `s-${session}`;
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
const nullableText = (v: unknown, max: number) => (v === null ? null : text(v, max));

/** A negotiation message from the client, rebuilt from known fields only (or null when malformed). */
function cleanSignal(msg: unknown): Omit<RtcIn, 'from'> & { to: string } | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const to = text(m.to, 64);
  if (!to) return null;
  const out: Omit<RtcIn, 'from'> & { to: string } = { to };
  if (m.description !== undefined) {
    const d = m.description as Record<string, unknown> | null;
    const type = d?.type;
    if (type !== 'offer' && type !== 'answer' && type !== 'rollback') return null;
    const sdp = d?.sdp === undefined ? undefined : text(d.sdp, MAX_SDP);
    if (type !== 'rollback' && sdp === undefined) return null;
    out.description = sdp === undefined ? { type } : { type, sdp };
  } else if (m.candidate !== undefined) {
    if (m.candidate === null) out.candidate = null;
    else {
      const c = m.candidate as Record<string, unknown>;
      const candidate = text(c.candidate, MAX_CANDIDATE);
      if (candidate === undefined) return null;
      const index = c.sdpMLineIndex;
      out.candidate = {
        candidate,
        sdpMid: nullableText(c.sdpMid, 64) ?? null,
        sdpMLineIndex: typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 16 ? index : null,
        usernameFragment: nullableText(c.usernameFragment, 256) ?? null,
      };
    }
  } else return null;
  return out;
}

const NO_RANK: Ranks = { rankSurvival: null, rankKills: null };

/**
 * How long a survivor whose connection dropped mid-night keeps their place (s). A slow machine
 * that hitches hard, or a phone switching networks, can take a while to come back; 20 s lost
 * players who would have made it.
 */
const HOLD_PLACE = 45;

/** How long a player host may go without a word before the room ends the night for everyone (s). */
const HOST_SILENCE = 45;
/** The most the host's count may run ahead of what a player's own browser last saw: kills at once, and kills a second since. */
const KILL_SLACK = 3;
const KILL_RATE = 1.5;

const wire = (m: Member): HostMember => ({ id: m.id, name: m.name, primary: m.primary, secondary: m.secondary, appearance: m.appearance, builds: m.builds, unlocks: m.unlocks });

/**
 * A game: whoever creates it hosts (starts the night; the next to have joined takes over when
 * they leave), friends join with its code or from the game list. The room carries the lobby,
 * the chat, the voice negotiation and the records.
 *
 * The night itself runs in one of two places. In a game made as ROOMS.survival it runs here on
 * the server (NightHost). In one made as ROOMS.hosted it runs in the host's own browser, with the
 * same NightHost in a worker there: the room starts it, passes the players' moves to the host
 * and the host's snapshots and events to the players, and checks the runs the host reports
 * before they reach the boards. Such a game takes none of the server's simulation time.
 */
export class SurvivalRoom extends Room {
  maxClients: number = GAME.maxPlayers;
  private readonly members = new Map<string, Member>();
  private host = '';
  private code = '';
  private title = '';
  private hidden = false;
  private status: RoomStatus = 'lobby';
  private hosting: Hosting = 'server';
  /** The night, when the server runs it. */
  private readonly nights = new NightHost(createWorld, {
    send: (to, type, msg) => {
      if (to.length === 1) {
        this.clients.find((c) => c.sessionId === to[0])?.send(type, msg);
        return;
      }
      const except = this.clients.filter((c) => !to.includes(c.sessionId));
      this.broadcast(type, msg, except.length ? { except } : undefined);
    },
  }, services.debug);
  private metaAt = 0;
  /** A player-hosted game: the host's version and build of the game (everyone must run the same one). */
  private version = '';
  /** A player-hosted night: when it began and when the host was last heard from (ms), and how it stood then. */
  private beganAt = 0;
  private hostHeard = 0;
  private readonly progress = new Map<string, HostRun>();
  private hostedSurvived = 0;
  private hostedHordes = 0;

  async onCreate(o: Partial<CreateOptions>): Promise<void> {
    this.hosting = this.roomName === ROOMS.hosted ? 'player' : 'server';
    // Only nights the server runs count against what this process can carry.
    if (this.hosting === 'server') gameOpened(this.roomId);
    else this.version = text(o.v, 40) ?? '';
    this.nights.onRefit = (id, weapon, build) => {
      const m = this.members.get(id);
      if (m) m.builds = { ...m.builds, [weapon]: build };
    };
    this.code = await claimCode(this.presence, this.roomId);
    this.clock.setInterval(() => void renewCode(this.presence, this.code).catch(() => undefined), 10 * 60 * 1000);
    this.title = cleanName(o.lobbyName, 32) || `${cleanName(o.name) || 'Survivor'}'s safehouse`;
    this.hidden = !!o.private;
    if (this.hidden) void this.setPrivate(true);
    this.updateMeta();

    this.onMessage(C2S.ready, (c, ready: unknown) => {
      const m = this.members.get(c.sessionId);
      if (!m || this.status !== 'lobby') return;
      m.ready = !!ready;
      this.sendLobby();
    });
    this.onMessage(C2S.start, (c) => this.start(c));
    // The night's own messages: to the night here, or on to the player who hosts it.
    for (const type of [C2S.loaded, C2S.motion, C2S.drive, C2S.act, C2S.debug]) {
      this.onMessage(type, (c, msg: unknown) => {
        if (this.status !== 'playing') return;
        if (this.hosting === 'player') this.toHost(c, type, msg);
        else this.nights.message(c.sessionId, type, msg);
      });
    }
    this.onMessage(C2S.ping, (c, n: unknown) => {
      if (typeof n !== 'number') return;
      // During a player-hosted night the host answers, so the round trip is the one the night's messages make.
      if (this.hosting === 'player' && this.status === 'playing' && c.sessionId !== this.host) this.toHost(c, C2S.ping, n);
      else c.send(S2C.pong, n);
    });
    this.onMessage(C2S.host, (c, msg: unknown) => this.fromHost(c, msg));
    this.onMessage(C2S.seen, (c, msg: unknown) => this.sees(c, msg));
    this.onMessage(C2S.chat, (c, msg: unknown) => this.chat(c, msg));
    this.onMessage(C2S.talk, (c, mode: unknown) => {
      const m = this.members.get(c.sessionId);
      if (!m || !m.limits.talk.take()) return;
      const talk: TalkMsg = { id: m.id, mode: mode === 'near' || mode === 'radio' ? mode : null };
      for (const other of this.clients) {
        const o = this.members.get(other.sessionId);
        if (o && o !== m && !this.apart(m, o)) other.send(S2C.talk, talk);
      }
    });
    this.onMessage(C2S.rtc, (c, msg: unknown) => {
      const m = this.members.get(c.sessionId);
      const signal = cleanSignal(msg);
      if (!m || !signal || !m.limits.rtc.take()) return;
      const { to, ...rest } = signal;
      const target = this.members.get(to);
      const client = this.clients.find((x) => x.sessionId === to);
      if (!target || target === m || !client || this.apart(m, target)) return;
      client.send(S2C.rtc, { from: m.id, ...rest } satisfies RtcIn);
    });
    this.onMessage(C2S.blocks, (c, list: unknown) => {
      const m = this.members.get(c.sessionId);
      if (!m || !Array.isArray(list)) return;
      m.blocks = new Set(list.slice(0, 500).filter((p): p is string => typeof p === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(p)));
    });
    this.setSimulationInterval((ms) => this.tick(ms), 1000 / 60);
    this.log(`opened "${this.title}"${this.hidden ? ' (private)' : ''}${this.hosting === 'player' ? ', hosted by its player' : ''}`);
  }

  /** One line per room event in the server log (who joined, nights started and ended). */
  private log(text: string): void {
    console.log(`[dead-hours] room ${this.code} ${text}`);
  }

  /** Who is joining: their sign-in session or browser key, looked up before they are let in. */
  async onAuth(_client: Client, o: Partial<JoinOptions>): Promise<Owner | true> {
    // The host's browser runs the rules of a player-hosted game: another build could disagree with it.
    if (this.hosting === 'player' && this.version && text(o.v, 40) !== this.version) throw new ServerError(VERSION_MISMATCH, 'VERSION MISMATCH');
    try {
      return (await resolveOwner(o.session, o.token)) ?? true;
    } catch (e) {
      // The profile store not answering must not keep anyone out: they play, unrecorded.
      console.warn('[dead-hours] could not look up a joining player, letting them in unrecorded:', e);
      return true;
    }
  }

  async onJoin(client: Client, o: Partial<JoinOptions>, auth?: Owner | true): Promise<void> {
    const who = auth && auth !== true ? auth : null;
    const pid = publicId(who?.owner ?? null, client.sessionId);
    // Unlocks come from the saved profile, never from the client.
    const store = services.store;
    const saved = who?.owner && store ? await store.getProfile(who.owner).catch(() => null) : null;
    const unlocks = saved ? unlocksOf(saved) : NO_UNLOCKS;
    this.members.set(client.sessionId, {
      id: client.sessionId,
      pid,
      name: cleanName(o.name) || 'Survivor',
      primary: cleanPrimary(o.primary),
      secondary: cleanSecondary(o.secondary),
      appearance: cleanAppearance(o.appearance),
      owner: who?.owner ?? null,
      signedIn: !!who?.account,
      builds: cleanBuilds(o.builds, unlocks),
      unlocks,
      ready: false,
      run: null,
      blocks: new Set(),
      // Passed on to a player host: moves and car moves 30 times a second each, and whatever else they do.
      limits: { chat: new Bucket(CHAT.burst, CHAT.refillSeconds), talk: new Bucket(20, 0.1), rtc: new Bucket(120, 0.05), relay: new Bucket(240, 1 / 120) },
      said: { text: '', at: 0, warned: 0 },
      canHost: o.canHost === true,
      inNight: 0,
      seen: null,
    });
    if (!this.host) this.host = client.sessionId;
    const name = this.members.get(client.sessionId)!.name;
    this.log(`${name} joined (${this.members.size}/${this.maxClients})`);
    client.send(S2C.ice, iceConfig(pid));
    // A night under way: straight into it beside the others (no waiting for the next one).
    const late = this.status === 'playing' ? this.dropIn(this.members.get(client.sessionId)!) : false;
    this.announce(late ? `${name} joined the night` : `${name} joined`, client.sessionId);
    this.sendLobby();
    this.updateMeta();
  }

  /** Puts a player who joined mid-night into it at the safehouse; they load the scene and the stream starts. */
  private dropIn(m: Member): boolean {
    m.run = null;
    m.ready = false;
    if (this.hosting === 'player') {
      const host = this.hostClient;
      if (!host) return false;
      m.inNight = Date.now();
      m.seen = null;
      host.send(S2C.host, { k: 'join', member: wire(m) } satisfies HostDown);
      this.log(`${m.name} dropped into the night at ${Math.floor(this.hostedSurvived)} s`);
      return true;
    }
    if (!this.nights.dropIn(wire(m))) return false;
    this.log(`${m.name} dropped into the night at ${Math.floor(this.nights.joinedAt(m.id))} s`);
    return true;
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const id = client.sessionId;
    if (!this.members.has(id)) return;
    // A dropped connection mid-night gets a short while to come back; the survivor stands still meanwhile.
    const m = this.members.get(id)!;
    const inPlay = this.hosting === 'player' ? m.inNight > 0 : !!this.nights.night?.sim.players.get(id)?.alive;
    if (!consented && this.status === 'playing' && inPlay) {
      this.log(`${this.members.get(id)!.name} lost connection, holding their place for ${HOLD_PLACE} s`);
      try {
        await this.allowReconnection(client, HOLD_PLACE);
        this.log(`${this.members.get(id)?.name ?? id} reconnected`);
        return;
      } catch {
        // Gone for good.
      }
    }
    this.drop(id);
  }

  onDispose(): void {
    this.log('closed');
    void releaseCode(this.presence, this.code).catch(() => undefined);
    gameClosed(this.roomId);
    this.nights.dispose();
  }

  /** The host's connection, while they are here. */
  private get hostClient(): Client | undefined {
    return this.clients.find((c) => c.sessionId === this.host);
  }

  private drop(id: string): void {
    const m = this.members.get(id);
    let over = false;
    if (this.status === 'playing' && this.hosting === 'player' && m?.inNight) {
      // As the host last counted it (a few seconds old at most).
      this.record(m, this.progress.get(id));
      if (id === this.host) {
        // The night lived in their browser: it is over for everyone, with what each had reached.
        over = true;
        this.announce('The host left: the night is over');
      } else {
        this.hostClient?.send(S2C.host, { k: 'left', id } satisfies HostDown);
        over = ![...this.members.values()].some((o) => o.id !== id && o.inNight);
      }
    } else if (this.status === 'playing' && this.hosting === 'server' && this.nights.night?.sim.players.has(id)) {
      if (m) this.record(m, this.nights.record(id));
      over = this.nights.remove(id);
    } else this.nights.remove(id);
    const name = m?.name ?? id;
    this.log(`${name} left`);
    // Before they are gone from the list: the night ending writes the runs of everyone still here.
    if (over) void this.end();
    this.members.delete(id);
    this.announce(`${name} left`);
    if (this.host === id) this.passHost();
    this.sendLobby();
    this.updateMeta();
  }

  /**
   * The host left: the next to have joined takes over. In a player-hosted game that is the next
   * whose browser can run a night; when nobody's can (phones), the server runs the nights from
   * here on if it has room for one more game.
   */
  private passHost(): void {
    const left = [...this.members.values()];
    this.host = left[0]?.id ?? '';
    if (this.hosting !== 'player' || !left.length) return;
    const able = left.find((m) => m.canHost);
    if (able) this.host = able.id;
    else if (this.status !== 'playing' && localGames() < MAX_ROOMS) {
      this.hosting = 'server';
      gameOpened(this.roomId);
      this.announce('Nobody here can host on their own device: the game server runs the nights now');
      this.log('nobody left can host: the server runs the nights');
    }
  }

  private start(client: Client): void {
    if (client.sessionId !== this.host) {
      client.send(S2C.notice, 'ONLY THE HOST CAN START THE NIGHT');
      return;
    }
    if (this.status !== 'lobby') return;
    if (this.hosting === 'player' && !this.members.get(this.host)?.canHost) {
      client.send(S2C.notice, 'THIS DEVICE CAN\'T RUN A NIGHT ITSELF. HOST A GAME ON THE SERVER INSTEAD');
      return;
    }
    const seed = (Math.random() * 2 ** 31) | 1;
    for (const m of this.members.values()) {
      m.run = null;
      m.ready = false;
      m.seen = null;
      m.inNight = this.hosting === 'player' ? Date.now() : 0;
    }
    this.status = 'playing';
    this.log(`night started with ${this.members.size}`);
    // The room stays open while the night plays: friends can drop in with the code or from the list
    // (Colyseus still closes it on its own while all four places are taken).
    const members = [...this.members.values()].map(wire);
    if (this.hosting === 'player') {
      // The host's browser runs it from here: it tells each player where they begin.
      this.beganAt = this.hostHeard = Date.now();
      this.progress.clear();
      this.hostedSurvived = this.hostedHordes = 0;
      client.send(S2C.host, { k: 'start', seed, members, debug: services.debug } satisfies HostDown);
    } else this.nights.start(members, seed);
    this.sendLobby();
    this.updateMeta();
  }

  private tick(ms: number): void {
    if (this.status !== 'playing') return;
    if (this.hosting === 'player') {
      // A host whose browser stopped answering (closed lid, frozen tab) can't keep everyone waiting.
      if (Date.now() - this.hostHeard > HOST_SILENCE * 1000) {
        this.announce('The host stopped answering: the night is over');
        void this.end();
      }
      return;
    }
    if (this.nights.tick(ms)) {
      void this.end();
      return;
    }
    if ((this.nights.night?.time ?? 0) - this.metaAt > 5) this.updateMeta();
  }

  // ------------------------------------------------------------------ a night in the host's browser

  /** One of a player's messages about the night, on to the player who hosts it. */
  private toHost(client: Client, type: string, msg: unknown): void {
    const m = this.members.get(client.sessionId);
    // (The host's own go straight to the night in their browser.)
    if (!m || !m.inNight || m.id === this.host || !HOST_IN.includes(type)) return;
    if (type === C2S.debug && !services.debug) return;
    if (!m.limits.relay.take()) return;
    this.hostClient?.send(S2C.host, { k: 'in', from: m.id, t: type, m: msg } satisfies HostDown);
  }

  /** What the host's night sends out and reports. Only the host is listened to, and only in a player-hosted game. */
  private fromHost(client: Client, raw: unknown): void {
    if (this.hosting !== 'player' || client.sessionId !== this.host || !raw || typeof raw !== 'object') return;
    const msg = raw as HostUp;
    this.hostHeard = Date.now();
    if (msg.k === 'out') {
      if (this.status !== 'playing' || !Array.isArray(msg.to) || !HOST_OUT.includes(msg.t)) return;
      const to = this.clients.filter((c) => c.sessionId !== this.host && msg.to.includes(c.sessionId) && this.members.get(c.sessionId)?.inNight);
      if (to.length === 1) to[0].send(msg.t, msg.m);
      else if (to.length) this.broadcast(msg.t, msg.m, { except: this.clients.filter((c) => !to.includes(c)) });
    } else if (msg.k === 'progress' || msg.k === 'over') {
      if (this.status !== 'playing' || !Array.isArray(msg.runs)) return;
      for (const r of msg.runs.slice(0, GAME.maxPlayers * 2)) {
        if (r && typeof r.id === 'string' && this.members.get(r.id)?.inNight) this.progress.set(r.id, r);
      }
      if (typeof msg.hordes === 'number' && Number.isFinite(msg.hordes)) this.hostedHordes = Math.max(0, Math.min(999, Math.floor(msg.hordes)));
      if (msg.k === 'over') void this.end();
      else {
        if (typeof msg.survived === 'number' && Number.isFinite(msg.survived)) this.hostedSurvived = Math.max(0, msg.survived);
        if (Date.now() / 1000 - this.metaAt > 5) this.updateMeta();
      }
    } else if (msg.k === 'refit') {
      // Kept for their next night, as far as their profile has unlocked it.
      const m = this.members.get(msg.id);
      if (!m || typeof msg.build !== 'string' || msg.build.length > 200) return;
      if (!PRIMARY_WEAPONS.includes(msg.weapon) && !SECONDARY_WEAPONS.includes(msg.weapon)) return;
      const want = decodeBuild(msg.weapon, msg.build);
      const ok = sanitizeBuild(msg.weapon, want, m.unlocks);
      if (BUILD_SLOTS.every((s) => ok[s] === want[s])) m.builds = { ...m.builds, [msg.weapon]: ok };
    }
  }

  /** A player-hosted night as one of the others sees it in their own browser: what the host's count is held against. */
  private sees(client: Client, raw: unknown): void {
    const m = this.members.get(client.sessionId);
    if (this.hosting !== 'player' || this.status !== 'playing' || !m?.inNight || m.id === this.host || !raw || typeof raw !== 'object') return;
    const s = raw as { survived?: unknown; kills?: unknown };
    if (typeof s.survived !== 'number' || !Number.isFinite(s.survived) || !Array.isArray(s.kills)) return;
    const kills = new Map<string, number>();
    for (let i = 0; i + 1 < s.kills.length && i < GAME.maxPlayers * 4; i += 2) {
      const id = s.kills[i], n = s.kills[i + 1];
      if (typeof id === 'string' && typeof n === 'number' && Number.isFinite(n)) kills.set(id, n);
    }
    m.seen = { survived: Math.max(0, s.survived), kills, at: Date.now() };
  }

  /**
   * A run as a player host counted it, held to what can be checked without running the night:
   * what a real run could reach at all, the clock on the wall, and what the player's own browser
   * (for the host: anyone else's) last saw. Null when it can't be a real run.
   */
  private checked(m: Member, run: HostRun): { survived: number; stats: PlayerStats } | null {
    const ok = plausibleRun(run);
    if (!ok) return null;
    const now = Date.now();
    let survived = Math.min(ok.survived, (now - Math.max(this.beganAt, m.inNight)) / 1000 + 2);
    const stats = ok.stats;
    const others = [...this.members.values()].filter((o) => o.id !== this.host && o.seen);
    const w = m.id !== this.host ? m.seen : others.sort((a, b) => b.seen!.at - a.seen!.at)[0]?.seen;
    if (w) {
      const age = (now - w.at) / 1000;
      survived = Math.min(survived, w.survived + age + 5);
      const most = Math.floor((w.kills.get(m.id) ?? 0) + KILL_SLACK + KILL_RATE * age);
      if (stats.kills > most) {
        stats.kills = most;
        stats.headshots = Math.min(stats.headshots, most);
        stats.limbKills = Math.min(stats.limbKills, most);
      }
    }
    return { survived: Math.max(0, survived), stats };
  }

  // ------------------------------------------------------------------ records

  /** Writes a survivor's run to the leaderboards (once a night: when they leave, or when it ends). */
  private record(m: Member, run: HostRun | null | undefined): void {
    if (m.run || !run) return;
    const hosted = this.hosting === 'player';
    const sure = hosted ? this.checked(m, run) : run;
    // A count that can't be real goes nowhere: the room sees an empty run.
    const { survived, stats } = sure ?? { survived: 0, stats: { ...NO_STATS } };
    const store = services.store;
    // Gone before the outbreak with nothing done: not a run worth a place on the boards.
    const counts = survived > 0 || stats.kills > 0;
    const ranks = store && m.owner && counts && sure
      ? store.recordRun({ owner: m.owner, name: m.name, appearance: m.appearance, mode: hosted ? 'hosted' : 'online', survived, stats }).catch((e) => {
        console.warn('[dead-hours] could not record a run:', e);
        return NO_RANK;
      })
      : Promise.resolve(NO_RANK);
    m.run = { survived, stats, ranks };
  }

  /** Everyone is dead (or a player host is gone): results with leaderboard places, then back to the lobby. */
  private async end(): Promise<void> {
    if (this.status !== 'playing') return;
    this.status = 'over';
    const hosted = this.hosting === 'player';
    if (hosted) {
      for (const m of this.members.values()) if (m.inNight) this.record(m, this.progress.get(m.id));
      // (A host who reported the end has stopped already; one the room gave up on is told to.)
      this.hostClient?.send(S2C.host, { k: 'stop' } satisfies HostDown);
    } else {
      for (const run of this.nights.finish()) {
        const m = this.members.get(run.id);
        if (m) this.record(m, run);
      }
    }
    for (const m of this.members.values()) m.inNight = 0;
    const results: RunResult[] = [];
    // Places once every run of the night is in (an earlier death would otherwise show the place it had then).
    await Promise.all([...this.members.values()].map((m) => m.run?.ranks));
    for (const m of this.members.values()) {
      if (!m.run) continue;
      const { survived, stats } = m.run;
      const store = services.store;
      const outcome = await m.run.ranks;
      const r = store && m.owner && outcome !== NO_RANK
        ? await store.placeRun(m.owner, survived, stats.kills).catch(() => NO_RANK)
        : NO_RANK;
      // The XP went onto the profile: what it unlocked is theirs from the next night on.
      const xp = 'gained' in outcome ? outcome.gained : 0;
      if ('xp' in outcome) m.unlocks = { ...m.unlocks, level: levelFor(outcome.xp) };
      results.push({ id: m.id, name: m.name, survived, stats, ...r, xp });
    }
    results.sort((a, b) => b.survived - a.survived || b.stats.kills - a.stats.kills);
    this.log(`night over: ${results.map((r) => `${r.name} ${Math.round(r.survived)} s ${r.stats.kills} kills`).join(', ') || 'nobody'}`);
    const hordes = hosted ? this.hostedHordes : this.nights.hordes;
    this.broadcast(S2C.over, { results, hordes } satisfies OverMsg);
    this.status = 'lobby';
    for (const m of this.members.values()) m.ready = false;
    this.sendLobby();
    this.updateMeta();
  }

  /** Two players kept apart because one blocks the other. */
  private apart(a: Member, b: Member): boolean {
    return a.blocks.has(b.pid) || b.blocks.has(a.pid);
  }

  /** A chat line from a player: cleaned, filtered, rate limited, and kept from anyone either side blocks. */
  private chat(client: Client, msg: unknown): void {
    const m = this.members.get(client.sessionId);
    if (!m) return;
    const clean = cleanChat(msg);
    if (!clean) return;
    const now = Date.now() / 1000;
    // The same line again within a few seconds is a repeat, not a message.
    if (clean === m.said.text && now - m.said.at < 4) return;
    if (!m.limits.chat.take(now)) {
      if (now - m.said.warned > 3) {
        m.said.warned = now;
        client.send(S2C.chat, { id: '', pid: '', name: '', text: 'Slow down: too many messages.', sys: true } satisfies ChatLine);
      }
      return;
    }
    m.said = { text: clean, at: now, warned: m.said.warned };
    const line: ChatLine = { id: m.id, pid: m.pid, name: m.name, text: censor(clean) };
    for (const c of this.clients) {
      const o = this.members.get(c.sessionId);
      if (o && !this.apart(m, o)) c.send(S2C.chat, line);
    }
  }

  /** A line from the room itself to everyone (but `except`). */
  private announce(text: string, except?: string): void {
    const line: ChatLine = { id: '', pid: '', name: '', text, sys: true };
    for (const c of this.clients) if (c.sessionId !== except) c.send(S2C.chat, line);
  }

  private sendLobby(): void {
    const msg: LobbyMsg = {
      code: this.code, name: this.title, host: this.host, status: this.status, private: this.hidden, hosting: this.hosting,
      players: [...this.members.values()].map((m) => ({ id: m.id, pid: m.pid, name: m.name, ready: m.ready, primary: m.primary, appearance: m.appearance })),
    };
    this.broadcast(S2C.lobby, msg);
  }

  private updateMeta(): void {
    const hosted = this.hosting === 'player';
    this.metaAt = hosted ? Date.now() / 1000 : this.nights.night?.time ?? 0;
    void this.setMetadata({
      code: this.code, name: this.title, host: this.members.get(this.host)?.name ?? '', status: this.status, hosting: this.hosting,
      survived: this.status !== 'playing' ? 0 : Math.floor(hosted ? this.hostedSurvived : this.nights.survived),
    });
  }
}
