export const STANDARD_THINKING_LEVEL_MAP = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
} as const;

export function getVirtualThinkingLevelMap(reasoning: boolean): typeof STANDARD_THINKING_LEVEL_MAP | undefined {
  return reasoning ? STANDARD_THINKING_LEVEL_MAP : undefined;
}
