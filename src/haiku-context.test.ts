import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Usage, type ModelRequest } from "@openai/agents";
import { BudgetLedger } from "./budget.js";
import { config } from "./config.js";
import { guardedModel } from "./provider.js";
import { modelRoutes } from "./provider-chain.js";
import { estimatedInputTokens } from "./haiku-context.js";
import { providerApiKey } from "./config.js";

function firstAvailableRoute(tier: "cheap" | "standard"): { provider: string; model?: string } {
  const routes = modelRoutes(tier, "auto");
  for (const route of routes) {
    if (route.provider === "ollama") return route;
    if (providerApiKey(route.provider as never)) return route;
  }
  return routes[0]!;
}

let ledger: BudgetLedger;
beforeEach(() => { ledger = new BudgetLedger(":memory:", 15, 20); vi.stubEnv("ANTHROPIC_API_KEY", "test"); vi.stubEnv("GEMINI_API_KEY", "test"); vi.stubEnv("OPENCODE_API_KEY", ""); vi.stubEnv("OPENROUTER_API_KEY", ""); });
afterEach(() => { ledger.close(); vi.unstubAllEnvs(); });
const base: ModelRequest = { input: "Hello", systemInstructions: "Required instructions", modelSettings: {}, tools: [], handoffs: [], outputType: "text", tracing: false };
function fake() {
  return { getResponse: vi.fn(async () => ({ usage: new Usage({ inputTokens: 10, outputTokens: 5 }), output: [] })),
    async *getStreamedResponse() {} };
}
describe("Haiku context guard", () => {
  it("estimates token units using a cautious bytes-per-token ratio and explicit overhead", () => {
    const request = { ...base, input: "const value = 42;\n".repeat(5000) };
    const bytes = Buffer.byteLength(JSON.stringify(request));
    expect(bytes).toBeGreaterThan(80_000);
    expect(estimatedInputTokens(request)).toBe(Math.ceil(bytes / 3) + 4096);
    expect(estimatedInputTokens(request)).toBeLessThan(40_000);
  });
  it("keeps an 80 KB English/code request on Haiku", async () => {
    const input = "const value = 42;\n".repeat(5000);
    const model = fake();
    const factory = vi.fn(async () => model);
    await guardedModel(modelRoutes("cheap", "auto"), ledger, factory).getResponse({ ...base, input });
    expect(factory).toHaveBeenCalledExactlyOnceWith(firstAvailableRoute("cheap"));
    expect(model.getResponse).toHaveBeenCalledWith(expect.objectContaining({ input }));
  });
  it.each([[220_000, "cheap"], [240_000, "standard"]] as const)("routes %i input bytes around the 80K estimated-token threshold", async (bytes, tier) => {
    const factory = vi.fn(async () => fake());
    const request = { ...base, input: "x".repeat(bytes) };
    expect(estimatedInputTokens(request) > 80_000).toBe(tier === "standard");
    await guardedModel(modelRoutes("cheap", "auto"), ledger, factory, vi.fn()).getResponse(request);
    expect(factory).toHaveBeenCalledExactlyOnceWith(firstAvailableRoute(tier));
  });
  it("leaves normal input unchanged and bounds output", async () => {
    const model = fake();
    await guardedModel(modelRoutes("cheap", "auto"), ledger, async () => model).getResponse(base);
    expect(model.getResponse).toHaveBeenCalledWith(expect.objectContaining({ input: "Hello", systemInstructions: base.systemInstructions,
      modelSettings: expect.objectContaining({ maxTokens: 2048 }) }));
  });
  it("trims oldest explicitly expendable history while preserving required context and newer history", async () => {
    const messages = ["old ".repeat(75_000), "recent reply"];
    const render = (history: string[]) => `CEO pack\nPROJECT canonical\nDurable memory\n${history.join("\n")}\nCurrent user request`;
    const prompt = render(messages);
    const model = fake();
    const factory = vi.fn(async () => model);
    await guardedModel(modelRoutes("cheap", "auto"), ledger, factory, vi.fn(), { prompt, messages, render })
      .getResponse({ ...base, input: [{ role: "user", content: prompt }] });
    expect(factory).toHaveBeenCalledExactlyOnceWith(firstAvailableRoute("cheap"));
    expect(model.getResponse).toHaveBeenCalledWith(expect.objectContaining({ input: [{ role: "user", content: render(["recent reply"]) }] }));
    expect(prompt).toContain(messages[0]);
  });
  it("skips oversized protected context without a Haiku reservation and preserves input for fallback", async () => {
    const model = fake();
    const factory = vi.fn(async () => model);
    const warn = vi.fn();
    const prompt = "CEO and project ".repeat(21_000);
    await guardedModel(modelRoutes("cheap", "auto"), ledger, factory, warn).getResponse({ ...base, input: prompt });
    expect(factory).toHaveBeenCalledExactlyOnceWith(firstAvailableRoute("standard"));
    expect(model.getResponse).toHaveBeenCalledWith(expect.objectContaining({ input: prompt }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Haiku skipped: estimated input"));
    expect(ledger.status().models.map((m) => m.provider)).toEqual(["gemini"]);
  });
  it("falls back after trimming when protected context alone is too large", async () => {
    const messages = ["Expendable old reply"];
    const render = (history: string[]) => `${"Project and CEO ".repeat(21_000)}\n${history.join("\n")}\nCurrent request`;
    const prompt = render(messages);
    const model = fake();
    const factory = vi.fn(async () => model);
    await guardedModel(modelRoutes("cheap", "auto"), ledger, factory, vi.fn(), { prompt, messages, render }).getResponse({ ...base, input: prompt });
    expect(factory).toHaveBeenCalledExactlyOnceWith(firstAvailableRoute("standard"));
    expect(model.getResponse).toHaveBeenCalledWith(expect.objectContaining({ input: prompt }));
  });
  it("honors a lower configured threshold", async () => {
    const original = config.haikuInputLimit;
    config.haikuInputLimit = 5000;
    try {
      const factory = vi.fn(async () => fake());
      await guardedModel(modelRoutes("cheap", "auto"), ledger, factory, vi.fn()).getResponse({ ...base, input: "x".repeat(3000) });
      expect(factory).toHaveBeenCalledExactlyOnceWith(firstAvailableRoute("standard"));
    } finally { config.haikuInputLimit = original; }
  });
  it("counts multibyte input and instructions, and limits Haiku effort", async () => {
    expect(estimatedInputTokens({ input: "🦊" })).toBeGreaterThan(estimatedInputTokens({ input: "a" }));
    const model = fake();
    const factory = vi.fn(async () => model);
    await guardedModel(modelRoutes("cheap", "auto"), ledger, factory, vi.fn()).getResponse({ ...base,
      systemInstructions: "x".repeat(config.haikuInputLimit * 3), input: "small" });
    expect(factory).toHaveBeenCalledExactlyOnceWith(firstAvailableRoute("standard"));
    await guardedModel(modelRoutes("cheap", "auto"), ledger, async () => model).getResponse({ ...base, modelSettings: { reasoning: { effort: "high" } } });
    expect(model.getResponse).toHaveBeenLastCalledWith(expect.objectContaining({ modelSettings: expect.objectContaining({ reasoning: { effort: "low" } }) }));
  });
});
