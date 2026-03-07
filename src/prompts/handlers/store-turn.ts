/**
 * @module prompts/handlers/store-turn
 *
 * Handler for the `store_conversation_turn` MCP prompt.
 *
 * ## Purpose
 *
 * `store_conversation_turn` is a scaffolding prompt. It takes a user message
 * and an agent reply, builds the canonical content and summary strings, and
 * returns an instruction message telling the agent exactly how to call
 * `store_memory`. The agent doesn't need to construct the memory schema
 * manually — the prompt handles that.
 *
 * ## Design Notes
 *
 * ### Why a Prompt Instead of a Tool?
 *
 * A tool would be simpler for a direct "save this turn" action. A prompt is
 * used here because:
 *
 *   1. It gives the caller visibility — the returned message shows what will
 *      be stored before store_memory is called, making it auditable.
 *   2. The caller can modify the suggested values before calling store_memory.
 *   3. It demonstrates how prompts can scaffold tool usage patterns.
 *
 * In practice, agents following `agent_memory_protocol` don't use this
 * prompt — they call `store_memory` directly. This prompt is for MCP clients
 * that prefer the structured scaffolding pattern.
 *
 * ## Content Format
 *
 * The stored content follows the canonical turn format:
 *
 *   User: <user_message>
 *   Assistant: <agent_reply>
 *
 * The summary is the first 80 characters of the user message (with ellipsis
 * if truncated), prefixed with "Conversation: " to signal its origin.
 *
 * ## Tags
 *
 * The returned instruction asks the agent to call `infer_concepts` first and
 * pass the result as `tags`. This ensures BM25 keyword recall can find the
 * memory via entity names.
 */

/**
 * Handle the `store_conversation_turn` prompt.
 *
 * Return type is intentionally inferred — see memory-context.ts for the
 * rationale (local alias vs MCP SDK union type mismatch).
 *
 * @param args - Prompt arguments. `user_message` and `agent_reply` are required.
 */
export function handleStoreConversationTurn(args: Record<string, unknown>) {
  const userMsg = String(args.user_message ?? "");
  const agentReply = String(args.agent_reply ?? "");
  const relatedUser = args.related_user ? String(args.related_user) : undefined;

  // Build canonical content and summary strings.
  const content = `User: ${userMsg}\nAssistant: ${agentReply}`;
  const summary = `Conversation: ${userMsg.slice(0, 80)}${userMsg.length > 80 ? "…" : ""}`;

  return {
    description: "Store this conversation turn as an episodic memory",
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            "Call the store_memory tool with these values:",
            `- type: "episodic"`,
            `- content: ${JSON.stringify(content)}`,
            `- summary: ${JSON.stringify(summary)}`,
            `- source: "chat"`,
            ...(relatedUser
              ? [`- related_user: ${JSON.stringify(relatedUser)}`]
              : []),
            `- tags: (call infer_concepts on the content first, pass the result)`,
          ].join("\n"),
        },
      },
    ],
  };
}
