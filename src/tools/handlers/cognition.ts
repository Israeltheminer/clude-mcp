/**
 * @module tools/handlers/cognition
 *
 * Handlers for the three LLM-backed cognition tools:
 *
 *   decay_memories  — run type-specific importance decay (self-hosted only)
 *   dream           — consolidation → reflection → emergence cycle
 *   score_importance — LLM estimate of how important a text is (0–1)
 *
 * ## Why "Cognition"?
 *
 * These three tools are the only ones that call external APIs (Anthropic for
 * `dream` and `score_importance`) or mutate aggregate state in a non-trivial
 * way (`decay_memories`). They model the cognitive maintenance operations of
 * the memory system:
 *
 *   decay_memories   — forgetting (time-based importance erosion)
 *   dream            — consolidation (compaction + insight extraction)
 *   score_importance — evaluation (deciding what is worth remembering)
 *
 * All three are "self-hosted only" in the sense that they require direct DB
 * access. Hosted mode (CORTEX_API_KEY) does not currently support them.
 *
 * ## decay_memories
 *
 * Applies type-specific daily decay rates to all memories:
 *
 *   episodic   → 7% / day  (events fade quickly)
 *   semantic   → 2% / day  (facts are more stable)
 *   procedural → 3% / day  (procedures decay moderately)
 *   self_model → 1% / day  (identity is nearly permanent)
 *
 * Designed to be called by a cron job (daily at 3am by default).
 * Calling it manually has no negative effect — it is idempotent per day.
 *
 * ## dream
 *
 * Three-phase consolidation cycle:
 *
 *   Phase 1 (consolidation) — clusters episodic memories by topic and compacts
 *     each cluster into a semantic summary. Old episodic fragments whose content
 *     is now covered by the semantic summary have their importance reduced.
 *
 *   Phase 2 (reflection)    — the LLM reviews the new semantic memories and
 *     produces reflective observations about patterns, contradictions, or
 *     underexplored themes.
 *
 *   Phase 3 (emergence)     — the LLM generates novel insights or hypotheses
 *     by free-associating across the full memory graph. The optional `on_emerge`
 *     argument focuses this phase (e.g. "look for patterns in user behaviour").
 *
 * Designed to be called by a cron job (weekly on Sundays at 4am by default).
 *
 * ## score_importance
 *
 * Sends a short prompt to Claude asking it to rate the importance of the
 * provided description on a 0–1 scale. The system prompt used internally is:
 *
 *   > Rate the importance of this information for an AI assistant's long-term
 *   > memory on a scale of 0.0 to 1.0. Return only the number.
 *   > (Optionally overridden by CLUDE_IMPORTANCE_PROMPT in the environment.)
 *
 * This is called automatically inside `store_memory` when importance is
 * omitted and ANTHROPIC_API_KEY is set. It can also be called directly when
 * the agent wants to make an explicit gate decision before storing.
 */

import type { Cortex } from "clude-bot";
import { ok, type ToolResult } from "../../helpers.js";

// ---------------------------------------------------------------------------
// decay_memories
// ---------------------------------------------------------------------------

/**
 * Handle the `decay_memories` tool call.
 *
 * Runs the decay pass and returns the count of memories whose importance
 * score was updated. A memory is updated only if its adjusted score differs
 * from the stored value by more than the SDK's floating-point tolerance.
 *
 * @param brain - Initialised Cortex instance.
 * @returns MCP tool result containing `{ memories_updated: number }`.
 */
export async function handleDecayMemories(brain: Cortex): Promise<ToolResult> {
  const updated = await brain.decay();
  return ok({ memories_updated: updated });
}

// ---------------------------------------------------------------------------
// dream
// ---------------------------------------------------------------------------

/**
 * Handle the `dream` tool call.
 *
 * Runs the three-phase dream cycle. The `on_emerge` argument is passed
 * verbatim to the emergence phase prompt. Omit it for unguided emergence.
 *
 * The call blocks until all three phases complete — this can take 30–120
 * seconds depending on the size of the memory store and model latency.
 * The result object returned by the SDK is forwarded as-is.
 *
 * @param brain - Initialised Cortex instance.
 * @param args  - Raw MCP arguments. `on_emerge` is optional.
 * @returns MCP tool result containing `{ dream_completed: true }`.
 */
export async function handleDream(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const opts: Record<string, unknown> = {};
  if (args.on_emerge) {
    opts.onEmergence = String(args.on_emerge);
  }
  await brain.dream(opts as any);
  return ok({ dream_completed: true });
}

// ---------------------------------------------------------------------------
// score_importance
// ---------------------------------------------------------------------------

/**
 * Handle the `score_importance` tool call.
 *
 * Sends `args.description` to the importance-scoring LLM prompt and returns
 * the 0–1 score. Use this when you want to make an explicit gate decision
 * before calling `store_memory`.
 *
 * Note: `store_memory` calls this automatically when importance is omitted
 * and ANTHROPIC_API_KEY is set, so explicit calls are only needed when you
 * want to inspect the score before committing to storage.
 *
 * @param brain - Initialised Cortex instance.
 * @param args  - Raw MCP arguments. `description` is required.
 * @returns MCP tool result containing `{ importance: number }`.
 */
export async function handleScoreImportance(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const score = await brain.scoreImportance(String(args.description));
  return ok({ importance: score });
}
