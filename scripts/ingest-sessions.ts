#!/usr/bin/env node
/**
 * ingest-sessions.ts — CLI wrapper for the ingestion pipeline.
 *
 * Usage:
 *   npm run ingest -- [options]
 *
 * Options:
 *   --limit N          Max sessions to process per run (default: unlimited)
 *   --project <pat>    Only process sessions from projects matching this substring
 *   --window N         Turns per memory window (default: 10)
 *   --threshold N      Min importance score to store (default: 0.4)
 *   --source <path>    Ingest a specific file or directory
 *   --platform <p>     Force platform: claude-code, chatgpt, auto (default: auto)
 *   --chain-dream      Run dream consolidation after ingestion
 *   --dry-run          Preview what would be processed without storing
 *   --reprocess        Clear ingestion state and reprocess all sessions
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env"), override: true });

import { createBrain } from "../src/brain.js";
import { buildConfig } from "../src/config.js";
import { runIngestionPipeline } from "../src/ingestors/pipeline.js";
import { loadState, saveState } from "../src/ingestors/state.js";
import type { IngestOptions, ProgressEvent } from "../src/ingestors/types.js";

// ── Terminal helpers ─────────────────────────────────────────────────────────

let _statusActive = false;
function setStatus(msg: string) {
  const cols = (process.stdout.columns || 120) - 1;
  process.stdout.write("\r" + msg.slice(0, cols).padEnd(cols));
  _statusActive = true;
}
function clearStatus() {
  if (_statusActive) {
    const cols = (process.stdout.columns || 120) - 1;
    process.stdout.write("\r" + " ".repeat(cols) + "\r");
    _statusActive = false;
  }
}
function println(msg: string) {
  clearStatus();
  console.log(msg);
}

// ── Progress callback ────────────────────────────────────────────────────────

function onProgress(event: ProgressEvent) {
  const pad = (n: number, total: number) => String(n + 1).padStart(String(total).length);

  switch (event.kind) {
    case "session-start":
      setStatus(`[${pad(event.index, event.total)}/${event.total}] ${event.label}`);
      break;
    case "window":
      setStatus(
        `[${pad(event.index, event.total)}/${event.total}] ` +
        `win ${event.windowNum}/${event.windowTotal}  ${event.status}`
      );
      break;
    case "rate-limit":
      setStatus(`⏸ rate limit — ${event.waitSec}s…`);
      break;
    case "session-done":
      println(`✓ [${pad(event.index, event.total)}/${event.total}] ${event.label}  →  ${event.memories} memories`);
      break;
    case "skip":
      println(`  [${pad(event.index, event.total)}/${event.total}] skipped — ${event.reason}`);
      break;
  }
}

// ── CLI arg parsing ──────────────────────────────────────────────────────────

function argVal(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const options: IngestOptions = {
  limit:      parseInt(argVal("--limit") ?? "0", 10) || 0,
  project:    argVal("--project"),
  window:     parseInt(argVal("--window") ?? "10", 10) || 10,
  threshold:  parseFloat(argVal("--threshold") ?? "0.4") || 0.4,
  sourcePath: argVal("--source"),
  platform:   (argVal("--platform") as IngestOptions["platform"]) ?? "auto",
  chainDream: process.argv.includes("--chain-dream"),
  dryRun:     process.argv.includes("--dry-run"),
};

// ── Reprocess mode ───────────────────────────────────────────────────────────

function handleReprocess() {
  const state = loadState();
  const count = Object.keys(state.ingested).length;
  if (count === 0) {
    console.log("No ingestion state to clear.");
    return;
  }
  state.ingested = {};
  saveState(state);
  console.log(`Cleared ingestion state for ${count} sessions. They will be re-ingested.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--reprocess")) {
    handleReprocess();
    if (process.argv.includes("--dry-run")) {
      return;
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("WARNING: ANTHROPIC_API_KEY not set — LLM scoring/summarization will use fallbacks");
  }

  console.log(`clude session ingestion${options.dryRun ? " [DRY RUN]" : ""}`);
  console.log(
    `window=${options.window}  threshold=${options.threshold}  ` +
    `limit=${options.limit || "none"}  project=${options.project ?? "all"}  ` +
    `platform=${options.platform}`
  );
  console.log();

  const config = buildConfig();
  const brain = await createBrain(config);

  const result = await runIngestionPipeline(brain, options, onProgress);

  if (options.chainDream && result.memoriesStored > 0 && !options.dryRun) {
    console.log("\nChaining dream consolidation…");
    await brain.dream({});
    result.dreamChained = true;
  }

  brain.destroy();
  console.log();
  console.log(
    `Done. ${result.sessionsProcessed} sessions ingested, ` +
    `${result.memoriesStored} memories stored.` +
    (result.dreamChained ? " Dream cycle completed." : "")
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
