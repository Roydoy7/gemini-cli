/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Highlight, themes } from 'prism-react-renderer';
import { useEffect, useState } from 'react';
import { cn } from '@/utils/cn';

interface CodeHighlightProps {
  code: string;
  language?: string;
  className?: string;
  maxHeight?: string;
  showCopyButton?: boolean;
}

export const CodeHighlight: React.FC<CodeHighlightProps> = ({
  code,
  language = 'python',
  className = '',
  maxHeight,
  showCopyButton = true,
}) => {
  const [isDark, setIsDark] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Check if dark mode is enabled
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };

    checkDarkMode();

    // Watch for theme changes
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy code:', error);
    }
  };

  return (
    <div className="relative group">
      {showCopyButton && (
        <button
          onClick={handleCopy}
          className={cn(
            'absolute top-2 right-2 px-2 py-1 rounded transition-all text-xs font-medium',
            'bg-background/80 hover:bg-background border border-border/50',
            'opacity-0 group-hover:opacity-100',
            'focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary/50',
            copied
              ? 'text-green-600 dark:text-green-400'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {copied ? 'Copied!' : 'Copy code'}
        </button>
      )}
      <Highlight
        theme={isDark ? themes.vsDark : themes.vsLight}
        code={code}
        language={language}
      >
        {({ style, tokens, getLineProps, getTokenProps }) => (
          <pre
            style={{
              ...style,
              backgroundColor: isDark ? style.backgroundColor : 'transparent',
              maxHeight: maxHeight || 'none',
              overflowY: maxHeight ? 'auto' : 'visible',
            }}
            className={`text-xs font-mono rounded px-3 py-2 overflow-x-auto ${className}`}
          >
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
};
