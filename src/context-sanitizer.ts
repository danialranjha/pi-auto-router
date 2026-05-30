import type { Context } from "@mariozechner/pi-ai";

function randomCallId(): string {
  return `call_${Math.random().toString(36).substring(2, 11)}`;
}

function stripOpenAICodexReplayMetadata(message: any): any {
  const next = { ...message };
  delete next.id;
  delete next.responseId;
  delete next.response_id;
  delete next.providerResponseId;
  delete next.providerMessageId;
  return next;
}

export function sanitizeContext(context: Context, provider?: string): Context {
  const messages = (context as any)?.messages;
  if (!Array.isArray(messages)) return context;

  const shouldStripReplayIds = provider === "openai-codex";

  const newMessages = messages.map((msg: any) => {
    if (!msg) return msg;
    const newMsg = shouldStripReplayIds ? stripOpenAICodexReplayMetadata(msg) : { ...msg };

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      newMsg.tool_calls = msg.tool_calls.map((tc: any) => {
        const newTc = { ...tc };
        if (newTc.id === undefined || newTc.id === null || String(newTc.id).trim() === "") {
          newTc.id = randomCallId();
        }
        return newTc;
      });
    }

    if (msg.role === "tool" || msg.role === "toolResult") {
      const toolCallId = msg.tool_call_id || msg.toolCallId;
      if (toolCallId === undefined || toolCallId === null || String(toolCallId).trim() === "") {
        const generatedId = randomCallId();
        if (msg.role === "tool") newMsg.tool_call_id = generatedId;
        else newMsg.toolCallId = generatedId;
      }

      const toolName = msg.name || msg.toolName;
      if (toolName === undefined || toolName === null || String(toolName).trim() === "") {
        if (msg.role === "tool") newMsg.name = "unknown_tool";
        else newMsg.toolName = "unknown_tool";
      }
    }

    return newMsg;
  });

  return { ...context, messages: newMessages } as Context;
}
