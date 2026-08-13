import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isThoughtSignatureCompatibilityError,
  shouldFailOverThoughtSignatureError,
} from "../src/signature-failover.ts";

describe("thought-signature same-request failover", () => {
  it("recognizes Google's missing-signature validation response", () => {
    const error = "400 INVALID_ARGUMENT: Function call is missing a thought_signature in functionCall parts";
    assert.equal(isThoughtSignatureCompatibilityError(error), true);
  });

  it("recognizes corrupted signatures returned through compatibility gateways", () => {
    assert.equal(isThoughtSignatureCompatibilityError("Provider returned error: Corrupted thought signature."), true);
  });

  it("does not classify unrelated bad requests as signature compatibility failures", () => {
    assert.equal(isThoughtSignatureCompatibilityError("400 INVALID_ARGUMENT: malformed tool schema"), false);
  });

  it("fails over before substantive output", () => {
    const error = "Function call is missing a thoughtSignature; it is required";
    assert.equal(shouldFailOverThoughtSignatureError(error, false), true);
  });

  it("does not fail over after substantive output because that could duplicate content or tool effects", () => {
    const error = "Function call is missing a thought_signature";
    assert.equal(shouldFailOverThoughtSignatureError(error, true), false);
  });
});
