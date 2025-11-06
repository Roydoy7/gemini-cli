/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { ChatRecordingService } from '../services/chatRecordingService.js';

// Type aliases for Anthropic SDK types
type MessageParam = Anthropic.Messages.MessageParam;
type MessageCreateParams = Anthropic.Messages.MessageCreateParams;
type MessageStreamEvent = Anthropic.Messages.MessageStreamEvent;
type Tool = Anthropic.Messages.Tool;
type TextBlock = Anthropic.Messages.TextBlock;
type ContentBlock = Anthropic.Messages.ContentBlock;

/**
 * Stream event types for Claude chat
 */
export enum ClaudeStreamEventType {
  CHUNK = 'chunk',
  RETRY = 'retry',
}

export type ClaudeStreamEvent =
  | { type: ClaudeStreamEventType.CHUNK; value: MessageStreamEvent }
  | { type: ClaudeStreamEventType.RETRY };

/**
 * Claude chat session that maintains conversation history and handles
 * streaming responses from Claude API.
 */
export class ClaudeChat {
  private readonly client: Anthropic;
  private readonly chatRecordingService: ChatRecordingService;
  private history: MessageParam[] = [];
  private systemInstruction?: string;
  private tools?: Tool[];

  constructor(config: Config, apiKey?: string) {
    // Initialize Anthropic SDK client
    this.client = new Anthropic({
      apiKey: apiKey || process.env['ANTHROPIC_API_KEY'],
    });

    this.chatRecordingService = new ChatRecordingService(config);
    this.chatRecordingService.initialize();
  }

  setSystemInstruction(sysInstr: string): void {
    this.systemInstruction = sysInstr;
  }

  /**
   * Send a message to Claude and get streaming response
   */
  async *sendMessageStream(
    model: string,
    message: MessageParam,
  ): AsyncGenerator<ClaudeStreamEvent> {
    // Add user message to history
    this.history.push(message);

    // Record user message
    if (message.role === 'user') {
      const content = this.extractTextFromMessage(message);
      if (content) {
        this.chatRecordingService.recordMessage({
          model,
          type: 'user',
          content,
        });
      }
    }

    // Prepare messages with cache breakpoint for conversation history
    // Add cache_control to the last message in history to enable caching
    const requestMessages = [...this.history];

    // Apply cache breakpoint to the last history message (before adding new user message)
    // This caches the entire conversation history up to this point
    if (requestMessages.length > 0) {
      const lastMsg = requestMessages[requestMessages.length - 1];
      if (lastMsg && typeof lastMsg.content !== 'string' && Array.isArray(lastMsg.content)) {
        // If content is an array of blocks, add cache_control to the last cacheable block
        const contentBlocks = [...lastMsg.content];
        if (contentBlocks.length > 0) {
          // Find the last cacheable block (text, tool_use, or tool_result)
          // thinking blocks don't support cache_control
          for (let i = contentBlocks.length - 1; i >= 0; i--) {
            const block = contentBlocks[i];
            if (
              block.type === 'text' ||
              block.type === 'tool_use' ||
              block.type === 'tool_result'
            ) {
              // Add cache_control using type assertion as the TypeScript definitions
              // don't include cache_control yet, but the API supports it
              contentBlocks[i] = {
                ...block,
                cache_control: { type: 'ephemeral' as const },
              } as unknown as ContentBlock;
              requestMessages[requestMessages.length - 1] = {
                ...lastMsg,
                content: contentBlocks,
              };
              break;
            }
          }
        }
      }
      // Note: If content is a string, we cannot add cache_control to it directly
      // In that case, caching will rely on system prompt and tools caching
    }

    const historyLengthBeforeRequest = this.history.length;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    let streamCompletedSuccessfully = false;

    // Create an async generator that wraps the stream and calls processStreamResponse
    const rawStream = (async function* () {
      try {
        const params: MessageCreateParams = {
          model,
          messages: requestMessages,
          max_tokens: 8192,
          stream: true,
        };

        if (self.systemInstruction) {
          // Use system prompt with cache_control for prompt caching
          // This enables Claude to cache the system prompt across requests
          params.system = [
            {
              type: 'text' as const,
              text: self.systemInstruction,
              cache_control: { type: 'ephemeral' as const },
            },
          ];
        }

        // Apply cache_control to tools for prompt caching
        // Caching tools is very beneficial as tool definitions rarely change
        if (self.tools && self.tools.length > 0) {
          const toolsWithCache = [...self.tools];
          // Add cache_control to the last tool
          toolsWithCache[toolsWithCache.length - 1] = {
            ...toolsWithCache[toolsWithCache.length - 1],
            cache_control: { type: 'ephemeral' as const },
          };
          params.tools = toolsWithCache;
        }

        const stream = self.client.messages.stream(params);

        for await (const event of stream) {
          yield { type: ClaudeStreamEventType.CHUNK, value: event };
        }

        streamCompletedSuccessfully = true;
      } catch (error) {
        console.error('[ClaudeChat] Stream error:', error);
        throw error;
      } finally {
        // Rollback history if stream was interrupted
        if (!streamCompletedSuccessfully) {
          console.warn(
            '[ClaudeChat] Stream was interrupted before completion, rolling back history to prevent corruption',
          );
          console.warn(
            `[ClaudeChat] Rolling back from ${self.history.length} to ${historyLengthBeforeRequest} entries`,
          );
          self.history = self.history.slice(0, historyLengthBeforeRequest);
        }
      }
    })();

    // Process the stream (similar to GeminiChat pattern)
    yield* this.processStreamResponse(model, rawStream);
  }

  /**
   * Process stream response and add to history
   * This method properly accumulates all content blocks and adds the complete
   * assistant response to history after the stream finishes.
   * Following GeminiChat pattern: yields events while processing.
   */
  async *processStreamResponse(
    model: string,
    stream: AsyncGenerator<ClaudeStreamEvent>,
  ): AsyncGenerator<ClaudeStreamEvent> {
    const contentBlocks: ContentBlock[] = [];
    let responseText = '';
    let currentBlockIndex = -1;

    for await (const event of stream) {
      // Yield every event immediately (like GeminiChat does)
      yield event;

      if (event.type !== ClaudeStreamEventType.CHUNK) continue;

      const chunk = event.value;

      switch (chunk.type) {
        case 'content_block_start':
          // New content block started
          currentBlockIndex++;
          if (chunk.content_block) {
            contentBlocks[currentBlockIndex] = chunk.content_block;

            // Initialize text for text blocks
            if (chunk.content_block.type === 'text') {
              responseText += chunk.content_block.text;
            }
          }
          break;

        case 'content_block_delta':
          // Update content block with delta
          if (chunk.delta.type === 'text_delta') {
            responseText += chunk.delta.text;

            // Update the text block in contentBlocks
            const block = contentBlocks[chunk.index];
            if (block && block.type === 'text') {
              block.text += chunk.delta.text;
            }
          } else if (chunk.delta.type === 'thinking_delta') {
            // Handle thinking content deltas (Claude Extended Thinking)
            const thinkingDelta = chunk.delta as {
              type: 'thinking_delta';
              thinking: string;
            };
            const block = contentBlocks[chunk.index] as {
              type: 'thinking';
              thinking: string;
            };
            if (block && block.type === 'thinking') {
              block.thinking += thinkingDelta.thinking;
            }
          } else if (chunk.delta.type === 'input_json_delta') {
            // Handle tool input streaming
            const block = contentBlocks[chunk.index];
            if (block && block.type === 'tool_use') {
              // Accumulate tool input (already handled by SDK)
            }
          }
          break;

        case 'content_block_stop':
          // Content block completed
          break;

        case 'message_stop':
          // Stream completed, add assistant response to history
          if (contentBlocks.length > 0) {
            this.history.push({
              role: 'assistant',
              content: contentBlocks,
            });
          }
          break;

        default:
          break;
      }
    }

    // Record assistant response
    if (responseText) {
      this.chatRecordingService.recordMessage({
        model,
        type: 'gemini', // Use 'gemini' type for compatibility
        content: responseText,
      });
    }
  }

  /**
   * Extract text content from a message
   */
  private extractTextFromMessage(message: MessageParam): string {
    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as TextBlock).text)
        .join('');
    }

    return '';
  }

  /**
   * Get chat history
   */
  getHistory(): MessageParam[] {
    return structuredClone(this.history);
  }

  /**
   * Set chat history
   */
  setHistory(history: MessageParam[]): void {
    this.history = history;
  }

  /**
   * Add a message to history
   */
  addHistory(message: MessageParam): void {
    this.history.push(message);
  }

  /**
   * Clear chat history and reset system instruction
   */
  clearHistory(): void {
    this.history = [];
    // Also clear system instruction and tools to prevent context overflow
    // when switching to a new session
    this.systemInstruction = undefined;
    this.tools = undefined;
  }

  /**
   * Set tools for function calling
   */
  setTools(tools: Tool[]): void {
    this.tools = tools;
  }

  /**
   * Convert Gemini Content format to Claude MessageParam format
   */
  static convertGeminiToClaudeMessage(content: Content): MessageParam {
    // Basic conversion - will be enhanced later
    const textParts = content.parts
      ?.filter((part) => part.text)
      .map((part) => part.text)
      .join('');

    return {
      role: content.role === 'model' ? 'assistant' : 'user',
      content: textParts || '',
    };
  }

  /**
   * Convert Claude MessageParam format to Gemini Content format
   */
  static convertClaudeToGeminiContent(message: MessageParam): Content {
    const content =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((block) => block.type === 'text')
              .map((block) => (block as TextBlock).text)
              .join('')
          : '';

    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }],
    };
  }

  /**
   * Get chat recording service
   */
  getChatRecordingService(): ChatRecordingService {
    return this.chatRecordingService;
  }

  /**
   * List available Claude models from the API
   * Uses the /v1/models endpoint
   */
  async listModels(): Promise<{
    data: Array<{ id: string; display_name: string }>;
  }> {
    const response = await this.client.models.list();
    return response as { data: Array<{ id: string; display_name: string }> };
  }
}
