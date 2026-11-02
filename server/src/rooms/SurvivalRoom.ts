import { createHash } from 'node:crypto';
import { Room, type Client } from 'colyseus';
import {
  C2S, CHAT, GAME, S2C, censor, cleanChat, type BeginMsg, type ChatLine, type CreateOptions, type JoinOptions, type LobbyMsg,
  type Loadout, type OverMsg, type PlayerStats, type RoomStatus, type RtcIn, type RunResult, type TalkMsg, type UnlockState, type WeaponId,
  NO_UNLOCKS, levelFor,
} from '@dead-hours/shared';
import { Night } from '../game/Night';
import { claimCode, releaseCode, renewCode } from '../net/codes';
import { resolveOwner, type Owner } from '../net/auth';
import { cleanAppearance, cleanBuilds, cleanName, cleanPrimary, cleanSecondary } from '../net/clean';
import { iceConfig } from '../net/ice';
import { Bucket } from '../net/limit';
import { gameClosed, gameOpened } from '../net/scale';
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
  /** Has the night's scene up: snapshots and events go only to loaded clients (no backlog while it builds). */
  loaded: boolean;
  spawn: BeginMsg['spawn'] | null;
  /** Survival seconds already gone when they dropped into this night (0: there from the start). */
  joinedAt: number;
  /** This night's run once it ended for them (died or left), and its leaderboard places. */
  run: { survived: number; stats: PlayerStats; ranks: Promise<Ranks | RunOutcome> } | null;
  /** Player ids this player blocks: no chat, voice or negotiation passes between them either way. */
  blocks: Set<string>;
  limits: { chat: Bucket; talk: Bucket; rtc: Bucket };
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

/**
 * A hosted game: whoever creates it hosts (starts the night; the next to have joined takes
 * over when they leave), friends join with its code or from the game list. The night itself
 * runs here on the server (Night); the room carries the lobby, the messages and the records.
 */
export class SurvivalRoom extends Room {
  maxClients: number = GAME.maxPlayers;
  private readonly members = new Map<string, Member>();
  private host = '';
  private code = '';
  private title = '';
  private hidden = false;
  private status: RoomStatus = 'lobby';
  private night: Night | null = null;
  private metaAt = 0;

  async onCreate(o: Partial<CreateOptions>): Promise<void> {
    gameOpened(this.roomId);
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
    this.onMessage(C2S.loaded, (c) => {
      const m = this.members.get(c.sessionId);
      if (!m || this.status !== 'playing' || m.loaded) return;
      m.loaded = true;
      // Dropped in late (or slow to load): first what is already going on that a snapshot doesn't carry.
      const missed = this.night?.catchUp();
      if (missed?.length) c.send(S2C.ev, missed);
    });
    this.onMessage(C2S.motion, (c, msg: unknown) => {
      if (this.status !== 'playing' || !this.night) return;
      const back = this.night.motion(c.sessionId, msg);
      if (back) c.send(S2C.pos, back);
    });
    this.onMessage(C2S.drive, (c, msg: unknown) => {
      if (this.status !== 'playing' || !this.night) return;
      const back = this.night.drive(c.sessionId, msg);
      if (back) c.send(S2C.vpos, back);
    });
    this.onMessage(C2S.act, (c, msg: unknown) => {
      if (this.status === 'playing') this.night?.act(c.sessionId, msg);
    });
    this.onMessage(C2S.ping, (c, n: unknown) => {
      if (typeof n === 'number') c.send(S2C.pong, n);
    });
    this.onMessage(C2S.debug, (c, msg: unknown) => {
      if (services.debug && this.status === 'playing') this.night?.debug(c.sessionId, msg);
    });
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
    this.log(`opened "${this.title}"${this.hidden ? ' (private)' : ''}`);
  }

  /** One line per room event in the server log (who joined, nights started and ended). */
  private log(text: string): void {
    console.log(`[dead-hours] room ${this.code} ${text}`);
  }

  /** Who is joining: their sign-in session or browser key, looked up before they are let in. */
  async onAuth(_client: Client, o: Partial<JoinOptions>): Promise<Owner | true> {
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
      loaded: false,
      spawn: null,
      joinedAt: 0,
      run: null,
      blocks: new Set(),
      limits: { chat: new Bucket(CHAT.burst, CHAT.refillSeconds), talk: new Bucket(20, 0.1), rtc: new Bucket(120, 0.05) },
      said: { text: '', at: 0, warned: 0 },
    });
    if (!this.host) this.host = client.sessionId;
    const name = this.members.get(client.sessionId)!.name;
    this.log(`${name} joined (${this.members.size}/${this.maxClients})`);
    client.send(S2C.ice, iceConfig(pid));
    // A night under way: straight into it beside the others (no waiting for the next one).
    const late = this.status === 'playing' && this.night ? this.dropIn(client, this.members.get(client.sessionId)!) : false;
    this.announce(late ? `${name} joined the night` : `${name} joined`, client.sessionId);
    this.sendLobby();
    this.updateMeta();
  }

  /** Puts a player who joined mid-night into it at the safehouse; they load the scene and the stream starts. */
  private dropIn(client: Client, m: Member): boolean {
    const night = this.night;
    if (!night) return false;
    const sim = night.sim;
    m.spawn = night.addSurvivor(m, sim.players.size);
    m.run = null;
    m.ready = false;
    m.loaded = false;
    m.joinedAt = sim.phase === 'survival' ? sim.phaseTime : 0;
    client.send(S2C.begin, { seed: night.seed, t: night.time, spawn: m.spawn, late: true } satisfies BeginMsg);
    this.log(`${m.name} dropped into the night at ${Math.floor(m.joinedAt)} s`);
    return true;
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const id = client.sessionId;
    if (!this.members.has(id)) return;
    // A dropped connection mid-night gets a short while to come back; the survivor stands still meanwhile.
    if (!consented && this.status === 'playing' && this.night?.sim.players.get(id)?.alive) {
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
    this.night?.dispose();
    this.night = null;
  }

  private drop(id: string): void {
    const night = this.night;
    if (night && this.status === 'playing' && night.sim.players.has(id)) {
      this.record(id);
      night.removeSurvivor(id);
    }
    const name = this.members.get(id)?.name ?? id;
    this.log(`${name} left`);
    this.members.delete(id);
    this.announce(`${name} left`);
    if (this.host === id) this.host = this.members.keys().next().value ?? '';
    if (night && this.status === 'playing' && (night.allDead || night.sim.players.size === 0)) void this.end();
    this.sendLobby();
    this.updateMeta();
  }

  private start(client: Client): void {
    if (client.sessionId !== this.host) {
      client.send(S2C.notice, 'ONLY THE HOST CAN START THE NIGHT');
      return;
    }
    if (this.status !== 'lobby') return;
    this.night?.dispose();
    const seed = (Math.random() * 2 ** 31) | 1;
    const night = new Night(seed);
    this.night = night;
    night.onRefit = (id, weapon, build) => {
      const m = this.members.get(id);
      if (m) m.builds = { ...m.builds, [weapon]: build };
    };
    let i = 0;
    for (const m of this.members.values()) {
      m.spawn = night.addSurvivor(m, i++);
      m.run = null;
      m.ready = false;
      m.loaded = false;
      m.joinedAt = 0;
    }
    this.status = 'playing';
    this.log(`night started with ${this.members.size}`);
    // The room stays open while the night plays: friends can drop in with the code or from the list
    // (Colyseus still closes it on its own while all four places are taken).
    for (const c of this.clients) {
      const m = this.members.get(c.sessionId);
      if (m?.spawn) c.send(S2C.begin, { seed, t: night.time, spawn: m.spawn } satisfies BeginMsg);
    }
    this.sendLobby();
    this.updateMeta();
  }

  private tick(ms: number): void {
    const night = this.night;
    if (this.status !== 'playing' || !night) return;
    const { events, snapshot } = night.advance(ms / 1000);
    const building = this.clients.filter((c) => !this.members.get(c.sessionId)?.loaded);
    const to = building.length ? { except: building } : undefined;
    if (events.length) {
      this.broadcast(S2C.ev, events, to);
      // (A death is not written to the boards here: the next lull can bring them back. The run is
      // recorded when they leave or the night ends.)
    }
    if (snapshot) this.broadcast(S2C.snap, snapshot, to);
    if (night.sim.phase === 'over' || night.allDead) {
      void this.end();
      return;
    }
    if (night.time - this.metaAt > 5) this.updateMeta();
  }

  /** Writes a survivor's run to the leaderboards (once a night: when they die or leave). */
  private record(id: string): void {
    const m = this.members.get(id);
    const night = this.night;
    const p = night?.sim.players.get(id);
    if (!m || !night || !p || m.run) return;
    const sim = night.sim;
    // Seconds since the outbreak (or since they dropped in), at the moment they fell (or now, leaving
    // alive), less any time spent dead before a lull brought them back.
    const since = p.alive ? 0 : Math.max(0, sim.time - p.diedAt);
    const survived = sim.phase === 'preparation' ? 0 : Math.max(0, sim.phaseTime - since - m.joinedAt - p.deadTime);
    const stats = { ...p.stats };
    const store = services.store;
    // Gone before the outbreak with nothing done: not a run worth a place on the boards.
    const counts = survived > 0 || stats.kills > 0;
    const ranks = store && m.owner && counts
      ? store.recordRun({ owner: m.owner, name: m.name, appearance: m.appearance, mode: 'online', survived, stats }).catch((e) => {
        console.warn('[dead-hours] could not record a run:', e);
        return NO_RANK;
      })
      : Promise.resolve(NO_RANK);
    m.run = { survived, stats, ranks };
  }

  /** Everyone is dead: results with leaderboard places, then back to the lobby. */
  private async end(): Promise<void> {
    if (this.status !== 'playing') return;
    this.status = 'over';
    for (const id of this.members.keys()) this.record(id);
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
    const hordes = this.night?.sim.horde.survived ?? 0;
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
      code: this.code, name: this.title, host: this.host, status: this.status, private: this.hidden,
      players: [...this.members.values()].map((m) => ({ id: m.id, pid: m.pid, name: m.name, ready: m.ready, primary: m.primary, appearance: m.appearance })),
    };
    this.broadcast(S2C.lobby, msg);
  }

  private updateMeta(): void {
    const sim = this.night?.sim;
    this.metaAt = sim?.time ?? 0;
    void this.setMetadata({
      code: this.code, name: this.title, host: this.members.get(this.host)?.name ?? '', status: this.status,
      survived: this.status === 'playing' && sim?.phase === 'survival' ? Math.floor(sim.phaseTime) : 0,
    });
  }
}
