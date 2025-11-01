/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

declare module 'fdir' {
  export class fdir {
    withFullPaths(): this;
    withErrors(): this;
    withRelativePaths(): this;
    withDirs(): this;
    withPathSeparator(sep: string): this;
    withMaxDepth(depth: number): this;
    exclude(fn: (dirName: string, dirPath: string) => boolean): this;
    crawl(directory: string): {
      withPromise(): Promise<string[]>;
    };
  }
}

declare module 'mime/lite' {
  interface Mime {
    getType(path: string): string | null;
    getExtension(type: string): string | null;
  }

  const mime: Mime;
  export default mime;
}
