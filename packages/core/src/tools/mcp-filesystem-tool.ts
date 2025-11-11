/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { McpVirtualFilesystem } from '../mcp/virtual-filesystem.js';

/**
 * Parameters for listing MCP filesystem directory structure
 */
interface McpLsParams {
  path?: string;
}

/**
 * Parameters for reading MCP tool definitions
 */
interface McpReadParams {
  path: string;
}

/**
 * Invocation for MCP directory listing
 */
class McpLsInvocation extends BaseToolInvocation<McpLsParams, ToolResult> {
  constructor(
    params: McpLsParams,
    private readonly virtualFs: McpVirtualFilesystem,
  ) {
    super(params);
  }

  getDescription(): string {
    const path = this.params.path || 'servers/';
    return `List MCP filesystem structure at ${path}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const treeOutput = this.virtualFs.getDirectoryTree();

    if (!treeOutput || treeOutput === 'servers/') {
      return {
        llmContent:
          'No MCP tools are currently available. Make sure MCP servers are connected.',
        returnDisplay: '(No MCP tools available)',
      };
    }

    return {
      llmContent: `MCP Virtual Filesystem:\n\n\`\`\`\n${treeOutput}\n\`\`\`\n\nEach .ts file represents an MCP tool interface. Use \`mcp_read\` to read specific tool definitions.`,
      returnDisplay: treeOutput,
    };
  }
}

/**
 * Invocation for reading MCP tool definitions
 */
class McpReadInvocation extends BaseToolInvocation<McpReadParams, ToolResult> {
  constructor(
    params: McpReadParams,
    private readonly virtualFs: McpVirtualFilesystem,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Read MCP tool definition: ${this.params.path}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    // Normalize path
    let path = this.params.path;
    if (!path.startsWith('servers/')) {
      path = 'servers/' + path;
    }
    if (!path.endsWith('.ts') && !path.endsWith('.py')) {
      path = path + '.ts';
    }

    const file = this.virtualFs.readFile(path);

    if (!file) {
      return {
        llmContent: `❌ File not found: ${path}\n\nUse \`mcp_ls\` to see available files.`,
        returnDisplay: `File not found: ${path}`,
      };
    }

    return {
      llmContent: `\`\`\`${file.language}\n${file.content}\n\`\`\`\n\nYou can import and use this tool in your ${file.language === 'typescript' ? 'TypeScript' : 'Python'} code.`,
      returnDisplay: file.content,
    };
  }
}

/**
 * Tool for listing MCP virtual filesystem structure
 */
export class McpLsTool extends BaseDeclarativeTool<McpLsParams, ToolResult> {
  constructor(private readonly virtualFs: McpVirtualFilesystem) {
    super(
      'mcp_ls',
      'List MCP Tools',
      `List the MCP virtual filesystem showing available tool interfaces.

This displays a tree structure of all MCP servers and their tools:
- Each server has its own directory
- Each tool has a .ts file with its TypeScript interface

This is the most token-efficient way to discover available MCP tools.

Example: {} will list all servers and tools`,
      Kind.Read,
      {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional path to list (default: "servers/")',
          },
        },
      },
      true,
      false,
    );
  }

  protected createInvocation(
    params: McpLsParams,
  ): ToolInvocation<McpLsParams, ToolResult> {
    return new McpLsInvocation(params, this.virtualFs);
  }
}

/**
 * Tool for reading MCP tool interface files
 */
export class McpReadTool extends BaseDeclarativeTool<
  McpReadParams,
  ToolResult
> {
  constructor(private readonly virtualFs: McpVirtualFilesystem) {
    super(
      'mcp_read',
      'Read MCP Tool Interface',
      `Read a TypeScript interface file for an MCP tool.

Returns the complete TypeScript definition including:
- Input parameter interface
- Response interface
- Function signature
- JSDoc documentation

Example: { "path": "servers/excel/create_workbook.ts" }

After reading the interface, you can write TypeScript code using the typescript tool to call the MCP tool.`,
      Kind.Read,
      {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path to the tool file (e.g., "servers/excel/create_workbook.ts")',
          },
        },
        required: ['path'],
      },
      true,
      false,
    );
  }

  protected createInvocation(
    params: McpReadParams,
  ): ToolInvocation<McpReadParams, ToolResult> {
    return new McpReadInvocation(params, this.virtualFs);
  }
}
