/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { EOL } from 'node:os';
import { spawn } from 'node:child_process';
import { globStream } from 'glob';
import chardet from 'chardet';
import iconv from 'iconv-lite';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import { isGitRepository } from '../utils/gitUtils.js';
import type { Config } from '../config/config.js';
import type { FileExclusions } from '../utils/ignorePatterns.js';
import { ToolErrorType } from './tool-error.js';
// import { GREP_TOOL_NAME } from './tool-names.js';
import { debugLogger } from '../utils/debugLogger.js';

// --- Interfaces ---

/**
 * Parameters for the GrepTool
 */
export interface GrepToolParams {
  /**
   * Operation type
   */
  op: 'search_content_in_folder' | 'search_content_in_file';

  /**
   * The regular expression pattern to search for in file contents
   */
  pattern: string;

  /**
   * The folder to search in (for search_content_in_folder op, optional, defaults to current directory)
   */
  folder_path?: string;

  /**
   * The file to search in (for search_content_in_file op, required)
   */
  file_path?: string;

  /**
   * File pattern to include in the search (for search_content_in_folder op, e.g. "*.js", "*.{ts,tsx}")
   */
  include?: string;

  /**
   * Output mode: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts
   */
  output_mode?: 'content' | 'files_with_matches' | 'count';

  /**
   * Number of lines to show after each match (only works with output_mode: "content")
   */
  '-A'?: number;

  /**
   * Number of lines to show before each match (only works with output_mode: "content")
   */
  '-B'?: number;

  /**
   * Number of lines to show before and after each match (only works with output_mode: "content")
   */
  '-C'?: number;

  /**
   * Case insensitive search (default: true)
   */
  '-i'?: boolean;

  /**
   * Limit output to first N lines/entries
   */
  head_limit?: number;

  /**
   * Skip first N lines/entries before applying head_limit
   */
  offset?: number;
}

/**
 * Result object for a single grep match
 */
interface GrepMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

class GrepToolInvocation extends BaseToolInvocation<
  GrepToolParams,
  ToolResult
> {
  private readonly fileExclusions: FileExclusions;

  constructor(
    private readonly config: Config,
    params: GrepToolParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
    this.fileExclusions = config.getFileExclusions();
  }

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists, or null if no path specified (to search all directories).
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidateFolderPath(relativePath?: string): string | null {
    // If no path specified, return null to indicate searching all workspace directories
    if (!relativePath) {
      return null;
    }

    const targetPath = path.resolve(this.config.getTargetDir(), relativePath);

    // Security Check: Ensure the resolved path is within workspace boundaries
    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
      const directories = workspaceContext.getDirectories();
      throw new Error(
        `Path validation failed: Attempted path "${relativePath}" resolves outside the allowed workspace directories: ${directories.join(', ')}`,
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      throw new Error(
        `Failed to access path stats for ${targetPath}: ${error}`,
      );
    }

    return targetPath;
  }

  /**
   * Resolves and validates a file path
   * @param filePath Path to the file
   * @returns The absolute path if valid
   * @throws {Error} If path is outside workspace, doesn't exist, or isn't a file
   */
  private resolveAndValidateFilePath(filePath: string): string {
    const targetPath = path.resolve(this.config.getTargetDir(), filePath);

    // Security Check: Ensure the resolved path is within workspace boundaries
    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
      const directories = workspaceContext.getDirectories();
      throw new Error(
        `Path validation failed: Attempted path "${filePath}" resolves outside the allowed workspace directories: ${directories.join(', ')}`,
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${targetPath}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new Error(`File does not exist: ${targetPath}`);
      }
      throw new Error(
        `Failed to access file stats for ${targetPath}: ${error}`,
      );
    }

    return targetPath;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { op } = this.params;

    try {
      switch (op) {
        case 'search_content_in_folder':
          return await this.searchInFolder(signal);
        case 'search_content_in_file':
          return await this.searchInFile(signal);
        default:
          throw new Error(`Unknown operation: ${op}`);
      }
    } catch (error) {
      if (signal.aborted) {
        return {
          llmContent: 'Operation cancelled',
          returnDisplay: 'Cancelled',
          error: {
            message: 'Operation cancelled',
            type: ToolErrorType.GREP_EXECUTION_ERROR,
          },
        };
      }

      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep ${op} operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.GREP_EXECUTION_ERROR,
        },
      };
    }
  }

  private async searchInFolder(signal: AbortSignal): Promise<ToolResult> {
    const workspaceContext = this.config.getWorkspaceContext();
    const searchDirAbs = this.resolveAndValidateFolderPath(
      this.params.folder_path,
    );
    const searchDirDisplay = this.params.folder_path || '.';

    // Determine which directories to search
    let searchDirectories: readonly string[];
    if (searchDirAbs === null) {
      // No path specified - search all workspace directories
      searchDirectories = workspaceContext.getDirectories();
    } else {
      // Specific path provided - search only that directory
      searchDirectories = [searchDirAbs];
    }

    // Collect matches from all search directories
    let allMatches: GrepMatch[] = [];
    for (const searchDir of searchDirectories) {
      const matches = await this.performGrepSearch({
        pattern: this.params.pattern,
        path: searchDir,
        include: this.params.include,
        signal,
      });

      // Add directory prefix if searching multiple directories
      if (searchDirectories.length > 1) {
        const dirName = path.basename(searchDir);
        matches.forEach((match) => {
          match.filePath = path.join(dirName, match.filePath);
        });
      }

      allMatches = allMatches.concat(matches);
    }

    let searchLocationDescription: string;
    if (searchDirAbs === null) {
      const numDirs = workspaceContext.getDirectories().length;
      searchLocationDescription =
        numDirs > 1
          ? `across ${numDirs} workspace directories`
          : `in the workspace directory`;
    } else {
      searchLocationDescription = `in path "${searchDirDisplay}"`;
    }

    if (allMatches.length === 0) {
      const noMatchMsg = `No matches found for pattern "${this.params.pattern}" ${searchLocationDescription}${this.params.include ? ` (filter: "${this.params.include}")` : ''}.`;
      return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
    }

    const outputMode = this.params.output_mode || 'content';

    // Group matches by file
    const matchesByFile = allMatches.reduce(
      (acc, match) => {
        const fileKey = match.filePath;
        if (!acc[fileKey]) {
          acc[fileKey] = [];
        }
        acc[fileKey].push(match);
        acc[fileKey].sort((a, b) => a.lineNumber - b.lineNumber);
        return acc;
      },
      {} as Record<string, GrepMatch[]>,
    );

    const matchCount = allMatches.length;
    const matchTerm = matchCount === 1 ? 'match' : 'matches';
    const fileCount = Object.keys(matchesByFile).length;

    let llmContent = '';

    if (outputMode === 'files_with_matches') {
      // Only show file paths
      llmContent = `Found ${matchCount} ${matchTerm} in ${fileCount} file(s) for pattern "${this.params.pattern}" ${searchLocationDescription}${this.params.include ? ` (filter: "${this.params.include}")` : ''}:
`;
      for (const filePath in matchesByFile) {
        llmContent += `${filePath}\n`;
      }
    } else if (outputMode === 'count') {
      // Show match counts per file
      llmContent = `Match counts for pattern "${this.params.pattern}" ${searchLocationDescription}${this.params.include ? ` (filter: "${this.params.include}")` : ''}:
`;
      for (const filePath in matchesByFile) {
        const count = matchesByFile[filePath].length;
        llmContent += `${filePath}: ${count}\n`;
      }
      llmContent += `\nTotal: ${matchCount} ${matchTerm} in ${fileCount} file(s)`;
    } else {
      // Default: show content
      llmContent = `Found ${matchCount} ${matchTerm} for pattern "${this.params.pattern}" ${searchLocationDescription}${this.params.include ? ` (filter: "${this.params.include}")` : ''}:
---
`;
      for (const filePath in matchesByFile) {
        llmContent += `File: ${filePath}\n`;
        matchesByFile[filePath].forEach((match) => {
          const trimmedLine = match.line.trim();
          llmContent += `L${match.lineNumber}: ${trimmedLine}\n`;
        });
        llmContent += '---\n';
      }
    }

    return {
      llmContent: llmContent.trim(),
      returnDisplay: `Found ${matchCount} ${matchTerm}`,
    };
  }

  private async searchInFile(_signal: AbortSignal): Promise<ToolResult> {
    if (!this.params.file_path) {
      throw new Error(
        'file_path is required for search_content_in_file operation',
      );
    }

    const fileAbsolutePath = this.resolveAndValidateFilePath(
      this.params.file_path,
    );
    const fileDisplayPath = makeRelative(
      fileAbsolutePath,
      this.config.getTargetDir(),
    );

    // Read file as buffer first
    const buffer = await fsPromises.readFile(fileAbsolutePath);

    // Detect encoding using chardet
    const detectedEncoding = chardet.detect(buffer);

    // Decode content with detected encoding, fallback to utf8
    let content: string;
    if (detectedEncoding && iconv.encodingExists(detectedEncoding)) {
      content = iconv.decode(buffer, detectedEncoding);
    } else {
      // Fallback to utf8 if detection failed
      content = buffer.toString('utf8');
    }

    const caseInsensitive = this.params['-i'] ?? true;
    const regex = new RegExp(this.params.pattern, caseInsensitive ? 'i' : '');
    const lines = content.split(/\r?\n/);
    const matches: GrepMatch[] = [];

    lines.forEach((line, index) => {
      if (regex.test(line)) {
        matches.push({
          filePath: fileDisplayPath,
          lineNumber: index + 1,
          line,
        });
      }
    });

    // Apply offset and head_limit
    const offset = this.params.offset ?? 0;
    const headLimit = this.params.head_limit;
    const filteredMatches = headLimit
      ? matches.slice(offset, offset + headLimit)
      : matches.slice(offset);

    if (matches.length === 0) {
      const noMatchMsg = `No matches found for pattern "${this.params.pattern}" in file "${fileDisplayPath}".`;
      return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
    }

    const outputMode = this.params.output_mode || 'content';
    const totalMatchCount = matches.length;
    const matchCount = filteredMatches.length;
    const matchTerm = matchCount === 1 ? 'match' : 'matches';

    let llmContent = '';

    if (outputMode === 'files_with_matches') {
      // Only show file path
      llmContent = `Found ${totalMatchCount} ${matchTerm} in file "${fileDisplayPath}"`;
      if (offset > 0 || headLimit) {
        llmContent += ` (showing ${matchCount})`;
      }
    } else if (outputMode === 'count') {
      // Show match count
      llmContent = `${fileDisplayPath}: ${totalMatchCount}`;
    } else {
      // Default: show content
      llmContent = `Found ${totalMatchCount} ${matchTerm} for pattern "${this.params.pattern}" in file "${fileDisplayPath}"`;
      if (offset > 0 || headLimit) {
        llmContent += ` (showing ${matchCount})`;
      }
      llmContent += `:\n---\n`;

      // Calculate context lines
      const contextAfter = this.params['-C'] ?? this.params['-A'] ?? 0;
      const contextBefore = this.params['-C'] ?? this.params['-B'] ?? 0;

      if (contextAfter > 0 || contextBefore > 0) {
        // Show matches with context
        filteredMatches.forEach((match) => {
          const startLine = Math.max(0, match.lineNumber - 1 - contextBefore);
          const endLine = Math.min(lines.length - 1, match.lineNumber - 1 + contextAfter);

          for (let i = startLine; i <= endLine; i++) {
            const lineNum = i + 1;
            const prefix = lineNum === match.lineNumber ? '' : '-';
            llmContent += `${prefix}L${lineNum}: ${lines[i].trim()}\n`;
          }
          llmContent += '\n';
        });
      } else {
        // Show matches without context
        filteredMatches.forEach((match) => {
          const trimmedLine = match.line.trim();
          llmContent += `L${match.lineNumber}: ${trimmedLine}\n`;
        });
      }
    }

    return {
      llmContent: llmContent.trim(),
      returnDisplay: `Found ${matchCount} ${matchTerm}`,
    };
  }

  /**
   * Checks if a command is available in the system's PATH.
   * @param {string} command The command name (e.g., 'git', 'grep').
   * @returns {Promise<boolean>} True if the command is available, false otherwise.
   */
  private isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const checkCommand = process.platform === 'win32' ? 'where' : 'command';
      const checkArgs =
        process.platform === 'win32' ? [command] : ['-v', command];
      try {
        const child = spawn(checkCommand, checkArgs, {
          stdio: 'ignore',
          shell: true,
        });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', (err) => {
          debugLogger.debug(
            `[GrepTool] Failed to start process for '${command}':`,
            err.message,
          );
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Parses the standard output of grep-like commands (git grep, system grep).
   * Expects format: filePath:lineNumber:lineContent
   * Handles colons within file paths and line content correctly.
   * @param {string} output The raw stdout string.
   * @param {string} basePath The absolute directory the search was run from, for relative paths.
   * @returns {GrepMatch[]} Array of match objects.
   */
  private parseGrepOutput(output: string, basePath: string): GrepMatch[] {
    const results: GrepMatch[] = [];
    if (!output) return results;

    const lines = output.split(EOL); // Use OS-specific end-of-line

    for (const line of lines) {
      if (!line.trim()) continue;

      // Find the index of the first colon.
      const firstColonIndex = line.indexOf(':');
      if (firstColonIndex === -1) continue; // Malformed

      // Find the index of the second colon, searching *after* the first one.
      const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
      if (secondColonIndex === -1) continue; // Malformed

      // Extract parts based on the found colon indices
      const filePathRaw = line.substring(0, firstColonIndex);
      const lineNumberStr = line.substring(
        firstColonIndex + 1,
        secondColonIndex,
      );
      const lineContent = line.substring(secondColonIndex + 1);

      const lineNumber = parseInt(lineNumberStr, 10);

      if (!isNaN(lineNumber)) {
        const absoluteFilePath = path.resolve(basePath, filePathRaw);
        const relativeFilePath = path.relative(basePath, absoluteFilePath);

        results.push({
          filePath: relativeFilePath || path.basename(absoluteFilePath),
          lineNumber,
          line: lineContent,
        });
      }
    }
    return results;
  }

  /**
   * Gets a description of the grep operation
   * @returns A string describing the grep
   */
  getDescription(): string {
    const { op } = this.params;

    if (op === 'search_content_in_file' && this.params.file_path) {
      const resolvedPath = path.resolve(
        this.config.getTargetDir(),
        this.params.file_path,
      );
      const relativePath = makeRelative(
        resolvedPath,
        this.config.getTargetDir(),
      );
      return `'${this.params.pattern}' in ${shortenPath(relativePath)}`;
    }

    // search_content_in_folder
    let description = `'${this.params.pattern}'`;
    if (this.params.include) {
      description += ` in ${this.params.include}`;
    }
    if (this.params.folder_path) {
      const resolvedPath = path.resolve(
        this.config.getTargetDir(),
        this.params.folder_path,
      );
      if (
        resolvedPath === this.config.getTargetDir() ||
        this.params.folder_path === '.'
      ) {
        description += ` within ./`;
      } else {
        const relativePath = makeRelative(
          resolvedPath,
          this.config.getTargetDir(),
        );
        description += ` within ${shortenPath(relativePath)}`;
      }
    } else {
      // When no path is specified, indicate searching all workspace directories
      const workspaceContext = this.config.getWorkspaceContext();
      const directories = workspaceContext.getDirectories();
      if (directories.length > 1) {
        description += ` across all workspace directories`;
      }
    }
    return description;
  }

  /**
   * Performs the actual search using the prioritized strategies.
   * @param options Search options including pattern, absolute path, and include glob.
   * @returns A promise resolving to an array of match objects.
   */
  private async performGrepSearch(options: {
    pattern: string;
    path: string; // Expects absolute path
    include?: string;
    signal: AbortSignal;
  }): Promise<GrepMatch[]> {
    const { pattern, path: absolutePath, include } = options;
    let strategyUsed = 'none';

    try {
      // --- Strategy 1: git grep ---
      const isGit = isGitRepository(absolutePath);
      const gitAvailable = isGit && (await this.isCommandAvailable('git'));

      if (gitAvailable) {
        strategyUsed = 'git grep';
        const gitArgs = [
          'grep',
          '--untracked',
          '-n',
          '-E',
          '--ignore-case',
          pattern,
        ];
        if (include) {
          gitArgs.push('--', include);
        }

        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn('git', gitArgs, {
              cwd: absolutePath,
              windowsHide: true,
            });
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
            child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
            child.on('error', (err) =>
              reject(new Error(`Failed to start git grep: ${err.message}`)),
            );
            child.on('close', (code) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
              const stderrData = Buffer.concat(stderrChunks).toString('utf8');
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve(''); // No matches
              else
                reject(
                  new Error(`git grep exited with code ${code}: ${stderrData}`),
                );
            });
          });
          return this.parseGrepOutput(output, absolutePath);
        } catch (gitError: unknown) {
          debugLogger.debug(
            `GrepLogic: git grep failed: ${getErrorMessage(
              gitError,
            )}. Falling back...`,
          );
        }
      }

      // --- Strategy 2: System grep ---
      debugLogger.debug(
        'GrepLogic: System grep is being considered as fallback strategy.',
      );

      const grepAvailable = await this.isCommandAvailable('grep');
      if (grepAvailable) {
        strategyUsed = 'system grep';
        const grepArgs = ['-r', '-n', '-H', '-E', '-I'];
        // Extract directory names from exclusion patterns for grep --exclude-dir
        const globExcludes = this.fileExclusions.getGlobExcludes();
        const commonExcludes = globExcludes
          .map((pattern) => {
            let dir = pattern;
            if (dir.startsWith('**/')) {
              dir = dir.substring(3);
            }
            if (dir.endsWith('/**')) {
              dir = dir.slice(0, -3);
            } else if (dir.endsWith('/')) {
              dir = dir.slice(0, -1);
            }

            // Only consider patterns that are likely directories. This filters out file patterns.
            if (dir && !dir.includes('/') && !dir.includes('*')) {
              return dir;
            }
            return null;
          })
          .filter((dir): dir is string => !!dir);
        commonExcludes.forEach((dir) => grepArgs.push(`--exclude-dir=${dir}`));
        if (include) {
          grepArgs.push(`--include=${include}`);
        }
        grepArgs.push(pattern);
        grepArgs.push('.');

        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn('grep', grepArgs, {
              cwd: absolutePath,
              windowsHide: true,
            });
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            const onData = (chunk: Buffer) => stdoutChunks.push(chunk);
            const onStderr = (chunk: Buffer) => {
              const stderrStr = chunk.toString();
              // Suppress common harmless stderr messages
              if (
                !stderrStr.includes('Permission denied') &&
                !/grep:.*: Is a directory/i.test(stderrStr)
              ) {
                stderrChunks.push(chunk);
              }
            };
            const onError = (err: Error) => {
              cleanup();
              reject(new Error(`Failed to start system grep: ${err.message}`));
            };
            const onClose = (code: number | null) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
              const stderrData = Buffer.concat(stderrChunks)
                .toString('utf8')
                .trim();
              cleanup();
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve(''); // No matches
              else {
                if (stderrData)
                  reject(
                    new Error(
                      `System grep exited with code ${code}: ${stderrData}`,
                    ),
                  );
                else resolve(''); // Exit code > 1 but no stderr, likely just suppressed errors
              }
            };

            const cleanup = () => {
              child.stdout.removeListener('data', onData);
              child.stderr.removeListener('data', onStderr);
              child.removeListener('error', onError);
              child.removeListener('close', onClose);
              if (child.connected) {
                child.disconnect();
              }
            };

            child.stdout.on('data', onData);
            child.stderr.on('data', onStderr);
            child.on('error', onError);
            child.on('close', onClose);
          });
          return this.parseGrepOutput(output, absolutePath);
        } catch (grepError: unknown) {
          debugLogger.debug(
            `GrepLogic: System grep failed: ${getErrorMessage(
              grepError,
            )}. Falling back...`,
          );
        }
      }

      // --- Strategy 3: Pure JavaScript Fallback ---
      debugLogger.debug(
        'GrepLogic: Falling back to JavaScript grep implementation.',
      );
      strategyUsed = 'javascript fallback';
      const globPattern = include ? include : '**/*';
      const ignorePatterns = this.fileExclusions.getGlobExcludes();

      const filesStream = globStream(globPattern, {
        cwd: absolutePath,
        dot: true,
        ignore: ignorePatterns,
        absolute: true,
        nodir: true,
        signal: options.signal,
      });

      const regex = new RegExp(pattern, 'i');
      const allMatches: GrepMatch[] = [];

      for await (const filePath of filesStream) {
        const fileAbsolutePath = filePath as string;
        try {
          // Read file as buffer first
          const buffer = await fsPromises.readFile(fileAbsolutePath);

          // Detect encoding using chardet
          const detectedEncoding = chardet.detect(buffer);

          // Decode content with detected encoding, fallback to utf8
          let content: string;
          if (detectedEncoding && iconv.encodingExists(detectedEncoding)) {
            content = iconv.decode(buffer, detectedEncoding);
          } else {
            // Fallback to utf8 if detection failed
            content = buffer.toString('utf8');
          }

          const lines = content.split(/\r?\n/);
          lines.forEach((line, index) => {
            if (regex.test(line)) {
              allMatches.push({
                filePath:
                  path.relative(absolutePath, fileAbsolutePath) ||
                  path.basename(fileAbsolutePath),
                lineNumber: index + 1,
                line,
              });
            }
          });
        } catch (readError: unknown) {
          // Ignore errors like permission denied or file gone during read
          if (!isNodeError(readError) || readError.code !== 'ENOENT') {
            debugLogger.debug(
              `GrepLogic: Could not read/process ${fileAbsolutePath}: ${getErrorMessage(
                readError,
              )}`,
            );
          }
        }
      }

      return allMatches;
    } catch (error: unknown) {
      debugLogger.warn(
        `GrepLogic: Error in performGrepSearch (Strategy: ${strategyUsed}): ${getErrorMessage(
          error,
        )}`,
      );
      throw error; // Re-throw
    }
  }
}

// --- GrepTool Class ---

/**
 * Implementation of the Grep tool
 */
export class GrepTool extends BaseDeclarativeTool<GrepToolParams, ToolResult> {
  static readonly Name = 'search_file_content';

  constructor(private readonly config: Config) {
    super(
      GrepTool.Name,
      'SearchContent',
      `A powerful search tool built on ripgrep.

Usage:
- ALWAYS use this tool for search tasks. NEVER invoke \`grep\` or \`rg\` as a shell command. This tool has been optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Two operation modes:
  - \`search_content_in_folder\`: Search across multiple files in a directory (use \`include\` to filter by file pattern)
  - \`search_content_in_file\`: Search within a specific file (faster, requires exact file path)
- Output modes: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts
- Context lines: Use -A, -B, or -C parameters to show lines before/after matches (only with output_mode: "content")
- Pagination: Use head_limit and offset to control output size
- Returns the lines containing matches, along with their file paths and line numbers in the format:
  File: path/to/file.ts
  L123: matching line content
  ---
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.`,
      Kind.Search,
      {
        properties: {
          op: {
            type: 'string',
            enum: ['search_content_in_folder', 'search_content_in_file'],
            description:
              'Operation mode: "search_content_in_folder" to search across multiple files in a directory (use with folder_path and optional include pattern), or "search_content_in_file" to search within a single specific file (use with file_path, faster for single file searches)',
          },
          pattern: {
            description:
              "The regular expression (regex) pattern to search for within file contents (e.g., 'function\\s+myFunction', 'import\\s+\\{.*\\}\\s+from\\s+.*').",
            type: 'string',
          },
          folder_path: {
            description:
              'For search_content_in_folder: Optional absolute path to the folder to search within. If omitted, searches the current working directory.',
            type: 'string',
          },
          file_path: {
            description:
              'For search_content_in_file: Required absolute path to the specific file to search in.',
            type: 'string',
          },
          include: {
            description:
              "For search_content_in_folder: Optional glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}', 'src/**'). If omitted, searches all files (respecting potential global ignores).",
            type: 'string',
          },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description:
              'Output mode: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts',
          },
          '-A': {
            type: 'number',
            description:
              'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
          },
          '-B': {
            type: 'number',
            description:
              'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
          },
          '-C': {
            type: 'number',
            description:
              'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
          },
          '-i': {
            type: 'boolean',
            description:
              'Case insensitive search (rg -i). Defaults to true.',
          },
          head_limit: {
            type: 'number',
            description:
              'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes.',
          },
          offset: {
            type: 'number',
            description:
              'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
          },
        },
        required: ['op', 'pattern'],
        type: 'object',
      },
    );
  }

  /**
   * Validates the parameters for the tool
   * @param params Parameters to validate
   * @returns An error message string if invalid, null otherwise
   */
  protected override validateToolParamValues(
    params: GrepToolParams,
  ): string | null {
    // Validate pattern
    try {
      new RegExp(params.pattern);
    } catch (error) {
      return `Invalid regular expression pattern provided: ${params.pattern}. Error: ${getErrorMessage(error)}`;
    }

    // Validate based on operation
    if (params.op === 'search_content_in_folder') {
      // folder_path is optional for search_content_in_folder
      if (params.folder_path) {
        try {
          const targetPath = path.resolve(
            this.config.getTargetDir(),
            params.folder_path,
          );
          const workspaceContext = this.config.getWorkspaceContext();
          if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
            const directories = workspaceContext.getDirectories();
            return `Path validation failed: Attempted path "${params.folder_path}" resolves outside the allowed workspace directories: ${directories.join(', ')}`;
          }

          const stats = fs.statSync(targetPath);
          if (!stats.isDirectory()) {
            return `Path is not a directory: ${targetPath}`;
          }
        } catch (error: unknown) {
          if (isNodeError(error) && error.code === 'ENOENT') {
            return `Folder does not exist: ${params.folder_path}`;
          }
          return `Failed to access folder: ${getErrorMessage(error)}`;
        }
      }
    } else if (params.op === 'search_content_in_file') {
      // file_path is required for search_content_in_file
      if (!params.file_path) {
        return 'file_path is required for search_content_in_file operation';
      }

      try {
        const targetPath = path.resolve(
          this.config.getTargetDir(),
          params.file_path,
        );
        const workspaceContext = this.config.getWorkspaceContext();
        if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
          const directories = workspaceContext.getDirectories();
          return `Path validation failed: Attempted path "${params.file_path}" resolves outside the allowed workspace directories: ${directories.join(', ')}`;
        }

        const stats = fs.statSync(targetPath);
        if (!stats.isFile()) {
          return `Path is not a file: ${targetPath}`;
        }
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return `File does not exist: ${params.file_path}`;
        }
        return `Failed to access file: ${getErrorMessage(error)}`;
      }
    }

    return null; // Parameters are valid
  }

  protected createInvocation(
    params: GrepToolParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<GrepToolParams, ToolResult> {
    return new GrepToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
