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
  CompressionInfo,
  ToolCall,
  ChatMessage,
  ToolResponseData,
  ToolExecutionStage,
} from '@/types';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
} from '@/types';
import { ModelProviderType } from '@/types';
import { useChatStore } from '@/stores/chatStore';
import type { SessionState } from '@/stores/chatStore';

// Define Electron API interface for unified chat
interface ElectronAPI {
  unifiedChat: {
    initialize: (
      config: Record<string, unknown>,
      initialRoleId?: string,
      defaultProvider?: ModelProviderType,
    ) => Promise<void>;
    switchProvider: (
      sessionId: string,
      providerType: ModelProviderType,
      model?: string,
    ) => Promise<void>;
    getSessionProvider: (sessionId: string) => Promise<ModelProviderType>;
    switchRole: (roleId: string) => Promise<boolean>;
    sendMessage: (
      messages: UniversalMessage[],
      provider?: ModelProviderType,
    ) => Promise<UniversalStreamEvent[]>;
    sendMessageStream: (
      messages: UniversalMessage[],
      provider?: ModelProviderType,
    ) => {
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
          sessionId?: string;
        }) => void,
        onError: (error: { type: string; error: string; sessionId?: string }) => void,
      ) => () => void;
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
      provider?: ModelProviderType,
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
        provider?: ModelProviderType;
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
          sessionId?: string;
          confirmationDetails: ToolCallConfirmationDetails;
        },
      ) => void,
    ) => () => void;
    sendToolConfirmationResponse: (
      outcome: string,
      sessionId?: string,
    ) => void;
    // Retry attempt notifications
    onRetryAttempt: (
      callback: (
        event: unknown,
        data: {
          attempt: number;
          maxAttempts: number;
          error: string;
          delayMs: number;
          timestamp: number;
        },
      ) => void,
    ) => () => void;
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
    // Model availability
    getAvailableModels: (
      providerType: ModelProviderType,
    ) => Promise<string[]>;
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

class UnifiedChatService {
  private initialized = false;
  private switchingRole = false;
  private lastRoleSwitch: { roleId: string; timestamp: number } | null = null;
  private modelsCache: Record<ModelProviderType, string[]> = {
    gemini: [],
    claude: [],
    openai: [],
    lmstudio: [],
  };
  private modelsCacheTimestamp: Record<ModelProviderType, number> = {
    gemini: 0,
    claude: 0,
    openai: 0,
    lmstudio: 0,
  };
  private readonly MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Tool confirmation callback
  private confirmationCallback?: (
    details: ToolCallConfirmationDetails,
    sessionId?: string,
  ) => Promise<ToolConfirmationOutcome>;

  // Helper function to create default session state
  private static createDefaultSessionState(): SessionState {
    return {
      currentOperation: null,
      error: null,
      streamingMessage: '',
      compressionNotification: null,
      toolConfirmation: null,
      retryState: {
        isRetrying: false,
        attempt: 0,
        maxAttempts: 0,
        errorMessage: '',
      },
    };
  }

  private get api() {
    const electronAPI = (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
    if (!electronAPI?.unifiedChat) {
      throw new Error('Unified Chat Electron API not available');
    }
    return electronAPI.unifiedChat;
  }

  async initialize(
    config: Record<string, unknown>,
    initialRoleId?: string,
    defaultProvider: ModelProviderType = ModelProviderType.GEMINI,
  ): Promise<void> {
    await this.api.initialize(config, initialRoleId, defaultProvider);
    this.initialized = true;

    // Set up tool confirmation listener
    this.setupConfirmationListener();

    // Set up retry attempt listener
    this.setupRetryListener();
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
        console.log('[UnifiedChatService] Tool confirmation request:', data);

        const sessionId = data.sessionId;

        if (this.confirmationCallback) {
          try {
            const outcome = await this.confirmationCallback(
              data.confirmationDetails,
              sessionId,
            );
            console.log(
              '[UnifiedChatService] Sending confirmation response:',
              outcome,
              'sessionId:',
              sessionId,
            );

            this.api.sendToolConfirmationResponse(outcome, sessionId);
          } catch (error) {
            console.error(
              '[UnifiedChatService] Error handling tool confirmation:',
              error,
            );
            this.api.sendToolConfirmationResponse('cancel', sessionId);
          }
        } else {
          console.warn(
            '[UnifiedChatService] No confirmation callback registered, auto-cancelling',
          );
          this.api.sendToolConfirmationResponse('cancel', sessionId);
        }
      });
    }
  }

  // Set up the retry attempt listener from main process
  private setupRetryListener(): void {
    if (this.api.onRetryAttempt) {
      this.api.onRetryAttempt((_, data) => {
        console.log(
          '[UnifiedChatService] Retry attempt notification:',
          data,
        );

        const chatState = useChatStore.getState();
        chatState.setRetryState({
          isRetrying: true,
          attempt: data.attempt,
          maxAttempts: data.maxAttempts,
          errorMessage: data.error,
        });

        setTimeout(() => {
          const currentState = useChatStore.getState();
          if (
            currentState.retryState?.attempt === data.attempt &&
            currentState.retryState?.maxAttempts === data.maxAttempts
          ) {
            currentState.setRetryState({
              isRetrying: false,
              attempt: 0,
              maxAttempts: 0,
              errorMessage: '',
            });
          }
        }, data.delayMs + 1000);
      });
    }
  }

  /**
   * Switch provider for a session
   */
  async switchProvider(
    sessionId: string,
    providerType: ModelProviderType,
    model?: string,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }

    console.log(
      `[UnifiedChatService] Switching session ${sessionId} to provider: ${providerType}, model: ${model || 'default'}`,
    );

    await this.api.switchProvider(sessionId, providerType, model);
  }

  /**
   * Get the current provider for a session
   */
  async getSessionProvider(sessionId: string): Promise<ModelProviderType> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }

    return await this.api.getSessionProvider(sessionId);
  }

  async switchRole(roleId: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }

    // Prevent duplicate calls within 1 second
    const now = Date.now();
    if (
      this.lastRoleSwitch &&
      this.lastRoleSwitch.roleId === roleId &&
      now - this.lastRoleSwitch.timestamp < 1000
    ) {
      console.log(
        `[UnifiedChatService] Ignoring duplicate switchRole call for ${roleId}`,
      );
      return true;
    }

    // Prevent concurrent calls
    if (this.switchingRole) {
      console.log(
        `[UnifiedChatService] Role switch already in progress, ignoring call for ${roleId}`,
      );
      return false;
    }

    this.switchingRole = true;
    try {
      console.log(`[UnifiedChatService] Switching to role: ${roleId}`);
      const result = await this.api.switchRole(roleId);

      if (result) {
        this.lastRoleSwitch = { roleId, timestamp: now };
      }

      return result;
    } finally {
      this.switchingRole = false;
    }
  }

  async sendMessage(
    messages: UniversalMessage[],
    provider?: ModelProviderType,
  ): Promise<{
    stream: AsyncGenerator<UniversalStreamEvent>;
    cancel: () => void;
  }> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }

    const streamResponse = this.api.sendMessageStream(messages, provider);

    // Get current session ID for event filtering
    const currentSessionId = await this.getCurrentSessionId();

    let cleanup: (() => void) | null = null;

    async function* eventGenerator(): AsyncGenerator<UniversalStreamEvent> {
      const events: UniversalStreamEvent[] = [];
      let isComplete = false;
      let hasError = false;
      let eventIndex = 0;
      let resolveNext: (() => void) | null = null;

      cleanup = streamResponse.startStream(
        // onChunk callback
        (chunk: {
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
          stage?: ToolExecutionStage;
          progress?: number;
          message?: string;
          details?: Record<string, unknown>;
        }) => {
          // Check if this event belongs to current session
          const isCurrentSession =
            !chunk.sessionId ||
            !currentSessionId ||
            chunk.sessionId === currentSessionId;

          // Handle background session updates
          if (!isCurrentSession && chunk.sessionId) {
            const chatState = useChatStore.getState();
            const sessionStates = chatState.sessionStates;
            const backgroundSessionState =
              sessionStates.get(chunk.sessionId) ??
              UnifiedChatService.createDefaultSessionState();

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
              const description =
                chunk.toolCall?.description ||
                (chunk.toolCall?.arguments as Record<string, unknown>)
                  ?.description;
              backgroundSessionState.currentOperation = {
                type: 'tool_executing',
                message:
                  (typeof description === 'string' ? description : null) ||
                  'Executing tool...',
                toolName: chunk.toolCall?.name,
              };
            }

            const newSessionStates = new Map(sessionStates);
            newSessionStates.set(chunk.sessionId, backgroundSessionState);
            chatState.sessionStates = newSessionStates;

            return;
          }

          // Handle current session events
          if (chunk.type === 'content_delta' && chunk.content) {
            events.push({
              type: 'content_delta',
              content: chunk.content,
              role: chunk.role as 'assistant',
              timestamp: chunk.timestamp,
            });
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          } else if (chunk.type === 'thought') {
            events.push({
              type: 'thought',
              thoughtSummary: chunk.thoughtSummary,
              timestamp: chunk.timestamp,
            });
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          } else if (chunk.type === 'compression') {
            events.push({
              type: 'compression',
              compressionInfo: chunk.compressionInfo,
              timestamp: chunk.timestamp,
            });
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          } else if (chunk.type === 'tool_call_request') {
            events.push({
              type: 'tool_call_request',
              toolCall: chunk.toolCall,
              timestamp: chunk.timestamp,
            });
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          } else if (chunk.type === 'tool_call_response') {
            events.push({
              type: 'tool_call_response',
              content: chunk.content,
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              toolSuccess: chunk.toolSuccess,
              toolResponseData: chunk.toolResponseData,
              sessionId: chunk.sessionId,
              timestamp: chunk.timestamp,
            });
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          } else if (chunk.type === 'tool_progress') {
            events.push({
              type: 'tool_progress',
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              stage: chunk.stage,
              progress: chunk.progress,
              message: chunk.message,
              details: chunk.details,
              timestamp: chunk.timestamp,
            });
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
          const isCurrentSession =
            !data.sessionId ||
            !currentSessionId ||
            data.sessionId === currentSessionId;

          if (!isCurrentSession && data.sessionId) {
            const chatState = useChatStore.getState();
            const sessionStates = chatState.sessionStates;
            const backgroundSessionState =
              sessionStates.get(data.sessionId) ??
              UnifiedChatService.createDefaultSessionState();

            backgroundSessionState.currentOperation = null;
            backgroundSessionState.streamingMessage = '';

            const newSessionStates = new Map(sessionStates);
            newSessionStates.set(data.sessionId, backgroundSessionState);
            chatState.sessionStates = newSessionStates;

            return;
          }

          events.push({
            type: 'message_complete',
            content: data.content,
            role: data.role as 'assistant',
            timestamp: data.timestamp,
          });
          isComplete = true;
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
        },
        // onError callback
        (error: { type: string; error: string; sessionId?: string }) => {
          const isCurrentSession =
            !error.sessionId ||
            !currentSessionId ||
            error.sessionId === currentSessionId;

          if (!isCurrentSession && error.sessionId) {
            const chatState = useChatStore.getState();
            const sessionStates = chatState.sessionStates;
            const backgroundSessionState =
              sessionStates.get(error.sessionId) ??
              UnifiedChatService.createDefaultSessionState();

            backgroundSessionState.error = error.error;
            backgroundSessionState.currentOperation = null;

            const newSessionStates = new Map(sessionStates);
            newSessionStates.set(error.sessionId, backgroundSessionState);
            chatState.sessionStates = newSessionStates;

            return;
          }

          events.push({
            type: 'error',
            error: error.error,
            timestamp: Date.now(),
          });
          hasError = true;
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
        },
      );

      try {
        // Real-time event yielding loop
        while (!isComplete && !hasError) {
          while (eventIndex < events.length) {
            const event = events[eventIndex];
            yield event;
            eventIndex++;
          }

          if (!isComplete && !hasError && eventIndex >= events.length) {
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
              setTimeout(() => {
                if (resolveNext === resolve) {
                  resolveNext = null;
                  resolve();
                }
              }, 100);
            });
          }
        }

        // Yield remaining events
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

  /**
   * Get available models for a specific provider
   */
  async getAvailableModels(
    providerType: ModelProviderType,
  ): Promise<string[]> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }

    // Check cache
    const now = Date.now();
    if (
      this.modelsCache[providerType] &&
      this.modelsCache[providerType].length > 0 &&
      now - this.modelsCacheTimestamp[providerType] < this.MODELS_CACHE_TTL
    ) {
      return this.modelsCache[providerType];
    }

    // Fetch from backend
    const models = await this.api.getAvailableModels(providerType);

    // Update cache
    this.modelsCache[providerType] = models;
    this.modelsCacheTimestamp[providerType] = now;

    return models;
  }

  /**
   * Get all available models for all providers
   */
  async getAllAvailableModels(): Promise<Record<ModelProviderType, string[]>> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }

    const providers: ModelProviderType[] = [
      ModelProviderType.GEMINI,
      ModelProviderType.CLAUDE,
      ModelProviderType.OPENAI,
      ModelProviderType.LMSTUDIO,
    ];
    const result: Record<ModelProviderType, string[]> = {
      gemini: [],
      claude: [],
      openai: [],
      lmstudio: [],
    };

    await Promise.all(
      providers.map(async (provider) => {
        try {
          result[provider] = await this.getAvailableModels(provider);
        } catch (error) {
          console.error(
            `[UnifiedChatService] Failed to get models for ${provider}:`,
            error,
          );
          result[provider] = [];
        }
      }),
    );

    return result;
  }

  getAllRoles(): RoleDefinition[] {
    if (!this.initialized) {
      return [];
    }
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
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.addWorkspaceDirectory(directory, basePath);
  }

  async setWorkspaceDirectories(directories: readonly string[]): Promise<void> {
    if (!this.initialized) {
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
      return items.map((item) => ({
        ...item,
        modified: item.modified ? new Date(item.modified) : undefined,
      }));
    } catch (error) {
      console.error(
        '[UnifiedChatService] Failed to get directory contents:',
        error,
      );
      return [];
    }
  }

  async addCustomTemplate(
    template: Omit<PresetTemplate, 'isBuiltin'>,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.addCustomTemplate(template);
  }

  async updateCustomTemplate(
    id: string,
    updates: Partial<Omit<PresetTemplate, 'id' | 'isBuiltin'>>,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.updateCustomTemplate(id, updates);
  }

  async deleteCustomTemplate(id: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.deleteCustomTemplate(id);
  }

  // Session management methods
  async createSession(
    sessionId: string,
    title?: string,
    roleId?: string,
    provider?: ModelProviderType,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.createSession(sessionId, title, roleId, provider);
  }

  async switchSession(sessionId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.switchSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.deleteSession(sessionId);
  }

  async deleteAllSessions(): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
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
      provider?: ModelProviderType;
    }>
  > {
    if (!this.initialized) {
      return [];
    }
    return await this.api.getSessionsInfo();
  }

  async updateSessionTitle(sessionId: string, newTitle: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.updateSessionTitle(sessionId, newTitle);
  }

  async toggleTitleLock(sessionId: string, locked: boolean): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.toggleTitleLock(sessionId, locked);
  }

  async updateSessionMessages(
    sessionId: string,
    messages: ChatMessage[],
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.updateSessionMessages(sessionId, messages);
  }

  async setSessionRole(sessionId: string, roleId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.setSessionRole(sessionId, roleId);
  }

  // OAuth authentication methods
  async startOAuthFlow(
    providerType: string,
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
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
      throw new Error('UnifiedChatService not initialized');
    }
    return await this.api.clearOAuthCredentials(providerType);
  }

  async checkEnvApiKey(
    providerType: string,
  ): Promise<{ detected: boolean; source: string }> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    return await this.api.checkEnvApiKey(providerType);
  }

  async setApiKeyPreference(
    providerType: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
    }
    return await this.api.setApiKeyPreference(providerType);
  }

  async setOAuthPreference(
    providerType: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
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
      throw new Error('UnifiedChatService not initialized');
    }
    await this.api.setApprovalMode(mode);
  }

  // Excel tool methods
  async getExcelWorkbooks(): Promise<{
    success: boolean;
    workbooks: Array<{ name: string; path?: string }>;
    error?: string;
  }> {
    if (!this.initialized) {
      throw new Error('UnifiedChatService not initialized');
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
      console.error(
        '[UnifiedChatService] Error getting Excel workbooks:',
        error,
      );
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
      throw new Error('UnifiedChatService not initialized');
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
      console.error(
        '[UnifiedChatService] Error getting Excel worksheets:',
        error,
      );
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
      throw new Error('UnifiedChatService not initialized');
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
      console.error(
        '[UnifiedChatService] Error getting Excel selection:',
        error,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

export const unifiedChatService = new UnifiedChatService();
