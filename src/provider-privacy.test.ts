import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Usage, type Model, type ModelRequest } from "@openai/agents";
import { BudgetLedger } from "./budget.js";
import { config } from "./config.js";
import { guardedModel, type ModelFactory } from "./provider.js";
import { modelRoutes } from "./provider-chain.js";

const request: ModelRequest = { input: "Synthetic test", modelSettings: {}, tools: [], handoffs: [], outputType: "text", tracing: false };
const originalConfig = { ...config };
let ledger: BudgetLedger;
function fakeModel(): Model {
  return {
    getResponse: vi.fn(async () => ({ usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }), output: [] })),
    async *getStreamedResponse() { throw new Error("unused"); },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-30T23:59:59.999Z"));
  for (const provider of ["OPENCODE", "OPENROUTER", "ANTHROPIC", "GEMINI"]) vi.stubEnv(`${provider}_API_KEY`, "test-key");
  ledger = new BudgetLedger(":memory:");
});
afterEach(() => {
  ledger.close();
  Object.assign(config, originalConfig);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production privacy expiry", () => {
  it.each(["deepseek-v4.1-flash", "deepseek-v4-pro"])("rechecks %s on each call and skips it after UTC expiry", async (id) => {
    const primary = { provider: "opencode", model: id } as const;
    const fallback = { provider: "opencode", model: "mimo-v2.6-pro" } as const;
    const factory = vi.fn<ModelFactory>(async () => fakeModel());
    const reserve = vi.spyOn(ledger, "reserve");
    const warn = vi.fn();
    const model = guardedModel([primary, fallback, { provider: "ollama" }], ledger, factory, warn);
    await model.getResponse(request);
    expect(factory).toHaveBeenCalledExactlyOnceWith(primary);
    vi.setSystemTime(new Date("2026-12-01T00:00:00.000Z"));
    await model.getResponse(request);
    expect(factory.mock.calls.map(([route]) => route)).toEqual([primary, fallback]);
    expect(reserve.mock.calls.map(([provider, model]) => `${provider}:${model}`)).toEqual([`opencode:${id}`, "opencode:mimo-v2.6-pro"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("privacy approval expired after 2026-11-30"));
  });

  it.each(["cheap", "standard", "hard"] as const)("preserves remaining %s fallback order through Ollama", async (tier) => {
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    const routes = modelRoutes(tier, "auto");
    const factory = vi.fn<ModelFactory>(async (route) => {
      if (route.provider !== "ollama") throw Object.assign(new Error("unavailable"), { status: 503 });
      return fakeModel();
    });
    await guardedModel(routes, ledger, factory, vi.fn()).getResponse(request);
    expect(factory.mock.calls.map(([route]) => route)).toEqual(routes.filter(
      (route) => route.provider !== "opencode" || !["deepseek-v4.1-flash", "deepseek-v4-pro"].includes(route.model ?? ""),
    ));
  });

  it("checks resolved default and explicit override models rather than only the route label", async () => {
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    const factory = vi.fn<ModelFactory>(async () => fakeModel());
    await guardedModel([{ provider: "opencode" }, { provider: "ollama" }], ledger, factory, vi.fn()).getResponse(request);
    Object.assign(config, { provider: "opencode", model: "deepseek-v4-pro" });
    await guardedModel([{ provider: "opencode", model: "mimo-v2.6-flash" }, { provider: "ollama" }], ledger, factory, vi.fn()).getResponse(request);
    expect(factory.mock.calls.map(([route]) => route)).toEqual([{ provider: "ollama" }, { provider: "ollama" }]);
  });

  it("does not invoke a model if initialization crosses the approval deadline", async () => {
    const expired = fakeModel();
    const fallback = fakeModel();
    const factory = vi.fn<ModelFactory>(async (route) => {
      if (route.model === "deepseek-v4-pro") {
        vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
        return expired;
      }
      return fallback;
    });
    await guardedModel([{ provider: "opencode", model: "deepseek-v4-pro" }, { provider: "ollama" }], ledger, factory, vi.fn()).getResponse(request);
    expect(expired.getResponse).not.toHaveBeenCalled();
    expect(fallback.getResponse).toHaveBeenCalledOnce();
  });

  it("fails closed without constructing a provider or reserving budget when no allowed route remains", async () => {
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    const factory = vi.fn<ModelFactory>(async () => fakeModel());
    const reserve = vi.spyOn(ledger, "reserve");
    await expect(guardedModel([{ provider: "opencode", model: "deepseek-v4-pro" }], ledger, factory, vi.fn()).getResponse(request))
      .rejects.toThrow("privacy approval expired");
    expect(factory).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
});
