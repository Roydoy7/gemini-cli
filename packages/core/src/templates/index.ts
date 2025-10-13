/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export { TemplateManager } from './TemplateManager.js';
export { TemplateRenderer } from './TemplateRenderer.js';
export {
  SimpleTemplateBuilder,
  TemplateWizard,
} from './SimpleTemplateBuilder.js';
export { ConversationTemplateGenerator } from './ConversationTemplateGenerator.js';
export type {
  PresetTemplate,
  TemplateVariable,
  TemplateRenderOptions,
  TemplateRenderResult,
  TemplateSearchOptions,
  TemplateUsageStats,
} from './types.js';
export type { SimpleTemplateOptions } from './SimpleTemplateBuilder.js';
export type {
  ConversationMessage,
  TemplateGenerationOptions,
  VariableSuggestion,
} from './ConversationTemplateGenerator.js';
