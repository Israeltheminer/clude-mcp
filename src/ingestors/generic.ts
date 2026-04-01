import { statSync } from "fs";
import { extname } from "path";
import type { SessionFile } from "./types.js";
import { collectSessionFiles, parseSession, sourceLabel } from "./claude-code.js";
import { collectChatGPTFiles, parseChatGPTExport } from "./chatgpt.js";

export interface CollectOptions {
  sourcePath?: string;
  platform?: "claude-code" | "chatgpt" | "auto";
  project?: string;
}

/**
 * Unified session collector. Delegates to platform-specific parsers.
 *
 * - If `sourcePath` is given, ingests that file/dir using the specified or
 *   auto-detected platform parser.
 * - If no `sourcePath`, scans all known locations (Claude Code projects +
 *   ChatGPT drop folder).
 */
export function collectAllSessions(opts: CollectOptions): SessionFile[] {
  const platform = opts.platform ?? "auto";

  if (opts.sourcePath) {
    return collectFromPath(opts.sourcePath, platform, opts.project);
  }

  // Scan all known locations
  let sessions: SessionFile[] = [];

  // Claude Code sessions
  const ccSessions = collectSessionFiles();
  sessions.push(...ccSessions);

  // ChatGPT drop folder
  const cgSessions = collectChatGPTFiles();
  sessions.push(...cgSessions);

  // Filter by project if requested
  if (opts.project) {
    sessions = sessions.filter(s => s.path.includes(opts.project!));
  }

  return sessions;
}

function collectFromPath(
  sourcePath: string,
  platform: "claude-code" | "chatgpt" | "auto",
  project?: string
): SessionFile[] {
  let stat;
  try {
    stat = statSync(sourcePath);
  } catch {
    return [];
  }

  if (stat.isDirectory()) {
    // Scan directory based on platform
    if (platform === "chatgpt") {
      return collectChatGPTFiles(sourcePath);
    }
    if (platform === "claude-code") {
      return collectSessionFiles(sourcePath);
    }
    // Auto: try both
    return [
      ...collectSessionFiles(sourcePath),
      ...collectChatGPTFiles(sourcePath),
    ];
  }

  // Single file — detect by extension
  const detected = platform === "auto" ? detectPlatform(sourcePath) : platform;

  if (detected === "chatgpt") {
    return parseChatGPTExport(sourcePath);
  }

  if (detected === "claude-code") {
    const turns = parseSession(sourcePath);
    if (turns.length < 2) return [];
    return [{
      path: sourcePath,
      platform: "claude-code",
      turns,
    }];
  }

  return [];
}

function detectPlatform(filePath: string): "claude-code" | "chatgpt" {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jsonl") return "claude-code";
  if (ext === ".json" || ext === ".zip") return "chatgpt";
  return "claude-code"; // fallback
}
