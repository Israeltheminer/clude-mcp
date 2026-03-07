/**
 * @module tools/handlers/analysis
 *
 * Handlers for the three memory-analysis (read-only) tools:
 *
 *   get_stats      — aggregate statistics across the entire memory store
 *   get_recent     — memories created or accessed within the last N hours
 *   get_self_model — all memories with type "self_model"
 *
 * ## Purpose
 *
 * These tools are observability primitives. They do not modify any data;
 * they are safe to call at any frequency and have no side-effects.
 *
 * ### get_stats
 *
 * Returns a snapshot of the memory store's health:
 *   - Total memory count
 *   - Breakdown by type (episodic / semantic / procedural / self_model)
 *   - Average importance score across all memories
 *   - Average decay_factor (1.0 = never decayed, 0.0 = fully stale)
 *   - Number of knowledge-graph links
 *
 * Useful for verifying that the memory protocol is working (count should grow
 * over sessions, importance should vary, decay factors should decrease over
 * days if `decay_memories` is run on schedule).
 *
 * ### get_recent
 *
 * Returns memories whose `created_at` or `last_accessed_at` timestamp falls
 * within the look-back window. The optional `memory_types` filter and `limit`
 * allow narrowing to e.g. "the last 10 episodic memories from today".
 *
 * This is lighter than a full hybrid recall for recency-based queries:
 *   - No embedding round-trip
 *   - No vector search
 *   - Pure timestamp filter + optional type filter
 *
 * ### get_self_model
 *
 * Returns every memory of type `self_model`. These capture the agent's
 * persistent identity, preferences, and working style as expressed by the
 * user. They decay at 1%/day — the slowest rate of any type — so they remain
 * available almost indefinitely.
 *
 * The `agent_memory_protocol` prompt directs the agent to call this
 * implicitly at session start (via recall_summaries) to populate the context.
 */

import type { Cortex, MemoryType } from "clude-bot";
import { ok, type ToolResult } from "../../helpers.js";

// ---------------------------------------------------------------------------
// get_stats
// ---------------------------------------------------------------------------

/**
 * Handle the `get_stats` tool call.
 *
 * Delegates to `brain.stats()` which runs a single aggregation query.
 * Returns the stats object verbatim — its shape is defined by the clude-bot
 * SDK and may include additional fields in future versions.
 *
 * @param brain - Initialised Cortex instance.
 * @returns MCP tool result containing the stats object.
 */
export async function handleGetStats(brain: Cortex): Promise<ToolResult> {
  const stats = await brain.stats();
  return ok(stats);
}

// ---------------------------------------------------------------------------
// get_recent
// ---------------------------------------------------------------------------

/**
 * Handle the `get_recent` tool call.
 *
 * Fetches memories active within the last `hours` hours. The SDK considers
 * a memory "active" if either its `created_at` or `last_accessed_at` field
 * falls within the window.
 *
 * @param brain - Initialised Cortex instance.
 * @param args  - Raw MCP arguments. `hours` is required.
 * @returns MCP tool result containing `{ count, memories }`.
 */
export async function handleGetRecent(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const memories = await brain.recent(
    Number(args.hours),
    args.memory_types as MemoryType[] | undefined,
    args.limit !== undefined ? Number(args.limit) : undefined
  );

  return ok({ count: memories.length, memories });
}

// ---------------------------------------------------------------------------
// get_self_model
// ---------------------------------------------------------------------------

/**
 * Handle the `get_self_model` tool call.
 *
 * Returns all `self_model` memories. Takes no arguments.
 *
 * Internally, this is equivalent to calling `recall_memories` with
 * `{ memory_types: ["self_model"] }` but without the embedding overhead —
 * it does a direct type-filtered DB query.
 *
 * @param brain - Initialised Cortex instance.
 * @returns MCP tool result containing `{ count, memories }`.
 */
export async function handleGetSelfModel(brain: Cortex): Promise<ToolResult> {
  const memories = await brain.selfModel();
  return ok({ count: memories.length, memories });
}
