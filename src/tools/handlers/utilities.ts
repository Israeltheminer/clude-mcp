/**
 * @module tools/handlers/utilities
 *
 * Handlers for the two local utility tools:
 *
 *   infer_concepts — regex concept extraction from text (no API call)
 *   format_context — format Memory[] into an LLM-ready string (no API call)
 *
 * ## Local Execution — No API Cost
 *
 * Both tools run entirely on the local machine. There is no LLM call, no
 * network request, and no Anthropic key required:
 *
 *   infer_concepts — pure regex + pattern matching against a 12-category
 *     ontology built into the clude-bot SDK. Returns 'type:entity' tag strings
 *     synchronously with no I/O.
 *
 *   format_context — pure string formatting of an in-memory array. The SDK
 *     iterates the Memory[] and emits one formatted block per memory, ready
 *     to splice into a system prompt.
 *
 * Call these as often as needed — they are effectively free.
 *
 * ## infer_concepts
 *
 * The 12 recognized concept types:
 *   person, project, token/crypto, location, emotion, tool/technology,
 *   organisation, event, time-reference, goal, problem, decision
 *
 * Returns an array of 'type:entity' strings, e.g.:
 *   ["person:Israel", "project:clude-mcp", "tool:TypeScript"]
 *
 * Always call infer_concepts before store_memory and pass the result as
 * `tags` if you have not already generated tags manually. This ensures
 * BM25 keyword recall can find the memory via entity-name searches.
 *
 * The `source` parameter is a hint for the ontology: 'chat' biases toward
 * person / emotion / goal; 'document' biases toward organisation / project / tool.
 *
 * ## format_context
 *
 * Converts the `memories` array returned by `recall_memories` or
 * `hydrate_memories` into a human-readable block for injection into a prompt.
 *
 * Each memory is formatted as:
 *
 *   [memory_type] (importance: X.X)
 *   Summary: <summary text>
 *   <full content>
 *   Tags: tag1, tag2, tag3
 *   ---
 *
 * The output string can be prepended to a system prompt or injected as a
 * user turn to give the model access to its memories without constructing
 * the format manually.
 */

import type { Cortex, Memory } from "clude-bot";
import { ok, type ToolResult } from "../../helpers.js";

// ---------------------------------------------------------------------------
// infer_concepts
// ---------------------------------------------------------------------------

/**
 * Handle the `infer_concepts` tool call.
 *
 * Runs the built-in ontology scanner against the provided text and returns
 * an array of concept strings. The call is synchronous (no await) because
 * the SDK method is pure — it does no I/O.
 *
 * @param brain - Initialised Cortex instance (used for the SDK method).
 * @param args  - Raw MCP arguments. `summary` and `source` are required.
 * @returns MCP tool result containing `{ concepts: string[] }`.
 */
export function handleInferConcepts(
  brain: Cortex,
  args: Record<string, unknown>
): ToolResult {
  const concepts = brain.inferConcepts(
    String(args.summary),
    String(args.source),
    (args.tags as string[]) ?? []
  );
  return ok({ concepts });
}

// ---------------------------------------------------------------------------
// format_context
// ---------------------------------------------------------------------------

/**
 * Handle the `format_context` tool call.
 *
 * Formats the provided Memory array into a multi-block string suitable for
 * injection into a system prompt or user turn. The call is synchronous.
 *
 * @param brain - Initialised Cortex instance (used for the SDK method).
 * @param args  - Raw MCP arguments. `memories` is required (Memory[]).
 * @returns MCP tool result containing `{ context: string }`.
 */
export function handleFormatContext(
  brain: Cortex,
  args: Record<string, unknown>
): ToolResult {
  const context = brain.formatContext(args.memories as Memory[]);
  return ok({ context });
}
