#!/usr/bin/env node
/**
 * rescore-memories.ts
 *
 * Re-scores memories that are stuck at the default importance of 0.5 due to
 * a bug in the original ingest script (filter dropped all turns below threshold
 * so importance was never passed to brain.store()).
 *
 * Fetches memories with importance=0.5 from Supabase, calls the Anthropic scorer
 * on each one's summary+content, then updates the importance in-place.
 *
 * Usage:
 *   npm run rescore              # re-score all 0.5-importance memories
 *   npm run rescore -- --limit 50  # do 50 at a time (safe batch size)
 *   npm run rescore -- --dry-run   # preview without writing
 */

import dotenv from "dotenv";
dotenv.config({ override: true }); // override empty env vars pre-set by parent shell
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN   = args.includes("--dry-run");
const LIMIT_IDX = args.indexOf("--limit");
const LIMIT     = LIMIT_IDX !== -1 ? (parseInt(args[LIMIT_IDX + 1], 10) || 100) : 100;

// ── Clients ───────────────────────────────────────────────────────────────────
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const supabaseUrl  = process.env.SUPABASE_URL;
const supabaseKey  = process.env.SUPABASE_KEY;

if (!anthropicKey || !supabaseUrl || !supabaseKey) {
  const missing = ["ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_KEY"]
    .filter(k => !process.env[k]).join(", ");
  console.error(`Missing required env vars: ${missing}`);
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: anthropicKey });
const db = createClient(supabaseUrl, supabaseKey);

// ── Rate limiter (Anthropic Haiku: generous tier, but be polite) ──────────────
// 5 concurrent requests max, no hard delay needed for Haiku
const CONCURRENCY = 5;

async function scoreImportance(summary: string, content: string): Promise<number> {
  const text = `${summary}\n\n${content}`.slice(0, 600);
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    messages: [{
      role: "user",
      content: `Rate how important this information is to remember long-term, on a scale from 0.0 to 1.0. Reply with a single decimal number only.\n\n${text}`,
    }],
  });
  const raw = (response.content[0] as any).text?.trim() ?? "0.5";
  const score = parseFloat(raw);
  return isNaN(score) ? 0.5 : Math.min(1, Math.max(0, score));
}

async function processBatch(memories: any[]): Promise<{ updated: number; errors: number }> {
  let updated = 0;
  let errors = 0;

  // Process in chunks of CONCURRENCY
  for (let i = 0; i < memories.length; i += CONCURRENCY) {
    const chunk = memories.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (mem) => {
      try {
        const importance = await scoreImportance(mem.summary ?? "", mem.content ?? "");
        if (!DRY_RUN) {
          const { error } = await db
            .from("memories")
            .update({ importance })
            .eq("id", mem.id);
          if (error) throw new Error(error.message);
        }
        process.stdout.write(importance >= 0.4 ? "●" : "·");
        updated++;
      } catch (err: any) {
        process.stdout.write("✗");
        errors++;
      }
    }));
  }

  return { updated, errors };
}

async function main() {
  console.log(`rescore-memories${DRY_RUN ? " [DRY RUN]" : ""}  limit=${LIMIT}`);

  // Fetch memories stuck at exactly 0.5
  const { data: memories, error } = await db
    .from("memories")
    .select("id, summary, content, importance, memory_type")
    .eq("importance", 0.5)
    .order("id", { ascending: true })
    .limit(LIMIT);

  if (error) {
    console.error("DB error:", error.message);
    process.exit(1);
  }

  console.log(`Found ${memories.length} memories at importance=0.5 to re-score\n`);

  if (memories.length === 0) {
    console.log("Nothing to do — all memories already have non-default importance.");
    return;
  }

  const { updated, errors } = await processBatch(memories);

  console.log(`\n\nDone. ${updated} re-scored${DRY_RUN ? " (dry run, no writes)" : ""}, ${errors} errors.`);
  if (memories.length === LIMIT) {
    console.log(`\nMore may remain — run again to continue (processed limit=${LIMIT}).`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
