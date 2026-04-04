import { test, describe } from "node:test";
import * as assert from "node:assert";
import { buildProtocolText } from "./protocol.js";

describe("buildProtocolText", () => {
  test("interpolates turnThreshold and importanceThreshold correctly", () => {
    const text = buildProtocolText(5, 0.6);

    assert.ok(text.includes("### Phase 1"));
    assert.ok(text.includes(`limit 5, min_importance 0.6`));
    assert.ok(text.includes("### Phase 2"));
    assert.ok(text.includes("every 5 turns"));
    assert.ok(text.includes(`Review the last 5 turns`));
    assert.ok(text.includes(`key facts/decisions from these 5 turns`));
    assert.ok(text.includes("### Phase 3"));
    assert.ok(text.includes("### Phase 4"));
  });

  test("Phase 3 defines the self_model vs semantic boundary", () => {
    const text = buildProtocolText(10, 0.6);

    assert.ok(text.includes("change how you BEHAVE"));
    assert.ok(text.includes("Yes → self_model"));
    assert.ok(text.includes("No  → semantic"));
    assert.ok(text.includes("Meta-observations about the reflection"));
  });

  test("Phase 1 excludes self_model from recall", () => {
    const text = buildProtocolText(10, 0.4);

    assert.ok(text.includes("Never include self_model in the recall"));
  });
});
