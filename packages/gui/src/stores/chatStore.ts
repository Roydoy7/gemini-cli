/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import type { ChatMessage, CompressionInfo, ToolCallConfirmationDetails } from '@/types';

// Status type for different operations
export type OperationStatus = {
  type: 'thinking' | 'tool_executing' | 'streaming' | 'compressing' | 'tool_awaiting_approval';
  message: string;
  details?: string;
  toolName?: string;
  progress?: number;
};

interface ChatState {
  isLoading: boolean;
  currentOperation: OperationStatus | null; // Current operation status - single source of truth
  error: string | null;
  streamingMessage: string;
  compressionNotification: CompressionInfo | null; // Show compression notification
  toolConfirmation: ToolCallConfirmationDetails | null; // Tool confirmation request
  approvalMode: 'default' | 'autoEdit' | 'yolo'; // Current tool approval mode
  inputMultilineMode: boolean; // Track if input is in multiline mode

  // Computed getters for backward compatibility
  get isStreaming(): boolean;
  get isThinking(): boolean;

  // Actions
  setLoading: (loading: boolean) => void;
  setCurrentOperation: (operation: OperationStatus | null) => void;
  setError: (error: string | null) => void;
  setStreamingMessage: (message: string) => void;
  setCompressionNotification: (info: CompressionInfo | null) => void;
  setToolConfirmation: (confirmation: ToolCallConfirmationDetails | null) => void;
  setApprovalMode: (mode: 'default' | 'autoEdit' | 'yolo') => void;
  setInputMultilineMode: (isMultiline: boolean) => void;
  addMessage: (sessionId: string, message: ChatMessage) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<ChatMessage>) => void;
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
  setCurrentOperation: (operation: OperationStatus | null) => set({ currentOperation: operation }),

  setError: (error: string | null) => set({ error }),
  
  setStreamingMessage: (message: string) => {
    set({ streamingMessage: message });
  },

  setCompressionNotification: (info: CompressionInfo | null) => set({ compressionNotification: info }),
  
  setToolConfirmation: (confirmation: ToolCallConfirmationDetails | null) => set({ toolConfirmation: confirmation }),

  setApprovalMode: (mode: 'default' | 'autoEdit' | 'yolo') => set({ approvalMode: mode }),

  setInputMultilineMode: (isMultiline: boolean) => set({ inputMultilineMode: isMultiline }),

  addMessage: (_sessionId: string, _message: ChatMessage) => {
    // This will be handled by appStore for persistence
    // But we can use this for optimistic updates
  },

  updateMessage: (_sessionId: string, _messageId: string, _updates: Partial<ChatMessage>) => {
    // This will also be handled by appStore
  },
}));