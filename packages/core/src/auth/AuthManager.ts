/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthClient } from 'google-auth-library';
import { clearCachedCredentialFile } from '../code_assist/oauth2.js';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

export interface AuthProvider {
  id: string;
  name: string;
  supportsOAuth: boolean;
  supportsApiKey: boolean;
  envApiKeyName?: string; // Environment variable name for API key
}

export interface AuthStatus {
  authenticated: boolean;
  authType: 'oauth' | 'api_key' | 'none';
  userEmail?: string;
  expiresAt?: Date;
}

export interface AuthPreference {
  providerId: string;
  preferredAuthType: 'oauth' | 'api_key';
}

export interface AuthCredentials {
  accessToken?: string;
  apiKey?: string;
  refreshToken?: string;
  expiresAt?: Date;
}

interface CachedCredentials extends AuthCredentials {
  cachedAt: Date;
  validUntil: Date;
}

/**
 * Singleton class to manage authentication for all model providers
 * Supports both OAuth and API key authentication
 */
export class AuthManager {
  private static instance: AuthManager;
  private oauthClients: Map<string, AuthClient> = new Map();
  private authStatuses: Map<string, AuthStatus> = new Map();
  private authPreferences: Map<string, 'oauth' | 'api_key'> = new Map();
  private credentialsCache: Map<string, CachedCredentials> = new Map();
  private config?: Config;

  // Cache duration: 5 minutes to avoid excessive OAuth token validation
  private static readonly CACHE_DURATION_MS = 5 * 60 * 1000;

  // Storage path for auth preferences
  private static getAuthPreferencesPath(): string {
    return path.join(Storage.getGlobalGeminiDir(), 'auth-preferences.json');
  }

  // Supported providers configuration
  private static readonly PROVIDERS: Record<string, AuthProvider> = {
    gemini: {
      id: 'gemini',
      name: 'Google Gemini',
      supportsOAuth: true,
      supportsApiKey: true,
      envApiKeyName: 'GEMINI_API_KEY',
    },
    openai: {
      id: 'openai',
      name: 'OpenAI',
      supportsOAuth: false, // OpenAI doesn't use OAuth, only API keys
      supportsApiKey: true,
      envApiKeyName: 'OPENAI_API_KEY',
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic Claude',
      supportsOAuth: false, // Anthropic doesn't use OAuth, only API keys
      supportsApiKey: true,
      envApiKeyName: 'ANTHROPIC_API_KEY',
    },
    lm_studio: {
      id: 'lm_studio',
      name: 'LM Studio',
      supportsOAuth: false,
      supportsApiKey: false, // Local model, no auth needed
    },
  };

  private constructor() {
    console.log('[AuthManager] Constructor called - creating new instance');
    // Load saved auth preferences synchronously on initialization
    // This ensures preferences are available immediately
    this.loadAuthPreferencesSync();
  }

  static getInstance(): AuthManager {
    if (!AuthManager.instance) {
      console.log('[AuthManager] getInstance: Creating new singleton instance');
      AuthManager.instance = new AuthManager();
    } else {
      console.log(
        '[AuthManager] getInstance: Returning existing singleton instance',
      );
    }
    return AuthManager.instance;
  }

  /**
   * Load auth preferences from persistent storage (synchronous)
   * This ensures preferences are available immediately when AuthManager is created
   */
  private loadAuthPreferencesSync(): void {
    try {
      const preferencesPath = AuthManager.getAuthPreferencesPath();
      const data = readFileSync(preferencesPath, 'utf-8');
      const preferences = JSON.parse(data);

      // Convert plain object to Map
      this.authPreferences.clear();
      for (const [providerId, authType] of Object.entries(preferences)) {
        if (authType === 'oauth' || authType === 'api_key') {
          this.authPreferences.set(providerId, authType as 'oauth' | 'api_key');
        }
      }

      console.log(
        '[AuthManager] Loaded auth preferences:',
        Object.fromEntries(this.authPreferences),
      );
    } catch (_error) {
      // File doesn't exist or is corrupted - start with empty preferences
      console.log(
        '[AuthManager] No saved auth preferences found, starting fresh',
      );
    }
  }

  /**
   * Save auth preferences to persistent storage
   */
  private async saveAuthPreferences(): Promise<void> {
    try {
      const preferencesPath = AuthManager.getAuthPreferencesPath();
      const globalDir = Storage.getGlobalGeminiDir();

      // Ensure the directory exists
      await fs.mkdir(globalDir, { recursive: true });

      // Convert Map to plain object for JSON serialization
      const preferences = Object.fromEntries(this.authPreferences);
      await fs.writeFile(
        preferencesPath,
        JSON.stringify(preferences, null, 2),
        'utf-8',
      );

      console.log('[AuthManager] Saved auth preferences:', preferences);
    } catch (error) {
      console.error('[AuthManager] Failed to save auth preferences:', error);
    }
  }

  /**
   * Initialize the AuthManager with a config instance
   */
  setConfig(config: Config): void {
    this.config = config;
  }

  /**
   * Get list of supported providers
   */
  getSupportedProviders(): AuthProvider[] {
    return Object.values(AuthManager.PROVIDERS);
  }

  /**
   * Check if a provider is supported
   */
  isProviderSupported(providerId: string): boolean {
    return providerId in AuthManager.PROVIDERS;
  }

  /**
   * Get provider configuration
   */
  getProvider(providerId: string): AuthProvider | null {
    return AuthManager.PROVIDERS[providerId] || null;
  }

  /**
   * Set user's preferred authentication type for a provider
   * Changed to async to ensure preferences are saved before returning
   */
  async setAuthPreference(
    providerId: string,
    authType: 'oauth' | 'api_key',
  ): Promise<void> {
    const provider = this.getProvider(providerId);
    if (!provider) {
      throw new Error(`Unsupported provider: ${providerId}`);
    }

    if (authType === 'oauth' && !provider.supportsOAuth) {
      throw new Error(`Provider ${provider.name} does not support OAuth`);
    }

    if (authType === 'api_key' && !provider.supportsApiKey) {
      throw new Error(
        `Provider ${provider.name} does not support API key authentication`,
      );
    }

    this.authPreferences.set(providerId, authType);

    // IMPORTANT: Clear cached auth status when preference changes
    // This forces getAuthStatus() to re-check authentication with the new preference
    this.authStatuses.delete(providerId);
    console.log(
      `[AuthManager] setAuthPreference: Cleared cached auth status for ${providerId}`,
    );

    // IMPORTANT: Wait for preferences to be saved to disk before returning
    // This ensures the preference is persisted even if the app is closed immediately after
    await this.saveAuthPreferences();
  }

  /**
   * Get user's preferred authentication type for a provider
   */
  getAuthPreference(providerId: string): 'oauth' | 'api_key' | null {
    const storedPreference = this.authPreferences.get(providerId);
    console.log(`[AuthManager] getAuthPreference(${providerId}):`, {
      storedPreference,
      mapSize: this.authPreferences.size,
      allPreferences: Object.fromEntries(this.authPreferences),
    });

    if (storedPreference) {
      console.log(
        `[AuthManager] getAuthPreference(${providerId}): Returning stored preference:`,
        storedPreference,
      );
      return storedPreference;
    }

    // Provide default values for known providers
    const provider = this.getProvider(providerId);
    if (!provider) {
      console.log(
        `[AuthManager] getAuthPreference(${providerId}): Unknown provider, returning null`,
      );
      return null;
    }

    // Default preferences based on provider capabilities
    let defaultPref: 'oauth' | 'api_key' | null;
    switch (providerId) {
      case 'gemini':
        defaultPref = provider.supportsOAuth
          ? 'oauth'
          : provider.supportsApiKey
            ? 'api_key'
            : null;
        console.log(
          `[AuthManager] getAuthPreference(${providerId}): No stored preference, returning default:`,
          defaultPref,
        );
        return defaultPref;
      case 'openai':
      case 'anthropic':
        defaultPref = provider.supportsApiKey ? 'api_key' : null;
        console.log(
          `[AuthManager] getAuthPreference(${providerId}): No stored preference, returning default:`,
          defaultPref,
        );
        return defaultPref;
      default:
        // For other providers, default to API key if supported, otherwise OAuth
        if (provider.supportsApiKey) {
          defaultPref = 'api_key';
        } else if (provider.supportsOAuth) {
          defaultPref = 'oauth';
        } else {
          defaultPref = null;
        }
        console.log(
          `[AuthManager] getAuthPreference(${providerId}): No stored preference, returning default:`,
          defaultPref,
        );
        return defaultPref;
    }
  }

  /**
   * Start OAuth flow for a provider (if supported)
   */
  async startOAuthFlow(
    providerId: string,
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    const provider = this.getProvider(providerId);
    if (!provider) {
      return { success: false, error: `Unsupported provider: ${providerId}` };
    }

    if (!provider.supportsOAuth) {
      return {
        success: false,
        error: `Provider ${provider.name} does not support OAuth`,
      };
    }

    try {
      if (providerId === 'gemini') {
        const oauthClient = await this.getGeminiOAuthClient();
        const { token } = await oauthClient.getAccessToken();

        if (token) {
          // Store OAuth client for future use
          this.oauthClients.set(providerId, oauthClient);

          // Update auth status
          const userInfo = await this.fetchGeminiUserInfo(token);
          this.authStatuses.set(providerId, {
            authenticated: true,
            authType: 'oauth',
            userEmail: userInfo?.email,
          });

          // Set user preference to OAuth
          await this.setAuthPreference(providerId, 'oauth');

          return { success: true, message: 'OAuth authentication successful' };
        }
      }

      // TODO: Add support for other OAuth providers (OpenAI, Anthropic, etc.)

      return { success: false, error: 'OAuth flow failed' };
    } catch (error) {
      console.error(`OAuth flow failed for ${providerId}:`, error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'OAuth authentication failed',
      };
    }
  }

  /**
   * Get authentication status for a provider
   */
  async getAuthStatus(providerId: string): Promise<AuthStatus> {
    const provider = this.getProvider(providerId);
    if (!provider) {
      return { authenticated: false, authType: 'none' };
    }

    // Check cached status first
    const cachedStatus = this.authStatuses.get(providerId);
    if (cachedStatus) {
      // Verify OAuth token is still valid
      if (cachedStatus.authType === 'oauth' && providerId === 'gemini') {
        const isValid = await this.verifyGeminiOAuthToken(providerId);
        if (!isValid) {
          this.authStatuses.delete(providerId);
          this.oauthClients.delete(providerId);
          return { authenticated: false, authType: 'none' };
        }
      }
      return cachedStatus;
    }

    // Check authentication status based on user's preferred method
    const preferredAuthType = this.getAuthPreference(providerId);

    if (preferredAuthType === 'oauth') {
      // User chose OAuth - only check OAuth status
      if (provider.supportsOAuth && providerId === 'gemini') {
        const oauthStatus = await this.checkGeminiOAuthStatus();
        this.authStatuses.set(providerId, oauthStatus);
        return oauthStatus;
      }
      return { authenticated: false, authType: 'none' };
    } else if (preferredAuthType === 'api_key') {
      // User chose API key - only check API key status
      if (provider.supportsApiKey && provider.envApiKeyName) {
        const hasApiKey = await this.checkEnvApiKey(providerId);
        const status: AuthStatus = {
          authenticated: hasApiKey.detected,
          authType: hasApiKey.detected ? 'api_key' : 'none',
        };
        this.authStatuses.set(providerId, status);
        return status;
      }
      return { authenticated: false, authType: 'none' };
    }

    // User hasn't chosen an authentication method
    return { authenticated: false, authType: 'none' };
  }

  /**
   * Check if cached credentials are still valid
   */
  private isCacheValid(cached: CachedCredentials): boolean {
    const now = new Date();
    return now < cached.validUntil;
  }

  /**
   * Get cached credentials if valid and matches current auth preference
   */
  private getCachedCredentials(providerId: string): AuthCredentials | null {
    const cached = this.credentialsCache.get(providerId);
    if (!cached || !this.isCacheValid(cached)) {
      // Remove invalid cache entry
      if (cached) {
        this.credentialsCache.delete(providerId);
      }
      return null;
    }

    // Check if cached credentials match current auth preference
    const currentAuthType = this.getAuthPreference(providerId);
    const cachedAuthType = cached.accessToken
      ? 'oauth'
      : cached.apiKey
        ? 'api_key'
        : null;

    if (currentAuthType !== cachedAuthType) {
      // Auth preference changed, invalidate cache
      this.credentialsCache.delete(providerId);
      return null;
    }

    return {
      accessToken: cached.accessToken,
      apiKey: cached.apiKey,
      refreshToken: cached.refreshToken,
      expiresAt: cached.expiresAt,
    };
  }

  /**
   * Cache credentials with expiration
   */
  private setCachedCredentials(
    providerId: string,
    credentials: AuthCredentials,
  ): void {
    const now = new Date();
    const cachedCredentials: CachedCredentials = {
      ...credentials,
      cachedAt: now,
      validUntil: new Date(now.getTime() + AuthManager.CACHE_DURATION_MS),
    };

    this.credentialsCache.set(providerId, cachedCredentials);
  }

  /**
   * Get access credentials for API calls based on user's preferred authentication type
   * This is the unified interface that providers should use
   */
  async getAccessCredentials(
    providerId: string,
  ): Promise<AuthCredentials | null> {
    const provider = this.getProvider(providerId);
    if (!provider) {
      return null;
    }

    // Check cache first to avoid repeated OAuth validation
    const cachedCredentials = this.getCachedCredentials(providerId);
    if (cachedCredentials) {
      return cachedCredentials;
    }

    // Get user's preferred authentication type
    const preferredAuthType = this.getAuthPreference(providerId);
    if (!preferredAuthType) {
      return null; // User hasn't chosen an authentication method
    }

    let credentials: AuthCredentials | null = null;

    if (preferredAuthType === 'oauth') {
      // User chose OAuth - only return OAuth credentials
      if (!provider.supportsOAuth) {
        throw new Error(`Provider ${provider.name} does not support OAuth`);
      }

      const oauthClient = this.oauthClients.get(providerId);
      if (!oauthClient) {
        return null; // OAuth not set up
      }

      try {
        const { token } = await oauthClient.getAccessToken();
        credentials = token ? { accessToken: token } : null;
      } catch (error) {
        console.error(`Failed to get OAuth token for ${providerId}:`, error);
        return null; // OAuth token invalid/expired
      }
    } else if (preferredAuthType === 'api_key') {
      // User chose API key - only return API key credentials
      if (!provider.supportsApiKey || !provider.envApiKeyName) {
        throw new Error(
          `Provider ${provider.name} does not support API key authentication`,
        );
      }

      const apiKey = process.env[provider.envApiKeyName];
      credentials = apiKey ? { apiKey } : null;
    }

    // Cache valid credentials
    if (credentials) {
      this.setCachedCredentials(providerId, credentials);
    }

    return credentials;
  }

  /**
   * Set user preference to use API key authentication
   */
  async useApiKeyAuth(providerId: string): Promise<void> {
    await this.setAuthPreference(providerId, 'api_key');

    // Update auth status if API key is available
    const provider = this.getProvider(providerId);
    if (provider?.envApiKeyName && process.env[provider.envApiKeyName]) {
      this.authStatuses.set(providerId, {
        authenticated: true,
        authType: 'api_key',
      });
    }
  }

  /**
   * Initialize default API key authentication ONLY for providers that only support API keys
   * DO NOT automatically set preferences based on environment variables - respect user choice
   */
  async initializeDefaultApiKeyAuth(): Promise<void> {
    // For providers that only support API key (like OpenAI currently), set default preference
    const apiKeyOnlyProviders = Object.entries(AuthManager.PROVIDERS)
      .filter(
        ([, provider]) => !provider.supportsOAuth && provider.supportsApiKey,
      )
      .map(([id]) => id);

    for (const providerId of apiKeyOnlyProviders) {
      if (!this.getAuthPreference(providerId)) {
        await this.useApiKeyAuth(providerId);
      }
    }

    // DO NOT automatically set preferences based on environment variable detection
    // Let users explicitly choose their preferred authentication method via UI
    // This respects user choice instead of making automatic decisions
  }

  /**
   * Clear authentication for a provider
   */
  async clearCredentials(
    providerId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[AuthManager] clearCredentials called for ${providerId}`);

      // Clear OAuth client, status, and credentials cache
      this.oauthClients.delete(providerId);
      this.authStatuses.delete(providerId);
      this.credentialsCache.delete(providerId);

      console.log(
        '[AuthManager] Cleared in-memory caches (oauthClients, authStatuses, credentialsCache)',
      );

      if (providerId === 'gemini') {
        // Clear cached OAuth credentials from disk
        console.log('[AuthManager] Clearing OAuth credentials from disk...');
        await clearCachedCredentialFile();
        console.log('[AuthManager] OAuth credentials cleared from disk');
      }

      console.log('[AuthManager] clearCredentials completed successfully');
      return { success: true };
    } catch (error) {
      console.error(
        `[AuthManager] Failed to clear credentials for ${providerId}:`,
        error,
      );
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to clear credentials',
      };
    }
  }

  /**
   * Check if environment API key exists for a provider
   */
  async checkEnvApiKey(
    providerId: string,
  ): Promise<{ detected: boolean; source: string }> {
    const provider = this.getProvider(providerId);
    if (!provider || !provider.envApiKeyName) {
      return { detected: false, source: 'not_supported' };
    }

    const apiKey = process.env[provider.envApiKeyName];
    const detected = !!(apiKey && apiKey.trim());

    return {
      detected,
      source: provider.envApiKeyName,
    };
  }

  // Private helper methods for Gemini OAuth
  private async getGeminiOAuthClient(): Promise<AuthClient> {
    if (!this.config) {
      // Create minimal config for OAuth
      const { Config } = await import('../config/config.js');
      const configParams = {
        sessionId: 'oauth-session',
        targetDir: process.cwd(),
        debugMode: false,
        cwd: process.cwd(),
        model: 'gemini-2.5-flash',
      };
      this.config = new Config(configParams);
      await this.config.initialize();
    }

    const { getOauthClient } = await import('../code_assist/oauth2.js');
    const { AuthType } = await import('../core/contentGenerator.js');
    return await getOauthClient(AuthType.LOGIN_WITH_GOOGLE, this.config);
  }

  private async checkGeminiOAuthStatus(): Promise<AuthStatus> {
    try {
      console.log(
        '[AuthManager] checkGeminiOAuthStatus: Checking cached credentials...',
      );
      // IMPORTANT: Only check cached credentials, DO NOT trigger browser login
      // This method is called during app initialization to check auth status

      // Try to load cached credentials from disk
      const credPath = Storage.getOAuthCredsPath();
      console.log(
        '[AuthManager] checkGeminiOAuthStatus: Reading credentials from',
        credPath,
      );
      const credData = await fs.readFile(credPath, 'utf-8');
      const credentials = JSON.parse(credData);

      console.log(
        '[AuthManager] checkGeminiOAuthStatus: Credentials found, verifying...',
      );

      if (
        credentials &&
        (credentials.access_token || credentials.refresh_token)
      ) {
        // Credentials exist - create OAuth client and verify
        const { OAuth2Client } = await import('google-auth-library');
        const client = new OAuth2Client({
          clientId:
            '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
          clientSecret: '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',
        });
        client.setCredentials(credentials);

        // Try to get access token - this may refresh if needed but won't trigger browser
        const { token } = await client.getAccessToken();

        if (token) {
          console.log(
            '[AuthManager] checkGeminiOAuthStatus: OAuth token verified successfully',
          );
          this.oauthClients.set('gemini', client);
          const userInfo = await this.fetchGeminiUserInfo(token);

          return {
            authenticated: true,
            authType: 'oauth',
            userEmail: userInfo?.email,
          };
        }
      }
    } catch (error) {
      // Credentials file doesn't exist or is invalid - user is not authenticated
      console.log(
        '[AuthManager] checkGeminiOAuthStatus: No valid credentials found:',
        error,
      );
    }

    console.log(
      '[AuthManager] checkGeminiOAuthStatus: Returning unauthenticated status',
    );
    return { authenticated: false, authType: 'none' };
  }

  private async verifyGeminiOAuthToken(providerId: string): Promise<boolean> {
    try {
      const oauthClient = this.oauthClients.get(providerId);
      if (!oauthClient) {
        return false;
      }

      const { token } = await oauthClient.getAccessToken();
      return !!token;
    } catch (error) {
      console.log('Error verifying Gemini OAuth token:', error);
      return false;
    }
  }

  private async fetchGeminiUserInfo(
    token: string,
  ): Promise<{ email: string } | null> {
    try {
      const response = await fetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      console.log('Failed to fetch user info:', error);
    }

    return null;
  }
}
