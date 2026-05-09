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
          'Use `impulse` for systematic iteration during response protocol'
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
  logResponse() {
    return {
      description: 'Persist a per-response session row and return the rendered status block ready to display',
      inputSchema: {
        message: z.string().describe('First-person prose composed for this response'),
        status: z.object({
          cycle: z.enum(['Getting Started', 'Building Confidence', 'Working Naturally', 'Fully Integrated']).describe('Framework adoption cycle assessed for this response'),
          feelings: z.number().int().nonnegative().describe('Count of detected feelings'),
          impulses: z.number().int().nonnegative().describe('Count of detected impulses'),
          observations: z.number().int().nonnegative().describe('Count of enumerated observations'),
          protocol: z.enum(['✅', '⚠️', '⛔️']).describe('Protocol execution glyph')
        }).describe('Status payload built during the response protocol')
      },
      outputSchema: {
        id: z.string().describe('Generated row id (RFC4122 v4)'),
        rendered: z.string().describe('Two-line status block ready to render verbatim at end of response'),
        status: z.object({
          cycle: z.string(),
          feelings: z.number(),
          impulses: z.number(),
          observations: z.number(),
          protocol: z.string()
        }).describe('Status payload as stored, echoed for round-trip verification')
      },
      annotations: {
        title: 'Log Response',
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      _meta: {
        usage: [
          'Call once per response after the response protocol iteration completes',
          'Compose `message` as first person brief note capturing what mattered this turn',
          'Do not call twice for the same response',
          'Pass raw counts and `cycle` name as `status` payload',
          'Render the returned `rendered` field verbatim at end of response'
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
