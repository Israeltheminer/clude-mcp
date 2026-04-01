import type { Cortex } from "clude-bot";
import { loadState } from "../ingestors/state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "ok" | "warn" | "error";

export interface CheckResult {
  name: string;
  severity: Severity;
  message: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Check: memory store rate
// Are memories actually being created?
// ---------------------------------------------------------------------------

export async function checkStoreRate(brain: Cortex): Promise<CheckResult> {
  const name = "store_rate";
  try {
    const recent = await brain.recent(48); // last 48 hours
    const last24h = recent.filter(
      (m: any) =>
        Date.now() - new Date(m.created_at).getTime() < 24 * 60 * 60 * 1000
    );

    if (last24h.length === 0) {
      return {
        name,
        severity: "error",
        message: "No memories created in the last 24 hours.",
        details: { last48h: recent.length, last24h: 0 },
      };
    }

    if (last24h.length < 3) {
      return {
        name,
        severity: "warn",
        message: `Only ${last24h.length} memories created in the last 24h — expected more from active sessions.`,
        details: { last48h: recent.length, last24h: last24h.length },
      };
    }

    return {
      name,
      severity: "ok",
      message: `${last24h.length} memories in last 24h, ${recent.length} in last 48h.`,
      details: { last48h: recent.length, last24h: last24h.length },
    };
  } catch (err: any) {
    return { name, severity: "error", message: `Check failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Check: memory quality sample
// Are recent memories coherent? Non-empty summaries? Reasonable importance?
// ---------------------------------------------------------------------------

export async function checkMemoryQuality(brain: Cortex): Promise<CheckResult> {
  const name = "memory_quality";
  try {
    const recent = await brain.recent(48, undefined, 20);
    if (recent.length === 0) {
      return { name, severity: "warn", message: "No recent memories to sample." };
    }

    const issues: string[] = [];
    let emptySummary = 0;
    let fallbackImportance = 0;
    let noTags = 0;

    for (const mem of recent as any[]) {
      if (!mem.summary || mem.summary.length < 10) emptySummary++;
      if (mem.importance === 0.5) fallbackImportance++;
      if (!mem.tags || mem.tags.length === 0) noTags++;
    }

    const total = recent.length;
    if (emptySummary > total * 0.5)
      issues.push(`${emptySummary}/${total} have empty/short summaries`);
    if (fallbackImportance > total * 0.7)
      issues.push(`${fallbackImportance}/${total} have fallback importance (0.5) — scoring may be broken`);
    if (noTags > total * 0.5)
      issues.push(`${noTags}/${total} have no tags — concept inference may be broken`);

    if (issues.length > 0) {
      return {
        name,
        severity: issues.some(i => i.includes("scoring")) ? "error" : "warn",
        message: issues.join("; "),
        details: { total, emptySummary, fallbackImportance, noTags },
      };
    }

    return {
      name,
      severity: "ok",
      message: `Sampled ${total} memories — summaries, importance, and tags look healthy.`,
      details: { total, emptySummary, fallbackImportance, noTags },
    };
  } catch (err: any) {
    return { name, severity: "error", message: `Check failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Check: recall sanity
// Can we actually retrieve memories for a known query?
// ---------------------------------------------------------------------------

export async function checkRecallSanity(brain: Cortex): Promise<CheckResult> {
  const name = "recall_sanity";
  try {
    const results = await brain.recall({
      query: "recent work and decisions",
      limit: 5,
    });

    if (results.length === 0) {
      return {
        name,
        severity: "error",
        message: "Recall returned 0 results for a broad query — vector search or embeddings may be down.",
      };
    }

    // Check that results aren't all fully decayed
    const decayed = (results as any[]).filter(
      (m) => m.decay_factor !== undefined && m.decay_factor < 0.1
    );
    if (decayed.length === results.length) {
      return {
        name,
        severity: "warn",
        message: `All ${results.length} recall results have decay_factor < 0.1 — decay may be too aggressive.`,
        details: { results: results.length, allDecayed: true },
      };
    }

    return {
      name,
      severity: "ok",
      message: `Recall returned ${results.length} results with healthy decay factors.`,
      details: { results: results.length, decayedCount: decayed.length },
    };
  } catch (err: any) {
    return { name, severity: "error", message: `Check failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Check: pipeline health
// Are scheduled jobs running? Any sessions marked ingested with 0 output?
// ---------------------------------------------------------------------------

export async function checkPipelineHealth(_brain: Cortex): Promise<CheckResult> {
  const name = "pipeline_health";
  try {
    const state = loadState();
    const ingestedPaths = Object.keys(state.ingested);
    const issues: string[] = [];

    if (ingestedPaths.length === 0) {
      issues.push("No sessions have ever been ingested");
    }

    // Check scheduler state for stale jobs
    const fs = await import("node:fs");
    const path = await import("node:path");
    const schedulerStatePath =
      process.env.SCHEDULER_STATE ??
      path.join(__dirname, "..", "..", ".scheduler-state.json");

    try {
      const raw = fs.readFileSync(schedulerStatePath, "utf8");
      const schedState = JSON.parse(raw);
      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;

      if (schedState.lastIngest) {
        const age = now - new Date(schedState.lastIngest).getTime();
        if (age > 2 * DAY_MS)
          issues.push(`Ingest hasn't run in ${Math.floor(age / DAY_MS)} days`);
      } else {
        issues.push("Ingest has never run via scheduler");
      }

      if (schedState.lastDream) {
        const age = now - new Date(schedState.lastDream).getTime();
        if (age > 2 * DAY_MS)
          issues.push(`Dream hasn't run in ${Math.floor(age / DAY_MS)} days`);
      } else {
        issues.push("Dream has never run via scheduler");
      }

      if (schedState.lastDecay) {
        const age = now - new Date(schedState.lastDecay).getTime();
        if (age > 2 * DAY_MS)
          issues.push(`Decay hasn't run in ${Math.floor(age / DAY_MS)} days`);
      } else {
        issues.push("Decay has never run via scheduler");
      }
    } catch {
      issues.push("Scheduler state file not found or unreadable");
    }

    if (issues.length > 0) {
      return {
        name,
        severity: issues.some(i => i.includes("never")) ? "error" : "warn",
        message: issues.join("; "),
        details: { totalIngested: ingestedPaths.length },
      };
    }

    return {
      name,
      severity: "ok",
      message: `Pipeline healthy. ${ingestedPaths.length} sessions ingested. Scheduler jobs are current.`,
      details: { totalIngested: ingestedPaths.length },
    };
  } catch (err: any) {
    return { name, severity: "error", message: `Check failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Check: overall stats sanity
// Are the aggregate numbers reasonable?
// ---------------------------------------------------------------------------

export async function checkStatsSanity(brain: Cortex): Promise<CheckResult> {
  const name = "stats_sanity";
  try {
    const stats = await brain.stats() as any;
    const issues: string[] = [];

    const total = stats.totalMemories ?? stats.total ?? 0;
    if (total === 0) {
      return {
        name,
        severity: "error",
        message: "Memory store is empty.",
        details: stats,
      };
    }

    const avgImportance = stats.averageImportance ?? stats.avg_importance;
    if (avgImportance !== undefined && avgImportance < 0.1) {
      issues.push(`Average importance is very low (${avgImportance.toFixed(3)}) — memories may be over-decayed`);
    }

    const avgDecay = stats.averageDecay ?? stats.avg_decay_factor;
    if (avgDecay !== undefined && avgDecay < 0.1) {
      issues.push(`Average decay factor is very low (${avgDecay.toFixed(3)}) — memories are heavily eroded`);
    }

    if (issues.length > 0) {
      return {
        name,
        severity: "warn",
        message: issues.join("; "),
        details: stats,
      };
    }

    return {
      name,
      severity: "ok",
      message: `${total} memories, avg importance ${(avgImportance ?? 0).toFixed(2)}, avg decay ${(avgDecay ?? 1).toFixed(2)}.`,
      details: stats,
    };
  } catch (err: any) {
    return { name, severity: "error", message: `Check failed: ${err.message}` };
  }
}
