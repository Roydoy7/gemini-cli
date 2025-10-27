/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutocompleteProvider, AutocompleteMatch } from './types';

export class AutocompleteSystem {
  private providers: Map<string, AutocompleteProvider> = new Map();

  registerProvider(provider: AutocompleteProvider): void {
    this.providers.set(provider.trigger, provider);
  }

  unregisterProvider(trigger: string): void {
    this.providers.delete(trigger);
  }

  getProvider(trigger: string): AutocompleteProvider | undefined {
    return this.providers.get(trigger);
  }

  getAllProviders(): AutocompleteProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Find autocomplete matches in text at cursor position
   */
  findMatch(text: string, cursorPos: number): AutocompleteMatch | null {
    // Ensure we have valid input
    if (!text || cursorPos <= 0 || cursorPos > text.length) {
      return null;
    }

    // Look backwards from cursor to find trigger
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = text[i];

      // If we hit whitespace or newline, no match
      if (char === ' ' || char === '\n' || char === '\t') {
        break;
      }

      // Check if this character is a trigger
      const provider = this.providers.get(char);
      if (provider) {
        // Check if the trigger is at the start of text or preceded by whitespace
        // This prevents triggering on @ symbols that are part of filenames
        const isValidTriggerPosition =
          i === 0 ||
          text[i - 1] === ' ' ||
          text[i - 1] === '\n' ||
          text[i - 1] === '\t';

        if (!isValidTriggerPosition) {
          // This @ is part of a filename or other text, not a trigger
          continue;
        }

        // Found a trigger, extract the query
        const query = text.slice(i + 1, cursorPos);

        return {
          provider,
          query,
          startPos: i,
          endPos: cursorPos,
        };
      }
    }

    return null;
  }

  /**
   * Replace text with selected autocomplete item
   */
  applyCompletion(
    text: string,
    match: AutocompleteMatch,
    selectedValue: string,
  ): { newText: string; newCursorPos: number } {
    const before = text.slice(0, match.startPos);
    const after = text.slice(match.endPos);

    // Format the selected value: remove trailing slash and add quotes
    let formattedValue = selectedValue;

    // Remove trailing slash if present
    if (formattedValue.endsWith('/') || formattedValue.endsWith('\\')) {
      formattedValue = formattedValue.slice(0, -1);
    }

    // Add quotes around the path
    formattedValue = `"${formattedValue}"`;

    const newText = before + formattedValue + after;
    const newCursorPos = match.startPos + formattedValue.length;

    return { newText, newCursorPos };
  }
}

// Global instance
export const autocompleteSystem = new AutocompleteSystem();
