import type {
  ModelTier,
  RouteKind,
  ShadowRouteDecision,
  ShadowRouter,
} from "./types.js";

const CODING = /\b(code|coding|typescript|javascript|node|react|api|bug|error|test|github|git|docker|sql|database|refactor|implement|function|class|compile|build)\b/i;
const RESEARCH = /\b(research|search|find|compare|investigate|evidence|source|latest|current|market|competitor|data)\b/i;
const BUSINESS = /\b(business|revenue|customer|pricing|sales|marketing|monetiz|profit|startup|product|affiliate|seo|outreach)\b/i;
const STRONG = /\b(architecture|design|strategy|due diligence|debug|diagnose|analyse|analyze|complex|security|migration|trade-?off)\b/i;
const CHEAP = /^(hi|hello|thanks|thank you|ok|okay|yes|no|done|merged|continue|go ahead)[.! ]*$/i;

function routeFor(message: string): RouteKind {
  const scores: Array<[RouteKind, number]> = [
    ["coding", CODING.test(message) ? 1 : 0],
    ["research", RESEARCH.test(message) ? 1 : 0],
    ["business", BUSINESS.test(message) ? 1 : 0],
  ];
  const best = scores.reduce((current, candidate) =>
    candidate[1] > current[1] ? candidate : current,
  );
  return best[1] > 0 ? best[0] : "general";
}

function tierFor(message: string): ModelTier {
  if (CHEAP.test(message.trim())) return "cheap";
  if (STRONG.test(message) || message.length > 1200) return "strong";
  return "standard";
}

export class BaselineShadowRouter implements ShadowRouter {
  async decide(message: string): Promise<ShadowRouteDecision> {
    const startedAt = performance.now();
    return {
      route: routeFor(message),
      modelTier: tierFor(message),
      provider: "baseline",
      model: "rules-v1",
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
}
