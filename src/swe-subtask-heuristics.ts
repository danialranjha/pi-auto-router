import type { CodeSubtask, RoutingHints } from "./types.ts";
import type { IntentResult } from "./intent-classifier.ts";
import type { ValidationTrace } from "./validation-outcome-detector.ts";

export type SweSubtaskHeuristic = {
  type: CodeSubtask;
  confidence: number;
  reasons: string[];
  hints: RoutingHints;
};

export function buildSweSubtaskHeuristic(intent: IntentResult | null | undefined, validation?: ValidationTrace): SweSubtaskHeuristic | null {
  if (!intent || intent.category !== "code") return null;

  let type = intent.subtask;
  const reasons = [...(intent.subtaskReasons ?? [])];
  let confidence = intent.subtaskConfidence ?? 0.6;

  if (!type && validation?.testOutcome === "failed") {
    type = "testing";
    confidence = 0.72;
    reasons.push("failed test signal");
  }
  if ((!type || type === "implementation") && validation?.buildOutcome === "failed") {
    type = "debugging";
    confidence = Math.max(confidence, 0.75);
    reasons.push("failed build signal");
  }
  if (!type) return null;

  const preferProviders = getPreferredProviders(type, validation);
  const hints: RoutingHints = { preferProviders };

  if ((type === "debugging" || type === "devops") && (validation?.buildOutcome === "failed" || validation?.testOutcome === "failed")) {
    hints.requireProvider = "claude-agent-sdk";
  }

  return {
    type,
    confidence,
    reasons,
    hints,
  };
}

function getPreferredProviders(type: CodeSubtask, validation?: ValidationTrace): string[] {
  switch (type) {
    case "implementation":
      return ["openai-codex", "claude-agent-sdk", "nvidia"];
    case "debugging":
      return validation?.testOutcome === "failed" || validation?.buildOutcome === "failed"
        ? ["claude-agent-sdk", "openai-codex", "google"]
        : ["claude-agent-sdk", "openai-codex"];
    case "refactor":
      return ["claude-agent-sdk", "openai-codex", "google"];
    case "testing":
      return ["openai-codex", "claude-agent-sdk", "google"];
    case "review":
      return ["claude-agent-sdk", "google", "openai-codex"];
    case "devops":
      return ["claude-agent-sdk", "openai-codex", "google"];
    default:
      return ["claude-agent-sdk", "openai-codex"];
  }
}
