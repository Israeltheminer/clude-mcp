#!/usr/bin/env npx tsx
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
 *   npx tsx scripts/ingest-sessions.ts [--window 10] [--threshold 0.4] [--dry-run]
 *
 * State:
 *   Progress is saved to ~/.claude/clude-ingest-state.json so re-runs skip
 *   already-ingested session files.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import "dotenv/config";

import { createBrain } from "../src/brain.js";
import { buildConfig } from "../src/config.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const WINDOW_IDX = args.indexOf("--window");
const THRESH_IDX = args.indexOf("--threshold");
const WINDOW = WINDOW_IDX !== -1 ? (parseInt(args[WINDOW_IDX + 1], 10) || 10) : 10;
const THRESHOLD = THRESH_IDX !== -1 ? (parseFloat(args[THRESH_IDX + 1]) || 0.4) : 0.4;

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
  console.log(`window=${WINDOW} turns  threshold=${THRESHOLD}\n`);

  const state = loadState();
  const files = collectSessionFiles();
  console.log(`Found ${files.length} session files`);

  const pending = files.filter(f => !state.ingested[f]);
  console.log(`${pending.length} not yet ingested\n`);

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

  for (const filePath of files) {
    if (state.ingested[filePath]) {
      process.stdout.write(".");
      continue;
    }

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
          importance = await brain.scoreImportance(scoreInput);
        } catch { /* fall through — auto-scores inside store() */ }

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
