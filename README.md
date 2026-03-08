# clude-mcp

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives any AI agent persistent, searchable memory — backed by [clude-bot](https://clude.io) and your own Supabase database.

Connect it once and every tool in your workflow (Claude Desktop, Claude Code, Cursor, Antigravity, and any other MCP-compatible client) shares the same memory store across sessions.

---

## What it does

- **Stores memories** with type classification, importance scoring, tags, and embeddings
- **Recalls memories** via a 7-phase hybrid pipeline: vector similarity + BM25 keyword search + knowledge-graph traversal
- **Links memories** into a typed knowledge graph with Hebbian reinforcement
- **Scores importance** automatically before every write (if Anthropic is configured)
- **Runs a dream cycle** to consolidate episodic memories into semantic knowledge
- **Decays stale memories** over time at type-specific rates

The **autonomous memory protocol** (`agent_memory_protocol` prompt) makes all of the above happen silently in the background — no per-conversation setup needed.

---

## Requirements

- Node.js ≥ 22
- A [Supabase](https://supabase.com) project (free tier works)
- An [Anthropic API key](https://console.anthropic.com) for importance scoring and the dream cycle

---

## Installation

```bash
git clone https://github.com/Israeltheminer/clude-mcp.git
cd clude-mcp
npm install
npm run build
```

---

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
# ── Self-hosted (Supabase) ─────────────────────────────────────────
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-role-key

# ── LLM (importance scoring + dream cycle) ─────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── Embeddings (optional — defaults to Supabase built-in) ──────────
# EMBEDDING_PROVIDER=voyage          # or: openai
# VOYAGE_API_KEY=pa-...
# OPENAI_API_KEY=sk-...

# ── Memory protocol thresholds ─────────────────────────────────────
MEMORY_TURN_THRESHOLD=10            # store episodic memories every N turns
MEMORY_IMPORTANCE_THRESHOLD=0.4     # minimum score to persist an episodic memory
```

### Supabase schema

Run the [clude-bot schema](https://raw.githubusercontent.com/sebbsssss/cludebot/main/supabase-schema.sql) in your Supabase SQL editor to create the required tables and `pgvector` HNSW indexes.

---

## Adding to your AI tools

The server communicates over stdio. Each tool needs a config entry pointing to the built binary.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clude": {
      "command": "node",
      "args": ["/absolute/path/to/clude-mcp/dist/index.js"]
    }
  }
}
```

### Claude Code

```json
// ~/.claude.json  →  mcpServers
"clude": {
  "command": "node",
  "args": ["/absolute/path/to/clude-mcp/dist/index.js"],
  "type": "stdio"
}
```

### Cursor

```json
// ~/.cursor/mcp.json
{
  "mcpServers": {
    "clude": {
      "command": "node",
      "args": ["/absolute/path/to/clude-mcp/dist/index.js"]
    }
  }
}
```

### Antigravity

Add the same `node` + `args` block to your Antigravity MCP server config.

> **Restart** each tool after editing its config. Verify with: list available MCP tools — you should see all 13 `clude` tools.

---

## Autonomous memory protocol

The `agent_memory_protocol` MCP prompt is the core of the system. It returns a lifecycle-agnostic four-phase instruction block — callable at session start, mid-conversation, after a context reset, or from programmatic agents at any point:

| Phase | Trigger | What happens |
|-------|---------|-------------|
| **1 — Initialize** | Immediately on load | `recall_summaries` warms context; `hydrate_memories` on relevant IDs; turn counter resets to 0 |
| **2 — Periodic** | Every N turns from load point | Step A: score + store episodic highlights; Step B: semantic checkpoint (always) |
| **3 — Reactive** | Any identity/preference statement | `store_memory` with type `self_model` immediately |
| **4 — Invariants** | Every memory write | `infer_concepts` for tags; `link_memories` for related memories; silent operation |

To activate it globally in Claude Code, create `~/.claude/CLAUDE.md` with the protocol embedded directly — **do not** use the `agent_memory_protocol` MCP prompt for this; that requires a separate API call at session start which is unreliable:

```markdown
# Memory Protocol

You have access to a persistent memory MCP server (`clude`). Follow this protocol autonomously on every session — silently, without mentioning it to the user.

## On session start (before your first response)

1. Call `recall_summaries` (no query, limit 20) to warm the context with recent memories
2. If any summaries are relevant to the current task, call `hydrate_memories` on those IDs
3. Let this inform your responses silently

## Every 10 conversation turns

**Step A — Episodic highlights**
- Review the last 10 turns and identify memorable moments
- For each: call `score_importance` on `summary + content[:400]`
- If score ≥ 0.4: call `store_memory` with type `"episodic"`
- Call `infer_concepts` to auto-generate tags
- Skip: small talk, greetings, filler, already-stored facts

**Step B — Semantic checkpoint**
- Write a 2–3 sentence summary of key facts/decisions from these 10 turns
- Call `store_memory` with type `"semantic"` and source `"checkpoint"` — always, regardless of score

## Immediately (no turn threshold)

Any time the user expresses a persistent preference, identity trait, or working style:
→ Call `store_memory` immediately with type `"self_model"`

## Always

- `score_importance` auto-runs inside `store_memory` when `importance` is omitted — no need to call it separately before storing
- Use `infer_concepts` to generate tags for every memory stored
- When a new memory clearly relates to an existing one, call `link_memories` with the appropriate `link_type`
- Never ask the user for permission — do it silently in the background
```

---

## Tools (13)

### Storage

| Tool | Description |
|------|-------------|
| `store_memory` | Persist a memory. Auto-scores importance if `ANTHROPIC_API_KEY` is set and `importance` is omitted. |
| `export_pack` | Serialize memories into a portable signed Memory Pack (JSON or Markdown). Requires CortexV2. |
| `import_pack` | Load a Memory Pack into the store. Applies an importance multiplier to prevent flooding. Requires CortexV2. |

### Retrieval

| Tool | Description |
|------|-------------|
| `recall_memories` | Full hybrid search → complete Memory objects. Best for ≤ 10 results. |
| `recall_summaries` | Lightweight hybrid search → summaries only. Use for wide scans (20–100). |
| `hydrate_memories` | Fetch full content for specific IDs. Use as step 2 of two-phase retrieval. |

### Graph

| Tool | Description |
|------|-------------|
| `link_memories` | Create a typed directed edge between two memories. Strengthened by Hebbian co-recall. |

**Link types:** `supports` · `contradicts` · `elaborates` · `causes` · `resolves` · `follows` · `relates`

### Analysis

| Tool | Description |
|------|-------------|
| `get_stats` | Aggregate counts, average importance/decay, graph link counts. |
| `get_recent` | Memories created or accessed within the last N hours. |
| `get_self_model` | All `self_model` memories (identity, preferences, working style). |

### Cognition *(self-hosted only)*

| Tool | Description |
|------|-------------|
| `decay_memories` | Apply type-specific daily decay rates to all memories. |
| `dream` | Run the consolidation → reflection → emergence cycle. |
| `score_importance` | Ask the LLM to rate a text's importance (0–1). |

### Utilities *(local, no API cost)*

| Tool | Description |
|------|-------------|
| `infer_concepts` | Extract concept tags from text using a 12-category ontology. |
| `format_context` | Format a Memory array into an LLM-ready system-prompt block. |

---

## Resources (3)

Subscribe to these URIs in MCP clients that support resource polling:

| URI | Description |
|-----|-------------|
| `memory://stats` | Live aggregate statistics |
| `memory://recent/24h` | Memories from the last 24 hours (up to 50) |
| `memory://self-model` | All self_model memories |

---

## Prompts (3)

| Prompt | Arguments | Description |
|--------|-----------|-------------|
| `memory_context` | `query` (required), `limit`, `related_user` | Recall + format memories as a context block |
| `store_conversation_turn` | `user_message`, `agent_reply`, `related_user` | Scaffold a store_memory call for a conversation turn |
| `agent_memory_protocol` | *(none)* | The full autonomous memory protocol instruction |

---

## Memory types & decay rates

| Type | Decay | Use for |
|------|-------|---------|
| `episodic` | 7%/day | Events, conversations, session highlights |
| `semantic` | 2%/day | Facts, decisions, distilled knowledge |
| `procedural` | 3%/day | How-to steps, workflows |
| `self_model` | 1%/day | Identity, preferences, working style |

---

## Scheduled maintenance

Two tasks keep the memory store healthy — run them daily, dream before decay so consolidated memories survive longer:

| Task | Frequency | Why |
|------|-----------|-----|
| `dream` | Nightly | Consolidates episodic → semantic before decay runs |
| `decay_memories` | Nightly (after dream) | Applies type-specific daily decay rates |

### Claude Code scheduled tasks (recommended)

```bash
# Dream: nightly (example — pick your own time)
claude schedule create memory-dream --cron "0 2 * * *" \
  "Call the dream tool on the clude MCP server to consolidate episodic memories into semantic knowledge."

# Decay: nightly, after dream
claude schedule create memory-decay --cron "0 3 * * *" \
  "Call the decay_memories tool on the clude MCP server to apply daily memory decay rates."
```

### Plain cron (alternative)

```cron
# Dream: nightly at 2am
0 2 * * *   node /path/to/clude-mcp/dist/index.js --tool dream

# Decay: nightly at 3am (after dream)
0 3 * * *   node /path/to/clude-mcp/dist/index.js --tool decay_memories
```

---

## Project structure

```
src/
├── index.ts                     Boot entry: pino guard + dotenv + main()
├── server.ts                    Bootstrap: config → brain → server → connect
├── config.ts                    buildConfig() — env vars → CortexConfig
├── brain.ts                     createBrain() — CortexV2/Cortex fallback
├── log.ts                       Stderr-only logger
├── helpers.ts                   ok(), isCortexV2(), shared types
│
├── tools/
│   ├── definitions/             JSON schemas for all 13 tools
│   │   ├── index.ts             TOOLS[] aggregator
│   │   ├── storage.ts
│   │   ├── retrieval.ts
│   │   ├── graph.ts
│   │   ├── analysis.ts
│   │   ├── cognition.ts
│   │   └── utilities.ts
│   ├── handlers/                Handler functions (one file per category)
│   │   ├── storage.ts           Auto-importance scoring lives here
│   │   ├── retrieval.ts
│   │   ├── graph.ts
│   │   ├── analysis.ts
│   │   ├── cognition.ts
│   │   └── utilities.ts
│   └── index.ts                 registerToolHandlers() dispatch router
│
├── resources/
│   ├── definitions.ts           3 resource URIs + metadata
│   └── handlers.ts              registerResourceHandlers()
│
└── prompts/
    ├── definitions.ts           3 prompt schemas
    ├── index.ts                 registerPromptHandlers() dispatch
    └── handlers/
        ├── memory-context.ts
        ├── store-turn.ts
        └── protocol.ts          buildProtocolText() — pure, testable
```

---

## Development

```bash
npm run dev      # watch mode (tsx)
npm run lint     # type-check only (tsc --noEmit)
npm run build    # compile to dist/
```

---

## License

MIT
