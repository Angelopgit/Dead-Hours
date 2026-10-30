import type { WeaponId } from '../config/weapons';
import type { Vec3 } from '../sim/math';
import type { PlayerStats } from '../sim/Simulation';

/** Room names registered on the Colyseus server. */
export const ROOMS = {
  survival: 'survival',
} as const;

/** Client → server messages. */
export const C2S = {
  /** Lobby: ready or not. */
  ready: 'ready',
  /** Lobby: the host starts the night (or starts another after it ends). */
  start: 'start',
  /** The night's scene is built and drawing: the server starts streaming snapshots to this client. */
  loaded: 'loaded',
  /** In play, ~30 times a second: packMotion() of where the survivor is and where they aim. */
  motion: 'motion',
  /** In play: one thing the survivor does (fire, reload, swing, use...). */
  act: 'act',
  /** Round-trip timing: the server echoes the number back. */
  ping: 'ping',
  /** Test commands (only when the server runs with DEAD_HOURS_DEBUG=1). */
  debug: 'debug',
} as const;

/** Server → client messages. */
export const S2C = {
  /** Who is in the room, who hosts, who is ready. */
  lobby: 'lobby',
  /** The night is starting: the seed and where this survivor starts. */
  begin: 'begin',
  /** World state, ~20 times a second (Snapshot). */
  snap: 'snap',
  /** Simulation events, every step that has any (SimEvent[]). */
  ev: 'ev',
  /** Everyone is dead: how each survivor did, and where it ranks. */
  over: 'over',
  pong: 'pong',
  /** The server refused a move (too fast, through a wall): the survivor is put back here. */
  pos: 'pos',
  /** Something the player should be told (only the host can start, ...). */
  notice: 'notice',
} as const;

/** One thing a survivor does. The server validates every one against its own state. */
export type ActMsg =
  | { a: 'fire'; o: Vec3; d: Vec3 }
  | { a: 'reload' }
  | { a: 'switch'; slot: 'primary' | 'secondary' }
  | { a: 'melee'; o: Vec3; d: Vec3 }
  | { a: 'bandage' }
  | { a: 'use'; id: number }
  | { a: 'primary'; weapon: WeaponId }
  | { a: 'grab'; limb: number }
  | { a: 'door'; door: number };

export type DebugMsg =
  | { cmd: 'skipPreparation' }
  | { cmd: 'spawn'; dist: number; angle: number; kind?: string }
  | { cmd: 'supplyDrop' }
  | { cmd: 'hurt'; amount: number }
  /** Health stays full (for slow test clients); 'hurt' still kills. */
  | { cmd: 'god'; on: boolean };

export interface JoinOptions {
  name: string;
  primary: string;
  /** encodeAppearance() of the survivor's look; the server sanitizes it and shares it. */
  appearance: string;
  /** The browser's player key (saved profile and leaderboard entries). */
  token?: string;
}

export interface CreateOptions extends JoinOptions {
  lobbyName?: string;
  /** Hidden from the game list: join by code only. */
  private?: boolean;
}

export type RoomStatus = 'lobby' | 'playing' | 'over';

/** What the game list shows about a room. */
export interface RoomListing {
  roomId: string;
  code: string;
  name: string;
  host: string;
  players: number;
  maxPlayers: number;
  status: RoomStatus;
  /** Seconds survived so far (while playing). */
  survived: number;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
  primary: string;
  appearance: string;
}

export interface LobbyMsg {
  code: string;
  name: string;
  /** Session id of the host (the room's creator, or whoever is next when they leave). */
  host: string;
  status: RoomStatus;
  private: boolean;
  players: LobbyPlayer[];
}

/** The night has begun. */
export interface BeginMsg {
  seed: number;
  /** Server simulation time now. */
  t: number;
  /** Where this survivor starts (camera yaw). */
  spawn: { x: number; y: number; z: number; yaw: number };
}

/** How one survivor did when the night ended for everyone. */
export interface RunResult {
  id: string;
  name: string;
  survived: number;
  stats: PlayerStats;
  /** Leaderboard place this run reached for survival time and for kills (null when not ranked). */
  rankSurvival: number | null;
  rankKills: number | null;
}

export interface OverMsg {
  results: RunResult[];
}
