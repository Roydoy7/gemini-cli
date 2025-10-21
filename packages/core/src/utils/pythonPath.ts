/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Get the embedded Python 3.13.7 executable path.
 * Handles both development and production builds (CLI and GUI).
 *
 * Path resolution:
 * - Development (CLI): packages/python-3.13.7/python.exe
 * - Production (CLI): packages/python-3.13.7/python.exe
 * - Production (GUI/Electron): resources/app/node_modules/@google/python-3.13.7/python.exe
 */
export function getEmbeddedPythonPath(): string {
  // Try calculating from current file location (works for most cases)
  const currentFileUrl = import.meta.url;
  const currentFilePath = new URL(currentFileUrl).pathname;
  const normalizedPath =
    process.platform === 'win32' ? currentFilePath.slice(1) : currentFilePath;

  // Path structure: packages/core/dist/src/utils/pythonPath.js
  const utilsPath = path.dirname(normalizedPath);
  const srcPath = path.dirname(utilsPath);
  const distPath = path.dirname(srcPath);
  const corePath = path.dirname(distPath);
  const packagesPath = path.dirname(corePath);

  // Try standard packages location first
  let embeddedPythonPath = path.join(
    packagesPath,
    'python-3.13.7',
    'python.exe',
  );

  if (fs.existsSync(embeddedPythonPath)) {
    return embeddedPythonPath;
  }

  // Try Electron packaged app location
  // Path: resources/app/node_modules/@google/gemini-cli-core/dist/src/utils
  // Go up to: resources/app/node_modules/@google/python-3.13.7
  const googlePath = path.resolve(corePath, '..');
  embeddedPythonPath = path.join(googlePath, 'python-3.13.7', 'python.exe');

  if (fs.existsSync(embeddedPythonPath)) {
    return embeddedPythonPath;
  }

  // Try relative to current working directory (for test environment)
  embeddedPythonPath = path.join(
    process.cwd(),
    'packages',
    'python-3.13.7',
    'python.exe',
  );

  if (fs.existsSync(embeddedPythonPath)) {
    return embeddedPythonPath;
  }

  // Try from project root
  const projectRoot = process.cwd().includes('packages')
    ? path.join(process.cwd(), '..', '..')
    : process.cwd();
  embeddedPythonPath = path.join(
    projectRoot,
    'packages',
    'python-3.13.7',
    'python.exe',
  );

  return embeddedPythonPath;
}
