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
// Run: attach to an existing clude HTTP server when present (second IDE), else
// full bootstrap — see instance-probe.ts / stdio-http-bridge.ts.
// ---------------------------------------------------------------------------
import {
  attachToRunningEnabled,
  explorerPort,
  isCludeHttpRunning,
  isMcpEndpointLikelyClude,
} from "./instance-probe.js";
import { runStdioHttpBridge } from "./stdio-http-bridge.js";
import { main } from "./server.js";
import { log } from "./log.js";

void (async () => {
  try {
    const port = explorerPort();
    if (attachToRunningEnabled()) {
      const hasHealth = await isCludeHttpRunning(port);
      const hasMcp = hasHealth ? true : await isMcpEndpointLikelyClude(port);
      if (hasHealth || hasMcp) {
        if (!hasHealth && hasMcp) {
          log(
            `Attach probe: /_clude/health missing on :${port}, but /mcp is live. Attaching for backward compatibility.`
          );
        }
        await runStdioHttpBridge(new URL(`http://127.0.0.1:${port}/mcp`));
        return;
      }
    }
    await main();
  } catch (err: unknown) {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
  }
})();
