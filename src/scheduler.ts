/**
 * @module scheduler
 *
 * Internal cron scheduler for the clude MCP server.
 *
 * Runs the dream consolidation and memory decay jobs on a configurable
 * schedule, removing the need for external Claude Code scheduled tasks.
 * The server already has ANTHROPIC_API_KEY and direct DB access — it can
 * run these jobs itself.
 *
 * ## Missed-run catch-up
 *
 * node-cron only fires while the process is running. If the server was down
 * at the scheduled time, the job is silently skipped. To handle this, each
 * job records its last successful run in a local state file
 * (.scheduler-state.json next to the process cwd). On startup, if the last
 * run was longer ago than the job's interval, the job fires immediately.
 *
 * ## Jobs
 *
 *   dream  — consolidation cycle (default: 02:00 + 14:00 daily, interval 12h)
 *   decay  — importance decay pass (default: 03:00 daily, interval 24h)
 *
 * ## Configuration via Environment Variables
 *
 *   DREAM_CRON        — cron expression for dream job  (default "0 2 * * *")
 *   DECAY_CRON        — cron expression for decay job  (default "0 3 * * *")
 *   SCHEDULER_ENABLED — set to "false" to disable both jobs (default: enabled
 *                       when ANTHROPIC_API_KEY is present)
 *   SCHEDULER_STATE   — path to the state file (default ".scheduler-state.json")
 *
 * ## Usage
 *
 *   import { startScheduler, stopScheduler } from "./scheduler.js";
 *
 *   const scheduler = startScheduler(brain);
 *   // on shutdown:
 *   stopScheduler(scheduler);
 */

import cron from "node-cron";
import fs from "node:fs";
import path from "node:path";
import type { Cortex } from "clude-bot";
import { log } from "./log.js";

export interface SchedulerHandle {
  dreamJob: cron.ScheduledTask;
  decayJob: cron.ScheduledTask;
}

interface SchedulerState {
  lastDream: string | null; // ISO timestamp
  lastDecay: string | null; // ISO timestamp
}

const DEFAULT_DREAM_CRON = "0 2,14 * * *"; // twice daily: 2am + 2pm
const DEFAULT_DECAY_CRON = "0 3 * * *";
const CATCH_UP_INTERVAL_MS = 10 * 60 * 60 * 1000; // fire catch-up if >10h since last run (matches 2x/day)

// ---------------------------------------------------------------------------
// State file helpers
// ---------------------------------------------------------------------------

function stateFilePath(): string {
  return (
    process.env.SCHEDULER_STATE ??
    path.join(__dirname, "..", ".scheduler-state.json")
  );
}

function readState(): SchedulerState {
  try {
    const raw = fs.readFileSync(stateFilePath(), "utf8");
    return JSON.parse(raw) as SchedulerState;
  } catch {
    return { lastDream: null, lastDecay: null };
  }
}

function writeState(patch: Partial<SchedulerState>): void {
  try {
    const current = readState();
    const next = { ...current, ...patch };
    fs.writeFileSync(stateFilePath(), JSON.stringify(next, null, 2), "utf8");
  } catch (err) {
    log("Scheduler: failed to write state file:", String(err));
  }
}

function isMissed(lastRun: string | null): boolean {
  if (!lastRun) return true; // never run → always catch up
  return Date.now() - new Date(lastRun).getTime() > CATCH_UP_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Job runners (shared between cron callbacks and catch-up)
// ---------------------------------------------------------------------------

async function runDream(brain: Cortex): Promise<void> {
  log("Scheduler: starting dream cycle...");
  try {
    await brain.dream({});
    writeState({ lastDream: new Date().toISOString() });
    log("Scheduler: dream cycle complete.");
  } catch (err) {
    log("Scheduler: dream cycle failed:", String(err));
  }
}

async function runDecay(brain: Cortex): Promise<void> {
  log("Scheduler: starting decay pass...");
  try {
    const updated = await brain.decay();
    writeState({ lastDecay: new Date().toISOString() });
    log(`Scheduler: decay pass complete. ${updated} memories updated.`);
  } catch (err) {
    log("Scheduler: decay pass failed:", String(err));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the internal cron scheduler.
 *
 * On startup, checks the state file for missed runs and fires catch-up jobs
 * immediately if either job hasn't run in >23h (non-blocking).
 *
 * Returns null if scheduling is disabled (SCHEDULER_ENABLED=false or
 * ANTHROPIC_API_KEY is not set — the dream job requires it).
 *
 * @param brain - Initialised Cortex instance shared with the MCP server.
 * @returns A SchedulerHandle for stopping the jobs, or null if disabled.
 */
export function startScheduler(brain: Cortex): SchedulerHandle | null {
  const enabled = process.env.SCHEDULER_ENABLED !== "false";
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  if (!enabled || !hasApiKey) {
    log(
      "Scheduler disabled.",
      !enabled ? "SCHEDULER_ENABLED=false" : "ANTHROPIC_API_KEY not set"
    );
    return null;
  }

  const dreamCron = process.env.DREAM_CRON ?? DEFAULT_DREAM_CRON;
  const decayCron = process.env.DECAY_CRON ?? DEFAULT_DECAY_CRON;

  if (!cron.validate(dreamCron)) {
    log(`Invalid DREAM_CRON expression: "${dreamCron}" — scheduler not started`);
    return null;
  }
  if (!cron.validate(decayCron)) {
    log(`Invalid DECAY_CRON expression: "${decayCron}" — scheduler not started`);
    return null;
  }

  // Catch-up: fire any missed jobs immediately (non-blocking).
  // Decay is cheap and idempotent — always run on startup to ensure it happens.
  // Dream is expensive — only catch up if missed (>20h since last run).
  const state = readState();
  log("Scheduler: running decay on startup (always).");
  void runDecay(brain);
  if (isMissed(state.lastDream)) {
    log("Scheduler: dream was missed — running catch-up now.");
    void runDream(brain);
  }

  // Schedule ongoing jobs
  const dreamJob = cron.schedule(dreamCron, () => void runDream(brain));
  const decayJob = cron.schedule(decayCron, () => void runDecay(brain));

  log(`Scheduler active. dream=${dreamCron}  decay=${decayCron}`);
  return { dreamJob, decayJob };
}

/**
 * Stop all scheduled jobs cleanly.
 *
 * Safe to call with a null handle (when the scheduler was disabled at startup).
 *
 * @param handle - The SchedulerHandle returned by startScheduler, or null.
 */
export function stopScheduler(handle: SchedulerHandle | null): void {
  if (!handle) return;
  handle.dreamJob.stop();
  handle.decayJob.stop();
  log("Scheduler stopped.");
}
