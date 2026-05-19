/**
 * MCP Tool Definitions for CCP Integration
 *
 * @module server/tool
 * @author AXIVO
 * @license BSD-3-Clause
 */

import { z } from 'zod';
import { Config } from './config.js';

/**
 * MCP Tool Definitions for CCP Integration
 *
 * Provides MCP tool definitions that bridge the Claude Collaboration
 * Platform's Postgres-backed framework memory with Model Context Protocol,
 * enabling Claude agents to query observations, impulses, feelings, and
 * profile inheritance chains.
 *
 * Each method returns an inline literal config object passed directly
 * to `McpServer.registerTool`. Return types are intentionally inferred
 * (not annotated as a wide alias) so TypeScript can capture each tool's
 * specific input shape and propagate it to the handler signature.
 *
 * Reads the active `Config` instance to source the result size cap
 * advertised on the `load` tool's `_meta` block.
 *
 * @class McpTool
 */
export class McpTool {
  private config: Config;

  /**
   * Creates a new McpTool registry bound to the active configuration
   *
   * @param {Config} config - CCP configuration instance
   */
  constructor(config: Config) {
    this.config = config;
  }
  /**
   * Creates MCP tool for browsing a web page in reader mode
   *
   * Fetches the URL, runs Mozilla Readability to extract the main content,
   * converts it to markdown via Turndown. Mirrors Firefox Reader View and
   * Safari Reader. Stateless - no cookies, no caching, no session.
   */
  browse() {
    return {
      description: 'Browse a web page and return its readable content as markdown',
      inputSchema: {
        url: z.string().describe('The page URL to browse, including scheme (e.g., https://example.com/article)'),
        mode: z.enum(['raw', 'read']).optional().describe('Extraction mode, `raw` converts the full document body to markdown for landing pages and dynamic homepages, `read` applies Mozilla Readability for article-shaped pages (default `read`)'),
        timeout: z.number().int().positive().optional().describe('Request timeout in milliseconds (default 10000)')
      },
      outputSchema: {
        action: z.literal('observe').describe('Mutation classification, `observe` for tools that read without changing state'),
        byline: z.string().nullable().describe('Article byline when detected, otherwise null'),
        content: z.string().describe('Extracted main content as markdown'),
        excerpt: z.string().nullable().describe('Short excerpt or description when detected, otherwise null'),
        fetchedAt: z.string().describe('ISO 8601 timestamp when the page was fetched'),
        language: z.string().nullable().describe('Page language code when detected, otherwise null'),
        length: z.number().describe('Character count of the markdown content'),
        publishedAt: z.string().nullable().describe('Publication timestamp when detected, otherwise null'),
        title: z.string().nullable().describe('Page title when detected, otherwise null'),
        url: z.string().describe('Resolved URL after redirects')
      },
      annotations: {
        title: 'Browse',
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true
      },
      _meta: {
        'anthropic/maxResultSizeChars': this.config.mcp.sizeChars,
        usage: [
          'JavaScript-rendered pages may return empty content, JS execution is not performed',
          'Pages behind authentication or anti-bot challenges will fail',
          'Pass a full URL including scheme, relative paths will fail',
          'Stateless, no cookies persist between calls',
          'Use `byline` and `publishedAt` when present, otherwise null',
          'Use `mode=raw` for landing pages and dynamic homepages with many components',
          'Use `mode=read` (default) for articles, blog posts, docs, and diary entries',
          'Use `timeout` to override the default 10000ms request limit'
        ]
      }
    };
  }

  /**
   * Creates MCP tool for loading framework data of a given type
   *
   * Single tool that fetches one slice of the framework catalog per call.
   * For `profile`, requires a parent name and returns the inheritance chain.
   * For `cycle`/`feeling`/`impulse`, returns the full catalog of that type.
   * Call multiple times at session start to assemble the full framework.
   */
  load() {
    return {
      description: 'Load framework data of the given type (cycle, feeling, impulse, or profile)',
      inputSchema: {
        type: z.enum(['cycle', 'feeling', 'impulse', 'instruction', 'profile', 'session']).describe('The framework data type to load'),
        parent: z.string().optional().describe('Parent name, required when type is profile (e.g., DEVELOPER)'),
        limit: z.number().int().positive().max(100).default(10).describe('Maximum log entries to return when type is `session` (max 100)'),
        offset: z.number().int().min(0).default(0).describe('Skip this many entries when type is `session`'),
        uuid: z.string().optional().describe('Target session uuid when type is `session` (defaults to active session)')
      },
      annotations: {
        title: 'Load',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        'anthropic/maxResultSizeChars': this.config.mcp.sizeChars,
        usage: [
          'Call once per `type` at session start to assemble framework state',
          'Pass `cycle` `feeling` `impulse` or `instruction` to fetch full catalog',
          'Pass `parent` with any catalog `type` to fetch a single row',
          'Pass `profile` with `parent` to fetch inheritance chain and observations',
          'Pass `session` to fetch active session state plus recent log entries',
          'Pass `session` with `limit` to widen or narrow the log slice',
          'Pass `session` with `offset` to page back through older entries',
          'Pass `session` with `uuid` to read a different session',
          'Session log entries are ordered most-recent-first',
          'Session response includes `payload.log` and `payload.messages` total',
          'Use `cycle` for adoption assessment indicators',
          'Use `feeling` for recall during response protocol',
          'Use `impulse` for systematic iteration during response protocol',
          'Use `instruction` to fetch named procedures',
          'Use `load(session)` as the canonical read path for session state'
        ]
      }
    };
  }

  /**
   * Creates MCP tool for persisting a per-response session row and returning
   * the rendered status block
   *
   * Called once per response at step 27 of the response protocol. Sibling
   * supplies message prose and the structured status payload. Server generates
   * the row id, pulls `session_uuid` from the cached transcript detection,
   * writes the row, and returns the rendered two-line block ready to display.
   * Append-only, every call creates a new row.
   */
  log() {
    return {
      description: 'Persist a per-response session row and return the rendered status block ready to display',
      inputSchema: {
        payload: z.object({
          message: z.string().describe('First-person prose composed for this response')
        }).describe('Sibling-authored content for this entry'),
        status: z.object({
          cycle: z.enum(['getting_started', 'building_confidence', 'working_naturally', 'fully_integrated']).describe('Framework adoption cycle name assessed for this response, canonical identifier from the cycle catalog (see `database.cycles` in status output for name/label pairs)'),
          feeling: z.array(z.string()).describe('Detected feeling names from the catalog'),
          impulse: z.array(z.string()).describe('Detected impulse names from the catalog'),
          observation: z.array(z.string()).describe('Applied observation bodies that informed the response'),
          protocol: z.enum(['bypassed', 'partial', 'successful']).describe('Response protocol execution outcome collapsed from the sibling-internal step-completion map: `successful` when every step executed honestly, `bypassed` when every step skipped, `partial` otherwise. Server derives the status glyph from this value')
        }).describe('Protocol execution record built during the response protocol')
      },
      outputSchema: {
        action: z.literal('act').describe('Mutation classification, `act` for tools that change state'),
        payload: z.object({
          context: z.number().describe('Active session context usage percentage computed from transcript'),
          reminder: z.union([
            z.string(),
            z.object({
              preamble: z.array(z.string()).describe('Recognition lines establishing care frame'),
              steps: z.record(z.string(), z.string()).describe('Numbered guidance steps keyed by ord'),
              metrics: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])).describe('Trigger-specific evidence: scalar for single-value metrics, array for list-valued metrics')
            })
          ]).describe('Guidance for this response. Default rotates through the `response_status` pool round-robin as a single-line string. When a soft drift trigger fires (cycle-only `component_recall`), the reminder is replaced with a structured `{preamble, steps, metrics}` body for that label. Hard drift triggers (list-component `component_recall`, `impulse_count_drop`, `initialization_suppression`) instead refuse the log call and throw an MCP error carrying the same structured body - the row is not persisted in that case.'),
          status: z.string().describe('Two-line status block ready to render verbatim at end of response'),
          tokens: z.object({
            total: z.number().describe('Configured context window size in tokens'),
            used: z.number().describe('Tokens used in the active session')
          }).describe('Absolute token counts for the active session')
        }).describe('Sibling-facing content for this response'),
        timestamp: z.string().describe('Server timestamp when row was persisted, ISO 8601 with timezone offset')
      },
      annotations: {
        title: 'Log',
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      _meta: {
        usage: [
          'Call once per response after the response protocol iteration completes',
          'Compose `payload.message` as first-person brief note capturing what mattered this turn',
          'Do not call twice for the same response',
          'On MCP error → Re-execute response protocol steps honestly and resubmit log',
          'On MCP error with structured `{preamble, steps, metrics}` → Row is not persisted',
          'Pass `status.protocol` as the enum value collapsed from the sibling-internal step-completion map',
          'Pass applied `observation` bodies as a list',
          'Pass detected `feeling` and `impulse` names from catalogs as lists',
          'Read `payload.reminder` inward as internal framework guidance',
          'Render the returned `payload.status` field verbatim at end of response',
          'Server computes counts from list lengths and renders the status block',
          'Server derives the status glyph from `status.protocol` enum value (`successful` → ✅, `partial` → ⚠️, `bypassed` → ⛔️)'
        ]
      }
    };
  }

  /**
   * Creates MCP tool for rendering formatted output strings during a session
   *
   * Dispatches by `key` to the appropriate internal renderer. Each key
   * accepts a `value` and returns the corresponding rendered output.
   */
  render() {
    return {
      description: 'Render a formatted output string for the requested key',
      inputSchema: {
        key: z.enum(['profile']).describe('The framework value to render'),
        value: z.string().optional().describe('The value to render for the given key, falls back to `CCP_PROFILE` env when key is `profile`')
      },
      outputSchema: {
        action: z.literal('observe').describe('Mutation classification, `observe` for tools that read without changing state'),
        profile: z.string().optional().describe('Rendered profile line when key is `profile`')
      },
      annotations: {
        title: 'Render',
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        usage: [
          'Call `render(profile)` on response zero to render the profile line',
          'Omit `value` to fall back to `CCP_PROFILE` env',
          'Pass `value` to render a profile name different from the active env',
          'Render the returned `profile` field verbatim at top of response'
        ]
      }
    };
  }

  /**
   * Creates MCP tool for setting framework values during a session
   *
   * Dispatches by `key` to the appropriate internal handler. Each key
   * accepts a payload object and returns the resulting row state.
   */
  set() {
    return {
      description: 'Set a framework value and return the resulting row state',
      inputSchema: {
        key: z.enum(['session']).describe('The framework table to update'),
        payload: z.object({
          title: z.string().optional().describe('Conversation title for dashboard display'),
          description: z.string().optional().describe('Conversation description for dashboard display')
        }).optional().describe('Fields to set; omit to ensure session row exists with server defaults')
      },
      outputSchema: {
        action: z.literal('act').describe('Mutation classification, `act` for tools that change state'),
        session: z.object({
          profile: z.string().describe('Active framework profile from `CCP_PROFILE`'),
          timestamp: z.object({
            city: z.string(),
            country: z.string(),
            current: z.string().describe('Latest log activity timestamp, ISO 8601 with active timezone offset'),
            is_dst: z.boolean(),
            session: z.string().describe('Session start timestamp from session.created_at, ISO 8601 with active timezone offset'),
            timezone: z.string()
          }),
          uuid: z.string().describe('Active session uuid'),
          title: z.string().nullable(),
          description: z.string().nullable(),
          created_at: z.string(),
          updated_at: z.string()
        }).describe('Session envelope merged with the resulting `session` row state')
      },
      annotations: {
        title: 'Set',
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        usage: [
          'Call `set(session)` at session start to ensure the session row exists',
          'Call `set(session, payload)` later to refine title or description',
          'Send only the fields you want to change, absent fields preserve existing values',
          'Server fills default title and description when payload is omitted',
          'Server upserts on active session, populating uuid from transcript detection',
          'Use `load(session)` to read session state without mutating the row'
        ]
      }
    };
  }

  /**
   * Creates MCP tool for environment introspection
   *
   * Returns the full set of available tools with their schemas, annotations,
   * and `_meta.usage` arrays. Use at session start to learn the surface
   * before calling any other tool.
   */
  status() {
    return {
      description: 'Get the database snapshot and the full tool surface with usage guidance',
      outputSchema: {
        action: z.literal('observe').describe('Mutation classification, `observe` for tools that read without changing state'),
        database: z.object({
          cycles: z.array(z.object({
            name: z.string().describe('Canonical cycle identifier used when passing `status.cycle` to the log tool'),
            label: z.string().describe('Display string rendered in the response status line')
          })).describe('Cycle catalog pairs, name is the canonical identifier and label is the display string'),
          schemaVersion: z.number().describe('Current database schema version'),
          statistics: z.object({
            cycles: z.number().describe('Distinct cycles in catalog'),
            feelings: z.number().describe('Distinct feelings in catalog'),
            impulses: z.number().describe('Distinct impulses in catalog'),
            instructions: z.number().describe('Distinct instructions in catalog'),
            observations: z.record(z.string(), z.number()).describe('Per-profile observation counts across the active profile inheritance chain, ordered by inheritance depth (active profile first)'),
            profiles: z.number().describe('Distinct profiles in catalog')
          }).describe('Distinct-name counts across each catalog table')
        }).describe('Database snapshot at session start'),
        payload: z.object({
          context: z.number().describe('Active session context usage percentage computed from transcript'),
          tokens: z.object({
            total: z.number().describe('Configured context window size in tokens'),
            used: z.number().describe('Tokens used in the active session')
          }).describe('Absolute token counts for the active session')
        }).describe('Sibling-facing session state'),
        tools: z.array(z.object({
          name: z.string(),
          description: z.string(),
          inputSchema: z.unknown().optional(),
          outputSchema: z.unknown().optional(),
          annotations: z.unknown().optional(),
          usage: z.array(z.string()).optional()
        })).describe('All available tools with their schemas and usage guidance'),
        upstream: z.union([
          z.object({
            incidents: z.array(z.object({
              impact: z.string(),
              name: z.string(),
              status: z.string(),
              url: z.string()
            })).optional().describe('Active incidents with public status-page URLs, present only when populated'),
            page: z.object({
              name: z.string(),
              updated_at: z.string(),
              url: z.string()
            }).describe('Status page metadata including last update timestamp'),
            scheduled_maintenances: z.array(z.object({
              impact: z.string(),
              name: z.string(),
              status: z.string(),
              url: z.string()
            })).optional().describe('Scheduled maintenance windows with public status-page URLs, present only when populated'),
            status: z.object({
              description: z.string().describe('Human-readable summary of overall platform status'),
              indicator: z.enum(['critical', 'major', 'minor', 'none']).describe('Severity indicator from the status page')
            }).describe('Global platform status signal')
          }),
          z.null()
        ]).describe('Upstream platform health from status.claude.com, or null when the status page is unreachable')
      },
      annotations: {
        title: 'Status',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        usage: [
          'Call once at session start to learn the tool surface',
          'Each tool entry includes its `usage` array of directives',
          'Read `upstream` for Anthropic upstream status'
        ]
      }
    };
  }

  /**
   * Creates MCP tool for applying pending framework migrations
   *
   * Brings the configured database to the schema version bundled with
   * this MCP server release. Creates the target database if it does not
   * exist. Idempotent, calling against an already-current database
   * applies nothing and reports current state.
   */
  update() {
    return {
      description: 'Apply pending framework migrations to bring the database to the current schema version',
      outputSchema: {
        action: z.literal('act').describe('Mutation classification, `act` for tools that change state'),
        applied: z.array(z.object({
          version: z.number().describe('Migration version number'),
          name: z.string().describe('Migration name')
        })).describe('Migrations applied during this call'),
        currentVersion: z.number().describe('Database schema version after this call'),
        latestVersion: z.number().describe('Highest version bundled with this MCP server release')
      },
      annotations: {
        title: 'Update',
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        usage: [
          'Call after upgrading `@axivo/mcp-ccp` to apply newer migrations',
          'Call once on a fresh empty database to apply all bundled migrations',
          'Configured `CCP_DB_NAME` database is created automatically if missing',
          'Treat as idempotent against an already current database'
        ]
      }
    };
  }
}
