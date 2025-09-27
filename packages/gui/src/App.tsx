/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {useEffect} from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { multiModelService } from '@/services/multiModelService';
import type { ChatSession, ModelProviderType } from '@/types';

export const App: React.FC = () => {
  const { currentProvider, currentModel, currentRole, theme } = useAppStore();
  const { setBuiltinRoles, syncOAuthStatus } = useAppStore();

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
    // Initialize MultiModelService via Electron IPC
    const initializeService = async () => {
      // Wait for Electron API to be available
      let retries = 0;
      const maxRetries = 10;
      
      while (retries < maxRetries) {
        const electronAPI = (globalThis as { electronAPI?: { getWorkingDirectory: () => Promise<string> } }).electronAPI;
        if (electronAPI) {
          break;
        }
        console.log(`Waiting for Electron API... attempt ${retries + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, 100));
        retries++;
      }
      
      try {
        
        // Get working directory via IPC instead of process.cwd()
        const electronAPI = (globalThis as { electronAPI?: { getWorkingDirectory: () => Promise<string> } }).electronAPI;
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
          approvalMode: 'default'  // Require user confirmation for important tool calls
        };
        
        await multiModelService.initialize(configParams);
        
        // Set up tool confirmation callback
        multiModelService.setConfirmationCallback(async (details) => 
          new Promise((resolve) => {
            // Set the confirmation request in chat store
            useChatStore.getState().setToolConfirmation(details);
            
            // Override the onConfirm to resolve our promise
            const originalOnConfirm = details.onConfirm;
            details.onConfirm = async (outcome, payload) => {
              // Clear the confirmation from store
              useChatStore.getState().setToolConfirmation(null);
              
              // Call original handler if it exists
              if (originalOnConfirm) {
                await originalOnConfirm(outcome, payload);
              }
              
              // Resolve with the outcome
              resolve(outcome);
            };
          })
        );
        
        // Switch to the current provider and model after initialization
        await multiModelService.switchProvider(currentProvider, currentModel);
        
        // Switch to the current role after initialization
        await multiModelService.switchRole(currentRole);
        
        // Load builtin roles after initialization
        try {
          const roles = await multiModelService.getAllRolesAsync();
          if (roles.length > 0) {
            setBuiltinRoles(roles.filter(role => role.isBuiltin !== false));
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
          const sessionsInfo = await multiModelService.getSessionsInfo();
          // console.log('Retrieved sessions from backend:', sessionsInfo);
          
          // Convert backend session info to frontend session format
          const { setActiveSession } = useAppStore.getState();
          
          // Clear existing sessions and rebuild from backend
          useAppStore.setState({ sessions: [] });
          
          for (const sessionInfo of sessionsInfo) {
            // Create placeholder messages array based on messageCount
            const placeholderMessages = Array.from({ length: sessionInfo.messageCount }, (_, index) => ({
              id: `${sessionInfo.id}-placeholder-${index}`,
              role: 'user' as const,
              content: '',
              timestamp: new Date()
            }));
            
            const session: ChatSession = {
              id: sessionInfo.id,
              title: sessionInfo.title,
              messages: placeholderMessages, // Show correct count but will be replaced when session is selected
              createdAt: sessionInfo.lastUpdated, // Using lastUpdated as approximation
              updatedAt: sessionInfo.lastUpdated,
              provider: currentProvider as ModelProviderType,
              model: currentModel,
              roleId: currentRole
            };
            
            useAppStore.getState().addSession(session);
          }
          
          // Switch to the most recent session (first in sorted list) and load its messages
          if (sessionsInfo.length > 0) {
            const mostRecentSessionId = sessionsInfo[0].id;
            await multiModelService.switchSession(mostRecentSessionId);
            setActiveSession(mostRecentSessionId);
            console.log('Switched to most recent session:', mostRecentSessionId);
            
            // Load messages for the initial session
            try {
              const messages = await multiModelService.getDisplayMessages(mostRecentSessionId);
              // console.log('Loaded', messages.length, 'messages for initial session:', mostRecentSessionId);
              
              // Convert and update the session with messages
              const { updateSession } = useAppStore.getState();
              const chatMessages = messages
                .map((msg, index) => ({
                  id: `${mostRecentSessionId}-${index}`,
                  role: msg.role as 'user' | 'assistant' | 'system' | 'tool', // Cast to allowed types
                  content: msg.content,
                  timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(), // Convert to Date object
                  toolCalls: msg.toolCalls
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
          const templates = await multiModelService.getAllTemplatesAsync();
          console.log('Pre-loaded', templates.length, 'templates successfully');
        } catch (error) {
          console.error('Failed to pre-load templates:', error);
        }

        // Mark initialization as complete
        useAppStore.getState().setInitialized(true);
        console.log('App initialization completed');
        
      } catch (error) {
        console.error('Failed to initialize MultiModelService:', error);
      }
    };

    initializeService();
  }, []); // Only run once on mount

  return <AppLayout />;
};