/**
 * @module prompts/handlers/memory-context
 *
 * Handler for the `memory_context` MCP prompt.
 *
 * ## Purpose
 *
 * `memory_context` is the "give me my memories about X" prompt. The caller
 * provides a query string; the server performs a full hybrid recall and
 * returns the results formatted as an LLM-ready context block. This lets
 * clients inject relevant memories into a conversation without knowing the
 * details of the retrieval pipeline.
 *
 * ## Behaviour
 *
 * 1. Run `brain.recall()` with the query, limit, and optional user scope.
 * 2. Pass the resulting Memory[] through `brain.formatContext()` to produce
 *    a multi-block formatted string.
 * 3. Return the string inside a `user` message so it can be inserted as
 *    the next turn in a conversation.
 *
 * ## Result Shape
 *
 * When memories exist:
 *
 *   Here is what I remember that's relevant:
 *
 *   [episodic] (importance: 0.8)
 *   Summary: ...
 *   ...
 *   Tags: tag1, tag2
 *   ---
 *   [semantic] (importance: 0.6)
 *   ...
 *
 * When no memories match the query:
 *
 *   I have no relevant memories for this query.
 *
 * ## Limit Default
 *
 * The default limit is 8. This is intentionally conservative — injecting
 * too many memories into a context window costs tokens and may dilute
 * relevance. For wider recall, the caller should pass an explicit `limit`.
 */

import type { Cortex } from "clude-bot";

/**
 * Handle the `memory_context` prompt.
 *
 * Return type is intentionally inferred (not annotated with a local alias).
 * A local `PromptResult` interface causes TypeScript to reject the value as
 * incompatible with the MCP SDK's `GetPromptResult` union — even though the
 * runtime shape is identical. Letting TypeScript infer avoids the mismatch.
 *
 * @param brain - Initialised Cortex instance.
 * @param args  - Prompt arguments. `query` is required.
 */
export async function handleMemoryContext(
  brain: Cortex,
  args: Record<string, unknown>
) {
  const query = String(args.query ?? "");
  const limit = args.limit ? Number(args.limit) : 8;
  const relatedUser = args.related_user ? String(args.related_user) : undefined;

  const memories = await brain.recall({
    query,
    ...(relatedUser && { relatedUser }),
    limit,
  });

  const context = brain.formatContext(memories);

  return {
    description: `Memory context for: "${query}"`,
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            memories.length > 0
              ? `Here is what I remember that's relevant:\n\n${context}`
              : "I have no relevant memories for this query.",
        },
      },
    ],
  };
}
