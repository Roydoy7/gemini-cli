/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import { ZipReader } from './zipReader.js';

/**
 * Represents a single cell's data
 */
export interface CellData {
  /** Cell coordinate (e.g., "A1", "B2") */
  coord: string;
  /** Formula if present (e.g., "=SUM(A1:A10)") */
  formula?: string;
  /** Computed or literal value */
  value?: string;
  /** Cell type: s=string, n=number, b=boolean, e=error, str=formula string */
  type?: string;
}

/**
 * Represents a sheet's data as a map of cell coordinates to cell data
 */
export type SheetData = Map<string, CellData>;

/**
 * Snapshot of an Excel file's internal state
 */
export interface ExcelSnapshot {
  /** SHA256 hash of sharedStrings.xml */
  sharedStringsHash: string;
  /** Map of sheet name to its XML hash */
  sheetHashes: Map<string, string>;
  /** Parsed shared strings (cached) */
  sharedStrings: string[];
  /** Map of sheet name to parsed data (only for changed sheets) */
  sheets: Map<string, SheetData>;
}

/**
 * Represents a change in a cell
 */
export interface CellChange {
  coord: string;
  changeType: 'added' | 'removed' | 'modified';
  before?: CellData;
  after?: CellData;
}

/**
 * Represents changes in a sheet
 */
export interface SheetChanges {
  sheetName: string;
  changes: CellChange[];
}

/**
 * Lightweight Excel parser with intelligent incremental parsing
 * Only parses sheets that have changed based on hash comparison
 */
export class ExcelParser {
  /**
   * Create a snapshot of an Excel file
   * Only parses what's necessary based on previous snapshot
   */
  static async createSnapshot(
    xlsxPath: string,
    previousSnapshot?: ExcelSnapshot,
  ): Promise<ExcelSnapshot> {
    const reader = new ZipReader(xlsxPath);
    await reader.readCentralDirectory();

    // Get list of all sheets
    const sheetFiles = reader
      .listFiles()
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort();

    // Read and hash key files
    const filesToRead = [
      'xl/sharedStrings.xml',
      'xl/workbook.xml',
      ...sheetFiles,
    ];

    const files = await reader.extractFiles(filesToRead);

    // Hash sharedStrings
    const sharedStringsXml =
      files.get('xl/sharedStrings.xml')?.toString('utf-8') || '';
    const sharedStringsHash = this.hashString(sharedStringsXml);

    // Parse or reuse sharedStrings
    let sharedStrings: string[];
    if (
      previousSnapshot &&
      previousSnapshot.sharedStringsHash === sharedStringsHash
    ) {
      // Reuse cached sharedStrings
      sharedStrings = previousSnapshot.sharedStrings;
    } else {
      // Parse sharedStrings
      sharedStrings = this.parseSharedStrings(sharedStringsXml);
    }

    // Get sheet names from workbook.xml
    const workbookXml = files.get('xl/workbook.xml')?.toString('utf-8') || '';
    const sheetIdToName = this.parseWorkbookSheets(workbookXml);

    // Hash each sheet and determine which need parsing
    const sheetHashes = new Map<string, string>();
    const sheets = new Map<string, SheetData>();

    for (const sheetFile of sheetFiles) {
      const sheetXml = files.get(sheetFile)?.toString('utf-8') || '';
      const sheetHash = this.hashString(sheetXml);

      // Extract sheet number from filename (e.g., sheet1.xml -> 1)
      const sheetNumMatch = /sheet(\d+)\.xml/.exec(sheetFile);
      if (!sheetNumMatch) continue;

      const sheetId = parseInt(sheetNumMatch[1], 10);
      const sheetName = sheetIdToName.get(sheetId) || `Sheet${sheetId}`;

      sheetHashes.set(sheetName, sheetHash);

      // Only parse if sheet is new or changed
      const previousHash = previousSnapshot?.sheetHashes.get(sheetName);
      if (!previousHash || previousHash !== sheetHash) {
        // Sheet changed or is new - parse it
        const sheetData = this.parseSheet(sheetXml, sharedStrings);
        sheets.set(sheetName, sheetData);
      } else if (previousSnapshot) {
        // Sheet unchanged - reuse cached data
        const cachedData = previousSnapshot.sheets.get(sheetName);
        if (cachedData) {
          sheets.set(sheetName, cachedData);
        }
      }
    }

    return {
      sharedStringsHash,
      sheetHashes,
      sharedStrings,
      sheets,
    };
  }

  /**
   * Compare two snapshots and return only the changes
   */
  static compareSnapshots(
    before: ExcelSnapshot,
    after: ExcelSnapshot,
  ): SheetChanges[] {
    const allSheetNames = new Set<string>([
      ...before.sheetHashes.keys(),
      ...after.sheetHashes.keys(),
    ]);

    const allChanges: SheetChanges[] = [];

    for (const sheetName of allSheetNames) {
      const beforeHash = before.sheetHashes.get(sheetName);
      const afterHash = after.sheetHashes.get(sheetName);

      // Quick hash comparison - skip if identical
      if (beforeHash && afterHash && beforeHash === afterHash) {
        continue;
      }

      // Sheet changed, removed, or added
      const beforeSheet = before.sheets.get(sheetName) || new Map();
      const afterSheet = after.sheets.get(sheetName) || new Map();

      const changes = this.compareSheets(beforeSheet, afterSheet);

      if (changes.length > 0) {
        allChanges.push({ sheetName, changes });
      }
    }

    return allChanges;
  }

  /**
   * Fast hash function for strings
   */
  private static hashString(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Parse sharedStrings.xml to build string lookup table
   */
  private static parseSharedStrings(xml: string): string[] {
    if (!xml) return [];

    const strings: string[] = [];

    // Match <si> elements and extract <t> text content
    const siRegex = /<si[^>]*>(.*?)<\/si>/gs;
    let siMatch;

    while ((siMatch = siRegex.exec(xml)) !== null) {
      const siContent = siMatch[1];

      // Extract all <t> elements within this <si>
      const tRegex = /<t[^>]*>(.*?)<\/t>/g;
      const texts: string[] = [];
      let tMatch;

      while ((tMatch = tRegex.exec(siContent)) !== null) {
        texts.push(this.decodeXmlEntities(tMatch[1]));
      }

      strings.push(texts.join(''));
    }

    return strings;
  }

  /**
   * Parse workbook.xml to get sheet names
   */
  private static parseWorkbookSheets(xml: string): Map<number, string> {
    const sheets = new Map<number, string>();

    // Match <sheet name="SheetName" sheetId="1" ... />
    const sheetRegex = /<sheet\s+name="([^"]+)"\s+sheetId="(\d+)"/g;
    let match;

    while ((match = sheetRegex.exec(xml)) !== null) {
      const name = this.decodeXmlEntities(match[1]);
      const id = parseInt(match[2], 10);
      sheets.set(id, name);
    }

    return sheets;
  }

  /**
   * Parse a worksheet XML and extract cell data
   */
  private static parseSheet(xml: string, sharedStrings: string[]): SheetData {
    const cells = new Map<string, CellData>();

    // Match <c r="A1" ...>...</c> elements
    const cellRegex = /<c\s+r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/gs;
    let match;

    while ((match = cellRegex.exec(xml)) !== null) {
      const coord = match[1];
      const attributes = match[2];
      const cellContent = match[3];

      const cell: CellData = { coord };

      // Extract cell type from attributes
      const typeMatch = /\s+t="([^"]+)"/.exec(attributes);
      if (typeMatch) {
        cell.type = typeMatch[1];
      }

      // Extract formula <f>...</f>
      const formulaMatch = /<f[^>]*>(.*?)<\/f>/s.exec(cellContent);
      if (formulaMatch) {
        cell.formula = this.decodeXmlEntities(formulaMatch[1]);
      }

      // Extract value <v>...</v>
      const valueMatch = /<v>(.*?)<\/v>/.exec(cellContent);
      if (valueMatch) {
        const v = valueMatch[1];

        // If type is shared string (t="s"), lookup in sharedStrings
        if (cell.type === 's') {
          const idx = parseInt(v, 10);
          cell.value = sharedStrings[idx] || '';
        } else {
          cell.value = v;
        }
      }

      // Extract inline string <is><t>...</t></is>
      const inlineStringMatch = /<is><t[^>]*>(.*?)<\/t><\/is>/.exec(
        cellContent,
      );
      if (inlineStringMatch) {
        cell.value = this.decodeXmlEntities(inlineStringMatch[1]);
        cell.type = 'inlineStr';
      }

      cells.set(coord, cell);
    }

    return cells;
  }

  /**
   * Decode XML entities
   */
  private static decodeXmlEntities(text: string): string {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
  }

  /**
   * Compare two sheets and generate cell changes
   */
  private static compareSheets(
    before: SheetData,
    after: SheetData,
  ): CellChange[] {
    const changes: CellChange[] = [];
    const allCoords = new Set<string>([...before.keys(), ...after.keys()]);

    for (const coord of allCoords) {
      const beforeCell = before.get(coord);
      const afterCell = after.get(coord);

      if (!beforeCell && afterCell) {
        // Cell added
        changes.push({
          coord,
          changeType: 'added',
          after: afterCell,
        });
      } else if (beforeCell && !afterCell) {
        // Cell removed
        changes.push({
          coord,
          changeType: 'removed',
          before: beforeCell,
        });
      } else if (beforeCell && afterCell) {
        // Check if cell changed
        if (this.cellsAreDifferent(beforeCell, afterCell)) {
          changes.push({
            coord,
            changeType: 'modified',
            before: beforeCell,
            after: afterCell,
          });
        }
      }
    }

    // Sort by coordinate for consistent output
    changes.sort((a, b) => this.compareCoordinates(a.coord, b.coord));

    return changes;
  }

  /**
   * Check if two cells are different
   */
  private static cellsAreDifferent(a: CellData, b: CellData): boolean {
    return a.formula !== b.formula || a.value !== b.value;
  }

  /**
   * Compare cell coordinates for sorting (A1 < A2 < B1 < B2)
   */
  private static compareCoordinates(a: string, b: string): number {
    const aMatch = /([A-Z]+)(\d+)/.exec(a);
    const bMatch = /([A-Z]+)(\d+)/.exec(b);

    if (!aMatch || !bMatch) return 0;

    const aCol = aMatch[1];
    const aRow = parseInt(aMatch[2], 10);
    const bCol = bMatch[1];
    const bRow = parseInt(bMatch[2], 10);

    // Compare row first (more intuitive for users)
    if (aRow !== bRow) {
      return aRow - bRow;
    }

    // Then compare column
    return aCol.localeCompare(bCol);
  }

  /**
   * Format changes as a unified diff-like string for LLM
   */
  static formatChanges(sheetChanges: SheetChanges[]): string {
    if (sheetChanges.length === 0) {
      return '';
    }

    const lines: string[] = [];

    for (const { sheetName, changes } of sheetChanges) {
      lines.push(`Sheet: ${sheetName}`);
      lines.push('─'.repeat(60));

      for (const change of changes) {
        switch (change.changeType) {
          case 'added':
            lines.push(`+ ${change.coord}: ${this.formatCell(change.after!)}`);
            break;

          case 'removed':
            lines.push(`- ${change.coord}: ${this.formatCell(change.before!)}`);
            break;

          case 'modified':
            lines.push(`  ${change.coord}:`);
            lines.push(`  - ${this.formatCell(change.before!)}`);
            lines.push(`  + ${this.formatCell(change.after!)}`);
            break;

          default:
            break;
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format a single cell for display
   */
  private static formatCell(cell: CellData): string {
    const parts: string[] = [];

    if (cell.formula) {
      parts.push(`formula: =${cell.formula}`);
    }

    if (cell.value !== undefined) {
      parts.push(`value: "${cell.value}"`);
    }

    return parts.join(', ') || '(empty)';
  }
}
