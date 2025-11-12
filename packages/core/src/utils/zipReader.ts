/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflateRaw = promisify(zlib.inflateRaw);

/**
 * Represents a file entry in a zip archive
 */
interface ZipEntry {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number; // 0 = stored, 8 = deflate
  localHeaderOffset: number;
}

/**
 * Lightweight ZIP reader that only extracts specific files
 * No external dependencies - uses Node.js built-in modules only
 */
export class ZipReader {
  private entries = new Map<string, ZipEntry>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Read the central directory to locate files in the archive
   */
  async readCentralDirectory(): Promise<void> {
    const fd = await fs.promises.open(this.filePath, 'r');

    try {
      const stats = await fd.stat();
      const fileSize = stats.size;

      // Read the end of central directory record (EOCD)
      // EOCD is at the end of the file, typically last 22 bytes minimum
      const eocdBufferSize = Math.min(fileSize, 65557); // 64KB + 22 bytes
      const eocdBuffer = Buffer.allocUnsafe(eocdBufferSize);
      await fd.read(eocdBuffer, 0, eocdBufferSize, fileSize - eocdBufferSize);

      // Find EOCD signature: 0x06054b50
      const eocdSignature = 0x06054b50;
      let eocdOffset = -1;

      for (let i = eocdBufferSize - 22; i >= 0; i--) {
        if (eocdBuffer.readUInt32LE(i) === eocdSignature) {
          eocdOffset = i;
          break;
        }
      }

      if (eocdOffset === -1) {
        throw new Error('Not a valid ZIP file: EOCD signature not found');
      }

      // Parse EOCD
      const totalEntries = eocdBuffer.readUInt16LE(eocdOffset + 10);
      const centralDirSize = eocdBuffer.readUInt32LE(eocdOffset + 12);
      const centralDirOffset = eocdBuffer.readUInt32LE(eocdOffset + 16);

      // Read central directory
      const centralDirBuffer = Buffer.allocUnsafe(centralDirSize);
      await fd.read(centralDirBuffer, 0, centralDirSize, centralDirOffset);

      // Parse central directory entries
      let offset = 0;
      const cdSignature = 0x02014b50;

      for (let i = 0; i < totalEntries; i++) {
        if (centralDirBuffer.readUInt32LE(offset) !== cdSignature) {
          throw new Error('Invalid central directory entry');
        }

        const compressionMethod = centralDirBuffer.readUInt16LE(offset + 10);
        const compressedSize = centralDirBuffer.readUInt32LE(offset + 20);
        const uncompressedSize = centralDirBuffer.readUInt32LE(offset + 24);
        const fileNameLength = centralDirBuffer.readUInt16LE(offset + 28);
        const extraFieldLength = centralDirBuffer.readUInt16LE(offset + 30);
        const commentLength = centralDirBuffer.readUInt16LE(offset + 32);
        const localHeaderOffset = centralDirBuffer.readUInt32LE(offset + 42);

        const fileName = centralDirBuffer.toString(
          'utf-8',
          offset + 46,
          offset + 46 + fileNameLength,
        );

        this.entries.set(fileName, {
          fileName,
          compressedSize,
          uncompressedSize,
          compressionMethod,
          localHeaderOffset,
        });

        offset += 46 + fileNameLength + extraFieldLength + commentLength;
      }
    } finally {
      await fd.close();
    }
  }

  /**
   * Extract a specific file from the archive
   */
  async extractFile(fileName: string): Promise<Buffer> {
    const entry = this.entries.get(fileName);
    if (!entry) {
      throw new Error(`File not found in archive: ${fileName}`);
    }

    const fd = await fs.promises.open(this.filePath, 'r');

    try {
      // Read local file header
      const localHeaderBuffer = Buffer.allocUnsafe(30);
      await fd.read(localHeaderBuffer, 0, 30, entry.localHeaderOffset);

      const localSignature = 0x04034b50;
      if (localHeaderBuffer.readUInt32LE(0) !== localSignature) {
        throw new Error('Invalid local file header');
      }

      const fileNameLength = localHeaderBuffer.readUInt16LE(26);
      const extraFieldLength = localHeaderBuffer.readUInt16LE(28);

      // Calculate data offset (skip local header, filename, and extra field)
      const dataOffset =
        entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;

      // Read compressed data
      const compressedData = Buffer.allocUnsafe(entry.compressedSize);
      await fd.read(compressedData, 0, entry.compressedSize, dataOffset);

      // Decompress based on compression method
      if (entry.compressionMethod === 0) {
        // Stored (no compression)
        return compressedData;
      } else if (entry.compressionMethod === 8) {
        // Deflate compression
        return await inflateRaw(compressedData);
      } else {
        throw new Error(
          `Unsupported compression method: ${entry.compressionMethod}`,
        );
      }
    } finally {
      await fd.close();
    }
  }

  /**
   * Extract multiple files at once
   */
  async extractFiles(fileNames: string[]): Promise<Map<string, Buffer>> {
    const results = new Map<string, Buffer>();

    for (const fileName of fileNames) {
      if (this.entries.has(fileName)) {
        try {
          const data = await this.extractFile(fileName);
          results.set(fileName, data);
        } catch (error) {
          // Skip files that can't be extracted
          console.warn(`Failed to extract ${fileName}:`, error);
        }
      }
    }

    return results;
  }

  /**
   * List all files in the archive
   */
  listFiles(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Check if a file exists in the archive
   */
  hasFile(fileName: string): boolean {
    return this.entries.has(fileName);
  }
}

/**
 * Convenience function to extract specific files from a ZIP archive
 */
export async function extractFromZip(
  zipPath: string,
  fileNames: string[],
): Promise<Map<string, Buffer>> {
  const reader = new ZipReader(zipPath);
  await reader.readCentralDirectory();
  return await reader.extractFiles(fileNames);
}
