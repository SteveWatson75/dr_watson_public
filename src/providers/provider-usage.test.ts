import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Usage, type Model, type ModelRequest } from "@openai/agents";
import { BudgetLedger } from "../budget.js";
import { guardedModel, type ModelFactory, type ModelUsageRecord } from "./provider.js";

const request: ModelRequest = { input: "Synthetic test", modelSettings: {}, tools: [], handoffs: [], outputType: "text", tracing: false };
let ledger: BudgetLedger;

function fakeModel(inputTokens = 12, outputTokens = 4): Model {
  return {
    getResponse: vi.fn(async () => ({ usage: new Usage({ requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }), output: [] })),
    async *getStreamedResponse() { throw new Error("unused"); },
  };
}

function rejectingModel(status = 503, message = "unavailable"): Model {
  return {
    getResponse: vi.fn(async () => { throw Object.assign(new Error(message), { status }); }),
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("guardedModel usage reporting", () => {
  it("reports the successful route with its resolved model and reported tokens", async () => {
    const reports: ModelUsageRecord[] = [];
    const factory = vi.fn<ModelFactory>(async () => fakeModel(120, 30));
    await guardedModel([{ provider: "opencode", model: "mimo-v2.6-flash" }, { provider: "ollama" }],
      ledger, factory, vi.fn(), undefined, undefined, (record) => reports.push(record)).getResponse(request);
    expect(reports).toEqual([{
      provider: "opencode", model: "mimo-v2.6-flash", outcome: "used",
      durationMs: expect.any(Number), inputTokens: 120, outputTokens: 30,
    }]);
  });

  it("reports a failed attempt when the provider rejects the invocation, then reports the fallback", async () => {
    const reports: ModelUsageRecord[] = [];
    const reserve = vi.spyOn(ledger, "reserve");
    const settle = vi.spyOn(ledger, "settle");
    const factory = vi.fn<ModelFactory>(async (route) =>
      (route.model === "mimo-v2.6-pro" ? rejectingModel() : fakeModel(300, 50)));
    const warn = vi.fn();
    await guardedModel([{ provider: "opencode", model: "mimo-v2.6-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }],
      ledger, factory, warn, undefined, undefined, (record) => reports.push(record)).getResponse(request);
    expect(reports).toEqual([
      { provider: "opencode", model: "mimo-v2.6-pro", outcome: "failed", durationMs: expect.any(Number), inputTokens: 0, outputTokens: 0 },
      { provider: "opencode", model: "mimo-v2.6-flash", outcome: "used", durationMs: expect.any(Number), inputTokens: 300, outputTokens: 50 },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("opencode:mimo-v2.6-pro is unavailable"));
    // Budget invariants are unchanged: every attempted route reserves before the
    // call and only successful reported usage settles the reservation.
    expect(reserve.mock.calls.map(([provider, model]) => `${provider}:${model}`))
      .toEqual(["opencode:mimo-v2.6-pro", "opencode:mimo-v2.6-flash"]);
    expect(settle).toHaveBeenCalledExactlyOnceWith(expect.any(Number), 0, 300, 50);
  });

  it("does not report an attempt when provider initialization fails before the invocation", async () => {
    const reports: ModelUsageRecord[] = [];
    const reserve = vi.spyOn(ledger, "reserve");
    const settle = vi.spyOn(ledger, "settle");
    const factory = vi.fn<ModelFactory>(async (route) => {
      if (route.model === "mimo-v2.6-pro") throw Object.assign(new Error("client construction failed"), { status: 503 });
      return fakeModel(300, 50);
    });
    const warn = vi.fn();
    await guardedModel([{ provider: "opencode", model: "mimo-v2.6-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }],
      ledger, factory, warn, undefined, undefined, (record) => reports.push(record)).getResponse(request);
    // Initialization is not a model invocation: no request is counted, only the
    // successful fallback is recorded, while the fallback warning is preserved.
    expect(reports).toEqual([
      { provider: "opencode", model: "mimo-v2.6-flash", outcome: "used", durationMs: expect.any(Number), inputTokens: 300, outputTokens: 50 },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("opencode:mimo-v2.6-pro is unavailable"));
    expect(reserve.mock.calls.map(([provider, model]) => `${provider}:${model}`))
      .toEqual(["opencode:mimo-v2.6-pro", "opencode:mimo-v2.6-flash"]);
    expect(settle).toHaveBeenCalledExactlyOnceWith(expect.any(Number), 0, 300, 50);
  });

  it("reports no invocations when every route fails during initialization", async () => {
    const reports: ModelUsageRecord[] = [];
    const factory = vi.fn<ModelFactory>(async () => {
      throw Object.assign(new Error("client construction failed"), { status: 503 });
    });
    const warn = vi.fn();
    const model = guardedModel([{ provider: "opencode", model: "mimo-v2.6-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }],
      ledger, factory, warn, undefined, undefined, (record) => reports.push(record));
    await expect(model.getResponse(request)).rejects.toThrow("No usable local fallback is configured.");
    expect(reports).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("opencode:mimo-v2.6-pro is unavailable"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("opencode:mimo-v2.6-flash is unavailable"));
  });

  it("records nothing for a privacy-blocked primary and preserves the privacy warning", async () => {
    vi.setSystemTime(new Date("2026-12-01T00:00:00.000Z"));
    const reports: ModelUsageRecord[] = [];
    const reserve = vi.spyOn(ledger, "reserve");
    const factory = vi.fn<ModelFactory>(async () => fakeModel());
    const warn = vi.fn();
    await guardedModel([{ provider: "opencode", model: "deepseek-v4-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }],
      ledger, factory, warn, undefined, undefined, (record) => reports.push(record)).getResponse(request);
    expect(reports).toEqual([
      { provider: "opencode", model: "mimo-v2.6-flash", outcome: "used", durationMs: expect.any(Number), inputTokens: 12, outputTokens: 4 },
    ]);
    expect(factory).toHaveBeenCalledExactlyOnceWith({ provider: "opencode", model: "mimo-v2.6-flash" });
    expect(reserve.mock.calls.map(([provider, model]) => `${provider}:${model}`)).toEqual(["opencode:mimo-v2.6-flash"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("privacy approval expired after 2026-11-30"));
  });

  it("records nothing for a route skipped for missing credentials and preserves the warning", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const reports: ModelUsageRecord[] = [];
    const factory = vi.fn<ModelFactory>(async () => fakeModel());
    const warn = vi.fn();
    await guardedModel([{ provider: "anthropic" }, { provider: "opencode", model: "mimo-v2.6-flash" }],
      ledger, factory, warn, undefined, undefined, (record) => reports.push(record)).getResponse(request);
    expect(reports).toEqual([
      { provider: "opencode", model: "mimo-v2.6-flash", outcome: "used", durationMs: expect.any(Number), inputTokens: 12, outputTokens: 4 },
    ]);
    expect(factory).toHaveBeenCalledExactlyOnceWith({ provider: "opencode", model: "mimo-v2.6-flash" });
    expect(warn).toHaveBeenCalledWith("anthropic API key is missing.");
  });

  it("reports every attempted invocation when all providers reject", async () => {
    const reports: ModelUsageRecord[] = [];
    const factory = vi.fn<ModelFactory>(async () => rejectingModel());
    const model = guardedModel([{ provider: "opencode", model: "mimo-v2.6-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }],
      ledger, factory, vi.fn(), undefined, undefined, (record) => reports.push(record));
    await expect(model.getResponse(request)).rejects.toThrow("No usable local fallback is configured.");
    expect(reports).toEqual([
      { provider: "opencode", model: "mimo-v2.6-pro", outcome: "failed", durationMs: expect.any(Number), inputTokens: 0, outputTokens: 0 },
      { provider: "opencode", model: "mimo-v2.6-flash", outcome: "failed", durationMs: expect.any(Number), inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("does not classify accounting errors as upstream provider failures", async () => {
    const reports: ModelUsageRecord[] = [];
    vi.spyOn(ledger, "settle").mockImplementation(() => { throw new Error("ledger write failed"); });
    const factory = vi.fn<ModelFactory>(async () => fakeModel());
    const model = guardedModel([{ provider: "opencode", model: "mimo-v2.6-flash" }, { provider: "opencode", model: "mimo-v2.6-pro" }],
      ledger, factory, vi.fn(), undefined, undefined, (record) => reports.push(record));
    await expect(model.getResponse(request)).rejects.toThrow("ledger write failed");
    // The accounting bug propagates as itself: no fallback is attempted and no
    // provider failure is reported.
    expect(factory).toHaveBeenCalledExactlyOnceWith({ provider: "opencode", model: "mimo-v2.6-flash" });
    expect(reports).toEqual([]);
  });

  it("does not classify reporting errors as upstream provider failures", async () => {
    const reports: ModelUsageRecord[] = [];
    const factory = vi.fn<ModelFactory>(async () => fakeModel());
    const model = guardedModel([{ provider: "opencode", model: "mimo-v2.6-flash" }, { provider: "opencode", model: "mimo-v2.6-pro" }],
      ledger, factory, vi.fn(), undefined, undefined, (record) => {
        reports.push(record);
        throw new Error("reporter bug");
      });
    await expect(model.getResponse(request)).rejects.toThrow("reporter bug");
    expect(factory).toHaveBeenCalledExactlyOnceWith({ provider: "opencode", model: "mimo-v2.6-flash" });
    expect(reports.map((record) => record.outcome)).toEqual(["used"]);
  });

  it("reports each invocation separately so tokens stay attributed per call", async () => {
    const reports: ModelUsageRecord[] = [];
    const first = fakeModel(10, 2);
    const second = fakeModel(30, 5);
    let calls = 0;
    const factory = vi.fn<ModelFactory>(async () => ((calls += 1) === 1 ? first : second));
    const model = guardedModel([{ provider: "opencode", model: "mimo-v2.6-flash" }],
      ledger, factory, vi.fn(), undefined, undefined, (record) => reports.push(record));
    await model.getResponse(request);
    await model.getResponse(request);
    expect(reports.map((record) => [record.outcome, record.inputTokens, record.outputTokens]))
      .toEqual([["used", 10, 2], ["used", 30, 5]]);
  });

  it("never carries prompts, credentials or provider errors into usage records", async () => {
    const reports: ModelUsageRecord[] = [];
    const factory = vi.fn<ModelFactory>(async (route) =>
      (route.model === "mimo-v2.6-pro" ? rejectingModel(503, "leaked: test-key in provider error body") : fakeModel()));
    await guardedModel([{ provider: "opencode", model: "mimo-v2.6-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }],
      ledger, factory, vi.fn(), undefined, undefined, (record) => reports.push(record))
      .getResponse({ ...request, input: "TOP-SECRET-PROMPT-CONTENT" });
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain("TOP-SECRET-PROMPT-CONTENT");
    expect(serialized).not.toContain("test-key");
    expect(serialized).not.toContain("provider error body");
    for (const record of reports) {
      expect(Object.keys(record).sort()).toEqual(["durationMs", "inputTokens", "model", "outcome", "outputTokens", "provider"]);
    }
  });
});
