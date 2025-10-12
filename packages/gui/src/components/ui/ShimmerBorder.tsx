/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { cn } from '@/utils/cn';

interface ShimmerBorderProps {
  children: React.ReactNode;
  className?: string;
  active?: boolean;
  colors?: string[];
  speed?: 'slow' | 'medium' | 'fast';
}

/**
 * Apple Intelligence-style shimmer border component
 * Displays animated gradient border when active
 */
export const ShimmerBorder: React.FC<ShimmerBorderProps> = ({
  children,
  className,
  active = true,
  colors = [
    '#60A5FA', // blue-400
    '#A78BFA', // violet-400
    '#F472B6', // pink-400
    '#FBBF24', // amber-400
    '#34D399', // emerald-400
    '#60A5FA', // blue-400 (loop back)
  ],
  speed = 'medium',
}) => {
  if (!active) {
    return <>{children}</>;
  }

  const speedMap = {
    slow: '6s',
    medium: '5s',
    fast: '4s',
  };

  const animationDuration = speedMap[speed];

  // Create gradient color string
  const gradient = colors.join(', ');

  return (
    <div className={cn('relative', className)}>
      {/* Shimmer border layer */}
      <div
        className="absolute -inset-[2px] rounded-[inherit] opacity-75 blur-[1px] pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(90deg, ${gradient})`,
          backgroundSize: '300% 100%',
          backgroundPosition: '0% 50%',
          animation: `shimmer ${animationDuration} linear infinite`,
        }}
      />

      {/* Content container - needs background to mask inner border */}
      <div className="relative rounded-[inherit] bg-background">{children}</div>

      <style>{`
        @keyframes shimmer {
          0% {
            background-position: 0% 50%;
          }
          100% {
            background-position: 300% 50%;
          }
        }
      `}</style>
    </div>
  );
};
