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
 *   ingest — session ingestion (default: 01:00 daily, interval 24h)
 *   dream  — consolidation cycle (default: 02:00 + 14:00 daily, interval 12h)
 *   decay  — importance decay pass (default: 03:00 daily, interval 24h)
 *   health — self-improving health check (default: 04:00 daily, interval 24h)
 *
 * ## Configuration via Environment Variables
 *
 *   INGEST_CRON       — cron expression for ingest job (default "0 1 * * *")
 *   INGEST_CHAIN_DREAM — chain dream after ingest      (default "true")
 *   DREAM_CRON        — cron expression for dream job  (default "0 2 * * *")
 *   DECAY_CRON        — cron expression for decay job  (default "0 3 * * *")
 *   HEALTH_CRON       — cron expression for health job (default "0 4 * * *")
 *   SCHEDULER_ENABLED — set to "false" to disable all jobs (default: enabled
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
import { runIngestionPipeline } from "./ingestors/pipeline.js";
import { runHealthCheck } from "./healthcheck/runner.js";

export interface SchedulerHandle {
  ingestJob: cron.ScheduledTask;
  dreamJob: cron.ScheduledTask;
  decayJob: cron.ScheduledTask;
  healthJob: cron.ScheduledTask;
}

interface SchedulerState {
  lastIngest: string | null;  // ISO timestamp
  lastDream: string | null;   // ISO timestamp
  lastDecay: string | null;   // ISO timestamp
  lastHealth: string | null;  // ISO timestamp
}

const DEFAULT_INGEST_CRON = "0 1 * * *";    // daily at 1am (before dream)
const DEFAULT_DREAM_CRON = "0 2,14 * * *";  // twice daily: 2am + 2pm
const DEFAULT_DECAY_CRON = "0 3 * * *";
const DEFAULT_HEALTH_CRON = "0 4 * * *";    // daily at 4am (after ingest+dream+decay)
const CATCH_UP_INTERVAL_MS = 10 * 60 * 60 * 1000; // fire catch-up if >10h since last run
const INGEST_CATCH_UP_MS = 22 * 60 * 60 * 1000;   // fire catch-up if >22h since last run (daily)

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
    return { lastIngest: null, lastDream: null, lastDecay: null, lastHealth: null };
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

async function runIngest(brain: Cortex): Promise<void> {
  const chainDream = process.env.INGEST_CHAIN_DREAM !== "false";
  log("Scheduler: starting session ingestion...");
  try {
    const result = await runIngestionPipeline(brain, {
      window: 10,
      threshold: 0.4,
      limit: 0,
      dryRun: false,
      chainDream: false, // dream is chained separately below
      platform: "auto",
    });
    writeState({ lastIngest: new Date().toISOString() });
    log(
      `Scheduler: ingestion complete. ${result.sessionsProcessed} sessions, ` +
      `${result.memoriesStored} memories stored.`
    );
    if (chainDream && result.memoriesStored > 0) {
      log("Scheduler: chaining dream after ingestion...");
      await runDream(brain);
    }
  } catch (err) {
    log("Scheduler: ingestion failed:", String(err));
  }
}

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

async function runHealth(brain: Cortex): Promise<void> {
  log("Scheduler: starting health check...");
  try {
    const results = await runHealthCheck(brain);
    writeState({ lastHealth: new Date().toISOString() });
    const worst = results.some(r => r.severity === "error")
      ? "ERROR"
      : results.some(r => r.severity === "warn")
        ? "WARN"
        : "OK";
    log(`Scheduler: health check complete — ${worst}`);
  } catch (err) {
    log("Scheduler: health check failed:", String(err));
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

  const ingestCron = process.env.INGEST_CRON ?? DEFAULT_INGEST_CRON;
  const dreamCron = process.env.DREAM_CRON ?? DEFAULT_DREAM_CRON;
  const decayCron = process.env.DECAY_CRON ?? DEFAULT_DECAY_CRON;
  const healthCron = process.env.HEALTH_CRON ?? DEFAULT_HEALTH_CRON;

  for (const [name, expr] of [["INGEST_CRON", ingestCron], ["DREAM_CRON", dreamCron], ["DECAY_CRON", decayCron], ["HEALTH_CRON", healthCron]]) {
    if (!cron.validate(expr)) {
      log(`Invalid ${name} expression: "${expr}" — scheduler not started`);
      return null;
    }
  }

  // Catch-up: fire any missed jobs immediately (non-blocking).
  const state = readState();
  log("Scheduler: running decay on startup (always).");
  void runDecay(brain);
  if (isMissed(state.lastDream)) {
    log("Scheduler: dream was missed — running catch-up now.");
    void runDream(brain);
  }
  if (!state.lastIngest || Date.now() - new Date(state.lastIngest).getTime() > INGEST_CATCH_UP_MS) {
    log("Scheduler: ingest was missed — running catch-up now.");
    void runIngest(brain);
  }

  // Schedule ongoing jobs
  const ingestJob = cron.schedule(ingestCron, () => void runIngest(brain));
  const dreamJob = cron.schedule(dreamCron, () => void runDream(brain));
  const decayJob = cron.schedule(decayCron, () => void runDecay(brain));
  const healthJob = cron.schedule(healthCron, () => void runHealth(brain));

  log(`Scheduler active. ingest=${ingestCron}  dream=${dreamCron}  decay=${decayCron}  health=${healthCron}`);
  return { ingestJob, dreamJob, decayJob, healthJob };
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
  handle.ingestJob.stop();
  handle.dreamJob.stop();
  handle.decayJob.stop();
  handle.healthJob.stop();
  log("Scheduler stopped.");
}
