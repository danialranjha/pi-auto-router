import type { Context } from "@earendil-works/pi-ai";

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

function hasValidThoughtSignature(value: unknown): boolean {
  return typeof value === "string"
    && value.length > 0
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isGemini3Target(provider?: string, modelId?: string): boolean {
  return provider === "google" && /^gemini-3(?:\.|-)/i.test(modelId ?? "");
}

function removeLegacyDowngradedHistory(messages: any[]): any[] {
  const callMarker = "[Historical tool call:";
  const resultMarker = "[Historical result from ";

  return messages.flatMap((message: any) => {
    if (message?.role === "user" && Array.isArray(message.content)) {
      const firstText = message.content[0]?.text;
      if (typeof firstText === "string" && firstText.startsWith(resultMarker) && firstText.endsWith(":]")) {
        return [];
      }
    }

    if (message?.role !== "assistant" || !Array.isArray(message.content)) return [message];
    const content = message.content.flatMap((block: any) => {
      if (block?.type !== "text" || typeof block.text !== "string") return [block];
      const markerIndex = block.text.indexOf(callMarker);
      if (markerIndex < 0) return [block];
      const text = block.text.slice(0, markerIndex).trimEnd();
      return text ? [{ ...block, text }] : [];
    });
    return [{ ...message, content }];
  });
}

/**
 * Gemini 3 signatures are opaque and bound to the exact provider/model response.
 * A parallel function-call turn is valid when its first call carries a valid
 * signature; later calls in that same turn may legitimately be unsigned.
 */
function removeIncompatibleGemini3ToolHistory(
  messages: any[],
  provider?: string,
  modelId?: string,
  api?: string,
): any[] {
  if (!isGemini3Target(provider, modelId)) return messages;

  const removedCallIds = new Set<string>();
  const sanitized = removeLegacyDowngradedHistory(messages).map((message: any) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;

    const toolCalls = message.content.filter((block: any) => block?.type === "toolCall");
    if (toolCalls.length === 0) return message;

    const isSameEndpointAndModel = message.provider === provider
      && message.model === modelId
      && (!api || !message.api || message.api === api);
    const canReplayWholeTurn = isSameEndpointAndModel && hasValidThoughtSignature(toolCalls[0]?.thoughtSignature);
    if (canReplayWholeTurn) return message;

    for (const call of toolCalls) {
      if (typeof call.id === "string") removedCallIds.add(call.id);
    }
    return {
      ...message,
      content: message.content.filter((block: any) => block?.type !== "toolCall"),
    };
  });

  return sanitized.filter((message: any) => (
    message?.role !== "toolResult" || !removedCallIds.has(message.toolCallId)
  ));
}

export function sanitizeContext(context: Context, provider?: string, modelId?: string, api?: string): Context {
  const messages = (context as any)?.messages;
  if (!Array.isArray(messages)) return context;

  const shouldStripReplayIds = provider === "openai-codex";
  const sanitizedMessages = messages.map((message: any) => {
    if (!message) return message;
    const next = shouldStripReplayIds ? stripOpenAICodexReplayMetadata(message) : { ...message };

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      next.tool_calls = message.tool_calls.map((toolCall: any) => {
        const nextToolCall = { ...toolCall };
        if (nextToolCall.id === undefined || nextToolCall.id === null || String(nextToolCall.id).trim() === "") {
          nextToolCall.id = randomCallId();
        }
        return nextToolCall;
      });
    }

    if (message.role === "tool" || message.role === "toolResult") {
      const toolCallId = message.tool_call_id || message.toolCallId;
      if (toolCallId === undefined || toolCallId === null || String(toolCallId).trim() === "") {
        const generatedId = randomCallId();
        if (message.role === "tool") next.tool_call_id = generatedId;
        else next.toolCallId = generatedId;
      }

      const toolName = message.name || message.toolName;
      if (toolName === undefined || toolName === null || String(toolName).trim() === "") {
        if (message.role === "tool") next.name = "unknown_tool";
        else next.toolName = "unknown_tool";
      }
    }

    return next;
  });

  return {
    ...context,
    messages: removeIncompatibleGemini3ToolHistory(sanitizedMessages, provider, modelId, api),
  } as Context;
}
