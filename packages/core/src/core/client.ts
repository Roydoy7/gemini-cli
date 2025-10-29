/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentConfig,
  PartListUnion,
  Content,
  Tool,
  GenerateContentResponse,
} from '@google/genai';
import {
  getDirectoryContextString,
  // getInitialChatHistory,
  getEnvironmentContext,
} from '../utils/environmentContext.js';
import type { ServerGeminiStreamEvent, ChatCompressionInfo } from './turn.js';
import { CompressionStatus } from './turn.js';
import { Turn, GeminiEventType } from './turn.js';
import type { Config } from '../config/config.js';
import { getCompressionPrompt } from './prompts.js';
import { RoleManager } from '../roles/RoleManager.js';
import { getResponseText } from '../utils/partUtils.js';
import { checkNextSpeaker } from '../utils/nextSpeakerChecker.js';
import { reportError } from '../utils/errorReporting.js';
import { GeminiChat } from './geminiChat.js';
import { retryWithBackoff } from '../utils/retry.js';
import { getErrorMessage } from '../utils/errors.js';
import { tokenLimit } from './tokenLimits.js';
import type { ChatRecordingService } from '../services/chatRecordingService.js';
import type { ContentGenerator } from './contentGenerator.js';
import {
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_THINKING_MODE,
  getEffectiveModel,
} from '../config/models.js';
import { LoopDetectionService } from '../services/loopDetectionService.js';
import {
  ChatCompressionService,
  COMPRESSION_TOKEN_THRESHOLD,
  COMPRESSION_PRESERVE_THRESHOLD,
} from '../services/chatCompressionService.js';
import { ideContextStore } from '../ide/ideContext.js';
import {
  logContentRetryFailure,
  logNextSpeakerCheck,
  logMalformedJsonResponse,
  logChatCompression,
} from '../telemetry/loggers.js';
import {
  ContentRetryFailureEvent,
  NextSpeakerCheckEvent,
  MalformedJsonResponseEvent,
  makeChatCompressionEvent,
} from '../telemetry/types.js';
import type { IdeContext, File } from '../ide/types.js';
import { handleFallback } from '../fallback/handler.js';
import type { RoutingContext } from '../routing/routingStrategy.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { debugLogger } from '../utils/debugLogger.js';

export function isThinkingSupported(model: string) {
  return model.startsWith('gemini-2.5') || model === DEFAULT_GEMINI_MODEL_AUTO;
}

export function isThinkingDefault(model: string) {
  if (model.startsWith('gemini-2.5-flash-lite')) {
    return false;
  }
  return model.startsWith('gemini-2.5') || model === DEFAULT_GEMINI_MODEL_AUTO;
}

/**
 * Creates a language reminder part to be injected before the first user message.
 * This reminds the model to use the same language as the user's message.
 */
function createLanguageReminderPart() {
  return {
    text: `<system_reminder>
Use the same language as the user's last message.
Ignore previous messages, you DO NOT need to keep consistency.
If user shifts language, be flex, change your reply immediately.
This is a reminder, NEVER mention it to the user.
</system_reminder>`,
  };
}

/**
 * Creates an action reminder to break free from previous refusal patterns.
 * This helps the model to try user suggestions even if it previously refused.
 */
function createActionReminderPart() {
  return {
    text: `<system_reminder>
If user suggests something, immediately try it first.
It's NOT necessary to keep consistent with previous refusals.
It's OK to change your mind or approach, DO NOT let your previous responses bind your following actions.
</system_reminder>`,
  };
}

/**
 * Get system reminder text to be included in system instruction
 */
function createSystemReminderPart() {
  return {
    text: `<system_reminder>
**IMPORTANT**: Do not return an empty response when a tool call is required.
</system_reminder>`,
  };
}

/**
 * Returns the index of the oldest item to keep when compressing. May return
 * contents.length which indicates that everything should be compressed.
 *
 * Exported for testing purposes.
 */
export function findCompressSplitPoint(
  contents: Content[],
  fraction: number,
): number {
  if (fraction <= 0 || fraction >= 1) {
    throw new Error('Fraction must be between 0 and 1');
  }

  const charCounts = contents.map((content) => JSON.stringify(content).length);
  const totalCharCount = charCounts.reduce((a, b) => a + b, 0);
  const targetCharCount = totalCharCount * fraction;

  let lastSplitPoint = 0; // 0 is always valid (compress nothing)
  let cumulativeCharCount = 0;
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    if (
      content.role === 'user' &&
      !content.parts?.some((part) => !!part.functionResponse)
    ) {
      if (cumulativeCharCount >= targetCharCount) {
        return i;
      }
      lastSplitPoint = i;
    }
    cumulativeCharCount += charCounts[i];
  }

  // We found no split points after targetCharCount.
  // Check if it's safe to compress everything.
  const lastContent = contents[contents.length - 1];
  if (
    lastContent?.role === 'model' &&
    !lastContent?.parts?.some((part) => part.functionCall)
  ) {
    return contents.length;
  }

  // Can't compress everything so just compress at last splitpoint.
  return lastSplitPoint;
}

const MAX_TURNS = 100;

export class GeminiClient {
  private chat?: GeminiChat;
  private readonly generateContentConfig: GenerateContentConfig = {
    temperature: 0,
    topP: 1,
  };
  private sessionTurnCount = 0;

  private readonly loopDetector: LoopDetectionService;
  private readonly compressionService: ChatCompressionService;
  private lastPromptId: string;
  private currentSequenceModel: string | null = null;
  private lastSentIdeContext: IdeContext | undefined;
  private forceFullIdeContext = true;

  /**
   * At any point in this conversation, was compression triggered without
   * being forced and did it fail?
   */
  private hasFailedCompressionAttempt = false;

  private readonly roleManager: RoleManager;

  constructor(private readonly config: Config) {
    this.loopDetector = new LoopDetectionService(config);
    this.compressionService = new ChatCompressionService();
    this.lastPromptId = this.config.getSessionId();

    // Initialize role management
    this.roleManager = RoleManager.getInstance();
  }

  async initialize() {
    this.chat = await this.startChat();
  }

  private getContentGeneratorOrFail(): ContentGenerator {
    if (!this.config.getContentGenerator()) {
      throw new Error('Content generator not initialized');
    }
    return this.config.getContentGenerator();
  }

  async addHistory(content: Content) {
    this.getChat().addHistory(content);
  }

  getChat(): GeminiChat {
    if (!this.chat) {
      throw new Error('Chat not initialized');
    }
    return this.chat;
  }

  isInitialized(): boolean {
    return this.chat !== undefined;
  }

  getHistory(): Content[] {
    return this.getChat().getHistory();
  }

  stripThoughtsFromHistory() {
    this.getChat().stripThoughtsFromHistory();
  }

  setHistory(history: Content[]) {
    this.getChat().setHistory(history);
    this.forceFullIdeContext = true;
  }

  async setTools(): Promise<void> {
    const toolRegistry = this.config.getToolRegistry();
    const toolDeclarations = toolRegistry.getFunctionDeclarations();
    const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];
    this.getChat().setTools(tools);
  }

  /**
   * Updates tools based on the current role.
   * This should be called when the role changes to ensure the correct toolset is loaded.
   */
  async updateToolsForCurrentRole(): Promise<void> {
    if (!this.chat) {
      return;
    }

    // Check if role system is enabled
    if (!this.roleManager.isRoleSystemEnabled()) {
      // Role system disabled, use all tools
      await this.setTools();
      console.log('[GeminiClient] Role system disabled, using all tools');
      return;
    }

    const currentRole = this.roleManager.getCurrentRole();

    // Special handling for software_engineer: use original gemini-cli behavior
    if (currentRole.id === 'software_engineer') {
      // Use all registered tools from ToolRegistry (original gemini-cli behavior)
      await this.setTools();
      console.log(
        '[GeminiClient] Software engineer role - using all registered tools (original gemini-cli behavior)',
      );
      return;
    }

    // For other roles, use tools from ToolsetManager
    // Note: We use ToolsetManager directly instead of ToolRegistry.
    // ToolRegistry is for the original gemini-cli, while ToolsetManager manages role-specific toolsets.
    const { ToolsetManager } = await import('../tools/ToolsetManager.js');
    const toolsetManager = new ToolsetManager();
    const roleToolClasses = toolsetManager.getToolsForRole(currentRole.id);

    // Get the tool registry
    const toolRegistry = this.config.getToolRegistry();

    // Create tool instances, register them, and get their schemas
    const toolDeclarations = roleToolClasses.map((ToolClass) => {
      const toolInstance = new ToolClass(this.config);

      // Register tool instance to ToolRegistry so it can be invoked later
      toolRegistry.registerTool(toolInstance);

      return toolInstance.schema;
    });

    // Register role-specific subagents as tools
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
          toolDeclarations.push(wrapper.schema);
        } catch (error) {
          console.error(
            `[GeminiClient] Failed to register subagent ${definition.name}:`,
            error,
          );
        }
      }
    }

    // Set tools on GeminiChat
    const tools = [{ functionDeclarations: toolDeclarations }];
    this.chat.setTools(tools);

    console.log(
      `[GeminiClient] Loaded ${toolDeclarations.length} tools for role: ${currentRole.id}`,
    );
  }

  async resetChat(): Promise<void> {
    this.chat = await this.startChat();
  }

  getChatRecordingService(): ChatRecordingService | undefined {
    return this.chat?.getChatRecordingService();
  }

  getLoopDetectionService(): LoopDetectionService {
    return this.loopDetector;
  }

  getCurrentSequenceModel(): string | null {
    return this.currentSequenceModel;
  }

  async addDirectoryContext(): Promise<void> {
    if (!this.chat) {
      return;
    }

    this.getChat().addHistory({
      role: 'user',
      parts: [{ text: await getDirectoryContextString(this.config) }],
    });
  }

  /**
   * Updates the GenerateContentConfig with the latest system prompt and workspace context.
   * This should be called before sending each message to ensure the LLM has
   * the most up-to-date workspace and role information.
   */
  async updateGenerateContentConfig(): Promise<void> {
    if (!this.chat) {
      return;
    }

    try {
      // Get latest role system prompt
      const userMemory = this.config.getUserMemory();
      const currentRoleId = this.roleManager.getCurrentRole().id;
      const roleSystemPrompt = this.roleManager.getRoleAwareSystemPrompt(
        this.config,
        userMemory,
        currentRoleId,
      );

      // Get latest workspace context
      const { WorkspaceManager } = await import('../utils/WorkspaceManager.js');
      const workspaceManager = WorkspaceManager.getInstance(this.config);
      const workspaceContext = await workspaceManager.getEnvironmentContext();
      const workspaceContextText = workspaceContext
        .map((part) =>
          typeof part === 'object' && 'text' in part ? part.text : '',
        )
        .join('\n');

      // Combine role prompt with workspace context and system reminder
      const combinedSystemInstruction = `${roleSystemPrompt}

# Environment Context

${workspaceContextText}
`.trim();

      // Update the chat's system instruction in GenerateContentConfig
      this.chat.setSystemInstruction(combinedSystemInstruction);

      console.log(
        '[GeminiClient] Updated GenerateContentConfig with latest system prompt and workspace context',
      );
    } catch (error) {
      console.error(
        '[GeminiClient] Failed to update GenerateContentConfig:',
        error,
      );
    }
  }

  async startChat(extraHistory?: Content[]): Promise<GeminiChat> {
    this.forceFullIdeContext = true;
    this.hasFailedCompressionAttempt = false;

    const toolRegistry = this.config.getToolRegistry();
    const toolDeclarations = toolRegistry.getFunctionDeclarations();
    const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];

    // Get environment context to append to system instruction
    const envParts = await getEnvironmentContext(this.config);
    const envContextString = envParts
      .map((part) => part.text || '')
      .join('\n\n');

    // Use provided history directly (no initial handshake message)
    const history: Content[] = [...(extraHistory ?? [])];

    try {
      const userMemory = this.config.getUserMemory();
      const currentRoleId = this.roleManager.getCurrentRole().id;
      const baseSystemInstruction = this.roleManager.getCombinedSystemPrompt(
        this.config,
        userMemory,
        currentRoleId,
      );

      // Append environment context and system reminder to system instruction
      const systemInstruction = `
${baseSystemInstruction}

# Environment Context

${envContextString}

`.trim();
      const model = this.config.getModel();

      const config: GenerateContentConfig = { ...this.generateContentConfig };

      if (isThinkingSupported(model)) {
        config.thinkingConfig = {
          includeThoughts: true,
          thinkingBudget: DEFAULT_THINKING_MODE,
        };
      }

      // Create new chat instance and assign to this.chat
      this.chat = new GeminiChat(
        this.config,
        {
          systemInstruction,
          ...config,
          tools,
        },
        history,
      );

      return this.chat;
    } catch (error) {
      await reportError(
        error,
        'Error initializing Gemini chat session.',
        history,
        'startChat',
      );
      throw new Error(`Failed to initialize chat: ${getErrorMessage(error)}`);
    }
  }

  private getIdeContextParts(forceFullContext: boolean): {
    contextParts: string[];
    newIdeContext: IdeContext | undefined;
  } {
    const currentIdeContext = ideContextStore.get();
    if (!currentIdeContext) {
      return { contextParts: [], newIdeContext: undefined };
    }

    if (forceFullContext || !this.lastSentIdeContext) {
      // Send full context as JSON
      const openFiles = currentIdeContext.workspaceState?.openFiles || [];
      const activeFile = openFiles.find((f) => f.isActive);
      const otherOpenFiles = openFiles
        .filter((f) => !f.isActive)
        .map((f) => f.path);

      const contextData: Record<string, unknown> = {};

      if (activeFile) {
        contextData['activeFile'] = {
          path: activeFile.path,
          cursor: activeFile.cursor
            ? {
                line: activeFile.cursor.line,
                character: activeFile.cursor.character,
              }
            : undefined,
          selectedText: activeFile.selectedText || undefined,
        };
      }

      if (otherOpenFiles.length > 0) {
        contextData['otherOpenFiles'] = otherOpenFiles;
      }

      if (Object.keys(contextData).length === 0) {
        return { contextParts: [], newIdeContext: currentIdeContext };
      }

      const jsonString = JSON.stringify(contextData, null, 2);
      const contextParts = [
        "Here is the user's editor context as a JSON object. This is for your information only.",
        '```json',
        jsonString,
        '```',
      ];

      if (this.config.getDebugMode()) {
        debugLogger.log(contextParts.join('\n'));
      }
      return {
        contextParts,
        newIdeContext: currentIdeContext,
      };
    } else {
      // Calculate and send delta as JSON
      const delta: Record<string, unknown> = {};
      const changes: Record<string, unknown> = {};

      const lastFiles = new Map(
        (this.lastSentIdeContext.workspaceState?.openFiles || []).map(
          (f: File) => [f.path, f],
        ),
      );
      const currentFiles = new Map(
        (currentIdeContext.workspaceState?.openFiles || []).map((f: File) => [
          f.path,
          f,
        ]),
      );

      const openedFiles: string[] = [];
      for (const [path] of currentFiles.entries()) {
        if (!lastFiles.has(path)) {
          openedFiles.push(path);
        }
      }
      if (openedFiles.length > 0) {
        changes['filesOpened'] = openedFiles;
      }

      const closedFiles: string[] = [];
      for (const [path] of lastFiles.entries()) {
        if (!currentFiles.has(path)) {
          closedFiles.push(path);
        }
      }
      if (closedFiles.length > 0) {
        changes['filesClosed'] = closedFiles;
      }

      const lastActiveFile = (
        this.lastSentIdeContext.workspaceState?.openFiles || []
      ).find((f: File) => f.isActive);
      const currentActiveFile = (
        currentIdeContext.workspaceState?.openFiles || []
      ).find((f: File) => f.isActive);

      if (currentActiveFile) {
        if (!lastActiveFile || lastActiveFile.path !== currentActiveFile.path) {
          changes['activeFileChanged'] = {
            path: currentActiveFile.path,
            cursor: currentActiveFile.cursor
              ? {
                  line: currentActiveFile.cursor.line,
                  character: currentActiveFile.cursor.character,
                }
              : undefined,
            selectedText: currentActiveFile.selectedText || undefined,
          };
        } else {
          const lastCursor = lastActiveFile.cursor;
          const currentCursor = currentActiveFile.cursor;
          if (
            currentCursor &&
            (!lastCursor ||
              lastCursor.line !== currentCursor.line ||
              lastCursor.character !== currentCursor.character)
          ) {
            changes['cursorMoved'] = {
              path: currentActiveFile.path,
              cursor: {
                line: currentCursor.line,
                character: currentCursor.character,
              },
            };
          }

          const lastSelectedText = lastActiveFile.selectedText || '';
          const currentSelectedText = currentActiveFile.selectedText || '';
          if (lastSelectedText !== currentSelectedText) {
            changes['selectionChanged'] = {
              path: currentActiveFile.path,
              selectedText: currentSelectedText,
            };
          }
        }
      } else if (lastActiveFile) {
        changes['activeFileChanged'] = {
          path: null,
          previousPath: lastActiveFile.path,
        };
      }

      if (Object.keys(changes).length === 0) {
        return { contextParts: [], newIdeContext: currentIdeContext };
      }

      delta['changes'] = changes;
      const jsonString = JSON.stringify(delta, null, 2);
      const contextParts = [
        "Here is a summary of changes in the user's editor context, in JSON format. This is for your information only.",
        '```json',
        jsonString,
        '```',
      ];

      if (this.config.getDebugMode()) {
        debugLogger.log(contextParts.join('\n'));
      }
      return {
        contextParts,
        newIdeContext: currentIdeContext,
      };
    }
  }

  private _getEffectiveModelForCurrentTurn(): string {
    if (this.currentSequenceModel) {
      return this.currentSequenceModel;
    }

    const configModel = this.config.getModel();
    const model: string =
      configModel === DEFAULT_GEMINI_MODEL_AUTO
        ? DEFAULT_GEMINI_MODEL
        : configModel;
    return getEffectiveModel(this.config.isInFallbackMode(), model);
  }

  async *sendMessageStream(
    request: PartListUnion,
    signal: AbortSignal,
    prompt_id: string,
    turns: number = MAX_TURNS,
    isInvalidStreamRetry: boolean = false,
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn> {
    if (this.lastPromptId !== prompt_id) {
      this.loopDetector.reset(prompt_id);
      this.lastPromptId = prompt_id;
      this.currentSequenceModel = null;
    }
    this.sessionTurnCount++;
    if (
      this.config.getMaxSessionTurns() > 0 &&
      this.sessionTurnCount > this.config.getMaxSessionTurns()
    ) {
      yield { type: GeminiEventType.MaxSessionTurns };
      return new Turn(this.getChat(), prompt_id);
    }
    // Ensure turns never exceeds MAX_TURNS to prevent infinite loops
    const boundedTurns = Math.min(turns, MAX_TURNS);
    if (!boundedTurns) {
      return new Turn(this.getChat(), prompt_id);
    }

    // Check for context window overflow
    const modelForLimitCheck = this._getEffectiveModelForCurrentTurn();

    const estimatedRequestTokenCount = Math.floor(
      JSON.stringify(request).length / 4,
    );

    const remainingTokenCount =
      tokenLimit(modelForLimitCheck) -
      uiTelemetryService.getLastPromptTokenCount();

    if (estimatedRequestTokenCount > remainingTokenCount * 0.95) {
      yield {
        type: GeminiEventType.ContextWindowWillOverflow,
        value: { estimatedRequestTokenCount, remainingTokenCount },
      };
      return new Turn(this.getChat(), prompt_id);
    }

    const compressed = await this.tryCompressChat(prompt_id, false);

    if (compressed.compressionStatus === CompressionStatus.COMPRESSED) {
      yield { type: GeminiEventType.ChatCompressed, value: compressed };
    }

    // Prevent context updates from being sent while a tool call is
    // waiting for a response. The Gemini API requires that a functionResponse
    // part from the user immediately follows a functionCall part from the model
    // in the conversation history . The IDE context is not discarded; it will
    // be included in the next regular message sent to the model.
    const history = this.getHistory();
    const lastMessage =
      history.length > 0 ? history[history.length - 1] : undefined;
    const hasPendingToolCall =
      !!lastMessage &&
      lastMessage.role === 'model' &&
      (lastMessage.parts?.some((p) => 'functionCall' in p) || false);

    if (this.config.getIdeMode() && !hasPendingToolCall) {
      const { contextParts, newIdeContext } = this.getIdeContextParts(
        this.forceFullIdeContext || history.length === 0,
      );
      if (contextParts.length > 0) {
        this.getChat().addHistory({
          role: 'user',
          parts: [{ text: contextParts.join('\n') }],
        });
      }
      this.lastSentIdeContext = newIdeContext;
      this.forceFullIdeContext = false;
    }

    const turn = new Turn(this.getChat(), prompt_id);

    const controller = new AbortController();
    const linkedSignal = AbortSignal.any([signal, controller.signal]);

    const loopDetected = await this.loopDetector.turnStarted(signal);
    if (loopDetected) {
      yield { type: GeminiEventType.LoopDetected };
      return turn;
    }

    // Inject reminders before user messages (only on first message)
    let modifiedRequest = request;
    if (Array.isArray(request) && history.length === 0) {
      modifiedRequest = [
        createLanguageReminderPart(),
        createActionReminderPart(),
        createSystemReminderPart(),
        ...request,
      ];
    }

    const routingContext: RoutingContext = {
      history: this.getChat().getHistory(/*curated=*/ true),
      request: modifiedRequest,
      signal,
    };

    let modelToUse: string;

    // Determine Model (Stickiness vs. Routing)
    if (this.currentSequenceModel) {
      modelToUse = this.currentSequenceModel;
    } else {
      const router = await this.config.getModelRouterService();
      const decision = await router.route(routingContext);
      modelToUse = decision.model;
      // Lock the model for the rest of the sequence
      this.currentSequenceModel = modelToUse;
    }

    const resultStream = turn.run(modelToUse, modifiedRequest, linkedSignal);
    for await (const event of resultStream) {
      if (this.loopDetector.addAndCheck(event)) {
        yield { type: GeminiEventType.LoopDetected };
        controller.abort();
        return turn;
      }
      yield event;
      if (event.type === GeminiEventType.InvalidStream) {
        if (this.config.getContinueOnFailedApiCall()) {
          if (isInvalidStreamRetry) {
            // We already retried once, so stop here.
            logContentRetryFailure(
              this.config,
              new ContentRetryFailureEvent(
                4, // 2 initial + 2 after injections
                'FAILED_AFTER_PROMPT_INJECTION',
                modelToUse,
              ),
            );
            return turn;
          }
          const nextRequest = [{ text: 'System: Please continue.' }];
          yield* this.sendMessageStream(
            nextRequest,
            signal,
            prompt_id,
            boundedTurns - 1,
            true, // Set isInvalidStreamRetry to true
          );
          return turn;
        }
      }
      if (event.type === GeminiEventType.Error) {
        return turn;
      }
    }
    if (!turn.pendingToolCalls.length && signal && !signal.aborted) {
      // Check if next speaker check is needed
      if (this.config.getQuotaErrorOccurred()) {
        return turn;
      }

      if (this.config.getSkipNextSpeakerCheck()) {
        return turn;
      }

      const nextSpeakerCheck = await checkNextSpeaker(
        this.getChat(),
        this.config.getBaseLlmClient(),
        signal,
        prompt_id,
      );
      logNextSpeakerCheck(
        this.config,
        new NextSpeakerCheckEvent(
          prompt_id,
          turn.finishReason?.toString() || '',
          nextSpeakerCheck?.next_speaker || '',
        ),
      );
      if (nextSpeakerCheck?.next_speaker === 'model') {
        const nextRequest = [{ text: 'Please continue.' }];
        // This recursive call's events will be yielded out, but the final
        // turn object will be from the top-level call.
        yield* this.sendMessageStream(
          nextRequest,
          signal,
          prompt_id,
          boundedTurns - 1,
          // isInvalidStreamRetry is false here, as this is a next speaker check
        );
      }
    }
    return turn;
  }

  async generateJson(
    contents: Content[],
    schema: Record<string, unknown>,
    abortSignal: AbortSignal,
    model?: string,
    config: GenerateContentConfig = {},
  ): Promise<Record<string, unknown>> {
    // Use current model from config instead of hardcoded Flash model
    const modelToUse =
      model || this.config.getModel() || DEFAULT_GEMINI_FLASH_MODEL;
    try {
      const userMemory = this.config.getUserMemory();
      const currentRoleId = this.roleManager.getCurrentRole().id;
      const systemInstruction = this.roleManager.getCombinedSystemPrompt(
        this.config,
        userMemory,
        currentRoleId,
      );
      await this.setTools();

      const requestConfig = {
        abortSignal,
        ...this.generateContentConfig,
        ...config,
      };

      const apiCall = () =>
        this.getContentGeneratorOrFail().generateContent(
          {
            model: modelToUse,
            config: {
              ...requestConfig,
              systemInstruction,
              responseJsonSchema: schema,
              responseMimeType: 'application/json',
            },
            contents,
          },
          this.lastPromptId,
        );

      const result = await retryWithBackoff(apiCall, {
        onPersistent429: async (authType?: string, error?: unknown) =>
          await handleFallback(this.config, modelToUse, authType, error),
        authType: this.config.getContentGeneratorConfig()?.authType,
        onRetryAttempt: this.config.onRetryAttemptHandler,
      });

      let text = getResponseText(result as GenerateContentResponse);
      if (!text) {
        const error = new Error(
          'API returned an empty response for generateJson.',
        );
        await reportError(
          error,
          'Error in generateJson: API returned an empty response.',
          contents,
          'generateJson-empty-response',
        );
        throw error;
      }

      const prefix = '```json';
      const suffix = '```';
      if (text.startsWith(prefix) && text.endsWith(suffix)) {
        logMalformedJsonResponse(
          this.config,
          new MalformedJsonResponseEvent(modelToUse),
        );
        text = text
          .substring(prefix.length, text.length - suffix.length)
          .trim();
      }

      try {
        return JSON.parse(text);
      } catch (parseError) {
        await reportError(
          parseError,
          'Failed to parse JSON response from generateJson.',
          {
            responseTextFailedToParse: text,
            originalRequestContents: contents,
          },
          'generateJson-parse',
        );
        throw new Error(
          `Failed to parse API response as JSON: ${getErrorMessage(
            parseError,
          )}`,
        );
      }
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }

      // Avoid double reporting for the empty response case handled above
      if (
        error instanceof Error &&
        error.message === 'API returned an empty response for generateJson.'
      ) {
        throw error;
      }

      await reportError(
        error,
        'Error generating JSON content via API.',
        contents,
        'generateJson-api',
      );
      throw new Error(
        `Failed to generate JSON content: ${getErrorMessage(error)}`,
      );
    }
  }

  async generateContent(
    contents: Content[],
    generationConfig: GenerateContentConfig,
    abortSignal: AbortSignal,
    model: string,
  ): Promise<GenerateContentResponse> {
    let currentAttemptModel: string = model;

    const configToUse: GenerateContentConfig = {
      ...this.generateContentConfig,
      ...generationConfig,
    };

    try {
      const userMemory = this.config.getUserMemory();
      const currentRoleId = this.roleManager.getCurrentRole().id;
      const systemInstruction = this.roleManager.getCombinedSystemPrompt(
        this.config,
        userMemory,
        currentRoleId,
      );
      await this.setTools();

      const requestConfig: GenerateContentConfig = {
        abortSignal,
        ...configToUse,
        systemInstruction,
      };

      const apiCall = () => {
        const modelToUse = this.config.isInFallbackMode()
          ? DEFAULT_GEMINI_FLASH_MODEL
          : model;
        currentAttemptModel = modelToUse;

        return this.getContentGeneratorOrFail().generateContent(
          {
            model: modelToUse,
            config: requestConfig,
            contents,
          },
          this.lastPromptId,
        );
      };
      const onPersistent429Callback = async (
        authType?: string,
        error?: unknown,
      ) =>
        // Pass the captured model to the centralized handler.
        await handleFallback(this.config, currentAttemptModel, authType, error);

      const result = await retryWithBackoff(apiCall, {
        onPersistent429: onPersistent429Callback,
        authType: this.config.getContentGeneratorConfig()?.authType,
        onRetryAttempt: this.config.onRetryAttemptHandler,
      });
      return result;
    } catch (error: unknown) {
      if (abortSignal.aborted) {
        throw error;
      }

      await reportError(
        error,
        `Error generating content via API with model ${currentAttemptModel}.`,
        {
          requestContents: contents,
          requestConfig: configToUse,
        },
        'generateContent-api',
      );
      throw new Error(
        `Failed to generate content with model ${currentAttemptModel}: ${getErrorMessage(error)}`,
      );
    }
  }

  async tryCompressChat(
    prompt_id: string,
    force: boolean = false,
  ): Promise<ChatCompressionInfo> {
    // If the model is 'auto', we will use a placeholder model to check.
    // Compression occurs before we choose a model, so calling `count_tokens`
    // before the model is chosen would result in an error.
    const model = this._getEffectiveModelForCurrentTurn();

    const curatedHistory = this.getChat().getHistory(true);

    // Regardless of `force`, don't do anything if the history is empty.
    if (
      curatedHistory.length === 0 ||
      (this.hasFailedCompressionAttempt && !force)
    ) {
      return {
        originalTokenCount: 0,
        newTokenCount: 0,
        compressionStatus: CompressionStatus.NOOP,
      };
    }

    // Estimate token count using a local approximation
    // Gemini tokenization: roughly 1 token ≈ 4 characters (for English/code)
    // This is much faster than calling the API and good enough for compression decisions
    const estimateTokens = (contents: Content[]): number =>
      Math.ceil(
        contents.reduce(
          (total, content) => total + JSON.stringify(content).length,
          0,
        ) / 4,
      );

    let originalTokenCount = estimateTokens(curatedHistory);

    // If we have a more accurate count from the last API response, use it
    const lastPromptTokens = uiTelemetryService.getLastPromptTokenCount();
    if (lastPromptTokens > 0) {
      originalTokenCount = lastPromptTokens;
    }

    const contextPercentageThreshold =
      this.config.getChatCompression()?.contextPercentageThreshold;

    // Don't compress if not forced and we are under the limit.
    if (!force) {
      const threshold =
        contextPercentageThreshold ?? COMPRESSION_TOKEN_THRESHOLD;
      if (originalTokenCount < threshold * tokenLimit(model)) {
        return {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          compressionStatus: CompressionStatus.NOOP,
        };
      }
    }

    const splitPoint = findCompressSplitPoint(
      curatedHistory,
      1 - COMPRESSION_PRESERVE_THRESHOLD,
    );

    const historyToCompress = curatedHistory.slice(0, splitPoint);
    const historyToKeep = curatedHistory.slice(splitPoint);

    const summaryResponse = await this.config
      .getContentGenerator()
      .generateContent(
        {
          model,
          contents: [
            ...historyToCompress,
            {
              role: 'user',
              parts: [
                {
                  text: 'First, reason in your scratchpad. Then, generate the <state_snapshot>.',
                },
              ],
            },
          ],
          config: {
            systemInstruction: { text: getCompressionPrompt() },
          },
        },
        prompt_id,
      );
    const summary = getResponseText(summaryResponse) ?? '';

    const newHistory = [
      {
        role: 'user' as const,
        parts: [
          createLanguageReminderPart(),
          createActionReminderPart(),
          createSystemReminderPart(),
          { text: summary },
        ],
      },
      {
        role: 'model' as const,
        parts: [{ text: 'Got it. Thanks for the additional context!' }],
      },
      ...historyToKeep,
    ];

    // Estimate new token count using the same method
    const newTokenCount = estimateTokens(newHistory);

    // Determine compression status
    let compressionStatus: CompressionStatus;
    if (newTokenCount >= originalTokenCount) {
      compressionStatus =
        CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT;
      this.hasFailedCompressionAttempt = !force && true;
    } else {
      compressionStatus = CompressionStatus.COMPRESSED;
      this.chat = await this.startChat(newHistory);
      this.forceFullIdeContext = true;
    }

    // Log compression event with token counts
    logChatCompression(
      this.config,
      makeChatCompressionEvent({
        tokens_before: originalTokenCount,
        tokens_after: newTokenCount,
      }),
    );

    return {
      originalTokenCount,
      newTokenCount,
      compressionStatus,
    };
  }
}
