#!/usr/bin/env node
/**
 * @module index
 *
 * Entry point for the clude MCP server.
 *
 * ## What Lives Here (and Why Only This)
 *
 * This file is intentionally minimal. It contains exactly three things:
 *
 *   1. The pino/sonic-boom stdout guard  — MUST be the first statement in the
 *      entire program, before any `import` that could load the clude-bot SDK.
 *
 *   2. The dotenv loader  — reads .env into process.env so that all subsequent
 *      modules see the configured values.
 *
 *   3. The `main()` call  — delegates everything else to `src/server.ts`.
 *
 * ## Why the Guard Must Be First
 *
 * The MCP protocol runs over stdio — stdout is the exclusive JSON-RPC channel.
 * Any bytes written to stdout that are not valid JSON-RPC frames corrupt the
 * protocol stream and cause the MCP client to disconnect.
 *
 * The clude-bot SDK (via pino/sonic-boom) writes logs directly to file
 * descriptor 1 (stdout) using native `fs.write(fd, ...)` calls. This bypasses
 * `process.stdout.write` entirely, making stream interception unreliable.
 *
 * Setting `process.env.LOG_LEVEL = "silent"` before the SDK is imported
 * prevents pino from creating any log stream, which is the only fully
 * reliable cross-version approach.
 *
 * If this line is moved below the imports — even by one line — pino may
 * initialise before reading LOG_LEVEL and begin writing to stdout.
 *
 * ## dotenv Placement
 *
 * dotenv.config() is called immediately after the guard. All subsequent
 * modules (config.ts, brain.ts, handlers) read from process.env, so loading
 * .env here — before any of those modules are evaluated — ensures they see
 * all configured values at require-time.
 *
 * The .env file path is resolved relative to this file's parent directory
 * (the project root), not the current working directory. This makes the
 * server work correctly regardless of where it is launched from.
 *
 * ## All Application Logic
 *
 * Everything else lives in:
 *
 *   src/server.ts          — main() bootstrap (config, brain, server, connect)
 *   src/config.ts          — env → CortexConfig
 *   src/brain.ts           — createBrain() (CortexV2 with Cortex fallback)
 *   src/log.ts             — stderr-only logger
 *   src/helpers.ts         — shared types + ok() + isCortexV2()
 *   src/tools/             — 13 tool definitions + handlers
 *   src/resources/         — 3 resource definitions + handlers
 *   src/prompts/           — 3 prompt definitions + handlers
 */

// ---------------------------------------------------------------------------
// CRITICAL: Set LOG_LEVEL before any import that may load clude-bot / pino.
// This must be the very first executable statement in the program.
// ---------------------------------------------------------------------------
process.env.LOG_LEVEL = "silent";

// ---------------------------------------------------------------------------
// Load .env into process.env before any module reads from it.
// ---------------------------------------------------------------------------
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ---------------------------------------------------------------------------
// Run the server. All application logic lives in server.ts.
// ---------------------------------------------------------------------------
import { main } from "./server.js";

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
