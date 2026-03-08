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
 *   --dry-run          Preview what would be processed without storing anything
 *
 * Rate limiting:
 *   Voyage free tier allows 3 requests/minute. Each store_memory call = 1 request
 *   (clude-bot batches all fragments internally). A token-bucket rate limiter
 *   throttles automatically — no manual --delay needed.
 *
 * State:
 *   Progress is saved to ~/.claude/clude-ingest-state.json so re-runs skip
 *   already-ingested session files. Run repeatedly to process in batches.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import dotenv from "dotenv";
dotenv.config({ override: true }); // override empty env vars pre-set by parent shell

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
      content: `Rate how important this information is to remember long-term for a developer assistant, on a scale from 0.0 to 1.0. Be extremely strict. Routine debugging, typical commands, or small talk should score 0.1-0.3. Only persistent user preferences, major architectural decisions, or critical system insights should score >0.6. Reply with a single decimal number only.\n\n${text.slice(0, 500)}`,
    }],
  });

  const raw = (response.content[0] as any).text?.trim() ?? "0.5";
  const score = parseFloat(raw);
  return isNaN(score) ? 0.5 : Math.min(1, Math.max(0, score));
}

async function summarizeWindowDirect(text: string): Promise<string> {
  const client = getAnthropicClient();
  if (!client) return "";

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `Write a concise 2-3 sentence summary of the key facts, context, and decisions discussed in the following conversation turns. Focus on the actionable takeaways and what was accomplished.\n\n${text.slice(0, 4000)}`,
      }],
    });
    return (response.content[0] as any).text?.trim() ?? "";
  } catch (err) {
    return "";
  }
}

async function inferConceptsDirect(text: string): Promise<string[]> {
  const client = getAnthropicClient();
  if (!client) return [];

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{
        role: "user",
        content: `Extract 2-4 broad, highly relevant categorization tags for this developer conversation. Use generic coding/memory concepts like architecture, debugging, refactoring, configuration, preferences, ui, backend, testing, etc. Return them as a comma-separated list of lowercase words. DO NOT output anything else.\n\n${text.slice(0, 2000)}`,
      }],
    });
    const raw = (response.content[0] as any).text?.trim() ?? "";
    return raw.split(',').map((s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')).filter(Boolean);
  } catch (err) {
    return [];
  }
}


// ── Status line ───────────────────────────────────────────────────────────────
// Rewrites a single terminal line with \r so progress doesn't scroll.

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

// ── Rate limiter ──────────────────────────────────────────────────────────────
// Token-bucket: allows up to `maxRequests` calls in a rolling `windowMs` window.
// Each call to .throttle() records a timestamp and waits if needed.

class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async throttle(onWait?: (waitSec: number) => void): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 10;
      onWait?.(Math.ceil(waitMs / 1000));

      // Live countdown: update status every second
      const endAt = Date.now() + waitMs;
      await new Promise<void>(resolve => {
        const tick = () => {
          const remaining = Math.ceil((endAt - Date.now()) / 1000);
          if (remaining <= 0) { resolve(); return; }
          onWait?.(remaining);
          setTimeout(tick, 1000);
        };
        tick();
      });

      return this.throttle(onWait); // re-check after waiting
    }

    this.timestamps.push(Date.now());
  }
}

// Voyage free tier: 3 requests per minute. One request per store_memory call.
const voyageLimiter = new RateLimiter(3, 60_000);

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN     = args.includes("--dry-run");
const WINDOW_IDX  = args.indexOf("--window");
const THRESH_IDX  = args.indexOf("--threshold");
const LIMIT_IDX   = args.indexOf("--limit");
const PROJECT_IDX = args.indexOf("--project");
const WINDOW    = WINDOW_IDX  !== -1 ? (parseInt(args[WINDOW_IDX  + 1], 10) || 10)  : 10;
const THRESHOLD = THRESH_IDX  !== -1 ? (parseFloat(args[THRESH_IDX + 1])    || 0.4) : 0.4;
const LIMIT     = LIMIT_IDX   !== -1 ? (parseInt(args[LIMIT_IDX   + 1], 10) || 0)   : 0; // 0 = unlimited
const PROJECT   = PROJECT_IDX !== -1 ? args[PROJECT_IDX + 1] : undefined;

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
  console.log(`window=${WINDOW}  threshold=${THRESHOLD}  limit=${LIMIT || "none"}  project=${PROJECT ?? "all"}  rate=3 RPM`);
  console.log();

  const state = loadState();
  let files = collectSessionFiles();

  if (PROJECT) {
    files = files.filter(f => f.includes(PROJECT));
    console.log(`Filtered to project "${PROJECT}": ${files.length} files`);
  } else {
    console.log(`Found ${files.length} session files`);
  }

  let pending = files.filter(f => !state.ingested[f]);
  console.log(`${pending.length} pending  |  ${files.length - pending.length} already ingested`);

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
  const total = pending.length;
  const padLen = String(total).length;

  for (let si = 0; si < pending.length; si++) {
    const filePath = pending[si];
    const prefix = `[${String(si + 1).padStart(padLen)}/${total}]`;

    const turns = parseSession(filePath);
    if (turns.length < 2) {
      state.ingested[filePath] = new Date().toISOString();
      saveState(state);
      println(`${prefix} skipped — too short (${turns.length} turns)`);
      continue;
    }

    const source = sourceLabel(filePath);
    const sessionDate = turns[0]?.timestamp?.slice(0, 10) ?? "unknown";
    const sessionLabel = `${source}  ${sessionDate}`;

    const windows = Math.ceil(turns.length / WINDOW);
    let sessionMemories = 0;

    // Split into windows of WINDOW turns
    for (let wi = 0; wi < turns.length; wi += WINDOW) {
      const window = turns.slice(wi, wi + WINDOW);
      if (window.length < 2) continue;

      const winNum = Math.floor(wi / WINDOW) + 1;
      setStatus(`${prefix} ${sessionLabel}  win ${winNum}/${windows}  ${memoriesStored + sessionMemories} stored`);

      const firstUserMsg = window.find(t => t.role === "user")?.text ?? "";
      const windowSummary = `${sessionLabel}: ${firstUserMsg.slice(0, 80)}${firstUserMsg.length > 80 ? "…" : ""}`;

      // ── Score user turns in parallel (Anthropic Haiku — separate rate limit) ─
      const userTurns = window.filter(t => t.role === "user");

      const scores = await Promise.all(
        userTurns.map(async (turn) => {
          const scoreInput = `${windowSummary} ${turn.text.slice(0, 400)}`;
          try {
            return { turn, importance: await scoreImportanceDirect(scoreInput) };
          } catch {
            return { turn, importance: undefined as number | undefined };
          }
        })
      );

      const best = scores
        .sort((a, b) => (b.importance ?? -1) - (a.importance ?? -1))[0];
      const isHighlight = best?.importance !== undefined && best.importance >= THRESHOLD;

      const windowText = window
        .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
        .join("\n\n");

      const generatedSummary = await summarizeWindowDirect(windowText);
      const checkpointSummary = generatedSummary
        ? `Checkpoint — ${sessionLabel} (turns ${wi + 1}–${wi + window.length})\n${generatedSummary}`
        : `Checkpoint — ${sessionLabel} (turns ${wi + 1}–${wi + window.length})`;

      const content = [
        windowText.slice(0, 1800),
        isHighlight ? `\n\n── Highlight (importance ${best!.importance!.toFixed(2)}) ──\n${best!.turn.text.slice(0, 400)}` : "",
      ].join("").trim();

      try {
        const tags = await inferConceptsDirect(checkpointSummary + (best ? " " + best.turn.text.slice(0, 100) : ""));
        await voyageLimiter.throttle((waitSec) => {
          setStatus(`${prefix} ${sessionLabel}  win ${winNum}/${windows}  ⏸ rate limit — ${waitSec}s…`);
        });
        setStatus(`${prefix} ${sessionLabel}  win ${winNum}/${windows}  storing…`);
        await brain.store({
          type: "semantic",
          content,
          summary: checkpointSummary,
          source: "checkpoint",
          tags,
          importance: best?.importance ?? 0.5,
        });
        sessionMemories++;
      } catch (err: any) {
        println(`  ✗ ${prefix} win ${winNum}: ${err.message}`);
      }
    }

    state.ingested[filePath] = new Date().toISOString();
    saveState(state);
    sessionsProcessed++;
    memoriesStored += sessionMemories;

    println(`✓ ${prefix} ${sessionLabel}  ${windows} win${windows !== 1 ? "s" : ""}  →  ${sessionMemories} memories`);
  }

  brain.destroy();
  console.log();
  console.log(`Done. ${sessionsProcessed} sessions ingested, ${memoriesStored} memories stored.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
