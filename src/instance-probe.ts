/**
 * Detect a running clude HTTP server (same machine) so a second stdio MCP
 * client can attach via the bridge instead of spawning a duplicate process.
 */

export function explorerPort(): number {
  return Number(process.env.EXPLORER_PORT ?? 3141);
}

export function attachToRunningEnabled(): boolean {
  return process.env.CLUDE_ATTACH !== "0" && process.env.CLUDE_NO_ATTACH !== "1";
}

/** GET /_clude/health — must match server.ts */
const HEALTH_PATH = "/_clude/health";
const MCP_PATH = "/mcp";

export async function isCludeHttpRunning(port: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}${HEALTH_PATH}`;
  const attempts = 2;
  const pauseMs = 350;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(900) });
      if (!res.ok) {
        if (i + 1 < attempts) await delay(pauseMs);
        continue;
      }
      const j = (await res.json()) as { ok?: unknown; server?: unknown };
      const ok = j?.ok === true && j?.server === "clude-mcp";
      if (ok) return true;
      return false;
    } catch {
      if (i + 1 < attempts) await delay(pauseMs);
    }
  }
  return false;
}

/**
 * Backward-compatible probe:
 * older clude builds may not expose /_clude/health but still serve /mcp.
 */
export async function isMcpEndpointLikelyClude(port: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}${MCP_PATH}`;
  try {
    const res = await fetch(url, {
      method: "OPTIONS",
      signal: AbortSignal.timeout(900),
    });
    // clude returns 204 for /mcp OPTIONS.
    if (res.status === 204) return true;

    // Some proxies/middleware could alter status but still indicate MCP shape.
    const allow = res.headers.get("allow") ?? "";
    if (allow.includes("POST") || allow.includes("OPTIONS")) return true;
  } catch {
    // ignore
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
