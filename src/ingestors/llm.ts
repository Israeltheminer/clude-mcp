import Anthropic from "@anthropic-ai/sdk";
import { log } from "../log.js";

let _client: Anthropic | null = null;

function getClient(apiKey?: string): Anthropic | null {
  if (_client) return _client;
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) {
    log("ingest/llm: ANTHROPIC_API_KEY not set — LLM calls will return fallbacks");
    return null;
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

function extractResponse(response: Anthropic.Message): string {
  const block = response.content[0];
  return block?.type === "text" ? block.text.trim() : "";
}

const PREFERENCE_SIGNALS = /\b(i want|i need|i prefer|i like|we use|we need|should be|must be|let's use|switch to|move to|i decided|my .*(project|app|stack|users|platform|team))\b/i;
const DECISION_SIGNALS = /\b(decided|choosing|picked|going with|switching to|moving to|replacing|migrating|instead of)\b/i;
const CONTEXT_SIGNALS = /\b(\d+%|percent|most users|our users|production|deployment|ios|android|safari|chrome|mobile)\b/i;
const NOISE_SIGNALS = /\b(let me|now i'll|checking|running|searching|looking at|reading|still on)\b/i;

function heuristicScore(text: string): number {
  const lower = text.toLowerCase();
  let score = 0.3;

  if (PREFERENCE_SIGNALS.test(lower)) score += 0.25;
  if (DECISION_SIGNALS.test(lower)) score += 0.15;
  if (CONTEXT_SIGNALS.test(lower)) score += 0.15;

  const questionCount = (text.match(/\?/g) || []).length;
  if (questionCount >= 2) score += 0.1;

  if (text.length > 200) score += 0.05;

  if (NOISE_SIGNALS.test(lower)) score -= 0.1;

  return Math.min(1, Math.max(0.1, score));
}

export async function scoreImportance(text: string, apiKey?: string): Promise<number> {
  const client = getClient(apiKey);
  if (!client) return heuristicScore(text);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{
        role: "user",
        content: [
          "Score how valuable this is to remember about the USER on 0.0–1.0.",
          "HIGH (0.7–1.0): User preferences, constraints, tech stack, platform targets, recurring pain points, architectural decisions they made, project requirements they stated.",
          "MEDIUM (0.4–0.6): Specific bugs the user encountered, tools they chose, workflows they established.",
          "LOW (0.0–0.3): AI debugging steps, routine tool output, boilerplate commands, AI narration of actions taken.",
          "Score the USER signal, not the AI actions. Reply with a single decimal only.",
          "",
          text.slice(0, 600),
        ].join("\n"),
      }],
    });
    const raw = extractResponse(response);
    const score = parseFloat(raw);
    return isNaN(score) ? heuristicScore(text) : Math.min(1, Math.max(0, score));
  } catch (err: any) {
    log(`ingest/llm: scoreImportance failed: ${err.message?.slice(0, 80)}`);
    return heuristicScore(text);
  }
}

/**
 * Heuristic summarizer: extract the most informative user sentences.
 * Used when Anthropic API is unavailable.
 */
function heuristicSummarize(userText: string): string {
  const sentences = userText
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 15);

  const scored = sentences.map(s => {
    let w = 0;
    if (PREFERENCE_SIGNALS.test(s)) w += 3;
    if (DECISION_SIGNALS.test(s)) w += 2;
    if (CONTEXT_SIGNALS.test(s)) w += 2;
    if (NOISE_SIGNALS.test(s)) w -= 2;
    if (s.includes("?")) w += 1;
    return { s, w };
  });

  const top = scored
    .sort((a, b) => b.w - a.w)
    .slice(0, 4)
    .filter(x => x.w > 0)
    .map(x => `- ${x.s}`);

  return top.length > 0 ? top.join("\n") : "";
}

export async function summarizeForUserContext(
  userText: string,
  assistantContext: string,
  apiKey?: string,
): Promise<string> {
  const client = getClient(apiKey);
  if (!client) return heuristicSummarize(userText);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: [
          "Extract what this conversation reveals about the USER — not what the AI did.",
          "Focus on: user preferences, decisions, project context, platform constraints, tech stack, pain points, requirements, and architectural choices.",
          "Ignore: AI tool calls, debugging steps, file edits, routine commands.",
          "Write 2-4 concise bullet points. Each should be a standalone fact about the user or their project. If nothing user-relevant exists, reply SKIP.",
          "",
          "USER MESSAGES:",
          userText.slice(0, 2500),
          "",
          "CONTEXT (assistant responses, for reference only):",
          assistantContext.slice(0, 1500),
        ].join("\n"),
      }],
    });
    const result = extractResponse(response);
    return result === "SKIP" ? "" : result;
  } catch (err: any) {
    log(`ingest/llm: summarizeForUserContext failed: ${err.message?.slice(0, 80)}`);
    return heuristicSummarize(userText);
  }
}

const TAG_KEYWORDS: Record<string, RegExp> = {
  "ios-safari":      /\b(ios safari|safari pwa|iphone|ipad|webkit)\b/i,
  "pwa":             /\b(pwa|service.worker|manifest\.json|standalone mode|installable)\b/i,
  "security":        /\b(rls|row.level|cross.org|vulnerability|permission|auth.?z)\b/i,
  "barcode-scanner": /\b(barcode|qr.?code|zxing|wasm.?scanner)\b/i,
  "typescript":      /\b(typescript|type.?error|tsc|tsconfig)\b/i,
  "ci-cd":           /\b(github actions|ci.?cd|blacksmith|deploy|workflow\.yml)\b/i,
  "testing":         /\b(vitest|jest|test suite|coverage|mock)\b/i,
  "ui-component":    /\b(skeleton|dialog|modal|component|button|sidebar)\b/i,
  "email":           /\b(email template|resend|smtp|email.?send)\b/i,
  "database":        /\b(supabase|convex|database|migration|schema)\b/i,
  "performance":     /\b(performance|optimize|lazy.?load|code.?split|cache)\b/i,
  "mobile":          /\b(mobile|responsive|touch|gesture)\b/i,
  "onboarding":      /\b(onboarding|registration flow|sign.?up flow)\b/i,
  "networking":      /\b(router|mikrotik|openwrt|raspberry pi|gl.inet|nat)\b/i,
};

function heuristicTags(text: string): string[] {
  const matched: string[] = [];
  for (const [tag, pattern] of Object.entries(TAG_KEYWORDS)) {
    if (pattern.test(text)) {
      matched.push(tag);
    }
  }
  return matched.slice(0, 5);
}

export async function inferTags(text: string, apiKey?: string): Promise<string[]> {
  const client = getClient(apiKey);
  if (!client) return heuristicTags(text);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      messages: [{
        role: "user",
        content: [
          "Extract 3-5 tags that categorize what the USER cares about in this conversation.",
          "Use domain-specific tags like: ios-safari, pwa, rls-security, barcode-scanner, convex, tanstack-router, email-templates, ci-cd, typescript, pricing-input, onboarding, etc.",
          "Prefer specific project/domain tags over generic ones (prefer 'rls-security' over 'backend').",
          "Return as comma-separated lowercase tags with hyphens. Nothing else.",
          "",
          text.slice(0, 2000),
        ].join("\n"),
      }],
    });
    const raw = extractResponse(response);
    return raw
      .split(",")
      .map((s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""))
      .filter(Boolean)
      .slice(0, 6);
  } catch (err: any) {
    log(`ingest/llm: inferTags failed: ${err.message?.slice(0, 80)}`);
    return heuristicTags(text);
  }
}

/** @deprecated Use summarizeForUserContext instead */
export const summarizeWindow = summarizeForUserContext;
/** @deprecated Use inferTags instead */
export const inferConcepts = inferTags;
