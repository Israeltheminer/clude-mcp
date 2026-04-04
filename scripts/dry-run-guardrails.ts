#!/usr/bin/env node
/**
 * dry-run-guardrails.ts
 *
 * Two-part dry run:
 *
 *   Part 1 — GUARDRAILS: Pulls all self_model memories and shows what would
 *   happen to each one (pass / cap / downgrade).
 *
 *   Part 2 — SYNTHESIS: Runs the self-model synthesizer in dry-run mode to
 *   show what NEW self_model entries would be generated from recent data.
 *
 * Nothing is modified. This is a read-only script.
 *
 * Usage:
 *   npx tsx scripts/dry-run-guardrails.ts
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import { createBrain } from "../src/brain.js";
import { buildConfig } from "../src/config.js";
import {
  isMetaReflective,
  isDreamSource,
  SELF_MODEL_IMPORTANCE_CAP,
} from "../src/tools/handlers/storage.js";
import { synthesizeSelfModel } from "../src/self-model/synthesize.js";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

interface MemoryRow {
  id: number;
  summary: string;
  content: string;
  source: string;
  importance: number;
  decay_factor: number;
  created_at: string;
  tags?: string[];
}

async function main() {
  const config = buildConfig();
  const brain = await createBrain(config);

  const memories: MemoryRow[] = await (brain as any).selfModel();

  if (!memories || memories.length === 0) {
    console.log("No self_model memories found.");
    (brain as any).destroy?.();
    return;
  }

  let passCount = 0;
  let cappedCount = 0;
  let downgradedCount = 0;

  console.log(`\n${BOLD}DRY RUN: ${memories.length} self_model memories${RESET}\n`);
  console.log("─".repeat(80));

  for (const mem of memories) {
    const combinedText = `${mem.summary} ${mem.content}`;
    const meta = isMetaReflective(combinedText);
    const dreamSrc = isDreamSource(mem.source);
    const wouldCap = dreamSrc && mem.importance > SELF_MODEL_IMPORTANCE_CAP;

    let verdict: string;
    let icon: string;

    if (meta && wouldCap) {
      verdict = `${RED}✗ BOTH${RESET} — downgraded to semantic + importance ${mem.importance} → ${SELF_MODEL_IMPORTANCE_CAP}`;
      icon = RED;
      downgradedCount++;
    } else if (meta) {
      verdict = `${RED}✗ DOWNGRADED${RESET} — would become semantic (meta-reflective)`;
      icon = RED;
      downgradedCount++;
    } else if (wouldCap) {
      verdict = `${YELLOW}⚠ CAPPED${RESET} — importance ${mem.importance} → ${SELF_MODEL_IMPORTANCE_CAP}`;
      icon = YELLOW;
      cappedCount++;
    } else {
      verdict = `${GREEN}✓ PASS${RESET}`;
      icon = GREEN;
      passCount++;
    }

    const age = timeSince(new Date(mem.created_at));
    const decay = (mem.decay_factor ?? 1).toFixed(2);

    console.log(`\n${icon}#${mem.id}${RESET} ${DIM}(${age}, imp ${mem.importance.toFixed(2)}, decay ${decay}, src: ${mem.source})${RESET}`);
    console.log(`  ${BOLD}${mem.summary.slice(0, 120)}${RESET}`);
    if (meta) {
      const snippet = mem.content.slice(0, 200).replace(/\n/g, " ");
      console.log(`  ${DIM}${snippet}…${RESET}`);
    }
    console.log(`  → ${verdict}`);
  }

  console.log("\n" + "─".repeat(80));
  console.log(`\n${BOLD}SUMMARY${RESET}`);
  console.log(`  ${GREEN}✓ PASS:${RESET}       ${passCount}/${memories.length} — kept as self_model, no changes`);
  console.log(`  ${YELLOW}⚠ CAPPED:${RESET}     ${cappedCount}/${memories.length} — kept as self_model, importance reduced`);
  console.log(`  ${RED}✗ DOWNGRADED:${RESET} ${downgradedCount}/${memories.length} — would become semantic`);

  // ── Part 2: Synthesis dry run ──────────────────────────────────────────
  console.log();
  console.log("─".repeat(80));
  console.log(`\n${BOLD}SYNTHESIS DRY RUN: what new self_model entries would be generated${RESET}\n`);

  try {
    const synthesis = await synthesizeSelfModel(brain, true);

    if (synthesis.entries.length === 0) {
      console.log(`  ${DIM}(no new observations extracted from recent data)${RESET}`);
    } else {
      for (const entry of synthesis.entries) {
        const catColor = entry.category === "user" ? GREEN : YELLOW;
        const catLabel = entry.category.toUpperCase();
        console.log(`  ${catColor}${catLabel}${RESET}  ${entry.summary}`);
      }
      console.log();
      console.log(`  Would store ${BOLD}${synthesis.generated}${RESET} new self_model entries`);
    }
  } catch (err) {
    console.log(`  ${RED}Synthesis failed: ${String(err)}${RESET}`);
  }

  console.log();
  (brain as any).destroy?.();
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
