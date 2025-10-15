/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  UniversalMessage,
  UniversalStreamEvent,
  RoleDefinition,
  PresetTemplate,
  ModelProviderType,
  CompressionInfo,
  ToolCall,
  ChatMessage,
  ToolResponseData,
} from '@/types';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
} from '@/types';
import { useChatStore } from '@/stores/chatStore';

// Define Electron API interface
interface ElectronAPI {
  geminiChat: {
    initialize: (
      config: Record<string, unknown>,
      initialRoleId?: string,
    ) => Promise<void>;
    switchProvider: (providerType: string, model: string) => Promise<void>;
    switchRole: (roleId: string) => Promise<boolean>;
    sendMessage: (
      messages: UniversalMessage[],
    ) => Promise<UniversalStreamEvent[]>;
    sendMessageStream: (messages: UniversalMessage[]) => {
      streamId: string;
      startStream: (
        onChunk: (chunk: {
          type: string;
          content?: string;
          role?: string;
          timestamp: number;
          sessionId?: string;
          compressionInfo?: CompressionInfo;
          toolCall?: ToolCall;
          toolCallId?: string;
          toolName?: string;
          toolSuccess?: boolean;
          toolResponseData?: ToolResponseData;
          thoughtSummary?: { subject: string; description: string };
        }) => void,
        onComplete: (data: {
          type: string;
          content: string;
          role: string;
          timestamp: number;
        }) => void,
        onError: (error: { type: string; error: string }) => void,
      ) => () => void; // Returns cleanup function
    };
    getAllRoles: () => Promise<RoleDefinition[]>;
    getCurrentRole: () => Promise<RoleDefinition | null>;
    getAllTemplates: () => Promise<PresetTemplate[]>;
    addWorkspaceDirectory: (
      directory: string,
      basePath?: string,
    ) => Promise<void>;
    getWorkspaceDirectories: () => Promise<readonly string[]>;
    getDirectoryContents: (directoryPath: string) => Promise<
      Array<{
        name: string;
        path: string;
        type: 'file' | 'folder';
        size?: number;
        modified?: Date;
      }>
    >;
    setWorkspaceDirectories: (directories: readonly string[]) => Promise<void>;
    addCustomTemplate: (
      template: Omit<PresetTemplate, 'isBuiltin'>,
    ) => Promise<void>;
    updateCustomTemplate: (
      id: string,
      updates: Partial<Omit<PresetTemplate, 'id' | 'isBuiltin'>>,
    ) => Promise<void>;
    deleteCustomTemplate: (id: string) => Promise<void>;
    // Session management
    createSession: (
      sessionId: string,
      title?: string,
      roleId?: string,
    ) => Promise<void>;
    switchSession: (sessionId: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    deleteAllSessions: () => Promise<void>;
    getCurrentSessionId: () => Promise<string | null>;
    getDisplayMessages: (sessionId?: string) => Promise<UniversalMessage[]>;
    getSessionsInfo: () => Promise<
      Array<{
        id: string;
        title: string;
        messageCount: number;
        lastUpdated: Date;
        roleId?: string;
      }>
    >;
    updateSessionTitle: (sessionId: string, newTitle: string) => Promise<void>;
    toggleTitleLock: (sessionId: string, locked: boolean) => Promise<void>;
    updateSessionMessages: (
      sessionId: string,
      messages: ChatMessage[],
    ) => Promise<void>;
    setSessionRole: (sessionId: string, roleId: string) => Promise<void>;
    // Tool confirmation
    onToolConfirmationRequest: (
      callback: (
        event: unknown,
        data: {
          streamId: string;
          sessionId?: string; // CRITICAL: Session ID for routing
          confirmationDetails: ToolCallConfirmationDetails;
        },
      ) => void,
    ) => () => void;
    sendToolConfirmationResponse: (
      outcome: string,
      sessionId?: string, // CRITICAL: Include sessionId in response
    ) => void;
    // OAuth authentication
    startOAuthFlow: (
      providerType: string,
    ) => Promise<{ success: boolean; message?: string; error?: string }>;
    getOAuthStatus: (
      providerType: string,
    ) => Promise<{ authenticated: boolean; userEmail?: string }>;
    clearOAuthCredentials: (
      providerType: string,
    ) => Promise<{ success: boolean; error?: string }>;
    checkEnvApiKey: (
      providerType: string,
    ) => Promise<{ detected: boolean; source: string }>;
    setApiKeyPreference: (
      providerType: string,
    ) => Promise<{ success: boolean; error?: string }>;
    setOAuthPreference: (
      providerType: string,
    ) => Promise<{ success: boolean; error?: string }>;
    getApprovalMode: () => Promise<'default' | 'autoEdit' | 'yolo'>;
    setApprovalMode: (mode: 'default' | 'autoEdit' | 'yolo') => Promise<void>;
    // Direct Excel tool calls
    callExcelTool: (
      operation: string,
      params?: Record<string, unknown>,
    ) => Promise<{
      success: boolean;
      data?: unknown;
      error?: string;
      workbooks?: Array<{ name: string; saved: boolean }>;
      worksheets?: Array<{ index: number; name: string }>;
      apps?: unknown[];
      selection?: string;
    }>;
  };
}

declare global {
  interface GlobalThis {
    electronAPI?: ElectronAPI;
  }
}

class GeminiChatService {
  private initialized = false;
  private switchingRole = false;
  private lastRoleSwitch: { roleId: string; timestamp: number } | null = null;
  private modelsCache: Record<string, string[]> | null = null;
  private modelsCacheTimestamp: number = 0;
  private readonly MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Tool confirmation callback - includes sessionId to route to correct session
  private confirmationCallback?: (
    details: ToolCallConfirmationDetails,
    sessionId?: string,
  ) => Promise<ToolConfirmationOutcome>;

  private get api() {
    const electronAPI = (globalThis as GlobalThis).electronAPI;
    if (!electronAPI?.geminiChat) {
      throw new Error('Electron API not available');
    }
    return electronAPI.geminiChat;
  }

  async initialize(
    config: Record<string, unknown>,
    initialRoleId?: string,
  ): Promise<void> {
    await this.api.initialize(config, initialRoleId);
    this.initialized = true;

    // Set up tool confirmation listener
    this.setupConfirmationListener();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // Set the confirmation callback for tool approvals
  setConfirmationCallback(
    callback: (
      details: ToolCallConfirmationDetails,
      sessionId?: string,
    ) => Promise<ToolConfirmationOutcome>,
  ): void {
    this.confirmationCallback = callback;
  }

  // Set up the confirmation request listener from main process
  private setupConfirmationListener(): void {
    if (this.api.onToolConfirmationRequest) {
      this.api.onToolConfirmationRequest(async (_, data) => {
        console.log('Tool confirmation request from main process:', data);

        // Extract sessionId from request data
        const sessionId = data.sessionId;

        if (this.confirmationCallback) {
          try {
            // Call the registered callback to handle confirmation in GUI
            // Pass sessionId so callback can route to correct session
            const outcome = await this.confirmationCallback(
              data.confirmationDetails,
              sessionId,
            );
            console.log(
              'Sending confirmation response:',
              outcome,
              'sessionId:',
              sessionId,
            );

            // Send the response back to main process WITH sessionId
            this.api.sendToolConfirmationResponse(outcome, sessionId);
          } catch (error) {
            console.error('Error handling tool confirmation:', error);
            // Send cancel as fallback WITH sessionId
            this.api.sendToolConfirmationResponse('cancel', sessionId);
          }
        } else {
          console.warn('No confirmation callback registered, auto-cancelling');
          this.api.sendToolConfirmationResponse('cancel', sessionId);
        }
      });
    }
  }

  async switchProvider(
    _providerType: ModelProviderType,
    model: string,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    // Project now uses only Gemini, no provider switching needed
    console.log(`Model switched to: ${model} (provider switching removed)`);
  }

  async switchRole(roleId: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    // Prevent duplicate calls within 1 second
    const now = Date.now();
    if (
      this.lastRoleSwitch &&
      this.lastRoleSwitch.roleId === roleId &&
      now - this.lastRoleSwitch.timestamp < 1000
    ) {
      console.log(
        `Ignoring duplicate switchRole call for ${roleId} (within 1s)`,
      );
      return true;
    }

    // Prevent concurrent calls
    if (this.switchingRole) {
      console.log(
        `Role switch already in progress, ignoring call for ${roleId}`,
      );
      return false;
    }

    this.switchingRole = true;
    try {
      console.log(`Switching to role: ${roleId}`);
      const result = await this.api.switchRole(roleId);

      if (result) {
        this.lastRoleSwitch = { roleId, timestamp: now };
      }

      return result;
    } finally {
      this.switchingRole = false;
    }
  }

  async sendMessage(messages: UniversalMessage[]): Promise<{
    stream: AsyncGenerator<UniversalStreamEvent>;
    cancel: () => void;
  }> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    const streamResponse = this.api.sendMessageStream(messages);

    // Get current session ID BEFORE starting stream for event filtering
    const currentSessionId = await this.getCurrentSessionId();

    // Create our own async generator using real-time callbacks
    let cleanup: (() => void) | null = null;

    async function* eventGenerator(): AsyncGenerator<UniversalStreamEvent> {
      const events: UniversalStreamEvent[] = [];
      let isComplete = false;
      let hasError = false;
      let eventIndex = 0;
      let resolveNext: (() => void) | null = null;

      // Set up real-time callbacks
      cleanup = streamResponse.startStream(
        // onChunk callback
        (chunk: {
          type: string;
          content?: string;
          role?: string;
          timestamp: number;
          sessionId?: string; // CRITICAL: Session ID from backend
          compressionInfo?: CompressionInfo;
          toolCall?: ToolCall;
          toolCallId?: string;
          toolName?: string;
          toolSuccess?: boolean;
          toolResponseData?: ToolResponseData;
          thoughtSummary?: { subject: string; description: string };
        }) => {
          // CRITICAL: Check if this event belongs to current session or another session
          const isCurrentSession =
            !chunk.sessionId ||
            !currentSessionId ||
            chunk.sessionId === currentSessionId;

          // If event is from another session, update that session's saved state
          if (!isCurrentSession && chunk.sessionId) {
            // Update background session state directly
            const chatState = useChatStore.getState();
            const sessionStates = chatState.sessionStates;
            const backgroundSessionState = sessionStates.get(
              chunk.sessionId,
            ) || {
              currentOperation: null,
              error: null,
              streamingMessage: '',
              compressionNotification: null,
              toolConfirmation: null,
            };

            // Update background session state based on event type
            if (chunk.type === 'thought') {
              backgroundSessionState.currentOperation = {
                type: 'thinking',
                message: 'AI is thinking...',
              };
            } else if (chunk.type === 'content_delta') {
              backgroundSessionState.streamingMessage += chunk.content || '';
            } else if (chunk.type === 'compression') {
              backgroundSessionState.compressionNotification =
                chunk.compressionInfo || null;
            } else if (chunk.type === 'tool_call_request') {
              backgroundSessionState.currentOperation = {
                type: 'tool_executing',
                message: 'Executing tool...',
                toolName: chunk.toolCall?.name,
              };
            }

            // Save updated state back to map
            const newSessionStates = new Map(sessionStates);
            newSessionStates.set(chunk.sessionId, backgroundSessionState);
            chatState.sessionStates = newSessionStates;

            // Don't add to events queue (don't show in current session UI)
            return;
          }
          if (chunk.type === 'content_delta' && chunk.content) {
            events.push({
              type: 'content_delta',
              content: chunk.content,
              role: chunk.role as 'assistant',
              timestamp: chunk.timestamp,
            });
            // Immediately wake up the generator
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          } else if (chunk.type === 'thought') {
            // Handle thought events - pass through with structured data
            events.push({
              type: 'thought',
              thoughtSummary: chunk.thoughtSummary,
              timestamp: chunk.timestamp,
            });
            // Wake up the generator for thought event
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          } else if (chunk.type === 'compression') {
            // Handle compression events
            events.push({
              type: 'compression',
              compressionInfo: chunk.compressionInfo,
              timestamp: chunk.timestamp,
            });
            // Wake up the generator for compression event
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          } else if (chunk.type === 'tool_call_request') {
            // Handle tool call request events
            events.push({
              type: 'tool_call_request',
              toolCall: chunk.toolCall,
              timestamp: chunk.timestamp,
            });
            // Wake up the generator for tool call event
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          } else if (chunk.type === 'tool_call_response') {
            // Handle tool call response events
            console.log(
              '[GeminiChatService] Received tool_call_response event',
            );
            console.log('[GeminiChatService] toolCallId:', chunk.toolCallId);
            console.log('[GeminiChatService] toolName:', chunk.toolName);
            console.log('[GeminiChatService] toolSuccess:', chunk.toolSuccess);
            console.log('[GeminiChatService] sessionId:', chunk.sessionId);
            console.log('[GeminiChatService] content:', chunk.content);

            events.push({
              type: 'tool_call_response',
              content: chunk.content,
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              toolSuccess: chunk.toolSuccess, // CRITICAL: Include toolSuccess field from backend
              toolResponseData: chunk.toolResponseData,
              sessionId: chunk.sessionId, // CRITICAL: Include sessionId for routing to correct session
              timestamp: chunk.timestamp,
            });
            console.log(
              '[GeminiChatService] Added tool_call_response to events queue, total events:',
              events.length,
            );

            // Wake up the generator for tool response event
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          }
        },
        // onComplete callback
        (data: {
          type: string;
          content: string;
          role: string;
          timestamp: number;
          sessionId?: string;
        }) => {
          // Check if completion is for current session or another session
          const isCurrentSession =
            !data.sessionId ||
            !currentSessionId ||
            data.sessionId === currentSessionId;

          // If completion is from another session, clear its operation state
          if (!isCurrentSession && data.sessionId) {
            const chatState = useChatStore.getState();
            const sessionStates = chatState.sessionStates;
            const backgroundSessionState = sessionStates.get(
              data.sessionId,
            ) || {
              currentOperation: null,
              error: null,
              streamingMessage: '',
              compressionNotification: null,
              toolConfirmation: null,
            };

            // Clear operation state when stream completes
            backgroundSessionState.currentOperation = null;
            backgroundSessionState.streamingMessage = '';

            const newSessionStates = new Map(sessionStates);
            newSessionStates.set(data.sessionId, backgroundSessionState);
            chatState.sessionStates = newSessionStates;

            console.log(
              `[GeminiChatService] Updated completion state for background session ${data.sessionId}`,
            );
            return;
          }
          events.push({
            type: 'message_complete',
            content: data.content,
            role: data.role as 'assistant',
            timestamp: data.timestamp,
          });
          isComplete = true;
          // Wake up the generator for completion
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
        },
        // onError callback
        (error: { type: string; error: string; sessionId?: string }) => {
          // Check if error is for current session or another session
          const isCurrentSession =
            !error.sessionId ||
            !currentSessionId ||
            error.sessionId === currentSessionId;

          // If error is from another session, update its error state
          if (!isCurrentSession && error.sessionId) {
            const chatState = useChatStore.getState();
            const sessionStates = chatState.sessionStates;
            const backgroundSessionState = sessionStates.get(
              error.sessionId,
            ) || {
              currentOperation: null,
              error: null,
              streamingMessage: '',
              compressionNotification: null,
              toolConfirmation: null,
            };

            // Set error state and clear operation
            backgroundSessionState.error = error.error;
            backgroundSessionState.currentOperation = null;

            const newSessionStates = new Map(sessionStates);
            newSessionStates.set(error.sessionId, backgroundSessionState);
            chatState.sessionStates = newSessionStates;

            console.log(
              `[GeminiChatService] Updated error state for background session ${error.sessionId}`,
            );
            return;
          }
          events.push({
            type: 'error',
            error: error.error,
            timestamp: Date.now(),
          });
          hasError = true;
          // Wake up the generator for error
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
        },
      );

      try {
        // Real-time event yielding loop
        while (!isComplete && !hasError) {
          // Yield any new events that have arrived
          while (eventIndex < events.length) {
            const event = events[eventIndex];
            yield event;
            eventIndex++;
          }

          // Wait for the next event to arrive (event-driven instead of polling)
          if (!isComplete && !hasError && eventIndex >= events.length) {
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
              // Fallback timeout to prevent infinite waiting
              setTimeout(() => {
                if (resolveNext === resolve) {
                  resolveNext = null;
                  resolve();
                }
              }, 100);
            });
          }
        }

        // Yield any remaining events
        while (eventIndex < events.length) {
          const event = events[eventIndex];
          yield event;
          eventIndex++;
        }
      } finally {
        if (cleanup) cleanup();
      }
    }

    return {
      stream: eventGenerator(),
      cancel: () => {
        if (cleanup) cleanup();
      },
    };
  }

  async getAvailableModels(
    providerType?: ModelProviderType,
  ): Promise<Record<string, string[]>> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    // Check cache if no specific provider is requested and cache is still valid
    const now = Date.now();
    if (
      !providerType &&
      this.modelsCache &&
      now - this.modelsCacheTimestamp < this.MODELS_CACHE_TTL
    ) {
      return this.modelsCache;
    }

    // Return hardcoded Gemini models since getAvailableModels API is removed
    const models: Record<string, string[]> = {
      gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    };

    // Cache the full model list if no specific provider was requested
    if (!providerType) {
      this.modelsCache = models;
      this.modelsCacheTimestamp = now;
    }

    return models;
  }

  getAllRoles(): RoleDefinition[] {
    if (!this.initialized) {
      return [];
    }

    // This needs to be async but keeping interface for compatibility
    return [];
  }

  async getAllRolesAsync(): Promise<RoleDefinition[]> {
    if (!this.initialized) {
      return [];
    }

    return await this.api.getAllRoles();
  }

  getCurrentRole(): RoleDefinition | null {
    if (!this.initialized) {
      return null;
    }

    // This needs to be async but keeping interface for compatibility
    return null;
  }

  async getCurrentRoleAsync(): Promise<RoleDefinition | null> {
    if (!this.initialized) {
      return null;
    }

    return await this.api.getCurrentRole();
  }

  getAllTemplates(): PresetTemplate[] {
    if (!this.initialized) {
      return [];
    }

    // This needs to be async but keeping interface for compatibility
    return [];
  }

  async getAllTemplatesAsync(): Promise<PresetTemplate[]> {
    if (!this.initialized) {
      return [];
    }

    return await this.api.getAllTemplates();
  }

  async addWorkspaceDirectory(
    directory: string,
    basePath?: string,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.addWorkspaceDirectory(directory, basePath);
  }

  async setWorkspaceDirectories(directories: readonly string[]): Promise<void> {
    if (!this.initialized) {
      // Silently ignore if not initialized - the sync will happen later
      return;
    }

    await this.api.setWorkspaceDirectories(directories);
  }

  async getWorkspaceDirectories(): Promise<readonly string[]> {
    if (!this.initialized) {
      return [];
    }

    return await this.api.getWorkspaceDirectories();
  }

  async getDirectoryContents(directoryPath: string): Promise<
    Array<{
      name: string;
      path: string;
      type: 'file' | 'folder';
      size?: number;
      modified?: Date;
    }>
  > {
    if (!this.initialized) {
      return [];
    }

    try {
      const items = await this.api.getDirectoryContents(directoryPath);
      // Convert modified dates from strings back to Date objects
      return items.map((item) => ({
        ...item,
        modified: item.modified ? new Date(item.modified) : undefined,
      }));
    } catch (error) {
      console.error('Failed to get directory contents:', error);
      return [];
    }
  }

  async addCustomTemplate(
    template: Omit<PresetTemplate, 'isBuiltin'>,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.addCustomTemplate(template);
  }

  async updateCustomTemplate(
    id: string,
    updates: Partial<Omit<PresetTemplate, 'id' | 'isBuiltin'>>,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.updateCustomTemplate(id, updates);
  }

  async deleteCustomTemplate(id: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.deleteCustomTemplate(id);
  }

  // Session management methods
  async createSession(
    sessionId: string,
    title?: string,
    roleId?: string,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.createSession(sessionId, title, roleId);
  }

  async switchSession(sessionId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.switchSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.deleteSession(sessionId);
  }

  async deleteAllSessions(): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.deleteAllSessions();
  }

  async getCurrentSessionId(): Promise<string | null> {
    if (!this.initialized) {
      return null;
    }

    return await this.api.getCurrentSessionId();
  }

  async getDisplayMessages(sessionId?: string): Promise<UniversalMessage[]> {
    if (!this.initialized) {
      return [];
    }

    return await this.api.getDisplayMessages(sessionId);
  }

  async getSessionsInfo(): Promise<
    Array<{
      id: string;
      title: string;
      messageCount: number;
      lastUpdated: Date;
      roleId?: string;
    }>
  > {
    if (!this.initialized) {
      return [];
    }

    return await this.api.getSessionsInfo();
  }

  async updateSessionTitle(sessionId: string, newTitle: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.updateSessionTitle(sessionId, newTitle);
  }

  async toggleTitleLock(sessionId: string, locked: boolean): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.toggleTitleLock(sessionId, locked);
  }

  async updateSessionMessages(
    sessionId: string,
    messages: ChatMessage[],
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.updateSessionMessages(sessionId, messages);
  }

  async setSessionRole(sessionId: string, roleId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.setSessionRole(sessionId, roleId);
  }

  // OAuth authentication methods
  async startOAuthFlow(
    providerType: string,
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    return await this.api.startOAuthFlow(providerType);
  }

  async getOAuthStatus(
    providerType: string,
  ): Promise<{ authenticated: boolean; userEmail?: string }> {
    if (!this.initialized) {
      return { authenticated: false };
    }

    return await this.api.getOAuthStatus(providerType);
  }

  async clearOAuthCredentials(
    providerType: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    return await this.api.clearOAuthCredentials(providerType);
  }

  async checkEnvApiKey(
    providerType: string,
  ): Promise<{ detected: boolean; source: string }> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    return await this.api.checkEnvApiKey(providerType);
  }

  async setApiKeyPreference(
    providerType: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    return await this.api.setApiKeyPreference(providerType);
  }

  async setOAuthPreference(
    providerType: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    return await this.api.setOAuthPreference(providerType);
  }

  async getApprovalMode(): Promise<'default' | 'autoEdit' | 'yolo'> {
    if (!this.initialized) {
      return 'default';
    }

    return await this.api.getApprovalMode();
  }

  async setApprovalMode(mode: 'default' | 'autoEdit' | 'yolo'): Promise<void> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    await this.api.setApprovalMode(mode);
  }

  // Excel tool methods using direct Excel tool
  async getExcelWorkbooks(): Promise<{
    success: boolean;
    workbooks: Array<{ name: string; path?: string }>;
    error?: string;
  }> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    try {
      const result = await this.api.callExcelTool('listWorkbooks');

      if (result.success && result.workbooks) {
        return {
          success: true,
          workbooks: result.workbooks,
        };
      }

      return {
        success: false,
        workbooks: [],
        error: result.error || 'Failed to get workbooks from Excel tool',
      };
    } catch (error) {
      console.error('Error getting Excel workbooks:', error);
      return {
        success: false,
        workbooks: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getExcelWorksheets(workbook: string): Promise<{
    success: boolean;
    worksheets: Array<{ index: number; name: string }>;
    error?: string;
  }> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    try {
      const result = await this.api.callExcelTool('listWorksheets', {
        workbookName: workbook,
      });

      if (result.success && result.worksheets) {
        return {
          success: true,
          worksheets: result.worksheets,
        };
      }

      return {
        success: false,
        worksheets: [],
        error: result.error || 'Failed to get worksheets from Excel tool',
      };
    } catch (error) {
      console.error('Error getting Excel worksheets:', error);
      return {
        success: false,
        worksheets: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getExcelSelection(
    workbook: string,
  ): Promise<{ success: boolean; selection?: string; error?: string }> {
    if (!this.initialized) {
      throw new Error('GeminiChatService not initialized');
    }

    try {
      const result = await this.api.callExcelTool('getSelection', {
        workbookName: workbook,
      });

      if (result.success && result.selection) {
        return {
          success: true,
          selection: result.selection,
        };
      }

      return {
        success: false,
        error: result.error || 'Failed to get selection from Excel',
      };
    } catch (error) {
      console.error('Error getting Excel selection:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

export const geminiChatService = new GeminiChatService();
