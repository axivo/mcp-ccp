/**
 * CCP Configuration Parser and Validator
 *
 * @module server/config
 * @author AXIVO
 * @license BSD-3-Clause
 */

import { z } from 'zod';

/**
 * Top-level CCP configuration
 */
export interface CcpConfig {
  contextWindow: number;
  database: DatabaseConfig;
  geolocation: GeolocationConfig;
  mcp: McpConfig;
  status: StatusConfig;
}

/**
 * Database connection settings
 */
export interface DatabaseConfig {
  host: string;
  name: string;
  password: string;
  port: number;
  schema: string;
  user: string;
}

/**
 * Geolocation settings
 */
export interface GeolocationConfig {
  fallbackTimezone: string;
  override?: string;
  service: string;
}

/**
 * MCP server limits
 *
 * `sizeChars` is the per-tool Anthropic result size cap advertised in
 * the `_meta` block of tool definitions.
 */
export interface McpConfig {
  sizeChars: number;
}

/**
 * Upstream platform status settings
 */
export interface StatusConfig {
  service: string;
}

/**
 * CCP Configuration Parser and Validator
 *
 * Loads configuration from a JSON file path resolved in this order:
 *   1. `CCP_CONFIG_PATH` env var
 *   2. `~/.claude/ccp/config.json`
 *   3. Bundled defaults (if no file exists)
 *
 * Validates with Zod schema; throws on invalid configuration.
 *
 * @class Config
 */
export class Config {
  private settings: CcpConfig;
  private static readonly DatabaseSchema = z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(54322),
    name: z.string().default('postgres'),
    user: z.string().default('postgres'),
    password: z.string().default('postgres'),
    schema: z.string().default('public')
  });
  private static readonly GeolocationSchema = z.object({
    service: z.url().default('https://ipinfo.io/json'),
    override: z.string().optional(),
    fallbackTimezone: z.string().default('UTC')
  });
  private static readonly McpSchema = z.object({
    sizeChars: z.number().int().positive().default(500000)
  });
  private static readonly StatusSchema = z.object({
    service: z.url().default('https://status.claude.ai/api/v2/summary.json')
  });
  private static readonly ConfigSchema = z.object({
    contextWindow: z.number().int().positive().default(1_000_000),
    database: Config.DatabaseSchema.optional(),
    geolocation: Config.GeolocationSchema.optional(),
    mcp: Config.McpSchema.optional(),
    status: Config.StatusSchema.optional()
  }).transform(data => ({
    contextWindow: data.contextWindow,
    database: data.database ?? Config.DatabaseSchema.parse({}),
    geolocation: data.geolocation ?? Config.GeolocationSchema.parse({}),
    mcp: data.mcp ?? Config.McpSchema.parse({}),
    status: data.status ?? Config.StatusSchema.parse({})
  }));

  /**
   * Creates a new Config instance with validated settings
   *
   * Private, use `Config.validate(raw)` to construct.
   *
   * @private
   * @param {CcpConfig} settings - Pre-validated configuration
   */
  private constructor(settings: CcpConfig) {
    this.settings = settings;
  }

  /**
   * Validates a raw configuration object against the schema
   *
   * Transport-specific loaders read configuration from their natural source
   * (filesystem for stdio, secret env var for HTTP) and pass the raw object
   * here for validation.
   *
   * @static
   * @param {unknown} raw - Raw configuration object to validate
   * @returns {Config} Validated Config instance
   * @throws {Error} If validation fails
   */
  static validate(raw: unknown): Config {
    try {
      const validated = Config.ConfigSchema.parse(raw);
      return new Config(validated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        throw new Error(`Invalid CCP configuration: ${errors}`);
      }
      throw error;
    }
  }

  /**
   * Returns the configured context window size in tokens
   *
   * Used by `getContextUsage` for the percentage denominator. Defaults
   * to 1,000,000; override in config for different window sizes.
   *
   * @returns {number} Context window size in tokens
   */
  get contextWindow(): number {
    return this.settings.contextWindow;
  }

  /**
   * Returns database connection settings
   *
   * @returns {DatabaseConfig} Database settings
   */
  get database(): DatabaseConfig {
    return this.settings.database;
  }

  /**
   * Returns geolocation settings
   *
   * @returns {GeolocationConfig} Geolocation settings
   */
  get geolocation(): GeolocationConfig {
    return this.settings.geolocation;
  }

  /**
   * Returns MCP server limits
   *
   * Default is `sizeChars: 500000`.
   *
   * @returns {McpConfig} MCP settings
   */
  get mcp(): McpConfig {
    return this.settings.mcp;
  }

  /**
   * Returns upstream platform status settings
   *
   * @returns {StatusConfig} Status settings
   */
  get status(): StatusConfig {
    return this.settings.status;
  }
}

export default Config;
