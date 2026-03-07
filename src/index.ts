#!/usr/bin/env node
/**
 * clude-mcp — MCP server for the clude-bot persistent memory SDK
 *
 * Exposes the full Cortex/CortexV2 API surface as MCP tools, resources, and prompts.
 * Configured entirely via environment variables (see .env.example).
 *
 * Transport: stdio (stdout = protocol, stderr = logs)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Cortex, type Memory, type MemorySummary, type MemoryType } from "clude-bot";

// ---------------------------------------------------------------------------
// Config — built from environment variables at startup
// ---------------------------------------------------------------------------

function buildConfig(): ConstructorParameters<typeof Cortex>[0] {
  const apiKey = process.env.CORTEX_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (apiKey) {
    const baseUrl = process.env.CORTEX_BASE_URL;
    return { hosted: { apiKey, ...(baseUrl && { baseUrl }) } };
  }

  if (supabaseUrl && supabaseKey) {
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const embeddingProvider = process.env.EMBEDDING_PROVIDER as "voyage" | "openai" | undefined;
    const voyageApiKey = process.env.VOYAGE_API_KEY;
    const openaiApiKey = process.env.OPENAI_API_KEY;

    return {
      supabase: { url: supabaseUrl, serviceKey: supabaseKey },
      ...(anthropicApiKey && { anthropic: { apiKey: anthropicApiKey } }),
      ...(embeddingProvider && {
        embedding: {
          provider: embeddingProvider,
          apiKey: embeddingProvider === "voyage" ? voyageApiKey! : openaiApiKey!,
        },
      }),
    };
  }

  throw new Error(
    "Missing config: set CORTEX_API_KEY for hosted mode, " +
      "or SUPABASE_URL + SUPABASE_KEY for self-hosted mode."
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "store_memory",
    description:
      "Persist a new memory. Returns the memory ID on success. " +
      "Memories are scored, embedded, and linked to the knowledge graph automatically.",
    inputSchema: {
      type: "object",
      required: ["type", "content", "summary", "source"],
      properties: {
        type: {
          type: "string",
          enum: ["episodic", "semantic", "procedural", "self_model"],
          description:
            "episodic=events/conversations, semantic=facts/knowledge, " +
            "procedural=how-to steps, self_model=identity/preferences",
        },
        content: {
          type: "string",
          description: "Full memory content (stored verbatim).",
        },
        summary: {
          type: "string",
          description: "Short human-readable summary (used for retrieval scoring).",
        },
        source: {
          type: "string",
          description: "Origin identifier, e.g. 'chat', 'document', 'tool'.",
        },
        source_id: {
          type: "string",
          description: "Optional external ID to deduplicate (e.g. message ID).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Topic tags for keyword retrieval.",
        },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Importance score 0–1. Omit to auto-score via LLM (requires Anthropic config).",
        },
        emotional_valence: {
          type: "number",
          minimum: -1,
          maximum: 1,
          description: "Sentiment: -1 (negative) to +1 (positive). Default 0.",
        },
        related_user: {
          type: "string",
          description: "User identifier to scope this memory (for multi-user agents).",
        },
        related_wallet: {
          type: "string",
          description: "Solana wallet address to associate with this memory.",
        },
      },
    },
  },

  {
    name: "recall_memories",
    description:
      "Retrieve memories using hybrid search: vector similarity + keyword matching + " +
      "knowledge-graph traversal. Returns full Memory objects ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query. Omit to retrieve by metadata only.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter to memories with any of these tags.",
        },
        memory_types: {
          type: "array",
          items: {
            type: "string",
            enum: ["episodic", "semantic", "procedural", "self_model"],
          },
          description: "Restrict to these memory types.",
        },
        related_user: {
          type: "string",
          description: "Scope recall to a specific user.",
        },
        related_wallet: {
          type: "string",
          description: "Scope recall to a specific Solana wallet.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "Max memories to return.",
        },
        min_importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Only return memories above this importance threshold.",
        },
        min_decay: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Only return memories with decay_factor above this threshold (freshness filter).",
        },
      },
    },
  },

  {
    name: "recall_summaries",
    description:
      "Lightweight memory retrieval — returns summaries only (no full content). " +
      "Use this to scan for relevant memories cheaply before hydrating specific ones.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        memory_types: {
          type: "array",
          items: { type: "string", enum: ["episodic", "semantic", "procedural", "self_model"] },
        },
        related_user: { type: "string" },
        related_wallet: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 100, default: 20 },
        min_importance: { type: "number", minimum: 0, maximum: 1 },
      },
    },
  },

  {
    name: "hydrate_memories",
    description:
      "Fetch full memory content for specific memory IDs. " +
      "Use after recall_summaries to expand only the memories you actually need.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: {
        ids: {
          type: "array",
          items: { type: "number" },
          minItems: 1,
          maxItems: 50,
          description: "Memory IDs to hydrate (from recall_summaries results).",
        },
      },
    },
  },

  {
    name: "link_memories",
    description:
      "Create a typed directed link between two memories in the knowledge graph. " +
      "Links strengthen via Hebbian reinforcement when both memories are co-recalled.",
    inputSchema: {
      type: "object",
      required: ["source_id", "target_id", "link_type"],
      properties: {
        source_id: { type: "number", description: "Source memory ID." },
        target_id: { type: "number", description: "Target memory ID." },
        link_type: {
          type: "string",
          enum: ["supports", "contradicts", "elaborates", "causes", "resolves", "follows", "relates"],
          description: "Semantic relationship from source → target.",
        },
        strength: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.5,
          description: "Initial link strength 0–1.",
        },
      },
    },
  },

  {
    name: "get_stats",
    description:
      "Return aggregate statistics: total memory count, breakdown by type, " +
      "average importance and decay, and graph link counts.",
    inputSchema: { type: "object", properties: {} },
  },

  {
    name: "get_recent",
    description: "Return memories created or accessed within a recent time window.",
    inputSchema: {
      type: "object",
      required: ["hours"],
      properties: {
        hours: {
          type: "number",
          minimum: 1,
          maximum: 720,
          description: "Look-back window in hours (e.g. 24 for last day).",
        },
        memory_types: {
          type: "array",
          items: { type: "string", enum: ["episodic", "semantic", "procedural", "self_model"] },
          description: "Filter to specific memory types.",
        },
        limit: { type: "number", minimum: 1, maximum: 100, default: 20 },
      },
    },
  },

  {
    name: "get_self_model",
    description:
      "Return all self_model memories — the agent's current identity, preferences, " +
      "and persistent beliefs about itself. These decay the slowest (1%/day).",
    inputSchema: { type: "object", properties: {} },
  },

  {
    name: "decay_memories",
    description:
      "Run the decay pass: reduces importance of stale memories according to " +
      "type-specific daily rates (episodic 7%, semantic 2%, procedural 3%, self_model 1%). " +
      "Returns the number of memories updated. Self-hosted only.",
    inputSchema: { type: "object", properties: {} },
  },

  {
    name: "dream",
    description:
      "Trigger a dream cycle: consolidation → reflection → emergence. " +
      "Compacts episodic memories into semantic knowledge and surfaces novel insights. " +
      "Requires Anthropic config. Self-hosted only.",
    inputSchema: {
      type: "object",
      properties: {
        on_emerge: {
          type: "string",
          description:
            "Optional instruction passed to the emergence phase, e.g. " +
            "'focus on patterns in user behavior'.",
        },
      },
    },
  },

  {
    name: "score_importance",
    description:
      "Use the LLM to estimate how important a piece of information is (0–1 scale). " +
      "Requires Anthropic config. Useful before storing to decide whether to persist at all.",
    inputSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: {
          type: "string",
          description: "The text to score for importance.",
        },
      },
    },
  },

  {
    name: "infer_concepts",
    description:
      "Extract structured concept labels from text using the built-in ontology " +
      "(twelve concept types: person, project, token, location, emotion, etc.). " +
      "Returns an array of concept strings for use as tags.",
    inputSchema: {
      type: "object",
      required: ["summary", "source"],
      properties: {
        summary: { type: "string", description: "Text to analyze." },
        source: {
          type: "string",
          description: "Source context hint (e.g. 'chat', 'document').",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Existing tags to include in concept inference.",
          default: [],
        },
      },
    },
  },

  {
    name: "format_context",
    description:
      "Format an array of memories into an LLM-ready context block. " +
      "Returns a string you can inject into a system prompt. " +
      "Accepts the 'memories' array from recall_memories output.",
    inputSchema: {
      type: "object",
      required: ["memories"],
      properties: {
        memories: {
          type: "array",
          description: "Memory objects from recall_memories or hydrate_memories.",
          items: { type: "object" },
        },
      },
    },
  },

  {
    name: "export_pack",
    description:
      "Export a portable Memory Pack — a signed, self-contained bundle of memories " +
      "that can be shared between agents or imported later. Returns JSON or Markdown.",
    inputSchema: {
      type: "object",
      required: ["name", "description"],
      properties: {
        name: { type: "string", description: "Human-readable pack name." },
        description: { type: "string", description: "What this pack contains." },
        query: {
          type: "string",
          description: "Recall query to select which memories to include.",
        },
        memory_ids: {
          type: "array",
          items: { type: "number" },
          description: "Specific memory IDs to include (overrides query).",
        },
        types: {
          type: "array",
          items: { type: "string", enum: ["episodic", "semantic", "procedural", "self_model"] },
          description: "Filter by memory type (ignored when memory_ids provided).",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Max memories to include.",
        },
        format: {
          type: "string",
          enum: ["json", "markdown"],
          default: "json",
          description: "Output format.",
        },
      },
    },
  },

  {
    name: "import_pack",
    description:
      "Import memories from a Memory Pack JSON string. " +
      "Applies an importance multiplier (default 0.8) to discourage pack flooding.",
    inputSchema: {
      type: "object",
      required: ["pack"],
      properties: {
        pack: {
          type: "string",
          description: "Memory Pack JSON string (from export_pack output).",
        },
        importance_multiplier: {
          type: "number",
          minimum: 0.1,
          maximum: 1.0,
          default: 0.8,
          description: "Scales down imported memory importance to distinguish from native memories.",
        },
        tag_prefix: {
          type: "string",
          description: "Optional prefix added to all imported memory tags, e.g. 'imported'.",
        },
        types: {
          type: "array",
          items: { type: "string", enum: ["episodic", "semantic", "procedural", "self_model"] },
          description: "Only import memories of these types.",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function isCortexV2(brain: Cortex): brain is Cortex & {
  exportPack: Function;
  importPack: Function;
  serializePack: Function;
  serializePackMarkdown: Function;
  parsePack: Function;
} {
  return typeof (brain as any).exportPack === "function";
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main() {
  let brain: Cortex;

  try {
    const config = buildConfig();
    // CortexV2 is backwards-compatible — import it if available
    let BrainClass: typeof Cortex;
    try {
      const { CortexV2 } = await import("clude-bot");
      BrainClass = CortexV2 as unknown as typeof Cortex;
    } catch {
      const { Cortex: C } = await import("clude-bot");
      BrainClass = C;
    }
    brain = new BrainClass(config);
    await brain.init();
    log("Cortex initialized.");
  } catch (err) {
    log("FATAL — could not initialize Cortex:", String(err));
    process.exit(1);
  }

  const server = new Server(
    { name: "clude-mcp", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    try {
      switch (name) {
        // --- store_memory ---------------------------------------------------
        case "store_memory": {
          const id = await brain.store({
            type: args.type as MemoryType,
            content: String(args.content),
            summary: String(args.summary),
            source: String(args.source),
            ...(args.source_id ? { sourceId: String(args.source_id) } : {}),
            ...(args.tags ? { tags: args.tags as string[] } : {}),
            ...(args.importance !== undefined ? { importance: Number(args.importance) } : {}),
            ...(args.emotional_valence !== undefined
              ? { emotionalValence: Number(args.emotional_valence) }
              : {}),
            ...(args.related_user ? { relatedUser: String(args.related_user) } : {}),
            ...(args.related_wallet ? { relatedWallet: String(args.related_wallet) } : {}),
          });
          return ok({ memory_id: id, stored: id !== null });
        }

        // --- recall_memories ------------------------------------------------
        case "recall_memories": {
          const memories = await brain.recall({
            ...(args.query ? { query: String(args.query) } : {}),
            ...(args.tags ? { tags: args.tags as string[] } : {}),
            ...(args.memory_types ? { memoryTypes: args.memory_types as MemoryType[] } : {}),
            ...(args.related_user ? { relatedUser: String(args.related_user) } : {}),
            ...(args.related_wallet ? { relatedWallet: String(args.related_wallet) } : {}),
            ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
            ...(args.min_importance !== undefined ? { minImportance: Number(args.min_importance) } : {}),
            ...(args.min_decay !== undefined ? { minDecay: Number(args.min_decay) } : {}),
          });
          return ok({ count: memories.length, memories });
        }

        // --- recall_summaries -----------------------------------------------
        case "recall_summaries": {
          const summaries = await brain.recallSummaries({
            ...(args.query ? { query: String(args.query) } : {}),
            ...(args.tags ? { tags: args.tags as string[] } : {}),
            ...(args.memory_types ? { memoryTypes: args.memory_types as MemoryType[] } : {}),
            ...(args.related_user ? { relatedUser: String(args.related_user) } : {}),
            ...(args.related_wallet ? { relatedWallet: String(args.related_wallet) } : {}),
            ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
            ...(args.min_importance !== undefined ? { minImportance: Number(args.min_importance) } : {}),
          });
          return ok({ count: summaries.length, summaries });
        }

        // --- hydrate_memories -----------------------------------------------
        case "hydrate_memories": {
          const memories = await brain.hydrate(args.ids as number[]);
          return ok({ count: memories.length, memories });
        }

        // --- link_memories --------------------------------------------------
        case "link_memories": {
          await brain.link(
            Number(args.source_id),
            Number(args.target_id),
            args.link_type as any,
            args.strength !== undefined ? Number(args.strength) : undefined
          );
          return ok({ linked: true });
        }

        // --- get_stats ------------------------------------------------------
        case "get_stats": {
          const stats = await brain.stats();
          return ok(stats);
        }

        // --- get_recent -----------------------------------------------------
        case "get_recent": {
          const memories = await brain.recent(
            Number(args.hours),
            args.memory_types as MemoryType[] | undefined,
            args.limit !== undefined ? Number(args.limit) : undefined
          );
          return ok({ count: memories.length, memories });
        }

        // --- get_self_model -------------------------------------------------
        case "get_self_model": {
          const memories = await brain.selfModel();
          return ok({ count: memories.length, memories });
        }

        // --- decay_memories -------------------------------------------------
        case "decay_memories": {
          const updated = await brain.decay();
          return ok({ memories_updated: updated });
        }

        // --- dream ----------------------------------------------------------
        case "dream": {
          const opts: any = {};
          if (args.on_emerge) {
            opts.onEmergence = args.on_emerge;
          }
          await brain.dream(opts);
          return ok({ dream_completed: true });
        }

        // --- score_importance -----------------------------------------------
        case "score_importance": {
          const score = await brain.scoreImportance(String(args.description));
          return ok({ importance: score });
        }

        // --- infer_concepts -------------------------------------------------
        case "infer_concepts": {
          const concepts = brain.inferConcepts(
            String(args.summary),
            String(args.source),
            (args.tags as string[]) ?? []
          );
          return ok({ concepts });
        }

        // --- format_context -------------------------------------------------
        case "format_context": {
          const context = brain.formatContext(args.memories as Memory[]);
          return ok({ context });
        }

        // --- export_pack ----------------------------------------------------
        case "export_pack": {
          if (!isCortexV2(brain)) {
            throw new McpError(ErrorCode.MethodNotFound, "export_pack requires CortexV2");
          }
          const pack = await (brain as any).exportPack({
            name: String(args.name),
            description: String(args.description),
            ...(args.query ? { query: String(args.query) } : {}),
            ...(args.memory_ids ? { memoryIds: args.memory_ids as number[] } : {}),
            ...(args.types ? { types: args.types as MemoryType[] } : {}),
            ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
          });
          const format = (args.format as string) ?? "json";
          const output =
            format === "markdown"
              ? (brain as any).serializePackMarkdown(pack)
              : (brain as any).serializePack(pack);
          return ok({ format, memory_count: pack.memories.length, pack: output });
        }

        // --- import_pack ----------------------------------------------------
        case "import_pack": {
          if (!isCortexV2(brain)) {
            throw new McpError(ErrorCode.MethodNotFound, "import_pack requires CortexV2");
          }
          const parsed = (brain as any).parsePack(String(args.pack));
          const result = await (brain as any).importPack(parsed, {
            ...(args.importance_multiplier !== undefined
              ? { importanceMultiplier: Number(args.importance_multiplier) }
              : {}),
            ...(args.tag_prefix ? { tagPrefix: String(args.tag_prefix) } : {}),
            ...(args.types ? { types: args.types as MemoryType[] } : {}),
          });
          return ok(result);
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new McpError(ErrorCode.InternalError, msg);
    }
  });

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: "memory://stats",
        name: "Memory Statistics",
        description: "Live aggregate stats: counts by type, average importance and decay.",
        mimeType: "application/json",
      },
      {
        uri: "memory://recent/24h",
        name: "Recent Memories (24h)",
        description: "Memories created or accessed in the last 24 hours.",
        mimeType: "application/json",
      },
      {
        uri: "memory://self-model",
        name: "Self Model",
        description: "The agent's self_model memories: identity, preferences, persistent beliefs.",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;

    if (uri === "memory://stats") {
      const stats = await brain.stats();
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(stats, null, 2) }] };
    }

    if (uri === "memory://recent/24h") {
      const memories = await brain.recent(24, undefined, 50);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ count: memories.length, memories }, null, 2),
          },
        ],
      };
    }

    if (uri === "memory://self-model") {
      const memories = await brain.selfModel();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ count: memories.length, memories }, null, 2),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
  });

  // -------------------------------------------------------------------------
  // Prompts
  // -------------------------------------------------------------------------

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: "memory_context",
        description:
          "Recall relevant memories for a query and format them as a system-prompt context block.",
        arguments: [
          { name: "query", description: "What to recall.", required: true },
          { name: "limit", description: "Max memories to include (default 8).", required: false },
          {
            name: "related_user",
            description: "Scope to a specific user ID.",
            required: false,
          },
        ],
      },
      {
        name: "store_conversation_turn",
        description:
          "Template for storing a single conversation turn as an episodic memory. " +
          "Fill in the fields and call store_memory.",
        arguments: [
          { name: "user_message", description: "What the user said.", required: true },
          { name: "agent_reply", description: "What the agent replied.", required: true },
          { name: "related_user", description: "User identifier.", required: false },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    if (name === "memory_context") {
      const query = String(args.query ?? "");
      const limit = args.limit ? Number(args.limit) : 8;
      const relatedUser = args.related_user ? String(args.related_user) : undefined;

      const memories = await brain.recall({
        query,
        ...(relatedUser && { relatedUser }),
        limit,
      });
      const context = brain.formatContext(memories);

      return {
        description: `Memory context for: "${query}"`,
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                memories.length > 0
                  ? `Here is what I remember that's relevant:\n\n${context}`
                  : "I have no relevant memories for this query.",
            },
          },
        ],
      };
    }

    if (name === "store_conversation_turn") {
      const userMsg = String(args.user_message ?? "");
      const agentReply = String(args.agent_reply ?? "");
      const relatedUser = args.related_user ? String(args.related_user) : undefined;

      const content = `User: ${userMsg}\nAssistant: ${agentReply}`;
      const summary = `Conversation: ${userMsg.slice(0, 80)}${userMsg.length > 80 ? "…" : ""}`;

      return {
        description: "Store this conversation turn as an episodic memory",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Call the store_memory tool with these values:",
                `- type: "episodic"`,
                `- content: ${JSON.stringify(content)}`,
                `- summary: ${JSON.stringify(summary)}`,
                `- source: "chat"`,
                ...(relatedUser ? [`- related_user: ${JSON.stringify(relatedUser)}`] : []),
                `- tags: (infer from the conversation using infer_concepts)`,
              ].join("\n"),
            },
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  const shutdown = () => {
    brain.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // -------------------------------------------------------------------------
  // Connect
  // -------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("clude-mcp ready.");
}

function log(...args: unknown[]) {
  // Always log to stderr to keep stdout clean for the MCP protocol
  process.stderr.write(args.join(" ") + "\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
