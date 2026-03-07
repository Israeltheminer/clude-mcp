/**
 * @module tools/index
 *
 * Registers all MCP tool handlers on the given Server instance.
 *
 * ## Responsibilities
 *
 * This module owns two things:
 *
 *   1. `ListToolsRequestSchema` handler — returns the static TOOLS array so
 *      MCP clients can discover what tools are available and their schemas.
 *
 *   2. `CallToolRequestSchema` handler — the central dispatch router that
 *      maps incoming tool names to their individual handler functions and
 *      applies uniform error wrapping.
 *
 * ## Dispatch Strategy
 *
 * Tool names are dispatched via a `switch` statement. Each case delegates to
 * a typed handler function in the appropriate handler module:
 *
 *   storage.*    → store_memory, export_pack, import_pack
 *   retrieval.*  → recall_memories, recall_summaries, hydrate_memories
 *   graph.*      → link_memories
 *   analysis.*   → get_stats, get_recent, get_self_model
 *   cognition.*  → decay_memories, dream, score_importance
 *   utilities.*  → infer_concepts, format_context
 *
 * ## Error Handling
 *
 * The outer try/catch in the dispatch handler applies two rules:
 *
 *   1. If the error is already an `McpError` (e.g. thrown by a handler that
 *      detects a CortexV2 requirement), it is re-thrown unchanged so the MCP
 *      client receives the precise error code.
 *
 *   2. Any other error (Supabase failure, SDK exception, unexpected throw) is
 *      wrapped in `McpError(InternalError, message)`. The raw error message is
 *      preserved so the client can see what went wrong.
 *
 * ## Extension
 *
 * To add a new tool:
 *   1. Add its JSON schema definition to the appropriate file under
 *      `src/tools/definitions/` (or create a new category file).
 *   2. Export the definition from `src/tools/definitions/index.ts`.
 *   3. Write a handler function in the appropriate file under
 *      `src/tools/handlers/` (or create a new category file).
 *   4. Add a `case` branch here in the dispatch switch.
 */

import type { Cortex } from "clude-bot";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { TOOLS } from "./definitions/index.js";

// Handler functions — one import per category module
import {
  handleStoreMemory,
  handleExportPack,
  handleImportPack,
} from "./handlers/storage.js";

import {
  handleRecallMemories,
  handleRecallSummaries,
  handleHydrateMemories,
} from "./handlers/retrieval.js";

import { handleLinkMemories } from "./handlers/graph.js";

import {
  handleGetStats,
  handleGetRecent,
  handleGetSelfModel,
} from "./handlers/analysis.js";

import {
  handleDecayMemories,
  handleDream,
  handleScoreImportance,
} from "./handlers/cognition.js";

import {
  handleInferConcepts,
  handleFormatContext,
} from "./handlers/utilities.js";

/**
 * Register all tool-related request handlers on the MCP server.
 *
 * Must be called after the server is constructed and before it connects to
 * the transport. The `brain` parameter must be fully initialised
 * (`brain.init()` already awaited) before this function is called.
 *
 * @param server - The MCP Server instance to register handlers on.
 * @param brain  - The fully initialised Cortex (or CortexV2) instance.
 */
export function registerToolHandlers(server: Server, brain: Cortex): void {
  // -----------------------------------------------------------------------
  // Tool discovery — MCP clients call this to learn what tools exist.
  // Returns the static TOOLS array defined in src/tools/definitions/index.ts.
  // -----------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  // -----------------------------------------------------------------------
  // Tool dispatch — routes incoming calls to the correct handler function.
  // -----------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    try {
      switch (name) {
        // --- Storage -------------------------------------------------------
        case "store_memory":
          return await handleStoreMemory(brain, args as Record<string, unknown>);

        case "export_pack":
          return await handleExportPack(brain, args as Record<string, unknown>);

        case "import_pack":
          return await handleImportPack(brain, args as Record<string, unknown>);

        // --- Retrieval -----------------------------------------------------
        case "recall_memories":
          return await handleRecallMemories(brain, args as Record<string, unknown>);

        case "recall_summaries":
          return await handleRecallSummaries(brain, args as Record<string, unknown>);

        case "hydrate_memories":
          return await handleHydrateMemories(brain, args as Record<string, unknown>);

        // --- Graph ---------------------------------------------------------
        case "link_memories":
          return await handleLinkMemories(brain, args as Record<string, unknown>);

        // --- Analysis (read-only, no side-effects) -------------------------
        case "get_stats":
          return await handleGetStats(brain);

        case "get_recent":
          return await handleGetRecent(brain, args as Record<string, unknown>);

        case "get_self_model":
          return await handleGetSelfModel(brain);

        // --- Cognition (LLM-backed / mutation) -----------------------------
        case "decay_memories":
          return await handleDecayMemories(brain);

        case "dream":
          return await handleDream(brain, args as Record<string, unknown>);

        case "score_importance":
          return await handleScoreImportance(brain, args as Record<string, unknown>);

        // --- Utilities (local, synchronous) --------------------------------
        case "infer_concepts":
          return handleInferConcepts(brain, args as Record<string, unknown>);

        case "format_context":
          return handleFormatContext(brain, args as Record<string, unknown>);

        // --- Unknown -------------------------------------------------------
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }
    } catch (err) {
      // Pass MCP errors through unchanged — they carry an intentional code.
      if (err instanceof McpError) throw err;

      // Wrap everything else as an internal error with the original message.
      const msg = err instanceof Error ? err.message : String(err);
      throw new McpError(ErrorCode.InternalError, msg);
    }
  });
}
