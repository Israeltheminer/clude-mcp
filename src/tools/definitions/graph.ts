/**
 * @module tools/definitions/graph
 *
 * JSON schema definition for the knowledge graph link tool:
 *
 *   link_memories — Create a typed directed edge between two memory nodes.
 *
 * ## Knowledge Graph Architecture
 *
 * The clude memory system maintains a directed knowledge graph alongside the
 * vector store. Each memory is a node; edges (links) represent semantic
 * relationships between nodes.
 *
 * Links are typed — the link_type field defines the nature of the relationship:
 *
 *   supports    — Memory A provides evidence for memory B.
 *   contradicts — Memory A conflicts with memory B.
 *   elaborates  — Memory A adds detail to memory B.
 *   causes      — Memory A is a cause of memory B.
 *   resolves    — Memory A resolves a conflict or problem in memory B.
 *   follows     — Memory A is a temporal or logical sequel to memory B.
 *   relates     — General association when no specific type fits.
 *
 * ## Hebbian Reinforcement
 *
 * Link strength (0–1) increases automatically each time both memories are
 * retrieved together in the same recall operation. This mirrors Hebbian
 * learning: "neurons that fire together, wire together." Frequently co-recalled
 * memories develop stronger graph edges, making future co-retrieval more likely.
 *
 * The `boost_link_strength` SQL function in the Supabase schema handles this
 * reinforcement. It increments strength by a fixed delta (capped at 1.0) each
 * time the pair appears in a recall result set.
 *
 * ## Effect on Retrieval
 *
 * During Phase 3 of the hybrid recall pipeline (graph traversal), the system
 * follows outgoing edges from matched memories to discover related nodes that
 * may not have scored well on vector or keyword similarity alone. Stronger edges
 * are weighted more heavily in this traversal.
 *
 * This means: linking memories explicitly (with link_memories) directly improves
 * the quality of future retrieval, especially for memories that share context
 * but use different vocabulary.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Schema for the link_memories tool. */
export const linkMemoriesDef: Tool = {
  name: "link_memories",
  description:
    "Create a typed directed link between two memories in the knowledge graph. " +
    "Links strengthen automatically via Hebbian reinforcement each time both " +
    "memories are co-recalled. Use after storing related memories to make the " +
    "graph aware of their relationship.",
  inputSchema: {
    type: "object",
    required: ["source_id", "target_id", "link_type"],
    properties: {
      source_id: {
        type: "number",
        description: "ID of the source memory (the 'from' node in the directed edge).",
      },
      target_id: {
        type: "number",
        description: "ID of the target memory (the 'to' node in the directed edge).",
      },
      link_type: {
        type: "string",
        enum: ["supports", "contradicts", "elaborates", "causes", "resolves", "follows", "relates"],
        description:
          "Semantic relationship from source → target. " +
          "supports=A is evidence for B, contradicts=A conflicts with B, " +
          "elaborates=A adds detail to B, causes=A caused B, " +
          "resolves=A resolves a problem in B, follows=A comes after B, " +
          "relates=general association.",
      },
      strength: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.5,
        description:
          "Initial link strength 0–1. Will be reinforced automatically over time " +
          "as both memories are co-recalled. Default 0.5 is a neutral starting point.",
      },
    },
  },
};
