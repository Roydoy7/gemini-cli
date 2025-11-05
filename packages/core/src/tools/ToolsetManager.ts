/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { LSTool } from './ls.js';
import { ReadFileTool } from './read-file.js';
import { GrepTool } from './grep.js';
import { RipGrepTool } from './ripGrep.js';
import { GlobTool } from './glob.js';
import { EditTool } from './edit.js';
import { WriteFileTool } from './write-file.js';
// import { WebFetchTool } from './web-fetch.js';
import { ReadManyFilesTool } from './read-many-files.js';
import { ShellTool } from './shell.js';
import { MemoryTool } from './memoryTool.js';
// import { WebSearchTool } from './web-search.js';
// import { ExcelTool } from './excel-tool.js';
// import { ExcelTool } from './excel-dotnet-tool.js';
import { PDFTool } from './pdf-tool.js';
import { ZipTool } from './zip-tool.js';
import { FileTool } from './file-tool.js';
import { WebTool } from './web-tool.js';
import { TodoTool } from './todo-tool.js';
import { PythonEmbeddedTool } from './python-embedded-tool.js';
// import { XlwingsTool } from './xlwings-tool.js';
import { MarkItDownTool } from './markitdown-tool.js';
import { GeminiSearchTool } from './gemini-search-tool.js';
import { JPXInvestorTool } from './jpx-investor-tool.js';
import { EconomicCalendarTool } from './economic-calendar-tool.js';
import { FinancialAnalyzer } from './financial-analyzer-tool.js';
import { EconomicNewsTool } from './economic-news-tool.js';
import { KnowledgeBaseTool } from './knowledge-base-tool.js';
import { GoogleRssNewsTool } from './google-rss-news-tool.js';
// import { DocumentIndexerAgent } from '../agents/document-indexer.js';
// import { DocumentRetrieverAgent } from '../agents/document-retriever.js';
// import { WorkflowAdvisorAgent } from '../agents/workflow-advisor.js';
import type { AgentDefinition } from '../agents/types.js';
import { WaitTool } from './wait-tool.js';

/**
 * Type for tool constructor/class (not instance).
 * Tools are stored as classes and instantiated when needed.
 * Using 'any' here because different tools have different constructor signatures.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolClass = any;

/**
 * Tools that only work with specific providers.
 * If a tool is not listed here, it works with all providers.
 */
const PROVIDER_SPECIFIC_TOOLS: Record<string, string[]> = {
  // GeminiSearchTool only works with Gemini provider (uses native Google Search API)
  [GeminiSearchTool.name]: ['gemini'],
};

/**
 * Provider-specific tool replacements.
 * When a tool is not available for a provider, use the replacement instead.
 *
 * Structure: { originalToolName: { provider: replacementToolClass } }
 *
 * Example:
 * - Gemini: Uses GeminiSearchTool (native Google Search)
 * - Others: Use GoogleRssNewsTool (RSS-based alternative)
 */
const TOOL_REPLACEMENTS: Record<string, Record<string, ToolClass>> = {
  // When GeminiSearchTool is not available (non-Gemini providers),
  // use GoogleRssNewsTool as replacement for news/search functionality
  [GeminiSearchTool.name]: {
    claude: GoogleRssNewsTool,
    openai: GoogleRssNewsTool,
    lmstudio: GoogleRssNewsTool,
  },
};

const ROLE_TOOLSET_MAP: Record<string, ToolClass[]> = {
  software_engineer: [
    LSTool,
    ReadFileTool,
    RipGrepTool,
    GlobTool,
    EditTool,
    WriteFileTool,
    ShellTool,
    GrepTool,
    ReadManyFilesTool,
    MemoryTool,
    PythonEmbeddedTool,
    MarkItDownTool,
    KnowledgeBaseTool,
    GeminiSearchTool,
    WaitTool,
  ],
  office_assistant: [
    LSTool,
    ReadFileTool,
    WriteFileTool,
    FileTool,
    ShellTool,
    WebTool,
    // XlwingsDocTool,
    MarkItDownTool,
    KnowledgeBaseTool,
    PDFTool,
    ZipTool,
    TodoTool,
    MemoryTool,
    PythonEmbeddedTool,
    GeminiSearchTool,
    WaitTool,
  ],
  translator: [
    ReadFileTool,
    WriteFileTool,
    EditTool,
    GeminiSearchTool,
    // WebSearchTool
  ],
  creative_writer: [
    ReadFileTool,
    WriteFileTool,
    EditTool,
    GeminiSearchTool,
    // WebSearchTool
  ],
  data_analyst: [
    ReadFileTool,
    WriteFileTool,
    EditTool,
    ShellTool,
    RipGrepTool,
    GeminiSearchTool,
    // WebSearchTool,
    MarkItDownTool,
  ],
  financial_analyst: [
    // ReadFileTool,
    // WriteFileTool,
    // EditTool,
    // ShellTool,
    GeminiSearchTool,
    WebTool,
    PythonEmbeddedTool,
    JPXInvestorTool,
    EconomicCalendarTool,
    FinancialAnalyzer,
    EconomicNewsTool,
    // MarkItDownTool,
    MemoryTool,
  ],
};

/**
 * Type for subagent definition with any output schema.
 * Subagents can have different output schemas, so we use a generic bound.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAgentDefinition = AgentDefinition<any>;

const ROLE_SUBAGENT_MAP: Record<string, AnyAgentDefinition[]> = {
  // office_assistant: [WorkflowAdvisorAgent],
};

export class ToolsetManager {
  /**
   * Get tools for a role, optionally filtered by provider
   * @param roleId - The role ID to get tools for
   * @param provider - Optional provider to filter tools (e.g., 'gemini', 'claude', 'openai', 'lmstudio')
   * @returns Array of tool classes that are compatible with the role and provider
   */
  getToolsForRole(roleId: string, provider?: string): ToolClass[] {
    const allTools = ROLE_TOOLSET_MAP[roleId] || [];

    // If no provider specified, return all tools
    if (!provider) {
      return allTools;
    }

    // Filter and replace tools based on provider support
    const compatibleTools: ToolClass[] = [];

    for (const ToolClass of allTools) {
      // Check if this tool has provider restrictions
      const supportedProviders = PROVIDER_SPECIFIC_TOOLS[ToolClass.name];

      // If no restrictions, tool works with all providers
      if (!supportedProviders) {
        compatibleTools.push(ToolClass);
        continue;
      }

      // Check if the current provider is in the supported list
      if (supportedProviders.includes(provider)) {
        compatibleTools.push(ToolClass);
        continue;
      }

      // Tool is not supported by this provider
      // Check if there's a replacement tool available
      const replacements = TOOL_REPLACEMENTS[ToolClass.name];
      if (replacements && replacements[provider]) {
        // Use the replacement tool instead
        compatibleTools.push(replacements[provider]);
      }
      // If no replacement available, skip this tool
    }

    return compatibleTools;
  }

  /**
   * Get the actual tool name that will be used for a given tool and provider.
   * This accounts for provider-specific replacements.
   * @param toolClass - The original tool class
   * @param provider - The provider being used
   * @returns The tool name that will actually be used (may be a replacement)
   */
  getEffectiveToolName(toolClass: ToolClass, provider: string): string {
    // Check if tool is supported by provider
    const supportedProviders = PROVIDER_SPECIFIC_TOOLS[toolClass.name];

    if (!supportedProviders || supportedProviders.includes(provider)) {
      // Tool is supported, return original name
      return toolClass.Name || toolClass.name;
    }

    // Tool is not supported, check for replacement
    const replacements = TOOL_REPLACEMENTS[toolClass.name];
    if (replacements && replacements[provider]) {
      const replacement = replacements[provider];
      return replacement.Name || replacement.name;
    }

    // No replacement, return original name (shouldn't happen in practice)
    return toolClass.Name || toolClass.name;
  }

  getSupportedRoles(): string[] {
    return Object.keys(ROLE_TOOLSET_MAP);
  }

  getSubagentForRole(roleId: string): AgentDefinition[] {
    return ROLE_SUBAGENT_MAP[roleId] || [];
  }

  /**
   * Check if a tool is supported by a specific provider
   * @param toolClass - The tool class to check
   * @param provider - The provider to check against
   * @returns true if the tool is supported, false otherwise
   */
  isToolSupportedByProvider(toolClass: ToolClass, provider: string): boolean {
    const supportedProviders = PROVIDER_SPECIFIC_TOOLS[toolClass.name];

    // If no restrictions, tool works with all providers
    if (!supportedProviders) {
      return true;
    }

    return supportedProviders.includes(provider);
  }
}
