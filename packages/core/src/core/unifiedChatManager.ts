/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { Content, Part } from '@google/genai';
import type { GeminiClient } from './client.js';
import type { ClaudeClient } from './claudeClient.js';
import type { OpenAIClient } from './openaiClient.js';
import type { LmStudioClient } from './lmstudioClient.js';
import {
  ClientPoolRouter,
  type ModelProviderType,
} from './clientPoolRouter.js';
import { SessionManager } from '../sessions/SessionManager.js';
import { RoleManager } from '../roles/RoleManager.js';
import { WorkspaceManager } from '../utils/WorkspaceManager.js';
import { TemplateManager } from '../templates/TemplateManager.js';
import type { UniversalMessage, ToolProgressEvent } from './message-types.js';
import {
  GeminiEventType,
  type ToolCallRequestInfo,
  type ServerGeminiStreamEvent,
} from './turn.js';
import {
  CoreToolScheduler,
  type ToolCall as SchedulerToolCall,
} from './coreToolScheduler.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
} from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { IClient } from './IClient.js';

/**
 * UnifiedChatManager - Multi-provider chat management system
 *
 * Responsibilities:
 * - Route sessions to appropriate provider (Gemini, Claude, OpenAI, LM Studio)
 * - Coordinate between IClient implementations, SessionManager, and RoleManager
 * - Handle message sending with streaming support across all providers
 * - Execute tool calls with confirmation support
 * - Manage conversation history and sessions
 * - Trigger chat compression when needed
 *
 * Architecture:
 * UnifiedChatManager → ClientPoolRouter → Provider-specific ClientPool → Provider Client (IClient)
 */
export class UnifiedChatManager {
  private clientPoolRouter: ClientPoolRouter;
  private sessionManager: SessionManager;
  private roleManager: RoleManager;
  private config: Config;
  private toolConfirmationHandler?: (
    details: ToolCallConfirmationDetails,
  ) => Promise<ToolConfirmationOutcome>;
  private toolProgressHandler?: (event: ToolProgressEvent) => void;
  private activeToolScheduler?: CoreToolScheduler;

  // Note: Provider is now a global setting stored in Config, not per-session

  constructor(config: Config) {
    this.config = config;
    this.sessionManager = SessionManager.getInstance();
    this.roleManager = RoleManager.getInstance();

    // Create client pool router with save and restore callbacks for all providers
    this.clientPoolRouter = new ClientPoolRouter(
      config,
      // Gemini callbacks
      (sessionId, client) => {
        this.saveSessionFromClient(sessionId, client);
      },
      async (sessionId, client) => {
        await this.restoreSessionIntoClient(sessionId, client);
      },
      // Claude callbacks
      (sessionId, client) => {
        this.saveSessionFromClient(sessionId, client);
      },
      async (sessionId, client) => {
        await this.restoreSessionIntoClient(sessionId, client);
      },
      // OpenAI callbacks
      (sessionId, client) => {
        this.saveSessionFromClient(sessionId, client);
      },
      async (sessionId, client) => {
        await this.restoreSessionIntoClient(sessionId, client);
      },
      // LM Studio callbacks
      (sessionId, client) => {
        this.saveSessionFromClient(sessionId, client);
      },
      async (sessionId, client) => {
        await this.restoreSessionIntoClient(sessionId, client);
      },
    );
  }

  /**
   * Initialize the chat manager
   * @param initialRoleId - Optional role ID to set during initialization
   * @param defaultProvider - Default provider type for new sessions
   */
  async initialize(
    initialRoleId?: string,
    defaultProvider: ModelProviderType = 'gemini',
  ): Promise<void> {
    // Set global provider from the parameter (respects user's persisted choice)
    this.config.setGlobalProvider(defaultProvider);
    console.log(
      `[UnifiedChatManager] Set global provider to: ${defaultProvider}`,
    );

    // Sync global model from Config.model (which was set in constructor from configParams)
    const currentModel = this.config.getModel();
    this.config.setGlobalModel(currentModel);
    console.log(`[UnifiedChatManager] Set global model to: ${currentModel}`);

    // Always switch to the specified role (defaults to software_engineer if not provided)
    // This ensures the role is set correctly and tools are configured
    const roleId = initialRoleId || 'software_engineer';
    await this.switchRole(roleId);

    // Load current session history into appropriate client if there's an active session
    const currentSessionId = this.sessionManager.getCurrentSessionId();
    if (currentSessionId) {
      // Use global provider
      const provider = this.config.getGlobalProvider() as ModelProviderType;
      await this.loadSessionIntoClient(currentSessionId, provider);
      console.log(
        `[UnifiedChatManager] Loaded existing session history into ${provider} client`,
      );
    }

    console.log(
      `[UnifiedChatManager] Initialized with role: ${roleId}, provider: ${defaultProvider}, model: ${currentModel}`,
    );
  }

  /**
   * Get the global provider (applies to all sessions)
   * Note: sessionId parameter is kept for backward compatibility but not used
   */
  getSessionProvider(sessionId: string): ModelProviderType {
    const provider = this.config.getGlobalProvider() as ModelProviderType;
    console.log(
      `[UnifiedChatManager] getSessionProvider(${sessionId}): using global provider: ${provider}`,
    );
    return provider;
  }

  /**
   * Set the global provider (applies to all sessions) and reinitialize tools
   * Note: sessionId parameter is kept for backward compatibility but not used
   */
  async setSessionProvider(
    sessionId: string,
    provider: ModelProviderType,
  ): Promise<void> {
    this.config.setGlobalProvider(provider);
    console.log(`[UnifiedChatManager] Set global provider: ${provider}`);

    // Get or create client for the new provider
    const client = await this.clientPoolRouter.getClient(sessionId, provider);

    // Reinitialize tools for the new provider
    await client.updateToolsForCurrentRole();
    console.log(
      `[UnifiedChatManager] Reinitialized tools for session ${sessionId} with provider ${provider}`,
    );
  }

  /**
   * Save session history from any IClient to SessionManager
   * This is called automatically by the client pools
   */
  private saveSessionFromClient(
    sessionId: string,
    client: GeminiClient | ClaudeClient | OpenAIClient | LmStudioClient,
  ): void {
    let messages: UniversalMessage[];

    // Check if client has getChat() method (OpenAI, LM Studio, Claude clients)
    // These clients convert their native history format in getHistory()
    // We need to get the raw history from the underlying chat object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientAny = client as any;

    if (typeof clientAny.getChat === 'function') {
      const chat = clientAny.getChat();
      const rawHistory = chat.getHistory();
      console.log(
        `[UnifiedChatManager] saveSessionFromClient (via getChat): sessionId=${sessionId}, history length=${rawHistory.length}`,
      );

      // Detect format from raw history
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const firstItem = rawHistory[0] as any;

      if (!firstItem) {
        console.log(
          '[UnifiedChatManager] Empty history, saving empty messages array',
        );
        messages = [];
      } else if ('role' in firstItem && 'parts' in firstItem) {
        // Gemini format: Content[] with role + parts
        console.log(
          '[UnifiedChatManager] Detected Gemini format (role + parts)',
        );
        messages = this.convertToUniversal(rawHistory as Content[]);
      } else if ('role' in firstItem && 'content' in firstItem) {
        // OpenAI/LM Studio or Claude format
        const content = firstItem.content;
        if (
          Array.isArray(content) &&
          content.length > 0 &&
          typeof content[0] === 'object' &&
          content[0] !== null &&
          'type' in content[0]
        ) {
          // Claude format: MessageParam[] with content as ContentBlock[]
          console.log(
            '[UnifiedChatManager] Detected Claude format (content with type blocks)',
          );
          messages = this.convertClaudeToUniversal(
            rawHistory as Array<
              import('@anthropic-ai/sdk/resources/messages.js').MessageParam
            >,
          );
        } else {
          // OpenAI/LM Studio format: ChatCompletionMessageParam[]
          console.log(
            '[UnifiedChatManager] Detected OpenAI/LmStudio format (role + content string)',
          );
          messages = this.convertOpenAIToUniversal(
            rawHistory as Array<
              import('openai/resources/chat/completions.js').ChatCompletionMessageParam
            >,
          );
        }
      } else {
        console.warn(
          '[UnifiedChatManager] Unknown raw history format from getChat()',
        );
        messages = [];
      }
    } else {
      // Gemini client - use getHistory() which returns Content[]
      const history = client.getHistory();
      console.log(
        `[UnifiedChatManager] saveSessionFromClient (Gemini): sessionId=${sessionId}, history length=${history.length}`,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const firstItem = history[0] as any;

      if (!firstItem) {
        console.log(
          '[UnifiedChatManager] Empty history, saving empty messages array',
        );
        messages = [];
      } else {
        messages = this.convertToUniversal(history as Content[]);
      }
    }

    const messagesWithToolCalls = messages.filter(
      (m) => m.toolCalls && m.toolCalls.length > 0,
    );
    const toolMessages = messages.filter((m) => m.role === 'tool');
    console.log(
      `[UnifiedChatManager] Saving ${messages.length} messages: ${messagesWithToolCalls.length} with toolCalls, ${toolMessages.length} tool responses`,
    );

    this.sessionManager.saveSessionHistory(sessionId, messages);
  }

  /**
   * Send messages with streaming support and automatic tool execution
   *
   * Works across all providers (Gemini, Claude, OpenAI, LM Studio)
   *
   * @param request - User message content as Part array (e.g., [{text: "..."}])
   * @param signal - Abort signal for cancellation
   * @param prompt_id - Unique ID for this prompt
   * @param provider - Optional provider override (defaults to session's current provider)
   */
  async *sendMessageStream(
    request: Part[],
    signal: AbortSignal,
    prompt_id: string,
    provider?: ModelProviderType,
  ): AsyncGenerator<ServerGeminiStreamEvent> {
    // Get current session ID
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    // Determine provider for this session
    const sessionProvider = provider || this.getSessionProvider(sessionId);

    // Get or create client for this session with the appropriate provider
    const client = await this.clientPoolRouter.getClient(
      sessionId,
      sessionProvider,
    );

    // Update GenerateContentConfig with latest system prompt and workspace context
    await client.updateGenerateContentConfig();

    // Ensure tools are initialized for the current role
    // This is especially important on first message after startup
    await client.updateToolsForCurrentRole();

    let currentRequest = request;

    try {
      // Agentic loop - continue until no tool calls are made
      while (true) {
        const toolCallRequests: ToolCallRequestInfo[] = [];
        const assistantToolCalls: Array<{
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }> = [];

        // Send message to client and collect tool calls + content
        const responseStream = client.sendMessageStream(
          currentRequest,
          signal,
          prompt_id,
        );

        for await (const event of responseStream) {
          if (signal.aborted) {
            return;
          }

          // Collect tool call requests
          if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);

            // Also collect for SessionManager history
            assistantToolCalls.push({
              id: event.value.callId,
              name: event.value.name,
              arguments: event.value.args,
            });

            // Yield the tool call request event
            yield {
              type: GeminiEventType.ToolCallRequest,
              value: {
                callId: event.value.callId,
                name: event.value.name,
                args: event.value.args,
                isClientInitiated: event.value.isClientInitiated,
                prompt_id: event.value.prompt_id,
                description: event.value.description,
              },
            };
            continue;
          }

          // Yield all other events to frontend
          yield event;
        }

        // If there are tool calls, execute them and continue the loop
        if (toolCallRequests.length > 0) {
          const toolResponseParts: Part[] = [];
          const executedToolResponses: UniversalMessage[] = [];

          // Use CoreToolScheduler with confirmation support if handler is available
          if (this.toolConfirmationHandler) {
            console.log(
              `[UnifiedChatManager] Executing ${toolCallRequests.length} tool calls`,
            );
            console.log(
              `[UnifiedChatManager] Current approval mode: ${this.config.getApprovalMode()}`,
            );
            console.log(
              `[UnifiedChatManager] Tool confirmation handler set: ${!!this.toolConfirmationHandler}`,
            );

            const yieldedToolCallIds = new Set<string>();
            const collectedEvents: ServerGeminiStreamEvent[] = [];

            await new Promise<void>((resolve, reject) => {
              const scheduler = new CoreToolScheduler({
                config: this.config,
                getPreferredEditor: () => undefined,
                onEditorClose: () => {},

                // Progress update handler
                onToolProgressUpdate: this.toolProgressHandler
                  ? (event: ToolProgressEvent) => {
                      collectedEvents.push({
                        type: GeminiEventType.ToolProgress,
                        value: event,
                      });
                      if (this.toolProgressHandler) {
                        this.toolProgressHandler(event);
                      }
                    }
                  : undefined,

                // Tool status update handler
                onToolCallsUpdate: async (
                  toolCallsUpdate: SchedulerToolCall[],
                ) => {
                  for (const toolCall of toolCallsUpdate) {
                    // Handle confirmation requests
                    if (toolCall.status === 'awaiting_approval') {
                      console.log(
                        `[UnifiedChatManager] Tool ${toolCall.request.name} awaiting approval`,
                      );
                      console.log(
                        `[UnifiedChatManager] Current approval mode: ${this.config.getApprovalMode()}`,
                      );
                      console.log(
                        `[UnifiedChatManager] Has confirmation handler: ${!!this.toolConfirmationHandler}`,
                      );

                      if (
                        'confirmationDetails' in toolCall &&
                        this.toolConfirmationHandler
                      ) {
                        console.log(
                          `[UnifiedChatManager] Requesting user confirmation for ${toolCall.request.name}`,
                        );
                        const outcome = await this.toolConfirmationHandler(
                          toolCall.confirmationDetails,
                        );
                        console.log(
                          `[UnifiedChatManager] User confirmation outcome: ${outcome}`,
                        );
                        await toolCall.confirmationDetails.onConfirm(outcome);
                      }
                    }

                    // Collect completed tool responses
                    if (
                      (toolCall.status === 'success' ||
                        toolCall.status === 'error' ||
                        toolCall.status === 'cancelled') &&
                      !yieldedToolCallIds.has(toolCall.request.callId)
                    ) {
                      yieldedToolCallIds.add(toolCall.request.callId);

                      let toolResponseContent: string;

                      if (
                        toolCall.status === 'success' &&
                        'response' in toolCall
                      ) {
                        const response = toolCall.response;

                        if (response.responseParts) {
                          toolResponseParts.push(...response.responseParts);
                        }

                        // Extract content for display
                        if (
                          response.responseParts &&
                          response.responseParts.length > 0
                        ) {
                          const responsePart = response.responseParts[0];
                          if ('text' in responsePart) {
                            toolResponseContent = responsePart.text || '';
                          } else if (
                            'functionResponse' in responsePart &&
                            responsePart.functionResponse
                          ) {
                            const funcResponse =
                              responsePart.functionResponse.response;
                            if (
                              funcResponse &&
                              typeof funcResponse === 'object' &&
                              'output' in funcResponse
                            ) {
                              toolResponseContent = funcResponse[
                                'output'
                              ] as string;
                            } else {
                              toolResponseContent = JSON.stringify(
                                funcResponse,
                                null,
                                2,
                              );
                            }
                          } else {
                            toolResponseContent = 'Tool executed successfully';
                          }
                        } else {
                          toolResponseContent = 'Tool executed successfully';
                        }

                        collectedEvents.push({
                          type: GeminiEventType.ToolCallResponse,
                          value: {
                            callId: toolCall.request.callId,
                            name: toolCall.request.name,
                            responseParts: response.responseParts,
                            resultDisplay: toolResponseContent,
                            error: undefined,
                            errorType: undefined,
                            structuredData: response.structuredData,
                            sessionId,
                            toolSuccess: true,
                          },
                        });
                      } else if (
                        toolCall.status === 'error' &&
                        'response' in toolCall
                      ) {
                        const errorMsg =
                          toolCall.response.error?.message ||
                          'Tool execution failed';
                        toolResponseContent = `Tool execution failed: ${errorMsg}`;

                        const errorResponseParts = toolCall.response
                          .responseParts || [
                          {
                            functionResponse: {
                              id: toolCall.request.callId,
                              name: toolCall.request.name,
                              response: {
                                error: errorMsg,
                              },
                            },
                          },
                        ];

                        toolResponseParts.push(...errorResponseParts);

                        collectedEvents.push({
                          type: GeminiEventType.ToolCallResponse,
                          value: {
                            callId: toolCall.request.callId,
                            name: toolCall.request.name,
                            responseParts: errorResponseParts,
                            resultDisplay: toolResponseContent,
                            error:
                              toolCall.response.error || new Error(errorMsg),
                            errorType:
                              toolCall.response.errorType ||
                              ToolErrorType.EXECUTION_FAILED,
                            structuredData: toolCall.response.structuredData,
                            sessionId,
                            toolSuccess: false,
                          },
                        });
                      } else if (
                        toolCall.status === 'cancelled' &&
                        'response' in toolCall
                      ) {
                        const cancelMsg =
                          toolCall.response.error?.message ||
                          'Tool execution cancelled';
                        toolResponseContent = `Tool cancelled: ${cancelMsg}`;

                        const cancelResponseParts = toolCall.response
                          .responseParts || [
                          {
                            functionResponse: {
                              id: toolCall.request.callId,
                              name: toolCall.request.name,
                              response: {
                                error: cancelMsg,
                              },
                            },
                          },
                        ];

                        toolResponseParts.push(...cancelResponseParts);

                        collectedEvents.push({
                          type: GeminiEventType.ToolCallResponse,
                          value: {
                            callId: toolCall.request.callId,
                            name: toolCall.request.name,
                            responseParts: cancelResponseParts,
                            resultDisplay: toolResponseContent,
                            error:
                              toolCall.response.error || new Error(cancelMsg),
                            errorType:
                              toolCall.response.errorType ||
                              ToolErrorType.USER_CANCELLED,
                            structuredData: toolCall.response.structuredData,
                            sessionId,
                            toolSuccess: false,
                          },
                        });
                      } else {
                        toolResponseContent = 'Unknown tool status';
                      }

                      // Build tool response message for SessionManager
                      executedToolResponses.push({
                        role: 'tool',
                        content: toolResponseContent,
                        tool_call_id: toolCall.request.callId,
                        name: toolCall.request.name,
                        timestamp: new Date(),
                      });
                    }
                  }
                },

                // All tools completed
                onAllToolCallsComplete: async (completedToolCalls) => {
                  this.activeToolScheduler = undefined;
                  console.log(
                    `[UnifiedChatManager] All ${completedToolCalls.length} tool calls completed`,
                  );
                  resolve();
                },
              });

              this.activeToolScheduler = scheduler;

              if (signal.aborted) {
                resolve();
                return;
              }

              scheduler.schedule(toolCallRequests, signal).catch((error) => {
                console.error(`[UnifiedChatManager] Scheduler error:`, error);
                reject(error);
              });
            });

            // Yield all collected tool response events
            for (const event of collectedEvents) {
              yield event;
            }
          } else {
            // Fallback: execute without confirmation
            console.warn(
              '[UnifiedChatManager] No tool confirmation handler set, tools will auto-execute!',
            );

            const { executeToolCall } = await import(
              './nonInteractiveToolExecutor.js'
            );

            for (const requestInfo of toolCallRequests) {
              const toolResponse = await executeToolCall(
                this.config,
                requestInfo,
                signal,
              );

              if (toolResponse.response.responseParts) {
                toolResponseParts.push(...toolResponse.response.responseParts);
              }

              const responseContent = toolResponse.response.resultDisplay
                ? typeof toolResponse.response.resultDisplay === 'string'
                  ? toolResponse.response.resultDisplay
                  : JSON.stringify(toolResponse.response.resultDisplay)
                : 'Tool executed successfully';

              executedToolResponses.push({
                role: 'tool',
                content: responseContent,
                tool_call_id: requestInfo.callId,
                name: requestInfo.name,
                timestamp: new Date(),
              });

              yield {
                type: GeminiEventType.ToolCallResponse,
                value: {
                  callId: requestInfo.callId,
                  name: requestInfo.name,
                  responseParts: toolResponse.response.responseParts || [],
                  resultDisplay: toolResponse.response.resultDisplay,
                  error: toolResponse.response.error,
                  errorType: toolResponse.response.errorType,
                  sessionId,
                  toolSuccess: !toolResponse.response.error,
                },
              };
            }
          }

          if (toolResponseParts.length === 0) {
            console.log(
              `[UnifiedChatManager] No tool response parts to continue with, ending conversation`,
            );
            break;
          }

          // Validate tool call/response count match
          const functionResponseCount = toolResponseParts.filter(
            (part) => 'functionResponse' in part,
          ).length;
          if (functionResponseCount !== toolCallRequests.length) {
            const errorMsg = `Tool call/response mismatch: ${toolCallRequests.length} calls but ${functionResponseCount} responses.`;
            console.error(`[UnifiedChatManager] ${errorMsg}`);
            throw new Error(errorMsg);
          }

          // Continue loop with tool responses
          currentRequest = toolResponseParts;
          console.log(
            `[UnifiedChatManager] Continuing conversation with ${toolResponseParts.length} tool response parts`,
          );
        } else {
          // No tool calls - conversation complete
          console.log(
            '[UnifiedChatManager] No tool calls, conversation complete',
          );
          break;
        }
      }
    } finally {
      // Auto-save session history
      console.log(
        `[UnifiedChatManager] Finally block: Saving session ${sessionId} (provider: ${sessionProvider})`,
      );
      await this.clientPoolRouter.saveSession(sessionId, sessionProvider);
      console.log(`[UnifiedChatManager] Session saved successfully`);

      // Auto-generate title
      this.sessionManager.autoGenerateTitle(sessionId).catch((error) => {
        console.error(
          '[UnifiedChatManager] Failed to auto-generate title:',
          error,
        );
      });
    }
  }

  /**
   * Get the IClient instance for the current session
   */
  getClient(): IClient | undefined {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      return undefined;
    }
    const provider = this.getSessionProvider(sessionId);
    const pool = this.clientPoolRouter.getPool(provider);
    return pool.get(sessionId);
  }

  /**
   * Set the tool confirmation handler
   */
  setToolConfirmationHandler(
    handler: (
      details: ToolCallConfirmationDetails,
    ) => Promise<ToolConfirmationOutcome>,
  ): void {
    this.toolConfirmationHandler = handler;
  }

  /**
   * Get the tool confirmation handler
   */
  getToolConfirmationHandler():
    | ((
        details: ToolCallConfirmationDetails,
      ) => Promise<ToolConfirmationOutcome>)
    | undefined {
    return this.toolConfirmationHandler;
  }

  /**
   * Set the tool progress handler
   */
  setToolProgressHandler(handler: (event: ToolProgressEvent) => void): void {
    this.toolProgressHandler = handler;
  }

  /**
   * Get the tool progress handler
   */
  getToolProgressHandler(): ((event: ToolProgressEvent) => void) | undefined {
    return this.toolProgressHandler;
  }

  /**
   * Convert Content[] (Gemini format) to UniversalMessage[] (SessionManager format)
   */
  private convertToUniversal(contents: Content[]): UniversalMessage[] {
    const messages: UniversalMessage[] = [];

    console.log(
      `[UnifiedChatManager] convertToUniversal: Converting ${contents.length} Gemini contents`,
    );

    for (const content of contents) {
      if (content.role !== 'user' && content.role !== 'model') {
        continue;
      }

      const role = content.role === 'model' ? 'assistant' : 'user';

      let textContent = '';
      const toolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }> = [];
      let toolCallId: string | undefined;
      let toolName: string | undefined;

      for (const part of content.parts || []) {
        if ('text' in part && part.text) {
          textContent += part.text;
        }

        if (
          'functionCall' in part &&
          part.functionCall &&
          part.functionCall.name
        ) {
          const args =
            (part.functionCall.args as Record<string, unknown>) || {};

          const functionCallId =
            part.functionCall.id ??
            `${part.functionCall.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          toolCalls.push({
            id: functionCallId,
            name: part.functionCall.name,
            arguments: args,
          });
          console.log(
            `[UnifiedChatManager] Found functionCall: ${part.functionCall.name} (id: ${functionCallId})`,
          );
        }

        if ('functionResponse' in part && part.functionResponse) {
          toolName = part.functionResponse.name;
          const response = part.functionResponse.response;

          if (part.functionResponse.id) {
            toolCallId = part.functionResponse.id;

            const hasError =
              response && typeof response === 'object' && 'error' in response;

            // Update corresponding toolCall status
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (msg.role === 'assistant' && msg.toolCalls) {
                const toolCallIndex = msg.toolCalls.findIndex(
                  (tc) => tc.id === toolCallId,
                );
                if (toolCallIndex !== -1) {
                  msg.toolCalls[toolCallIndex] = {
                    ...msg.toolCalls[toolCallIndex],
                    status: hasError ? 'failed' : 'completed',
                    success: !hasError,
                    result: hasError
                      ? `Tool execution failed: ${String(response['error'])}`
                      : response &&
                          typeof response === 'object' &&
                          'output' in response
                        ? String(response['output'])
                        : 'Tool executed successfully',
                  };
                  break;
                }
              }
            }
          } else {
            toolCallId = `call_${Date.now()}`;
          }

          if (
            response &&
            typeof response === 'object' &&
            'output' in response
          ) {
            textContent += String(response['output']);
          }
        }
      }

      if (toolCallId && toolName) {
        const toolMessage: UniversalMessage = {
          role: 'tool',
          content: textContent,
          tool_call_id: toolCallId,
          name: toolName,
          timestamp: new Date(),
          parts: content.parts as unknown[],
        };
        messages.push(toolMessage);
        console.log(
          `[UnifiedChatManager] Created tool message: ${toolName} (call_id: ${toolCallId})`,
        );
      } else {
        const message: UniversalMessage = {
          role,
          content: textContent,
          timestamp: new Date(),
          parts: content.parts as unknown[],
        };

        if (toolCalls.length > 0) {
          message.toolCalls = toolCalls;
          console.log(
            `[UnifiedChatManager] Created ${role} message with ${toolCalls.length} toolCalls`,
          );
        } else {
          console.log(
            `[UnifiedChatManager] Created ${role} message (no toolCalls), content length: ${textContent.length}`,
          );
        }

        messages.push(message);
      }
    }

    console.log(
      `[UnifiedChatManager] convertToUniversal completed: ${messages.length} messages created`,
    );
    return messages;
  }

  /**
   * Convert OpenAI/LM Studio format to Universal format
   */
  private convertOpenAIToUniversal(
    messages: Array<
      import('openai/resources/chat/completions.js').ChatCompletionMessageParam
    >,
  ): UniversalMessage[] {
    const universalMessages: UniversalMessage[] = [];
    console.log(
      `[UnifiedChatManager] convertOpenAIToUniversal: Converting ${messages.length} OpenAI/LmStudio messages`,
    );

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

        // Check if tool response contains error (following Gemini pattern from commit db58d2aba)
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
                  `[UnifiedChatManager] Updated toolCall ${toolCallId} status to failed`,
                );
                break;
              }
            }
          }
        }

        const toolMessage = {
          role: 'tool' as const,
          content: toolContent,
          tool_call_id: toolCallId,
          timestamp: new Date(),
        };
        console.log(
          `[UnifiedChatManager] Created tool message (call_id: ${toolMessage.tool_call_id})`,
        );
        universalMessages.push(toolMessage);
      } else if (msg.role === 'assistant') {
        // Assistant message (may include tool calls)
        console.log(`[UnifiedChatManager] Processing assistant message:`);
        console.log(
          `[UnifiedChatManager]   - content type: ${typeof msg.content}`,
        );
        console.log(
          `[UnifiedChatManager]   - content value: ${JSON.stringify(msg.content).substring(0, 100)}`,
        );

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

        console.log(
          `[UnifiedChatManager]   - extracted content length: ${content.length}`,
        );

        const message: UniversalMessage = {
          role: 'assistant',
          content,
          timestamp: new Date(),
        };

        // Handle tool calls
        if (
          'tool_calls' in msg &&
          msg.tool_calls &&
          Array.isArray(msg.tool_calls)
        ) {
          message.toolCalls = msg.tool_calls
            .filter((tc) => tc.type === 'function')
            .map((tc) => {
              console.log(
                `[UnifiedChatManager] Found tool_call: ${tc.function.name} (id: ${tc.id})`,
              );
              return {
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments || '{}') as Record<
                  string,
                  unknown
                >,
              };
            });
          console.log(
            `[UnifiedChatManager] Created assistant message with ${message.toolCalls.length} toolCalls`,
          );
        } else {
          console.log(
            `[UnifiedChatManager] Created assistant message (no toolCalls), content length: ${content.length}`,
          );
        }

        universalMessages.push(message);
      } else if (msg.role === 'user') {
        // User message
        const userContent =
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
        console.log(`[UnifiedChatManager] Processing user message:`);
        console.log(
          `[UnifiedChatManager]   - content type: ${typeof msg.content}`,
        );
        console.log(
          `[UnifiedChatManager]   - content value: ${JSON.stringify(msg.content).substring(0, 100)}`,
        );
        console.log(
          `[UnifiedChatManager]   - final content length: ${userContent.length}`,
        );
        universalMessages.push({
          role: 'user',
          content: userContent,
          timestamp: new Date(),
        });
      }
    }

    const messagesWithToolCalls = universalMessages.filter(
      (m) => m.toolCalls && m.toolCalls.length > 0,
    );
    const toolMessages = universalMessages.filter((m) => m.role === 'tool');
    console.log(
      `[UnifiedChatManager] convertOpenAIToUniversal completed: ${universalMessages.length} messages created (${messagesWithToolCalls.length} with toolCalls, ${toolMessages.length} tool responses)`,
    );
    return universalMessages;
  }

  /**
   * Convert Claude format to Universal format
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

            // Check if tool response contains error (following Gemini pattern from commit db58d2aba)
            let hasError = false;
            // Claude tool_result blocks have an is_error property
            if ('is_error' in block && block.is_error) {
              hasError = true;
            } else {
              // Fallback: check content for error indicators
              try {
                const parsedContent = JSON.parse(toolContent);
                hasError =
                  parsedContent &&
                  typeof parsedContent === 'object' &&
                  'error' in parsedContent;
              } catch {
                hasError =
                  toolContent.includes('Tool execution failed') ||
                  toolContent.includes('Tool cancelled');
              }
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
                      `[UnifiedChatManager] Updated Claude toolCall ${toolCallId} status to failed`,
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
            });
          } else if (block.type === 'text') {
            // Regular text message
            universalMessages.push({
              role: 'user',
              content: block.text,
              timestamp: new Date(),
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
   * Restore session history into a specific client
   */
  private async restoreSessionIntoClient(
    sessionId: string,
    client: GeminiClient | ClaudeClient | OpenAIClient | LmStudioClient,
  ): Promise<void> {
    console.log(
      `[UnifiedChatManager] restoreSessionIntoClient: sessionId=${sessionId}`,
    );
    const universalHistory = this.sessionManager.getDisplayMessages(sessionId);
    console.log(
      `[UnifiedChatManager] Retrieved ${universalHistory.length} messages from SessionManager for session ${sessionId}`,
    );

    if (universalHistory.length === 0) {
      console.log(
        `[UnifiedChatManager] No history found, resetting chat for session ${sessionId}`,
      );
      await client.resetChat();
      console.log(
        `[UnifiedChatManager] Started fresh chat for session ${sessionId}`,
      );
      return;
    }

    // All clients now accept UniversalMessage[] directly and handle their own conversion
    console.log(
      `[UnifiedChatManager] Setting ${universalHistory.length} UniversalMessages into client`,
    );
    client.setHistory(universalHistory);
    console.log(
      `[UnifiedChatManager] Restored ${universalHistory.length} messages into client for session ${sessionId}`,
    );
  }

  /**
   * Load session history into client
   */
  private async loadSessionIntoClient(
    sessionId: string,
    provider: ModelProviderType,
  ): Promise<void> {
    const client = await this.clientPoolRouter.getClient(sessionId, provider);

    const history = client.getHistory();
    console.log(
      `[UnifiedChatManager] Client for session ${sessionId} (${provider}) has ${history.length} messages in history`,
    );
  }

  /**
   * Get SessionManager instance
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Switch session with client pool coordination
   *
   * NOTE: We DO NOT save the current session here because:
   * 1. Session history is saved automatically after each user/assistant/tool interaction (in sendMessageStream finally block)
   * 2. Saving during switch may capture incomplete/incorrect state if client hasn't fully restored history
   * 3. The client pool will auto-save on timeout (15 min idle)
   */
  async switchSession(sessionId: string): Promise<void> {
    const currentSessionId = this.sessionManager.getCurrentSessionId();

    console.log(
      `[UnifiedChatManager] switchSession: from ${currentSessionId} to ${sessionId}`,
    );

    // Just switch the session - no need to save
    console.log(
      `[UnifiedChatManager] Calling sessionManager.switchSession(${sessionId})`,
    );
    this.sessionManager.switchSession(sessionId);

    const newProvider = this.getSessionProvider(sessionId);
    console.log(
      `[UnifiedChatManager] Loading session ${sessionId} into ${newProvider} client`,
    );
    await this.loadSessionIntoClient(sessionId, newProvider);
    console.log(
      `[UnifiedChatManager] Switched to session: ${sessionId} (${newProvider})`,
    );
  }

  /**
   * Delete session with client pool cleanup
   */
  deleteSession(sessionId: string): void {
    const provider = this.getSessionProvider(sessionId);
    this.clientPoolRouter.releaseSession(sessionId, provider);
    this.sessionManager.deleteSession(sessionId);
    // Note: Provider is now global, no per-session tracking to clean up
  }

  /**
   * Delete all sessions
   */
  deleteAllSessions(): void {
    const sessionIds = this.sessionManager.getSessionIds();
    sessionIds.forEach((id) => this.deleteSession(id));
  }

  /**
   * Get RoleManager instance
   */
  getRoleManager(): RoleManager {
    return this.roleManager;
  }

  /**
   * Switch role with client tool updates
   */
  async switchRole(roleId: string): Promise<boolean> {
    const success = await this.roleManager.setCurrentRole(roleId);
    if (success) {
      const sessionId = this.sessionManager.getCurrentSessionId();
      if (sessionId) {
        const client = this.getClient();
        if (client) {
          await client.updateToolsForCurrentRole();
        }
      }
      console.log(`[UnifiedChatManager] Switched to role: ${roleId}`);
    }
    return success;
  }

  /**
   * Get config
   */
  getConfig(): Config {
    return this.config;
  }

  /**
   * Set approval mode
   */
  setApprovalMode(mode: 'default' | 'autoEdit' | 'yolo'): void {
    const approvalModeValue =
      mode === 'yolo'
        ? ApprovalMode.YOLO
        : mode === 'autoEdit'
          ? ApprovalMode.AUTO_EDIT
          : ApprovalMode.DEFAULT;

    const previousMode = this.config.getApprovalMode();
    this.config.setApprovalMode(approvalModeValue);
    console.log(`[UnifiedChatManager] Set approval mode to: ${mode}`);

    if (this.activeToolScheduler && approvalModeValue !== previousMode) {
      const signal = new AbortController().signal;
      this.activeToolScheduler
        .reevaluateAllPendingTools(signal)
        .catch((error) => {
          console.error(
            '[UnifiedChatManager] Error reevaluating pending tools:',
            error,
          );
        });
    }
  }

  /**
   * Get approval mode
   */
  getApprovalMode(): 'default' | 'autoEdit' | 'yolo' {
    const mode = this.config.getApprovalMode();

    switch (mode) {
      case ApprovalMode.YOLO:
        return 'yolo';
      case ApprovalMode.AUTO_EDIT:
        return 'autoEdit';
      default:
        return 'default';
    }
  }

  /**
   * Get WorkspaceManager instance
   */
  getWorkspaceManager(): WorkspaceManager {
    return WorkspaceManager.getInstance(this.config);
  }

  /**
   * Get TemplateManager instance
   */
  getTemplateManager(): TemplateManager {
    return TemplateManager.getInstance(this.config);
  }

  /**
   * Get available models for a provider
   */
  async getAvailableModels(provider: ModelProviderType): Promise<string[]> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      // Create temporary session to get models
      const tempSessionId = `temp-${Date.now()}`;
      try {
        const client = await this.clientPoolRouter.getClient(
          tempSessionId,
          provider,
        );
        const models = await client.getAvailableModels();
        this.clientPoolRouter.releaseSession(tempSessionId, provider);
        return models;
      } catch (error) {
        console.error(
          `[UnifiedChatManager] Failed to get models for ${provider}:`,
          error,
        );
        return [];
      }
    }

    const client = await this.clientPoolRouter.getClient(sessionId, provider);
    return await client.getAvailableModels();
  }

  /**
   * Cleanup - saves all sessions and releases client pools
   */
  async cleanup(): Promise<void> {
    console.log('[UnifiedChatManager] Cleaning up...');

    await this.clientPoolRouter.clearAll();

    console.log('[UnifiedChatManager] Cleanup complete');
  }
}
