import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@mariozechner/pi-ai";
import { sanitizeContext } from "../src/context-sanitizer.ts";

function makeContext(): Context {
  return {
    messages: [
      {
        id: "msg_3",
        responseId: "resp_1",
        role: "assistant",
        content: "prior assistant reply",
        tool_calls: [
          {
            id: "",
            function: { name: "functions.bash", arguments: JSON.stringify({ command: "echo hi" }) },
          },
        ],
      },
      {
        id: "msg_32",
        role: "tool",
        content: "stdout",
        tool_call_id: "",
        name: "",
      },
      {
        id: "msg_99",
        role: "user",
        content: "follow-up prompt",
      },
    ],
  } as any;
}

describe("sanitizeContext", () => {
  it("strips replay ids for openai-codex while preserving message content", () => {
    const context = makeContext();
    const sanitized = sanitizeContext(context, "openai-codex") as any;

    assert.equal(sanitized.messages[0].id, undefined);
    assert.equal(sanitized.messages[0].responseId, undefined);
    assert.equal(sanitized.messages[1].id, undefined);
    assert.equal(sanitized.messages[2].id, undefined);
    assert.equal(sanitized.messages[0].content, "prior assistant reply");
    assert.equal(sanitized.messages[2].content, "follow-up prompt");
    assert.match(String(sanitized.messages[0].tool_calls[0].id), /^call_/);
    assert.match(String(sanitized.messages[1].tool_call_id), /^call_/);
    assert.equal(sanitized.messages[1].name, "unknown_tool");
  });

  it("keeps existing ids for non-openai providers", () => {
    const context = makeContext();
    const sanitized = sanitizeContext(context, "deepseek") as any;

    assert.equal(sanitized.messages[0].id, "msg_3");
    assert.equal(sanitized.messages[0].responseId, "resp_1");
    assert.equal(sanitized.messages[1].id, "msg_32");
    assert.equal(sanitized.messages[2].id, "msg_99");
    assert.match(String(sanitized.messages[0].tool_calls[0].id), /^call_/);
    assert.match(String(sanitized.messages[1].tool_call_id), /^call_/);
    assert.equal(sanitized.messages[1].name, "unknown_tool");
  });
});
