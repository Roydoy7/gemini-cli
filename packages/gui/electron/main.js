/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-env node */
/* eslint-disable @typescript-eslint/no-require-imports, import/enforce-node-protocol-usage, @typescript-eslint/no-unused-vars, no-undef */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const {
  UnifiedChatManager,
  Config,
  RoleManager,
  WorkspaceManager,
  SessionManager,
  AuthManager,
  TemplateManager,
  loadBuiltinExtensions,
} = require('@google/gemini-cli-core');

// UnifiedChatManager instance - we'll initialize this when needed
let unifiedChatManager = null;
let templateManager = null;
let isInitialized = false;
let initializationPromise = null;

// Track active streams and their AbortControllers for proper cancellation
const activeStreams = new Map(); // streamId -> { abortController, startTime }

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load the React app
  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    // Open the DevTools in development
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(() => {
  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-working-directory', () => {
  // Return user's home directory or Documents folder instead of process.cwd()
  const os = require('os');
  const path = require('path');

  // Try to get Documents folder, fallback to home directory
  try {
    const documentsPath = path.join(os.homedir(), 'Documents');
    const fs = require('fs');
    if (fs.existsSync(documentsPath)) {
      return documentsPath;
    }
  } catch (error) {
    console.warn('Failed to access Documents folder:', error);
  }

  // Fallback to home directory
  return os.homedir();
});

// Dialog API handlers
ipcMain.handle('dialog-show-open-dialog', async (_, options) => {
  try {
    const result = await dialog.showOpenDialog(options);
    return result;
  } catch (error) {
    console.error('Failed to show open dialog:', error);
    throw error;
  }
});

// Read file as base64
ipcMain.handle('fs-read-file-as-base64', async (_, filePath) => {
  try {
    const fs = require('fs').promises;
    const buffer = await fs.readFile(filePath);
    return buffer.toString('base64');
  } catch (error) {
    console.error('Failed to read file as base64:', error);
    throw error;
  }
});

// Helper function to ensure UnifiedChatManager is initialized
const ensureInitialized = async (
  configParams = {},
  initialRoleId = undefined,
  defaultProvider = 'gemini',
) => {
  // If already initialized, return immediately
  if (unifiedChatManager && isInitialized) {
    return unifiedChatManager;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    await initializationPromise;
    return unifiedChatManager;
  }

  // Start initialization
  initializationPromise = (async () => {
    try {
      // Create a proper ConfigParameters object
      // Get user's preferred working directory instead of process.cwd()
      const os = require('os');
      const path = require('path');
      let workingDirectory = os.homedir();

      try {
        const documentsPath = path.join(os.homedir(), 'Documents');
        const fs = require('fs');
        if (fs.existsSync(documentsPath)) {
          workingDirectory = documentsPath;
        }
      } catch (error) {
        console.warn(
          'Failed to access Documents folder, using home directory:',
          error,
        );
      }

      const configParameters = {
        sessionId: `gui-session-${Date.now()}`,
        targetDir: workingDirectory,
        debugMode: false,
        cwd: workingDirectory,
        interactive: true,
        ideMode: false, // 禁用 IDE 模式以避免 wmic 命令问题
        ...configParams,
      };

      // Load built-in extensions (like windows-mcp)
      const extensions = loadBuiltinExtensions(workingDirectory);
      console.log(
        '[ensureInitialized] Loaded built-in extensions:',
        extensions.map((e) => e.name),
      );

      // Merge MCP servers from extensions
      const mcpServers = {};
      for (const extension of extensions) {
        console.log(
          '[ensureInitialized] Processing extension:',
          extension.name,
          'with servers:',
          Object.keys(extension.mcpServers || {}),
        );
        if (extension.mcpServers) {
          Object.entries(extension.mcpServers).forEach(([key, server]) => {
            if (mcpServers[key]) {
              console.warn(
                `Skipping extension MCP server "${key}" from ${extension.name} - already exists`,
              );
              return;
            }
            mcpServers[key] = {
              ...server,
              extensionName: extension.name,
            };
            console.log(
              '[ensureInitialized] Added MCP server:',
              key,
              'from extension:',
              extension.name,
            );
          });
        }
      }
      console.log(
        '[ensureInitialized] Merged MCP servers:',
        Object.keys(mcpServers),
      );
      console.log(
        '[ensureInitialized] MCP server details:',
        JSON.stringify(mcpServers, null, 2),
      );

      // Create the Config instance
      const config = new Config({
        ...configParameters,
        extensions,
        mcpServers,
      });

      // Check auth preference and initialize accordingly
      const { AuthType } = require('@google/gemini-cli-core');
      const authManager = AuthManager.getInstance();

      // Get user's auth preference for Gemini
      const authPref = authManager.getAuthPreference('gemini');
      console.log('[ensureInitialized] Auth preference:', authPref);

      // Respect user's choice - don't override their selection
      if (authPref === 'api_key') {
        console.log('[ensureInitialized] User chose API key authentication');
        await config.refreshAuth(AuthType.USE_GEMINI);
      } else if (authPref === 'oauth') {
        console.log('[ensureInitialized] User chose OAuth authentication');
        await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
      } else {
        // No preference set - check what's available and use it
        console.log(
          '[ensureInitialized] No auth preference set, checking available auth...',
        );
        const apiKeyResult = await authManager.checkEnvApiKey('gemini');
        if (apiKeyResult.detected) {
          console.log(
            '[ensureInitialized] API key detected, using API key auth',
          );
          await config.refreshAuth(AuthType.USE_GEMINI);
        } else {
          console.log('[ensureInitialized] No API key, attempting OAuth');
          await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
        }
      }

      await config.initialize();

      // Set up retry callback to notify renderer about retry attempts
      config.setOnRetryAttemptHandler(
        (attempt, maxAttempts, error, delayMs) => {
          // Send retry notification to all renderer processes
          BrowserWindow.getAllWindows().forEach((window) => {
            window.webContents.send('unifiedChat-retry-attempt', {
              attempt,
              maxAttempts,
              error: error?.message || String(error),
              delayMs,
              timestamp: Date.now(),
            });
          });
        },
      );

      // Initialize SessionManager FIRST (before UnifiedChatManager)
      // This ensures sessions are loaded when UnifiedChatManager.initialize() tries to access them
      await SessionManager.getInstance().initializeWithConfig({
        config: config,
      });

      // Initialize UnifiedChatManager with the proper Config instance
      unifiedChatManager = new UnifiedChatManager(config);
      await unifiedChatManager.initialize(initialRoleId, defaultProvider);

      // Initialize WorkspaceManager with config to ensure proper setup
      const workspaceManager = WorkspaceManager.getInstance(config);
      await workspaceManager.ensureInitialized();
      // console.log('WorkspaceManager initialized with config and persisted directories loaded')

      // Initialize TemplateManager with config
      templateManager = TemplateManager.getInstance(config);
      // console.log('TemplateManager initialized with config')

      isInitialized = true;
      // console.log('UnifiedChatManager, SessionManager and WorkspaceManager initialized with default provider:', defaultProvider)
    } catch (error) {
      console.error('Failed to initialize UnifiedChatManager:', error);
      initializationPromise = null; // Reset on error
      throw error;
    }
  })();

  await initializationPromise;
  return unifiedChatManager;
};

// GeminiChat IPC handlers - Now using UnifiedChatManager (supports multi-provider)
ipcMain.handle(
  'unifiedChat-initialize',
  async (_, configParams, initialRoleId, defaultProvider) => {
    try {
      // console.log('UnifiedChat initialize called with:', configParams, 'initialRoleId:', initialRoleId, 'defaultProvider:', defaultProvider)
      await ensureInitialized(configParams, initialRoleId, defaultProvider || 'gemini');
      return { success: true };
    } catch (error) {
      console.error('Failed to initialize UnifiedChatManager:', error);
      throw error;
    }
  },
);

// Provider management handlers
ipcMain.handle('unifiedChat-switch-provider', async (_, sessionId, providerType, model) => {
  try {
    const manager = await ensureInitialized();
    const config = manager.getConfig();

    console.log(`[Main.js] switchProvider: sessionId=${sessionId}, provider=${providerType}, model=${model}`);

    // Set global model if provided (do this first before changing provider)
    if (model) {
      config.setGlobalModel(model);
      console.log(`[Main.js] Set global model: ${model}`);
    }

    // Set global provider and reinitialize tools (async now)
    await manager.setSessionProvider(sessionId, providerType);

    return { success: true };
  } catch (error) {
    console.error('Failed to switch provider:', error);
    throw error;
  }
});

ipcMain.handle('unifiedChat-get-session-provider', async (_, sessionId) => {
  try {
    const manager = await ensureInitialized();
    return manager.getSessionProvider(sessionId);
  } catch (error) {
    console.error('Failed to get session provider:', error);
    return 'gemini'; // Default fallback
  }
});

ipcMain.handle('unifiedChat-get-available-models', async (_, providerType) => {
  try {
    const manager = await ensureInitialized();
    return await manager.getAvailableModels(providerType);
  } catch (error) {
    console.error('Failed to get available models:', error);
    return [];
  }
});

ipcMain.handle('unifiedChat-get-all-roles', async () => {
  // console.log('MultiModel getAllRoles called')
  try {
    const system = await ensureInitialized();
    const roles = RoleManager.getInstance().getAllRoles();
    // console.log('Retrieved roles:', roles.length, 'roles')
    return roles;
  } catch (error) {
    console.error('Failed to get all roles:', error);
    // Fallback to basic built-in roles if system is not available
    return [
      {
        id: 'software_engineer',
        name: 'Software Engineer',
        description:
          'Professional software development and code analysis assistant',
        category: 'development',
        icon: '💻',
        isBuiltin: true,
      },
    ];
  }
});

ipcMain.handle('unifiedChat-get-current-role', async () => {
  // console.log('MultiModel getCurrentRole called')
  try {
    const system = await ensureInitialized();
    const currentRole = RoleManager.getInstance().getCurrentRole();
    // console.log('Retrieved current role:', currentRole.id)
    return currentRole;
  } catch (error) {
    console.error('Failed to get current role:', error);
    // Fallback to default role if system is not available
    return {
      id: 'software_engineer',
      name: 'Software Engineer',
      description:
        'Professional software development and code analysis assistant',
      category: 'development',
      icon: '💻',
      isBuiltin: true,
    };
  }
});

// Add more handlers as needed...
// Removed: Project now uses only Gemini, no provider switching needed
// ipcMain.handle('unifiedChat-switch-provider', ...)

ipcMain.handle('unifiedChat-switch-role', async (_, roleId) => {
  // console.log('MultiModel switchRole called:', roleId)
  try {
    const system = await ensureInitialized();
    const success = await system.switchRole(roleId);
    // console.log('Role switched successfully:', success)
    return success;
  } catch (error) {
    console.error('Failed to switch role:', error);
    return false;
  }
});

// Workspace directory management handlers
ipcMain.handle('unifiedChat-get-workspace-directories', async () => {
  try {
    // console.log('MultiModel getWorkspaceDirectories called')
    const system = await ensureInitialized();
    const directories = WorkspaceManager.getInstance().getDirectories();
    // console.log('Current workspace directories:', directories)
    return directories;
  } catch (error) {
    console.error('Failed to get workspace directories:', error);
    return [];
  }
});

ipcMain.handle(
  'unifiedChat-get-directory-contents',
  async (_, directoryPath) => {
    try {
      // console.log('MultiModel getDirectoryContents called for:', directoryPath)
      const system = await ensureInitialized();
      const items =
        await WorkspaceManager.getInstance().getDirectoryContents(
          directoryPath,
        );
      // console.log('Got directory contents:', items.length, 'items')
      return items;
    } catch (error) {
      console.error('Error getting directory contents:', error);
      return [];
    }
  },
);

ipcMain.handle(
  'unifiedChat-add-workspace-directory',
  async (event, directory, basePath) => {
    try {
      // console.log('MultiModel addWorkspaceDirectory called:', directory, 'basePath:', basePath)
      const system = await ensureInitialized();
      await WorkspaceManager.getInstance().addWorkspaceDirectory(
        directory,
        basePath,
      );

      // Notify all renderer processes about the workspace change
      const updatedDirectories =
        WorkspaceManager.getInstance().getDirectories();
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('workspace-directories-changed', {
          type: 'added',
          directories: updatedDirectories,
          changedDirectory: directory,
        });
      });

      // console.log('Successfully added workspace directory:', directory)
      return { success: true };
    } catch (error) {
      console.error('Failed to add workspace directory:', error);
      throw error;
    }
  },
);

ipcMain.handle(
  'unifiedChat-set-workspace-directories',
  async (event, directories) => {
    try {
      // console.log('MultiModel setWorkspaceDirectories called:', directories)
      const system = await ensureInitialized();
      await WorkspaceManager.getInstance().setDirectories(directories);

      // Notify all renderer processes about the workspace change
      const updatedDirectories =
        WorkspaceManager.getInstance().getDirectories();
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('workspace-directories-changed', {
          type: 'set',
          directories: updatedDirectories,
        });
      });

      // console.log('Successfully set workspace directories')
      return { success: true };
    } catch (error) {
      console.error('Failed to set workspace directories:', error);
      throw error;
    }
  },
);

ipcMain.handle('unifiedChat-get-all-templates', async () => {
  try {
    await ensureInitialized();
    const templates = templateManager.getAllTemplates();
    // console.log('MultiModel getAllTemplates called, returning', templates.length, 'templates')
    return templates;
  } catch (error) {
    console.error('Failed to get all templates:', error);
    return [];
  }
});

ipcMain.handle('unifiedChat-add-custom-template', async (_, template) => {
  try {
    await ensureInitialized();
    templateManager.addCustomTemplate(template);
    // console.log('MultiModel addCustomTemplate called:', template.name)
    return { success: true };
  } catch (error) {
    console.error('Failed to add custom template:', error);
    throw error;
  }
});

ipcMain.handle('unifiedChat-update-custom-template', async (_, id, updates) => {
  try {
    await ensureInitialized();
    templateManager.updateCustomTemplate(id, updates);
    // console.log('MultiModel updateCustomTemplate called:', id)
    return { success: true };
  } catch (error) {
    console.error('Failed to update custom template:', error);
    throw error;
  }
});

ipcMain.handle('unifiedChat-delete-custom-template', async (_, id) => {
  try {
    await ensureInitialized();
    templateManager.deleteCustomTemplate(id);
    // console.log('MultiModel deleteCustomTemplate called:', id)
    return { success: true };
  } catch (error) {
    console.error('Failed to delete custom template:', error);
    throw error;
  }
});

// History management handlers
ipcMain.handle('unifiedChat-get-history', async () => {
  try {
    const system = await ensureInitialized();
    const history = SessionManager.getInstance().getHistory();
    // console.log('MultiModel getHistory called, returning', history.length, 'messages')
    return history;
  } catch (error) {
    console.error('Failed to get conversation history:', error);
    return [];
  }
});

ipcMain.handle('unifiedChat-set-history', async (_, history) => {
  try {
    const system = await ensureInitialized();
    SessionManager.getInstance().setHistory(history);
    // console.log('MultiModel setHistory called with', history.length, 'messages')
    return { success: true };
  } catch (error) {
    console.error('Failed to set conversation history:', error);
    throw error;
  }
});

ipcMain.handle('unifiedChat-clear-history', async () => {
  try {
    const system = await ensureInitialized();
    SessionManager.getInstance().clearHistory();
    // console.log('MultiModel clearHistory called')
    return { success: true };
  } catch (error) {
    console.error('Failed to clear conversation history:', error);
    throw error;
  }
});

// Session management handlers
ipcMain.handle(
  'unifiedChat-create-session',
  async (_, sessionId, title = 'New Chat', roleId, provider) => {
    try {
      const system = await ensureInitialized();
      const config = system.getConfig();
      console.log('[Main.js] createSession called with:', { sessionId, title, roleId, provider });

      // Set global provider if provided
      if (provider) {
        config.setGlobalProvider(provider);
        console.log(`[Main.js] Set global provider: ${provider}`);
      }

      SessionManager.getInstance().createSession(
        sessionId,
        title,
        roleId,
      );
      console.log('[Main.js] SessionManager.createSession completed');
      return { success: true };
    } catch (error) {
      console.error('Failed to create session:', error);
      throw error;
    }
  },
);

ipcMain.handle('unifiedChat-switch-session', async (_, sessionId) => {
  try {
    const system = await ensureInitialized();
    // Use GeminiChatManager.switchSession to properly load history into GeminiClient
    await system.switchSession(sessionId);
    console.log('[Main] Switched to session:', sessionId);
    return { success: true };
  } catch (error) {
    console.error('Failed to switch session:', error);
    throw error;
  }
});

ipcMain.handle('unifiedChat-delete-session', async (_, sessionId) => {
  try {
    const system = await ensureInitialized();
    SessionManager.getInstance().deleteSession(sessionId);
    // console.log('MultiModel deleteSession called:', sessionId)
    return { success: true };
  } catch (error) {
    console.error('Failed to delete session:', error);
    throw error;
  }
});

ipcMain.handle('unifiedChat-delete-all-sessions', async () => {
  try {
    const system = await ensureInitialized();
    const sessionManager = SessionManager.getInstance();
    const sessionsInfo = sessionManager.getSessionsInfo();

    // Delete all sessions
    for (const sessionInfo of sessionsInfo) {
      sessionManager.deleteSession(sessionInfo.id);
    }

    // console.log('MultiModel deleteAllSessions called, deleted', sessionsInfo.length, 'sessions')
    return { success: true };
  } catch (error) {
    console.error('Failed to delete all sessions:', error);
    throw error;
  }
});

ipcMain.handle('unifiedChat-get-current-session-id', async () => {
  try {
    const system = await ensureInitialized();
    const sessionId = SessionManager.getInstance().getCurrentSessionId();
    // console.log('MultiModel getCurrentSessionId called, returning:', sessionId)
    return sessionId;
  } catch (error) {
    console.error('Failed to get current session ID:', error);
    return null;
  }
});

ipcMain.handle('unifiedChat-get-display-messages', async (_, sessionId) => {
  try {
    const system = await ensureInitialized();
    const messages = SessionManager.getInstance().getDisplayMessages(sessionId);
    // console.log('MultiModel getDisplayMessages called for session:', sessionId, 'returning', messages.length, 'messages')
    return messages;
  } catch (error) {
    console.error('Failed to get display messages:', error);
    return [];
  }
});

ipcMain.handle('unifiedChat-get-sessions-info', async () => {
  try {
    const system = await ensureInitialized();
    const sessionsInfo = SessionManager.getInstance().getSessionsInfo();
    // console.log('MultiModel getSessionsInfo called, returning', sessionsInfo.length, 'sessions')
    return sessionsInfo;
  } catch (error) {
    console.error('Failed to get sessions info:', error);
    return [];
  }
});

ipcMain.handle(
  'unifiedChat-update-session-title',
  async (_, sessionId, newTitle) => {
    try {
      const system = await ensureInitialized();
      SessionManager.getInstance().updateSessionTitle(sessionId, newTitle);
      // console.log('MultiModel updateSessionTitle called:', sessionId, newTitle)
      return { success: true };
    } catch (error) {
      console.error('Failed to update session title:', error);
      throw error;
    }
  },
);

ipcMain.handle('unifiedChat-toggle-title-lock', async (_, sessionId, locked) => {
  try {
    const system = await ensureInitialized();
    SessionManager.getInstance().toggleTitleLock(sessionId, locked);
    console.log('Title lock toggled:', sessionId, locked);
    return { success: true };
  } catch (error) {
    console.error('Failed to toggle title lock:', error);
    throw error;
  }
});

ipcMain.handle(
  'unifiedChat-update-session-messages',
  async (_, sessionId, messages) => {
    try {
      const system = await ensureInitialized();
      SessionManager.getInstance().saveSessionHistory(sessionId, messages);
      console.log(
        'MultiModel updateSessionMessages called:',
        sessionId,
        messages.length,
        'messages',
      );
      return { success: true };
    } catch (error) {
      console.error('Failed to update session messages:', error);
      throw error;
    }
  },
);

ipcMain.handle('unifiedChat-set-session-role', async (_, sessionId, roleId) => {
  try {
    const system = await ensureInitialized();
    SessionManager.getInstance().setSessionRole(sessionId, roleId);
    // console.log('MultiModel setSessionRole called:', sessionId, roleId)
    return { success: true };
  } catch (error) {
    console.error('Failed to set session role:', error);
    throw error;
  }
});

// Add message sending handler
ipcMain.handle('unifiedChat-send-message', async (_, messages, signal) => {
  try {
    // console.log('MultiModel sendMessage called with:', messages?.length, 'messages')
    const system = await ensureInitialized();

    // Debug: check current provider
    const currentProvider = system.getCurrentProvider();
    // console.log('Current provider config:', currentProvider)

    // Convert messages to the format expected by MultiModelSystem
    const universalMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Create an AbortController for the signal
    const abortController = new AbortController();

    const response = await system.sendMessage(
      universalMessages,
      abortController.signal,
    );
    // console.log('MultiModel sendMessage response received')
    return response;
  } catch (error) {
    console.error('Failed to send message:', error);
    throw error;
  }
});

// Handle stream cancellation from frontend
ipcMain.handle('unifiedChat-cancel-stream', async (event, streamId) => {
  try {
    const streamInfo = activeStreams.get(streamId);
    if (streamInfo) {
      console.log(`Cancelling stream: ${streamId}`);
      // Abort the stream and any ongoing tool calls
      streamInfo.abortController.abort('User cancelled stream');
      // Remove from active streams
      activeStreams.delete(streamId);

      // Send cancellation event to frontend
      event.sender.send('unifiedChat-stream-error', {
        streamId,
        sessionId: streamInfo.sessionId, // Include sessionId from tracked stream
        error: 'Stream cancelled by user',
      });

      return { success: true, message: 'Stream cancelled successfully' };
    } else {
      console.warn(`Stream ${streamId} not found in active streams`);
      return { success: false, message: 'Stream not found' };
    }
  } catch (error) {
    console.error('Failed to cancel stream:', error);
    return { success: false, message: error.message };
  }
});

// Add streaming message handler using electron-ipc-stream
ipcMain.handle(
  'unifiedChat-send-message-stream',
  async (event, messages, streamId) => {
    // Get current session ID at the very beginning
    // This is critical: we need it for progress handler, confirmation handler, and stream association
    const currentSessionId = SessionManager.getInstance().getCurrentSessionId();

    try {
      // console.log('MultiModel sendMessageStream called with:', messages?.length, 'messages', 'streamId:', streamId)
      const system = await ensureInitialized();

      // Validate session exists
      if (!currentSessionId) {
        throw new Error('No active session - cannot start stream');
      }

      // Set up tool progress handler for real-time progress updates
      system.setToolProgressHandler((progressEvent) => {
        // Send progress event to renderer process
        event.sender.send('unifiedChat-stream-chunk', {
          streamId,
          sessionId: currentSessionId,
          type: 'tool_progress',
          toolCallId: progressEvent.callId,
          toolName: progressEvent.toolName,
          stage: progressEvent.stage,
          progress: progressEvent.progress,
          message: progressEvent.message,
          details: progressEvent.details,
          timestamp: progressEvent.timestamp,
        });
      });

      // Set up tool confirmation handler for this stream session
      system.setToolConfirmationHandler(async (confirmationDetails) => {
        // console.log('Tool confirmation requested from main process:', confirmationDetails)

        // Create a serializable confirmation request with all necessary data
        const confirmationRequest = {
          title: confirmationDetails.title,
          type: confirmationDetails.type,
          // Include all fields needed for display
          ...(confirmationDetails.type === 'edit' && {
            fileName: confirmationDetails.fileName,
            fileDiff: confirmationDetails.fileDiff,
            originalContent: confirmationDetails.originalContent,
            newContent: confirmationDetails.newContent,
          }),
          ...(confirmationDetails.type === 'exec' && {
            command: confirmationDetails.command,
            rootCommand: confirmationDetails.rootCommand,
            showPythonCode: confirmationDetails.showPythonCode,
            pythonCode: confirmationDetails.pythonCode,
            description: confirmationDetails.description,
          }),
          ...(confirmationDetails.type === 'mcp' && {
            serverName: confirmationDetails.serverName,
            toolName: confirmationDetails.toolName,
            toolDisplayName: confirmationDetails.toolDisplayName,
            parameters: confirmationDetails.parameters,
          }),
          ...(confirmationDetails.type === 'info' && {
            message: confirmationDetails.message,
          }),
        };

        // Send confirmation request to renderer process with sessionId
        event.sender.send('tool-confirmation-request', {
          streamId,
          sessionId: currentSessionId, // CRITICAL: Include sessionId for proper routing
          confirmationDetails: confirmationRequest,
        });

        // Wait for response from renderer
        return new Promise((resolve) => {
          ipcMain.once(
            'tool-confirmation-response',
            (responseEvent, response) => {
              console.log('[Main] Tool confirmation response received');
              console.log('[Main] Response sessionId:', response.sessionId);
              console.log(
                '[Main] Expected sessionId (from stream start):',
                currentSessionId,
              );

              // CRITICAL: Verify response belongs to correct session
              if (
                response.sessionId &&
                response.sessionId !== currentSessionId
              ) {
                console.warn(
                  `[Main] Ignoring tool confirmation response from session ${response.sessionId}, expected ${currentSessionId}`,
                );
                // Reject invalid response - tool execution will timeout or be cancelled
                resolve({ approved: false, reason: 'Session mismatch' });
                return;
              }
              console.log(
                '[Main] SessionId matched, resolving with outcome:',
                response.outcome,
              );
              resolve(response.outcome);
            },
          );
        });
      });

      // GeminiChatManager.sendMessageStream() expects Part array (e.g., [{text: "..."}])
      // It only needs the current user request, not full history
      // History is managed internally by GeminiClient's GeminiChat
      const lastMessage = messages[messages.length - 1];

      // Use parts if available (for images and other media), otherwise use text content
      const request =
        lastMessage.parts && lastMessage.parts.length > 0
          ? lastMessage.parts
          : [{ text: lastMessage.content }];

      // Create an AbortController for the signal
      const abortController = new AbortController();

      // Register the stream for cancellation tracking with sessionId
      activeStreams.set(streamId, {
        abortController,
        startTime: Date.now(),
        sessionId: currentSessionId, // Associate stream with session
      });

      try {
        // Use streaming approach
        console.log(
          `[Main] Starting stream ${streamId} with request:`,
          request,
        );
        const streamGenerator = system.sendMessageStream(
          request,
          abortController.signal,
          streamId,
        );
        console.log(`[Main] Stream generator created for ${streamId}`);

        let fullContent = '';
        let chunkCount = 0;

        console.log(`[Main] Entering for-await loop for stream ${streamId}`);
        for await (const chunk of streamGenerator) {
          chunkCount++;
          // Check if stream was cancelled
          if (abortController.signal.aborted) {
            console.log(
              `Stream ${streamId} was cancelled, stopping processing`,
            );
            break;
          }

          // // console.log('Stream chunk received:', chunk.type, chunk.content?.substring(0, 50))

          // Handle error events - these should stop the stream immediately
          if (chunk.type === 'error') {
            console.error(
              '[Main] Received error event from stream:',
              chunk.error,
            );

            // Format error message with more detail
            let errorMessage = chunk.error?.message || 'Unknown error occurred';

            // Add additional context for specific error types
            if (errorMessage.includes('GOOGLE_CLOUD_PROJECT')) {
              errorMessage = `Authentication Error: ${errorMessage}\n\nFor Workspace GCA users, you need to set the GOOGLE_CLOUD_PROJECT environment variable before starting the application.\n\nPlease restart the application with:\nset GOOGLE_CLOUD_PROJECT=your-project-id`;
            } else if (errorMessage.includes('Failed to initialize')) {
              errorMessage = `Initialization Error: ${errorMessage}\n\nPlease check your authentication settings and try again.`;
            }

            // Send error through IPC events
            const errorData = {
              streamId,
              sessionId: currentSessionId, // Include sessionId
              type: 'error',
              error: errorMessage,
              timestamp: Date.now(),
            };

            event.sender.send('unifiedChat-stream-error', errorData);

            // Break the loop to stop processing
            break;
          }

          // Handle different event types
          if (chunk.type === 'compression') {
            // Send compression event
            const compressionData = {
              streamId,
              sessionId: currentSessionId, // Include sessionId
              type: 'compression',
              compressionInfo: chunk.compressionInfo,
              timestamp: Date.now(),
            };
            event.sender.send('unifiedChat-stream-chunk', compressionData);
          } else if (chunk.type === 'content') {
            // Turn events use 'value' field, convert to frontend format
            const content = chunk.value || chunk.content || '';
            const chunkData = {
              streamId,
              sessionId: currentSessionId, // Include sessionId
              type: 'content_delta', // Frontend expects 'content_delta'
              content: content,
              role: 'assistant',
              timestamp: Date.now(),
            };
            event.sender.send('unifiedChat-stream-chunk', chunkData);

            // Accumulate content for final response
            if (content) {
              fullContent += content;
            }
          } else if (chunk.type === 'thought') {
            // Send thought as special event type with structured data
            const thoughtSummary = chunk.value;
            if (thoughtSummary && typeof thoughtSummary === 'object') {
              const chunkData = {
                streamId,
                sessionId: currentSessionId, // Include sessionId
                type: 'thought', // Keep as 'thought' type for special frontend handling
                thoughtSummary: {
                  subject: thoughtSummary.subject || '',
                  description: thoughtSummary.description || '',
                },
                role: 'assistant',
                timestamp: Date.now(),
              };
              event.sender.send('unifiedChat-stream-chunk', chunkData);
            }
            // Don't accumulate thought in final content
          } else if (chunk.type === 'finished') {
            // Stream finished, don't send this to frontend
            // The completion signal will be sent after the loop
          } else if (chunk.type === 'tool_call_request') {
            // Handle tool call requests with proper field mapping
            const requestValue = chunk.value || {};
            const chunkData = {
              streamId,
              sessionId: currentSessionId, // Include sessionId
              type: 'tool_call_request',
              toolCall: {
                id: requestValue.callId,
                name: requestValue.name,
                arguments: requestValue.args || {}, // Map 'args' to 'arguments' for frontend
                description: requestValue.description, // Include description from tool args
              },
              role: 'assistant',
              timestamp: Date.now(),
            };
            event.sender.send('unifiedChat-stream-chunk', chunkData);
          } else if (chunk.type === 'tool_call_response') {
            // Handle tool call responses with proper field mapping
            const responseValue = chunk.value || {};
            // Tool is successful only if BOTH error and errorType are undefined
            const isSuccess = !responseValue.error && !responseValue.errorType;
            const chunkData = {
              streamId,
              sessionId: currentSessionId, // Include sessionId
              type: 'tool_call_response',
              toolCallId: responseValue.callId,
              toolName: responseValue.name || 'unknown',
              content: responseValue.resultDisplay || '',
              toolSuccess: isSuccess,
              toolResponseData: responseValue.structuredData,
              error: responseValue.error,
              errorType: responseValue.errorType,
              role: 'assistant',
              timestamp: Date.now(),
            };
            event.sender.send('unifiedChat-stream-chunk', chunkData);
          } else if (chunk.type === 'tool_progress') {
            // Handle tool progress events
            const progressValue = chunk.value || {};
            const chunkData = {
              streamId,
              sessionId: currentSessionId,
              type: 'tool_progress',
              toolCallId: progressValue.callId,
              toolName: progressValue.toolName,
              stage: progressValue.stage,
              progress: progressValue.progress,
              message: progressValue.message,
              details: progressValue.details,
              timestamp: Date.now(),
            };
            event.sender.send('unifiedChat-stream-chunk', chunkData);
          } else {
            // Handle other event types
            const chunkData = {
              streamId,
              sessionId: currentSessionId, // Include sessionId
              type: chunk.type,
              content: chunk.content || chunk.value || '',
              role: 'assistant',
              timestamp: Date.now(),
              ...chunk, // Include any additional properties
            };
            event.sender.send('unifiedChat-stream-chunk', chunkData);

            // Accumulate content if present
            const content = chunk.content || chunk.value;
            if (content) {
              fullContent += content;
            }
          }
        }

        // Send completion signal
        const completionData = {
          streamId,
          sessionId: currentSessionId, // Include sessionId
          type: 'complete',
          content: fullContent,
          role: 'assistant',
          timestamp: Date.now(),
        };

        event.sender.send('unifiedChat-stream-complete', completionData);

        return { success: true, totalContent: fullContent };
      } catch (streamError) {
        console.error('[Main] Stream error occurred:', streamError);

        // Format error message with more detail
        let errorMessage = streamError.message || 'Unknown error occurred';

        // Add additional context for specific error types
        if (errorMessage.includes('GOOGLE_CLOUD_PROJECT')) {
          errorMessage = `Authentication Error: ${errorMessage}\n\nFor Workspace GCA users, you need to set the GOOGLE_CLOUD_PROJECT environment variable before starting the application.\n\nPlease restart the application with:\nset GOOGLE_CLOUD_PROJECT=your-project-id`;
        }

        // Send error through IPC events
        const errorData = {
          streamId,
          sessionId: currentSessionId, // Include sessionId
          type: 'error',
          error: errorMessage,
          timestamp: Date.now(),
        };

        event.sender.send('unifiedChat-stream-error', errorData);
        throw streamError;
      }
    } catch (error) {
      console.error('[Main] Failed to send streaming message:', error);

      // Format error message with context
      let errorMessage = error.message || 'Failed to send message';

      // Add additional context for specific error types
      if (errorMessage.includes('GOOGLE_CLOUD_PROJECT')) {
        errorMessage = `Authentication Error: ${errorMessage}\n\nFor Workspace GCA users, you need to set the GOOGLE_CLOUD_PROJECT environment variable before starting the application.\n\nPlease restart the application with:\nset GOOGLE_CLOUD_PROJECT=your-project-id`;
      } else if (errorMessage.includes('Failed to initialize')) {
        errorMessage = `Initialization Error: ${errorMessage}\n\nPlease check your authentication settings and try again.`;
      }

      // Send error through IPC if we have a streamId
      if (streamId) {
        const errorData = {
          streamId,
          sessionId: currentSessionId, // Include sessionId
          type: 'error',
          error: errorMessage,
          timestamp: Date.now(),
        };
        event.sender.send('unifiedChat-stream-error', errorData);
      }

      throw error;
    } finally {
      // Always clean up the stream from active streams tracking
      activeStreams.delete(streamId);
      console.log(`[Main] Stream ${streamId} removed from active streams`);
    }
  },
);

// OAuth Authentication IPC handlers using AuthManager
ipcMain.handle('oauth-start-flow', async (_, providerType) => {
  try {
    // console.log('OAuth start flow called for:', providerType)

    // Ensure system is initialized to get config
    const system = await ensureInitialized();

    // Use AuthManager instead of hardcoded OAuth logic
    // const { AuthManager } = require('@google/gemini-cli-core')
    const authManager = AuthManager.getInstance();
    authManager.setConfig(system.getConfig());

    const result = await authManager.startOAuthFlow(providerType);
    // console.log('OAuth flow result:', result)

    return result;
  } catch (error) {
    console.error('OAuth flow failed:', error);
    return {
      success: false,
      error: error.message || 'OAuth authentication failed',
    };
  }
});

ipcMain.handle('oauth-get-status', async (_, providerType) => {
  try {
    // console.log('OAuth get status called for:', providerType)

    // IMPORTANT: This should ONLY check OAuth status, not API key or any other auth method
    // This is used by the OAuth configuration UI to determine if user is logged in with OAuth
    const authManager = AuthManager.getInstance();

    // Get the current auth preference
    const authPref = authManager.getAuthPreference(providerType);

    // If user's preference is NOT oauth, always return unauthenticated
    if (authPref !== 'oauth') {
      return { authenticated: false, type: 'none' };
    }

    // User chose OAuth - check if they have valid OAuth credentials
    const status = await authManager.getAuthStatus(providerType);

    // Only return authenticated if BOTH:
    // 1. User's preference is OAuth
    // 2. OAuth credentials are valid
    const isOAuthAuthenticated =
      status.authType === 'oauth' && status.authenticated;

    return {
      authenticated: isOAuthAuthenticated,
      userEmail: status.userEmail,
      type: isOAuthAuthenticated ? 'oauth' : 'none',
    };
  } catch (error) {
    console.error('Failed to check OAuth status:', error);
    return { authenticated: false };
  }
});

ipcMain.handle('oauth-clear-credentials', async (_, providerType) => {
  try {
    // console.log('OAuth clear credentials called for:', providerType)

    // Use AuthManager for unified credential clearing
    // const { AuthManager } = require('@google/gemini-cli-core')
    const authManager = AuthManager.getInstance();

    const result = await authManager.clearCredentials(providerType);
    // console.log('OAuth credentials cleared:', result)

    return result;
  } catch (error) {
    console.error('Failed to clear OAuth credentials:', error);
    return {
      success: false,
      error: error.message,
    };
  }
});

ipcMain.handle('check-env-api-key', async (_, providerType) => {
  try {
    // console.log('Check environment API key called for:', providerType)

    // Use AuthManager for unified API key checking
    // const { AuthManager } = require('@google/gemini-cli-core')
    const authManager = AuthManager.getInstance();

    const result = await authManager.checkEnvApiKey(providerType);
    // console.log('Environment API key check result:', result)

    return result;
  } catch (error) {
    console.error('Failed to check environment API key:', error);
    return { detected: false, source: 'Error' };
  }
});

// Add IPC handler for setting API key preference
ipcMain.handle('set-api-key-preference', async (_, providerType) => {
  try {
    // console.log('Set API key preference called for:', providerType)

    // Use AuthManager to set API key preference WITHOUT initializing
    // Setting preference should not trigger initialization
    const authManager = AuthManager.getInstance();
    await authManager.useApiKeyAuth(providerType);

    // console.log('API key preference set successfully')
    return { success: true };
  } catch (error) {
    console.error('Failed to set API key preference:', error);
    return {
      success: false,
      error: error.message,
    };
  }
});

// Add IPC handler for setting OAuth preference
ipcMain.handle('set-oauth-preference', async (_, providerType) => {
  try {
    // console.log('Set OAuth preference called for:', providerType)

    // Use AuthManager to set OAuth preference WITHOUT initializing
    // Setting preference should not trigger initialization
    const authManager = AuthManager.getInstance();
    await authManager.setAuthPreference(providerType, 'oauth');

    // console.log('OAuth preference set successfully')
    return { success: true };
  } catch (error) {
    console.error('Failed to set OAuth preference:', error);
    return {
      success: false,
      error: error.message,
    };
  }
});

// Add IPC handler for getting auth preference
ipcMain.handle('get-auth-preference', async (_, providerType) => {
  try {
    // console.log('Get auth preference called for:', providerType)

    // Use AuthManager to get auth preference WITHOUT initializing
    const authManager = AuthManager.getInstance();
    const preference = authManager.getAuthPreference(providerType);

    // console.log('Auth preference result:', preference)
    return { preference };
  } catch (error) {
    console.error('Failed to get auth preference:', error);
    return { preference: null };
  }
});

// Approval mode management handlers
ipcMain.handle('get-approval-mode', async () => {
  try {
    const system = await ensureInitialized();
    const approvalMode = system.getApprovalMode();
    return approvalMode;
  } catch (error) {
    console.error('Failed to get approval mode:', error);
    return 'default';
  }
});

ipcMain.handle('set-approval-mode', async (_, mode) => {
  try {
    const system = await ensureInitialized();
    system.setApprovalMode(mode);
    return { success: true };
  } catch (error) {
    console.error('Failed to set approval mode:', error);
    throw error;
  }
});

// Direct Excel tool call handler
ipcMain.handle('unifiedChat-call-excel-tool', async (_, operation, params) => {
  try {
    const system = await ensureInitialized();
    const { ExcelTool } = require('@google/gemini-cli-core');
    const excelTool = new ExcelTool(system.getConfig());

    switch (operation) {
      case 'listApps':
        return await excelTool.listApps();
      case 'listWorkbooks':
        return await excelTool.listWorkbooks();
      case 'listWorksheets':
        return await excelTool.listWorksheets(params?.workbookName);
      case 'getSelection':
        return await excelTool.getSelection(params?.workbookName);
      default:
        return {
          success: false,
          error: `Unknown Excel operation: ${operation}`,
        };
    }
  } catch (error) {
    console.error('Failed to call Excel tool:', error);
    return {
      success: false,
      error: error.message,
    };
  }
});

// MCP Server Management handlers
ipcMain.handle('mcp-get-servers', async () => {
  try {
    const system = await ensureInitialized();
    const config = system.getConfig();
    const {
      McpServerEnablementManager,
      generateMcpServerKey,
      MCPServerStatus,
      getAllMCPServerStatuses,
    } = require('@google/gemini-cli-core');

    // Get MCP servers from configuration
    const mcpServers = config.getMcpServers() || {};

    // Get enablement manager
    const enablementManager = new McpServerEnablementManager();

    // Get server statuses
    const serverStatuses = getAllMCPServerStatuses();

    // Build server list
    const servers = [];
    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      const serverKey = generateMcpServerKey(
        serverConfig.extension?.name,
        name,
      );

      const enabled = enablementManager.isEnabled(serverKey);
      const status = serverStatuses.get(name);
      const connected = status === MCPServerStatus.CONNECTED;

      // Determine transport type
      let transport = 'stdio';
      if (serverConfig.httpUrl) {
        transport = 'http';
      } else if (serverConfig.url) {
        transport = 'sse';
      }

      servers.push({
        key: serverKey,
        name,
        displayName: serverConfig.extension
          ? `${name} (${serverConfig.extension.name})`
          : name,
        extensionName: serverConfig.extension?.name,
        enabled,
        description: serverConfig.description,
        transport,
        connected,
      });
    }

    return servers;
  } catch (error) {
    console.error('Failed to get MCP servers:', error);
    throw error;
  }
});

ipcMain.handle('mcp-set-servers-enabled', async (_, updates) => {
  try {
    const system = await ensureInitialized();
    const config = system.getConfig();
    const { McpServerEnablementManager } = require('@google/gemini-cli-core');

    // Get enablement manager
    const enablementManager = new McpServerEnablementManager();

    // Apply updates
    enablementManager.setMultiple(updates);

    // Re-discover MCP tools to apply the changes
    // This will remove tools from disabled servers and discover tools from newly enabled servers
    const toolRegistry = config.getToolRegistry();
    await toolRegistry.discoverMcpTools();
    console.log('[Main] MCP server enablement updated, tools re-discovered');

    return { success: true };
  } catch (error) {
    console.error('Failed to set MCP servers enabled:', error);
    throw error;
  }
});

ipcMain.handle('mcp-refresh-servers', async () => {
  try {
    // Trigger re-discovery of MCP servers
    // This would require re-initializing the system or
    // calling the discovery method again
    const system = await ensureInitialized();

    // For now, just return success
    // In a full implementation, you'd want to:
    // 1. Stop existing MCP clients
    // 2. Re-discover MCP servers
    // 3. Start new MCP clients
    return { success: true };
  } catch (error) {
    console.error('Failed to refresh MCP servers:', error);
    throw error;
  }
});
