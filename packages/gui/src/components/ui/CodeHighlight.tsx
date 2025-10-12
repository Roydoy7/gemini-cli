/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Highlight, themes } from 'prism-react-renderer';
import { useEffect, useState } from 'react';

interface CodeHighlightProps {
  code: string;
  language?: string;
  className?: string;
  maxHeight?: string;
}

export const CodeHighlight: React.FC<CodeHighlightProps> = ({
  code,
  language = 'python',
  className = '',
  maxHeight,
}) => {
  const [isDark, setIsDark] = useState(false);

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

  return (
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
  );
};
