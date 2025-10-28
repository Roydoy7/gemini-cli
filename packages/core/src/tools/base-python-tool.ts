/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../config/config.js';
import type {
  ToolInvocation,
  ToolResult,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolConfirmationOutcome,
  Kind,
} from './tools.js';
import {
  ToolExecutionStage,
  type ToolProgressEvent,
} from '../core/message-types.js';
import { getErrorMessage } from '../utils/errors.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import type { ShellExecutionConfig } from '../services/shellExecutionService.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';

interface PythonOperationParams {
  /** Operation type */
  op?: string;
}

export abstract class BasePythonTool<
  TParams extends PythonOperationParams,
  TResult extends ToolResult,
> extends BaseDeclarativeTool<TParams, TResult> {
  private readonly allowlist = new Set<string>();

  /**
   * Whether to show Python code in confirmation dialog.
   * Override in subclasses to control code visibility.
   * Default: false (hide code for high-level tool operations)
   */
  protected readonly showPythonCode: boolean = false;

  constructor(
    name: string,
    displayName: string,
    description: string,
    protected readonly defaultRequirements: string[],
    parameterSchema: unknown,
    protected readonly config: Config,
    isOutputMarkdown: boolean = true,
    canUpdateOutput: boolean = false,
  ) {
    super(
      name,
      displayName,
      description,
      Kind.Execute,
      parameterSchema,
      isOutputMarkdown,
      canUpdateOutput,
    );
  }

  protected createInvocation(
    params: TParams,
  ): ToolInvocation<TParams, TResult> {
    return new BasePythonToolInvocation(
      this,
      params,
      this.config,
      this.allowlist,
      this.getRequirements(params),
    );
  }

  /**
   * Generate Python code for the specific tool operation
   */
  protected abstract generatePythonCode(params: TParams): string;

  /**
   * Parse the Python execution result into the expected tool result
   */
  protected abstract parseResult(
    pythonOutput: string,
    params: TParams,
  ): TResult;

  /**
   * Get the requirements for this specific tool execution
   */
  protected getRequirements(_params: TParams): string[] {
    return this.defaultRequirements;
  }

  /**
   * Determine if this tool requires confirmation before execution
   * Override this method in subclasses to skip confirmation for safe operations
   */
  protected requiresConfirmation(_params: TParams): boolean {
    return true;
  }

  /**
   * Get the embedded Python path (same logic as PythonEmbeddedTool)
   */
  protected getEmbeddedPythonPath(): string {
    const currentFileUrl = import.meta.url;
    const currentFilePath = new URL(currentFileUrl).pathname;

    const normalizedPath =
      process.platform === 'win32' ? currentFilePath.slice(1) : currentFilePath;

    const toolsPath = path.dirname(normalizedPath);
    const srcPath = path.dirname(toolsPath);
    const distPath = path.dirname(srcPath);
    const corePath = path.dirname(distPath);
    const packagesPath = path.dirname(corePath);

    // Try the calculated path first
    let embeddedPythonPath = path.join(
      packagesPath,
      'python-3.13.7',
      'python.exe',
    );

    // If not found, try relative to current working directory (for test environment)
    if (!fs.existsSync(embeddedPythonPath)) {
      embeddedPythonPath = path.join(
        process.cwd(),
        'packages',
        'python-3.13.7',
        'python.exe',
      );
    }

    // If still not found, try from project root
    if (!fs.existsSync(embeddedPythonPath)) {
      const projectRoot = process.cwd().includes('packages')
        ? path.join(process.cwd(), '..', '..')
        : process.cwd();
      embeddedPythonPath = path.join(
        projectRoot,
        'packages',
        'python-3.13.7',
        'python.exe',
      );
    }

    return embeddedPythonPath;
  }
}

class BasePythonToolInvocation<
  TParams extends PythonOperationParams,
  TResult extends ToolResult,
> extends BaseToolInvocation<TParams, TResult> {
  constructor(
    private readonly tool: BasePythonTool<TParams, TResult>,
    params: TParams,
    private readonly config: Config,
    private readonly allowlist: Set<string>,
    private readonly requirements: string[],
  ) {
    super(params);
  }

  override getDescription(): string {
    const pythonCode = this.tool['generatePythonCode'](this.params);
    let description = `Execute Python code for ${this.tool.displayName}`;

    const codePreview =
      pythonCode.length > 200 ? pythonCode.slice(0, 200) + '...' : pythonCode;

    if (codePreview.includes('import')) {
      const imports = codePreview.match(/^import .+|^from .+ import .+/gm);
      if (imports) {
        description += ` (imports: ${imports.map((i) => i.split(' ')[1]).join(', ')})`;
      }
    }

    return description;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // Check if tool requires confirmation
    if (!this.tool['requiresConfirmation'](this.params)) {
      return false;
    }

    // Check if Python execution is already allowed
    const rootCommand = `${this.tool.name}_python`;
    if (this.allowlist.has(rootCommand)) {
      return false;
    }

    const pythonCode = this.tool['generatePythonCode'](this.params);

    const requirements = this.requirements;
    const requirementsStr =
      requirements.length > 0 ? ` (requires: ${requirements.join(', ')})` : '';

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: `Confirm ${this.tool.displayName} Execution`,
      command: `python ${this.tool.name}${requirementsStr}\n\n${pythonCode}`,
      rootCommand,
      showPythonCode: this.tool['showPythonCode'], // Use tool's showPythonCode setting
      pythonCode, // Pass the actual code directly
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.allowlist.add(rootCommand);
        }
      },
    };

    return confirmationDetails;
  }

  override async execute(
    signal: AbortSignal,
    updateOutput?: (output: string | AnsiOutput) => void,
    shellExecutionConfig?: ShellExecutionConfig,
    progressCallback?: (event: ToolProgressEvent) => void,
  ): Promise<TResult> {
    const callId = `${this.tool.name}_${Date.now()}`;

    const emitProgress = (
      stage: ToolExecutionStage,
      progress?: number,
      message?: string,
      details?: Record<string, unknown>,
    ) => {
      if (progressCallback) {
        progressCallback({
          callId,
          toolName: this.tool.name,
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
      const embeddedPythonPath = this.tool['getEmbeddedPythonPath']();

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
        } as TResult;
      }

      emitProgress(
        ToolExecutionStage.PREPARING,
        10,
        'Python environment ready',
      );

      // Get requirements for this execution
      const requirements = this.requirements;

      // Check and install requirements if specified
      if (requirements.length > 0) {
        emitProgress(
          ToolExecutionStage.INSTALLING_DEPS,
          20,
          `Checking ${requirements.length} dependencies`,
          { packages: requirements },
        );

        // Check which packages need to be installed
        // For packages with extras (e.g., 'markitdown[pdf,docx]'), always install to ensure
        // extras dependencies are present
        const packagesToInstall: string[] = [];

        for (const requirement of requirements) {
          const hasExtras = requirement.includes('[');

          // For packages with extras, always install them to ensure optional dependencies
          // are present. This is because pip doesn't provide an easy way to check if
          // a package was installed with specific extras.
          if (hasExtras) {
            packagesToInstall.push(requirement);
            continue;
          }

          // For packages without extras, check if already installed
          try {
            const basePackage = requirement.split('[')[0];
            // On Windows with PowerShell, use & operator for quoted paths
            const isWindows = process.platform === 'win32';
            const checkCommand = isWindows
              ? `& "${embeddedPythonPath}" -m pip show "${basePackage}"`
              : `"${embeddedPythonPath}" -m pip show "${basePackage}"`;

            // Get workspace context for validation
            const workspaceContext = this.config.getWorkspaceContext();
            const workspaceDirectories = workspaceContext.getDirectories();
            const checkWorkingDir =
              workspaceDirectories.length > 0
                ? workspaceDirectories[0]
                : this.config.getTargetDir();

            const { result: checkPromise } =
              await ShellExecutionService.execute(
                checkCommand,
                checkWorkingDir,
                () => {},
                signal,
                false,
                shellExecutionConfig || {},
              );
            const checkResult = await checkPromise;

            // If pip show fails or package is not found, add to packages to install
            if (checkResult.exitCode !== 0) {
              packagesToInstall.push(requirement);
            }
          } catch {
            // If check fails, assume package needs installation
            packagesToInstall.push(requirement);
          }
        }

        const missingPackages = packagesToInstall;

        // Only install missing packages
        if (missingPackages.length > 0) {
          emitProgress(
            ToolExecutionStage.INSTALLING_DEPS,
            30,
            `Installing ${missingPackages.length} packages: ${missingPackages.join(', ')}`,
            { missingPackages },
          );

          if (updateOutput) {
            updateOutput(
              `Installing missing Python packages: ${missingPackages.join(', ')}...\\n`,
            );
          }

          try {
            // On Windows with PowerShell, use & operator for quoted paths
            // On Unix, quotes are sufficient
            const isWindows = process.platform === 'win32';
            const installCommand = isWindows
              ? `& "${embeddedPythonPath}" -m pip install ${missingPackages.join(' ')} --quiet`
              : `"${embeddedPythonPath}" -m pip install ${missingPackages.join(' ')} --quiet`;

            // Get workspace context for validation
            const workspaceContext = this.config.getWorkspaceContext();
            const workspaceDirectories = workspaceContext.getDirectories();
            const installWorkingDir =
              workspaceDirectories.length > 0
                ? workspaceDirectories[0]
                : this.config.getTargetDir();

            const { result: installPromise } =
              await ShellExecutionService.execute(
                installCommand,
                installWorkingDir,
                () => {},
                signal,
                false,
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
              } as TResult;
            }

            emitProgress(
              ToolExecutionStage.INSTALLING_DEPS,
              50,
              'Dependencies installed successfully',
            );

            if (updateOutput) {
              updateOutput(`✅ Packages installed successfully\\n\\n`);
            }
          } catch (installError) {
            emitProgress(
              ToolExecutionStage.FAILED,
              undefined,
              'Failed to install dependencies',
            );
            return {
              llmContent: `Failed to install Python requirements: ${getErrorMessage(installError)}`,
              returnDisplay: `❌ Failed to install Python requirements`,
            } as TResult;
          }
        } else {
          emitProgress(
            ToolExecutionStage.INSTALLING_DEPS,
            50,
            'All required packages already installed',
          );
          if (updateOutput) {
            updateOutput(`✅ All required packages already installed\\n\\n`);
          }
        }
      }

      // Generate and execute Python code
      emitProgress(
        ToolExecutionStage.EXECUTING,
        60,
        'Generating Python script',
      );
      const pythonCode = this.tool['generatePythonCode'](this.params);

      // Create temporary Python script file
      const tempDir = os.tmpdir();
      const timestamp = Date.now();
      const operation = this.params.op || 'unknown';
      const scriptPath = path.join(
        tempDir,
        `${this.tool.name}_${operation}_${timestamp}.py`,
      );

      emitProgress(ToolExecutionStage.EXECUTING, 65, 'Preparing Python script');
      // Write Python code to temporary file with UTF-8 encoding and progress protocol
      const codeWithEncoding = `# -*- coding: utf-8 -*-
import sys
import io
import base64
import json
import time

# Force UTF-8 for internal processing
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

# Progress reporting function
class ProgressTracker:
    def __init__(self):
        self.start_time = time.time()

    def report(self, stage, progress=None, message=None, **kwargs):
        """
        Report execution progress to Node.js

        Args:
            stage: Execution stage (e.g., 'loading', 'processing', 'analyzing')
            progress: Progress percentage (0-100)
            message: Status message
            **kwargs: Additional details
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
        print(f"__GEMINI_PROGRESS__{json.dumps(event)}__END__", file=sys.stderr, flush=True)

_progress = ProgressTracker()
report_progress = _progress.report

# Capture the original print function
_original_print = print
_output_lines = []

# Override print to capture output
def print(*args, **kwargs):
    # Convert args to string and capture
    line = ' '.join(str(arg) for arg in args)
    if kwargs.get('end', '\\n') == '\\n':
        line += '\\n'
    _output_lines.append(line)

# Execute the main tool code
try:
${pythonCode
  .split('\n')
  .map((line) => '    ' + line)
  .join('\n')}
except Exception as e:
    import traceback
    error_output = f"Error: {str(e)}\\n{traceback.format_exc()}"
    _output_lines.append(error_output)
    report_progress('failed', message=str(e))

# Restore original print
print = _original_print

# Combine all captured output
final_output = ''.join(_output_lines)

# Output result with Base64 encoding to handle Chinese characters
if final_output.strip():
    # Encode as Base64 to avoid any encoding issues with Chinese characters
    encoded = base64.b64encode(final_output.encode('utf-8')).decode('ascii')
    print(f"__TOOL_RESULT_BASE64__{encoded}__END__")
else:
    print("__TOOL_RESULT_BASE64____END__")
`;
      await fs.promises.writeFile(scriptPath, codeWithEncoding, 'utf-8');

      // Prepare execution command with UTF-8 environment settings
      const isWindows = process.platform === 'win32';
      const command = isWindows
        ? `$env:PYTHONIOENCODING='utf-8'; $env:PYTHONLEGACYWINDOWSSTDIO='1'; & "${embeddedPythonPath}" "${scriptPath}"`
        : `PYTHONIOENCODING=utf-8 "${embeddedPythonPath}" "${scriptPath}"`;

      // Set working directory - validate it's within workspace
      const workspaceContext = this.config.getWorkspaceContext();
      const workspaceDirectories = workspaceContext.getDirectories();

      // Use first workspace directory or targetDir as working directory
      const workingDir =
        workspaceDirectories.length > 0
          ? workspaceDirectories[0]
          : this.config.getTargetDir();

      // Security Check: Ensure working directory is within workspace boundaries
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
        } as TResult;
      }

      emitProgress(ToolExecutionStage.EXECUTING, 70, 'Running Python script');

      // Progress parser for Python stdout/stderr
      const progressParser = (output: string): string => {
        const progressRegex = /__GEMINI_PROGRESS__(\{.*?\})__END__/g;
        let match;
        let cleanedOutput = output;

        while ((match = progressRegex.exec(output)) !== null) {
          try {
            const eventData = JSON.parse(match[1]);

            if (eventData.__PROGRESS__ && progressCallback) {
              // Map Python stage to ToolExecutionStage
              const stage = this.mapPythonStageToToolStage(eventData.stage);

              progressCallback({
                callId,
                toolName: this.tool.name,
                stage,
                progress: eventData.progress,
                message: eventData.message,
                details: eventData.details,
                timestamp: Date.now(),
              });
            }
          } catch {
            // Ignore parse errors for progress events
          }
        }

        // Remove progress markers from output
        cleanedOutput = output.replace(progressRegex, '');
        return cleanedOutput;
      };

      // Execute Python script
      const { result: pythonPromise } = await ShellExecutionService.execute(
        command,
        workingDir,
        (event) => {
          if (event.type === 'data') {
            // Handle both string and AnsiOutput types
            let chunk: string;
            if (typeof event.chunk === 'string') {
              chunk = event.chunk;
            } else {
              // AnsiOutput is AnsiLine[] (array of arrays of tokens)
              // Convert to string for progress parsing
              chunk = event.chunk
                .map((line) => line.map((token) => token.text).join(''))
                .join('\n');
            }

            // Parse and extract progress events
            const cleanedChunk = progressParser(chunk);

            // Pass cleaned output to updateOutput callback
            if (updateOutput && cleanedChunk) {
              updateOutput(cleanedChunk);
            }
          }
        },
        signal,
        false,
        shellExecutionConfig || {},
      );

      const result = await pythonPromise;

      emitProgress(ToolExecutionStage.PROCESSING, 90, 'Processing results');

      // Clean up temporary file
      // COMMENTED OUT FOR DEBUGGING - DO NOT COMMIT
      // try {
      //   await fs.promises.unlink(scriptPath);
      // } catch (cleanupError) {
      //   console.warn('Failed to delete temporary Python script:', cleanupError);
      // }
      console.log('DEBUG: Temporary Python script saved at:', scriptPath);

      // Parse output - check for Base64 encoded result to handle Chinese characters
      let finalOutput = result.output.trim();

      // Check for Base64 encoded result marker
      const base64Match = finalOutput.match(
        /__TOOL_RESULT_BASE64__([A-Za-z0-9+/=]*)__END__/,
      );
      if (base64Match) {
        try {
          // Decode Base64 result if present
          const base64Data = base64Match[1];
          if (base64Data) {
            finalOutput = Buffer.from(base64Data, 'base64').toString('utf-8');
          } else {
            finalOutput = '';
          }
        } catch (decodeError) {
          console.warn('Failed to decode Base64 result:', decodeError);
          // Fall back to raw output
          finalOutput = result.output.trim();
        }
      }

      // Parse the Python output into the expected tool result format
      const parsedResult = this.tool['parseResult'](finalOutput, this.params);

      emitProgress(
        ToolExecutionStage.COMPLETED,
        100,
        'Execution completed successfully',
      );

      return parsedResult;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      emitProgress(
        ToolExecutionStage.FAILED,
        undefined,
        `Execution failed: ${errorMessage}`,
      );
      return {
        llmContent: `Failed to execute ${this.tool.name}: ${errorMessage}`,
        returnDisplay: `❌ ${this.tool.displayName} failed: ${errorMessage}`,
      } as TResult;
    }
  }

  private mapPythonStageToToolStage(pythonStage: string): ToolExecutionStage {
    const stageMap: Record<string, ToolExecutionStage> = {
      loading: ToolExecutionStage.PREPARING,
      cleaning: ToolExecutionStage.PROCESSING,
      analyzing: ToolExecutionStage.EXECUTING,
      processing: ToolExecutionStage.PROCESSING,
      reporting: ToolExecutionStage.PROCESSING,
      completed: ToolExecutionStage.COMPLETED,
      failed: ToolExecutionStage.FAILED,
    };

    return stageMap[pythonStage] || ToolExecutionStage.EXECUTING;
  }
}
