import { config, type LlmProvider, type TaskTier } from "./config.js";

export interface ModelRoute { provider: LlmProvider; model?: string }

const OPENROUTER_FREE = { provider: "openrouter", model: "openrouter/free" } satisfies ModelRoute;

// OpenCode Go's free models ("Free" in the model id) have no monthly limit and
// stay available after the paid Go models exhaust their rolling 5-hour/weekly
// limits. They are the zero-cost fallback while the subscription allowance
// recovers, so they sit ahead of the external free/paid routes. Cheap tier
// leads with Crouton; standard/hard tiers lead with Beam; Iceman is the final
// zero-cost fallback.
const GO_FREE_STANDARD = [
  { provider: "opencode", model: "beam-free" },
  { provider: "opencode", model: "crouton-alpha-free" },
  { provider: "opencode", model: "iceman-contributor-free" },
] satisfies ModelRoute[];
const GO_FREE_CHEAP = [
  { provider: "opencode", model: "crouton-alpha-free" },
  { provider: "opencode", model: "beam-free" },
  { provider: "opencode", model: "iceman-contributor-free" },
] satisfies ModelRoute[];

export const TIER_ROUTES: Record<TaskTier, ModelRoute[]> = {
  cheap: [
    { provider: "opencode", model: "mimo-v2.6-flash" },
    { provider: "opencode", model: "glm-5.3-flash" },
    { provider: "opencode", model: "deepseek-v4.1-flash" },
    ...GO_FREE_CHEAP,
    OPENROUTER_FREE,
    { provider: "anthropic", model: "claude-haiku-5-5" },
    { provider: "gemini", model: "gemini-3.8-flash" },
  ],
  standard: [
    { provider: "opencode", model: "deepseek-v4.1-flash" },
    { provider: "opencode", model: "mimo-v2.6-pro" },
    { provider: "opencode", model: "kimi-k2.7-code" },
    ...GO_FREE_STANDARD,
    OPENROUTER_FREE,
    { provider: "gemini", model: "gemini-3.8-flash" },
    { provider: "anthropic", model: "claude-sonnet-5-5" },
  ],
  hard: [
    { provider: "opencode", model: "deepseek-v4-pro" },
    { provider: "opencode", model: "qwen3.8-max" },
    { provider: "opencode", model: "kimi-k2.7-code" },
    ...GO_FREE_STANDARD,
    OPENROUTER_FREE,
    { provider: "gemini", model: "gemini-3.8-flash" },
    { provider: "anthropic", model: "claude-sonnet-5-5" },
  ],
};

const OPEN_CODE_COMPACTION = /(?:consolidated summary|update the existing checkpoint|compaction summary|summarize the conversation into)/i;
const CODE_REVIEW_REQUEST = /\b(?:code review|(?:pull request|pr) review|review(?:ing)? (?:of )?(?:(?:this|the|my|these) )?(?:pull request|pr|code|changes|diff))\b/i;

export function taskTier(message: string): TaskTier {
  // OpenCode's hidden compaction requests are not new user tasks. If they reach
  // the router without a remembered session route, keep them on the coding tier
  // rather than defaulting to the cheap route.
  if (OPEN_CODE_COMPACTION.test(message)) return "standard";
  if (/\b(business strategy|product strategy|strategic priorit\w*|revenue strategy|go.to.market strategy)\b/i.test(message)) return "hard";
  if (CODE_REVIEW_REQUEST.test(message)) return "hard";
  if (/\b(architecture|difficult debugging|complex debugging|race condition|deadlock|high.value (pr|pull request) review|low confidence)\b/i.test(message)) return "hard";
  if (/\b(small (code )?edits?|simple tests?|straightforward|summari[sz]e|summary|classif\w*|draft (an? )?issue)\b/i.test(message)) return "cheap";
  if (/\b(implement\w*|multi.file|repo(sitory)?|debug\w*|refactor\w*|coding)\b/i.test(message) || message.length > 1200) return "standard";
  return "cheap";
}

export function modelRoutes(tier: TaskTier, override: LlmProvider | "auto" = config.provider): ModelRoute[] {
  if (override === "ollama") return [{ provider: "ollama" }];
  if (override !== "auto") {
    const matching = TIER_ROUTES[tier].find((route) => route.provider === override);
    return [matching ? { ...matching } : { provider: override }, { provider: "ollama" }];
  }
  return [...TIER_ROUTES[tier], { provider: "ollama" }];
}
