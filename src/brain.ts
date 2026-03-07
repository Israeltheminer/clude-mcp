/**
 * @module brain
 *
 * Cortex SDK bootstrap — creates and initialises the active memory brain.
 *
 * ## Cortex vs CortexV2
 *
 * clude-bot ships two brain classes:
 *
 *   Cortex   — Base class. Full memory API: store, recall, hydrate, link,
 *              stats, decay, dream, score_importance, infer_concepts, etc.
 *
 *   CortexV2 — Extends Cortex with the Memory Pack API: exportPack,
 *              importPack, serializePack, serializePackMarkdown, parsePack.
 *              Fully backwards-compatible — every Cortex method is available.
 *
 * `createBrain()` always tries CortexV2 first. If the installed version of
 * clude-bot does not export CortexV2 (older releases), it falls back to the
 * base Cortex class. The rest of the server uses `isCortexV2()` (helpers.ts)
 * to conditionally expose Memory Pack tools.
 *
 * ## Initialisation Order
 *
 * Callers MUST await `createBrain()` before registering MCP tool handlers.
 * Internally, `brain.init()` is called before the promise resolves. This call:
 *
 *   1. Establishes the Supabase connection pool (self-hosted mode)
 *   2. Verifies the database schema is present and compatible
 *   3. Warms the embedding client (if EMBEDDING_PROVIDER is set)
 *   4. Wires up the event bus used by the dream cycle
 *
 * If `init()` is skipped, tool calls that touch the database will fail with
 * unhelpful "connection not ready" errors rather than clean startup failures.
 *
 * ## Shutdown
 *
 * Callers are responsible for calling `brain.destroy()` on SIGINT/SIGTERM.
 * `destroy()` is synchronous and stops the dream scheduler + cleans up the
 * event bus. It does NOT close the Supabase connection pool (the SDK leaves
 * that to the process exit).
 */

import { Cortex } from "clude-bot";
import type { CortexConfig } from "./config";

/**
 * Create and initialise the active memory brain.
 *
 * Tries to use `CortexV2` for Memory Pack support. Falls back to the base
 * `Cortex` class if CortexV2 is not exported by the installed clude-bot
 * version. Always calls `brain.init()` before returning.
 *
 * The dynamic import pattern is used so the try/catch is scoped only to the
 * module import itself — any errors from the constructor or `init()` will
 * propagate to the caller without being swallowed.
 *
 * @param config - Cortex constructor options, built by `buildConfig()`.
 * @returns A fully-initialised Cortex (or CortexV2) instance, ready for use.
 *
 * @throws If the database schema is missing or unreachable (self-hosted mode).
 * @throws If the CORTEX_API_KEY is invalid (hosted mode).
 */
export async function createBrain(config: CortexConfig): Promise<Cortex> {
  let BrainClass: typeof Cortex;

  try {
    // CortexV2 extends Cortex and is fully backwards-compatible.
    // Prefer it whenever available to unlock Memory Pack tools.
    const { CortexV2 } = await import("clude-bot");
    BrainClass = CortexV2 as unknown as typeof Cortex;
  } catch {
    // CortexV2 not available in this version of clude-bot.
    // Fall back silently to the base Cortex class.
    // Memory Pack tools (export_pack / import_pack) will return MethodNotFound.
    const { Cortex: C } = await import("clude-bot");
    BrainClass = C;
  }

  const brain = new BrainClass(config);

  // Must complete before any tool handlers are registered.
  // Establishes DB connections, verifies schema, warms the embedding client.
  await brain.init();

  return brain;
}
