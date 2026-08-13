import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import { sanitizeContext } from "../src/context-sanitizer.ts";

const SIGNATURE = "YWJjZA==";

function makeContext(): Context {
  return {
    messages: [
      {
        id: "msg_3",
        responseId: "resp_1",
        role: "assistant",
        content: "prior assistant reply",
        tool_calls: [{
          id: "",
          function: { name: "functions.bash", arguments: JSON.stringify({ command: "echo hi" }) },
        }],
      },
      { id: "msg_32", role: "tool", content: "stdout", tool_call_id: "", name: "" },
      { id: "msg_99", role: "user", content: "follow-up prompt" },
    ],
  } as any;
}

function nativeToolTurn(overrides: Record<string, unknown> = {}): any[] {
  return [
    {
      role: "assistant",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      content: [
        { type: "text", text: "Checking." },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" }, thoughtSignature: SIGNATURE },
      ],
      ...overrides,
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      timestamp: 123,
    },
  ];
}

function sanitize(messages: any[], modelId = "gemini-3.1-pro-preview"): any[] {
  return (sanitizeContext({ messages } as any, "google", modelId) as any).messages;
}

describe("sanitizeContext", () => {
  it("strips replay ids for openai-codex while preserving message content", () => {
    const sanitized = sanitizeContext(makeContext(), "openai-codex") as any;

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
    const sanitized = sanitizeContext(makeContext(), "deepseek") as any;

    assert.equal(sanitized.messages[0].id, "msg_3");
    assert.equal(sanitized.messages[0].responseId, "resp_1");
    assert.equal(sanitized.messages[1].id, "msg_32");
    assert.equal(sanitized.messages[2].id, "msg_99");
    assert.match(String(sanitized.messages[0].tool_calls[0].id), /^call_/);
    assert.match(String(sanitized.messages[1].tool_call_id), /^call_/);
    assert.equal(sanitized.messages[1].name, "unknown_tool");
  });

  describe("Gemini 3 model switching", () => {
    it("removes an unsigned cross-model call and its result without turning them into prose", () => {
      const messages = nativeToolTurn({ provider: "openai-codex", model: "gpt-5.4" });
      delete messages[0].content[1].thoughtSignature;

      const result = sanitize(messages);

      assert.deepEqual(result, [{ ...messages[0], content: [{ type: "text", text: "Checking." }] }]);
      assert.equal(JSON.stringify(result).includes("toolCall"), false);
      assert.equal(JSON.stringify(result).includes("file contents"), false);
    });

    it("removes a signature from a different Gemini model because signatures are model-bound", () => {
      const messages = nativeToolTurn({ model: "gemini-3-flash-preview" });
      const result = sanitize(messages);

      assert.equal(result[0].content.some((part: any) => part.type === "toolCall"), false);
      assert.equal(result.some((message: any) => message.role === "toolResult"), false);
    });

    it("does not alter tool history for non-Gemini-3 targets", () => {
      const messages = nativeToolTurn({ provider: "openai-codex", model: "gpt-5.4" });
      const result = (sanitizeContext({ messages } as any, "google", "gemini-2.5-pro") as any).messages;
      assert.equal(result[0].content[1].type, "toolCall");
      assert.equal(result[1].role, "toolResult");
    });

    it("removes a signature captured from a different Google API endpoint", () => {
      const messages = nativeToolTurn({ api: "google-vertex" });
      const result = (sanitizeContext(
        { messages } as any,
        "google",
        "gemini-3.1-pro-preview",
        "google-generative-ai",
      ) as any).messages;

      assert.equal(result[0].content.some((part: any) => part.type === "toolCall"), false);
      assert.equal(result.some((message: any) => message.role === "toolResult"), false);
    });

    it("removes legacy prose downgrade artifacts observed in existing sessions", () => {
      const messages = [
        {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Checking.\n[Historical tool call: read({\"path\":\"a.ts\"})]" }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "[Historical result from read:]" },
            { type: "text", text: "file contents" },
          ],
        },
      ];

      assert.deepEqual(sanitize(messages), [{ ...messages[0], content: [{ type: "text", text: "Checking." }] }]);
    });
  });

  describe("Gemini 3 parallel tools", () => {
    it("preserves the complete ordered parallel turn when only its first call is signed", () => {
      const messages = nativeToolTurn();
      messages[0].content.push({ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "pwd" } });
      messages.push({
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "bash",
        content: [{ type: "text", text: "/workspace" }],
      });

      const result = sanitize(messages);
      assert.deepEqual(result, messages);
      assert.deepEqual(result[0].content.map((part: any) => part.id).filter(Boolean), ["call_1", "call_2"]);
    });

    it("removes the complete parallel call/result group when the first call is unsigned", () => {
      const messages = nativeToolTurn();
      delete messages[0].content[1].thoughtSignature;
      messages[0].content.push({ type: "toolCall", id: "call_2", name: "bash", arguments: {}, thoughtSignature: SIGNATURE });
      messages.push({ role: "toolResult", toolCallId: "call_2", toolName: "bash", content: [] });

      const result = sanitize(messages);
      assert.deepEqual(result[0].content, [{ type: "text", text: "Checking." }]);
      assert.equal(result.some((message: any) => message.role === "toolResult"), false);
    });
  });

  describe("Gemini 3 persisted history", () => {
    it("preserves a valid signature through JSON persistence and replay", () => {
      const restored = JSON.parse(JSON.stringify(nativeToolTurn()));
      const result = sanitize(restored);

      assert.equal(result[0].content[1].thoughtSignature, SIGNATURE);
      assert.equal(result[1].toolCallId, "call_1");
    });

    it("removes the restored call/result pair when persistence omitted the signature", () => {
      const restored = JSON.parse(JSON.stringify(nativeToolTurn()));
      delete restored[0].content[1].thoughtSignature;

      const result = sanitize(restored);
      assert.equal(result[0].content.some((part: any) => part.type === "toolCall"), false);
      assert.equal(result.some((message: any) => message.role === "toolResult"), false);
    });
  });

  describe("Gemini 3 failed tool calls", () => {
    it("preserves a signed call and error result so the model can continue the turn", () => {
      const messages = nativeToolTurn();
      messages[1] = { ...messages[1], isError: true, content: [{ type: "text", text: "ENOENT" }] };

      assert.deepEqual(sanitize(messages), messages);
    });

    it("removes both an unsigned call and its error result", () => {
      const messages = nativeToolTurn();
      delete messages[0].content[1].thoughtSignature;
      messages[1] = { ...messages[1], isError: true, content: [{ type: "text", text: "ENOENT" }] };

      const result = sanitize(messages);
      assert.equal(result[0].content.some((part: any) => part.type === "toolCall"), false);
      assert.equal(result.some((message: any) => message.role === "toolResult"), false);
    });
  });
});
