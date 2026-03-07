/**
 * @module log
 *
 * Stderr-only logging utility for the clude MCP server.
 *
 * ## Why stderr?
 *
 * The MCP protocol uses stdio as its transport layer. Specifically:
 *   - stdout  →  exclusive JSON-RPC channel (client reads from this)
 *   - stderr  →  diagnostic output (ignored by the MCP client)
 *
 * Any bytes written to stdout that are not valid JSON-RPC frames corrupt the
 * protocol stream and cause the client (Claude Desktop, Cursor, etc.) to
 * disconnect with a parse error. This module exists to ensure all diagnostic
 * output is unconditionally routed to stderr.
 *
 * ## Why not console.log / console.error?
 *
 * `console.log` writes to stdout. `console.error` writes to stderr and would
 * technically be safe, but using a dedicated module makes the intent explicit
 * and prevents accidental `console.log` calls from slipping through in future
 * edits.
 */

/**
 * Write a diagnostic line to stderr.
 *
 * Accepts any number of arguments — same call signature as `console.log` —
 * and joins them with spaces before appending a newline. Never touches stdout.
 *
 * @param args - Values to log. Objects are not JSON-serialised automatically;
 *               pass `JSON.stringify(obj)` explicitly if needed.
 *
 * @example
 * log("Cortex initialized.");
 * log("Auto-scored importance:", score, "for", summary);
 * log("FATAL:", err.message);
 */
export function log(...args: unknown[]): void {
  process.stderr.write(args.join(" ") + "\n");
}
