import { describe, expect, it } from "vitest";
import { candidateCatalogue } from "../providers/model-policy.js";
import { modelRoutes, taskTier } from "./provider-chain.js";

describe("task routing", () => {
  it.each([
    ["", "cheap"],
    ["ordinary question", "cheap"],
    ["x".repeat(1200), "cheap"],
    ["x".repeat(1201), "standard"],
    ["Summarize this implementation across the repo", "cheap"],
    ["Make a small edit to review this code", "hard"],
    ["Consolidated summary of the architecture review", "standard"],
    ["IMPLEMENT the feature", "standard"],
  ] as const)("preserves default, boundary and precedence behavior (%s)", (message, tier) => {
    expect(taskTier(message)).toBe(tier);
  });

  it.each([
    ["Summarize these notes", "cheap", "opencode", "mimo-v2.6-flash"],
    ["Make a small code edit", "cheap", "opencode", "mimo-v2.6-flash"],
    ["Implement issue #19 across the repo", "standard", "opencode", "mimo-v2.6-pro"],
    ["Debug this implementation", "standard", "opencode", "mimo-v2.6-pro"],
    ["Investigate this difficult debugging race condition", "hard", "opencode", "qwen4-max"],
    ["Review the architecture", "hard", "opencode", "qwen4-max"],
    ["Review this pull request in a fresh context", "hard", "opencode", "qwen4-max"],
    ["Review these changes for security issues", "hard", "opencode", "qwen4-max"],
  ] as const)("routes %s", (message, tier, provider, model) => {
    expect(taskTier(message)).toBe(tier);
    expect(modelRoutes(tier, "auto")[0]).toEqual({ provider, model });
  });

  it("keeps OpenCode compaction on the coding tier", () => {
    expect(taskTier("Update the existing checkpoint with the current work state.")).toBe("standard");
    expect(taskTier("Compaction summary: consolidate the conversation into the required template.")).toBe("standard");
  });

  it("keeps the evaluated cheap route order", () => {
    expect(modelRoutes("cheap", "auto")).toEqual([
      { provider: "opencode", model: "mimo-v2.6-flash" },
      { provider: "opencode", model: "glm-5.3-flash" },
      { provider: "opencode", model: "deepseek-v4.1-flash" },
      { provider: "opencode", model: "beam-free" },
      { provider: "openrouter", model: "openrouter/free" },
      { provider: "anthropic", model: "claude-haiku-5-5" },
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "ollama" },
    ]);
  });

  it("promotes MiMo V2.6 Pro ahead of DeepSeek Flash on the standard route", () => {
    expect(modelRoutes("standard", "auto")).toEqual([
      { provider: "opencode", model: "mimo-v2.6-pro" },
      { provider: "opencode", model: "deepseek-v4.1-flash" },
      { provider: "opencode", model: "kimi-k2.7-code" },
      { provider: "opencode", model: "beam-free" },
      { provider: "openrouter", model: "openrouter/free" },
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      { provider: "ollama" },
    ]);
  });

  it("leads the hard route with the evaluated Qwen4 Max, Kimi K3.1 Pro and MiMo pair", () => {
    expect(modelRoutes("hard", "auto")).toEqual([
      { provider: "opencode", model: "qwen4-max" },
      { provider: "opencode", model: "kimi-k3.1-pro" },
      { provider: "opencode", model: "mimo-v2.6-pro" },
      { provider: "opencode", model: "deepseek-v4-pro" },
      { provider: "opencode", model: "qwen3.8-max" },
      { provider: "opencode", model: "kimi-k2.7-code" },
      { provider: "opencode", model: "beam-free" },
      { provider: "openrouter", model: "openrouter/free" },
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      { provider: "ollama" },
    ]);
  });

  it("keeps provider/model pairs unique within each tier and Ollama last", () => {
    for (const tier of ["cheap", "standard", "hard"] as const) {
      const routes = modelRoutes(tier, "auto");
      const keys = routes.map((route) => `${route.provider}:${route.model ?? ""}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(routes.at(-1)).toEqual({ provider: "ollama" });
    }
  });

  it("derives routes only from the approved catalogue, never from evaluation scores", () => {
    const before = (["cheap", "standard", "hard"] as const).map((tier) => modelRoutes(tier, "auto"));
    const candidate = candidateCatalogue.candidates.find((entry) => entry.id === "qwen4-max")!;
    const original = { ...candidate };
    try {
      // Even a dramatic change to reviewed evaluation metadata (prices,
      // allowances, ranking) must not move a production route.
      candidate.input = 99;
      candidate.output = 99;
      candidateCatalogue.candidates.reverse();
      for (const [index, tier] of (["cheap", "standard", "hard"] as const).entries()) {
        expect(modelRoutes(tier, "auto")).toEqual(before[index]);
      }
    } finally {
      Object.assign(candidate, original);
      candidateCatalogue.candidates.reverse();
    }
  });

  it("falls back to the free Go models before leaving the provider", () => {
    for (const tier of ["cheap", "standard", "hard"] as const) {
      const routes = modelRoutes(tier, "auto");
      const models = routes.map((route) => route.model ?? route.provider);
      // The free Go routes appear after the paid Go routes and before any
      // non-Go provider, so a capped account keeps working inside the plan.
      expect(models).toContain("beam-free");
      expect(models).not.toContain("crouton-alpha-free");
      expect(models).not.toContain("iceman-contributor-free");
      const firstExternal = routes.findIndex((route) => route.provider !== "opencode");
      expect(firstExternal).toBeGreaterThan(-1);
      const goModels = routes.slice(0, firstExternal).map((route) => route.model);
      expect(goModels.at(-1)).toMatch(/-free$/);
    }
    // The remaining free route is Beam; it is not an accessibility guarantee.
    expect(modelRoutes("cheap", "auto")[3]).toEqual({ provider: "opencode", model: "beam-free" });
    expect(modelRoutes("hard", "auto")[6]).toEqual({ provider: "opencode", model: "beam-free" });
  });

  it("honors provider overrides and keeps local fallback", () => {
    expect(modelRoutes("hard", "anthropic")[0]).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(modelRoutes("hard", "opencode")[0]).toEqual({ provider: "opencode", model: "qwen4-max" });
    expect(modelRoutes("hard", "ollama")).toEqual([{ provider: "ollama" }]);
    expect(modelRoutes("cheap", "openai")).toEqual([{ provider: "openai" }, { provider: "ollama" }]);
  });
});
