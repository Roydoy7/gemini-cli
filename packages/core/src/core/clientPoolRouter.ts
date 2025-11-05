/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { IClient } from './IClient.js';
import type { IClientPool } from './IClientPool.js';
import { GeminiClientPool } from './clientPool.js';
import { ClaudeClientPool } from './claudeClientPool.js';
import { OpenAIClientPool } from './openaiClientPool.js';
import { LmStudioClientPool } from './lmstudioClientPool.js';
import type { GeminiClient } from './client.js';
import type { ClaudeClient } from './claudeClient.js';
import type { OpenAIClient } from './openaiClient.js';
import type { LmStudioClient } from './lmstudioClient.js';

/**
 * Model provider types supported by the ClientPoolRouter
 * Currently supports Gemini, Claude, OpenAI, and LM Studio
 */
export type ModelProviderType = 'gemini' | 'claude' | 'openai' | 'lmstudio';

/**
 * ClientPoolRouter - Routes session requests to the appropriate client pool
 *
 * Features:
 * - Maintains separate pools for each provider (Gemini, Claude, OpenAI, LM Studio)
 * - Routes based on session provider configuration
 * - Returns IClientPool and IClient interfaces for full decoupling
 * - Supports provider switching per session
 *
 * Architecture:
 * ```
 * ClientPoolRouter
 *   ├── GeminiClientPool (IClientPool) → GeminiClient (IClient)
 *   ├── ClaudeClientPool (IClientPool) → ClaudeClient (IClient)
 *   ├── OpenAIClientPool (IClientPool) → OpenAIClient (IClient)
 *   └── LmStudioClientPool (IClientPool) → LmStudioClient (IClient)
 * ```
 */
export class ClientPoolRouter {
  private readonly geminiClientPool: IClientPool;
  private readonly claudeClientPool: IClientPool;
  private readonly openaiClientPool: IClientPool;
  private readonly lmstudioClientPool: IClientPool;

  constructor(
    config: Config,
    onSaveGeminiSession: (sessionId: string, client: GeminiClient) => void,
    onRestoreGeminiSession: (
      sessionId: string,
      client: GeminiClient,
    ) => Promise<void>,
    onSaveClaudeSession: (sessionId: string, client: ClaudeClient) => void,
    onRestoreClaudeSession: (
      sessionId: string,
      client: ClaudeClient,
    ) => Promise<void>,
    onSaveOpenAISession: (sessionId: string, client: OpenAIClient) => void,
    onRestoreOpenAISession: (
      sessionId: string,
      client: OpenAIClient,
    ) => Promise<void>,
    onSaveLmStudioSession: (sessionId: string, client: LmStudioClient) => void,
    onRestoreLmStudioSession: (
      sessionId: string,
      client: LmStudioClient,
    ) => Promise<void>,
  ) {
    // Initialize all client pools
    this.geminiClientPool = new GeminiClientPool(
      config,
      onSaveGeminiSession,
      onRestoreGeminiSession,
    );

    this.claudeClientPool = new ClaudeClientPool(
      config,
      onSaveClaudeSession,
      onRestoreClaudeSession,
    );

    this.openaiClientPool = new OpenAIClientPool(
      config,
      onSaveOpenAISession,
      onRestoreOpenAISession,
    );

    this.lmstudioClientPool = new LmStudioClientPool(
      config,
      onSaveLmStudioSession,
      onRestoreLmStudioSession,
    );
  }

  /**
   * Get the client pool for a specific provider
   *
   * @param provider - Provider type ('gemini', 'claude', 'openai', or 'lmstudio')
   * @returns IClientPool interface for the specified provider
   */
  getPool(provider: ModelProviderType): IClientPool {
    if (provider === 'gemini') {
      return this.geminiClientPool;
    } else if (provider === 'claude') {
      return this.claudeClientPool;
    } else if (provider === 'openai') {
      return this.openaiClientPool;
    } else if (provider === 'lmstudio') {
      return this.lmstudioClientPool;
    }

    throw new Error(`Unknown provider: ${provider}`);
  }

  /**
   * Get or create a client for the specified session
   *
   * @param sessionId - Unique session identifier
   * @param provider - Provider type for this session
   * @returns Promise resolving to IClient interface
   */
  async getClient(
    sessionId: string,
    provider: ModelProviderType,
  ): Promise<IClient> {
    const pool = this.getPool(provider);
    return await pool.getOrCreate(sessionId);
  }

  /**
   * Save a session's history
   *
   * @param sessionId - Unique session identifier
   * @param provider - Provider type for this session
   */
  async saveSession(
    sessionId: string,
    provider: ModelProviderType,
  ): Promise<void> {
    console.log(
      `[ClientPoolRouter] saveSession called: sessionId=${sessionId}, provider=${provider}`,
    );
    const pool = this.getPool(provider);
    await pool.save(sessionId);
    console.log(`[ClientPoolRouter] pool.save completed for ${sessionId}`);
  }

  /**
   * Release a session's client
   *
   * @param sessionId - Unique session identifier
   * @param provider - Provider type for this session
   */
  releaseSession(sessionId: string, provider: ModelProviderType): void {
    const pool = this.getPool(provider);
    pool.release(sessionId);
  }

  /**
   * Check if a session has an active client
   *
   * @param sessionId - Unique session identifier
   * @param provider - Provider type for this session
   * @returns True if the session has an active client
   */
  has(sessionId: string, provider: ModelProviderType): boolean {
    const pool = this.getPool(provider);
    return pool.has(sessionId);
  }

  /**
   * Get all active sessions across all providers
   *
   * @returns Object mapping provider type to active session IDs
   */
  getAllActiveSessions(): Record<ModelProviderType, string[]> {
    return {
      gemini: this.geminiClientPool.getActiveSessions(),
      claude: this.claudeClientPool.getActiveSessions(),
      openai: this.openaiClientPool.getActiveSessions(),
      lmstudio: this.lmstudioClientPool.getActiveSessions(),
    };
  }

  /**
   * Clear all client pools
   */
  async clearAll(): Promise<void> {
    await Promise.all([
      this.geminiClientPool.clear(),
      this.claudeClientPool.clear(),
      this.openaiClientPool.clear(),
      this.lmstudioClientPool.clear(),
    ]);
  }

  /**
   * Get statistics for all pools
   *
   * @returns Object with statistics for each provider
   */
  getStats(): Record<
    ModelProviderType,
    { totalClients: number; activeSessions: string[] }
  > {
    return {
      gemini: this.geminiClientPool.getStats(),
      claude: this.claudeClientPool.getStats(),
      openai: this.openaiClientPool.getStats(),
      lmstudio: this.lmstudioClientPool.getStats(),
    };
  }
}
