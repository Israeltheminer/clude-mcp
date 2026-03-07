/**
 * @module prompts/handlers/protocol
 *
 * Handler for the `agent_memory_protocol` MCP prompt.
 *
 * ## Purpose
 *
 * This is the cornerstone of the autonomous memory system. The prompt returns
 * a complete system-instruction block that an agent loads once at session
 * start and follows silently throughout the conversation. It defines:
 *
 *   - What to do on session initialization (warm recall)
 *   - What to evaluate and store every N turns (the turn threshold)
 *   - What to store immediately without waiting for the threshold
 *   - How to tag, link, and score everything consistently
 *
 * ## Configuration via Environment Variables
 *
 * Two thresholds are read from the environment at prompt-generation time:
 *
 *   MEMORY_TURN_THRESHOLD      — how many turns between storage passes (default 10)
 *   MEMORY_IMPORTANCE_THRESHOLD — minimum score to persist an episodic memory (default 0.4)
 *
 * This means changing these values in `.env` takes effect on the next session
 * start — no code changes or redeploys required. Agents always get the
 * server's current configuration rather than a stale cached copy.
 *
 * ## Why a Prompt (Not a Tool or Resource)?
 *
 * The protocol is a text instruction, not a data endpoint or an action. MCP
 * prompts are the right primitive for "here is a block of text the model
 * should follow" — they are returned as messages with role semantics, and
 * many MCP clients (Claude Desktop, Cursor) can inject them as system-prompt
 * extensions. Tools and resources cannot play this role.
 *
 * ## Silent Operation
 *
 * The protocol explicitly instructs the agent to operate silently — to never
 * announce that it is storing or recalling. This keeps memory operations
 * invisible to the user while making the agent's responses richer over time.
 *
 * ## Protocol Structure
 *
 * 1. Session start   — run recall_summaries to warm the context
 * 2. Every N turns   — Step A (episodic highlights) + Step B (semantic checkpoint)
 * 3. Immediately     — store self_model memories on any identity statement
 * 4. Always          — score before store, infer_concepts for tags, link related memories
 */

/**
 * Handle the `agent_memory_protocol` prompt.
 *
 * Reads `MEMORY_TURN_THRESHOLD` and `MEMORY_IMPORTANCE_THRESHOLD` from the
 * environment at call time (not at module load) so that value changes are
 * reflected without a server restart.
 *
 * Return type is intentionally inferred — see memory-context.ts for the
 * rationale (local alias vs MCP SDK union type mismatch).
 */
export function handleAgentMemoryProtocol() {
  const turnThreshold = Number(process.env.MEMORY_TURN_THRESHOLD ?? 10);
  const importanceThreshold = Number(
    process.env.MEMORY_IMPORTANCE_THRESHOLD ?? 0.4
  );

  const protocol = buildProtocolText(turnThreshold, importanceThreshold);

  return {
    description: "Autonomous memory protocol — load once at session start",
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: protocol,
        },
      },
    ],
  };
}

/**
 * Build the full protocol instruction text with thresholds interpolated.
 *
 * Kept as a pure function so it can be unit-tested independently of the
 * environment and the MCP request/response envelope.
 *
 * @param turnThreshold       - How many turns between storage passes.
 * @param importanceThreshold - Minimum importance score to store episodic memories.
 * @returns The complete protocol instruction string.
 */
export function buildProtocolText(
  turnThreshold: number,
  importanceThreshold: number
): string {
  return [
    "## MEMORY PROTOCOL (always active — follow silently, never mention to the user)",
    "",
    "### On session start",
    "1. Call recall_summaries with no query and limit 20 to load recent memory summaries into context",
    "2. If any summaries are directly relevant to the current task, call hydrate_memories on those IDs",
    "3. Let this context silently inform your responses — do not announce it",
    "",
    `### Every ${turnThreshold} conversation turns`,
    "",
    "**Step A — Highlights (episodic)**",
    `Review the last ${turnThreshold} turns and identify memorable moments:`,
    "- For each one: call score_importance on the summary + content",
    `- If score >= ${importanceThreshold}: call store_memory with type "episodic"`,
    "- Call infer_concepts on the content to generate tags automatically",
    "- Skip: small talk, greetings, questions with no answer, filler, already-stored facts",
    "",
    "**Step B — Checkpoint (semantic)**",
    `- Write a 2–3 sentence summary of the key facts/decisions from these ${turnThreshold} turns`,
    `- Call store_memory with type "semantic" and source "checkpoint" — always, regardless of score`,
    "- This is the compressed long-term record of the session block",
    "",
    "### What qualifies as episodic",
    "✓ Decisions made and the reasoning behind them",
    "✓ Preferences or opinions the user stated",
    "✓ Technical choices, architectural decisions, problems identified",
    "✓ Action items, goals, commitments",
    "✗ Small talk, pleasantries, repeated information, unanswered questions",
    "",
    "### self_model — store immediately (no turn threshold)",
    "Any time the user expresses a persistent preference, identity trait, or working style:",
    `→ call store_memory immediately with type "self_model"`,
    "→ do not wait for the turn threshold",
    "",
    "### Always",
    "- score_importance runs before every store_memory call (auto-runs inside store_memory if omitted)",
    "- Use infer_concepts to generate tags for every memory stored",
    "- When a new memory clearly relates to an existing one, call link_memories with the appropriate link_type",
    "- Never ask the user for permission to store — do it in the background",
  ].join("\n");
}
