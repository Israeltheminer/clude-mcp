/**
 * @module tools/handlers/graph
 *
 * Handler for the memory knowledge-graph tool:
 *
 *   link_memories — create a typed directed edge between two memory nodes
 *
 * ## Knowledge Graph Model
 *
 * Memories are nodes; links are typed directed edges. The graph is stored in
 * Supabase alongside the memory rows and consulted during the Graph Walk phase
 * of hybrid recall (phase 5 of 7).
 *
 * ### Link Types
 *
 * | Link type    | Meaning                                              |
 * |--------------|------------------------------------------------------|
 * | supports     | Source evidence supports the target claim            |
 * | contradicts  | Source conflicts with or disproves the target        |
 * | elaborates   | Source adds detail or nuance to the target           |
 * | causes       | Source event/fact leads to the target outcome        |
 * | resolves     | Source resolves the problem or question in target    |
 * | follows      | Source event came chronologically after target       |
 * | relates      | General relatedness (use when no stronger type fits) |
 *
 * ### Hebbian Reinforcement
 *
 * Links have a floating-point `strength` (0–1). Every time both the source
 * and target memory appear together in a recall result, the SDK increments
 * the link strength (Hebbian "neurons that fire together, wire together").
 * Links that are never co-recalled decay naturally toward 0 over time.
 *
 * When creating a link manually:
 *   - Use `strength: 1.0` for certain, explicitly stated relationships
 *   - Use `strength: 0.5` (default) for inferred or uncertain links
 *   - Use `strength: 0.3` or lower for weak/speculative connections
 *
 * ## When to Create Links
 *
 * The autonomous memory protocol (`agent_memory_protocol` prompt) recommends
 * calling `link_memories` whenever a newly stored memory clearly relates to
 * an existing one. Common patterns:
 *
 *   - A decision memory → `causes` → an outcome memory recorded later
 *   - A problem memory → `resolves` → a solution memory
 *   - A fact memory → `elaborates` → a summary memory
 *   - An event memory → `follows` → the prior event in the same narrative
 */

import type { Cortex } from "clude-bot";
import { ok, type ToolResult } from "../../helpers.js";

/**
 * Handle the `link_memories` tool call.
 *
 * Creates a typed directed edge from `source_id` to `target_id` in the
 * knowledge graph. If a link with the same source, target, and type already
 * exists, the SDK upserts it (updating the strength value).
 *
 * @param brain - Initialised Cortex instance.
 * @param args  - Raw MCP arguments. `source_id`, `target_id`, and `link_type`
 *                are required. `strength` defaults to 0.5 if omitted.
 * @returns MCP tool result containing `{ linked: true }`.
 */
export async function handleLinkMemories(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  await brain.link(
    Number(args.source_id),
    Number(args.target_id),
    args.link_type as any,
    args.strength !== undefined ? Number(args.strength) : undefined
  );

  return ok({ linked: true });
}
