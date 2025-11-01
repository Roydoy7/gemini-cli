/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import type { ToolCallRequestInfo } from '../core/turn.js';
import { GeminiClient } from '../core/client.js';

export interface SubagentParams {
  /** The task or goal for the subagent to accomplish */
  task: string;

  /** System prompt to define the subagent's behavior */
  system_prompt: string;

  /** List of tool names the subagent can use */
  tools?: string[];

  /** Expected output variables and their descriptions */
  outputs?: Record<string, string>;

  /** Context variables to substitute in prompts using ${var} syntax */
  context?: Record<string, string>;

  /** Maximum execution time in minutes (default: 5) */
  max_time?: number;

  /** Maximum number of turns (default: 20) */
  max_turns?: number;

  /** Temperature for generation (default: 0.7) */
  temperature?: number;
}

export interface SubagentResult extends ToolResult {
  outputs?: Record<string, string>;
  terminate_reason?: 'success' | 'max_turns' | 'timeout' | 'error';
  turns_used?: number;
  execution_time?: number;
}

/**
 * Tool for executing autonomous subagents with specific tasks.
 * Subagents use GeminiClient and run without user interaction.
 */
export class SubagentTool extends BaseDeclarativeTool<
  SubagentParams,
  SubagentResult
> {
  static readonly Name: string = 'subagent_tool';
  constructor(private readonly config: Config) {
    super(
      'subagent_tool',
      'Subagent Executor',
      `Execute an autonomous subagent for complex, self-contained tasks.
       The subagent uses GeminiClient and runs independently,
       returning structured results upon completion.`,
      Kind.Execute,
      {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task or goal for the subagent to accomplish',
          },
          system_prompt: {
            type: 'string',
            description:
              'System prompt defining the subagent behavior and instructions',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of tool names the subagent can use',
          },
          outputs: {
            type: 'object',
            description:
              'Expected output variables (key: variable name, value: description)',
          },
          context: {
            type: 'object',
            description:
              'Context variables for prompt templating using ${var} syntax',
          },
          max_time: {
            type: 'number',
            description: 'Maximum execution time in minutes',
            default: 5,
          },
          max_turns: {
            type: 'number',
            description: 'Maximum number of turns',
            default: 20,
          },
          temperature: {
            type: 'number',
            description: 'Temperature for generation',
            default: 0.7,
          },
        },
        required: ['task', 'system_prompt'],
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected createInvocation(params: SubagentParams) {
    return new SubagentInvocation(this, params, this.config);
  }
}

class SubagentInvocation extends BaseToolInvocation<
  SubagentParams,
  SubagentResult
> {
  private emittedVars: Record<string, string> = {};
  private subagentClient?: GeminiClient;
  private subagentConfig: Config;

  constructor(tool: SubagentTool, params: SubagentParams, config: Config) {
    super(params);

    // Create Config wrapper with YOLO approval mode for autonomous execution
    this.subagentConfig = new Proxy(config, {
      get(target, prop) {
        if (prop === 'getApprovalMode') {
          return () => ApprovalMode.YOLO;
        }
        return Reflect.get(target, prop);
      },
    });
  }

  override getDescription(): string {
    const toolsList = this.params.tools?.join(', ') || 'none';
    const outputKeys = this.params.outputs
      ? Object.keys(this.params.outputs).join(', ')
      : 'none';
    return `Execute subagent for task: "${this.params.task.substring(0, 100)}..." with tools: [${toolsList}], expecting outputs: [${outputKeys}]`;
  }

  override async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<SubagentResult> {
    const startTime = Date.now();
    let turnCount = 0;
    const maxTurns = this.params.max_turns || 20;
    const maxTimeMs = (this.params.max_time || 5) * 60 * 1000;

    try {
      // Create a new GeminiClient instance for the subagent
      this.subagentClient = new GeminiClient(this.subagentConfig);

      // Build system prompt with context substitution
      const systemPrompt = this.buildSystemPrompt();

      if (updateOutput) {
        updateOutput(
          `🤖 Starting subagent execution...\nTask: ${this.params.task}\n\n`,
        );
      }

      // Initialize conversation with system prompt and task
      let userMessage =
        'Begin working on your task. Use the available tools as needed.';

      // Main execution loop
      while (turnCount < maxTurns) {
        // Check timeout
        const elapsed = Date.now() - startTime;
        if (elapsed > maxTimeMs) {
          return this.createResult(
            'timeout',
            turnCount,
            elapsed / 1000,
            'Execution timeout reached',
          );
        }

        turnCount++;

        if (updateOutput) {
          updateOutput(`[Turn ${turnCount}] Generating response...\n`);
        }

        if (signal.aborted) {
          return this.createResult(
            'error',
            turnCount,
            (Date.now() - startTime) / 1000,
            'Execution aborted',
          );
        }

        // Send message to GeminiClient with system prompt
        let assistantContent = '';
        let hasToolCalls = false;
        const toolCalls: Array<{
          name: string;
          id: string;
          args: Record<string, unknown>;
        }> = [];

        try {
          // Use stream to collect response
          // Note: systemPrompt should be set via Config or other mechanism
          // For now, we'll prepend it to the first message
          const messageWithContext =
            turnCount === 1 ? `${systemPrompt}\n\n${userMessage}` : userMessage;

          for await (const event of this.subagentClient.sendMessageStream(
            [{ text: messageWithContext }],
            signal,
            `subagent-${turnCount}`,
            maxTurns,
          )) {
            if (event.type === 'content') {
              assistantContent += event.value;
            } else if (event.type === 'tool_call_request') {
              hasToolCalls = true;
              const toolCallInfo = event.value;
              toolCalls.push({
                name: toolCallInfo.name,
                id: toolCallInfo.callId,
                args: toolCallInfo.args,
              });
            }
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          if (updateOutput) {
            updateOutput(`❌ Error generating response: ${errorMessage}\n`);
          }
          return this.createResult(
            'error',
            turnCount,
            (Date.now() - startTime) / 1000,
            `Generation error: ${errorMessage}`,
          );
        }

        // Show assistant response
        if (assistantContent.trim()) {
          if (updateOutput) {
            const truncated =
              assistantContent.length > 200
                ? assistantContent.substring(0, 200) + '...'
                : assistantContent;
            updateOutput(`[Assistant]: ${truncated}\n\n`);
          }
        }

        // Execute tool calls if any
        if (hasToolCalls && toolCalls.length > 0) {
          const toolResults: string[] = [];

          for (const toolCall of toolCalls) {
            // Check if this is the special emit tool
            if (toolCall.name === 'emit_output' && toolCall.args) {
              const key = toolCall.args['variable_name'] as string;
              const value = toolCall.args['variable_value'] as string;
              if (key && value) {
                this.emittedVars[key] = value;
                toolResults.push(`Emitted variable '${key}'`);
                if (updateOutput) {
                  updateOutput(`📤 Emitted: ${key} = ${value}\n`);
                }
              }
            } else {
              // Execute regular tool
              try {
                const requestInfo: ToolCallRequestInfo = {
                  callId: toolCall.id || `${toolCall.name}-${Date.now()}`,
                  name: toolCall.name,
                  args: toolCall.args || {},
                  isClientInitiated: false,
                  prompt_id: `subagent-${turnCount}`,
                };

                const { executeToolCall } = await import(
                  '../core/nonInteractiveToolExecutor.js'
                );
                const toolResponse = await executeToolCall(
                  this.subagentConfig,
                  requestInfo,
                  signal,
                );

                if (toolResponse.response.error) {
                  toolResults.push(
                    `Tool ${toolCall.name} failed: ${toolResponse.response.error.message}`,
                  );
                } else {
                  const result =
                    toolResponse.response.resultDisplay ||
                    'Tool executed successfully';
                  const resultStr =
                    typeof result === 'string'
                      ? result
                      : JSON.stringify(result);
                  toolResults.push(
                    `Tool ${toolCall.name} result: ${resultStr}`,
                  );
                  if (updateOutput) {
                    const truncated =
                      resultStr.length > 100
                        ? resultStr.substring(0, 100) + '...'
                        : resultStr;
                    updateOutput(`🔧 Tool ${toolCall.name}: ${truncated}\n`);
                  }
                }
              } catch (error) {
                const errorMsg = getErrorMessage(error);
                toolResults.push(`Tool ${toolCall.name} error: ${errorMsg}`);
              }
            }
          }

          // Prepare next user message with tool results
          if (toolResults.length > 0) {
            userMessage = `Tool results:\n${toolResults.join('\n')}`;
          }
        } else {
          // No tool calls
          // Check if we have all required outputs
          if (this.params.outputs && this.allOutputsEmitted()) {
            return this.createResult(
              'success',
              turnCount,
              (Date.now() - startTime) / 1000,
              'All outputs emitted successfully',
            );
          }

          // If no outputs expected, task is complete
          if (
            !this.params.outputs ||
            Object.keys(this.params.outputs).length === 0
          ) {
            return this.createResult(
              'success',
              turnCount,
              (Date.now() - startTime) / 1000,
              'Task completed',
            );
          }

          // Outputs are still missing
          const missingOutputs = Object.keys(this.params.outputs).filter(
            (key) => !(key in this.emittedVars),
          );

          // Check if model is stuck (no content and no tool calls)
          if (!assistantContent.trim()) {
            return this.createResult(
              'error',
              turnCount,
              (Date.now() - startTime) / 1000,
              'Subagent stuck: no tool calls or content generated',
            );
          }

          // Prompt to emit missing outputs
          userMessage = `You need to emit the following outputs using the emit_output tool: ${missingOutputs.join(', ')}`;
        }
      }

      return this.createResult(
        'max_turns',
        turnCount,
        (Date.now() - startTime) / 1000,
        'Maximum turns reached',
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (updateOutput) {
        updateOutput(`❌ Subagent failed: ${errorMessage}\n`);
      }

      return {
        error: new Error(errorMessage),
        llmContent: `Subagent execution failed: ${errorMessage}`,
        returnDisplay: `❌ Subagent failed: ${errorMessage}`,
        terminate_reason: 'error',
        turns_used: turnCount,
        execution_time: (Date.now() - startTime) / 1000,
      };
    }
  }

  private buildSystemPrompt(): string {
    let prompt = this.params.system_prompt;

    // Substitute context variables using ${var} syntax
    if (this.params.context) {
      for (const [key, value] of Object.entries(this.params.context)) {
        const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
        prompt = prompt.replace(pattern, value);
      }
    }

    // Add task context
    prompt += `\n\n## Your Task\n${this.params.task}`;

    // Add tool information from config
    const toolRegistry = this.subagentConfig.getToolRegistry();
    const availableTools = toolRegistry.getAllToolNames();

    let allowedTools = availableTools;
    if (this.params.tools && this.params.tools.length > 0) {
      // Filter to only allowed tools if specified
      allowedTools = availableTools.filter((tool: string) =>
        this.params.tools!.includes(tool),
      );
    }

    if (allowedTools.length > 0) {
      prompt += `\n\n## Available Tools\nYou have access to these tools: ${allowedTools.join(', ')}`;

      if (this.params.tools && this.params.tools.length > 0) {
        const notAvailable = this.params.tools.filter(
          (tool) => !availableTools.includes(tool),
        );
        if (notAvailable.length > 0) {
          prompt += `\n\nNote: These requested tools are not available: ${notAvailable.join(', ')}`;
        }
      }
    } else {
      prompt += `\n\n## Available Tools\nNo tools are available.`;
    }

    // Add output requirements
    if (this.params.outputs && Object.keys(this.params.outputs).length > 0) {
      prompt += `\n\n## Required Outputs\nYou must emit the following outputs using the emit_output tool:`;
      for (const [key, description] of Object.entries(this.params.outputs)) {
        prompt += `\n- ${key}: ${description}`;
      }
      prompt += `\n\nUse emit_output(variable_name="key", variable_value="value") to emit each output.`;
    }

    // Add execution constraints
    prompt += `\n\n## Execution Constraints
- You are running autonomously without user interaction
- You cannot ask for clarification or additional input
- Work with the information and tools available to you
- If you encounter issues, try alternative approaches
- Complete your task within ${this.params.max_turns || 20} turns and ${this.params.max_time || 5} minutes
- Once all required outputs are emitted or the task is complete, you may stop`;

    return prompt;
  }

  private allOutputsEmitted(): boolean {
    if (!this.params.outputs) return true;
    return Object.keys(this.params.outputs).every(
      (key) => key in this.emittedVars,
    );
  }

  private createResult(
    reason: 'success' | 'max_turns' | 'timeout' | 'error',
    turns: number,
    time: number,
    message?: string,
  ): SubagentResult {
    const summary: string[] = [];

    // Status
    const statusEmoji =
      reason === 'success' ? '✅' : reason === 'error' ? '❌' : '⚠️';
    const statusText =
      reason === 'success'
        ? 'Completed successfully'
        : reason === 'max_turns'
          ? 'Reached maximum turns'
          : reason === 'timeout'
            ? 'Execution timeout'
            : 'Execution error';

    summary.push(`**Status**: ${statusEmoji} ${statusText}`);
    summary.push(`**Turns Used**: ${turns}`);
    summary.push(`**Execution Time**: ${time.toFixed(1)}s`);

    if (message) {
      summary.push(`**Details**: ${message}`);
    }

    // Add outputs
    if (Object.keys(this.emittedVars).length > 0) {
      summary.push('\n**Outputs**:');
      for (const [key, value] of Object.entries(this.emittedVars)) {
        const displayValue =
          value.length > 200 ? value.substring(0, 200) + '...' : value;
        summary.push(`- **${key}**: ${displayValue}`);
      }
    }

    const displayText = summary.join('\n');

    // LLM content with full outputs
    let llmContent = `Subagent ${statusText}\n`;
    if (Object.keys(this.emittedVars).length > 0) {
      llmContent += '\nOutputs:\n';
      for (const [key, value] of Object.entries(this.emittedVars)) {
        llmContent += `${key}: ${value}\n`;
      }
    }

    return {
      llmContent,
      returnDisplay: displayText,
      outputs: this.emittedVars,
      terminate_reason: reason,
      turns_used: turns,
      execution_time: time,
    };
  }
}
