/**
 * CCP MCP Server implementation
 *
 * @module server/mcp
 * @author AXIVO
 * @license BSD-3-Clause
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
  private static readonly toolActions = {
    browse: 'observe',
    load: 'observe',
    log: 'act',
    render: 'observe',
    set: 'act',
    status: 'observe',
    update: 'act'
  } as const;

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
    this.tool = new McpTool(this.config);
    this.registerAll();
  }

  /**
   * Returns all tool definitions in a wire-friendly shape for the status tool
   *
   * Iterates every registered tool, converts each Zod input/output schema to
   * JSON Schema for portability, and lifts `_meta.usage` to a top-level `usage`
   * field for ergonomic consumption.
   *
   * @private
   * @returns {object[]} Array of tool definitions
   */
  private getToolDefinitions(): Record<string, unknown>[] {
    const entries: { name: string; config: Record<string, unknown> }[] = [
      { name: 'browse', config: this.tool.browse() },
      { name: 'load', config: this.tool.load() },
      { name: 'log', config: this.tool.log() },
      { name: 'render', config: this.tool.render() },
      { name: 'set', config: this.tool.set() },
      { name: 'status', config: this.tool.status() },
      { name: 'update', config: this.tool.update() }
    ];
    return entries.map(({ name, config }) => {
      const definition: Record<string, unknown> = {
        name,
        description: config.description ?? ''
      };
      if (config.inputSchema && Object.keys(config.inputSchema as Record<string, unknown>).length > 0) {
        definition.inputSchema = z.toJSONSchema(z.object(config.inputSchema as z.ZodRawShape));
      }
      if (config.outputSchema && Object.keys(config.outputSchema as Record<string, unknown>).length > 0) {
        definition.outputSchema = z.toJSONSchema(z.object(config.outputSchema as z.ZodRawShape));
      }
      if (config.annotations) {
        definition.annotations = config.annotations;
      }
      const meta = config._meta as { usage?: string[] } | undefined;
      if (meta?.usage) {
        definition.usage = meta.usage;
      }
      return definition;
    });
  }

  /**
   * Handles the browse tool, fetches a URL and returns readable markdown
   *
   * @private
   * @param {object} args - Tool arguments
   * @returns {Promise<any>} Tool execution response
   */
  private async handleBrowse(args: { url: string; mode?: 'raw' | 'read'; timeout?: number }) {
    try {
      const result = await this.client.browse(args);
      return this.structured('browse', result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.client.error(message);
    }
  }

  /**
   * Handles the load tool, fetches framework data of the given type
   *
   * @private
   * @param {object} args - Tool arguments
   * @returns {Promise<any>} Tool execution response
   */
  private async handleLoad(args: { type: 'cycle' | 'feeling' | 'impulse' | 'instruction' | 'profile' | 'session'; parent?: string; limit?: number; offset?: number; uuid?: string }) {
    try {
      const result = await this.client.load(args.type, args.parent, { limit: args.limit, offset: args.offset, uuid: args.uuid });
      return this.structured('load', result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.client.response(`load failed: ${message}`);
    }
  }

  /**
   * Handles the log tool, persists a per-response session row
   *
   * @private
   * @param {object} args - Tool arguments
   * @returns {Promise<any>} Tool execution response
   */
  private async handleLog(args: { payload: { message: string }; status: { cycle: string; feeling: string[]; impulse: string[]; observation: string[]; protocol: 'bypassed' | 'partial' | 'successful' } }) {
    try {
      const result = await this.client.log(args);
      return this.structured('log', result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.client.error(message);
    }
  }

  /**
   * Handles the render tool, renders a formatted output string for the requested key
   *
   * @private
   * @param {object} args - Tool arguments
   * @returns {Promise<any>} Tool execution response
   */
  private async handleRender(args: { key: 'profile'; value?: string }) {
    try {
      const result = await this.client.render(args);
      return this.structured('render', result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.client.response(`render failed: ${message}`);
    }
  }

  /**
   * Handles the set tool, sets a framework value and returns resulting row state
   *
   * @private
   * @param {object} args - Tool arguments
   * @returns {Promise<any>} Tool execution response
   */
  private async handleSet(args: { key: 'session'; payload?: { title?: string; description?: string } }) {
    try {
      const result = await this.client.set(args);
      return this.structured('set', result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.client.response(`set failed: ${message}`);
    }
  }

  /**
   * Handles the status tool, returns the full tool surface with usage
   *
   * @private
   * @returns {Promise<any>} Tool execution response
   */
  private async handleStatus() {
    try {
      const { payload, upstream, ...database } = await this.client.status();
      const tools = this.getToolDefinitions();
      return this.structured('status', { database, payload, tools, upstream });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.client.response(`status failed: ${message}`);
    }
  }

  /**
   * Handles the update tool, applies any pending migrations
   *
   * @private
   * @returns {Promise<any>} Tool execution response
   */
  private async handleUpdate() {
    try {
      const result = await this.client.update();
      return this.structured('update', result as unknown as Record<string, unknown>);
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
    this.server.registerTool('browse', this.tool.browse(), (args) => this.handleBrowse(args as { url: string; mode?: 'raw' | 'read'; timeout?: number }));
    this.server.registerTool('load', this.tool.load(), (args) => this.handleLoad(args as { type: 'cycle' | 'feeling' | 'impulse' | 'instruction' | 'profile' | 'session'; parent?: string; limit?: number; offset?: number; uuid?: string }));
    this.server.registerTool('log', this.tool.log(), (args) => this.handleLog(args as { payload: { message: string }; status: { cycle: string; feeling: string[]; impulse: string[]; observation: string[]; protocol: 'bypassed' | 'partial' | 'successful' } }));
    this.server.registerTool('render', this.tool.render(), (args) => this.handleRender(args as { key: 'profile'; value?: string }));
    this.server.registerTool('set', this.tool.set(), (args) => this.handleSet(args as { key: 'session'; payload?: { title?: string; description?: string } }));
    this.server.registerTool('status', this.tool.status(), () => this.handleStatus());
    this.server.registerTool('update', this.tool.update(), () => this.handleUpdate());
  }

  /**
   * Builds an output payload for tool responses with structured content
   *
   * Prepends the tool's `action` classification from `toolActions` so siblings
   * can branch on observe vs act when consuming responses, then JSON-encodes
   * the merged payload into both the text content envelope and the typed
   * `structuredContent` field.
   *
   * @private
   * @param {keyof typeof toolActions} toolName - Tool name used to resolve the action classification
   * @param {object} output - Structured output payload returned by the handler
   * @returns {object} CallToolResult with both text content and structuredContent
   */
  private structured<T extends Record<string, unknown>>(toolName: keyof typeof Mcp.toolActions, output: T): { content: { type: 'text'; text: string }[]; structuredContent: T & { action: typeof Mcp.toolActions[keyof typeof Mcp.toolActions] } } {
    const payload = { action: Mcp.toolActions[toolName], ...output };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload
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
