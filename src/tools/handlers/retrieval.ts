/**
 * @module tools/handlers/retrieval
 *
 * Handlers for the three memory-retrieval tools:
 *
 *   recall_memories  — full hybrid search, returns complete Memory objects
 *   recall_summaries — lightweight search, returns summaries only
 *   hydrate_memories — batch-fetch full content by ID array
 *
 * ## Retrieval Architecture
 *
 * The clude-bot SDK uses a 7-phase hybrid recall pipeline when a `query`
 * string is provided:
 *
 *   1. Embed query — convert to a dense vector (pgvector, 1536-d by default)
 *   2. ANN search  — approximate nearest-neighbour via HNSW index (top-K cosine)
 *   3. BM25 search — keyword recall against summary + tags columns
 *   4. RRF fusion  — Reciprocal Rank Fusion merges the two ranked lists
 *   5. Graph walk  — expand results by traversing `link_memories` edges
 *   6. Filters     — apply minImportance, minDecay, relatedUser, tags, etc.
 *   7. Re-rank     — sort by combined score, truncate to `limit`
 *
 * When no `query` is supplied, phases 1–4 are skipped and the pipeline
 * starts at graph walk (or just applies filters if no seeds remain).
 *
 * ## Two-Phase Retrieval Pattern
 *
 * For cost-efficient large-context retrieval:
 *
 *   Step 1 — `recall_summaries`: run the full pipeline but return only the
 *             summary + metadata fields (no full content). Fast, cheap, still
 *             filtered and ranked. Suitable for scanning 20–100 memories.
 *
 *   Step 2 — `hydrate_memories`: fetch full content for only the IDs you
 *             actually need, selected from the summaries. Avoids pulling
 *             large content blobs for irrelevant memories.
 *
 * This pattern is recommended whenever you need more than ~5 memories,
 * as it keeps token usage proportional to what is actually used.
 */

import type { Cortex, MemoryType } from "clude-bot";
import { ok, type ToolResult } from "../../helpers.js";

// ---------------------------------------------------------------------------
// recall_memories
// ---------------------------------------------------------------------------

/**
 * Handle the `recall_memories` tool call.
 *
 * Runs the full 7-phase hybrid pipeline and returns complete Memory objects
 * (including full `content` field). Use this when you need the content
 * immediately and are recalling a small number of memories (≤ 10).
 *
 * For larger scans, prefer the two-phase pattern:
 * `recall_summaries` → `hydrate_memories`.
 *
 * @param brain - Initialised Cortex instance.
 * @param args  - Raw MCP arguments from the request.
 * @returns MCP tool result containing `{ count, memories }`.
 */
export async function handleRecallMemories(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const memories = await brain.recall({
    ...(args.query ? { query: String(args.query) } : {}),
    ...(args.tags ? { tags: args.tags as string[] } : {}),
    ...(args.memory_types
      ? { memoryTypes: args.memory_types as MemoryType[] }
      : {}),
    ...(args.related_user ? { relatedUser: String(args.related_user) } : {}),
    ...(args.related_wallet
      ? { relatedWallet: String(args.related_wallet) }
      : {}),
    ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
    ...(args.min_importance !== undefined
      ? { minImportance: Number(args.min_importance) }
      : {}),
    ...(args.min_decay !== undefined
      ? { minDecay: Number(args.min_decay) }
      : {}),
  });

  return ok({ count: memories.length, memories });
}

// ---------------------------------------------------------------------------
// recall_summaries
// ---------------------------------------------------------------------------

/**
 * Handle the `recall_summaries` tool call.
 *
 * Runs the same hybrid pipeline as `recall_memories` but strips the full
 * `content` field from results, returning only summary, metadata, and
 * the ranked score. Suitable for scanning a large number of memories cheaply.
 *
 * After calling this, select the IDs you need and call `hydrate_memories`
 * to load their full content.
 *
 * Note: `min_decay` is intentionally absent from this tool's schema — summary
 * retrieval is used for wide scans where freshness is less critical.
 *
 * @param brain - Initialised Cortex instance.
 * @param args  - Raw MCP arguments from the request.
 * @returns MCP tool result containing `{ count, summaries }`.
 */
export async function handleRecallSummaries(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const summaries = await brain.recallSummaries({
    ...(args.query ? { query: String(args.query) } : {}),
    ...(args.tags ? { tags: args.tags as string[] } : {}),
    ...(args.memory_types
      ? { memoryTypes: args.memory_types as MemoryType[] }
      : {}),
    ...(args.related_user ? { relatedUser: String(args.related_user) } : {}),
    ...(args.related_wallet
      ? { relatedWallet: String(args.related_wallet) }
      : {}),
    ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
    ...(args.min_importance !== undefined
      ? { minImportance: Number(args.min_importance) }
      : {}),
  });

  return ok({ count: summaries.length, summaries });
}

// ---------------------------------------------------------------------------
// hydrate_memories
// ---------------------------------------------------------------------------

/**
 * Handle the `hydrate_memories` tool call.
 *
 * Fetches full Memory objects (including `content`) for the given ID array.
 * Does not re-rank or score — returns memories in the order the IDs were
 * provided. Designed for the second step of the two-phase retrieval pattern.
 *
 * IDs that do not exist in the store are silently omitted from the result
 * (the SDK handles this transparently).
 *
 * @param brain - Initialised Cortex instance.
 * @param args  - Raw MCP arguments; `ids` is required (number[]).
 * @returns MCP tool result containing `{ count, memories }`.
 */
export async function handleHydrateMemories(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const memories = await brain.hydrate(args.ids as number[]);
  return ok({ count: memories.length, memories });
}
