export type RouteKind = "general" | "coding" | "research" | "business";
export type ModelTier = "cheap" | "standard" | "strong";

export interface ShadowRouteDecision {
  route: RouteKind;
  modelTier: ModelTier;
  provider: string;
  model?: string;
  durationMs: number;
}

export interface ShadowRouter {
  decide(message: string): Promise<ShadowRouteDecision | undefined>;
}
