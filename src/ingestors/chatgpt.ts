import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { homedir } from "os";
import type { Turn, SessionFile } from "./types.js";

const DROP_DIR = join(homedir(), ".claude", "imports", "chatgpt");

// ---------------------------------------------------------------------------
// ChatGPT conversation.json parsing
// ---------------------------------------------------------------------------

interface ChatGPTNode {
  id: string;
  message?: {
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    create_time?: number;
  };
  parent?: string | null;
  children?: string[];
}

interface ChatGPTConversation {
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<string, ChatGPTNode>;
}

/**
 * Walk the ChatGPT mapping tree from root to leaf, following the first child
 * at each branch to produce a linear turn sequence.
 */
function walkTree(mapping: Record<string, ChatGPTNode>): Turn[] {
  // Find root node (no parent, or parent not in mapping)
  let rootId: string | undefined;
  for (const [id, node] of Object.entries(mapping)) {
    if (!node.parent || !mapping[node.parent]) {
      rootId = id;
      break;
    }
  }
  if (!rootId) return [];

  const turns: Turn[] = [];
  let currentId: string | undefined = rootId;

  while (currentId) {
    const node: ChatGPTNode = mapping[currentId];
    if (!node) break;

    const msg = node.message;
    if (msg?.author?.role && msg.content?.parts) {
      const role = msg.author.role;
      if (role === "user" || role === "assistant") {
        const text = (msg.content.parts ?? [])
          .filter((p: unknown): p is string => typeof p === "string")
          .join("\n")
          .trim();

        if (text.length >= 20) {
          const timestamp = msg.create_time
            ? new Date(msg.create_time * 1000).toISOString()
            : "";
          turns.push({ role, text, timestamp });
        }
      }
    }

    // Follow first child
    currentId = node.children?.[0];
  }

  return turns;
}

/**
 * Parse a conversations.json array into SessionFile[].
 */
function parseConversationsJson(data: ChatGPTConversation[], sourcePath: string): SessionFile[] {
  const sessions: SessionFile[] = [];

  for (const conv of data) {
    if (!conv.mapping) continue;
    const turns = walkTree(conv.mapping);
    if (turns.length < 2) continue;

    sessions.push({
      path: `${sourcePath}#${conv.title ?? "untitled"}`,
      platform: "chatgpt",
      turns,
    });
  }

  return sessions;
}

/**
 * Parse a ChatGPT export file (.json or .zip) into SessionFile[].
 */
export function parseChatGPTExport(filePath: string): SessionFile[] {
  const ext = extname(filePath).toLowerCase();

  if (ext === ".json") {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const conversations = Array.isArray(raw) ? raw : [raw];
    return parseConversationsJson(conversations, filePath);
  }

  if (ext === ".zip") {
    // Dynamic import to avoid hard dependency if adm-zip isn't installed
    let AdmZip: any;
    try {
      AdmZip = require("adm-zip");
    } catch {
      throw new Error(
        "adm-zip is required to parse ChatGPT ZIP exports. Install it: npm i adm-zip"
      );
    }
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry("conversations.json");
    if (!entry) {
      throw new Error(`No conversations.json found in ZIP: ${filePath}`);
    }
    const raw = JSON.parse(entry.getData().toString("utf8"));
    const conversations = Array.isArray(raw) ? raw : [raw];
    return parseConversationsJson(conversations, filePath);
  }

  throw new Error(`Unsupported ChatGPT export format: ${ext}`);
}

/**
 * Collect ChatGPT export files from the drop folder.
 * Creates the drop folder if it doesn't exist.
 */
export function collectChatGPTFiles(dropDir?: string): SessionFile[] {
  const dir = dropDir ?? DROP_DIR;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return [];
  }

  const sessions: SessionFile[] = [];

  for (const file of readdirSync(dir)) {
    const ext = extname(file).toLowerCase();
    if (ext !== ".json" && ext !== ".zip") continue;

    const filePath = join(dir, file);
    try {
      sessions.push(...parseChatGPTExport(filePath));
    } catch {
      // Skip unparseable files silently
    }
  }

  return sessions;
}
