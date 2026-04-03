import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Turn, SessionFile } from "./types.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Extract plain text from a message content field.
 * Handles string content and content-block arrays.
 * Strips IDE event tags and scheduled-task wrappers.
 */
export function extractText(content: unknown): string {
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
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(/<[\w-]+>[\s\S]*?<\/antml:[\w-]+>/g, "")
    .replace(/<search_results>[\s\S]*?<\/search_results>/g, "")
    .replace(/<environment_details>[\s\S]*?<\/environment_details>/g, "")
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/g, "")
    .replace(/<previous_tool_call>[\s\S]*?<\/previous_tool_call>/g, "")
    .trim();
}

/**
 * Parse a Claude Code JSONL session file into ordered user/assistant turns.
 */
export function parseSession(filePath: string): Turn[] {
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
 * Determine the source label from file path.
 * Antigravity sessions live under project dirs containing "gemini".
 */
export function sourceLabel(filePath: string): string {
  return filePath.includes("gemini") ? "antigravity" : "claude-code";
}

/**
 * Collect all .jsonl session files from ~/.claude/projects/.
 */
export function collectSessionFiles(rootDir?: string): SessionFile[] {
  const dir = rootDir ?? PROJECTS_DIR;
  const files: SessionFile[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(dir);
  } catch {
    return files;
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(dir, projectDir);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch { continue; }

    for (const file of readdirSync(projectPath)) {
      if (file.endsWith(".jsonl")) {
        const filePath = join(projectPath, file);
        const turns = parseSession(filePath);
        files.push({
          path: filePath,
          platform: "claude-code",
          turns,
          projectFolder: projectDir,
          sourceId: `claude-code:${filePath}`,
        });
      }
    }
  }

  return files;
}
