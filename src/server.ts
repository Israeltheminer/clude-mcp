/**
 * @module server
 *
 * The main server bootstrap and lifecycle manager.
 *
 * ## Transport
 *
 * clude uses MCP's Streamable HTTP transport, served on the same HTTP server
 * as the memory explorer UI. This means:
 *
 *   - The server runs as a standalone process (not a subprocess of Claude Code)
 *   - It persists across Claude Code sessions
 *   - The explorer UI is always available at http://localhost:<port>
 *   - MCP clients connect via http://localhost:<port>/mcp
 *
 * ## Endpoints
 *
 *   POST /mcp        → MCP JSON-RPC (Streamable HTTP transport)
 *   GET  /mcp        → MCP SSE stream (server→client notifications)
 *   DELETE /mcp      → MCP session termination
 *   GET  /           → Explorer UI
 *   GET  /api/*      → Explorer API routes
 *
 * ## Shutdown
 *
 * SIGINT and SIGTERM close all MCP transports, stop the scheduler,
 * destroy the brain, and exit cleanly.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { log } from "./log.js";
import { buildConfig } from "./config.js";
import { createBrain } from "./brain.js";
import { registerToolHandlers } from "./tools/index.js";
import { registerResourceHandlers } from "./resources/handlers.js";
import { registerPromptHandlers } from "./prompts/index.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { createInteractionTracker } from "./interaction-tracker.js";
import { handleExplorerRequest } from "./http.js";

// ---------------------------------------------------------------------------
// MCP server factory — creates a fresh Server + handlers per session
// ---------------------------------------------------------------------------

function createMcpServer(brain: any, tracker: any): Server {
  const server = new Server(
    { name: "clude", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  registerToolHandlers(server, brain, tracker);
  registerResourceHandlers(server, brain);
  registerPromptHandlers(server, brain);

  return server;
}

// ---------------------------------------------------------------------------
// JSON body parser for raw http.IncomingMessage
// ---------------------------------------------------------------------------

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Bootstrap and run the clude MCP server over Streamable HTTP.
 */
export async function main(): Promise<void> {
  const config = buildConfig();

  let brain;
  try {
    brain = await createBrain(config);
    log("Cortex initialized.");
  } catch (err) {
    log("FATAL — could not initialize Cortex:", String(err));
    process.exit(1);
  }

  const tracker = createInteractionTracker(brain);

  // ── Stdio transport (for Claude Desktop / Antigravity) ───────────────────
  const stdioTransport = new StdioServerTransport();
  const stdioServer = createMcpServer(brain, tracker);
  await stdioServer.connect(stdioTransport);

  // ── Session management ──────────────────────────────────────────────────
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // ── HTTP server ─────────────────────────────────────────────────────────
  const port = Number(process.env.EXPLORER_PORT ?? 3141);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    // ── MCP Streamable HTTP endpoint ────────────────────────────────────
    if (path === "/mcp") {
      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Last-Event-ID",
        });
        res.end();
        return;
      }

      try {
        if (req.method === "POST") {
          const body = await parseJsonBody(req);
          const sessionId = req.headers["mcp-session-id"] as string | undefined;

          if (sessionId && transports[sessionId]) {
            // Existing session
            await transports[sessionId].handleRequest(req, res, body);
          } else if (!sessionId && isInitializeRequest(body)) {
            // New session
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid: string) => {
                transports[sid] = transport;
                log(`MCP session initialized: ${sid}`);
              },
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid && transports[sid]) {
                delete transports[sid];
                log(`MCP session closed: ${sid}`);
              }
            };

            const mcpServer = createMcpServer(brain, tracker);
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, body);
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: No valid session ID provided" },
              id: null,
            }));
          }
        } else if (req.method === "GET") {
          // SSE stream for server→client notifications
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (!sessionId || !transports[sessionId]) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid or missing session ID");
            return;
          }
          await transports[sessionId].handleRequest(req, res);
        } else if (req.method === "DELETE") {
          // Session termination
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (!sessionId || !transports[sessionId]) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid or missing session ID");
            return;
          }
          await transports[sessionId].handleRequest(req, res);
        } else {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end("Method not allowed");
        }
      } catch (err: any) {
        log("MCP request error:", String(err));
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }));
        }
      }
      return;
    }

    // ── Explorer UI + API ───────────────────────────────────────────────
    try {
      await handleExplorerRequest(brain, req, res);
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message ?? "Internal error" }));
      }
    }
  });

  httpServer.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      log(`Port ${port} already in use — is another clude instance running?`);
      process.exit(1);
    } else {
      log("HTTP server error:", err.message);
    }
  });

  // ── Scheduler ───────────────────────────────────────────────────────────
  const scheduler = startScheduler(brain);

  // ── Shutdown ────────────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    log("Shutting down...");
    await tracker.flush();
    tracker.destroy();
    stopScheduler(scheduler);

    try {
      await stdioTransport.close();
    } catch {}

    for (const sid of Object.keys(transports)) {
      try {
        await transports[sid].close();
        delete transports[sid];
      } catch {}
    }

    httpServer.close();
    brain.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Start ───────────────────────────────────────────────────────────────
  httpServer.listen(port, "127.0.0.1", () => {
    log(`clude ready → http://localhost:${port}`);
    log(`MCP endpoint → http://localhost:${port}/mcp`);
  });
}
