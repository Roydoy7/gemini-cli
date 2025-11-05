/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IClient } from './IClient.js';

/**
 * IClientPool - Interface for LLM client pool management
 *
 * This interface defines the contract for managing multiple client instances
 * across different sessions. It provides session-based client lifecycle management
 * including creation, caching, timeout, and cleanup.
 *
 * Implementations:
 * - GeminiClientPool (packages/core/src/core/clientPool.ts)
 * - ClaudeClientPool (packages/core/src/core/claudeClientPool.ts)
 *
 * Features:
 * - Each session has its own client instance
 * - 15-minute idle timeout with automatic release
 * - Automatic session history save/restore
 * - Pool-wide statistics and management
 */
export interface IClientPool {
  /**
   * Get or create a client for the specified session
   * If the client exists, resets its idle timer
   * If not, creates a new client, initializes it, and restores session history
   *
   * @param sessionId - Unique session identifier
   * @returns Promise resolving to the client instance
   */
  getOrCreate(sessionId: string): Promise<IClient>;

  /**
   * Get existing client without creating a new one
   * Resets the idle timer if client exists
   *
   * @param sessionId - Unique session identifier
   * @returns Client instance if exists, undefined otherwise
   */
  get(sessionId: string): IClient | undefined;

  /**
   * Check if a session has an active client
   *
   * @param sessionId - Unique session identifier
   * @returns True if client exists for this session
   */
  has(sessionId: string): boolean;

  /**
   * Save a session's history
   * Typically called before releasing or when needing to persist state
   *
   * @param sessionId - Unique session identifier
   */
  save(sessionId: string): Promise<void>;

  /**
   * Release a client (called on timeout or manual cleanup)
   * Saves the session before releasing and cleans up resources
   *
   * @param sessionId - Unique session identifier
   */
  release(sessionId: string): void;

  /**
   * Clear the entire pool
   * Saves all sessions before clearing and cleans up all resources
   */
  clear(): Promise<void>;

  /**
   * Get all active session IDs
   *
   * @returns Array of session IDs that have active clients
   */
  getActiveSessions(): string[];

  /**
   * Get pool statistics
   *
   * @returns Object containing pool statistics (total clients, active sessions, etc.)
   */
  getStats(): {
    totalClients: number;
    activeSessions: string[];
  };
}
