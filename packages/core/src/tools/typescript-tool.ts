/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
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
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import { transpile, type TranspileOptions } from 'typescript';
import { registerDirectoryForTracking } from './fileTrackingIntegration.js';

export interface TypeScriptToolParams {
  code: string;
  description?: string;
  timeout?: number;
  workingDirectory?: string;
  executionMode?: 'vm' | 'sandbox';
}

class TypeScriptToolInvocation extends BaseToolInvocation<
  TypeScriptToolParams,
  ToolResult
> {
  constructor(
    params: TypeScriptToolParams,
    private readonly allowlist: Set<string>,
    private readonly config: Config,
  ) {
    super(params);
  }

  getDescription(): string {
    let description = `Execute TypeScript code`;
    if (this.params.description) {
      description += `: ${this.params.description.replace(/\n/g, ' ')}`;
    }
    return description;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // Check if TypeScript execution is already allowed
    if (this.allowlist.has('typescript_embedded')) {
      return false;
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm TypeScript Code Execution',
      command: `typescript (Node.js VM) -c "${this.params.code}"`,
      rootCommand: 'typescript_embedded',
      showPythonCode: false,
      pythonCode: this.params.code,
      description: this.params.description,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.allowlist.add('typescript_embedded');
        }
      },
    };
    return confirmationDetails;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string | AnsiOutput) => void,
    _shellExecutionConfig?: unknown,
    progressCallback?: (event: ToolProgressEvent) => void,
  ): Promise<ToolResult> {
    const callId = `typescript_embedded_${Date.now()}`;

    const emitProgress = (
      stage: ToolExecutionStage,
      progress?: number,
      message?: string,
      details?: Record<string, unknown>,
    ) => {
      if (progressCallback) {
        progressCallback({
          callId,
          toolName: 'typescript',
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
        'Initializing TypeScript environment',
      );

      // Determine execution mode (default: vm)
      const executionMode = this.params.executionMode || 'vm';

      if (executionMode === 'sandbox') {
        // TODO: Integrate with existing Docker/Podman sandbox
        return await this.executeInSandbox(signal, emitProgress, updateOutput);
      } else {
        return await this.executeInVm(signal, emitProgress, updateOutput);
      }
    } catch (error) {
      emitProgress(ToolExecutionStage.FAILED, undefined, 'Execution error');
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Failed to execute TypeScript code: ${errorMessage}`,
        returnDisplay: `❌ TypeScript execution failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Execute TypeScript code in Node.js VM (fast mode)
   */
  private async executeInVm(
    signal: AbortSignal,
    emitProgress: (
      stage: ToolExecutionStage,
      progress?: number,
      message?: string,
      details?: Record<string, unknown>,
    ) => void,
    updateOutput?: (output: string | AnsiOutput) => void,
  ): Promise<ToolResult> {
    emitProgress(ToolExecutionStage.PREPARING, 10, 'Transpiling TypeScript');

    // Step 1: Transpile TypeScript to JavaScript
    const jsCode = this.transpileTypeScript(this.params.code);

    emitProgress(ToolExecutionStage.PREPARING, 20, 'Transforming imports');

    // Step 2: Transform MCP imports
    const transformedCode = this.transformMcpImports(jsCode);

    emitProgress(
      ToolExecutionStage.EXECUTING,
      30,
      'Setting up execution environment',
    );

    // Step 3: Prepare sandbox context with progress tracking
    const output: string[] = [];
    const errors: string[] = [];

    const sandbox = this.createSandboxContext(output, errors, updateOutput);

    emitProgress(ToolExecutionStage.EXECUTING, 50, 'Running TypeScript code');

    // Step 4: Execute in VM with timeout
    const timeoutMs = (this.params.timeout || 60) * 1000;

    try {
      const context = vm.createContext(sandbox);
      const script = new vm.Script(
        `(async () => {
${transformedCode
  .split('\n')
  .map((line) => '  ' + line)
  .join('\n')}
})()`,
        {
          filename: 'typescript-mcp-code.js',
        },
      );

      // Check for abort signal
      if (signal.aborted) {
        throw new Error('Execution aborted by user');
      }

      emitProgress(ToolExecutionStage.EXECUTING, 70, 'Executing code');

      await script.runInContext(context, {
        timeout: timeoutMs,
      });

      emitProgress(ToolExecutionStage.PROCESSING, 90, 'Processing results');

      const finalOutput = output.join('\n');
      const finalErrors = errors.join('\n');

      if (finalErrors) {
        emitProgress(
          ToolExecutionStage.FAILED,
          100,
          'Execution completed with errors',
        );

        if (updateOutput) {
          updateOutput(`❌ TypeScript execution failed\n\n`);
        }

        return {
          llmContent: `❌ TypeScript execution completed with errors:\n\n${finalErrors}\n\nOutput:\n${finalOutput}`,
          returnDisplay: `❌ Execution failed:\n${finalErrors}`,
        };
      }

      emitProgress(
        ToolExecutionStage.COMPLETED,
        100,
        'Execution completed successfully',
      );

      // Register directory after successful execution to track current state
      // This ensures TypeScript's own changes are not reported as external changes
      const workingDir =
        this.params.workingDirectory || this.config.getTargetDir();
      await registerDirectoryForTracking(this.config, workingDir);

      if (updateOutput) {
        updateOutput('✅ TypeScript execution completed successfully\n\n');
      }

      return {
        llmContent: `✅ TypeScript execution completed successfully\n\n${finalOutput || '(no output)'}`,
        returnDisplay: finalOutput || '✅ Executed successfully (no output)',
      };
    } catch (error) {
      // Handle timeout
      if (
        error instanceof Error &&
        error.message.includes('Script execution timed out')
      ) {
        emitProgress(
          ToolExecutionStage.FAILED,
          undefined,
          `Execution timed out after ${this.params.timeout || 60} seconds`,
        );

        if (updateOutput) {
          updateOutput(`❌ Execution timed out\n\n`);
        }

        return {
          llmContent: `❌ TypeScript execution timed out after ${this.params.timeout || 60} seconds.\n\nPartial output:\n${output.join('\n')}`,
          returnDisplay: `❌ Execution timed out after ${this.params.timeout || 60} seconds`,
        };
      }

      // Handle other errors with detailed context
      emitProgress(
        ToolExecutionStage.FAILED,
        undefined,
        `Execution failed: ${getErrorMessage(error)}`,
      );

      if (updateOutput) {
        updateOutput(`❌ Execution error: ${getErrorMessage(error)}\n\n`);
      }

      // Try to extract error context from the code
      const errorMessage = getErrorMessage(error);
      const codeLines = this.params.code.split('\n');
      let errorContext = '';

      // Try to find error line from stack trace
      if (error instanceof Error && error.stack) {
        const stackLines = error.stack.split('\n');
        for (const line of stackLines) {
          const match = line.match(/:(\d+):(\d+)/);
          if (match) {
            const lineNum = parseInt(match[1], 10);
            if (lineNum > 0 && lineNum <= codeLines.length) {
              // Show 3 lines before and after the error
              const start = Math.max(0, lineNum - 4);
              const end = Math.min(codeLines.length, lineNum + 3);
              const contextLines = [];

              for (let i = start; i < end; i++) {
                const marker = i === lineNum - 1 ? '>>> ' : '    ';
                contextLines.push(`${marker}Line ${i + 1}: ${codeLines[i]}`);
              }

              errorContext = `\n\nError context:\n${contextLines.join('\n')}`;
              break;
            }
          }
        }
      }

      return {
        llmContent: `❌ TypeScript execution failed:\n\n${errorMessage}${errorContext}\n\nPartial output:\n${output.join('\n')}`,
        returnDisplay: `❌ Execution failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Execute TypeScript code in Docker/Podman sandbox (secure mode)
   */
  private async executeInSandbox(
    _signal: AbortSignal,
    emitProgress: (
      stage: ToolExecutionStage,
      progress?: number,
      message?: string,
      details?: Record<string, unknown>,
    ) => void,
    _updateOutput?: (output: string | AnsiOutput) => void,
  ): Promise<ToolResult> {
    emitProgress(
      ToolExecutionStage.PREPARING,
      10,
      'Preparing sandbox environment',
    );

    // TODO: Integrate with existing sandbox infrastructure
    // Reference: packages/cli/src/utils/sandbox.ts

    return {
      llmContent:
        'Sandbox execution mode is not yet implemented. Please use VM mode.',
      returnDisplay: 'Sandbox mode not available',
    };
  }

  /**
   * Transpile TypeScript code to JavaScript
   */
  private transpileTypeScript(code: string): string {
    const options: TranspileOptions = {
      compilerOptions: {
        target: 99, // ES2022
        module: 99, // ESNext
        moduleResolution: 3, // Bundler
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: false, // Allow more flexible code
      },
    };

    try {
      return transpile(code, options.compilerOptions);
    } catch (error) {
      throw new Error(
        `TypeScript transpilation failed: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Transform MCP import statements to runtime loader calls
   *
   * Converts:
   *   import { send_email } from '.mcp/google-workspace/gmail/send_email'
   * To:
   *   const { send_email } = await __loadMcpTool('google-workspace', 'send_email')
   */
  private transformMcpImports(code: string): string {
    const importRegex =
      /import\s+{([^}]+)}\s+from\s+['"]\.mcp\/([^/]+)\/(?:[^/]+\/)*([^'"]+)['"]/g;

    return code.replace(
      importRegex,
      (_match, imports, serverName, toolFile) => {
        const toolName = toolFile.replace(/\.(ts|js)$/, '');
        const importNames = imports
          .split(',')
          .map((s: string) => s.trim())
          .join(', ');

        return `const { ${importNames} } = await __loadMcpTool('${serverName}', '${toolName}')`;
      },
    );
  }

  /**
   * Create sandbox context for VM execution with progress tracking
   */
  private createSandboxContext(
    output: string[],
    errors: string[],
    updateOutput?: (output: string | AnsiOutput) => void,
  ): Record<string, unknown> {
    // Progress tracker for user code
    const startTime = Date.now();
    const progressReporter = (
      stage: string,
      progress?: number,
      message?: string,
      details?: Record<string, unknown>,
    ) => {
      const progressEvent = {
        __PROGRESS__: true,
        stage,
        progress,
        message,
        details,
        timestamp: Date.now(),
        elapsed: (Date.now() - startTime) / 1000,
      };
      // Send progress event through updateOutput
      if (updateOutput) {
        updateOutput(
          `__GEMINI_PROGRESS__${JSON.stringify(progressEvent)}__END__\n`,
        );
      }
    };

    return {
      // Console API with output capture
      console: {
        log: (...args: unknown[]) => {
          const message = args
            .map((arg) =>
              typeof arg === 'object'
                ? JSON.stringify(arg, null, 2)
                : String(arg),
            )
            .join(' ');
          output.push(message);
          // Also send to updateOutput for real-time display
          if (updateOutput) {
            updateOutput(message + '\n');
          }
        },
        error: (...args: unknown[]) => {
          const message = args
            .map((arg) =>
              typeof arg === 'object'
                ? JSON.stringify(arg, null, 2)
                : String(arg),
            )
            .join(' ');
          errors.push(message);
          if (updateOutput) {
            updateOutput(`[ERROR] ${message}\n`);
          }
        },
        warn: (...args: unknown[]) => {
          const message = args
            .map((arg) =>
              typeof arg === 'object'
                ? JSON.stringify(arg, null, 2)
                : String(arg),
            )
            .join(' ');
          output.push(`[WARN] ${message}`);
          if (updateOutput) {
            updateOutput(`[WARN] ${message}\n`);
          }
        },
        info: (...args: unknown[]) => {
          const message = args
            .map((arg) =>
              typeof arg === 'object'
                ? JSON.stringify(arg, null, 2)
                : String(arg),
            )
            .join(' ');
          output.push(`[INFO] ${message}`);
          if (updateOutput) {
            updateOutput(`[INFO] ${message}\n`);
          }
        },
      },

      // Progress reporting function (exposed to user code)
      report_progress: progressReporter,

      // MCP Tool Loader - dynamically loads MCP tools
      // Used for legacy .mcp/ import syntax: import { tool } from '.mcp/server/tool'
      __loadMcpTool: async (serverName: string, toolName: string) => {
        const mcpManager = this.config.getMcpClientManager();
        if (!mcpManager) {
          throw new Error('MCP client manager not available');
        }

        // Return an object with the tool function
        // The function signature matches what's generated in the virtual filesystem
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [toolName]: async (input: any) =>
            await mcpManager.callTool(serverName, toolName, input),
        };
      },

      // MCP Client interface for calling MCP tools from generated code
      __mcpClient: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callTool: async (serverName: string, toolName: string, input: any) => {
          const mcpManager = this.config.getMcpClientManager();
          if (!mcpManager) {
            throw new Error('MCP client manager not available');
          }
          return await mcpManager.callTool(serverName, toolName, input);
        },
      },

      // Whitelisted globals
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      Promise,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      Math,
      JSON,
      Error,
      TypeError,
      RangeError,
      RegExp,
      Map,
      Set,
      WeakMap,
      WeakSet,

      // Utility functions
      Buffer,
    };
  }
}

export class TypeScriptTool extends BaseDeclarativeTool<
  TypeScriptToolParams,
  ToolResult
> {
  static readonly Name: string = 'typescript';

  private readonly allowlist = new Set<string>();

  constructor(private readonly config: Config) {
    super(
      'typescript',
      'TypeScript',
      `Execute TypeScript code using Node.js VM environment.

# QUICK GUIDE
- Can import MCP tools from .mcp/ directory
- Supports async/await and modern ES2022 features
- Runs in isolated VM context for safety
- Default timeout: 60 seconds
- Real-time progress reporting to GUI

# EXECUTION MODES
- \`vm\` (default): Fast execution in Node.js VM (recommended)
- \`sandbox\`: Secure execution in Docker/Podman (coming soon)

# PROGRESS REPORTING
You can report execution progress to the GUI using the \`report_progress()\` function:

\`\`\`typescript
// Available in all TypeScript code
report_progress('loading', 10, 'Loading data from API');
// Process data...
report_progress('processing', 50, 'Processing 500 rows', { rows_processed: 500, total: 1000 });
// Write results...
report_progress('writing', 90, 'Writing results to file');
\`\`\`

Parameters:
- \`stage\`: String describing the current stage (e.g., 'loading', 'processing', 'analyzing')
- \`progress\`: Optional number 0-100 representing percentage complete
- \`message\`: Optional status message shown to the user
- \`details\`: Optional object with additional details (e.g., { rows_processed: 100 })

# MCP TOOL IMPORTS
You can import MCP tools from the virtual .mcp/ filesystem:

\`\`\`typescript
import { send_email } from '.mcp/google-workspace/gmail/send_email';

const result = await send_email({
  to: 'user@example.com',
  subject: 'Hello',
  body: 'Test message'
});

console.log('Email sent:', result.messageId);
\`\`\`

# AVAILABLE GLOBALS
- console: log, error, warn, info (all stream to GUI in real-time)
- report_progress: Function for progress reporting
- setTimeout, setInterval, clearTimeout, clearInterval
- Promise, Array, Object, String, Number, Boolean, Date, Math, JSON
- Buffer (Node.js Buffer API)
`,
      Kind.Execute,
      {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'TypeScript code to execute. Can be multi-line, use imports, and async/await. Can import MCP tools from .mcp/ directory.',
          },
          description: {
            type: 'string',
            description:
              'Clear description of what this code will do and why. This will be shown to the user in the confirmation dialog.',
          },
          timeout: {
            type: 'number',
            description: 'Execution timeout in seconds (default: 60, max: 300)',
            minimum: 1,
            maximum: 300,
          },
          workingDirectory: {
            type: 'string',
            description:
              'Working directory for script execution (default: current workspace directory)',
          },
          executionMode: {
            type: 'string',
            enum: ['vm', 'sandbox'],
            description:
              'Execution mode: "vm" for fast Node.js VM execution (default), "sandbox" for secure Docker/Podman execution',
          },
        },
        required: ['code', 'description'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      true, // canUpdateOutput
    );
  }

  protected createInvocation(
    params: TypeScriptToolParams,
  ): ToolInvocation<TypeScriptToolParams, ToolResult> {
    return new TypeScriptToolInvocation(params, this.allowlist, this.config);
  }
}
