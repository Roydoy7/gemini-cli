/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Universal message format for conversation history
 */
export interface UniversalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: MessageToolCall[];
  tool_call_id?: string;
  name?: string;
  timestamp?: Date;
}

/**
 * Tool call information stored in message history
 */
export interface MessageToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Visualization data for charts and graphs
 */
export interface VisualizationData {
  type:
    | 'quotes'
    | 'ohlc_bars'
    | 'technical_indicators'
    | 'screener_results'
    | 'signals';
  title: string;
  data: Array<Record<string, string | number | boolean>>;
  metadata?: {
    symbols?: string[];
    timeframe?: string;
    indicators?: string[];
    source?: string;
    [key: string]: string | number | boolean | string[] | undefined;
  };
}

/**
 * Structured tool response data
 */
export interface ToolResponseData {
  operation: string;
  summary: string;
  details?: Record<string, unknown>;
  metrics?: {
    rowsAffected?: number;
    columnsAffected?: number;
    cellsAffected?: number;
    duration?: number;
  };
  files?: {
    input?: string[];
    output?: string[];
    created?: string[];
    workbook?: string;
    worksheet?: string;
  };
  nextActions?: string[];
  visualizations?: VisualizationData[];
}

/**
 * Compression information for conversation history
 */
export interface CompressionInfo {
  originalTokenCount: number;
  newTokenCount: number;
  compressionRatio: number;
}

/**
 * Tool execution stage enumeration
 */
export enum ToolExecutionStage {
  VALIDATING = 'validating', // Validating parameters
  CONFIRMING = 'confirming', // Awaiting user confirmation
  PREPARING = 'preparing', // Preparing execution environment
  INSTALLING_DEPS = 'installing_deps', // Installing dependencies (Python)
  EXECUTING = 'executing', // Executing
  PROCESSING = 'processing', // Processing results
  COMPLETED = 'completed', // Completed
  FAILED = 'failed', // Failed
  CANCELLED = 'cancelled', // Cancelled
}

/**
 * Tool execution progress event
 * Used to report real-time progress during tool execution
 */
export interface ToolProgressEvent {
  /** Tool call ID */
  callId: string;
  /** Tool name */
  toolName: string;
  /** Current execution stage */
  stage: ToolExecutionStage;
  /** Progress percentage (0-100), optional */
  progress?: number;
  /** Status message describing current operation */
  message?: string;
  /** Additional structured details */
  details?: Record<string, unknown>;
  /** Timestamp when the event occurred */
  timestamp: number;
}
