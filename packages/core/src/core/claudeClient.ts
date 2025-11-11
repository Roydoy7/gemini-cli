/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { ClaudeChat } from './claudeChat.js';
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
      '[ClaudeClient] Failed to create environment awareness reminder:',
      error,
    );
    return null;
  }
}

/**
 * ClaudeClient - Manages a single Claude chat session
 *
 * Mirrors GeminiClient's structure but uses Claude API instead of Gemini.
 * Provides the same interface for compatibility with the rest of the system.
 */
export class ClaudeClient implements IClient {
  private chat?: ClaudeChat;
  private readonly roleManager: RoleManager;

  constructor(private readonly config: Config) {
    this.roleManager = RoleManager.getInstance();
  }

  async initialize(): Promise<void> {
    // Get API key from config or environment
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is required for Claude',
      );
    }

    this.chat = new ClaudeChat(this.config, apiKey);
  }

  isInitialized(): boolean {
    return this.chat !== undefined;
  }

  getChat(): ClaudeChat {
    if (!this.chat) {
      throw new Error('Chat not initialized');
    }
    return this.chat;
  }

  getHistory(): UniversalMessage[] {
    // Convert Claude MessageParam[] to UniversalMessage[]
    const claudeHistory = this.getChat().getHistory();
    return this.convertClaudeToUniversal(claudeHistory);
  }

  setHistory(history: UniversalMessage[]): void {
    console.log(
      '[ClaudeClient] setHistory: Converting UniversalMessage[] to Claude format',
    );
    // Convert UniversalMessage[] to Claude MessageParam[]
    const claudeHistory = this.convertUniversalToClaude(history);
    this.getChat().setHistory(claudeHistory);
  }

  async addHistory(content: Content): Promise<void> {
    const claudeMessage = ClaudeChat.convertGeminiToClaudeMessage(content);
    this.getChat().addHistory(claudeMessage);
  }

  stripThoughtsFromHistory(): void {
    // Claude doesn't have built-in thinking mode like Gemini
    // This is a no-op for now, but could be implemented if needed
  }

  async setTools(): Promise<void> {
    const toolRegistry = this.config.getToolRegistry();
    const functionDeclarations = toolRegistry.getFunctionDeclarations();

    // Convert Gemini FunctionDeclarations to Claude Tools
    const claudeTools = functionDeclarations.map((func) =>
      this.convertGeminiToolToClaude(func),
    );

    this.getChat().setTools(claudeTools);
  }

  /**
   * Convert Gemini FunctionDeclaration to Claude Tool format
   */
  private convertGeminiToolToClaude(
    func: import('@google/genai').FunctionDeclaration,
  ): import('@anthropic-ai/sdk/resources/messages.js').Tool {
    // Ensure input_schema has the required structure
    const inputSchema =
      func.parametersJsonSchema && typeof func.parametersJsonSchema === 'object'
        ? (func.parametersJsonSchema as import('@anthropic-ai/sdk/resources/messages.js').Tool.InputSchema)
        : {
            type: 'object' as const,
            properties: {},
          };

    return {
      name: func.name ?? '',
      description: func.description ?? '',
      input_schema: inputSchema,
    };
  }

  async updateToolsForCurrentRole(): Promise<void> {
    if (!this.chat) {
      return;
    }

    // Check if role system is enabled
    if (!this.roleManager.isRoleSystemEnabled()) {
      await this.setTools();
      console.log('[ClaudeClient] Role system disabled, using all tools');
      return;
    }

    const currentRole = this.roleManager.getCurrentRole();

    // Special handling for software_engineer: use original behavior
    if (currentRole.id === 'software_engineer') {
      await this.setTools();
      console.log(
        '[ClaudeClient] Software engineer role - using all registered tools',
      );
      return;
    }

    // For other roles, use tools from ToolsetManager
    const { ToolsetManager } = await import('../tools/ToolsetManager.js');
    const toolsetManager = new ToolsetManager();
    // Filter tools by provider - only get tools that work with Claude
    const roleToolClasses = toolsetManager.getToolsForRole(
      currentRole.id,
      'claude',
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
            `[ClaudeClient] Failed to register subagent ${definition.name}:`,
            error,
          );
        }
      }
    }

    // Convert registered tools to Claude format
    const functionDeclarations = toolRegistry.getFunctionDeclarations();
    const claudeTools = functionDeclarations.map((func) =>
      this.convertGeminiToolToClaude(func),
    );

    this.getChat().setTools(claudeTools);

    console.log(
      `[ClaudeClient] Updated tools for role: ${currentRole.id} (${claudeTools.length} tools)`,
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

    // Convert PartListUnion to Claude message format
    // Tool responses (functionResponse parts) are converted to tool_result blocks
    // and will be added to history by sendMessageStream
    const message = this.convertRequestToClaudeMessage(modifiedRequest);

    // Get model from global config or use default
    const globalModel = this.config.getGlobalModel();
    const model =
      globalModel || this.config.getModel() || 'claude-3-5-sonnet-20241022';

    console.log(`[ClaudeClient] Sending message with model: ${model}`);

    // Send message to Claude
    const stream = await this.getChat().sendMessageStream(model, message);

    // Track metadata for finish event
    let finishReason: import('@google/genai').FinishReason | undefined;
    let usageMetadata:
      | import('@google/genai').GenerateContentResponseUsageMetadata
      | undefined;

    // Track token usage statistics (import TokenUsage type)
    type TokenUsage = import('./message-types.js').TokenUsage;
    let tokenUsage: TokenUsage | undefined;

    // Track tool use input accumulation (for streaming tool parameters)
    const toolInputAccumulators = new Map<
      number,
      { id: string; name: string; partialJson: string }
    >();

    try {
      // Convert Claude events to Gemini events (event type conversion only)
      // History management is now handled by ClaudeChat.processStreamResponse()
      for await (const event of stream) {
        // Check for abort signal
        if (signal.aborted) {
          yield { type: GeminiEventType.UserCancelled };
          return new Turn(this.getChat() as never, prompt_id);
        }

        if (event.type === 'chunk') {
          const claudeEvent = event.value;

          // Convert Claude stream events to Gemini format
          switch (claudeEvent.type) {
            case 'message_start':
              // Message started - collect initial usage stats
              if (claudeEvent.message?.usage) {
                const usage = claudeEvent.message.usage;
                tokenUsage = {
                  inputTokens: usage.input_tokens || 0,
                  outputTokens: usage.output_tokens || 0,
                  totalTokens:
                    (usage.input_tokens || 0) + (usage.output_tokens || 0),
                  cacheCreationInputTokens:
                    usage.cache_creation_input_tokens || 0,
                  cacheReadInputTokens: usage.cache_read_input_tokens || 0,
                  provider: 'claude',
                  model: claudeEvent.message.model,
                  serviceTier:
                    'service_tier' in usage
                      ? (usage.service_tier as string)
                      : undefined,
                  timestamp: new Date(),
                };

                // Add cache creation details if present
                if ('cache_creation' in usage && usage.cache_creation) {
                  const cacheCreation =
                    usage.cache_creation as unknown as Record<
                      string,
                      number | undefined
                    >;
                  tokenUsage.cacheCreation = {
                    ephemeral_5m_input_tokens:
                      cacheCreation['ephemeral_5m_input_tokens'],
                    ephemeral_1h_input_tokens:
                      cacheCreation['ephemeral_1h_input_tokens'],
                  };
                }

                // Emit token usage event
                yield {
                  type: GeminiEventType.TokenUsage,
                  value: tokenUsage,
                };
              }
              break;

            case 'content_block_start':
              // New content block started
              if (claudeEvent.content_block) {
                // If it's a tool use block, store it for later (we'll emit after input is complete)
                if (claudeEvent.content_block.type === 'tool_use') {
                  const toolUseBlock = claudeEvent.content_block;
                  toolInputAccumulators.set(claudeEvent.index, {
                    id: toolUseBlock.id,
                    name: toolUseBlock.name,
                    partialJson: JSON.stringify(toolUseBlock.input || {}),
                  });
                }
                // Handle thinking blocks (Claude Extended Thinking)
                else if (claudeEvent.content_block.type === 'thinking') {
                  const thinkingBlock = claudeEvent.content_block as {
                    type: 'thinking';
                    thinking: string;
                  };
                  if (thinkingBlock.thinking) {
                    yield {
                      type: GeminiEventType.Thought,
                      value: {
                        subject: '',
                        description: thinkingBlock.thinking,
                      },
                    };
                  }
                }
              }
              break;

            case 'content_block_delta':
              if (claudeEvent.delta.type === 'text_delta') {
                // Emit text as Content event
                yield {
                  type: GeminiEventType.Content,
                  value: claudeEvent.delta.text,
                };
              }
              // Handle thinking deltas (streaming thinking content)
              else if (claudeEvent.delta.type === 'thinking_delta') {
                const thinkingDelta = claudeEvent.delta as {
                  type: 'thinking_delta';
                  thinking: string;
                };
                if (thinkingDelta.thinking) {
                  yield {
                    type: GeminiEventType.Thought,
                    value: {
                      subject: '',
                      description: thinkingDelta.thinking,
                    },
                  };
                }
              }
              // Handle input_json_delta (streaming tool parameters)
              else if (claudeEvent.delta.type === 'input_json_delta') {
                const inputDelta = claudeEvent.delta as {
                  type: 'input_json_delta';
                  partial_json: string;
                };
                // Accumulate the partial JSON
                const accumulator = toolInputAccumulators.get(
                  claudeEvent.index,
                );
                if (accumulator) {
                  accumulator.partialJson += inputDelta.partial_json;
                }
              }
              break;

            case 'content_block_stop': {
              // Content block completed - emit tool call if this was a tool_use block
              const accumulator = toolInputAccumulators.get(claudeEvent.index);
              if (accumulator) {
                try {
                  // Parse the complete JSON input
                  const args = JSON.parse(accumulator.partialJson) as Record<
                    string,
                    unknown
                  >;
                  yield {
                    type: GeminiEventType.ToolCallRequest,
                    value: {
                      callId: accumulator.id,
                      name: accumulator.name,
                      args,
                      isClientInitiated: false,
                      prompt_id,
                    },
                  };
                } catch (error) {
                  console.error(
                    `[ClaudeClient] Failed to parse tool input JSON: ${error}`,
                  );
                  // Emit with empty args on parse error
                  yield {
                    type: GeminiEventType.ToolCallRequest,
                    value: {
                      callId: accumulator.id,
                      name: accumulator.name,
                      args: {},
                      isClientInitiated: false,
                      prompt_id,
                    },
                  };
                }
                // Clean up accumulator
                toolInputAccumulators.delete(claudeEvent.index);
              }
              break;
            }

            case 'message_delta':
              // Handle stop reason and usage metadata
              if (claudeEvent.delta.stop_reason) {
                // Map Claude stop reasons to Gemini finish reasons
                const stopReason = claudeEvent.delta.stop_reason;
                if (stopReason === 'end_turn') {
                  finishReason = 'stop' as import('@google/genai').FinishReason;
                } else if (stopReason === 'max_tokens') {
                  finishReason =
                    'maxTokens' as import('@google/genai').FinishReason;
                } else if (stopReason === 'stop_sequence') {
                  finishReason = 'stop' as import('@google/genai').FinishReason;
                } else if (stopReason === 'tool_use') {
                  finishReason = 'stop' as import('@google/genai').FinishReason;
                }
              }
              if (claudeEvent.usage) {
                // Map Claude usage to Gemini usage metadata
                usageMetadata = {
                  promptTokenCount: claudeEvent.usage.input_tokens || 0,
                  candidatesTokenCount: claudeEvent.usage.output_tokens || 0,
                  totalTokenCount:
                    (claudeEvent.usage.input_tokens || 0) +
                    (claudeEvent.usage.output_tokens || 0),
                };

                // Update token usage statistics (delta provides final output token count)
                if (tokenUsage) {
                  tokenUsage.outputTokens =
                    claudeEvent.usage.output_tokens || 0;
                  tokenUsage.totalTokens =
                    tokenUsage.inputTokens + tokenUsage.outputTokens;

                  // Emit updated token usage event with final counts
                  yield {
                    type: GeminiEventType.TokenUsage,
                    value: tokenUsage,
                  };
                }
              }
              break;

            case 'message_stop':
              // Message completed successfully - emit Finished event
              yield {
                type: GeminiEventType.Finished,
                value: {
                  reason: finishReason,
                  usageMetadata,
                },
              };
              break;

            default:
              // Ignore other event types
              break;
          }
        }
      }

      // Note: History management is now handled by ClaudeChat.processStreamResponse(),
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
   * Convert PartListUnion request to Claude MessageParam format
   * Handles text parts and tool responses (functionResponse)
   */
  private convertRequestToClaudeMessage(
    request: PartListUnion,
  ): import('@anthropic-ai/sdk/resources/messages.js').MessageParam {
    type ToolResultBlock = {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    };
    type TextBlock = { type: 'text'; text: string };
    type ContentBlock = TextBlock | ToolResultBlock;

    const contentBlocks: ContentBlock[] = [];

    if (typeof request === 'string') {
      contentBlocks.push({ type: 'text', text: request });
    } else if (Array.isArray(request)) {
      for (const part of request) {
        if (typeof part === 'string') {
          contentBlocks.push({ type: 'text', text: part });
        } else if ('text' in part && part.text) {
          contentBlocks.push({ type: 'text', text: part.text });
        } else if ('functionResponse' in part && part.functionResponse) {
          // Convert Gemini functionResponse to Claude tool_result
          const funcResp = part.functionResponse;
          contentBlocks.push({
            type: 'tool_result',
            tool_use_id: funcResp.id ?? 'unknown', // Use ID not name
            content: JSON.stringify(funcResp.response || {}),
          });
        }
      }
    }

    // If no content blocks, add empty text
    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: '' });
    }

    return {
      role: 'user',
      content: contentBlocks,
    };
  }

  /**
   * Try to compress chat history when context limit is approached
   *
   * For Claude, we use a simple approach:
   * 1. Count tokens using Anthropic's counting method (approximate with chars/4)
   * 2. If exceeds threshold (70% of limit), compress older messages
   * 3. Keep recent 30% of history and summarize the rest
   */
  async tryCompressChat(
    _prompt_id: string,
    _force: boolean = false,
  ): Promise<ChatCompressionInfo> {
    const { CompressionStatus } = await import('./turn.js');

    const history = this.getHistory();

    // Claude models typically have 200k context window
    // Using conservative estimate of 150k for safety
    const CONTEXT_LIMIT = 150000;
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
      `[ClaudeClient] Compressed chat: ${estimatedTokens} → ${newEstimatedTokens} tokens (${history.length} → ${compressedHistory.length} messages)`,
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
    // For Claude, this is called before each message send
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
   * Get list of available Claude models
   * Fetches the list from Anthropic API using the /v1/models endpoint
   */
  async getAvailableModels(): Promise<string[]> {
    if (!this.isInitialized()) {
      throw new Error('ClaudeClient not initialized');
    }

    try {
      const chat = this.getChat();
      const modelsResponse = await chat.listModels();
      return modelsResponse.data.map((model) => model.id);
    } catch (error) {
      console.error('[ClaudeClient] Failed to fetch models from API:', error);
      // Fallback to hardcoded list if API call fails
      return [
        'claude-4-1-opus',
        'claude-4-5-sonnet-20250929',
        'claude-4-5-haiku',
      ];
    }
  }

  /**
   * Convert Claude MessageParam[] to UniversalMessage[]
   */
  private convertClaudeToUniversal(
    messages: Array<
      import('@anthropic-ai/sdk/resources/messages.js').MessageParam
    >,
  ): UniversalMessage[] {
    const universalMessages: UniversalMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        // User message (may contain tool_result blocks)
        const contentBlocks = Array.isArray(msg.content)
          ? msg.content
          : [{ type: 'text' as const, text: msg.content }];

        for (const block of contentBlocks) {
          if (block.type === 'tool_result') {
            // Tool result block
            const toolCallId = block.tool_use_id;
            const toolContent =
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);

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
                      `[ClaudeClient] Updated toolCall ${toolCallId} status to failed`,
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
              parts: [msg], // Preserve original Claude message
            });
          } else if (block.type === 'text') {
            // Regular text message
            universalMessages.push({
              role: 'user',
              content: block.text,
              timestamp: new Date(),
              parts: [msg], // Preserve original Claude message
            });
          }
        }
      } else if (msg.role === 'assistant') {
        // Assistant message (may contain tool_use blocks)
        const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
        let textContent = '';
        const toolCalls: Array<{
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }> = [];

        for (const block of contentBlocks) {
          if (block.type === 'text') {
            textContent += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: (block.input || {}) as Record<string, unknown>,
            });
          }
        }

        const message: UniversalMessage = {
          role: 'assistant',
          content: textContent,
          timestamp: new Date(),
          parts: [msg], // Preserve original Claude message
        };

        if (toolCalls.length > 0) {
          message.toolCalls = toolCalls;
        }

        universalMessages.push(message);
      }
    }

    return universalMessages;
  }

  /**
   * Convert UniversalMessage[] to Claude MessageParam[]
   */
  private convertUniversalToClaude(
    messages: UniversalMessage[],
  ): Array<import('@anthropic-ai/sdk/resources/messages.js').MessageParam> {
    const claudeMessages: Array<
      import('@anthropic-ai/sdk/resources/messages.js').MessageParam
    > = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        continue;
      }

      // If parts field exists and contains original Claude message, restore it directly
      // This preserves ALL fields
      if (msg.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
        const originalMsg = msg.parts[0];
        if (
          originalMsg &&
          typeof originalMsg === 'object' &&
          'role' in originalMsg
        ) {
          claudeMessages.push(
            originalMsg as import('@anthropic-ai/sdk/resources/messages.js').MessageParam,
          );
          continue;
        }
      }

      // Fallback: reconstruct message from UniversalMessage fields
      // This is for backward compatibility with messages that don't have parts field
      if (msg.role === 'tool') {
        // Tool result - add as user message with tool_result block
        claudeMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id || '',
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === 'assistant') {
        // Assistant message
        const contentBlocks: Array<
          | import('@anthropic-ai/sdk/resources/messages.js').TextBlock
          | import('@anthropic-ai/sdk/resources/messages.js').ToolUseBlock
        > = [];

        if (msg.content) {
          contentBlocks.push({
            type: 'text',
            text: msg.content,
            citations: [],
          });
        }

        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }

        claudeMessages.push({
          role: 'assistant',
          content: contentBlocks,
        });
      } else if (msg.role === 'user') {
        // User message
        claudeMessages.push({
          role: 'user',
          content: msg.content,
        });
      }
    }

    return claudeMessages;
  }
}
