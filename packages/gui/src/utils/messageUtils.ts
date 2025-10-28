/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ImageAttachment } from '@/types';

/**
 * Extract image attachments from message parts array
 * Converts inlineData format to ImageAttachment format for frontend display
 */
export function extractImagesFromParts(
  parts?: unknown[],
): ImageAttachment[] | undefined {
  if (!parts || parts.length === 0) return undefined;

  const images: ImageAttachment[] = [];
  for (const part of parts) {
    if (typeof part === 'object' && part !== null && 'inlineData' in part) {
      const inlineData = (part as { inlineData: unknown }).inlineData;
      if (
        typeof inlineData === 'object' &&
        inlineData !== null &&
        'data' in inlineData &&
        'mimeType' in inlineData
      ) {
        const data = (inlineData as { data: string }).data;
        const mimeType = (inlineData as { mimeType: string }).mimeType;

        if (mimeType.startsWith('image/')) {
          // Extract filename from data or use generic name
          const ext = mimeType.split('/')[1] || 'png';
          const name = `image.${ext}`;
          const size = Math.ceil((data.length * 3) / 4); // Approximate size from base64

          images.push({
            id: `${Date.now()}-${Math.random()}`,
            name,
            mimeType,
            base64Data: data,
            size,
            previewUrl: `data:${mimeType};base64,${data}`,
          });
        }
      }
    }
  }

  return images.length > 0 ? images : undefined;
}
