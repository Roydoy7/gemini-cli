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
import { ModelProviderType } from '@/types';

interface AuthSettingsModalProps {
  open: boolean;
  onClose: () => void;
  defaultProvider?: ModelProviderType;
}

interface ProviderAuthInfo {
  type: ModelProviderType;
  name: string;
  icon: string;
  supportsOAuth: boolean;
  envVarName: string;
  apiKeyUrl?: string;
}

const PROVIDERS: ProviderAuthInfo[] = [
  {
    type: ModelProviderType.GEMINI,
    name: 'Google Gemini',
    icon: '🔷',
    supportsOAuth: true,
    envVarName: 'GEMINI_API_KEY',
    apiKeyUrl: 'https://makersuite.google.com/app/apikey',
  },
  {
    type: ModelProviderType.CLAUDE,
    name: 'Anthropic Claude',
    icon: '🟣',
    supportsOAuth: false,
    envVarName: 'ANTHROPIC_API_KEY',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    type: ModelProviderType.OPENAI,
    name: 'OpenAI',
    icon: '🟢',
    supportsOAuth: false,
    envVarName: 'OPENAI_API_KEY',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    type: ModelProviderType.LMSTUDIO,
    name: 'LM Studio',
    icon: '🖥️',
    supportsOAuth: false,
    envVarName: 'LMSTUDIO_BASE_URL',
  },
];

export const AuthSettingsModal: React.FC<AuthSettingsModalProps> = ({
  open,
  onClose,
  defaultProvider = ModelProviderType.GEMINI,
}) => {
  const { authConfig, updateAuthConfig } = useAppStore();
  const [selectedProvider, setSelectedProvider] =
    useState<ModelProviderType>(defaultProvider);
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

  const currentProvider = PROVIDERS.find((p) => p.type === selectedProvider);

  useEffect(() => {
    if (open) {
      loadCurrentSettings();
      if (currentProvider?.supportsOAuth) {
        checkOAuthStatus();
      }
      setMessage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedProvider]);

  const loadCurrentSettings = async () => {
    console.log(
      '[AuthSettingsModal] loadCurrentSettings: Loading settings for provider:',
      selectedProvider,
    );
    try {
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            unifiedChat?: {
              getAuthPreference: (
                providerType: string,
              ) => Promise<{ preference: 'api_key' | 'oauth' | null }>;
            };
          };
        }
      ).electronAPI;

      if (electronAPI?.unifiedChat) {
        const prefResult =
          await electronAPI.unifiedChat.getAuthPreference(selectedProvider);
        const backendPref = prefResult?.preference;

        console.log(
          '[AuthSettingsModal] loadCurrentSettings: Backend preference:',
          backendPref,
        );

        if (backendPref) {
          setAuthType(backendPref);
        } else {
          setAuthType('api_key');
        }
      } else {
        const providerConfig = authConfig[selectedProvider];
        if (providerConfig) {
          setAuthType(providerConfig.type || 'api_key');
        }
      }
    } catch (error) {
      console.error(
        '[AuthSettingsModal] Failed to load auth preference from backend:',
        error,
      );
      const providerConfig = authConfig[selectedProvider];
      if (providerConfig) {
        setAuthType(providerConfig.type || 'api_key');
      }
    }

    await checkEnvironmentApiKey();
  };

  const checkEnvironmentApiKey = async () => {
    try {
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            unifiedChat?: {
              checkEnvApiKey: (
                providerType: string,
              ) => Promise<{ detected: boolean; source?: string }>;
            };
          };
        }
      ).electronAPI;

      if (electronAPI?.unifiedChat) {
        const result =
          await electronAPI.unifiedChat.checkEnvApiKey(selectedProvider);
        setEnvApiKeyDetected(result.detected);
        console.log(
          `Environment API key check for ${selectedProvider}: ${result.detected ? 'detected' : 'not detected'} from ${result.source || 'unknown'}`,
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
        '[AuthSettingsModal] checkOAuthStatus: Checking OAuth status for:',
        selectedProvider,
      );
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            unifiedChat?: {
              getOAuthStatus: (
                providerType: string,
              ) => Promise<{ authenticated: boolean; userEmail?: string }>;
            };
          };
        }
      ).electronAPI;

      if (electronAPI?.unifiedChat) {
        const status =
          await electronAPI.unifiedChat.getOAuthStatus(selectedProvider);
        console.log(
          '[AuthSettingsModal] checkOAuthStatus: Received status:',
          JSON.stringify(status),
        );
        setOauthStatus(status);
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
      console.log('Starting OAuth flow for:', selectedProvider);
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            unifiedChat?: {
              startOAuthFlow: (providerType: string) => Promise<{
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

      if (!electronAPI?.unifiedChat) {
        throw new Error('Electron API not available');
      }

      const result =
        await electronAPI.unifiedChat.startOAuthFlow(selectedProvider);

      if (result.success) {
        console.log('Setting OAuth preference in backend...');
        await electronAPI.unifiedChat.setOAuthPreference(selectedProvider);

        updateAuthConfig({
          [selectedProvider]: {
            type: 'oauth',
            oauthToken: 'authenticated',
          },
        });

        await checkOAuthStatus();

        setMessage({
          type: 'success',
          text: result.message || 'Authentication successful!',
        });

        setTimeout(() => {
          handleClose();
        }, 1500);
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
        '[AuthSettingsModal] handleUseOAuth: Setting OAuth preference for:',
        selectedProvider,
      );
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            unifiedChat?: {
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

      if (!electronAPI?.unifiedChat) {
        throw new Error('Electron API not available');
      }

      await electronAPI.unifiedChat.setOAuthPreference(selectedProvider);

      const prefResult =
        await electronAPI.unifiedChat.getAuthPreference(selectedProvider);
      console.log(
        '[AuthSettingsModal] handleUseOAuth: Verified preference:',
        prefResult.preference,
      );

      if (prefResult.preference !== 'oauth') {
        throw new Error('Preference not saved correctly');
      }

      updateAuthConfig({
        [selectedProvider]: {
          type: 'oauth',
          oauthToken: 'authenticated',
        },
      });

      setMessage({
        type: 'success',
        text: 'Switched to OAuth authentication',
      });

      setTimeout(() => {
        handleClose();
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
        '[AuthSettingsModal] handleOAuthLogout: Signing out from:',
        selectedProvider,
      );
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            unifiedChat?: {
              clearOAuthCredentials: (
                providerType: string,
              ) => Promise<{ success: boolean; error?: string }>;
            };
          };
        }
      ).electronAPI;

      if (!electronAPI?.unifiedChat) {
        throw new Error('Electron API not available');
      }

      const result =
        await electronAPI.unifiedChat.clearOAuthCredentials(selectedProvider);

      if (result.success) {
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
        text: `No ${currentProvider?.envVarName} environment variable detected. Please set it and restart the application.`,
      });
      return;
    }

    try {
      console.log('Setting API key preference for:', selectedProvider);
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            unifiedChat?: {
              setApiKeyPreference: (
                providerType: string,
              ) => Promise<{ success: boolean }>;
            };
          };
        }
      ).electronAPI;

      if (!electronAPI?.unifiedChat) {
        throw new Error('Electron API not available');
      }

      await electronAPI.unifiedChat.setApiKeyPreference(selectedProvider);

      updateAuthConfig({
        [selectedProvider]: {
          type: 'api_key',
          oauthToken: undefined,
        },
      });

      setMessage({
        type: 'success',
        text: 'Switched to API key authentication',
      });

      setTimeout(() => {
        handleClose();
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
      '[AuthSettingsModal] handleAuthTypeChange: Changing to:',
      newType,
      'for provider:',
      selectedProvider,
    );
    setAuthType(newType);

    try {
      const electronAPI = (
        globalThis as {
          electronAPI?: {
            unifiedChat?: {
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

      if (!electronAPI?.unifiedChat) {
        throw new Error('Electron API not available');
      }

      if (newType === 'api_key') {
        await electronAPI.unifiedChat.setApiKeyPreference(selectedProvider);
      } else {
        await electronAPI.unifiedChat.setOAuthPreference(selectedProvider);
        await checkOAuthStatus();
      }
    } catch (error) {
      console.error(
        '[AuthSettingsModal] handleAuthTypeChange: Failed:',
        error,
      );
    }
  };

  const handleClose = () => {
    console.log(
      '[AuthSettingsModal] Closing modal, triggering auth-changed event',
    );
    window.dispatchEvent(new CustomEvent('auth-changed'));
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-card rounded-lg shadow-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold">Provider Authentication</h2>
          <Button variant="ghost" size="icon" onClick={handleClose}>
            <X size={20} />
          </Button>
        </div>

        {/* Provider Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {PROVIDERS.map((provider) => (
            <button
              key={provider.type}
              onClick={() => setSelectedProvider(provider.type)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors whitespace-nowrap ${
                selectedProvider === provider.type
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-accent hover:bg-accent/80'
              }`}
            >
              <span>{provider.icon}</span>
              <span className="text-sm font-medium">{provider.name}</span>
            </button>
          ))}
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

        {/* LM Studio - No Authentication Required */}
        {selectedProvider === ModelProviderType.LMSTUDIO ? (
          <Card className="p-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle size={20} />
                <span className="font-medium">No Authentication Required</span>
              </div>
              <p className="text-sm text-muted-foreground">
                LM Studio runs locally on your machine and doesn't require
                authentication.
              </p>
              <div className="p-3 bg-accent/30 rounded-md border">
                <div className="text-sm font-medium mb-2">
                  Optional: Custom Server URL
                </div>
                <div className="text-xs text-muted-foreground">
                  Default: <code className="bg-accent px-1 rounded">http://localhost:1234/v1</code>
                </div>
                {envApiKeyDetected && (
                  <div className="flex items-center text-green-600 mt-2">
                    <CheckCircle size={14} className="mr-1" />
                    <span className="text-xs">Custom LMSTUDIO_BASE_URL detected</span>
                  </div>
                )}
              </div>
            </div>
          </Card>
        ) : (
          <>
            {/* Authentication Method Selection */}
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm font-medium mb-3">
                  Authentication Method
                </label>
                <div className="space-y-3">
                  {/* API Key Option */}
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
                        Use your {currentProvider?.name} API key
                      </div>
                    </div>
                  </label>

                  {/* OAuth Option (only for Gemini) */}
                  {currentProvider?.supportsOAuth && (
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
                  )}
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
                            {currentProvider?.envVarName} environment variable
                            detected
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center text-amber-600">
                          <AlertTriangle size={16} className="mr-2" />
                          <span className="text-sm">
                            {currentProvider?.envVarName} environment variable
                            not found
                          </span>
                        </div>
                      )}
                    </div>

                    {!envApiKeyDetected && (
                      <div className="text-xs text-muted-foreground">
                        To use API key authentication, set the{' '}
                        <code className="bg-accent px-1 rounded">
                          {currentProvider?.envVarName}
                        </code>{' '}
                        environment variable with your API key
                        {currentProvider?.apiKeyUrl && (
                          <>
                            {' '}
                            from{' '}
                            <a
                              href={currentProvider.apiKeyUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {currentProvider.name} Dashboard
                            </a>
                          </>
                        )}{' '}
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
              {authType === 'oauth' && currentProvider?.supportsOAuth && (
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
                          Sign in with your Google account to access Gemini
                          API. This will open your browser for authentication.
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
          </>
        )}

        {/* Footer */}
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={handleClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
};
