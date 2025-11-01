/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { RichTextInput } from '../chat/RichTextInput';
import type { PresetTemplate } from '@/types';

interface TemplateEditorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (template: Partial<PresetTemplate>) => Promise<void>;
  template?: PresetTemplate | null;
  mode: 'create' | 'edit';
}

export const TemplateEditorDialog: React.FC<TemplateEditorDialogProps> = ({
  isOpen,
  onClose,
  onSave,
  template,
  mode,
}) => {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // Load template data when dialog opens or template changes
  useEffect(() => {
    if (isOpen && template) {
      setName(template.name || '');
      setContent(template.content || template.template || '');
      setDescription(template.description || '');
    } else if (isOpen && mode === 'create') {
      setName('');
      setContent('');
      setDescription('');
    }
  }, [isOpen, template, mode]);

  // Focus on name input when dialog opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        const nameInput = document.querySelector(
          '#template-name-input',
        ) as HTMLInputElement;
        nameInput?.focus();
      }, 100);
    }
  }, [isOpen]);

  const handleSave = async () => {
    if (!name.trim() || !content.trim()) return;

    setSaving(true);
    try {
      // Save content to both template and content fields for consistency
      const contentToSave = content.trim();
      const templateData: Partial<PresetTemplate> = {
        ...(template && { id: template.id }),
        name: name.trim(),
        template: contentToSave,
        content: contentToSave,
        description: description.trim() || undefined,
      };

      await onSave(templateData);
      onClose();
    } catch (error) {
      console.error('Failed to save template:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    onClose();
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl + Enter to save
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (name.trim() && content.trim() && !saving) {
        handleSave();
      }
    }
    // Escape to cancel
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-xl border border-border w-full max-w-5xl h-[95vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">
            {mode === 'create' ? 'Create Template' : 'Edit Template'}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleCancel}
            className="h-8 w-8"
          >
            <X size={18} />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col overflow-hidden p-6 space-y-4">
          {/* Template Name */}
          <div className="flex-shrink-0">
            <label
              htmlFor="template-name-input"
              className="block text-sm font-medium mb-2"
            >
              Template Name <span className="text-red-500">*</span>
            </label>
            <Input
              id="template-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter template name"
              className="w-full"
            />
          </div>

          {/* Template Description */}
          <div className="flex-shrink-0">
            <label
              htmlFor="template-description-input"
              className="block text-sm font-medium mb-2"
            >
              Description (Optional)
            </label>
            <Input
              id="template-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe what this template is for"
              className="w-full"
            />
          </div>

          {/* Template Content - Using RichTextInput */}
          <div className="flex-1 flex flex-col min-h-0">
            <label className="block text-sm font-medium mb-2 flex-shrink-0">
              Template Content <span className="text-red-500">*</span>
            </label>
            <div className="flex-1 min-h-0 flex flex-col">
              <RichTextInput
                value={content}
                onChange={setContent}
                placeholder="Enter your template content here... (Markdown supported)"
                defaultMultiline={true}
                fullHeight={true}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          <div className="text-xs text-muted-foreground">
            Press{' '}
            <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">
              Cmd/Ctrl+Enter
            </kbd>{' '}
            to save •{' '}
            <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">Esc</kbd> to
            cancel
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!name.trim() || !content.trim() || saving}
              className="min-w-24"
            >
              {saving ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                <>
                  <Save size={16} className="mr-2" />
                  Save
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
