import { z } from "zod";
import modelCatalogueJson from "../config/models.json" with { type: "json" };

// Bump this version whenever the approved catalogue shape changes. The schema
// rejects a configuration written for a different version, so an older parser
// cannot silently consume a newer catalogue.
export const MODEL_CATALOGUE_VERSION = 1;

export const PROVIDERS = [
  "opencode",
  "anthropic",
  "gemini",
  "ollama",
  "openrouter",
  "groq",
  "openai",
] as const;

const providerIdSchema = z.enum(PROVIDERS);
const taskTierSchema = z.enum(["cheap", "standard", "hard"]);

const modelRouteSchema = z.object({
  provider: providerIdSchema,
  model: z.string().min(1).optional(),
}).strict();

const priceSchema = z.object({
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
}).strict();

const providerSchema = z.object({
  id: providerIdSchema,
  defaultModel: z.string().min(1),
  baseUrl: z.string().url(),
}).strict();

const pricingEntrySchema = z.object({
  provider: providerIdSchema,
  model: z.string().min(1),
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
}).strict();

const longContextPriceRuleSchema = z.object({
  model: z.string().min(1),
  inputAbove: z.number().int().positive(),
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
}).strict();

const scheduledPriceRuleSchema = z.object({
  model: z.string().min(1),
  effectiveFrom: z.string().refine((value) => Number.isFinite(Date.parse(value)), "must be a parseable date"),
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
}).strict();

export const modelCatalogueSchema = z.object({
  version: z.literal(MODEL_CATALOGUE_VERSION),
  providers: z.array(providerSchema).min(1),
  tierRoutes: z.object({
    cheap: z.array(modelRouteSchema).min(1),
    standard: z.array(modelRouteSchema).min(1),
    hard: z.array(modelRouteSchema).min(1),
  }).strict(),
  localFallback: modelRouteSchema,
  pricing: z.array(pricingEntrySchema).min(1),
  priceRules: z.object({
    longContext: z.array(longContextPriceRuleSchema),
    scheduled: z.array(scheduledPriceRuleSchema),
  }).strict(),
}).strict().superRefine((catalogue, ctx) => {
  const configuredProviders = catalogue.providers.map((provider) => provider.id);
  const configured = new Set(configuredProviders);
  if (configured.size !== configuredProviders.length) {
    ctx.addIssue({ code: "custom", path: ["providers"], message: "provider ids must be unique" });
  }
  for (const provider of PROVIDERS) {
    if (!configured.has(provider)) {
      ctx.addIssue({ code: "custom", path: ["providers"], message: `missing provider ${provider}` });
    }
  }

  if (catalogue.localFallback.provider !== "ollama" || catalogue.localFallback.model) {
    ctx.addIssue({ code: "custom", path: ["localFallback"], message: "local fallback must be the Ollama provider without a model" });
  }

  const priceKeys = new Set<string>();
  for (const [index, price] of catalogue.pricing.entries()) {
    const key = `${price.provider}:${price.model}`;
    if (priceKeys.has(key)) {
      ctx.addIssue({ code: "custom", path: ["pricing", index], message: `duplicate price for ${key}` });
    }
    priceKeys.add(key);
  }

  for (const [tier, routes] of Object.entries(catalogue.tierRoutes)) {
    const seen = new Set<string>();
    routes.forEach((route, index) => {
      if (!route.model) {
        ctx.addIssue({ code: "custom", path: ["tierRoutes", tier, index, "model"], message: "tier routes require a model" });
      }
      const key = `${route.provider}:${route.model ?? ""}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["tierRoutes", tier, index], message: `duplicate route ${key}` });
      }
      seen.add(key);
      if (route.provider !== "ollama" && !priceKeys.has(key)) {
        ctx.addIssue({ code: "custom", path: ["tierRoutes", tier, index], message: `routed model ${key} has no approved identity or pricing policy` });
      }
    });
  }

  for (const rule of catalogue.priceRules.longContext) {
    const hasBase = catalogue.pricing.some((price) => price.model === rule.model);
    if (!hasBase) {
      ctx.addIssue({ code: "custom", path: ["priceRules", "longContext", rule.model], message: "long-context rule needs a base price" });
    }
  }
  for (const rule of catalogue.priceRules.scheduled) {
    const hasBase = catalogue.pricing.some((price) => price.model === rule.model);
    if (!hasBase) {
      ctx.addIssue({ code: "custom", path: ["priceRules", "scheduled", rule.model], message: "scheduled rule needs a base price" });
    }
  }
});

export type LlmProvider = z.infer<typeof providerIdSchema>;
export type TaskTier = z.infer<typeof taskTierSchema>;
export type ModelRoute = z.infer<typeof modelRouteSchema>;
export type ModelPrice = z.infer<typeof priceSchema>;
export type ModelCatalogue = z.infer<typeof modelCatalogueSchema>;

// config/models.json is the single source of truth for the active approved
// catalogue. It is parsed and validated at module load; a malformed or
// unapproved configuration fails closed here. Model discovery may report new
// OpenCode models, but nothing routes until this file is edited and validated.
export const modelCatalogue: ModelCatalogue = modelCatalogueSchema.parse(modelCatalogueJson);

export const MODEL_PRICING: Record<string, ModelPrice> = Object.fromEntries(
  modelCatalogue.pricing.map(({ provider, model, input, output }) => [
    `${provider}:${model}`,
    { input, output },
  ]),
);

export const approvedModelRoutes: readonly ModelRoute[] = [
  ...modelCatalogue.tierRoutes.cheap,
  ...modelCatalogue.tierRoutes.standard,
  ...modelCatalogue.tierRoutes.hard,
  modelCatalogue.localFallback,
];

// Discovery is read-only. This helper is the explicit boundary between the
// approved catalogue above and candidate models reported by check-models.
export function approvedOpenCodeModelIds(): Set<string> {
  return new Set(approvedModelRoutes
    .filter((route) => route.provider === "opencode" && route.model)
    .map((route) => route.model as string));
}
