/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useImperativeHandle, forwardRef } from 'react';
import { BookTemplate, Plus, Edit3, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { geminiChatService } from '@/services/geminiChatService';
import { useAppStore } from '@/stores/appStore';
import { TemplateEditorDialog } from './TemplateEditorDialog';
import type { PresetTemplate } from '@/types';

interface TemplatePanelProps {
  onTemplateUse?: (template: PresetTemplate) => void;
}

interface TemplatePanelHandle {
  refreshTemplates: () => void;
}

export const TemplatePanel = forwardRef<
  TemplatePanelHandle,
  TemplatePanelProps
>(({ onTemplateUse }, ref) => {
  const [templates, setTemplates] = useState<PresetTemplate[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create');
  const [templateToEdit, setTemplateToEdit] = useState<PresetTemplate | null>(
    null,
  );

  const { initialized } = useAppStore();

  // Load templates when app is initialized
  React.useEffect(() => {
    if (initialized) {
      console.log('App initialized, loading templates...');
      loadTemplates();
    }
  }, [initialized]);

  const loadTemplates = async () => {
    try {
      setLoading(true);
      const backendTemplates = await geminiChatService.getAllTemplatesAsync();
      const customTemplates = backendTemplates.filter(
        (template) => !template.isBuiltin,
      );
      setTemplates(customTemplates);
      console.log(
        'Templates loaded:',
        customTemplates.length,
        'custom templates',
      );
    } catch (error) {
      console.error('Failed to load templates:', error);
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  };

  // Expose refresh method to parent components
  useImperativeHandle(ref, () => ({
    refreshTemplates() {
      loadTemplates();
    },
  }));

  const handleUseTemplate = (template: PresetTemplate) => {
    if (onTemplateUse) {
      onTemplateUse(template);
    }
  };

  const handleEditTemplate = (template: PresetTemplate) => {
    setTemplateToEdit(template);
    setEditorMode('edit');
    setEditorOpen(true);
  };

  const handleCreateTemplate = () => {
    setTemplateToEdit(null);
    setEditorMode('create');
    setEditorOpen(true);
  };

  const handleSaveTemplate = async (templateData: Partial<PresetTemplate>) => {
    if (editorMode === 'create') {
      const newTemplate = {
        id: `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: templateData.name || '',
        description: templateData.description || '',
        category: 'custom',
        icon: '📝',
        template: templateData.template || '',
        content: templateData.content || '',
        variables: [],
        tags: [],
        author: 'User',
        version: '1.0.0',
        lastModified: new Date(),
        usageCount: 0,
      };

      await geminiChatService.addCustomTemplate(newTemplate);
    } else if (editorMode === 'edit' && templateToEdit) {
      await geminiChatService.updateCustomTemplate(templateToEdit.id, {
        name: templateData.name?.trim() || '',
        template: templateData.template?.trim() || '',
        description: templateData.description?.trim() || undefined,
      });
    }

    await loadTemplates();
  };

  const handleDeleteTemplate = async (templateId: string) => {
    try {
      await geminiChatService.deleteCustomTemplate(templateId);
      await loadTemplates();

      if (selectedTemplate === templateId) {
        setSelectedTemplate(null);
      }
    } catch (error) {
      console.error('Failed to delete template:', error);
    }
  };

  return (
    <div className="p-4 h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <BookTemplate size={16} className="text-primary" />
          <span className="font-medium text-sm">Templates</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleCreateTemplate}
        >
          <Plus size={12} />
        </Button>
      </div>

      {/* Templates List */}
      <div className="space-y-1 flex-1 overflow-y-auto min-h-0">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            Loading templates...
          </div>
        )}

        {!loading && templates.length === 0 && (
          <div className="text-xs text-muted-foreground py-2 text-center">
            No templates yet
            <div className="text-xs text-muted-foreground/70 mt-1">
              Click + to create your first template
            </div>
          </div>
        )}

        {templates
          .filter(
            (template) =>
              template.id &&
              (template.name || template.content || template.template),
          )
          .map((template) => (
            <div
              key={template.id}
              className="group bg-accent/30 rounded hover:bg-accent/50 transition-colors"
            >
              <div
                className="p-3 cursor-pointer"
                onClick={() => handleUseTemplate(template)}
              >
                {/* Template Content - Prominent Display */}
                <div className="text-sm font-medium text-foreground mb-2 line-clamp-3 leading-relaxed">
                  {template.content || template.template || 'No content'}
                </div>

                {/* Template Name and Actions */}
                <div className="flex items-center justify-between mb-1">
                  <span
                    className="text-xs text-muted-foreground truncate flex-1"
                    title={template.name}
                  >
                    {template.name || 'Unnamed Template'}
                  </span>
                  <div
                    className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditTemplate(template);
                      }}
                      className="h-5 w-5 hover:bg-blue-500/20 hover:text-blue-500"
                      title="Edit template"
                    >
                      <Edit3 size={10} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteTemplate(template.id);
                      }}
                      className="h-5 w-5 hover:bg-destructive/20 hover:text-destructive"
                      title="Delete template"
                    >
                      <Trash2 size={10} />
                    </Button>
                  </div>
                </div>

                {/* Date - Below everything */}
                <div className="text-xs text-muted-foreground/60">
                  {new Date(template.lastModified).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
      </div>

      {/* Template Editor Dialog */}
      <TemplateEditorDialog
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSave={handleSaveTemplate}
        template={templateToEdit}
        mode={editorMode}
      />
    </div>
  );
});

TemplatePanel.displayName = 'TemplatePanel';
