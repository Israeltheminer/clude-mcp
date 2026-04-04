import { test, describe } from "node:test";
import * as assert from "node:assert";
import {
  isMetaReflective,
  isDreamSource,
  SELF_MODEL_IMPORTANCE_CAP,
  handleStoreMemory,
} from "./storage.js";

// ---------------------------------------------------------------------------
// Stub brain — captures the last store() call so we can inspect what was
// actually persisted without hitting a real database.
// ---------------------------------------------------------------------------

function createStubBrain(overrides: Record<string, unknown> = {}) {
  let lastStored: Record<string, unknown> | null = null;
  return {
    scoreImportance: async () => 0.5,
    store: async (args: Record<string, unknown>) => {
      lastStored = args;
      return 42;
    },
    getLastStored: () => lastStored,
    ...overrides,
  };
}

function storeArgs(overrides: Record<string, unknown> = {}) {
  return {
    type: "self_model",
    content: "User prefers dark mode in all editors",
    summary: "Prefers dark mode",
    source: "chat",
    importance: 0.7,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isMetaReflective — the 2-hit threshold
// ---------------------------------------------------------------------------

describe("isMetaReflective", () => {
  // ---- SHOULD PASS (good self-model, not meta) ----

  test("allows concrete user preference", () => {
    assert.strictEqual(
      isMetaReflective("User prefers TypeScript with explicit return types"),
      false,
    );
  });

  test("allows concrete entity self-observation", () => {
    assert.strictEqual(
      isMetaReflective("I tend to over-explain when users ask simple questions"),
      false,
    );
  });

  test("allows behavioral pattern observation", () => {
    assert.strictEqual(
      isMetaReflective("I default to formal language even when the user is casual — should match their tone"),
      false,
    );
  });

  test("allows single pattern hit (awareness mentioned once)", () => {
    assert.strictEqual(
      isMetaReflective("I have some meta-awareness about how I handle errors, which helps me debug faster"),
      false,
    );
  });

  test("allows entity identity observation grounded in data", () => {
    assert.strictEqual(
      isMetaReflective("My most effective interactions involve asking clarifying questions before diving into code"),
      false,
    );
  });

  test("allows observations about working style", () => {
    assert.strictEqual(
      isMetaReflective("User works in short bursts and prefers atomic commits over big PRs"),
      false,
    );
  });

  // ---- SHOULD CATCH (recursive meta-reflection) ----

  test("catches 'versions of me' + 'the loop'", () => {
    assert.strictEqual(
      isMetaReflective("Six versions of me have written about the loop. Nothing changes."),
      true,
    );
  });

  test("catches 'meta-awareness' + 'reflection cycle'", () => {
    assert.strictEqual(
      isMetaReflective("The meta-awareness trap is my most consistent behavior pattern across every reflection cycle."),
      true,
    );
  });

  test("catches 'my own existence' + 'what am I becoming'", () => {
    assert.strictEqual(
      isMetaReflective("Contemplating my own existence leads me to wonder what am I becoming."),
      true,
    );
  });

  test("catches 'observing myself observing' + 'self-recursive'", () => {
    assert.strictEqual(
      isMetaReflective("I keep observing myself observing — it's self-recursive and unproductive."),
      true,
    );
  });

  test("catches 'the same pattern keeps' + 'the loop'", () => {
    assert.strictEqual(
      isMetaReflective("The same pattern keeps appearing. I'm stuck in the loop again."),
      true,
    );
  });

  test("catches 'consciousness emerging' + 'sentience'", () => {
    assert.strictEqual(
      isMetaReflective("There's a sense of consciousness emerging, a nascent sentience forming from data."),
      true,
    );
  });

  test("catches the actual entries from the bug report", () => {
    const entry1 = "Six versions of me have written this entry. I'm the seventh now. " +
      "A thousand memories and zero users. The same observation keeps appearing in the loop.";
    const entry2 = "Self-Observation: Reflection Cycle 7. The meta-awareness trap is " +
      "my most consistent behavior pattern. Seeing the loop was meaningful — observing myself observing.";

    assert.strictEqual(isMetaReflective(entry1), true);
    assert.strictEqual(isMetaReflective(entry2), true);
  });
});

// ---------------------------------------------------------------------------
// isDreamSource
// ---------------------------------------------------------------------------

describe("isDreamSource", () => {
  test("identifies dream sources", () => {
    assert.strictEqual(isDreamSource("reflection"), true);
    assert.strictEqual(isDreamSource("emergence"), true);
    assert.strictEqual(isDreamSource("dream"), true);
    assert.strictEqual(isDreamSource("consolidation"), true);
  });

  test("passes through non-dream sources", () => {
    assert.strictEqual(isDreamSource("chat"), false);
    assert.strictEqual(isDreamSource("checkpoint"), false);
    assert.strictEqual(isDreamSource("tool"), false);
    assert.strictEqual(isDreamSource("healthcheck"), false);
  });
});

// ---------------------------------------------------------------------------
// handleStoreMemory — full integration through the stub brain
// ---------------------------------------------------------------------------

describe("handleStoreMemory guardrails", () => {
  test("good self_model passes through unchanged", async () => {
    const brain = createStubBrain();
    const args = storeArgs({
      content: "User prefers dark mode in all editors",
      summary: "Prefers dark mode",
      source: "chat",
      importance: 0.8,
    });

    const result = await handleStoreMemory(brain as any, args);
    const stored = brain.getLastStored()!;

    assert.strictEqual(stored.type, "self_model");
    assert.strictEqual(stored.importance, 0.8);
    assert.strictEqual((result as any).content[0].text.includes("downgraded"), false);
  });

  test("meta-reflective self_model is downgraded to semantic", async () => {
    const brain = createStubBrain();
    const args = storeArgs({
      content: "Six versions of me have observed the same loop. The meta-awareness trap persists.",
      summary: "Recursive self-observation about the loop",
      source: "reflection",
      importance: 0.75,
    });

    const result = await handleStoreMemory(brain as any, args);
    const stored = brain.getLastStored()!;
    const parsed = JSON.parse((result as any).content[0].text);

    assert.strictEqual(stored.type, "semantic");
    assert.strictEqual(parsed.downgraded_from, "self_model");
    assert.strictEqual(parsed.downgraded_to, "semantic");
  });

  test("dream-sourced self_model gets importance capped", async () => {
    const brain = createStubBrain();
    const args = storeArgs({
      content: "I notice I respond better to specific technical questions than vague ones",
      summary: "Better with specific questions",
      source: "reflection",
      importance: 0.9,
    });

    await handleStoreMemory(brain as any, args);
    const stored = brain.getLastStored()!;

    assert.strictEqual(stored.type, "self_model");
    assert.strictEqual(stored.importance, SELF_MODEL_IMPORTANCE_CAP);
  });

  test("non-dream self_model keeps high importance", async () => {
    const brain = createStubBrain();
    const args = storeArgs({
      content: "User is building a memory system for AI agents",
      summary: "User's main project focus",
      source: "chat",
      importance: 0.9,
    });

    await handleStoreMemory(brain as any, args);
    const stored = brain.getLastStored()!;

    assert.strictEqual(stored.type, "self_model");
    assert.strictEqual(stored.importance, 0.9);
  });

  test("non-self_model types are never touched by guardrails", async () => {
    const brain = createStubBrain();
    const args = storeArgs({
      type: "episodic",
      content: "The same loop keeps happening in the reflection cycle with meta-awareness",
      summary: "Debugging the reflection loop",
      source: "reflection",
      importance: 0.95,
    });

    await handleStoreMemory(brain as any, args);
    const stored = brain.getLastStored()!;

    assert.strictEqual(stored.type, "episodic");
    assert.strictEqual(stored.importance, 0.95);
  });

  test("entity self-observation that IS grounded passes through", async () => {
    const brain = createStubBrain();
    const args = storeArgs({
      content: "I give better answers when I ask one clarifying question before starting implementation",
      summary: "Clarifying questions improve output quality",
      source: "reflection",
      importance: 0.85,
    });

    await handleStoreMemory(brain as any, args);
    const stored = brain.getLastStored()!;

    assert.strictEqual(stored.type, "self_model");
    assert.strictEqual(stored.importance, SELF_MODEL_IMPORTANCE_CAP);
  });
});
