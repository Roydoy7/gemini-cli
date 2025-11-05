/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { Storage } from './storage.js';

/**
 * Configuration for individual MCP server enablement
 */
export interface McpServerEnablementConfig {
  enabled: boolean;
}

/**
 * Configuration for all MCP servers
 * Key: "extensionName__serverName" or "serverName" for non-extension servers
 */
export interface AllMcpServersEnablementConfig {
  [serverKey: string]: McpServerEnablementConfig;
}

/**
 * Manages the enablement state of MCP servers.
 * MCP servers can come from:
 * - User settings (settings.json)
 * - Extension definitions (gemini-extension.json)
 *
 * This manager provides a unified interface to enable/disable MCP servers
 * regardless of their source.
 */
export class McpServerEnablementManager {
  private configFilePath: string;

  constructor() {
    // Always use global Gemini directory for consistent MCP enablement state
    // This ensures frontend and backend read/write the same configuration file
    const baseDir = Storage.getGlobalGeminiDir();
    this.configFilePath = path.join(baseDir, 'mcp-server-enablement.json');
  }

  /**
   * Get the config file path for display purposes
   */
  getConfigFilePath(): string {
    return this.configFilePath;
  }

  /**
   * Checks if a specific MCP server is enabled
   * @param serverKey - The unique identifier for the server (extensionName__serverName or serverName)
   * @returns true if enabled (default is true if not configured)
   */
  isEnabled(serverKey: string): boolean {
    const config = this.readConfig();
    const serverConfig = config[serverKey];
    // Default to enabled if not explicitly configured
    return serverConfig?.enabled !== false;
  }

  /**
   * Enable a specific MCP server
   * @param serverKey - The unique identifier for the server
   */
  enable(serverKey: string): void {
    const config = this.readConfig();
    config[serverKey] = { enabled: true };
    this.writeConfig(config);
  }

  /**
   * Disable a specific MCP server
   * @param serverKey - The unique identifier for the server
   */
  disable(serverKey: string): void {
    const config = this.readConfig();
    config[serverKey] = { enabled: false };
    this.writeConfig(config);
  }

  /**
   * Toggle the enablement state of a specific MCP server
   * @param serverKey - The unique identifier for the server
   * @returns The new state (true if now enabled, false if now disabled)
   */
  toggle(serverKey: string): boolean {
    const currentState = this.isEnabled(serverKey);
    if (currentState) {
      this.disable(serverKey);
    } else {
      this.enable(serverKey);
    }
    return !currentState;
  }

  /**
   * Set the enablement state for multiple servers at once
   * @param updates - Map of serverKey to enabled state
   */
  setMultiple(updates: Record<string, boolean>): void {
    const config = this.readConfig();
    for (const [serverKey, enabled] of Object.entries(updates)) {
      config[serverKey] = { enabled };
    }
    this.writeConfig(config);
  }

  /**
   * Remove a server from the configuration (will default to enabled)
   * @param serverKey - The unique identifier for the server
   */
  remove(serverKey: string): void {
    const config = this.readConfig();
    delete config[serverKey];
    this.writeConfig(config);
  }

  /**
   * Get all configured server states
   */
  getAll(): AllMcpServersEnablementConfig {
    return this.readConfig();
  }

  /**
   * Read the configuration from disk
   */
  private readConfig(): AllMcpServersEnablementConfig {
    try {
      if (!fs.existsSync(this.configFilePath)) {
        return {};
      }
      const content = fs.readFileSync(this.configFilePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('Failed to read MCP server enablement config:', error);
      return {};
    }
  }

  /**
   * Write the configuration to disk
   */
  private writeConfig(config: AllMcpServersEnablementConfig): void {
    try {
      const dir = path.dirname(this.configFilePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Failed to write MCP server enablement config:', error);
      throw error;
    }
  }
}

/**
 * Generate a unique server key for MCP servers
 * @param extensionName - The extension name (if from extension), or undefined for user-defined servers
 * @param serverName - The MCP server name
 */
export function generateMcpServerKey(
  extensionName: string | undefined,
  serverName: string,
): string {
  return extensionName ? `${extensionName}__${serverName}` : serverName;
}
