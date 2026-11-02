import type { WeaponId } from '../config/weapons';
import type { Vec3 } from '../sim/math';
import type { SkateTrick } from '../config/skateboards';
import type { PlayerStats } from '../sim/Simulation';

/** Room names registered on the Colyseus server. */
export const ROOMS = {
  survival: 'survival',
} as const;

/** Matchmaking error when every game server already runs as many games as it takes. */
export const SERVERS_FULL = 4503;

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
  /** A line of text chat (lobby or in play). */
  chat: 'chat',
  /** Voice: what this survivor is transmitting now (TalkMode or null). */
  talk: 'talk',
  /** Voice: WebRTC negotiation for one other survivor (RtcOut). */
  rtc: 'rtc',
  /** The lasting player ids this player blocks (string[]): no chat or voice either way. */
  blocks: 'blocks',
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
  /** A line of text chat (ChatLine). */
  chat: 'chat',
  /** Someone started or stopped transmitting voice (TalkMsg). */
  talk: 'talk',
  /** WebRTC negotiation from another survivor (RtcIn). */
  rtc: 'rtc',
  /** How to reach the others for voice: STUN and TURN servers (IceConfig), sent on joining. */
  ice: 'ice',
} as const;

/** One thing a survivor does. The server validates every one against its own state. */
export type ActMsg =
  | { a: 'fire'; o: Vec3; d: Vec3 }
  | { a: 'reload' }
  | { a: 'switch'; slot: 'primary' | 'secondary' | 'melee' }
  | { a: 'melee'; o: Vec3; d: Vec3 }
  | { a: 'bandage' }
  | { a: 'use'; id: number }
  | { a: 'primary'; weapon: WeaponId }
  | { a: 'grab'; limb: number }
  | { a: 'door'; door: number }
  /** Starts nailing boards up or prying them off a door or window (carries on while held); 'stop' lets go. */
  | { a: 'barricade'; slot: number; k: 'board' | 'pry' | 'stop' }
  /** Hold interact on a downed teammate (null: let go). */
  | { a: 'revive'; target: string | null }
  /** New attachments or finish for a carried gun (encodeBuild); the server checks the player's unlocks. */
  | { a: 'refit'; weapon: WeaponId; build: string }
  /** Throw a grenade or Molotov along the crosshair ray. */
  | { a: 'throw'; kind: 'frag' | 'molotov'; o: Vec3; d: Vec3 }
  /** Hop on skateboard `id`; -1 steps off (`bail`: thrown off by a wall), leaving it at `at` (where the rider's browser put it) pointing `yaw`. */
  | { a: 'board'; id: number; at?: Vec3; yaw?: number; bail?: boolean }
  /** Vaulting through window slot `slot` (the browser moves the survivor; a pane still in smashes). */
  | { a: 'vault'; slot: number }
  /** Popped a flip trick off an ollie on the board (the others see it). */
  | { a: 'trick'; kind: SkateTrick };

export type DebugMsg =
  | { cmd: 'skipPreparation' }
  | { cmd: 'spawn'; dist: number; angle: number; kind?: string }
  | { cmd: 'supplyDrop'; weapon?: WeaponId; serum?: boolean }
  | { cmd: 'hurt'; amount: number }
  | { cmd: 'raid' }
  | { cmd: 'lull' }
  /** Health stays full (for slow test clients); 'hurt' still kills. */
  | { cmd: 'god'; on: boolean };

export interface JoinOptions {
  name: string;
  primary: string;
  /** The sidearm (SECONDARY_WEAPONS: the M17 or the akimbo pair; anything else gets the M17). */
  secondary?: string;
  /** encodeAppearance() of the survivor's look; the server sanitizes it and shares it. */
  appearance: string;
  /** The browser's player key (saved profile and leaderboard entries) for guests. */
  token?: string;
  /** A signed-in player's session: their runs count for their account instead of the key. */
  session?: string;
  /** encodeLoadout() of the survivor's weapon builds; the server keeps only what the profile has unlocked. */
  builds?: string;
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
  /** Lasting player id (from the player key; per connection without one): mute and block lists use it. */
  pid: string;
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
  /** Joined a night already under way (dropped in from the game list or with the code). */
  late?: boolean;
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
  /** XP the run earned (0 when it wasn't saved: no player key or no store). */
  xp?: number;
}

export interface OverMsg {
  results: RunResult[];
  /** Horde waves the night outlasted (absent from older servers). */
  hordes?: number;
}

/** Where a voice goes: to whoever is near (from where the speaker stands) or over the team radio. */
export type TalkMode = 'near' | 'radio';

export interface ChatLine {
  /** Session id of the sender ('' for the room's own lines). */
  id: string;
  /** The sender's lasting player id. */
  pid: string;
  name: string;
  /** Cleaned and filtered by the server: plain text, to be shown as text. */
  text: string;
  /** Said by the room itself (joined, left, slow down). */
  sys?: boolean;
}

export interface TalkMsg {
  id: string;
  mode: TalkMode | null;
}

/** WebRTC negotiation for voice, passed through the room to one other survivor. */
export interface RtcSignal {
  description?: { type: 'offer' | 'answer' | 'rollback'; sdp?: string };
  /** An ICE candidate (null: no more candidates). */
  candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null;
}

export interface RtcOut extends RtcSignal {
  to: string;
}

export interface RtcIn extends RtcSignal {
  from: string;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServer[];
  /** The server offers a TURN relay (players on strict networks can force voice through it). */
  relay: boolean;
}
