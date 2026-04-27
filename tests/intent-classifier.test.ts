import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, intentToTier } from "../src/intent-classifier.ts";
import type { Message } from "../src/types.ts";

describe("classifyIntent", () => {
  it("classifies code prompts as code", () => {
    const r = classifyIntent("implement a function that sorts an array");
    assert.equal(r.category, "code");
    assert.ok(r.confidence > 0.5);
  });

  it("classifies code blocks as code", () => {
    const r = classifyIntent("fix this bug:\n```\nconst x = 1\n```");
    assert.equal(r.category, "code");
  });

  it("classifies file paths and extensions as code", () => {
    const r = classifyIntent("update src/index.ts to add a new export");
    assert.equal(r.category, "code");
  });

  it("classifies debugging as code", () => {
    const r = classifyIntent("debug why this TypeScript code throws an error");
    assert.equal(r.category, "code");
  });

  it("classifies git operations as code", () => {
    const r = classifyIntent("git commit the changes and push to main");
    assert.equal(r.category, "code");
  });

  it("classifies creative writing as creative", () => {
    const r = classifyIntent("write a poem about the stars");
    assert.equal(r.category, "creative");
  });

  it("classifies storytelling as creative", () => {
    const r = classifyIntent("create a story about a dragon who learns to code");
    assert.equal(r.category, "creative");
  });

  it("classifies marketing copy as creative", () => {
    const r = classifyIntent("write a blog post about our new product launch");
    assert.equal(r.category, "creative");
  });

  it("classifies analysis as analysis", () => {
    const r = classifyIntent("analyze this code and explain what it does");
    assert.equal(r.category, "analysis");
  });

  it("classifies summarization as analysis", () => {
    const r = classifyIntent("summarize this document for me");
    assert.equal(r.category, "analysis");
  });

  it("classifies comparison as analysis", () => {
    const r = classifyIntent("compare React and Vue for this use case");
    assert.equal(r.category, "analysis");
  });

  it("classifies review as analysis", () => {
    const r = classifyIntent("review this PR and suggest improvements");
    assert.equal(r.category, "analysis");
  });

  it("falls back to general for ambiguous prompts", () => {
    const r = classifyIntent("hi");
    assert.equal(r.category, "general");
  });

  it("falls back to general for short meta questions", () => {
    const r = classifyIntent("what can you do?");
    assert.equal(r.category, "general");
  });

  it("uses history for context when prompt is short", () => {
    const history: Message[] = [
      { role: "user", content: "I need to refactor this function to use async/await" },
      { role: "assistant", content: "Sure, what does the function do?" },
    ];
    const r = classifyIntent("it throws a TypeError", history);
    // History provides code context (refactor, function, async/await)
    assert.equal(r.category, "code");
  });

  it("reports reasons in result", () => {
    const r = classifyIntent("implement a sorting function and analyze its performance");
    assert.ok(r.reasons.length > 0);
    assert.ok(r.reasons.some((s) => s.includes("code")));
  });
});

describe("intentToTier", () => {
  it("maps code to swe", () => {
    assert.equal(intentToTier("code"), "swe");
  });

  it("maps creative to economy", () => {
    assert.equal(intentToTier("creative"), "economy");
  });

  it("maps analysis to long", () => {
    assert.equal(intentToTier("analysis"), "long");
  });

  it("returns null for general", () => {
    assert.equal(intentToTier("general"), null);
  });
});
