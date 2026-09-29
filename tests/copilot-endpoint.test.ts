import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyCopilotEndpoint, deriveCopilotApiBaseUrlFromToken } from "../src/copilot-endpoint.ts";

describe("copilot endpoint derivation", () => {
  it("derives business endpoint from proxy-ep token claim", () => {
    const token = "tid=abc;exp=123;proxy-ep=proxy.business.githubcopilot.com;chat=1";
    assert.equal(deriveCopilotApiBaseUrlFromToken(token), "https://api.business.githubcopilot.com");
  });

  it("derives individual endpoint from proxy-ep token claim", () => {
    const token = "tid=abc;proxy-ep=proxy.individual.githubcopilot.com;chat=1";
    assert.equal(deriveCopilotApiBaseUrlFromToken(token), "https://api.individual.githubcopilot.com");
  });

  it("returns undefined when proxy-ep claim is absent", () => {
    const token = "tid=abc;exp=123;chat=1";
    assert.equal(deriveCopilotApiBaseUrlFromToken(token), undefined);
  });

  it("applies derived endpoint only to github-copilot models", () => {
    const token = "tid=abc;proxy-ep=proxy.business.githubcopilot.com;chat=1";

    const copilotModel = { provider: "github-copilot", id: "gpt-5.3-codex", baseUrl: "https://api.individual.githubcopilot.com" };
    const updated = applyCopilotEndpoint(copilotModel, token);
    assert.equal(updated.baseUrl, "https://api.business.githubcopilot.com");

    const anthropicModel = { provider: "anthropic", id: "claude-sonnet-5", baseUrl: "https://api.anthropic.com" };
    const untouched = applyCopilotEndpoint(anthropicModel, token);
    assert.equal(untouched.baseUrl, "https://api.anthropic.com");
  });
});
