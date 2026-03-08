#!/usr/bin/env node
/**
 * dream.ts
 *
 * Runs one full dream cycle against the memory store.
 *
 * The dream cycle is a 5-phase cognitive consolidation process:
 *   1. Consolidation  — generates focal-point questions from recent episodic memories
 *   2. Compaction     — summarises old, faded episodics into semantic memories
 *   3. Reflection     — produces self-observations grounded in evidence
 *   4. Contradiction  — resolves conflicting memories, stores `resolves` links
 *   5. Emergence      — introspective synthesis output (printed to stdout)
 *
 * Run this after a large ingestion batch to consolidate hundreds of episodic
 * checkpoints into high-quality semantic insights. The scheduled dream cycle
 * in the MCP server runs every 6 hours automatically, but this script lets
 * you trigger it on demand — e.g. right after `npm run ingest`.
 *
 * Usage:
 *   npm run dream
 *   node --require tsx/cjs scripts/dream.ts
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import { createBrain } from "../src/brain.js";
import { buildConfig } from "../src/config.js";

async function main() {
  const config = buildConfig();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY not set — dream cycle requires Anthropic access.");
    process.exit(1);
  }

  console.log("🧠 Starting dream cycle...\n");
  const startMs = Date.now();

  const brain = await createBrain(config);

  let emergenceText = "";
  await brain.dream({
    onEmergence: async (text: string) => {
      emergenceText = text;
    },
  });

  brain.destroy();

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n✨ Dream cycle complete in ${elapsed}s\n`);

  if (emergenceText) {
    console.log("── Emergence ─────────────────────────────────────────────");
    console.log(emergenceText);
    console.log("──────────────────────────────────────────────────────────");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
