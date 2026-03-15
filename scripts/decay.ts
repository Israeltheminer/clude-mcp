#!/usr/bin/env node
/**
 * decay.ts
 *
 * Runs one memory decay pass — reduces importance/decay_factor on all memories
 * according to type-specific daily rates.
 *
 * Idempotent per day. Safe to run multiple times — the cutoff parameter
 * prevents double-decay within 24h.
 *
 * Usage:
 *   npm run decay
 *   node --require tsx/cjs scripts/decay.ts
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import { createBrain } from "../src/brain.js";
import { buildConfig } from "../src/config.js";

async function main() {
  const config = buildConfig();

  console.log("🧹 Starting decay pass...\n");
  const startMs = Date.now();

  const brain = await createBrain(config);
  const updated = await brain.decay();
  brain.destroy();

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`✨ Decay pass complete in ${elapsed}s — ${updated} memories updated.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
