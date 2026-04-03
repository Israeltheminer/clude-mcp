import Anthropic from "@anthropic-ai/sdk";
import type { Cortex } from "clude-bot";
import { log } from "../log.js";

// Very small, opinionated procedural extractor.
// Runs after dream, looks at recent semantic memories and, for tags that show up
// repeatedly, tries to distill a reusable step-by-step procedure.

const PROCEDURE_MIN_TAG_COUNT = 3; // tag must appear on at least N memories
const PROCEDURE_MAX_TAGS = 5;     // at most this many procedures per run
const PROCEDURE_MAX_MEMORIES_PER_TAG = 8;
const RECENT_HOURS = 24 * 7;      // look back one week

function getAnthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY not set — cannot extract procedures");
  }
  return new Anthropic({ apiKey: key });
}

export async function runProceduralExtraction(brain: Cortex): Promise<void> {
  try {
    log("procedure: starting extraction pass...");

    // 1) Get recent semantic memories
    const recent = await brain.recent(RECENT_HOURS, ["semantic"], 200);
    if (!recent.length) {
      log("procedure: no recent semantic memories, skipping");
      return;
    }

    // 2) Count non-project tags
    const tagCounts = new Map<string, number>();
    for (const m of recent) {
      const tags = (m as any).tags as string[] | null | undefined;
      if (!tags) continue;
      for (const raw of tags) {
        const t = String(raw);
        if (!t || t.startsWith("project:")) continue;
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    }

    const candidates = [...tagCounts.entries()]
      .filter(([, count]) => count >= PROCEDURE_MIN_TAG_COUNT)
      .sort((a, b) => b[1] - a[1])
      .slice(0, PROCEDURE_MAX_TAGS);

    if (!candidates.length) {
      log("procedure: no tags met minimum frequency threshold");
      return;
    }

    const anthropic = getAnthropicClient();

    for (const [tag] of candidates) {
      try {
        const tagged = recent.filter((m) =>
          ((m as any).tags as string[] | null | undefined)?.includes(tag),
        );
        if (tagged.length < PROCEDURE_MIN_TAG_COUNT) continue;

        const slice = tagged.slice(0, PROCEDURE_MAX_MEMORIES_PER_TAG);
        const contextLines = slice
          .map(
            (m, i) =>
              `${i + 1}. ${String((m as any).summary ?? "").slice(0, 200)}`,
          )
          .join("\n");

        const prompt = [
          `You are extracting a reusable procedure for the goal/tag: "${tag}".`,
          "",
          "Below are semantic memories (summaries) of past successful work related to this tag.",
          "If there is a clear, reusable multi-step workflow the agent should follow next time,",
          "output ONLY a numbered list of steps (1., 2., 3., ...).",
          "",
          "If there is no stable, reusable procedure here, reply exactly: SKIP",
          "",
          "PAST MEMORIES:",
          contextLines,
        ].join("\n");

        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        });

        const block = response.content[0];
        const text =
          block && block.type === "text"
            ? block.text.trim()
            : "";
        if (!text || text.startsWith("SKIP")) {
          log(`procedure: tag="${tag}" → SKIP`);
          continue;
        }

        // Heuristic: must have at least two numbered steps to be worth storing.
        const stepLines = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l);
        const numberedCount = stepLines.filter((l) => /^\d+\./.test(l)).length;
        if (numberedCount < 2) {
          log(`procedure: tag="${tag}" → not enough concrete steps`);
          continue;
        }

        const content = stepLines.join("\n");
        const summary =
          stepLines.find((l) => /^\d+\./.test(l)) ??
          `Procedure for ${tag}`;

        const procedureTags = [
          `procedure:${tag}`,
          tag,
          ...(slice[0] as any).tags?.filter(
            (t: string) => t.startsWith("project:"),
          ) ?? [],
        ];

        await brain.store({
          type: "procedural",
          content,
          summary,
          source: "procedure-extractor",
          tags: procedureTags,
          importance: 0.8,
          metadata: {
            derived_from_tag: tag,
            source_memory_ids: slice.map((m) => m.id),
          },
        });

        log(`procedure: stored procedural memory for tag="${tag}"`);
      } catch (err: any) {
        log(
          `procedure: extraction failed for tag="${tag}": ${String(
            err?.message ?? err,
          ).slice(0, 120)}`,
        );
      }
    }

    log("procedure: extraction pass complete");
  } catch (err: any) {
    log(
      `procedure: top-level extraction error: ${String(err?.message ?? err).slice(
        0,
        120,
      )}`,
    );
  }
}

