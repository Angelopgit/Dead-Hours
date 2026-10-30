import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { PlayerStats } from '@dead-hours/shared';

/** A survivor as they saved them: name, look and the rifle they carry. */
export interface ProfileData {
  name: string;
  appearance: string;
  primary: string;
}

/** Everything a player has done across their runs. */
export interface ProfileStats {
  runs: number;
  kills: number;
  headshots: number;
  limbsSevered: number;
  /** Seconds survived, all runs together. */
  timeSurvived: number;
  bestSurvived: number;
  bestKills: number;
}

export interface Profile extends ProfileData {
  updatedAt: number;
  stats: ProfileStats;
  /** Places on the two boards (null before the first run). */
  rankSurvival: number | null;
  rankKills: number | null;
}

export type RunMode = 'solo' | 'online';

export interface RunRecord {
  /** The player's key (only its hash is stored). */
  token: string;
  name: string;
  appearance: string;
  mode: RunMode;
  /** Seconds survived after the outbreak began. */
  survived: number;
  stats: PlayerStats;
}

export interface Ranks {
  rankSurvival: number | null;
  rankKills: number | null;
}

export interface BoardEntry {
  name: string;
  value: number;
  mode: RunMode;
  /** When it was set (ms since epoch). */
  at: number;
}

export type BoardKind = 'survival' | 'kills';

/** Where profiles and leaderboards live: Postgres when DATABASE_URL is set, else a file. */
export interface Store {
  readonly kind: 'postgres' | 'file';
  getProfile(token: string): Promise<Profile | null>;
  saveProfile(token: string, data: ProfileData): Promise<Profile>;
  /** Records a run and returns its places (see placeRun). */
  recordRun(run: RunRecord): Promise<Ranks>;
  /**
   * Where a run of this player stands on each board now: a place only when it is their best
   * (each board holds one entry per player) and above zero.
   */
  placeRun(token: string, survived: number, kills: number): Promise<Ranks>;
  board(kind: BoardKind, limit: number): Promise<BoardEntry[]>;
  close(): Promise<void>;
}

/** Keys are stored hashed: a copy of the database can't be used to play as someone. */
export const keyHash = (token: string): string => createHash('sha256').update(`dead-hours:${token}`).digest('hex');

const emptyStats = (): ProfileStats => ({ runs: 0, kills: 0, headshots: 0, limbsSevered: 0, timeSurvived: 0, bestSurvived: 0, bestKills: 0 });

// ------------------------------------------------------------------ file store (development, single server)

interface FileProfile extends ProfileData {
  updatedAt: number;
  stats: ProfileStats;
  survivedMode: RunMode;
  survivedAt: number;
  killsMode: RunMode;
  killsAt: number;
}

/**
 * Profiles and bests in a JSON file, rewritten a moment after each change. Fine for a single
 * server with a disk that persists; hosted servers should set DATABASE_URL instead.
 */
export class FileStore implements Store {
  readonly kind = 'file' as const;
  private readonly profiles = new Map<string, FileProfile>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly path: string) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as { profiles?: Record<string, FileProfile> };
      for (const [k, v] of Object.entries(data.profiles ?? {})) this.profiles.set(k, v);
    } catch {
      // First run: nothing saved yet.
    }
  }

  private schedule(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  private flush(): void {
    this.saveTimer = null;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ profiles: Object.fromEntries(this.profiles) }));
    renameSync(tmp, this.path);
  }

  private rank(field: 'bestSurvived' | 'bestKills', value: number, except: string): number {
    let n = 1;
    for (const [k, p] of this.profiles) if (k !== except && p.stats[field] > value) n++;
    return n;
  }

  async placeRun(token: string, survived: number, kills: number): Promise<Ranks> {
    const key = keyHash(token);
    const s = this.profiles.get(key)?.stats;
    return {
      rankSurvival: s && survived > 0 && survived >= s.bestSurvived ? this.rank('bestSurvived', survived, key) : null,
      rankKills: s && kills > 0 && kills >= s.bestKills ? this.rank('bestKills', kills, key) : null,
    };
  }

  private view(key: string, p: FileProfile): Profile {
    const ranked = p.stats.runs > 0;
    return {
      name: p.name, appearance: p.appearance, primary: p.primary, updatedAt: p.updatedAt, stats: { ...p.stats },
      rankSurvival: ranked ? this.rank('bestSurvived', p.stats.bestSurvived, key) : null,
      rankKills: ranked ? this.rank('bestKills', p.stats.bestKills, key) : null,
    };
  }

  private ensure(key: string, data: ProfileData): FileProfile {
    let p = this.profiles.get(key);
    if (!p) {
      p = { ...data, updatedAt: Date.now(), stats: emptyStats(), survivedMode: 'solo', survivedAt: 0, killsMode: 'solo', killsAt: 0 };
      this.profiles.set(key, p);
    }
    return p;
  }

  async getProfile(token: string): Promise<Profile | null> {
    const key = keyHash(token);
    const p = this.profiles.get(key);
    return p ? this.view(key, p) : null;
  }

  async saveProfile(token: string, data: ProfileData): Promise<Profile> {
    const key = keyHash(token);
    const p = this.ensure(key, data);
    Object.assign(p, data, { updatedAt: Date.now() });
    this.schedule();
    return this.view(key, p);
  }

  async recordRun(run: RunRecord): Promise<Ranks> {
    const key = keyHash(run.token);
    const p = this.ensure(key, { name: run.name, appearance: run.appearance, primary: 'ar' });
    const s = p.stats;
    s.runs++;
    s.kills += run.stats.kills;
    s.headshots += run.stats.headshots;
    s.limbsSevered += run.stats.limbsSevered;
    s.timeSurvived += run.survived;
    const now = Date.now();
    if (run.survived > s.bestSurvived) {
      s.bestSurvived = run.survived;
      p.survivedMode = run.mode;
      p.survivedAt = now;
    }
    if (run.stats.kills > s.bestKills) {
      s.bestKills = run.stats.kills;
      p.killsMode = run.mode;
      p.killsAt = now;
    }
    this.schedule();
    return this.placeRun(run.token, run.survived, run.stats.kills);
  }

  async board(kind: BoardKind, limit: number): Promise<BoardEntry[]> {
    const field = kind === 'survival' ? 'bestSurvived' : 'bestKills';
    return [...this.profiles.values()]
      .filter((p) => p.stats.runs > 0 && p.stats[field] > 0)
      .sort((a, b) => b.stats[field] - a.stats[field] || (kind === 'survival' ? a.survivedAt - b.survivedAt : a.killsAt - b.killsAt))
      .slice(0, limit)
      .map((p) => ({
        name: p.name, value: p.stats[field],
        mode: kind === 'survival' ? p.survivedMode : p.killsMode, at: kind === 'survival' ? p.survivedAt : p.killsAt,
      }));
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.flush();
    }
  }
}

// ------------------------------------------------------------------ Postgres

const SCHEMA = `
create table if not exists dh_profiles (
  key text primary key,
  name text not null,
  appearance text not null default '',
  primary_weapon text not null default 'ar',
  updated_at timestamptz not null default now(),
  runs integer not null default 0,
  kills integer not null default 0,
  headshots integer not null default 0,
  limbs_severed integer not null default 0,
  time_survived double precision not null default 0,
  best_survived double precision not null default 0,
  best_survived_mode text not null default 'solo',
  best_survived_at timestamptz,
  best_kills integer not null default 0,
  best_kills_mode text not null default 'solo',
  best_kills_at timestamptz
);
create index if not exists dh_profiles_best_survived on dh_profiles (best_survived desc);
create index if not exists dh_profiles_best_kills on dh_profiles (best_kills desc);
create table if not exists dh_runs (
  id bigserial primary key,
  key text not null,
  name text not null,
  mode text not null,
  survived double precision not null,
  kills integer not null,
  stats jsonb not null,
  at timestamptz not null default now()
);
create index if not exists dh_runs_key on dh_runs (key);
`;

interface ProfileRow {
  key: string;
  name: string;
  appearance: string;
  primary_weapon: string;
  updated_at: Date;
  runs: number;
  kills: number;
  headshots: number;
  limbs_severed: number;
  time_survived: number;
  best_survived: number;
  best_kills: number;
}

/** Hosted databases want TLS from outside their network; on the inside (and locally) they don't. */
function sslFor(url: string): pg.PoolConfig['ssl'] {
  if (/sslmode=/i.test(url) || process.env.PGSSLMODE) return undefined;
  try {
    const host = new URL(url).hostname;
    if (!host.includes('.') || host === '127.0.0.1' || host.endsWith('.local')) return undefined;
    return { rejectUnauthorized: false };
  } catch {
    return undefined;
  }
}

/** Profiles, bests and a log of every run in Postgres (DATABASE_URL). */
export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  private constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, ssl: sslFor(url), max: 5 });
  }

  static async connect(url: string): Promise<PostgresStore> {
    const s = new PostgresStore(url);
    await s.pool.query(SCHEMA);
    return s;
  }

  private async ranks(key: string, survived: number, kills: number): Promise<Ranks> {
    const r = await this.pool.query<{ s: string; k: string }>(
      `select (select count(*) from dh_profiles where key <> $1 and runs > 0 and best_survived > $2) as s,
              (select count(*) from dh_profiles where key <> $1 and runs > 0 and best_kills > $3) as k`,
      [key, survived, kills],
    );
    return { rankSurvival: Number(r.rows[0].s) + 1, rankKills: Number(r.rows[0].k) + 1 };
  }

  private async view(row: ProfileRow): Promise<Profile> {
    const ranked = row.runs > 0;
    const r = ranked ? await this.ranks(row.key, row.best_survived, row.best_kills) : { rankSurvival: null, rankKills: null };
    return {
      name: row.name, appearance: row.appearance, primary: row.primary_weapon, updatedAt: row.updated_at.getTime(),
      stats: {
        runs: row.runs, kills: row.kills, headshots: row.headshots, limbsSevered: row.limbs_severed,
        timeSurvived: row.time_survived, bestSurvived: row.best_survived, bestKills: row.best_kills,
      },
      ...r,
    };
  }

  async getProfile(token: string): Promise<Profile | null> {
    const r = await this.pool.query<ProfileRow>('select * from dh_profiles where key = $1', [keyHash(token)]);
    return r.rows[0] ? this.view(r.rows[0]) : null;
  }

  async saveProfile(token: string, data: ProfileData): Promise<Profile> {
    const r = await this.pool.query<ProfileRow>(
      `insert into dh_profiles (key, name, appearance, primary_weapon) values ($1, $2, $3, $4)
       on conflict (key) do update set name = excluded.name, appearance = excluded.appearance,
         primary_weapon = excluded.primary_weapon, updated_at = now()
       returning *`,
      [keyHash(token), data.name, data.appearance, data.primary],
    );
    return this.view(r.rows[0]);
  }

  async recordRun(run: RunRecord): Promise<Ranks> {
    const key = keyHash(run.token);
    const k = run.stats.kills;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into dh_profiles (key, name, appearance) values ($1, $2, $3) on conflict (key) do nothing`,
        [key, run.name, run.appearance],
      );
      await client.query(
        `update dh_profiles set
           runs = runs + 1, kills = kills + $2, headshots = headshots + $3, limbs_severed = limbs_severed + $4,
           time_survived = time_survived + $5,
           best_survived_mode = case when $5 > best_survived then $7 else best_survived_mode end,
           best_survived_at = case when $5 > best_survived then now() else best_survived_at end,
           best_survived = greatest(best_survived, $5),
           best_kills_mode = case when $6 > best_kills then $7 else best_kills_mode end,
           best_kills_at = case when $6 > best_kills then now() else best_kills_at end,
           best_kills = greatest(best_kills, $6)
         where key = $1`,
        [key, k, run.stats.headshots, run.stats.limbsSevered, run.survived, k, run.mode],
      );
      await client.query(
        'insert into dh_runs (key, name, mode, survived, kills, stats) values ($1, $2, $3, $4, $5, $6)',
        [key, run.name, run.mode, run.survived, k, JSON.stringify(run.stats)],
      );
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
    return this.placeRun(run.token, run.survived, k);
  }

  async placeRun(token: string, survived: number, kills: number): Promise<Ranks> {
    const key = keyHash(token);
    const best = await this.pool.query<{ best_survived: number; best_kills: number }>(
      'select best_survived, best_kills from dh_profiles where key = $1', [key],
    );
    const row = best.rows[0];
    if (!row) return { rankSurvival: null, rankKills: null };
    const r = await this.ranks(key, survived, kills);
    return {
      rankSurvival: survived > 0 && survived >= row.best_survived ? r.rankSurvival : null,
      rankKills: kills > 0 && kills >= row.best_kills ? r.rankKills : null,
    };
  }

  async board(kind: BoardKind, limit: number): Promise<BoardEntry[]> {
    const [value, mode, at] = kind === 'survival'
      ? ['best_survived', 'best_survived_mode', 'best_survived_at']
      : ['best_kills', 'best_kills_mode', 'best_kills_at'];
    const r = await this.pool.query<{ name: string; value: number; mode: RunMode; at: Date | null }>(
      `select name, ${value} as value, ${mode} as mode, ${at} as at from dh_profiles
       where runs > 0 and ${value} > 0 order by ${value} desc, ${at} asc limit $1`,
      [limit],
    );
    return r.rows.map((x) => ({ name: x.name, value: Number(x.value), mode: x.mode, at: x.at ? x.at.getTime() : 0 }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Postgres when DATABASE_URL is set; otherwise a JSON file beside the server (DATA_FILE to move it). */
export async function openStore(): Promise<Store> {
  const url = process.env.DATABASE_URL;
  if (url) return PostgresStore.connect(url);
  return new FileStore(process.env.DATA_FILE ?? new URL('../data/dead-hours.json', import.meta.url).pathname);
}
