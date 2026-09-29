import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTruncatedStop, truncatedStopMessage } from "../src/terminal-stop.ts";

describe("isTruncatedStop", () => {
  it("treats a length stop as truncated", () => {
    assert.equal(isTruncatedStop("length"), true);
  });

  it("does not treat other stop reasons as truncated", () => {
    for (const reason of ["stop", "error", "end_turn", "max_tokens", "tool_use", undefined, null, ""]) {
      assert.equal(isTruncatedStop(reason), false, `stopReason=${String(reason)} should not be truncated`);
    }
  });
});

describe("truncatedStopMessage", () => {
  it("includes the target label and stop reason", () => {
    assert.equal(
      truncatedStopMessage("L8: GLM-5.2 (Ollama Cloud)"),
      "L8: GLM-5.2 (Ollama Cloud): output truncated (stopReason=length)",
    );
  });

  it("falls back to a generic label when none is provided", () => {
    assert.equal(truncatedStopMessage(), "Target: output truncated (stopReason=length)");
  });
});
