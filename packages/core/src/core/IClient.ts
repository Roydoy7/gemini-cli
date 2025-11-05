/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion, Content } from '@google/genai';
import type { ServerGeminiStreamEvent, ChatCompressionInfo } from './turn.js';
import type { Turn } from './turn.js';
import type { UniversalMessage } from './message-types.js';

/**
 * IClient - Interface for all LLM Provider clients
 *
 * This interface defines the contract that both GeminiClient and ClaudeClient
 * must implement to ensure compatibility with the rest of the system.
 *
 * Implementations:
 * - GeminiClient (packages/core/src/core/client.ts)
 * - ClaudeClient (packages/core/src/core/claudeClient.ts)
 */
export interface IClient {
  /**
   * Initialize the client (set up API connections, load configuration, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Check if the client has been initialized
   */
  isInitialized(): boolean;

  /**
   * Get the conversation history
   * @returns Array of UniversalMessage objects representing the conversation
   */
  getHistory(): UniversalMessage[];

  /**
   * Set the entire conversation history
   * @param history - Array of UniversalMessage objects to set as history
   *                  Each client implementation will convert to its native format
   */
  setHistory(history: UniversalMessage[]): void;

  /**
   * Add a single content item to the conversation history
   * @param content - Content object to add
   */
  addHistory(content: Content): Promise<void>;

  /**
   * Set the available tools for function calling
   */
  setTools(): Promise<void>;

  /**
   * Update tools based on the current role configuration
   */
  updateToolsForCurrentRole(): Promise<void>;

  /**
   * Send a message and get streaming response
   * This is the core method for LLM interaction
   *
   * @param request - User message (text or parts)
   * @param signal - AbortSignal for cancellation
   * @param prompt_id - Unique identifier for this prompt
   * @param turns - Maximum number of turns (optional, Gemini-specific)
   * @param isInvalidStreamRetry - Whether this is a retry (optional, Gemini-specific)
   * @returns AsyncGenerator yielding stream events and returning a Turn object
   */
  sendMessageStream(
    request: PartListUnion,
    signal: AbortSignal,
    prompt_id: string,
    turns?: number,
    isInvalidStreamRetry?: boolean,
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn>;

  /**
   * Try to compress chat history when context limit is approached
   *
   * @param prompt_id - Current prompt ID (Gemini-specific)
   * @param force - Force compression even if not needed (Gemini-specific, optional)
   * @returns Promise resolving to compression information
   */
  tryCompressChat(
    prompt_id: string,
    force?: boolean,
  ): Promise<ChatCompressionInfo>;

  /**
   * Update generation configuration (temperature, model, etc.)
   */
  updateGenerateContentConfig(): Promise<void>;

  /**
   * Reset the chat to initial state
   */
  resetChat(): Promise<void>;

  /**
   * Strip thinking/thought content from history
   * (Gemini-specific feature, may be no-op for other providers)
   */
  stripThoughtsFromHistory(): void;

  /**
   * Get list of available models for this provider
   * This may involve API calls to the provider or return a hardcoded list
   *
   * @returns Promise resolving to array of model identifiers
   *          (e.g., ['gemini-2.5-pro', 'gemini-2.5-flash'] for Gemini)
   */
  getAvailableModels(): Promise<string[]>;
}
