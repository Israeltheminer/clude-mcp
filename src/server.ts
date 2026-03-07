/**
 * @module server
 *
 * The main server bootstrap and lifecycle manager.
 *
 * ## Responsibility Boundary
 *
 * This module is the only place that knows about all three registration
 * layers (tools, resources, prompts). Its single exported function `main()`
 * performs the entire startup sequence:
 *
 *   1. Build config from environment variables
 *   2. Initialise the memory brain (Cortex / CortexV2)
 *   3. Construct the MCP Server instance
 *   4. Register tool, resource, and prompt handlers
 *   5. Wire up OS signal handlers for graceful shutdown
 *   6. Connect to the stdio transport and start serving
 *
 * Everything else lives in focused modules:
 *
 *   config.ts              — env → CortexConfig
 *   brain.ts               — CortexConfig → initialised Cortex instance
 *   tools/index.ts         — register 13 tool handlers
 *   resources/handlers.ts  — register 3 resource handlers
 *   prompts/index.ts       — register 3 prompt handlers
 *
 * ## Transport
 *
 * clude uses MCP's stdio transport:
 *   stdout → exclusive JSON-RPC channel (the MCP protocol stream)
 *   stderr → diagnostic logs (safe to write freely; ignored by clients)
 *
 * The `LOG_LEVEL=silent` guard in `index.ts` ensures pino/sonic-boom never
 * writes to stdout. This module does not touch that guard — it must be set
 * before any imports load the SDK.
 *
 * ## Shutdown
 *
 * SIGINT and SIGTERM both call `brain.destroy()` and exit with code 0.
 * `destroy()` is synchronous — it stops the dream scheduler and cleans up
 * the event bus, but does not close the Supabase connection pool (that is
 * left to the process exit).
 *
 * ## Error on Init
 *
 * If config building fails (missing env vars) or brain.init() fails
 * (unreachable Supabase, invalid API key), the error is logged to stderr
 * and the process exits with code 1. This is the correct behaviour for an
 * MCP server — the client will see a clean connection failure rather than
 * a zombie process that drops all calls silently.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { log } from "./log.js";
import { buildConfig } from "./config.js";
import { createBrain } from "./brain.js";
import { registerToolHandlers } from "./tools/index.js";
import { registerResourceHandlers } from "./resources/handlers.js";
import { registerPromptHandlers } from "./prompts/index.js";

/**
 * Bootstrap and run the clude MCP server.
 *
 * This function never resolves during normal operation — the server stays
 * alive until a SIGINT/SIGTERM signal triggers `brain.destroy()` + exit.
 *
 * @throws If config is invalid or brain initialisation fails. The caller
 *         (`src/index.ts`) catches this and exits with code 1.
 */
export async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Config — build from environment variables.
  //    Throws immediately if required vars are missing.
  // -------------------------------------------------------------------------
  const config = buildConfig();

  // -------------------------------------------------------------------------
  // 2. Brain — initialise Cortex (or CortexV2 if available).
  //    Establishes DB connections, verifies schema, warms embeddings.
  // -------------------------------------------------------------------------
  let brain;
  try {
    brain = await createBrain(config);
    log("Cortex initialized.");
  } catch (err) {
    log("FATAL — could not initialize Cortex:", String(err));
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 3. Server — construct the MCP Server with full capability declaration.
  //    All three capability namespaces must be declared here for clients to
  //    know they can call ListTools / ListResources / ListPrompts.
  // -------------------------------------------------------------------------
  const server = new Server(
    { name: "clude", version: "1.0.0" },
    {
      capabilities: {
        tools: {},      // Enables: ListTools, CallTool
        resources: {},  // Enables: ListResources, ReadResource
        prompts: {},    // Enables: ListPrompts, GetPrompt
      },
    }
  );

  // -------------------------------------------------------------------------
  // 4. Handlers — register tools, resources, and prompts.
  //    Order does not matter; all handlers are registered before connecting.
  // -------------------------------------------------------------------------
  registerToolHandlers(server, brain);
  registerResourceHandlers(server, brain);
  registerPromptHandlers(server, brain);

  // -------------------------------------------------------------------------
  // 5. Shutdown — wire SIGINT/SIGTERM for graceful cleanup.
  //    Calling brain.destroy() stops the dream scheduler + event bus.
  //    The process exits immediately after — no async teardown needed.
  // -------------------------------------------------------------------------
  const shutdown = (): void => {
    brain.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // -------------------------------------------------------------------------
  // 6. Connect — attach the stdio transport and start the JSON-RPC loop.
  //    After this point the server is live and will handle incoming requests.
  // -------------------------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("clude ready.");
}
