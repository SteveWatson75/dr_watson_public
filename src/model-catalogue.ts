import { z } from "zod";

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

// The approved catalogue is the only routing authority. Model discovery may
// report new OpenCode models, but nothing here changes until this file is
// edited and validated.
export const modelCatalogueSource = {
  version: MODEL_CATALOGUE_VERSION,
  providers: [
    { id: "opencode", defaultModel: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/inference/go/openai/v1" },
    { id: "anthropic", defaultModel: "claude-haiku-5-5", baseUrl: "https://api.anthropic.com/v1/" },
    { id: "gemini", defaultModel: "gemini-3.8-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/" },
    { id: "ollama", defaultModel: "llama3.2:3b", baseUrl: "http://127.0.0.1:11434/v1" },
    { id: "openrouter", defaultModel: "openrouter/free", baseUrl: "https://openrouter.ai/api/v1" },
    { id: "groq", defaultModel: "openai/gpt-oss-120b", baseUrl: "https://api.groq.com/openai/v1" },
    { id: "openai", defaultModel: "gpt-4.1-mini", baseUrl: "https://api.openai.com/v1" },
  ],
  tierRoutes: {
    // OpenCode Go's free models (ids ending in "-free") have no monthly limit
    // and stay available after the paid Go models exhaust their rolling
    // 5-hour/weekly limits. They remain ahead of external routes: cheap leads
    // with Crouton, stronger tiers lead with Beam, and Iceman is the final
    // zero-cost fallback before OpenRouter.
    cheap: [
      { provider: "opencode", model: "mimo-v2.6-flash" },
      { provider: "opencode", model: "glm-5.3-flash" },
      { provider: "opencode", model: "deepseek-v4.1-flash" },
      { provider: "opencode", model: "crouton-alpha-free" },
      { provider: "opencode", model: "beam-free" },
      { provider: "opencode", model: "iceman-contributor-free" },
      { provider: "openrouter", model: "openrouter/free" },
      { provider: "anthropic", model: "claude-haiku-5-5" },
      { provider: "gemini", model: "gemini-3.8-flash" },
    ],
    standard: [
      { provider: "opencode", model: "deepseek-v4.1-flash" },
      { provider: "opencode", model: "mimo-v2.6-pro" },
      { provider: "opencode", model: "kimi-k2.7-code" },
      { provider: "opencode", model: "beam-free" },
      { provider: "opencode", model: "crouton-alpha-free" },
      { provider: "opencode", model: "iceman-contributor-free" },
      { provider: "openrouter", model: "openrouter/free" },
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ],
    hard: [
      { provider: "opencode", model: "deepseek-v4-pro" },
      { provider: "opencode", model: "qwen3.8-max" },
      { provider: "opencode", model: "kimi-k2.7-code" },
      { provider: "opencode", model: "beam-free" },
      { provider: "opencode", model: "crouton-alpha-free" },
      { provider: "opencode", model: "iceman-contributor-free" },
      { provider: "openrouter", model: "openrouter/free" },
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ],
  },
  localFallback: { provider: "ollama" },
  // USD per million tokens. OpenCode Go is a fixed subscription, so routed Go
  // usage is zero incremental cash cost here; Go's own usage limits are
  // enforced upstream. This table also prices explicit LLM_MODEL overrides.
  pricing: [
    { provider: "opencode", model: "mimo-v2.6-flash", input: 0, output: 0 },
    { provider: "opencode", model: "glm-5.3-flash", input: 0, output: 0 },
    { provider: "opencode", model: "deepseek-v4.1-flash", input: 0, output: 0 },
    { provider: "opencode", model: "mimo-v2.6-pro", input: 0, output: 0 },
    { provider: "opencode", model: "kimi-k2.7-code", input: 0, output: 0 },
    { provider: "opencode", model: "deepseek-v4-pro", input: 0, output: 0 },
    { provider: "opencode", model: "step-5-preview", input: 0, output: 0 },
    { provider: "opencode", model: "qwen3.8-max", input: 0, output: 0 },
    { provider: "opencode", model: "beam-free", input: 0, output: 0 },
    { provider: "opencode", model: "crouton-alpha-free", input: 0, output: 0 },
    { provider: "opencode", model: "iceman-contributor-free", input: 0, output: 0 },
    { provider: "anthropic", model: "claude-haiku-5-5", input: 0.1, output: 0.5 },
    { provider: "anthropic", model: "claude-sonnet-5-5", input: 2, output: 10 },
    { provider: "gemini", model: "gemini-3.8-flash", input: 0.75, output: 3.75 },
    { provider: "openrouter", model: "openrouter/free", input: 0, output: 0 },
  ],
  priceRules: {
    longContext: [
      { model: "claude-haiku-5-5", inputAbove: 100_000, input: 0.5, output: 2.5 },
    ],
    scheduled: [
      { model: "gemini-3.8-flash", effectiveFrom: "2027-01-01T00:00:00.000Z", input: 1.5, output: 7.5 },
    ],
  },
} as const;

export const modelCatalogue: ModelCatalogue = modelCatalogueSchema.parse(modelCatalogueSource);

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
