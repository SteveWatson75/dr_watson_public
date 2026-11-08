import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTrace, setTracingDisabled, Usage, type Model, type ModelRequest } from "@openai/agents";
import { BudgetLedger, estimatedCost, formatBudget } from "./budget.js";
import { guardedModel } from "./provider.js";
import { modelRoutes } from "./provider-chain.js";

setTracingDisabled(true);

const resources: Array<() => void> = [];
afterEach(() => { resources.reverse().forEach((fn) => fn()); resources.length = 0; vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function ledger(soft = 15, hard = 20, now?: () => Date) {
  const dir = mkdtempSync(join(tmpdir(), "watson-budget-"));
  const path = join(dir, "budget.db");
  const db = new BudgetLedger(path, soft, hard, now);
  resources.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
  return { db, path };
}
const request: ModelRequest = { input: "Hello", modelSettings: {}, tools: [], handoffs: [], outputType: "text", tracing: false };
function fakeModel(inputTokens = 100, outputTokens = 50): Model {
  return { getResponse: vi.fn(async () => ({ usage: new Usage({ requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }), output: [] })),
    async *getStreamedResponse() { throw new Error("unused"); } };
}

describe("monthly budget", () => {
  it("calculates subscription routes, paid prices, long Haiku context, and scheduled Gemini pricing", () => {
    expect(estimatedCost("opencode", "deepseek-v4.1-flash", 1_000_000, 1_000_000)).toBe(0);
    expect(estimatedCost("opencode", "mimo-v2.6-pro", 1_000_000, 1_000_000)).toBe(0);
    expect(estimatedCost("opencode", "step-5-preview", 1_000_000, 1_000_000)).toBe(0);
    expect(estimatedCost("opencode", "beam-free", 1_000_000, 1_000_000)).toBe(0);
    expect(estimatedCost("opencode", "crouton-alpha-free", 1_000_000, 1_000_000)).toBe(0);
    expect(estimatedCost("opencode", "iceman-contributor-free", 1_000_000, 1_000_000)).toBe(0);
    expect(estimatedCost("anthropic", "claude-sonnet-5-5", 1_000_000, 1_000_000)).toBe(12);
    expect(estimatedCost("anthropic", "claude-haiku-5-5", 100_000, 1000)).toBeCloseTo(0.0105);
    expect(estimatedCost("anthropic", "claude-haiku-5-5", 100_001, 1000)).toBeCloseTo(0.0525005);
    expect(estimatedCost("gemini", "gemini-3.8-flash", 1_000_000, 1_000_000, new Date("2027-01-02"))).toBe(9);
    expect(estimatedCost("ollama", "any", 1e6, 1e6)).toBe(0);
    expect(estimatedCost("openai", "unknown", 1, 1)).toBeUndefined();
  });
  it("persists spend, warns at soft limit, and resets by UTC month", () => {
    let date = new Date("2026-10-15Z");
    const { db, path } = ledger(15, 20, () => date);
    const id = db.reserve("anthropic", "claude-sonnet-5-5", 16)!;
    db.settle(id, 16, 3_000_000, 1_000_000);
    expect(formatBudget(db.status())).toContain("Warning: monthly soft budget");
    const other = new BudgetLedger(path, 15, 20, () => date);
    resources.push(() => other.close());
    expect(other.status().spent).toBe(16);
    expect(other.status().models[0]?.inputTokens).toBe(3_000_000);
    date = new Date("2026-11-01Z");
    expect(db.status().spent).toBe(0);
  });
  it("atomically reserves budget across two processes/connections", () => {
    const { db, path } = ledger();
    const other = new BudgetLedger(path);
    resources.push(() => other.close());
    expect(db.reserve("gemini", "gemini-3.8-flash", 19)).toBeDefined();
    expect(other.reserve("anthropic", "claude-sonnet-5-5", 2)).toBeUndefined();
    expect(other.status().spent).toBe(19);
  });
  it("blocks paid calls at the hard limit but still allows zero-cost routes", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    vi.stubEnv("OPENCODE_API_KEY", "test");
    const { db } = ledger();
    db.reserve("gemini", "gemini-3.8-flash", 20);
    const factory = vi.fn(async () => fakeModel());
    const freeRoute = { provider: "opencode", model: "deepseek-v4.1-flash" } as const;
    const model = guardedModel([{ provider: "anthropic" }, freeRoute, { provider: "ollama" }], db, factory);
    await model.getResponse(request);
    expect(factory.mock.calls).toEqual([[freeRoute]]);
    expect(db.status().remaining).toBe(0);
  });
  it.each([
    [422, "422 Upstream request failed: Endpoint is unavailable."],
    [400, "400 Upstream request failed: Model is unavailable."],
  ] as const)("falls through to another Go model on upstream availability status %i", async (status, message) => {
    vi.stubEnv("OPENCODE_API_KEY", "test-key");
    const { db } = ledger(0, 0);
    const unavailable = { provider: "opencode" as const, model: "mimo-v2.6-flash" };
    const fallback = { provider: "opencode" as const, model: "deepseek-v4.1-flash" };
    const failing = { ...fakeModel(), getResponse: vi.fn(async () => {
      throw Object.assign(new Error(message), { status });
    }) };
    const factory = vi.fn(async (route) => route.model === unavailable.model ? failing : fakeModel());

    await guardedModel([unavailable, fallback], db, factory, vi.fn()).getResponse(request);

    expect(factory.mock.calls.map(([route]) => route)).toEqual([unavailable, fallback]);
    expect(db.status().spent).toBe(0);
  });
  it("falls back to a free Go model when the paid Go model hits the rolling 429 limit", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "test-key");
    vi.stubEnv("LLM_INPUT_USD_PER_MILLION", "0");
    vi.stubEnv("LLM_OUTPUT_USD_PER_MILLION", "0");
    const { db } = ledger(0, 0);
    const paid = { provider: "opencode" as const, model: `paid-probe-${Date.now()}` };
    const free = { provider: "opencode" as const, model: "beam-free" };
    const failing = { ...fakeModel(), getResponse: vi.fn(async () => {
      throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    }) };
    const factory = vi.fn(async (route) => route.model === paid.model ? failing : fakeModel());
    const warn = vi.fn();

    await guardedModel([paid, free], db, factory, warn).getResponse(request);

    expect(factory.mock.calls.map(([route]) => route)).toEqual([paid, free]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cooling it down for 5 hours"));
    expect(db.status().spent).toBe(0);
  });
  it("does not warn about a zero soft budget while using a zero-cost Go route", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "test-key");
    const { db } = ledger(0, 0);
    const warn = vi.fn();
    await guardedModel([{ provider: "opencode", model: "mimo-v2.6-flash" }], db, async () => fakeModel(), warn)
      .getResponse(request);
    expect(warn).not.toHaveBeenCalledWith("Warning: monthly soft budget limit reached.");
  });
  it("rejects requests whose reservation would exceed remaining budget", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const { db } = ledger(0, 0.00001);
    const factory = vi.fn(async () => fakeModel());
    await guardedModel([{ provider: "anthropic" }, { provider: "ollama" }], db, factory).getResponse(request);
    expect(factory).toHaveBeenCalledExactlyOnceWith({ provider: "ollama" });
  });
  it("records each paid request immediately and checks budget again on the next call", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const { db } = ledger(0.01, 0.02);
    const paid = fakeModel(100_000, 20_000);
    const factory = vi.fn(async (route) => route.provider === "ollama" ? fakeModel() : paid);
    const warn = vi.fn();
    const model = guardedModel([{ provider: "anthropic" }, { provider: "ollama" }], db, factory, warn);
    await model.getResponse(request);
    await model.getResponse(request);
    expect(paid.getResponse).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[1]?.[0]).toEqual({ provider: "ollama" });
    expect(db.status().spent).toBeCloseTo(0.02);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("soft budget limit"));
  });
  it("keeps reservations after timeouts and falls back without untracked retries", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const { db } = ledger();
    const factory = vi.fn(async (route) => {
      if (route.provider === "ollama") return fakeModel();
      return { ...fakeModel(), getResponse: vi.fn(async () => { throw new Error("request timed out"); }) };
    });
    await guardedModel([{ provider: "anthropic" }, { provider: "ollama" }], db, factory, vi.fn()).getResponse(request);
    expect(db.status().spent).toBeGreaterThan(0);
    expect(factory).toHaveBeenCalledTimes(2);
  });
  it("stops clearly when capped and local is unavailable", async () => {
    const { db } = ledger(0, 0);
    const factory = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(guardedModel([{ provider: "ollama" }], db, factory).getResponse(request)).rejects.toThrow("ollama serve");
  });
  it.each(["anthropic", "gemini"] as const)("sends the expected %s adapter request and records returned usage", async (provider) => {
    vi.stubEnv(`${provider.toUpperCase()}_API_KEY`, "test-key");
    const { db } = ledger();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const req = new Request(input, init);
      requests.push({ url: req.url, body: await req.json() });
      return new Response(JSON.stringify({
        id: "test-response", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const model = guardedModel([{ provider }], db);
    const result = await withTrace("adapter test", () => model.getResponse(request));
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(provider === "anthropic"
      ? "https://api.anthropic.com/v1/chat/completions"
      : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(requests[0]?.body.model).toBe(provider === "anthropic" ? "claude-haiku-5-5" : "gemini-3.8-flash");
    expect(requests[0]?.body.max_tokens ?? requests[0]?.body.max_completion_tokens).toBe(2048);
    expect(db.status().models[0]).toMatchObject({ provider, inputTokens: 100, outputTokens: 50 });
    expect(db.status().spent).toBeCloseTo(estimatedCost(provider, String(requests[0]?.body.model), 100, 50)!);
  });
  it.each(["Invalid tool arguments", "Requested tool unavailable"])("stops the automatic chain on a generic HTTP 400: %s", async (message) => {
    vi.stubEnv("OPENCODE_API_KEY", "test-key");
    const { db } = ledger();
    const calls: Array<{ url: string; model: string }> = [];
    const fetch = vi.fn(async (input, init) => {
      const req = new Request(input, init);
      const body = await req.json() as { model: string };
      calls.push({ url: req.url, model: body.model });
      return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }),
        { status: 400, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const model = guardedModel(modelRoutes("cheap", "auto"), db, undefined, vi.fn());
    await expect(withTrace("bad request test", () => model.getResponse(request))).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ url: "https://opencode.ai/inference/go/openai/v1/chat/completions", model: "mimo-v2.6-flash" }]);
    expect(db.status().models.map(({ provider, model }) => ({ provider, model })))
      .toEqual([{ provider: "opencode", model: "mimo-v2.6-flash" }]);
  });
  it("does not retry failed HTTP calls inside the adapter", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const { db } = ledger();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "unavailable", type: "api_error" } }),
      { status: 503, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(withTrace("adapter failure test", () => guardedModel([{ provider: "anthropic" }], db, undefined, vi.fn()).getResponse(request))).rejects.toThrow("No usable local fallback");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.status().spent).toBeGreaterThan(0);
  });
  it("treats blank manual pricing as unknown and retains reservations when usage is missing", async () => {
    vi.stubEnv("LLM_INPUT_USD_PER_MILLION", "");
    vi.stubEnv("LLM_OUTPUT_USD_PER_MILLION", "");
    expect(estimatedCost("openai", "unknown", 1, 1)).toBeUndefined();
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const { db } = ledger();
    await guardedModel([{ provider: "anthropic" }], db, async () => fakeModel(0, 0)).getResponse(request);
    expect(db.status().spent).toBeGreaterThan(0);
  });
});
