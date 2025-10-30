/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, Content } from '@google/genai';
import type { Config } from '../config/config.js';
import os from 'node:os';
// import { getFolderStructure } from './getFolderStructure.js';

/**
 * Generates a string describing the current workspace directories and their structures.
 * @param {Config} config - The runtime configuration and services.
 * @returns {Promise<string>} A promise that resolves to the directory context string.
 */
export async function getDirectoryContextString(
  config: Config,
): Promise<string> {
  const workspaceContext = config.getWorkspaceContext();
  const workspaceDirectories = workspaceContext.getDirectories();

  // const folderStructures = await Promise.all(
  //   workspaceDirectories.map((dir) =>
  //     getFolderStructure(dir, {
  //       fileService: config.getFileService(),
  //     }),
  //   ),
  // );

  // const folderStructure = folderStructures.join('\n');

  let workingDirPreamble: string;
  if (workspaceDirectories.length === 1) {
    workingDirPreamble = `My current workspace is:\n<workspace>\n${workspaceDirectories[0]}\n</workspace>\n`;
  } else {
    const dirList = workspaceDirectories.map((dir) => `  - ${dir}`).join('\n');
    workingDirPreamble = `My current workspaces are:\n<workspace>\n${dirList}\n</workspace>\n`;
  }

  //Here is the folder structure of the current working directories:
  // ${folderStructure}

  return `${workingDirPreamble}`;
}

/**
 * Retrieves environment-related information to be included in the chat context.
 * This includes the current working directory, date, operating system, and folder structure.
 * Optionally, it can also include the full file context if enabled.
 * @param {Config} config - The runtime configuration and services.
 * @returns A promise that resolves to an array of `Part` objects containing environment information.
 */
export async function getEnvironmentContext(config: Config): Promise<Part[]> {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const platform = process.platform;
  const directoryContext = await getDirectoryContextString(config);

  // Get detailed system information
  const osType = os.type();
  const osRelease = os.release();
  const osArch = os.arch();
  const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const systemLanguage = systemLocale.split('-')[0];
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Get platform-specific information
  let osVersion = `${osType} ${osRelease}`;
  if (platform === 'win32') {
    // Windows-specific version info
    osVersion = `Windows ${osRelease}`;
  } else if (platform === 'darwin') {
    osVersion = `macOS ${osRelease}`;
  } else if (platform === 'linux') {
    osVersion = `Linux ${osRelease}`;
  }

  // Generate encoding warnings based on system language
  let encodingWarning = '';
  if (systemLanguage === 'ja') {
    encodingWarning = '\nWARNING: Japanese OS detected - be careful of Shift_JIS encoding when reading/writing files. Use UTF-8 encoding explicitly when possible.';
  } else if (systemLanguage === 'zh') {
    encodingWarning = '\nWARNING: Chinese OS detected - be careful of GBK/GB2312 encoding when reading/writing files. Use UTF-8 encoding explicitly when possible.';
  } else if (systemLanguage === 'ko') {
    encodingWarning = '\nWARNING: Korean OS detected - be careful of EUC-KR encoding when reading/writing files. Use UTF-8 encoding explicitly when possible.';
  } else if (platform === 'win32') {
    encodingWarning = '\nNOTE: Windows OS detected - default encoding may vary by locale. Use UTF-8 encoding explicitly when reading/writing files.';
  }

  const context = `
We are setting up the context for our chat.
Today's date is ${today}.
System locale: ${systemLocale} (os language: ${systemLanguage}, timezone: ${timeZone})
Operating system: ${osVersion} (${osArch})${encodingWarning}
IMPORTANT: DO NOT let the os language or locale affect your response language - always respond in the same language as the user's message.
${directoryContext}
IMPORTANT: REFUSE to operate outside of <workspace> tags above, if the user asks you to do so, warn them that you can only operate within <workspace>.
Operate under subfolders of <workspace> is allowed.
        `.trim();

  const initialParts: Part[] = [{ text: context }];

  return initialParts;
}

export async function getInitialChatHistory(
  config: Config,
  extraHistory?: Content[],
): Promise<Content[]> {
  const envParts = await getEnvironmentContext(config);
  const envContextString = envParts.map((part) => part.text || '').join('\n\n');

  const allSetupText = `
${envContextString}

Reminder: Do not return an empty response when a tool call is required.

My setup is complete. I will provide my first command in the next turn.
    `.trim();

  return [
    {
      role: 'user',
      parts: [{ text: allSetupText }],
    },
    ...(extraHistory ?? []),
  ];
}
