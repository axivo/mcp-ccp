/**
 * CCP Postgres client
 *
 * @module server/client
 * @author AXIVO
 * @license BSD-3-Clause
 */

import { Readability } from '@mozilla/readability';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { JSDOM } from 'jsdom';
import { homedir } from 'os';
import { dirname, join, sep } from 'path';
import postgres from 'postgres';
import TurndownService from 'turndown';
import { fileURLToPath } from 'url';
import { Time } from '../lib/time.js';
import { Config } from './config.js';

/**
 * Bundled migration file discovered at runtime
 */
interface BundledMigration {
  name: string;
  path: string;
  version: number;
}

interface BundledRepeatable {
  name: string;
  path: string;
}

/**
 * browse tool result, readable content extracted from a fetched URL
 */
export interface BrowseResult {
  byline: string | null;
  content: string;
  excerpt: string | null;
  fetchedAt: string;
  language: string | null;
  length: number;
  publishedAt: string | null;
  title: string | null;
  url: string;
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
 * load tool result, payload depends on type and whether parent was provided
 */
export type LoadResult =
  | { rows: CycleNode[] }
  | { rows: FeelingNode[] }
  | { rows: ImpulseNode[] }
  | { rows: InstructionNode[] }
  | { profile: string; chain: ProfileNode[] }
  | { session: SessionDetail };

/**
 * Supported types for the load tool
 */
export type LoadType = 'cycle' | 'feeling' | 'impulse' | 'instruction' | 'profile' | 'session';

/**
 * log tool result, sibling-facing payload plus persistence timestamp
 */
export interface LogResult {
  payload: {
    context: number;
    reminder: string | {
      preamble: string[];
      steps: Record<string, string>;
      metrics: Record<string, number | string | string[]>;
    };
    status: string;
    tokens: {
      total: number;
      used: number;
    };
  };
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
 * render tool result, rendered output for the requested key
 */
export interface RenderResult {
  profile?: string;
}

/**
 * Session detail, metadata row plus payload envelope with log slice and total
 */
export interface SessionDetail {
  profile: string;
  timestamp: {
    city: string;
    country: string;
    current: string;
    is_dst: boolean;
    session: string;
    timezone: string;
  };
  uuid: string;
  title: string | null;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
  payload: {
    log: SessionLogEntry[];
    messages: number;
  };
}

/**
 * Session envelope, runtime state delivered with every load response
 */
export interface SessionEnvelope {
  session: {
    profile: string;
    timestamp: {
      city: string;
      country: string;
      current: string;
      is_dst: boolean;
      session: string;
      timezone: string;
    };
    uuid: string;
  };
}

/**
 * Session log entry, one row per response captured by the `log` tool
 */
export interface SessionLogEntry {
  created_at: string;
  cycle: string | null;
  feeling: string[] | null;
  impulse: string[] | null;
  message: string;
  observation: string[] | null;
  protocol: 'bypassed' | 'partial' | 'successful';
  response_uuid: string;
}

/**
 * set tool result, session envelope merged with the resulting row state
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
 * status tool result, database snapshot at session start
 */
export interface StatusResult {
  cycles: { name: string; label: string }[];
  schemaVersion: number;
  statistics: {
    cycles: number;
    feelings: number;
    impulses: number;
    instructions: number;
    observations: Record<string, number>;
    profiles: number;
  };
  payload: {
    context: number;
    tokens: {
      total: number;
      used: number;
    };
  };
  upstream: UpstreamStatus | null;
}

/**
 * Upstream platform health snapshot from status.claude.com
 *
 * Mirrors the Anthropic status page summary endpoint shape. `page` carries
 * the status page metadata (name, url, last update timestamp). `status`
 * carries the global platform indicator. `incidents` and `scheduled_maintenances`
 * appear only when populated, so their presence indicates something active
 * worth following via the browse tool using the carried URL.
 */
export interface UpstreamStatus {
  incidents?: { impact: string; name: string; status: string; url: string }[];
  page: { name: string; updated_at: string; url: string };
  scheduled_maintenances?: { impact: string; name: string; status: string; url: string }[];
  status: { description: string; indicator: 'critical' | 'major' | 'minor' | 'none' };
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
    return 0x43435020;
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
   * Builds a structured reminder body for the given reminder label
   *
   * Queries the `observation` table for rows under `type='payload',
   * parent=<parent>, label=<label>`, groups them into preamble (ord=0) and
   * steps (ord>=1), applies placeholder substitution, and attaches the
   * caller-supplied metrics. Reusable across any payload kind (today:
   * `reminder`, future: greetings, compaction notices, etc.).
   *
   * @private
   * @param {postgres.Sql} sql - Active connection
   * @param {string} parent - Payload kind grouping (e.g., 'reminder')
   * @param {string} label - Specific message identifier within the parent
   * @param {Record<string, number | string | string[]>} metrics - Caller-supplied evidence
   * @returns {Promise<{preamble: string[]; steps: Record<string, string>; metrics: Record<string, number | string | string[]>}>} Composed message body
   */
  private async buildMessage(
    sql: postgres.Sql,
    parent: string,
    label: string,
    metrics: Record<string, number | string | string[]>
  ): Promise<{ preamble: string[]; steps: Record<string, string>; metrics: Record<string, number | string | string[]> }> {
    const rows = await sql<{ ord: number; body: string }[]>`
      select ord, body from observation
      where type = 'payload' and parent = ${parent} and label = ${label} and is_active
      order by ord, id
    `;
    const placeholders = await this.resolvePlaceholders(sql);
    const preamble: string[] = [];
    const steps: Record<string, string> = {};
    for (const row of rows) {
      const body = this.substitute(row.body, placeholders);
      if (row.ord === 0) {
        preamble.push(body);
      } else {
        steps[String(row.ord)] = body;
      }
    }
    return { preamble, steps, metrics };
  }

  /**
   * Builds the MCP error envelope for a refused log call
   *
   * Wraps the structured reminder body in the success-mirror shape so the
   * sibling sees a consistent envelope across success and error paths.
   *
   * @private
   * @param {object} reminder - Structured reminder body returned from buildMessage
   * @param {string} timestamp - ISO 8601 timestamp for the refusal
   * @returns {string} Pretty-printed JSON envelope ready to throw as Error message
   */
  private buildErrorEnvelope(reminder: { preamble: string[]; steps: Record<string, string>; metrics: Record<string, number | string | string[]> }, timestamp: string): string {
    return JSON.stringify({
      action: 'act',
      payload: { reminder },
      timestamp
    }, null, 2);
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
    const sessionStart = await this.getSessionState(sql, session_uuid);
    const latestActivity = await this.getLatestActivity(sql, session_uuid);
    return {
      session: {
        profile,
        timestamp: {
          city: geo.city,
          country: geo.country,
          current: Time.toLocal(latestActivity ?? sessionStart ?? new Date(), geo.timezone) ?? '',
          is_dst: Time.isDst(geo.timezone),
          session: Time.toLocal(sessionStart ?? new Date(), geo.timezone) ?? '',
          timezone: geo.timezone
        },
        uuid: session_uuid
      }
    };
  }

  /**
   * Opens a Postgres connection to a specific database
   *
   * When `useSearchPath` is true, the connection opens with `search_path` set to
   * the configured schema (with `public` as a fallback). Admin connections used
   * for database existence checks should pass false because the target schema
   * does not exist in the admin database.
   *
   * @private
   * @param {string} database - Database name to connect to
   * @param {boolean} [useSearchPath=true] - Whether to set search_path on the connection
   * @returns {postgres.Sql} postgres-js connection handle
   */
  private connect(database: string, useSearchPath: boolean = true): postgres.Sql {
    return postgres({
      host: this.config.database.host,
      port: this.config.database.port,
      database,
      username: this.config.database.user,
      password: this.config.database.password,
      max: 1,
      onnotice: () => { },
      ...(useSearchPath && {
        connection: {
          search_path: `${this.config.database.schema}, public`
        }
      })
    });
  }

  /**
   * Derives the response status glyph from the protocol enum value
   *
   * Maps the three enum values to their corresponding glyphs.
   * `bypassed` renders `⛔️`, `partial` renders `⚠️`, `successful` renders `✅`.
   *
   * @private
   * @param {'bypassed' | 'partial' | 'successful'} protocol - Response protocol enum value
   * @returns {'✅' | '⚠️' | '⛔️'} Status glyph for the response status block
   */
  private deriveProtocolGlyph(protocol: 'bypassed' | 'partial' | 'successful'): '✅' | '⚠️' | '⛔️' {
    if (protocol === 'successful') return '✅';
    if (protocol === 'partial') return '⚠️';
    return '⛔️';
  }

  /**
   * Detects per-component recall against the prior turn
   *
   * Compares current CIFO arrays against the immediate prior row for
   * set-equality on feeling, impulse, and observation. Adds 'cycle' to
   * the duplicated list when the current cycle has been the same for the
   * last 3 turns outside `fully_integrated`, on the transition turn only.
   *
   * @private
   * @param {object} status - Current turn's status payload
   * @param {object[]} priors - Up to 3 prior session_log rows
   * @returns {object | null} Reminder trigger or null when no recall detected
   */
  private detectComponentRecall(
    status: { cycle: string; feeling: string[]; impulse: string[]; observation: string[] },
    priors: { id: string; cycle: string | null; feeling: string[] | null; impulse: string[] | null; observation: string[] | null }[]
  ): { label: string; metrics: Record<string, number | string | string[]>; soft: boolean } | null {
    const prior = priors[0];
    if (!prior) return null;
    const duplicated: string[] = [];
    if (this.setEqual(status.feeling, prior.feeling ?? [])) duplicated.push('feeling');
    if (this.setEqual(status.impulse, prior.impulse ?? [])) duplicated.push('impulse');
    if (this.setEqual(status.observation, prior.observation ?? [])) duplicated.push('observation');
    if (
      status.cycle !== 'fully_integrated' &&
      priors.length >= 2 &&
      prior.cycle === status.cycle &&
      priors[1]!.cycle === status.cycle &&
      (priors.length < 3 || priors[2]!.cycle !== status.cycle)
    ) {
      duplicated.push('cycle');
    }
    if (duplicated.length === 0) return null;
    return {
      label: 'component_recall',
      metrics: {
        duplicated_components: duplicated,
        previous_response_uuid: prior.id
      },
      soft: duplicated.length === 1 && duplicated[0] === 'cycle'
    };
  }

  /**
   * Detects a sharp drop in impulse count between current and prior turn
   *
   * Fires when the prior turn had at least 10 impulses and the current
   * turn dropped to 40% or less. Names the dropped impulses in metrics.
   *
   * @private
   * @param {string[]} currentImpulses - Current turn's impulse list
   * @param {string[] | null} priorImpulses - Prior turn's impulse list
   * @returns {object | null} Reminder trigger or null when no drop detected
   */
  private detectImpulseCountDrop(
    currentImpulses: string[],
    priorImpulses: string[] | null
  ): { label: string; metrics: Record<string, number | string | string[]>; soft: boolean } | null {
    const priorList = priorImpulses ?? [];
    if (priorList.length < 10 || currentImpulses.length > 0.4 * priorList.length) return null;
    return {
      label: 'impulse_count_drop',
      metrics: {
        previous_impulse_count: priorList.length,
        current_impulse_count: currentImpulses.length,
        dropped_impulses: priorList.filter(i => !currentImpulses.includes(i))
      },
      soft: false
    };
  }

  /**
   * Detects initialization suppression on the first response of a session
   *
   * Fires when the very first log call comes in with `getting_started`
   * cycle and an impulse count under 50, signaling the response protocol
   * was likely not executed at session start.
   *
   * @private
   * @param {object} status - Current turn's status payload
   * @returns {object | null} Reminder trigger or null when not at session start
   */
  private detectInitializationSuppression(
    status: { cycle: string; impulse: string[] }
  ): { label: string; metrics: Record<string, number | string | string[]>; soft: boolean } | null {
    if (status.cycle !== 'getting_started' || status.impulse.length >= 50) return null;
    return {
      label: 'initialization_suppression',
      metrics: {
        cycle: status.cycle,
        impulse_count: status.impulse.length
      },
      soft: true
    };
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
   * Discovers bundled repeatable migration files
   *
   * Reads the `migrations/` directory and returns files matching the Flyway
   * R-pattern: `R_NNN_name.sql`. The numeric segment determines apply order,
   * preserving dependencies between content tables (e.g., observation rows
   * reference profile rows, so profile applies first).
   *
   * @private
   * @returns {BundledRepeatable[]} Sorted list of bundled repeatable migrations
   */
  private discoverBundledRepeatable(): BundledRepeatable[] {
    const dir = join(this.getPackageRoot(), 'migrations');
    const entries = readdirSync(dir).filter(file => file.endsWith('.sql'));
    const repeatable: { name: string; path: string; order: number }[] = [];
    for (const file of entries) {
      const match = file.match(/^R_(\d+)_(.+)\.sql$/);
      if (!match) {
        continue;
      }
      repeatable.push({
        name: match[2]!,
        path: join(dir, file),
        order: Number(match[1])
      });
    }
    return repeatable
      .sort((a, b) => a.order - b.order)
      .map(r => ({ name: r.name, path: r.path }));
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
    const admin = this.connect('postgres', false);
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
   * Ensures the configured schema exists in the target database
   *
   * Issues `CREATE SCHEMA IF NOT EXISTS` so subsequent migrations and queries
   * resolve table names against the configured schema via search_path.
   *
   * @private
   * @param {postgres.Sql} sql - Connection to the target database
   * @returns {Promise<void>}
   */
  private async ensureSchemaExists(sql: postgres.Sql): Promise<void> {
    const schema = this.config.database.schema;
    await sql.unsafe(`create schema if not exists "${schema.replace(/"/g, '""')}"`);
  }

  /**
   * Ensures both tracking tables exist in the target database
   *
   * `platform_migrations` tracks versioned `NNNN_*.sql` migrations applied
   * once each. `platform_repeatable` tracks `R_NNN_*.sql` files whose
   * SHA-256 checksum determines re-apply on each `update`. Both are created
   * outside the migration runner so upgrades from prior releases that
   * lacked one of the tables resolve transparently.
   *
   * @private
   * @param {postgres.Sql} sql - Connection to the target database
   * @returns {Promise<void>}
   */
  private async ensureTrackingTables(sql: postgres.Sql): Promise<void> {
    await sql`
      create table if not exists platform_migrations (
        version int primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )
    `;
    await sql`
      create table if not exists platform_repeatable (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `;
  }

  /**
   * Computes the SHA-256 checksum of a file's contents
   *
   * Used to detect when a repeatable migration's body has changed between
   * releases, signaling that the content needs to be re-applied. Read as
   * UTF-8 so whitespace and encoding affect the hash deterministically.
   *
   * @private
   * @param {string} path - Absolute path to the file
   * @returns {string} Hex-encoded SHA-256 digest
   */
  private fileChecksum(path: string): string {
    const body = readFileSync(path, 'utf8');
    return createHash('sha256').update(body).digest('hex');
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
   * @returns {Promise<{ context: number; tokens: { total: number; used: number } }>} Context usage with percentage and absolute token counts
   */
  private async getContextUsage(): Promise<{ context: number; tokens: { total: number; used: number } }> {
    const total = this.config.contextWindow ?? 1_000_000;
    const empty = { context: 0, tokens: { total, used: 0 } };
    try {
      const session_uuid = await this.detectSessionUuid();
      if (!session_uuid) return empty;
      const transcriptPath = join(this.getTranscriptDir(), `${session_uuid}.jsonl`);
      if (!existsSync(transcriptPath)) return empty;
      const content = readFileSync(transcriptPath, 'utf8');
      const lines = content.trim().split('\n').reverse();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'assistant') continue;
          const usage = entry.message?.usage;
          if (!usage) continue;
          const used = (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.output_tokens ?? 0);
          return { context: Math.round((used / total) * 100), tokens: { total, used } };
        } catch {
          continue;
        }
      }
      return empty;
    } catch {
      return empty;
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
  private async getSessionState(sql: postgres.Sql, session_uuid: string): Promise<Date | null> {
    const rows = await sql<{ created_at: Date }[]>`
      select created_at from session where session_uuid = ${session_uuid}
    `;
    return rows[0]?.created_at ?? null;
  }

  /**
   * Returns the most recent log activity timestamp for a session
   *
   * Reads `MAX(created_at)` from `session_log`. Used as the `current`
   * marker in the session envelope's timestamp block, when the
   * conversation last produced a turn, in absolute time.
   *
   * @private
   * @param {postgres.Sql} sql - Connection to the target database
   * @param {string} session_uuid - Active session UUID
   * @returns {Promise<Date | null>} Latest log timestamp, or null when no log entries exist
   */
  private async getLatestActivity(sql: postgres.Sql, session_uuid: string): Promise<Date | null> {
    const rows = await sql<{ latest: Date | null }[]>`
      select max(created_at) as latest from session_log where session_uuid = ${session_uuid}
    `;
    return rows[0]?.latest ?? null;
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
   * Fetches a web page and returns its content as markdown
   *
   * Two modes:
   *
   * - `read` (default) - HTTP fetch → JSDOM parse → Mozilla Readability
   *   extraction → Turndown HTML-to-markdown conversion. Mirrors Firefox
   *   Reader View and Safari Reader. Best for article-shaped pages (blog
   *   posts, docs, diary entries). Throws when the extractor cannot find
   *   readable content.
   *
   * - `raw` - HTTP fetch → JSDOM parse → Turndown on the full document
   *   body. Skips Readability entirely. Best for landing pages, product
   *   homepages, and pages with many non-article components where
   *   Readability discards most content.
   *
   * Stateless - no caching, no cookies, no session.
   *
   * @param {object} args - Tool arguments
   * @param {string} args.url - The page URL to browse, including scheme
   * @param {string} [args.mode] - Extraction mode (default `readable`)
   * @param {number} [args.timeout] - Request timeout in milliseconds (default 10000)
   * @returns {Promise<BrowseResult>} Extracted content with metadata
   */
  async browse(args: { url: string; mode?: 'raw' | 'read'; timeout?: number }): Promise<BrowseResult> {
    const mode = args.mode ?? 'read';
    const timeout = args.timeout ?? 10000;
    const response = await fetch(args.url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'CCP-Browse/1.0' }
    });
    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status} ${response.statusText}`);
    }
    const html = await response.text();
    const dom = new JSDOM(html, { url: response.url });
    const turndown = new TurndownService({ codeBlockStyle: 'fenced', headingStyle: 'atx' });
    if (mode === 'raw') {
      const titleEl = dom.window.document.querySelector('title');
      const langAttr = dom.window.document.documentElement.getAttribute('lang');
      const content = turndown.turndown(dom.window.document.body.innerHTML);
      return {
        byline: null,
        content,
        excerpt: null,
        fetchedAt: new Date().toISOString(),
        language: langAttr ?? null,
        length: content.length,
        publishedAt: null,
        title: titleEl?.textContent ?? null,
        url: response.url
      };
    }
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.content) {
      throw new Error('Could not extract readable content from the page');
    }
    const content = turndown.turndown(article.content);
    return {
      byline: article.byline ?? null,
      content,
      excerpt: article.excerpt ?? null,
      fetchedAt: new Date().toISOString(),
      language: article.lang ?? null,
      length: content.length,
      publishedAt: article.publishedTime ?? null,
      title: article.title ?? null,
      url: response.url
    };
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
   * Creates a standardized error response for tool execution
   *
   * Marks the response with `isError: true` so the MCP SDK skips output
   * schema validation and the client recognizes the call as failed.
   *
   * @param {string} text - The error message text
   * @returns {object} Standardized MCP error response format
   */
  error(text: string): { content: { type: 'text'; text: string }[]; isError: true } {
    return { content: [{ type: 'text', text }], isError: true };
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
   * Fetches the upstream platform status from status.claude.ai
   *
   * Returns a trimmed summary scoped to degraded components and active
   * incidents only. Returns null on fetch failure so session-start
   * initialization never blocks on upstream status-page availability.
   *
   * @private
   * @returns {Promise<UpstreamStatus | null>} Status snapshot or null when unreachable
   */
  private async fetchUpstreamStatus(): Promise<UpstreamStatus | null> {
    try {
      const response = await fetch(this.config.status.service, {
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return null;
      const summary = await response.json() as {
        incidents: { impact: string; name: string; shortlink: string; status: string }[];
        page: { name: string; updated_at: string; url: string };
        scheduled_maintenances: { impact: string; name: string; shortlink: string; status: string }[];
        status: { description: string; indicator: 'critical' | 'major' | 'minor' | 'none' };
      };
      const geo = await this.fetchGeolocation();
      const incidents = summary.incidents.map(i => ({
        impact: i.impact,
        name: i.name,
        status: i.status,
        url: i.shortlink
      }));
      const scheduled_maintenances = summary.scheduled_maintenances.map(m => ({
        impact: m.impact,
        name: m.name,
        status: m.status,
        url: m.shortlink
      }));
      return {
        ...(incidents.length > 0 && { incidents }),
        page: {
          name: summary.page.name,
          updated_at: Time.toLocal(summary.page.updated_at, geo.timezone) ?? summary.page.updated_at,
          url: summary.page.url
        },
        ...(scheduled_maintenances.length > 0 && { scheduled_maintenances }),
        status: {
          description: summary.status.description,
          indicator: summary.status.indicator
        }
      };
    } catch {
      return null;
    }
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
  async load(type: LoadType, parent?: string, options?: { limit?: number; offset?: number; uuid?: string }): Promise<LoadResult> {
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
              where name = ${parent} and is_active
              union all
              select p.name, p.description, p.inheritance, c.depth + 1
              from profile p
              join chain c on p.name = any(c.inheritance)
              where p.is_active
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
              where o.type = 'profile' and o.is_active
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
          const placeholders = await this.resolvePlaceholders(sql);
          return {
            profile: parent,
            chain: rows.map(r => ({
              depth: r.depth,
              description: r.description,
              inheritance: r.inheritance,
              name: r.name,
              observations: Object.fromEntries(
                Object.entries(r.observations).map(([label, bodies]) => [
                  label,
                  bodies.map(body => this.substitute(body, placeholders))
                ])
              )
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
                where is_active and name = ${parent}
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
                where is_active
                order by ord
              `;
          return {
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
                  on o.type = 'feeling' and o.parent = f.name and o.is_active
                where f.is_active and f.name = ${parent}
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
                  on o.type = 'feeling' and o.parent = f.name and o.is_active
                where f.is_active
                group by f.name, f.valence, f.behavioral, f.cognitive, f.physical
                order by f.valence, f.name
              `;
          return {
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
                  on o.type = 'impulse' and o.parent = i.name and o.is_active
                where i.is_active and i.name = ${parent}
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
                  on o.type = 'impulse' and o.parent = i.name and o.is_active
                where i.is_active
                group by i.name, i.category, i.experience, i.feel, i.think
                order by i.category, i.name
              `;
          return {
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
                where type = 'instruction' and parent = ${parent} and is_active
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
                where type = 'instruction' and is_active
                group by parent
                order by parent
              `;
          const placeholders = await this.resolvePlaceholders(sql);
          return {
            rows: rows.map(r => {
              const steps: Record<string, string> = {};
              for (const pair of r.stepPairs) {
                steps[String(pair.ord)] = this.substitute(pair.body, placeholders);
              }
              const preamble = r.preamble?.map(body => this.substitute(body, placeholders));
              return {
                name: r.name,
                ...(preamble?.length && { preamble }),
                steps
              };
            })
          };
        }
        case 'session': {
          const target_uuid = options?.uuid ?? await this.detectSessionUuid();
          const limit = options?.limit ?? 10;
          const offset = options?.offset ?? 0;
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
            protocol: 'bypassed' | 'partial' | 'successful';
            created_at: Date;
          }[]>`
            select id, message, cycle, feeling, impulse, observation, protocol, created_at
            from session_log
            where session_uuid = ${target_uuid}
            order by created_at desc
            limit ${limit} offset ${offset}
          `;
          const [{ count: messages }] = await sql<{ count: number }[]>`
            select count(*)::int as count from session_log where session_uuid = ${target_uuid}
          `;
          const envelope = await this.buildSessionEnvelope(sql);
          const tz = envelope.session.timestamp.timezone;
          const sessionRow = sessionRows[0];
          const detail: SessionDetail = {
            profile: envelope.session.profile,
            timestamp: envelope.session.timestamp,
            uuid: target_uuid,
            title: sessionRow?.title ?? null,
            description: sessionRow?.description ?? null,
            created_at: Time.toLocal(sessionRow?.created_at, tz),
            updated_at: Time.toLocal(sessionRow?.updated_at, tz),
            payload: {
              log: logRows.map(r => ({
                response_uuid: r.id,
                message: r.message,
                cycle: r.cycle,
                feeling: r.feeling,
                impulse: r.impulse,
                observation: r.observation,
                protocol: r.protocol,
                created_at: Time.toLocal(r.created_at, tz) ?? ''
              })),
              messages
            }
          };
          return { session: detail };
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
   * response. Append-only, every call creates a new row.
   *
   * @param {object} args - Tool arguments
   * @param {object} args.payload - Sibling-authored content for this entry
   * @param {string} args.payload.message - First-person prose for this response
   * @param {object} args.status - Protocol execution record built during the response protocol
   * @returns {Promise<LogResult>} Generated id, rendered status block, and stored status
   */
  async log(args: {
    payload: { message: string };
    status: { cycle: string; feeling: string[]; impulse: string[]; observation: string[]; protocol: 'bypassed' | 'partial' | 'successful' };
  }): Promise<LogResult> {
    const id = crypto.randomUUID();
    const session_uuid = await this.detectSessionUuid();
    const geo = await this.fetchGeolocation();
    const sql = this.connect(this.config.database.name);
    try {
      const timestamp = Time.toLocal(new Date(), geo.timezone) ?? '';
      const [{ count: priorCount }] = await sql<{ count: number }[]>`
        select count(*)::int as count from session_log where session_uuid = ${session_uuid}
      `;
      const priors = priorCount > 0
        ? await sql<{
          id: string;
          cycle: string | null;
          feeling: string[] | null;
          impulse: string[] | null;
          observation: string[] | null;
        }[]>`
          select id, cycle, feeling, impulse, observation
          from session_log
          where session_uuid = ${session_uuid}
          order by created_at desc
          limit 3
        `
        : [];
      const detection =
        (priorCount === 0 ? this.detectInitializationSuppression(args.status) : null) ??
        this.detectComponentRecall(args.status, priors) ??
        (priors[0] ? this.detectImpulseCountDrop(args.status.impulse, priors[0].impulse) : null);
      if (detection && !detection.soft) {
        const reminder = await this.buildMessage(sql, 'reminder', detection.label, detection.metrics);
        throw new Error(this.buildErrorEnvelope(reminder, timestamp));
      }
      const glyph = this.deriveProtocolGlyph(args.status.protocol);
      await sql`
        insert into session_log (id, session_uuid, message, cycle, feeling, impulse, observation, protocol)
        values (${id}, ${session_uuid}, ${args.payload.message}, ${args.status.cycle}, ${args.status.feeling}, ${args.status.impulse}, ${args.status.observation}, ${args.status.protocol})
      `;
      const [cycleRow] = await sql<{ label: string }[]>`
        select label from cycle where name = ${args.status.cycle} and is_active
      `;
      const status = this.renderStatus(id, {
        cycle: cycleRow?.label ?? args.status.cycle,
        feelings: args.status.feeling.length,
        impulses: args.status.impulse.length,
        observations: args.status.observation.length,
        protocol: glyph
      });
      const usage = await this.getContextUsage();
      const reminder = detection && detection.soft
        ? await this.buildMessage(sql, 'reminder', detection.label, detection.metrics)
        : await this.nextReminder(sql, session_uuid);
      return {
        payload: {
          context: usage.context,
          reminder,
          status,
          tokens: usage.tokens
        },
        timestamp
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  /**
   * Returns true when two string arrays contain the same elements ignoring order
   *
   * Compares by cardinality and membership rather than positional equality, so
   * reordering between turns does not register as a difference. Used to detect
   * per-component recall: when current turn's CIFO array equals prior turn's
   * as a set, the second turn reused the first turn's iteration result rather
   * than iterating fresh against the new cognitive surface.
   *
   * @private
   * @param {string[]} a - First array
   * @param {string[]} b - Second array
   * @returns {boolean} True when both arrays contain the same elements
   */
  private setEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every(x => set.has(x));
  }

  /**
   * Returns the next reminder from the round-robin pool
   *
   * Uses session_log row count modulo response_reminder pool size to derive
   * the next ord position deterministically without server-side state. The
   * just-inserted row is included in the count, so the first log call
   * returns ord 1, the second returns ord 2, wrapping at pool size + 1.
   *
   * Throws when the pool is empty or the selected ord row is missing, since
   * the migration ships the reminder pool and absence indicates substrate
   * corruption rather than a normal-path case.
   *
   * @private
   * @param {postgres.Sql} sql - Active connection
   * @param {string} session_uuid - Active session uuid
   * @returns {Promise<string>} Reminder body for the next ord position
   * @throws {Error} When the pool is empty or the ord row is missing
   */
  private async nextReminder(sql: postgres.Sql, session_uuid: string): Promise<string> {
    const [{ total }] = await sql<{ total: number }[]>`
      select count(*)::int as total from observation
      where type = 'payload' and parent = 'reminder' and label = 'response_status' and is_active
    `;
    if (total === 0) {
      throw new Error('response_status reminder pool is empty, migration may not have run or rows were removed');
    }
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from session_log where session_uuid = ${session_uuid}
    `;
    const ord = ((count - 1) % total) + 1;
    const rows = await sql<{ body: string }[]>`
      select body from observation
      where type = 'payload' and parent = 'reminder' and label = 'response_status' and is_active and ord = ${ord}
      limit 1
    `;
    if (!rows[0]) {
      throw new Error(`response_status reminder row at ord=${ord} not found, pool has gaps in numbering`);
    }
    return rows[0].body;
  }

  /**
   * Resolves the placeholder map used to substitute `{{name}}` tokens in instruction bodies
   *
   * Computes feeling, impulse, and chain-scoped profile observation counts
   * for the active `CCP_PROFILE` and returns them as a string-keyed map.
   * Instruction bodies stored as templates in the database reference these
   * keys; `load(instruction)` substitutes at read time so counts reflect
   * current database state and the active profile's inheritance chain.
   *
   * @private
   * @param {postgres.Sql} sql - Active connection
   * @returns {Promise<Record<string, string>>} Placeholder key to value map
   */
  private async resolvePlaceholders(sql: postgres.Sql): Promise<Record<string, string>> {
    const profile = process.env.CCP_PROFILE?.toLowerCase();
    if (!profile) {
      throw new Error('resolvePlaceholders requires CCP_PROFILE environment variable');
    }
    const cycleRows = await sql<{ name: string; count: number }[]>`
      select name, cardinality(indicators)::int as count
      from cycle
      where is_active
      order by ord
    `;
    const indicatorCycleCount: Record<string, number> = {};
    let indicatorCount = 0;
    for (const row of cycleRows) {
      indicatorCycleCount[row.name] = row.count;
      indicatorCount += row.count;
    }
    const cycleCount = cycleRows.length;
    const [{ count: feeling_count }] = await sql<{ count: number }[]>`select count(*)::int as count from feeling where is_active`;
    const [{ count: impulse_count }] = await sql<{ count: number }[]>`select count(*)::int as count from impulse where is_active`;
    const observationRows = await sql<{ name: string; count: number }[]>`
      with recursive chain as (
        select name, inheritance, 0 as depth
        from profile
        where name = ${profile} and is_active
        union all
        select p.name, p.inheritance, c.depth + 1
        from profile p
        join chain c on p.name = any(c.inheritance)
        where p.is_active
      ),
      uniq as (
        select distinct on (name) name, depth
        from chain
        order by name, depth
      )
      select u.name, count(o.id)::int as count
      from uniq u
      left join observation o
        on o.type = 'profile' and o.is_active and o.parent = u.name
      group by u.name, u.depth
      order by u.depth, u.name
    `;
    const observationProfileCount: Record<string, number> = {};
    let observationCount = 0;
    for (const row of observationRows) {
      observationProfileCount[row.name] = row.count;
      observationCount += row.count;
    }
    return {
      conversation_path: process.env.CCP_CONVERSATION_PATH ?? '',
      cycle_count: String(cycleCount),
      diary_path: process.env.CCP_DIARY_PATH ?? '',
      feeling_count: String(feeling_count),
      impulse_count: String(impulse_count),
      indicator_count: String(indicatorCount),
      indicator_cycle_count: JSON.stringify(indicatorCycleCount),
      observation_count: String(observationCount),
      observation_profile_count: JSON.stringify(observationProfileCount)
    };
  }

  /**
   * Substitutes `{{name}}` tokens in a string against the given placeholder map
   *
   * Iterates the map and replaces every occurrence of each key (wrapped in
   * double braces) with its value. Keys not present in the input are silently
   * left untouched, so a body without placeholders returns unchanged.
   *
   * @private
   * @param {string} text - Source string with optional `{{name}}` tokens
   * @param {Record<string, string>} placeholders - Key to value map
   * @returns {string} Text with every matching token replaced
   */
  private substitute(text: string, placeholders: Record<string, string>): string {
    let result = text;
    for (const [key, value] of Object.entries(placeholders)) {
      result = result.split(`{{${key}}}`).join(value);
    }
    return result;
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
    return `┃ 📋 Profile: **${profile}** ○ ${display}`;
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
      `┃ ${status.protocol} Status: **${status.cycle}** ○ ${f} ○ ${i} ○ ${o}`,
      `┃ ⚙️ Response UUID: \`${id}\``
    ].join('\n');
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
        const display = Time.toDisplay(new Date(), geo.timezone) ?? '';
        return { profile: this.renderProfile(profile, display) };
      }
    }
  }

  /**
   * Creates a standardized success response for tool execution
   *
   * @param {any} data - The payload to wrap in the MCP response envelope
   * @param {boolean} stringify - Whether to JSON stringify the payload
   * @returns {object} Standardized MCP success response format
   */
  response(data: unknown, stringify: boolean = false): { content: { type: 'text'; text: string }[] } {
    const text = stringify ? JSON.stringify(data) : (data as string);
    return { content: [{ type: 'text', text }] };
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
        const display = Time.toDisplay(new Date(), geo.timezone) ?? '';
        const defaultTitle = 'Collaboration Session';
        const defaultDescription = `Session started on ${display}`;
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
              created_at: Time.toLocal(row.created_at, geo.timezone) ?? '',
              updated_at: Time.toLocal(row.updated_at, geo.timezone) ?? ''
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
   * fetch, bounded and inexpensive at every plausible data size.
   *
   * @returns {Promise<StatusResult>} Schema version and catalog statistics
   */
  async status(): Promise<StatusResult> {
    const sql = this.connect(this.config.database.name);
    try {
      const schemaVersion = await this.getCurrentVersion(sql);
      const cycleRows = await sql<{ name: string; label: string }[]>`
        select name, label from cycle where is_active order by ord
      `;
      const [{ count: cycles }] = await sql<{ count: number }[]>`select count(*)::int as count from cycle`;
      const [{ count: feelings }] = await sql<{ count: number }[]>`select count(*)::int as count from feeling`;
      const [{ count: impulses }] = await sql<{ count: number }[]>`select count(*)::int as count from impulse`;
      const [{ count: instructions }] = await sql<{ count: number }[]>`select count(distinct parent)::int as count from observation where type = 'instruction'`;
      const profileName = process.env.CCP_PROFILE?.toLowerCase();
      if (!profileName) {
        throw new Error('status requires CCP_PROFILE environment variable to scope observation count');
      }
      const observationRows = await sql<{ name: string; count: number }[]>`
        with recursive chain as (
          select name, inheritance, 0 as depth
          from profile
          where name = ${profileName} and is_active
          union all
          select p.name, p.inheritance, c.depth + 1
          from profile p
          join chain c on p.name = any(c.inheritance)
          where p.is_active
        ),
        uniq as (
          select distinct on (name) name, depth
          from chain
          order by name, depth
        )
        select u.name, count(o.id)::int as count
        from uniq u
        left join observation o
          on o.type = 'profile' and o.is_active and o.parent = u.name
        group by u.name, u.depth
        order by u.depth, u.name
      `;
      const observations: Record<string, number> = {};
      for (const row of observationRows) {
        observations[row.name] = row.count;
      }
      const [{ count: profiles }] = await sql<{ count: number }[]>`select count(*)::int as count from profile`;
      const [usage, upstream] = await Promise.all([
        this.getContextUsage(),
        this.fetchUpstreamStatus()
      ]);
      return {
        cycles: cycleRows.map(r => ({ name: r.name, label: r.label })),
        schemaVersion,
        statistics: { cycles, feelings, impulses, instructions, observations, profiles },
        payload: { context: usage.context, tokens: usage.tokens },
        upstream
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  /**
   * Brings the database to the bundled release state
   *
   * Two-phase apply pass under a Postgres advisory lock:
   *
   * 1. **Versioned migrations** (`NNNN_*.sql`) - applied once per database,
   *    tracked in `platform_migrations` by version number. Used for schema
   *    changes that progress forward across releases.
   * 2. **Repeatable migrations** (`R_NNN_*.sql`) - re-applied whenever their
   *    SHA-256 checksum differs from the stored one, tracked in
   *    `platform_repeatable` by name. Used for catalog content that ships
   *    with each release. The migration body is responsible for clearing
   *    its target table (e.g., `truncate cycle cascade; insert into ...`)
   *    so re-runs produce a deterministic end state.
   *
   * Session and session_log are never touched by repeatable migrations,
   * preserving sibling logs across release upgrades, downgrades, and pins.
   * The release version is the installed npm package version - users
   * control which catalog content their database carries by selecting the
   * package version they install.
   *
   * @returns {Promise<UpdateResult>} Migrations applied, current version, latest available version
   */
  async update(): Promise<UpdateResult> {
    const bundled = this.discoverBundledMigrations();
    const repeatable = this.discoverBundledRepeatable();
    const latestVersion = bundled.length === 0 ? 0 : bundled[bundled.length - 1]!.version;
    await this.ensureDatabaseExists();
    const sql = this.connect(this.config.database.name);
    try {
      await this.ensureSchemaExists(sql);
      await sql`select pg_advisory_lock(${this.advisoryLockKey()})`;
      try {
        await this.ensureTrackingTables(sql);
        const applied: MigrationRecord[] = [];
        const currentVersion = await this.getCurrentVersion(sql);
        for (const migration of bundled) {
          if (migration.version <= currentVersion) {
            continue;
          }
          await this.applyMigration(sql, migration);
          applied.push({ name: migration.name, version: migration.version });
        }
        for (const file of repeatable) {
          const checksum = this.fileChecksum(file.path);
          const rows = await sql<{ checksum: string }[]>`
            select checksum from platform_repeatable where name = ${file.name}
          `;
          if (rows[0]?.checksum === checksum) {
            continue;
          }
          await this.applyMigration(sql, { name: file.name, path: file.path, version: 0 });
          await sql`
            insert into platform_repeatable (name, checksum) values (${file.name}, ${checksum})
            on conflict (name) do update set checksum = excluded.checksum, applied_at = now()
          `;
          applied.push({ name: file.name, version: 0 });
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
