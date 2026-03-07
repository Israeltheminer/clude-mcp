/**
 * @module tools/definitions/analysis
 *
 * JSON schema definitions for the three memory analysis and inspection tools:
 *
 *   get_stats      — Aggregate statistics across the entire memory store.
 *   get_recent     — Memories created or accessed within a time window.
 *   get_self_model — All self_model memories: identity, preferences, beliefs.
 *
 * ## When to Use These
 *
 * These three tools are primarily observational — they don't modify the memory
 * graph, they surface information about its current state:
 *
 *   get_stats      → Use at session start to understand the current memory
 *                    landscape before making recall decisions.
 *
 *   get_recent     → Use to surface what happened recently without needing a
 *                    query. Useful for "catch me up on the last 24 hours" type
 *                    requests, or to seed context at session start.
 *
 *   get_self_model → Use whenever you need to understand the persistent identity,
 *                    preferences, and working style of the user or agent. Self-model
 *                    memories decay slowest (1%/day) and represent the most stable
 *                    layer of the knowledge graph.
 *
 * ## self_model vs other types
 *
 * self_model memories are special:
 *   - Slowest decay rate (1%/day vs 7% for episodic)
 *   - Stored immediately by the agent_memory_protocol (no turn threshold)
 *   - Surfaced separately via get_self_model for quick access
 *   - Examples: "User prefers concise responses", "Agent's primary domain is TypeScript",
 *               "User works in Pacific timezone", "Israel prefers tabs over spaces"
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Schema for the get_stats tool. */
export const getStatsDef: Tool = {
  name: "get_stats",
  description:
    "Return aggregate statistics: total memory count, breakdown by type, " +
    "average importance and decay factor, and graph link counts. " +
    "Useful for understanding the current state of the memory store at a glance.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/** Schema for the get_recent tool. */
export const getRecentDef: Tool = {
  name: "get_recent",
  description:
    "Return memories created or accessed within a recent time window. " +
    "Useful for session warm-up ('what happened recently?') without needing " +
    "a specific query. Returns full Memory objects sorted by recency.",
  inputSchema: {
    type: "object",
    required: ["hours"],
    properties: {
      hours: {
        type: "number",
        minimum: 1,
        maximum: 720,
        description:
          "Look-back window in hours. E.g. 24 = last day, 168 = last week, " +
          "720 = last 30 days. Both creation time and last-access time are checked.",
      },
      memory_types: {
        type: "array",
        items: {
          type: "string",
          enum: ["episodic", "semantic", "procedural", "self_model"],
        },
        description: "Filter to specific memory types. Omit to return all types.",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 100,
        default: 20,
        description: "Maximum number of memories to return, sorted by most recent first.",
      },
    },
  },
};

/** Schema for the get_self_model tool. */
export const getSelfModelDef: Tool = {
  name: "get_self_model",
  description:
    "Return all self_model memories — the agent's current identity, preferences, " +
    "and persistent beliefs about itself and the user. These decay at 1%/day " +
    "(the slowest rate) and represent the most stable layer of the knowledge graph. " +
    "Load these at session start to ground your responses in established context.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};
