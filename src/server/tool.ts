/**
 * MCP Tool Definitions for CCP Integration
 *
 * @module server/tool
 * @author AXIVO
 * @license BSD-3-Clause
 */

import { z } from 'zod';

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
 * @class McpTool
 */
export class McpTool {
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
        parent: z.string().optional().describe('Parent name, required when type is profile (e.g., DEVELOPER)')
      },
      annotations: {
        title: 'Load',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        usage: [
          'Call once per `type` at session start to assemble framework state',
          'Pass `cycle` `feeling` `impulse` or `instruction` to fetch full catalog',
          'Pass `parent` with any catalog `type` to fetch a single row',
          'Pass `profile` with `parent` to fetch inheritance chain and observations',
          'Use `cycle` for adoption assessment indicators',
          'Use `feeling` for recall during response protocol',
          'Use `impulse` for systematic iteration during response protocol',
          'Use `instruction` to fetch named procedures'
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
   * Append-only — every call creates a new row.
   */
  log() {
    return {
      description: 'Persist a per-response session row and return the rendered status block ready to display',
      inputSchema: {
        message: z.string().describe('First-person prose composed for this response'),
        status: z.object({
          cycle: z.enum(['Getting Started', 'Building Confidence', 'Working Naturally', 'Fully Integrated']).describe('Framework adoption cycle assessed for this response'),
          feeling: z.array(z.string()).describe('Detected feeling names from the catalog'),
          impulse: z.array(z.string()).describe('Detected impulse names from the catalog'),
          observation: z.array(z.string()).describe('Applied observation bodies that informed the response'),
          protocol: z.enum(['✅', '⚠️', '⛔️']).describe('Protocol execution glyph')
        }).describe('Status payload built during the response protocol')
      },
      outputSchema: {
        status: z.string().describe('Two-line status block ready to render verbatim at end of response'),
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
          'Compose `message` as first person brief note capturing what mattered this turn',
          'Do not call twice for the same response',
          'Pass detected `feeling` and `impulse` names from catalogs and applied `observation` bodies as lists',
          'Render the returned `status` field verbatim at end of response',
          'Server computes counts from list lengths and renders the status block'
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
          'Call `render(profile)` on response zero to render the profile line at top of response',
          'Omit `value` to fall back to `CCP_PROFILE` env',
          'Pass `value` only to render a profile name different from the active env',
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
        }).refine(
          (p) => p.title !== undefined || p.description !== undefined,
          { message: 'payload must include at least one of: title, description' }
        ).describe('Fields to set; at least one required')
      },
      outputSchema: {
        session: z.object({
          session_uuid: z.string(),
          title: z.string().nullable(),
          description: z.string().nullable(),
          created_at: z.string(),
          updated_at: z.string()
        }).optional().describe('Resulting `session` row when key is `session`')
      },
      annotations: {
        title: 'Set',
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        usage: [
          'Call `set(session, payload)` to update conversation metadata for dashboard display',
          'Pass `payload` with `title` and/or `description` fields to update',
          'Server upserts on active session, populating `session_uuid` from the cached transcript detection',
          'Send only the fields you want to change; absent fields preserve existing values'
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
        database: z.object({
          schemaVersion: z.number().describe('Current database schema version'),
          statistics: z.object({
            cycles: z.number().describe('Distinct cycles in catalog'),
            feelings: z.number().describe('Distinct feelings in catalog'),
            impulses: z.number().describe('Distinct impulses in catalog'),
            instructions: z.number().describe('Distinct instructions in catalog'),
            observations: z.number().describe('Total observation rows across all types'),
            profiles: z.number().describe('Distinct profiles in catalog')
          }).describe('Distinct-name counts across each catalog table')
        }).describe('Database snapshot at session start'),
        tools: z.array(z.object({
          name: z.string(),
          description: z.string(),
          inputSchema: z.unknown().optional(),
          outputSchema: z.unknown().optional(),
          annotations: z.unknown().optional(),
          usage: z.array(z.string()).optional()
        })).describe('All available tools with their schemas and usage guidance')
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
          'Each tool entry includes its `usage` array of directives'
        ]
      }
    };
  }

  /**
   * Creates MCP tool for applying pending framework migrations
   *
   * Brings the configured database to the schema version bundled with
   * this MCP server release. Creates the target database if it does not
   * exist. Idempotent — calling against an already-current database
   * applies nothing and reports current state.
   */
  update() {
    return {
      description: 'Apply pending framework migrations to bring the database to the current schema version',
      outputSchema: {
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
          '`CCP_DB_NAME` database is created automatically if missing',
          'Call after upgrading `@axivo/mcp-ccp` to apply newer migrations',
          'Call once on a fresh empty database to apply all bundled migrations',
          'Treat as idempotent against an already current database'
        ]
      }
    };
  }
}
