/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpClientManager } from '../tools/mcp-client-manager.js';
import type { McpClient } from '../tools/mcp-client.js';

/**
 * Virtual file representation for MCP tools
 */
interface VirtualFile {
  path: string;
  content: string;
  language: 'typescript' | 'python';
  serverName: string;
  toolName: string;
}

/**
 * Tool information from MCP server
 */
interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Manages the virtual filesystem for MCP tools
 *
 * This creates a lightweight virtual filesystem that LLMs can browse to discover
 * and use MCP tools. Following Anthropic's approach, this achieves 98%+ token
 * savings by:
 * 1. Showing only a directory tree in the system prompt (~200 tokens)
 * 2. Allowing LLM to read specific tool definitions on demand
 * 3. LLM writes code to call tools instead of direct tool invocation
 */
export class McpVirtualFilesystem {
  private files: Map<string, VirtualFile> = new Map();
  private directoryTree: string = '';
  private isGenerated: boolean = false;

  constructor(private readonly mcpClientManager: McpClientManager) {}

  /**
   * Generate virtual filesystem from connected MCP servers
   * Should be called after MCP discovery completes
   */
  async generate(): Promise<void> {
    this.files.clear();
    this.isGenerated = false;

    const clients = this.mcpClientManager.getClients();
    if (clients.size === 0) {
      this.directoryTree = 'servers/\n(No MCP servers connected)';
      return;
    }

    // Collect tool information from each MCP server
    const serverTools = new Map<string, McpToolInfo[]>();

    for (const [serverName, client] of clients.entries()) {
      try {
        // Get tools from the MCP client
        const tools = await this.getToolsFromClient(client);
        if (tools.length > 0) {
          serverTools.set(serverName, tools);
        }
      } catch (error) {
        console.warn(
          `Failed to get tools from MCP server ${serverName}:`,
          error,
        );
      }
    }

    // Generate virtual TypeScript files for each tool
    for (const [serverName, tools] of serverTools.entries()) {
      for (const tool of tools) {
        const tsContent = this.generateTypeScriptFile(
          serverName,
          tool.name,
          tool.description,
          tool.inputSchema,
        );

        const path = `servers/${serverName}/${tool.name}.ts`;
        this.files.set(path, {
          path,
          content: tsContent,
          language: 'typescript',
          serverName,
          toolName: tool.name,
        });
      }
    }

    // Generate directory tree
    this.directoryTree = this.generateDirectoryTree(serverTools);
    this.isGenerated = true;
  }

  /**
   * Get tools from an MCP client
   */
  private async getToolsFromClient(client: McpClient): Promise<McpToolInfo[]> {
    try {
      // Access the internal MCP SDK client through the private 'client' property
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcpClient = (client as any).client;

      if (!mcpClient || typeof mcpClient.listTools !== 'function') {
        return [];
      }

      const result = await mcpClient.listTools();
      const tools = result.tools || [];

      return tools.map(
        (tool: {
          name: string;
          description?: string;
          inputSchema: unknown;
        }) => ({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema,
        }),
      );
    } catch (error) {
      console.warn('Failed to list tools from MCP client:', error);
      return [];
    }
  }

  /**
   * Get the directory tree structure (for system prompt)
   */
  getDirectoryTree(): string {
    return this.directoryTree;
  }

  /**
   * Check if filesystem has been generated
   */
  isReady(): boolean {
    return this.isGenerated;
  }

  /**
   * Read a virtual file by path
   */
  readFile(path: string): VirtualFile | undefined {
    return this.files.get(path);
  }

  /**
   * List all files in a directory
   */
  listDirectory(dirPath: string): string[] {
    const normalizedPath = dirPath.endsWith('/') ? dirPath : dirPath + '/';

    return Array.from(this.files.keys())
      .filter((path) => path.startsWith(normalizedPath))
      .map((path) => path.substring(normalizedPath.length))
      .filter((relativePath) => !relativePath.includes('/'));
  }

  /**
   * Get total number of virtual files
   */
  getFileCount(): number {
    return this.files.size;
  }

  /**
   * Generate directory tree structure
   */
  private generateDirectoryTree(
    serverTools: Map<string, McpToolInfo[]>,
  ): string {
    if (serverTools.size === 0) {
      return 'servers/\n(No MCP tools available)';
    }

    const lines: string[] = [];
    lines.push('servers/');

    const serverNames = Array.from(serverTools.keys()).sort();
    serverNames.forEach((serverName, serverIndex) => {
      const isLastServer = serverIndex === serverNames.length - 1;
      const serverPrefix = isLastServer ? '└──' : '├──';
      lines.push(`${serverPrefix} ${serverName}/`);

      const tools = serverTools.get(serverName)!;
      const continuationMark = isLastServer ? '    ' : '│   ';

      tools.forEach((tool, toolIndex) => {
        const isLastTool = toolIndex === tools.length - 1;
        const toolPrefix = isLastTool ? '└──' : '├──';
        lines.push(`${continuationMark}${toolPrefix} ${tool.name}.ts`);
      });
    });

    return lines.join('\n');
  }

  /**
   * Generate TypeScript interface file for an MCP tool
   */
  private generateTypeScriptFile(
    serverName: string,
    toolName: string,
    description: string,
    inputSchema: unknown,
  ): string {
    const lines: string[] = [];

    lines.push(`// File: servers/${serverName}/${toolName}.ts`);
    lines.push(`// Auto-generated MCP tool interface`);
    lines.push('');
    lines.push(`import { callMCPTool } from "../../../client.js";`);
    lines.push('');

    // Generate input interface from schema
    const inputInterfaceName = this.toPascalCase(toolName) + 'Input';
    const schema = inputSchema as {
      type?: string;
      properties?: Record<
        string,
        {
          type?: string;
          description?: string;
          items?: { type?: string };
          enum?: unknown[];
        }
      >;
      required?: string[];
    };

    if (schema?.properties) {
      lines.push(`/**`);
      lines.push(` * Input parameters for ${toolName}`);
      lines.push(` */`);
      lines.push(`interface ${inputInterfaceName} {`);
      const requiredFields = new Set(schema.required || []);

      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        const isRequired = requiredFields.has(propName);
        const tsType = this.jsonSchemaTypeToTS(propSchema);
        const optional = isRequired ? '' : '?';

        if (propSchema.description) {
          lines.push(`  /** ${propSchema.description} */`);
        }
        lines.push(`  ${propName}${optional}: ${tsType};`);
      }

      lines.push('}');
    } else {
      lines.push(`interface ${inputInterfaceName} {`);
      lines.push(`  [key: string]: unknown;`);
      lines.push('}');
    }

    lines.push('');
    lines.push(`/**`);
    lines.push(` * Response from ${toolName}`);
    lines.push(` */`);
    lines.push(`interface ${this.toPascalCase(toolName)}Response {`);
    lines.push('  [key: string]: unknown;');
    lines.push('}');
    lines.push('');

    // Generate function signature
    lines.push(`/**`);
    lines.push(` * ${description}`);
    lines.push(` *`);
    lines.push(` * @param input - The input parameters`);
    lines.push(` * @returns Promise resolving to the tool response`);
    lines.push(` */`);
    lines.push(`export async function ${toolName}(`);
    lines.push(`  input: ${inputInterfaceName}`);
    lines.push(`): Promise<${this.toPascalCase(toolName)}Response> {`);
    lines.push(`  return callMCPTool<${this.toPascalCase(toolName)}Response>(`);
    lines.push(`    '${serverName}__${toolName}',`);
    lines.push(`    input`);
    lines.push(`  );`);
    lines.push(`}`);

    return lines.join('\n');
  }

  private toPascalCase(str: string): string {
    return str
      .split(/[_-]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }

  private jsonSchemaTypeToTS(propSchema: {
    type?: string;
    items?: { type?: string };
    enum?: unknown[];
  }): string {
    // Handle enum
    if (propSchema.enum) {
      const enumValues = propSchema.enum
        .map((v) => (typeof v === 'string' ? `'${v}'` : String(v)))
        .join(' | ');
      return enumValues;
    }

    // Handle array
    if (propSchema.type === 'array') {
      const itemType = propSchema.items?.type
        ? this.jsonSchemaTypeToTS({ type: propSchema.items.type })
        : 'unknown';
      return `${itemType}[]`;
    }

    // Handle primitive types
    switch (propSchema.type) {
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'object':
        return 'Record<string, unknown>';
      default:
        return 'unknown';
    }
  }
}
