/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AuthSelection } from '@/components/auth/AuthSelection';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { geminiChatService } from '@/services/geminiChatService';
import type { ChatSession, ModelProviderType } from '@/types';

export const App: React.FC = () => {
  const { currentProvider, currentModel, currentRole, theme, isHydrated } =
    useAppStore();
  const { setBuiltinRoles, syncOAuthStatus } = useAppStore();
  const [authStatus, setAuthStatus] = useState<{
    checking: boolean;
    authenticated: boolean;
    needsSelection: boolean;
  }>({ checking: true, authenticated: false, needsSelection: false });

  const [isWaitingForOAuth, setIsWaitingForOAuth] = useState(false);

  // Listen for auth-changed events (triggered when user modifies auth settings)
  useEffect(() => {
    const handleAuthChanged = async () => {
      console.log(
        '[App] Auth changed event received, re-checking auth status...',
      );

      try {
        const electronAPI = (
          globalThis as {
            electronAPI?: {
              geminiChat?: {
                getAuthPreference: (
                  providerType: string,
                ) => Promise<{ preference: 'api_key' | 'oauth' | null }>;
                checkEnvApiKey: (
                  providerType: string,
                ) => Promise<{ detected: boolean }>;
                getOAuthStatus: (
                  providerType: string,
                ) => Promise<{ authenticated: boolean; userEmail?: string }>;
              };
            };
          }
        ).electronAPI;

        if (!electronAPI?.geminiChat) {
          return;
        }

        // Get current auth preference
        const prefResult =
          await electronAPI.geminiChat.getAuthPreference('gemini');
        const authPref = prefResult?.preference;

        // Check authentication based on preference
        let isAuthenticated = false;
        if (authPref === 'api_key') {
          const apiKeyResult =
            await electronAPI.geminiChat.checkEnvApiKey('gemini');
          isAuthenticated = apiKeyResult?.detected || false;
        } else if (authPref === 'oauth') {
          const oauthStatus =
            await electronAPI.geminiChat.getOAuthStatus('gemini');
          isAuthenticated = oauthStatus?.authenticated || false;
        }

        console.log('[App] Auth status after change:', {
          pref: authPref,
          authenticated: isAuthenticated,
        });

        setAuthStatus({
          checking: false,
          authenticated: isAuthenticated,
          needsSelection: false, // User explicitly changed auth, don't show selection
        });
      } catch (error) {
        console.error('[App] Failed to check auth after change:', error);
      }
    };

    window.addEventListener('auth-changed', handleAuthChanged);

    return () => {
      window.removeEventListener('auth-changed', handleAuthChanged);
    };
  }, []);

  // Monitor OAuth status when waiting for user to complete OAuth login
  useEffect(() => {
    if (!isWaitingForOAuth) {
      return;
    }

    console.log(
      '[App] Waiting for OAuth completion, starting status polling...',
    );

    const checkOAuthCompletion = async () => {
      try {
        const electronAPI = (
          globalThis as {
            electronAPI?: {
              geminiChat?: {
                getOAuthStatus: (
                  providerType: string,
                ) => Promise<{ authenticated: boolean; userEmail?: string }>;
              };
            };
          }
        ).electronAPI;

        if (!electronAPI?.geminiChat) {
          return;
        }

        const oauthStatus =
          await electronAPI.geminiChat.getOAuthStatus('gemini');
        console.log('[App] OAuth status check:', oauthStatus);

        if (oauthStatus?.authenticated) {
          console.log(
            '[App] OAuth completed successfully, closing auth selection dialog',
          );
          setIsWaitingForOAuth(false);
          setAuthStatus({
            checking: false,
            authenticated: true,
            needsSelection: false,
          });
        }
      } catch (error) {
        console.error('[App] Failed to check OAuth completion:', error);
      }
    };

    // Check immediately
    checkOAuthCompletion();

    // Then check every 2 seconds
    const interval = setInterval(checkOAuthCompletion, 2000);

    return () => {
      clearInterval(interval);
    };
  }, [isWaitingForOAuth]);

  // Check authentication status before initializing
  useEffect(() => {
    const checkAuthStatus = async () => {
      if (!isHydrated) {
        return;
      }

      try {
        // Wait for Electron API
        let retries = 0;
        const maxRetries = 10;

        interface ElectronGeminiAPI {
          checkEnvApiKey: (
            providerType: string,
          ) => Promise<{ detected: boolean }>;
          getOAuthStatus: (
            providerType: string,
          ) => Promise<{ authenticated: boolean; userEmail?: string }>;
          getAuthPreference: (
            providerType: string,
          ) => Promise<{ preference: 'api_key' | 'oauth' | null }>;
        }

        while (retries < maxRetries) {
          const electronAPI = (
            globalThis as { electronAPI?: { geminiChat?: ElectronGeminiAPI } }
          ).electronAPI;
          if (electronAPI?.geminiChat) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          retries++;
        }

        const electronAPI = (
          globalThis as { electronAPI?: { geminiChat?: ElectronGeminiAPI } }
        ).electronAPI;

        if (!electronAPI?.geminiChat) {
          console.warn('Electron API not available, showing auth selection');
          setAuthStatus({
            checking: false,
            authenticated: false,
            needsSelection: true,
          });
          return;
        }

        // Get user's auth preference from backend (source of truth)
        const prefResult =
          await electronAPI.geminiChat.getAuthPreference?.('gemini');
        const authPref = prefResult?.preference;
        console.log('User auth preference from backend:', authPref);

        // Sync backend preference to frontend store (backend is source of truth)
        if (authPref) {
          useAppStore.getState().updateAuthConfig({
            gemini: {
              type: authPref,
            },
          });
          console.log(
            'Synced backend auth preference to frontend store:',
            authPref,
          );
        }

        // Check authentication based on user preference
        if (authPref === 'api_key') {
          // User chose API key - verify it exists
          const apiKeyResult =
            await electronAPI.geminiChat.checkEnvApiKey('gemini');
          if (apiKeyResult?.detected) {
            console.log('User chose API key and it is available');
            setAuthStatus({
              checking: false,
              authenticated: true,
              needsSelection: false,
            });
            return;
          } else {
            console.log(
              'User chose API key but it is not available, showing auth selection',
            );
            setAuthStatus({
              checking: false,
              authenticated: false,
              needsSelection: true,
            });
            return;
          }
        } else if (authPref === 'oauth') {
          // User chose OAuth - verify they are logged in
          const oauthStatus =
            await electronAPI.geminiChat.getOAuthStatus('gemini');
          if (oauthStatus?.authenticated) {
            console.log(
              'User chose OAuth and is authenticated:',
              oauthStatus.userEmail,
            );
            setAuthStatus({
              checking: false,
              authenticated: true,
              needsSelection: false,
            });
            return;
          } else {
            console.log(
              'User chose OAuth but is not authenticated, showing auth selection',
            );
            setAuthStatus({
              checking: false,
              authenticated: false,
              needsSelection: true,
            });
            return;
          }
        } else {
          // No preference set - ALWAYS show auth selection, don't make decisions for the user
          console.log(
            'No auth preference set, showing auth selection to let user choose',
          );
          setAuthStatus({
            checking: false,
            authenticated: false,
            needsSelection: true,
          });
          return;
        }
      } catch (error) {
        console.error('Failed to check auth status:', error);
        // On error, show auth selection to be safe
        setAuthStatus({
          checking: false,
          authenticated: false,
          needsSelection: true,
        });
      }
    };

    checkAuthStatus();
  }, [isHydrated]);

  useEffect(() => {
    // Apply theme to document
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else if (theme === 'light') {
      root.classList.remove('dark');
    } else {
      // System theme
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', isDark);
    }
  }, [theme]);

  useEffect(() => {
    // Only initialize if authenticated (skip if user hasn't configured auth yet)
    if (
      authStatus.checking ||
      authStatus.needsSelection ||
      !authStatus.authenticated
    ) {
      return;
    }

    // Initialize GeminiChatService via Electron IPC
    const initializeService = async () => {
      // Wait for Electron API to be available
      let retries = 0;
      const maxRetries = 10;

      while (retries < maxRetries) {
        const electronAPI = (
          globalThis as {
            electronAPI?: { getWorkingDirectory: () => Promise<string> };
          }
        ).electronAPI;
        if (electronAPI) {
          break;
        }
        console.log(
          `Waiting for Electron API... attempt ${retries + 1}/${maxRetries}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        retries++;
      }

      try {
        // Get working directory via IPC instead of process.cwd()
        const electronAPI = (
          globalThis as {
            electronAPI?: { getWorkingDirectory: () => Promise<string> };
          }
        ).electronAPI;
        if (!electronAPI) {
          throw new Error('Electron API not available after waiting');
        }
        const workingDirectory = await electronAPI.getWorkingDirectory();
        console.log('Working directory:', workingDirectory);

        const configParams = {
          sessionId: `gui-session-${Date.now()}`,
          targetDir: workingDirectory,
          debugMode: false,
          model: currentModel,
          cwd: workingDirectory,
          interactive: true,
          telemetry: { enabled: false },
          approvalMode: 'default', // Require user confirmation for important tool calls
        };

        await geminiChatService.initialize(configParams, currentRole);

        // Set up tool confirmation callback with sessionId support
        geminiChatService.setConfirmationCallback(
          async (details, sessionId) =>
            new Promise((resolve) => {
              // CRITICAL: Set the confirmation request for the SPECIFIC SESSION
              // If sessionId is provided, route to that session; otherwise use current session
              if (sessionId) {
                useChatStore
                  .getState()
                  .setToolConfirmationForSession(sessionId, details);
              } else {
                useChatStore.getState().setToolConfirmation(details);
              }

              // Override the onConfirm to resolve our promise
              const originalOnConfirm = details.onConfirm;
              details.onConfirm = async (outcome, payload) => {
                // Clear the confirmation from the SPECIFIC SESSION
                if (sessionId) {
                  useChatStore
                    .getState()
                    .setToolConfirmationForSession(sessionId, null);
                } else {
                  useChatStore.getState().setToolConfirmation(null);
                }

                // Call original handler if it exists
                if (originalOnConfirm) {
                  await originalOnConfirm(outcome, payload);
                }

                // Resolve with the outcome
                resolve(outcome);
              };
            }),
        );

        // Load builtin roles after initialization
        try {
          const roles = await geminiChatService.getAllRolesAsync();
          if (roles.length > 0) {
            setBuiltinRoles(roles.filter((role) => role.isBuiltin !== false));
          }
        } catch (error) {
          console.error('Failed to load builtin roles:', error);
        }

        // Sync OAuth authentication status
        try {
          await syncOAuthStatus();
          console.log('OAuth status synchronized');
        } catch (error) {
          console.error('Failed to sync OAuth status:', error);
        }

        // Load sessions from backend (backend is the source of truth)
        try {
          const sessionsInfo = await geminiChatService.getSessionsInfo();
          // console.log('Retrieved sessions from backend:', sessionsInfo);

          // Convert backend session info to frontend session format
          const { setActiveSession } = useAppStore.getState();

          // Clear existing sessions and rebuild from backend
          useAppStore.setState({ sessions: [], activeSessionId: null });

          for (const sessionInfo of sessionsInfo) {
            // Create placeholder messages array based on messageCount
            const placeholderMessages = Array.from(
              { length: sessionInfo.messageCount },
              (_, index) => ({
                id: `${sessionInfo.id}-placeholder-${index}`,
                role: 'user' as const,
                content: '',
                timestamp: new Date(),
              }),
            );

            const session: ChatSession = {
              id: sessionInfo.id,
              title: sessionInfo.title,
              messages: placeholderMessages, // Show correct count but will be replaced when session is selected
              createdAt: sessionInfo.lastUpdated, // Using lastUpdated as approximation
              updatedAt: sessionInfo.lastUpdated,
              provider: currentProvider as ModelProviderType,
              model: currentModel,
              roleId: sessionInfo.roleId || currentRole, // Use session's roleId if available, fallback to current role
            };

            useAppStore.getState().addSession(session);
          }

          // Switch to the most recent session (first in sorted list) and load its messages
          if (sessionsInfo.length > 0) {
            const mostRecentSessionId = sessionsInfo[0].id;
            await geminiChatService.switchSession(mostRecentSessionId);
            await setActiveSession(mostRecentSessionId); // CRITICAL: await to sync sessionId
            console.log(
              'Switched to most recent session:',
              mostRecentSessionId,
            );

            // Load messages for the initial session
            try {
              const messages =
                await geminiChatService.getDisplayMessages(mostRecentSessionId);
              // console.log('Loaded', messages.length, 'messages for initial session:', mostRecentSessionId);

              // Convert and update the session with messages
              const { updateSession } = useAppStore.getState();
              const chatMessages = messages.map((msg, index) => ({
                id: `${mostRecentSessionId}-${index}`,
                role: msg.role as 'user' | 'assistant' | 'system' | 'tool', // Cast to allowed types
                content: msg.content,
                timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(), // Convert to Date object
                toolCalls: msg.toolCalls,
                tool_call_id: msg.tool_call_id, // Required for tool response messages
                name: msg.name, // Required for tool response messages
              }));

              updateSession(mostRecentSessionId, { messages: chatMessages });
            } catch (error) {
              console.error('Failed to load initial session messages:', error);
            }
          }
        } catch (error) {
          console.error('Failed to load sessions from backend:', error);
        }

        // Pre-load templates to ensure they're available when TemplatePanel mounts
        try {
          console.log('Pre-loading templates...');
          const templates = await geminiChatService.getAllTemplatesAsync();
          console.log('Pre-loaded', templates.length, 'templates successfully');
        } catch (error) {
          console.error('Failed to pre-load templates:', error);
        }

        // Mark initialization as complete
        useAppStore.getState().setInitialized(true);
        console.log('App initialization completed');
      } catch (error) {
        console.error('Failed to initialize GeminiChatService:', error);
      }
    };

    initializeService();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    authStatus.checking,
    authStatus.needsSelection,
    authStatus.authenticated,
    isHydrated,
    currentProvider,
    currentModel,
    // Note: currentRole is intentionally NOT in deps - role changes should not trigger re-initialization
    setBuiltinRoles,
    syncOAuthStatus,
  ]); // Re-run when auth status or hydration changes

  const handleAuthSelection = async (method: 'oauth' | 'apikey') => {
    try {
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: {
              setApiKeyPreference?: (
                providerType: string,
              ) => Promise<{ success: boolean }>;
              setOAuthPreference?: (
                providerType: string,
              ) => Promise<{ success: boolean }>;
              checkEnvApiKey: (
                providerType: string,
              ) => Promise<{ detected: boolean }>;
              getOAuthStatus: (
                providerType: string,
              ) => Promise<{ authenticated: boolean }>;
              startOAuthFlow?: (
                providerType: string,
              ) => Promise<{ success: boolean }>;
            };
          };
        }
      ).electronAPI;

      if (!electronAPI?.geminiChat) {
        console.error('Electron API not available');
        return;
      }

      if (method === 'apikey') {
        // Set API key preference
        await electronAPI.geminiChat.setApiKeyPreference?.('gemini');

        // Check if API key is actually available
        const apiKeyResult =
          await electronAPI.geminiChat.checkEnvApiKey('gemini');
        if (apiKeyResult?.detected) {
          console.log('API key preference set and API key detected');
          setAuthStatus({
            checking: false,
            authenticated: true,
            needsSelection: false,
          });
        } else {
          console.error(
            'API key preference set but no API key found in environment',
          );
          alert(
            'API key not found in environment. Please set GEMINI_API_KEY or GOOGLE_API_KEY environment variable.',
          );
          setAuthStatus({
            checking: false,
            authenticated: false,
            needsSelection: true,
          });
        }
      } else {
        // Set OAuth preference
        await electronAPI.geminiChat.setOAuthPreference?.('gemini');

        // Check if already authenticated
        const oauthStatus =
          await electronAPI.geminiChat.getOAuthStatus('gemini');
        if (oauthStatus?.authenticated) {
          console.log('OAuth preference set and already authenticated');
          setAuthStatus({
            checking: false,
            authenticated: true,
            needsSelection: false,
          });
        } else {
          // Not authenticated yet - start OAuth flow
          console.log('OAuth preference set, starting OAuth flow');

          // Start monitoring OAuth completion
          setIsWaitingForOAuth(true);

          // Start OAuth flow (this will open browser)
          // Don't await - let the polling handle completion detection
          electronAPI.geminiChat
            .startOAuthFlow?.('gemini')
            .then((result) => {
              console.log('[App] OAuth flow completed with result:', result);
              if (!result?.success) {
                console.error('OAuth flow failed');
                setIsWaitingForOAuth(false);
                setAuthStatus({
                  checking: false,
                  authenticated: false,
                  needsSelection: true,
                });
              }
              // If successful, the polling useEffect will detect it and close the dialog
            })
            .catch((error) => {
              console.error('OAuth flow error:', error);
              setIsWaitingForOAuth(false);
              setAuthStatus({
                checking: false,
                authenticated: false,
                needsSelection: true,
              });
            });
        }
      }
    } catch (error) {
      console.error('Failed to set auth preference:', error);
      setAuthStatus({
        checking: false,
        authenticated: false,
        needsSelection: true,
      });
    }
  };

  const handleSkipAuth = async () => {
    console.log('User skipped authentication, re-checking auth status...');

    try {
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: {
              getAuthPreference: (
                providerType: string,
              ) => Promise<{ preference: 'api_key' | 'oauth' | null }>;
              checkEnvApiKey: (
                providerType: string,
              ) => Promise<{ detected: boolean }>;
              getOAuthStatus: (
                providerType: string,
              ) => Promise<{ authenticated: boolean; userEmail?: string }>;
            };
          };
        }
      ).electronAPI;

      if (!electronAPI?.geminiChat) {
        setAuthStatus({
          checking: false,
          authenticated: false,
          needsSelection: false,
        });
        return;
      }

      // Get current auth preference
      const prefResult =
        await electronAPI.geminiChat.getAuthPreference('gemini');
      const authPref = prefResult?.preference;

      // Check authentication based on preference
      let isAuthenticated = false;
      if (authPref === 'api_key') {
        const apiKeyResult =
          await electronAPI.geminiChat.checkEnvApiKey('gemini');
        isAuthenticated = apiKeyResult?.detected || false;
      } else if (authPref === 'oauth') {
        const oauthStatus =
          await electronAPI.geminiChat.getOAuthStatus('gemini');
        isAuthenticated = oauthStatus?.authenticated || false;
      }

      console.log('[App] Auth status after skip:', {
        pref: authPref,
        authenticated: isAuthenticated,
      });

      setAuthStatus({
        checking: false,
        authenticated: isAuthenticated,
        needsSelection: false,
      });
    } catch (error) {
      console.error('[App] Failed to check auth after skip:', error);
      setAuthStatus({
        checking: false,
        authenticated: false,
        needsSelection: false,
      });
    }
  };

  // Always render AppLayout, show auth selection as modal overlay
  return (
    <>
      <AppLayout />
      {authStatus.needsSelection && (
        <AuthSelection
          onSelectAuth={handleAuthSelection}
          onSkip={handleSkipAuth}
        />
      )}
    </>
  );
};
