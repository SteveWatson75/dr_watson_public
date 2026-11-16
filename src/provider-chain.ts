import { config, type LlmProvider, type TaskTier } from "./config.js";
import { modelCatalogue, type ModelRoute } from "./model-catalogue.js";

export type { ModelRoute } from "./model-catalogue.js";

export const TIER_ROUTES: Record<TaskTier, ModelRoute[]> = modelCatalogue.tierRoutes;

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
  const localFallback = { ...modelCatalogue.localFallback };
  if (override === "ollama") return [localFallback];
  if (override !== "auto") {
    const matching = TIER_ROUTES[tier].find((route) => route.provider === override);
    return [matching ? { ...matching } : { provider: override }, localFallback];
  }
  return [...TIER_ROUTES[tier], localFallback];
}
