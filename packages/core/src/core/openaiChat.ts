/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionTool,
  ChatCompletionContentPart,
  ChatCompletionContentPartText,
} from 'openai';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { ChatRecordingService } from '../services/chatRecordingService.js';

/**
 * Stream event types for OpenAI chat
 */
export enum OpenAIStreamEventType {
  CHUNK = 'chunk',
  RETRY = 'retry',
}

export type OpenAIStreamEvent =
  | { type: OpenAIStreamEventType.CHUNK; value: ChatCompletionChunk }
  | { type: OpenAIStreamEventType.RETRY };

/**
 * OpenAI chat session that maintains conversation history and handles
 * streaming responses from OpenAI API.
 */
export class OpenAIChat {
  private readonly client: OpenAI;
  private readonly chatRecordingService: ChatRecordingService;
  private history: ChatCompletionMessageParam[] = [];
  private systemInstruction?: string;
  private tools?: ChatCompletionTool[];

  constructor(config: Config, apiKey?: string) {
    // Initialize OpenAI SDK client
    this.client = new OpenAI({
      apiKey: apiKey || process.env['OPENAI_API_KEY'],
    });

    this.chatRecordingService = new ChatRecordingService(config);
    this.chatRecordingService.initialize();
  }

  setSystemInstruction(sysInstr: string): void {
    this.systemInstruction = sysInstr;
  }

  /**
   * Send a message to OpenAI and get streaming response
   */
  async *sendMessageStream(
    model: string,
    message: ChatCompletionMessageParam,
  ): AsyncGenerator<OpenAIStreamEvent> {
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

    const historyLengthBeforeRequest = this.history.length;

    // Build messages array (system instruction + history)
    const messages: ChatCompletionMessageParam[] = [];
    if (this.systemInstruction) {
      messages.push({
        role: 'system',
        content: this.systemInstruction,
      });
    }
    messages.push(...this.history);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    let streamCompletedSuccessfully = false;

    // Create an async generator that wraps the stream and calls processStreamResponse
    const rawStream = (async function* () {
      try {
        const params: ChatCompletionCreateParamsStreaming = {
          model,
          messages,
          stream: true,
        };

        if (self.tools && self.tools.length > 0) {
          params.tools = self.tools;
        }

        const stream = await self.client.chat.completions.create(params);

        for await (const chunk of stream) {
          yield { type: OpenAIStreamEventType.CHUNK, value: chunk };
        }

        streamCompletedSuccessfully = true;
      } catch (error) {
        console.error('[OpenAIChat] Stream error:', error);
        throw error;
      } finally {
        // Rollback history if stream was interrupted
        if (!streamCompletedSuccessfully) {
          console.warn(
            '[OpenAIChat] Stream was interrupted before completion, rolling back history to prevent corruption',
          );
          console.warn(
            `[OpenAIChat] Rolling back from ${self.history.length} to ${historyLengthBeforeRequest} entries`,
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
   * This method properly accumulates all chunks and adds the complete
   * assistant response to history after the stream finishes.
   * Following GeminiChat pattern: yields events while processing.
   */
  async *processStreamResponse(
    model: string,
    stream: AsyncGenerator<OpenAIStreamEvent>,
  ): AsyncGenerator<OpenAIStreamEvent> {
    let accumulatedContent = '';
    const accumulatedToolCalls: Array<{
      index: number;
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];

    for await (const event of stream) {
      // Yield every event immediately (like GeminiChat does)
      yield event;

      if (event.type !== OpenAIStreamEventType.CHUNK) continue;

      const chunk = event.value;
      const delta = chunk.choices[0]?.delta;

      if (!delta) continue;

      // Accumulate text content
      if (delta.content) {
        accumulatedContent += delta.content;
      }

      // Accumulate tool calls
      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index;
          if (!accumulatedToolCalls[index]) {
            accumulatedToolCalls[index] = {
              index,
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
              accumulatedToolCalls[index].function.arguments +=
                toolCall.function.arguments;
            }
          }
        }
      }
    }

    // Build assistant message
    const assistantMessage: ChatCompletionMessageParam = {
      role: 'assistant',
      content: accumulatedContent || null,
    };

    if (accumulatedToolCalls.length > 0) {
      assistantMessage.tool_calls = accumulatedToolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    // Add to history
    this.history.push(assistantMessage);

    // Record assistant response
    if (accumulatedContent) {
      this.chatRecordingService.recordMessage({
        model,
        type: 'gemini', // Use 'gemini' type for compatibility
        content: accumulatedContent,
      });
    }
  }

  /**
   * Extract text content from a message
   */
  private extractTextFromMessage(message: ChatCompletionMessageParam): string {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        return message.content
          .filter((part: ChatCompletionContentPart) => part.type === 'text')
          .map(
            (part: ChatCompletionContentPart) =>
              (part as ChatCompletionContentPartText).text || '',
          )
          .join('');
      }
    }
    return '';
  }

  /**
   * Get chat history
   */
  getHistory(): ChatCompletionMessageParam[] {
    return structuredClone(this.history);
  }

  /**
   * Set chat history
   */
  setHistory(history: ChatCompletionMessageParam[]): void {
    this.history = history;
  }

  /**
   * Add a message to history
   */
  addHistory(message: ChatCompletionMessageParam): void {
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
  setTools(tools: ChatCompletionTool[]): void {
    this.tools = tools;
  }

  /**
   * Convert Gemini Content format to OpenAI ChatCompletionMessageParam format
   */
  static convertGeminiToOpenAIMessage(
    content: Content,
  ): ChatCompletionMessageParam {
    // Extract text from parts
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
   * Convert OpenAI ChatCompletionMessageParam format to Gemini Content format
   */
  static convertOpenAIToGeminiContent(
    message: ChatCompletionMessageParam,
  ): Content {
    let content = '';

    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        content = message.content;
      } else if (Array.isArray(message.content)) {
        content = message.content
          .filter((part: ChatCompletionContentPart) => part.type === 'text')
          .map(
            (part: ChatCompletionContentPart) =>
              (part as ChatCompletionContentPartText).text || '',
          )
          .join('');
      }
    } else if (message.role === 'assistant') {
      content = (message.content as string) || '';
    } else if (message.role === 'system') {
      // System messages don't map to Gemini Content (handled separately as systemInstruction)
      content = (message.content as string) || '';
    }

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
   * List available OpenAI models from the API
   * Uses the /v1/models endpoint
   */
  async listModels(): Promise<{ data: Array<{ id: string }> }> {
    const response = await this.client.models.list();
    // Filter to only chat completion models (gpt-* models)
    const chatModels = [];
    for await (const model of response) {
      if (model.id.startsWith('gpt-')) {
        chatModels.push({ id: model.id });
      }
    }
    return { data: chatModels };
  }
}
