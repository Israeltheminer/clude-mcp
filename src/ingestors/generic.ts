import { statSync } from "fs";
import { extname } from "path";
import type { SessionFile } from "./types.js";
import { collectSessionFiles, parseSession, sourceLabel } from "./claude-code.js";
import { collectChatGPTFiles, parseChatGPTExport } from "./chatgpt.js";
import { collectClaudeWebFiles, parseClaudeWebExport } from "./claude-web.js";

export interface CollectOptions {
  sourcePath?: string;
  platform?: "claude-code" | "claude-web" | "chatgpt" | "cursor" | "auto";
  project?: string;
}

/**
 * Unified session collector. Delegates to platform-specific parsers.
 *
 * - If `sourcePath` is given, ingests that file/dir using the specified or
 *   auto-detected platform parser.
 * - If no `sourcePath`, scans all known locations (Claude Code projects +
 *   Claude web drop folder + ChatGPT drop folder).
 */
export function collectAllSessions(opts: CollectOptions): SessionFile[] {
  const platform = opts.platform ?? "auto";

  if (opts.sourcePath) {
    return collectFromPath(opts.sourcePath, platform, opts.project);
  }

  let sessions: SessionFile[] = [];

  sessions.push(...collectSessionFiles());
  sessions.push(...collectClaudeWebFiles());
  sessions.push(...collectChatGPTFiles());

  if (opts.project) {
    sessions = sessions.filter(s => s.path.includes(opts.project!));
  }

  return sessions;
}

function collectFromPath(
  sourcePath: string,
  platform: "claude-code" | "claude-web" | "chatgpt" | "cursor" | "auto",
  project?: string
): SessionFile[] {
  let stat;
  try {
    stat = statSync(sourcePath);
  } catch {
    return [];
  }

  if (stat.isDirectory()) {
    if (platform === "chatgpt") return collectChatGPTFiles(sourcePath);
    if (platform === "claude-web") return collectClaudeWebFiles(sourcePath);
    if (platform === "claude-code") return collectSessionFiles(sourcePath);
    if (platform === "cursor") {
      // TODO: implement Cursor session ingestion once export format/paths are defined.
      return [];
    }
    return [
      ...collectSessionFiles(sourcePath),
      ...collectClaudeWebFiles(sourcePath),
      ...collectChatGPTFiles(sourcePath),
    ];
  }

  const detected = platform === "auto" ? detectPlatform(sourcePath) : platform;

  if (detected === "chatgpt") return parseChatGPTExport(sourcePath);
  if (detected === "claude-web") return parseClaudeWebExport(sourcePath);

  if (detected === "claude-code") {
    const turns = parseSession(sourcePath);
    if (turns.length < 2) return [];
    return [{
      path: sourcePath,
      platform: "claude-code",
      turns,
      sourceId: `claude-code:${sourcePath}`,
    }];
  }

  return [];
}

function detectPlatform(filePath: string): "claude-code" | "claude-web" | "chatgpt" {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jsonl") return "claude-code";
  if (ext === ".zip") return "chatgpt";
  if (ext === ".json") {
    // Peek at structure to distinguish Claude web from ChatGPT
    try {
      const { readFileSync } = require("fs");
      const raw = readFileSync(filePath, "utf8");
      if (raw.includes('"chat_messages"') || raw.includes('"sender"')) return "claude-web";
      if (raw.includes('"mapping"')) return "chatgpt";
    } catch {}
    return "chatgpt";
  }
  return "claude-code";
}
