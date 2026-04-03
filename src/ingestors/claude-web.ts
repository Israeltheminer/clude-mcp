import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { homedir } from "os";
import type { Turn, SessionFile } from "./types.js";

const DROP_DIR = join(homedir(), ".claude", "imports", "claude-web");

interface ClaudeWebMessage {
  uuid?: string;
  sender: "human" | "assistant";
  text: string;
  created_at?: string;
}

interface ClaudeWebConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  model?: string;
  chat_messages?: ClaudeWebMessage[];
}

function parseConversations(
  data: ClaudeWebConversation[],
  sourcePath: string,
): SessionFile[] {
  const sessions: SessionFile[] = [];

  for (const conv of data) {
    if (!conv.chat_messages || conv.chat_messages.length < 2) continue;

    const turns: Turn[] = [];
    for (const msg of conv.chat_messages) {
      const role = msg.sender === "human" ? "user" : "assistant";
      const text = (msg.text ?? "").trim();
      if (text.length < 20) continue;

      turns.push({
        role,
        text,
        timestamp: msg.created_at ?? conv.created_at ?? "",
      });
    }

    if (turns.length < 2) continue;

    const idFragment = conv.uuid ?? conv.name ?? "untitled";
    sessions.push({
      path: `${sourcePath}#${conv.name ?? conv.uuid ?? "untitled"}`,
      platform: "claude-web",
      turns,
      sourceId: `claude-web:${idFragment}`,
    });
  }

  return sessions;
}

export function parseClaudeWebExport(filePath: string): SessionFile[] {
  const ext = extname(filePath).toLowerCase();

  if (ext === ".json") {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const conversations = Array.isArray(raw) ? raw : [raw];
    return parseConversations(conversations, filePath);
  }

  if (ext === ".zip") {
    let AdmZip: any;
    try {
      AdmZip = require("adm-zip");
    } catch {
      throw new Error(
        "adm-zip is required to parse Claude ZIP exports. Install it: npm i adm-zip",
      );
    }
    const zip = new AdmZip(filePath);
    const entry =
      zip.getEntry("conversations.json") ?? zip.getEntry("claude_conversations.json");
    if (!entry) {
      throw new Error(`No conversations.json found in ZIP: ${filePath}`);
    }
    const raw = JSON.parse(entry.getData().toString("utf8"));
    const conversations = Array.isArray(raw) ? raw : [raw];
    return parseConversations(conversations, filePath);
  }

  throw new Error(`Unsupported Claude web export format: ${ext}`);
}

export function collectClaudeWebFiles(dropDir?: string): SessionFile[] {
  const dir = dropDir ?? DROP_DIR;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return [];
  }

  const sessions: SessionFile[] = [];

  for (const file of readdirSync(dir)) {
    const ext = extname(file).toLowerCase();
    if (ext !== ".json" && ext !== ".zip") continue;

    try {
      sessions.push(...parseClaudeWebExport(join(dir, file)));
    } catch {
      // Skip unparseable files
    }
  }

  return sessions;
}
