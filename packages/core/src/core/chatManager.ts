/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { Content, Part } from '@google/genai';
import { GeminiClient } from './client.js';
import { SessionManager } from '../sessions/SessionManager.js';
import { RoleManager } from '../roles/RoleManager.js';
import { WorkspaceManager } from '../utils/WorkspaceManager.js';
import type { UniversalMessage } from '../providers/types.js';
import type { RoleDefinition } from '../roles/types.js';
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
  private client: GeminiClient;
  private sessionManager: SessionManager;
  private roleManager: RoleManager;
  private config: Config;
  private toolConfirmationHandler?: (
    details: ToolCallConfirmationDetails,
  ) => Promise<ToolConfirmationOutcome>;
  private activeToolScheduler?: CoreToolScheduler;

  constructor(config: Config) {
    this.config = config;
    this.client = new GeminiClient(config);
    this.sessionManager = SessionManager.getInstance();
    this.roleManager = RoleManager.getInstance();
  }

  /**
   * Initialize the chat manager
   * @param initialRoleId - Optional role ID to set during initialization
   */
  async initialize(initialRoleId?: string): Promise<void> {
    await this.client.initialize();

    // Always switch to the specified role (defaults to software_engineer if not provided)
    // This ensures the role is set correctly and tools are configured
    const roleId = initialRoleId || 'software_engineer';
    await this.switchRole(roleId);

    console.log('[GeminiChatManager] Initialized with role:', roleId);
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
    let currentRequest = request;
    let isFirstIteration = true;

    // Save initial user message to SessionManager (only on first iteration)
    if (isFirstIteration && request.length > 0) {
      const userContent = request
        .map((part) => {
          if ('text' in part) {
            return part.text;
          }
          return '';
        })
        .join('\n')
        .trim();

      if (userContent) {
        const userMessage: UniversalMessage = {
          role: 'user',
          content: userContent,
          timestamp: new Date(),
        };
        this.sessionManager.addHistory(userMessage);
        console.log(
          `[GeminiChatManager] Saved user message (${userContent.length} chars)`,
        );

        // Auto-update title if this is the first user message in the session
        this.sessionManager.handleAutoTitleGeneration(userMessage);
      }
    }

    // Agentic loop - continue until no tool calls are made
    // Note: Each iteration's assistant response is saved independently
    while (true) {
      const toolCallRequests: ToolCallRequestInfo[] = [];
      let assistantContent = '';
      const assistantToolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }> = [];

      // Send message to GeminiClient and collect tool calls + content
      const responseStream = this.client.sendMessageStream(
        currentRequest,
        signal,
        prompt_id,
      );

      for await (const event of responseStream) {
        if (signal.aborted) {
          return;
        }

        // Collect assistant content for SessionManager
        if (event.type === GeminiEventType.Content) {
          assistantContent += event.value;
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

                      collectedEvents.push({
                        type: GeminiEventType.ToolCallResponse,
                        value: {
                          callId: toolCall.request.callId,
                          responseParts: toolCall.response.responseParts || [],
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

                      collectedEvents.push({
                        type: GeminiEventType.ToolCallResponse,
                        value: {
                          callId: toolCall.request.callId,
                          responseParts: toolCall.response.responseParts || [],
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
                responseParts: toolResponse.responseParts || [],
                resultDisplay: toolResponse.resultDisplay,
                error: toolResponse.error,
                errorType: toolResponse.errorType,
              },
            };
          }
        }

        // Save this iteration's assistant message with tool calls and responses
        // Each iteration saves its own assistant response independently
        this.saveAssistantWithToolCalls(
          assistantContent,
          assistantToolCalls,
          executedToolResponses,
        );

        // Mark that we've completed the first iteration
        isFirstIteration = false;

        // Check if we have tool responses to continue with
        if (toolResponseParts.length === 0) {
          console.log(
            `[GeminiChatManager] No tool response parts to continue with, ending conversation`,
          );
          break;
        }

        // Continue loop with tool responses as next request
        currentRequest = toolResponseParts;
        console.log(
          `[GeminiChatManager] Continuing conversation with ${toolResponseParts.length} tool response parts`,
        );
      } else {
        // No tool calls - save assistant response and exit
        if (assistantContent.trim()) {
          const assistantMessage: UniversalMessage = {
            role: 'assistant',
            content: assistantContent,
            timestamp: new Date(),
          };
          this.sessionManager.addHistory(assistantMessage);
          console.log(
            `[GeminiChatManager] Saved assistant response without tool calls (${assistantContent.length} chars)`,
          );

          // Trigger intelligent title generation if appropriate
          const currentSessionId = this.sessionManager.getCurrentSessionId();
          if (currentSessionId) {
            this.sessionManager
              .triggerIntelligentTitleGeneration(currentSessionId, {
                type: 'gemini',
                model: 'gemini-2.5-flash',
              })
              .catch((error) => {
                console.error(
                  '[GeminiChatManager] Failed to generate intelligent title:',
                  error,
                );
              });
          }
        }

        // Conversation complete
        break;
      }
    }
  }

  /**
   * Save assistant message with tool calls and tool responses to SessionManager
   * Mirrors MultiModelSystem.saveAssistantWithToolCalls()
   */
  private saveAssistantWithToolCalls(
    assistantContent: string,
    assistantToolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }>,
    executedToolResponses: UniversalMessage[],
  ): void {
    // Save assistant message with tool calls
    const assistantMessage: UniversalMessage = {
      role: 'assistant',
      content: assistantContent,
      timestamp: new Date(),
      toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
    };

    this.sessionManager.addHistory(assistantMessage);

    // Save all tool responses
    executedToolResponses.forEach((response) => {
      this.sessionManager.addHistory(response);
    });

    console.log(
      `[GeminiChatManager] Saved assistant message with ${assistantToolCalls.length} tool calls and ${executedToolResponses.length} responses`,
    );

    // Trigger intelligent title generation if appropriate
    const currentSessionId = this.sessionManager.getCurrentSessionId();
    if (currentSessionId && assistantContent.trim()) {
      this.sessionManager
        .triggerIntelligentTitleGeneration(currentSessionId, {
          type: 'gemini',
          model: 'gemini-2.5-flash',
        })
        .catch((error) => {
          console.error(
            '[GeminiChatManager] Failed to generate intelligent title:',
            error,
          );
        });
    }
  }

  /**
   * Get the GeminiClient instance for direct access if needed
   */
  getClient(): GeminiClient {
    return this.client;
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
   * Called when switching sessions
   */
  private async loadSessionIntoClient(sessionId: string): Promise<void> {
    // Get history from SessionManager (UniversalMessage[])
    const universalHistory = this.sessionManager.getDisplayMessages(sessionId);

    // Convert to Gemini format (Content[])
    const geminiHistory = this.convertUniversalToGemini(universalHistory);

    // Load into GeminiClient
    if (geminiHistory.length > 0) {
      // Restart chat with existing history
      await this.client.startChat(geminiHistory);
      console.log(
        `[GeminiChatManager] Loaded ${geminiHistory.length} messages into GeminiClient for session ${sessionId}`,
      );
    } else {
      // Fresh chat
      await this.client.resetChat();
      console.log(
        `[GeminiChatManager] Started fresh chat for session ${sessionId}`,
      );
    }
  }

  /**
   * Session Management
   */
  createSession(sessionId: string, title?: string, roleId?: string): void {
    this.sessionManager.createSession(sessionId, title || 'New Chat', roleId);
  }

  async switchSession(sessionId: string): Promise<void> {
    this.sessionManager.switchSession(sessionId);

    // Load session history into GeminiClient
    await this.loadSessionIntoClient(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sessionManager.deleteSession(sessionId);
  }

  deleteAllSessions(): void {
    const sessionIds = this.sessionManager.getSessionIds();
    sessionIds.forEach((id) => this.deleteSession(id));
  }

  getCurrentSessionId(): string | null {
    return this.sessionManager.getCurrentSessionId();
  }

  getSessionsInfo() {
    return this.sessionManager.getSessionsInfo();
  }

  getDisplayMessages(sessionId?: string): UniversalMessage[] {
    return this.sessionManager.getDisplayMessages(sessionId);
  }

  updateSessionTitle(sessionId: string, newTitle: string): void {
    this.sessionManager.updateSessionTitle(sessionId, newTitle);
  }

  setSessionRole(sessionId: string, roleId: string): void {
    this.sessionManager.setSessionRole(sessionId, roleId);
  }

  /**
   * Role Management
   */
  async switchRole(roleId: string): Promise<boolean> {
    const success = await this.roleManager.setCurrentRole(roleId);
    if (success) {
      // Update tools when role changes - filter based on role
      await this.setToolsForCurrentRole();
      console.log(`[GeminiChatManager] Switched to role: ${roleId}`);
    }
    return success;
  }

  /**
   * Set tools for the current role using ToolsetManager
   */
  private async setToolsForCurrentRole(): Promise<void> {
    // Check if role system is enabled
    if (!this.roleManager.isRoleSystemEnabled()) {
      // Role system disabled, use default client.setTools()
      await this.client.setTools();
      console.log('[GeminiChatManager] Role system disabled, using all tools');
      return;
    }

    const currentRole = this.roleManager.getCurrentRole();

    // Special handling for software_engineer: use original gemini-cli behavior
    if (currentRole.id === 'software_engineer') {
      // Use all registered tools from ToolRegistry (original gemini-cli behavior)
      await this.client.setTools();
      console.log(
        '[GeminiChatManager] Software engineer role - using all registered tools (original gemini-cli behavior)',
      );
      return;
    }

    // For other roles, use tools from ToolsetManager
    // Note: We use ToolsetManager directly instead of ToolRegistry.
    // ToolRegistry is for the original gemini-cli, while ToolsetManager manages role-specific toolsets.
    const { ToolsetManager } = await import('../tools/ToolsetManager.js');
    const toolsetManager = new ToolsetManager();
    const roleToolClasses = toolsetManager.getToolsForRole(currentRole.id);

    // Create tool instances and get their schemas (FunctionDeclaration)
    const toolDeclarations = roleToolClasses.map((ToolClass) => {
      const toolInstance = new ToolClass(this.config);
      return toolInstance.schema;
    });

    // Set tools on GeminiChat
    const tools = [{ functionDeclarations: toolDeclarations }];
    const chat = this.client['chat'];
    if (chat && typeof chat.setTools === 'function') {
      chat.setTools(tools);
    }

    console.log(
      `[GeminiChatManager] Loaded ${toolDeclarations.length} tools for role: ${currentRole.id}`,
    );
  }

  getCurrentRole() {
    return this.roleManager.getCurrentRole();
  }

  getAllRoles() {
    return this.roleManager.getAllRoles();
  }

  async addCustomRole(role: RoleDefinition): Promise<void> {
    await this.roleManager.addCustomRole(role);
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
   * Utility: Get workspace directories
   */
  getWorkspaceDirectories(): readonly string[] {
    const workspaceManager = WorkspaceManager.getInstance(this.config);
    return workspaceManager.getDirectories();
  }

  async addWorkspaceDirectory(
    directory: string,
    basePath?: string,
  ): Promise<void> {
    const workspaceManager = WorkspaceManager.getInstance(this.config);
    await workspaceManager.addWorkspaceDirectory(directory, basePath);
  }

  async setWorkspaceDirectories(directories: readonly string[]): Promise<void> {
    const workspaceManager = WorkspaceManager.getInstance(this.config);
    await workspaceManager.setDirectories(directories);
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    console.log('[GeminiChatManager] Cleaning up...');
    // No specific cleanup needed for GeminiClient currently
  }
}
