/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-env node */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const { contextBridge, ipcRenderer } = require('electron');

// Define the API interface that will be exposed to the renderer process
const electronAPI = {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getWorkingDirectory: () => ipcRenderer.invoke('get-working-directory'),

  // Dialog API
  dialog: {
    showOpenDialog: (options) =>
      ipcRenderer.invoke('dialog-show-open-dialog', options),
  },

  // File system API
  fs: {
    readFileAsBase64: (filePath) =>
      ipcRenderer.invoke('fs-read-file-as-base64', filePath),
  },

  // Event listeners
  onWorkspaceDirectoriesChanged: (callback) => {
    ipcRenderer.on('workspace-directories-changed', callback);
    // Return cleanup function
    return () =>
      ipcRenderer.removeListener('workspace-directories-changed', callback);
  },

  // Unified Chat System API (Multi-provider support: Gemini, Claude, OpenAI, LM Studio)
  unifiedChat: {
    initialize: (config, initialRoleId, defaultProvider) =>
      ipcRenderer.invoke('unifiedChat-initialize', config, initialRoleId, defaultProvider),
    switchRole: (roleId) =>
      ipcRenderer.invoke('unifiedChat-switch-role', roleId),
    sendMessage: (messages) =>
      ipcRenderer.invoke('unifiedChat-send-message', messages),
    sendMessageStream: (messages) => {
      const streamId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      return {
        streamId,
        // Real-time streaming with callback
        startStream: (onChunk, onComplete, onError) => {
          let cleanedUp = false;

          // Store handler references for precise removal
          const chunkHandler = (event, data) => {
            if (data.streamId === streamId) {
              onChunk(data);
            }
          };

          const completeHandler = (event, data) => {
            if (data.streamId === streamId) {
              cleanup(false); // false = don't cancel on backend (already complete)
              onComplete(data);
            }
          };

          const errorHandler = (event, data) => {
            if (data.streamId === streamId) {
              console.error('IPC stream error received:', data.error);
              cleanup(false); // false = don't cancel on backend (already errored)
              onError({ type: 'error', error: data.error });
            }
          };

          const cleanup = (shouldCancelBackend = true) => {
            if (cleanedUp) return; // Prevent multiple cleanup calls
            cleanedUp = true;

            // Remove specific event listeners
            ipcRenderer.removeListener('unifiedChat-stream-chunk', chunkHandler);
            ipcRenderer.removeListener(
              'unifiedChat-stream-complete',
              completeHandler,
            );
            ipcRenderer.removeListener('unifiedChat-stream-error', errorHandler);

            // Only cancel on backend if explicitly requested (e.g., user cancellation)
            if (shouldCancelBackend) {
              ipcRenderer
                .invoke('unifiedChat-cancel-stream', streamId)
                .catch((error) => {
                  console.warn('Failed to cancel stream on backend:', error);
                });
            }
          };

          // Set up event handlers BEFORE starting the request
          ipcRenderer.on('unifiedChat-stream-chunk', chunkHandler);
          ipcRenderer.on('unifiedChat-stream-complete', completeHandler);
          ipcRenderer.on('unifiedChat-stream-error', errorHandler);

          // NOTE: Frontend timeout removed - rely on backend timeout mechanisms
          // Backend has multiple layers of timeout protection:
          // 1. Python tool timeout (configurable, default 300s)
          // 2. Individual tool execution timeouts
          // If stream is truly stuck, user can manually cancel with Stop button

          // NOW start the streaming request after event handlers are set
          ipcRenderer
            .invoke('unifiedChat-send-message-stream', messages, streamId)
            .catch((error) => {
              console.error('IPC invoke failed:', error.message, error);
              cleanup(false); // false = invoke already failed, no need to cancel
              onError({ type: 'error', error: error.message });
            });

          // Return cleanup function for manual cancellation
          return () => {
            cleanup(true); // true = user initiated cancellation
          };
        },
      };
    },
    getAllRoles: () => ipcRenderer.invoke('unifiedChat-get-all-roles'),
    getCurrentRole: () => ipcRenderer.invoke('unifiedChat-get-current-role'),
    getAllTemplates: () => ipcRenderer.invoke('unifiedChat-get-all-templates'),
    addWorkspaceDirectory: (directory, basePath) =>
      ipcRenderer.invoke(
        'unifiedChat-add-workspace-directory',
        directory,
        basePath,
      ),
    getWorkspaceDirectories: () =>
      ipcRenderer.invoke('unifiedChat-get-workspace-directories'),
    getDirectoryContents: (directoryPath) =>
      ipcRenderer.invoke('unifiedChat-get-directory-contents', directoryPath),
    setWorkspaceDirectories: (directories) =>
      ipcRenderer.invoke('unifiedChat-set-workspace-directories', directories),
    addCustomTemplate: (template) =>
      ipcRenderer.invoke('unifiedChat-add-custom-template', template),
    updateCustomTemplate: (id, updates) =>
      ipcRenderer.invoke('unifiedChat-update-custom-template', id, updates),
    deleteCustomTemplate: (id) =>
      ipcRenderer.invoke('unifiedChat-delete-custom-template', id),
    // Session management
    createSession: (sessionId, title, roleId, provider) =>
      ipcRenderer.invoke(
        'unifiedChat-create-session',
        sessionId,
        title,
        roleId,
        provider,
      ),
    switchSession: (sessionId) =>
      ipcRenderer.invoke('unifiedChat-switch-session', sessionId),
    deleteSession: (sessionId) =>
      ipcRenderer.invoke('unifiedChat-delete-session', sessionId),
    deleteAllSessions: () =>
      ipcRenderer.invoke('unifiedChat-delete-all-sessions'),
    getCurrentSessionId: () =>
      ipcRenderer.invoke('unifiedChat-get-current-session-id'),
    getDisplayMessages: (sessionId) =>
      ipcRenderer.invoke('unifiedChat-get-display-messages', sessionId),
    getSessionsInfo: () => ipcRenderer.invoke('unifiedChat-get-sessions-info'),
    updateSessionTitle: (sessionId, newTitle) =>
      ipcRenderer.invoke(
        'unifiedChat-update-session-title',
        sessionId,
        newTitle,
      ),
    toggleTitleLock: (sessionId, locked) =>
      ipcRenderer.invoke('unifiedChat-toggle-title-lock', sessionId, locked),
    updateSessionMessages: (sessionId, messages) =>
      ipcRenderer.invoke(
        'unifiedChat-update-session-messages',
        sessionId,
        messages,
      ),
    setSessionRole: (sessionId, roleId) =>
      ipcRenderer.invoke('unifiedChat-set-session-role', sessionId, roleId),
    // Provider management
    switchProvider: (sessionId, providerType, model) =>
      ipcRenderer.invoke('unifiedChat-switch-provider', sessionId, providerType, model),
    getSessionProvider: (sessionId) =>
      ipcRenderer.invoke('unifiedChat-get-session-provider', sessionId),
    getAvailableModels: (providerType) =>
      ipcRenderer.invoke('unifiedChat-get-available-models', providerType),
    // OAuth authentication
    startOAuthFlow: (providerType) =>
      ipcRenderer.invoke('oauth-start-flow', providerType),
    getOAuthStatus: (providerType) =>
      ipcRenderer.invoke('oauth-get-status', providerType),
    clearOAuthCredentials: (providerType) =>
      ipcRenderer.invoke('oauth-clear-credentials', providerType),
    checkEnvApiKey: (providerType) =>
      ipcRenderer.invoke('check-env-api-key', providerType),
    setApiKeyPreference: (providerType) =>
      ipcRenderer.invoke('set-api-key-preference', providerType),
    setOAuthPreference: (providerType) =>
      ipcRenderer.invoke('set-oauth-preference', providerType),
    getAuthPreference: (providerType) =>
      ipcRenderer.invoke('get-auth-preference', providerType),
    getApprovalMode: () => ipcRenderer.invoke('get-approval-mode'),
    setApprovalMode: (mode) => ipcRenderer.invoke('set-approval-mode', mode),
    // Direct Excel tool calls
    callExcelTool: (operation, params) =>
      ipcRenderer.invoke('unifiedChat-call-excel-tool', operation, params),
    // Tool confirmation
    onToolConfirmationRequest: (callback) => {
      ipcRenderer.on('tool-confirmation-request', callback);
      // Return cleanup function
      return () =>
        ipcRenderer.removeListener('tool-confirmation-request', callback);
    },
    sendToolConfirmationResponse: (outcome, sessionId) =>
      ipcRenderer.send('tool-confirmation-response', { outcome, sessionId }),
    // Retry attempt notifications
    onRetryAttempt: (callback) => {
      ipcRenderer.on('unifiedChat-retry-attempt', callback);
      // Return cleanup function
      return () =>
        ipcRenderer.removeListener('unifiedChat-retry-attempt', callback);
    },
  },
};

// MCP Server Management API
const mcpAPI = {
  getMcpServers: () => ipcRenderer.invoke('mcp-get-servers'),
  setMcpServersEnabled: (updates) =>
    ipcRenderer.invoke('mcp-set-servers-enabled', updates),
  refreshMcpServers: () => ipcRenderer.invoke('mcp-refresh-servers'),
};

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronAPI', electronAPI);
    contextBridge.exposeInMainWorld('electron', mcpAPI);
  } catch (error) {
    console.error('Failed to expose electron API:', error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.electronAPI = electronAPI;
  // @ts-expect-error (define in dts)
  window.electron = mcpAPI;
}
