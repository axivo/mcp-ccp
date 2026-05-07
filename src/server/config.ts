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
  database: DatabaseConfig;
  geolocation: GeolocationConfig;
}

/**
 * Database connection settings
 */
export interface DatabaseConfig {
  host: string;
  name: string;
  password: string;
  port: number;
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
    port: z.number().int().positive().default(5432),
    name: z.string().default('ccp'),
    user: z.string().default('postgres'),
    password: z.string().default('')
  });
  private static readonly GeolocationSchema = z.object({
    service: z.string().url().default('https://ipinfo.io/json'),
    override: z.string().optional(),
    fallbackTimezone: z.string().default('UTC')
  });
  private static readonly ConfigSchema = z.object({
    database: Config.DatabaseSchema.optional(),
    geolocation: Config.GeolocationSchema.optional()
  }).transform(data => ({
    database: data.database ?? Config.DatabaseSchema.parse({}),
    geolocation: data.geolocation ?? Config.GeolocationSchema.parse({})
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
}

export default Config;
