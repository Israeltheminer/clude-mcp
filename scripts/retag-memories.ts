#!/usr/bin/env node
/**
 * retag-memories.ts
 *
 * Re-classifies all existing memories using the new software/engineering
 * ontology, stripping the old crypto/Twitter auto-concepts (whale_activity,
 * price_action, token_economics, community_pattern, etc.) and replacing them
 * with meaningful software tags (bug_fix, api_design, ai_ml, etc.).
 *
 * For each memory the script:
 *   1. Strips known-bad crypto concepts from the `tags` array
 *   2. Runs inferConceptsSoftware on summary + source + remaining tags
 *   3. Merges new concepts into `tags` and writes them back
 *   4. Replaces the `concepts` column with the new software concepts
 *
 * Usage:
 *   npm run retag                      # retag every memory (pages of 500)
 *   npm run retag -- --dry-run          # preview — prints diff, no writes
 *   npm run retag -- --limit 200        # stop after 200 memories
 *   npm run retag -- --types semantic   # only retag a specific memory_type
 */

import dotenv from "dotenv";
dotenv.config({ override: true });
import { createClient } from "@supabase/supabase-js";

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN    = argv.includes("--dry-run");
const LIMIT_IDX  = argv.indexOf("--limit");
const LIMIT      = LIMIT_IDX !== -1 ? parseInt(argv[LIMIT_IDX + 1], 10) || Infinity : Infinity;
const TYPES_IDX  = argv.indexOf("--types");
const FILTER_TYPE = TYPES_IDX !== -1 ? argv[TYPES_IDX + 1] : null;
const PAGE_SIZE  = 500;

// ── DB client ─────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  const missing = ["SUPABASE_URL", "SUPABASE_KEY"].filter(k => !process.env[k]).join(", ");
  console.error(`Missing required env vars: ${missing}`);
  process.exit(1);
}
const db = createClient(supabaseUrl, supabaseKey);

// ── Old crypto concept labels to strip ───────────────────────────────────────
// These were produced by the clude-bot crypto/Twitter ontology and have no
// meaning for a software engineering memory store.
const CRYPTO_CONCEPTS = new Set([
  "market_event",
  "holder_behavior",
  "social_interaction",
  "community_pattern",
  "token_economics",
  "sentiment_shift",
  "recurring_user",
  "whale_activity",
  "price_action",
  "engagement_pattern",
]);

// ── Software/engineering ontology (mirrors utilities.ts) ─────────────────────
function inferConceptsSoftware(
  summary: string,
  source: string,
  tags: string[]
): string[] {
  const concepts: string[] = [];
  const lower = summary.toLowerCase();

  // Self / identity
  if (
    source === "reflection" ||
    source === "emergence" ||
    /myself|i am|i feel|identity|who i/.test(lower)
  ) concepts.push("self_insight");
  if (
    source === "emergence" ||
    /becoming|evolving|changed|grew|identity/.test(lower)
  ) concepts.push("identity_evolution");

  // Session checkpoints
  if (source === "checkpoint" || /checkpoint|turns \d|summary of/.test(lower))
    concepts.push("session_checkpoint");

  // Code & engineering
  if (/\bfix(ed|ing)?\b|bug\b|error\b|crash\b|exception\b|broken\b|issue\b/.test(lower))
    concepts.push("bug_fix");
  if (/\brefactor|cleanup|restructur|rewrite|simplif/.test(lower))
    concepts.push("refactoring");
  if (/\bfeature|implement|add(ed|ing)?\b|build\b|creat(e|ed|ing)/.test(lower))
    concepts.push("feature_work");
  if (/\btest(s|ing|ed)?\b|spec\b|coverage\b|assert\b|jest\b|vitest\b|mocha\b/.test(lower))
    concepts.push("testing");
  if (/\bapi\b|endpoint\b|route\b|http\b|rest\b|graphql\b|webhook\b/.test(lower))
    concepts.push("api_design");
  if (/\bdatabase\b|schema\b|migration\b|query\b|sql\b|postgres\b|supabase\b|sqlite\b/.test(lower))
    concepts.push("data_layer");
  if (/\bui\b|component\b|style\b|css\b|layout\b|frontend\b|react\b|svelte\b|tailwind\b/.test(lower))
    concepts.push("ui_work");
  if (/\bperformance\b|latency\b|optim|cache\b|speed\b/.test(lower))
    concepts.push("performance");
  if (/\bdeploy\b|release\b|ship(ped|ping)?\b|production\b|pipeline\b|ci\b|cd\b/.test(lower))
    concepts.push("deployment");
  if (/\barchitect|design pattern\b|structure\b/.test(lower))
    concepts.push("architecture");

  // AI / ML
  if (/\bai\b|llm\b|model\b|embedding\b|vector\b|neural\b|machine.?learn|fine.?tun/.test(lower))
    concepts.push("ai_ml");
  if (/\bmemory\b|recall\b|cortex\b|clude\b/.test(lower))
    concepts.push("memory_system");

  // Decision / learning
  if (/\bdecid|chos(e|en)\b|option\b|trade.?off|approach\b/.test(lower))
    concepts.push("decision");
  if (/\blearn(ed|ing)?\b|discover\b|insight\b|realiz/.test(lower))
    concepts.push("learning");

  // Tools & workflow
  if (/\bgit\b|commit\b|branch\b|\bpr\b|pull.?request|merge\b/.test(lower))
    concepts.push("version_control");
  if (/\bterminal\b|cli\b|command\b|script\b|bash\b|shell\b/.test(lower))
    concepts.push("tooling");

  return [...new Set(concepts)];
}

// ── Per-memory transform ──────────────────────────────────────────────────────
interface MemoryRow {
  id: number;
  summary: string;
  source: string;
  memory_type: string;
  tags: string[];
  concepts: string[];
}

interface Diff {
  id: number;
  oldTags: string[];
  newTags: string[];
  oldConcepts: string[];
  newConcepts: string[];
}

function retagMemory(mem: MemoryRow): Diff {
  // Strip old crypto concepts from stored tags, keep everything else
  const cleanTags = (mem.tags ?? []).filter(t => !CRYPTO_CONCEPTS.has(t));

  // Generate new software concepts
  const newConcepts = inferConceptsSoftware(mem.summary ?? "", mem.source ?? "", cleanTags);

  // Merged tag list: clean existing + new concepts (deduped)
  const newTagSet = new Set([...cleanTags, ...newConcepts]);
  const newTags = [...newTagSet];

  return {
    id: mem.id,
    oldTags: mem.tags ?? [],
    newTags,
    oldConcepts: mem.concepts ?? [],
    newConcepts,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `retag-memories${DRY_RUN ? " [DRY RUN]" : ""}` +
    (FILTER_TYPE ? `  type=${FILTER_TYPE}` : "") +
    (isFinite(LIMIT) ? `  limit=${LIMIT}` : "")
  );
  console.log();

  let cursor = 0;
  let totalProcessed = 0;
  let totalChanged = 0;
  let totalErrors = 0;

  while (totalProcessed < LIMIT) {
    const batchSize = Math.min(PAGE_SIZE, LIMIT - totalProcessed);

    let query = db
      .from("memories")
      .select("id, summary, source, memory_type, tags, concepts")
      .order("id", { ascending: true })
      .range(cursor, cursor + batchSize - 1);

    if (FILTER_TYPE) query = query.eq("memory_type", FILTER_TYPE);

    const { data: rows, error } = await query;

    if (error) {
      console.error("DB fetch error:", error.message);
      process.exit(1);
    }
    if (!rows || rows.length === 0) break;

    // Compute diffs for this page
    const diffs: Diff[] = (rows as MemoryRow[]).map(retagMemory);
    const changed = diffs.filter(
      d =>
        JSON.stringify(d.newTags.sort()) !== JSON.stringify(d.oldTags.slice().sort()) ||
        JSON.stringify(d.newConcepts.sort()) !== JSON.stringify(d.oldConcepts.slice().sort())
    );

    if (DRY_RUN) {
      // Print a preview of the first 10 diffs
      for (const d of changed.slice(0, 10)) {
        const removed = d.oldTags.filter(t => !d.newTags.includes(t));
        const added   = d.newTags.filter(t => !d.oldTags.includes(t));
        if (removed.length || added.length) {
          console.log(`  id=${d.id}`);
          if (removed.length) console.log(`    - ${removed.join(", ")}`);
          if (added.length)   console.log(`    + ${added.join(", ")}`);
        }
      }
      if (changed.length > 10) {
        console.log(`  … and ${changed.length - 10} more in this page`);
      }
    } else {
      // Write in batches of 50 parallel upserts
      const CONCURRENCY = 50;
      for (let i = 0; i < changed.length; i += CONCURRENCY) {
        const chunk = changed.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map(d =>
            db
              .from("memories")
              .update({ tags: d.newTags, concepts: d.newConcepts })
              .eq("id", d.id)
          )
        );
        for (const r of results) {
          if (r.status === "rejected" || (r.value as any).error) {
            process.stdout.write("✗");
            totalErrors++;
          } else {
            process.stdout.write("●");
            totalChanged++;
          }
        }
      }
    }

    totalProcessed += rows.length;
    cursor += rows.length;

    // Progress line
    process.stdout.write(
      `\n  page ${Math.ceil(cursor / PAGE_SIZE)}: ${rows.length} fetched, ${changed.length} need update\n`
    );

    if (rows.length < batchSize) break; // last page
  }

  console.log();
  console.log(
    `Done. ${totalProcessed} memories scanned, ` +
    (DRY_RUN
      ? `${totalChanged || "see above"} would change (dry run — nothing written)`
      : `${totalChanged} updated, ${totalErrors} errors`)
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
