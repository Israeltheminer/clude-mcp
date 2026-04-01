import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { Cortex } from "clude-bot";
import { log } from "../log.js";
import {
  checkStoreRate,
  checkMemoryQuality,
  checkRecallSanity,
  checkPipelineHealth,
  checkStatsSanity,
  type CheckResult,
  type Severity,
} from "./checks.js";

// ---------------------------------------------------------------------------
// Local log
// ---------------------------------------------------------------------------

const LOG_DIR = join(__dirname, "..", "..", "logs");
const LOG_FILE = join(LOG_DIR, "healthcheck.log");

function appendLog(entry: string): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, entry + "\n", "utf8");
  } catch (err) {
    log("Healthcheck: failed to write log:", String(err));
  }
}

function formatLogEntry(results: CheckResult[]): string {
  const ts = new Date().toISOString();
  const lines = [`[${ts}] Memory Health Check`];
  const maxSeverity = worstSeverity(results);
  lines.push(`  Overall: ${maxSeverity.toUpperCase()}`);

  for (const r of results) {
    const icon = r.severity === "ok" ? "+" : r.severity === "warn" ? "!" : "X";
    lines.push(`  [${icon}] ${r.name}: ${r.message}`);
  }

  lines.push("");
  return lines.join("\n");
}

function worstSeverity(results: CheckResult[]): Severity {
  if (results.some(r => r.severity === "error")) return "error";
  if (results.some(r => r.severity === "warn")) return "warn";
  return "ok";
}

// ---------------------------------------------------------------------------
// Self-model memory
// ---------------------------------------------------------------------------

async function storeSelfModelReport(
  brain: Cortex,
  results: CheckResult[],
): Promise<void> {
  const severity = worstSeverity(results);

  // Only store if there are actual issues
  if (severity === "ok") return;

  const issues = results.filter(r => r.severity !== "ok");
  const date = new Date().toISOString().slice(0, 10);
  const summary = `Memory health check ${date}: ${severity.toUpperCase()} — ${issues.map(i => i.name).join(", ")}`;

  const content = issues
    .map(r => {
      const icon = r.severity === "warn" ? "WARNING" : "ERROR";
      return `[${icon}] ${r.name}: ${r.message}` +
        (r.details ? `\n  Details: ${JSON.stringify(r.details)}` : "");
    })
    .join("\n\n");

  try {
    await brain.store({
      type: "self_model",
      summary,
      content: `Memory system self-diagnosis (${date}):\n\n${content}\n\nThis is an automated health check. If the same issues persist across multiple checks, the underlying cause needs investigation.`,
      source: "healthcheck",
      tags: ["healthcheck", "self-diagnosis", severity, ...issues.map(i => i.name)],
      importance: severity === "error" ? 0.85 : 0.6,
    });
    log(`Healthcheck: stored self_model memory (${severity})`);
  } catch (err) {
    log("Healthcheck: failed to store self_model:", String(err));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all health checks, log results locally, and store a self_model memory
 * if issues are found.
 */
export async function runHealthCheck(brain: Cortex): Promise<CheckResult[]> {
  log("Healthcheck: starting...");

  const results = await Promise.all([
    checkStoreRate(brain),
    checkMemoryQuality(brain),
    checkRecallSanity(brain),
    checkPipelineHealth(brain),
    checkStatsSanity(brain),
  ]);

  // Log locally
  const entry = formatLogEntry(results);
  appendLog(entry);
  log(`Healthcheck: ${worstSeverity(results).toUpperCase()} — ${results.length} checks completed`);

  // Store self_model if issues found
  await storeSelfModelReport(brain, results);

  return results;
}
