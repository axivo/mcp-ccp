#!/usr/bin/env node
/**
 * CCP MCP Server Entry Point (stdio)
 *
 * Loads configuration from a JSON file (path resolved from `CCP_CONFIG_PATH`
 * env var or `~/.claude/ccp/config.json`), validates it, and starts the MCP
 * server over stdio transport.
 *
 * The HTTP/Worker entry point lives separately and loads configuration from
 * a Worker Secret instead of a file.
 *
 * @module index
 * @author AXIVO
 * @license BSD-3-Clause
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config } from './server/config.js';
import { Mcp } from './server/mcp.js';

/**
 * Resolves the configuration file path for stdio transport
 *
 * @returns {string | null} Path to config file, or null when no path resolves
 */
function resolveConfigPath(): string | null {
  const envPath = process.env.CCP_CONFIG_PATH;
  if (envPath) {
    return envPath;
  }
  const defaultPath = join(homedir(), '.claude', 'ccp', 'config.json');
  if (existsSync(defaultPath)) {
    return defaultPath;
  }
  return null;
}

/**
 * Loads configuration from the resolved file path
 *
 * Reads JSON, returns the parsed object. Returns empty object when no
 * file exists so bundled defaults apply.
 *
 * @returns {unknown} Raw configuration object
 */
function loadConfigFromFile(): unknown {
  const path = resolveConfigPath();
  if (!path || !existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Main entry point for the CCP MCP Server (stdio transport)
 *
 * @async
 * @function main
 * @throws {Error} When server initialization fails
 */
async function main(): Promise<void> {
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error.message);
    if (error.message.includes('EPIPE') || (error as any).code === 'EPIPE') {
      console.error('EPIPE error caught - continuing operation');
      return;
    }
    console.error('Fatal error:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    if (reason && typeof reason === 'object' &&
      ((reason as any).code === 'EPIPE' || (reason as Error).message?.includes('EPIPE'))) {
      console.error('EPIPE rejection caught - continuing operation');
      return;
    }
  });
  const config = Config.validate(loadConfigFromFile());
  const mcpServer = new Mcp(config);
  const transport = new StdioServerTransport();
  try {
    await mcpServer.connect(transport);
  } catch (error) {
    console.error('Failed to connect MCP transport:', error);
  }
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
