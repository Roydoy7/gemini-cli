/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Loader2, Wrench, Package, Brain, AlertCircle } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Card, CardContent } from '@/components/ui/Card';
import { ShimmerBorder } from '@/components/ui/ShimmerBorder';
import type { OperationStatus } from '@/stores/chatStore';

interface StatusIndicatorProps {
  className?: string;
  operation: OperationStatus | null;
  isThinking?: boolean;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  className,
  operation,
  isThinking,
}) => {
  // If no operation and not thinking, don't show anything
  if (!operation && !isThinking) return null;

  // Fallback to thinking status if no operation is set but isThinking is true
  const currentOperation: OperationStatus = operation || {
    type: 'thinking',
    message: 'AI is thinking',
  };

  // Select icon based on operation type
  const getIcon = () => {
    switch (currentOperation.type) {
      case 'tool_executing':
        return <Wrench size={16} className="animate-bounce duration-1000" />;
      case 'tool_awaiting_approval':
        return <AlertCircle size={16} className="animate-ping duration-1000" />;
      case 'compressing':
        return <Package size={16} className="animate-pulse duration-1000" />;
      case 'streaming':
        return <Loader2 size={16} className="animate-spin duration-1000" />;
      case 'thinking':
      default:
        return <Brain size={16} className="animate-pulse duration-1500" />;
    }
  };

  // Get status color based on type
  const getStatusColor = () => {
    switch (currentOperation.type) {
      case 'tool_executing':
        return 'text-blue-500';
      case 'tool_awaiting_approval':
        return 'text-orange-500';
      case 'compressing':
        return 'text-amber-500';
      case 'streaming':
        return 'text-green-500';
      case 'thinking':
      default:
        return 'text-muted-foreground';
    }
  };

  // Get shimmer colors based on operation type
  const getShimmerColors = () => {
    switch (currentOperation.type) {
      case 'tool_executing':
        // Blue/cyan theme for tool execution
        return ['#3B82F6', '#06B6D4', '#8B5CF6', '#3B82F6'];
      case 'streaming':
        // Green/emerald theme for streaming
        return ['#10B981', '#34D399', '#6EE7B7', '#10B981'];
      case 'thinking':
      default:
        // Purple/pink theme for thinking (Apple Intelligence style)
        return [
          '#60A5FA', // blue-400
          '#A78BFA', // violet-400
          '#F472B6', // pink-400
          '#FBBF24', // amber-400
          '#34D399', // emerald-400
          '#60A5FA', // blue-400
        ];
    }
  };

  return (
    <>
      <div className={cn('flex gap-3 max-w-4xl', className)}>
        {/* Avatar */}
        <div className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center bg-secondary">
          <Brain size={20} />
        </div>

        {/* Status card with shimmer border */}
        <div className="flex-1 min-w-0">
          <ShimmerBorder
            active={
              currentOperation.type === 'thinking' ||
              currentOperation.type === 'streaming' ||
              currentOperation.type === 'tool_executing'
            }
            speed="medium"
            colors={getShimmerColors()}
            className="rounded-lg"
          >
            <Card className="border-0">
              <CardContent className="p-3">
                <div className="flex items-center gap-2">
                  <div className={cn('flex-shrink-0', getStatusColor())}>
                    {getIcon()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn('text-sm font-medium', getStatusColor())}
                    >
                      {currentOperation.message}
                    </div>
                    {currentOperation.details && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {currentOperation.details}
                      </div>
                    )}
                    {currentOperation.toolName && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Tool: {currentOperation.toolName}
                      </div>
                    )}
                  </div>

                  {/* Enhanced typing dots for thinking state - heartbeat style */}
                  {currentOperation.type === 'thinking' && (
                    <div className="flex gap-1 flex-shrink-0">
                      <div
                        className="w-2.5 h-2.5 bg-primary rounded-full"
                        style={{
                          animation: 'heartbeat 1.4s ease-in-out infinite',
                          animationDelay: '0s',
                        }}
                      />
                      <div
                        className="w-2.5 h-2.5 bg-primary rounded-full"
                        style={{
                          animation: 'heartbeat 1.4s ease-in-out infinite',
                          animationDelay: '0.2s',
                        }}
                      />
                      <div
                        className="w-2.5 h-2.5 bg-primary rounded-full"
                        style={{
                          animation: 'heartbeat 1.4s ease-in-out infinite',
                          animationDelay: '0.4s',
                        }}
                      />
                    </div>
                  )}

                  {/* Pulsing indicator for tool awaiting approval */}
                  {currentOperation.type === 'tool_awaiting_approval' && (
                    <div className="flex gap-1 flex-shrink-0">
                      <div className="w-3 h-3 bg-orange-500/70 rounded-full animate-ping [animation-duration:1s]" />
                      <div className="w-3 h-3 bg-orange-500/70 rounded-full animate-ping [animation-delay:-0.5s] [animation-duration:1s]" />
                    </div>
                  )}

                  {/* Progress bar for operations with progress */}
                  {currentOperation.progress !== undefined && (
                    <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden flex-shrink-0">
                      <div
                        className="h-full bg-primary transition-all duration-300"
                        style={{ width: `${currentOperation.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </ShimmerBorder>
        </div>
      </div>
      <style>{`
      @keyframes heartbeat {
        0% {
          transform: scale(1);
          opacity: 1;
        }
        14% {
          transform: scale(1.3);
          opacity: 1;
        }
        28% {
          transform: scale(1);
          opacity: 0.8;
        }
        42% {
          transform: scale(1.3);
          opacity: 1;
        }
        70% {
          transform: scale(1);
          opacity: 0.8;
        }
        100% {
          transform: scale(1);
          opacity: 1;
        }
      }
    `}</style>
    </>
  );
};
