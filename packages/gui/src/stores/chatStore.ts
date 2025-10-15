/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import type {
  ChatMessage,
  CompressionInfo,
  ToolCallConfirmationDetails,
} from '@/types';

// Status type for different operations
export type OperationStatus = {
  type:
    | 'thinking'
    | 'tool_executing'
    | 'streaming'
    | 'compressing'
    | 'tool_awaiting_approval'
    | 'retrying';
  message: string;
  details?: string;
  toolName?: string;
  progress?: number;
};

// Retry state for 429 errors
export interface RetryState {
  isRetrying: boolean;
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
}

// Per-session state that needs to be preserved when switching sessions
export interface SessionState {
  currentOperation: OperationStatus | null;
  error: string | null;
  streamingMessage: string;
  compressionNotification: CompressionInfo | null;
  toolConfirmation: ToolCallConfirmationDetails | null;
  retryState: RetryState;
}

interface ChatState {
  isLoading: boolean;
  currentOperation: OperationStatus | null; // Current operation status - single source of truth
  error: string | null;
  streamingMessage: string;
  compressionNotification: CompressionInfo | null; // Show compression notification
  toolConfirmation: ToolCallConfirmationDetails | null; // Tool confirmation request
  approvalMode: 'default' | 'autoEdit' | 'yolo'; // Current tool approval mode
  inputMultilineMode: boolean; // Track if input is in multiline mode
  retryState: RetryState; // Retry state for 429 errors

  // Per-session state storage - key: sessionId, value: SessionState
  sessionStates: Map<string, SessionState>;
  currentSessionId: string | null;

  // Computed getters for backward compatibility
  get isStreaming(): boolean;
  get isThinking(): boolean;

  // Actions
  setLoading: (loading: boolean) => void;
  setCurrentOperation: (operation: OperationStatus | null) => void;
  setError: (error: string | null) => void;
  setStreamingMessage: (message: string) => void;
  setCompressionNotification: (info: CompressionInfo | null) => void;
  setToolConfirmation: (
    confirmation: ToolCallConfirmationDetails | null,
  ) => void;
  setApprovalMode: (mode: 'default' | 'autoEdit' | 'yolo') => void;
  setInputMultilineMode: (isMultiline: boolean) => void;
  setRetryState: (state: Partial<RetryState>) => void;
  addMessage: (sessionId: string, message: ChatMessage) => void;
  updateMessage: (
    sessionId: string,
    messageId: string,
    updates: Partial<ChatMessage>,
  ) => void;

  // Session state management
  saveCurrentSessionState: () => void;
  loadSessionState: (sessionId: string) => Promise<void>;
  clearSessionState: (sessionId: string) => void;
  setToolConfirmationForSession: (
    sessionId: string,
    confirmation: ToolCallConfirmationDetails | null,
  ) => void;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  isLoading: false,
  currentOperation: null,
  error: null,
  streamingMessage: '',
  compressionNotification: null,
  toolConfirmation: null,
  approvalMode: 'default',
  inputMultilineMode: false,
  retryState: {
    isRetrying: false,
    attempt: 0,
    maxAttempts: 10,
    errorMessage: '',
  },
  sessionStates: new Map<string, SessionState>(),
  currentSessionId: null,

  // Computed properties for backward compatibility
  get isStreaming() {
    const op = get().currentOperation;
    return op?.type === 'streaming';
  },

  get isThinking() {
    const op = get().currentOperation;
    return op?.type === 'thinking';
  },

  setLoading: (loading: boolean) => set({ isLoading: loading }),

  // Primary method - single source of truth
  setCurrentOperation: (operation: OperationStatus | null) =>
    set({ currentOperation: operation }),

  setError: (error: string | null) => set({ error }),

  setStreamingMessage: (message: string) => {
    set({ streamingMessage: message });
  },

  setCompressionNotification: (info: CompressionInfo | null) =>
    set({ compressionNotification: info }),

  setToolConfirmation: (confirmation: ToolCallConfirmationDetails | null) =>
    set({ toolConfirmation: confirmation }),

  setApprovalMode: (mode: 'default' | 'autoEdit' | 'yolo') =>
    set({ approvalMode: mode }),

  setInputMultilineMode: (isMultiline: boolean) =>
    set({ inputMultilineMode: isMultiline }),

  setRetryState: (state: Partial<RetryState>) =>
    set((prev) => ({
      retryState: { ...prev.retryState, ...state },
    })),

  addMessage: (_sessionId: string, _message: ChatMessage) => {
    // This will be handled by appStore for persistence
    // But we can use this for optimistic updates
  },

  updateMessage: (
    _sessionId: string,
    _messageId: string,
    _updates: Partial<ChatMessage>,
  ) => {
    // This will also be handled by appStore
  },

  // Save current session state before switching
  saveCurrentSessionState: () => {
    const state = get();
    if (!state.currentSessionId) return;

    const sessionState: SessionState = {
      currentOperation: state.currentOperation,
      error: state.error,
      streamingMessage: state.streamingMessage,
      compressionNotification: state.compressionNotification,
      toolConfirmation: state.toolConfirmation,
      retryState: state.retryState,
    };

    const newSessionStates = new Map(state.sessionStates);
    newSessionStates.set(state.currentSessionId, sessionState);
    set({ sessionStates: newSessionStates });
  },

  // Load session state when switching to a session
  loadSessionState: async (sessionId: string) => {
    const state = get();

    // CRITICAL: Get the ACTUAL backend sessionId after switching
    // Frontend sessionId (appStore.activeSessionId) and backend sessionId (SessionManager)
    // may be different, so we need to sync with backend
    try {
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: { getCurrentSessionId: () => Promise<string | null> };
          };
        }
      ).electronAPI;
      const backendSessionId =
        await electronAPI?.geminiChat?.getCurrentSessionId();

      console.log(
        '[ChatStore] loadSessionState called with frontend sessionId:',
        sessionId,
      );
      console.log('[ChatStore] Backend sessionId:', backendSessionId);

      // Use backend sessionId as the source of truth
      const actualSessionId = backendSessionId || sessionId;

      const sessionState = state.sessionStates.get(actualSessionId);

      if (sessionState) {
        // Restore saved state for this session
        set({
          currentSessionId: actualSessionId, // Use backend sessionId
          currentOperation: sessionState.currentOperation,
          error: sessionState.error,
          streamingMessage: sessionState.streamingMessage,
          compressionNotification: sessionState.compressionNotification,
          toolConfirmation: sessionState.toolConfirmation,
          retryState: sessionState.retryState,
        });
      } else {
        // Clean slate for new session
        set({
          currentSessionId: actualSessionId, // Use backend sessionId
          currentOperation: null,
          error: null,
          streamingMessage: '',
          compressionNotification: null,
          toolConfirmation: null,
          retryState: {
            isRetrying: false,
            attempt: 0,
            maxAttempts: 10,
            errorMessage: '',
          },
        });
      }
    } catch (error) {
      console.error('[ChatStore] Failed to get backend sessionId:', error);
      // Fallback to using provided sessionId
      const sessionState = state.sessionStates.get(sessionId);
      set({
        currentSessionId: sessionId,
        ...(sessionState || {
          currentOperation: null,
          error: null,
          streamingMessage: '',
          compressionNotification: null,
          toolConfirmation: null,
          retryState: {
            isRetrying: false,
            attempt: 0,
            maxAttempts: 10,
            errorMessage: '',
          },
        }),
      });
    }
  },

  // Clear session state when session is deleted
  clearSessionState: (sessionId: string) => {
    const state = get();
    const newSessionStates = new Map(state.sessionStates);
    newSessionStates.delete(sessionId);
    set({ sessionStates: newSessionStates });
  },

  // Set tool confirmation for a specific session (may not be current session)
  setToolConfirmationForSession: (
    sessionId: string,
    confirmation: ToolCallConfirmationDetails | null,
  ) => {
    const state = get();

    console.log('[ChatStore] setToolConfirmationForSession called');
    console.log('[ChatStore] Target sessionId:', sessionId);
    console.log('[ChatStore] Current sessionId:', state.currentSessionId);
    console.log('[ChatStore] Confirmation:', confirmation);

    // If this is the current session, update the current state directly
    if (state.currentSessionId === sessionId) {
      console.log('[ChatStore] Setting tool confirmation for CURRENT session');
      set({ toolConfirmation: confirmation });
    } else {
      console.log(
        '[ChatStore] Setting tool confirmation for BACKGROUND session',
      );
      // Otherwise, update the saved session state
      const sessionStates = state.sessionStates;
      const sessionState = sessionStates.get(sessionId) || {
        currentOperation: null,
        error: null,
        streamingMessage: '',
        compressionNotification: null,
        toolConfirmation: null,
        retryState: {
          isRetrying: false,
          attempt: 0,
          maxAttempts: 10,
          errorMessage: '',
        },
      };

      sessionState.toolConfirmation = confirmation;

      const newSessionStates = new Map(sessionStates);
      newSessionStates.set(sessionId, sessionState);
      set({ sessionStates: newSessionStates });
    }
  },
}));
