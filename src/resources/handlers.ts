/**
 * @module resources/handlers
 *
 * MCP resource handler implementation for the clude memory server.
 *
 * ## What This Module Does
 *
 * This module registers two request handlers on the MCP server:
 *
 *   1. `ListResourcesRequestSchema` — returns the static RESOURCES array so
 *      clients can discover what resources are available.
 *
 *   2. `ReadResourceRequestSchema` — called when a client reads a specific
 *      resource URI. Maps each URI to the appropriate brain method and
 *      returns the result as a JSON content block.
 *
 * ## Response Envelope
 *
 * MCP resource reads return `{ contents: [{ uri, mimeType, text }] }`. Each
 * resource handler here builds that shape directly, serialising the brain
 * data as pretty-printed JSON.
 *
 * ## Adding a New Resource
 *
 * 1. Add the URI and metadata to `RESOURCES` in `resources/definitions.ts`.
 * 2. Add a matching `if (uri === "memory://your-new-uri")` branch here.
 * 3. Implement the brain query and build the content block.
 *
 * Keep each branch self-contained — avoid shared state between branches.
 *
 * ## Error Handling
 *
 * Unknown URIs throw `McpError(InvalidRequest)`. Brain errors propagate
 * naturally — the MCP SDK converts unhandled errors to `InternalError`.
 */

import type { Cortex } from "clude-bot";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { RESOURCES } from "./definitions.js";

/**
 * Register all resource-related request handlers on the MCP server.
 *
 * Must be called after the server is constructed and before it connects to
 * the transport. The `brain` parameter must be fully initialised before
 * this function is called.
 *
 * @param server - The MCP Server instance to register handlers on.
 * @param brain  - The fully initialised Cortex (or CortexV2) instance.
 */
export function registerResourceHandlers(server: Server, brain: Cortex): void {
  // -----------------------------------------------------------------------
  // Resource discovery
  // -----------------------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: RESOURCES,
  }));

  // -----------------------------------------------------------------------
  // Resource reads
  // -----------------------------------------------------------------------
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;

    // --- memory://stats ---------------------------------------------------
    if (uri === "memory://stats") {
      const stats = await brain.stats();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }

    // --- memory://recent/24h ----------------------------------------------
    if (uri === "memory://recent/24h") {
      // Fixed window (24 h) and limit (50) for this resource.
      // For a configurable window, use the get_recent tool instead.
      const memories = await brain.recent(24, undefined, 50);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              { count: memories.length, memories },
              null,
              2
            ),
          },
        ],
      };
    }

    // --- memory://self-model ----------------------------------------------
    if (uri === "memory://self-model") {
      const memories = await brain.selfModel();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              { count: memories.length, memories },
              null,
              2
            ),
          },
        ],
      };
    }

    // --- Unknown URI ------------------------------------------------------
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Unknown resource URI: ${uri}`
    );
  });
}
