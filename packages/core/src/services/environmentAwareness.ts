/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as Diff from 'diff';
import { debugLogger } from '../utils/debugLogger.js';
import { ExcelParser, type ExcelSnapshot } from '../utils/excelDiff.js';

const execAsync = promisify(exec);

/**
 * Represents a tracked file in the session
 */
interface TrackedFile {
  /** Absolute file path */
  path: string;
  /** Last known content (for text files) */
  lastContent?: string;
  /** Last known modification time */
  lastMtime: number;
  /** File size in bytes */
  lastSize: number;
  /** Whether this is a text file (can generate diff) */
  isTextFile: boolean;
  /** Whether this is an Excel file */
  isExcelFile: boolean;
  /** Last known Excel snapshot (for .xlsx files) */
  lastExcelSnapshot?: ExcelSnapshot;
}

/**
 * Information about a file change
 */
export interface FileChangeInfo {
  /** Absolute file path */
  path: string;
  /** Type of change detected */
  changeType: 'created' | 'modified' | 'deleted';
  /** Unified diff for text files (null for binary files or deleted files) */
  diff?: string;
  /** Whether file is currently locked (e.g., by Excel) */
  isLocked: boolean;
  /** Process ID that has the file locked (if available) */
  lockingPid?: number;
  /** Process name that has the file locked (if available) */
  lockingProcessName?: string;
  /** File size in bytes */
  size: number;
  /** File modification time */
  mtime: number;
}

/**
 * Session-aware file tracker
 * Tracks file changes within a specific session and provides context to LLM
 */
export class SessionFileTracker {
  /** Map of file path to tracked file info */
  private trackedFiles = new Map<string, TrackedFile>();

  /** Session ID this tracker belongs to */
  private readonly sessionId: string;

  /** Text file extensions that support diff generation */
  private static readonly TEXT_FILE_EXTENSIONS = new Set([
    '.txt',
    '.md',
    '.json',
    '.xml',
    '.yaml',
    '.yml',
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.py',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.go',
    '.rs',
    '.rb',
    '.php',
    '.html',
    '.css',
    '.scss',
    '.sass',
    '.sql',
    '.sh',
    '.bash',
    '.ps1',
    '.bat',
    '.cmd',
    '.log',
    '.csv',
    '.ini',
    '.conf',
    '.config',
    '.properties',
  ]);

  /** Excel file extensions that may be locked by Excel process */
  private static readonly EXCEL_FILE_EXTENSIONS = new Set([
    '.xlsx',
    '.xlsm',
    '.xlsb',
    '.xls',
    '.xlt',
    '.xltx',
    '.xltm',
  ]);

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    debugLogger.log(`[FileTracker] Created tracker for session ${sessionId}`);
  }

  /**
   * Register a file for tracking
   * Should be called when a tool touches a file
   */
  async registerFile(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);

    try {
      const stats = await fs.promises.stat(absolutePath);
      const isTextFile = this.isTextFile(absolutePath);
      const isExcelFile = this.isExcelFile(absolutePath);

      let content: string | undefined;
      if (isTextFile && stats.size < 10 * 1024 * 1024) {
        // Only track content for text files < 10MB
        content = await fs.promises.readFile(absolutePath, 'utf-8');
      }

      let excelSnapshot: ExcelSnapshot | undefined;
      if (isExcelFile && stats.size < 50 * 1024 * 1024) {
        // Parse Excel files < 50MB
        try {
          excelSnapshot = await ExcelParser.createSnapshot(absolutePath);
          debugLogger.log(
            `[FileTracker] Parsed Excel file: ${absolutePath} (${excelSnapshot.sheetHashes.size} sheets)`,
          );
        } catch (error) {
          debugLogger.warn(
            `[FileTracker] Failed to parse Excel file ${absolutePath}:`,
            error,
          );
        }
      }

      const trackedFile: TrackedFile = {
        path: absolutePath,
        lastContent: content,
        lastMtime: stats.mtimeMs,
        lastSize: stats.size,
        isTextFile,
        isExcelFile,
        lastExcelSnapshot: excelSnapshot,
      };

      this.trackedFiles.set(absolutePath, trackedFile);
      debugLogger.log(
        `[FileTracker] Registered file: ${absolutePath} (session: ${this.sessionId})`,
      );
    } catch (error) {
      debugLogger.warn(
        `[FileTracker] Failed to register file ${absolutePath}:`,
        error,
      );
    }
  }

  /**
   * Check if file is a text file based on extension
   */
  private isTextFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return SessionFileTracker.TEXT_FILE_EXTENSIONS.has(ext);
  }

  /**
   * Check if file is an Excel file
   */
  private isExcelFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return SessionFileTracker.EXCEL_FILE_EXTENSIONS.has(ext);
  }

  /**
   * Detect changes in all tracked files
   * Returns information about files that have changed since last check
   */
  async detectChanges(): Promise<FileChangeInfo[]> {
    const changes: FileChangeInfo[] = [];

    for (const [filePath, trackedFile] of this.trackedFiles.entries()) {
      try {
        const change = await this.checkFileChange(filePath, trackedFile);
        if (change) {
          changes.push(change);
        }
      } catch (error) {
        debugLogger.warn(
          `[FileTracker] Error checking file ${filePath}:`,
          error,
        );
      }
    }

    return changes;
  }

  /**
   * Check if a specific file has changed
   */
  private async checkFileChange(
    filePath: string,
    trackedFile: TrackedFile,
  ): Promise<FileChangeInfo | null> {
    try {
      const stats = await fs.promises.stat(filePath);

      // Check if file was modified
      if (
        stats.mtimeMs === trackedFile.lastMtime &&
        stats.size === trackedFile.lastSize
      ) {
        return null; // No change
      }

      // File was modified
      let diff: string | undefined;

      if (
        trackedFile.isTextFile &&
        trackedFile.lastContent &&
        stats.size < 10 * 1024 * 1024
      ) {
        const newContent = await fs.promises.readFile(filePath, 'utf-8');

        // Generate unified diff
        const patch = Diff.createPatch(
          path.basename(filePath),
          trackedFile.lastContent,
          newContent,
          'before',
          'after',
          { context: 3 },
        );

        diff = patch;

        // Update tracked content
        trackedFile.lastContent = newContent;
      } else if (
        trackedFile.isExcelFile &&
        trackedFile.lastExcelSnapshot &&
        stats.size < 50 * 1024 * 1024
      ) {
        // Generate Excel diff
        try {
          const newSnapshot = await ExcelParser.createSnapshot(
            filePath,
            trackedFile.lastExcelSnapshot,
          );

          const changes = ExcelParser.compareSnapshots(
            trackedFile.lastExcelSnapshot,
            newSnapshot,
          );

          if (changes.length > 0) {
            diff = ExcelParser.formatChanges(changes);
            debugLogger.log(
              `[FileTracker] Excel changes detected: ${changes.length} sheet(s) modified`,
            );
          }

          // Update tracked snapshot
          trackedFile.lastExcelSnapshot = newSnapshot;
        } catch (error) {
          debugLogger.warn(
            `[FileTracker] Failed to generate Excel diff for ${filePath}:`,
            error,
          );
        }
      }

      // Update tracked file info
      trackedFile.lastMtime = stats.mtimeMs;
      trackedFile.lastSize = stats.size;

      // Check if file is locked
      const lockInfo = await this.checkFileLock(filePath);

      return {
        path: filePath,
        changeType: 'modified',
        diff,
        isLocked: lockInfo.isLocked,
        lockingPid: lockInfo.pid,
        lockingProcessName: lockInfo.processName,
        size: stats.size,
        mtime: stats.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File was deleted
        this.trackedFiles.delete(filePath);
        return {
          path: filePath,
          changeType: 'deleted',
          isLocked: false,
          size: 0,
          mtime: Date.now(),
        };
      }
      throw error;
    }
  }

  /**
   * Check if file is locked by another process (e.g., Excel)
   * Returns lock information including PID and process name
   */
  private async checkFileLock(filePath: string): Promise<{
    isLocked: boolean;
    pid?: number;
    processName?: string;
  }> {
    // Only check lock for Excel files on Windows
    if (process.platform !== 'win32' || !this.isExcelFile(filePath)) {
      return { isLocked: false };
    }

    try {
      // Use PowerShell to find processes with open handle to this file
      // This is more reliable than trying to open the file exclusively
      const command = `powershell -Command "Get-Process | Where-Object { $_.Modules.FileName -like '*${path.basename(filePath)}*' } | Select-Object Id, ProcessName | ConvertTo-Json"`;

      const { stdout } = await execAsync(command, { timeout: 5000 });

      if (stdout.trim()) {
        const processes = JSON.parse(stdout);
        const processList = Array.isArray(processes) ? processes : [processes];

        // Look for Excel process specifically
        const excelProcess = processList.find((p: { ProcessName: string }) =>
          p.ProcessName.toLowerCase().includes('excel'),
        );

        if (excelProcess) {
          return {
            isLocked: true,
            pid: excelProcess.Id,
            processName: excelProcess.ProcessName,
          };
        }
      }

      // Alternative method: Try to open file exclusively
      // If it fails with EBUSY, file is locked
      try {
        const fd = await fs.promises.open(filePath, 'r+');
        await fd.close();
        return { isLocked: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EBUSY') {
          return { isLocked: true };
        }
        return { isLocked: false };
      }
    } catch (error) {
      debugLogger.warn(
        `[FileTracker] Failed to check file lock for ${filePath}:`,
        error,
      );
      return { isLocked: false };
    }
  }

  /**
   * Get summary of all tracked files for this session
   */
  getSummary(): {
    sessionId: string;
    trackedFileCount: number;
    trackedFiles: string[];
  } {
    return {
      sessionId: this.sessionId,
      trackedFileCount: this.trackedFiles.size,
      trackedFiles: Array.from(this.trackedFiles.keys()),
    };
  }

  /**
   * Clear all tracked files for this session
   */
  clear(): void {
    this.trackedFiles.clear();
    debugLogger.log(
      `[FileTracker] Cleared all tracked files for session ${this.sessionId}`,
    );
  }

  /**
   * Remove a specific file from tracking
   */
  unregisterFile(filePath: string): void {
    const absolutePath = path.resolve(filePath);
    this.trackedFiles.delete(absolutePath);
    debugLogger.log(
      `[FileTracker] Unregistered file: ${absolutePath} (session: ${this.sessionId})`,
    );
  }

  /**
   * Register all files in a directory for tracking (shallow, non-recursive)
   * Used by Python/TypeScript tools to track their working directory
   */
  async registerDirectory(dirPath: string): Promise<void> {
    try {
      const absolutePath = path.resolve(dirPath);
      const entries = await fs.promises.readdir(absolutePath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = path.join(absolutePath, entry.name);
          await this.registerFile(filePath);
        }
      }

      debugLogger.log(
        `[FileTracker] Registered directory: ${absolutePath} (session: ${this.sessionId})`,
      );
    } catch (error) {
      debugLogger.warn(
        `[FileTracker] Failed to register directory ${dirPath}:`,
        error,
      );
    }
  }
}

/**
 * Global manager for session file trackers
 * Maintains separate trackers for each session
 */
export class EnvironmentAwarenessManager {
  private static instance: EnvironmentAwarenessManager;

  /** Map of session ID to file tracker */
  private sessionTrackers = new Map<string, SessionFileTracker>();

  private constructor() {
    debugLogger.log('[EnvironmentAwareness] Manager initialized');
  }

  /**
   * Get singleton instance
   */
  static getInstance(): EnvironmentAwarenessManager {
    if (!EnvironmentAwarenessManager.instance) {
      EnvironmentAwarenessManager.instance = new EnvironmentAwarenessManager();
    }
    return EnvironmentAwarenessManager.instance;
  }

  /**
   * Get or create tracker for a session
   */
  getTracker(sessionId: string): SessionFileTracker {
    let tracker = this.sessionTrackers.get(sessionId);
    if (!tracker) {
      tracker = new SessionFileTracker(sessionId);
      this.sessionTrackers.set(sessionId, tracker);
    }
    return tracker;
  }

  /**
   * Remove tracker for a session (cleanup when session ends)
   */
  removeTracker(sessionId: string): void {
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      tracker.clear();
      this.sessionTrackers.delete(sessionId);
      debugLogger.log(
        `[EnvironmentAwareness] Removed tracker for session ${sessionId}`,
      );
    }
  }

  /**
   * Get summary of all active trackers
   */
  getSummary(): {
    activeSessionCount: number;
    sessions: Record<
      string,
      { trackedFileCount: number; trackedFiles: string[] }
    >;
  } {
    const sessions: Record<
      string,
      { trackedFileCount: number; trackedFiles: string[] }
    > = {};

    for (const [sessionId, tracker] of this.sessionTrackers.entries()) {
      const summary = tracker.getSummary();
      sessions[sessionId] = {
        trackedFileCount: summary.trackedFileCount,
        trackedFiles: summary.trackedFiles,
      };
    }

    return {
      activeSessionCount: this.sessionTrackers.size,
      sessions,
    };
  }

  /**
   * Format file changes for LLM consumption
   * Generates a human-readable summary of file changes
   */
  formatChangesForLLM(changes: FileChangeInfo[]): string {
    if (changes.length === 0) {
      return 'No file changes detected.';
    }

    const lines: string[] = [];
    lines.push(
      `📊 Environment Changes Detected (${changes.length} file${changes.length > 1 ? 's' : ''})`,
    );
    lines.push('');

    for (const change of changes) {
      const relativePath = change.path;

      switch (change.changeType) {
        case 'created':
          lines.push(`✨ Created: ${relativePath}`);
          break;
        case 'modified':
          lines.push(`📝 Modified: ${relativePath}`);
          if (change.diff) {
            lines.push('');
            lines.push('```diff');
            lines.push(change.diff);
            lines.push('```');
          }
          break;
        case 'deleted':
          lines.push(`🗑️  Deleted: ${relativePath}`);
          break;
        default:
          break;
      }

      // Add lock information for Excel files
      if (change.isLocked) {
        lines.push(`   ⚠️  File is currently locked`);
        if (change.lockingProcessName) {
          lines.push(
            `   📌 Locked by: ${change.lockingProcessName} (PID: ${change.lockingPid})`,
          );
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }
}
