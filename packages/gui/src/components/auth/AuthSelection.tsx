/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Key, Globe } from 'lucide-react';

interface AuthSelectionProps {
  onSelectAuth: (method: 'oauth' | 'apikey') => void;
  onSkip?: () => void;
}

export const AuthSelection: React.FC<AuthSelectionProps> = ({
  onSelectAuth,
  onSkip,
}) => {
  const [selectedMethod, setSelectedMethod] = useState<
    'oauth' | 'apikey' | null
  >(null);

  const handleConfirm = () => {
    if (selectedMethod) {
      onSelectAuth(selectedMethod);
    }
  };

  const handleSkip = () => {
    if (onSkip) {
      onSkip();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/50">
      <div className="max-w-2xl w-full">
        <div className="bg-card border border-border rounded-lg shadow-2xl p-8">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-foreground mb-2">
              Welcome to Gemini CLI
            </h2>
            <p className="text-sm text-muted-foreground">
              Please select your authentication method to get started
            </p>
          </div>

          <div className="space-y-4 mb-6">
            {/* OAuth Option */}
            <button
              onClick={() => setSelectedMethod('oauth')}
              className={`w-full p-6 border-2 rounded-lg transition-all ${
                selectedMethod === 'oauth'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50 hover:bg-muted/50'
              }`}
            >
              <div className="flex items-start gap-4">
                <div
                  className={`p-3 rounded-lg ${
                    selectedMethod === 'oauth'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Globe size={24} />
                </div>
                <div className="flex-1 text-left">
                  <h3 className="text-lg font-semibold text-foreground mb-1">
                    Google Account (OAuth)
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Sign in with your Google account. Best for personal use with
                    Gmail accounts.
                  </p>
                </div>
              </div>
            </button>

            {/* API Key Option */}
            <button
              onClick={() => setSelectedMethod('apikey')}
              className={`w-full p-6 border-2 rounded-lg transition-all ${
                selectedMethod === 'apikey'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50 hover:bg-muted/50'
              }`}
            >
              <div className="flex items-start gap-4">
                <div
                  className={`p-3 rounded-lg ${
                    selectedMethod === 'apikey'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Key size={24} />
                </div>
                <div className="flex-1 text-left">
                  <h3 className="text-lg font-semibold text-foreground mb-1">
                    API Key
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Use an API key from environment variables (GEMINI_API_KEY or
                    GOOGLE_API_KEY).
                  </p>
                </div>
              </div>
            </button>
          </div>

          <div className="flex justify-between gap-3">
            {onSkip && (
              <Button variant="ghost" onClick={handleSkip} className="px-6">
                Skip for now
              </Button>
            )}
            <div className="flex gap-3 ml-auto">
              <Button
                onClick={handleConfirm}
                disabled={!selectedMethod}
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
