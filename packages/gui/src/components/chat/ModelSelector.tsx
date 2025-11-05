/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { Check, Bot, RefreshCw, Shield } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { useAppStore } from '@/stores/appStore';
import { unifiedChatService } from '@/services/unifiedChatService';
import { cn } from '@/utils/cn';
import { AuthSettingsModal } from '@/components/settings/AuthSettingsModal';
import { ModelProviderType } from '@/types';

interface ModelSelectorProps {
  onClose: () => void;
}

interface ProviderInfo {
  type: ModelProviderType;
  name: string;
  icon: string;
  requiresAuth: boolean;
  supportsOAuth: boolean;
}

const PROVIDERS: ProviderInfo[] = [
  {
    type: ModelProviderType.GEMINI,
    name: 'Google Gemini',
    icon: '🔷',
    requiresAuth: true,
    supportsOAuth: true,
  },
  {
    type: ModelProviderType.CLAUDE,
    name: 'Anthropic Claude',
    icon: '🟣',
    requiresAuth: true,
    supportsOAuth: false,
  },
  {
    type: ModelProviderType.OPENAI,
    name: 'OpenAI',
    icon: '🟢',
    requiresAuth: true,
    supportsOAuth: false,
  },
  {
    type: ModelProviderType.LMSTUDIO,
    name: 'LM Studio',
    icon: '🖥️',
    requiresAuth: false,
    supportsOAuth: false,
  },
];

export const ModelSelector: React.FC<ModelSelectorProps> = ({ onClose }) => {
  const { currentModel, setCurrentModel, setCurrentProvider } = useAppStore();

  const [loading, setLoading] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ModelProviderType>(
    ModelProviderType.GEMINI,
  );
  const [availableModels, setAvailableModels] = useState<
    Record<ModelProviderType, string[]>
  >({
    [ModelProviderType.GEMINI]: [],
    [ModelProviderType.CLAUDE]: [],
    [ModelProviderType.OPENAI]: [],
    [ModelProviderType.LMSTUDIO]: [],
  });

  // Authentication states
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authStatuses, setAuthStatuses] = useState<
    Record<
      ModelProviderType,
      {
        authenticated: boolean;
        userEmail?: string;
        type?: 'oauth' | 'api_key' | 'none';
      }
    >
  >({
    [ModelProviderType.GEMINI]: { authenticated: false },
    [ModelProviderType.CLAUDE]: { authenticated: false },
    [ModelProviderType.OPENAI]: { authenticated: false },
    [ModelProviderType.LMSTUDIO]: { authenticated: true }, // LM Studio doesn't require auth
  });

  // Check authentication status for a provider
  const checkProviderAuth = useCallback(
    async (provider: ModelProviderType) => {
      try {
        console.log(`[ModelSelector] Checking ${provider} auth...`);

        // LM Studio doesn't require authentication
        if (provider === ModelProviderType.LMSTUDIO) {
          setAuthStatuses((prev) => ({
            ...prev,
            [provider]: { authenticated: true, type: 'none' },
          }));
          return;
        }

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

        let authPref: 'api_key' | 'oauth' | null = null;
        if (electronAPI?.unifiedChat) {
          const prefResult =
            await electronAPI.unifiedChat.getAuthPreference(provider);
          authPref = prefResult?.preference || null;
          console.log(
            `[ModelSelector] ${provider} auth preference:`,
            authPref,
          );
        }

        const providerInfo = PROVIDERS.find((p) => p.type === provider);

        if (authPref === 'api_key' || !providerInfo?.supportsOAuth) {
          // Check API key
          const envResult = await unifiedChatService.checkEnvApiKey(provider);
          console.log(`[ModelSelector] ${provider} API key check:`, envResult);
          setAuthStatuses((prev) => ({
            ...prev,
            [provider]: {
              authenticated: envResult.detected,
              type: 'api_key',
            },
          }));
        } else if (authPref === 'oauth' && providerInfo?.supportsOAuth) {
          // Check OAuth (only for Gemini)
          const status = await unifiedChatService.getOAuthStatus(provider);
          console.log(`[ModelSelector] ${provider} OAuth status:`, status);
          setAuthStatuses((prev) => ({
            ...prev,
            [provider]: { ...status, type: 'oauth' },
          }));
        } else {
          // No preference - check both if OAuth is supported
          const envResult = await unifiedChatService.checkEnvApiKey(provider);

          if (envResult.detected) {
            setAuthStatuses((prev) => ({
              ...prev,
              [provider]: { authenticated: true, type: 'api_key' },
            }));
          } else if (providerInfo?.supportsOAuth) {
            const oauthStatus =
              await unifiedChatService.getOAuthStatus(provider);
            if (oauthStatus.authenticated) {
              setAuthStatuses((prev) => ({
                ...prev,
                [provider]: { ...oauthStatus, type: 'oauth' },
              }));
            } else {
              setAuthStatuses((prev) => ({
                ...prev,
                [provider]: { authenticated: false, type: 'none' },
              }));
            }
          } else {
            setAuthStatuses((prev) => ({
              ...prev,
              [provider]: { authenticated: false, type: 'none' },
            }));
          }
        }
      } catch (error) {
        console.error(`Failed to check ${provider} auth:`, error);
        setAuthStatuses((prev) => ({
          ...prev,
          [provider]: { authenticated: false },
        }));
      }
    },
    [],
  );

  // Load models for a specific provider
  const loadProviderModels = useCallback(
    async (provider: ModelProviderType) => {
      try {
        console.log(`[ModelSelector] Loading ${provider} models`);
        const models = await unifiedChatService.getAvailableModels(provider);
        console.log(`[ModelSelector] Loaded ${provider} models:`, models);
        setAvailableModels((prev) => ({
          ...prev,
          [provider]: models || [],
        }));
      } catch (error) {
        console.error(`Failed to load ${provider} models:`, error);
        setAvailableModels((prev) => ({
          ...prev,
          [provider]: [],
        }));
      }
    },
    [],
  );

  // Initialize on mount - check all providers
  useEffect(() => {
    PROVIDERS.forEach((provider) => {
      checkProviderAuth(provider.type);
      loadProviderModels(provider.type);
    });
  }, [checkProviderAuth, loadProviderModels]);

  const handleRefreshModels = async () => {
    await loadProviderModels(selectedProvider);
  };

  const handleModelSelect = async (model: string) => {
    if (model === currentModel) {
      onClose();
      return;
    }

    setLoading(true);
    try {
      // Get current session ID
      const sessionId = await unifiedChatService.getCurrentSessionId();
      if (!sessionId) {
        console.error('No active session found');
        return;
      }

      // Switch provider for this session
      await unifiedChatService.switchProvider(
        sessionId,
        selectedProvider,
        model,
      );

      // Update global provider and model state
      setCurrentProvider(selectedProvider);
      setCurrentModel(model);
      onClose();
    } catch (error) {
      console.error('Failed to switch model:', error);
    } finally {
      setLoading(false);
    }
  };

  const currentProviderInfo = PROVIDERS.find(
    (p) => p.type === selectedProvider,
  );
  const currentAuthStatus = authStatuses[selectedProvider];
  const currentModels = availableModels[selectedProvider];

  return (
    <>
      <Card className="w-[700px] shadow-lg">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="text-blue-500" size={20} />
              <h3 className="font-semibold">Select Model Provider & Model</h3>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              ×
            </Button>
          </div>
        </CardHeader>
        <CardContent className="min-h-[400px]">
          <div className="space-y-4">
            {/* Provider Tabs */}
            <div className="flex gap-2 border-b pb-2">
              {PROVIDERS.map((provider) => (
                <Button
                  key={provider.type}
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5',
                    selectedProvider === provider.type &&
                      'bg-accent border-b-2 border-primary',
                  )}
                  onClick={() => setSelectedProvider(provider.type)}
                >
                  <span className="text-base">{provider.icon}</span>
                  <span className="text-sm font-medium">{provider.name}</span>
                  {authStatuses[provider.type]?.authenticated && (
                    <div
                      className="w-2 h-2 rounded-full bg-green-500"
                      title="Authenticated"
                    />
                  )}
                </Button>
              ))}
            </div>

            {/* Header with Auth and Refresh buttons */}
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-muted-foreground">
                Available Models
              </h4>
              <div className="flex items-center gap-1">
                {currentProviderInfo?.requiresAuth && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAuthModal(true)}
                    className="h-6 px-2"
                    title="Authentication Settings"
                  >
                    <Shield size={12} />
                    <span className="ml-1 text-xs">Auth</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRefreshModels}
                  disabled={loading}
                  className="h-6 px-2"
                >
                  <RefreshCw
                    size={12}
                    className={cn(loading && 'animate-spin')}
                  />
                  <span className="ml-1 text-xs">Refresh</span>
                </Button>
              </div>
            </div>

            {/* Models List */}
            <div className="space-y-1 max-h-[350px] overflow-y-auto pr-2">
              {currentModels.length > 0 ? (
                currentModels.map((model) => (
                  <Button
                    key={model}
                    variant="ghost"
                    className={cn(
                      'w-full justify-between h-auto p-3 text-left',
                      currentModel === model &&
                        'bg-accent border border-primary',
                    )}
                    onClick={() => handleModelSelect(model)}
                    disabled={loading}
                  >
                    <span className="font-mono text-sm flex-1 truncate">
                      {model}
                    </span>
                    {currentModel === model && (
                      <Check
                        size={14}
                        className="text-primary flex-shrink-0 ml-2"
                      />
                    )}
                  </Button>
                ))
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  <Bot size={24} className="mx-auto mb-2 opacity-50" />
                  {!currentAuthStatus.authenticated &&
                  currentProviderInfo?.requiresAuth ? (
                    <>
                      Authentication required to load models
                      <br />
                      <span className="text-xs">
                        Click the &quot;Auth&quot; button above to configure
                        authentication
                      </span>
                    </>
                  ) : (
                    <>
                      No models loaded
                      <br />
                      <span className="text-xs">
                        Click &quot;Refresh&quot; to load models
                        {currentProviderInfo?.requiresAuth &&
                          ' or check authentication'}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Auth Settings Modal */}
      <AuthSettingsModal
        open={showAuthModal}
        onClose={async () => {
          setShowAuthModal(false);
          // Refresh authentication status and reload models when modal closes
          await checkProviderAuth(selectedProvider);
          await loadProviderModels(selectedProvider);
        }}
      />
    </>
  );
};
