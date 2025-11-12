/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { Config, MCPServerConfig } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  type McpClient,
  MCPDiscoveryState,
  populateMcpServerCommand,
} from './mcp-client.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getErrorMessage } from '../utils/errors.js';
import type { EventEmitter } from 'node:events';
import { coreEvents } from '../utils/events.js';
import { debugLogger } from '../utils/debugLogger.js';
import {
  type McpServerEnablementManager,
  generateMcpServerKey,
} from '../config/mcpServerEnablement.js';
import type { GeminiCLIExtension } from '../config/config.js';
import { McpClient as McpClientClass } from './mcp-client.js';
import { McpServerEnablementManager as McpServerEnablementManagerClass } from '../config/mcpServerEnablement.js';

/**
 * Determines the runtime type based on MCP server configuration
 */
function detectServerRuntime(
  config: MCPServerConfig,
): 'python' | 'typescript' | 'unknown' {
  if (!config.command) {
    // Network-based servers (SSE, HTTP) - default to typescript
    return 'typescript';
  }

  const cmd = config.command.toLowerCase();

  // Check for Python
  if (cmd.includes('python') || cmd.includes('python3') || cmd.includes('py')) {
    return 'python';
  }

  // Check for Node.js / TypeScript
  if (cmd.includes('node') || cmd.includes('ts-node') || cmd.includes('tsx')) {
    return 'typescript';
  }

  // Check args for hints
  if (config.args && config.args.length > 0) {
    const firstArg = config.args[0].toLowerCase();
    if (firstArg.endsWith('.py')) {
      return 'python';
    }
    if (
      firstArg.endsWith('.ts') ||
      firstArg.endsWith('.js') ||
      firstArg.endsWith('.mjs')
    ) {
      return 'typescript';
    }
  }

  return 'unknown';
}

/**
 * Manages MCP clients and their virtual filesystem representation.
 *
 * This class REPLACES McpClientManager and:
 * 1. Manages the lifecycle of multiple MCP clients
 * 2. Discovers MCP tools from connected clients
 * 3. Generates Python or TypeScript files for each tool based on server type
 * 4. Writes these files to a temporary directory structure
 * 5. Provides execution interface for tools
 */
export class McpVirtualManager {
  private clients: Map<string, McpClient> = new Map();
  private readonly toolRegistry: ToolRegistry;
  private readonly cliConfig: Config;
  private discoveryPromise: Promise<void> | undefined;
  private discoveryState: MCPDiscoveryState = MCPDiscoveryState.NOT_STARTED;
  private readonly eventEmitter?: EventEmitter;
  private readonly blockedMcpServers: Array<{
    name: string;
    extensionName: string;
  }> = [];
  private mcpEnablementManager?: McpServerEnablementManager;

  private basePath: string;
  private initialized = false;
  private serverRuntimes: Map<string, 'python' | 'typescript' | 'unknown'> =
    new Map();

  /**
   * Creates a new MCP Virtual Manager
   * @param toolRegistry The central registry where discovered tools will be registered
   * @param cliConfig The CLI configuration object
   * @param eventEmitter Optional event emitter for status updates
   * @param baseDir Optional base directory. If not provided, uses OS temp directory
   */
  constructor(
    toolRegistry: ToolRegistry,
    cliConfig: Config,
    eventEmitter?: EventEmitter,
    baseDir?: string,
  ) {
    this.toolRegistry = toolRegistry;
    this.cliConfig = cliConfig;
    this.eventEmitter = eventEmitter;
    this.basePath = baseDir || path.join(tmpdir(), 'gemini-cli-mcp-tools');
  }

  getBlockedMcpServers() {
    return this.blockedMcpServers;
  }

  /**
   * For all the MCP servers associated with this extension:
   *
   *    - Removes all its MCP servers from the global configuration object.
   *    - Disconnects all MCP clients from their servers.
   *    - Updates the Gemini chat configuration to load the new tools.
   */
  async stopExtension(extension: GeminiCLIExtension) {
    debugLogger.log(`Unloading extension: ${extension.name}`);
    await Promise.all(
      Object.keys(extension.mcpServers ?? {}).map(
        this.disconnectClient.bind(this),
      ),
    );
  }

  /**
   * For all the MCP servers associated with this extension:
   *
   *    - Adds all its MCP servers to the global configuration object.
   *    - Connects MCP clients to each server and discovers their tools.
   *    - Updates the Gemini chat configuration to load the new tools.
   */
  async startExtension(extension: GeminiCLIExtension) {
    debugLogger.log(`Loading extension: ${extension.name}`);
    await Promise.all(
      Object.entries(extension.mcpServers ?? {}).map(([name, config]) =>
        this.maybeDiscoverMcpServer(name, {
          ...config,
          extension,
        }),
      ),
    );
  }

  private isAllowedMcpServer(name: string) {
    const allowedNames = this.cliConfig.getAllowedMcpServers();
    if (
      allowedNames &&
      allowedNames.length > 0 &&
      allowedNames.indexOf(name) === -1
    ) {
      return false;
    }
    const blockedNames = this.cliConfig.getBlockedMcpServers();
    if (
      blockedNames &&
      blockedNames.length > 0 &&
      blockedNames.indexOf(name) !== -1
    ) {
      return false;
    }
    return true;
  }

  private async disconnectClient(name: string) {
    const existing = this.clients.get(name);
    if (existing) {
      try {
        this.clients.delete(name);
        this.eventEmitter?.emit('mcp-client-update', this.clients);
        await existing.disconnect();
      } catch (error) {
        debugLogger.warn(
          `Error stopping client '${name}': ${getErrorMessage(error)}`,
        );
      } finally {
        // This is required to update the content generator configuration with the
        // new tool configuration.
        const geminiClient = this.cliConfig.getGeminiClient();
        if (geminiClient.isInitialized()) {
          await geminiClient.setTools();
        }
      }
    }
  }

  maybeDiscoverMcpServer(
    name: string,
    config: MCPServerConfig,
  ): Promise<void> | void {
    // First layer: Check command-line allowlist/blocklist
    if (!this.isAllowedMcpServer(name)) {
      if (!this.blockedMcpServers.find((s) => s.name === name)) {
        this.blockedMcpServers?.push({
          name,
          extensionName: config.extension?.name ?? '',
        });
      }
      return;
    }
    // Second layer: Check user config enablement state
    if (this.mcpEnablementManager) {
      const serverKey = generateMcpServerKey(config.extension?.name, name);
      if (!this.mcpEnablementManager.isEnabled(serverKey)) {
        debugLogger.log(`MCP server '${name}' is disabled in user config`);
        return;
      }
    }
    if (!this.cliConfig.isTrustedFolder()) {
      return;
    }
    if (config.extension && !config.extension.isActive) {
      return;
    }
    const existing = this.clients.get(name);
    if (existing && existing.getServerConfig().extension !== config.extension) {
      const extensionText = config.extension
        ? ` from extension "${config.extension.name}"`
        : '';
      debugLogger.warn(
        `Skipping MCP config for server with name "${name}"${extensionText} as it already exists.`,
      );
      return;
    }

    const currentDiscoveryPromise = new Promise<void>((resolve, _reject) => {
      (async () => {
        try {
          if (existing) {
            await existing.disconnect();
          }

          const client =
            existing ??
            new McpClientClass(
              name,
              config,
              this.toolRegistry,
              this.cliConfig.getPromptRegistry(),
              this.cliConfig.getWorkspaceContext(),
              this.cliConfig.getDebugMode(),
            );
          if (!existing) {
            this.clients.set(name, client);
            this.eventEmitter?.emit('mcp-client-update', this.clients);
          }
          try {
            await client.connect();
            await client.discover(this.cliConfig);

            // After successful discovery, sync tools to virtual filesystem
            await this.syncServerToVirtualFs(name, client, config);

            this.eventEmitter?.emit('mcp-client-update', this.clients);
          } catch (error) {
            this.eventEmitter?.emit('mcp-client-update', this.clients);
            // Log the error but don't let a single failed server stop the others
            coreEvents.emitFeedback(
              'error',
              `Error during discovery for server '${name}': ${getErrorMessage(
                error,
              )}`,
              error,
            );
          }
        } finally {
          // This is required to update the content generator configuration with the
          // new tool configuration.
          const geminiClient = this.cliConfig.getGeminiClient();
          if (geminiClient.isInitialized()) {
            await geminiClient.setTools();
          }
          resolve();
        }
      })();
    });

    if (this.discoveryPromise) {
      this.discoveryPromise = this.discoveryPromise.then(
        () => currentDiscoveryPromise,
      );
    } else {
      this.discoveryState = MCPDiscoveryState.IN_PROGRESS;
      this.discoveryPromise = currentDiscoveryPromise;
    }
    this.eventEmitter?.emit('mcp-client-update', this.clients);
    const currentPromise = this.discoveryPromise;
    currentPromise.then((_) => {
      // If we are the last recorded discoveryPromise, then we are done, reset
      // the world.
      if (currentPromise === this.discoveryPromise) {
        this.discoveryPromise = undefined;
        this.discoveryState = MCPDiscoveryState.COMPLETED;
      }
    });
    return currentPromise;
  }

  /**
   * Initiates the tool discovery process for all configured MCP servers (via
   * gemini settings or command line arguments).
   *
   * It connects to each server, discovers its available tools, and registers
   * them with the `ToolRegistry`.
   *
   * For any server which is already connected, it will first be disconnected.
   *
   * This does NOT load extension MCP servers - this happens when the
   * ExtensionLoader explicitly calls `loadExtension`.
   */
  async startConfiguredMcpServers(): Promise<void> {
    if (!this.cliConfig.isTrustedFolder()) {
      return;
    }

    // Initialize enablement manager if not already initialized
    if (!this.mcpEnablementManager) {
      this.mcpEnablementManager = new McpServerEnablementManagerClass();
    }

    // Initialize virtual filesystem
    await this.initialize();

    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );

    this.eventEmitter?.emit('mcp-client-update', this.clients);
    await Promise.all(
      Object.entries(servers).map(([name, config]) =>
        this.maybeDiscoverMcpServer(name, config),
      ),
    );
  }

  /**
   * Restarts all active MCP Clients.
   */
  async restart(): Promise<void> {
    await Promise.all(
      Array.from(this.clients.entries()).map(async ([name, client]) => {
        try {
          await this.maybeDiscoverMcpServer(name, client.getServerConfig());
        } catch (error) {
          debugLogger.error(
            `Error restarting client '${name}': ${getErrorMessage(error)}`,
          );
        }
      }),
    );
  }

  /**
   * Restart a single MCP server by name.
   */
  async restartServer(name: string) {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`No MCP server registered with the name "${name}"`);
    }
    await this.maybeDiscoverMcpServer(name, client.getServerConfig());
  }

  /**
   * Stops all running local MCP servers and closes all client connections.
   * This is the cleanup method to be called on application exit.
   */
  async stop(): Promise<void> {
    const disconnectionPromises = Array.from(this.clients.entries()).map(
      async ([name, client]) => {
        try {
          await client.disconnect();
        } catch (error) {
          coreEvents.emitFeedback(
            'error',
            `Error stopping client '${name}':`,
            error,
          );
        }
      },
    );

    await Promise.all(disconnectionPromises);
    this.clients.clear();

    // Clean up virtual filesystem
    await this.cleanup();
  }

  getDiscoveryState(): MCPDiscoveryState {
    return this.discoveryState;
  }

  /**
   * All of the MCP server configurations currently loaded.
   */
  getMcpServers(): Record<string, MCPServerConfig> {
    const mcpServers: Record<string, MCPServerConfig> = {};
    for (const [name, client] of this.clients.entries()) {
      mcpServers[name] = client.getServerConfig();
    }
    return mcpServers;
  }

  /**
   * Get the MCP server enablement manager for controlling which servers are active.
   */
  getMcpEnablementManager(): McpServerEnablementManager | undefined {
    return this.mcpEnablementManager;
  }

  /**
   * Get all client instances (for status display)
   */
  getClients(): Map<string, McpClient> {
    return this.clients;
  }

  /**
   * Initializes the virtual filesystem by clearing any existing content
   */
  async initialize(): Promise<void> {
    try {
      // Clear and recreate the base directory
      await fs.rm(this.basePath, { recursive: true, force: true });
      await fs.mkdir(this.basePath, { recursive: true });

      debugLogger.log(
        `MCP virtual filesystem initialized at: ${this.basePath}`,
      );
      this.initialized = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize MCP virtual filesystem: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Synchronizes a single server's tools to the virtual filesystem
   * Note: Currently only generates TypeScript definitions
   */
  private async syncServerToVirtualFs(
    serverName: string,
    mcpClient: McpClient,
    config: MCPServerConfig,
  ): Promise<void> {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Detect server runtime for informational purposes
      const runtime = detectServerRuntime(config);
      this.serverRuntimes.set(serverName, runtime);

      // Get the underlying SDK client
      const client = (mcpClient as any).client as Client | undefined;
      if (!client) {
        debugLogger.warn(`Client for server '${serverName}' is not connected`);
        return;
      }

      // Check if server supports tools
      if (!client.getServerCapabilities()?.tools) {
        debugLogger.log(`Server '${serverName}' does not support tools`);
        return;
      }

      // List available tools
      const response = await client.request(
        { method: 'tools/list', params: {} },
        undefined as any,
      );

      const tools = (response as any).tools || [];
      if (tools.length === 0) {
        debugLogger.log(`No tools found on server '${serverName}'`);
        return;
      }

      // Create server directory
      const serverDir = path.join(this.basePath, 'servers', serverName);
      await fs.mkdir(serverDir, { recursive: true });

      // Generate TypeScript file for each tool
      // Note: Python support is planned for future implementation
      for (const tool of tools) {
        const toolName = tool.name as string;
        const fileContent = this.generateTypeScriptToolDefinition(
          serverName,
          tool,
        );
        const filePath = path.join(serverDir, `${toolName}.ts`);
        await fs.writeFile(filePath, fileContent, 'utf-8');

        debugLogger.debug(
          `Generated TypeScript tool definition: ${serverName}/${toolName}.ts`,
        );
      }

      debugLogger.log(
        `Synced ${tools.length} tool(s) for server '${serverName}' (detected runtime: ${runtime})`,
      );
    } catch (error) {
      debugLogger.warn(
        `Failed to sync tools for server '${serverName}': ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Generates TypeScript definition for a tool
   */
  private generateTypeScriptToolDefinition(
    serverName: string,
    tool: any,
  ): string {
    const toolName = tool.name as string;
    const description =
      (tool.description as string) || 'No description available';
    const inputSchema = tool.inputSchema || { type: 'object', properties: {} };

    // Generate TypeScript interface from JSON schema
    const interfaceName = this.toPascalCase(toolName) + 'Input';
    const interfaceContent = this.generateTsInterface(
      interfaceName,
      inputSchema,
    );

    // Generate the tool function
    return `/**
 * MCP Tool: ${toolName}
 * Server: ${serverName}
 *
 * ${description}
 */

${interfaceContent}

/**
 * Calls the ${toolName} tool on the ${serverName} MCP server
 *
 * @param input - The input parameters for the tool
 * @returns The result from the MCP tool execution
 */
export async function ${this.toCamelCase(toolName)}(
  input: ${interfaceName}
): Promise<any> {
  // This function is available in the TypeScript execution environment
  // It will be loaded dynamically by __loadMcpTool()
  return await __mcpClient.callTool('${serverName}', '${toolName}', input);
}

// Tool metadata
export const metadata = {
  name: '${toolName}',
  server: '${serverName}',
  description: \`${description.replace(/`/g, '\\`')}\`,
  inputSchema: ${JSON.stringify(inputSchema, null, 2)}
};
`;
  }

  /*
   * Python support is planned for future implementation
   * The following methods are kept for future use but currently commented out
   * to avoid "unused code" warnings during compilation.
   *
  private generatePythonToolDefinition(serverName: string, tool: any): string {
    const toolName = tool.name as string;
    const description = (tool.description as string) || 'No description available';
    const inputSchema = tool.inputSchema || { type: 'object', properties: {} };
    const pythonParams = this.generatePythonParams(inputSchema);

    return `"""
MCP Tool: ${toolName}
Server: ${serverName}
${description}
"""
from typing import Any, Dict, Optional, List
import json

METADATA = {
    'name': '${toolName}',
    'server': '${serverName}',
    'description': '''${description.replace(/'/g, "\\'")}''',
    'input_schema': ${JSON.stringify(inputSchema, null, 4).replace(/"/g, "'")}
}

async def ${this.toSnakeCase(toolName)}(${pythonParams}) -> Any:
    """Calls the ${toolName} tool on the ${serverName} MCP server"""
    return await __mcp_client.call_tool('${serverName}', '${toolName}', locals())
`;
  }

  private generatePythonParams(schema: any): string {
    if (schema.type !== 'object' || !schema.properties) {
      return '**kwargs: Any';
    }
    const properties = schema.properties || {};
    const required = new Set(schema.required || []);
    const params: string[] = [];
    for (const [key, prop] of Object.entries(properties)) {
      const isRequired = required.has(key);
      const pythonType = this.jsonSchemaToPhythonType(prop as any);
      if (isRequired) {
        params.push(`${key}: ${pythonType}`);
      } else {
        params.push(`${key}: Optional[${pythonType}] = None`);
      }
    }
    return params.join(', ');
  }

  private jsonSchemaToPhythonType(schema: any): string {
    if (!schema.type) return 'Any';
    switch (schema.type) {
      case 'string': return 'str';
      case 'number': return 'float';
      case 'integer': return 'int';
      case 'boolean': return 'bool';
      case 'array': {
        const itemType = schema.items ? this.jsonSchemaToPhythonType(schema.items) : 'Any';
        return `List[${itemType}]`;
      }
      case 'object': return 'Dict[str, Any]';
      case 'null': return 'None';
      default: return 'Any';
    }
  }
  */

  /**
   * Generates TypeScript interface from JSON schema
   */
  private generateTsInterface(name: string, schema: any): string {
    if (schema.type !== 'object') {
      return `export type ${name} = any;`;
    }

    const properties = schema.properties || {};
    const required = new Set(schema.required || []);

    const fields = Object.entries(properties).map(
      ([key, prop]: [string, any]) => {
        const isRequired = required.has(key);
        const optional = isRequired ? '' : '?';
        const type = this.jsonSchemaToTsType(prop);
        const description = prop.description
          ? `  /** ${prop.description} */\n`
          : '';

        return `${description}  ${key}${optional}: ${type};`;
      },
    );

    if (fields.length === 0) {
      return `export interface ${name} {}`;
    }

    return `export interface ${name} {
${fields.join('\n')}
}`;
  }

  /**
   * Converts JSON schema type to TypeScript type
   */
  private jsonSchemaToTsType(schema: any): string {
    if (!schema.type) {
      return 'any';
    }

    switch (schema.type) {
      case 'string':
        if (schema.enum) {
          return schema.enum.map((v: string) => `'${v}'`).join(' | ');
        }
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array': {
        const itemType = schema.items
          ? this.jsonSchemaToTsType(schema.items)
          : 'any';
        return `Array<${itemType}>`;
      }
      case 'object':
        if (schema.properties) {
          // Inline object type
          const props = Object.entries(schema.properties).map(
            ([key, prop]: [string, any]) => {
              const type = this.jsonSchemaToTsType(prop);
              return `${key}: ${type}`;
            },
          );
          return `{ ${props.join(', ')} }`;
        }
        return 'Record<string, any>';
      case 'null':
        return 'null';
      default:
        return 'any';
    }
  }

  /**
   * Converts a string to PascalCase
   */
  private toPascalCase(str: string): string {
    return str
      .replace(/[_-](.)/g, (_, c) => c.toUpperCase())
      .replace(/^(.)/, (_, c) => c.toUpperCase())
      .replace(/[^a-zA-Z0-9]/g, '');
  }

  /**
   * Converts a string to camelCase
   */
  private toCamelCase(str: string): string {
    const pascal = this.toPascalCase(str);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
  }

  /**
   * Converts a string to snake_case
   * NOTE: Currently unused - kept for future Python support
   */
  /*
  private toSnakeCase(str: string): string {
    return str
      .replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
      .replace(/^_/, '')
      .replace(/[^a-z0-9_]/g, '_');
  }
  */

  /**
   * Gets the base path of the virtual filesystem
   */
  getBasePath(): string {
    return this.basePath;
  }

  /**
   * Gets the runtime type for a server
   */
  getServerRuntime(
    serverName: string,
  ): 'python' | 'typescript' | 'unknown' | undefined {
    return this.serverRuntimes.get(serverName);
  }

  /**
   * Calls an MCP tool from user code execution context.
   * This method is used by the __mcpClient interface in typescript-tool.ts
   *
   * @param serverName The MCP server name
   * @param toolName The tool name
   * @param input The tool input parameters
   * @returns The result from the MCP tool
   */
  async callTool(
    serverName: string,
    toolName: string,
    input: any,
  ): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server '${serverName}' not found or not connected`);
    }

    // Get tools for this server from the tool registry
    const tools = this.toolRegistry.getToolsByServer(serverName);

    // Find the specific tool - tools are registered with format: serverName__toolName
    const toolKey = `${serverName}__${toolName}`;
    const tool: any = tools.find(
      (t: any) => t.name === toolKey || t.serverToolName === toolName,
    );

    if (!tool) {
      throw new Error(
        `Tool '${toolName}' not found on MCP server '${serverName}'`,
      );
    }

    // Create a tool invocation and execute it
    const invocation = tool.createInvocation(input);
    const result = await invocation.execute(new AbortController().signal);

    if (result.error) {
      throw new Error(result.error.message || 'MCP tool execution failed');
    }

    return result.llmContent;
  }

  /**
   * Provides context information to the LLM about MCP tools location and usage.
   * Similar to WorkspaceManager.getEnvironmentContext(), this method returns
   * context that guides the LLM on how to discover and use MCP tools.
   *
   * @returns Promise<string> describing the MCP tools virtual filesystem
   */
  async getMcpToolsContext(): Promise<string> {
    if (!this.initialized || this.clients.size === 0) {
      return '';
    }

    const serverList: string[] = [];
    for (const [serverName, _client] of this.clients.entries()) {
      const runtime = this.serverRuntimes.get(serverName) || 'unknown';
      const serverPath = path.join(this.basePath, 'servers', serverName);

      try {
        const files = await fs.readdir(serverPath);
        const toolCount = files.filter((f) => f.endsWith('.ts')).length;
        serverList.push(
          `  - ${serverName} (${runtime} server, ${toolCount} tool${toolCount !== 1 ? 's' : ''})`,
        );
      } catch (_error) {
        // Server directory might not exist yet
        serverList.push(`  - ${serverName} (${runtime} server, no tools)`);
      }
    }

    if (serverList.length === 0) {
      return '';
    }

    return `
<mcp_tools>
MCP (Model Context Protocol) tools are available in a virtual filesystem at:
${this.basePath}

Available MCP servers:
${serverList.join('\n')}

Directory structure:
  ${this.basePath}/
    servers/
      {server_name}/
        {tool_name}.ts   (TypeScript tool definitions)

To discover and use MCP tools:
1. Use 'ls' to explore the servers directory structure
2. Use 'cat' to read individual tool definition files
3. Each .ts file contains:
   - Tool description and JSDoc comments
   - TypeScript interface for input parameters
   - An async function ready to call
   - Tool metadata (name, server, schema)

4. To call a tool, write TypeScript code that:
   - Imports the tool definition file
   - Calls the exported function with typed parameters
   - The function internally routes to the MCP server via __mcpClient

Example workflow:
  # Discover available MCP servers
  ls ${this.basePath}/servers

  # Explore tools for a specific server
  ls ${this.basePath}/servers/{server_name}

  # Read a tool's definition to see its usage
  cat ${this.basePath}/servers/{server_name}/{tool_name}.ts

  # Use the tool in your TypeScript code
  import { toolFunction } from '${this.basePath}/servers/{server_name}/{tool_name}.ts';
  const result = await toolFunction({ param: value });

IMPORTANT:
- These tools are part of the MCP protocol and provide extended capabilities
- All tools are callable from TypeScript code execution environment
- Always check the tool's input schema and description before using it
- The __mcpClient interface is automatically available in the execution context
</mcp_tools>
`.trim();
  }

  /**
   * Cleans up the virtual filesystem
   */
  async cleanup(): Promise<void> {
    try {
      await fs.rm(this.basePath, { recursive: true, force: true });
      debugLogger.log('MCP virtual filesystem cleaned up');
      this.initialized = false;
    } catch (error) {
      debugLogger.warn(
        `Error cleaning up MCP virtual filesystem: ${getErrorMessage(error)}`,
      );
    }
  }
}
