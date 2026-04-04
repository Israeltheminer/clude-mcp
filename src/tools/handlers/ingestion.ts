import type { Cortex } from "clude-bot";
import { ok, type ToolResult } from "../../helpers.js";
import { runIngestionPipeline } from "../../ingestors/pipeline.js";
import { loadState, saveState } from "../../ingestors/state.js";
import type { IngestOptions } from "../../ingestors/types.js";
import { log } from "../../log.js";

/**
 * Handle the `ingest_sessions` tool call.
 *
 * Runs the ingestion pipeline across all configured sources (or a specific
 * path), then optionally chains into the dream consolidation cycle.
 */
export async function handleIngestSessions(
  brain: Cortex,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (args.reprocess) {
    const state = loadState();
    const cleared = Object.keys(state.ingested).length;
    state.ingested = {};
    saveState(state);
    log(`ingest: cleared state for ${cleared} sessions (reprocess mode)`);
  }

  const options: IngestOptions = {
    window: Number(args.window ?? 10),
    threshold: Number(args.threshold ?? 0.4),
    limit: Number(args.limit ?? 0),
    project: args.project ? String(args.project) : undefined,
    dryRun: Boolean(args.dry_run),
    chainDream: Boolean(args.chain_dream),
    sourcePath: args.source_path ? String(args.source_path) : undefined,
    platform: (args.platform as IngestOptions["platform"]) ?? "auto",
    episodic: args.episodic !== false,
    semantic: args.semantic !== false,
  };

  const result = await runIngestionPipeline(brain, options, (event) => {
    if (event.kind === "session-done") {
      log(`ingest: [${event.index + 1}/${event.total}] ${event.label} → ${event.memories} memories`);
    }
  });

  if (options.chainDream && result.memoriesStored > 0 && !options.dryRun) {
    log("ingest: chaining into dream cycle…");
    await brain.dream({});
    result.dreamChained = true;
  }

  return ok(result);
}
