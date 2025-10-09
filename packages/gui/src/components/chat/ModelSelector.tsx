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
import { geminiChatService } from '@/services/geminiChatService';
import { cn } from '@/utils/cn';
import { AuthSettingsModal } from '@/components/settings/AuthSettingsModal';
import { ModelProviderType } from '@/types';

interface ModelSelectorProps {
  onClose: () => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ onClose }) => {
  const { currentModel, setCurrentModel } = useAppStore();

  const [loading, setLoading] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Authentication states for Gemini
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [geminiAuthStatus, setGeminiAuthStatus] = useState<{
    authenticated: boolean;
    userEmail?: string;
    type?: 'oauth' | 'api_key' | 'none';
  }>({ authenticated: false });
  const [envApiKeyDetected, setEnvApiKeyDetected] = useState(false);

  // Check authentication status for Gemini
  const checkGeminiAuth = useCallback(async () => {
    try {
      console.log('[ModelSelector] Checking Gemini auth...');

      const status = await geminiChatService.getOAuthStatus('gemini');
      console.log('[ModelSelector] OAuth status:', status);
      setGeminiAuthStatus(status);

      // Also check for environment API key
      console.log('[ModelSelector] Checking environment API key...');
      const envResult = await geminiChatService.checkEnvApiKey('gemini');
      console.log(
        '[ModelSelector] Environment API key result:',
        JSON.stringify(envResult, null, 2),
      );
      setEnvApiKeyDetected(envResult.detected);
    } catch (error) {
      console.error('Failed to check Gemini auth:', error);
      setGeminiAuthStatus({ authenticated: false });
      setEnvApiKeyDetected(false);
    }
  }, []);

  // Load Gemini models
  const loadModels = useCallback(async () => {
    try {
      console.log('[ModelSelector] Loading Gemini models');
      const models = await geminiChatService.getAvailableModels(
        ModelProviderType.GEMINI,
      );
      const geminiModels = models.gemini || [];
      console.log('[ModelSelector] Loaded models:', geminiModels);
      setAvailableModels(geminiModels);
    } catch (error) {
      console.error('Failed to load models:', error);
      setAvailableModels([]);
    }
  }, []);

  // Initialize on mount
  useEffect(() => {
    checkGeminiAuth();
    loadModels();
  }, [checkGeminiAuth, loadModels]);

  const handleRefreshModels = async () => {
    await loadModels();
  };

  const handleModelSelect = async (model: string) => {
    if (model === currentModel) {
      onClose();
      return;
    }

    setLoading(true);
    try {
      await geminiChatService.switchProvider(ModelProviderType.GEMINI, model);
      setCurrentModel(model);
      onClose();
    } catch (error) {
      console.error('Failed to switch model:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Card className="w-[600px] shadow-lg">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="text-blue-500" size={20} />
              <h3 className="font-semibold">Select Gemini Model</h3>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              ×
            </Button>
          </div>
        </CardHeader>
        <CardContent className="min-h-[400px]">
          <div className="space-y-4">
            {/* Header with Auth and Refresh buttons */}
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-muted-foreground">
                Available Models
              </h4>
              <div className="flex items-center gap-1">
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
              {availableModels.length > 0 ? (
                availableModels.map((model) => (
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
                  {!geminiAuthStatus.authenticated && !envApiKeyDetected ? (
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
                        Click &quot;Refresh&quot; to load models or check
                        authentication
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
          await checkGeminiAuth();
          await loadModels();
        }}
      />
    </>
  );
};
