/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GrepToolParams } from './grep.js';
import { GrepTool } from './grep.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { ToolErrorType } from './tool-error.js';
import * as glob from 'glob';

vi.mock('glob', { spy: true });

// Mock the child_process module to control grep/git grep behavior
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'error' || event === 'close') {
        // Simulate command not found or error for git grep and system grep
        // to force it to fall back to JS implementation.
        setTimeout(() => cb(1), 0); // cb(1) for error/close
      }
    },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  })),
}));

describe('GrepTool', () => {
  let tempRootDir: string;
  let grepTool: GrepTool;
  const abortSignal = new AbortController().signal;

  const mockConfig = {
    getTargetDir: () => tempRootDir,
    getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
    getFileExclusions: () => ({
      getGlobExcludes: () => [],
    }),
  } as unknown as Config;

  beforeEach(async () => {
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-root-'));
    grepTool = new GrepTool(mockConfig);

    // Create some test files and directories
    await fs.writeFile(
      path.join(tempRootDir, 'fileA.txt'),
      'hello world\nsecond line with world',
    );
    await fs.writeFile(
      path.join(tempRootDir, 'fileB.js'),
      'const foo = "bar";\nfunction baz() { return "hello"; }',
    );
    await fs.mkdir(path.join(tempRootDir, 'sub'));
    await fs.writeFile(
      path.join(tempRootDir, 'sub', 'fileC.txt'),
      'another world in sub dir',
    );
    await fs.writeFile(
      path.join(tempRootDir, 'sub', 'fileD.md'),
      '# Markdown file\nThis is a test.',
    );
  });

  afterEach(async () => {
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  describe('validateToolParams', () => {
    it('should return null for valid params (search_content_in_folder with pattern only)', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'hello',
      };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return null for valid params (search_content_in_folder with pattern and folder_path)', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'hello',
        folder_path: '.',
      };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return null for valid params (search_content_in_folder with pattern, folder_path, and include)', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'hello',
        folder_path: '.',
        include: '*.txt',
      };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return null for valid params (search_content_in_file)', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'hello',
        file_path: 'fileA.txt',
      };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return error if op is missing', () => {
      const params = {
        pattern: 'hello',
      } as unknown as GrepToolParams;
      expect(grepTool.validateToolParams(params)).toBe(
        `params must have required property 'op'`,
      );
    });

    it('should return error if pattern is missing', () => {
      const params = {
        op: 'search_content_in_folder',
      } as unknown as GrepToolParams;
      expect(grepTool.validateToolParams(params)).toBe(
        `params must have required property 'pattern'`,
      );
    });

    it('should return error for invalid regex pattern', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: '[[',
      };
      expect(grepTool.validateToolParams(params)).toContain(
        'Invalid regular expression pattern',
      );
    });

    it('should return error if folder_path does not exist', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'hello',
        folder_path: 'nonexistent',
      };
      expect(grepTool.validateToolParams(params)).toContain(
        'Folder does not exist',
      );
    });

    it('should return error if folder_path is a file, not a directory', async () => {
      const filePath = path.join(tempRootDir, 'fileA.txt');
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'hello',
        folder_path: filePath,
      };
      expect(grepTool.validateToolParams(params)).toContain(
        `Path is not a directory: ${filePath}`,
      );
    });

    it('should return error if file_path is missing for search_content_in_file', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'hello',
      };
      expect(grepTool.validateToolParams(params)).toContain(
        'file_path is required for search_content_in_file operation',
      );
    });

    it('should return error if file_path does not exist', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'hello',
        file_path: 'nonexistent.txt',
      };
      expect(grepTool.validateToolParams(params)).toContain(
        'File does not exist',
      );
    });

    it('should return error if file_path is a directory, not a file', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'hello',
        file_path: 'sub',
      };
      expect(grepTool.validateToolParams(params)).toContain(
        'Path is not a file',
      );
    });
  });

  describe('execute - search_content_in_folder', () => {
    it('should find matches for a simple pattern in all files', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'world',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 3 matches for pattern "world" in the workspace directory',
      );
      expect(result.llmContent).toContain('File: fileA.txt');
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('L2: second line with world');
      expect(result.llmContent).toContain(
        `File: ${path.join('sub', 'fileC.txt')}`,
      );
      expect(result.llmContent).toContain('L1: another world in sub dir');
      expect(result.returnDisplay).toBe('Found 3 matches');
    });

    it('should find matches in a specific folder_path', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'world',
        folder_path: 'sub',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "world" in path "sub"',
      );
      expect(result.llmContent).toContain('File: fileC.txt'); // Path relative to 'sub'
      expect(result.llmContent).toContain('L1: another world in sub dir');
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should find matches with an include glob', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'hello',
        include: '*.js',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "hello" in the workspace directory (filter: "*.js"):',
      );
      expect(result.llmContent).toContain('File: fileB.js');
      expect(result.llmContent).toContain(
        'L2: function baz() { return "hello"; }',
      );
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should find matches with an include glob and folder_path', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'sub', 'another.js'),
        'const greeting = "hello";',
      );
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'hello',
        folder_path: 'sub',
        include: '*.js',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "hello" in path "sub" (filter: "*.js")',
      );
      expect(result.llmContent).toContain('File: another.js');
      expect(result.llmContent).toContain('L1: const greeting = "hello";');
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should return "No matches found" when pattern does not exist', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'nonexistentpattern',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'No matches found for pattern "nonexistentpattern" in the workspace directory.',
      );
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('should handle regex special characters correctly', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'foo.*bar',
      }; // Matches 'const foo = "bar";'
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "foo.*bar" in the workspace directory:',
      );
      expect(result.llmContent).toContain('File: fileB.js');
      expect(result.llmContent).toContain('L1: const foo = "bar";');
    });

    it('should be case-insensitive by default (JS fallback)', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'HELLO',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 2 matches for pattern "HELLO" in the workspace directory:',
      );
      expect(result.llmContent).toContain('File: fileA.txt');
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('File: fileB.js');
      expect(result.llmContent).toContain(
        'L2: function baz() { return "hello"; }',
      );
    });

    it('should throw an error if params are invalid', async () => {
      const params = {
        op: 'search_content_in_folder',
      } as unknown as GrepToolParams; // Invalid: pattern missing
      expect(() => grepTool.build(params)).toThrow(
        /params must have required property 'pattern'/,
      );
    });

    it('should return a GREP_EXECUTION_ERROR on failure', async () => {
      vi.mocked(glob.globStream).mockRejectedValue(new Error('Glob failed'));
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'hello',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.error?.type).toBe(ToolErrorType.GREP_EXECUTION_ERROR);
      vi.mocked(glob.globStream).mockReset();
    });
  });

  describe('execute - search_content_in_file', () => {
    it('should find matches in a specific file', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'world',
        file_path: 'fileA.txt',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 2 matches for pattern "world" in file "fileA.txt"',
      );
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('L2: second line with world');
      expect(result.returnDisplay).toBe('Found 2 matches');
    });

    it('should find matches in a file within a subdirectory', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'world',
        file_path: path.join('sub', 'fileC.txt'),
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        `Found 1 match for pattern "world" in file "${path.join('sub', 'fileC.txt')}"`,
      );
      expect(result.llmContent).toContain('L1: another world in sub dir');
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should return "No matches found" when pattern does not exist in file', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'nonexistent',
        file_path: 'fileA.txt',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'No matches found for pattern "nonexistent" in file "fileA.txt"',
      );
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('should handle regex patterns in file search', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'foo.*bar',
        file_path: 'fileB.js',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "foo.*bar" in file "fileB.js"',
      );
      expect(result.llmContent).toContain('L1: const foo = "bar";');
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should be case-insensitive in file search', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'HELLO',
        file_path: 'fileA.txt',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "HELLO" in file "fileA.txt"',
      );
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.returnDisplay).toBe('Found 1 match');
    });
  });

  describe('multi-directory workspace', () => {
    it('should search across all workspace directories when no folder_path is specified', async () => {
      // Create additional directory with test files
      const secondDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'grep-tool-second-'),
      );
      await fs.writeFile(
        path.join(secondDir, 'other.txt'),
        'hello from second directory\nworld in second',
      );
      await fs.writeFile(
        path.join(secondDir, 'another.js'),
        'function world() { return "test"; }',
      );

      // Create a mock config with multiple directories
      const multiDirConfig = {
        getTargetDir: () => tempRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(tempRootDir, [secondDir]),
        getFileExclusions: () => ({
          getGlobExcludes: () => [],
        }),
      } as unknown as Config;

      const multiDirGrepTool = new GrepTool(multiDirConfig);
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'world',
      };
      const invocation = multiDirGrepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should find matches in both directories
      expect(result.llmContent).toContain(
        'Found 5 matches for pattern "world"',
      );

      // Matches from first directory
      expect(result.llmContent).toContain('fileA.txt');
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('L2: second line with world');
      expect(result.llmContent).toContain('fileC.txt');
      expect(result.llmContent).toContain('L1: another world in sub dir');

      // Matches from second directory (with directory name prefix)
      const secondDirName = path.basename(secondDir);
      expect(result.llmContent).toContain(
        `File: ${path.join(secondDirName, 'other.txt')}`,
      );
      expect(result.llmContent).toContain('L2: world in second');
      expect(result.llmContent).toContain(
        `File: ${path.join(secondDirName, 'another.js')}`,
      );
      expect(result.llmContent).toContain('L1: function world()');

      // Clean up
      await fs.rm(secondDir, { recursive: true, force: true });
    });

    it('should search only specified folder_path within workspace directories', async () => {
      // Create additional directory
      const secondDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'grep-tool-second-'),
      );
      await fs.mkdir(path.join(secondDir, 'sub'));
      await fs.writeFile(
        path.join(secondDir, 'sub', 'test.txt'),
        'hello from second sub directory',
      );

      // Create a mock config with multiple directories
      const multiDirConfig = {
        getTargetDir: () => tempRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(tempRootDir, [secondDir]),
        getFileExclusions: () => ({
          getGlobExcludes: () => [],
        }),
      } as unknown as Config;

      const multiDirGrepTool = new GrepTool(multiDirConfig);

      // Search only in the 'sub' directory of the first workspace
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'world',
        folder_path: 'sub',
      };
      const invocation = multiDirGrepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should only find matches in the specified sub directory
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "world" in path "sub"',
      );
      expect(result.llmContent).toContain('File: fileC.txt');
      expect(result.llmContent).toContain('L1: another world in sub dir');

      // Should not contain matches from second directory
      expect(result.llmContent).not.toContain('test.txt');

      // Clean up
      await fs.rm(secondDir, { recursive: true, force: true });
    });
  });

  describe('getDescription', () => {
    it('should generate correct description for search_content_in_folder with pattern only', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'testPattern',
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern'");
    });

    it('should generate correct description for search_content_in_folder with pattern and include', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'testPattern',
        include: '*.ts',
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern' in *.ts");
    });

    it('should generate correct description for search_content_in_folder with pattern and folder_path', async () => {
      const dirPath = path.join(tempRootDir, 'src', 'app');
      await fs.mkdir(dirPath, { recursive: true });
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'testPattern',
        folder_path: path.join('src', 'app'),
      };
      const invocation = grepTool.build(params);
      // The path will be relative to the tempRootDir, so we check for containment.
      expect(invocation.getDescription()).toContain("'testPattern' within");
      expect(invocation.getDescription()).toContain(path.join('src', 'app'));
    });

    it('should indicate searching across all workspace directories when no folder_path specified', () => {
      // Create a mock config with multiple directories
      const multiDirConfig = {
        getTargetDir: () => tempRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(tempRootDir, ['/another/dir']),
        getFileExclusions: () => ({
          getGlobExcludes: () => [],
        }),
      } as unknown as Config;

      const multiDirGrepTool = new GrepTool(multiDirConfig);
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'testPattern',
      };
      const invocation = multiDirGrepTool.build(params);
      expect(invocation.getDescription()).toBe(
        "'testPattern' across all workspace directories",
      );
    });

    it('should generate correct description for search_content_in_folder with pattern, include, and folder_path', async () => {
      const dirPath = path.join(tempRootDir, 'src', 'app');
      await fs.mkdir(dirPath, { recursive: true });
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'testPattern',
        include: '*.ts',
        folder_path: path.join('src', 'app'),
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toContain(
        "'testPattern' in *.ts within",
      );
      expect(invocation.getDescription()).toContain(path.join('src', 'app'));
    });

    it('should use ./ for root folder_path in description', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_folder',
        pattern: 'testPattern',
        folder_path: '.',
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern' within ./");
    });

    it('should generate correct description for search_content_in_file', () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'testPattern',
        file_path: 'fileA.txt',
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern' in fileA.txt");
    });

    it('should generate correct description for search_content_in_file with subdirectory', async () => {
      const params: GrepToolParams = {
        op: 'search_content_in_file',
        pattern: 'testPattern',
        file_path: path.join('sub', 'fileC.txt'),
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toContain("'testPattern' in");
      expect(invocation.getDescription()).toContain(
        path.join('sub', 'fileC.txt'),
      );
    });
  });
});
