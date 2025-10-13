/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import {
  Globe,
  Sun,
  Moon,
  Monitor,
  Brain,
  Settings,
  User,
  Key,
  CheckCircle,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { RoleSelector } from '@/components/chat/RoleSelector';
import { AuthSettingsModal } from '@/components/settings/AuthSettingsModal';
// Removed WorkspaceSelector import - now in Sidebar
import { useAppStore } from '@/stores/appStore';
import { useAuthStatus } from '@/hooks/useAuthStatus';

interface HeaderProps {
  isRightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  isRightSidebarOpen,
  onToggleRightSidebar,
}) => {
  const {
    currentProvider,
    currentModel,
    currentRole,
    language,
    theme,
    setTheme,
  } = useAppStore();

  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showRoleSelector, setShowRoleSelector] = useState(false);
  const [showAuthSettings, setShowAuthSettings] = useState(false);
  // Removed showWorkspaceSelector state - now in Sidebar

  // Get real-time auth status from backend
  const authStatus = useAuthStatus('gemini');

  const getProviderIcon = () => {
    switch (currentProvider) {
      case 'gemini':
        return <Brain size={16} className="text-blue-500" />;
      case 'openai':
        return <Brain size={16} className="text-green-500" />;
      case 'lm_studio':
        return <Brain size={16} className="text-purple-500" />;
      default:
        return <Brain size={16} />;
    }
  };

  const toggleTheme = () => {
    const themes = ['light', 'dark', 'system'] as const;
    const currentIndex = themes.indexOf(theme);
    const nextIndex = (currentIndex + 1) % themes.length;
    const newTheme = themes[nextIndex];

    // Prevent double calls by checking if theme is actually different
    if (newTheme !== theme) {
      setTheme(newTheme);
    }
  };

  const getThemeIcon = () => {
    switch (theme) {
      case 'light':
        return <Sun size={16} />;
      case 'dark':
        return <Moon size={16} />;
      case 'system':
        return <Monitor size={16} />;
      default:
        return <Sun size={16} />;
    }
  };

  return (
    <header className="sticky top-0 z-40 h-16 border-b border-border bg-card px-6 flex items-center justify-between">
      {/* Left Section - Model and Role Info */}
      <div className="flex items-center gap-4">
        <div className="relative">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 h-8 px-3"
            onClick={() => setShowModelSelector(true)}
          >
            {getProviderIcon()}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Model:</span>
              <span className="text-sm font-medium">{currentModel}</span>
            </div>
          </Button>
        </div>

        {showModelSelector && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              className="fixed inset-0 bg-black/50"
              onClick={() => setShowModelSelector(false)}
            />
            <div className="relative max-h-[80vh] overflow-auto">
              <ModelSelector onClose={() => setShowModelSelector(false)} />
            </div>
          </div>
        )}

        <div className="w-px h-6 bg-border" />

        <div className="relative">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 h-8 px-3"
            onClick={() => setShowRoleSelector(true)}
          >
            <User size={16} />
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Role:</span>
              <span className="text-sm">{currentRole.replace('_', ' ')}</span>
            </div>
          </Button>
        </div>

        {showRoleSelector && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              className="fixed inset-0 bg-black/50"
              onClick={() => setShowRoleSelector(false)}
            />
            <div className="relative max-h-[80vh] overflow-auto">
              <RoleSelector onClose={() => setShowRoleSelector(false)} />
            </div>
          </div>
        )}

        <div className="w-px h-6 bg-border" />

        {/* Workspace moved to Sidebar for better UX */}
      </div>

      {/* Right Section - Controls */}
      <div className="flex items-center gap-2">
        {/* Authentication Status Indicator */}
        {currentProvider === 'gemini' && (
          <button
            onClick={() => setShowAuthSettings(true)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs transition-colors ${
              authStatus.authenticated
                ? 'hover:bg-muted/50'
                : 'bg-red-500/10 hover:bg-red-500/20 border border-red-500/30'
            }`}
            title={
              authStatus.authenticated
                ? 'Click to change authentication method'
                : '⚠️ Authentication required - Click to configure'
            }
          >
            {authStatus.authenticated ? (
              <>
                <CheckCircle size={14} className="text-green-500" />
                <span className="text-green-600 font-medium">
                  {authStatus.type === 'oauth' ? 'OAuth' : 'API Key'}
                </span>
              </>
            ) : (
              <>
                <Key size={14} className="text-red-600" />
                <span className="text-red-600 font-medium">Auth Required</span>
                <span className="text-red-500/70 text-[10px]">
                  Click to Config
                </span>
              </>
            )}
          </button>
        )}

        {/* Auth Settings Modal */}
        <AuthSettingsModal
          open={showAuthSettings}
          onClose={() => setShowAuthSettings(false)}
        />

        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          className="h-8 w-8"
          title={`Current theme: ${theme} (click to cycle)`}
        >
          {getThemeIcon()}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title={`Language: ${language}`}
        >
          <Globe size={16} />
        </Button>

        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Settings size={16} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onToggleRightSidebar}
          title={`${isRightSidebarOpen ? 'Hide' : 'Show'} sidebar`}
        >
          {isRightSidebarOpen ? (
            <PanelRightClose size={16} />
          ) : (
            <PanelRightOpen size={16} />
          )}
        </Button>
      </div>
    </header>
  );
};
