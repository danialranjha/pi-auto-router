import type { Message } from "./types.ts";

export type IntentCategory = "code" | "creative" | "analysis" | "general";

export type IntentResult = {
  category: IntentCategory;
  confidence: number; // 0–1
  reasons: string[];
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
    return { category: scores[0][0], confidence, reasons };
  }

  return { category: "general", confidence: 0.3, reasons: ["no strong signal"] };
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
