import { Room, type Client } from 'colyseus';
import {
  C2S, GAME, S2C, type BeginMsg, type CreateOptions, type JoinOptions, type LobbyMsg, type OverMsg, type PlayerStats,
  type RoomStatus, type RunResult, type WeaponId,
} from '@dead-hours/shared';
import { Night } from '../game/Night';
import { claimCode, releaseCode } from '../net/codes';
import { cleanAppearance, cleanName, cleanPrimary, cleanToken } from '../net/clean';
import { services } from '../services';
import type { Ranks } from '../store';

interface Member {
  id: string;
  name: string;
  primary: WeaponId;
  appearance: string;
  token: string | null;
  ready: boolean;
  /** Has the night's scene up: snapshots and events go only to loaded clients (no backlog while it builds). */
  loaded: boolean;
  spawn: BeginMsg['spawn'] | null;
  /** This night's run once it ended for them (died or left), and its leaderboard places. */
  run: { survived: number; stats: PlayerStats; ranks: Promise<Ranks> } | null;
}

const NO_RANK: Ranks = { rankSurvival: null, rankKills: null };

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

  onCreate(o: Partial<CreateOptions>): void {
    this.code = claimCode(this.roomId);
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
      if (m && this.status === 'playing') m.loaded = true;
    });
    this.onMessage(C2S.motion, (c, msg: unknown) => {
      if (this.status !== 'playing' || !this.night) return;
      const back = this.night.motion(c.sessionId, msg);
      if (back) c.send(S2C.pos, back);
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
    this.setSimulationInterval((ms) => this.tick(ms), 1000 / 60);
    this.log(`opened "${this.title}"${this.hidden ? ' (private)' : ''}`);
  }

  /** One line per room event in the server log (who joined, nights started and ended). */
  private log(text: string): void {
    console.log(`[dead-hours] room ${this.code} ${text}`);
  }

  onJoin(client: Client, o: Partial<JoinOptions>): void {
    this.members.set(client.sessionId, {
      id: client.sessionId,
      name: cleanName(o.name) || 'Survivor',
      primary: cleanPrimary(o.primary),
      appearance: cleanAppearance(o.appearance),
      token: cleanToken(o.token),
      ready: false,
      loaded: false,
      spawn: null,
      run: null,
    });
    if (!this.host) this.host = client.sessionId;
    this.log(`${this.members.get(client.sessionId)!.name} joined (${this.members.size}/${this.maxClients})`);
    this.sendLobby();
    this.updateMeta();
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const id = client.sessionId;
    if (!this.members.has(id)) return;
    // A dropped connection mid-night gets a short while to come back; the survivor stands still meanwhile.
    if (!consented && this.status === 'playing' && this.night?.sim.players.get(id)?.alive) {
      this.log(`${this.members.get(id)!.name} lost connection, holding their place for 20 s`);
      try {
        await this.allowReconnection(client, 20);
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
    releaseCode(this.code);
    this.night?.dispose();
    this.night = null;
  }

  private drop(id: string): void {
    const night = this.night;
    if (night && this.status === 'playing' && night.sim.players.has(id)) {
      this.record(id);
      night.removeSurvivor(id);
    }
    this.log(`${this.members.get(id)?.name ?? id} left`);
    this.members.delete(id);
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
    let i = 0;
    for (const m of this.members.values()) {
      m.spawn = night.addSurvivor(m, i++);
      m.run = null;
      m.ready = false;
      m.loaded = false;
    }
    this.status = 'playing';
    this.log(`night started with ${this.members.size}`);
    void this.lock();
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
      for (const e of events) if (e.type === 'playerDied') this.record(e.player);
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
    // Seconds since the outbreak, at the moment they fell (or now, leaving alive).
    const since = p.alive ? 0 : Math.max(0, sim.time - p.diedAt);
    const survived = sim.phase === 'preparation' ? 0 : Math.max(0, sim.phaseTime - since);
    const stats = { ...p.stats };
    const store = services.store;
    // Gone before the outbreak with nothing done: not a run worth a place on the boards.
    const counts = survived > 0 || stats.kills > 0;
    const ranks = store && m.token && counts
      ? store.recordRun({ token: m.token, name: m.name, appearance: m.appearance, mode: 'online', survived, stats }).catch((e) => {
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
      const r = store && m.token && (await m.run.ranks) !== NO_RANK
        ? await store.placeRun(m.token, survived, stats.kills).catch(() => NO_RANK)
        : NO_RANK;
      results.push({ id: m.id, name: m.name, survived, stats, ...r });
    }
    results.sort((a, b) => b.survived - a.survived || b.stats.kills - a.stats.kills);
    this.log(`night over: ${results.map((r) => `${r.name} ${Math.round(r.survived)} s ${r.stats.kills} kills`).join(', ') || 'nobody'}`);
    this.broadcast(S2C.over, { results } satisfies OverMsg);
    this.status = 'lobby';
    for (const m of this.members.values()) m.ready = false;
    void this.unlock();
    this.sendLobby();
    this.updateMeta();
  }

  private sendLobby(): void {
    const msg: LobbyMsg = {
      code: this.code, name: this.title, host: this.host, status: this.status, private: this.hidden,
      players: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, ready: m.ready, primary: m.primary, appearance: m.appearance })),
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
