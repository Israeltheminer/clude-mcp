/**
 * @module tools/definitions/retrieval
 *
 * JSON schema definitions for the three memory retrieval tools:
 *
 *   recall_memories  — Full hybrid search returning complete Memory objects.
 *   recall_summaries — Lightweight search returning summaries only.
 *   hydrate_memories — Fetch full content for specific memory IDs.
 *
 * ## Two-Phase Retrieval Pattern
 *
 * The recommended pattern for token-efficient retrieval is:
 *
 *   1. Call recall_summaries (cheap — returns only IDs + summaries)
 *   2. Read the summaries in-context to identify which memories are relevant
 *   3. Call hydrate_memories on only the relevant IDs (loads full content)
 *
 * This avoids loading the full content of every matched memory into the context
 * window, which is expensive when memories contain long text.
 *
 * Use recall_memories directly only when you need the full content of all
 * results and know the result set will be small (e.g. limit ≤ 5).
 *
 * ## Hybrid Search Pipeline
 *
 * When a query is provided, recall_memories and recall_summaries both run a
 * 7-phase hybrid retrieval pipeline internally:
 *
 *   Phase 1 — Vector similarity search (pgvector HNSW index)
 *             Finds semantically similar memories regardless of keyword overlap.
 *             Requires EMBEDDING_PROVIDER to be configured.
 *
 *   Phase 2 — Keyword/BM25 search (pg_trgm)
 *             Finds exact and fuzzy keyword matches in content + summary.
 *
 *   Phase 3 — Knowledge graph traversal (Hebbian links)
 *             Expands results by following typed edges in the memory graph.
 *
 *   Phase 4 — Tag filtering
 *             Narrows by concept tags if provided.
 *
 *   Phase 5 — Metadata filtering
 *             Applies min_importance, min_decay, memory_types, related_user.
 *
 *   Phase 6 — Score fusion (RRF — Reciprocal Rank Fusion)
 *             Merges vector and keyword rankings into a single relevance score.
 *
 *   Phase 7 — Limit + sort
 *             Returns the top-N results ordered by fused relevance score.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Shared filter properties used by both recall tools. */
const recallFilterProperties = {
  tags: {
    type: "array" as const,
    items: { type: "string" as const },
    description:
      "Filter to memories tagged with any of these values. Tags are set at " +
      "store time and auto-inferred by infer_concepts.",
  },
  memory_types: {
    type: "array" as const,
    items: {
      type: "string" as const,
      enum: ["episodic", "semantic", "procedural", "self_model"],
    },
    description: "Restrict results to these memory types.",
  },
  related_user: {
    type: "string" as const,
    description: "Scope recall to memories tagged with this user identifier.",
  },
  related_wallet: {
    type: "string" as const,
    description: "Scope recall to memories associated with this Solana wallet.",
  },
  min_importance: {
    type: "number" as const,
    minimum: 0,
    maximum: 1,
    description:
      "Only return memories with an importance score at or above this threshold. " +
      "Useful for surface-level queries that only want high-signal results.",
  },
};

/** Schema for the recall_memories tool. */
export const recallMemoriesDef: Tool = {
  name: "recall_memories",
  description:
    "Retrieve memories using hybrid search: vector similarity + keyword matching + " +
    "knowledge-graph traversal. Returns full Memory objects ranked by relevance. " +
    "For large result sets, prefer recall_summaries → hydrate_memories instead.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural language search query. Drives both vector and keyword search. " +
          "Omit to retrieve by metadata filters only (tags, type, user, etc.).",
      },
      ...recallFilterProperties,
      limit: {
        type: "number",
        minimum: 1,
        maximum: 50,
        default: 10,
        description: "Maximum number of memories to return. Hard cap: 50.",
      },
      min_decay: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Freshness filter: only return memories whose decay_factor is at or " +
          "above this value. 1.0 = just stored, 0.0 = fully decayed. " +
          "Use to exclude stale memories from recall.",
      },
    },
  },
};

/** Schema for the recall_summaries tool. */
export const recallSummariesDef: Tool = {
  name: "recall_summaries",
  description:
    "Lightweight memory retrieval — returns summaries and metadata only, " +
    "no full content. Use this as the first phase of the two-phase retrieval " +
    "pattern: scan summaries cheaply, then call hydrate_memories on the IDs " +
    "that are actually relevant. Significantly cheaper on context window tokens.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language search query. Omit to retrieve by metadata only.",
      },
      ...recallFilterProperties,
      limit: {
        type: "number",
        minimum: 1,
        maximum: 100,
        default: 20,
        description: "Maximum number of summaries to return. Higher cap than recall_memories.",
      },
    },
  },
};

/** Schema for the hydrate_memories tool. */
export const hydrateMemoriesDef: Tool = {
  name: "hydrate_memories",
  description:
    "Fetch full memory content for specific memory IDs. " +
    "Use after recall_summaries to expand only the memories you actually need " +
    "rather than loading all results into the context window. " +
    "Accepts up to 50 IDs per call.",
  inputSchema: {
    type: "object",
    required: ["ids"],
    properties: {
      ids: {
        type: "array",
        items: { type: "number" },
        minItems: 1,
        maxItems: 50,
        description:
          "Memory IDs to hydrate. Obtain these from the 'id' field in " +
          "recall_summaries or recall_memories output.",
      },
    },
  },
};
