import type { Message } from "./types.ts";

export type ValidationOutcome = "passed" | "failed";
export type ValidationSignal = {
  kind: "test" | "build";
  toolName: string;
  command: string;
  outcome: ValidationOutcome;
  summary: string;
};

export type ValidationTrace = {
  testOutcome?: ValidationOutcome;
  buildOutcome?: ValidationOutcome;
  signals: ValidationSignal[];
};

type ToolCallInfo = {
  toolName: string;
  command?: string;
};

export function detectValidationTrace(messages: Message[], maxSignals = 6): ValidationTrace {
  const toolCalls = new Map<string, ToolCallInfo>();
  const signals: ValidationSignal[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const anyMsg = msg as any;

    if (msg.role === "assistant" && Array.isArray(anyMsg.tool_calls)) {
      for (const call of anyMsg.tool_calls) {
        const id = normalizeString(call?.id);
        if (!id) continue;
        const toolName = extractToolName(call);
        const command = extractCommand(call);
        toolCalls.set(id, { toolName, command });
      }
      continue;
    }

    if (msg.role !== "tool" && msg.role !== "toolResult") continue;

    const toolCallId = normalizeString(anyMsg.tool_call_id ?? anyMsg.toolCallId);
    const fallbackToolName = normalizeString(anyMsg.name ?? anyMsg.toolName) ?? "unknown_tool";
    const toolCall = toolCallId ? toolCalls.get(toolCallId) : undefined;
    const toolName = toolCall?.toolName ?? fallbackToolName;
    const command = toolCall?.command ?? extractCommand(anyMsg);

    if (!looksLikeBashTool(toolName, command)) continue;
    if (!command) continue;

    const kind = classifyValidationCommand(command);
    if (!kind) continue;

    const outcome = detectToolOutcome(anyMsg.content);
    if (!outcome) continue;

    signals.push({
      kind,
      toolName,
      command: command.trim(),
      outcome,
      summary: `${kind} ${outcome}: ${summarizeCommand(command)}`,
    });
  }

  const recentSignals = signals.slice(-maxSignals);
  const lastTest = [...recentSignals].reverse().find((s) => s.kind === "test");
  const lastBuild = [...recentSignals].reverse().find((s) => s.kind === "build");

  return {
    testOutcome: lastTest?.outcome,
    buildOutcome: lastBuild?.outcome,
    signals: recentSignals,
  };
}

function extractToolName(call: any): string {
  return normalizeString(call?.function?.name)
    ?? normalizeString(call?.name)
    ?? normalizeString(call?.toolName)
    ?? "unknown_tool";
}

function extractCommand(value: any): string | undefined {
  const candidates = [
    value?.function?.arguments,
    value?.arguments,
    value?.input,
    value?.args,
    value?.command,
    value?.content?.command,
  ];

  for (const candidate of candidates) {
    const command = parseCommandCandidate(candidate);
    if (command) return command;
  }

  return undefined;
}

function parseCommandCandidate(candidate: unknown): string | undefined {
  if (!candidate) return undefined;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.command === "string" && parsed.command.trim()) {
          return parsed.command;
        }
      } catch {
        // fall through
      }
    }
    return trimmed;
  }
  if (typeof candidate === "object" && typeof (candidate as any).command === "string") {
    return (candidate as any).command;
  }
  return undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function looksLikeBashTool(toolName: string, command?: string): boolean {
  const name = toolName.toLowerCase();
  return name.includes("bash") || Boolean(command);
}

function classifyValidationCommand(command: string): "test" | "build" | null {
  const text = command.toLowerCase();
  const testPatterns = [
    /(?:^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
    /(?:^|\s)pytest\b/,
    /(?:^|\s)go\s+test\b/,
    /(?:^|\s)cargo\s+test\b/,
    /(?:^|\s)vitest\b/,
    /(?:^|\s)jest\b/,
    /(?:^|\s)mocha\b/,
    /(?:^|\s)ava\b/,
    /(?:^|\s)ctest\b/,
    /(?:^|\s)mvn\s+test\b/,
    /(?:^|\s)(gradle|\.\/gradlew)\s+test\b/,
    /(?:^|\s)phpunit\b/,
    /(?:^|\s)rspec\b/,
    /(?:^|\s)mix\s+test\b/,
    /(?:^|\s)deno\s+test\b/,
  ];
  if (testPatterns.some((pattern) => pattern.test(text))) return "test";

  const buildPatterns = [
    /(?:^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/,
    /(?:^|\s)tsc\b/,
    /(?:^|\s)go\s+build\b/,
    /(?:^|\s)cargo\s+build\b/,
    /(?:^|\s)make\s+build\b/,
    /(?:^|\s)mvn\s+package\b/,
    /(?:^|\s)(gradle|\.\/gradlew)\s+build\b/,
    /(?:^|\s)vite\s+build\b/,
    /(?:^|\s)next\s+build\b/,
    /(?:^|\s)nuxt\s+build\b/,
    /(?:^|\s)webpack\b/,
    /(?:^|\s)rollup\b/,
  ];
  if (buildPatterns.some((pattern) => pattern.test(text))) return "build";

  return null;
}

function detectToolOutcome(content: unknown): ValidationOutcome | undefined {
  const explicit = detectExplicitOutcome(content);
  if (explicit) return explicit;

  const text = serializeContent(content).toLowerCase();

  if (text) {
    if (/(^|\b)(failing|failed|failure|errors? found|build failed|tests? failed|command failed|exited with code\s*[1-9]|exit code\s*[:=]?\s*[1-9])(\b|$)/i.test(text)) {
      return "failed";
    }
    if (/(^|\b)(passing|passed|all tests passed|build succeeded|build successful|compiled successfully|0 failed|0 errors)(\b|$)/i.test(text)) {
      return "passed";
    }
  }

  const stderr = extractFieldText(content, ["stderr", "error", "errors"]);
  if (stderr && stderr.trim()) return "failed";

  if (content && typeof content === "object") {
    const anyContent = content as any;
    const hasStdioFields = typeof anyContent.stdout === "string" || typeof anyContent.stderr === "string" || typeof anyContent.output === "string";
    if (hasStdioFields) {
      const stderr = String(anyContent.stderr ?? anyContent.error ?? "").trim();
      if (!stderr) return "passed";
    }
  }

  return undefined;
}

function detectExplicitOutcome(content: unknown): ValidationOutcome | undefined {
  if (!content || typeof content !== "object") return undefined;
  const anyContent = content as any;

  if (typeof anyContent.success === "boolean") return anyContent.success ? "passed" : "failed";

  const numericCode = [anyContent.exitCode, anyContent.exit_code, anyContent.code]
    .find((value) => typeof value === "number");
  if (typeof numericCode === "number") return numericCode === 0 ? "passed" : "failed";

  const status = normalizeString(anyContent.status)?.toLowerCase();
  if (status === "success" || status === "ok" || status === "passed") return "passed";
  if (status === "error" || status === "failed") return "failed";

  return undefined;
}

function extractFieldText(content: unknown, fieldNames: string[]): string {
  if (!content || typeof content !== "object") return "";
  const anyContent = content as any;
  return fieldNames
    .map((field) => anyContent[field])
    .filter((value) => typeof value === "string")
    .join("\n");
}

function serializeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => serializeContent(item)).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof (content as any).text === "string") return (content as any).text;
    if (typeof (content as any).stdout === "string" || typeof (content as any).stderr === "string") {
      return [String((content as any).stdout ?? ""), String((content as any).stderr ?? "")].filter(Boolean).join("\n");
    }
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

function summarizeCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine;
}
