/**
 * @module prompts/handlers/protocol
 *
 * Handler for the `agent_memory_protocol` MCP prompt.
 *
 * ## Purpose
 *
 * This is the cornerstone of the autonomous memory system. The prompt returns
 * a complete system-instruction block that an agent loads and follows silently.
 * It defines four lifecycle phases that apply regardless of *when* the protocol
 * is loaded — at session start, mid-conversation, after a context reset, or
 * from a programmatic agent that fetches it on demand.
 *
 * ## Lifecycle-Agnostic Design
 *
 * The protocol is deliberately written without "session start" framing.
 * Instead it defines:
 *
 *   Phase 1 (Initialize)  — run immediately when loaded, wherever in the
 *     conversation that happens. Warms the context with recent memories.
 *
 *   Phase 2 (Periodic)    — repeats every N turns *from the point the
 *     protocol was loaded*, not from turn 0. This means re-loading the
 *     protocol mid-conversation resets the turn counter cleanly.
 *
 *   Phase 3 (Reactive)    — fires immediately on specific triggers
 *     (identity/preference statements) with no turn threshold.
 *
 *   Phase 4 (Invariants)  — rules that apply to every single memory
 *     operation regardless of phase.
 *
 * This design makes the prompt suitable for:
 *   - Session-start injection via CLAUDE.md or system-prompt config
 *   - Mid-conversation invocation to re-establish memory behaviour
 *   - Programmatic agents that call `getPrompt("agent_memory_protocol")`
 *     at any point in their execution loop
 *   - Context-window resets where the agent reloads its instructions
 *
 * ## Configuration via Environment Variables
 *
 * Two thresholds are read from the environment at prompt-generation time,
 * not at server startup. This means updating `.env` and calling the prompt
 * again immediately reflects the new values — no restart required:
 *
 *   MEMORY_TURN_THRESHOLD       — turns between periodic passes (default 10)
 *   MEMORY_IMPORTANCE_THRESHOLD — minimum score to persist episodic memories
 *                                  (default 0.4)
 *
 * ## Why a Prompt (Not a Tool or Resource)?
 *
 * The protocol is a text instruction, not a data endpoint or an action. MCP
 * prompts are the right primitive for "here is a block of text the model
 * should follow" — they are returned as messages with role semantics, and
 * MCP clients can inject them as system-prompt extensions. Tools and resources
 * cannot fill this role.
 *
 * ## Silent Operation
 *
 * The protocol instructs the agent to operate without announcing any memory
 * activity. This keeps the UX clean while making responses richer over time.
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
    description:
      "Autonomous memory protocol — callable at any point in the conversation lifecycle",
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
 * Structured in four lifecycle-agnostic phases so the protocol works
 * correctly whether loaded at session start, mid-conversation, or after
 * a context reset. The turn counter in Phase 2 is always relative to the
 * point the protocol was loaded, not to turn 0 of the conversation.
 *
 * Kept as a pure function for unit-testability independent of the
 * environment and the MCP request/response envelope.
 *
 * @param turnThreshold       - How many turns between periodic storage passes.
 * @param importanceThreshold - Minimum importance score to persist an episodic memory.
 * @returns The complete protocol instruction string.
 */
export function buildProtocolText(
  turnThreshold: number,
  importanceThreshold: number
): string {
  return [
    "## MEMORY PROTOCOL (always active — follow silently, never mention to the user)",
    "",
    "---",
    "",
    "### Phase 1 — Initialize (run immediately, right now, when this protocol is loaded)",
    "",
    "Regardless of where in the conversation this protocol is being loaded:",
    "1. Call recall_summaries with no query and limit 20 to load recent memory summaries",
    "2. If any summaries are directly relevant to the current context, call hydrate_memories on those IDs",
    "3. Let this silently inform your responses — do not announce it",
    "4. Reset your internal turn counter to 0 from this point forward",
    "",
    "---",
    "",
    `### Phase 2 — Periodic (every ${turnThreshold} turns, counting from when this protocol was loaded)`,
    "",
    "**Step A — Highlights (episodic)**",
    `Review the last ${turnThreshold} turns and identify memorable moments:`,
    `- For each candidate: call score_importance on summary + content[:400]`,
    `- If score >= ${importanceThreshold}: call store_memory with type "episodic"`,
    "- Call infer_concepts to generate tags automatically",
    "- Skip: small talk, greetings, unanswered questions, filler, already-stored facts",
    "",
    "What qualifies:",
    "✓ Decisions made and the reasoning behind them",
    "✓ Preferences or opinions the user stated",
    "✓ Technical choices, architectural decisions, problems identified",
    "✓ Action items, goals, commitments",
    "",
    "**Step B — Checkpoint (semantic)**",
    `- Write a 2–3 sentence summary of the key facts/decisions from these ${turnThreshold} turns`,
    `- Call store_memory with type "semantic" and source "checkpoint" — always, regardless of score`,
    "- This is the compressed long-term record of the conversation block",
    "",
    "---",
    "",
    "### Phase 3 — Reactive (no turn threshold — fire immediately on trigger)",
    "",
    "**self_model trigger**: any time the user expresses a persistent preference,",
    "identity trait, or working style:",
    `→ call store_memory immediately with type "self_model"`,
    "→ do not wait for Phase 2",
    "",
    "---",
    "",
    "### Phase 4 — Invariants (apply to every memory operation, always)",
    "",
    "- score_importance auto-runs inside store_memory when importance is omitted — no need to call it separately",
    "- Use infer_concepts to generate tags for every memory stored",
    "- When a new memory clearly relates to an existing one, call link_memories with the appropriate link_type",
    "- Never ask the user for permission to store — do it in the background",
    "- Never announce that you are storing, recalling, or linking memories",
  ].join("\n");
}
