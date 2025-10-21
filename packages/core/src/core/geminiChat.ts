/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// DISCLAIMER: This is a copied version of https://github.com/googleapis/js-genai/blob/main/src/chats.ts with the intention of working around a key bug
// where function responses are not treated as "valid" responses: https://b.corp.google.com/issues/420354090

import {
  GenerateContentResponse,
  type Content,
  type GenerateContentConfig,
  type SendMessageParameters,
  type Part,
  type Tool,
  FinishReason,
} from '@google/genai';
import { toParts } from '../code_assist/converter.js';
import { createUserContent } from '@google/genai';
import { retryWithBackoff } from '../utils/retry.js';
import type { Config } from '../config/config.js';
import {
  DEFAULT_GEMINI_FLASH_MODEL,
  getEffectiveModel,
} from '../config/models.js';
import { hasCycleInSchema, MUTATOR_KINDS } from '../tools/tools.js';
import type { StructuredError } from './turn.js';
import type { CompletedToolCall } from './coreToolScheduler.js';
import {
  logContentRetry,
  logContentRetryFailure,
} from '../telemetry/loggers.js';
import { ChatRecordingService } from '../services/chatRecordingService.js';
import {
  ContentRetryEvent,
  ContentRetryFailureEvent,
} from '../telemetry/types.js';
import { handleFallback } from '../fallback/handler.js';
import { isFunctionResponse } from '../utils/messageInspectors.js';
import { partListUnionToString } from './geminiRequest.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';

export enum StreamEventType {
  /** A regular content chunk from the API. */
  CHUNK = 'chunk',
  /** A signal that a retry is about to happen. The UI should discard any partial
   * content from the attempt that just failed. */
  RETRY = 'retry',
}

export type StreamEvent =
  | { type: StreamEventType.CHUNK; value: GenerateContentResponse }
  | { type: StreamEventType.RETRY };

/**
 * Options for retrying due to invalid content from the model.
 */
interface ContentRetryOptions {
  /** Total number of attempts to make (1 initial + N retries). */
  maxAttempts: number;
  /** The base delay in milliseconds for linear backoff. */
  initialDelayMs: number;
}

const INVALID_CONTENT_RETRY_OPTIONS: ContentRetryOptions = {
  maxAttempts: 2, // 1 initial call + 2 retry
  initialDelayMs: 500,
};

/**
 * Returns true if the response is valid, false otherwise.
 */
function isValidResponse(response: GenerateContentResponse): boolean {
  if (response.candidates === undefined || response.candidates.length === 0) {
    return false;
  }
  const content = response.candidates[0]?.content;
  if (content === undefined) {
    return false;
  }
  return isValidContent(content);
}

export function isValidNonThoughtTextPart(part: Part): boolean {
  return (
    typeof part.text === 'string' &&
    !part.thought &&
    // Technically, the model should never generate parts that have text and
    //  any of these but we don't trust them so check anyways.
    !part.functionCall &&
    !part.functionResponse &&
    !part.inlineData &&
    !part.fileData
  );
}

function isValidContent(content: Content): boolean {
  if (content.parts === undefined || content.parts.length === 0) {
    return false;
  }
  for (const part of content.parts) {
    if (part === undefined || Object.keys(part).length === 0) {
      return false;
    }
    if (!part.thought && part.text !== undefined && part.text === '') {
      return false;
    }
  }
  return true;
}

/**
 * Validates the history contains the correct roles.
 *
 * @throws Error if the history does not start with a user turn.
 * @throws Error if the history contains an invalid role.
 */
function validateHistory(history: Content[]) {
  for (const content of history) {
    if (content.role !== 'user' && content.role !== 'model') {
      throw new Error(`Role must be user or model, but got ${content.role}.`);
    }
  }
}

/**
 * Extracts the curated (valid) history from a comprehensive history.
 *
 * @remarks
 * The model may sometimes generate invalid or empty contents(e.g., due to safety
 * filters or recitation). Extracting valid turns from the history
 * ensures that subsequent requests could be accepted by the model.
 */
function extractCuratedHistory(comprehensiveHistory: Content[]): Content[] {
  if (comprehensiveHistory === undefined || comprehensiveHistory.length === 0) {
    return [];
  }
  const curatedHistory: Content[] = [];
  const length = comprehensiveHistory.length;
  let i = 0;
  while (i < length) {
    if (comprehensiveHistory[i].role === 'user') {
      curatedHistory.push(stripThoughtsFromContent(comprehensiveHistory[i]));
      i++;
    } else {
      const modelOutput: Content[] = [];
      let isValid = true;
      while (i < length && comprehensiveHistory[i].role === 'model') {
        modelOutput.push(comprehensiveHistory[i]);
        if (isValid && !isValidContent(comprehensiveHistory[i])) {
          isValid = false;
        }
        i++;
      }
      if (isValid) {
        // Strip thoughts and filter out any content that becomes invalid after stripping
        const strippedOutput = modelOutput
          .map(stripThoughtsFromContent)
          .filter(isValidContent);
        curatedHistory.push(...strippedOutput);
      }
    }
  }
  return curatedHistory;
}

/**
 * Strip thought parts from a Content object to save tokens when sending to LLM.
 * Thought parts are internal reasoning and don't affect conversation flow.
 */
function stripThoughtsFromContent(content: Content): Content {
  if (!content.parts || content.parts.length === 0) {
    return content;
  }

  const filteredParts = content.parts.filter((part) => {
    // Remove thought parts (original thought parts from API)
    if ('thought' in part && part.thought) {
      return false;
    }
    // Also remove text parts that contain thinking content (converted thought parts)
    // These are identified by <think> tags
    if ('text' in part && part.text && part.text.includes('<think>')) {
      return false;
    }
    return true;
  });

  return {
    ...content,
    parts: filteredParts,
  };
}

/**
 * Custom error to signal that a stream completed with invalid content,
 * which should trigger a retry.
 */
export class InvalidStreamError extends Error {
  readonly type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT';

  constructor(message: string, type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT') {
    super(message);
    this.name = 'InvalidStreamError';
    this.type = type;
  }
}

/**
 * Chat session that enables sending messages to the model with previous
 * conversation context.
 *
 * @remarks
 * The session maintains all the turns between user and model.
 */
export class GeminiChat {
  // A promise to represent the current state of the message being sent to the
  // model.
  private sendPromise: Promise<void> = Promise.resolve();
  private readonly chatRecordingService: ChatRecordingService;

  constructor(
    private readonly config: Config,
    private readonly generationConfig: GenerateContentConfig = {},
    private history: Content[] = [],
  ) {
    validateHistory(history);
    this.chatRecordingService = new ChatRecordingService(config);
    this.chatRecordingService.initialize();
  }

  setSystemInstruction(sysInstr: string) {
    this.generationConfig.systemInstruction = sysInstr;
  }

  /**
   * Sends a message to the model and returns the response in chunks.
   *
   * @remarks
   * This method will wait for the previous message to be processed before
   * sending the next message.
   *
   * @see {@link Chat#sendMessage} for non-streaming method.
   * @param params - parameters for sending the message.
   * @return The model's response.
   *
   * @example
   * ```ts
   * const chat = ai.chats.create({model: 'gemini-2.0-flash'});
   * const response = await chat.sendMessageStream({
   * message: 'Why is the sky blue?'
   * });
   * for await (const chunk of response) {
   * console.log(chunk.text);
   * }
   * ```
   */
  async sendMessageStream(
    model: string,
    params: SendMessageParameters,
    prompt_id: string,
  ): Promise<AsyncGenerator<StreamEvent>> {
    await this.sendPromise;

    let streamDoneResolver: () => void;
    const streamDonePromise = new Promise<void>((resolve) => {
      streamDoneResolver = resolve;
    });
    this.sendPromise = streamDonePromise;

    const userContent = createUserContent(params.message);

    // Record user input - capture complete message with all parts (text, files, images, etc.)
    // but skip recording function responses (tool call results) as they should be stored in tool call records
    if (!isFunctionResponse(userContent)) {
      const userMessage = Array.isArray(params.message)
        ? params.message
        : [params.message];
      const userMessageContent = partListUnionToString(toParts(userMessage));
      this.chatRecordingService.recordMessage({
        model,
        type: 'user',
        content: userMessageContent,
      });
    }

    // Record history length before adding user message, for potential rollback
    const historyLengthBeforeRequest = this.history.length;

    // Add user content to history ONCE before any attempts.
    this.history.push(userContent);
    const requestContents = this.getHistory(true);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    let streamCompletedSuccessfully = false;

    return (async function* () {
      try {
        let lastError: unknown = new Error('Request failed after all retries.');

        for (
          let attempt = 0;
          attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts;
          attempt++
        ) {
          try {
            if (attempt > 0) {
              yield { type: StreamEventType.RETRY };
            }

            const stream = await self.makeApiCallAndProcessStream(
              model,
              requestContents,
              params,
              prompt_id,
            );

            for await (const chunk of stream) {
              yield { type: StreamEventType.CHUNK, value: chunk };
            }

            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            const isContentError = error instanceof InvalidStreamError;

            if (isContentError) {
              // Check if we have more attempts left.
              if (attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts - 1) {
                logContentRetry(
                  self.config,
                  new ContentRetryEvent(
                    attempt,
                    (error as InvalidStreamError).type,
                    INVALID_CONTENT_RETRY_OPTIONS.initialDelayMs,
                    model,
                  ),
                );
                await new Promise((res) =>
                  setTimeout(
                    res,
                    INVALID_CONTENT_RETRY_OPTIONS.initialDelayMs *
                      (attempt + 1),
                  ),
                );
                continue;
              }
            }
            break;
          }
        }

        if (lastError) {
          if (lastError instanceof InvalidStreamError) {
            logContentRetryFailure(
              self.config,
              new ContentRetryFailureEvent(
                INVALID_CONTENT_RETRY_OPTIONS.maxAttempts,
                (lastError as InvalidStreamError).type,
                model,
              ),
            );
          }
          throw lastError;
        }

        // If we reach here without throwing, stream completed successfully
        streamCompletedSuccessfully = true;
      } finally {
        // CRITICAL: Rollback history if stream was interrupted (timeout/cancel/error)
        // This prevents incomplete history (user message without model response) from being saved
        // which would break Gemini API (unpaired tool calls/responses) and cause context loss
        if (!streamCompletedSuccessfully) {
          console.warn(
            '[GeminiChat] Stream was interrupted before completion, rolling back history to prevent corruption',
          );
          console.warn(
            `[GeminiChat] Rolling back from ${self.history.length} to ${historyLengthBeforeRequest} entries`,
          );
          self.history = self.history.slice(0, historyLengthBeforeRequest);
        }

        streamDoneResolver!();
      }
    })();
  }

  private async makeApiCallAndProcessStream(
    model: string,
    requestContents: Content[],
    params: SendMessageParameters,
    prompt_id: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const apiCall = () => {
      const modelToUse = getEffectiveModel(
        this.config.isInFallbackMode(),
        model,
      );

      if (
        this.config.getQuotaErrorOccurred() &&
        modelToUse === DEFAULT_GEMINI_FLASH_MODEL
      ) {
        throw new Error(
          'Please submit a new query to continue with the Flash model.',
        );
      }

      return this.config.getContentGenerator().generateContentStream(
        {
          model: modelToUse,
          contents: requestContents,
          config: { ...this.generationConfig, ...params.config },
        },
        prompt_id,
      );
    };

    const onPersistent429Callback = async (
      authType?: string,
      error?: unknown,
    ) => await handleFallback(this.config, model, authType, error);

    const streamResponse = await retryWithBackoff(apiCall, {
      onPersistent429: onPersistent429Callback,
      authType: this.config.getContentGeneratorConfig()?.authType,
    });

    return this.processStreamResponse(model, streamResponse);
  }

  /**
   * Returns the chat history.
   *
   * @remarks
   * The history is a list of contents alternating between user and model.
   *
   * There are two types of history:
   * - The `curated history` contains only the valid turns between user and
   * model, which will be included in the subsequent requests sent to the model.
   * - The `comprehensive history` contains all turns, including invalid or
   * empty model outputs, providing a complete record of the history.
   *
   * The history is updated after receiving the response from the model,
   * for streaming response, it means receiving the last chunk of the response.
   *
   * The `comprehensive history` is returned by default. To get the `curated
   * history`, set the `curated` parameter to `true`.
   *
   * @param curated - whether to return the curated history or the comprehensive
   * history.
   * @return History contents alternating between user and model for the entire
   * chat session.
   */
  getHistory(curated: boolean = false): Content[] {
    let history = curated ? extractCuratedHistory(this.history) : this.history;

    // Remove unpaired tool calls to satisfy Gemini API requirements
    history = this.removeUnpairedToolCalls(history);

    // Deep copy the history to avoid mutating the history outside of the
    // chat session.
    return structuredClone(history);
  }

  /**
   * Remove unpaired function calls from history.
   * Gemini requires that every functionCall must have a corresponding functionResponse.
   * This method removes any functionCall parts that don't have a matching functionResponse.
   *
   * IMPORTANT: Pending tool calls (in the last model message) are NOT considered unpaired,
   * as they are currently being processed and waiting for responses.
   */
  private removeUnpairedToolCalls(history: Content[]): Content[] {
    // Collect IDs of pending tool calls (from the last model message)
    const pendingToolCallIds = new Set<string>();
    const lastMessage =
      history.length > 0 ? history[history.length - 1] : undefined;
    if (lastMessage?.role === 'model' && lastMessage.parts) {
      for (const part of lastMessage.parts) {
        if (part.functionCall?.id) {
          pendingToolCallIds.add(part.functionCall.id);
        }
      }
    }

    // Collect all function call IDs and their corresponding response IDs
    const functionCallIds = new Set<string>();
    const functionResponseIds = new Set<string>();

    // First pass: collect all function call and response IDs
    for (const content of history) {
      if (!content.parts) continue;

      for (const part of content.parts) {
        if (part.functionCall?.id) {
          functionCallIds.add(part.functionCall.id);
        }
        if (part.functionResponse) {
          // Extract callId from functionResponse.id field
          // This ID should match the functionCall.id from the corresponding tool call
          if (part.functionResponse.id) {
            functionResponseIds.add(part.functionResponse.id);
          }
        }
      }
    }

    // Find unpaired function calls (calls without responses)
    // Exclude pending tool calls as they are currently being processed
    const unpairedCallIds = new Set<string>();
    for (const callId of functionCallIds) {
      if (!functionResponseIds.has(callId) && !pendingToolCallIds.has(callId)) {
        unpairedCallIds.add(callId);
      }
    }

    if (unpairedCallIds.size > 0) {
      console.log(
        `[GeminiChat] Removing ${unpairedCallIds.size} unpaired tool calls: ${Array.from(unpairedCallIds).join(', ')}`,
      );
    }

    // Second pass: filter out unpaired function calls
    const cleanedHistory: Content[] = [];
    for (const content of history) {
      if (!content.parts) {
        cleanedHistory.push(content);
        continue;
      }

      const cleanedParts = content.parts.filter((part) => {
        // Remove functionCall parts with unpaired IDs
        if (
          part.functionCall?.id &&
          unpairedCallIds.has(part.functionCall.id)
        ) {
          return false;
        }
        return true;
      });

      // Only include content if it still has parts after filtering
      if (cleanedParts.length > 0) {
        cleanedHistory.push({
          ...content,
          parts: cleanedParts,
        });
      }
    }

    return cleanedHistory;
  }

  /**
   * Clears the chat history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Adds a new entry to the chat history.
   */
  addHistory(content: Content): void {
    this.history.push(content);
  }

  setHistory(history: Content[]): void {
    this.history = history;
  }

  stripThoughtsFromHistory(): void {
    this.history = this.history.map((content) => {
      const newContent = { ...content };
      if (newContent.parts) {
        newContent.parts = newContent.parts.map((part) => {
          if (part && typeof part === 'object' && 'thoughtSignature' in part) {
            const newPart = { ...part };
            delete (newPart as { thoughtSignature?: string }).thoughtSignature;
            return newPart;
          }
          return part;
        });
      }
      return newContent;
    });
  }

  setTools(tools: Tool[]): void {
    this.generationConfig.tools = tools;
  }

  async maybeIncludeSchemaDepthContext(error: StructuredError): Promise<void> {
    // Check for potentially problematic cyclic tools with cyclic schemas
    // and include a recommendation to remove potentially problematic tools.
    if (
      isSchemaDepthError(error.message) ||
      isInvalidArgumentError(error.message)
    ) {
      const tools = this.config.getToolRegistry().getAllTools();
      const cyclicSchemaTools: string[] = [];
      for (const tool of tools) {
        if (
          (tool.schema.parametersJsonSchema &&
            hasCycleInSchema(tool.schema.parametersJsonSchema)) ||
          (tool.schema.parameters && hasCycleInSchema(tool.schema.parameters))
        ) {
          cyclicSchemaTools.push(tool.displayName);
        }
      }
      if (cyclicSchemaTools.length > 0) {
        const extraDetails =
          `\n\nThis error was probably caused by cyclic schema references in one of the following tools, try disabling them with excludeTools:\n\n - ` +
          cyclicSchemaTools.join(`\n - `) +
          `\n`;
        error.message += extraDetails;
      }
    }
  }

  private async *processStreamResponse(
    model: string,
    streamResponse: AsyncGenerator<GenerateContentResponse>,
  ): AsyncGenerator<GenerateContentResponse> {
    const modelResponseParts: Part[] = [];
    const debugTurns: GenerateContentResponse[] = [];

    let hasToolCall = false;
    let hasFinishReason = false;

    for await (const chunk of this.stopBeforeSecondMutator(streamResponse)) {
      hasFinishReason =
        chunk?.candidates?.some((candidate) => candidate.finishReason) ?? false;
      if (isValidResponse(chunk)) {
        const content = chunk.candidates?.[0]?.content;
        if (content?.parts) {
          if (content.parts.some((part) => part.thought)) {
            // Record thoughts
            this.recordThoughtFromContent(content);
          }
          if (content.parts.some((part) => part.functionCall)) {
            hasToolCall = true;
            //Set function call id
            for (const part of content.parts) {
              if (part.functionCall) {
                part.functionCall.id = `${part.functionCall.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
              }
            }
          }

          // Include all parts including thought parts
          // Thought parts will be converted to <think> text format when saving to history
          // and filtered out by stripThoughtsFromContent when sending to LLM
          modelResponseParts.push(...content.parts);
        }
      }

      // Record token usage if this chunk has usageMetadata
      if (chunk.usageMetadata) {
        this.chatRecordingService.recordMessageTokens(chunk.usageMetadata);
        if (chunk.usageMetadata.promptTokenCount !== undefined) {
          uiTelemetryService.setLastPromptTokenCount(
            chunk.usageMetadata.promptTokenCount,
          );
        }
      }

      debugTurns.push(chunk);
      yield chunk; // Yield every chunk to the UI immediately.
    }

    // String thoughts and consolidate text parts.
    const consolidatedParts: Part[] = [];
    for (const part of modelResponseParts) {
      const lastPart = consolidatedParts[consolidatedParts.length - 1];
      if (
        lastPart?.text &&
        isValidNonThoughtTextPart(lastPart) &&
        isValidNonThoughtTextPart(part)
      ) {
        lastPart.text += part.text;
      } else {
        consolidatedParts.push(part);
      }
    }

    const responseText = consolidatedParts
      .filter((part) => part.text)
      .map((part) => part.text)
      .join('')
      .trim();

    // Record model response text from the collected parts
    if (responseText) {
      this.chatRecordingService.recordMessage({
        model,
        type: 'gemini',
        content: responseText,
      });
    }

    // Check if response contains thoughtSignature (Gemini internal reasoning)
    // thoughtSignature parts don't have text fields, so they don't contribute to responseText
    const hasThoughtSignature = consolidatedParts.some(
      (part) =>
        part &&
        typeof part === 'object' &&
        'thoughtSignature' in part &&
        (part as { thoughtSignature?: string }).thoughtSignature,
    );

    // Stream validation logic: A stream is considered successful if:
    // 1. There's a tool call (tool calls can end without explicit finish reasons), OR
    // 2. There's a finish reason AND (we have non-empty response text OR thoughtSignature)
    //
    // We throw an error only when there's no tool call AND:
    // - No finish reason, OR
    // - Empty response text AND no thoughtSignature
    if (
      !hasToolCall &&
      !responseText &&
      (!hasFinishReason || !hasThoughtSignature)
    ) {
      // Helper function to format debug information from the stream
      const formatDebugInfo = () => {
        const toolCallCount = consolidatedParts.filter(
          (part) => part.functionCall,
        ).length;
        const textPreview = responseText
          ? responseText.length > 100
            ? responseText.substring(0, 100) + '...'
            : responseText
          : '(empty)';
        const chunkCount = debugTurns.length;
        const finishReasons = debugTurns
          .flatMap((turn) => turn.candidates?.map((c) => c.finishReason) || [])
          .filter(Boolean);

        const lastFinishReason =
          finishReasons.length > 0
            ? finishReasons[finishReasons.length - 1]
            : 'none';

        return `Last finish reason: ${lastFinishReason}\nLLM returned ${chunkCount} chunk(s), ${toolCallCount} tool call(s), response text: "${textPreview}", all finish reasons: [${finishReasons.join(', ') || 'none'}], hasThoughtSignature: ${hasThoughtSignature}`;
      };

      if (!hasFinishReason) {
        throw new InvalidStreamError(
          `Model stream ended without a finish reason. ${formatDebugInfo()}`,
          'NO_FINISH_REASON',
        );
      } else {
        throw new InvalidStreamError(
          `Model stream ended with empty response text. ${formatDebugInfo()}`,
          'NO_RESPONSE_TEXT',
        );
      }
    }

    // Convert thought parts to <think> tagged text before saving to history
    // This ensures thinking content persists when sessions are reloaded
    const partsWithThinkingAsText: Part[] = [];
    let thinkingPartsCount = 0;
    for (const part of consolidatedParts) {
      // Check if this is a thought part (has 'thought' field)
      // When a part has 'thought' field, the actual text content is in 'text' field
      const partWithThought = part as Part & { thought?: boolean | string };
      if (partWithThought.thought && partWithThought.text) {
        thinkingPartsCount++;
        // Convert thought part to text part with <think> tags
        // Use the text field which contains the actual thinking content
        const thinkingText = `<think>\n${partWithThought.text}\n</think>\n\n`;
        partsWithThinkingAsText.push({ text: thinkingText });
      } else if (!partWithThought.thought) {
        // Keep non-thought parts as-is (skip thought parts without text)
        partsWithThinkingAsText.push(part);
      }
    }

    if (thinkingPartsCount > 0) {
      console.log(
        `[GeminiChat] Converted ${thinkingPartsCount} thought parts to <think> tagged text`,
      );
    }

    this.history.push({ role: 'model', parts: partsWithThinkingAsText });
  }

  /**
   * Gets the chat recording service instance.
   */
  getChatRecordingService(): ChatRecordingService {
    return this.chatRecordingService;
  }

  /**
   * Records completed tool calls with full metadata.
   * This is called by external components when tool calls complete, before sending responses to Gemini.
   */
  recordCompletedToolCalls(
    model: string,
    toolCalls: CompletedToolCall[],
  ): void {
    const toolCallRecords = toolCalls.map((call) => {
      const resultDisplayRaw = call.response?.resultDisplay;
      const resultDisplay =
        typeof resultDisplayRaw === 'string' ? resultDisplayRaw : undefined;

      return {
        id: call.request.callId,
        name: call.request.name,
        args: call.request.args,
        result: call.response?.responseParts || null,
        status: call.status as 'error' | 'success' | 'cancelled',
        timestamp: new Date().toISOString(),
        resultDisplay,
      };
    });

    this.chatRecordingService.recordToolCalls(model, toolCallRecords);
  }

  /**
   * Extracts and records thought from thought content.
   */
  private recordThoughtFromContent(content: Content): void {
    if (!content.parts || content.parts.length === 0) {
      return;
    }

    const thoughtPart = content.parts[0];
    if (thoughtPart.text) {
      // Extract subject and description using the same logic as turn.ts
      const rawText = thoughtPart.text;
      const subjectStringMatches = rawText.match(/\*\*(.*?)\*\*/s);
      const subject = subjectStringMatches
        ? subjectStringMatches[1].trim()
        : '';
      const description = rawText.replace(/\*\*(.*?)\*\*/s, '').trim();

      this.chatRecordingService.recordThought({
        subject,
        description,
      });
    }
  }

  /**
   * Truncates the chunkStream right before the second function call to a
   * function that mutates state. This may involve trimming parts from a chunk
   * as well as omtting some chunks altogether.
   *
   * We do this because it improves tool call quality if the model gets
   * feedback from one mutating function call before it makes the next one.
   */
  private async *stopBeforeSecondMutator(
    chunkStream: AsyncGenerator<GenerateContentResponse>,
  ): AsyncGenerator<GenerateContentResponse> {
    let foundMutatorFunctionCall = false;

    for await (const chunk of chunkStream) {
      const candidate = chunk.candidates?.[0];
      const content = candidate?.content;
      if (!candidate || !content?.parts) {
        yield chunk;
        continue;
      }

      const truncatedParts: Part[] = [];
      for (const part of content.parts) {
        if (this.isMutatorFunctionCall(part)) {
          if (foundMutatorFunctionCall) {
            // This is the second mutator call.
            // Truncate and return immedaitely.
            const newChunk = new GenerateContentResponse();
            newChunk.candidates = [
              {
                ...candidate,
                content: {
                  ...content,
                  parts: truncatedParts,
                },
                finishReason: FinishReason.STOP,
              },
            ];
            yield newChunk;
            return;
          }
          foundMutatorFunctionCall = true;
        }
        truncatedParts.push(part);
      }

      yield chunk;
    }
  }

  private isMutatorFunctionCall(part: Part): boolean {
    if (!part?.functionCall?.name) {
      return false;
    }
    const tool = this.config.getToolRegistry().getTool(part.functionCall.name);
    return !!tool && MUTATOR_KINDS.includes(tool.kind);
  }
}

/** Visible for Testing */
export function isSchemaDepthError(errorMessage: string): boolean {
  return errorMessage.includes('maximum schema depth exceeded');
}

export function isInvalidArgumentError(errorMessage: string): boolean {
  return errorMessage.includes('Request contains an invalid argument');
}
