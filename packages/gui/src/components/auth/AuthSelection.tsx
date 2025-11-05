/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Key, Globe, CheckCircle } from 'lucide-react';
import { ModelProviderType } from '@/types';

interface AuthSelectionProps {
  onSelectAuth: (provider: ModelProviderType, method: 'oauth' | 'apikey') => void;
  onSkip?: () => void;
}

interface ProviderOption {
  type: ModelProviderType;
  name: string;
  icon: string;
  supportsOAuth: boolean;
  description: string;
  envVarNames: string[];
}

const PROVIDERS: ProviderOption[] = [
  {
    type: ModelProviderType.GEMINI,
    name: 'Google Gemini',
    icon: '🔷',
    supportsOAuth: true,
    description: 'Google\'s most capable AI model',
    envVarNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  {
    type: ModelProviderType.CLAUDE,
    name: 'Anthropic Claude',
    icon: '🟣',
    supportsOAuth: false,
    description: 'Anthropic\'s advanced language model',
    envVarNames: ['ANTHROPIC_API_KEY'],
  },
  {
    type: ModelProviderType.OPENAI,
    name: 'OpenAI',
    icon: '🟢',
    supportsOAuth: false,
    description: 'GPT models from OpenAI',
    envVarNames: ['OPENAI_API_KEY'],
  },
  {
    type: ModelProviderType.LMSTUDIO,
    name: 'LM Studio',
    icon: '🖥️',
    supportsOAuth: false,
    description: 'Local models via LM Studio',
    envVarNames: [],
  },
];

export const AuthSelection: React.FC<AuthSelectionProps> = ({
  onSelectAuth,
  onSkip,
}) => {
  const [selectedProvider, setSelectedProvider] = useState<ModelProviderType | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<'oauth' | 'apikey' | null>(null);

  const currentProvider = PROVIDERS.find((p) => p.type === selectedProvider);

  const handleProviderSelect = (provider: ModelProviderType) => {
    setSelectedProvider(provider);
    // Auto-select method based on provider capabilities
    const providerInfo = PROVIDERS.find((p) => p.type === provider);
    if (providerInfo) {
      if (provider === ModelProviderType.LMSTUDIO) {
        // LM Studio doesn't need auth, auto-select apikey as placeholder
        setSelectedMethod('apikey');
      } else if (providerInfo.supportsOAuth) {
        // Default to OAuth for Gemini
        setSelectedMethod('oauth');
      } else {
        // Only API key available
        setSelectedMethod('apikey');
      }
    }
  };

  const handleConfirm = () => {
    if (selectedProvider && selectedMethod) {
      onSelectAuth(selectedProvider, selectedMethod);
    }
  };

  const handleSkip = () => {
    if (onSkip) {
      onSkip();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/50 backdrop-blur-sm">
      <div className="max-w-3xl w-full">
        <div className="bg-card border border-border rounded-lg shadow-2xl p-8">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-foreground mb-2">
              Welcome to Multi-LLM Chat
            </h2>
            <p className="text-sm text-muted-foreground">
              Select your preferred AI provider to get started
            </p>
          </div>

          {/* Step 1: Provider Selection */}
          <div className="mb-6">
            <h3 className="text-sm font-medium text-foreground mb-3">
              Step 1: Choose Provider
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {PROVIDERS.map((provider) => (
                <button
                  key={provider.type}
                  onClick={() => handleProviderSelect(provider.type)}
                  className={`p-4 border-2 rounded-lg transition-all text-left ${
                    selectedProvider === provider.type
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/50 hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{provider.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-semibold text-foreground">
                          {provider.name}
                        </h4>
                        {selectedProvider === provider.type && (
                          <CheckCircle size={16} className="text-primary flex-shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {provider.description}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Step 2: Authentication Method */}
          {selectedProvider && (
            <div className="mb-6">
              <h3 className="text-sm font-medium text-foreground mb-3">
                Step 2: Authentication Method
              </h3>

              {selectedProvider === ModelProviderType.LMSTUDIO ? (
                // LM Studio - No auth required
                <div className="p-4 border-2 border-green-500/50 bg-green-500/5 rounded-lg">
                  <div className="flex items-start gap-3">
                    <CheckCircle size={24} className="text-green-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-semibold text-foreground mb-1">
                        No Authentication Required
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        LM Studio runs locally on your machine. No API key or sign-in needed.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* OAuth Option - Only for Gemini */}
                  {currentProvider?.supportsOAuth && (
                    <button
                      onClick={() => setSelectedMethod('oauth')}
                      className={`w-full p-4 border-2 rounded-lg transition-all ${
                        selectedMethod === 'oauth'
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50 hover:bg-muted/50'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={`p-2 rounded-lg ${
                            selectedMethod === 'oauth'
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          <Globe size={20} />
                        </div>
                        <div className="flex-1 text-left">
                          <div className="flex items-center gap-2 mb-1">
                            <h4 className="font-semibold text-foreground">
                              Google Account (OAuth)
                            </h4>
                            {selectedMethod === 'oauth' && (
                              <CheckCircle size={16} className="text-primary" />
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground">
                            Sign in with your Google account. Recommended for personal use.
                          </p>
                        </div>
                      </div>
                    </button>
                  )}

                  {/* API Key Option */}
                  <button
                    onClick={() => setSelectedMethod('apikey')}
                    className={`w-full p-4 border-2 rounded-lg transition-all ${
                      selectedMethod === 'apikey'
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50 hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`p-2 rounded-lg ${
                          selectedMethod === 'apikey'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        <Key size={20} />
                      </div>
                      <div className="flex-1 text-left">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-semibold text-foreground">
                            API Key
                          </h4>
                          {selectedMethod === 'apikey' && (
                            <CheckCircle size={16} className="text-primary" />
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Use an API key from environment variables
                          {currentProvider && currentProvider.envVarNames.length > 0 && (
                            <>
                              {' ('}
                              {currentProvider.envVarNames.map((name, index) => (
                                <span key={name}>
                                  {index > 0 && ' or '}
                                  <code className="bg-muted px-1 rounded text-xs">
                                    {name}
                                  </code>
                                </span>
                              ))}
                              {')'}
                            </>
                          )}
                          .
                        </p>
                      </div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex justify-between gap-3 pt-4 border-t border-border">
            {onSkip && (
              <Button variant="ghost" onClick={handleSkip} className="px-6">
                Skip for now
              </Button>
            )}
            <div className="flex gap-3 ml-auto">
              <Button
                onClick={handleConfirm}
                disabled={!selectedProvider || !selectedMethod}
                className="px-6"
              >
                Continue
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
