import { afterEach, describe, expect, it, vi } from "vitest";
import { estimatedCost, MODEL_PRICING } from "./budget.js";
import {
  approvedOpenCodeModelIds,
  modelCatalogue,
  modelCatalogueSchema,
  modelCatalogueSource,
  MODEL_CATALOGUE_VERSION,
  type ModelRoute,
} from "./model-catalogue.js";
import { modelRoutes } from "./provider-chain.js";

afterEach(() => vi.unstubAllEnvs());

const LEGACY_ROUTES: Record<"cheap" | "standard" | "hard", ModelRoute[]> = {
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
    { provider: "ollama" },
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
    { provider: "ollama" },
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
    { provider: "ollama" },
  ],
};

const LEGACY_PRICING = [
  { key: "opencode:mimo-v2.6-flash", input: 0, output: 0 },
  { key: "opencode:glm-5.3-flash", input: 0, output: 0 },
  { key: "opencode:deepseek-v4.1-flash", input: 0, output: 0 },
  { key: "opencode:mimo-v2.6-pro", input: 0, output: 0 },
  { key: "opencode:kimi-k2.7-code", input: 0, output: 0 },
  { key: "opencode:deepseek-v4-pro", input: 0, output: 0 },
  { key: "opencode:step-5-preview", input: 0, output: 0 },
  { key: "opencode:qwen3.8-max", input: 0, output: 0 },
  { key: "opencode:beam-free", input: 0, output: 0 },
  { key: "opencode:crouton-alpha-free", input: 0, output: 0 },
  { key: "opencode:iceman-contributor-free", input: 0, output: 0 },
  { key: "anthropic:claude-haiku-5-5", input: 0.1, output: 0.5 },
  { key: "anthropic:claude-sonnet-5-5", input: 2, output: 10 },
  { key: "gemini:gemini-3.8-flash", input: 0.75, output: 3.75 },
  { key: "openrouter:openrouter/free", input: 0, output: 0 },
] as const;

describe("approved model catalogue", () => {
  it("validates the current versioned configuration", () => {
    expect(modelCatalogueSchema.safeParse(modelCatalogueSource).success).toBe(true);
    expect(modelCatalogue.version).toBe(MODEL_CATALOGUE_VERSION);
    expect(modelCatalogue).toEqual(modelCatalogueSource);
  });

  it.each([
    ["a different version", { ...modelCatalogueSource, version: MODEL_CATALOGUE_VERSION + 1 }],
    ["a missing provider", { ...modelCatalogueSource, providers: modelCatalogueSource.providers.filter(({ id }) => id !== "anthropic") }],
    ["an unknown tier provider", {
      ...modelCatalogueSource,
      tierRoutes: { ...modelCatalogueSource.tierRoutes, cheap: [{ provider: "unknown", model: "x" }] },
    }],
    ["a tier route without a model", {
      ...modelCatalogueSource,
      tierRoutes: { ...modelCatalogueSource.tierRoutes, cheap: [{ provider: "opencode" }] },
    }],
    ["a non-Ollama local fallback", { ...modelCatalogueSource, localFallback: { provider: "openrouter", model: "openrouter/free" } }],
    ["a negative price", {
      ...modelCatalogueSource,
      pricing: [{ ...modelCatalogueSource.pricing[0], input: -1 }],
    }],
    ["a duplicate route", {
      ...modelCatalogueSource,
      tierRoutes: { ...modelCatalogueSource.tierRoutes, cheap: [
        { provider: "opencode", model: "mimo-v2.6-flash" },
        { provider: "opencode", model: "mimo-v2.6-flash" },
      ] },
    }],
  ])("rejects %s", (_label, source) => {
    expect(modelCatalogueSchema.safeParse(source).success).toBe(false);
  });

  it("keeps discovery separate from approved models", () => {
    expect([...approvedOpenCodeModelIds()].sort()).toEqual([
      "beam-free",
      "crouton-alpha-free",
      "deepseek-v4-pro",
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "iceman-contributor-free",
      "kimi-k2.7-code",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
      "qwen3.8-max",
    ]);
    expect(approvedOpenCodeModelIds().has("step-5-preview")).toBe(false);
  });
});

describe("catalogue route equivalence", () => {
  it.each(["cheap", "standard", "hard"] as const)("keeps the exact %s fallback order", (tier) => {
    expect(modelRoutes(tier, "auto")).toEqual(LEGACY_ROUTES[tier]);
  });

  it("keeps provider overrides and the local fallback", () => {
    expect(modelRoutes("cheap", "opencode")).toEqual([
      { provider: "opencode", model: "mimo-v2.6-flash" },
      { provider: "ollama" },
    ]);
    expect(modelRoutes("standard", "gemini")).toEqual([
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "ollama" },
    ]);
    expect(modelRoutes("hard", "anthropic")).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      { provider: "ollama" },
    ]);
    expect(modelRoutes("cheap", "openrouter")).toEqual([
      { provider: "openrouter", model: "openrouter/free" },
      { provider: "ollama" },
    ]);
    expect(modelRoutes("hard", "ollama")).toEqual([{ provider: "ollama" }]);
    expect(modelRoutes("cheap", "openai")).toEqual([
      { provider: "openai" },
      { provider: "ollama" },
    ]);
  });
});

describe("catalogue pricing equivalence", () => {
  it("keeps the legacy price table", () => {
    expect(Object.keys(MODEL_PRICING).sort()).toEqual(LEGACY_PRICING.map(({ key }) => key).sort());
    for (const { key, input, output } of LEGACY_PRICING) {
      expect(MODEL_PRICING[key]).toEqual({ input, output });
      const [provider, model] = key.split(":") as [string, string];
      expect(estimatedCost(provider, model, 1000, 1000)).toBeCloseTo((input + output) / 1000);
    }
  });

  it("keeps Haiku long-context and Gemini scheduled prices", () => {
    expect(estimatedCost("anthropic", "claude-haiku-5-5", 100_000, 1000)).toBeCloseTo(0.0105);
    expect(estimatedCost("anthropic", "claude-haiku-5-5", 100_001, 1000)).toBeCloseTo(0.0525005);
    expect(estimatedCost("gemini", "gemini-3.8-flash", 1_000_000, 1_000_000, new Date("2026-12-31T23:59:59.999Z"))).toBe(4.5);
    expect(estimatedCost("gemini", "gemini-3.8-flash", 1_000_000, 1_000_000, new Date("2027-01-01T00:00:00.000Z"))).toBe(9);
  });

  it("keeps Ollama free and rejects unknown prices", () => {
    vi.stubEnv("LLM_INPUT_USD_PER_MILLION", "");
    vi.stubEnv("LLM_OUTPUT_USD_PER_MILLION", "");
    expect(estimatedCost("ollama", "any", 1_000_000, 1_000_000)).toBe(0);
    expect(estimatedCost("openai", "unknown", 1, 1)).toBeUndefined();
  });
});
