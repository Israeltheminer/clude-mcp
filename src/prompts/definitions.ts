/**
 * @module prompts/definitions
 *
 * Static MCP prompt definitions for the clude memory server.
 *
 * ## What Are MCP Prompts?
 *
 * Prompts are named, templated message sequences that MCP clients can invoke
 * to get structured content back from the server. Unlike tools (which perform
 * actions), prompts return `messages` arrays — ready-made user/assistant turns
 * that can be injected into a conversation or system prompt.
 *
 * ## The Three Prompts
 *
 * ### memory_context
 *
 * The runtime recall prompt. The caller provides a `query` string and gets
 * back a pre-formatted memory context block. The server performs the hybrid
 * recall internally; the caller does not need to know about the retrieval
 * pipeline.
 *
 * Arguments:
 *   query        (required) — what to recall
 *   limit        (optional) — max memories to include (default 8)
 *   related_user (optional) — scope recall to a specific user
 *
 * ### store_conversation_turn
 *
 * A scaffolding prompt for agents that want to store conversation turns but
 * prefer to receive the store_memory call structure rather than building it
 * themselves. The server computes a canonical summary and content string;
 * the agent just needs to call store_memory with the returned values.
 *
 * Arguments:
 *   user_message (required) — what the user said
 *   agent_reply  (required) — what the agent replied
 *   related_user (optional) — user identifier for scoping
 *
 * ### agent_memory_protocol
 *
 * The autonomous memory protocol. Returns a complete four-phase instruction
 * block that is lifecycle-agnostic: it works correctly whether loaded at
 * session start, mid-conversation, after a context reset, or by a
 * programmatic agent calling getPrompt() at any point in its execution loop.
 *
 * Phase 1 (Initialize)  — runs immediately on load; warms context via recall
 * Phase 2 (Periodic)    — every N turns from load point, not from turn 0
 * Phase 3 (Reactive)    — immediate self_model storage on identity triggers
 * Phase 4 (Invariants)  — tagging, linking, scoring rules for every write
 *
 * Arguments: none — the server reads MEMORY_TURN_THRESHOLD and
 * MEMORY_IMPORTANCE_THRESHOLD from the environment and interpolates them
 * into the returned text. Changing these values takes effect on the next
 * prompt call with no server restart required.
 *
 * See `prompts/handlers/protocol.ts` for the full protocol text.
 */

/** Describes a single MCP prompt argument. */
export interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

/** Describes a single MCP prompt (name + metadata + argument list). */
export interface PromptMeta {
  name: string;
  description: string;
  arguments: PromptArg[];
}

/**
 * All MCP prompts exposed by the clude server.
 *
 * Passed verbatim into the `ListPromptsRequestSchema` response envelope.
 * Add new entries here and add a matching handler in `prompts/handlers/`.
 */
export const PROMPTS: PromptMeta[] = [
  {
    name: "memory_context",
    description:
      "Recall relevant memories for a query and format them as a " +
      "system-prompt context block. The server performs hybrid recall; " +
      "the caller receives pre-formatted text ready for injection.",
    arguments: [
      {
        name: "query",
        description: "What to recall — a natural-language question or topic.",
        required: true,
      },
      {
        name: "limit",
        description: "Max memories to include in the context block (default 8).",
        required: false,
      },
      {
        name: "related_user",
        description: "Scope recall to a specific user identifier.",
        required: false,
      },
    ],
  },

  {
    name: "store_conversation_turn",
    description:
      "Template for storing a single conversation turn as an episodic memory. " +
      "The server builds the canonical content and summary strings; " +
      "the caller invokes store_memory with the returned values.",
    arguments: [
      {
        name: "user_message",
        description: "What the user said in this turn.",
        required: true,
      },
      {
        name: "agent_reply",
        description: "What the agent replied in this turn.",
        required: true,
      },
      {
        name: "related_user",
        description: "User identifier for memory scoping.",
        required: false,
      },
    ],
  },

  {
    name: "agent_memory_protocol",
    description:
      "Returns the autonomous memory protocol — a four-phase instruction block " +
      "defining when and what to store, recall, and link. Lifecycle-agnostic: " +
      "callable at session start, mid-conversation, after a context reset, or " +
      "from programmatic agents at any point. Thresholds read from server env vars.",
    arguments: [],
  },
];
