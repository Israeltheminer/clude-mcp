import { test, describe } from "node:test";
import * as assert from "node:assert";
import { buildProtocolText } from "./protocol.js";

describe("buildProtocolText", () => {
  test("interpolates turnThreshold and importanceThreshold correctly", () => {
    const text = buildProtocolText(5, 0.6);

    // Verify turnThreshold
    assert.ok(text.includes("### Every 5 conversation turns"));
    assert.ok(text.includes("Review the last 5 turns and identify memorable moments:"));
    assert.ok(text.includes(`Write a 2–3 sentence summary of the key facts/decisions from these 5 turns`));

    // Verify importanceThreshold
    assert.ok(text.includes("If score >= 0.6: call store_memory with type \"episodic\""));

    // Verify general structure exists
    assert.ok(text.includes("### On session start"));
    assert.ok(text.includes("**Step A — Highlights (episodic)**"));
    assert.ok(text.includes("**Step B — Checkpoint (semantic)**"));
    assert.ok(text.includes("### self_model — store immediately (no turn threshold)"));
  });
});
