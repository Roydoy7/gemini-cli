/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { GeminiClient } from './client.js';

/**
 * Timeout duration for idle client cleanup (15 minutes)
 */
const CLIENT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Wrapper for GeminiClient with auto-save and timeout management
 */
class ClientWrapper {
  private idleTimer?: NodeJS.Timeout;

  constructor(
    readonly sessionId: string,
    readonly client: GeminiClient,
    private readonly onSave: (sessionId: string, client: GeminiClient) => void,
    private readonly onTimeout: (sessionId: string) => void,
  ) {
    this.resetIdleTimer();
  }

  /**
   * Reset the idle timer (called on each access)
   */
  resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      console.log(
        `[ClientWrapper] Client for session ${this.sessionId} idle for 15 minutes, releasing...`,
      );
      this.onTimeout(this.sessionId);
    }, CLIENT_IDLE_TIMEOUT_MS);
  }

  /**
   * Save current session history
   */
  async save(): Promise<void> {
    this.onSave(this.sessionId, this.client);
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}

/**
 * GeminiClientPool - Manages multiple GeminiClient instances for concurrent sessions
 *
 * Features:
 * - Each session has its own GeminiClient instance
 * - Allows concurrent responses across multiple sessions
 * - Auto-releases idle clients after 15 minutes
 * - Each client is responsible for saving its own history
 */
export class GeminiClientPool {
  private clients: Map<string, ClientWrapper> = new Map();
  private readonly config: Config;

  constructor(
    config: Config,
    private readonly onSaveSession: (
      sessionId: string,
      client: GeminiClient,
    ) => void,
    private readonly onRestoreSession: (
      sessionId: string,
      client: GeminiClient,
    ) => Promise<void>,
  ) {
    this.config = config;
  }

  /**
   * Get or create a GeminiClient for the specified session
   */
  async getOrCreate(sessionId: string): Promise<GeminiClient> {
    // If client exists, reset its idle timer and return
    const existing = this.clients.get(sessionId);
    if (existing) {
      existing.resetIdleTimer();
      return existing.client;
    }

    // Create new client
    console.log(
      `[GeminiClientPool] Creating new client for session: ${sessionId}`,
    );
    const client = new GeminiClient(this.config);
    await client.initialize();
    await client.updateToolsForCurrentRole();

    // Restore session history from SessionManager
    console.log(
      `[GeminiClientPool] Restoring session history for session: ${sessionId}`,
    );
    await this.onRestoreSession(sessionId, client);

    // Wrap client with auto-save and timeout management
    const wrapper = new ClientWrapper(
      sessionId,
      client,
      this.onSaveSession,
      (sid) => this.release(sid),
    );

    this.clients.set(sessionId, wrapper);

    console.log(
      `[GeminiClientPool] Client created for session ${sessionId}. Pool size: ${this.clients.size}`,
    );

    return client;
  }

  /**
   * Get existing client without creating
   */
  get(sessionId: string): GeminiClient | undefined {
    const wrapper = this.clients.get(sessionId);
    if (wrapper) {
      wrapper.resetIdleTimer();
      return wrapper.client;
    }
    return undefined;
  }

  /**
   * Check if a session has an active client
   */
  has(sessionId: string): boolean {
    return this.clients.has(sessionId);
  }

  /**
   * Save a session's history
   */
  async save(sessionId: string): Promise<void> {
    const wrapper = this.clients.get(sessionId);
    if (wrapper) {
      await wrapper.save();
    }
  }

  /**
   * Release a client (called on timeout or manual cleanup)
   */
  release(sessionId: string): void {
    const wrapper = this.clients.get(sessionId);
    if (wrapper) {
      console.log(
        `[GeminiClientPool] Releasing client for session: ${sessionId}`,
      );

      // Save before releasing
      wrapper.save().catch((error) => {
        console.error(
          `[GeminiClientPool] Failed to save session ${sessionId} before release:`,
          error,
        );
      });

      // Cleanup resources
      wrapper.cleanup();

      // Remove from pool
      this.clients.delete(sessionId);

      console.log(
        `[GeminiClientPool] Pool size after release: ${this.clients.size}`,
      );
    }
  }

  /**
   * Get all active session IDs
   */
  getActiveSessions(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Clear the entire pool
   */
  async clear(): Promise<void> {
    console.log(
      `[GeminiClientPool] Clearing pool with ${this.clients.size} clients`,
    );

    // Save all sessions before clearing
    const savePromises = Array.from(this.clients.values()).map((wrapper) =>
      wrapper.save(),
    );
    await Promise.allSettled(savePromises);

    // Cleanup all wrappers
    for (const wrapper of this.clients.values()) {
      wrapper.cleanup();
    }

    this.clients.clear();
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    totalClients: number;
    activeSessions: string[];
  } {
    return {
      totalClients: this.clients.size,
      activeSessions: this.getActiveSessions(),
    };
  }
}
