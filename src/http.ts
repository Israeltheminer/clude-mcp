/**
 * @module http
 *
 * Lightweight HTTP server that runs alongside the stdio MCP transport,
 * sharing the same brain (Cortex) instance. Enables the local memory
 * explorer UI at http://localhost:<EXPLORER_PORT>.
 *
 * ## Endpoints
 *
 *   GET /               → explore.html (memory explorer UI)
 *   GET /brain.html     → brain.html (3D neural map, loaded as iframe)
 *   GET /api/brain      → { nodes: Memory[] } for initial explorer load
 *   GET /api/recall     → { memories: Memory[] } for semantic search
 *   GET /api/stats      → aggregate memory statistics
 *   GET /api/recent     → recent memories (past N hours)
 *
 * ## Why No New Dependencies
 *
 * Uses only Node.js built-in modules (node:http, node:fs/promises,
 * node:path, node:url) so no package.json changes are needed.
 *
 * ## Security
 *
 * The server binds to 127.0.0.1 only (loopback). It is NOT accessible
 * from the network. No auth is needed — if you can reach it, you're on
 * the same machine as the MCP server.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import type { Cortex } from "clude-bot";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Body reader helper
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Resolve the public/ directory relative to this compiled file.
// __dirname is the dist/ folder at runtime, so go one level up to project root.
const PUBLIC = join(__dirname, "..", "public");

async function serveStatic(
  filePath: string,
  res: ServerResponse
): Promise<void> {
  try {
    const data = await readFile(join(PUBLIC, filePath));
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// JSON API helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://localhost:" + (res.socket as any)?.localPort,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { out[k] = v; });
  return out;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(
  brain: Cortex,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const path = url.pathname;

  // ── API Routes ────────────────────────────────────────────────────────────

  // GET /api/brain?limit=500
  // Returns { nodes: Memory[] } — the format expected by explore.html's
  // loadBrainData(). Normalises field names so the explorer renders correctly.
  if (path === "/api/brain") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 1000);
    const memories = await brain.recall({ limit });
    const nodes = memories.map((m: any) => ({
      id: m.id,
      type: m.type ?? m.memory_type ?? "episodic",
      summary: m.summary ?? "",
      content: m.content ?? "",
      tags: m.tags ?? [],
      source: m.source ?? m.source_label ?? "",
      importance: m.importance ?? 0.5,
      decay: m.decay_factor ?? m.decay ?? 1,
      createdAt: m.created_at ?? m.createdAt,
      evidenceIds: m.evidence_ids ?? m.evidenceIds ?? [],
    }));
    return json(res, { nodes, total: nodes.length });
  }

  // GET /api/recall?query=...&limit=30
  // Returns { memories: Memory[] } for semantic search. Explorer maps _score.
  if (path === "/api/recall") {
    const q = parseQuery(url);
    const query = q.query ?? "";
    const limit = Math.min(Number(q.limit ?? 30), 100);
    if (!query.trim()) return json(res, { memories: [] });
    const memories = await brain.recall({ query, limit });
    return json(res, { memories });
  }

  // GET /api/stats
  if (path === "/api/stats") {
    const stats = await brain.stats();
    return json(res, stats);
  }

  // GET /api/recent?hours=24&limit=50
  if (path === "/api/recent") {
    const q = parseQuery(url);
    const hours = Number(q.hours ?? 24);
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const memories = await brain.recent(hours, undefined, limit);
    return json(res, { count: memories.length, memories });
  }

  // POST /api/memory/:id/explain  { question, memory, ancestors, descendants, related, history }
  // Supports multi-turn conversation: `history` is [{role, content}] of prior turns.
  const explainMatch = path.match(/^\/api\/memory\/(\d+)\/explain$/);
  if (explainMatch && req.method === "POST") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return json(res, { error: "ANTHROPIC_API_KEY not configured" }, 503);
    }
    const body = (await readBody(req)) as any;
    const question: string = body?.question ?? "";
    const memory: any = body?.memory ?? {};
    const history: Array<{ role: string; content: string }> = body?.history ?? [];

    // Build a rich system prompt that includes this memory's full context
    const memCtx = [
      `Memory #${memory.id || "?"}`,
      `Type: ${memory.memory_type || memory.type || "unknown"}`,
      `Summary: ${memory.summary || ""}`,
      `Content:\n${memory.content || ""}`,
      `Tags: ${(memory.tags || []).join(", ")}`,
      `Importance: ${((memory.importance ?? 0.5) * 100).toFixed(0)}%`,
      `Created: ${memory.created_at || memory.createdAt || "?"}`,
    ].join("\n");

    const related: any[] = [
      ...(body?.ancestors || []),
      ...(body?.descendants || []),
      ...(body?.related || []),
    ].slice(0, 12);
    const relatedCtx = related.length
      ? "\n\nConnected memories:\n" +
        related
          .map((r: any) => `- [${r.relation}] ${r.summary || (r.content || "").slice(0, 120)}`)
          .join("\n")
      : "";

    const systemPrompt =
      "You are a personal memory analyst. The user is exploring one of their AI agent's memories " +
      "and wants to have a conversation about it. Be concise, specific, and insightful. " +
      "Reference the memory content and its connections directly. Do not be generic.\n\n" +
      "=== MEMORY CONTEXT ===\n" + memCtx + relatedCtx;

    // Build the messages array: prior history + new user question
    // For the very first turn, prepend a context-setting user message if history is empty
    type AnthropicMessage = { role: "user" | "assistant"; content: string };
    const messages: AnthropicMessage[] = [];

    if (history.length === 0) {
      // First turn: seed with a brief system-level context message so Claude knows the memory
      messages.push({
        role: "user",
        content: `I'd like to explore this memory. ${question || "What is this memory about and how does it connect to others?"}`,
      });
    } else {
      // Replay prior turns, then append the new question
      for (const turn of history) {
        messages.push({ role: turn.role as "user" | "assistant", content: turn.content });
      }
      messages.push({ role: "user", content: question });
    }

    try {
      const client = new Anthropic({ apiKey });
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        system: systemPrompt,
        messages,
      });
      const explanation =
        msg.content?.[0]?.type === "text" ? (msg.content[0] as any).text : "";
      return json(res, { explanation });
    } catch (err: any) {
      return json(res, { error: err.message ?? "Explain failed" }, 500);
    }
  }

  // ── Static Files ──────────────────────────────────────────────────────────

  if (path === "/" || path === "/explore.html") {
    return serveStatic("explore.html", res);
  }

  // Serve anything else from public/ (brain.html, assets, etc.)
  return serveStatic(path, res);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Start the local memory explorer HTTP server.
 *
 * Binds to 127.0.0.1 (loopback only). Safe to call alongside the stdio
 * MCP transport — both can run concurrently in the same Node.js process.
 *
 * @param brain - Fully initialised Cortex instance shared with MCP tools.
 * @param port  - Port to listen on (from EXPLORER_PORT env var).
 */
export function startExplorer(brain: Cortex, port: number): void {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(brain, req, res);
    } catch (err: any) {
      if (!res.headersSent) {
        json(res, { error: err.message ?? "Internal error" }, 500);
      }
    }
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `[clude] Port ${port} already in use — HTTP explorer skipped (another instance is likely running).\n`
      );
    } else {
      process.stderr.write(`[clude] HTTP server error: ${err.message}\n`);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(
      `[clude] Memory explorer → http://localhost:${port}\n`
    );
  });
}
