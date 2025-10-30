/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from './tools.js';
import type { ToolResult, ToolCallConfirmationDetails } from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { WAIT_TOOL_NAME } from './tool-names.js';

export interface WaitToolParams {
  seconds: number;
  reason?: string;
}

export class WaitToolInvocation extends BaseToolInvocation<
  WaitToolParams,
  ToolResult
> {
  constructor(
    params: WaitToolParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const seconds = this.params.seconds;
    const reason = this.params.reason ? ` (${this.params.reason})` : '';
    return `Wait ${seconds} second${seconds !== 1 ? 's' : ''}${reason}`;
  }

  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // Wait is a harmless operation that doesn't need confirmation
    return false;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { seconds, reason } = this.params;
    const milliseconds = seconds * 1000;

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      // Handle abort signal
      const abortHandler = () => {
        const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
        reject(new Error(`Wait cancelled after ${elapsedSeconds} seconds`));
      };

      if (signal.aborted) {
        abortHandler();
        return;
      }

      signal.addEventListener('abort', abortHandler);

      // Set up the wait timer
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abortHandler);

        const reasonText = reason ? ` Reason: ${reason}` : '';
        resolve({
          llmContent: `Waited for ${seconds} second${seconds !== 1 ? 's' : ''}.${reasonText}`,
          returnDisplay: `✓ Waited ${seconds}s${reason ? `: ${reason}` : ''}`,
        });
      }, milliseconds);

      // Clean up timer if aborted
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    });
  }
}

export class WaitTool extends BaseDeclarativeTool<
  WaitToolParams,
  ToolResult
> {
  static readonly Name = WAIT_TOOL_NAME;

  constructor(messageBus?: MessageBus) {
    super(
      WaitTool.Name,
      'Wait',
      `Pause execution for a specified number of seconds. Use this when you need to:
- Wait for API rate limits to reset
- Allow time for asynchronous operations to complete
- Give time for external processes to finish
- Implement delays between operations
- Wait for services to start up

This is more user-friendly than using shell 'sleep' commands and works consistently across all platforms.`,
      Kind.Execute,
      {
        type: 'object',
        required: ['seconds'],
        properties: {
          seconds: {
            type: 'number',
            description: 'Number of seconds to wait (must be positive, max 300 seconds / 5 minutes)',
            minimum: 0.1,
            maximum: 300,
          },
          reason: {
            type: 'string',
            description:
              'Optional: Brief explanation of why waiting is needed (e.g., "Waiting for API rate limit to reset", "Allowing download to complete")',
          },
        },
      },
      false, // output is not markdown
      false, // output cannot be updated
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: WaitToolParams,
  ): string | null {
    if (params.seconds <= 0) {
      return 'Wait duration must be positive';
    }
    if (params.seconds > 300) {
      return 'Wait duration cannot exceed 300 seconds (5 minutes)';
    }
    return null;
  }

  protected createInvocation(
    params: WaitToolParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): WaitToolInvocation {
    return new WaitToolInvocation(params, messageBus, _toolName, _toolDisplayName);
  }
}
