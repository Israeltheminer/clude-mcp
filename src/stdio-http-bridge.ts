/**
 * stdio MCP (host subprocess) ↔ Streamable HTTP MCP to an existing clude
 * instance. Keeps one cortex + one scheduler; second IDE attaches here.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./log.js";

export async function runStdioHttpBridge(mcpUrl: URL): Promise<void> {
  log(`Attaching stdio MCP to existing clude at ${mcpUrl.toString()} (one shared instance).`);

  const stdio = new StdioServerTransport();
  const http = new StreamableHTTPClientTransport(mcpUrl);

  let upstreamChain = Promise.resolve();
  stdio.onmessage = (msg: JSONRPCMessage) => {
    upstreamChain = upstreamChain
      .then(() => http.send(msg))
      .catch((err: unknown) => {
        log("bridge: failed to forward message to HTTP:", String(err));
      });
  };

  http.onmessage = (msg: JSONRPCMessage) => {
    void stdio.send(msg).catch((err: unknown) => {
      log("bridge: failed to write MCP response to stdio:", String(err));
    });
  };

  http.onerror = (err: Error) => {
    log("bridge: HTTP transport error:", err.message);
  };

  stdio.onerror = (err: Error) => {
    log("bridge: stdio transport error:", err.message);
  };

  await http.start();

  const shutdown = async (): Promise<void> => {
    try {
      await http.terminateSession();
    } catch {
      /* DELETE optional per spec */
    }
    try {
      await http.close();
    } catch {
      /* ignore */
    }
    try {
      await stdio.close();
    } catch {
      /* ignore */
    }
  };

  const onSignal = (): void => {
    void shutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  process.stdin.on("end", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await stdio.start();
}
