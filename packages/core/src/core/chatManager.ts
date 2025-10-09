/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { Content, Part } from '@google/genai';
import { GeminiClient } from './client.js';
import { SessionManager } from '../sessions/SessionManager.js';
import { RoleManager } from '../roles/RoleManager.js';
import { WorkspaceManager } from '../utils/WorkspaceManager.js';
import type { UniversalMessage } from '../providers/types.js';
import type { RoleDefinition } from '../roles/types.js';

/**
 * GeminiChatManager - Unified chat management system
 *
 * Responsibilities:
 * - Coordinate between GeminiClient, SessionManager, and RoleManager
 * - Handle message sending with streaming support
 * - Execute tool calls with confirmation support
 * - Manage conversation history and sessions
 * - Trigger chat compression when needed
 *
 * This replaces the MultiModelSystem approach, focusing solely on Gemini.
 */
export class GeminiChatManager {
  private client: GeminiClient;
  private sessionManager: SessionManager;
  private roleManager: RoleManager;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.client = new GeminiClient(config);
    this.sessionManager = SessionManager.getInstance();
    this.roleManager = RoleManager.getInstance();
  }

  /**
   * Initialize the chat manager
   */
  async initialize(): Promise<void> {
    await this.client.initialize();
    console.log('[GeminiChatManager] Initialized with GeminiClient');
  }

  /**
   * Send messages with streaming support
   *
   * Directly delegates to GeminiClient.sendMessageStream()
   * GeminiClient handles:
   * - History management through its internal GeminiChat
   * - Tool execution and continuation
   * - Compression triggers
   * - Next speaker checks
   *
   * @param request - User message content as Part array (e.g., [{text: "..."}])
   * @param signal - Abort signal for cancellation
   * @param prompt_id - Unique ID for this prompt
   * @returns The Turn object from GeminiClient
   */
  async *sendMessageStream(
    request: Part[],
    signal: AbortSignal,
    prompt_id: string
  ) {
    return yield* this.client.sendMessageStream(request, signal, prompt_id);
  }

  /**
   * Get the GeminiClient instance for direct access if needed
   */
  getClient(): GeminiClient {
    return this.client;
  }

  /**
   * Convert UniversalMessage[] (SessionManager format) to Content[] (Gemini format)
   */
  private convertUniversalToGemini(messages: UniversalMessage[]): Content[] {
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // System messages are handled as systemInstruction, skip from history
        continue;
      }

      // Map UniversalMessage role to Gemini Content role
      let role: 'user' | 'model' = 'user';
      if (msg.role === 'assistant') {
        role = 'model';
      } else if (msg.role === 'tool') {
        role = 'user'; // Tool responses are sent as 'user' role in Gemini
      }
      const parts: Part[] = [];

      // Regular content
      if (msg.content && msg.role !== 'tool') {
        parts.push({ text: msg.content });
      }

      // Tool calls (from assistant)
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          parts.push({
            functionCall: {
              name: toolCall.name,
              args: toolCall.arguments
            }
          });
        }
      }

      // Tool responses (from tool role)
      if (msg.role === 'tool' && msg.tool_call_id) {
        parts.push({
          functionResponse: {
            name: msg.name || '',
            response: {
              output: msg.content
            }
          }
        });
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    return contents;
  }

  /**
   * Load session history into GeminiClient
   * Called when switching sessions
   */
  private async loadSessionIntoClient(sessionId: string): Promise<void> {
    // Get history from SessionManager (UniversalMessage[])
    const universalHistory = this.sessionManager.getDisplayMessages(sessionId);

    // Convert to Gemini format (Content[])
    const geminiHistory = this.convertUniversalToGemini(universalHistory);

    // Load into GeminiClient
    if (geminiHistory.length > 0) {
      // Restart chat with existing history
      await this.client.startChat(geminiHistory);
      console.log(`[GeminiChatManager] Loaded ${geminiHistory.length} messages into GeminiClient for session ${sessionId}`);
    } else {
      // Fresh chat
      await this.client.resetChat();
      console.log(`[GeminiChatManager] Started fresh chat for session ${sessionId}`);
    }
  }

  /**
   * Session Management
   */
  createSession(sessionId: string, title?: string, roleId?: string): void {
    this.sessionManager.createSession(sessionId, title || 'New Chat', roleId);
  }

  async switchSession(sessionId: string): Promise<void> {
    this.sessionManager.switchSession(sessionId);

    // Load session history into GeminiClient
    await this.loadSessionIntoClient(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sessionManager.deleteSession(sessionId);
  }

  deleteAllSessions(): void {
    const sessionIds = this.sessionManager.getSessionIds();
    sessionIds.forEach(id => this.deleteSession(id));
  }

  getCurrentSessionId(): string | null {
    return this.sessionManager.getCurrentSessionId();
  }

  getSessionsInfo() {
    return this.sessionManager.getSessionsInfo();
  }

  getDisplayMessages(sessionId?: string): UniversalMessage[] {
    return this.sessionManager.getDisplayMessages(sessionId);
  }

  updateSessionTitle(sessionId: string, newTitle: string): void {
    this.sessionManager.updateSessionTitle(sessionId, newTitle);
  }

  setSessionRole(sessionId: string, roleId: string): void {
    this.sessionManager.setSessionRole(sessionId, roleId);
  }

  /**
   * Role Management
   */
  async switchRole(roleId: string): Promise<boolean> {
    const success = await this.roleManager.setCurrentRole(roleId);
    if (success) {
      // Update tools when role changes
      await this.client.setTools();
      console.log(`[GeminiChatManager] Switched to role: ${roleId}`);
    }
    return success;
  }

  getCurrentRole() {
    return this.roleManager.getCurrentRole();
  }

  getAllRoles() {
    return this.roleManager.getAllRoles();
  }

  async addCustomRole(role: RoleDefinition): Promise<void> {
    await this.roleManager.addCustomRole(role);
  }

  /**
   * Configuration
   */
  getConfig(): Config {
    return this.config;
  }

  setApprovalMode(mode: 'default' | 'autoEdit' | 'yolo'): void {
    // Map to ApprovalMode enum values
    const approvalModeValue = mode === 'yolo' ? ApprovalMode.YOLO :
                              mode === 'autoEdit' ? ApprovalMode.AUTO_EDIT :
                              ApprovalMode.DEFAULT;

    this.config.setApprovalMode(approvalModeValue);
    console.log(`[GeminiChatManager] Set approval mode to: ${mode}`);
  }

  getApprovalMode(): 'default' | 'autoEdit' | 'yolo' {
    const mode = this.config.getApprovalMode();

    switch (mode) {
      case ApprovalMode.YOLO:
        return 'yolo';
      case ApprovalMode.AUTO_EDIT:
        return 'autoEdit';
      default:
        return 'default';
    }
  }

  /**
   * Utility: Get workspace directories
   */
  getWorkspaceDirectories(): readonly string[] {
    const workspaceManager = WorkspaceManager.getInstance(this.config);
    return workspaceManager.getDirectories();
  }

  async addWorkspaceDirectory(directory: string, basePath?: string): Promise<void> {
    const workspaceManager = WorkspaceManager.getInstance(this.config);
    await workspaceManager.addWorkspaceDirectory(directory, basePath);
  }

  async setWorkspaceDirectories(directories: readonly string[]): Promise<void> {
    const workspaceManager = WorkspaceManager.getInstance(this.config);
    await workspaceManager.setDirectories(directories);
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    console.log('[GeminiChatManager] Cleaning up...');
    // No specific cleanup needed for GeminiClient currently
  }
}
