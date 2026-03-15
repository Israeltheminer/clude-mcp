#!/usr/bin/env node
/**
 * Standalone memory explorer server.
 *
 * Runs independently of Claude Code so the explorer UI stays up
 * even when the MCP server is not connected.
 *
 * Usage:
 *   npm run explorer
 *   EXPLORER_PORT=3141 npm run explorer
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import { buildConfig } from "../src/config.js";
import { createBrain } from "../src/brain.js";
import { startExplorer } from "../src/http.js";

async function main() {
  const port = Number(process.env.EXPLORER_PORT ?? 3141);
  const config = buildConfig();
  const brain = await createBrain(config);

  const server = startExplorer(brain, port);

  const shutdown = () => {
    server.close();
    brain.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
