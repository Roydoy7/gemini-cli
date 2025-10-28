/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
      geminiChat: {
        // ... other methods
        [key: string]: unknown;
      };
    };
  }
}

export {};
