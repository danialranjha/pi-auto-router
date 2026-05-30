import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectValidationTrace } from "../src/validation-outcome-detector.ts";
import type { Message } from "../src/types.ts";

function assistantToolCall(id: string, name: string, args: unknown): Message {
  return {
    role: "assistant",
    content: [],
    tool_calls: [
      {
        id,
        function: {
          name,
          arguments: typeof args === "string" ? args : JSON.stringify(args),
        },
      },
    ],
  } as any;
}

function toolResult(id: string, name: string, content: unknown): Message {
  return {
    role: "tool",
    content,
    tool_call_id: id,
    name,
  } as any;
}

describe("detectValidationTrace", () => {
  it("detects passing test command from bash tool result", () => {
    const trace = detectValidationTrace([
      assistantToolCall("call_1", "functions.bash", { command: "npm test" }),
      toolResult("call_1", "functions.bash", { stdout: "399 passing", stderr: "" }),
    ]);

    assert.equal(trace.testOutcome, "passed");
    assert.equal(trace.buildOutcome, undefined);
    assert.equal(trace.signals.length, 1);
    assert.equal(trace.signals[0].kind, "test");
  });

  it("detects failing build command from stderr", () => {
    const trace = detectValidationTrace([
      assistantToolCall("call_2", "functions.bash", { command: "npm run build" }),
      toolResult("call_2", "functions.bash", { stdout: "", stderr: "Build failed with 2 errors" }),
    ]);

    assert.equal(trace.buildOutcome, "failed");
    assert.equal(trace.testOutcome, undefined);
    assert.equal(trace.signals[0].summary, "build failed: npm run build");
  });

  it("uses explicit exit codes when available", () => {
    const trace = detectValidationTrace([
      assistantToolCall("call_3", "functions.bash", { command: "cargo test" }),
      toolResult("call_3", "functions.bash", { exitCode: 1, stdout: "", stderr: "test failed" }),
    ]);

    assert.equal(trace.testOutcome, "failed");
  });

  it("tracks latest outcome per validation kind", () => {
    const trace = detectValidationTrace([
      assistantToolCall("call_1", "functions.bash", { command: "npm test" }),
      toolResult("call_1", "functions.bash", { stdout: "10 passing", stderr: "" }),
      assistantToolCall("call_2", "functions.bash", { command: "npm test" }),
      toolResult("call_2", "functions.bash", { stdout: "", stderr: "1 failing" }),
      assistantToolCall("call_3", "functions.bash", { command: "tsc --noEmit" }),
      toolResult("call_3", "functions.bash", { stdout: "", stderr: "" }),
    ]);

    assert.equal(trace.testOutcome, "failed");
    assert.equal(trace.buildOutcome, "passed");
    assert.equal(trace.signals.length, 3);
  });

  it("ignores non-validation commands", () => {
    const trace = detectValidationTrace([
      assistantToolCall("call_1", "functions.bash", { command: "ls -la" }),
      toolResult("call_1", "functions.bash", { stdout: "file.txt", stderr: "" }),
    ]);

    assert.equal(trace.testOutcome, undefined);
    assert.equal(trace.buildOutcome, undefined);
    assert.equal(trace.signals.length, 0);
  });

  it("supports tool messages without paired assistant tool calls", () => {
    const trace = detectValidationTrace([
      {
        role: "toolResult",
        toolName: "functions.bash",
        content: { command: "pytest", success: true, stdout: "2 passed" },
      } as any,
    ]);

    assert.equal(trace.testOutcome, "passed");
    assert.equal(trace.signals.length, 1);
  });
});
