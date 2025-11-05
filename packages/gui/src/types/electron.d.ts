/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface McpServer {
  key: string;
  name: string;
  displayName: string;
  extensionName?: string;
  enabled: boolean;
  description?: string;
  transport: 'stdio' | 'sse' | 'http';
  connected?: boolean;
}

declare global {
  interface Window {
    electronAPI?: {
      getAppVersion: () => Promise<string>;
      getWorkingDirectory: () => Promise<string>;
      dialog: {
        showOpenDialog: (options: {
          properties?: string[];
          title?: string;
          filters?: Array<{ name: string; extensions: string[] }>;
        }) => Promise<{ canceled: boolean; filePaths: string[] }>;
      };
      fs: {
        readFileAsBase64: (filePath: string) => Promise<string>;
      };
      onWorkspaceDirectoriesChanged: (
        callback: (directories: string[]) => void,
      ) => () => void;
      unifiedChat: {
        // ... other methods
        [key: string]: unknown;
      };
    };
    electron?: {
      getMcpServers: () => Promise<McpServer[]>;
      setMcpServersEnabled: (updates: Record<string, boolean>) => Promise<void>;
      refreshMcpServers: () => Promise<void>;
    };
  }
}

export {};
