/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import * as path from 'node:path';
import { globSync } from 'glob';
import chardet from 'chardet';
import iconv from 'iconv-lite';

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
    // Read file as buffer first
    const buffer = await fs.readFile(filePath);

    // Detect encoding using chardet for each file
    const detectedEncoding = chardet.detect(buffer);

    // Decode content with detected encoding, fallback to utf8
    let content: string;
    if (detectedEncoding && iconv.encodingExists(detectedEncoding)) {
      content = iconv.decode(buffer, detectedEncoding);
    } else {
      // Fallback to utf8 if detection failed
      content = buffer.toString('utf8');
    }

    return content;
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
