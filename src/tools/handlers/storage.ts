/**
 * @module tools/handlers/storage
 *
 * Handlers for the three memory-storage tools:
 *
 *   store_memory  — write a new memory, optionally auto-scoring importance
 *   export_pack   — serialize memories into a portable signed Memory Pack
 *   import_pack   — load a Memory Pack into the local memory store
 *
 * ## Auto-Importance Scoring (store_memory)
 *
 * When the caller omits the `importance` field and `ANTHROPIC_API_KEY` is
 * present in the environment, `store_memory` calls `brain.scoreImportance()`
 * before writing. The scoring prompt receives:
 *
 *   "{summary} {content[0:400]}"
 *
 * This combines the human-readable summary with just enough content for the
 * LLM to form a grounded judgment. The first 400 characters of content are
 * used rather than the full content to limit token cost.
 *
 * If scoring fails (network error, API quota) the call continues without
 * importance rather than surfacing an error — the SDK assigns its own default.
 *
 * ## Memory Pack Tools (export_pack / import_pack)
 *
 * Both tools require CortexV2. They are guarded by the `isCortexV2()` check
 * and throw `MethodNotFound` on the base Cortex class. CortexV2 is available
 * in clude-bot ≥ 2.x. The guard is duck-typed (checks for `exportPack` method)
 * to survive version mismatches gracefully.
 *
 * ### export_pack
 *
 * Builds a signed bundle of memories from three possible sources:
 *   - `memory_ids` array (explicit, ignores query/types)
 *   - `query` string (hybrid recall, filtered by `types` and `limit`)
 *   - no filter (all memories up to `limit`)
 *
 * Returns a JSON or Markdown serialisation of the pack.
 *
 * ### import_pack
 *
 * Parses a JSON string produced by `export_pack` and writes its memories.
 * An `importance_multiplier < 1` (default 0.8) deliberately dampens the
 * imported memories' importance scores so they rank below natively stored ones
 * when memory pressure forces dropping low-importance items.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Cortex, MemoryType } from "clude-bot";
import { isCortexV2 } from "../../helpers.js";
import { ok, type ToolResult } from "../../helpers.js";
import { log } from "../../log.js";

// ---------------------------------------------------------------------------
// store_memory
// ---------------------------------------------------------------------------

/**
 * Handle the `store_memory` tool call.
 *
 * @param brain - Initialised Cortex (or CortexV2) instance.
 * @param args  - Raw MCP arguments from the request.
 * @returns MCP tool result containing `{ memory_id, stored }`.
 */
export async function handleStoreMemory(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  // ------------------------------------------------------------------
  // Step 1: Resolve importance
  //   - If the caller supplied a value, use it verbatim.
  //   - If omitted AND ANTHROPIC_API_KEY is set, auto-score via LLM.
  //   - On scoring failure, proceed without — SDK will apply its default.
  // ------------------------------------------------------------------
  let importance: number | undefined =
    args.importance !== undefined ? Number(args.importance) : undefined;

  if (importance === undefined && process.env.ANTHROPIC_API_KEY) {
    try {
      const scoringText =
        `${String(args.summary)} ${String(args.content).slice(0, 400)}`.trim();
      importance = await brain.scoreImportance(scoringText);
      log(
        `Auto-scored importance: ${importance} for "${String(args.summary).slice(0, 60)}"`
      );
    } catch (scoreErr) {
      log(
        "Importance auto-scoring failed, using SDK default:",
        String(scoreErr)
      );
    }
  }

  // ------------------------------------------------------------------
  // Step 2: Persist the memory
  //
  // The Cortex `store()` method accepts camelCase keys. MCP arguments
  // arrive as snake_case, so we translate each optional field explicitly
  // rather than blindly forwarding the args object.
  // ------------------------------------------------------------------
  const id = await brain.store({
    type: args.type as MemoryType,
    content: String(args.content),
    summary: String(args.summary),
    source: String(args.source),
    ...(args.source_id ? { sourceId: String(args.source_id) } : {}),
    ...(args.tags ? { tags: args.tags as string[] } : {}),
    ...(importance !== undefined ? { importance } : {}),
    ...(args.emotional_valence !== undefined
      ? { emotionalValence: Number(args.emotional_valence) }
      : {}),
    ...(args.related_user ? { relatedUser: String(args.related_user) } : {}),
    ...(args.related_wallet
      ? { relatedWallet: String(args.related_wallet) }
      : {}),
  });

  return ok({ memory_id: id, stored: id !== null });
}

// ---------------------------------------------------------------------------
// export_pack
// ---------------------------------------------------------------------------

/**
 * Handle the `export_pack` tool call.
 *
 * Requires CortexV2. Throws `MethodNotFound` on the base Cortex class.
 *
 * @param brain - Initialised Cortex (or CortexV2) instance.
 * @param args  - Raw MCP arguments from the request.
 * @returns MCP tool result containing `{ format, memory_count, pack }`.
 *
 * @throws {McpError} MethodNotFound if CortexV2 is not available.
 */
export async function handleExportPack(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (!isCortexV2(brain)) {
    throw new McpError(
      ErrorCode.MethodNotFound,
      "export_pack requires CortexV2. " +
        "Upgrade clude-bot to v2.x or later to enable Memory Pack support."
    );
  }

  const pack = await brain.exportPack({
    name: String(args.name),
    description: String(args.description),
    ...(args.query ? { query: String(args.query) } : {}),
    ...(args.memory_ids ? { memoryIds: args.memory_ids as number[] } : {}),
    ...(args.types ? { types: args.types as MemoryType[] } : {}),
    ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
  });

  const format = (args.format as string) ?? "json";
  const output =
    format === "markdown"
      ? brain.serializePackMarkdown(pack)
      : brain.serializePack(pack);

  return ok({ format, memory_count: (pack as any).memories.length, pack: output });
}

// ---------------------------------------------------------------------------
// import_pack
// ---------------------------------------------------------------------------

/**
 * Handle the `import_pack` tool call.
 *
 * Requires CortexV2. Throws `MethodNotFound` on the base Cortex class.
 *
 * @param brain - Initialised Cortex (or CortexV2) instance.
 * @param args  - Raw MCP arguments from the request.
 * @returns MCP tool result forwarding the SDK's import result object.
 *
 * @throws {McpError} MethodNotFound if CortexV2 is not available.
 */
export async function handleImportPack(
  brain: Cortex,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (!isCortexV2(brain)) {
    throw new McpError(
      ErrorCode.MethodNotFound,
      "import_pack requires CortexV2. " +
        "Upgrade clude-bot to v2.x or later to enable Memory Pack support."
    );
  }

  const parsed = brain.parsePack(String(args.pack));
  const result = await brain.importPack(parsed, {
    ...(args.importance_multiplier !== undefined
      ? { importanceMultiplier: Number(args.importance_multiplier) }
      : {}),
    ...(args.tag_prefix ? { tagPrefix: String(args.tag_prefix) } : {}),
    ...(args.types ? { types: args.types as MemoryType[] } : {}),
  });

  return ok(result);
}
