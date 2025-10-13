/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAppStore } from '@/stores/appStore';
import { X, Key, User, CheckCircle, AlertTriangle } from 'lucide-react';

interface AuthSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const AuthSettingsModal: React.FC<AuthSettingsModalProps> = ({
  open,
  onClose,
}) => {
  const { authConfig, updateAuthConfig } = useAppStore();
  const [authType, setAuthType] = useState<'oauth' | 'api_key'>('api_key');
  const [envApiKeyDetected, setEnvApiKeyDetected] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<{
    authenticated: boolean;
    userEmail?: string;
  }>({
    authenticated: false,
  });
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (open) {
      loadCurrentSettings();
      checkOAuthStatus();
      setMessage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadCurrentSettings = async () => {
    console.log('[AuthSettingsModal] loadCurrentSettings: Loading settings...');
    // Get auth preference from backend (source of truth)
    try {
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: {
              getAuthPreference: (
                providerType: string,
              ) => Promise<{ preference: 'api_key' | 'oauth' | null }>;
            };
          };
        }
      ).electronAPI;

      if (electronAPI?.geminiChat) {
        const prefResult =
          await electronAPI.geminiChat.getAuthPreference('gemini');
        const backendPref = prefResult?.preference;

        console.log(
          '[AuthSettingsModal] loadCurrentSettings: Backend preference:',
          backendPref,
        );

        if (backendPref) {
          setAuthType(backendPref);
          console.log(
            '[AuthSettingsModal] loadCurrentSettings: Set auth type to:',
            backendPref,
          );
        } else {
          setAuthType('api_key'); // Default to API key if no preference
          console.log(
            '[AuthSettingsModal] loadCurrentSettings: No preference found, defaulting to api_key',
          );
        }
      } else {
        // Fallback to store value if backend not available
        const geminiConfig = authConfig.gemini;
        if (geminiConfig) {
          setAuthType(geminiConfig.type || 'api_key');
        }
      }
    } catch (error) {
      console.error(
        '[AuthSettingsModal] Failed to load auth preference from backend:',
        error,
      );
      // Fallback to store value
      const geminiConfig = authConfig.gemini;
      if (geminiConfig) {
        setAuthType(geminiConfig.type || 'api_key');
      }
    }

    // Check if GEMINI_API_KEY environment variable is set
    await checkEnvironmentApiKey();
  };

  const checkEnvironmentApiKey = async () => {
    try {
      // Use Electron API directly instead of geminiChatService to avoid initialization dependency
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: {
              checkEnvApiKey: (
                providerType: string,
              ) => Promise<{ detected: boolean; source?: string }>;
            };
          };
        }
      ).electronAPI;

      if (electronAPI?.geminiChat) {
        const result = await electronAPI.geminiChat.checkEnvApiKey('gemini');
        setEnvApiKeyDetected(result.detected);
        console.log(
          `Environment API key check: ${result.detected ? 'detected' : 'not detected'} from ${result.source || 'unknown'}`,
        );
      } else {
        console.error('Electron API not available');
        setEnvApiKeyDetected(false);
      }
    } catch (error) {
      console.error('Failed to check environment API key:', error);
      setEnvApiKeyDetected(false);
    }
  };

  const checkOAuthStatus = async () => {
    try {
      console.log(
        '[AuthSettingsModal] checkOAuthStatus: Checking OAuth status...',
      );
      // Use Electron API directly instead of geminiChatService to avoid initialization dependency
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

      if (electronAPI?.geminiChat) {
        const status = await electronAPI.geminiChat.getOAuthStatus('gemini');
        console.log(
          '[AuthSettingsModal] checkOAuthStatus: Received status:',
          JSON.stringify(status),
        );
        setOauthStatus(status);
        console.log(
          '[AuthSettingsModal] checkOAuthStatus: Set oauthStatus.authenticated =',
          status.authenticated,
        );
      } else {
        console.error('[AuthSettingsModal] Electron API not available');
        setOauthStatus({ authenticated: false });
      }
    } catch (error) {
      console.error('[AuthSettingsModal] Failed to check OAuth status:', error);
      setOauthStatus({ authenticated: false });
    }
  };

  const handleOAuthLogin = async () => {
    setIsAuthenticating(true);
    setMessage(null);

    try {
      // Use Electron API directly to start OAuth flow
      console.log('Starting OAuth flow...');
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: {
              startOAuthFlow: (
                providerType: string,
              ) => Promise<{
                success: boolean;
                message?: string;
                error?: string;
              }>;
              setOAuthPreference: (
                providerType: string,
              ) => Promise<{ success: boolean }>;
            };
          };
        }
      ).electronAPI;

      if (!electronAPI?.geminiChat) {
        throw new Error('Electron API not available');
      }

      const result = await electronAPI.geminiChat.startOAuthFlow('gemini');

      if (result.success) {
        // Set backend OAuth preference explicitly
        console.log('Setting OAuth preference in backend...');
        await electronAPI.geminiChat.setOAuthPreference('gemini');

        // Update configuration to use OAuth
        updateAuthConfig({
          gemini: {
            type: 'oauth',
            oauthToken: 'authenticated', // We don't store the actual token in frontend
          },
        });

        // Refresh OAuth status
        await checkOAuthStatus();

        setMessage({
          type: 'success',
          text: result.message || 'Authentication successful!',
        });

        // Auto-close modal after successful authentication
        setTimeout(() => {
          onClose();
        }, 1500); // Give user time to see the success message
      } else {
        throw new Error(result.error || 'OAuth authentication failed');
      }
    } catch (error) {
      console.error('OAuth authentication error:', error);
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Authentication failed',
      });
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleUseOAuth = async () => {
    try {
      console.log(
        '[AuthSettingsModal] handleUseOAuth: Setting OAuth preference in backend...',
      );
      // Use Electron API directly to set OAuth preference
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: {
              setOAuthPreference: (
                providerType: string,
              ) => Promise<{ success: boolean }>;
              getAuthPreference: (
                providerType: string,
              ) => Promise<{ preference: 'api_key' | 'oauth' | null }>;
            };
          };
        }
      ).electronAPI;

      if (!electronAPI?.geminiChat) {
        throw new Error('Electron API not available');
      }

      console.log(
        '[AuthSettingsModal] handleUseOAuth: Calling setOAuthPreference...',
      );
      await electronAPI.geminiChat.setOAuthPreference('gemini');

      // Verify the preference was saved
      const prefResult =
        await electronAPI.geminiChat.getAuthPreference('gemini');
      console.log(
        '[AuthSettingsModal] handleUseOAuth: Verified preference after save:',
        prefResult.preference,
      );

      if (prefResult.preference !== 'oauth') {
        throw new Error(
          `Preference not saved correctly. Expected 'oauth', got '${prefResult.preference}'`,
        );
      }

      // Update configuration to use OAuth
      updateAuthConfig({
        gemini: {
          type: 'oauth',
          oauthToken: 'authenticated',
        },
      });

      setMessage({
        type: 'success',
        text: 'Switched to OAuth authentication',
      });

      // Auto-close modal after successful switch
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
      console.error('[AuthSettingsModal] handleUseOAuth failed:', error);
      setMessage({
        type: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'Failed to switch to OAuth authentication',
      });
    }
  };

  const handleOAuthLogout = async () => {
    try {
      console.log(
        '[AuthSettingsModal] handleOAuthLogout: Starting sign out...',
      );
      // Use Electron API directly to clear OAuth credentials
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: {
              clearOAuthCredentials: (
                providerType: string,
              ) => Promise<{ success: boolean; error?: string }>;
            };
          };
        }
      ).electronAPI;

      if (!electronAPI?.geminiChat) {
        throw new Error('Electron API not available');
      }

      console.log(
        '[AuthSettingsModal] handleOAuthLogout: Calling clearOAuthCredentials...',
      );
      const result =
        await electronAPI.geminiChat.clearOAuthCredentials('gemini');
      console.log('[AuthSettingsModal] handleOAuthLogout: Result:', result);

      if (result.success) {
        // Don't change the auth preference - user still wants to use OAuth, they're just signing out
        // The auth preference should remain as 'oauth', just in an unauthenticated state
        console.log(
          '[AuthSettingsModal] handleOAuthLogout: Credentials cleared, refreshing status...',
        );

        // Immediately refresh OAuth status from backend to confirm credentials are cleared
        await checkOAuthStatus();

        setMessage({
          type: 'success',
          text: 'Signed out successfully',
        });
      } else {
        throw new Error(result.error || 'Failed to sign out');
      }
    } catch (error) {
      console.error('[AuthSettingsModal] handleOAuthLogout failed:', error);
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to sign out',
      });
    }
  };

  const handleSwitchToApiKey = async () => {
    if (!envApiKeyDetected) {
      setMessage({
        type: 'error',
        text: 'No GEMINI_API_KEY environment variable detected. Please set the environment variable and restart the application.',
      });
      return;
    }

    try {
      // Use Electron API directly to set API key preference
      console.log('Setting API key preference in backend...');
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: {
              setApiKeyPreference: (
                providerType: string,
              ) => Promise<{ success: boolean }>;
            };
          };
        }
      ).electronAPI;

      if (!electronAPI?.geminiChat) {
        throw new Error('Electron API not available');
      }

      await electronAPI.geminiChat.setApiKeyPreference('gemini');

      updateAuthConfig({
        gemini: {
          type: 'api_key',
          oauthToken: undefined,
        },
      });

      setMessage({
        type: 'success',
        text: 'Switched to API key authentication',
      });

      // Auto-close modal after successful switch
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
      console.error('Failed to set API key preference:', error);
      setMessage({
        type: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'Failed to switch to API key authentication',
      });
    }
  };

  const handleAuthTypeChange = async (newType: 'api_key' | 'oauth') => {
    console.log(
      '[AuthSettingsModal] handleAuthTypeChange: Changing auth type to:',
      newType,
    );
    setAuthType(newType);

    // Immediately save the preference to backend
    try {
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            geminiChat?: {
              setApiKeyPreference: (
                providerType: string,
              ) => Promise<{ success: boolean }>;
              setOAuthPreference: (
                providerType: string,
              ) => Promise<{ success: boolean }>;
            };
          };
        }
      ).electronAPI;

      if (!electronAPI?.geminiChat) {
        throw new Error('Electron API not available');
      }

      if (newType === 'api_key') {
        console.log(
          '[AuthSettingsModal] handleAuthTypeChange: Saving API key preference...',
        );
        await electronAPI.geminiChat.setApiKeyPreference('gemini');
      } else {
        console.log(
          '[AuthSettingsModal] handleAuthTypeChange: Saving OAuth preference...',
        );
        await electronAPI.geminiChat.setOAuthPreference('gemini');

        // After switching to OAuth, refresh OAuth status to check if user is already logged in
        console.log(
          '[AuthSettingsModal] handleAuthTypeChange: Refreshing OAuth status...',
        );
        await checkOAuthStatus();
      }

      console.log(
        '[AuthSettingsModal] handleAuthTypeChange: Preference saved successfully',
      );
    } catch (error) {
      console.error(
        '[AuthSettingsModal] handleAuthTypeChange: Failed to save preference:',
        error,
      );
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-lg shadow-lg p-6 max-w-md w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold">
            Google Gemini Authentication
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X size={20} />
          </Button>
        </div>

        {/* Message */}
        {message && (
          <div
            className={`flex items-center gap-2 p-3 rounded-md mb-4 ${
              message.type === 'success'
                ? 'bg-green-50 text-green-800 border border-green-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}
          >
            {message.type === 'success' ? (
              <CheckCircle size={16} />
            ) : (
              <AlertTriangle size={16} />
            )}
            <span className="text-sm">{message.text}</span>
          </div>
        )}

        {/* Authentication Method Selection */}
        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-medium mb-3">
              Authentication Method
            </label>
            <div className="space-y-3">
              <label className="flex items-center p-3 border rounded-md cursor-pointer hover:bg-accent/50 transition-colors">
                <input
                  type="radio"
                  value="api_key"
                  checked={authType === 'api_key'}
                  onChange={(e) =>
                    handleAuthTypeChange(e.target.value as 'api_key')
                  }
                  className="mr-3"
                />
                <Key size={16} className="mr-2 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium">API Key</div>
                  <div className="text-xs text-muted-foreground">
                    Use your Gemini API key
                  </div>
                </div>
              </label>

              <label className="flex items-center p-3 border rounded-md cursor-pointer hover:bg-accent/50 transition-colors">
                <input
                  type="radio"
                  value="oauth"
                  checked={authType === 'oauth'}
                  onChange={(e) =>
                    handleAuthTypeChange(e.target.value as 'oauth')
                  }
                  className="mr-3"
                />
                <User size={16} className="mr-2 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium">
                    Google OAuth (Recommended)
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Sign in with your Google account
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* API Key Configuration */}
          {authType === 'api_key' && (
            <Card className="p-4">
              <div className="space-y-3">
                <label className="block text-sm font-medium">
                  Environment API Key
                </label>
                <div className="p-3 bg-accent/30 rounded-md border">
                  {envApiKeyDetected ? (
                    <div className="flex items-center text-green-600">
                      <CheckCircle size={16} className="mr-2" />
                      <span className="text-sm">
                        GEMINI_API_KEY environment variable detected
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center text-amber-600">
                      <AlertTriangle size={16} className="mr-2" />
                      <span className="text-sm">
                        GEMINI_API_KEY environment variable not found
                      </span>
                    </div>
                  )}
                </div>

                {!envApiKeyDetected && (
                  <div className="text-xs text-muted-foreground">
                    To use API key authentication, set the{' '}
                    <code className="bg-accent px-1 rounded">
                      GEMINI_API_KEY
                    </code>{' '}
                    environment variable with your API key from{' '}
                    <a
                      href="https://makersuite.google.com/app/apikey"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      Google AI Studio
                    </a>{' '}
                    and restart the application.
                  </div>
                )}

                <Button
                  onClick={handleSwitchToApiKey}
                  disabled={!envApiKeyDetected}
                  className="w-full"
                >
                  {envApiKeyDetected
                    ? 'Use API Key Authentication'
                    : 'API Key Not Available'}
                </Button>
              </div>
            </Card>
          )}

          {/* OAuth Configuration */}
          {authType === 'oauth' && (
            <Card className="p-4">
              <div className="space-y-4">
                {oauthStatus.authenticated ? (
                  <div className="text-sm">
                    <div className="flex items-center text-green-600 mb-2">
                      <CheckCircle size={16} className="mr-2" />
                      Authenticated
                    </div>
                    {oauthStatus.userEmail && (
                      <div className="text-muted-foreground mb-4">
                        Signed in as:{' '}
                        <span className="font-medium">
                          {oauthStatus.userEmail}
                        </span>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Button onClick={handleUseOAuth} className="w-full">
                        Use OAuth Authentication
                      </Button>
                      <Button
                        onClick={handleOAuthLogout}
                        variant="outline"
                        className="w-full"
                      >
                        Sign Out
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Sign in with your Google account to access Gemini API.
                      This will open your browser for authentication.
                    </p>
                    <Button
                      onClick={handleOAuthLogin}
                      disabled={isAuthenticating}
                      className="w-full"
                    >
                      {isAuthenticating
                        ? 'Authenticating...'
                        : 'Sign in with Google'}
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
};
