#!/usr/bin/env node
/**
 * ingest-sessions.ts
 *
 * Retroactively processes existing Claude Code and Antigravity conversation
 * sessions into the clude memory store.
 *
 * Scans ~/.claude/projects/ for all JSONL session files, extracts
 * user/assistant turns, and runs them through the memory protocol:
 *   - Episodic highlights (score_importance gated)
 *   - Semantic checkpoint per N-turn window (always stored)
 *
 * Usage:
 *   npm run ingest -- [options]
 *   node --require tsx/cjs scripts/ingest-sessions.ts [options]
 *
 * Options:
 *   --limit N          Max sessions to process per run (default: unlimited)
 *   --project <pat>    Only process sessions from projects matching this substring
 *   --window N         Turns per memory window (default: 10)
 *   --threshold N      Min importance score to store episodic memory (default: 0.4)
 *   --delay N          ms to wait between memory stores (default: 20000 for Voyage free tier 3 RPM)
 *   --dry-run          Preview what would be processed without storing anything
 *
 * State:
 *   Progress is saved to ~/.claude/clude-ingest-state.json so re-runs skip
 *   already-ingested session files. Run repeatedly to process in batches.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";
import { createBrain } from "../src/brain.js";
import { buildConfig } from "../src/config.js";

// ── Direct Anthropic scorer ───────────────────────────────────────────────────
// Bypass clude-bot's internal scorer which has a key injection issue.
// Score 0–1: ask the model to rate importance as a number between 0 and 1.

let _anthropic: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  if (_anthropic) return _anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _anthropic = new Anthropic({ apiKey });
  return _anthropic;
}

async function scoreImportanceDirect(text: string): Promise<number> {
  const client = getAnthropicClient();
  if (!client) return 0.5; // heuristic fallback if no key

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    messages: [{
      role: "user",
      content: `Rate how important this information is to remember long-term, on a scale from 0.0 to 1.0. Reply with a single decimal number only.\n\n${text.slice(0, 500)}`,
    }],
  });

  const raw = (response.content[0] as any).text?.trim() ?? "0.5";
  const score = parseFloat(raw);
  return isNaN(score) ? 0.5 : Math.min(1, Math.max(0, score));
}

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN     = args.includes("--dry-run");
const WINDOW_IDX  = args.indexOf("--window");
const THRESH_IDX  = args.indexOf("--threshold");
const LIMIT_IDX   = args.indexOf("--limit");
const PROJECT_IDX = args.indexOf("--project");
const WINDOW    = WINDOW_IDX  !== -1 ? (parseInt(args[WINDOW_IDX  + 1], 10) || 10)  : 10;
const THRESHOLD = THRESH_IDX  !== -1 ? (parseFloat(args[THRESH_IDX + 1])    || 0.4) : 0.4;
const DELAY_IDX = args.indexOf("--delay");
const LIMIT     = LIMIT_IDX   !== -1 ? (parseInt(args[LIMIT_IDX   + 1], 10) || 0)     : 0;     // 0 = unlimited
const PROJECT   = PROJECT_IDX !== -1 ? args[PROJECT_IDX + 1] : undefined;
const DELAY_MS  = DELAY_IDX   !== -1 ? (parseInt(args[DELAY_IDX   + 1], 10) || 20000) : 20000; // Voyage free: 3 RPM

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const STATE_FILE = join(homedir(), ".claude", "clude-ingest-state.json");

// ── Types ─────────────────────────────────────────────────────────────────────

interface Turn {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

interface IngestState {
  ingested: Record<string, string>; // filePath → ISO timestamp of ingest
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadState(): IngestState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  }
  return { ingested: {} };
}

function saveState(state: IngestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Extract plain text from a message content field.
 * Handles string content and content-block arrays.
 * Strips IDE event tags and scheduled-task wrappers.
 */
function extractText(content: unknown): string {
  let raw = "";

  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = (content as any[])
      .filter((b) => b.type === "text")
      .map((b) => b.text as string)
      .join("\n");
  }

  return raw
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .replace(/<scheduled-task[\s\S]*?<\/scheduled-task>/g, "")
    .trim();
}

/**
 * Parse a JSONL session file into ordered user/assistant turns.
 */
function parseSession(filePath: string): Turn[] {
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const turns: Turn[] = [];

  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.message?.content) continue;

    const text = extractText(entry.message.content);
    if (!text || text.length < 20) continue;

    turns.push({
      role: entry.type as "user" | "assistant",
      text,
      timestamp: entry.timestamp ?? "",
    });
  }

  return turns;
}

/**
 * Collect all .jsonl session files from ~/.claude/projects/.
 */
function collectSessionFiles(): string[] {
  const files: string[] = [];

  for (const projectDir of readdirSync(PROJECTS_DIR)) {
    const projectPath = join(PROJECTS_DIR, projectDir);
    if (!statSync(projectPath).isDirectory()) continue;

    for (const file of readdirSync(projectPath)) {
      if (file.endsWith(".jsonl")) {
        files.push(join(projectPath, file));
      }
    }
  }

  return files;
}

/** Antigravity sessions live under project dirs containing "gemini". */
function sourceLabel(filePath: string): string {
  return filePath.includes("gemini") ? "antigravity" : "claude-code";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`clude session ingestion${DRY_RUN ? " [DRY RUN]" : ""}`);
  console.log(`window=${WINDOW}  threshold=${THRESHOLD}  limit=${LIMIT || "none"}  project=${PROJECT ?? "all"}\n`);

  const state = loadState();
  let files = collectSessionFiles();

  if (PROJECT) {
    files = files.filter(f => f.includes(PROJECT));
    console.log(`Filtered to project "${PROJECT}": ${files.length} files`);
  } else {
    console.log(`Found ${files.length} session files`);
  }

  let pending = files.filter(f => !state.ingested[f]);
  console.log(`${pending.length} not yet ingested`);

  if (LIMIT > 0 && pending.length > LIMIT) {
    console.log(`Capping to ${LIMIT} sessions (--limit)`);
    pending = pending.slice(0, LIMIT);
  }

  console.log();

  if (DRY_RUN) {
    for (const f of pending) console.log(" ", f);
    return;
  }

  if (pending.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const config = buildConfig();
  const brain = await createBrain(config);

  let sessionsProcessed = 0;
  let memoriesStored = 0;

  for (const filePath of pending) {

    const turns = parseSession(filePath);
    if (turns.length < 2) {
      state.ingested[filePath] = new Date().toISOString();
      saveState(state);
      continue;
    }

    const source = sourceLabel(filePath);
    const sessionDate = turns[0]?.timestamp?.slice(0, 10) ?? "unknown";
    const sessionLabel = `${source} session ${sessionDate}`;

    // Split into windows of WINDOW turns
    for (let i = 0; i < turns.length; i += WINDOW) {
      const window = turns.slice(i, i + WINDOW);
      if (window.length < 2) continue;

      const firstUserMsg = window.find(t => t.role === "user")?.text ?? "";
      const windowSummary = `${sessionLabel}: ${firstUserMsg.slice(0, 80)}${firstUserMsg.length > 80 ? "…" : ""}`;

      // ── Step A: score each user turn, store episodic highlights ───────────
      for (const turn of window) {
        if (turn.role !== "user") continue;

        const scoreInput = `${windowSummary} ${turn.text.slice(0, 400)}`;
        let importance: number | undefined;

        try {
          importance = await scoreImportanceDirect(scoreInput);
        } catch { /* fall through — store() will use heuristic */ }

        if (importance !== undefined && importance < THRESHOLD) continue;

        try {
          const tags = brain.inferConcepts(turn.text, source, []);
          await brain.store({
            type: "episodic",
            content: `${sessionLabel}\n\nUser: ${turn.text}`,
            summary: windowSummary,
            source,
            tags,
            ...(importance !== undefined ? { importance } : {}),
          });
          memoriesStored++;
          await sleep(DELAY_MS);
        } catch (err: any) {
          console.error(`\n[episodic] ${filePath}: ${err.message}`);
        }
      }

      // ── Step B: semantic checkpoint (always) ──────────────────────────────
      const windowText = window
        .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
        .join("\n\n");

      const checkpointSummary = `Checkpoint — ${sessionLabel} (turns ${i + 1}–${i + window.length})`;

      try {
        const tags = brain.inferConcepts(checkpointSummary, source, []);
        await brain.store({
          type: "semantic",
          content: windowText.slice(0, 2000),
          summary: checkpointSummary,
          source: "checkpoint",
          tags,
        });
        memoriesStored++;
        await sleep(DELAY_MS);
      } catch (err: any) {
        console.error(`\n[checkpoint] ${filePath}: ${err.message}`);
      }
    }

    state.ingested[filePath] = new Date().toISOString();
    saveState(state);
    sessionsProcessed++;
    process.stdout.write("✓");
  }

  brain.destroy();

  console.log(`\n\nDone. ${sessionsProcessed} sessions ingested, ${memoriesStored} memories stored.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
