/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useImperativeHandle, forwardRef } from 'react';
import { X } from 'lucide-react';
import { DirectoryPanel } from '../workspace/DirectoryPanel';
import { TemplatePanel } from '../templates/TemplatePanel';
import { Button } from '@/components/ui/Button';
import type { PresetTemplate } from '@/types';

interface RightSidebarProps {
  onTemplateUse?: (template: PresetTemplate) => void;
  onClose?: () => void;
}

interface RightSidebarHandle {
  refreshTemplates: () => void;
}

export const RightSidebar = forwardRef<RightSidebarHandle, RightSidebarProps>(({ onTemplateUse, onClose }, ref) => {
  const templatePanelRef = React.useRef<{ refreshTemplates: () => void }>(null);

  useImperativeHandle(ref, () => ({
    refreshTemplates: () => {
      templatePanelRef.current?.refreshTemplates();
    }
  }));
  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-card border-l border-border flex flex-col z-40">
      {/* Top bar with close button */}
      {onClose && (
        <div className="flex-shrink-0 h-10 border-b border-border flex items-center justify-end px-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-muted"
            onClick={onClose}
            title="Hide sidebar"
          >
            <X size={14} />
          </Button>
        </div>
      )}

      {/* Directory Panel - 上半部分 */}
      <div className="flex-1 min-h-0">
        <DirectoryPanel />
      </div>

      {/* Template Panel - 下半部分 */}
      <div className="flex-1 min-h-0 border-t border-border">
        <TemplatePanel ref={templatePanelRef} onTemplateUse={onTemplateUse} />
      </div>
    </div>
  );
});