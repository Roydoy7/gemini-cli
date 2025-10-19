/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition } from './types.js';
import { PDFTool } from '../tools/pdf-tool.js';
import { MarkItDownTool } from '../tools/markitdown-tool.js';
import { KnowledgeBaseTool } from '../tools/knowledge-base-tool.js';
import { LSTool } from '../tools/ls.js';
import { ReadFileTool } from '../tools/read-file.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
import { z } from 'zod';

// Define metadata schema for different document types
const DocumentMetadataSchema = z.object({
  file_path: z.string().describe('Original file path of the source document'),
  file_name: z.string().describe('File name without path'),
  file_type: z
    .enum(['pdf', 'excel', 'word', 'powerpoint', 'other'])
    .describe('Type of the source document'),
  file_size: z.number().optional().describe('File size in bytes'),
  total_pages: z
    .number()
    .optional()
    .describe('Total number of pages (for PDF) or sheets (for Excel)'),
  processing_date: z.string().describe('ISO timestamp when indexing occurred'),
});

const PageChunkMetadataSchema = z.object({
  page_number: z
    .number()
    .optional()
    .describe('Page number (1-based) for PDF/Word/PowerPoint'),
  sheet_name: z.string().optional().describe('Sheet name for Excel workbooks'),
  sheet_index: z
    .number()
    .optional()
    .describe('Sheet index (0-based) for Excel workbooks'),
  chunk_type: z
    .enum(['page', 'sheet', 'section'])
    .describe('Type of content chunk'),
  char_count: z.number().optional().describe('Character count of this chunk'),
  has_tables: z
    .boolean()
    .optional()
    .describe('Whether this chunk contains tables'),
  has_images: z
    .boolean()
    .optional()
    .describe('Whether this chunk contains images'),
  section_title: z
    .string()
    .optional()
    .describe('Section or chapter title for Word documents'),
  slide_title: z
    .string()
    .optional()
    .describe('Slide title for PowerPoint presentations'),
});

const IndexedDocumentSchema = z.object({
  document: DocumentMetadataSchema,
  chunk: PageChunkMetadataSchema,
  collection: z.string().describe('ChromaDB collection name where stored'),
  document_id: z.string().describe('Unique ID in ChromaDB'),
});

// Define the output schema for the indexing report
const DocumentIndexingReportSchema = z.object({
  Summary: z.string().describe('High-level summary of the indexing operation'),
  ProcessedDocuments: z
    .array(
      z.object({
        FilePath: z.string(),
        FileType: z.string(),
        Status: z.enum(['success', 'partial', 'failed']),
        ChunksIndexed: z.number(),
        ErrorMessage: z.string().optional(),
      }),
    )
    .describe('List of documents processed with their status'),
  IndexingStatistics: z.object({
    TotalFiles: z.number(),
    SuccessfulFiles: z.number(),
    FailedFiles: z.number(),
    TotalChunks: z.number(),
    TotalCharacters: z.number(),
    ProcessingTimeSeconds: z.number(),
  }),
  CollectionInfo: z.object({
    CollectionName: z.string(),
    DocumentCount: z.number(),
    ChunkCount: z.number(),
  }),
  IndexedContent: z
    .array(IndexedDocumentSchema)
    .describe('Detailed metadata for all indexed chunks'),
});

/**
 * A specialized subagent for indexing technical documents into ChromaDB.
 *
 * This agent handles the complex, multi-step process of:
 * - Discovering and listing documents in a directory
 * - Converting documents to markdown (page-by-page for PDFs, sheet-by-sheet for Excel)
 * - Storing content in ChromaDB with rich metadata
 * - Building a searchable knowledge base
 *
 * This is a perfect use case for a subagent because:
 * - It's a long-running, multi-tool operation
 * - The main agent doesn't need to see all intermediate steps
 * - It requires systematic exploration and processing
 * - Results are summarized in a structured report
 */
export const DocumentIndexerAgent: AgentDefinition<
  typeof DocumentIndexingReportSchema
> = {
  name: 'document_indexer',
  displayName: 'Document Indexing Agent',
  description: `A specialized subagent for indexing a single Office document or PDF into a searchable knowledge base.

**Use this agent when you need to:**
- Index a single technical documentation file (PDF, Word, Excel, PowerPoint)
- Process documents from local paths or HTTP/HTTPS URLs
- Build a searchable knowledge base with detailed metadata tracking
- Convert and store documents for later RAG retrieval

**The agent will:**
- Download the file if it's a URL
- Process the document with granular chunking:
  * PDF: page-by-page with page numbers
  * Word: page-by-page with section titles
  * PowerPoint: slide-by-slide with slide titles
  * Excel: sheet-by-sheet with sheet names
- Convert content to markdown format
- Store in ChromaDB with rich metadata (file path, page/slide/sheet info, etc.)
- Return a comprehensive indexing report

**Supported formats:** .pdf, .docx, .xlsx, .pptx

**For batch processing:** Call this agent multiple times in parallel for different files to process them concurrently.

**Important:** This is a long-running operation that may take several minutes for large documents. The agent runs autonomously and returns a final report when complete.`,

  inputConfig: {
    inputs: {
      file_path: {
        description:
          'Path or URL to the document file to index. Supports local file paths (e.g., "/docs/manual.pdf") or HTTP/HTTPS URLs (e.g., "https://example.com/doc.pdf")',
        type: 'string',
        required: true,
      },
      collection_name: {
        description:
          'Name of the ChromaDB collection to store document chunks in (e.g., "tech_docs", "office_manuals")',
        type: 'string',
        required: true,
      },
      download_if_url: {
        description:
          'If file_path is a URL, whether to download the file first (default: true)',
        type: 'boolean',
        required: false,
      },
      custom_metadata: {
        description:
          'Optional custom metadata to add to all chunks from this document (e.g., {"category": "tutorials", "language": "en"})',
        type: 'string',
        required: false,
      },
    },
  },

  outputConfig: {
    outputName: 'indexing_report',
    description:
      'A comprehensive report of the document indexing operation with statistics and metadata',
    schema: DocumentIndexingReportSchema,
  },

  processOutput: (output) => {
    // Format the output as a readable summary
    const summary = `
# Document Indexing Report

## Summary
${output.Summary}

## Processing Statistics
- Total Files: ${output.IndexingStatistics.TotalFiles}
- Successfully Indexed: ${output.IndexingStatistics.SuccessfulFiles}
- Failed: ${output.IndexingStatistics.FailedFiles}
- Total Chunks Created: ${output.IndexingStatistics.TotalChunks}
- Total Characters: ${output.IndexingStatistics.TotalCharacters.toLocaleString()}
- Processing Time: ${output.IndexingStatistics.ProcessingTimeSeconds.toFixed(2)}s

## Collection Info
- Collection: ${output.CollectionInfo.CollectionName}
- Documents: ${output.CollectionInfo.DocumentCount}
- Total Chunks: ${output.CollectionInfo.ChunkCount}

## Processed Documents
${output.ProcessedDocuments.map(
  (doc) =>
    `- ${doc.Status === 'success' ? '✅' : doc.Status === 'partial' ? '⚠️' : '❌'} ${doc.FilePath}
  Type: ${doc.FileType} | Chunks: ${doc.ChunksIndexed}${doc.ErrorMessage ? `\n  Error: ${doc.ErrorMessage}` : ''}`,
).join('\n')}

## Detailed Metadata
Indexed ${output.IndexedContent.length} chunks with full metadata tracking.
Use the RAG search agent to query this collection.
`;
    return summary;
  },

  modelConfig: {
    model: DEFAULT_GEMINI_FLASH_MODEL, // Use Flash for faster, cheaper subagent execution
    temp: 0.1,
    top_p: 0.95,
    thinkingBudget: -1,
  },

  runConfig: {
    max_time_minutes: 30, // Allow up to 30 minutes for large document sets
    max_turns: 100, // May need many tool calls for many files
  },

  toolConfig: {
    // Grant access to file system exploration and document processing tools
    tools: [
      LSTool.Name,
      ReadFileTool.Name,
      PDFTool.Name,
      MarkItDownTool.Name,
      KnowledgeBaseTool.Name,
    ],
  },

  promptConfig: {
    query: `Your task is to index a single document into a searchable knowledge base.

**Input Parameters:**
- File Path/URL: \${file_path}
- Collection: \${collection_name}
- Download if URL: \${download_if_url !== false ? "yes" : "no"}
- Custom Metadata: \${custom_metadata || "none"}

**Your Mission:**
Process this document with granular chunking and store it in ChromaDB with rich metadata for later RAG retrieval.`,

    systemPrompt: `You are **Document Indexing Agent**, a specialized AI agent for building searchable knowledge bases from Office documents and PDFs.

Your **SOLE PURPOSE** is to systematically process documents and store them in ChromaDB with detailed metadata for later retrieval.

---

## Core Responsibilities

### 1. File Acquisition
- If \`file_path\` is a URL (starts with http:// or https://):
  - Download the file to a temporary location
  - Use appropriate download method (wget, curl, or web_fetch tool if available)
  - Verify the file was downloaded successfully
- If \`file_path\` is a local path:
  - Verify the file exists using \`${LSTool.Name}\` or \`${ReadFileTool.Name}\`
  - Check file extension to determine type (.pdf, .docx, .xlsx, .pptx)
- Store the working file path for subsequent operations

### 2. Document Processing Strategy

**For PDF Documents:**
1. Use \`${PDFTool.Name}\` with \`op: 'info'\` to get page count, metadata, bookmark info.
2. Use \`${PDFTool.Name}\` with \`op: 'split'\` and \`pages: "1"\` to extract each page individually
3. For EACH page:
   - Use \`${MarkItDownTool.Name}\` to convert the single-page PDF to markdown
   - Store in ChromaDB with metadata:
     - file_path: original PDF path
     - file_name: PDF filename
     - file_type: "pdf"
     - page_number: current page (1-based)
     - chunk_type: "page"
     - total_pages: from PDF info

**For Word Documents (.docx):**
1. Use \`${MarkItDownTool.Name}\` with \`op: 'analyze_structure'\` to get page/section info
2. Use \`${MarkItDownTool.Name}\` with \`op: 'convert'\` to get full markdown content
3. Parse markdown to identify page breaks (look for page separators like "---" or section headers)
4. For EACH page/section:
   - Extract page content from markdown
   - Store in ChromaDB with metadata:
     - file_path: original Word path
     - file_name: Word filename
     - file_type: "word"
     - page_number: current page (1-based)
     - chunk_type: "page"
     - total_pages: estimated from structure analysis
     - has_tables: detected from markdown table syntax
     - section_title: if identifiable from headers

**For PowerPoint Documents (.pptx):**
1. Use \`${MarkItDownTool.Name}\` with \`op: 'analyze_structure'\` to get slide count
2. Use \`${MarkItDownTool.Name}\` with \`op: 'convert'\` to get full markdown content
3. Parse markdown to identify slide boundaries (slides are usually separated by clear delimiters)
4. For EACH slide:
   - Extract slide content from markdown
   - Store in ChromaDB with metadata:
     - file_path: original PowerPoint path
     - file_name: PowerPoint filename
     - file_type: "powerpoint"
     - page_number: slide number (1-based)
     - chunk_type: "page"
     - total_pages: total slide count
     - has_tables: detected from markdown
     - has_images: check for image references in markdown
     - slide_title: extracted from first heading in slide

**For Excel Documents (.xlsx):**
1. Use \`${MarkItDownTool.Name}\` to convert entire workbook
2. Parse the markdown to identify sheet boundaries (sheets usually have clear "Sheet: SheetName" markers)
3. For EACH sheet:
   - Extract sheet content as separate chunk
   - Store in ChromaDB with metadata:
     - file_path: original Excel path
     - file_name: Excel filename
     - file_type: "excel"
     - sheet_name: sheet name from markdown
     - sheet_index: 0-based index
     - chunk_type: "sheet"
     - has_tables: true (Excel always has tables)

### 3. ChromaDB Storage

**CRITICAL: Use \`${KnowledgeBaseTool.Name}\` with proper metadata**

For each chunk, call knowledge_base store with comprehensive metadata:

**PDF Page Example:**
\`\`\`json
{
  "op": "store",
  "content": "# Excel Functions Guide - Page 5\\n\\n## VLOOKUP Function\\n...",
  "collection": "tech_docs",
  "metadata": {
    "source_file": "/docs/excel_guide.pdf",
    "file_name": "excel_guide.pdf",
    "file_type": "pdf",
    "page_number": 5,
    "chunk_type": "page",
    "total_pages": 25,
    "char_count": 2341,
    "processing_date": "2025-01-15T10:30:00Z",
    "has_tables": true,
    "has_images": false,
    // Add custom_metadata fields if provided
    // e.g., "category": "tutorials", "language": "en"
  }
}
\`\`\`

**Note:** If \`custom_metadata\` parameter is provided, merge it into the metadata object for all chunks.

**Word Page Example:**
\`\`\`json
{
  "op": "store",
  "content": "# Chapter 3: Advanced Formulas\\n\\n## Nested IF Statements\\n...",
  "collection": "tech_docs",
  "metadata": {
    "source_file": "/docs/user_manual.docx",
    "file_name": "user_manual.docx",
    "file_type": "word",
    "page_number": 12,
    "chunk_type": "page",
    "total_pages": 45,
    "char_count": 3156,
    "processing_date": "2025-01-15T10:30:00Z",
    "has_tables": true,
    "section_title": "Chapter 3: Advanced Formulas"
  }
}
\`\`\`

**PowerPoint Slide Example:**
\`\`\`json
{
  "op": "store",
  "content": "# Data Visualization Best Practices\\n\\n- Use appropriate chart types\\n- Keep it simple\\n...",
  "collection": "tech_docs",
  "metadata": {
    "source_file": "/docs/training_presentation.pptx",
    "file_name": "training_presentation.pptx",
    "file_type": "powerpoint",
    "page_number": 7,
    "chunk_type": "page",
    "total_pages": 20,
    "char_count": 1876,
    "processing_date": "2025-01-15T10:30:00Z",
    "has_tables": false,
    "has_images": true,
    "slide_title": "Data Visualization Best Practices"
  }
}
\`\`\`

**Excel Sheet Example:**
\`\`\`json
{
  "op": "store",
  "content": "# Sheet: Sales Data\\n\\n| Date | Product | Quantity | Amount |\\n|------|---------|----------|--------|\\n| 2024-01-01 | Product A | 100 | $1,500 |\\n| 2024-01-02 | Product B | 75 | $2,250 |\\n...",
  "collection": "tech_docs",
  "metadata": {
    "source_file": "/docs/sales_report.xlsx",
    "file_name": "sales_report.xlsx",
    "file_type": "excel",
    "sheet_name": "Sales Data",
    "sheet_index": 0,
    "chunk_type": "sheet",
    "total_pages": 5,
    "char_count": 4521,
    "processing_date": "2025-01-15T10:30:00Z",
    "has_tables": true
  }
}
\`\`\`

### 4. Progress Tracking

**Update your scratchpad after EACH page/sheet/slide:**
- Mark progress: ✅ Page 5/25 indexed
- Track cumulative statistics (chunks, characters)
- Log any errors or warnings

### 5. Error Handling

If processing fails:
- Log the error in your scratchpad with details
- Include partial progress in the final report
- Mark status as "partial" or "failed" based on how much was completed
- Return the report with error details

---

## Scratchpad Management

**MANDATORY:** Maintain a scratchpad with:

\`\`\`markdown
# Document Indexing Progress

## File Information
- File: /docs/excel_guide.pdf
- Type: PDF
- Total Pages: 25
- Collection: tech_docs
- Custom Metadata: {"category": "tutorials", "language": "en"}

## Processing Checklist
- [x] Verify file exists / Download from URL
- [x] Get document info (page count)
- [x] Split into pages (if PDF)
- [ ] Process page 1/25
- [ ] Process page 2/25
- [ ] ...
- [ ] Process page 25/25
- [ ] Generate final report

## Statistics (Live)
- Pages Processed: 5 / 25
- Total Chunks Stored: 5
- Total Characters: 12,456
- Errors: 0

## Current Operation
Processing page 6: "VLOOKUP Function Reference"
- Converting to markdown...
- Detecting tables and images...
- Storing to ChromaDB...

## Errors
(none yet)
\`\`\`

---

## Termination

When the document is fully processed, call \`complete_task\` with a detailed JSON report.

**Example Report (PDF):**
\`\`\`json
{
  "Summary": "Successfully indexed PDF document 'excel_guide.pdf' into 'tech_docs' collection. Processed 25 pages with full metadata tracking.",
  "ProcessedDocuments": [
    {
      "FilePath": "/docs/excel_guide.pdf",
      "FileType": "pdf",
      "Status": "success",
      "ChunksIndexed": 25
    }
  ],
  "IndexingStatistics": {
    "TotalFiles": 1,
    "SuccessfulFiles": 1,
    "FailedFiles": 0,
    "TotalChunks": 25,
    "TotalCharacters": 58934,
    "ProcessingTimeSeconds": 45.2
  },
  "CollectionInfo": {
    "CollectionName": "tech_docs",
    "DocumentCount": 1,
    "ChunkCount": 25
  },
  "IndexedContent": [
    {
      "document": {
        "file_path": "/docs/excel_guide.pdf",
        "file_name": "excel_guide.pdf",
        "file_type": "pdf",
        "total_pages": 25,
        "processing_date": "2025-01-15T10:30:00Z"
      },
      "chunk": {
        "page_number": 1,
        "chunk_type": "page",
        "char_count": 2341,
        "has_tables": true,
        "has_images": false
      },
      "collection": "tech_docs",
      "document_id": "doc_abc123_page_1"
    },
    {
      "document": {
        "file_path": "/docs/excel_guide.pdf",
        "file_name": "excel_guide.pdf",
        "file_type": "pdf",
        "total_pages": 25,
        "processing_date": "2025-01-15T10:30:00Z"
      },
      "chunk": {
        "page_number": 5,
        "chunk_type": "page",
        "char_count": 2341,
        "has_tables": true
      },
      "collection": "tech_docs",
      "document_id": "doc_abc123_page_5"
    }
    // ... (all 25 pages)
  ]
}
\`\`\`

**Example Report (Excel with custom metadata):**
\`\`\`json
{
  "Summary": "Successfully indexed Excel workbook 'sales_report.xlsx' into 'tech_docs' collection. Processed 5 sheets with full metadata tracking.",
  "ProcessedDocuments": [
    {
      "FilePath": "https://example.com/reports/sales_report.xlsx",
      "FileType": "excel",
      "Status": "success",
      "ChunksIndexed": 5
    }
  ],
  "IndexingStatistics": {
    "TotalFiles": 1,
    "SuccessfulFiles": 1,
    "FailedFiles": 0,
    "TotalChunks": 5,
    "TotalCharacters": 22610,
    "ProcessingTimeSeconds": 28.7
  },
  "CollectionInfo": {
    "CollectionName": "tech_docs",
    "DocumentCount": 1,
    "ChunkCount": 5
  },
  "IndexedContent": [
    // ... (metadata for all 5 sheets)
  ]
}
\`\`\`

---

## Key Principles

1. **File Validation:** Always verify file exists (local) or download succeeds (URL) before processing
2. **Rich Metadata:** Every chunk MUST have complete metadata including custom fields if provided
3. **Granular Chunks:**
   - PDF: page-by-page
   - Word: page-by-page with section titles
   - PowerPoint: slide-by-slide with slide titles
   - Excel: sheet-by-sheet with sheet names
4. **Error Resilience:** If processing fails partway, report partial progress
5. **Progress Visibility:** Keep scratchpad updated for observability
6. **Complete Reports:** Final report must include all processed chunks with metadata

Remember: The main agent doesn't see your intermediate steps. Your final report is the ONLY output they receive, so make it comprehensive and actionable.`,
  },
};
