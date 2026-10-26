import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOperationalTargetKey, isOperationalFailure } from "../src/operational-health.ts";

describe("operational target identity", () => {
  it("shares identity across routes/labels, isolates models and configured auth identities", () => {
    const t = {provider:"mistral",modelId:"small"};
    assert.equal(getOperationalTargetKey(t), getOperationalTargetKey({...t,authProvider:"mistral"}));
    assert.notEqual(getOperationalTargetKey(t), getOperationalTargetKey({...t,modelId:"medium"}));
    assert.notEqual(getOperationalTargetKey(t), getOperationalTargetKey({...t,authProvider:"other-account"}));
  });
});

describe("operational failure classification", () => {
  it("counts rate, capacity, server, connectivity, quota and balance failures", () => {
    for (const error of ["429 Rate limit exceeded", "rate_limited", "503 overloaded", "502 bad gateway", "500 internal server error", "504 gateway timeout", "ECONNRESET", "network connection timed out", "quota exceeded", "credits exhausted", "insufficient balance", "421 misdirected request"]) {
      assert.equal(isOperationalFailure(error), true, error);
    }
  });
  it("does not count conversation/input, auth, model-resolution or truncation failures", () => {
    for (const error of ["400 invalid_request_error: upstream rejected call_id", "invalid 'input: required_field_missing", "function_response.name missing", "invalid thought_signature: upstream rejected request", "Missing required thought signature", "401 unauthorized upstream", "403 invalid API key", "no valid credentials in auth.json or provider environment variables", "No API key", "invalid google cloud code assist credentials", "404 model not available", "output truncated (stopReason=length)", undefined, "unknown terminal error"]) {
      assert.equal(isOperationalFailure(error), false, String(error));
    }
  });
});
