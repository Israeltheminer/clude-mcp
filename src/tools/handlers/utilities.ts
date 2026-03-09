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

import Anthropic from "@anthropic-ai/sdk";
import type { Cortex, Memory } from "clude-bot";
import { ok, type ToolResult } from "../../helpers.js";

// ---------------------------------------------------------------------------
// infer_concepts — LLM-based, domain-agnostic
// ---------------------------------------------------------------------------

/**
 * Extract concept tags from a memory summary using claude-haiku.
 *
 * No predefined ontology — the model reads what is actually in the text and
 * returns 3–6 lowercase snake_case tags specific to that content. Works for
 * any domain: code, cooking, music, research, personal notes, etc.
 *
 * Falls back to an empty array if ANTHROPIC_API_KEY is not set or the call
 * fails, so the tool never throws.
 */
async function inferConceptsLLM(
  summary: string,
  source: string,
  tags: string[]
): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  try {
    const anthropic = new Anthropic({ apiKey });

    const tagHint =
      tags.length > 0
        ? `\nExisting tags (merge relevant ones): ${tags.slice(0, 10).join(", ")}`
        : "";
    const sourceHint = source ? `\nSource context: ${source}` : "";

    const { content } = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      messages: [
        {
          role: "user",
          content:
            `Extract 3–6 concept tags from this memory. ` +
            `Rules: lowercase snake_case only (e.g. "pasta_recipe", "merge_conflict", "sleep_tracking"). ` +
            `Be specific to the actual content — no generic labels. ` +
            `Return a JSON array of strings, nothing else.` +
            sourceHint +
            tagHint +
            `\n\nMemory: ${summary.slice(0, 600)}`,
        },
      ],
    });

    const text = (content[0] as { text: string }).text?.trim() ?? "[]";
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];

    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((t): t is string => typeof t === "string" && /^[a-z][a-z0-9_]{1,39}$/.test(t))
      .slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Handle the `infer_concepts` tool call.
 *
 * Delegates to claude-haiku for domain-agnostic tag extraction — no hardcoded
 * ontology, no domain assumptions. Returns an empty array (never throws) when
 * ANTHROPIC_API_KEY is unavailable.
 *
 * @param brain - Initialised Cortex instance (unused).
 * @param args  - Raw MCP arguments. `summary` and `source` are required.
 * @returns MCP tool result containing `{ concepts: string[] }`.
 */
export async function handleInferConcepts(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const concepts = await inferConceptsLLM(
    String(args.summary ?? ""),
    String(args.source ?? ""),
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
