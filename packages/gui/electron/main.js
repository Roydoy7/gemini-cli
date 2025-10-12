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
  GeminiChatManager,
  Config,
  RoleManager,
  WorkspaceManager,
  SessionManager,
  ModelProviderFactory,
  AuthManager,
  TemplateManager,
} = require('@google/gemini-cli-core');

// GeminiChatManager instance - we'll initialize this when needed
let geminiChatManager = null;
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

// Helper function to ensure GeminiChatManager is initialized
const ensureInitialized = async (
  configParams = {},
  initialRoleId = undefined,
) => {
  // If already initialized, return immediately
  if (geminiChatManager && isInitialized) {
    return geminiChatManager;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    await initializationPromise;
    return geminiChatManager;
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

      // Create the Config instance
      const config = new Config(configParameters);

      // Initialize contentGenerator with Google OAuth as default
      // This must be done before config.initialize() because GeminiClient needs contentGenerator
      const { AuthType } = require('@google/gemini-cli-core');
      await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);

      await config.initialize();

      // Initialize SessionManager FIRST (before GeminiChatManager)
      // This ensures sessions are loaded when GeminiChatManager.initialize() tries to access them
      await SessionManager.getInstance().initializeWithConfig({
        config: config,
        createModelProvider: ModelProviderFactory.create,
      });

      // Initialize GeminiChatManager with the proper Config instance
      geminiChatManager = new GeminiChatManager(config);
      await geminiChatManager.initialize(initialRoleId);

      // Initialize WorkspaceManager with config to ensure proper setup
      const workspaceManager = WorkspaceManager.getInstance(config);
      await workspaceManager.ensureInitialized();
      // console.log('WorkspaceManager initialized with config and persisted directories loaded')

      // Initialize TemplateManager with config
      templateManager = new TemplateManager(config);
      // console.log('TemplateManager initialized with config')

      isInitialized = true;
      // console.log('MultiModelSystem, SessionManager and WorkspaceManager initialized with LM Studio default model')
    } catch (error) {
      console.error('Failed to initialize GeminiChatManager:', error);
      initializationPromise = null; // Reset on error
      throw error;
    }
  })();

  await initializationPromise;
  return geminiChatManager;
};

// GeminiChat IPC handlers - Now using actual GeminiChatManager
ipcMain.handle(
  'geminiChat-initialize',
  async (_, configParams, initialRoleId) => {
    try {
      // console.log('GeminiChat initialize called with:', configParams, 'initialRoleId:', initialRoleId)
      await ensureInitialized(configParams, initialRoleId);
      return { success: true };
    } catch (error) {
      console.error('Failed to initialize GeminiChatManager:', error);
      throw error;
    }
  },
);

// Removed: Project now uses only Gemini, model list is hardcoded in frontend
// ipcMain.handle('geminiChat-get-available-models', ...)

ipcMain.handle('geminiChat-get-all-roles', async () => {
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

ipcMain.handle('geminiChat-get-current-role', async () => {
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
// ipcMain.handle('geminiChat-switch-provider', ...)

ipcMain.handle('geminiChat-switch-role', async (_, roleId) => {
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
ipcMain.handle('geminiChat-get-workspace-directories', async () => {
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
  'geminiChat-get-directory-contents',
  async (_, directoryPath) => {
    try {
      // console.log('MultiModel getDirectoryContents called for:', directoryPath)
      const system = await ensureInitialized();
      const items = await geminiChatManager.getDirectoryContents(directoryPath);
      // console.log('Got directory contents:', items.length, 'items')
      return items;
    } catch (error) {
      console.error('Error getting directory contents:', error);
      return [];
    }
  },
);

ipcMain.handle(
  'geminiChat-add-workspace-directory',
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
  'geminiChat-set-workspace-directories',
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

ipcMain.handle('geminiChat-get-all-templates', async () => {
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

ipcMain.handle('geminiChat-add-custom-template', async (_, template) => {
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

ipcMain.handle('geminiChat-update-custom-template', async (_, id, updates) => {
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

ipcMain.handle('geminiChat-delete-custom-template', async (_, id) => {
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
ipcMain.handle('geminiChat-get-history', async () => {
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

ipcMain.handle('geminiChat-set-history', async (_, history) => {
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

ipcMain.handle('geminiChat-clear-history', async () => {
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
  'geminiChat-create-session',
  async (_, sessionId, title = 'New Chat', roleId) => {
    try {
      const system = await ensureInitialized();
      SessionManager.getInstance().createSession(sessionId, title, roleId);
      // console.log('MultiModel createSession called:', sessionId, title, 'roleId:', roleId)
      return { success: true };
    } catch (error) {
      console.error('Failed to create session:', error);
      throw error;
    }
  },
);

ipcMain.handle('geminiChat-switch-session', async (_, sessionId) => {
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

ipcMain.handle('geminiChat-delete-session', async (_, sessionId) => {
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

ipcMain.handle('geminiChat-delete-all-sessions', async () => {
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

ipcMain.handle('geminiChat-get-current-session-id', async () => {
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

ipcMain.handle('geminiChat-get-display-messages', async (_, sessionId) => {
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

ipcMain.handle('geminiChat-get-sessions-info', async () => {
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
  'geminiChat-update-session-title',
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

ipcMain.handle(
  'geminiChat-update-session-messages',
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

ipcMain.handle('geminiChat-set-session-role', async (_, sessionId, roleId) => {
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
ipcMain.handle('geminiChat-send-message', async (_, messages, signal) => {
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
ipcMain.handle('geminiChat-cancel-stream', async (event, streamId) => {
  try {
    const streamInfo = activeStreams.get(streamId);
    if (streamInfo) {
      console.log(`Cancelling stream: ${streamId}`);
      // Abort the stream and any ongoing tool calls
      streamInfo.abortController.abort('User cancelled stream');
      // Remove from active streams
      activeStreams.delete(streamId);

      // Send cancellation event to frontend
      event.sender.send('geminiChat-stream-error', {
        streamId,
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
  'geminiChat-send-message-stream',
  async (event, messages, streamId) => {
    try {
      // console.log('MultiModel sendMessageStream called with:', messages?.length, 'messages', 'streamId:', streamId)
      const system = await ensureInitialized();

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
          }),
          ...(confirmationDetails.type === 'mcp' && {
            toolName: confirmationDetails.toolName,
            parameters: confirmationDetails.parameters,
          }),
          ...(confirmationDetails.type === 'info' && {
            message: confirmationDetails.message,
          }),
        };

        // Send confirmation request to renderer process
        event.sender.send('tool-confirmation-request', {
          streamId,
          confirmationDetails: confirmationRequest,
        });

        // Wait for response from renderer
        return new Promise((resolve) => {
          ipcMain.once(
            'tool-confirmation-response',
            (responseEvent, outcome) => {
              // console.log('Tool confirmation response received in main process:', outcome)
              resolve(outcome);
            },
          );
        });
      });

      // GeminiChatManager.sendMessageStream() expects Part array (e.g., [{text: "..."}])
      // It only needs the current user request, not full history
      // History is managed internally by GeminiClient's GeminiChat
      const lastMessage = messages[messages.length - 1];
      const request = [{ text: lastMessage.content }];

      // Create an AbortController for the signal
      const abortController = new AbortController();

      // Register the stream for cancellation tracking
      activeStreams.set(streamId, {
        abortController,
        startTime: Date.now(),
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
          console.log(
            `[Main] Stream ${streamId} received chunk #${chunkCount}, type:`,
            chunk.type,
          );
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
              type: 'error',
              error: errorMessage,
              timestamp: Date.now(),
            };

            event.sender.send('geminiChat-stream-error', errorData);

            // Break the loop to stop processing
            break;
          }

          // Handle different event types
          if (chunk.type === 'compression') {
            // Send compression event
            const compressionData = {
              streamId,
              type: 'compression',
              compressionInfo: chunk.compressionInfo,
              timestamp: Date.now(),
            };
            event.sender.send('geminiChat-stream-chunk', compressionData);
          } else if (chunk.type === 'content') {
            // Turn events use 'value' field, convert to frontend format
            const content = chunk.value || chunk.content || '';
            const chunkData = {
              streamId,
              type: 'content_delta', // Frontend expects 'content_delta'
              content: content,
              role: 'assistant',
              timestamp: Date.now(),
            };
            event.sender.send('geminiChat-stream-chunk', chunkData);

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
                type: 'thought', // Keep as 'thought' type for special frontend handling
                thoughtSummary: {
                  subject: thoughtSummary.subject || '',
                  description: thoughtSummary.description || '',
                },
                role: 'assistant',
                timestamp: Date.now(),
              };
              event.sender.send('geminiChat-stream-chunk', chunkData);
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
              type: 'tool_call_request',
              toolCall: {
                id: requestValue.callId,
                name: requestValue.name,
                arguments: requestValue.args || {}, // Map 'args' to 'arguments' for frontend
              },
              role: 'assistant',
              timestamp: Date.now(),
            };
            event.sender.send('geminiChat-stream-chunk', chunkData);
          } else if (chunk.type === 'tool_call_response') {
            // Handle tool call responses with proper field mapping
            const responseValue = chunk.value || {};
            // Tool is successful only if BOTH error and errorType are undefined
            const isSuccess = !responseValue.error && !responseValue.errorType;
            const chunkData = {
              streamId,
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
            event.sender.send('geminiChat-stream-chunk', chunkData);
          } else {
            // Handle other event types
            const chunkData = {
              streamId,
              type: chunk.type,
              content: chunk.content || chunk.value || '',
              role: 'assistant',
              timestamp: Date.now(),
              ...chunk, // Include any additional properties
            };
            event.sender.send('geminiChat-stream-chunk', chunkData);

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
          type: 'complete',
          content: fullContent,
          role: 'assistant',
          timestamp: Date.now(),
        };

        event.sender.send('geminiChat-stream-complete', completionData);

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
          type: 'error',
          error: errorMessage,
          timestamp: Date.now(),
        };

        event.sender.send('geminiChat-stream-error', errorData);
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
          type: 'error',
          error: errorMessage,
          timestamp: Date.now(),
        };
        event.sender.send('geminiChat-stream-error', errorData);
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

    // Use AuthManager for unified OAuth status checking
    // const { AuthManager } = require('@google/gemini-cli-core')
    const authManager = AuthManager.getInstance();

    // Ensure system is initialized and pass config to AuthManager
    const system = await ensureInitialized();
    authManager.setConfig(system.getConfig());

    const status = await authManager.getAuthStatus(providerType);
    // console.log('OAuth status result:', status)

    return {
      authenticated: status.authenticated,
      userEmail: status.userEmail,
      type: status.authType,
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

    // Ensure system is initialized
    const system = await ensureInitialized();

    // Use AuthManager to set API key preference
    // const { AuthManager } = require('@google/gemini-cli-core')
    const authManager = AuthManager.getInstance();
    authManager.setConfig(system.getConfig());
    authManager.useApiKeyAuth(providerType);

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

    // Ensure system is initialized
    const system = await ensureInitialized();

    // Use AuthManager to set OAuth preference
    // const { AuthManager } = require('@google/gemini-cli-core')
    const authManager = AuthManager.getInstance();
    authManager.setConfig(system.getConfig());
    authManager.setAuthPreference(providerType, 'oauth');

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
ipcMain.handle('geminiChat-call-excel-tool', async (_, operation, params) => {
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
