/**
 * @module interaction-tracker
 *
 * Automatic episodic memory creation at the server level.
 *
 * Instead of relying on the LLM agent to follow CLAUDE.md instructions and
 * call `store_memory` every N turns, this module tracks tool calls passing
 * through the MCP server and automatically creates episodic + semantic
 * checkpoint memories after every N substantive interactions.
 *
 * ## How It Works
 *
 * 1. Every tool call is recorded (name, truncated args/result, duration).
 * 2. "Meta" tools (store_memory, decay_memories, etc.) are logged but do NOT
 *    increment the flush counter — this prevents infinite loops.
 * 3. When the counter hits the flush threshold (default 10), the tracker
 *    snapshots the log and asynchronously:
 *      a. Sends it to Haiku to summarise into 1–3 episodic memories
 *      b. Creates one semantic checkpoint summary
 *      c. Stores all via `brain.store()`
 * 4. If no ANTHROPIC_API_KEY is set, a heuristic template is used instead.
 *
 * ## Environment Variables
 *
 *   AUTO_EPISODIC_ENABLED   — "true" (default when API key set) / "false"
 *   AUTO_EPISODIC_THRESHOLD — tool calls before flush (default: 10)
 *   AUTO_EPISODIC_MODEL     — model for summarisation (default: claude-haiku-4-5-20251001)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Cortex, MemoryType } from "clude-bot";
import { log } from "./log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteractionEntry {
  timestamp: string;
  toolName: string;
  argsSnippet: string;
  resultSnippet: string;
  durationMs: number;
}

export interface TrackerOptions {
  /** Number of substantive tool calls before an automatic flush. */
  flushThreshold?: number;
  /** Max entries in the ring buffer. */
  maxLogEntries?: number;
  /** Disable entirely. */
  enabled?: boolean;
  /** Model ID for summarisation. */
  model?: string;
}

export interface InteractionTracker {
  /** Record a tool call. Triggers flush when threshold is reached. */
  record(entry: InteractionEntry): void;
  /** Force flush (e.g. on shutdown). Resolves silently if nothing to flush. */
  flush(): Promise<void>;
  /** Pending calls since last flush. */
  readonly pendingCount: number;
}

// ---------------------------------------------------------------------------
// Meta tools — logged but don't count toward the flush threshold
// ---------------------------------------------------------------------------

const META_TOOLS = new Set([
  "store_memory",
  "score_importance",
  "infer_concepts",
  "decay_memories",
  "dream",
  "format_context",
  "get_stats",
  "get_self_model",
]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInteractionTracker(
  brain: Cortex,
  opts?: TrackerOptions,
): InteractionTracker {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const enabled =
    opts?.enabled ??
    (process.env.AUTO_EPISODIC_ENABLED
      ? process.env.AUTO_EPISODIC_ENABLED === "true"
      : !!apiKey);

  if (!enabled) {
    // Return a no-op tracker
    return {
      record() {},
      async flush() {},
      get pendingCount() {
        return 0;
      },
    };
  }

  const threshold =
    opts?.flushThreshold ??
    (process.env.AUTO_EPISODIC_THRESHOLD
      ? Number(process.env.AUTO_EPISODIC_THRESHOLD)
      : 5);

  const maxLog = opts?.maxLogEntries ?? 50;
  const model = opts?.model ?? process.env.AUTO_EPISODIC_MODEL ?? "claude-haiku-4-5-20251001";

  const buffer: InteractionEntry[] = [];
  let substantiveCount = 0;
  let flushInProgress = false;

  // -----------------------------------------------------------------------
  // LLM-based summarisation
  // -----------------------------------------------------------------------
  async function summariseWithLLM(
    entries: InteractionEntry[],
  ): Promise<{ episodic: { summary: string; content: string }[]; checkpoint: string }> {
    const anthropic = new Anthropic({ apiKey });

    const logText = entries
      .map(
        (e) =>
          `[${e.timestamp}] ${e.toolName} (${e.durationMs}ms)\n  args: ${e.argsSnippet}\n  result: ${e.resultSnippet}`,
      )
      .join("\n\n");

    const { content } = await anthropic.messages.create({
      model,
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content:
            `You are summarising tool activity from an MCP memory server. ` +
            `Below is a log of ${entries.length} tool calls.\n\n` +
            `Extract 1–3 key events worth remembering as episodic memories. ` +
            `Focus on: what the user/agent was doing, decisions made, problems encountered, patterns observed.\n\n` +
            `Return ONLY a JSON object with this shape:\n` +
            `{\n` +
            `  "episodic": [{"summary": "max 200 chars", "content": "full detail"}],\n` +
            `  "checkpoint": "2-3 sentence overall summary of this activity block"\n` +
            `}\n\n` +
            `Tool call log:\n${logText}`,
        },
      ],
    });

    const text = (content[0] as { text: string }).text?.trim() ?? "{}";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { episodic: [], checkpoint: `${entries.length} tool calls processed.` };
    }

    const parsed = JSON.parse(match[0]);
    return {
      episodic: Array.isArray(parsed.episodic) ? parsed.episodic : [],
      checkpoint: String(parsed.checkpoint || `${entries.length} tool calls processed.`),
    };
  }

  // -----------------------------------------------------------------------
  // Heuristic fallback (no API key)
  // -----------------------------------------------------------------------
  function summariseHeuristic(
    entries: InteractionEntry[],
  ): { episodic: { summary: string; content: string }[]; checkpoint: string } {
    // Group by tool name
    const counts: Record<string, number> = {};
    for (const e of entries) {
      counts[e.toolName] = (counts[e.toolName] || 0) + 1;
    }

    const toolSummary = Object.entries(counts)
      .map(([name, count]) => `${name} x${count}`)
      .join(", ");

    const logText = entries
      .map((e) => `[${e.timestamp}] ${e.toolName}: ${e.argsSnippet}`)
      .join("\n");

    return {
      episodic: [
        {
          summary: `Auto-captured: ${entries.length} tool calls (${toolSummary})`,
          content: logText,
        },
      ],
      checkpoint: `Activity block: ${entries.length} calls — ${toolSummary}.`,
    };
  }

  // -----------------------------------------------------------------------
  // Flush — snapshot buffer, summarise, store
  // -----------------------------------------------------------------------
  async function doFlush(): Promise<void> {
    if (buffer.length === 0) return;
    if (flushInProgress) return;

    flushInProgress = true;
    const snapshot = buffer.splice(0);
    substantiveCount = 0;

    try {
      const result = apiKey
        ? await summariseWithLLM(snapshot)
        : summariseHeuristic(snapshot);

      // Store episodic memories
      for (const ep of result.episodic) {
        if (!ep.summary || !ep.content) continue;
        try {
          await brain.store({
            type: "episodic" as MemoryType,
            content: ep.content,
            summary: ep.summary.slice(0, 200),
            source: "auto_episodic",
          });
        } catch (storeErr) {
          log("auto-episodic store failed:", String(storeErr));
        }
      }

      // Store semantic checkpoint
      if (result.checkpoint) {
        try {
          await brain.store({
            type: "semantic" as MemoryType,
            content: result.checkpoint,
            summary: `Checkpoint: ${result.checkpoint.slice(0, 180)}`,
            source: "checkpoint",
          });
        } catch (storeErr) {
          log("auto-checkpoint store failed:", String(storeErr));
        }
      }

      log(
        `auto-episodic flush: ${result.episodic.length} episodic + 1 checkpoint from ${snapshot.length} calls`,
      );
    } catch (err) {
      log("auto-episodic flush error:", String(err));
    } finally {
      flushInProgress = false;
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------
  return {
    record(entry: InteractionEntry): void {
      // Always log the entry
      if (buffer.length >= maxLog) buffer.shift();
      buffer.push(entry);

      // Only count substantive tools toward the threshold
      if (!META_TOOLS.has(entry.toolName)) {
        substantiveCount++;
      }

      // Trigger flush in background when threshold reached
      if (substantiveCount >= threshold) {
        void doFlush();
      }
    },

    async flush(): Promise<void> {
      await doFlush();
    },

    get pendingCount(): number {
      return substantiveCount;
    },
  };
}
