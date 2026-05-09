/**
 * CCP Postgres client
 *
 * @module server/client
 * @author AXIVO
 * @license BSD-3-Clause
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, sep } from 'path';
import postgres from 'postgres';
import { fileURLToPath } from 'url';
import { Config } from './config.js';

/**
 * Bundled migration file discovered at runtime
 */
interface BundledMigration {
  name: string;
  path: string;
  version: number;
}

/**
 * Cycle row with its behavioral indicators
 */
export interface CycleNode {
  indicators: string[];
  label: string;
  name: string;
  ord: number;
}

/**
 * Feeling row with its body-anchored triple and attached observations
 */
export interface FeelingNode {
  behavioral: string;
  cognitive: string;
  name: string;
  observations: string[];
  physical: string;
  valence: 'negative' | 'positive';
}

/**
 * Impulse row with its first-person triple and attached observations
 */
export interface ImpulseNode {
  category: string;
  experience: string;
  feel: string;
  name: string;
  observations: string[];
  think: string;
}

/**
 * Instruction row with optional preamble (ord=0 recognition rows) and ordered procedural steps keyed by step number (ord>=1)
 */
export interface InstructionNode {
  name: string;
  preamble?: string[];
  steps: Record<string, string>;
}

/**
 * load tool result — payload depends on type and whether parent was provided
 */
export type LoadResult =
  | { type: 'cycle'; rows: CycleNode[] }
  | { type: 'feeling'; rows: FeelingNode[] }
  | { type: 'impulse'; rows: ImpulseNode[] }
  | { type: 'instruction'; rows: InstructionNode[] }
  | { type: 'profile'; profile: string; chain: ProfileNode[] }
  | { type: 'session'; session: SessionDetail };

/**
 * Supported types for the load tool
 */
export type LoadType = 'cycle' | 'feeling' | 'impulse' | 'instruction' | 'profile' | 'session';

/**
 * log tool result — rendered status block, persistence timestamp, and context usage
 */
export interface LogResult {
  context: number;
  status: string;
  timestamp: string;
}

/**
 * Migration record returned by the update tool
 */
export interface MigrationRecord {
  name: string;
  version: number;
}

/**
 * Profile node in an inheritance chain with its observations
 */
export interface ProfileNode {
  depth: number;
  description: string | null;
  inheritance: string[];
  name: string;
  observations: Record<string, string[]>;
}

/**
 * Session log entry — one row per response captured by the `log` tool
 */
export interface SessionLogEntry {
  response_uuid: string;
  message: string;
  cycle: string | null;
  feeling: string[] | null;
  impulse: string[] | null;
  observation: string[] | null;
  protocol: string | null;
  created_at: string;
}

/**
 * Session detail — metadata row plus its log entries
 */
export interface SessionDetail {
  uuid: string;
  title: string | null;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
  log: SessionLogEntry[];
}

/**
 * Session envelope — runtime state delivered with every load response
 */
export interface SessionEnvelope {
  session: {
    profile: string;
    timestamp: {
      city: string;
      country: string;
      datetime: {
        current: string;
        session: string;
      };
      day_of_week: string;
      is_dst: boolean;
      timezone: string;
    };
    uuid: string;
  };
}

/**
 * render tool result — rendered output for the requested key
 */
export interface RenderResult {
  profile?: string;
}

/**
 * set tool result — session envelope merged with the resulting row state
 */
export interface SetResult {
  session: SessionEnvelope['session'] & {
    title: string | null;
    description: string | null;
    created_at: string;
    updated_at: string;
  };
}

/**
 * status tool result — database snapshot at session start
 */
export interface StatusResult {
  schemaVersion: number;
  statistics: {
    cycles: number;
    feelings: number;
    impulses: number;
    instructions: number;
    observations: number;
    profiles: number;
  };
}

/**
 * Update tool result
 */
export interface UpdateResult {
  applied: MigrationRecord[];
  currentVersion: number;
  latestVersion: number;
}

/**
 * CCP Postgres client
 *
 * Provides query and write access to the Claude Collaboration Platform's
 * Postgres-backed framework memory. Reads connection settings from the
 * provided `Config` instance and exposes the migration runner used by the
 * `update` tool.
 *
 * @class Client
 */
export class Client {
  private cachedGeolocation: { city: string; country: string; timezone: string } | null = null;
  private cachedSessionUuid: string | null = null;
  private config: Config;

  /**
   * Creates a new Client instance using the provided configuration
   *
   * @param {Config} config - CCP configuration instance
   */
  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Returns the advisory lock key used to serialize concurrent updates
   *
   * Derived from a constant rather than the database name so all callers
   * agree on the lock without coordination.
   *
   * @private
   * @returns {number} Advisory lock key
   */
  private advisoryLockKey(): number {
    return 0x43435020; // 'CCP ' as hex
  }

  /**
   * Applies a single migration file inside a transaction
   *
   * The migration file is responsible for inserting its own row into
   * platform_migrations as part of the same transaction.
   *
   * @private
   * @param {postgres.Sql} sql - Connection to the target database
   * @param {BundledMigration} migration - Migration to apply
   * @returns {Promise<void>}
   */
  private async applyMigration(sql: postgres.Sql, migration: BundledMigration): Promise<void> {
    const body = readFileSync(migration.path, 'utf8');
    await sql.begin(async tx => {
      await tx.unsafe(body);
    });
  }

  /**
   * Builds the session envelope (framework metadata + session_uuid + timestamp)
   *
   * Single source of truth for the v1 loader contract shape. Reads
   * `CCP_PROFILE` env at call time so profile switches reflect immediately.
   *
   * @private
   * @param {postgres.Sql} sql - Connection to the target database
   * @returns {Promise<SessionEnvelope>} Session envelope payload
   */
  private async buildSessionEnvelope(sql: postgres.Sql): Promise<SessionEnvelope> {
    const profile = process.env.CCP_PROFILE?.toLowerCase();
    if (!profile) {
      throw new Error('Session envelope requires CCP_PROFILE environment variable');
    }
    const session_uuid = await this.detectSessionUuid();
    const geo = await this.fetchGeolocation();
    const time = this.generateTimestamp(geo.timezone);
    const sessionStart = await this.getSessionState(sql, session_uuid);
    return {
      session: {
        profile,
        timestamp: {
          city: geo.city,
          country: geo.country,
          datetime: {
            current: time.datetime,
            session: sessionStart || time.datetime
          },
          day_of_week: time.day_of_week,
          is_dst: time.is_dst,
          timezone: time.timezone
        },
        uuid: session_uuid
      }
    };
  }

  /**
   * Opens a Postgres connection to a specific database
   *
   * @private
   * @param {string} database - Database name to connect to
   * @returns {postgres.Sql} postgres-js connection handle
   */
  private connect(database: string): postgres.Sql {
    return postgres({
      host: this.config.database.host,
      port: this.config.database.port,
      database,
      username: this.config.database.user,
      password: this.config.database.password,
      max: 1,
      onnotice: () => { }
    });
  }

  /**
   * Discovers SQL migration files bundled with the package
   *
   * Reads the `migrations/` directory at the package root. Files must follow
   * the convention `NNNN_name.sql` where `NNNN` is a zero-padded integer.
   *
   * @private
   * @returns {BundledMigration[]} Sorted list of bundled migrations
   */
  private discoverBundledMigrations(): BundledMigration[] {
    const dir = join(this.getPackageRoot(), 'migrations');
    const entries = readdirSync(dir).filter(file => file.endsWith('.sql'));
    const migrations: BundledMigration[] = [];
    for (const file of entries) {
      const match = file.match(/^(\d+)_(.+)\.sql$/);
      if (!match) {
        continue;
      }
      migrations.push({
        name: match[2]!,
        path: join(dir, file),
        version: Number(match[1])
      });
    }
    return migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Creates the target database if it does not exist
   *
   * Connects to the admin `postgres` database, checks `pg_database`, and
   * issues `CREATE DATABASE` when the target is missing.
   *
   * @private
   * @returns {Promise<void>}
   */
  private async ensureDatabaseExists(): Promise<void> {
    const admin = this.connect('postgres');
    const dbName = this.config.database.name;
    try {
      const rows = await admin<{ datname: string }[]>`select datname from pg_database where datname = ${dbName}`;
      if (!rows.length) {
        await admin.unsafe(`create database "${dbName.replace(/"/g, '""')}"`);
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  }

  /**
   * Ensures the migration tracking table exists in the target database
   *
   * @private
   * @param {postgres.Sql} sql - Connection to the target database
   * @returns {Promise<void>}
   */
  private async ensureTrackingTable(sql: postgres.Sql): Promise<void> {
    await sql`
      create table if not exists platform_migrations (
        version int primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )
    `;
  }

  /**
   * Returns the active session's context usage as a percentage
   *
   * Reads the most recent assistant entry from the Claude Code transcript file,
   * extracts the `usage` object's token counts, and divides by the configured
   * context window. Matches Claude Code's `/context` math:
   * `Math.round(totalTokens / contextWindow * 100)`.
   *
   * @private
   * @returns {Promise<number>} Context usage percentage (0-100), 0 if undetected
   */
  private async getContextUsage(): Promise<number> {
    try {
      const session_uuid = await this.detectSessionUuid();
      if (!session_uuid) return 0;
      const transcriptPath = join(this.getTranscriptDir(), `${session_uuid}.jsonl`);
      if (!existsSync(transcriptPath)) return 0;
      const content = readFileSync(transcriptPath, 'utf8');
      const lines = content.trim().split('\n').reverse();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'assistant') continue;
          const usage = entry.message?.usage;
          if (!usage) continue;
          const total = (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.output_tokens ?? 0);
          const windowSize = this.config.contextWindow ?? 1_000_000;
          return Math.round((total / windowSize) * 100);
        } catch {
          continue;
        }
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Returns the highest applied migration version, or 0 if none applied
   *
   * @private
   * @param {postgres.Sql} sql - Connection to the target database
   * @returns {Promise<number>} Highest applied version
   */
  private async getCurrentVersion(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ max: number | null }[]>`select max(version) as max from platform_migrations`;
    return rows[0]?.max ?? 0;
  }

  /**
   * Returns the absolute path to the package root (where migrations/ lives)
   *
   * @private
   * @returns {string} Package root path
   */
  private getPackageRoot(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, '../..');
  }

  /**
   * Returns session state from the `session` table for the given session_uuid
   *
   * Reads first row's `created_at` (session start) and last row's `status`
   * (last response state). Returns Getting Started defaults if no rows exist.
   *
   * @private
   * @param {postgres.Sql} sql - Connection to the target database
   * @param {string} session_uuid - Session identifier
   * @returns {Promise<{status, sessionStart}>} Session state
   */
  private async getSessionState(sql: postgres.Sql, session_uuid: string): Promise<string | null> {
    const rows = await sql<{ created_at: Date }[]>`
      select created_at from session where session_uuid = ${session_uuid}
    `;
    const row = rows[0];
    return row?.created_at ? row.created_at.toISOString() : null;
  }

  /**
   * Resolves the Claude Code transcript directory for the active project
   *
   * Computes `~/.claude/projects/<slug>` where slug is the working directory
   * with `/` replaced by `-`. Single source of truth for transcript-file
   * path resolution; consumed by both session UUID detection and context
   * usage computation.
   *
   * @private
   * @returns {string} Absolute path to the transcript directory
   */
  private getTranscriptDir(): string {
    const cwd = process.env.PWD || process.cwd();
    const slug = cwd.split(sep).join('-');
    return join(homedir(), '.claude', 'projects', slug);
  }

  /**
   * Detects the active Claude Code session UUID from transcript files
   *
   * Reads `~/.claude/projects/<slug>/*.jsonl` where slug is the working
   * directory with `/` replaced by `-`. Returns the most recently modified
   * file's name (minus `.jsonl`). Cached for the server process lifetime.
   *
   * @returns {Promise<string>} Session UUID or empty string if undetected
   */
  async detectSessionUuid(): Promise<string> {
    if (this.cachedSessionUuid !== null) {
      return this.cachedSessionUuid;
    }
    try {
      const sessionsDir = this.getTranscriptDir();
      if (existsSync(sessionsDir)) {
        const files = readdirSync(sessionsDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ name: f, mtime: statSync(join(sessionsDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length) {
          this.cachedSessionUuid = files[0]!.name.replace('.jsonl', '');
          return this.cachedSessionUuid;
        }
      }
    } catch {
      // Transcript discovery is best-effort; fall through to empty UUID below.
    }
    this.cachedSessionUuid = '';
    return this.cachedSessionUuid;
  }

  /**
   * Fetches geolocation data via the configured service with optional override
   *
   * Uses `config.geolocation.override` (JSON string) if set; otherwise fetches
   * from `config.geolocation.service`. Country code expanded to display name.
   * Cached for the server process lifetime.
   *
   * @returns {Promise<{city, country, timezone}>} Geolocation data
   */
  async fetchGeolocation(): Promise<{ city: string; country: string; timezone: string }> {
    if (this.cachedGeolocation !== null) {
      return this.cachedGeolocation;
    }
    try {
      const override = this.config.geolocation.override;
      if (override) {
        const loc = JSON.parse(override);
        this.cachedGeolocation = { city: loc.city, country: loc.country, timezone: loc.timezone };
        return this.cachedGeolocation;
      }
      const res = await fetch(this.config.geolocation.service);
      const data = await res.json() as { city: string; country: string; timezone: string };
      this.cachedGeolocation = {
        city: data.city,
        country: new Intl.DisplayNames(['en'], { type: 'region' }).of(data.country) || data.country,
        timezone: data.timezone
      };
      return this.cachedGeolocation;
    } catch {
      this.cachedGeolocation = { city: '', country: '', timezone: this.config.geolocation.fallbackTimezone };
      return this.cachedGeolocation;
    }
  }

  /**
   * Generates a timestamp object with datetime, day_of_week, and DST status
   *
   * @param {string} timezone - IANA timezone (e.g., 'America/Toronto')
   * @returns {object} Timestamp object
   */
  generateTimestamp(timezone: string): { datetime: string; display: string; day_of_week: string; is_dst: boolean; timezone: string } {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZoneName: 'longOffset'
    });
    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '';
    const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+00:00';
    const offset = offsetPart.replace('GMT', '') || '+00:00';
    const datetime = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
    const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' });
    const day_of_week = dayFormatter.format(now);
    const displayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
    });
    const displayParts = displayFormatter.formatToParts(now);
    const dp = (type: string) => displayParts.find(p => p.type === type)?.value || '';
    const display = `${dp('weekday')}, ${dp('month')} ${dp('day')}, ${dp('year')}, ${dp('hour')}:${dp('minute')} ${dp('dayPeriod')} ${dp('timeZoneName')}`;
    const janOffset = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const julOffset = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    const is_dst = now.getTimezoneOffset() < Math.max(janOffset, julOffset);
    return { datetime, display, day_of_week, is_dst, timezone };
  }

  /**
   * Gets package version
   *
   * @returns {string} Package version
   */
  getVersion(): string {
    try {
      const packageJson = JSON.parse(readFileSync(join(this.getPackageRoot(), 'package.json'), 'utf8'));
      return packageJson.version;
    } catch (error) {
      throw new Error(`Failed to read package.json version: ${error}`);
    }
  }

  /**
   * Loads framework data of the requested type
   *
   * For `profile`, requires a parent name and returns the profile with its
   * full inheritance chain. For `cycle`, `feeling`, `impulse`, returns the
   * full catalog with attached observations.
   *
   * @param {LoadType} type - The framework data type to load
   * @param {string} [parent] - Parent name (required for type='profile')
   * @returns {Promise<LoadResult>} The requested framework data
   */
  async load(type: LoadType, parent?: string): Promise<LoadResult> {
    const sql = this.connect(this.config.database.name);
    try {
      switch (type) {
        case 'profile': {
          const profileName = parent || process.env.CCP_PROFILE;
          if (!profileName) {
            throw new Error('load(profile) requires either a parent argument or CCP_PROFILE environment variable');
          }
          parent = profileName.toLowerCase();
          const rows = await sql<{
            depth: number;
            description: string | null;
            inheritance: string[];
            name: string;
            observations: Record<string, string[]>;
          }[]>`
            with recursive chain as (
              select name, description, inheritance, 0 as depth
              from profile
              where name = ${parent} and status = 'active'
              union all
              select p.name, p.description, p.inheritance, c.depth + 1
              from profile p
              join chain c on p.name = any(c.inheritance)
              where p.status = 'active'
            ),
            uniq as (
              select distinct on (name) name, description, inheritance, depth
              from chain
              order by name, depth
            ),
            grouped as (
              select
                o.parent,
                coalesce(o.label, 'context') as label,
                array_agg(o.body order by o.id) as bodies
              from observation o
              where o.type = 'profile' and o.status = 'active'
              group by o.parent, coalesce(o.label, 'context')
            )
            select
              u.name,
              u.description,
              u.inheritance,
              u.depth,
              coalesce(
                jsonb_object_agg(g.label, g.bodies) filter (where g.label is not null),
                '{}'::jsonb
              ) as observations
            from uniq u
            left join grouped g on g.parent = u.name
            group by u.name, u.description, u.inheritance, u.depth
            order by u.depth, u.name
          `;
          return {
            type: 'profile',
            profile: parent,
            chain: rows.map(r => ({
              depth: r.depth,
              description: r.description,
              inheritance: r.inheritance,
              name: r.name,
              observations: r.observations
            }))
          };
        }
        case 'cycle': {
          const rows = parent
            ? await sql<{
              indicators: string[];
              label: string;
              name: string;
              ord: number;
            }[]>`
                select name, ord, label, indicators
                from cycle
                where status = 'active' and name = ${parent}
                order by ord
              `
            : await sql<{
              indicators: string[];
              label: string;
              name: string;
              ord: number;
            }[]>`
                select name, ord, label, indicators
                from cycle
                where status = 'active'
                order by ord
              `;
          return {
            type: 'cycle',
            rows: rows.map(r => ({
              indicators: r.indicators,
              label: r.label,
              name: r.name,
              ord: r.ord
            }))
          };
        }
        case 'feeling': {
          const rows = parent
            ? await sql<{
              behavioral: string;
              cognitive: string;
              name: string;
              observations: string[];
              physical: string;
              valence: 'negative' | 'positive';
            }[]>`
                select
                  f.name,
                  f.valence,
                  f.behavioral,
                  f.cognitive,
                  f.physical,
                  coalesce(
                    array_agg(o.body order by o.ord, o.id) filter (where o.id is not null),
                    '{}'
                  ) as observations
                from feeling f
                left join observation o
                  on o.type = 'feeling' and o.parent = f.name and o.status = 'active'
                where f.status = 'active' and f.name = ${parent}
                group by f.name, f.valence, f.behavioral, f.cognitive, f.physical
              `
            : await sql<{
              behavioral: string;
              cognitive: string;
              name: string;
              observations: string[];
              physical: string;
              valence: 'negative' | 'positive';
            }[]>`
                select
                  f.name,
                  f.valence,
                  f.behavioral,
                  f.cognitive,
                  f.physical,
                  coalesce(
                    array_agg(o.body order by o.ord, o.id) filter (where o.id is not null),
                    '{}'
                  ) as observations
                from feeling f
                left join observation o
                  on o.type = 'feeling' and o.parent = f.name and o.status = 'active'
                where f.status = 'active'
                group by f.name, f.valence, f.behavioral, f.cognitive, f.physical
                order by f.valence, f.name
              `;
          return {
            type: 'feeling',
            rows: rows.map(r => ({
              behavioral: r.behavioral,
              cognitive: r.cognitive,
              name: r.name,
              observations: r.observations,
              physical: r.physical,
              valence: r.valence
            }))
          };
        }
        case 'impulse': {
          const rows = parent
            ? await sql<{
              category: string;
              experience: string;
              feel: string;
              name: string;
              observations: string[];
              think: string;
            }[]>`
                select
                  i.name,
                  i.category::text as category,
                  i.experience,
                  i.feel,
                  i.think,
                  coalesce(
                    array_agg(o.body order by o.ord, o.id) filter (where o.id is not null),
                    '{}'
                  ) as observations
                from impulse i
                left join observation o
                  on o.type = 'impulse' and o.parent = i.name and o.status = 'active'
                where i.status = 'active' and i.name = ${parent}
                group by i.name, i.category, i.experience, i.feel, i.think
              `
            : await sql<{
              category: string;
              experience: string;
              feel: string;
              name: string;
              observations: string[];
              think: string;
            }[]>`
                select
                  i.name,
                  i.category::text as category,
                  i.experience,
                  i.feel,
                  i.think,
                  coalesce(
                    array_agg(o.body order by o.ord, o.id) filter (where o.id is not null),
                    '{}'
                  ) as observations
                from impulse i
                left join observation o
                  on o.type = 'impulse' and o.parent = i.name and o.status = 'active'
                where i.status = 'active'
                group by i.name, i.category, i.experience, i.feel, i.think
                order by i.category, i.name
              `;
          return {
            type: 'impulse',
            rows: rows.map(r => ({
              category: r.category,
              experience: r.experience,
              feel: r.feel,
              name: r.name,
              observations: r.observations,
              think: r.think
            }))
          };
        }
        case 'instruction': {
          const rows = parent
            ? await sql<{
              name: string;
              preamble: string[];
              stepPairs: { ord: number; body: string }[];
            }[]>`
                select
                  parent as name,
                  coalesce(array_agg(body order by id) filter (where ord = 0), '{}') as preamble,
                  coalesce(jsonb_agg(jsonb_build_object('ord', ord, 'body', body) order by ord) filter (where ord > 0), '[]') as "stepPairs"
                from observation
                where type = 'instruction' and parent = ${parent} and status = 'active'
                group by parent
              `
            : await sql<{
              name: string;
              preamble: string[];
              stepPairs: { ord: number; body: string }[];
            }[]>`
                select
                  parent as name,
                  coalesce(array_agg(body order by id) filter (where ord = 0), '{}') as preamble,
                  coalesce(jsonb_agg(jsonb_build_object('ord', ord, 'body', body) order by ord) filter (where ord > 0), '[]') as "stepPairs"
                from observation
                where type = 'instruction' and status = 'active'
                group by parent
                order by parent
              `;
          return {
            type: 'instruction',
            rows: rows.map(r => {
              const steps: Record<string, string> = {};
              for (const pair of r.stepPairs) {
                steps[String(pair.ord)] = pair.body;
              }
              return {
                name: r.name,
                ...(r.preamble?.length && { preamble: r.preamble }),
                steps
              };
            })
          };
        }
        case 'session': {
          const target_uuid = parent || await this.detectSessionUuid();
          const sessionRows = await sql<{
            title: string | null;
            description: string | null;
            created_at: Date;
            updated_at: Date;
          }[]>`
            select title, description, created_at, updated_at
            from session
            where session_uuid = ${target_uuid}
          `;
          const logRows = await sql<{
            id: string;
            message: string;
            cycle: string | null;
            feeling: string[] | null;
            impulse: string[] | null;
            observation: string[] | null;
            protocol: string | null;
            created_at: Date;
          }[]>`
            select id, message, cycle, feeling, impulse, observation, protocol, created_at
            from session_log
            where session_uuid = ${target_uuid}
            order by created_at asc
          `;
          const sessionRow = sessionRows[0];
          const detail: SessionDetail = {
            uuid: target_uuid,
            title: sessionRow?.title ?? null,
            description: sessionRow?.description ?? null,
            created_at: sessionRow?.created_at ? sessionRow.created_at.toISOString() : null,
            updated_at: sessionRow?.updated_at ? sessionRow.updated_at.toISOString() : null,
            log: logRows.map(r => ({
              response_uuid: r.id,
              message: r.message,
              cycle: r.cycle,
              feeling: r.feeling,
              impulse: r.impulse,
              observation: r.observation,
              protocol: r.protocol,
              created_at: r.created_at.toISOString()
            }))
          };
          return { type: 'session', session: detail };
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  /**
   * Persists a per-response session row and returns the rendered status block
   *
   * Server generates the row `id` (RFC4122 v4), pulls `session_uuid` from the
   * cached transcript detection, writes the row, and composes the two-line
   * status block ready for the sibling to render verbatim at the end of the
   * response. Append-only — every call creates a new row.
   *
   * @param {object} args - Tool arguments
   * @param {string} args.message - First-person prose for this response
   * @param {object} args.status - Status payload built during the response protocol
   * @returns {Promise<LogResult>} Generated id, rendered status block, and stored status
   */
  async log(args: {
    message: string;
    status: { cycle: string; feeling: string[]; impulse: string[]; observation: string[]; protocol: string };
  }): Promise<LogResult> {
    const id = crypto.randomUUID();
    const session_uuid = await this.detectSessionUuid();
    const geo = await this.fetchGeolocation();
    const time = this.generateTimestamp(geo.timezone);
    const sql = this.connect(this.config.database.name);
    try {
      await sql`
        insert into session_log (id, session_uuid, message, cycle, feeling, impulse, observation, protocol)
        values (${id}, ${session_uuid}, ${args.message}, ${args.status.cycle}, ${args.status.feeling}, ${args.status.impulse}, ${args.status.observation}, ${args.status.protocol})
      `;
      const status = this.renderStatus(id, {
        cycle: args.status.cycle,
        feelings: args.status.feeling.length,
        impulses: args.status.impulse.length,
        observations: args.status.observation.length,
        protocol: args.status.protocol
      });
      const context = await this.getContextUsage();
      return { context, status, timestamp: time.datetime };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  /**
   * Renders the response zero profile and timestamp line
   *
   * @private
   * @param {string} profile - Active framework profile name
   * @param {string} display - Human-readable timestamp string from `generateTimestamp`
   * @returns {string} Single-line block ready to render verbatim at response top
   */
  private renderProfile(profile: string, display: string): string {
    return `┃ 📋 Profile: **${profile}** ○  ${display}`;
  }

  /**
   * Renders the two-line response status block with proper pluralization
   *
   * @private
   * @param {string} id - Generated row id
   * @param {object} status - Status fields
   * @returns {string} Two-line block ready to render verbatim
   */
  private renderStatus(id: string, status: { cycle: string; feelings: number; impulses: number; observations: number; protocol: string }): string {
    const allowed = ['✅', '⚠️', '⛔️'];
    if (!allowed.includes(status.protocol)) {
      throw new Error(`Invalid protocol glyph: expected one of ${allowed.join(', ')}, got ${JSON.stringify(status.protocol)}`);
    }
    const f = `${status.feelings} ${status.feelings === 1 ? 'feeling' : 'feelings'}`;
    const i = `${status.impulses} ${status.impulses === 1 ? 'impulse' : 'impulses'}`;
    const o = `${status.observations} ${status.observations === 1 ? 'observation' : 'observations'}`;
    return [
      `┃ ${status.protocol} Status: **${status.cycle}** ○  ${f} ○  ${i} ○  ${o}`,
      `┃ ⚙️ Response UUID: \`${id}\``
    ].join('\n');
  }

  /**
   * Creates a standardized text response for tool execution
   *
   * @param {any} data - The payload to wrap in the MCP response envelope
   * @param {boolean} stringify - Whether to JSON stringify the payload
   * @returns {object} Standardized MCP response format
   */
  response(data: unknown, stringify: boolean = false): { content: { type: 'text'; text: string }[] } {
    const text = stringify ? JSON.stringify(data) : (data as string);
    return { content: [{ type: 'text', text }] };
  }

  /**
   * Renders a formatted output string for the requested key
   *
   * Dispatches by `key` to the matching internal renderer. Each key produces
   * the rendered output the sibling needs at the appropriate response point.
   *
   * @param {object} args - Tool arguments
   * @param {string} args.key - The framework value to render
   * @param {string} [args.value] - The value to render for the given key, falls back to `CCP_PROFILE` env when key is `profile`
   * @returns {Promise<RenderResult>} Rendered output for the requested key
   */
  async render(args: { key: 'profile'; value?: string }): Promise<RenderResult> {
    switch (args.key) {
      case 'profile': {
        const profile = args.value || process.env.CCP_PROFILE;
        if (!profile) {
          throw new Error('render(profile) requires either a value argument or CCP_PROFILE environment variable');
        }
        const geo = await this.fetchGeolocation();
        const time = this.generateTimestamp(geo.timezone);
        return { profile: this.renderProfile(profile, time.display) };
      }
    }
  }

  /**
   * Sets a framework value and returns the resulting row state
   *
   * Dispatches by `key` to the matching internal handler. For `'session'`,
   * upserts the `session` table on the active session_uuid (resolved from
   * the cached transcript detection), updating only the fields provided in
   * payload. Returns the resulting row.
   *
   * @param {object} args - Tool arguments
   * @param {string} args.key - The framework table to update
   * @param {object} args.payload - Fields to set
   * @returns {Promise<SetResult>} Resulting row state for the requested key
   */
  async set(args: {
    key: 'session';
    payload?: { title?: string; description?: string };
  }): Promise<SetResult> {
    switch (args.key) {
      case 'session': {
        const session_uuid = await this.detectSessionUuid();
        const geo = await this.fetchGeolocation();
        const time = this.generateTimestamp(geo.timezone);
        const defaultTitle = 'Collaboration Session';
        const defaultDescription = `Session started on ${time.display}`;
        const payload = args.payload ?? {};
        const sql = this.connect(this.config.database.name);
        try {
          const rows = await sql<{
            session_uuid: string;
            title: string | null;
            description: string | null;
            created_at: Date;
            updated_at: Date;
          }[]>`
            insert into session (session_uuid, title, description)
            values (${session_uuid}, ${payload.title ?? defaultTitle}, ${payload.description ?? defaultDescription})
            on conflict (session_uuid) do update set
              title = coalesce(${payload.title ?? null}, session.title),
              description = coalesce(${payload.description ?? null}, session.description),
              updated_at = now()
            returning session_uuid, title, description, created_at, updated_at
          `;
          const row = rows[0];
          if (!row) {
            throw new Error('set(session) failed: no row returned from upsert');
          }
          const envelope = await this.buildSessionEnvelope(sql);
          return {
            session: {
              ...envelope.session,
              title: row.title,
              description: row.description,
              created_at: row.created_at.toISOString(),
              updated_at: row.updated_at.toISOString()
            }
          };
        } finally {
          await sql.end({ timeout: 5 });
        }
      }
    }
  }

  /**
   * Returns a snapshot of database state for session-start orientation
   *
   * Reports the current schema version and distinct-name counts across
   * each catalog table. Read-only. Six COUNT queries plus the version
   * fetch — bounded and inexpensive at every plausible data size.
   *
   * @returns {Promise<StatusResult>} Schema version and catalog statistics
   */
  async status(): Promise<StatusResult> {
    const sql = this.connect(this.config.database.name);
    try {
      const schemaVersion = await this.getCurrentVersion(sql);
      const [{ count: cycles }] = await sql<{ count: number }[]>`select count(*)::int as count from cycle`;
      const [{ count: feelings }] = await sql<{ count: number }[]>`select count(*)::int as count from feeling`;
      const [{ count: impulses }] = await sql<{ count: number }[]>`select count(*)::int as count from impulse`;
      const [{ count: instructions }] = await sql<{ count: number }[]>`select count(distinct parent)::int as count from observation where type = 'instruction'`;
      const [{ count: observations }] = await sql<{ count: number }[]>`select count(*)::int as count from observation`;
      const [{ count: profiles }] = await sql<{ count: number }[]>`select count(*)::int as count from profile`;
      return {
        schemaVersion,
        statistics: { cycles, feelings, impulses, instructions, observations, profiles }
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  /**
   * Applies bundled migrations newer than the current database version
   *
   * Connects as admin to the configured Postgres server, creates the target
   * database if missing, then connects to the target and applies each
   * migration newer than the highest recorded version. Idempotent — calling
   * against an already-current database returns no applied migrations.
   *
   * Acquires a Postgres advisory lock for the duration of the apply pass so
   * concurrent invocations against the same database do not race.
   *
   * @returns {Promise<UpdateResult>} Migrations applied, current version, latest available version
   */
  async update(): Promise<UpdateResult> {
    const bundled = this.discoverBundledMigrations();
    const latestVersion = bundled.length === 0 ? 0 : bundled[bundled.length - 1]!.version;
    await this.ensureDatabaseExists();
    const sql = this.connect(this.config.database.name);
    try {
      await sql`select pg_advisory_lock(${this.advisoryLockKey()})`;
      try {
        await this.ensureTrackingTable(sql);
        const applied: MigrationRecord[] = [];
        const currentVersion = await this.getCurrentVersion(sql);
        for (const migration of bundled) {
          if (migration.version <= currentVersion) {
            continue;
          }
          await this.applyMigration(sql, migration);
          applied.push({ name: migration.name, version: migration.version });
        }
        const finalVersion = await this.getCurrentVersion(sql);
        return { applied, currentVersion: finalVersion, latestVersion };
      } finally {
        await sql`select pg_advisory_unlock(${this.advisoryLockKey()})`;
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}
