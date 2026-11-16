import { afterEach, describe, expect, it, vi } from "vitest";
import { estimatedCost, MODEL_PRICING } from "./budget.js";
import { providerDefaults } from "./config.js";
import {
  approvedOpenCodeModelIds,
  modelCatalogue,
  modelCatalogueSchema,
  MODEL_CATALOGUE_VERSION,
} from "./model-catalogue.js";
import { normalizeGoModels } from "./opencode-models.js";
import { modelRoutes } from "./provider-chain.js";
import modelsJson from "../config/models.json" with { type: "json" };
import legacyJson from "../config/legacy-models.json" with { type: "json" };

afterEach(() => vi.unstubAllEnvs());

describe("approved model catalogue", () => {
  it("validates the active configuration in config/models.json", () => {
    expect(modelCatalogueSchema.safeParse(modelsJson).success).toBe(true);
    expect(modelCatalogue.version).toBe(MODEL_CATALOGUE_VERSION);
    expect(modelCatalogue).toEqual(modelsJson);
  });

  it.each([
    ["a different version", { ...modelsJson, version: MODEL_CATALOGUE_VERSION + 1 }],
    ["a missing provider", { ...modelsJson, providers: modelsJson.providers.filter(({ id }) => id !== "anthropic") }],
    ["an unknown tier provider", {
      ...modelsJson,
      tierRoutes: { ...modelsJson.tierRoutes, cheap: [{ provider: "unknown", model: "x" }] },
    }],
    ["a tier route without a model", {
      ...modelsJson,
      tierRoutes: { ...modelsJson.tierRoutes, cheap: [{ provider: "opencode" }] },
    }],
    ["a non-Ollama local fallback", { ...modelsJson, localFallback: { provider: "openrouter", model: "openrouter/free" } }],
    ["a negative price", {
      ...modelsJson,
      pricing: modelsJson.pricing.map((price, index) => (index === 0 ? { ...price, input: -1 } : price)),
    }],
    ["a duplicate route", {
      ...modelsJson,
      tierRoutes: { ...modelsJson.tierRoutes, cheap: [
        { provider: "opencode", model: "mimo-v2.6-flash" },
        { provider: "opencode", model: "mimo-v2.6-flash" },
      ] },
    }],
    ["an unknown routed model", {
      ...modelsJson,
      tierRoutes: { ...modelsJson.tierRoutes, cheap: [{ provider: "opencode", model: "mimo-v9.9-flash" }] },
    }],
    ["a routed model with no pricing policy", {
      ...modelsJson,
      tierRoutes: { ...modelsJson.tierRoutes, cheap: [{ provider: "anthropic", model: "claude-opus-4" }] },
    }],
  ])("rejects %s", (_label, source) => {
    expect(modelCatalogueSchema.safeParse(source).success).toBe(false);
  });

  it("keeps model discovery from modifying approved routes", () => {
    const before = [...approvedOpenCodeModelIds()].sort();
    normalizeGoModels({
      object: "list",
      data: [{ id: "kimi-k3", object: "model", created: 0, owned_by: "opencode" }],
    });
    expect([...approvedOpenCodeModelIds()].sort()).toEqual(before);
    expect(approvedOpenCodeModelIds().has("kimi-k3")).toBe(false);
    expect(approvedOpenCodeModelIds().has("step-5-preview")).toBe(false);
  });

  it("excludes unavailable Crouton and training-required Iceman from historical routes", () => {
    const legacyOpenCode = new Set(
      Object.values(legacyJson.tierRoutes).flatMap((routes) =>
        routes.flatMap((route) => (route.provider === "opencode" && route.model ? [route.model] : [])),
      ),
    );
    expect([...approvedOpenCodeModelIds()].sort()).toEqual(
      [...legacyOpenCode].filter((id) => !["crouton-alpha-free", "iceman-contributor-free"].includes(id)).sort(),
    );
  });
});

describe("catalogue route equivalence", () => {
  it.each(["cheap", "standard", "hard"] as const)("keeps %s fallback order except mandatory exclusions", (tier) => {
    expect(modelRoutes(tier, "auto")).toEqual(legacyJson.tierRoutes[tier].filter(
      (route) => route.provider !== "opencode" || !["crouton-alpha-free", "iceman-contributor-free"].includes(route.model ?? ""),
    ));
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
  it("keeps provider defaults matching the legacy fixture", () => {
    const legacyDefaults = Object.fromEntries(
      legacyJson.providers.map(({ id, model, baseUrl }) => [id, { model, baseUrl }]),
    );
    expect(providerDefaults).toEqual(legacyDefaults);
  });

  it("keeps the legacy price table", () => {
    expect(Object.keys(MODEL_PRICING).sort()).toEqual(
      legacyJson.pricing.map(({ provider, model }) => `${provider}:${model}`).sort(),
    );
    for (const { provider, model, input, output } of legacyJson.pricing) {
      expect(MODEL_PRICING[`${provider}:${model}`]).toEqual({ input, output });
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

  it("keeps manually supplied pricing working for overrides", () => {
    vi.stubEnv("LLM_INPUT_USD_PER_MILLION", "1.25");
    vi.stubEnv("LLM_OUTPUT_USD_PER_MILLION", "3.5");
    expect(estimatedCost("openai", "gpt-4.1-mini", 1_000_000, 1_000_000)).toBe(4.75);
    expect(modelRoutes("hard", "openai")).toEqual([
      { provider: "openai" },
      { provider: "ollama" },
    ]);
  });
});
