import { createHash, randomBytes } from 'node:crypto';
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
  /** Whose profile the run counts for (see ownerOfKey and accounts). */
  owner: string;
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
  /** Set by a player signed in with an account (not only a browser key). */
  signedIn: boolean;
}

/** A signed-in player. Their survivor, stats and places live on the profile at `profileKey`. */
export interface Account {
  id: string;
  /** The profile (owner key) this account plays as. */
  profileKey: string;
  /** What the sign-in service calls them (shown as "signed in as"). */
  name: string;
  email: string | null;
  /** Services they have signed in with, e.g. ['google', 'discord']. */
  providers: string[];
  createdAt: number;
}

/** Who a sign-in service says someone is. */
export interface Identity {
  provider: string;
  /** Their id at that service (never changes). */
  subject: string;
  name: string;
  /** Only when the service has verified it (used to join a second service to the same account). */
  email: string | null;
}

export type BoardKind = 'survival' | 'kills';

/**
 * Where profiles, leaderboards and accounts live: Postgres when DATABASE_URL is set, else a file.
 * Profiles are keyed by an owner key: the hash of a guest's browser key (ownerOfKey), or the
 * profile key of a signed-in account.
 */
export interface Store {
  readonly kind: 'postgres' | 'file';
  getProfile(owner: string): Promise<Profile | null>;
  saveProfile(owner: string, data: ProfileData): Promise<Profile>;
  /** Records a run and returns its places (see placeRun). */
  recordRun(run: RunRecord): Promise<Ranks>;
  /**
   * Where a run of this player stands on each board now: a place only when it is their best
   * (each board holds one entry per player) and above zero.
   */
  placeRun(owner: string, survived: number, kills: number): Promise<Ranks>;
  board(kind: BoardKind, limit: number): Promise<BoardEntry[]>;
  /**
   * Folds one profile into another (a guest's browser profile into the account they sign in to):
   * totals add up, bests keep the better, the look stays the target's. When the target has no
   * profile yet the source simply becomes it. The source profile is gone afterwards.
   */
  mergeProfiles(from: string, into: string): Promise<void>;

  /** The account for this sign-in: found by service id, else by verified email, else made. */
  accountFor(identity: Identity): Promise<Account>;
  getAccount(id: string): Promise<Account | null>;
  /** Sessions and one-time sign-in codes are stored by hash with an expiry (ms since epoch). */
  createSession(hash: string, accountId: string, expires: number): Promise<void>;
  sessionAccount(hash: string): Promise<Account | null>;
  deleteSession(hash: string): Promise<void>;
  createLoginCode(hash: string, accountId: string, nonce: string, expires: number): Promise<void>;
  /** Uses up a sign-in code: returns it once, never again. */
  takeLoginCode(hash: string): Promise<{ accountId: string; nonce: string } | null>;
  close(): Promise<void>;
}

/** Keys are stored hashed: a copy of the database can't be used to play as someone. */
export const keyHash = (token: string): string => createHash('sha256').update(`dead-hours:${token}`).digest('hex');
/** The owner key of a guest playing with a browser key. */
export const ownerOfKey = keyHash;
/** Sessions and sign-in codes are stored hashed too. */
export const secretHash = (secret: string): string => createHash('sha256').update(`dead-hours session:${secret}`).digest('hex');
const newId = (): string => randomBytes(12).toString('base64url');
/** A fresh profile key for an account (never a browser key's hash: those are hex). */
const newProfileKey = (): string => `acct-${randomBytes(18).toString('base64url')}`;

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

interface FileAccount {
  id: string;
  profileKey: string;
  name: string;
  email: string | null;
  createdAt: number;
}

interface FileData {
  profiles?: Record<string, FileProfile>;
  accounts?: Record<string, FileAccount>;
  /** "provider:subject" → account id. */
  logins?: Record<string, string>;
  sessions?: Record<string, { accountId: string; expires: number }>;
}

/** Adds one profile's totals to another's; bests keep the better run and when and how it was set. */
function foldStats(from: FileProfile, into: FileProfile): void {
  const f = from.stats;
  const t = into.stats;
  t.runs += f.runs;
  t.kills += f.kills;
  t.headshots += f.headshots;
  t.limbsSevered += f.limbsSevered;
  t.timeSurvived += f.timeSurvived;
  if (f.bestSurvived > t.bestSurvived) {
    t.bestSurvived = f.bestSurvived;
    into.survivedMode = from.survivedMode;
    into.survivedAt = from.survivedAt;
  }
  if (f.bestKills > t.bestKills) {
    t.bestKills = f.bestKills;
    into.killsMode = from.killsMode;
    into.killsAt = from.killsAt;
  }
}

/**
 * Profiles, bests and accounts in a JSON file, rewritten a moment after each change. Fine for a
 * single server with a disk that persists; hosted servers should set DATABASE_URL instead.
 * Sign-in codes stay in memory (they last a minute).
 */
export class FileStore implements Store {
  readonly kind = 'file' as const;
  private readonly profiles = new Map<string, FileProfile>();
  private readonly accounts = new Map<string, FileAccount>();
  private readonly logins = new Map<string, string>();
  private readonly sessions = new Map<string, { accountId: string; expires: number }>();
  private readonly codes = new Map<string, { accountId: string; nonce: string; expires: number }>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly path: string) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as FileData;
      for (const [k, v] of Object.entries(data.profiles ?? {})) this.profiles.set(k, v);
      for (const [k, v] of Object.entries(data.accounts ?? {})) this.accounts.set(k, v);
      for (const [k, v] of Object.entries(data.logins ?? {})) this.logins.set(k, v);
      for (const [k, v] of Object.entries(data.sessions ?? {})) this.sessions.set(k, v);
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
    const now = Date.now();
    for (const [k, v] of this.sessions) if (v.expires < now) this.sessions.delete(k);
    const data: FileData = {
      profiles: Object.fromEntries(this.profiles), accounts: Object.fromEntries(this.accounts),
      logins: Object.fromEntries(this.logins), sessions: Object.fromEntries(this.sessions),
    };
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.path);
  }

  private signedIn = (): Set<string> => new Set([...this.accounts.values()].map((a) => a.profileKey));

  private rank(field: 'bestSurvived' | 'bestKills', value: number, except: string): number {
    let n = 1;
    for (const [k, p] of this.profiles) if (k !== except && p.stats[field] > value) n++;
    return n;
  }

  async placeRun(owner: string, survived: number, kills: number): Promise<Ranks> {
    const s = this.profiles.get(owner)?.stats;
    return {
      rankSurvival: s && survived > 0 && survived >= s.bestSurvived ? this.rank('bestSurvived', survived, owner) : null,
      rankKills: s && kills > 0 && kills >= s.bestKills ? this.rank('bestKills', kills, owner) : null,
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

  async getProfile(owner: string): Promise<Profile | null> {
    const p = this.profiles.get(owner);
    return p ? this.view(owner, p) : null;
  }

  async saveProfile(owner: string, data: ProfileData): Promise<Profile> {
    const p = this.ensure(owner, data);
    Object.assign(p, data, { updatedAt: Date.now() });
    this.schedule();
    return this.view(owner, p);
  }

  async recordRun(run: RunRecord): Promise<Ranks> {
    const p = this.ensure(run.owner, { name: run.name, appearance: run.appearance, primary: 'ar' });
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
    return this.placeRun(run.owner, run.survived, run.stats.kills);
  }

  async board(kind: BoardKind, limit: number): Promise<BoardEntry[]> {
    const field = kind === 'survival' ? 'bestSurvived' : 'bestKills';
    const signedIn = this.signedIn();
    return [...this.profiles.entries()]
      .filter(([, p]) => p.stats.runs > 0 && p.stats[field] > 0)
      .sort(([, a], [, b]) => b.stats[field] - a.stats[field] || (kind === 'survival' ? a.survivedAt - b.survivedAt : a.killsAt - b.killsAt))
      .slice(0, limit)
      .map(([k, p]) => ({
        name: p.name, value: p.stats[field],
        mode: kind === 'survival' ? p.survivedMode : p.killsMode, at: kind === 'survival' ? p.survivedAt : p.killsAt,
        signedIn: signedIn.has(k),
      }));
  }

  async mergeProfiles(from: string, into: string): Promise<void> {
    const src = this.profiles.get(from);
    if (!src || from === into) return;
    const dst = this.profiles.get(into);
    if (dst) foldStats(src, dst);
    else this.profiles.set(into, src);
    this.profiles.delete(from);
    this.schedule();
  }

  private accountView(a: FileAccount): Account {
    const providers = [...this.logins].filter(([, id]) => id === a.id).map(([k]) => k.split(':')[0]);
    return { ...a, providers: [...new Set(providers)].sort() };
  }

  async accountFor(who: Identity): Promise<Account> {
    const login = `${who.provider}:${who.subject}`;
    let a = this.accounts.get(this.logins.get(login) ?? '');
    if (!a && who.email) a = [...this.accounts.values()].find((x) => x.email === who.email);
    if (!a) {
      a = { id: newId(), profileKey: newProfileKey(), name: who.name, email: who.email, createdAt: Date.now() };
      this.accounts.set(a.id, a);
    }
    a.name = who.name || a.name;
    if (who.email && !a.email) a.email = who.email;
    this.logins.set(login, a.id);
    this.schedule();
    return this.accountView(a);
  }

  async getAccount(id: string): Promise<Account | null> {
    const a = this.accounts.get(id);
    return a ? this.accountView(a) : null;
  }

  async createSession(hash: string, accountId: string, expires: number): Promise<void> {
    this.sessions.set(hash, { accountId, expires });
    this.schedule();
  }

  async sessionAccount(hash: string): Promise<Account | null> {
    const s = this.sessions.get(hash);
    if (!s || s.expires < Date.now()) return null;
    return this.getAccount(s.accountId);
  }

  async deleteSession(hash: string): Promise<void> {
    if (this.sessions.delete(hash)) this.schedule();
  }

  async createLoginCode(hash: string, accountId: string, nonce: string, expires: number): Promise<void> {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expires < now) this.codes.delete(k);
    this.codes.set(hash, { accountId, nonce, expires });
  }

  async takeLoginCode(hash: string): Promise<{ accountId: string; nonce: string } | null> {
    const c = this.codes.get(hash);
    this.codes.delete(hash);
    return c && c.expires >= Date.now() ? { accountId: c.accountId, nonce: c.nonce } : null;
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
create table if not exists dh_accounts (
  id text primary key,
  profile_key text not null unique,
  name text not null default '',
  email text,
  created_at timestamptz not null default now()
);
create index if not exists dh_accounts_email on dh_accounts (email);
create table if not exists dh_logins (
  provider text not null,
  subject text not null,
  account_id text not null references dh_accounts (id) on delete cascade,
  primary key (provider, subject)
);
create table if not exists dh_sessions (
  hash text primary key,
  account_id text not null references dh_accounts (id) on delete cascade,
  expires_at timestamptz not null
);
create table if not exists dh_login_codes (
  hash text primary key,
  account_id text not null references dh_accounts (id) on delete cascade,
  nonce text not null,
  expires_at timestamptz not null
);
`;

interface AccountRow {
  id: string;
  profile_key: string;
  name: string;
  email: string | null;
  created_at: Date;
  providers: string[] | null;
}

const ACCOUNT_SELECT = `select a.*, (select array_agg(distinct l.provider order by l.provider) from dh_logins l where l.account_id = a.id) as providers
  from dh_accounts a`;

const accountOf = (r: AccountRow): Account => ({
  id: r.id, profileKey: r.profile_key, name: r.name, email: r.email, providers: r.providers ?? [], createdAt: r.created_at.getTime(),
});

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

  async getProfile(owner: string): Promise<Profile | null> {
    const r = await this.pool.query<ProfileRow>('select * from dh_profiles where key = $1', [owner]);
    return r.rows[0] ? this.view(r.rows[0]) : null;
  }

  async saveProfile(owner: string, data: ProfileData): Promise<Profile> {
    const r = await this.pool.query<ProfileRow>(
      `insert into dh_profiles (key, name, appearance, primary_weapon) values ($1, $2, $3, $4)
       on conflict (key) do update set name = excluded.name, appearance = excluded.appearance,
         primary_weapon = excluded.primary_weapon, updated_at = now()
       returning *`,
      [owner, data.name, data.appearance, data.primary],
    );
    return this.view(r.rows[0]);
  }

  async recordRun(run: RunRecord): Promise<Ranks> {
    const key = run.owner;
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
    return this.placeRun(key, run.survived, k);
  }

  async placeRun(key: string, survived: number, kills: number): Promise<Ranks> {
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
    const r = await this.pool.query<{ name: string; value: number; mode: RunMode; at: Date | null; signed_in: boolean }>(
      `select p.name, p.${value} as value, p.${mode} as mode, p.${at} as at,
              exists (select 1 from dh_accounts a where a.profile_key = p.key) as signed_in
       from dh_profiles p
       where p.runs > 0 and p.${value} > 0 order by p.${value} desc, p.${at} asc limit $1`,
      [limit],
    );
    return r.rows.map((x) => ({ name: x.name, value: Number(x.value), mode: x.mode, at: x.at ? x.at.getTime() : 0, signedIn: x.signed_in }));
  }

  async mergeProfiles(from: string, into: string): Promise<void> {
    if (from === into) return;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const src = await client.query<ProfileRow>('select * from dh_profiles where key = $1 for update', [from]);
      if (src.rows[0]) {
        const moved = await client.query('update dh_profiles set key = $2 where key = $1 and not exists (select 1 from dh_profiles where key = $2)', [from, into]);
        if (!moved.rowCount) {
          await client.query(
            `update dh_profiles d set
               runs = d.runs + s.runs, kills = d.kills + s.kills, headshots = d.headshots + s.headshots,
               limbs_severed = d.limbs_severed + s.limbs_severed, time_survived = d.time_survived + s.time_survived,
               best_survived_mode = case when s.best_survived > d.best_survived then s.best_survived_mode else d.best_survived_mode end,
               best_survived_at = case when s.best_survived > d.best_survived then s.best_survived_at else d.best_survived_at end,
               best_survived = greatest(d.best_survived, s.best_survived),
               best_kills_mode = case when s.best_kills > d.best_kills then s.best_kills_mode else d.best_kills_mode end,
               best_kills_at = case when s.best_kills > d.best_kills then s.best_kills_at else d.best_kills_at end,
               best_kills = greatest(d.best_kills, s.best_kills)
             from dh_profiles s where s.key = $1 and d.key = $2`,
            [from, into],
          );
          await client.query('delete from dh_profiles where key = $1', [from]);
        }
        await client.query('update dh_runs set key = $2 where key = $1', [from, into]);
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async accountFor(who: Identity): Promise<Account> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      let id = (await client.query<{ account_id: string }>('select account_id from dh_logins where provider = $1 and subject = $2', [who.provider, who.subject])).rows[0]?.account_id;
      if (!id && who.email) {
        id = (await client.query<{ id: string }>('select id from dh_accounts where email = $1 order by created_at limit 1', [who.email])).rows[0]?.id;
      }
      if (!id) {
        id = newId();
        await client.query('insert into dh_accounts (id, profile_key, name, email) values ($1, $2, $3, $4)', [id, newProfileKey(), who.name, who.email]);
      } else {
        await client.query(`update dh_accounts set name = case when $2 = '' then name else $2 end, email = coalesce(email, $3) where id = $1`, [id, who.name, who.email]);
      }
      await client.query(
        'insert into dh_logins (provider, subject, account_id) values ($1, $2, $3) on conflict (provider, subject) do nothing',
        [who.provider, who.subject, id],
      );
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
    const a = await this.getAccount((await this.pool.query<{ account_id: string }>('select account_id from dh_logins where provider = $1 and subject = $2', [who.provider, who.subject])).rows[0].account_id);
    return a!;
  }

  async getAccount(id: string): Promise<Account | null> {
    const r = await this.pool.query<AccountRow>(`${ACCOUNT_SELECT} where a.id = $1`, [id]);
    return r.rows[0] ? accountOf(r.rows[0]) : null;
  }

  async createSession(hash: string, accountId: string, expires: number): Promise<void> {
    await this.pool.query('delete from dh_sessions where expires_at < now()');
    await this.pool.query('insert into dh_sessions (hash, account_id, expires_at) values ($1, $2, $3)', [hash, accountId, new Date(expires)]);
  }

  async sessionAccount(hash: string): Promise<Account | null> {
    const r = await this.pool.query<AccountRow>(
      `${ACCOUNT_SELECT} join dh_sessions s on s.account_id = a.id where s.hash = $1 and s.expires_at > now()`, [hash],
    );
    return r.rows[0] ? accountOf(r.rows[0]) : null;
  }

  async deleteSession(hash: string): Promise<void> {
    await this.pool.query('delete from dh_sessions where hash = $1', [hash]);
  }

  async createLoginCode(hash: string, accountId: string, nonce: string, expires: number): Promise<void> {
    await this.pool.query('delete from dh_login_codes where expires_at < now()');
    await this.pool.query('insert into dh_login_codes (hash, account_id, nonce, expires_at) values ($1, $2, $3, $4)', [hash, accountId, nonce, new Date(expires)]);
  }

  async takeLoginCode(hash: string): Promise<{ accountId: string; nonce: string } | null> {
    const r = await this.pool.query<{ account_id: string; nonce: string }>(
      'delete from dh_login_codes where hash = $1 and expires_at > now() returning account_id, nonce', [hash],
    );
    return r.rows[0] ? { accountId: r.rows[0].account_id, nonce: r.rows[0].nonce } : null;
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
