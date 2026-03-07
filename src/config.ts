/**
 * @module config
 *
 * Environment-to-config bridge for the Cortex SDK.
 *
 * ## Operational Modes
 *
 * The server supports two modes, selected by which environment variables are
 * present. Both are mutually exclusive; hosted mode takes priority.
 *
 * ### OPTION A — Hosted Mode
 *
 * Required:
 *   CORTEX_API_KEY     API key issued by the clude.ai cloud service.
 *
 * Optional:
 *   CORTEX_BASE_URL    Override the hosted endpoint (default: https://cluude.ai).
 *                      Useful for staging environments or self-hosted cloud infra.
 *
 * In hosted mode, all storage, embedding generation, and LLM inference happen
 * remotely. No local database is required. Memory content leaves your machine.
 *
 * ### OPTION B — Self-Hosted Mode
 *
 * Required:
 *   SUPABASE_URL       Your Supabase project URL.
 *   SUPABASE_KEY       Your Supabase service-role key (NOT the anon key).
 *
 * Optional:
 *   ANTHROPIC_API_KEY  Enables:
 *                        - dream(): LLM-driven memory consolidation
 *                        - score_importance(): LLM-rated importance scoring
 *                        - auto-scoring on store_memory when importance is omitted
 *                      Without this key these features throw at call time.
 *
 *   EMBEDDING_PROVIDER  "voyage" or "openai". Enables semantic (vector) search
 *                       on recall. Without it, recall falls back to keyword
 *                       matching + graph traversal only.
 *
 *   VOYAGE_API_KEY      Required when EMBEDDING_PROVIDER=voyage.
 *   OPENAI_API_KEY      Required when EMBEDDING_PROVIDER=openai.
 *
 *   CLUDE_IMPORTANCE_PROMPT
 *                       Overrides the system prompt used by score_importance().
 *                       Personalise it for your context, e.g.:
 *                       "You rate how important information is to <name>. Rate
 *                        1–10. Reply with a single integer only."
 *
 *   MEMORY_TURN_THRESHOLD        (default: 10)
 *                       Used by the agent_memory_protocol prompt. Defines how
 *                       many conversation turns pass before the agent stores
 *                       highlights and a checkpoint.
 *
 *   MEMORY_IMPORTANCE_THRESHOLD  (default: 0.4)
 *                       Used by the agent_memory_protocol prompt. Memories with
 *                       a score below this threshold are discarded rather than
 *                       stored as episodic memories.
 *
 * ## Error Behaviour
 *
 * `buildConfig()` throws synchronously at startup if the environment is
 * misconfigured. This is intentional: failing fast with a clear message is
 * better than silently degrading at the first tool call.
 */

import type { Cortex } from "clude-bot";

/** The constructor options type that Cortex accepts. */
export type CortexConfig = ConstructorParameters<typeof Cortex>[0];

/**
 * Build the Cortex SDK configuration object from environment variables.
 *
 * Called once during server bootstrap (in `brain.ts`) before the Cortex
 * instance is created. Validates consistency between related env vars and
 * returns a fully-formed config object.
 *
 * @throws {Error} When neither hosted nor self-hosted credentials are present.
 * @throws {Error} When EMBEDDING_PROVIDER is set but the matching key is absent.
 * @returns A CortexConfig object ready to pass to `new Cortex(config)`.
 */
export function buildConfig(): CortexConfig {
  const apiKey      = process.env.CORTEX_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  // ── HOSTED MODE ────────────────────────────────────────────────────────────
  // Presence of CORTEX_API_KEY selects hosted mode unconditionally.
  if (apiKey) {
    const baseUrl = process.env.CORTEX_BASE_URL;
    return {
      hosted: {
        apiKey,
        // Spread baseUrl only when explicitly set — the SDK has a sensible default.
        ...(baseUrl ? { baseUrl } : {}),
      },
    };
  }

  // ── SELF-HOSTED MODE ───────────────────────────────────────────────────────
  if (supabaseUrl && supabaseKey) {
    const anthropicApiKey    = process.env.ANTHROPIC_API_KEY;
    const embeddingProvider  = process.env.EMBEDDING_PROVIDER as "voyage" | "openai" | undefined;
    const voyageApiKey       = process.env.VOYAGE_API_KEY;
    const openaiApiKey       = process.env.OPENAI_API_KEY;

    // Guard: fail fast if the embedding key is missing.
    //
    // Without this check, the SDK would silently receive `undefined` as the
    // embedding API key, which only surfaces as a confusing auth error on the
    // first recall call — after the server has been running for minutes. A
    // startup error is far easier to diagnose.
    if (embeddingProvider === "voyage" && !voyageApiKey) {
      throw new Error("EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is not set.");
    }
    if (embeddingProvider === "openai" && !openaiApiKey) {
      throw new Error("EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set.");
    }

    const embeddingKey = embeddingProvider === "voyage" ? voyageApiKey : openaiApiKey;

    return {
      supabase: { url: supabaseUrl, serviceKey: supabaseKey },

      // Anthropic config — optional block. Enables dream() and LLM scoring.
      ...(anthropicApiKey ? { anthropic: { apiKey: anthropicApiKey } } : {}),

      // Embedding config — optional block. Enables pgvector semantic search.
      // Both provider and key must be present to activate; if only the provider
      // is set but the key validation above passed, embeddingKey is defined.
      ...(embeddingProvider && embeddingKey
        ? { embedding: { provider: embeddingProvider, apiKey: embeddingKey } }
        : {}),
    };
  }

  // ── NO VALID CONFIG ────────────────────────────────────────────────────────
  throw new Error(
    "Missing config: set CORTEX_API_KEY for hosted mode, " +
      "or SUPABASE_URL + SUPABASE_KEY for self-hosted mode."
  );
}
