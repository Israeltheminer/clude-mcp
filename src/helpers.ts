/**
 * @module helpers
 *
 * Shared utility types and functions used across all handler modules.
 *
 * Centralising these here serves two purposes:
 *
 *   1. Avoids circular imports — tool, resource, and prompt handlers all need
 *      `ok()` and `isCortexV2()`, but neither should know about the other.
 *      A shared leaf module breaks the potential cycle.
 *
 *   2. Single source of truth — if the MCP response envelope format changes
 *      (e.g. new content block types), only this file needs updating.
 *
 * ## MCP Tool Response Format
 *
 * Every tool handler must return an object of the shape:
 *
 * ```json
 * {
 *   "content": [
 *     { "type": "text", "text": "<JSON string>" }
 *   ]
 * }
 * ```
 *
 * The `ok()` helper wraps any value in this envelope automatically.
 *
 * ## CortexV2 Duck-Typing
 *
 * clude-bot ships two brain classes: `Cortex` (base) and `CortexV2` (extended).
 * CortexV2 adds Memory Pack methods that are not present on the base class.
 * Because we cannot always guarantee which version is installed, we detect
 * CortexV2 at runtime via duck-typing rather than `instanceof`, and use the
 * `CortexV2Brain` intersection type to get TypeScript coverage on those methods.
 */

import type { Cortex } from "clude-bot";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A generic callable type used to annotate duck-typed CortexV2 methods.
 *
 * TypeScript's built-in `Function` type is deliberately vague — it accepts any
 * arity and return type without enforcing call-site types. `AnyFn` is still
 * wide, but it's explicit about the intent: "this is a function of unknown
 * signature that we are calling via duck-typing."
 *
 * Used in the `CortexV2Brain` intersection type below.
 */
export type AnyFn = (...args: unknown[]) => unknown;

/**
 * The shape of an MCP tool result.
 *
 * Exported so that handler files can annotate their return types explicitly,
 * making it obvious at a glance that they produce valid MCP responses.
 */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

/**
 * Intersection type representing a Cortex instance that also has the
 * CortexV2 Memory Pack API surface.
 *
 * Used as the narrowed type inside `isCortexV2()` branches so TypeScript
 * allows calls to `exportPack`, `importPack`, etc. without casting to `any`.
 *
 * The five methods listed are the complete public Memory Pack API as of
 * clude-bot v2.6.x:
 *   - exportPack   — collects memories into a portable signed bundle
 *   - importPack   — writes a parsed pack into the local memory store
 *   - serializePack         — serialises a pack to a JSON string
 *   - serializePackMarkdown — serialises a pack to Markdown
 *   - parsePack    — deserialises a JSON string back into a pack object
 */
export type CortexV2Brain = Cortex & {
  exportPack: AnyFn;
  importPack: AnyFn;
  serializePack: AnyFn;
  serializePackMarkdown: AnyFn;
  parsePack: AnyFn;
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Wrap a value in an MCP tool-response envelope.
 *
 * MCP requires every tool to return `{ content: [{ type, text }] }`. This
 * helper serialises `data` as pretty-printed JSON (2-space indent) so the
 * calling agent can read it clearly in its context window.
 *
 * @param data - Any JSON-serialisable value. Passed through `JSON.stringify`.
 * @returns A valid MCP tool result object.
 *
 * @example
 * return ok({ memory_id: 42, stored: true });
 * return ok({ count: memories.length, memories });
 */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Type guard — narrows a `Cortex` instance to `CortexV2Brain`.
 *
 * Returns `true` if `brain` has the `exportPack` method, which is the
 * definitive marker of a CortexV2 instance. This approach is used instead
 * of `instanceof CortexV2` because:
 *
 *   1. CortexV2 may not be available in older versions of clude-bot, in which
 *      case the server falls back to the base Cortex class.
 *   2. Dynamic `import("clude-bot")` in brain.ts means the constructor
 *      reference is captured in a local variable, making `instanceof` checks
 *      against the module-level export unreliable.
 *
 * If this guard returns false, `export_pack` and `import_pack` tool calls will
 * throw an MCP `MethodNotFound` error with a clear message.
 *
 * @param brain - The active Cortex or CortexV2 instance.
 * @returns `true` if `brain` is a CortexV2 instance with Memory Pack support.
 */
export function isCortexV2(brain: Cortex): brain is CortexV2Brain {
  return typeof (brain as any).exportPack === "function";
}
