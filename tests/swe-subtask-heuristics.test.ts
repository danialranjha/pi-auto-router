import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSweSubtaskHeuristic } from "../src/swe-subtask-heuristics.ts";
import type { IntentResult } from "../src/intent-classifier.ts";

function codeIntent(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    category: "code",
    confidence: 0.9,
    reasons: ["code=8"],
    ...overrides,
  };
}

describe("buildSweSubtaskHeuristic", () => {
  it("returns implementation preferences for implementation tasks", () => {
    const heuristic = buildSweSubtaskHeuristic(codeIntent({ subtask: "implementation", subtaskConfidence: 0.8, subtaskReasons: ["implement"] }));
    assert.equal(heuristic?.type, "implementation");
    assert.deepEqual(heuristic?.hints.preferProviders, ["openai-codex", "claude-agent-sdk", "nvidia"]);
  });

  it("upgrades ambiguous code tasks with failed build signals to debugging", () => {
    const heuristic = buildSweSubtaskHeuristic(codeIntent(), {
      buildOutcome: "failed",
      signals: [],
    });
    assert.equal(heuristic?.type, "debugging");
    assert.equal(heuristic?.hints.requireProvider, "claude-agent-sdk");
  });

  it("maps failed test context to testing when no explicit subtask exists", () => {
    const heuristic = buildSweSubtaskHeuristic(codeIntent(), {
      testOutcome: "failed",
      signals: [],
    });
    assert.equal(heuristic?.type, "testing");
    assert.deepEqual(heuristic?.hints.preferProviders, ["openai-codex", "claude-agent-sdk", "google"]);
  });

  it("returns null for non-code intents", () => {
    const heuristic = buildSweSubtaskHeuristic({ category: "analysis", confidence: 0.8, reasons: [] });
    assert.equal(heuristic, null);
  });
});
