import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferRequirements, solveConstraints, tierToRequirements } from "../src/constraint-solver.ts";
import type { RouteTarget, RoutingContext } from "../src/types.ts";

const targets: RouteTarget[] = [
  { provider: "claude-agent-sdk", modelId: "claude-opus-4-6", label: "Opus" },
  { provider: "openai-codex", modelId: "gpt-5.4", authProvider: "openai-codex", label: "Codex" },
  { provider: "ollama", modelId: "glm-5.1:cloud", label: "GLM" },
];

const baseCtx: RoutingContext = {
  prompt: "hi",
  history: [],
  routeId: "test",
  estimatedTokens: 10,
  classification: "short",
  availableTargets: targets,
};

describe("solveConstraints", () => {
  it("returns all targets when no requirements set", () => {
    const r = solveConstraints(baseCtx);
    assert.equal(r.candidates.length, 3);
    assert.equal(r.rejections.length, 0);
  });

  it("filters by vision capability", () => {
    const caps = (t: RouteTarget) => ({ vision: t.modelId.includes("opus") || t.modelId.includes("gpt") });
    const r = solveConstraints(baseCtx, { requirements: { vision: true }, capabilities: caps });
    assert.equal(r.candidates.length, 2);
    assert.equal(r.rejections.length, 1);
    assert.equal(r.rejections[0].target.label, "GLM");
    assert.equal(r.rejections[0].reason, "lacks vision capability");
  });

  it("filters by reasoning capability", () => {
    const caps = (t: RouteTarget) => ({ reasoning: t.modelId.includes("opus") });
    const r = solveConstraints(baseCtx, { requirements: { reasoning: true }, capabilities: caps });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].label, "Opus");
  });

  it("filters by minContextWindow", () => {
    const caps = (t: RouteTarget) => ({ contextWindow: t.modelId.includes("opus") ? 200_000 : 8_000 });
    const r = solveConstraints(baseCtx, { requirements: { minContextWindow: 100_000 }, capabilities: caps });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].label, "Opus");
    assert.match(r.rejections[0].reason, /context window/);
  });

  it("filters by minMaxTokens", () => {
    const caps = (t: RouteTarget) => ({ maxTokens: t.modelId.includes("opus") ? 128_000 : 4_000 });
    const r = solveConstraints(baseCtx, { requirements: { minMaxTokens: 64_000 }, capabilities: caps });
    assert.equal(r.candidates.length, 1);
    assert.match(r.rejections[0].reason, /max tokens/);
  });

  it("filters out cooled-down targets before capability checks", () => {
    const r = solveConstraints(baseCtx, { isOnCooldown: (t) => t.label === "Codex" });
    assert.equal(r.candidates.length, 2);
    assert.ok(r.rejections.find((rej) => rej.target.label === "Codex" && rej.reason === "on cooldown"));
  });

  it("combines multiple constraints (AND semantics)", () => {
    const caps = (t: RouteTarget) => ({
      vision: t.modelId.includes("opus") || t.modelId.includes("gpt"),
      reasoning: t.modelId.includes("opus") || t.modelId.includes("gpt"),
      contextWindow: t.modelId.includes("opus") ? 200_000 : 100_000,
    });
    const r = solveConstraints(baseCtx, {
      requirements: { vision: true, reasoning: true, minContextWindow: 150_000 },
      capabilities: caps,
    });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].label, "Opus");
  });

  it("treats missing capability data as permissive", () => {
    const caps = () => undefined;
    const r = solveConstraints(baseCtx, { requirements: { vision: true }, capabilities: caps });
    assert.equal(r.candidates.length, 3);
  });

  it("does not reject when only requirement is set but capability is unknown", () => {
    const caps = (_t: RouteTarget) => ({});
    const r = solveConstraints(baseCtx, { requirements: { reasoning: true, minContextWindow: 100 }, capabilities: caps });
    assert.equal(r.candidates.length, 3);
  });
});

describe("inferRequirements", () => {
  it("uses estimatedTokens as minimum context window when larger than base", () => {
    const ctx = { ...baseCtx, estimatedTokens: 50_000 };
    const reqs = inferRequirements(ctx, { minContextWindow: 10_000 });
    assert.equal(reqs.minContextWindow, 50_000);
  });
  it("preserves base requirement when larger than estimatedTokens", () => {
    const ctx = { ...baseCtx, estimatedTokens: 100 };
    const reqs = inferRequirements(ctx, { minContextWindow: 10_000 });
    assert.equal(reqs.minContextWindow, 10_000);
  });
  it("forwards other requirement fields unchanged", () => {
    const reqs = inferRequirements(baseCtx, { vision: true, reasoning: true, minMaxTokens: 4_000 });
    assert.equal(reqs.vision, true);
    assert.equal(reqs.reasoning, true);
    assert.equal(reqs.minMaxTokens, 4_000);
  });
});

describe("tierToRequirements", () => {
  it("returns empty requirements for undefined tier", () => {
    const reqs = tierToRequirements(undefined, 1000);
    assert.equal(Object.keys(reqs).length, 0);
  });

  it("sets vision for vision tier", () => {
    const reqs = tierToRequirements("vision", 1000);
    assert.equal(reqs.vision, true);
    assert.equal(reqs.reasoning, undefined);
  });

  it("sets reasoning for reasoning tier", () => {
    const reqs = tierToRequirements("reasoning", 5000);
    assert.equal(reqs.reasoning, true);
    assert.equal(reqs.vision, undefined);
  });

  it("sets reasoning for swe tier", () => {
    const reqs = tierToRequirements("swe", 5000);
    assert.equal(reqs.reasoning, true);
  });

  it("sets minContextWindow for long tier", () => {
    const reqs = tierToRequirements("long", 50000);
    assert.equal(reqs.minContextWindow, 100_000);
  });

  it("uses estimatedTokens as minContextWindow when larger than 100k", () => {
    const reqs = tierToRequirements("long", 150_000);
    assert.equal(reqs.minContextWindow, 150_000);
  });

  it("returns empty for economy tier (no special requirements)", () => {
    const reqs = tierToRequirements("economy", 1000);
    assert.equal(Object.keys(reqs).length, 0);
  });

  it("returns empty for unknown tier values", () => {
    const reqs = tierToRequirements(undefined as any, 1000);
    assert.equal(Object.keys(reqs).length, 0);
  });
});
