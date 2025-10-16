/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Hammer,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/utils/cn';
import { ShimmerBorder } from '@/components/ui/ShimmerBorder';
import { CodeHighlight } from '@/components/ui/CodeHighlight';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SmartVisualization } from '@/components/charts/SmartVisualization';
import type { ToolCall, ToolResponseData } from '@/types';

interface ToolExecutionPair {
  toolCall: ToolCall;
  toolResponse?: {
    content: string;
    success?: boolean;
    toolResponseData?: ToolResponseData;
    timestamp?: Date;
  };
}

interface ToolExecutionGroupProps {
  executions: ToolExecutionPair[];
  timestamp?: Date;
}

/**
 * CopyableCodeBlock - A code block with a copy button
 */
const CopyableCodeBlock: React.FC<{
  content: string;
  className?: string;
}> = ({ content, className = '' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  return (
    <div className="relative group">
      <button
        onClick={handleCopy}
        className={cn(
          'absolute top-1 right-1 px-2 py-0.5 rounded transition-all text-xs font-medium',
          'bg-background/80 hover:bg-background border border-border/50',
          'opacity-0 group-hover:opacity-100',
          'focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-primary/50',
          copied
            ? 'text-green-600 dark:text-green-400'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre className={className}>{content}</pre>
    </div>
  );
};

/**
 * Displays a group of tool executions (call + response pairs) in a compact, collapsible format.
 * Optimized to reduce vertical space while maintaining readability.
 */
export const ToolExecutionGroup: React.FC<ToolExecutionGroupProps> = ({
  executions,
  timestamp,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set()); // All items collapsed by default
  const headerRef = useRef<HTMLDivElement>(null);

  if (executions.length === 0) return null;

  const toggleGroupExpanded = () => {
    if (headerRef.current) {
      const scrollContainer =
        headerRef.current.closest('[data-scroll-container]') ||
        headerRef.current.closest('.overflow-y-auto') ||
        document.querySelector('[class*="overflow-y-auto"]');

      if (scrollContainer) {
        // Save the absolute scroll position of the element's top
        const rect = headerRef.current.getBoundingClientRect();
        const scrollTop = scrollContainer.scrollTop;
        const elementTopInDocument =
          scrollTop + rect.top - scrollContainer.getBoundingClientRect().top;

        // Toggle state
        setIsExpanded(!isExpanded);

        // After DOM update, scroll to keep the element's top at the same position
        requestAnimationFrame(() => {
          if (headerRef.current) {
            const newRect = headerRef.current.getBoundingClientRect();
            const newElementTopInDocument =
              scrollContainer.scrollTop +
              newRect.top -
              scrollContainer.getBoundingClientRect().top;

            // Adjust scroll to maintain element's top position
            scrollContainer.scrollTop +=
              newElementTopInDocument - elementTopInDocument;
          }
        });
      } else {
        setIsExpanded(!isExpanded);
      }
    } else {
      setIsExpanded(!isExpanded);
    }
  };

  const toggleItemExpanded = (index: number) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const allCompleted = executions.every(
    (exec) => exec.toolResponse !== undefined,
  );
  const hasFailures = executions.some(
    (exec) => exec.toolResponse?.success === false,
  );

  // Single execution - show in expanded format by default
  if (executions.length === 1) {
    const execution = executions[0];
    return (
      <ToolExecutionCard
        execution={execution}
        isExpanded={expandedItems.has(0)}
        onToggle={() => toggleItemExpanded(0)}
        timestamp={timestamp || execution.toolResponse?.timestamp}
      />
    );
  }

  // Multiple executions - show grouped with summary
  return (
    <div className="space-y-2">
      {/* Group header with summary */}
      <div
        ref={headerRef}
        className="bg-muted/30 rounded-lg border border-border/50 overflow-hidden"
      >
        <button
          onClick={toggleGroupExpanded}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              {isExpanded ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
              <Hammer size={16} className="text-primary" />
            </div>
            <span className="text-sm font-medium">
              {executions.length} Tool Execution
              {executions.length > 1 ? 's' : ''}
            </span>
            {allCompleted && (
              <span
                className={cn(
                  'text-xs font-medium flex items-center gap-1',
                  hasFailures
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-green-600 dark:text-green-400',
                )}
              >
                {hasFailures ? (
                  <>
                    <XCircle size={12} />
                    Some failed
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={12} />
                    All completed
                  </>
                )}
              </span>
            )}
            {!allCompleted && (
              <span className="text-xs font-medium flex items-center gap-1 text-blue-600 dark:text-blue-400">
                <Clock size={12} />
                In progress
              </span>
            )}
          </div>
          {timestamp && (
            <time
              dateTime={timestamp.toISOString()}
              className="text-xs text-muted-foreground"
              title={format(timestamp, 'yyyy-MM-dd HH:mm:ss')}
            >
              {format(timestamp, 'HH:mm')}
            </time>
          )}
        </button>

        {/* Expanded group content */}
        {isExpanded && (
          <div className="border-t border-border/30 bg-background/50 p-3 space-y-2">
            {executions.map((execution, index) => (
              <ToolExecutionCard
                key={index}
                execution={execution}
                isExpanded={expandedItems.has(index)}
                onToggle={() => toggleItemExpanded(index)}
                isNested
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

interface ToolExecutionCardProps {
  execution: ToolExecutionPair;
  isExpanded: boolean;
  onToggle: () => void;
  timestamp?: Date;
  isNested?: boolean;
}

const ToolExecutionCard: React.FC<ToolExecutionCardProps> = ({
  execution,
  isExpanded,
  onToggle,
  timestamp,
  isNested = false,
}) => {
  const { toolCall, toolResponse } = execution;
  const cardRef = useRef<HTMLDivElement>(null);

  const handleToggle = () => {
    if (cardRef.current) {
      const scrollContainer =
        cardRef.current.closest('[data-scroll-container]') ||
        cardRef.current.closest('.overflow-y-auto') ||
        document.querySelector('[class*="overflow-y-auto"]');

      if (scrollContainer) {
        // Save the absolute scroll position of the element's top
        const rect = cardRef.current.getBoundingClientRect();
        const scrollTop = scrollContainer.scrollTop;
        const elementTopInDocument =
          scrollTop + rect.top - scrollContainer.getBoundingClientRect().top;

        // Toggle state
        onToggle();

        // After DOM update, scroll to keep the element's top at the same position
        requestAnimationFrame(() => {
          if (cardRef.current) {
            const newRect = cardRef.current.getBoundingClientRect();
            const newElementTopInDocument =
              scrollContainer.scrollTop +
              newRect.top -
              scrollContainer.getBoundingClientRect().top;

            // Adjust scroll to maintain element's top position
            scrollContainer.scrollTop +=
              newElementTopInDocument - elementTopInDocument;
          }
        });
      } else {
        onToggle();
      }
    } else {
      onToggle();
    }
  };

  const getStatusIcon = () => {
    if (!toolResponse) {
      return <Clock size={14} className="text-blue-600 dark:text-blue-400" />;
    }
    if (toolResponse.success === false) {
      return <XCircle size={14} className="text-red-600 dark:text-red-400" />;
    }
    return (
      <CheckCircle2 size={14} className="text-green-600 dark:text-green-400" />
    );
  };

  const getStatusText = () => {
    if (!toolResponse) return 'Executing...';
    if (toolResponse.success === false) return 'Failed';
    return 'Success';
  };

  const operation =
    (toolCall.arguments as Record<string, unknown>)?.op ||
    (toolCall.arguments as Record<string, unknown>)?.operation;

  const getKeyParameters = () => {
    const args = toolCall.arguments || {};
    const entries = Object.entries(args);
    const priorityKeys = [
      'op',
      'operation',
      'range',
      'workbook',
      'worksheet',
      'data',
    ];
    return entries.sort(([a], [b]) => {
      const aIndex = priorityKeys.indexOf(a);
      const bIndex = priorityKeys.indexOf(b);
      if (aIndex === -1 && bIndex === -1) return 0;
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });
  };

  const keyParams = getKeyParameters();
  const hasParams = keyParams.length > 0;

  // Determine if shimmer should be active (tool is executing)
  const isExecuting = !toolResponse;

  // Shimmer colors for tool execution (blue/cyan theme)
  const shimmerColors = [
    '#60A5FA', // blue-400
    '#A78BFA', // violet-400
    '#F472B6', // pink-400
    '#FBBF24', // amber-400
    '#34D399', // emerald-400
    '#60A5FA', // blue-400
  ];

  return (
    <ShimmerBorder
      active={isExecuting}
      speed="medium"
      colors={shimmerColors}
      className="rounded-lg"
    >
      <div
        ref={cardRef}
        className={cn(
          'rounded-lg overflow-hidden transition-all',
          'border-0',
          !isExecuting && 'border',
          isNested ? 'border-border/30' : 'border-border/50',
          toolResponse?.success === false
            ? 'border-red-300 dark:border-red-800/50 bg-red-50/30 dark:bg-red-950/10'
            : toolResponse
              ? 'border-green-300 dark:border-green-800/50'
              : 'border-blue-300 dark:border-blue-800/50',
        )}
      >
        {/* Tool execution header */}
        <button
          onClick={handleToggle}
          className="w-full px-3 py-2.5 flex items-center justify-between bg-green-50 hover:bg-green-100 dark:bg-background/30 dark:hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
            {getStatusIcon()}
            <span className="font-medium text-sm truncate">
              {toolCall.name}
            </span>
            {operation != null && (
              <span className="font-mono text-xs text-muted-foreground truncate">
                {typeof operation === 'string'
                  ? operation
                  : JSON.stringify(operation)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs font-medium">{getStatusText()}</span>
            {timestamp && !isNested && (
              <time
                dateTime={timestamp.toISOString()}
                className="text-xs text-muted-foreground"
                title={format(timestamp, 'yyyy-MM-dd HH:mm:ss')}
              >
                {format(timestamp, 'HH:mm')}
              </time>
            )}
          </div>
        </button>

        {/* Expanded content */}
        {isExpanded && (
          <div className="border-t border-border/30 bg-green-50 dark:bg-background/30">
            {/* Tool call parameters */}
            {hasParams && (
              <div className="px-3 py-2 space-y-2">
                <div className="text-xs font-medium text-muted-foreground">
                  Parameters:
                </div>
                <div className="space-y-1.5">
                  {keyParams.map(([key, value]) => (
                    <div key={key} className="flex items-start gap-2">
                      <div className="text-xs font-medium text-blue-600 dark:text-blue-400 w-24 flex-shrink-0 pt-1">
                        {key}:
                      </div>
                      <div className="flex-1 min-w-0">
                        {typeof value === 'object' && value !== null ? (
                          <CopyableCodeBlock
                            content={JSON.stringify(value, null, 2)}
                            className="text-xs bg-green-100/50 dark:bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap font-mono overflow-x-auto border border-green-200 dark:border-border/50"
                          />
                        ) : key === 'code' ||
                          key === 'script' ||
                          key === 'query' ? (
                          <div className="bg-green-100/50 dark:bg-muted/50 rounded border border-green-200 dark:border-border/50">
                            <CodeHighlight
                              code={String(value)}
                              language="python"
                            />
                          </div>
                        ) : (
                          <CopyableCodeBlock
                            content={String(value)}
                            className="text-xs text-foreground/90 font-mono bg-green-100/50 dark:bg-muted/30 rounded px-2 py-1 whitespace-pre-wrap overflow-x-auto border border-green-200 dark:border-border/50"
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tool response */}
            {toolResponse && (
              <div className="border-t border-border/30 px-3 py-2 space-y-2">
                <div className="text-xs font-medium text-muted-foreground">
                  Result:
                </div>

                {/* Structured response data */}
                {toolResponse.toolResponseData ? (
                  <div className="space-y-2">
                    {/* Summary */}
                    {toolResponse.toolResponseData.summary && (
                      <div className="text-sm font-medium text-foreground">
                        {toolResponse.toolResponseData.summary}
                      </div>
                    )}

                    {/* Metrics */}
                    {toolResponse.toolResponseData.metrics &&
                      Object.keys(toolResponse.toolResponseData.metrics)
                        .length > 0 && (
                        <div className="flex flex-wrap gap-2 text-xs">
                          {toolResponse.toolResponseData.metrics
                            .rowsAffected && (
                            <span className="px-2 py-1 bg-muted/50 rounded">
                              Rows:{' '}
                              {
                                toolResponse.toolResponseData.metrics
                                  .rowsAffected
                              }
                            </span>
                          )}
                          {toolResponse.toolResponseData.metrics
                            .columnsAffected && (
                            <span className="px-2 py-1 bg-muted/50 rounded">
                              Columns:{' '}
                              {
                                toolResponse.toolResponseData.metrics
                                  .columnsAffected
                              }
                            </span>
                          )}
                          {toolResponse.toolResponseData.metrics
                            .cellsAffected && (
                            <span className="px-2 py-1 bg-muted/50 rounded">
                              Cells:{' '}
                              {
                                toolResponse.toolResponseData.metrics
                                  .cellsAffected
                              }
                            </span>
                          )}
                        </div>
                      )}

                    {/* Files */}
                    {toolResponse.toolResponseData.files && (
                      <div className="space-y-1 text-xs">
                        {toolResponse.toolResponseData.files.workbook && (
                          <div className="flex items-center gap-1">
                            <span className="font-medium text-muted-foreground">
                              File:
                            </span>
                            <span className="font-mono truncate">
                              {toolResponse.toolResponseData.files.workbook}
                            </span>
                          </div>
                        )}
                        {toolResponse.toolResponseData.files.worksheet && (
                          <div className="flex items-center gap-1">
                            <span className="font-medium text-muted-foreground">
                              Sheet:
                            </span>
                            <span className="font-mono">
                              {toolResponse.toolResponseData.files.worksheet}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Next actions */}
                    {toolResponse.toolResponseData.nextActions &&
                      toolResponse.toolResponseData.nextActions.length > 0 && (
                        <div className="pt-2 border-t border-border/20">
                          <div className="text-xs font-medium text-muted-foreground mb-1">
                            Suggested next actions:
                          </div>
                          <div className="space-y-1">
                            {toolResponse.toolResponseData.nextActions.map(
                              (action: string, index: number) => (
                                <div
                                  key={index}
                                  className="text-xs bg-muted/30 rounded px-2 py-1 font-mono"
                                >
                                  {action}
                                </div>
                              ),
                            )}
                          </div>
                        </div>
                      )}

                    {/* Visualizations */}
                    {toolResponse.toolResponseData.visualizations &&
                      toolResponse.toolResponseData.visualizations.length >
                        0 && (
                        <div className="pt-2 border-t border-border/20">
                          <SmartVisualization
                            visualizations={
                              toolResponse.toolResponseData.visualizations
                            }
                          />
                        </div>
                      )}
                  </div>
                ) : (
                  /* Unstructured response */
                  <div className="text-sm">
                    <MarkdownRenderer
                      content={toolResponse.content}
                      className=""
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </ShimmerBorder>
  );
};
