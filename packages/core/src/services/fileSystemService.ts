/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import * as path from 'node:path';
import { globSync } from 'glob';
import { getCachedEncodingForBuffer } from '../utils/systemEncoding.js';

/**
 * Interface for file system operations that may be delegated to different implementations
 */
export interface FileSystemService {
  /**
   * Read text content from a file
   *
   * @param filePath - The path to the file to read
   * @returns The file content as a string
   */
  readTextFile(filePath: string): Promise<string>;

  /**
   * Write text content to a file
   *
   * @param filePath - The path to the file to write
   * @param content - The content to write
   */
  writeTextFile(filePath: string, content: string): Promise<void>;

  /**
   * Finds files with a given name within specified search paths.
   *
   * @param fileName - The name of the file to find.
   * @param searchPaths - An array of directory paths to search within.
   * @returns An array of absolute paths to the found files.
   */
  findFiles(fileName: string, searchPaths: readonly string[]): string[];
}

/**
 * Standard file system implementation
 */
export class StandardFileSystemService implements FileSystemService {
  async readTextFile(filePath: string): Promise<string> {
    // Read file as buffer first to detect encoding
    const buffer = await fs.readFile(filePath);

    // Detect encoding from buffer
    const encoding = getCachedEncodingForBuffer(buffer);

    // Convert buffer to string using detected encoding
    // Node.js TextDecoder supports various encodings including UTF-16LE
    try {
      const decoder = new TextDecoder(encoding);
      return decoder.decode(buffer);
    } catch (error) {
      // Fallback to utf-8 if encoding is not supported
      console.warn(
        `Failed to decode file with encoding ${encoding}, falling back to utf-8:`,
        error,
      );
      return buffer.toString('utf-8');
    }
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }

  findFiles(fileName: string, searchPaths: readonly string[]): string[] {
    return searchPaths.flatMap((searchPath) => {
      const pattern = path.posix.join(searchPath, '**', fileName);
      return globSync(pattern, {
        nodir: true,
        absolute: true,
      });
    });
  }
}
