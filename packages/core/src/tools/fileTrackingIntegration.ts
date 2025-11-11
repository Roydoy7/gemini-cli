/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { EnvironmentAwarenessManager } from '../services/environmentAwareness.js';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Register a file for tracking in the current session
 * Should be called by tools when they modify files (write, edit, create)
 *
 * @param config - Config instance to get current session ID
 * @param filePath - Absolute or relative file path to track
 *
 * @example
 * ```typescript
 * // In a tool's execute method after writing a file
 * await registerFileForTracking(this.config, filePath);
 * ```
 */
export async function registerFileForTracking(
  config: Config,
  filePath: string,
): Promise<void> {
  try {
    const sessionId = config.getSessionId();
    if (!sessionId) {
      debugLogger.warn(
        '[FileTracking] Cannot register file: no active session',
      );
      return;
    }

    const manager = EnvironmentAwarenessManager.getInstance();
    const tracker = manager.getTracker(sessionId);
    await tracker.registerFile(filePath);
  } catch (error) {
    debugLogger.warn(
      `[FileTracking] Failed to register file ${filePath}:`,
      error,
    );
  }
}

/**
 * Unregister a file from tracking
 * Call this when a file is deleted or should no longer be tracked
 *
 * @param config - Config instance to get current session ID
 * @param filePath - File path to stop tracking
 */
export function unregisterFileFromTracking(
  config: Config,
  filePath: string,
): void {
  try {
    const sessionId = config.getSessionId();
    if (!sessionId) {
      return;
    }

    const manager = EnvironmentAwarenessManager.getInstance();
    const tracker = manager.getTracker(sessionId);
    tracker.unregisterFile(filePath);
  } catch (error) {
    debugLogger.warn(
      `[FileTracking] Failed to unregister file ${filePath}:`,
      error,
    );
  }
}

/**
 * Register all files in a directory for tracking (shallow, non-recursive)
 * Used by Python/TypeScript tools to track their working directory
 *
 * @param config - Config instance to get current session ID
 * @param dirPath - Directory path to track
 *
 * @example
 * ```typescript
 * // After Python/TypeScript script execution
 * await registerDirectoryForTracking(this.config, workingDirectory);
 * ```
 */
export async function registerDirectoryForTracking(
  config: Config,
  dirPath: string,
): Promise<void> {
  try {
    const sessionId = config.getSessionId();
    if (!sessionId) {
      debugLogger.warn(
        '[FileTracking] Cannot register directory: no active session',
      );
      return;
    }

    const manager = EnvironmentAwarenessManager.getInstance();
    const tracker = manager.getTracker(sessionId);
    await tracker.registerDirectory(dirPath);
  } catch (error) {
    debugLogger.warn(
      `[FileTracking] Failed to register directory ${dirPath}:`,
      error,
    );
  }
}

/**
 * Clean up file tracking when a session ends
 * Should be called by SessionManager when a session is deleted
 *
 * @param sessionId - Session ID to clean up
 */
export function cleanupSessionTracking(sessionId: string): void {
  try {
    const manager = EnvironmentAwarenessManager.getInstance();
    manager.removeTracker(sessionId);
    debugLogger.log(
      `[FileTracking] Cleaned up tracking for session ${sessionId}`,
    );
  } catch (error) {
    debugLogger.warn(
      `[FileTracking] Failed to cleanup session ${sessionId}:`,
      error,
    );
  }
}
