/**
 * @module tools/definitions/cognition
 *
 * JSON schema definitions for the three LLM-powered cognition tools:
 *
 *   decay_memories   — Apply time-based importance decay to stale memories.
 *   dream            — Run the three-phase memory consolidation cycle.
 *   score_importance — Ask the LLM to rate the importance of a piece of text.
 *
 * ## Decay
 *
 * Memory importance decays over time at type-specific daily rates:
 *
 *   episodic   7%/day  — Fades fast; events become less relevant quickly.
 *   procedural 3%/day  — How-to knowledge persists longer but still fades.
 *   semantic   2%/day  — Facts persist much longer.
 *   self_model 1%/day  — Identity/preferences persist longest.
 *
 * decay_memories applies one pass of this decay to all memories. In the clude
 * setup it is scheduled via a cron job (daily at 3am) so agents don't need to
 * call it manually. Manual calls are useful for testing or forcing decay after
 * a database import.
 *
 * Decay only runs in self-hosted mode (it requires direct Supabase access).
 *
 * ## Dream Cycle
 *
 * The dream cycle converts accumulated episodic memories into distilled semantic
 * and self_model knowledge. It runs in three phases:
 *
 *   Phase 1 — CONSOLIDATION
 *     Pulls recent episodic memories, sends them to Claude with the prompt:
 *     "What are 3 high-level questions these memories can answer?"
 *     Produces 3 focal-point questions.
 *
 *   Phase 2 — REFLECTION
 *     For each focal question, recalls the most relevant memories and asks
 *     Claude to answer in one insightful sentence citing evidence.
 *     Stores each answer as a new semantic memory.
 *
 *   Phase 3 — EMERGENCE (optional)
 *     If on_emerge is set, passes it to Claude as a custom emergence instruction.
 *     E.g. "focus on patterns in how I make decisions under pressure."
 *
 * dream() requires ANTHROPIC_API_KEY and runs in self-hosted mode only.
 * In the clude setup it is scheduled weekly (Sunday 4am) via a cron job.
 *
 * ## Importance Scoring
 *
 * score_importance sends a single prompt to Claude:
 *   system: "You rate the importance of events for an AI agent. Reply with a
 *            single integer 1–10."
 *   user:   "Rate the importance of: '<text>'"
 *
 * The response is parsed to a 0–1 float (score / 10). If parsing fails or the
 * LLM times out, the SDK falls back to a heuristic score.
 *
 * The scoring prompt can be customised via CLUDE_IMPORTANCE_PROMPT in .env.
 * Personalising it for the specific user or domain significantly improves
 * signal quality.
 *
 * score_importance is called automatically inside store_memory when importance
 * is omitted and ANTHROPIC_API_KEY is set.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Schema for the decay_memories tool. */
export const decayMemoriesDef: Tool = {
  name: "decay_memories",
  description:
    "Run the decay pass: reduces importance of stale memories according to " +
    "type-specific daily rates (episodic 7%, semantic 2%, procedural 3%, self_model 1%). " +
    "Returns the number of memories updated. Self-hosted only. " +
    "Normally called by the daily cron job — manual calls are rarely needed.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/** Schema for the dream tool. */
export const dreamDef: Tool = {
  name: "dream",
  description:
    "Trigger a dream cycle: consolidation → reflection → emergence. " +
    "Reads recent episodic memories, asks Claude to identify key questions, " +
    "answers each question as a semantic memory, then optionally runs a custom " +
    "emergence instruction. Requires ANTHROPIC_API_KEY. Self-hosted only. " +
    "Normally called by the weekly cron job — manual calls trigger on-demand consolidation.",
  inputSchema: {
    type: "object",
    properties: {
      on_emerge: {
        type: "string",
        description:
          "Optional instruction passed to the emergence phase of the dream cycle. " +
          "Guides what patterns Claude looks for. " +
          "E.g. 'focus on recurring decision patterns' or " +
          "'identify what frustrates the user most'.",
      },
    },
  },
};

/** Schema for the score_importance tool. */
export const scoreImportanceDef: Tool = {
  name: "score_importance",
  description:
    "Use the LLM to estimate how important a piece of information is (0–1 scale). " +
    "Requires ANTHROPIC_API_KEY. Falls back to a heuristic score if the LLM fails. " +
    "This tool is called automatically inside store_memory when importance is omitted " +
    "and ANTHROPIC_API_KEY is set — you only need to call it directly if you want to " +
    "gate on the score before deciding whether to store at all.",
  inputSchema: {
    type: "object",
    required: ["description"],
    properties: {
      description: {
        type: "string",
        description:
          "The text to score for importance. Combine the memory summary + " +
          "first ~400 chars of content for best results. Max 500 chars sent to LLM.",
      },
    },
  },
};
