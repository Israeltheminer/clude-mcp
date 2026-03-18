#!/usr/bin/env node
/**
 * @module index
 *
 * Entry point for the clude MCP server.
 *
 * Minimal bootstrap: silence SDK logs, load .env, then hand off to server.ts.
 *
 * The LOG_LEVEL guard prevents pino (inside clude-bot) from writing noisy
 * logs to stdout. Must be set before any import that loads the SDK.
 */

// ---------------------------------------------------------------------------
// Silence pino before any import that may load clude-bot.
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
