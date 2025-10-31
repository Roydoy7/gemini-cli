/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ToolResult } from './tools.js';
import { BasePythonTool } from './base-python-tool.js';

/**
 * Knowledge base operations
 */
export type KnowledgeBaseOperation =
  | 'store'
  | 'search'
  | 'get'
  | 'list_collections'
  | 'list_documents'
  | 'advanced_search'
  | 'delete'
  | 'delete_collection';

/**
 * Parameters for knowledge base operations
 */
export interface KnowledgeBaseParams {
  /** Operation to perform */
  op: KnowledgeBaseOperation;

  /** Markdown content to store (for store operation) */
  content?: string;

  /** Path to markdown file to store (for store operation, alternative to content) */
  file_path?: string;

  /** Search query (for search operation) */
  query?: string;

  /** Number of results to return (for search operation) */
  limit?: number;

  /** Metadata for the content */
  metadata?: {
    source_file?: string;
    title?: string;
    author?: string;
    date?: string;
    url?: string;
    language?: string; // Document language (e.g., 'en', 'zh', 'zh-CN', 'zh-TW', 'ja', 'es')
    [key: string]: string | undefined;
  };

  /** Collection name (defaults to 'default') */
  collection?: string;

  /** Advanced search and retrieval options */
  where?: Record<string, unknown>; // Metadata filtering: {"author": "John", "page": {"$gt": 10}} - also used for delete operation
  where_document?: Record<string, unknown>; // Full-text search: {"$contains": "search term"}
  content_mode?: 'chunks' | 'full' | 'metadata_only'; // Content inclusion level
  similarity_threshold?: number; // Minimum similarity score (0-1)

  /** Document management */
  document_ids?: string[]; // Specific document IDs to retrieve or delete (delete operation: either document_ids or where required)

  /** Result formatting */
  include_metadata?: boolean; // Include metadata in results (default: true)
  include_distances?: boolean; // Include similarity distances (default: true)
}

/**
 * Knowledge Base Tool - Simple storage and retrieval for markdown content
 */
export class KnowledgeBaseTool extends BasePythonTool<
  KnowledgeBaseParams,
  ToolResult
> {
  static readonly Name = 'knowledge_base';

  constructor(config: Config) {
    super(
      KnowledgeBaseTool.Name,
      'KnowledgeBase',
      `Store and retrieve markdown content using semantic similarity search. Build a persistent, searchable knowledge base that remembers information across conversations.

# WHEN TO USE
- Save complete workflows, solutions, or code patterns for future reference
- Store documentation or reference materials (via markitdown conversion)
- Search for previously saved solutions when facing similar problems

# TYPICAL WORKFLOW

## Save a complete solution
\`\`\`json
{
  "op": "store",
  "content": "# Excel Automation Solution\\n\\nComplete workflow for reading Excel data:\\n\\n\`\`\`python\\nimport xlwings as xw\\nbook = xw.Book('data.xlsx')\\nsheet = book.sheets[0]\\ndata = sheet.range('A1').expand('table').value\\n\`\`\`\\n\\nWorks with large files, tested with 10k+ rows.",
  "collection": "workflows",
  "metadata": {
    "title": "Excel Data Reading",
    "category": "automation",
    "language": "en"
  }
}
\`\`\`

## Store documentation files
\`\`\`
Step 1: markitdown-tools(op="convert_path_only", file_path="manual.pdf")
Step 2: knowledge_base(op="store", file_path="manual.md", collection="docs", metadata={"title": "User Manual", "language": "en"})
\`\`\`

## Search for solutions
\`\`\`json
{
  "op": "search",
  "query": "how to read excel files",
  "collection": "workflows",
  "limit": 3
}
\`\`\`

# OPERATIONS

## store
- \`content\`: Direct text input (workflows, solutions, code snippets)
- \`file_path\`: Load from markdown file (converted by markitdown)
- \`metadata\`: Add title, category, language for better search
- Content auto-chunks for optimal retrieval

## search
- Natural language \`query\` to find relevant content
- **Match query language to document language** (EN queries for EN docs, ZH queries for ZH docs)
- Returns top N results with similarity scores
- Use \`limit\` to control results (default: 5)

## advanced_search
- Semantic search + metadata filters
- \`where\`: Filter by metadata (e.g., \`{"category": "automation", "language": "en"}\`)
- \`where_document\`: Full-text search (e.g., \`{"$contains": "xlwings"}\`)
- \`similarity_threshold\`: Min similarity score (0-1)

## list_collections
- Show all collections and their metadata

## list_documents
- List all documents in a collection
- \`content_mode\`: "full", "chunks", or "metadata_only"

## delete
- Delete by \`document_ids\` or \`where\` filter
- Example: \`where={"source_file": "manual.pdf"}\` deletes all chunks from that file
- Requires user confirmation

## delete_collection
- Remove entire collection and all documents
- Requires user confirmation

# KEY POINTS
- **Collections**: Organize by type (e.g., "workflows", "docs", "solutions")
- **Multilingual**: Supports 50+ languages (EN, ZH, JP, etc.)
  - First use: Downloads ~400MB model (2-5 min)
  - If fails: Auto-retry or fallback to default model
- **Metadata**: Always add \`language\` field (\`"en"\`, \`"zh"\`, etc.) for better organization
- **Upsert**: Re-storing same content updates instead of duplicating
- **Storage**: Persistent in \`.gemini/knowledge_base\` directory`,
      ['chromadb', 'sentence-transformers'], // Required Python packages
      {
        properties: {
          op: {
            description:
              'Operation to perform: store (save content), search (semantic search), get (retrieve by ID), list_collections (show all collections), list_documents (list all documents in collection), advanced_search (combined semantic + metadata + full-text search), delete (delete specific documents), delete_collection (delete entire collection)',
            type: 'string',
            enum: [
              'store',
              'search',
              'get',
              'list_collections',
              'list_documents',
              'advanced_search',
              'delete',
              'delete_collection',
            ],
          },
          content: {
            description:
              'Markdown content to store (for store operation, either content or file_path required)',
            type: 'string',
          },
          file_path: {
            description:
              'Path to markdown file to store (for store operation, alternative to content)',
            type: 'string',
          },
          query: {
            description: 'Search query text (required for search operation)',
            type: 'string',
          },
          limit: {
            description:
              'Maximum number of search results to return (default: 5)',
            type: 'number',
            minimum: 1,
            maximum: 20,
          },
          metadata: {
            description:
              'Optional metadata for the content (source_file, title, author, date, url, language, etc.)',
            type: 'object',
            properties: {
              source_file: { type: 'string' },
              title: { type: 'string' },
              author: { type: 'string' },
              date: { type: 'string' },
              url: { type: 'string' },
              language: {
                type: 'string',
                description:
                  'Document language code (e.g., "en", "zh", "zh-CN", "zh-TW", "ja", "es", "fr", "de")',
              },
            },
            additionalProperties: { type: 'string' },
          },
          collection: {
            description:
              'Collection name to store/search in (default: "default")',
            type: 'string',
          },
          where: {
            description:
              'Metadata filtering (advanced_search): {"author": "John", "page": {"$gt": 10}}',
            type: 'object',
          },
          where_document: {
            description:
              'Full-text search filtering (advanced_search): {"$contains": "search term"}',
            type: 'object',
          },
          content_mode: {
            description:
              'Content inclusion level: chunks (default, semantic chunks), full (complete documents), metadata_only (just metadata)',
            type: 'string',
            enum: ['chunks', 'full', 'metadata_only'],
          },
          similarity_threshold: {
            description: 'Minimum similarity score 0-1 (advanced_search)',
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
          document_ids: {
            description:
              'Specific document IDs to retrieve (get operation) or delete (delete operation)',
            type: 'array',
            items: { type: 'string' },
          },
          include_metadata: {
            description: 'Include metadata in results (default: true)',
            type: 'boolean',
          },
          include_distances: {
            description:
              'Include similarity distances in results (default: true)',
            type: 'boolean',
          },
        },
        required: ['op'],
        type: 'object',
      },
      config,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  /**
   * KnowledgeBase operations are safe for non-interactive execution in subagents,
   * except for delete operations which require user confirmation.
   */
  protected override requiresConfirmation(
    params: KnowledgeBaseParams,
  ): boolean {
    // Delete operations require confirmation as they are destructive
    return params.op === 'delete' || params.op === 'delete_collection';
  }

  protected override validateToolParamValues(
    params: KnowledgeBaseParams,
  ): string | null {
    const { op, content, file_path, query, document_ids } = params;

    switch (op) {
      case 'store':
        if (!content && !file_path) {
          return 'Either content or file_path is required for store operation';
        }
        if (content && content.trim().length === 0) {
          return 'content cannot be empty if provided';
        }
        break;

      case 'search':
        if (!query || query.trim().length === 0) {
          return 'query is required and cannot be empty for search operation';
        }
        break;

      case 'advanced_search':
        if (!query || query.trim().length === 0) {
          return 'query is required and cannot be empty for advanced_search operation';
        }
        break;

      case 'get':
        if (!document_ids || document_ids.length === 0) {
          return 'document_ids is required and cannot be empty for get operation';
        }
        break;

      case 'delete':
        // Either document_ids or where is required for delete
        if (
          (!document_ids || document_ids.length === 0) &&
          (!params.where || Object.keys(params.where).length === 0)
        ) {
          return 'Either document_ids or where parameter is required for delete operation';
        }
        break;

      case 'delete_collection':
        // No additional validation needed - will delete the collection specified by the collection parameter
        break;

      case 'list_collections':
        // No validation needed
        break;

      case 'list_documents':
        // No validation needed - will list documents in the specified collection
        break;

      default:
        return `Unknown operation: ${op}`;
    }

    return null;
  }

  protected parseResult(
    pythonOutput: string,
    params: KnowledgeBaseParams,
  ): ToolResult {
    try {
      // Clean the output to handle potential non-JSON prefixes
      let cleanOutput = pythonOutput.trim();

      // If output starts with "Error:", extract the error part
      if (cleanOutput.startsWith('Error:')) {
        return {
          returnDisplay: `❌ **Python Error:** ${cleanOutput}`,
          llmContent: `Knowledge base operation failed: ${cleanOutput}`,
        };
      }

      // Check for SSL/network errors before attempting JSON parsing
      if (cleanOutput.includes('[SSL:') || cleanOutput.includes('CERTIFICATE')) {
        return {
          returnDisplay: `❌ **SSL Certificate Error**

The knowledge base tool encountered an SSL certificate error while downloading the multilingual embedding model.

**Possible solutions:**
1. **Retry the operation** - The model may have been partially downloaded and will resume
2. **Check your network connection** - Ensure you can access HuggingFace (huggingface.co)
3. **Try again later** - The error may be temporary

The tool will automatically fall back to a default embedding model on the next attempt.`,
          llmContent: `SSL certificate error during model download. Please retry the operation.`,
        };
      }

      if (cleanOutput.toLowerCase().includes('timeout') || cleanOutput.toLowerCase().includes('timed out')) {
        return {
          returnDisplay: `❌ **Network Timeout**

The knowledge base tool timed out while downloading the multilingual embedding model (~400MB).

**Please retry the operation** - The download will resume from where it left off.

If the issue persists, the tool will fall back to a default embedding model.`,
          llmContent: `Network timeout during model download. Please retry the operation.`,
        };
      }

      // Try to find JSON in the output (support both objects and arrays)
      const jsonMatch = cleanOutput.match(/[{[][\s\S]*[}\]]/);
      if (jsonMatch) {
        cleanOutput = jsonMatch[0];
      }

      const result = JSON.parse(cleanOutput);

      // Generate helpful response based on operation
      if (result.status === 'error' || result.error) {
        return {
          returnDisplay: `❌ **Error:** ${result.error}`,
          llmContent: `Knowledge base operation failed: ${result.error}`,
        };
      }

      if (params.op === 'store') {
        return {
          returnDisplay: `✅ **Content stored successfully!**

📄 **Source:** ${result.source || 'Direct content'}
🗂️ **Collection:** ${params.collection || 'default'}
📊 **Chunks:** ${result.chunks_stored || 0}
📝 **Characters:** ${result.total_characters || 0}`,
          llmContent: `Content successfully stored in knowledge base. ${result.chunks_stored || 0} chunks created from ${result.total_characters || 0} characters.`,
        };
      } else if (params.op === 'search') {
        const results = (result.results || []) as Array<{
          similarity?: number;
          content?: string;
        }>;
        if (results.length === 0) {
          return {
            returnDisplay: `🔍 **No results found**\n\nNo matching content found for: "${params.query}"`,
            llmContent: `No results found in knowledge base for query: "${params.query}"`,
          };
        }

        const displayResults = results
          .slice(0, 3)
          .map(
            (r, i) =>
              `**Result ${i + 1}** (similarity: ${r.similarity || 0})\n${r.content?.substring(0, 200) || ''}${(r.content?.length ?? 0) > 200 ? '...' : ''}`,
          )
          .join('\n\n');

        return {
          returnDisplay: `🔍 **Found ${results.length} results**\n\n${displayResults}`,
          llmContent: JSON.stringify(results, null, 2),
        };
      } else if (params.op === 'advanced_search') {
        const results = result.results || [];
        if (results.length === 0) {
          return {
            returnDisplay: `🔍 **No results found**\n\nQuery: "${result.query || params.query}"\nFilters applied: ${JSON.stringify(result.filters || {})}`,
            llmContent: `No results found for advanced search query: "${params.query}"`,
          };
        }

        interface SearchResult {
          similarity?: number;
          content?: string;
          metadata?: Record<string, unknown>;
        }
        const displayResults = results
          .slice(0, 3)
          .map(
            (r: SearchResult, i: number) =>
              `**Result ${i + 1}** (similarity: ${r.similarity || 0})\n${params.content_mode === 'full' ? r.content : r.content?.substring(0, 200) + '...' || ''}${r.metadata ? `\n*Metadata: ${JSON.stringify(r.metadata)}*` : ''}`,
          )
          .join('\n\n');

        return {
          returnDisplay: `🔍 **Advanced Search Results** (${results.length} found)\n\n${displayResults}`,
          llmContent: JSON.stringify(results, null, 2),
        };
      } else if (params.op === 'get') {
        const documents = result.documents || [];
        interface Document {
          id?: string;
          content?: string;
        }
        return {
          returnDisplay: `📄 **Retrieved ${documents.length} documents**\n\n${documents
            .map(
              (doc: Document, i: number) =>
                `**Document ${i + 1}**: ${doc.id}\n${params.content_mode !== 'metadata_only' ? doc.content?.substring(0, 200) + '...' || 'No content' : 'Metadata only'}`,
            )
            .join('\n\n')}`,
          llmContent: JSON.stringify(documents, null, 2),
        };
      } else if (params.op === 'list_collections') {
        const collections = result.collections || [];
        interface Collection {
          name?: string;
          metadata?: Record<string, unknown>;
        }
        return {
          returnDisplay: `📚 **Available Collections** (${collections.length})\n\n${collections
            .map(
              (col: Collection) =>
                `• **${col.name}**${col.metadata ? ` - ${JSON.stringify(col.metadata)}` : ''}`,
            )
            .join('\n')}`,
          llmContent: JSON.stringify(collections, null, 2),
        };
      } else if (params.op === 'delete') {
        const deletedCount = result.deleted_count || 0;
        const deletedIds = result.deleted_ids || [];
        const method = result.method || 'unknown';
        const whereFilter = result.where_filter;

        let displayMessage = `✅ **Documents deleted successfully!**

🗂️ **Collection:** ${result.collection || params.collection || 'default'}
🗑️ **Deleted:** ${deletedCount} document(s)
🔧 **Method:** ${method === 'by_ids' ? 'By IDs' : 'By Metadata Filter'}`;

        if (whereFilter) {
          displayMessage += `\n🔍 **Filter:** ${JSON.stringify(whereFilter)}`;
        }

        if (deletedIds.length > 0) {
          displayMessage += `\n\n**Deleted IDs${deletedIds.length > 10 ? ' (first 10)' : ''}:**\n${deletedIds
            .slice(0, 10)
            .map((id: string) => `• ${id}`)
            .join('\n')}`;
        }

        return {
          returnDisplay: displayMessage,
          llmContent: `Successfully deleted ${deletedCount} documents from collection '${result.collection || params.collection || 'default'}'. ${whereFilter ? `Filter: ${JSON.stringify(whereFilter)}` : `IDs: ${deletedIds.slice(0, 10).join(', ')}`}`,
        };
      } else if (params.op === 'delete_collection') {
        return {
          returnDisplay: `✅ **Collection deleted successfully!**

🗂️ **Deleted Collection:** ${result.deleted_collection || params.collection || 'default'}

⚠️ **Warning:** All documents in this collection have been permanently removed.`,
          llmContent: `Successfully deleted collection '${result.deleted_collection || params.collection || 'default'}' and all its documents.`,
        };
      }

      return {
        returnDisplay: `✅ Operation completed: ${params.op}`,
        llmContent: JSON.stringify(result, null, 2),
      };
    } catch (error) {
      return {
        returnDisplay: `❌ **Failed to parse results**\n\nError: ${error}\n\nRaw output:\n\`\`\`\n${pythonOutput.substring(0, 500)}...\n\`\`\``,
        llmContent: `Error parsing knowledge base results: ${error}`,
      };
    }
  }

  protected generatePythonCode(params: KnowledgeBaseParams): string {
    const {
      op,
      content = '',
      file_path = '',
      query = '',
      limit = 5,
      metadata = {},
      collection = 'default',
      where = {},
      where_document = {},
      content_mode = 'chunks',
      similarity_threshold = 0,
      document_ids = [],
      include_metadata = true,
      include_distances = true,
    } = params;

    return `
import os
import json
import hashlib
from pathlib import Path
from typing import List, Dict, Any, Optional
import chromadb
from chromadb.config import Settings

class SimpleKnowledgeBase:
    def __init__(self, collection_name: str = "default"):
        self.collection_name = collection_name

        # Create knowledge base directory
        self.kb_dir = Path(".gemini/knowledge_base")
        self.kb_dir.mkdir(parents=True, exist_ok=True)

        # Initialize Chroma client
        self.client = chromadb.PersistentClient(
            path=str(self.kb_dir),
            settings=Settings(allow_reset=True)
        )

        # Get or create collection with multilingual embedding support
        try:
            self.collection = self.client.get_collection(name=collection_name)
        except:
            # Use multilingual embedding model for better cross-language support
            # paraphrase-multilingual-MiniLM-L12-v2 supports 50+ languages including Chinese
            try:
                from chromadb.utils import embedding_functions
                import socket

                # Set socket timeout for model downloads to avoid SSL timeouts
                # Default is None (infinite), which can cause hangs on slow networks
                original_timeout = socket.getdefaulttimeout()
                socket.setdefaulttimeout(300)  # 5 minutes for model download

                try:
                    report_progress('loading', 20, 'Downloading multilingual embedding model (first time only, ~400MB)...')
                    multilingual_ef = embedding_functions.SentenceTransformerEmbeddingFunction(
                        model_name="paraphrase-multilingual-MiniLM-L12-v2"
                    )
                    report_progress('loading', 40, 'Model loaded successfully')

                    self.collection = self.client.create_collection(
                        name=collection_name,
                        embedding_function=multilingual_ef,
                        metadata={"description": f"Knowledge base collection: {collection_name}"}
                    )
                finally:
                    # Restore original socket timeout
                    socket.setdefaulttimeout(original_timeout)

            except Exception as e:
                # Fallback to default embedding if multilingual model fails
                error_msg = str(e)

                # Provide more helpful error messages for common SSL/network issues
                if 'SSL' in error_msg or 'certificate' in error_msg.lower():
                    report_progress('loading', None, f'SSL error during model download: {error_msg}')
                    print(f"Warning: SSL certificate error downloading model. Using default embedding. Error: {error_msg}")
                elif 'timeout' in error_msg.lower() or 'timed out' in error_msg.lower():
                    report_progress('loading', None, f'Timeout downloading model: {error_msg}')
                    print(f"Warning: Timeout downloading multilingual model. Using default embedding. Try again or check network.")
                else:
                    report_progress('loading', None, f'Model loading failed: {error_msg}')
                    print(f"Warning: Failed to load multilingual model, using default: {error_msg}")

                self.collection = self.client.create_collection(
                    name=collection_name,
                    metadata={"description": f"Knowledge base collection: {collection_name}"}
                )

    def chunk_text(self, text: str, chunk_size: int = 800, overlap: int = 100) -> List[str]:
        """Split text into overlapping chunks"""
        if len(text) <= chunk_size:
            return [text]

        chunks = []
        start = 0

        while start < len(text):
            end = start + chunk_size

            if end >= len(text):
                # Last chunk
                chunks.append(text[start:].strip())
                break

            # Try to find a good breaking point
            chunk = text[start:end]

            # Look for sentence endings
            last_period = chunk.rfind('.')
            last_newline = chunk.rfind('\\n\\n')  # Paragraph break
            last_exclamation = chunk.rfind('!')
            last_question = chunk.rfind('?')

            # Choose the best breaking point
            break_points = [p for p in [last_period, last_newline, last_exclamation, last_question] if p > start + chunk_size // 2]

            if break_points:
                best_break = max(break_points)
                end = start + best_break + 1

            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)

            # Move start position with overlap
            start = end - overlap if end < len(text) else end

        return [chunk for chunk in chunks if chunk.strip()]

    def store_content(self, content: str = None, file_path: str = None, metadata: Dict[str, Any] = None) -> Dict[str, Any]:
        """Store markdown content in the knowledge base"""
        if metadata is None:
            metadata = {}

        try:
            # Get content from file if file_path is provided
            if file_path:
                if not os.path.exists(file_path):
                    return {
                        "status": "error",
                        "error": f"File not found: {file_path}"
                    }

                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()

                # Auto-populate metadata from file
                file_name = os.path.basename(file_path)
                if 'source_file' not in metadata:
                    metadata['source_file'] = file_path
                if 'title' not in metadata:
                    metadata['title'] = os.path.splitext(file_name)[0]

            elif content is None:
                return {
                    "status": "error",
                    "error": "Either content or file_path must be provided"
                }

            if not content.strip():
                return {
                    "status": "error",
                    "error": "Content cannot be empty"
                }

            # Generate unique ID for this content
            content_hash = hashlib.md5(content.encode('utf-8')).hexdigest()

            # Split content into chunks
            chunks = self.chunk_text(content)

            # Prepare chunk data
            chunk_ids = []
            chunk_documents = []
            chunk_metadatas = []

            for i, chunk in enumerate(chunks):
                chunk_id = f"{content_hash}_chunk_{i}"
                chunk_ids.append(chunk_id)
                chunk_documents.append(chunk)

                chunk_metadata = {
                    "content_id": content_hash,
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                    "chunk_length": len(chunk),
                    **metadata  # Include user-provided metadata
                }
                chunk_metadatas.append(chunk_metadata)

            # Store in Chroma (use upsert to allow updating existing content)
            self.collection.upsert(
                documents=chunk_documents,
                metadatas=chunk_metadatas,
                ids=chunk_ids
            )

            return {
                "status": "success",
                "content_id": content_hash,
                "chunks_stored": len(chunks),
                "total_characters": len(content),
                "collection": self.collection_name,
                "source": file_path if file_path else "direct_content"
            }

        except Exception as e:
            return {
                "status": "error",
                "error": str(e)
            }

    def search_content(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Search for relevant content"""
        try:
            results = self.collection.query(
                query_texts=[query],
                n_results=limit
            )

            search_results = []

            if results['ids'] and results['ids'][0]:
                for i, (chunk_id, document, metadata, distance) in enumerate(zip(
                    results['ids'][0],
                    results['documents'][0],
                    results['metadatas'][0],
                    results['distances'][0] if results['distances'] else [0] * len(results['ids'][0])
                )):
                    # Convert distance to similarity score
                    similarity = max(0, 1 - distance)

                    search_results.append({
                        "chunk_id": chunk_id,
                        "content": document,
                        "similarity": round(similarity, 3),
                        "metadata": metadata,
                        "source_file": metadata.get("source_file", ""),
                        "title": metadata.get("title", ""),
                        "chunk_index": metadata.get("chunk_index", 0)
                    })

            return {
                "status": "success",
                "results": search_results,
                "total_found": len(search_results),
                "query": query
            }

        except Exception as e:
            return {"status": "error", "error": str(e), "results": []}

    def get_documents(self, document_ids: list, content_mode: str = "chunks"):
        """Get specific documents by IDs"""
        try:
            # Build include list based on content_mode (ids are always included by default)
            include = []
            if content_mode == "metadata_only":
                include.append("metadatas")
            elif content_mode == "chunks":
                include.extend(["documents", "metadatas"])
            elif content_mode == "full":
                include.extend(["documents", "metadatas"])

            results = self.collection.get(
                ids=document_ids,
                include=include
            )

            documents = []
            if results['ids']:
                for i, doc_id in enumerate(results['ids']):
                    doc_info = {"id": doc_id}

                    if content_mode != "metadata_only" and 'documents' in results:
                        doc_info["content"] = results['documents'][i]

                    if 'metadatas' in results and results['metadatas'][i]:
                        doc_info["metadata"] = results['metadatas'][i]

                    documents.append(doc_info)

            return {
                "status": "success",
                "documents": documents,
                "count": len(documents)
            }

        except Exception as e:
            return {"error": str(e)}

    def list_collections(self):
        """List all collections in the database"""
        try:
            collections = self.client.list_collections()
            return {
                "status": "success",
                "collections": [{"name": col.name, "metadata": col.metadata} for col in collections]
            }
        except Exception as e:
            return {"error": str(e)}

    def list_documents(self, content_mode: str = "metadata_only", limit: int = 100):
        """List all documents in the collection"""
        try:
            # Build include list based on content_mode
            include = ["metadatas"]
            if content_mode in ["chunks", "full"]:
                include.append("documents")

            # Get all documents (ChromaDB get() without IDs returns all)
            results = self.collection.get(
                include=include,
                limit=limit
            )

            documents = []
            if results['ids']:
                for i, doc_id in enumerate(results['ids']):
                    doc_info = {
                        "id": doc_id,
                        "metadata": results['metadatas'][i] if results['metadatas'] else {}
                    }

                    # Add content based on mode
                    if content_mode == "full" and results.get('documents'):
                        doc_info["content"] = results['documents'][i]
                    elif content_mode == "chunks" and results.get('documents'):
                        content = results['documents'][i]
                        doc_info["content_preview"] = content[:200] + "..." if len(content) > 200 else content
                        doc_info["content_length"] = len(content)

                    documents.append(doc_info)

            return {
                "status": "success",
                "collection": self.collection_name,
                "document_count": len(documents),
                "documents": documents
            }
        except Exception as e:
            return {"error": str(e)}

    def delete_documents(self, document_ids: list = None, where: dict = None) -> Dict[str, Any]:
        """Delete documents by IDs or metadata filter"""
        try:
            if not document_ids and not where:
                return {
                    "status": "error",
                    "error": "Either document_ids or where filter must be provided for deletion"
                }

            # Build delete parameters
            delete_params = {}

            if document_ids:
                # Delete by IDs
                delete_params["ids"] = document_ids
                self.collection.delete(**delete_params)
                return {
                    "status": "success",
                    "deleted_count": len(document_ids),
                    "deleted_ids": document_ids,
                    "collection": self.collection_name,
                    "method": "by_ids"
                }
            elif where:
                # Delete by metadata filter
                delete_params["where"] = where

                # Get count before deletion (for reporting)
                try:
                    pre_delete = self.collection.get(where=where, include=["metadatas"])
                    deleted_count = len(pre_delete["ids"]) if pre_delete["ids"] else 0
                    deleted_ids = pre_delete["ids"] if pre_delete["ids"] else []
                except:
                    deleted_count = 0
                    deleted_ids = []

                # Perform deletion
                self.collection.delete(**delete_params)

                return {
                    "status": "success",
                    "deleted_count": deleted_count,
                    "deleted_ids": deleted_ids[:10],  # Limit to first 10 IDs for display
                    "collection": self.collection_name,
                    "method": "by_metadata",
                    "where_filter": where
                }

        except Exception as e:
            return {
                "status": "error",
                "error": str(e)
            }

    def delete_collection(self) -> Dict[str, Any]:
        """Delete the current collection"""
        try:
            collection_name = self.collection_name

            # Check if collection exists
            try:
                self.client.get_collection(name=collection_name)
            except:
                return {
                    "status": "error",
                    "error": f"Collection '{collection_name}' not found"
                }

            # Delete the collection
            self.client.delete_collection(name=collection_name)

            return {
                "status": "success",
                "deleted_collection": collection_name,
                "message": f"Collection '{collection_name}' has been deleted"
            }
        except Exception as e:
            return {
                "status": "error",
                "error": str(e)
            }

    def advanced_search(self, query: str, limit: int = 5, where=None, where_document=None,
                       content_mode: str = "chunks", similarity_threshold: float = 0,
                       include_metadata: bool = True, include_distances: bool = True):
        """Advanced search with metadata filtering, full-text search, and content control"""
        try:
            # Build include list (ids are always included by default)
            include = ["documents"]
            if include_metadata:
                include.append("metadatas")
            if include_distances:
                include.append("distances")

            # Perform query
            query_params = {
                "query_texts": [query],
                "n_results": limit,
                "include": include
            }

            if where:
                query_params["where"] = where
            if where_document:
                query_params["where_document"] = where_document

            results = self.collection.query(**query_params)

            search_results = []
            if results['ids'] and results['ids'][0]:
                for i, (chunk_id, document) in enumerate(zip(results['ids'][0], results['documents'][0])):
                    # Calculate similarity and apply threshold
                    distance = results['distances'][0][i] if include_distances and results['distances'] else 0
                    similarity = max(0, 1 - distance)

                    if similarity < similarity_threshold:
                        continue

                    result_item = {
                        "chunk_id": chunk_id,
                        "similarity": round(similarity, 3)
                    }

                    # Add content based on mode
                    if content_mode == "full":
                        result_item["content"] = document
                    elif content_mode == "chunks":
                        # Return chunk with preview
                        result_item["content"] = document[:500] + "..." if len(document) > 500 else document
                        result_item["full_content"] = document
                    elif content_mode == "metadata_only":
                        # Only metadata, no content
                        pass

                    # Add metadata if requested
                    if include_metadata and 'metadatas' in results and results['metadatas'][0][i]:
                        result_item["metadata"] = results['metadatas'][0][i]

                    # Add distance if requested
                    if include_distances:
                        result_item["distance"] = round(distance, 4)

                    search_results.append(result_item)

            return {
                "status": "success",
                "results": search_results,
                "total_found": len(search_results),
                "query": query,
                "filters": {
                    "where": where,
                    "where_document": where_document,
                    "similarity_threshold": similarity_threshold
                }
            }

        except Exception as e:
            return {"error": str(e)}

# Main execution
def main():
    try:
        kb = SimpleKnowledgeBase("${collection}")

        operation = "${op}"

        if operation == "store":
            content_str = """${content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"""
            file_path_str = r"${file_path.replace(/\\/g, '\\\\')}"
            content = content_str if content_str else None
            file_path = file_path_str if file_path_str else None
            metadata = ${JSON.stringify(metadata)}
            result = kb.store_content(content=content, file_path=file_path, metadata=metadata)

        elif operation == "search":
            query = """${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"""
            result = kb.search_content(query, limit=${limit})

        elif operation == "get":
            document_ids = ${JSON.stringify(document_ids)}
            result = kb.get_documents(document_ids, content_mode="${content_mode}")

        elif operation == "list_collections":
            result = kb.list_collections()

        elif operation == "list_documents":
            result = kb.list_documents(content_mode="${content_mode}", limit=${limit})

        elif operation == "advanced_search":
            query = """${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"""
            where_filter = ${JSON.stringify(where)}
            where_doc_filter = ${JSON.stringify(where_document)}
            result = kb.advanced_search(
                query=query,
                limit=${limit},
                where=where_filter if where_filter else None,
                where_document=where_doc_filter if where_doc_filter else None,
                content_mode="${content_mode}",
                similarity_threshold=${similarity_threshold},
                include_metadata=${include_metadata ? 'True' : 'False'},
                include_distances=${include_distances ? 'True' : 'False'}
            )

        elif operation == "delete":
            document_ids = ${JSON.stringify(document_ids)}
            where_filter = ${JSON.stringify(where)}
            result = kb.delete_documents(
                document_ids=document_ids if document_ids else None,
                where=where_filter if where_filter else None
            )

        elif operation == "delete_collection":
            result = kb.delete_collection()

        else:
            result = {"status": "error", "error": f"Unknown operation: {operation}"}

    except Exception as e:
        result = {
            "status": "error",
            "error": str(e),
            "error_type": type(e).__name__
        }

    try:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as json_error:
        # Fallback if JSON serialization fails
        print(json.dumps({
            "status": "error",
            "error": f"JSON serialization failed: {str(json_error)}",
            "original_error": str(result) if 'result' in locals() else "Unknown"
        }))

if __name__ == "__main__":
    main()
`;
  }
}
