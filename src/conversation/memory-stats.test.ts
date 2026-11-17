import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./memory.js";

let store: MemoryStore;
afterEach(() => store.close());

describe("memory reporting contract", () => {
  it("reports zeros and empty distributions for a fresh store", () => {
    store = new MemoryStore(":memory:");
    expect(store.getStats()).toEqual({
      runs: 0,
      successfulRuns: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      averageDurationMs: 0,
      providerModels: [],
      routes: [],
      tiers: [],
    });
  });

  it("orders equal-count models and route distributions deterministically and rounds latency", () => {
    store = new MemoryStore(":memory:");
    const sessionId = store.createSession();
    for (const model of ["z-model", "a-model"]) {
      const runId = store.addAgentRun({
        sessionId,
        agent: "Dr Watson",
        model: "planned-model",
        durationMs: 11,
        success: false,
        requests: 2,
      });
      store.addModelUsage({
        agentRunId: runId,
        sessionId,
        provider: "test",
        model,
        outcome: "used",
        durationMs: 4,
        inputTokens: 2,
        outputTokens: 1,
      });
      store.addModelUsage({
        agentRunId: runId,
        sessionId,
        provider: "test",
        model,
        outcome: "failed",
        durationMs: 5,
      });
    }
    for (const modelTier of ["standard", "cheap", "cheap"]) {
      store.addRoutingDecision({
        sessionId,
        provider: "test",
        route: "planned",
        modelTier,
        durationMs: 0,
      });
    }
    const stats = store.getStats();
    expect(stats.runs).toBe(2);
    expect(stats.successfulRuns).toBe(0);
    expect(stats.averageDurationMs).toBe(11);
    expect(stats.providerModels).toEqual(
      ["a-model", "z-model"].map((model) => ({
        model: `test:${model}`,
        runs: 2,
        successfulRuns: 1,
        requests: 2,
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        averageDurationMs: 5,
      })),
    );
    expect(stats.routes).toEqual([{ provider: "test", route: "planned", count: 3 }]);
    expect(stats.tiers).toEqual([
      { provider: "test", modelTier: "cheap", count: 2 },
      { provider: "test", modelTier: "standard", count: 1 },
    ]);
  });
});
