/**
 * @module tools/definitions/storage
 *
 * JSON schema definitions for the three memory storage tools:
 *
 *   store_memory  — Persist a new memory with auto-scoring and concept inference.
 *   export_pack   — Bundle memories into a portable, shareable Memory Pack.
 *   import_pack   — Ingest a Memory Pack into the local memory store.
 *
 * ## Memory Types
 *
 * Every memory is classified into one of four types, each with its own decay
 * rate and retrieval priority:
 *
 *   episodic   — Events and conversations. Decays fastest (7%/day). Represents
 *                "what happened" — specific moments in time.
 *
 *   semantic   — Facts and distilled knowledge. Decays slowly (2%/day).
 *                Represents "what is known" — durable truths extracted from
 *                experience. The dream cycle produces semantic memories.
 *
 *   procedural — How-to knowledge and step-by-step processes. Moderate decay
 *                (3%/day). Represents "how to do things".
 *
 *   self_model — Identity, preferences, working style. Slowest decay (1%/day).
 *                Represents "who I am" — persistent beliefs about the agent
 *                or user that should survive across many sessions.
 *
 * ## Memory Packs (CortexV2 only)
 *
 * Memory Packs are signed, self-contained JSON bundles that can be exported
 * from one agent and imported into another. They are useful for:
 *   - Seeding a new agent with domain knowledge
 *   - Sharing context between collaborating agents
 *   - Archiving memories before resetting a database
 *
 * export_pack and import_pack require CortexV2. If the installed version of
 * clude-bot only exposes the base Cortex class, these tools return MethodNotFound.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Schema for the store_memory tool. */
export const storeMemoryDef: Tool = {
  name: "store_memory",
  description:
    "Persist a new memory. Returns the memory ID on success. " +
    "If importance is omitted and ANTHROPIC_API_KEY is set, importance is " +
    "auto-scored via LLM before storing. Tags are auto-generated via infer_concepts " +
    "if not supplied. Memories are embedded and linked to the knowledge graph automatically.",
  inputSchema: {
    type: "object",
    required: ["type", "content", "summary", "source"],
    properties: {
      type: {
        type: "string",
        enum: ["episodic", "semantic", "procedural", "self_model"],
        description:
          "Memory classification. Determines decay rate and retrieval priority. " +
          "episodic=events/conversations (7%/day decay), " +
          "semantic=facts/knowledge (2%/day), " +
          "procedural=how-to steps (3%/day), " +
          "self_model=identity/preferences (1%/day, slowest).",
      },
      content: {
        type: "string",
        description:
          "Full memory content stored verbatim. May be encrypted at rest if " +
          "encryption is enabled in the SDK config. Max 10,000 characters.",
      },
      summary: {
        type: "string",
        description:
          "Short human-readable summary (max ~200 chars). Used for retrieval " +
          "scoring and lightweight recall via recall_summaries. Should capture " +
          "the essential meaning without the full detail.",
      },
      source: {
        type: "string",
        description:
          "Origin identifier for provenance tracking. Use consistent values: " +
          "'chat', 'document', 'tool', 'checkpoint', 'dream', etc.",
      },
      source_id: {
        type: "string",
        description:
          "Optional external ID for deduplication. If a memory with the same " +
          "source_id already exists, the store may skip insertion. " +
          "E.g. a message ID or document hash.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Topic tags for keyword retrieval. If omitted, call infer_concepts " +
          "first and pass the result here. Tags are used for both full-text " +
          "search and concept-graph traversal.",
      },
      importance: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Importance score 0–1. Controls decay speed and recall ranking. " +
          "Omit to auto-score via LLM (requires ANTHROPIC_API_KEY). " +
          "Falls back to 0.5 if no key is configured.",
      },
      emotional_valence: {
        type: "number",
        minimum: -1,
        maximum: 1,
        description:
          "Emotional sentiment of the memory: -1 (strongly negative) to +1 " +
          "(strongly positive). Default 0 (neutral). Used for mood-aware retrieval.",
      },
      related_user: {
        type: "string",
        description:
          "User identifier to scope this memory. Enables per-user memory " +
          "isolation in multi-user or multi-agent deployments. Pass a stable " +
          "user ID, email, or handle.",
      },
      related_wallet: {
        type: "string",
        description:
          "Solana wallet address to associate with this memory. Used in " +
          "on-chain agent contexts to link memories to a wallet identity.",
      },
    },
  },
};

/** Schema for the export_pack tool (CortexV2 only). */
export const exportPackDef: Tool = {
  name: "export_pack",
  description:
    "Export a portable Memory Pack — a signed, self-contained bundle of memories " +
    "that can be shared between agents or imported later. Returns JSON or Markdown. " +
    "Requires CortexV2 (included in clude-bot ≥ 2.x).",
  inputSchema: {
    type: "object",
    required: ["name", "description"],
    properties: {
      name: {
        type: "string",
        description: "Human-readable pack name shown when the pack is imported.",
      },
      description: {
        type: "string",
        description: "What this pack contains and its intended use.",
      },
      query: {
        type: "string",
        description:
          "Natural language query to select which memories to include. " +
          "Uses the same hybrid recall as recall_memories. " +
          "Overridden by memory_ids if both are provided.",
      },
      memory_ids: {
        type: "array",
        items: { type: "number" },
        description:
          "Specific memory IDs to include. Takes priority over query. " +
          "Obtain IDs from recall_summaries or recall_memories.",
      },
      types: {
        type: "array",
        items: { type: "string", enum: ["episodic", "semantic", "procedural", "self_model"] },
        description: "Filter by memory type. Ignored when memory_ids is provided.",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 200,
        default: 50,
        description: "Maximum number of memories to include in the pack.",
      },
      format: {
        type: "string",
        enum: ["json", "markdown"],
        default: "json",
        description:
          "'json' returns a machine-readable signed bundle (for import_pack). " +
          "'markdown' returns a human-readable document for review or sharing.",
      },
    },
  },
};

/** Schema for the import_pack tool (CortexV2 only). */
export const importPackDef: Tool = {
  name: "import_pack",
  description:
    "Import memories from a Memory Pack JSON string. " +
    "Applies an importance multiplier to distinguish imported memories from " +
    "natively-created ones, preventing pack flooding of the knowledge graph. " +
    "Requires CortexV2 (included in clude-bot ≥ 2.x).",
  inputSchema: {
    type: "object",
    required: ["pack"],
    properties: {
      pack: {
        type: "string",
        description:
          "Memory Pack JSON string, as returned by export_pack with format='json'. " +
          "Must be a valid signed pack — unsigned or tampered packs are rejected.",
      },
      importance_multiplier: {
        type: "number",
        minimum: 0.1,
        maximum: 1.0,
        default: 0.8,
        description:
          "Scales down imported memory importance scores. Default 0.8 means " +
          "imported memories start at 80% of their original importance, making " +
          "them slightly less prominent than native memories in retrieval.",
      },
      tag_prefix: {
        type: "string",
        description:
          "Optional string prepended to all tags on imported memories, e.g. " +
          "'imported' or 'agent-x'. Useful for tracking provenance in " +
          "multi-agent memory pools.",
      },
      types: {
        type: "array",
        items: { type: "string", enum: ["episodic", "semantic", "procedural", "self_model"] },
        description: "Only import memories of these types. Omit to import all types.",
      },
    },
  },
};
