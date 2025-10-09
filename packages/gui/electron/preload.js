/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const { contextBridge, ipcRenderer } = require('electron')

// Define the API interface that will be exposed to the renderer process
const electronAPI = {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getWorkingDirectory: () => ipcRenderer.invoke('get-working-directory'),
  
  // Dialog API
  dialog: {
    showOpenDialog: (options) => ipcRenderer.invoke('dialog-show-open-dialog', options)
  },
  
  // Event listeners
  onWorkspaceDirectoriesChanged: (callback) => {
    ipcRenderer.on('workspace-directories-changed', callback)
    // Return cleanup function
    return () => ipcRenderer.removeListener('workspace-directories-changed', callback)
  },
  
  // GeminiChat System API
  geminiChat: {
    initialize: (config) => ipcRenderer.invoke('geminiChat-initialize', config),
    switchProvider: (providerType, model) => ipcRenderer.invoke('geminiChat-switch-provider', providerType, model),
    switchRole: (roleId) => ipcRenderer.invoke('geminiChat-switch-role', roleId),
    sendMessage: (messages) => ipcRenderer.invoke('geminiChat-send-message', messages),
    sendMessageStream: (messages) => {
      const streamId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      
      return {
        streamId,
        // Real-time streaming with callback
        startStream: (onChunk, onComplete, onError) => {
          const cleanup = () => {
            // Notify backend to cancel the stream and any ongoing tool calls
            ipcRenderer.invoke('geminiChat-cancel-stream', streamId).catch(error => {
              console.warn('Failed to cancel stream on backend:', error);
            });
            // Remove event listeners
            ipcRenderer.removeAllListeners('geminiChat-stream-chunk');
            ipcRenderer.removeAllListeners('geminiChat-stream-complete');
            ipcRenderer.removeAllListeners('geminiChat-stream-error');
          };
          
          // Set up event handlers BEFORE starting the request
          ipcRenderer.on('geminiChat-stream-chunk', (event, data) => {
            if (data.streamId === streamId) {
              onChunk(data);
            }
          });
          
          ipcRenderer.on('geminiChat-stream-complete', (event, data) => {
            if (data.streamId === streamId) {
              cleanup();
              onComplete(data);
            }
          });
          
          ipcRenderer.on('geminiChat-stream-error', (event, data) => {
            if (data.streamId === streamId) {
              console.error('IPC stream error received:', data.error);
              cleanup();
              onError({ type: 'error', error: data.error });
            }
          });
          
          // Set up timeout
          const timeout = setTimeout(() => {
            console.error('Stream timeout after 15 minutes');
            cleanup();
            onError({ type: 'error', error: 'Stream timeout' });
          }, 15 * 60 * 1000); // 15 minute timeout
          
          // NOW start the streaming request after event handlers are set
          ipcRenderer.invoke('geminiChat-send-message-stream', messages, streamId)
            .catch((error) => {
              console.error('IPC invoke failed:', error.message, error);
              clearTimeout(timeout);
              cleanup();
              onError({ type: 'error', error: error.message });
            });
          
          // Return cleanup function
          return () => {
            clearTimeout(timeout);
            cleanup();
          };
        }
      }
    },
    getAvailableModels: (providerType) => ipcRenderer.invoke('geminiChat-get-available-models', providerType),
    getAllRoles: () => ipcRenderer.invoke('geminiChat-get-all-roles'),
    getCurrentRole: () => ipcRenderer.invoke('geminiChat-get-current-role'),
    getAllTemplates: () => ipcRenderer.invoke('geminiChat-get-all-templates'),
    renderTemplate: (templateId, variables) => ipcRenderer.invoke('geminiChat-render-template', templateId, variables),
    addWorkspaceDirectory: (directory, basePath) => ipcRenderer.invoke('geminiChat-add-workspace-directory', directory, basePath),
    getWorkspaceDirectories: () => ipcRenderer.invoke('geminiChat-get-workspace-directories'),
    getDirectoryContents: (directoryPath) => ipcRenderer.invoke('geminiChat-get-directory-contents', directoryPath),
    setWorkspaceDirectories: (directories) => ipcRenderer.invoke('geminiChat-set-workspace-directories', directories),
    getCurrentToolset: () => ipcRenderer.invoke('geminiChat-get-current-toolset'),
    addCustomRole: (role) => ipcRenderer.invoke('geminiChat-add-custom-role', role),
    addCustomTemplate: (template) => ipcRenderer.invoke('geminiChat-add-custom-template', template),
    updateCustomTemplate: (id, updates) => ipcRenderer.invoke('geminiChat-update-custom-template', id, updates),
    deleteCustomTemplate: (id) => ipcRenderer.invoke('geminiChat-delete-custom-template', id),
    // Session management
    createSession: (sessionId, title, roleId) => ipcRenderer.invoke('geminiChat-create-session', sessionId, title, roleId),
    switchSession: (sessionId) => ipcRenderer.invoke('geminiChat-switch-session', sessionId),
    deleteSession: (sessionId) => ipcRenderer.invoke('geminiChat-delete-session', sessionId),
    deleteAllSessions: () => ipcRenderer.invoke('geminiChat-delete-all-sessions'),
    getCurrentSessionId: () => ipcRenderer.invoke('geminiChat-get-current-session-id'),
    getDisplayMessages: (sessionId) => ipcRenderer.invoke('geminiChat-get-display-messages', sessionId),
    getSessionsInfo: () => ipcRenderer.invoke('geminiChat-get-sessions-info'),
    updateSessionTitle: (sessionId, newTitle) => ipcRenderer.invoke('geminiChat-update-session-title', sessionId, newTitle),
    setSessionRole: (sessionId, roleId) => ipcRenderer.invoke('geminiChat-set-session-role', sessionId, roleId),
    // OAuth authentication
    startOAuthFlow: (providerType) => ipcRenderer.invoke('oauth-start-flow', providerType),
    getOAuthStatus: (providerType) => ipcRenderer.invoke('oauth-get-status', providerType),
    clearOAuthCredentials: (providerType) => ipcRenderer.invoke('oauth-clear-credentials', providerType),
    checkEnvApiKey: (providerType) => ipcRenderer.invoke('check-env-api-key', providerType),
    setApiKeyPreference: (providerType) => ipcRenderer.invoke('set-api-key-preference', providerType),
    setOAuthPreference: (providerType) => ipcRenderer.invoke('set-oauth-preference', providerType),
    getApprovalMode: () => ipcRenderer.invoke('get-approval-mode'),
    setApprovalMode: (mode) => ipcRenderer.invoke('set-approval-mode', mode),
    // Direct Excel tool calls
    callExcelTool: (operation, params) => ipcRenderer.invoke('geminiChat-call-excel-tool', operation, params),
    // Tool confirmation
    onToolConfirmationRequest: (callback) => {
      ipcRenderer.on('tool-confirmation-request', callback);
      // Return cleanup function
      return () => ipcRenderer.removeListener('tool-confirmation-request', callback);
    },
    sendToolConfirmationResponse: (outcome) => ipcRenderer.send('tool-confirmation-response', outcome),
  }
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronAPI', electronAPI)
  } catch (error) {
    console.error('Failed to expose electron API:', error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electronAPI = electronAPI
}