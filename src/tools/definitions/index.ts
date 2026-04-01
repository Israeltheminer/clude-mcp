/**
 * @module tools/definitions/index
 *
 * Aggregator for all MCP tool definitions.
 *
 * ## Why a Separate Aggregator?
 *
 * Each functional category of tools (storage, retrieval, graph, analysis,
 * cognition, utilities) is defined in its own file with focused documentation.
 * This aggregator exists to:
 *
 *   1. Produce the single `TOOLS` array that `ListToolsRequestSchema` returns
 *   2. Keep import trees shallow — callers only need this one file
 *   3. Make it trivial to add or remove tool categories in the future
 *
 * ## Tool Inventory (13 tools total)
 *
 * Storage (3):
 *   store_memory   — write a new memory with optional auto-scoring
 *   export_pack    — serialize memories to a portable signed bundle
 *   import_pack    — load a Memory Pack into the store
 *
 * Retrieval (3):
 *   recall_memories  — full hybrid search → Memory objects
 *   recall_summaries — lightweight hybrid search → summaries only
 *   hydrate_memories — batch-fetch full content by ID array
 *
 * Graph (1):
 *   link_memories  — create a typed directed edge between memories
 *
 * Analysis (3):
 *   get_stats      — aggregate counts + average importance/decay
 *   get_recent     — memories created/accessed within N hours
 *   get_self_model — all self_model memories
 *
 * Cognition (3):
 *   decay_memories  — run type-specific decay pass (self-hosted only)
 *   dream           — consolidation → reflection → emergence cycle
 *   score_importance — LLM-scored importance for a description string
 *
 * Utilities (2):
 *   infer_concepts — regex concept extraction, local, zero latency
 *   format_context — format Memory[] into an LLM-ready string, local
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  storeMemoryDef,
  exportPackDef,
  importPackDef,
} from "./storage.js";

import {
  recallMemoriesDef,
  recallSummariesDef,
  hydrateMemoriesDef,
} from "./retrieval.js";

import { linkMemoriesDef } from "./graph.js";

import {
  getStatsDef,
  getRecentDef,
  getSelfModelDef,
} from "./analysis.js";

import {
  decayMemoriesDef,
  dreamDef,
  scoreImportanceDef,
} from "./cognition.js";

import { inferConceptsDef, formatContextDef } from "./utilities.js";
import { ingestSessionsDef } from "./ingestion.js";

/**
 * All 13 MCP tool definitions, in canonical display order.
 *
 * Order is intentional:
 *   - Storage first (write path), then Retrieval (read path)
 *   - Graph follows (linking retrieved memories)
 *   - Analysis for observability
 *   - Cognition for maintenance operations
 *   - Utilities last (local helpers with no side-effects)
 *
 * Passed verbatim into the `ListToolsRequestSchema` response envelope.
 */
export const TOOLS: Tool[] = [
  // Storage
  storeMemoryDef,
  exportPackDef,
  importPackDef,

  // Retrieval
  recallMemoriesDef,
  recallSummariesDef,
  hydrateMemoriesDef,

  // Graph
  linkMemoriesDef,

  // Analysis
  getStatsDef,
  getRecentDef,
  getSelfModelDef,

  // Cognition
  decayMemoriesDef,
  dreamDef,
  scoreImportanceDef,

  // Ingestion
  ingestSessionsDef,

  // Utilities (local, zero latency)
  inferConceptsDef,
  formatContextDef,
];
