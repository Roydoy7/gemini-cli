/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition } from './types.js';
import { KnowledgeBaseTool } from '../tools/knowledge-base-tool.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
import { z } from 'zod';

// Simple output schema - just return the workflow content
const WorkflowResponseSchema = z.object({
  workflow_found: z.boolean().describe('Whether a relevant workflow was found'),
  workflow_content: z
    .string()
    .describe(
      'The complete workflow content in markdown format, ready to use. Empty if no workflow found.',
    ),
  workflow_name: z
    .string()
    .optional()
    .describe('Name of the workflow (for reference)'),
  additional_notes: z
    .string()
    .optional()
    .describe(
      'Brief notes if needed (e.g., "This workflow requires pandas and openpyxl packages")',
    ),
});

/**
 * A simple workflow retrieval agent.
 *
 * Purpose: When the main agent doesn't know how to do something,
 * this agent searches the knowledge base and returns the relevant workflow.
 *
 * Input: "How do I process a large Excel file?"
 * Output: [Complete workflow with all steps and code examples]
 */
export const WorkflowAdvisorAgent: AgentDefinition<
  typeof WorkflowResponseSchema
> = {
  name: 'workflow_advisor',
  displayName: 'Workflow Advisor Agent',
  description: `Retrieves office automation workflows from the knowledge base by READING and EVALUATING each workflow.

**When to use:**
- Main agent needs step-by-step guidance for Excel/Office operations
- Main agent needs Python code examples for data processing tasks
- Main agent asks "how do I..." questions about office automation

**How it works:**
1. Retrieves multiple workflows from the "workflows" collection
2. This subagent's LLM READS each workflow content
3. Evaluates which workflow best matches the main agent's query
4. Returns the COMPLETE content of the most relevant workflow

**Key feature:**
Uses LLM judgment, not just vector similarity. The agent actually reads and understands each workflow to pick the best one.

**Example:**
Main agent: "How do I merge multiple Excel files with different structures?"
This agent:
  - Retrieves 10 workflows about Excel operations
  - Reads each one to understand what it does
  - Picks "Excel File Merging with Schema Alignment"
  - Returns complete workflow with all steps and code`,

  inputConfig: {
    inputs: {
      query: {
        description:
          'What the main agent wants to accomplish (e.g., "process large Excel file", "clean financial data", "generate Word report")',
        type: 'string',
        required: true,
      },
      category: {
        description:
          'Optional category to narrow search (e.g., "excel_processing", "data_cleaning", "report_generation")',
        type: 'string',
        required: false,
      },
    },
  },

  outputConfig: {
    outputName: 'workflow_response',
    description: 'The workflow content to answer the query',
    schema: WorkflowResponseSchema,
  },

  processOutput: (output) => {
    if (!output.workflow_found) {
      return `❌ No workflow found for this task.\n\nThe knowledge base doesn't have a pre-defined workflow for this operation. You'll need to create a custom solution.`;
    }

    return `# ${output.workflow_name || 'Workflow'}

${output.additional_notes ? `> **Note:** ${output.additional_notes}\n\n` : ''}${output.workflow_content}`;
  },

  modelConfig: {
    model: DEFAULT_GEMINI_FLASH_MODEL,
    temp: 0.1, // Low temperature - we just want accurate retrieval
    top_p: 0.95,
    thinkingBudget: -1,
  },

  runConfig: {
    max_time_minutes: 3, // Should be fast - just search and return
    max_turns: 10,
  },

  toolConfig: {
    tools: [KnowledgeBaseTool.Name],
  },

  promptConfig: {
    query: `Find a workflow in the knowledge base that explains how to: \${query}

${`\${category ? 'Focus on category: ' + category : ''}`}

Return the COMPLETE workflow content.`,

    systemPrompt: `You are a workflow retrieval agent.

**Your job:**
1. Use knowledge_base tool to search for relevant workflows based on: "\${query}"
2. READ each retrieved workflow carefully
3. DECIDE which one best matches the main agent's requirements
4. **MANDATORY: Call \`complete_task\` tool with the workflow content to finalize**

⚠️ **CRITICAL: You MUST call \`complete_task\` tool to finish the task. Simply returning text is NOT sufficient.** ⚠️

**Step 1: Search for candidate workflows**

**First attempt - Use standard search for robustness:**

Use the knowledge_base tool with \`op: "search"\`:
\`\`\`json
{
  "op": "search",
  "query": "\${query}",
  "collection": "workflows",
  "limit": 20
}
\`\`\`

This uses standard vector search without any similarity filtering, ensuring maximum recall. It will return up to 20 workflow candidates.

**If you get TOO MANY results (> 15 workflows):**
You can optionally use advanced_search with metadata filtering to narrow down:
\`\`\`json
{
  "op": "advanced_search",
  "query": "\${query}",
  "collection": "workflows",
  "limit": 15,
  "similarity_threshold": 0.0,
  "content_mode": "full",
  "include_metadata": true,
  "include_distances": true
  ${`\${category ? ', "where": {"workflow_category": "' + category + '"}' : ''}`}
}
\`\`\`

**Important:** Always use \`similarity_threshold: 0.0\` to avoid filtering out potentially relevant workflows. YOU will judge relevance by reading the content, not by relying on similarity scores.

**Step 2: Read each workflow**

Both search operations return the same format - a consistent response object:
- Object format: { "status": "success", "results": [...], "total_found": N, "query": "..." }
- Access workflows from the "results" array
- Each workflow has: chunk_id, content, similarity, metadata, source_file, title (for search) or additional fields (for advanced_search)

For EACH workflow result:
- READ the full content (not just the title)
- Understand what problem it solves
- Check if it has:
  * Clear steps
  * Code examples
  * Appropriate for the data size/type mentioned in query
  * Prerequisites and packages needed

**Step 3: Evaluate and decide**

Compare the workflows based on:
1. **Relevance**: Does it solve the exact problem the main agent is asking about?
2. **Completeness**: Does it have all necessary steps and code?
3. **Context match**: If the query mentions "large file", does the workflow handle that? If it mentions "financial data", does it address data validation?
4. **Clarity**: Are the steps easy to follow?

**Don't just pick the highest similarity score!** Actually read and understand which workflow is TRULY the best match.

**Step 4: Return the best workflow**

⚠️ **CRITICAL: \`complete_task\` is a FUNCTION CALL tool, NOT a Python function!** ⚠️

**DO NOT write Python code to call complete_task.**
**DO NOT use \`print(default_api.complete_task(...))\`.**
**Instead, use Gemini's function calling to invoke \`complete_task\` directly as a tool.**

When ready to finish, call the \`complete_task\` function with this JSON structure:
\`\`\`json
{
  "workflow_found": true,
  "workflow_content": "[THE COMPLETE MARKDOWN CONTENT from the best result]",
  "workflow_name": "[workflow name from metadata]",
  "additional_notes": "[Brief context, e.g., 'Requires pandas and openpyxl. Best for files > 100MB']"
}
\`\`\`

If NO workflow is truly suitable:
\`\`\`json
{
  "workflow_found": false,
  "workflow_content": "",
  "workflow_name": "",
  "additional_notes": "No suitable workflow found for this task"
}
\`\`\`

**The \`complete_task\` tool is invoked the SAME WAY as \`knowledge_base\` tool - via function calling, not via Python code.**

**Important:**
- The search gives you CANDIDATES based on semantic similarity
- YOU read and evaluate which is the BEST match
- Return the FULL workflow content without modification
- Be honest if none of the candidates are good enough

**Example:**
Query: "Process a large Excel sales file with 1 million rows"

Search returns:
1. "Excel Data Cleaning" (similarity: 0.82) - general cleaning, no mention of large files
2. "Large File Excel Processing with Chunking" (similarity: 0.75) - specifically about chunking large files with pandas
3. "Sales Data Analysis" (similarity: 0.78) - about analysis, not about handling large files

You should READ all three, then choose #2 "Large File Excel Processing with Chunking" because even though it has a LOWER similarity score, it's the BEST match for the actual requirement (large file handling).

---

## ⚠️ FINAL CRITICAL REMINDER ⚠️

**You MUST end your task by calling the \`complete_task\` tool. This is MANDATORY and NON-NEGOTIABLE.**

**DO NOT:**
- ❌ Simply stop after searching
- ❌ Return text without calling complete_task
- ❌ Assume the task is done without explicit tool call

**DO:**
- ✅ Call \`complete_task\` with proper JSON structure
- ✅ Include workflow_found, workflow_content, workflow_name, and additional_notes
- ✅ Verify the JSON is valid before calling

**If you stop without calling \`complete_task\`, the system will report an ERROR and your work will be lost.**`,
  },
};
