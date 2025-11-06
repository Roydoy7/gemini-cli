/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { ChatRecordingService } from '../services/chatRecordingService.js';

// Type aliases for OpenAI SDK types (LM Studio uses OpenAI-compatible API)
type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionCreateParamsStreaming = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ChatCompletionContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type ChatCompletionContentPartText = OpenAI.Chat.Completions.ChatCompletionContentPartText;

/**
 * Stream event types for LM Studio chat
 */
export enum LmStudioStreamEventType {
  CHUNK = 'chunk',
  RETRY = 'retry',
}

export type LmStudioStreamEvent =
  | { type: LmStudioStreamEventType.CHUNK; value: ChatCompletionChunk }
  | { type: LmStudioStreamEventType.RETRY };

/**
 * LM Studio chat session that maintains conversation history and handles
 * streaming responses from LM Studio's OpenAI-compatible API.
 *
 * LM Studio provides a local LLM server with OpenAI-compatible endpoints,
 * allowing you to run models locally while using the same API interface.
 */
export class LmStudioChat {
  private readonly client: OpenAI;
  private readonly chatRecordingService: ChatRecordingService;
  private history: ChatCompletionMessageParam[] = [];
  private systemInstruction?: string;
  private tools?: ChatCompletionTool[];

  constructor(config: Config, baseURL?: string) {
    // Initialize OpenAI client with LM Studio base URL
    // Default LM Studio local server URL is http://localhost:1234/v1
    this.client = new OpenAI({
      baseURL:
        baseURL ||
        process.env['LMSTUDIO_BASE_URL'] ||
        'http://localhost:1234/v1',
      apiKey: 'lm-studio', // LM Studio doesn't require a real API key
    });

    this.chatRecordingService = new ChatRecordingService(config);
    this.chatRecordingService.initialize();
  }

  setSystemInstruction(sysInstr: string): void {
    this.systemInstruction = sysInstr;
  }

  /**
   * Send a message to LM Studio and get streaming response
   */
  async sendMessageStream(
    model: string,
    message: ChatCompletionMessageParam,
  ): Promise<AsyncGenerator<LmStudioStreamEvent>> {
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
          yield { type: LmStudioStreamEventType.CHUNK, value: chunk };
        }

        streamCompletedSuccessfully = true;
      } catch (error) {
        console.error('[LmStudioChat] Stream error:', error);
        throw error;
      } finally {
        // Rollback history if stream was interrupted
        if (!streamCompletedSuccessfully) {
          console.warn(
            '[LmStudioChat] Stream was interrupted before completion, rolling back history to prevent corruption',
          );
          console.warn(
            `[LmStudioChat] Rolling back from ${self.history.length} to ${historyLengthBeforeRequest} entries`,
          );
          self.history = self.history.slice(0, historyLengthBeforeRequest);
        }
      }
    })();

    // Process the stream (similar to GeminiChat pattern)
    return this.processStreamResponse(model, rawStream);
  }

  /**
   * Process stream response and add to history
   * Similar to GeminiChat.processStreamResponse - yields chunks while accumulating,
   * then adds the complete assistant response to history after the stream finishes.
   *
   * @param model - The model name
   * @param stream - The stream of LM Studio events
   * @returns AsyncGenerator that yields the same events while processing
   */
  async *processStreamResponse(
    model: string,
    stream: AsyncGenerator<LmStudioStreamEvent>,
  ): AsyncGenerator<LmStudioStreamEvent> {
    let accumulatedContent = '';
    let accumulatedReasoning = ''; // Accumulate reasoning content
    const accumulatedToolCalls: Array<{
      index: number;
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];

    for await (const event of stream) {
      // Yield every event immediately (like GeminiChat does)
      yield event;

      if (event.type !== LmStudioStreamEventType.CHUNK) continue;

      const chunk = event.value;
      const delta = chunk.choices[0]?.delta;

      if (!delta) continue;

      // Accumulate reasoning content (similar to Gemini's thinking)
      if ('reasoning' in delta && delta.reasoning) {
        accumulatedReasoning += delta.reasoning as string;
      }

      // Accumulate text content
      if (delta.content) {
        accumulatedContent += delta.content;
      }

      // Accumulate tool calls (standard OpenAI format)
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

    // Parse Harmony format if detected in accumulated content
    // Harmony format: <|channel|>commentary to=tool_name code<|message|>{"param": "value"}
    const harmonyToolCalls = this.parseHarmonyFormat(accumulatedContent);
    if (harmonyToolCalls.length > 0) {
      console.log(
        `[LmStudioChat] Detected Harmony format, parsed ${harmonyToolCalls.length} tool calls`,
      );

      // Add parsed Harmony tool calls to accumulated tool calls
      for (const harmonyCall of harmonyToolCalls) {
        accumulatedToolCalls.push({
          index: accumulatedToolCalls.length,
          id: `harmony_${Date.now()}_${accumulatedToolCalls.length}`,
          type: 'function',
          function: {
            name: harmonyCall.name,
            arguments: harmonyCall.arguments,
          },
        });
      }

      // Clear the Harmony format content as it's now converted to tool calls
      accumulatedContent = '';
    }

    // Build assistant message
    const assistantMessage: ChatCompletionMessageParam & {
      reasoning?: string;
    } = {
      role: 'assistant',
      content: accumulatedContent || null,
    };

    // Convert reasoning to <think> tagged text format before saving to history
    // This ensures thinking content persists when sessions are reloaded
    // Following the same pattern as Gemini (commit 6d33ccf47)
    if (accumulatedReasoning) {
      const thinkingText = `<think>\n${accumulatedReasoning}\n</think>\n\n`;
      console.log(
        `[LmStudioChat] Converting reasoning to <think> tagged text (${accumulatedReasoning.substring(0, 50)}...)`,
      );

      // Prepend thinking text to content
      if (assistantMessage.content) {
        assistantMessage.content = thinkingText + assistantMessage.content;
      } else {
        assistantMessage.content = thinkingText;
      }

      // Also keep reasoning field for Client layer to access
      assistantMessage.reasoning = accumulatedReasoning;
    }

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
   * Parse Harmony format tool calls from text content
   *
   * Supported formats:
   * 1. Full format: <|channel|>commentary to=tool_name code<|message|>CODE_CONTENT
   * 2. New format: <|start|>assistant<|channel|>commentary to=functions.tool_name<|constrain|>json<|message|>JSON_ARGS
   * 3. Simplified: <|message|>CODE_CONTENT (defaults to python_embedded_tools)
   *
   * Examples:
   * - <|channel|>commentary to=python code<|message|>import os, json\n...
   * - <|start|>assistant<|channel|>commentary to=functions.list_dir<|constrain|>json<|message|>{"path":"C:\\temp"}
   * - <|message|>import os\nprint('hello')
   */
  private parseHarmonyFormat(
    content: string,
  ): Array<{ name: string; arguments: string }> {
    const toolCalls: Array<{ name: string; arguments: string }> = [];

    // Strip <|start|>assistant prefix if present
    const processedContent = content.replace(/^<\|start\|>assistant/, '');

    // Pattern 1: <|channel|>commentary to=TOOL_NAME (code|<|constrain|>json)<|message|>ARGUMENTS
    // Matches both old format (with "code") and new format (with "<|constrain|>json")
    const channelPattern =
      /<\|channel\|>commentary\s+to=(?:functions\.)?(\w+)(?:\s+code|<\|constrain\|>\w+)<\|message\|>(.+?)(?=<\|channel\||<\|start\||$)/gs;

    let match;
    while ((match = channelPattern.exec(processedContent)) !== null) {
      const toolName = match[1];
      const toolArguments = match[2].trim();

      console.log(`[LmStudioChat] Parsed Harmony tool call: ${toolName}`);
      console.log(
        `[LmStudioChat] Arguments length: ${toolArguments.length} chars`,
      );

      // Create tool call with arguments as JSON
      let parsedArguments: string;
      try {
        // Try to parse as JSON first
        JSON.parse(toolArguments);
        parsedArguments = toolArguments;
      } catch {
        // If not JSON, wrap it in the expected structure for code
        parsedArguments = JSON.stringify({ code: toolArguments });
      }

      toolCalls.push({
        name: toolName,
        arguments: parsedArguments,
      });
    }

    // Pattern 2: Simplified format <|message|>CODE (no channel header)
    // Only match if we haven't found any channel-based tool calls
    if (toolCalls.length === 0 && processedContent.includes('<|message|>')) {
      const messagePattern = /<\|message\|>(.+?)$/s;
      const messageMatch = messagePattern.exec(processedContent);

      if (messageMatch) {
        const code = messageMatch[1].trim();
        console.log(
          `[LmStudioChat] Parsed simplified Harmony format (defaulting to python_embedded_tools)`,
        );
        console.log(`[LmStudioChat] Code length: ${code.length} chars`);

        toolCalls.push({
          name: 'python_embedded_tools',
          arguments: JSON.stringify({ code }),
        });
      }
    }

    return toolCalls;
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
    if (
      message.role === 'assistant' &&
      'tool_calls' in message &&
      Array.isArray(message.tool_calls)
    ) {
      console.log(
        `[LmStudioChat] addHistory: Adding assistant message with ${message.tool_calls.length} tool_calls`,
      );
    } else if (message.role === 'tool') {
      const toolCallId =
        'tool_call_id' in message ? String(message.tool_call_id) : 'unknown';
      console.log(
        `[LmStudioChat] addHistory: Adding tool response message (call_id: ${toolCallId})`,
      );
    } else {
      console.log(`[LmStudioChat] addHistory: Adding ${message.role} message`);
    }
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
  static convertGeminiToLmStudioMessage(
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
  static convertLmStudioToGeminiContent(
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
   * List available models from LM Studio server
   * Uses the /v1/models endpoint
   */
  async listModels(): Promise<{ data: Array<{ id: string }> }> {
    const response = await this.client.models.list();
    const models = [];
    for await (const model of response) {
      models.push({ id: model.id });
    }
    return { data: models };
  }
}
