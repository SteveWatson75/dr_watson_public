import { describe, expect, it } from "vitest";
import { modelRoutes, taskTier } from "./provider-chain.js";

describe("task routing", () => {
  it.each([
    ["Summarize these notes", "cheap", "opencode", "mimo-v2.6-flash"],
    ["Make a small code edit", "cheap", "opencode", "mimo-v2.6-flash"],
    ["Implement issue #19 across the repo", "standard", "opencode", "deepseek-v4.1-flash"],
    ["Debug this implementation", "standard", "opencode", "deepseek-v4.1-flash"],
    ["Investigate this difficult debugging race condition", "hard", "opencode", "deepseek-v4-pro"],
    ["Review the architecture", "hard", "opencode", "deepseek-v4-pro"],
    ["Review this pull request in a fresh context", "hard", "opencode", "deepseek-v4-pro"],
    ["Review these changes for security issues", "hard", "opencode", "deepseek-v4-pro"],
  ] as const)("routes %s", (message, tier, provider, model) => {
    expect(taskTier(message)).toBe(tier);
    expect(modelRoutes(tier, "auto")[0]).toEqual({ provider, model });
  });

  it("keeps OpenCode compaction on the coding tier", () => {
    expect(taskTier("Update the existing checkpoint with the current work state.")).toBe("standard");
    expect(taskTier("Compaction summary: consolidate the conversation into the required template.")).toBe("standard");
  });

  it("keeps equivalent Go backups before external fallbacks", () => {
    expect(modelRoutes("standard", "auto")).toEqual([
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
    ]);
    expect(modelRoutes("hard", "auto").slice(0, 3)).toEqual([
      { provider: "opencode", model: "deepseek-v4-pro" },
      { provider: "opencode", model: "qwen3.8-max" },
      { provider: "opencode", model: "kimi-k2.7-code" },
    ]);
  });

  it("falls back to the free Go models before leaving the provider", () => {
    for (const tier of ["cheap", "standard", "hard"] as const) {
      const routes = modelRoutes(tier, "auto");
      const models = routes.map((route) => route.model ?? route.provider);
      // The free Go routes appear after the paid Go routes and before any
      // non-Go provider, so a capped account keeps working inside the plan.
      expect(models).toContain("beam-free");
      expect(models).toContain("crouton-alpha-free");
      expect(models).toContain("iceman-contributor-free");
      const firstExternal = routes.findIndex((route) => route.provider !== "opencode");
      expect(firstExternal).toBeGreaterThan(-1);
      const goModels = routes.slice(0, firstExternal).map((route) => route.model);
      expect(goModels.at(-1)).toMatch(/-free$/);
      expect(goModels.at(-2)).toMatch(/-free$/);
    }
    // Cheap tier leads with Crouton, stronger tiers with Beam.
    expect(modelRoutes("cheap", "auto")[3]).toEqual({ provider: "opencode", model: "crouton-alpha-free" });
    expect(modelRoutes("hard", "auto")[3]).toEqual({ provider: "opencode", model: "beam-free" });
  });

  it("honors provider overrides and keeps local fallback", () => {
    expect(modelRoutes("hard", "anthropic")[0]).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(modelRoutes("hard", "opencode")[0]).toEqual({ provider: "opencode", model: "deepseek-v4-pro" });
    expect(modelRoutes("hard", "ollama")).toEqual([{ provider: "ollama" }]);
    expect(modelRoutes("cheap", "openai")).toEqual([{ provider: "openai" }, { provider: "ollama" }]);
  });
});
