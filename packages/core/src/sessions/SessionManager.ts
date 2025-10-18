/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { UniversalMessage } from '../core/message-types.js';
import type { Config } from '../config/config.js';

export interface SessionData {
  id: string;
  title: string;
  lastUpdated: Date;
  createdAt: Date;
  conversationHistory: UniversalMessage[];
  metadata?: {
    provider?: string;
    model?: string;
    roleId?: string;
    titleLockedByUser?: boolean; // User manually set title, prevent auto-updates
  };
}

export interface SessionInfo {
  id: string;
  title: string;
  messageCount: number;
  lastUpdated: Date;
  roleId?: string;
}

export interface SessionManagerOptions {
  config: Config;
}

/**
 * SessionManager handles session persistence and retrieval as a singleton.
 * It manages conversation history, session metadata, and intelligent title generation.
 */
export class SessionManager {
  private static instance: SessionManager | null = null;
  private sessions: Map<string, SessionData> = new Map();
  private currentSessionId: string | null = null;
  private config: Config | null = null;
  private initialized = false;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Initialize the SessionManager with configuration
   */
  async initializeWithConfig(options: SessionManagerOptions): Promise<void> {
    if (this.initialized) {
      console.warn('[SessionManager] Already initialized');
      return;
    }

    this.config = options.config;
    this.initialized = true; // Set before calling initialize to avoid circular dependency
    await this.initialize();
  }

  /**
   * Initialize the session manager by loading persisted sessions
   */
  private async initialize(): Promise<void> {
    await this.loadSessions();
  }

  /**
   * Ensure the SessionManager is properly initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.config) {
      throw new Error(
        'SessionManager not initialized. Call initializeWithConfig() first.',
      );
    }
  }

  /**
   * Get the sessions storage directory path
   */
  private getSessionsDir(): string {
    this.ensureInitialized();
    return path.join(this.config!.storage.getProjectTempDir(), 'sessions');
  }

  /**
   * Get the path for a specific session file
   */
  private getSessionPath(sessionId: string): string {
    return path.join(this.getSessionsDir(), `${sessionId}.json`);
  }

  /**
   * Load all persisted sessions from disk
   */
  private async loadSessions(): Promise<void> {
    const sessionsDir = this.getSessionsDir();

    try {
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
        return;
      }

      const files = fs.readdirSync(sessionsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const sessionPath = path.join(sessionsDir, file);
          const sessionContent = fs.readFileSync(sessionPath, 'utf-8');
          const sessionData = JSON.parse(sessionContent) as SessionData;

          // Convert date strings back to Date objects
          sessionData.lastUpdated = new Date(sessionData.lastUpdated);
          sessionData.createdAt = new Date(sessionData.createdAt);

          this.sessions.set(sessionData.id, sessionData);
        } catch (error) {
          console.error(`Failed to load session file ${file}:`, error);
        }
      }

      console.log(
        `[SessionManager] Loaded ${this.sessions.size} sessions from disk`,
      );

      // Auto-restore the most recently updated session as current session
      if (this.sessions.size > 0 && !this.currentSessionId) {
        const sortedSessions = Array.from(this.sessions.values()).sort(
          (a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime(),
        );
        this.currentSessionId = sortedSessions[0].id;
        console.log(
          `[SessionManager] Auto-restored current session: ${this.currentSessionId}`,
        );
      }
    } catch (error) {
      console.error('[SessionManager] Failed to load sessions:', error);
    }
  }

  /**
   * Save a session to disk
   */
  private async saveSession(sessionData: SessionData): Promise<void> {
    try {
      const sessionsDir = this.getSessionsDir();
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
      }

      const sessionPath = this.getSessionPath(sessionData.id);
      fs.writeFileSync(
        sessionPath,
        JSON.stringify(sessionData, null, 2),
        'utf-8',
      );
    } catch (error) {
      console.error(
        `[SessionManager] Failed to save session ${sessionData.id}:`,
        error,
      );
    }
  }

  /**
   * Create a new session
   */
  createSession(
    sessionId: string,
    title: string = 'New Chat',
    roleId?: string,
  ): void {
    this.ensureInitialized();
    console.log(
      `[SessionManager] Creating session: ${sessionId} with roleId: ${roleId}`,
    );

    const newSession: SessionData = {
      id: sessionId,
      title,
      lastUpdated: new Date(),
      createdAt: new Date(),
      conversationHistory: [],
      metadata: {
        roleId,
      },
    };

    this.sessions.set(sessionId, newSession);

    // Auto-switch to new session if no current session
    if (!this.currentSessionId) {
      this.switchSession(sessionId);
    }

    // Save to disk
    this.saveSession(newSession);
  }

  /**
   * Switch to a different session
   * Note: Does NOT update lastUpdated timestamp - only actual messages update the timestamp
   */
  switchSession(sessionId: string): void {
    this.ensureInitialized();
    console.log(
      `[SessionManager] Switching from session ${this.currentSessionId} to ${sessionId}`,
    );

    // Switch to new session (no timestamp update)
    this.currentSessionId = sessionId;

    // Create session if it doesn't exist
    let targetSession = this.sessions.get(sessionId);
    if (!targetSession) {
      this.createSession(sessionId);
      targetSession = this.sessions.get(sessionId)!;
    }

    const sessionHistory = targetSession.conversationHistory;
    console.log(
      `[SessionManager] Loaded session ${sessionId} with ${sessionHistory.length} messages`,
    );
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): void {
    console.log(`[SessionManager] Deleting session: ${sessionId}`);

    // Remove from memory
    this.sessions.delete(sessionId);

    // Remove from disk
    try {
      const sessionPath = this.getSessionPath(sessionId);
      if (fs.existsSync(sessionPath)) {
        fs.unlinkSync(sessionPath);
      }
    } catch (error) {
      console.error(
        `[SessionManager] Failed to delete session file ${sessionId}:`,
        error,
      );
    }

    // If deleting current session, clear current state
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
  }

  /**
   * Get all session IDs
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get sessions info for frontend (sorted by lastUpdated)
   */
  getSessionsInfo(): SessionInfo[] {
    const sessionsInfo = Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      title: session.title,
      messageCount: session.conversationHistory.filter(
        (msg) =>
          !msg.content.startsWith('Tool response:') &&
          !msg.content.startsWith('Tool execution completed successfully'),
      ).length, // Count display messages only
      lastUpdated: session.lastUpdated,
      roleId: session.metadata?.roleId,
    }));

    // Sort by lastUpdated (most recent first)
    sessionsInfo.sort(
      (a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime(),
    );

    console.log(
      `[SessionManager] Retrieved info for ${sessionsInfo.length} sessions`,
    );
    return sessionsInfo;
  }

  /**
   * Update session title (typically called when user manually edits the title)
   * This locks the title to prevent future auto-updates
   */
  updateSessionTitle(sessionId: string, newTitle: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.title = newTitle;
      session.metadata = { ...session.metadata, titleLockedByUser: true };
      session.lastUpdated = new Date();
      console.log(
        `[SessionManager] Updated session ${sessionId} title to: ${newTitle} (locked by user)`,
      );
      this.saveSession(session);
    }
  }

  /**
   * Toggle title lock status for a session
   * When locked, title won't be auto-updated
   */
  toggleTitleLock(sessionId: string, locked: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata = { ...session.metadata, titleLockedByUser: locked };
      session.lastUpdated = new Date();
      console.log(
        `[SessionManager] Session ${sessionId} title lock: ${locked ? 'locked' : 'unlocked'}`,
      );
      this.saveSession(session);
    }
  }

  /**
   * Update session metadata
   */
  updateSessionMetadata(
    sessionId: string,
    metadata: Partial<SessionData['metadata']>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata = { ...session.metadata, ...metadata };
      session.lastUpdated = new Date();
      this.saveSession(session);
    }
  }

  /**
   * Set session role
   */
  setSessionRole(sessionId: string, roleId: string): void {
    console.log(
      `[SessionManager] Setting role ${roleId} for session ${sessionId}`,
    );
    this.updateSessionMetadata(sessionId, { roleId });
  }

  /**
   * Save history for a specific session (called by GeminiClient)
   * This replaces the session's entire conversation history
   */
  saveSessionHistory(sessionId: string, history: UniversalMessage[]): void {
    this.ensureInitialized();
    const session = this.sessions.get(sessionId);
    if (session) {
      session.conversationHistory = [...history];
      session.lastUpdated = new Date();
      this.saveSession(session);
    } else {
      console.warn(
        `[SessionManager] Cannot save history: session ${sessionId} not found`,
      );
    }
  }

  /**
   * Add a message to session history
   * @deprecated Use saveSessionHistory instead for better consistency
   */
  addHistory(message: UniversalMessage): void {
    if (this.currentSessionId) {
      const session = this.sessions.get(this.currentSessionId);
      if (session) {
        session.conversationHistory.push(message);
        session.lastUpdated = new Date();
        this.saveSession(session);
      }
    }
  }

  /**
   * Get conversation history for current session
   */
  getHistory(): readonly UniversalMessage[] {
    if (this.currentSessionId) {
      const session = this.sessions.get(this.currentSessionId);
      return session?.conversationHistory || [];
    }
    return [];
  }

  /**
   * Set conversation history for current session
   */
  setHistory(history: UniversalMessage[]): void {
    if (this.currentSessionId) {
      const session = this.sessions.get(this.currentSessionId);
      if (session) {
        session.conversationHistory = [...history];
        session.lastUpdated = new Date();
        this.saveSession(session);
      }
    }
  }

  /**
   * Clear conversation history for current session
   */
  clearHistory(): void {
    if (this.currentSessionId && this.sessions.has(this.currentSessionId)) {
      const session = this.sessions.get(this.currentSessionId)!;
      session.conversationHistory = [];
      session.lastUpdated = new Date();
      this.saveSession(session);
    }
  }

  /**
   * Get display messages for UI (include all messages including tools)
   */
  getDisplayMessages(sessionId?: string): UniversalMessage[] {
    const targetSessionId = sessionId || this.currentSessionId;
    if (!targetSessionId) {
      return [];
    }

    const session = this.sessions.get(targetSessionId);
    if (!session) {
      return [];
    }

    // Filter out "Please continue." continuation prompts from display
    const displayMessages = session.conversationHistory.filter(
      (msg) => !(msg.role === 'user' && msg.content === 'Please continue.'),
    );

    return displayMessages;
  }

  /**
   * Generate title from first user message
   */
  generateTitleFromMessage(message: string): string {
    // Remove line breaks and trim
    const cleanMessage = message.replace(/\n+/g, ' ').trim();

    // Truncate to 30 characters
    if (cleanMessage.length <= 30) {
      return cleanMessage;
    }

    // Find a good break point (space) near 30 chars
    const truncated = cleanMessage.substring(0, 30);
    const lastSpaceIndex = truncated.lastIndexOf(' ');

    if (lastSpaceIndex > 15) {
      // If there's a space reasonably close to the end
      return cleanMessage.substring(0, lastSpaceIndex) + '...';
    } else {
      return truncated + '...';
    }
  }

  /**
   * Generate intelligent title using LLM when user sends exactly 3rd message
   */
  async generateIntelligentTitle(sessionId: string): Promise<string | null> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return null;

      // Get display messages (without tool messages)
      const displayMessages = session.conversationHistory.filter(
        (msg) =>
          !msg.content.startsWith('Tool response:') &&
          !msg.content.startsWith('Tool execution completed successfully'),
      );

      // Take last 5 user messages for title generation (more focused, less tokens)
      const userMessages = displayMessages.filter((msg) => msg.role === 'user');
      const recentUserMessages = userMessages.slice(-5); // Get last 5 messages

      const conversationText = recentUserMessages
        .map((msg) => `${msg.role}: ${msg.content}`)
        .join('\n');

      const titlePrompt = `Based on this conversation, generate a short, descriptive title (max 40 characters). Only respond with the title, no explanation:

${conversationText}

Title:`;

      // Use GeminiClient to generate title (dynamic import to avoid circular dependency)
      // Create a config proxy that forces gemini-2.5-flash model for title generation
      const titleConfig = new Proxy(this.config!, {
        get(target, prop) {
          if (prop === 'getModel') {
            return () => 'gemini-2.5-flash';
          }
          return Reflect.get(target, prop);
        },
      });

      const { GeminiClient } = await import('../core/client.js');
      const client = new GeminiClient(titleConfig);

      // Initialize chat session with empty history
      await client.startChat([]);

      // Create abort controller with 30 second timeout for title generation
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        console.warn('[SessionManager] Title generation timeout after 30s');
        abortController.abort();
      }, 30000);

      try {
        let generatedTitle = '';
        for await (const event of client.sendMessageStream(
          [{ text: titlePrompt }],
          abortController.signal,
          'title-generation',
        )) {
          if (event.type === 'content') {
            generatedTitle += event.value;
          }
        }

        clearTimeout(timeoutId);
        generatedTitle = generatedTitle.trim().replace(/^["']|["']$/g, ''); // Remove quotes

        // Validate and return
        if (
          generatedTitle &&
          generatedTitle.length > 0 &&
          generatedTitle.length <= 50
        ) {
          console.log(
            `[SessionManager] LLM generated title for session ${sessionId}: ${generatedTitle}`,
          );
          return generatedTitle;
        }

        return null;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch (error) {
      console.error(
        '[SessionManager] Failed to generate intelligent title:',
        error,
      );
      return null;
    }
  }

  /**
   * Auto-generate session title dynamically based on conversation
   * - First user message: Extract from message content (first 30 chars)
   * - Every 5 messages: Use GeminiClient to generate intelligent title (5, 10, 15, ...)
   * - Title will be continuously updated unless user manually locks it
   */
  async autoGenerateTitle(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return; // Skip if session doesn't exist
    }

    // Skip if title was locked by user
    if (session.metadata?.titleLockedByUser) {
      console.log(
        `[SessionManager] Title locked by user, skipping auto-generation: ${session.title}`,
      );
      return;
    }

    // Count user messages (excluding continuation prompts)
    const userMessages = session.conversationHistory.filter(
      (msg) => msg.role === 'user' && msg.content !== 'Please continue.',
    );

    if (userMessages.length === 1) {
      // First message: use simple extraction for immediate feedback
      const title = this.generateTitleFromMessage(userMessages[0].content);
      console.log(
        `[SessionManager] Auto-generated title from first message: ${title}`,
      );
      session.title = title;
      session.lastUpdated = new Date();
      this.saveSession(session);
    } else if (userMessages.length % 5 === 0) {
      // Every 5 messages: regenerate intelligent title (5, 10, 15, ...)
      try {
        const intelligentTitle = await this.generateIntelligentTitle(sessionId);
        if (intelligentTitle) {
          console.log(
            `[SessionManager] Updating title at ${userMessages.length} messages: ${intelligentTitle}`,
          );
          session.title = intelligentTitle;
          session.lastUpdated = new Date();
          this.saveSession(session);
        }
      } catch (error) {
        console.error(
          '[SessionManager] Error generating intelligent title:',
          error,
        );
      }
    }
  }
}
