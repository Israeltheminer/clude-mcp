/**
 * @module self-model/cleanup
 *
 * Post-dream cleanup for self_model entries.
 *
 * The dream cycle (clude-bot) stores memories via its internal storeMemory()
 * function, bypassing the MCP tool handler and its guardrails. This module
 * runs AFTER dream and retroactively applies the same checks:
 *
 *   1. Finds recent self_model entries from dream sources
 *   2. Downgrades meta-reflective entries to semantic
 *   3. Caps inflated importance scores
 *
 * This closes the bypass gap between dream-internal storage and MCP-side
 * guardrails.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { log } from "../log.js";
import {
  isMetaReflective,
  isDreamSource,
  SELF_MODEL_IMPORTANCE_CAP,
} from "../tools/handlers/storage.js";

export interface CleanupResult {
  scanned: number;
  downgraded: number;
  capped: number;
  details: Array<{
    id: number;
    summary: string;
    action: "downgraded" | "capped" | "both";
    oldImportance?: number;
    newImportance?: number;
  }>;
  dryRun: boolean;
}

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL + SUPABASE_KEY required for cleanup");
  }
  return createClient(url, key);
}

/**
 * Scan recent self_model entries and apply guardrails retroactively.
 *
 * @param lookbackHours - How far back to look for dream-produced entries.
 * @param dryRun        - If true, report what would change without modifying.
 */
export async function cleanupDreamSelfModel(
  lookbackHours = 24,
  dryRun = false,
): Promise<CleanupResult> {
  const db = getSupabase();
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const { data: entries, error } = await db
    .from("memories")
    .select("id, summary, content, source, importance, memory_type, created_at")
    .eq("memory_type", "self_model")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error) {
    log(`self-model cleanup: query failed: ${error.message}`);
    return { scanned: 0, downgraded: 0, capped: 0, details: [], dryRun };
  }

  const result: CleanupResult = {
    scanned: entries?.length ?? 0,
    downgraded: 0,
    capped: 0,
    details: [],
    dryRun,
  };

  if (!entries || entries.length === 0) return result;

  for (const entry of entries) {
    const combinedText = `${entry.summary} ${entry.content}`;
    const meta = isMetaReflective(combinedText);
    const dreamSrc = isDreamSource(entry.source ?? "");
    const wouldCap = dreamSrc && entry.importance > SELF_MODEL_IMPORTANCE_CAP;

    if (!meta && !wouldCap) continue;

    const detail: CleanupResult["details"][number] = {
      id: entry.id,
      summary: (entry.summary ?? "").slice(0, 120),
      action: meta && wouldCap ? "both" : meta ? "downgraded" : "capped",
    };

    if (wouldCap) {
      detail.oldImportance = entry.importance;
      detail.newImportance = SELF_MODEL_IMPORTANCE_CAP;
    }

    if (!dryRun) {
      const updates: Record<string, unknown> = {};
      if (meta) updates.memory_type = "semantic";
      if (wouldCap) updates.importance = SELF_MODEL_IMPORTANCE_CAP;

      const { error: updateErr } = await db
        .from("memories")
        .update(updates)
        .eq("id", entry.id);

      if (updateErr) {
        log(`self-model cleanup: failed to update #${entry.id}: ${updateErr.message}`);
        continue;
      }
    }

    if (meta) result.downgraded++;
    if (wouldCap) result.capped++;
    result.details.push(detail);
  }

  return result;
}
