import type { Cortex } from "clude-bot";
import type { Turn, IngestOptions, IngestResult, ProgressEvent } from "./types.js";
import { loadState, saveState } from "./state.js";
import { RateLimiter } from "./rate-limiter.js";
import { scoreImportance, summarizeForUserContext, inferTags } from "./llm.js";
import { collectAllSessions } from "./generic.js";
import { sourceLabel } from "./claude-code.js";
import { log } from "../log.js";

const voyageLimiter = new RateLimiter(3, 60_000);

/**
 * Build user-focused content from a window of turns.
 * User messages are primary content; assistant messages are condensed context.
 */
function buildUserContent(turns: Turn[]): { userText: string; assistantContext: string } {
  const userParts: string[] = [];
  const assistantParts: string[] = [];

  for (const t of turns) {
    if (t.role === "user") {
      userParts.push(t.text);
    } else {
      const condensed = condenseAssistantTurn(t.text);
      if (condensed) assistantParts.push(condensed);
    }
  }

  return {
    userText: userParts.join("\n\n"),
    assistantContext: assistantParts.join("\n"),
  };
}

/**
 * Strip AI narration fluff from assistant turns, keeping only substantive content.
 * Removes "Let me...", "Now I'll...", tool-call narration, and keeps findings/decisions.
 */
function condenseAssistantTurn(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(Let me|Now (?:let me|I'll)|I'll |I need to |I can see|I should |Looking at|Still on|Good[,.])/i.test(trimmed)) continue;
    if (/^(Searching|Reading|Checking|Running|Executing|Navigating|Clicking)/i.test(trimmed)) continue;
    if (/^A: (Let me|Now |I'll |I need to |Still |OK )/i.test(trimmed)) continue;
    kept.push(trimmed);
  }

  return kept.slice(0, 8).join("\n");
}

/**
 * Run the full ingestion pipeline: collect → filter → window → score → store.
 * Extracts USER context (preferences, decisions, project facts) — not AI actions.
 */
export async function runIngestionPipeline(
  brain: Cortex,
  options: IngestOptions,
  onProgress?: (event: ProgressEvent) => void,
): Promise<IngestResult> {
  const result: IngestResult = {
    sessionsProcessed: 0,
    memoriesStored: 0,
    sessionsPending: 0,
    sessionsSkipped: 0,
    dreamChained: false,
  };

  const allSessions = collectAllSessions({
    sourcePath: options.sourcePath,
    platform: options.platform,
    project: options.project,
  });

  const state = loadState();
  let pending = allSessions.filter(s => !state.ingested[s.path]);

  result.sessionsPending = pending.length;
  result.sessionsSkipped = allSessions.length - pending.length;

  if (options.limit > 0 && pending.length > options.limit) {
    pending = pending.slice(0, options.limit);
  }

  if (options.dryRun || pending.length === 0) {
    return result;
  }

  const total = pending.length;

  for (let si = 0; si < pending.length; si++) {
    const session = pending[si];
    const turns = session.turns;

    if (turns.length < 2) {
      state.ingested[session.path] = new Date().toISOString();
      saveState(state);
      onProgress?.({ kind: "skip", index: si, total, reason: "too short" });
      continue;
    }

    const source = session.platform === "claude-code"
      ? sourceLabel(session.path)
      : session.platform;
    const sessionDate = turns[0]?.timestamp?.slice(0, 10) ?? "unknown";
    const sessionLabel = `${source}  ${sessionDate}`;

    onProgress?.({ kind: "session-start", index: si, total, label: sessionLabel });

    const windowSize = options.window;
    const windowTotal = Math.ceil(turns.length / windowSize);
    let sessionMemories = 0;
    let prevCheckpointId: number | null = null;

    for (let wi = 0; wi < turns.length; wi += windowSize) {
      const windowTurns = turns.slice(wi, wi + windowSize);
      if (windowTurns.length < 2) continue;

      const winNum = Math.floor(wi / windowSize) + 1;
      onProgress?.({
        kind: "window",
        index: si,
        total,
        windowNum: winNum,
        windowTotal,
        status: "analyzing",
      });

      // ── Separate user signal from AI narration ────────────────────
      const { userText, assistantContext } = buildUserContent(windowTurns);

      if (!userText.trim() || userText.trim().length < 30) {
        onProgress?.({
          kind: "window",
          index: si,
          total,
          windowNum: winNum,
          windowTotal,
          status: "skipped (no user content)",
        });
        continue;
      }

      // ── Score on user text, not assistant narration ───────────────
      const importance = await scoreImportance(userText.slice(0, 600));

      // Heuristic scores max out ~0.55; lower the threshold proportionally
      const effectiveThreshold = importance <= 0.55
        ? Math.max(0.25, options.threshold * 0.65)
        : options.threshold;

      if (importance < effectiveThreshold) {
        onProgress?.({
          kind: "window",
          index: si,
          total,
          windowNum: winNum,
          windowTotal,
          status: `skipped (score ${importance.toFixed(2)})`,
        });
        continue;
      }

      // ── LLM summarization focused on user context ─────────────────
      onProgress?.({
        kind: "window",
        index: si,
        total,
        windowNum: winNum,
        windowTotal,
        status: "summarizing",
      });

      const summary = await summarizeForUserContext(userText, assistantContext);

      if (!summary) {
        onProgress?.({
          kind: "window",
          index: si,
          total,
          windowNum: winNum,
          windowTotal,
          status: "skipped (no user-relevant content)",
        });
        continue;
      }

      // Tags from LLM — do NOT use brain.inferConcepts (returns []).
      // Feed user text + summary only; exclude assistant context to avoid tag pollution.
      const tags = await inferTags(userText.slice(0, 1000) + "\n" + summary);

      // ── Content: user text as primary, condensed assistant as supporting ──
      const content = [
        userText.slice(0, 2000),
        assistantContext ? `\n\n── Assistant context ──\n${assistantContext.slice(0, 500)}` : "",
      ].join("").trim();

      try {
        await voyageLimiter.throttle((waitSec) => {
          onProgress?.({ kind: "rate-limit", waitSec });
        });

        onProgress?.({
          kind: "window",
          index: si,
          total,
          windowNum: winNum,
          windowTotal,
          status: "storing",
        });

        const checkpointId = await brain.store({
          type: "semantic",
          content,
          summary: `[${sessionLabel}] ${summary}`,
          source: "checkpoint",
          tags,
          importance,
        });
        sessionMemories++;

        if (checkpointId && prevCheckpointId) {
          try {
            await brain.link(prevCheckpointId, checkpointId, "follows", 0.8);
          } catch { /* non-fatal */ }
        }
        prevCheckpointId = checkpointId;
      } catch (err: any) {
        log(`ingest: window ${winNum} error: ${err.message}`);
      }
    }

    state.ingested[session.path] = new Date().toISOString();
    saveState(state);
    result.sessionsProcessed++;
    result.memoriesStored += sessionMemories;

    onProgress?.({
      kind: "session-done",
      index: si,
      total,
      label: sessionLabel,
      memories: sessionMemories,
    });
  }

  return result;
}
