/**
 * @module self-model/synthesize
 *
 * Generates grounded self_model entries by analyzing recent episodic and
 * semantic memories. Runs after the dream cycle to populate the identity
 * layer with observations that modify future behavior.
 *
 * ## The self_model vs semantic boundary
 *
 * Litmus test: "does knowing this change how I BEHAVE next time?"
 *   Yes → self_model  (modifies actions, tone, approach, defaults)
 *   No  → semantic    (a fact about the world — even if user-provided)
 *
 * ## Two categories
 *
 *   1. USER — preferences/expectations with behavioral implications
 *      ("User verifies fixes manually → always include a verification step")
 *
 *   2. ENTITY — interaction patterns that improve outcomes
 *      ("Asking one clarifying question before implementation gets better results")
 *
 * Deduplication: existing self_model summaries are passed to the LLM so it
 * only produces genuinely new observations. If nothing new is found, nothing
 * is stored — the module is a no-op rather than generating filler.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Cortex } from "clude-bot";
import { log } from "../log.js";
import { isMetaReflective } from "../tools/handlers/storage.js";

const RECENT_HOURS = 24 * 3;       // look back 3 days
const MAX_EPISODIC = 30;
const MAX_SEMANTIC = 20;
const MAX_NEW_ENTRIES = 3;          // at most 3 new self_model entries per run
const MODEL = "claude-haiku-4-5-20251001";

export interface SynthesisResult {
  generated: number;
  skipped: number;
  entries: Array<{ summary: string; category: "user" | "entity" }>;
  dryRun: boolean;
}

function getAnthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY not set — cannot synthesize self-model");
  }
  return new Anthropic({ apiKey: key });
}

/**
 * Run a self-model synthesis pass.
 *
 * @param brain   - Initialised Cortex instance.
 * @param dryRun  - If true, generates observations but does not store them.
 * @returns Summary of what was generated/stored.
 */
export async function synthesizeSelfModel(
  brain: Cortex,
  dryRun = false,
): Promise<SynthesisResult> {
  const result: SynthesisResult = {
    generated: 0,
    skipped: 0,
    entries: [],
    dryRun,
  };

  const [episodic, semantic, existing] = await Promise.all([
    brain.recent(RECENT_HOURS, ["episodic"], MAX_EPISODIC),
    brain.recent(RECENT_HOURS, ["semantic"], MAX_SEMANTIC),
    brain.selfModel(),
  ]);

  if (episodic.length + semantic.length < 5) {
    log("self-model: too few recent memories for synthesis, skipping");
    return result;
  }

  const existingSummaries = existing
    .map((m) => m.summary)
    .filter(Boolean);

  const recentContext = [
    ...episodic.map(
      (m) => `[episodic] ${m.summary}`,
    ),
    ...semantic.map(
      (m) => `[semantic] ${m.summary}`,
    ),
  ].join("\n");

  const existingContext = existingSummaries.length > 0
    ? `\nEXISTING SELF-MODEL (do NOT repeat these):\n${existingSummaries.map((s) => `- ${s}`).join("\n")}`
    : "";

  const anthropic = getAnthropicClient();

  const prompt = [
    "You are analyzing an AI agent's recent interaction history to extract behavioral observations.",
    "",
    "IMPORTANT — self_model vs semantic:",
    "Self-model entries answer: \"does knowing this change how I BEHAVE next time?\"",
    "Only output observations where the answer is YES — things that modify actions, tone,",
    "approach, or defaults in future interactions.",
    "",
    "Facts about the world (tools, libraries, system architecture) are NOT self-model",
    "even if the user mentioned them. Those belong in semantic memory.",
    "",
    "RECENT MEMORIES:",
    recentContext,
    existingContext,
    "",
    `Output up to ${MAX_NEW_ENTRIES} NEW behavioral observations not already covered.`,
    "Each must be on its own line, prefixed with its category:",
    "",
    "  USER: <preference, working style, or expectation that changes how to interact>",
    "  ENTITY: <behavioral pattern — what approach works better or worse>",
    "",
    "The observation must include the BEHAVIORAL IMPLICATION — what to do differently:",
    "",
    "  Good: \"USER: User verifies fixes manually → always include a verification step\"",
    "  Good: \"USER: User context-switches across repos → keep explanations self-contained\"",
    "  Good: \"ENTITY: Asking one clarifying question before implementation gets better results\"",
    "",
    "  Bad:  \"USER: User's project uses Supabase + Anthropic\" (tech stack fact → semantic)",
    "  Bad:  \"USER: User manages multiple codebases\" (fact with no behavioral implication)",
    "  Bad:  \"ENTITY: I am becoming more self-aware\" (meta-reflective, not actionable)",
    "",
    "- Do NOT repeat anything in EXISTING SELF-MODEL",
    "- If nothing genuinely new with a behavioral implication exists, reply: NONE",
    "",
    "Output only the observations, one per line. No numbering, no extra text.",
  ].join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });

  const block = response.content[0];
  const text = block?.type === "text" ? block.text.trim() : "";

  if (!text || text === "NONE") {
    log("self-model: synthesis found nothing new");
    return result;
  }

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("USER:") || l.startsWith("ENTITY:"));

  for (const line of lines.slice(0, MAX_NEW_ENTRIES)) {
    const isUser = line.startsWith("USER:");
    const category = isUser ? "user" as const : "entity" as const;
    const observation = line.replace(/^(?:USER|ENTITY):\s*/, "").trim();

    if (!observation || observation.length < 10) {
      result.skipped++;
      continue;
    }

    if (isMetaReflective(observation)) {
      log(`self-model: rejected meta-reflective synthesis: "${observation.slice(0, 80)}"`);
      result.skipped++;
      continue;
    }

    if (dryRun) {
      result.entries.push({ summary: observation, category });
      result.generated++;
      continue;
    }

    try {
      const id = await brain.store({
        type: "self_model",
        content: `${category === "user" ? "User observation" : "Entity observation"}: ${observation}`,
        summary: observation.slice(0, 300),
        source: "self-model-synthesis",
        tags: ["self_model", category === "user" ? "user_preference" : "entity_behavior"],
        importance: 0.7,
      });

      if (id) {
        result.entries.push({ summary: observation, category });
        result.generated++;
        log(`self-model: stored ${category} observation: "${observation.slice(0, 80)}"`);
      }
    } catch (err) {
      log(`self-model: failed to store observation: ${String(err)}`);
      result.skipped++;
    }
  }

  return result;
}
