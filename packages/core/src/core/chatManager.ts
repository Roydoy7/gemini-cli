/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { Content, Part } from '@google/genai';
import type { GeminiClient } from './client.js';
import { GeminiClientPool } from './clientPool.js';
import { SessionManager } from '../sessions/SessionManager.js';
import { RoleManager } from '../roles/RoleManager.js';
import { WorkspaceManager } from '../utils/WorkspaceManager.js';
import { TemplateManager } from '../templates/TemplateManager.js';
import type { UniversalMessage } from './message-types.js';
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

/**
 * GeminiChatManager - Unified chat management system
 *
 * Responsibilities:
 * - Coordinate between GeminiClient, SessionManager, and RoleManager
 * - Handle message sending with streaming support
 * - Execute tool calls with confirmation support
 * - Manage conversation history and sessions
 * - Trigger chat compression when needed
 *
 * This replaces the MultiModelSystem approach, focusing solely on Gemini.
 */
export class GeminiChatManager {
  private clientPool: GeminiClientPool;
  private sessionManager: SessionManager;
  private roleManager: RoleManager;
  private config: Config;
  private toolConfirmationHandler?: (
    details: ToolCallConfirmationDetails,
  ) => Promise<ToolConfirmationOutcome>;
  private activeToolScheduler?: CoreToolScheduler;

  constructor(config: Config) {
    this.config = config;
    this.sessionManager = SessionManager.getInstance();
    this.roleManager = RoleManager.getInstance();

    // Create client pool with save callback
    this.clientPool = new GeminiClientPool(config, (sessionId, client) => {
      this.saveSessionFromClient(sessionId, client);
    });
  }

  /**
   * Initialize the chat manager
   * @param initialRoleId - Optional role ID to set during initialization
   */
  async initialize(initialRoleId?: string): Promise<void> {
    // Always switch to the specified role (defaults to software_engineer if not provided)
    // This ensures the role is set correctly and tools are configured
    const roleId = initialRoleId || 'software_engineer';
    await this.switchRole(roleId);

    // Load current session history into GeminiClient if there's an active session
    const currentSessionId = this.sessionManager.getCurrentSessionId();
    if (currentSessionId) {
      await this.loadSessionIntoClient(currentSessionId);
      console.log(
        '[GeminiChatManager] Loaded existing session history into GeminiClient',
      );
    }

    console.log('[GeminiChatManager] Initialized with role:', roleId);
  }

  /**
   * Save session history from GeminiClient to SessionManager
   * This is called automatically by the client pool
   */
  private saveSessionFromClient(sessionId: string, client: GeminiClient): void {
    const geminiHistory = client.getHistory();
    const messages = this.convertGeminiToUniversal(geminiHistory);
    this.sessionManager.saveSessionHistory(sessionId, messages);
  }

  /**
   * Send messages with streaming support and automatic tool execution
   *
   * Implements agentic loop like CLI's nonInteractiveCli.ts:
   * 1. Send message to GeminiClient
   * 2. Collect tool call requests and assistant content from stream
   * 3. Execute tool calls using executeToolCall()
   * 4. Save assistant message with tool calls and tool responses to SessionManager
   * 5. Send tool responses back and continue loop
   * 6. Repeat until no more tool calls
   *
   * Note: GeminiClient automatically manages its own history (GeminiChat).
   * We need to separately save to SessionManager for display purposes.
   *
   * @param request - User message content as Part array (e.g., [{text: "..."}])
   * @param signal - Abort signal for cancellation
   * @param prompt_id - Unique ID for this prompt
   */
  async *sendMessageStream(
    request: Part[],
    signal: AbortSignal,
    prompt_id: string,
  ): AsyncGenerator<ServerGeminiStreamEvent> {
    // Get current session ID
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    // Get or create client for this session
    const client = await this.clientPool.getOrCreate(sessionId);

    // Update GenerateContentConfig with latest system prompt and workspace context
    // This ensures the LLM always has the most up-to-date workspace information
    await client.updateGenerateContentConfig();

    let currentRequest = request;

    // Note: Title generation will be handled at the end of the conversation

    // Note: We don't save to SessionManager during streaming anymore
    // The client pool will auto-save when the stream completes

    try {
      // Agentic loop - continue until no tool calls are made
      while (true) {
        const toolCallRequests: ToolCallRequestInfo[] = [];
        const assistantToolCalls: Array<{
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }> = [];

        // Send message to GeminiClient and collect tool calls + content
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
              },
            };
            continue; // Don't yield the original event
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
              `[GeminiChatManager] Executing ${toolCallRequests.length} tool calls`,
            );
            console.log(
              `[GeminiChatManager] Current approval mode: ${this.config.getApprovalMode()}`,
            );
            console.log(
              `[GeminiChatManager] Tool confirmation handler set: ${!!this.toolConfirmationHandler}`,
            );

            const yieldedToolCallIds = new Set<string>();
            const collectedEvents: ServerGeminiStreamEvent[] = [];

            await new Promise<void>((resolve, reject) => {
              const scheduler = new CoreToolScheduler({
                config: this.config,
                getPreferredEditor: () => undefined,
                onEditorClose: () => {},

                // This is called every time any tool's status changes
                onToolCallsUpdate: async (
                  toolCallsUpdate: SchedulerToolCall[],
                ) => {
                  for (const toolCall of toolCallsUpdate) {
                    // Handle confirmation requests
                    if (toolCall.status === 'awaiting_approval') {
                      console.log(
                        `[GeminiChatManager] Tool ${toolCall.request.name} awaiting approval`,
                      );
                      console.log(
                        `[GeminiChatManager] Current approval mode: ${this.config.getApprovalMode()}`,
                      );
                      console.log(
                        `[GeminiChatManager] Has confirmation handler: ${!!this.toolConfirmationHandler}`,
                      );

                      if (
                        'confirmationDetails' in toolCall &&
                        this.toolConfirmationHandler
                      ) {
                        console.log(
                          `[GeminiChatManager] Requesting user confirmation for ${toolCall.request.name}`,
                        );
                        const outcome = await this.toolConfirmationHandler(
                          toolCall.confirmationDetails,
                        );
                        console.log(
                          `[GeminiChatManager] User confirmation outcome: ${outcome}`,
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

                      // Extract tool response content and parts
                      let toolResponseContent: string;

                      if (
                        toolCall.status === 'success' &&
                        'response' in toolCall
                      ) {
                        const response = toolCall.response;

                        // Collect response parts for next iteration
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

                        // Collect tool response event in correct format
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

                        // Create error response parts if not provided
                        const errorResponseParts = toolCall.response
                          .responseParts || [
                          {
                            functionResponse: {
                              name: toolCall.request.name,
                              response: {
                                error: errorMsg,
                              },
                            },
                          },
                        ];

                        // Add error response parts to continue conversation
                        toolResponseParts.push(...errorResponseParts);

                        collectedEvents.push({
                          type: GeminiEventType.ToolCallResponse,
                          value: {
                            callId: toolCall.request.callId,
                            name: toolCall.request.name,
                            responseParts: errorResponseParts,
                            resultDisplay: toolResponseContent,
                            error: toolCall.response.error,
                            errorType: toolCall.response.errorType,
                            structuredData: toolCall.response.structuredData,
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

                        // Create cancellation response parts if not provided
                        const cancelResponseParts = toolCall.response
                          .responseParts || [
                          {
                            functionResponse: {
                              name: toolCall.request.name,
                              response: {
                                error: cancelMsg,
                              },
                            },
                          },
                        ];

                        // Add cancellation response parts to continue conversation
                        toolResponseParts.push(...cancelResponseParts);

                        collectedEvents.push({
                          type: GeminiEventType.ToolCallResponse,
                          value: {
                            callId: toolCall.request.callId,
                            name: toolCall.request.name,
                            responseParts: cancelResponseParts,
                            resultDisplay: toolResponseContent,
                            error: toolCall.response.error,
                            errorType: toolCall.response.errorType,
                            structuredData: toolCall.response.structuredData,
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

                      console.log(
                        `[GeminiChatManager] Collected tool response for ${toolCall.request.name} (status: ${toolCall.status})`,
                      );
                    }
                  }
                },

                // All tools completed
                onAllToolCallsComplete: async (completedToolCalls) => {
                  this.activeToolScheduler = undefined;
                  console.log(
                    `[GeminiChatManager] All ${completedToolCalls.length} tool calls completed`,
                  );
                  resolve();
                },
              });

              // Save reference to active scheduler for potential approval mode changes
              this.activeToolScheduler = scheduler;

              // Check for abort
              if (signal.aborted) {
                console.warn(
                  `[GeminiChatManager] Aborted before tool execution.`,
                );
                resolve();
                return;
              }

              // Schedule all tools at once - they will execute in parallel
              scheduler.schedule(toolCallRequests, signal).catch((error) => {
                console.error(`[GeminiChatManager] Scheduler error:`, error);
                reject(error);
              });
            });

            // Now yield all collected tool response events
            for (const event of collectedEvents) {
              yield event;
            }
          } else {
            // Fallback: execute without confirmation (not recommended for GUI)
            console.warn(
              '[GeminiChatManager] No tool confirmation handler set, tools will auto-execute!',
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

              if (toolResponse.responseParts) {
                toolResponseParts.push(...toolResponse.responseParts);
              }

              const responseContent = toolResponse.resultDisplay
                ? typeof toolResponse.resultDisplay === 'string'
                  ? toolResponse.resultDisplay
                  : JSON.stringify(toolResponse.resultDisplay)
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
                  responseParts: toolResponse.responseParts || [],
                  resultDisplay: toolResponse.resultDisplay,
                  error: toolResponse.error,
                  errorType: toolResponse.errorType,
                },
              };
            }
          }

          // Note: We don't save to SessionManager during tool execution anymore
          // The client pool will auto-save the complete history when streaming completes

          // Check if we have tool responses to continue with
          if (toolResponseParts.length === 0) {
            console.log(
              `[GeminiChatManager] No tool response parts to continue with, ending conversation`,
            );
            break;
          }

          // CRITICAL: Validate that we have responses for all tool calls
          // Gemini API requires: number of function responses == number of function calls
          const functionResponseCount = toolResponseParts.filter(
            (part) => 'functionResponse' in part,
          ).length;
          if (functionResponseCount !== toolCallRequests.length) {
            const errorMsg = `Tool call/response mismatch: ${toolCallRequests.length} calls but ${functionResponseCount} responses. This will cause API errors.`;
            console.error(`[GeminiChatManager] ${errorMsg}`);
            console.error(
              `[GeminiChatManager] Tool calls:`,
              toolCallRequests.map((r) => r.name),
            );
            console.error(
              `[GeminiChatManager] Response parts:`,
              toolResponseParts.map((p) =>
                'functionResponse' in p ? p.functionResponse?.name : 'other',
              ),
            );
            throw new Error(errorMsg);
          }

          // Continue loop with tool responses as next request
          currentRequest = toolResponseParts;
          console.log(
            `[GeminiChatManager] Continuing conversation with ${toolResponseParts.length} tool response parts (${functionResponseCount} function responses for ${toolCallRequests.length} calls)`,
          );
        } else {
          // No tool calls - conversation complete
          console.log(
            '[GeminiChatManager] No tool calls, conversation complete',
          );

          // Conversation complete
          break;
        }
      }
    } finally {
      // Auto-save session history after streaming completes
      // This ensures tool calls and responses are always paired
      await this.clientPool.save(sessionId);

      // Auto-generate title AFTER saving history
      // This ensures conversationHistory has the latest messages
      this.sessionManager.autoGenerateTitle(sessionId).catch((error) => {
        console.error(
          '[GeminiChatManager] Failed to auto-generate title:',
          error,
        );
      });
    }
  }

  /**
   * Get the GeminiClient instance for the current session
   */
  getClient(): GeminiClient | undefined {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      return undefined;
    }
    return this.clientPool.get(sessionId);
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
   * Convert Content[] (Gemini format) to UniversalMessage[] (SessionManager format)
   */
  private convertGeminiToUniversal(contents: Content[]): UniversalMessage[] {
    const messages: UniversalMessage[] = [];

    console.log(
      `[GeminiChatManager] Converting ${contents.length} Gemini contents to UniversalMessage`,
    );

    for (const content of contents) {
      // Skip system messages (handled separately)
      if (content.role !== 'user' && content.role !== 'model') {
        continue;
      }

      // Map Gemini role to UniversalMessage role
      const role = content.role === 'model' ? 'assistant' : 'user';

      // Extract text content
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
          // // Log if text contains thinking tags
          // if (part.text.includes('<think>')) {
          //   console.log(
          //     `[GeminiChatManager] Found <think> tag in text part (${part.text.substring(0, 100)}...)`,
          //   );
          // }
        }

        // Extract function calls (tool calls from assistant)
        if (
          'functionCall' in part &&
          part.functionCall &&
          part.functionCall.name
        ) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            name: part.functionCall.name,
            arguments:
              (part.functionCall.args as Record<string, unknown>) || {},
          });
        }

        // Extract function responses (tool responses)
        if ('functionResponse' in part && part.functionResponse) {
          toolName = part.functionResponse.name;
          toolCallId = `call_${Date.now()}`;
          const response = part.functionResponse.response;
          if (
            response &&
            typeof response === 'object' &&
            'output' in response
          ) {
            textContent += String(response['output']);
          }
        }
      }

      // Create UniversalMessage
      if (toolCallId && toolName) {
        // This is a tool response
        messages.push({
          role: 'tool',
          content: textContent,
          tool_call_id: toolCallId,
          name: toolName,
          timestamp: new Date(),
        });
      } else {
        // Regular message (user or assistant)
        const message: UniversalMessage = {
          role,
          content: textContent,
          timestamp: new Date(),
        };

        if (toolCalls.length > 0) {
          message.toolCalls = toolCalls;
        }

        // // Log message content summary
        // const hasThinking = textContent.includes('<think>');
        // const contentPreview =
        //   textContent.length > 100
        //     ? textContent.substring(0, 100) + '...'
        //     : textContent;
        // console.log(
        //   `[GeminiChatManager] Created ${role} message (${textContent.length} chars, thinking: ${hasThinking}): ${contentPreview}`,
        // );

        messages.push(message);
      }
    }

    // console.log(
    //   `[GeminiChatManager] Converted to ${messages.length} UniversalMessages`,
    // );
    return messages;
  }

  /**
   * Convert UniversalMessage[] (SessionManager format) to Content[] (Gemini format)
   */
  private convertUniversalToGemini(messages: UniversalMessage[]): Content[] {
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // System messages are handled as systemInstruction, skip from history
        continue;
      }

      // Map UniversalMessage role to Gemini Content role
      let role: 'user' | 'model' = 'user';
      if (msg.role === 'assistant') {
        role = 'model';
      } else if (msg.role === 'tool') {
        role = 'user'; // Tool responses are sent as 'user' role in Gemini
      }
      const parts: Part[] = [];

      // Regular content
      if (msg.content && msg.role !== 'tool') {
        parts.push({ text: msg.content });
      }

      // Tool calls (from assistant)
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          parts.push({
            functionCall: {
              name: toolCall.name,
              args: toolCall.arguments,
            },
          });
        }
      }

      // Tool responses (from tool role)
      if (msg.role === 'tool' && msg.tool_call_id) {
        parts.push({
          functionResponse: {
            name: msg.name || '',
            response: {
              output: msg.content,
            },
          },
        });
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    return contents;
  }

  /**
   * Load session history into GeminiClient
   * Called when switching sessions or initializing
   */
  private async loadSessionIntoClient(sessionId: string): Promise<void> {
    // Get or create client for this session
    const client = await this.clientPool.getOrCreate(sessionId);

    // Get history from SessionManager (UniversalMessage[])
    const universalHistory = this.sessionManager.getDisplayMessages(sessionId);

    // Convert to Gemini format (Content[])
    const geminiHistory = this.convertUniversalToGemini(universalHistory);

    // Load into GeminiClient
    if (geminiHistory.length > 0) {
      // Restart chat with existing history
      await client.startChat(geminiHistory);
      console.log(
        `[GeminiChatManager] Loaded ${geminiHistory.length} messages into GeminiClient for session ${sessionId}`,
      );
    } else {
      // Fresh chat
      await client.resetChat();
      console.log(
        `[GeminiChatManager] Started fresh chat for session ${sessionId}`,
      );
    }
  }

  /**
   * Get SessionManager instance - delegate session operations to it
   * Note: switchSession and deleteSession need special handling for client pool
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Switch session with client pool coordination
   */
  async switchSession(sessionId: string): Promise<void> {
    this.sessionManager.switchSession(sessionId);
    await this.loadSessionIntoClient(sessionId);
    console.log(`[GeminiChatManager] Switched to session: ${sessionId}`);
  }

  /**
   * Delete session with client pool cleanup
   */
  deleteSession(sessionId: string): void {
    this.clientPool.release(sessionId);
    this.sessionManager.deleteSession(sessionId);
  }

  /**
   * Delete all sessions with client pool cleanup
   */
  deleteAllSessions(): void {
    const sessionIds = this.sessionManager.getSessionIds();
    sessionIds.forEach((id) => this.deleteSession(id));
  }

  /**
   * Get RoleManager instance - delegate role operations to it
   * Note: switchRole needs special handling for client tool updates
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
        const client = this.clientPool.get(sessionId);
        if (client) {
          await client.updateToolsForCurrentRole();
        }
      }
      console.log(`[GeminiChatManager] Switched to role: ${roleId}`);
    }
    return success;
  }

  /**
   * Configuration
   */
  getConfig(): Config {
    return this.config;
  }

  setApprovalMode(mode: 'default' | 'autoEdit' | 'yolo'): void {
    // Map to ApprovalMode enum values
    const approvalModeValue =
      mode === 'yolo'
        ? ApprovalMode.YOLO
        : mode === 'autoEdit'
          ? ApprovalMode.AUTO_EDIT
          : ApprovalMode.DEFAULT;

    const previousMode = this.config.getApprovalMode();
    this.config.setApprovalMode(approvalModeValue);
    console.log(`[GeminiChatManager] Set approval mode to: ${mode}`);

    // If we have an active tool scheduler and approval mode changed to more permissive,
    // re-evaluate pending tools that might now be auto-approved
    if (this.activeToolScheduler && approvalModeValue !== previousMode) {
      const signal = new AbortController().signal;
      this.activeToolScheduler
        .reevaluateAllPendingTools(signal)
        .catch((error) => {
          console.error(
            '[GeminiChatManager] Error reevaluating pending tools after approval mode change:',
            error,
          );
        });
    }
  }

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
   * Get WorkspaceManager instance - delegate workspace operations to it
   */
  getWorkspaceManager(): WorkspaceManager {
    return WorkspaceManager.getInstance(this.config);
  }

  /**
   * Get TemplateManager instance - delegate template operations to it
   */
  getTemplateManager(): TemplateManager {
    return TemplateManager.getInstance(this.config);
  }

  /**
   * Cleanup - saves all sessions and releases client pool
   */
  async cleanup(): Promise<void> {
    console.log('[GeminiChatManager] Cleaning up...');

    // Clear the client pool (this will save all sessions)
    await this.clientPool.clear();

    console.log('[GeminiChatManager] Cleanup complete');
  }
}
