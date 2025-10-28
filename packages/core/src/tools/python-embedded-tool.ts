/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Config } from '../config/config.js';
import type {
  ToolInvocation,
  ToolResult,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
} from './tools.js';
import type { ToolProgressEvent } from '../core/message-types.js';
import { ToolExecutionStage } from '../core/message-types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolConfirmationOutcome,
  Kind,
} from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import type { ShellExecutionConfig } from '../services/shellExecutionService.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import { XlwingsDocTool } from '../tools/xlwings-doc-tool.js';
import { GeminiSearchTool } from '../tools/gemini-search-tool.js';
import { KnowledgeBaseTool } from './knowledge-base-tool.js';

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;

export interface PythonEmbeddedToolParams {
  code: string;
  description?: string;
  timeout?: number;
  workingDirectory?: string;
  requirements?: string[];
}

class PythonEmbeddedToolInvocation extends BaseToolInvocation<
  PythonEmbeddedToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: PythonEmbeddedToolParams,
    private readonly allowlist: Set<string>,
  ) {
    super(params);
  }

  getDescription(): string {
    let description = `Execute Python code`;
    if (this.params.description) {
      description += `: ${this.params.description.replace(/\n/g, ' ')}`;
    }
    if (this.params.requirements?.length) {
      description += ` (requires: ${this.params.requirements.join(', ')})`;
    }
    return description;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // Check if Python execution is already allowed
    if (this.allowlist.has('python_embedded')) {
      return false;
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Python Code Execution',
      command: `python (embedded) -c "${this.params.code}"`,
      rootCommand: 'python_embedded',
      showPythonCode: true, // Show code for direct Python execution
      pythonCode: this.params.code, // Pass the actual code directly
      description: this.params.description, // Pass the description to help user understand the purpose
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.allowlist.add('python_embedded');
        }
      },
    };
    return confirmationDetails;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string | AnsiOutput) => void,
    shellExecutionConfig?: ShellExecutionConfig,
    progressCallback?: (event: ToolProgressEvent) => void,
  ): Promise<ToolResult> {
    const callId = `python_embedded_${Date.now()}`;

    // Helper function to emit progress events
    const emitProgress = (
      stage: ToolExecutionStage,
      progress?: number,
      message?: string,
      details?: Record<string, unknown>,
    ) => {
      if (progressCallback) {
        progressCallback({
          callId,
          toolName: 'python-embedded-tools',
          stage,
          progress,
          message,
          details,
          timestamp: Date.now(),
        });
      }
    };

    try {
      emitProgress(
        ToolExecutionStage.PREPARING,
        0,
        'Initializing Python environment',
      );

      // Get embedded Python path
      const embeddedPythonPath = this.getEmbeddedPythonPath();

      // Verify embedded Python exists
      if (!fs.existsSync(embeddedPythonPath)) {
        emitProgress(
          ToolExecutionStage.FAILED,
          undefined,
          'Embedded Python not found',
        );
        return {
          llmContent: `Embedded Python not found at: ${embeddedPythonPath}`,
          returnDisplay: `❌ Embedded Python not found at: ${embeddedPythonPath}`,
        };
      }

      emitProgress(
        ToolExecutionStage.PREPARING,
        10,
        'Python environment ready',
      );

      // Install requirements if specified
      if (this.params.requirements?.length) {
        emitProgress(
          ToolExecutionStage.INSTALLING_DEPS,
          20,
          `Checking ${this.params.requirements.length} dependencies`,
          { packages: this.params.requirements },
        );

        // Get workspace context for validation
        const workspaceContext = this.config.getWorkspaceContext();
        const workspaceDirectories = workspaceContext.getDirectories();

        // Determine working directory
        let workingDir: string;
        if (this.params.workingDirectory) {
          workingDir = this.params.workingDirectory;
        } else {
          workingDir =
            workspaceDirectories.length > 0
              ? workspaceDirectories[0]
              : this.config.getTargetDir();
        }

        // Validate working directory is within workspace
        if (!workspaceContext.isPathWithinWorkspace(workingDir)) {
          const errorMessage =
            workspaceDirectories.length > 0
              ? `Error: Python working directory "${workingDir}" must be within workspace directories:\n${workspaceDirectories.map((d) => `  - ${d}`).join('\n')}\n\nPlease add the target directory to your workspace first.`
              : `Error: No workspace directories configured. Cannot execute Python tools outside workspace.\n\nDirectory attempted: ${workingDir}`;

          emitProgress(
            ToolExecutionStage.FAILED,
            undefined,
            'Working directory not in workspace',
          );

          return {
            llmContent: errorMessage,
            returnDisplay: `❌ Directory not in workspace: ${workingDir}`,
          };
        }

        // Get site-packages directory path
        const pythonDir = path.dirname(embeddedPythonPath);
        const sitePackagesDir = path.join(pythonDir, 'Lib', 'site-packages');

        // Check which packages need to be installed by checking filesystem directly
        const packagesToInstall: string[] = [];

        for (const pkg of this.params.requirements) {
          const isInstalled = this.checkPackageInstalled(sitePackagesDir, pkg);
          if (!isInstalled) {
            packagesToInstall.push(pkg);
          }
        }

        // Only install packages that are not already installed
        if (packagesToInstall.length > 0) {
          emitProgress(
            ToolExecutionStage.INSTALLING_DEPS,
            30,
            `Installing ${packagesToInstall.length} packages: ${packagesToInstall.join(', ')}`,
            { missingPackages: packagesToInstall },
          );

          if (updateOutput) {
            updateOutput(
              `Installing Python packages: ${packagesToInstall.join(', ')}...\n`,
            );
          }

          try {
            const installCommand = `"${embeddedPythonPath}" -m pip install ${packagesToInstall.join(' ')} --quiet`;

            const { result: installPromise } =
              await ShellExecutionService.execute(
                installCommand,
                workingDir,
                () => {}, // No output callback for install
                signal,
                false, // Don't use NodePty for install
                shellExecutionConfig || {},
              );

            const installResult = await installPromise;

            if (installResult.exitCode !== 0) {
              emitProgress(
                ToolExecutionStage.FAILED,
                undefined,
                'Failed to install dependencies',
              );
              return {
                llmContent: `Failed to install Python requirements: ${installResult.output}`,
                returnDisplay: `❌ Failed to install Python requirements`,
              };
            }

            emitProgress(
              ToolExecutionStage.INSTALLING_DEPS,
              40,
              'Dependencies installed',
            );

            if (updateOutput) {
              updateOutput(`✅ Packages installed successfully\n\n`);
            }
          } catch (installError) {
            return {
              llmContent: `Failed to install Python requirements: ${getErrorMessage(installError)}`,
              returnDisplay: `❌ Failed to install Python requirements`,
            };
          }
        }
        // If all packages already installed, skip silently (no output to save time)
      }

      emitProgress(ToolExecutionStage.EXECUTING, 50, 'Running Python script');

      // Create temporary Python script file
      const tempDir = os.tmpdir();
      const scriptId = crypto.randomUUID();
      const scriptPath = path.join(tempDir, `gemini_python_${scriptId}.py`);

      // Write Python code to temporary file with UTF-8 encoding
      // Wrap output in Base64 to avoid encoding issues on Windows with non-ASCII characters
      // Add line tracing for timeout detection and progress reporting
      const codeWithEncoding = `# -*- coding: utf-8 -*-
import sys
import io
import base64
import json
import traceback
import time

# Force UTF-8 for internal processing
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Progress reporting function
class ProgressTracker:
    def __init__(self):
        self.start_time = time.time()

    def report(self, stage, progress=None, message=None, **kwargs):
        """
        Report execution progress to the application.

        Args:
            stage: Execution stage (e.g., 'loading', 'processing', 'analyzing', 'writing')
            progress: Progress percentage (0-100), optional
            message: Status message describing what's happening
            **kwargs: Additional details (e.g., rows_processed=100, total_rows=500)

        Example:
            report_progress('loading', 10, 'Opening workbooks')
            report_progress('processing', 50, 'Processing data', rows_processed=500, total_rows=1000)
            report_progress('writing', 90, 'Writing results to file')
        """
        event = {
            '__PROGRESS__': True,
            'stage': stage,
            'progress': progress,
            'message': message,
            'details': kwargs,
            'timestamp': time.time(),
            'elapsed': time.time() - self.start_time
        }
        # Use original stderr to bypass our capture
        _original_stderr_write(f"__GEMINI_PROGRESS__{json.dumps(event)}__END__\\n")

_progress = ProgressTracker()
report_progress = _progress.report

# Capture all output
_output_lines = []
_error_lines = []
_original_print = print
_original_stderr_write = sys.stderr.write
_last_executed_line = 0

def print(*args, **kwargs):
    """Capture print output"""
    import io
    str_io = io.StringIO()
    _original_print(*args, file=str_io, **kwargs)
    output = str_io.getvalue()
    _output_lines.append(output)

def stderr_write(text):
    """Capture stderr output (except progress events)"""
    # Don't capture progress events
    if '__GEMINI_PROGRESS__' not in text:
        _error_lines.append(text)
    return len(text)

sys.stderr.write = stderr_write

def _trace_lines(frame, event, arg):
    """Trace function to track last executed line"""
    global _last_executed_line
    if event == 'line' and frame.f_code.co_filename == '<string>':
        _last_executed_line = frame.f_lineno
    return _trace_lines

# Enable line tracing
sys.settrace(_trace_lines)

# Execute user code
_exit_code = 0
_error_line_number = None
_error_context = None
try:
${this.params.code
  .split('\n')
  .map((line) => '    ' + line)
  .join('\n')}
except SystemExit as e:
    _exit_code = e.code if e.code else 0
except Exception as e:
    # Extract detailed error information
    tb_list = traceback.extract_tb(e.__traceback__)

    # Find the frame in user code
    user_code_lines = ${JSON.stringify(this.params.code.split('\n'))}

    for frame in tb_list:
        if frame.filename == '<string>':
            _error_line_number = frame.lineno

            # Get code context (3 lines before and after)
            context_lines = []
            for i in range(max(1, _error_line_number - 3), min(len(user_code_lines) + 1, _error_line_number + 4)):
                marker = ">>> " if i == _error_line_number else "    "
                if i - 1 < len(user_code_lines):
                    context_lines.append(f"{marker}Line {i}: {user_code_lines[i - 1]}")

            _error_context = "\\n".join(context_lines)
            break

    # Format error message with context
    error_header = f"\\n{'='*60}\\n"
    error_header += f"ERROR at Line {_error_line_number}\\n"
    error_header += f"{'='*60}\\n"

    if _error_context:
        error_header += f"\\nCode context:\\n{_error_context}\\n\\n"

    error_header += f"Error type: {type(e).__name__}\\n"
    error_header += f"Error message: {str(e)}\\n"
    error_header += f"{'='*60}\\n\\n"

    _error_lines.append(error_header)
    _error_lines.append("Full traceback:\\n")
    _error_lines.append(traceback.format_exc())
    _exit_code = 1
finally:
    # Disable tracing
    sys.settrace(None)

# Restore original functions
print = _original_print
sys.stderr.write = _original_stderr_write

# Combine output
_final_output = ''.join(_output_lines)
_final_errors = ''.join(_error_lines)

# Output result with special markers
result_data = {
    "stdout": _final_output,
    "stderr": _final_errors,
    "exit_code": _exit_code,
    "error_line": _error_line_number,
    "last_executed_line": _last_executed_line
}

# Encode as JSON then Base64 to avoid any encoding issues
json_str = json.dumps(result_data, ensure_ascii=False)
encoded = base64.b64encode(json_str.encode('utf-8')).decode('ascii')
print(f"__PYTHON_RESULT_BASE64__{encoded}__END__")

sys.exit(_exit_code)`;
      await fs.promises.writeFile(scriptPath, codeWithEncoding, 'utf-8');

      // Prepare execution command with UTF-8 environment settings
      const isWindows = process.platform === 'win32';
      const command = isWindows
        ? `chcp 65001 > nul && set PYTHONIOENCODING=utf-8 && set PYTHONLEGACYWINDOWSSTDIO=1 && "${embeddedPythonPath}" "${scriptPath}"`
        : `PYTHONIOENCODING=utf-8 "${embeddedPythonPath}" "${scriptPath}"`;

      // Set working directory - validate it's within workspace
      const workspaceContext = this.config.getWorkspaceContext();
      const workspaceDirectories = workspaceContext.getDirectories();

      // Determine working directory
      let workingDir: string;
      if (this.params.workingDirectory) {
        workingDir = this.params.workingDirectory;
      } else {
        workingDir =
          workspaceDirectories.length > 0
            ? workspaceDirectories[0]
            : this.config.getTargetDir();
      }

      // Validate working directory is within workspace
      if (!workspaceContext.isPathWithinWorkspace(workingDir)) {
        const errorMessage =
          workspaceDirectories.length > 0
            ? `Error: Python execution directory "${workingDir}" must be within workspace directories:\n${workspaceDirectories.map((d) => `  - ${d}`).join('\n')}\n\nPlease add the target directory to your workspace first.`
            : `Error: No workspace directories configured. Cannot execute Python tools outside workspace.\n\nDirectory attempted: ${workingDir}`;

        emitProgress(
          ToolExecutionStage.FAILED,
          undefined,
          'Working directory not in workspace',
        );

        return {
          llmContent: errorMessage,
          returnDisplay: `❌ Directory not in workspace: ${workingDir}`,
        };
      }

      // Get timeout setting (default 300 seconds)
      const timeoutMs = (this.params.timeout || 300) * 1000;

      // Progress event parser
      const progressParser = (chunk: string): string => {
        const progressRegex = /__GEMINI_PROGRESS__(.+?)__END__/g;
        let match;
        let cleanedChunk = chunk;

        while ((match = progressRegex.exec(chunk)) !== null) {
          try {
            const eventData = JSON.parse(match[1]);
            if (eventData.__PROGRESS__ && progressCallback) {
              // Map Python stage to ToolExecutionStage
              progressCallback({
                callId,
                toolName: 'python-embedded-tools',
                stage: ToolExecutionStage.EXECUTING,
                progress: eventData.progress,
                message: eventData.message || eventData.stage,
                details: {
                  ...eventData.details,
                  pythonStage: eventData.stage,
                  elapsed: eventData.elapsed,
                },
                timestamp: Date.now(),
              });
            }
          } catch (parseError) {
            // Ignore parsing errors
            console.warn('Failed to parse Python progress event:', parseError);
          }
          // Remove progress markers from output
          cleanedChunk = cleanedChunk.replace(match[0], '');
        }

        return cleanedChunk;
      };

      // Execute Python script using ShellExecutionService with timeout
      const { result: pythonPromise } = await ShellExecutionService.execute(
        command,
        workingDir,
        (event) => {
          if (event.type === 'data') {
            // Parse and extract progress events from stderr
            const chunk =
              typeof event.chunk === 'string'
                ? event.chunk
                : event.chunk
                    .map((line) => line.map((token) => token.text).join(''))
                    .join('\n');

            const cleanedChunk = progressParser(chunk);

            // Pass cleaned output to updateOutput callback
            if (updateOutput && cleanedChunk) {
              updateOutput(cleanedChunk);
            }
          }
        },
        signal,
        false, // Don't use NodePty for Python execution
        shellExecutionConfig || {},
      );

      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `Python execution timed out after ${this.params.timeout || 300} seconds`,
            ),
          );
        }, timeoutMs);
      });

      // Race between execution and timeout
      let result;
      try {
        result = await Promise.race([pythonPromise, timeoutPromise]);
      } catch (error) {
        if (error instanceof Error && error.message.includes('timed out')) {
          // Try to get partial result before cleaning up
          let partialOutput = '';
          let lastLine = 0;

          try {
            // Read the script file to try to extract any partial output
            const scriptOutput = await fs.promises.readFile(
              scriptPath,
              'utf-8',
            );
            // Try to parse any output that might have been written
            const match = scriptOutput.match(
              /__PYTHON_RESULT_BASE64__([A-Za-z0-9+/=]+)__END__/,
            );
            if (match) {
              const jsonStr = Buffer.from(match[1], 'base64').toString('utf-8');
              const resultData = JSON.parse(jsonStr);
              lastLine = resultData.last_executed_line || 0;
              if (resultData.stdout) {
                partialOutput = resultData.stdout;
              }
            }
          } catch (_parseError) {
            // Ignore parsing errors
          }

          // Clean up temporary file
          try {
            await fs.promises.unlink(scriptPath);
          } catch (_cleanupError) {
            // Ignore cleanup errors
          }

          // Get code context around the last executed line
          const codeLines = this.params.code.split('\n');
          let contextInfo = '';
          if (lastLine > 0 && lastLine <= codeLines.length) {
            const start = Math.max(1, lastLine - 2);
            const end = Math.min(codeLines.length, lastLine + 2);
            const contextLines = [];
            for (let i = start; i <= end; i++) {
              const marker = i === lastLine ? '>>> ' : '    ';
              contextLines.push(`${marker}Line ${i}: ${codeLines[i - 1]}`);
            }
            contextInfo = `\n\nLast executed line:\n${contextLines.join('\n')}`;
          }

          const timeoutMessage = `❌ Python execution timed out after ${this.params.timeout || 300} seconds.

TIMEOUT DETAILS:
${lastLine > 0 ? `- Last executed line: ${lastLine}` : '- Unable to determine last executed line'}
${partialOutput ? `- Partial output before timeout:\n${partialOutput}` : '- No output captured before timeout'}
${contextInfo}

The script took too long to complete. Consider:
1. Optimizing your code for better performance (check for infinite loops or slow operations)
2. Increasing the timeout parameter if the operation legitimately needs more time
3. Breaking the task into smaller chunks
4. Adding progress indicators with print() statements to track execution`;

          return {
            llmContent: timeoutMessage,
            returnDisplay: `❌ Execution timed out after ${this.params.timeout || 300} seconds at line ${lastLine || 'unknown'}`,
          };
        }

        // Clean up for other errors
        try {
          await fs.promises.unlink(scriptPath);
        } catch (_cleanupError) {
          // Ignore cleanup errors
        }
        throw error;
      }

      emitProgress(
        ToolExecutionStage.PROCESSING,
        90,
        'Processing execution results',
      );

      // Clean up temporary file
      try {
        await fs.promises.unlink(scriptPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
        console.warn('Failed to delete temporary Python script:', cleanupError);
      }

      // Parse output - check for Base64 encoded result
      let output = result.output.trim();
      let actualExitCode = result.exitCode;

      // Check for Base64 encoded result marker
      const base64Match = output.match(
        /__PYTHON_RESULT_BASE64__([A-Za-z0-9+/=]+)__END__/,
      );
      if (base64Match) {
        try {
          // Decode Base64 result
          const base64Data = base64Match[1];
          const jsonStr = Buffer.from(base64Data, 'base64').toString('utf-8');
          const resultData = JSON.parse(jsonStr);

          // Use decoded output
          output = resultData.stdout || '';
          if (resultData.stderr) {
            output = output
              ? `${output}\n${resultData.stderr}`
              : resultData.stderr;
          }
          actualExitCode = resultData.exit_code || 0;
        } catch (decodeError) {
          console.warn('Failed to decode Base64 result:', decodeError);
          // Fall back to raw output
          output = result.output.trim();
        }
      }

      const hasError = actualExitCode !== 0;

      if (hasError) {
        emitProgress(
          ToolExecutionStage.FAILED,
          100,
          `Execution failed (exit code: ${actualExitCode})`,
        );
      } else {
        emitProgress(
          ToolExecutionStage.COMPLETED,
          100,
          'Execution completed successfully',
        );
      }

      const formattedOutput =
        output ||
        (hasError
          ? 'Python script executed with errors (no output)'
          : 'Python script executed successfully (no output)');

      // Add execution summary
      const summary = hasError
        ? `❌ Python execution completed with errors (exit code: ${actualExitCode})`
        : '✅ Python execution completed successfully';

      const finalOutput = `${summary}\n\n${formattedOutput}`;

      return {
        llmContent: finalOutput,
        returnDisplay: finalOutput,
      };
    } catch (error) {
      emitProgress(ToolExecutionStage.FAILED, undefined, 'Execution error');
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Failed to execute Python code: ${errorMessage}`,
        returnDisplay: `❌ Python execution failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Check if a Python package is installed by examining the site-packages directory
   * This is much faster than running pip show because it doesn't spawn a process
   */
  private checkPackageInstalled(
    sitePackagesDir: string,
    packageName: string,
  ): boolean {
    try {
      // Normalize package name (pip uses lowercase with hyphens replaced by underscores for folders)
      const normalizedName = packageName.toLowerCase().replace(/-/g, '_');

      // Check for package directory (e.g., "requests", "openpyxl")
      const packageDir = path.join(sitePackagesDir, normalizedName);
      if (fs.existsSync(packageDir)) {
        return true;
      }

      // Check for .dist-info directory (e.g., "requests-2.31.0.dist-info")
      const items = fs.readdirSync(sitePackagesDir);
      for (const item of items) {
        if (
          item.toLowerCase().startsWith(normalizedName) &&
          item.endsWith('.dist-info')
        ) {
          return true;
        }
      }

      return false;
    } catch (_error) {
      // If we can't check, assume not installed to trigger installation attempt
      return false;
    }
  }

  private getEmbeddedPythonPath(): string {
    // Use import.meta.url to get the current file location
    const currentFileUrl = import.meta.url;
    const currentFilePath = new URL(currentFileUrl).pathname;

    // Convert Windows path format if needed
    const normalizedPath =
      process.platform === 'win32'
        ? currentFilePath.slice(1) // Remove leading slash on Windows
        : currentFilePath;

    // Path structure: packages/core/src/tools/python-embedded-tool.ts
    // Go up: src/tools -> src -> core -> packages -> python-3.13.7
    const toolsPath = path.dirname(normalizedPath); // packages/core/dist/src/tools/python-embedded-tool.js
    const srcPath = path.dirname(toolsPath); // packages/core/dist/src
    const distPath = path.dirname(srcPath); // packages/core/dist
    const corePath = path.dirname(distPath); // packages/core
    const packagesPath = path.dirname(corePath); // packages
    const embeddedPythonPath = path.join(
      packagesPath,
      'python-3.13.7',
      'python.exe',
    );
    return embeddedPythonPath;
  }
}

export class PythonEmbeddedTool extends BaseDeclarativeTool<
  PythonEmbeddedToolParams,
  ToolResult
> {
  static readonly Name: string = 'python-embedded-tools';

  private readonly allowlist = new Set<string>();

  constructor(private readonly config: Config) {
    super(
      'python-embedded-tools',
      'Python Code Execution (Embedded)',
      `Use this tool to execute python code it.
This tool uses an embedded Python 3.13.7 environment to ensure stable and consistent execution across different systems.
# USAGE GUIDELINES
- IMPORTANT: AVOID using python code to obtain large amount of data and return to llm memory, this is inefficient and error-prone, consumes too many tokens, prefer file-based operations and handle data locally with python libraries
- If your code produces errors, try to fix them based on error messages, if you can not resolve, use ${GeminiSearchTool.Name} to search for solutions or examples, if you are still stuck, inform the user about the technical limitations

# PYTHON CODING GUIDELINES
- When performing file-based operations, always use absolute file paths (as instructed in GENERAL GUIDELINES). Always close workbooks after operations to avoid file locks, even if errors occur. Use double backslashes (e.g., C:\\\\path\\\\to\\\\file.xlsx) or raw strings (e.g., r\\"C:\\path\\to\\file.xlsx\\") for Windows paths.
- Use standard libraries where possible to avoid dependency issues
- If external libraries are needed, specify them in the "requirements" parameter when calling the tool (e.g., ["requests", "pandas", "matplotlib"])
- When working with files, always specify UTF-8 encoding (e.g., open(file, "r", encoding="utf-8")) to prevent UnicodeEncodeError on Windows systems
- When handling text output, ensure it is UTF-8 encoded to avoid issues with non-ASCII characters
- For any data processing, consider using pandas for tabular data and matplotlib for visualizations
- When generating plots or images, save them to files and provide the file paths in the output
- When working with dates and times, use the datetime module and be explicit about time zones if relevant
- When making HTTP requests, use the requests library and handle potential exceptions (e.g., timeouts, connection errors)
- When parsing JSON or XML data, use the json or xml.etree.ElementTree modules respectively
- When performing numerical computations, consider using numpy for efficiency
- When working with data files (CSV, Excel), use pandas for easy reading/writing and manipulation
- When automating Excel tasks, prefer xlwings for interaction with open workbooks and advanced features; use openpyxl for file-based operations without needing an open instance
- Always include error handling to manage exceptions gracefully and provide informative messages
- Write clean, readable code with appropriate comments to explain complex logic
- Test code snippets independently to ensure they work as expected before integrating them into larger scripts
- For complex PDF generation or manipulation, consider using PyPDF2 or ReportLab libraries

# EXCEL SPECIFIC GUIDELINES
## Decide which python library to use between xlwings and openpyxl based on the following guidelines:
### When to choose xlwings:
  - User explicitly requests to use xlwings
  - Task involves interacting with an already opened Excel application
  - Task requires advanced Excel features not supported by openpyxl (e.g., charts, shapes, macros)
  - Task requires real-time interaction with Excel (e.g., updating live data, responding to user actions in Excel)
  *NOTICE*: If you're unsure how to use xlwings, or your xlwings code produces errors, refer to ${XlwingsDocTool.Name} for documentation and examples, follow the query examples provided in the tool description to find relevant information quickly
  **CRITICAL xlwings considerations**:
    - **UsedRangeAccuracy:** Be aware that 'sheet.used_range' might sometimes report the entire sheet's maximum range (e.g., 1048576 rows) even if actual data is much less. This can lead to COM errors or performance issues.
    - **Robust Data Boundary Determination:** Methods like 'sheet.used_range', 'expand()', 'end()' are UNRELIABLE with merged cells, empty cells, or complex formatting. When user provides explicit ranges (e.g., "columns A to Z", "rows 1 to 100"), ALWAYS use them directly. If range is unknown, manually scan for non-empty cells or ask user to specify the range.
    - **Data Type Conversion for Comparison:** CRITICAL - Excel stores numbers as float even if displayed as text/integer. Leading zeros are lost ('027' becomes 27.0).
### When to choose openpyxl:
  - As default option when unsure
  - User explicitly requests to use openpyxl
  - Task involves complex data processing, analysis, or visualization that is better handled with pandas/matplotlib
  - Task requires reading/writing large datasets where performance and memory efficiency are critical
  - Task involves creating or modifying Excel files without needing to interact with an open Excel application
  - When xlwings encounters persistent or cryptic errors (e.g., COM errors, attribute errors on chart objects) despite following documentation, consider switching to openpyxl for file-based operations (if interaction with an open instance is not strictly required) or inform the user about the technical limitations and suggest manual intervention in Excel
  *NOTICE*: You may use neither openpyxl nor xlwings, as long as the task can be accomplished with pandas/matplotlib or other Python libraries directly

## GENERAL GUIDELINES
- NEVER assume a worksheet has table headers; NEVER assume there is only one header row, there may be multiple header rows or no headers at all; Ferthermore, there maybe multiple tables and headers in a single worksheet, if necessary, try to identify the correct table by sampling data
- NEVER assume you can write correct python code in one attempt, always use print statement to output helpful information, if errors occur, use these message to iteratively fix your code. If you can not resolve the errors, use ${GeminiSearchTool.Name} to search for solutions or examples, if you are still stuck, inform the user about the technical limitations
- If your python code sucessfully runs and finishes the task as expected, consider use ${KnowledgeBaseTool.Name} to save the code snippet for future reference
- When required to copy data between workbooks, always copy values only, avoid copying formulas or formats to prevent broken references unless explicitly requested
- For data filtering tasks, never assume what user tells you is the exact content in the cells, try to find out unique values in the target column first, then find out what use wants to filter after normalizing data types (e.g., strings vs numbers, leading zeros)
- When writing code for this task, especially with libraries like \`xlwings\` or \`openpyxl\`, you must operate under a 'defensive programming' principle. Do not assume that column names will match perfectly, and do not assume data types are consistent. When comparing cell values for filtering, your code must be robust enough to handle unexpected types. For example, explicitly cast the cell's value to multiple potential types (string, integer, float) and check against all of them to prevent misses due to Excel's implicit type conversions.

## CRITICAL: Verification After Excel Modifications
**MANDATORY: Always verify modifications by re-reading the affected data**

When modifying Excel files (cells, formulas, formats):
1. **Perform the modification** (write, update, delete)
2. **Re-open or re-read the file** to verify changes
3. **Print verification results** to confirm success
4. **Report verified status** to user (e.g., "✓ A1 = 100 (verified)")

Example for openpyxl:
\`\`\`python
# Step 1: Modify
wb = openpyxl.load_workbook('data.xlsx')
ws = wb['Sheet1']
ws['A1'] = 100
wb.save('data.xlsx')

# Step 2: Verify - CRITICAL
wb_verify = openpyxl.load_workbook('data.xlsx')
actual = wb_verify['Sheet1']['A1'].value
print(f"✓ Verified: A1 = {actual}")
wb_verify.close()

# Step 3: Validate
assert actual == 100, f"Verification failed! Expected 100, got {actual}"
\`\`\`

Example for xlwings:
\`\`\`python
# Step 1: Modify
book = xw.Book('data.xlsx')
book.sheets['Sheet1'].range('A1').value = 100
book.save()

# Step 2: Verify - CRITICAL
actual = book.sheets['Sheet1'].range('A1').value
print(f"✓ Verified: A1 = {actual}")

# Step 3: Validate
assert actual == 100, f"Verification failed! Expected 100, got {actual}"
book.close()
\`\`\`

**Skip verification only if**: user explicitly says "don't verify" OR operation is purely cosmetic (colors, fonts) and low-risk

## CRITICAL: Iterative Debugging Strategy
When Python code produces errors, follow this systematic approach:

### 1. First Error - Direct Fix
- Read the error message carefully
- Identify the exact line and issue
- Apply a targeted fix to that specific problem
- Re-run immediately

### 2. Second Error (Same Type) - Change Strategy
- If the SAME type of error occurs again, your approach is fundamentally wrong
- DO NOT try "more robust" variations of the same failed approach
- Instead, try a COMPLETELY DIFFERENT method:
  - If reading data failed: try a different API method or library
  - If conversion failed: try a different data structure or algorithm
  - If range access failed: try explicit coordinates instead of expansion

### 3. Third Attempt - Seek External Help
- If still failing after 2 genuine attempts, use ${GeminiSearchTool.Name}
- Search for specific error messages or documentation
- Look for working examples of similar tasks
- If no solution found, inform user of technical limitations

### Example: Handling xlwings.range() Errors
**WRONG** (repeated failing approach):
\`\`\`python
# Attempt 1: sheet.range('A1').expand('right')
# → Error: NoneType has no len() (merged cells!)

# Attempt 2: sheet.range('A1').expand('right') with None filtering
# → Still fails (same root cause: expand() doesn't handle merged cells)

# Attempt 3: Read 'A1:Z1' then expand
# → Still same error (still using unreliable expand() method)

# Attempt 4-62: Various "more robust" versions of expand()...
# → All fail because they all use the SAME unreliable approach
\`\`\`

**CORRECT** (progressive strategy change):
\`\`\`python
# Attempt 1: sheet.range('A1').expand('right')
# → Error: NoneType has no len() (merged cells/empty cells cause failure)

# Attempt 2: DIFFERENT STRATEGY - Use explicit range from user's specification
# User said "columns XA to XS", so use that directly:
headers = sheet.range('XA30:XS31').value
# → Success! No dependency on cell content or formatting

# Alternative: Use numeric indexes if string reference doesn't work
xa_idx = col_letter_to_index('XA')  # 625
xs_idx = col_letter_to_index('XS')  # 644
headers = sheet.range((30, xa_idx), (31, xs_idx)).value
# → Also succeeds!
\`\`\`

**Key Principle**:
- Each retry should be a DIFFERENT approach, not a variation of the same idea
- expand(), end(), used_range are UNRELIABLE - don't keep trying to "fix" them
- When user gives explicit ranges, USE THEM DIRECTLY

### Example 2: Handling Excel Data Type Mismatches
**WRONG** (ignoring data type issue):
\`\`\`python
# User wants to filter rows where column XR is '027', '211A', '306', or '634'
filter_values = ['027', '211A', '306', '634']

# Attempt 1: Direct comparison
for row in rows:
    if row['XR'] in filter_values:  # Fails! row['XR'] is 27.0, not '027'
        process(row)
# → Found 0 matches (should have found 4!)

# Attempt 2: Same logic, just reformatted
matching_rows = [r for r in rows if r['XR'] in filter_values]
# → Still 0 matches (same problem!)

# Attempt 3-10: Various attempts at string conversion without understanding the issue
\`\`\`

**CORRECT** (understanding Excel's numeric storage):
\`\`\`python
# Understand the problem: Excel stores '027' as number 27.0 (leading zero lost!)
filter_values = ['027', '211A', '306', '634']

# Create normalized filter set with all possible representations
normalized_filters = set()
for val in filter_values:
    normalized_filters.add(val)  # '027', '211A', '306', '634'
    normalized_filters.add(val.lstrip('0') or '0')  # '27', '211A', '306', '634'
    try:
        normalized_filters.add(str(int(val)))  # '27', '306', '634'
        normalized_filters.add(str(float(val)))  # '27.0', '306.0', '634.0'
    except ValueError:
        pass  # '211A' is not numeric, skip

# Now filter with normalized comparison
matching_rows = []
for row in rows:
    cell_str = str(row['XR'] or "").strip()
    if cell_str in normalized_filters:
        matching_rows.append(row)
# → Found 4 matches! (27.0 matches with '027', '211A' matches exactly, etc.)
\`\`\`

**Lesson**: When Excel filtering returns 0 results unexpectedly, check data types first!

## EXCEL COLUMN REFERENCE HANDLING
When users mention column letters like "A", "B", "C", or even "XA", "XB", "XR" in complex sheets:

### For xlwings:
**PREFERRED**: Use explicit column ranges (direct string or numeric indexes):
\`\`\`python
# ✅ BEST: Direct column letter reference with explicit range
sheet.range('XA30:XS31').value  # Read headers from columns XA to XS
sheet.range('XR32').value       # Read specific cell in column XR

# ✅ GOOD: Using numeric column index with col_letter_to_index
xa_idx = col_letter_to_index('XA')  # Returns 625
xs_idx = col_letter_to_index('XS')  # Returns 644
sheet.range((30, xa_idx), (31, xs_idx)).value

# ❌ UNRELIABLE: Methods that depend on cell content/formatting
sheet.range('A1').expand('right')    # Fails with merged cells, empty cells
sheet.range('A1').end('right')       # Unreliable with gaps or merged cells
sheet.used_range                      # May return incorrect range with merged cells
\`\`\`

**CRITICAL**: When user specifies exact columns (like "XA to XS"):
- ALWAYS use explicit range specifications
- NEVER rely on expand(), end(), or used_range methods
- These methods fail with: merged cells, empty cells, hidden rows/columns, or non-contiguous data
\`\`\`

### For openpyxl:
**REQUIRED**: Convert column letters to numeric indexes (openpyxl uses 1-based column numbers):
\`\`\`python
from openpyxl.utils import column_index_from_string, get_column_letter

# Convert letter to number
xa_idx = column_index_from_string('XA')  # Returns 625
# Or use custom function:
def col_letter_to_index(col_letter):
    """Convert Excel column letter to 1-based numeric index.
    Examples: A=1, Z=26, AA=27, XA=625, XR=642, XS=644"""
    col_letter = col_letter.upper()
    index = 0
    for i, char in enumerate(reversed(col_letter)):
        index += (ord(char) - ord('A') + 1) * (26 ** i)
    return index

# Verify the conversion (always validate for critical operations)
assert col_letter_to_index('A') == 1
assert col_letter_to_index('Z') == 26
assert col_letter_to_index('AA') == 27
assert col_letter_to_index('XR') == 642  # Example from task
\`\`\`

**CRITICAL**: When user specifies column ranges like "XA to XS":
- These are Excel column positions (XA is column 625, XS is column 644)
- NEVER assume "A to Z" (26 columns) when user mentions columns beyond Z
- ALWAYS use the exact column range specified by the user

## CRITICAL: xlwings Data Writing Best Practices

### Finding Next Available Row (next_write_row)
**❌ WRONG - Can exceed Excel row limit**:
\`\`\`python
# This can cause next_write_row to reach 1048577 (exceeds Excel's 1048576 limit!)
next_write_row = 7  # Starting row
while dest_sheet.range((next_write_row, 1)).value is not None:
    next_write_row += 1  # Keeps incrementing even with empty rows
# → Result: COM error when next_write_row exceeds Excel's maximum row limit
\`\`\`

**✅ CORRECT - Check starting row and use end('down')**:
\`\`\`python
# Check if the starting row (e.g., row 7) is empty
if dest_sheet.range('A7').value is None:
    next_write_row = 7  # Start from row 7 if it's empty
else:
    # Find the last row with data in column A below row 6
    next_write_row = dest_sheet.range('A6').end('down').row + 1
# → Result: Reliable and efficient, avoids exceeding Excel row limit
\`\`\`

**⚠️ NOTE**: While \`used_range.last_cell.row\` seems convenient, it can be unreliable with merged cells, empty cells, or complex formatting. The method above is more robust.

### Writing Data Efficiently
**❌ WRONG - Row-by-row writing is slow and error-prone**:
\`\`\`python
# This triggers COM interaction for EACH row - very slow for large datasets!
for i, row_data in enumerate(data_to_write):
    dest_sheet.range((next_write_row + i, 1)).value = [row_data]
    # → Each iteration = one COM call = high overhead and error risk
# → Result: Extremely slow for 100+ rows, prone to COM errors
\`\`\`

**✅ CORRECT - Batch write all data at once**:
\`\`\`python
# Prepare data as list of lists (2D array)
data_to_write_formatted = [
    [row[0], row[1], row[2], ...],  # Row 1
    [row[0], row[1], row[2], ...],  # Row 2
    # ... all rows
]

# Calculate target range dimensions
num_rows = len(data_to_write_formatted)
num_cols = len(data_to_write_formatted[0]) if data_to_write_formatted else 0

# Write all data in ONE operation
if data_to_write_formatted and num_cols > 0:
    target_range = dest_sheet.range((next_write_row, 1), (next_write_row + num_rows - 1, num_cols))
    target_range.value = data_to_write_formatted  # Single COM call for all data
    dest_book.save()
# → Result: 100x faster, much lower COM error risk
\`\`\`

### Complete Example: Copying Data Between Workbooks
\`\`\`python
import xlwings as xw

# Open workbooks
source_book = xw.Book('source.xlsx')
dest_book = xw.Book('destination.xlsx')

source_sheet = source_book.sheets['SourceSheet']
dest_sheet = dest_book.sheets['DestSheet']

# ✅ Step 1: Find next available row reliably
if dest_sheet.range('A7').value is None:
    next_write_row = 7
else:
    next_write_row = dest_sheet.range('A6').end('down').row + 1

# ✅ Step 2: Read source data (assuming columns XA to XS, rows 32-200)
source_data = source_sheet.range('XA32:XS200').value

# ✅ Step 3: Filter and prepare data for batch write
filtered_data = []
for row in source_data:
    if row[17] in ['027', '211A', '306', '436']:  # XR is column 18 (0-indexed)
        filtered_data.append(row)

# ✅ Step 4: Batch write all data at once
if filtered_data:
    # Method 1: Define target range explicitly
    num_rows = len(filtered_data)
    num_cols = len(filtered_data[0])
    target_range = dest_sheet.range(
        (next_write_row, 1),
        (next_write_row + num_rows - 1, num_cols)
    )
    target_range.value = filtered_data

    # Method 2: Simpler - assign directly to starting cell (xlwings auto-expands)
    # dest_sheet.cells(next_write_row, 1).value = filtered_data

    dest_book.save()
    print(f"✅ Successfully wrote {num_rows} rows starting at row {next_write_row}")

# ✅ Step 5: Always close workbooks
source_book.close()
dest_book.close()
\`\`\`

### Key Lessons from Real-World Debugging
1. **next_write_row Calculation Error**: Using \`while dest_sheet.range((next_write_row, 1)).value is not None\` can cause \`next_write_row\` to exceed Excel's maximum row limit (1,048,576), resulting in COM errors. **Solution**: Check if the starting row is empty; if not, use \`dest_sheet.range('A6').end('down').row + 1\` to find the next available row. Avoid \`used_range.last_cell.row\` as it can be unreliable with merged cells or complex formatting.

2. **Row-by-Row Writing Performance**: Writing data one row at a time with \`dest_sheet.range((next_write_row + i, 1)).value = [row_data]\` is extremely slow and prone to COM errors for large datasets. **Solution**: Prepare all data as a 2D list and write in a single batch operation with \`target_range.value = data_to_write_formatted\`.

3. **Data Format for Batch Writing**: When using batch write, ensure data is formatted as a list of lists where each inner list represents a complete row: \`[[col1, col2, ...], [col1, col2, ...], ...]\`. Incorrect formatting can cause \`ValueError\` or write data to wrong cells.

## Common xlwings operations
- Open or connect to an existing workbook:
  \`\`\`python
  import xlwings as xw
  import os

  # Set workbook variable
  file_path = 'file_path.xlsx'
  book = None

  try:
    # Iterate through Excel instances and get book  
    for app in xw.apps:
        for wb in app.books:
            if wb.name == file_path:
                # Found the workbook by name
                book = wb
                break
            if wb.name == os.path.basename(file_path):
                # Found the open workbook by base name
                book = wb
                break
            if wb.name == os.path.splitext(os.path.basename(file_path))[0]:
                # Found the open workbook by name without extension
                book = wb
                break
            if wb.fullname == file_path:
                # Found the open workbook by full path
                book = wb
                break
    # If not found, open it
    if book is None:
        book = xw.Book(file_path)
  except Exception as e:
    # Handle exceptions (e.g., file not found, permission issues)
  finally:
    # Always close workbook if it was opened by this code
    if book:
        book.close()
  \`\`\`

- Get used range and read data:
  \`\`\`python
  # Get used range (actual data area)
  used_range = sheet.used_range
  if used_range:
      last_row = used_range.last_cell.row
      last_col = used_range.last_cell.column

      # CRITICAL: Don't use .options(pd.DataFrame, header=None) - causes TypeError
      # Instead, read as 2D array first, then convert to DataFrame
      data = sheet.range((1, 1), (last_row, last_col)).value
      df = pd.DataFrame(data)
  \`\`\`

- When on a file-based operation, avoid alerts/popups:
  \`\`\`python
  app = App()
  with app.properties(display_alerts=False):
      # do stuff
  \`\`\`

- Chart title:
  \`\`\`python
  chart.api.HasTitle = True
  chart.api.ChartTitle.Text = "Title"  # Chart title
  chart.api.Axes(1).HasTitle = True  # X axis
  chart.api.Axes(1).AxisTitle.Text = "X Axis Title"
  chart.api.Axes(2).HasTitle = True  # Y axis
  chart.api.Axes(2).AxisTitle.Text = "Y Axis Title"
  \`\`\`

- Cell value comparison and filtering:
  \`\`\`python
  # CRITICAL: Excel stores numbers as float, even if displayed as text or integer
  # "027" in Excel might be read as 27.0 or 27 (leading zero lost!)
  # "211A" stays as string (contains non-numeric character)

  # ❌ WRONG: Direct comparison fails with type mismatch
  filter_values = ['027', '211A', '306', '634']
  if cell.value in filter_values:  # Fails if cell.value is 27.0 or 27
      # do something

  # ✅ CORRECT: Normalize both sides to strings for comparison
  filter_values = ['027', '211A', '306', '634']
  cell_str = str(cell.value or "").strip()

  # Handle numeric values that might have lost leading zeros
  if cell_str in filter_values:
      # Exact match (works for '211A', '634')
      matched = True
  elif cell_str.replace('.0', '') in filter_values:
      # Match '27.0' -> '27' -> '027'? No, this won't work!
      pass

  # ✅ BEST: Convert all filter values to possible formats
  # Create a set of all possible representations
  normalized_filters = set()
  for val in filter_values:
      normalized_filters.add(val)  # Original: '027', '211A'
      normalized_filters.add(val.lstrip('0'))  # Remove leading zeros: '27', '211A'
      try:
          # Add numeric representations
          normalized_filters.add(str(int(val)))  # '027' -> '27'
          normalized_filters.add(str(float(val)))  # '027' -> '27.0'
      except ValueError:
          pass  # Skip non-numeric values like '211A'

  # Now compare
  cell_str = str(cell.value or "").strip()
  if cell_str in normalized_filters:
      # Matches: 27, 27.0, '27', '027' all match with filter '027'
      matched = True

  # ✅ ALTERNATIVE: Compare numeric values when possible
  for filter_val in filter_values:
      cell_str = str(cell.value or "").strip()
      # Try exact string match first
      if cell_str == filter_val:
          matched = True
          break
      # Try numeric comparison (handles 27.0 == 27 == '027')
      try:
          if float(cell_str) == float(filter_val):
              matched = True
              break
      except (ValueError, TypeError):
          pass  # Not a number, skip numeric comparison

  # For other comparison scenarios:
  # For pure numeric comparison
  if float(cell.value) == 42.0:
      # Works for 42, 42.0, '42', '42.0'
      pass

  # For string comparison (case-insensitive)
  if str(cell.value or "").strip().lower() == "target":
      # Safe for any cell value including None
      pass
  \`\`\`
`,
      Kind.Execute,
      {
        type: 'object',
        required: ['code', 'description'],
        properties: {
          code: {
            type: 'string',
            description:
              'Python code to execute. Can be multi-line and include imports. IMPORTANT: When working with text/files, always specify UTF-8 encoding (e.g., open(file, "r", encoding="utf-8")) to prevent UnicodeEncodeError on Windows systems.',
          },
          description: {
            type: 'string',
            description:
              'REQUIRED: Clear description of what this code will do and why. This description will be shown to the user in the confirmation dialog to help them understand the purpose of the code execution. Should be concise (1-2 sentences) but informative enough for the user to make an informed decision.',
          },
          timeout: {
            type: 'number',
            description: 'Execution timeout in seconds (default: 300)',
            minimum: 1,
            maximum: 300,
          },
          workingDirectory: {
            type: 'string',
            description:
              'Working directory for script execution (default: current target directory)',
          },
          requirements: {
            type: 'array',
            items: { type: 'string' },
            description:
              'List of Python packages to install before execution (e.g., ["requests", "pandas", "matplotlib"])',
          },
        },
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      true, // canUpdateOutput
    );
  }

  protected createInvocation(
    params: PythonEmbeddedToolParams,
  ): ToolInvocation<PythonEmbeddedToolParams, ToolResult> {
    return new PythonEmbeddedToolInvocation(
      this.config,
      params,
      this.allowlist,
    );
  }

  private getPythonPathStatic(): string {
    // Use import.meta.url to get the current file location
    const currentFileUrl = import.meta.url;
    const currentFilePath = new URL(currentFileUrl).pathname;

    // Convert Windows path format if needed
    const normalizedPath =
      process.platform === 'win32'
        ? currentFilePath.slice(1) // Remove leading slash on Windows
        : currentFilePath;

    // Path structure: packages/core/src/tools/python-embedded-tool.ts
    // Go up: src/tools -> src -> core -> packages -> python-3.13.7
    const toolsPath = path.dirname(normalizedPath); // packages/core/dist/src/tools/python-embedded-tool.js
    const srcPath = path.dirname(toolsPath); // packages/core/dist/src
    const distPath = path.dirname(srcPath); // packages/core/dist
    const corePath = path.dirname(distPath); // packages/core
    const packagesPath = path.dirname(corePath); // packages
    const embeddedPythonPath = path.join(
      packagesPath,
      'python-3.13.7',
      'python.exe',
    );
    return embeddedPythonPath;
  }

  /**
   * Get information about the embedded Python environment
   */
  async getEnvironmentInfo(): Promise<{
    pythonPath: string;
    version: string;
    available: boolean;
  }> {
    try {
      // Use the same path resolution as the private method
      const embeddedPythonPath = this.getPythonPathStatic();

      const available = fs.existsSync(embeddedPythonPath);

      if (available) {
        // Get version info
        try {
          const { result: versionPromise } =
            await ShellExecutionService.execute(
              `"${embeddedPythonPath}" --version`,
              process.cwd(),
              () => {},
              new AbortController().signal,
              false,
              {},
            );
          const result = await versionPromise;

          return {
            pythonPath: embeddedPythonPath,
            version: result.output?.trim() || 'Unknown',
            available: true,
          };
        } catch (error) {
          return {
            pythonPath: embeddedPythonPath,
            version: 'Error getting version ' + getErrorMessage(error),
            available: true, // File exists but version check failed
          };
        }
      }

      return {
        pythonPath: embeddedPythonPath,
        version: 'Not available',
        available: false,
      };
    } catch (error) {
      return {
        pythonPath: 'Unknown',
        version: 'Error getting version ' + getErrorMessage(error),
        available: false,
      };
    }
  }
}
