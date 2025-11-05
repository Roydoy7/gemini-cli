/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { LmStudioChat } from './lmstudioChat.js';
import { RoleManager } from '../roles/RoleManager.js';
import type { ServerGeminiStreamEvent, ChatCompressionInfo } from './turn.js';
import type { PartListUnion } from '@google/genai';
import type { IClient } from './IClient.js';
import type { Turn } from './turn.js';
import type { UniversalMessage } from './message-types.js';

/**
 * LmStudioClient - Manages a single LM Studio chat session
 *
 * Mirrors GeminiClient's structure but uses LM Studio's OpenAI-compatible API.
 * LM Studio is a local LLM server that provides OpenAI-compatible endpoints.
 * Provides the same interface for compatibility with the rest of the system.
 */
export class LmStudioClient implements IClient {
  private chat?: LmStudioChat;
  private readonly roleManager: RoleManager;

  constructor(private readonly config: Config) {
    this.roleManager = RoleManager.getInstance();
  }

  async initialize(): Promise<void> {
    // LM Studio uses custom base URL (default: http://localhost:1234/v1)
    const baseURL =
      process.env['LMSTUDIO_BASE_URL'] || 'http://localhost:1234/v1';

    this.chat = new LmStudioChat(this.config, baseURL);
  }

  isInitialized(): boolean {
    return this.chat !== undefined;
  }

  getChat(): LmStudioChat {
    if (!this.chat) {
      throw new Error('Chat not initialized');
    }
    return this.chat;
  }

  getHistory(): UniversalMessage[] {
    // Convert LM Studio ChatCompletionMessageParam[] to UniversalMessage[]
    const lmstudioHistory = this.getChat().getHistory();
    return this.convertOpenAIToUniversal(lmstudioHistory);
  }

  setHistory(history: UniversalMessage[]): void {
    console.log(
      '[LmStudioClient] setHistory: Converting UniversalMessage[] to OpenAI format',
    );
    // Convert UniversalMessage[] to LM Studio ChatCompletionMessageParam[]
    const lmstudioHistory = this.convertUniversalToOpenAI(history);
    this.getChat().setHistory(lmstudioHistory);
  }

  async addHistory(content: Content): Promise<void> {
    const lmstudioMessage =
      LmStudioChat.convertGeminiToLmStudioMessage(content);
    this.getChat().addHistory(lmstudioMessage);
  }

  stripThoughtsFromHistory(): void {
    // LM Studio doesn't have built-in thinking mode like Gemini
    // This is a no-op for now, but could be implemented if needed
  }

  async setTools(): Promise<void> {
    const toolRegistry = this.config.getToolRegistry();
    const functionDeclarations = toolRegistry.getFunctionDeclarations();

    // Convert Gemini FunctionDeclarations to OpenAI ChatCompletionTool
    const lmstudioTools = functionDeclarations.map((func) =>
      this.convertGeminiToolToLmStudio(func),
    );

    this.getChat().setTools(lmstudioTools);
  }

  /**
   * Convert Gemini FunctionDeclaration to OpenAI ChatCompletionTool format
   * (LM Studio uses the same format as OpenAI)
   */
  private convertGeminiToolToLmStudio(
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
      console.log('[LmStudioClient] Role system disabled, using all tools');
      return;
    }

    const currentRole = this.roleManager.getCurrentRole();

    // Special handling for software_engineer: use original behavior
    if (currentRole.id === 'software_engineer') {
      await this.setTools();
      console.log(
        '[LmStudioClient] Software engineer role - using all registered tools',
      );
      return;
    }

    // For other roles, use tools from ToolsetManager
    const { ToolsetManager } = await import('../tools/ToolsetManager.js');
    const toolsetManager = new ToolsetManager();
    // Filter tools by provider - only get tools that work with LM Studio
    const roleToolClasses = toolsetManager.getToolsForRole(
      currentRole.id,
      'lmstudio',
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
            `[LmStudioClient] Failed to register subagent ${definition.name}:`,
            error,
          );
        }
      }
    }

    // Convert registered tools to LM Studio format (OpenAI-compatible)
    const functionDeclarations = toolRegistry.getFunctionDeclarations();
    const lmstudioTools = functionDeclarations.map((func) =>
      this.convertGeminiToolToLmStudio(func),
    );

    this.getChat().setTools(lmstudioTools);

    console.log(
      `[LmStudioClient] Updated tools for role: ${currentRole.id} (${lmstudioTools.length} tools)`,
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

    // Convert PartListUnion to LM Studio message format
    // Tool responses (functionResponse parts) are converted to tool messages
    // and will be added to history by sendMessageStream
    const message = this.convertRequestToLmStudioMessage(request);

    // Get model from config or use default
    // For LM Studio, the model name should match the loaded model in LM Studio
    // Get model from global config or use default
    const globalModel = this.config.getGlobalModel();
    const model = globalModel || this.config.getModel() || 'local-model';

    console.log(`[LmStudioClient] Sending message with model: ${model}`);

    // Send message to LM Studio
    const stream = await this.getChat().sendMessageStream(model, message);

    // Track content blocks for tool use and metadata
    const contentBlocks: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];
    let accumulatedContent = '';
    let accumulatedReasoning = ''; // Accumulate reasoning like Gemini does
    let finishReason: import('@google/genai').FinishReason | undefined;
    let usageMetadata:
      | import('@google/genai').GenerateContentResponseUsageMetadata
      | undefined;

    try {
      // Convert LM Studio events to Gemini events
      for await (const event of stream) {
        // Check for abort signal
        if (signal.aborted) {
          yield { type: GeminiEventType.UserCancelled };
          return new Turn(this.getChat() as never, prompt_id);
        }

        if (event.type === 'chunk') {
          const lmstudioChunk = event.value;
          const delta = lmstudioChunk.choices[0]?.delta;

          if (!delta) continue;

          // Handle reasoning content - accumulate but don't send yet
          // Following Gemini pattern: accumulate reasoning and send complete Thought after stream
          // Note: Chat layer also accumulates reasoning and saves to history for persistence
          if ('reasoning' in delta && delta.reasoning) {
            accumulatedReasoning += delta.reasoning as string;
          }

          // Handle text content
          if (delta.content) {
            accumulatedContent += delta.content;

            // Don't yield Harmony format content to frontend - it will be processed as tool calls later
            // Harmony format markers: <|channel|>, <|message|>, <|call|>, etc.
            const hasHarmonyMarker =
              delta.content.includes('<|channel|>') ||
              delta.content.includes('<|message|>') ||
              delta.content.includes('<|call|>') ||
              accumulatedContent.includes('<|channel|>') ||
              accumulatedContent.includes('<|message|>');

            if (!hasHarmonyMarker) {
              yield {
                type: GeminiEventType.Content,
                value: delta.content,
              };
            }
            // else {
            //   console.log('[LmStudioClient] Suppressing Harmony format content from stream display');
            // }
          }

          // Handle tool calls
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
                // Don't emit ToolCallRequest here - wait until we have complete arguments
              } else {
                // Accumulate function arguments
                if (toolCall.function?.arguments) {
                  contentBlocks[index].function.arguments +=
                    toolCall.function.arguments;
                }
              }
            }
          }

          // Handle finish reason
          const openaiFinishReason = lmstudioChunk.choices[0]?.finish_reason;
          if (openaiFinishReason) {
            // Map OpenAI finish reasons to Gemini finish reasons
            finishReason = this.mapFinishReason(openaiFinishReason);
          }

          // Handle usage metadata (if available)
          if (lmstudioChunk.usage) {
            usageMetadata = {
              promptTokenCount: lmstudioChunk.usage.prompt_tokens,
              candidatesTokenCount: lmstudioChunk.usage.completion_tokens,
              totalTokenCount: lmstudioChunk.usage.total_tokens,
            };
          }
        }
      }

      // Process accumulated tool calls (from OpenAI format) and emit with complete arguments
      for (const block of contentBlocks) {
        if (block.function.name && block.function.arguments) {
          try {
            const args = JSON.parse(block.function.arguments);
            yield {
              type: GeminiEventType.ToolCallRequest,
              value: {
                callId: block.id,
                name: block.function.name,
                args,
                isClientInitiated: false,
                prompt_id,
              },
            };
          } catch (error) {
            console.error(
              '[LmStudioClient] Failed to parse tool call arguments:',
              error,
            );
          }
        }
      }

      // Send accumulated reasoning as complete Thought event (like Gemini does)
      if (accumulatedReasoning) {
        yield {
          type: GeminiEventType.Thought,
          value: {
            subject: '',
            description: accumulatedReasoning,
          },
        };
      }

      // Check for Harmony format tool calls in Chat history
      const history = this.getChat().getHistory();
      const lastMessage = history[history.length - 1];

      if (
        lastMessage &&
        lastMessage.role === 'assistant' &&
        'tool_calls' in lastMessage
      ) {
        const toolCalls = lastMessage.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          console.log(
            `[LmStudioClient] Found ${toolCalls.length} Harmony format tool calls in history`,
          );

          for (const toolCall of toolCalls) {
            // Check if it's a function type tool call
            if (toolCall.type === 'function' && 'function' in toolCall) {
              try {
                const args = JSON.parse(toolCall.function.arguments);
                yield {
                  type: GeminiEventType.ToolCallRequest,
                  value: {
                    callId: toolCall.id,
                    name: toolCall.function.name,
                    args,
                    isClientInitiated: false,
                    prompt_id,
                  },
                };
              } catch (error) {
                console.error(
                  '[LmStudioClient] Failed to parse Harmony tool call arguments:',
                  error,
                );
              }
            }
          }
        }
      }

      // Emit finish event
      yield {
        type: GeminiEventType.Finished,
        value: {
          reason: finishReason,
          usageMetadata,
        },
      };

      // Note: History management (including Harmony format parsing) is now handled
      // by LmStudioChat.processStreamResponse(), following the same pattern as GeminiChat.

      return new Turn(this.getChat() as never, prompt_id);
    } catch (error) {
      console.error('[LmStudioClient] Stream error:', error);
      throw error;
    }
  }

  /**
   * Convert PartListUnion to LM Studio ChatCompletionMessageParam
   */
  private convertRequestToLmStudioMessage(
    request: PartListUnion,
  ): import('openai/resources/chat/completions.js').ChatCompletionMessageParam {
    let messageContent = '';
    const toolMessages: Array<{
      role: 'tool';
      content: string;
      tool_call_id: string;
    }> = [];

    if (Array.isArray(request)) {
      for (const part of request) {
        if (typeof part === 'string') {
          messageContent += part;
        } else if ('text' in part && part.text) {
          messageContent += part.text;
        } else if ('functionResponse' in part && part.functionResponse) {
          const funcResp = part.functionResponse;
          toolMessages.push({
            role: 'tool',
            content: JSON.stringify(funcResp.response || {}),
            tool_call_id: funcResp.id ?? 'unknown',
          });
        }
      }
    } else if (typeof request === 'string') {
      messageContent = request;
    } else if ('text' in request) {
      messageContent = request.text || '';
    }

    // If we have tool responses, return them as tool messages
    if (toolMessages.length > 0) {
      return toolMessages[0];
    }

    // Return user message
    return {
      role: 'user',
      content: messageContent || '',
    };
  }

  /**
   * Map OpenAI finish reasons to Gemini finish reasons
   */
  private mapFinishReason(
    openaiReason: string,
  ): import('@google/genai').FinishReason {
    switch (openaiReason) {
      case 'stop':
        return 'stop' as import('@google/genai').FinishReason;
      case 'length':
        return 'maxTokens' as import('@google/genai').FinishReason;
      case 'content_filter':
        return 'safety' as import('@google/genai').FinishReason;
      case 'tool_calls':
      case 'function_call':
        return 'stop' as import('@google/genai').FinishReason;
      default:
        return 'other' as import('@google/genai').FinishReason;
    }
  }

  /**
   * Try to compress chat history
   *
   * LM Studio typically runs smaller local models with limited context windows.
   * This method implements chat history compression similar to OpenAI:
   * 1. Estimate token count from history
   * 2. Trigger compression at 70% of context limit
   * 3. Keep recent 30% of history and summarize the rest
   */
  async tryCompressChat(
    _prompt_id: string,
    _force: boolean = false,
  ): Promise<ChatCompressionInfo> {
    const { CompressionStatus } = await import('./turn.js');

    const history = this.getHistory();

    // LM Studio local models typically have smaller context windows
    // Using conservative estimate for local models (e.g., Llama, Mistral)
    const CONTEXT_LIMIT = 8192; // Common limit for local models (8K tokens)
    const COMPRESSION_THRESHOLD = 0.7; // Compress at 70% of limit
    const PRESERVE_FRACTION = 0.3; // Keep last 30%

    // Estimate token count (rough approximation: 1 token ≈ 4 chars)
    const estimatedTokens = Math.floor(JSON.stringify(history).length / 4);

    // Check if compression is needed
    if (!_force && estimatedTokens < CONTEXT_LIMIT * COMPRESSION_THRESHOLD) {
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

    // Create summary message
    const summaryText = this.createHistorySummary(olderMessages);
    const summaryMessage: UniversalMessage = {
      role: 'user',
      content: `[Previous conversation summary: ${summaryText}]`,
      timestamp: new Date(),
    };

    // Build compressed history
    const compressedHistory = [summaryMessage, ...recentMessages];

    // Update history
    this.setHistory(compressedHistory);

    // Estimate new token count
    const newEstimatedTokens = Math.floor(
      JSON.stringify(compressedHistory).length / 4,
    );

    console.log(
      `[LmStudioClient] Compressed chat: ${estimatedTokens} → ${newEstimatedTokens} tokens (${history.length} → ${compressedHistory.length} messages)`,
    );

    return {
      originalTokenCount: estimatedTokens,
      newTokenCount: newEstimatedTokens,
      compressionStatus: CompressionStatus.COMPRESSED,
    };
  }

  /**
   * Create a summary of conversation history
   */
  private createHistorySummary(history: UniversalMessage[]): string {
    const summaryParts: string[] = [];

    for (const msg of history) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      const text = msg.content.trim();

      if (text) {
        // Truncate long messages
        const truncated =
          text.length > 100 ? text.substring(0, 100) + '...' : text;
        summaryParts.push(`${role}: ${truncated}`);
      }
    }

    return summaryParts.join('; ');
  }

  /**
   * Update generation config
   */
  async updateGenerateContentConfig(): Promise<void> {
    // LM Studio doesn't require dynamic config updates
    // Configuration is typically set when creating the chat
  }

  /**
   * Reset chat session
   */
  async resetChat(): Promise<void> {
    if (this.chat) {
      this.chat.clearHistory();
    }
  }

  /**
   * Get available models from LM Studio server
   */
  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await this.getChat().listModels();
      return response.data.map((model) => model.id);
    } catch (error) {
      console.error('[LmStudioClient] Failed to fetch models:', error);
      return [];
    }
  }

  // Note: Harmony format parsing has been moved to LmStudioChat.processStreamResponse()
  // to follow the same architecture pattern as GeminiChat.
  // The Client layer now only handles event type conversion (LmStudioStreamEvent → GeminiEventType)
  // and Harmony content filtering for UI display.

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
                  `[LmStudioClient] Updated toolCall ${toolCallId} status to failed`,
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

        // Check if message has reasoning field (LM Studio extended field)
        // The Chat layer should have already converted reasoning to <think> tags in content
        // But if content doesn't have <think> tags (e.g., from old sessions or direct API),
        // add them here for frontend display
        if (
          'reasoning' in msg &&
          typeof msg.reasoning === 'string' &&
          msg.reasoning
        ) {
          if (!content.includes('<think>')) {
            content = `<think>\n${msg.reasoning}\n</think>\n\n${content}`;
          }
        }

        const message: UniversalMessage = {
          role: 'assistant',
          content,
          timestamp: new Date(),
          parts: [msg], // Preserve original OpenAI message (including reasoning field if present)
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
