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

function json(res: ServerResponse, data: unknown, status = 200, origin = "*"): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
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

  // GET /api/brain?min_importance=0.0[&stream=1]
  // Uses recallSummaries (10x lighter than full recall — no content field).
  // Returns { nodes } for the explorer graph/cards. Content is fetched on
  // demand via GET /api/memory/:id when the user opens a provenance panel.
  // No hard node cap — min_importance is the natural filter.
  //
  // ?stream=1  →  NDJSON chunked response; each line is:
  //   { nodes: Node[], total: number }
  // Allows the client to start rendering after the first 100 nodes rather
  // than waiting for the full payload. A setImmediate tick between each
  // batch yields the event loop so TCP can flush each chunk individually.
  if (path === "/api/brain") {
    const minImportance = Number(url.searchParams.get("min_importance") ?? 0);
    const stream = url.searchParams.get("stream") === "1";
    const summaries = await brain.recallSummaries({
      limit: 10000,
      minImportance: minImportance > 0 ? minImportance : undefined,
    });
    const nodes = summaries.map((m: any) => ({
      id: m.id,
      type: m.memory_type ?? "episodic",
      summary: m.summary ?? "",
      content: "",  // not included in summaries; fetched on demand
      tags: m.tags ?? [],
      source: m.source ?? "",
      importance: m.importance ?? 0.5,
      decay: m.decay_factor ?? 1,
      createdAt: m.created_at,
      evidenceIds: [],
    }));

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      const BATCH = 100;
      const tick = () => new Promise<void>(r => setImmediate(r));
      if (nodes.length === 0) {
        res.write(JSON.stringify({ nodes: [], total: 0 }) + "\n");
      } else {
        for (let i = 0; i < nodes.length; i += BATCH) {
          res.write(JSON.stringify({
            nodes: nodes.slice(i, i + BATCH),
            total: nodes.length,
          }) + "\n");
          await tick(); // yield event loop so each batch flushes as its own TCP segment
        }
      }
      res.end();
      return;
    }

    return json(res, { nodes, total: nodes.length });
  }

  // GET /api/memory/:id
  // Hydrates a single memory's full content. Called by explore.html when the
  // user opens a provenance panel and the node has no cached content.
  const memoryGetMatch = path.match(/^\/api\/memory\/(\d+)$/);
  if (memoryGetMatch && req.method === "GET") {
    const id = Number(memoryGetMatch[1]);
    const [mem] = await brain.hydrate([id]);
    if (!mem) return json(res, { error: "Not found" }, 404);
    return json(res, mem);
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

    // P4: Use brain.formatContext() for consistent LLM-ready memory formatting
    // Normalise client-sent fields to match the Memory interface
    const memoryObj = {
      ...memory,
      memory_type: memory.memory_type ?? memory.type ?? "semantic",
      tags: memory.tags ?? [],
      importance: memory.importance ?? 0.5,
      decay_factor: memory.decay_factor ?? memory.decay ?? 1,
      created_at: memory.created_at ?? memory.createdAt ?? "",
      evidence_ids: memory.evidence_ids ?? memory.evidenceIds ?? [],
    };
    const memCtx = brain.formatContext([memoryObj as any]);

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
import type { Server } from "node:http";

/**
 * Handle a single explorer request (UI + API routes).
 *
 * Called by server.ts for all non-MCP requests. Exported so the HTTP
 * server can be shared with the MCP Streamable HTTP transport.
 */
export async function handleExplorerRequest(
  brain: Cortex,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  await handleRequest(brain, req, res);
}

/**
 * Start a standalone explorer HTTP server (legacy — used by scripts/explorer.ts).
 */
export function startExplorer(brain: Cortex, port: number): Server {
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

  return server;
}
