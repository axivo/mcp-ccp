/**
 * CCP MCP Server implementation
 *
 * @module server/mcp
 * @author AXIVO
 * @license BSD-3-Clause
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from './client.js';
import { Config } from './config.js';
import { McpTool } from './tool.js';

/**
 * CCP MCP Server implementation bridging the Claude Collaboration Platform
 * with Model Context Protocol
 *
 * Provides framework-memory and platform queries through MCP tools, managing
 * the Postgres client, request routing, and response formatting.
 *
 * @class Mcp
 */
export class Mcp {
  private client: Client;
  private config: Config;
  private server: McpServer;
  private tool: McpTool;

  /**
   * Creates a new Mcp instance with the given configuration
   *
   * Configuration is loaded by the entry point (transport-specific) and
   * passed in. This keeps the server transport-agnostic. Initializes the
   * Postgres client, MCP server, tool definitions, and registers every
   * tool with the underlying McpServer registry.
   *
   * @param {Config} config - Validated CCP configuration
   */
  constructor(config: Config) {
    this.config = config;
    this.client = new Client(this.config);
    this.server = new McpServer(
      { name: 'ccp', version: this.client.getVersion() },
      { capabilities: { tools: {} } }
    );
    this.tool = new McpTool();
    this.registerAll();
  }

  /**
   * Handles the load tool — fetches framework data of the given type
   *
   * @private
   * @param {object} args - Tool arguments
   * @returns {Promise<any>} Tool execution response
   */
  private async handleLoad(args: { type: 'cycle' | 'feeling' | 'impulse' | 'instruction' | 'profile' | 'session'; parent?: string }) {
    try {
      const result = await this.client.load(args.type, args.parent);
      return this.structured(result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.client.response(`load failed: ${message}`);
    }
  }

  /**
   * Handles the log_response tool — persists a per-response session row
   *
   * @private
   * @param {object} args - Tool arguments
   * @returns {Promise<any>} Tool execution response
   */
  private async handleLogResponse(args: { message: string; status: { cycle: string; feelings: number; impulses: number; observations: number; protocol: string } }) {
    try {
      const result = await this.client.logResponse(args);
      return this.structured(result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.client.response(`log_response failed: ${message}`);
    }
  }

  /**
   * Handles the update tool — applies any pending migrations
   *
   * @private
   * @returns {Promise<any>} Tool execution response
   */
  private async handleUpdate() {
    try {
      const result = await this.client.update();
      return this.structured(result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.client.response(`update failed: ${message}`);
    }
  }

  /**
   * Registers every tool with the McpServer registry
   *
   * Each call wires a tool definition from `McpTool` to its handler.
   * The SDK validates incoming arguments against the tool's `inputSchema`
   * and (when present) the tool's response against its `outputSchema`.
   *
   * @private
   */
  private registerAll(): void {
    this.server.registerTool('load', this.tool.load(), (args) => this.handleLoad(args as { type: 'cycle' | 'feeling' | 'impulse' | 'instruction' | 'profile' | 'session'; parent?: string }));
    this.server.registerTool('log_response', this.tool.logResponse(), (args) => this.handleLogResponse(args as { message: string; status: { cycle: string; feelings: number; impulses: number; observations: number; protocol: string } }));
    this.server.registerTool('update', this.tool.update(), () => this.handleUpdate());
  }

  /**
   * Builds an output payload for tool responses with structured content
   *
   * @private
   * @param {object} output - Structured output payload
   * @returns {object} CallToolResult with both text content and structuredContent
   */
  private structured<T extends Record<string, unknown>>(output: T): { content: { type: 'text'; text: string }[]; structuredContent: T } {
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output
    };
  }

  /**
   * Connects the MCP server to stdio transport with error handling
   *
   * @param {StdioServerTransport} transport - Stdio transport for MCP communication
   * @returns {Promise<void>}
   */
  async connect(transport: StdioServerTransport): Promise<void> {
    transport.onerror = () => { };
    await this.server.connect(transport);
  }
}
