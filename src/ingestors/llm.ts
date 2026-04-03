import Anthropic from "@anthropic-ai/sdk";
import { log } from "../log.js";

let _client: Anthropic | null = null;

function getClient(apiKey?: string): Anthropic {
  if (_client) return _client;
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY not set — refusing to ingest without LLM");
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

function extractResponse(response: Anthropic.Message): string {
  const block = response.content[0];
  return block?.type === "text" ? block.text.trim() : "";
}

export async function scoreImportance(text: string, apiKey?: string): Promise<number> {
  const client = getClient(apiKey);
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
  if (isNaN(score)) throw new Error(`LLM returned non-numeric score: "${raw}"`);
  return Math.min(1, Math.max(0, score));
}

export async function summarizeForUserContext(
  userText: string,
  assistantContext: string,
  apiKey?: string,
): Promise<string> {
  const client = getClient(apiKey);
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    messages: [{
      role: "user",
      content: [
        "You are building a concise, decision-focused memory about the USER.",
        "",
        "1) Extract what this conversation reveals about the USER — not what the AI did.",
        "2) Focus especially on:",
        "   - concrete decisions the user made (choices between options, adopted patterns, rejected approaches),",
        "   - rules or commitments that should hold in the future (\"we will always...\", \"we never...\"),",
        "   - stable preferences, constraints, or long-lived facts about their projects and environment.",
        "3) Ignore AI tool calls, debugging steps, file edits, and routine commands.",
        "",
        "Output format (markdown bullets only, no headings):",
        "- Decision: <short, closed-form decision or rule, if any>",
        "- Rule: <ongoing constraint or guideline, if any>",
        "- Fact: <important stable fact about the user/project>",
        "- Open-question: <important unresolved question, if it matters long-term>",
        "",
        "If nothing user-relevant exists, reply SKIP.",
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
  return result.startsWith("SKIP") ? "" : result;
}

export async function inferTags(text: string, apiKey?: string): Promise<string[]> {
  const client = getClient(apiKey);
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
}

/** @deprecated Use summarizeForUserContext instead */
export const summarizeWindow = summarizeForUserContext;
/** @deprecated Use inferTags instead */
export const inferConcepts = inferTags;
