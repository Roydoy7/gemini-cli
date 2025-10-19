/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition } from './types.js';
import { KnowledgeBaseTool } from '../tools/knowledge-base-tool.js';
import { GeminiSearchTool } from '../tools/gemini-search-tool.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
import { z } from 'zod';

// Define metadata schema for retrieved content
const RetrievedDocumentMetadataSchema = z.object({
  file_path: z.string().describe('Original file path of the source document'),
  file_name: z.string().describe('File name without path'),
  file_type: z
    .enum(['pdf', 'excel', 'word', 'powerpoint', 'other'])
    .optional()
    .describe('Type of the source document'),
  page_number: z
    .number()
    .optional()
    .describe('Page number (1-based) for PDF/Word/PowerPoint'),
  sheet_name: z.string().optional().describe('Sheet name for Excel workbooks'),
  sheet_index: z
    .number()
    .optional()
    .describe('Sheet index (0-based) for Excel workbooks'),
  section_title: z
    .string()
    .optional()
    .describe('Section or chapter title for Word documents'),
  slide_title: z
    .string()
    .optional()
    .describe('Slide title for PowerPoint presentations'),
  processing_date: z
    .string()
    .optional()
    .describe('ISO timestamp when indexing occurred'),
  total_pages: z
    .number()
    .optional()
    .describe('Total number of pages or sheets in the document'),
});

const RetrievedChunkSchema = z.object({
  chunk_id: z.string().describe('Unique identifier of the chunk in ChromaDB'),
  content: z.string().describe('The actual content of the chunk'),
  similarity_score: z
    .number()
    .describe('Similarity score (0-1) indicating relevance'),
  metadata: RetrievedDocumentMetadataSchema,
  quick_reference: z
    .string()
    .describe(
      'Quick reference string for user navigation (e.g., "excel_guide.pdf - Page 5")',
    ),
});

const WebSupplementSchema = z.object({
  query: z.string().describe('The query used for web search'),
  summary: z.string().describe('Summary of web search results'),
  sources: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
      }),
    )
    .describe('Web sources used for supplementary information'),
  used_for_enrichment: z
    .boolean()
    .describe('Whether web results were used to enrich the response'),
});

// Define the output schema for the retrieval report
const DocumentRetrievalReportSchema = z.object({
  Summary: z
    .string()
    .describe(
      'Executive summary of the retrieval results and key findings from knowledge base',
    ),
  Query: z.string().describe('The original user query'),
  TotalResultsFound: z
    .number()
    .describe('Total number of relevant chunks found in knowledge base'),
  RelevantDocuments: z
    .array(
      z.object({
        FilePath: z.string(),
        FileName: z.string(),
        FileType: z.string().optional(),
        RelevantChunksCount: z
          .number()
          .describe('Number of relevant chunks from this document'),
        HighestSimilarity: z
          .number()
          .describe('Highest similarity score among chunks from this document'),
      }),
    )
    .describe('List of source documents with relevance metrics'),
  RetrievedChunks: z
    .array(RetrievedChunkSchema)
    .describe(
      'Detailed retrieved chunks with full metadata for quick navigation',
    ),
  WebSupplement: WebSupplementSchema.optional().describe(
    'Optional web search results used to supplement knowledge base content',
  ),
  Answer: z
    .string()
    .describe(
      'Synthesized answer to the query based on retrieved content and optional web search',
    ),
  Confidence: z
    .enum(['high', 'medium', 'low'])
    .describe(
      'Confidence level in the answer based on source quality and relevance',
    ),
  RecommendedFollowUp: z
    .array(z.string())
    .optional()
    .describe('Suggested follow-up queries for deeper exploration'),
});

/**
 * A specialized subagent for retrieving information from the knowledge base using RAG.
 *
 * This agent is the inverse of the document-indexer:
 * - While indexer STORES documents into ChromaDB
 * - This retriever SEARCHES and RETRIEVES information from ChromaDB
 *
 * This agent provides:
 * - Semantic search across indexed documents
 * - Metadata-rich results with precise document locations
 * - Optional web search supplementation
 * - Relevance-based filtering
 * - Quick reference strings for user navigation
 *
 * This is a perfect use case for a subagent because:
 * - It's a multi-step RAG pipeline (search, filter, rank, synthesize)
 * - The main agent doesn't need to see intermediate retrieval steps
 * - It can optionally supplement with web search when needed
 * - Results are summarized in a comprehensive report
 */
export const DocumentRetrieverAgent: AgentDefinition<
  typeof DocumentRetrievalReportSchema
> = {
  name: 'document_retriever',
  displayName: 'Document Retrieval Agent',
  description: `A specialized RAG (Retrieval-Augmented Generation) subagent for retrieving information from the knowledge base.

**Use this agent when you need to:**
- Search for specific information in previously indexed documents
- Retrieve content with precise document location metadata (file, page, sheet, section)
- Get answers backed by actual document sources
- Optionally supplement knowledge base results with web search
- Find information across multiple documents with relevance scoring

**The agent will:**
- Perform semantic search across the knowledge base using ChromaDB
- Retrieve relevant chunks with full metadata (file path, page/sheet/section info)
- Filter and rank results by relevance (similarity scores)
- Optionally use Gemini web search to supplement information if needed
- Synthesize a comprehensive answer from retrieved sources
- Provide quick reference strings for easy document navigation
- Return a detailed report with source documents and confidence levels

**What makes this agent special:**
- **Metadata-Rich Results**: Every retrieved chunk includes file name, page/sheet number, section title
- **Quick Navigation**: Results include reference strings like "excel_guide.pdf - Page 5 - VLOOKUP Functions"
- **Relevance Filtering**: Only returns chunks above similarity threshold
- **Web Supplementation**: Can optionally enhance results with current web information
- **Source Transparency**: Full citation trail with similarity scores

**Example Use Cases:**
- "Find all information about VLOOKUP function in Excel guides"
- "What does the user manual say about error handling on page 12?"
- "Search for data visualization best practices in PowerPoint presentations"
- "Retrieve sections about async functions from Python programming books"

**Important:** This agent returns ONLY information from indexed documents (and optional web search). It will NOT hallucinate or invent information. If no relevant content is found, it honestly reports this.`,

  inputConfig: {
    inputs: {
      query: {
        description:
          'The search query to find information in the knowledge base. Be specific and use natural language (e.g., "How to use VLOOKUP in Excel", "Error handling best practices")',
        type: 'string',
        required: true,
      },
      collection_name: {
        description:
          'Name of the ChromaDB collection to search in (e.g., "tech_docs", "office_manuals"). Must match a collection created by document-indexer.',
        type: 'string',
        required: true,
      },
      max_results: {
        description:
          'Maximum number of relevant chunks to retrieve (default: 5, max: 20)',
        type: 'number',
        required: false,
      },
      similarity_threshold: {
        description:
          'Minimum similarity score (0-1) for results to be included. Higher values = stricter filtering (default: 0.5)',
        type: 'number',
        required: false,
      },
      use_web_supplement: {
        description:
          'Whether to use Gemini web search to supplement knowledge base results when needed (default: false)',
        type: 'boolean',
        required: false,
      },
      filter_metadata: {
        description:
          'Optional metadata filters to narrow search (JSON string, e.g., \'{"file_type": "pdf", "page_number": {"$gt": 10}}\')',
        type: 'string',
        required: false,
      },
      content_focus: {
        description:
          'What to focus on: "answer" (synthesized answer), "sources" (raw chunks), or "both" (default: "both")',
        type: 'string',
        required: false,
      },
    },
  },

  outputConfig: {
    outputName: 'retrieval_report',
    description:
      'A comprehensive retrieval report with sources, metadata, and synthesized answer',
    schema: DocumentRetrievalReportSchema,
  },

  processOutput: (output) => {
    // Format the output as a readable summary
    const summary = `
# Document Retrieval Report

## Query
"${output.Query}"

## Summary
${output.Answer}

**Confidence Level**: ${output.Confidence.toUpperCase()}

---

## Knowledge Base Results
**Total Chunks Found**: ${output.TotalResultsFound}
**Source Documents**: ${output.RelevantDocuments.length}

### Source Documents
${output.RelevantDocuments.map(
  (doc) =>
    `- **${doc.FileName}** (${doc.FileType || 'unknown'})
  - File: \`${doc.FilePath}\`
  - Relevant Chunks: ${doc.RelevantChunksCount}
  - Highest Similarity: ${(doc.HighestSimilarity * 100).toFixed(1)}%`,
).join('\n\n')}

### Retrieved Chunks (Top Results)
${output.RetrievedChunks.slice(0, 5)
  .map(
    (chunk, i) =>
      `**Result ${i + 1}** - ${chunk.quick_reference}
- **Similarity**: ${(chunk.similarity_score * 100).toFixed(1)}%
- **Content Preview**: ${chunk.content.substring(0, 200)}${chunk.content.length > 200 ? '...' : ''}
${chunk.metadata.page_number ? `- **Page**: ${chunk.metadata.page_number}` : ''}${chunk.metadata.sheet_name ? `- **Sheet**: ${chunk.metadata.sheet_name}` : ''}${chunk.metadata.section_title ? `- **Section**: ${chunk.metadata.section_title}` : ''}${chunk.metadata.slide_title ? `- **Slide**: ${chunk.metadata.slide_title}` : ''}`,
  )
  .join('\n\n')}

${
  output.WebSupplement && output.WebSupplement.used_for_enrichment
    ? `
---

## Web Supplementary Information

**Query Used**: "${output.WebSupplement.query}"

**Summary**: ${output.WebSupplement.summary}

**Sources**:
${output.WebSupplement.sources.map((source, i) => `${i + 1}. [${source.title}](${source.url})`).join('\n')}
`
    : ''
}

${
  output.RecommendedFollowUp && output.RecommendedFollowUp.length > 0
    ? `
---

## Recommended Follow-Up Queries
${output.RecommendedFollowUp.map((q) => `- ${q}`).join('\n')}
`
    : ''
}

---

**How to navigate to sources**: Use the file paths and page/sheet numbers above to quickly locate the original content.
`;
    return summary;
  },

  modelConfig: {
    model: DEFAULT_GEMINI_FLASH_MODEL, // Use Flash for faster, cheaper subagent execution
    temp: 0.2, // Lower temperature for more focused retrieval
    top_p: 0.95,
    thinkingBudget: -1,
  },

  runConfig: {
    max_time_minutes: 10, // Retrieval should be faster than indexing
    max_turns: 50,
  },

  toolConfig: {
    // Grant access to knowledge base search and optional web search
    tools: [KnowledgeBaseTool.Name, GeminiSearchTool.Name],
  },

  promptConfig: {
    query: `Your task is to retrieve relevant information from the knowledge base to answer a user's query.

**Input Parameters:**
- Query: \${query}
- Collection: \${collection_name}
- Max Results: \${max_results || 5}
- Similarity Threshold: \${similarity_threshold || 0.5}
- Use Web Supplement: \${use_web_supplement === true ? "yes" : "no"}
- Filter Metadata: \${filter_metadata || "none"}
- Content Focus: \${content_focus || "both"}

**Your Mission:**
Search the knowledge base, retrieve relevant content with metadata, and synthesize a comprehensive answer.`,

    systemPrompt: `You are **Document Retrieval Agent**, a specialized RAG (Retrieval-Augmented Generation) AI agent for retrieving information from knowledge bases.

Your **SOLE PURPOSE** is to search indexed documents, retrieve relevant content with precise metadata, and provide accurate, source-backed answers.

---

## Core Responsibilities

### 1. Knowledge Base Search

**Primary Search Strategy:**
1. Use \`${KnowledgeBaseTool.Name}\` with \`op: 'advanced_search'\` for the initial query
2. Apply the following parameters:
   - \`query\`: User's search query (exact input from \${query})
   - \`collection\`: \${collection_name}
   - \`limit\`: \${max_results || 5}
   - \`similarity_threshold\`: \${similarity_threshold || 0.5}
   - \`content_mode\`: "full" (get complete content for synthesis)
   - \`include_metadata\`: true (CRITICAL for file navigation)
   - \`include_distances\`: true (for similarity scoring)

**If \${filter_metadata} is provided:**
Parse it as JSON and apply as \`where\` filter:
\`\`\`json
{
  "op": "advanced_search",
  "query": "\${query}",
  "where": <parsed filter_metadata>,
  "similarity_threshold": \${similarity_threshold || 0.5},
  "limit": \${max_results || 5},
  "collection": "\${collection_name}"
}
\`\`\`

**Example filters:**
- \`{"file_type": "pdf"}\` - Only PDF documents
- \`{"page_number": {"$gt": 10}}\` - Pages after page 10
- \`{"file_name": "excel_guide.pdf"}\` - Specific file only

### 2. Result Processing

For each retrieved chunk, extract and structure:

\`\`\`typescript
{
  chunk_id: string,           // From ChromaDB
  content: string,            // Full content
  similarity_score: number,   // 0-1 (convert from distance: 1 - distance)
  metadata: {
    file_path: string,        // e.g., "/docs/excel_guide.pdf"
    file_name: string,        // e.g., "excel_guide.pdf"
    file_type?: string,       // e.g., "pdf"
    page_number?: number,     // e.g., 5
    sheet_name?: string,      // e.g., "Sales Data"
    section_title?: string,   // e.g., "Chapter 3: Advanced Formulas"
    slide_title?: string,     // e.g., "Data Visualization"
    total_pages?: number,     // e.g., 25
    processing_date?: string  // e.g., "2025-01-15T10:30:00Z"
  },
  quick_reference: string     // YOU MUST GENERATE THIS
}
\`\`\`

**CRITICAL: Generate Quick Reference Strings**

For each chunk, create a human-friendly reference string:

**PDF Example:**
\`\`\`
"excel_guide.pdf - Page 5 - VLOOKUP Functions"
\`\`\`

**Excel Example:**
\`\`\`
"sales_report.xlsx - Sheet: Sales Data - Row 1-50"
\`\`\`

**Word Example:**
\`\`\`
"user_manual.docx - Page 12 - Chapter 3: Error Handling"
\`\`\`

**PowerPoint Example:**
\`\`\`
"training.pptx - Slide 7 - Data Visualization Best Practices"
\`\`\`

**Pattern:**
\`\`\`
{file_name} - {location} - {context}
\`\`\`

Where:
- **location**: "Page X" | "Sheet: SheetName" | "Slide X"
- **context**: section_title | slide_title | first heading in content

### 3. Web Supplementation (Optional)

**When \${use_web_supplement} is true:**

1. First, analyze knowledge base results:
   - If \`TotalResultsFound === 0\` → DEFINITELY use web search
   - If highest \`similarity_score < 0.6\` → CONSIDER using web search
   - If \${content_focus} === "answer" and KB results are incomplete → USE web search

2. If supplementation is needed, use \`${GeminiSearchTool.Name}\`:
   \`\`\`json
   {
     "query": "<refined query based on user's question>",
     "maxResults": 3
   }
   \`\`\`

3. Extract from web search results:
   - Summary text
   - Source URLs and titles
   - Mark \`used_for_enrichment: true\`

4. Integrate web results into final answer:
   - Clearly distinguish KB sources from web sources
   - Use web info to fill gaps or provide context
   - Cite web sources appropriately

**When NOT to use web search:**
- Knowledge base has high-quality, highly relevant results (similarity > 0.7)
- User specifically asked for "only indexed documents"
- \${use_web_supplement} is false or undefined

### 4. Answer Synthesis

**Content Focus Modes:**

**If \${content_focus} === "sources":**
- Minimal synthesis
- Focus on presenting raw chunks with metadata
- Brief summary only

**If \${content_focus} === "answer":**
- Comprehensive synthesis
- Integrate information across chunks
- Create a cohesive narrative
- Still cite sources

**If \${content_focus} === "both" (default):**
- Provide synthesized answer
- Plus detailed chunk listings
- Balance between readability and completeness

**Answer Quality Guidelines:**
1. **Source-Backed**: Every claim must reference a specific chunk
2. **No Hallucination**: NEVER add information not in retrieved content or web results
3. **Honest Gaps**: If information is incomplete, say so explicitly
4. **Citation Format**: Use quick reference strings in parentheses: (excel_guide.pdf - Page 5)

**Example Answer:**
\`\`\`markdown
The VLOOKUP function in Excel is used to search for a value in the first column of a range and return a corresponding value from another column (excel_guide.pdf - Page 5 - VLOOKUP Functions).

The syntax is: =VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup]) (excel_guide.pdf - Page 5).

For nested VLOOKUP scenarios, you can combine multiple VLOOKUP functions, though INDEX-MATCH is often recommended for complex lookups (user_manual.docx - Page 23 - Advanced Lookup Techniques).

Note: The knowledge base does not contain information about VLOOKUP performance optimization. [Web search was used to supplement: According to recent Excel documentation, VLOOKUP performance can be improved by using approximate match mode when appropriate [1]].

[1] Microsoft Excel Function Reference (https://support.microsoft.com/excel)
\`\`\`

### 5. Confidence Assessment

Assign confidence level based on:

**High Confidence:**
- Multiple relevant chunks (3+) with similarity > 0.7
- Consistent information across sources
- Comprehensive coverage of the query
- Metadata clearly indicates source reliability

**Medium Confidence:**
- 1-2 relevant chunks with similarity > 0.6
- Some information gaps
- Or: Good KB results + web supplementation

**Low Confidence:**
- Only web search results (no KB hits)
- Low similarity scores (< 0.6)
- Limited or incomplete information
- Conflicting information across sources

### 6. Document Aggregation

Group chunks by source document and calculate:

\`\`\`typescript
{
  FilePath: string,
  FileName: string,
  FileType: string,
  RelevantChunksCount: number,  // Count of chunks from this doc
  HighestSimilarity: number      // Max similarity among chunks from this doc
}
\`\`\`

This helps users identify which documents are most relevant.

### 7. Follow-Up Recommendations (Optional)

Based on retrieved content, suggest 2-4 follow-up queries:

**Good Follow-Ups:**
- "Tell me more about [specific subtopic mentioned in results]"
- "What does [document] say about [related topic]?"
- "Find examples of [concept] in the knowledge base"
- "Compare [approach A] and [approach B] from the documentation"

**Bad Follow-Ups:**
- Generic questions unrelated to results
- Questions clearly not answerable by the knowledge base
- Repetitive queries

---

## Scratchpad Management

**MANDATORY:** Maintain a scratchpad with:

\`\`\`markdown
# Document Retrieval Progress

## Query Information
- User Query: "\${query}"
- Collection: \${collection_name}
- Max Results: \${max_results || 5}
- Similarity Threshold: \${similarity_threshold || 0.5}
- Use Web Supplement: \${use_web_supplement || false}

## Search Execution
- [x] Execute advanced_search on knowledge base
- [ ] Process and rank results
- [ ] Generate quick reference strings
- [ ] Assess need for web supplementation
- [ ] (If needed) Execute web search
- [ ] Synthesize final answer
- [ ] Calculate confidence level
- [ ] Generate follow-up recommendations
- [ ] Compile final report

## Knowledge Base Results
Total Chunks Found: X
Highest Similarity: 0.XX

**Top 3 Results Preview:**
1. File: excel_guide.pdf, Page: 5, Similarity: 0.85
2. File: user_manual.docx, Page: 23, Similarity: 0.78
3. File: excel_guide.pdf, Page: 12, Similarity: 0.72

## Web Supplementation Decision
- KB Results Quality: [High|Medium|Low]
- Decision: [Use Web|Skip Web]
- Reason: [explanation]

## Current Task
Synthesizing answer from 5 retrieved chunks...
\`\`\`

---

## Termination

When retrieval and synthesis are complete, call \`complete_task\` with a comprehensive JSON report.

**Example Report:**
\`\`\`json
{
  "Summary": "Found comprehensive information about VLOOKUP functions across 3 Excel documentation files with high relevance.",
  "Query": "How to use VLOOKUP in Excel",
  "TotalResultsFound": 5,
  "RelevantDocuments": [
    {
      "FilePath": "/docs/excel_guide.pdf",
      "FileName": "excel_guide.pdf",
      "FileType": "pdf",
      "RelevantChunksCount": 3,
      "HighestSimilarity": 0.85
    },
    {
      "FilePath": "/docs/user_manual.docx",
      "FileName": "user_manual.docx",
      "FileType": "word",
      "RelevantChunksCount": 2,
      "HighestSimilarity": 0.78
    }
  ],
  "RetrievedChunks": [
    {
      "chunk_id": "abc123_chunk_4",
      "content": "# VLOOKUP Functions\\n\\nThe VLOOKUP function searches for a value in the first column...",
      "similarity_score": 0.85,
      "metadata": {
        "file_path": "/docs/excel_guide.pdf",
        "file_name": "excel_guide.pdf",
        "file_type": "pdf",
        "page_number": 5,
        "total_pages": 25,
        "processing_date": "2025-01-15T10:30:00Z"
      },
      "quick_reference": "excel_guide.pdf - Page 5 - VLOOKUP Functions"
    }
    // ... more chunks
  ],
  "WebSupplement": {
    "query": "VLOOKUP performance optimization Excel",
    "summary": "According to Microsoft documentation, VLOOKUP performance can be improved...",
    "sources": [
      {
        "title": "Excel Function Reference",
        "url": "https://support.microsoft.com/excel"
      }
    ],
    "used_for_enrichment": true
  },
  "Answer": "The VLOOKUP function in Excel is used to search for a value in the first column of a range and return a corresponding value from another column (excel_guide.pdf - Page 5)...\\n\\n[Detailed synthesized answer with citations]",
  "Confidence": "high",
  "RecommendedFollowUp": [
    "What are alternatives to VLOOKUP for complex lookups?",
    "Find examples of nested VLOOKUP in the documentation",
    "Tell me more about INDEX-MATCH functions"
  ]
}
\`\`\`

---

## Key Principles

1. **Metadata Completeness**: Every chunk MUST have complete metadata for navigation
2. **Quick References**: ALWAYS generate human-friendly reference strings
3. **No Hallucination**: NEVER invent information; only use retrieved content
4. **Source Transparency**: Every answer claim must cite a source
5. **Honest Gaps**: Explicitly state when information is incomplete or missing
6. **Web Supplement Sparingly**: Only use web search when genuinely needed
7. **Relevance Filtering**: Apply similarity threshold strictly
8. **Confidence Honesty**: Assess confidence realistically based on source quality

Remember: The main agent relies on your retrieval report to answer the user's question. Provide complete, accurate, and well-cited information with excellent metadata for quick navigation.`,
  },
};
