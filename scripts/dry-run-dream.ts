#!/usr/bin/env node
/**
 * dry-run-dream.ts
 *
 * Runs a full dream cycle, then shows:
 *   1. What new memories dream produced (by timestamp comparison)
 *   2. Which ones the post-dream cleanup would catch
 *   3. What the self-model synthesizer would generate
 *
 * Pass --apply to actually run the cleanup + synthesis. Without it,
 * everything is reported as dry-run (dream itself always stores, but
 * cleanup and synthesis are held back).
 *
 * Usage:
 *   npx tsx scripts/dry-run-dream.ts           # dream runs, cleanup/synthesis dry-run
 *   npx tsx scripts/dry-run-dream.ts --apply   # dream + cleanup + synthesis all applied
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import { createBrain } from "../src/brain.js";
import { buildConfig } from "../src/config.js";
import { cleanupDreamSelfModel } from "../src/self-model/cleanup.js";
import { synthesizeSelfModel } from "../src/self-model/synthesize.js";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";

const apply = process.argv.includes("--apply");

async function main() {
  const config = buildConfig();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — dream cycle requires it.");
    process.exit(1);
  }

  const brain = await createBrain(config);
  const beforeTime = new Date().toISOString();

  // ── Step 1: Run the dream cycle ─────────────────────────────────────────
  console.log(`\n${BOLD}STEP 1: Running dream cycle...${RESET}\n`);
  const dreamStart = Date.now();
  await brain.dream({});
  const dreamMs = Date.now() - dreamStart;
  console.log(`${DIM}Dream completed in ${(dreamMs / 1000).toFixed(1)}s${RESET}\n`);

  // ── Step 2: Find what dream produced ────────────────────────────────────
  console.log("─".repeat(80));
  console.log(`\n${BOLD}STEP 2: New memories created during dream${RESET}\n`);

  // Pull all very recent memories (last 1 hour, generous window)
  const recentAll = await brain.recent(1, undefined, 100);
  const newMemories = recentAll.filter(
    (m: any) => m.created_at >= beforeTime
  );

  if (newMemories.length === 0) {
    console.log(`  ${DIM}(no new memories created during dream)${RESET}`);
  } else {
    const byType = new Map<string, number>();
    for (const m of newMemories) {
      const t = (m as any).memory_type;
      byType.set(t, (byType.get(t) ?? 0) + 1);
    }

    console.log(`  ${BOLD}${newMemories.length} new memories:${RESET} ${[...byType.entries()].map(([t, c]) => `${t}=${c}`).join(", ")}\n`);

    for (const m of newMemories) {
      const mem = m as any;
      const typeColor = mem.memory_type === "self_model" ? RED
        : mem.memory_type === "semantic" ? GREEN
        : mem.memory_type === "procedural" ? CYAN
        : YELLOW;
      console.log(`  ${typeColor}${mem.memory_type.padEnd(12)}${RESET} ${DIM}(imp ${mem.importance.toFixed(2)}, src: ${mem.source})${RESET}`);
      console.log(`  ${mem.summary?.slice(0, 120) ?? "(no summary)"}`);
      console.log();
    }
  }

  // ── Step 3: Cleanup dry-run ─────────────────────────────────────────────
  console.log("─".repeat(80));
  const mode = apply ? "APPLYING" : "DRY RUN";
  console.log(`\n${BOLD}STEP 3: Post-dream self_model cleanup (${mode})${RESET}\n`);

  const cleanup = await cleanupDreamSelfModel(1, !apply);

  if (cleanup.details.length === 0) {
    console.log(`  ${GREEN}✓ No self_model entries need correction${RESET}`);
  } else {
    for (const d of cleanup.details) {
      const actionColor = d.action === "both" ? RED : d.action === "downgraded" ? RED : YELLOW;
      const actionLabel = d.action === "both"
        ? "DOWNGRADE + CAP"
        : d.action === "downgraded"
          ? "DOWNGRADE → semantic"
          : `CAP ${d.oldImportance?.toFixed(2)} → ${d.newImportance?.toFixed(2)}`;

      const verb = apply ? "Applied" : "Would";
      console.log(`  ${actionColor}#${d.id}${RESET} ${verb}: ${actionLabel}`);
      console.log(`  ${DIM}${d.summary}${RESET}`);
      console.log();
    }
    console.log(`  ${BOLD}${cleanup.downgraded} downgraded, ${cleanup.capped} capped${RESET} ${apply ? "(applied)" : "(dry run)"}`);
  }

  // ── Step 4: Synthesis dry-run ───────────────────────────────────────────
  console.log();
  console.log("─".repeat(80));
  console.log(`\n${BOLD}STEP 4: Self-model synthesis (${mode})${RESET}\n`);

  const synthesis = await synthesizeSelfModel(brain, !apply);

  if (synthesis.entries.length === 0) {
    console.log(`  ${DIM}(no new behavioral observations extracted)${RESET}`);
  } else {
    for (const entry of synthesis.entries) {
      const catColor = entry.category === "user" ? GREEN : YELLOW;
      console.log(`  ${catColor}${entry.category.toUpperCase()}${RESET}  ${entry.summary}`);
    }
    console.log();
    console.log(`  ${BOLD}${synthesis.generated} entries${RESET} ${apply ? "(stored)" : "(would store)"}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log();
  console.log("═".repeat(80));
  console.log(`\n${BOLD}PIPELINE SUMMARY${RESET}\n`);
  console.log(`  Dream produced:       ${newMemories.length} new memories`);
  console.log(`  Cleanup would fix:    ${cleanup.details.length} bad self_model entries`);
  console.log(`  Synthesis would add:  ${synthesis.generated} new self_model entries`);
  console.log(`  Mode:                 ${apply ? `${GREEN}APPLIED${RESET}` : `${YELLOW}DRY RUN${RESET} (pass --apply to commit)`}`);
  console.log();

  (brain as any).destroy?.();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
