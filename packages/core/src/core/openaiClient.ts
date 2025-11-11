/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { OpenAIChat } from './openaiChat.js';
import { RoleManager } from '../roles/RoleManager.js';
import type { ServerGeminiStreamEvent, ChatCompressionInfo } from './turn.js';
import type { PartListUnion } from '@google/genai';
import type { IClient } from './IClient.js';
import type { Turn } from './turn.js';
import type { UniversalMessage } from './message-types.js';

/**
 * Creates environment awareness reminder with file change information
 * This injects detected file changes into the user's message automatically
 */
async function createEnvironmentAwarenessReminderPart(
  config: Config,
): Promise<{ text: string } | null> {
  try {
    const sessionId = config.getSessionId();
    if (!sessionId) {
      return null;
    }

    // Dynamically import to avoid circular dependency
    const { EnvironmentAwarenessManager } = await import(
      '../services/environmentAwareness.js'
    );

    const manager = EnvironmentAwarenessManager.getInstance();
    const tracker = manager.getTracker(sessionId);

    // Detect changes
    const changes = await tracker.detectChanges();

    if (changes.length === 0) {
      return null; // No changes to report
    }

    // Format changes for LLM
    const formattedChanges = manager.formatChangesForLLM(changes);

    return {
      text: `<system_reminder>
${formattedChanges}

This information is automatically provided to keep you aware of environment changes.
Consider these changes when responding to the user.
Do NOT explicitly mention this reminder to the user unless directly relevant to their question.
</system_reminder>`,
    };
  } catch (error) {
    console.error(
      '[OpenAIClient] Failed to create environment awareness reminder:',
      error,
    );
    return null;
  }
}

/**
 * OpenAIClient - Manages a single OpenAI chat session
 *
 * Mirrors GeminiClient's structure but uses OpenAI API instead of Gemini.
 * Provides the same interface for compatibility with the rest of the system.
 */
export class OpenAIClient implements IClient {
  private chat?: OpenAIChat;
  private readonly roleManager: RoleManager;

  constructor(private readonly config: Config) {
    this.roleManager = RoleManager.getInstance();
  }

  async initialize(): Promise<void> {
    // Get API key from config or environment
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY environment variable is required for OpenAI',
      );
    }

    this.chat = new OpenAIChat(this.config, apiKey);
  }

  isInitialized(): boolean {
    return this.chat !== undefined;
  }

  getChat(): OpenAIChat {
    if (!this.chat) {
      throw new Error('Chat not initialized');
    }
    return this.chat;
  }

  getHistory(): UniversalMessage[] {
    // Convert OpenAI ChatCompletionMessageParam[] to UniversalMessage[]
    const openaiHistory = this.getChat().getHistory();
    return this.convertOpenAIToUniversal(openaiHistory);
  }

  setHistory(history: UniversalMessage[]): void {
    console.log(
      '[OpenAIClient] setHistory: Converting UniversalMessage[] to OpenAI format',
    );
    // Convert UniversalMessage[] to OpenAI ChatCompletionMessageParam[]
    const openaiHistory = this.convertUniversalToOpenAI(history);
    this.getChat().setHistory(openaiHistory);
  }

  async addHistory(content: Content): Promise<void> {
    const openaiMessage = OpenAIChat.convertGeminiToOpenAIMessage(content);
    this.getChat().addHistory(openaiMessage);
  }

  stripThoughtsFromHistory(): void {
    // OpenAI doesn't have built-in thinking mode like Gemini
    // This is a no-op for now, but could be implemented if needed
  }

  async setTools(): Promise<void> {
    const toolRegistry = this.config.getToolRegistry();
    const functionDeclarations = toolRegistry.getFunctionDeclarations();

    // Convert Gemini FunctionDeclarations to OpenAI ChatCompletionTool
    const openaiTools = functionDeclarations.map((func) =>
      this.convertGeminiToolToOpenAI(func),
    );

    this.getChat().setTools(openaiTools);
  }

  /**
   * Convert Gemini FunctionDeclaration to OpenAI ChatCompletionTool format
   */
  private convertGeminiToolToOpenAI(
    func: import('@google/genai').FunctionDeclaration,
  ): import('openai/resources/chat/completions.js').ChatCompletionTool {
    // Ensure input_schema has the required structure
    const parameters =
      func.parametersJsonSchema && typeof func.parametersJsonSchema === 'object'
        ? (func.parametersJsonSchema as Record<string, unknown>)
        : {
            type: 'object',
            properties: {},
          };

    return {
      type: 'function',
      function: {
        name: func.name ?? '',
        description: func.description ?? '',
        parameters,
      },
    };
  }

  async updateToolsForCurrentRole(): Promise<void> {
    if (!this.chat) {
      return;
    }

    // Check if role system is enabled
    if (!this.roleManager.isRoleSystemEnabled()) {
      await this.setTools();
      console.log('[OpenAIClient] Role system disabled, using all tools');
      return;
    }

    const currentRole = this.roleManager.getCurrentRole();

    // Special handling for software_engineer: use original behavior
    if (currentRole.id === 'software_engineer') {
      await this.setTools();
      console.log(
        '[OpenAIClient] Software engineer role - using all registered tools',
      );
      return;
    }

    // For other roles, use tools from ToolsetManager
    const { ToolsetManager } = await import('../tools/ToolsetManager.js');
    const toolsetManager = new ToolsetManager();
    // Filter tools by provider - only get tools that work with OpenAI
    const roleToolClasses = toolsetManager.getToolsForRole(
      currentRole.id,
      'openai',
    );

    const toolRegistry = this.config.getToolRegistry();

    // Register tools
    for (const ToolClass of roleToolClasses) {
      const toolInstance = new ToolClass(this.config);
      toolRegistry.registerTool(toolInstance);
    }

    // Register role-specific subagents
    const roleSubagentDefinitions = toolsetManager.getSubagentForRole(
      currentRole.id,
    );
    if (roleSubagentDefinitions && roleSubagentDefinitions.length > 0) {
      const { SubagentToolWrapper } = await import(
        '../agents/subagent-tool-wrapper.js'
      );

      for (const definition of roleSubagentDefinitions) {
        try {
          const messageBusEnabled =
            this.config.getEnableMessageBusIntegration();
          const wrapper = new SubagentToolWrapper(
            definition,
            this.config,
            messageBusEnabled ? this.config.getMessageBus() : undefined,
          );
          toolRegistry.registerTool(wrapper);
        } catch (error) {
          console.error(
            `[OpenAIClient] Failed to register subagent ${definition.name}:`,
            error,
          );
        }
      }
    }

    // Convert registered tools to OpenAI format
    const functionDeclarations = toolRegistry.getFunctionDeclarations();
    const openaiTools = functionDeclarations.map((func) =>
      this.convertGeminiToolToOpenAI(func),
    );

    this.getChat().setTools(openaiTools);

    console.log(
      `[OpenAIClient] Updated tools for role: ${currentRole.id} (${openaiTools.length} tools)`,
    );
  }

  /**
   * Send a message and get streaming response
   * This is the core method that needs to be compatible with GeminiClient's interface
   */
  async *sendMessageStream(
    request: PartListUnion,
    signal: AbortSignal,
    prompt_id: string,
    turns: number = 100, // Maximum turns to prevent infinite loops
    _isInvalidStreamRetry: boolean = false, // Reserved for future use (like Gemini's retry logic)
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn> {
    const { Turn, GeminiEventType } = await import('./turn.js');

    // Ensure turns never exceeds maximum to prevent infinite loops
    const MAX_TURNS = 100;
    const boundedTurns = Math.min(turns, MAX_TURNS);
    if (!boundedTurns) {
      return new Turn(this.getChat() as never, prompt_id);
    }
    const { getEnvironmentContext } = await import(
      '../utils/environmentContext.js'
    );

    // Set system instruction before sending message
    const userMemory = this.config.getUserMemory();
    const currentRoleId = this.roleManager.getCurrentRole().id;
    const baseSystemInstruction = this.roleManager.getCombinedSystemPrompt(
      this.config,
      userMemory,
      currentRoleId,
    );

    // Get environment context
    const envParts = await getEnvironmentContext(this.config);
    const envContextString = envParts
      .map((part) => part.text || '')
      .join('\n\n');

    // Combine system instruction with environment context
    const systemInstruction = `
${baseSystemInstruction}

# Environment Context

${envContextString}
`.trim();

    this.getChat().setSystemInstruction(systemInstruction);

    // Inject environment awareness reminder before user messages
    let modifiedRequest = request;
    if (Array.isArray(request)) {
      const reminders = [];

      // Environment awareness reminder (every message)
      const envReminder = await createEnvironmentAwarenessReminderPart(
        this.config,
      );
      if (envReminder) {
        reminders.push(envReminder);
      }

      if (reminders.length > 0) {
        modifiedRequest = [...reminders, ...request];
      }
    }

    // Convert PartListUnion to OpenAI message format
    // Tool responses (functionResponse parts) are converted to tool messages
    // and will be added to history by sendMessageStream
    const message = this.convertRequestToOpenAIMessage(modifiedRequest);

    // Get model from global config or use default
    const globalModel = this.config.getGlobalModel();
    const model =
      globalModel || this.config.getModel() || 'gpt-4-turbo-preview';

    console.log(`[OpenAIClient] Sending message with model: ${model}`);

    // Send message to OpenAI
    const stream = await this.getChat().sendMessageStream(model, message);

    // Track accumulated tool calls and metadata
    const contentBlocks: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];
    let finishReason: import('@google/genai').FinishReason | undefined;
    let usageMetadata:
      | import('@google/genai').GenerateContentResponseUsageMetadata
      | undefined;

    try {
      // Convert OpenAI events to Gemini events (event type conversion only)
      // History management is now handled by OpenAIChat.processStreamResponse()
      for await (const event of stream) {
        // Check for abort signal
        if (signal.aborted) {
          yield { type: GeminiEventType.UserCancelled };
          return new Turn(this.getChat() as never, prompt_id);
        }

        if (event.type === 'chunk') {
          const openaiChunk = event.value;
          const delta = openaiChunk.choices[0]?.delta;

          if (!delta) continue;

          // Handle text content
          if (delta.content) {
            yield {
              type: GeminiEventType.Content,
              value: delta.content,
            };
          }

          // Handle tool calls - accumulate for parsing after stream completes
          if (delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              const index = toolCall.index;

              // Initialize or update tool call
              if (!contentBlocks[index]) {
                contentBlocks[index] = {
                  id: toolCall.id || '',
                  type: 'function',
                  function: {
                    name: toolCall.function?.name || '',
                    arguments: toolCall.function?.arguments || '',
                  },
                };
              } else {
                // Accumulate function arguments
                if (toolCall.function?.arguments) {
                  contentBlocks[index].function.arguments +=
                    toolCall.function.arguments;
                }
              }
            }
          }

          // Handle finish reason and usage
          if (openaiChunk.choices[0]?.finish_reason) {
            const openaiFinishReason = openaiChunk.choices[0].finish_reason;
            if (openaiFinishReason === 'stop') {
              finishReason = 'stop' as import('@google/genai').FinishReason;
            } else if (openaiFinishReason === 'length') {
              finishReason =
                'maxTokens' as import('@google/genai').FinishReason;
            } else if (openaiFinishReason === 'tool_calls') {
              finishReason = 'stop' as import('@google/genai').FinishReason;
            } else if (openaiFinishReason === 'content_filter') {
              finishReason = 'safety' as import('@google/genai').FinishReason;
            }
          }

          // Handle usage metadata
          if (openaiChunk.usage) {
            usageMetadata = {
              promptTokenCount: openaiChunk.usage.prompt_tokens || 0,
              candidatesTokenCount: openaiChunk.usage.completion_tokens || 0,
              totalTokenCount: openaiChunk.usage.total_tokens || 0,
            };
          }
        }
      }

      // After stream completes, parse accumulated tool call arguments and emit ToolCallRequest events
      for (const toolCall of contentBlocks) {
        if (toolCall.function.arguments) {
          try {
            const parsedArgs = JSON.parse(toolCall.function.arguments);
            yield {
              type: GeminiEventType.ToolCallRequest,
              value: {
                callId: toolCall.id,
                name: toolCall.function.name,
                args: parsedArgs,
                isClientInitiated: false,
                prompt_id,
              },
            };
          } catch (error) {
            console.error(
              `[OpenAIClient] Failed to parse tool arguments for ${toolCall.function.name}:`,
              error,
            );
          }
        }
      }

      // Emit Finished event
      yield {
        type: GeminiEventType.Finished,
        value: {
          reason: finishReason,
          usageMetadata,
        },
      };

      // Note: History management is now handled by OpenAIChat.processStreamResponse(),
      // following the same pattern as GeminiChat.
    } catch (error) {
      // Handle stream errors
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      yield {
        type: GeminiEventType.Error,
        value: {
          error: {
            message: errorMessage,
          },
        },
      };
    }

    // Return a Turn object for compatibility
    return new Turn(this.getChat() as never, prompt_id);
  }

  /**
   * Convert PartListUnion request to OpenAI ChatCompletionMessageParam format
   * Handles text parts and tool responses (functionResponse)
   */
  private convertRequestToOpenAIMessage(
    request: PartListUnion,
  ): import('openai/resources/chat/completions.js').ChatCompletionMessageParam {
    type ToolMessage = {
      role: 'tool';
      content: string;
      tool_call_id: string;
    };
    type UserMessage = {
      role: 'user';
      content: string;
    };

    let messageContent = '';
    const toolMessages: ToolMessage[] = [];

    if (typeof request === 'string') {
      messageContent = request;
    } else if (Array.isArray(request)) {
      for (const part of request) {
        if (typeof part === 'string') {
          messageContent += part;
        } else if ('text' in part && part.text) {
          messageContent += part.text;
        } else if ('functionResponse' in part && part.functionResponse) {
          // Convert Gemini functionResponse to OpenAI tool message
          const funcResp = part.functionResponse;
          toolMessages.push({
            role: 'tool',
            content: JSON.stringify(funcResp.response || {}),
            tool_call_id: funcResp.id ?? 'unknown', // Use ID not name
          });
        }
      }
    }

    // If we have tool responses, we need to return them as tool messages
    // OpenAI requires tool messages to be separate from user messages
    if (toolMessages.length > 0) {
      // Return the first tool message (OpenAI expects one message at a time)
      return toolMessages[0];
    }

    // Return user message
    const userMessage: UserMessage = {
      role: 'user',
      content: messageContent || '',
    };
    return userMessage;
  }

  /**
   * Try to compress chat history when context limit is approached
   *
   * For OpenAI, we use a simple approach:
   * 1. Count tokens using approximate estimation (chars/4)
   * 2. If exceeds threshold (70% of limit), compress older messages
   * 3. Keep recent 30% of history and summarize the rest
   */
  async tryCompressChat(
    _prompt_id: string,
    _force: boolean = false,
  ): Promise<ChatCompressionInfo> {
    const { CompressionStatus } = await import('./turn.js');

    const history = this.getHistory();

    // OpenAI models typically have varying context windows
    // Using conservative estimate based on common models
    const CONTEXT_LIMIT = 128000; // GPT-4 Turbo limit
    const COMPRESSION_THRESHOLD = 0.7; // Compress at 70% of limit
    const PRESERVE_FRACTION = 0.3; // Keep last 30%

    // Estimate token count (rough approximation: 1 token ≈ 4 chars)
    const estimatedTokens = Math.floor(JSON.stringify(history).length / 4);

    // Check if compression is needed
    if (estimatedTokens < CONTEXT_LIMIT * COMPRESSION_THRESHOLD) {
      return {
        originalTokenCount: estimatedTokens,
        newTokenCount: estimatedTokens,
        compressionStatus: CompressionStatus.NOOP,
      };
    }

    // Find split point to preserve recent history
    const preserveCount = Math.max(
      2, // Keep at least 2 messages
      Math.floor(history.length * PRESERVE_FRACTION),
    );
    const splitIndex = history.length - preserveCount;

    if (splitIndex <= 0) {
      // History too short to compress
      return {
        originalTokenCount: estimatedTokens,
        newTokenCount: estimatedTokens,
        compressionStatus: CompressionStatus.NOOP,
      };
    }

    // Create compressed history
    // Keep recent messages, add a summary of older ones
    const olderMessages = history.slice(0, splitIndex);
    const recentMessages = history.slice(splitIndex);

    // Create summary of older messages
    const summaryText = `[Previous conversation summarized: ${olderMessages.length} messages exchanged]`;
    const compressedHistory: UniversalMessage[] = [
      {
        role: 'user',
        content: summaryText,
        timestamp: new Date(),
      },
      ...recentMessages,
    ];

    // Update chat history
    this.setHistory(compressedHistory);

    const newEstimatedTokens = Math.floor(
      JSON.stringify(compressedHistory).length / 4,
    );

    console.log(
      `[OpenAIClient] Compressed chat: ${estimatedTokens} → ${newEstimatedTokens} tokens (${history.length} → ${compressedHistory.length} messages)`,
    );

    return {
      originalTokenCount: estimatedTokens,
      newTokenCount: newEstimatedTokens,
      compressionStatus: CompressionStatus.COMPRESSED,
    };
  }

  /**
   * Update generation config (temperature, etc.)
   */
  async updateGenerateContentConfig(): Promise<void> {
    // For OpenAI, this is called before each message send
    // Currently a no-op as config is applied directly in sendMessageStream
    // Future: Could store config state here for use in sendMessageStream
  }

  /**
   * Reset chat to initial state
   */
  async resetChat(): Promise<void> {
    this.chat?.clearHistory();
  }

  /**
   * Get list of available OpenAI models
   * Fetches the list from OpenAI API using the /v1/models endpoint
   */
  async getAvailableModels(): Promise<string[]> {
    if (!this.isInitialized()) {
      throw new Error('OpenAIClient not initialized');
    }

    try {
      const chat = this.getChat();
      const modelsResponse = await chat.listModels();
      return modelsResponse.data.map((model) => model.id);
    } catch (error) {
      console.error('[OpenAIClient] Failed to fetch models from API:', error);
      // Fallback to hardcoded list if API call fails
      return ['gpt-4-turbo-preview', 'gpt-4', 'gpt-3.5-turbo'];
    }
  }

  /**
   * Convert OpenAI ChatCompletionMessageParam[] to UniversalMessage[]
   */
  private convertOpenAIToUniversal(
    messages: Array<
      import('openai/resources/chat/completions.js').ChatCompletionMessageParam
    >,
  ): UniversalMessage[] {
    const universalMessages: UniversalMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        continue;
      }

      if (msg.role === 'tool') {
        // Tool response message
        const toolCallId =
          'tool_call_id' in msg ? (msg.tool_call_id as string) : undefined;
        const toolContent =
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);

        // Check if tool response contains error
        let hasError = false;
        try {
          const parsedContent = JSON.parse(toolContent);
          hasError =
            parsedContent &&
            typeof parsedContent === 'object' &&
            'error' in parsedContent;
        } catch {
          // If not JSON, check if content contains error indicators
          hasError =
            toolContent.includes('Tool execution failed') ||
            toolContent.includes('Tool cancelled');
        }

        // Update corresponding toolCall status if this is an error response
        if (hasError && toolCallId) {
          for (let i = universalMessages.length - 1; i >= 0; i--) {
            const msg = universalMessages[i];
            if (msg.role === 'assistant' && msg.toolCalls) {
              const toolCallIndex = msg.toolCalls.findIndex(
                (tc) => tc.id === toolCallId,
              );
              if (toolCallIndex !== -1) {
                msg.toolCalls[toolCallIndex] = {
                  ...msg.toolCalls[toolCallIndex],
                  status: 'failed',
                  success: false,
                  result: toolContent,
                };
                console.log(
                  `[OpenAIClient] Updated toolCall ${toolCallId} status to failed`,
                );
                break;
              }
            }
          }
        }

        universalMessages.push({
          role: 'tool',
          content: toolContent,
          tool_call_id: toolCallId,
          timestamp: new Date(),
          parts: [msg], // Preserve original OpenAI message
        });
      } else if (msg.role === 'assistant') {
        // Assistant message (may include tool calls)
        let content = '';
        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (msg.content === null) {
          content = '';
        } else if (Array.isArray(msg.content)) {
          content = msg.content
            .map((part) => {
              if ('text' in part) return part.text;
              if ('refusal' in part) return part.refusal;
              return '';
            })
            .join('');
        }

        const message: UniversalMessage = {
          role: 'assistant',
          content,
          timestamp: new Date(),
          parts: [msg], // Preserve original OpenAI message
        };

        // Handle tool calls
        if (
          'tool_calls' in msg &&
          msg.tool_calls &&
          Array.isArray(msg.tool_calls)
        ) {
          message.toolCalls = msg.tool_calls
            .filter((tc) => tc.type === 'function')
            .map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments || '{}') as Record<
                string,
                unknown
              >,
            }));
        }

        universalMessages.push(message);
      } else if (msg.role === 'user') {
        // User message
        const userContent =
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
        universalMessages.push({
          role: 'user',
          content: userContent,
          timestamp: new Date(),
          parts: [msg], // Preserve original OpenAI message
        });
      }
    }

    return universalMessages;
  }

  /**
   * Convert UniversalMessage[] to OpenAI ChatCompletionMessageParam[]
   */
  private convertUniversalToOpenAI(
    messages: UniversalMessage[],
  ): Array<
    import('openai/resources/chat/completions.js').ChatCompletionMessageParam
  > {
    const openaiMessages: Array<
      import('openai/resources/chat/completions.js').ChatCompletionMessageParam
    > = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        continue;
      }

      // If parts field exists and contains original OpenAI message, restore it directly
      // This preserves ALL fields including reasoning, refusal, etc.
      if (msg.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
        const originalMsg = msg.parts[0];
        if (
          originalMsg &&
          typeof originalMsg === 'object' &&
          'role' in originalMsg
        ) {
          openaiMessages.push(
            originalMsg as import('openai/resources/chat/completions.js').ChatCompletionMessageParam,
          );
          continue;
        }
      }

      // Fallback: reconstruct message from UniversalMessage fields
      // This is for backward compatibility with messages that don't have parts field
      if (msg.role === 'tool') {
        // Tool response
        openaiMessages.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id || '',
          content: msg.content,
        });
      } else if (msg.role === 'assistant') {
        // Assistant message
        const assistantMsg: import('openai/resources/chat/completions.js').ChatCompletionMessageParam =
          {
            role: 'assistant',
            content: msg.content || null,
          };

        if (msg.toolCalls && msg.toolCalls.length > 0) {
          assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }

        openaiMessages.push(assistantMsg);
      } else if (msg.role === 'user') {
        // User message
        openaiMessages.push({
          role: 'user',
          content: msg.content,
        });
      }
    }

    return openaiMessages;
  }
}
