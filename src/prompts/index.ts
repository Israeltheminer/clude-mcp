/**
 * @module prompts/index
 *
 * Registers all MCP prompt handlers on the given Server instance.
 *
 * ## Responsibilities
 *
 * This module owns two things:
 *
 *   1. `ListPromptsRequestSchema` handler — returns the static PROMPTS array
 *      so MCP clients can discover what prompts are available and their
 *      argument schemas.
 *
 *   2. `GetPromptRequestSchema` handler — the central dispatch for incoming
 *      prompt requests. Maps each prompt name to its handler function and
 *      applies uniform error handling for unknown names.
 *
 * ## Dispatch Strategy
 *
 * Prompt names are dispatched via explicit `if` branches rather than a
 * switch, which avoids the need for a `default` fall-through. Each branch
 * returns immediately, making the "unknown prompt" error path clear.
 *
 * ## Brain Dependency
 *
 * Only `memory_context` requires `brain` (it runs a recall query internally).
 * `store_conversation_turn` and `agent_memory_protocol` are pure functions
 * of their arguments and environment respectively — they don't touch the DB.
 *
 * The `brain` parameter is passed to `registerPromptHandlers` and threaded
 * through to `handleMemoryContext` only.
 *
 * ## Adding a New Prompt
 *
 * 1. Define the prompt metadata in `src/prompts/definitions.ts`.
 * 2. Write a handler function in a new file under `src/prompts/handlers/`.
 * 3. Re-export it from `src/prompts/handlers/index.ts`.
 * 4. Add a dispatch branch here in `registerPromptHandlers`.
 */

import type { Cortex } from "clude-bot";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { PROMPTS } from "./definitions.js";
import {
  handleMemoryContext,
  handleStoreConversationTurn,
  handleAgentMemoryProtocol,
} from "./handlers/index.js";

/**
 * Register all prompt-related request handlers on the MCP server.
 *
 * Must be called after the server is constructed and before it connects to
 * the transport. `brain` must be fully initialised before this is called.
 *
 * @param server - The MCP Server instance to register handlers on.
 * @param brain  - The fully initialised Cortex (or CortexV2) instance.
 */
export function registerPromptHandlers(server: Server, brain: Cortex): void {
  // -----------------------------------------------------------------------
  // Prompt discovery
  // -----------------------------------------------------------------------
  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: PROMPTS,
  }));

  // -----------------------------------------------------------------------
  // Prompt dispatch
  // -----------------------------------------------------------------------
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    if (name === "memory_context") {
      return handleMemoryContext(brain, args as Record<string, unknown>);
    }

    if (name === "store_conversation_turn") {
      return handleStoreConversationTurn(args as Record<string, unknown>);
    }

    if (name === "agent_memory_protocol") {
      return handleAgentMemoryProtocol();
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
  });
}
