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
import { registerDirectoryForTracking } from './fileTrackingIntegration.js';

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;

export interface PythonToolParams {
  code: string;
  description?: string;
  timeout?: number;
  workingDirectory?: string;
  requirements?: string[];
  get_guide?: 'excel' | 'basics' | 'error_handling';
}

class PythonToolInvocation extends BaseToolInvocation<
  PythonToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: PythonToolParams,
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
    // Skip confirmation for get_guide requests (read-only operation)
    if (this.params.get_guide) {
      return false;
    }

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
          toolName: 'python',
          stage,
          progress,
          message,
          details,
          timestamp: Date.now(),
        });
      }
    };

    try {
      // Handle guide request - return guide without executing code
      if (this.params.get_guide) {
        const guide = this.getGuideContent(this.params.get_guide);
        return {
          llmContent: guide,
          returnDisplay: `📚 Python Guide: ${this.params.get_guide}`,
        };
      }

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
            // On Windows with PowerShell, use & operator for quoted paths
            const isWindows = process.platform === 'win32';
            const installCommand = isWindows
              ? `& "${embeddedPythonPath}" -m pip install ${packagesToInstall.join(' ')} --quiet`
              : `"${embeddedPythonPath}" -m pip install ${packagesToInstall.join(' ')} --quiet`;

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
        ? `$env:PYTHONIOENCODING='utf-8'; $env:PYTHONLEGACYWINDOWSSTDIO='1'; & "${embeddedPythonPath}" "${scriptPath}"`
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
                toolName: 'python',
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

        // Register directory after successful execution to track current state
        // This ensures Python's own changes are not reported as external changes
        await registerDirectoryForTracking(this.config, workingDir);
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

  private getGuideContent(
    guide: 'excel' | 'basics' | 'error_handling',
  ): string {
    const guides = {
      excel: `# EXCEL OPERATIONS GUIDE

## Library Selection
- **openpyxl** (default): File-based operations, large datasets, data processing
- **xlwings**: Interactive Excel, charts, macros, real-time updates

## Excel Critical Notes
- Excel stores numbers as floats: '027' becomes 27.0 (leading zeros lost)
- Don't rely on expand(), end(), used_range with merged/empty cells - use explicit ranges
- When user specifies column ranges (e.g., "XA to XS"), use them directly
- Always verify modifications: read back and confirm changes succeeded

## Safe Excel Data Comparison
\`\`\`python
def normalize_for_comparison(value):
    """Normalize Excel value for safe comparison"""
    variants = {str(value).strip()}
    try:
        num = float(value)
        variants.update({str(int(num)), str(num)})
    except (ValueError, TypeError):
        pass
    return variants
\`\`\`

## Performance Tips
\`\`\`python
# Batch write for performance
sheet.range('A1').value = data_list  # Single call, not row-by-row

# Explicit ranges (reliable)
sheet.range('XA30:XS31').value  # Don't use expand() with merged cells
\`\`\`

## Common Operations
\`\`\`python
# Read Excel with openpyxl
import openpyxl
wb = openpyxl.load_workbook('file.xlsx')
sheet = wb['Sheet1']
data = sheet['A1:C10']

# Write Excel with openpyxl
sheet['A1'] = 'Hello'
wb.save('file.xlsx')

# Use xlwings for interactive Excel
import xlwings as xw
wb = xw.Book('file.xlsx')
sheet = wb.sheets['Sheet1']
sheet.range('A1').value = [[1, 2], [3, 4]]
wb.save()
\`\`\``,

      basics: `# PYTHON BASICS GUIDE

## Core Guidelines
- Avoid returning large data to LLM (use file operations instead to save tokens)
- Always use UTF-8 encoding for files: open(file, "r", encoding="utf-8")
- Use absolute paths for file operations
- For Windows paths: use double backslashes (C:\\\\path) or raw strings (r"C:\\path")
- Specify requirements: ["pandas", "openpyxl", "matplotlib"] as needed

## File Operations
\`\`\`python
# Read file with UTF-8
with open('/path/to/file.txt', 'r', encoding='utf-8') as f:
    content = f.read()

# Write file with UTF-8
with open('/path/to/file.txt', 'w', encoding='utf-8') as f:
    f.write('Hello World')

# Process large files line by line
with open('large_file.txt', 'r', encoding='utf-8') as f:
    for line in f:
        process(line)
\`\`\`

## Common Libraries Available
- **pandas**: Data analysis and manipulation
- **openpyxl**: Excel file operations
- **xlwings**: Interactive Excel control
- **matplotlib**: Data visualization
- **requests**: HTTP requests
- **beautifulsoup4**: HTML parsing`,

      error_handling: `# ERROR HANDLING STRATEGY

## Two-Strike Rule
1. **First error**: Fix the specific issue
2. **Second same error**: Try COMPLETELY DIFFERENT approach (different library/method)

## Common Issues

### UnicodeEncodeError (Windows)
\`\`\`python
# Always specify UTF-8 encoding
with open(file, 'r', encoding='utf-8') as f:
    content = f.read()
\`\`\`

### Excel Type Mismatches
\`\`\`python
# Excel may return float when you expect string
value = sheet['A1'].value
if value is not None:
    value = str(value).strip()
\`\`\`

### Path Issues (Windows)
\`\`\`python
# Use raw strings or double backslashes
path = r"C:\\Users\\Documents\\file.xlsx"
# or
path = "C:\\\\Users\\\\Documents\\\\file.xlsx"
# or use forward slashes (Python converts them)
path = "C:/Users/Documents/file.xlsx"
\`\`\`

### Import Errors
If a package is not found, specify it in requirements parameter:
\`\`\`json
{
  "code": "import pandas as pd",
  "requirements": ["pandas"]
}
\`\`\``,
    };

    return guides[guide];
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

    // Path structure: packages/core/src/tools/python-tool.ts
    // Go up: src/tools -> src -> core -> packages -> python-3.13.7
    const toolsPath = path.dirname(normalizedPath); // packages/core/dist/src/tools/python-tool.js
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

export class PythonTool extends BaseDeclarativeTool<
  PythonToolParams,
  ToolResult
> {
  static readonly Name: string = 'python';

  private readonly allowlist = new Set<string>();

  constructor(private readonly config: Config) {
    super(
      'python',
      'Python',
      `Execute Python code using embedded Python 3.13.7 environment.

# QUICK GUIDE
- Use UTF-8 encoding for files: open(file, "r", encoding="utf-8")
- Use absolute paths for file operations
- Specify requirements: ["pandas", "openpyxl", "matplotlib"] as needed
- Available libraries: pandas, openpyxl, xlwings, matplotlib, requests, beautifulsoup4

# GET DETAILED GUIDES
When you need detailed guidance, use the \`get_guide\` parameter instead of \`code\`:
- \`get_guide: "excel"\` - Excel operations, library selection, common patterns
- \`get_guide: "basics"\` - Core guidelines, file operations, available libraries
- \`get_guide: "error_handling"\` - Common errors and solutions

This retrieves detailed documentation without consuming tokens in the main description.

`,
      Kind.Execute,
      {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'Python code to execute. Can be multi-line and include imports. IMPORTANT: When working with text/files, always specify UTF-8 encoding (e.g., open(file, "r", encoding="utf-8")) to prevent UnicodeEncodeError on Windows systems. Required when get_guide is not specified.',
          },
          description: {
            type: 'string',
            description:
              'Clear description of what this code will do and why. This description will be shown to the user in the confirmation dialog to help them understand the purpose of the code execution. Should be concise (1-2 sentences) but informative enough for the user to make an informed decision. Required when get_guide is not specified.',
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
          get_guide: {
            type: 'string',
            enum: ['excel', 'basics', 'error_handling'],
            description:
              'Get detailed guide documentation. Use this to retrieve comprehensive guides without code execution: "excel" for Excel operations and best practices, "basics" for core Python guidelines and file operations, "error_handling" for common errors and solutions. When specified, code and description are not required.',
          },
        },
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      true, // canUpdateOutput
    );
  }

  protected createInvocation(
    params: PythonToolParams,
  ): ToolInvocation<PythonToolParams, ToolResult> {
    return new PythonToolInvocation(this.config, params, this.allowlist);
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

    // Path structure: packages/core/src/tools/python-tool.ts
    // Go up: src/tools -> src -> core -> packages -> python-3.13.7
    const toolsPath = path.dirname(normalizedPath); // packages/core/dist/src/tools/python-tool.js
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
