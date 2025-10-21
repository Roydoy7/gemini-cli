/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GeminiCLIExtension } from '../config/config.js';
import { getEmbeddedPythonPath } from './pythonPath.js';

/**
 * Simple variable substitution for extension configs.
 * Replaces ${embeddedPythonPath}, ${extensionPath}, and ${pathSeparator}.
 */
function substituteVariables(obj: unknown, extensionPath: string): unknown {
  if (typeof obj === 'string') {
    return obj
      .replace(/\$\{embeddedPythonPath\}/g, getEmbeddedPythonPath())
      .replace(/\$\{extensionPath\}/g, extensionPath)
      .replace(/\$\{pathSeparator\}/g, path.sep)
      .replace(/\$\{\/\}/g, path.sep);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteVariables(item, extensionPath));
  }
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteVariables(value, extensionPath);
    }
    return result;
  }
  return obj;
}

/**
 * Load built-in extensions from packages/extensions directory.
 * These are extensions shipped with Gemini CLI that are automatically available.
 *
 * This function is used by both CLI and GUI to discover built-in extensions.
 */
export function loadBuiltinExtensions(
  _workspaceDir: string = process.cwd(),
): GeminiCLIExtension[] {
  try {
    // Calculate path to packages/extensions
    // For CLI: packages/core/dist/src/utils/extensionLoader.js
    // For GUI: resources/app/node_modules/@google/gemini-cli-core/dist/src/utils/extensionLoader.js
    const currentFileUrl = import.meta.url;
    const currentFilePath = new URL(currentFileUrl).pathname;
    const normalizedPath =
      process.platform === 'win32' ? currentFilePath.slice(1) : currentFilePath;

    const utilsPath = path.dirname(normalizedPath);
    const srcPath = path.dirname(utilsPath);
    const distPath = path.dirname(srcPath);
    const corePath = path.dirname(distPath);
    const packagesPath = path.dirname(corePath);

    // Try packages/extensions first (development and CLI)
    let builtinExtensionsDir = path.join(packagesPath, 'extensions');

    // For Electron packaged app, extensions might be in resources/app/node_modules/@google/
    if (!fs.existsSync(builtinExtensionsDir)) {
      // Go up from core path to @google, then look for extensions
      const googlePath = path.dirname(corePath);
      builtinExtensionsDir = path.join(googlePath, 'extensions');
    }

    // Check if built-in extensions directory exists
    if (!fs.existsSync(builtinExtensionsDir)) {
      return [];
    }

    const extensions: GeminiCLIExtension[] = [];
    const subdirs = fs.readdirSync(builtinExtensionsDir);

    for (const subdir of subdirs) {
      const extensionDir = path.join(builtinExtensionsDir, subdir);

      // Skip non-directories
      try {
        if (!fs.statSync(extensionDir).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      // Try to load extension config
      const configPath = path.join(extensionDir, 'gemini-extension.json');
      if (!fs.existsSync(configPath)) {
        continue;
      }

      try {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const rawConfig = JSON.parse(configContent);

        // Check platform compatibility
        if (rawConfig.platforms) {
          if (!rawConfig.platforms.includes(process.platform)) {
            console.log(
              `[Extension] Skipping ${rawConfig.name}: not compatible with platform ${process.platform}`,
            );
            continue;
          }
        }

        // Apply variable substitution
        const config = substituteVariables(
          rawConfig,
          extensionDir,
        ) as typeof rawConfig;

        console.log(
          `[Extension] Loading extension: ${config.name} v${config.version}`,
        );
        console.log(`[Extension] Path: ${extensionDir}`);

        // Log MCP servers configuration
        if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
          console.log(
            `[Extension] MCP Servers in ${config.name}:`,
            Object.keys(config.mcpServers),
          );
          for (const [serverName, serverConfig] of Object.entries(
            config.mcpServers,
          )) {
            const mcpConfig = serverConfig as {
              command?: string;
              args?: string[];
              env?: Record<string, string>;
            };
            console.log(`[Extension]   - ${serverName}:`);
            console.log(`[Extension]       Command: ${mcpConfig.command}`);
            console.log(
              `[Extension]       Args: ${JSON.stringify(mcpConfig.args)}`,
            );
            if (mcpConfig.env) {
              console.log(
                `[Extension]       Env: ${JSON.stringify(mcpConfig.env)}`,
              );
            }
          }
        }

        // Create basic extension object
        // MCP servers now have variables substituted
        const extension: GeminiCLIExtension = {
          name: config.name,
          version: config.version,
          isActive: true,
          path: extensionDir,
          mcpServers: config.mcpServers || {},
          contextFiles: Array.isArray(config.contextFileName)
            ? config.contextFileName
            : config.contextFileName
              ? [config.contextFileName]
              : [],
          excludeTools: config.excludeTools,
        };

        extensions.push(extension);
        console.log(`[Extension] ✓ Successfully loaded: ${config.name}`);
      } catch (error) {
        console.error(`\n${'='.repeat(80)}`);
        console.error(`❌ [EXTENSION LOAD FAILED] Path: ${extensionDir}`);
        console.error(`${'='.repeat(80)}`);
        console.error(`Error:`, error);
        console.error(`${'='.repeat(80)}\n`);
      }
    }

    return extensions;
  } catch (error) {
    // Silently fail if built-in extensions can't be loaded
    console.warn('Failed to load built-in extensions:', error);
    return [];
  }
}
