import type { CodeSubtask, Message } from "./types.ts";

export type IntentCategory = "code" | "creative" | "analysis" | "general";

export type IntentResult = {
  category: IntentCategory;
  confidence: number; // 0–1
  reasons: string[];
  subtask?: CodeSubtask;
  subtaskConfidence?: number;
  subtaskReasons?: string[];
};

/**
 * Heuristic intent classifier.
 * Scores the prompt + history against keyword/pattern rules for
 * code, creative, and analysis intents. Highest score wins.
 * Falls back to "general" when no strong signal is detected.
 */

// ── Code indicators ──────────────────────────────────────────────
const CODE_KEYWORDS = [
  "function", "class ", "import ", "export ", "const ", "let ", "var ",
  "def ", "return ", "async ", "await ", "interface", "type ", "enum ",
  "struct", "impl ", "fn ", "pub ", "mod ", "package",
  "require(", "from ", "include ", "extends", "implements",
];

const CODE_ACTIONS = [
  "implement", "debug", "refactor", "compile", "deploy", "build",
  "commit", "push", "merge", "rebase", "install", "npm ", "pip ",
  "docker", "kubernetes", "api", "endpoint", "endpoint", "middleware",
  "database", "query", "migration", "schema", "unit test", "integration test",
  "fix this code", "fix the bug", "this error", "stack trace",
  "patch", "hotfix", "dependency", "dependencies",
];

const CODE_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/,                    // code blocks
  /`[^`]+`/,                           // inline code
  /^\s{2,}\S/m,                        // indented code
  /\/\*[\s\S]*?\*\//,                  // block comments
  /\/\/\s.*/,                          // line comments
  /\.ts\b|\.js\b|\.py\b|\.rs\b|\.go\b|\.java\b|\.c\b|\.cpp\b|\.h\b/, // code file extensions
  /src\//,                             // source paths
  /package\.json|Cargo\.toml|go\.mod|Makefile|Dockerfile/, // config files
  /\bgit\s+(clone|add|commit|push|pull|merge|rebase)\b/,
];

// ── Creative indicators ──────────────────────────────────────────
const CREATIVE_KEYWORDS = [
  "write a poem", "create a story", "write a song", "compose",
  "brainstorm", "creative", "storytelling", "narrative",
  "fictional", "character", "plot", "worldbuilding",
  "roleplay", "role-play", "pretend you are",
];

const CREATIVE_ACTIONS = [
  "write a blog", "draft an email", "social media post", "marketing copy",
  "newsletter", "press release", "sales pitch", "pitch deck",
  "design a", "create a logo", "branding", "slogan",
  "tweet", "twitter thread", "linkedin post",
];

const CREATIVE_PATTERNS: RegExp[] = [
  /\bwrite\s+(a|an|the)\s+(poem|story|song|script|novel|letter|essay)\b/i,
  /\b(create|make|design)\s+(a|an)\s+(story|character|logo|poster|flyer)\b/i,
  /\b(imagine|pretend|role.?play)\b/i,
  /write\s+(like|in\s+the\s+style\s+of)\b/i,
];

// ── Analysis indicators ──────────────────────────────────────────
const ANALYSIS_KEYWORDS = [
  "analyze", "analysis", "summarize", "summary", "explain",
  "compare", "contrast", "evaluate", "assess", "review",
  "critique", "examine", "investigate", "audit",
  "what does this", "how does this", "why is",
];

const ANALYSIS_ACTIONS = [
  "review this code", "review this PR", "code review",
  "explain this", "what does this do", "how does this work",
  "summarize this", "summarize the", "give me a summary",
  "find the issue", "identify the problem", "root cause",
  "performance analysis", "benchmark", "profile",
];

const ANALYSIS_PATTERNS: RegExp[] = [
  /\b(review|summarize|analyze|explain)\s+(this|the|these|my)\b/i,
  /\b(what|how|why)\s+(does|is|are|do|should|would|can|could)\b/i,
  /\b(compare|contrast|diff)\s+(the|these|between)\b/i,
  /^(can|could|would)\s+you\s+(review|analyze|explain|summarize)/im,
  /\.md\b|\.rst\b|\.txt\b|\.adoc\b/,      // documentation file extensions
  /\bREADME\b|CHANGELOG|CONTRIBUTING|LICENSE\b/,
];

/**
 * Classify user intent from prompt text and optional history.
 */
const SUBTASK_SIGNALS: Array<{ subtask: CodeSubtask; keywords: string[]; patterns?: RegExp[] }> = [
  {
    subtask: "debugging",
    keywords: ["debug", "bug", "error", "exception", "stack trace", "failing", "broken", "not working", "fix", "root cause"],
  },
  {
    subtask: "refactor",
    keywords: ["refactor", "clean up", "cleanup", "restructure", "rename", "extract", "simplify", "modernize", "migrate"],
  },
  {
    subtask: "testing",
    keywords: ["unit test", "integration test", "test case", "spec", "coverage", "assert", "mock", "fixture", "flaky test"],
  },
  {
    subtask: "review",
    keywords: ["code review", "review this pr", "review this code", "audit this code", "inspect this patch", "suggest improvements"],
  },
  {
    subtask: "devops",
    keywords: ["deploy", "docker", "kubernetes", "k8s", "terraform", "helm", "github actions", "ci/cd", "pipeline", "infra", "infrastructure"],
  },
  {
    subtask: "implementation",
    keywords: ["implement", "build", "create", "add", "write", "generate", "scaffold", "feature", "endpoint", "handler"],
  },
];

export function classifyIntent(prompt: string, history?: Message[]): IntentResult {
  const text = buildClassificationText(prompt, history);
  
  const codeScore = scoreCategory(text, CODE_KEYWORDS, CODE_ACTIONS, CODE_PATTERNS, 3, 2);
  const creativeScore = scoreCategory(text, CREATIVE_KEYWORDS, CREATIVE_ACTIONS, CREATIVE_PATTERNS, 2, 1.5);
  const analysisScore = scoreCategory(text, ANALYSIS_KEYWORDS, ANALYSIS_ACTIONS, ANALYSIS_PATTERNS, 2, 1.5);

  // Conversation depth boost: long conversations suggest code/analysis intent
  const historyLength = history?.length ?? 0;
  let codeScoreFinal = codeScore;
  let analysisScoreFinal = analysisScore;
  if (historyLength >= 5) {
    // Deep conversation — likely debugging or analysis
    codeScoreFinal += 2;
    analysisScoreFinal += 2;
  } else if (historyLength >= 3) {
    codeScoreFinal += 1;
    analysisScoreFinal += 1;
  }

  const reasons: string[] = [];
  if (codeScoreFinal > 0) reasons.push(`code=${codeScoreFinal.toFixed(1)}`);
  if (creativeScore > 0) reasons.push(`creative=${creativeScore.toFixed(1)}`);
  if (analysisScoreFinal > 0) reasons.push(`analysis=${analysisScoreFinal.toFixed(1)}`);
  if (historyLength >= 3 && (codeScoreFinal > 0 || analysisScoreFinal > 0)) {
    reasons.push(`depth=${historyLength} msgs`);
  }

  // Determine category: highest score wins, with minimum threshold
  const MIN_SCORE = 2; // need at least 2 points for a non-general classification
  const scores: [IntentCategory, number][] = [
    ["code", codeScoreFinal],
    ["creative", creativeScore],
    ["analysis", analysisScoreFinal],
  ];
  scores.sort((a, b) => b[1] - a[1]);

  if (scores[0][1] >= MIN_SCORE) {
    const total = scores.reduce((sum, [, s]) => sum + s, 0);
    const confidence = Math.min(1, total > 0 ? scores[0][1] / (total * 0.7) : 0);
    const result: IntentResult = { category: scores[0][0], confidence, reasons };
    if (result.category === "code") {
      const subtask = classifyCodeSubtask(text);
      if (subtask) {
        result.subtask = subtask.subtask;
        result.subtaskConfidence = subtask.confidence;
        result.subtaskReasons = subtask.reasons;
      }
    }
    return result;
  }

  return { category: "general", confidence: 0.3, reasons: ["no strong signal"] };
}

export function classifyCodeSubtask(text: string): { subtask: CodeSubtask; confidence: number; reasons: string[] } | null {
  const lower = text.toLowerCase();
  const scored = SUBTASK_SIGNALS
    .map(({ subtask, keywords, patterns }) => {
      let score = 0;
      const reasons: string[] = [];
      for (const keyword of keywords) {
        if (lower.includes(keyword)) {
          score += 1;
          reasons.push(keyword);
        }
      }
      for (const pattern of patterns ?? []) {
        if (pattern.test(text)) {
          score += 1;
          reasons.push(String(pattern));
        }
      }
      return { subtask, score, reasons };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  const top = scored[0]!;
  const total = scored.reduce((sum, entry) => sum + entry.score, 0);
  return {
    subtask: top.subtask,
    confidence: Math.min(1, top.score / Math.max(1, total * 0.7)),
    reasons: top.reasons,
  };
}

function buildClassificationText(prompt: string, history?: Message[]): string {
  // Use prompt + last 2 messages from history for context
  const parts = [prompt];
  if (history && history.length > 0) {
    const recent = history.slice(-2);
    for (const msg of recent) {
      const content = extractTextContent(msg);
      if (content) parts.push(content);
    }
  }
  return parts.join("\n");
}

function extractTextContent(msg: Message): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in (part as Record<string, unknown>)) {
          return String((part as Record<string, unknown>).text);
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function scoreCategory(
  text: string,
  keywords: string[],
  actions: string[],
  patterns: RegExp[],
  keywordWeight: number,
  patternWeight: number,
): number {
  let score = 0;
  const lower = text.toLowerCase();

  for (const kw of keywords) {
    if (lower.includes(kw)) score += keywordWeight;
  }
  for (const action of actions) {
    if (lower.includes(action)) score += keywordWeight * 1.2; // actions slightly stronger
  }
  for (const pat of patterns) {
    if (pat.test(text)) score += patternWeight;
  }

  return score;
}

/**
 * Map an intent category to a tier hint for routing.
 */
export function intentToTier(category: IntentCategory): string | null {
  switch (category) {
    case "code": return "swe";
    case "creative": return "economy";
    case "analysis": return "long";
    default: return null;
  }
}
