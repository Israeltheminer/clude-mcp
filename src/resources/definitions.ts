/**
 * @module resources/definitions
 *
 * Static MCP resource definitions for the clude memory server.
 *
 * ## What Are MCP Resources?
 *
 * Resources are named, URI-addressable read endpoints that MCP clients can
 * subscribe to or poll. Unlike tools (which accept arguments), resources are
 * parameter-free views over server state. They are analogous to REST GET
 * endpoints with stable URLs.
 *
 * The clude server exposes three resources, each providing a live view into
 * a different slice of the memory store:
 *
 * ## memory://stats
 *
 * Returns the same aggregate statistics as the `get_stats` tool but as a
 * subscribable resource. Clients that support resource subscriptions (e.g.
 * Claude Desktop) can refresh this view automatically.
 *
 * Useful for a persistent "memory health" widget in an IDE sidebar.
 *
 * ## memory://recent/24h
 *
 * Returns memories created or accessed in the last 24 hours, up to 50
 * results. The 24-hour window and limit are fixed — for a configurable
 * window use the `get_recent` tool instead.
 *
 * Useful for a "what happened today" context injection at session start.
 *
 * ## memory://self-model
 *
 * Returns all `self_model` memories — the agent's persistent identity,
 * preferences, and working style as captured across all sessions.
 *
 * Useful for injecting the self-model as a system-prompt preamble so the
 * agent always "knows itself" without a separate recall step.
 *
 * ## MIME Type
 *
 * All three resources use `application/json`. The body is pretty-printed
 * JSON (2-space indent) for readability in MCP client UIs.
 */

/** Describes a single MCP resource (URI + metadata). */
export interface ResourceMeta {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * The complete list of resources exposed by the clude MCP server.
 *
 * Passed verbatim into the `ListResourcesRequestSchema` response envelope.
 * Add new entries here and add a matching case in `resources/handlers.ts`.
 */
export const RESOURCES: ResourceMeta[] = [
  {
    uri: "memory://stats",
    name: "Memory Statistics",
    description:
      "Live aggregate stats: total count, breakdown by type, " +
      "average importance and decay, and graph link counts.",
    mimeType: "application/json",
  },
  {
    uri: "memory://recent/24h",
    name: "Recent Memories (24 h)",
    description:
      "Memories created or accessed in the last 24 hours. " +
      "Returns up to 50 memories, newest first.",
    mimeType: "application/json",
  },
  {
    uri: "memory://self-model",
    name: "Self Model",
    description:
      "All self_model memories: the agent's persistent identity, " +
      "preferences, and working style. Decay rate: 1%/day.",
    mimeType: "application/json",
  },
];
