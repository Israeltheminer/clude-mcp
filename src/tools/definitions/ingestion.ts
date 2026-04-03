import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Schema for the ingest_sessions tool. */
export const ingestSessionsDef: Tool = {
  name: "ingest_sessions",
  description:
    "Ingest AI chat sessions from Claude Code, Claude.ai web, or ChatGPT " +
    "exports into the memory system. Scans all known locations by default " +
    "(~/.claude/projects/ for Claude Code, ~/.claude/imports/claude-web/ for " +
    "Claude.ai exports, ~/.claude/imports/chatgpt/ for ChatGPT exports). " +
    "Optionally chains into the dream consolidation cycle after ingestion. " +
    "Self-hosted only. Requires ANTHROPIC_API_KEY for LLM scoring/summarisation.",
  inputSchema: {
    type: "object",
    properties: {
      source_path: {
        type: "string",
        description:
          "Path to a specific file or directory to ingest. " +
          "Supports .jsonl (Claude Code), .json/.zip (Claude.ai / ChatGPT export). " +
          "When omitted, scans all known locations.",
      },
      platform: {
        type: "string",
        enum: ["claude-code", "claude-web", "chatgpt", "auto"],
        description:
          "Force platform detection. Default 'auto' infers from file extension.",
      },
      window: {
        type: "number",
        description: "Turns per memory window (default: 10).",
      },
      threshold: {
        type: "number",
        description:
          "Min importance score to store episodic highlight (default: 0.4).",
      },
      limit: {
        type: "number",
        description: "Max sessions to process in this run (default: 0 = unlimited).",
      },
      project: {
        type: "string",
        description:
          "Only process sessions from projects matching this substring.",
      },
      chain_dream: {
        type: "boolean",
        description:
          "Run dream consolidation after ingestion completes (default: false).",
      },
      dry_run: {
        type: "boolean",
        description:
          "Preview what would be processed without storing anything (default: false).",
      },
      reprocess: {
        type: "boolean",
        description:
          "Clear ingestion state first, causing all sessions to be re-ingested " +
          "with the latest pipeline. Use after pipeline quality improvements.",
      },
    },
  },
};
