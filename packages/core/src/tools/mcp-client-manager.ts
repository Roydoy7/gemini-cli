/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  McpClient,
  MCPDiscoveryState,
  populateMcpServerCommand,
} from './mcp-client.js';
import { getErrorMessage } from '../utils/errors.js';
import type { EventEmitter } from 'node:events';
import { coreEvents } from '../utils/events.js';

/**
 * Manages the lifecycle of multiple MCP clients, including local child processes.
 * This class is responsible for starting, stopping, and discovering tools from
 * a collection of MCP servers defined in the configuration.
 */
export class McpClientManager {
  private clients: Map<string, McpClient> = new Map();
  private readonly toolRegistry: ToolRegistry;
  private discoveryState: MCPDiscoveryState = MCPDiscoveryState.NOT_STARTED;
  private readonly eventEmitter?: EventEmitter;

  constructor(toolRegistry: ToolRegistry, eventEmitter?: EventEmitter) {
    this.toolRegistry = toolRegistry;
    this.eventEmitter = eventEmitter;
  }

  /**
   * Initiates the tool discovery process for all configured MCP servers.
   * It connects to each server, discovers its available tools, and registers
   * them with the `ToolRegistry`.
   *
   * @param cliConfig - The configuration object
   * @param background - If true, runs discovery in the background without blocking
   * @returns Promise that resolves immediately if background=true, or when discovery completes if background=false
   */
  async discoverAllMcpTools(cliConfig: Config, background: boolean = false): Promise<void> {
    if (!cliConfig.isTrustedFolder()) {
      return;
    }
    await this.stop();

    const servers = populateMcpServerCommand(
      cliConfig.getMcpServers() || {},
      cliConfig.getMcpServerCommand(),
    );

    this.discoveryState = MCPDiscoveryState.IN_PROGRESS;

    this.eventEmitter?.emit('mcp-client-update', this.clients);
    const discoveryPromises = Object.entries(servers)
      .filter(([_, config]) => !config.extension || config.extension.isActive)
      .map(async ([name, config]) => {
        const client = new McpClient(
          name,
          config,
          this.toolRegistry,
          cliConfig.getPromptRegistry(),
          cliConfig.getWorkspaceContext(),
          cliConfig.getDebugMode(),
        );
        this.clients.set(name, client);

        this.eventEmitter?.emit('mcp-client-update', this.clients);
        try {
          await client.connect();
          await client.discover(cliConfig);
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
      });

    // Run discovery in background if requested
    if (background) {
      Promise.all(discoveryPromises).then(() => {
        this.discoveryState = MCPDiscoveryState.COMPLETED;
        console.log('[McpClientManager] Background MCP tool discovery completed');
      }).catch((error) => {
        console.error('[McpClientManager] Background MCP tool discovery failed:', error);
        this.discoveryState = MCPDiscoveryState.COMPLETED;
      });
      return; // Return immediately without waiting
    }

    await Promise.all(discoveryPromises);
    this.discoveryState = MCPDiscoveryState.COMPLETED;
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
          console.error(
            `Error stopping client '${name}': ${getErrorMessage(error)}`,
          );
        }
      },
    );

    await Promise.all(disconnectionPromises);
    this.clients.clear();
  }

  getDiscoveryState(): MCPDiscoveryState {
    return this.discoveryState;
  }
}
