/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';

interface AuthStatus {
  type: 'oauth' | 'api_key' | 'none';
  authenticated: boolean;
}

/**
 * Hook to get real-time authentication status from backend AuthManager
 */
export function useAuthStatus(providerType: string): AuthStatus {
  const [authStatus, setAuthStatus] = useState<AuthStatus>({
    type: 'none',
    authenticated: false,
  });

  useEffect(() => {
    const checkAuthStatus = async () => {
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
                ) => Promise<{ authenticated: boolean }>;
              };
            };
          }
        ).electronAPI;

        if (!electronAPI?.geminiChat) {
          return;
        }

        // Get auth preference from backend
        const prefResult =
          await electronAPI.geminiChat.getAuthPreference(providerType);
        const authPref = prefResult?.preference;

        if (authPref === 'api_key') {
          // Check if API key exists
          const apiKeyResult =
            await electronAPI.geminiChat.checkEnvApiKey(providerType);
          setAuthStatus({
            type: 'api_key',
            authenticated: apiKeyResult?.detected || false,
          });
        } else if (authPref === 'oauth') {
          // Check if OAuth is authenticated
          const oauthStatus =
            await electronAPI.geminiChat.getOAuthStatus(providerType);
          setAuthStatus({
            type: 'oauth',
            authenticated: oauthStatus?.authenticated || false,
          });
        } else {
          // No preference - check what's available
          const apiKeyResult =
            await electronAPI.geminiChat.checkEnvApiKey(providerType);
          const oauthStatus =
            await electronAPI.geminiChat.getOAuthStatus(providerType);

          if (apiKeyResult?.detected) {
            setAuthStatus({
              type: 'api_key',
              authenticated: true,
            });
          } else if (oauthStatus?.authenticated) {
            setAuthStatus({
              type: 'oauth',
              authenticated: true,
            });
          } else {
            setAuthStatus({
              type: 'none',
              authenticated: false,
            });
          }
        }
      } catch (error) {
        console.error('Failed to check auth status:', error);
        setAuthStatus({
          type: 'none',
          authenticated: false,
        });
      }
    };

    checkAuthStatus();

    // Re-check every 5 seconds to keep status updated
    const interval = setInterval(checkAuthStatus, 5000);

    return () => clearInterval(interval);
  }, [providerType]);

  return authStatus;
}
