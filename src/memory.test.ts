import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./memory.js";

let store: MemoryStore | undefined;

afterEach(() => store?.close());

describe("MemoryStore", () => {
  it("persists messages in conversation order", () => {
    store = new MemoryStore(":memory:");
    const sessionId = store.createSession("owntil");

    store.addMessage(sessionId, "user", "Find the cheapest delivered price.");
    store.addMessage(sessionId, "assistant", "I will compare total delivered cost.");

    expect(store.getRecentMessages(sessionId)).toEqual([
      { role: "user", content: "Find the cheapest delivered price." },
      { role: "assistant", content: "I will compare total delivered cost." },
    ]);
  });

  it("stores and retrieves relevant project memories", () => {
    store = new MemoryStore(":memory:");
    store.addMemory("Rank car parts by total delivered cost.", "car-parts-search");
    store.addMemory("Use workwear as the first commercial vertical.", "signalspanare");
    store.addMemory("Prefer concise practical answers.");

    expect(store.searchMemories("delivered car parts cost", "car-parts-search")).toEqual([
      { id: 1, project: "car-parts-search", content: "Rank car parts by total delivered cost." },
    ]);
    expect(store.searchMemories("workwear vertical", "car-parts-search")).toEqual([]);
    expect(store.searchMemories("concise answers", "car-parts-search")).toEqual([
      { id: 3, project: undefined, content: "Prefer concise practical answers." },
    ]);
  });

  it("records a shadow routing decision", () => {
    store = new MemoryStore(":memory:");
    const sessionId = store.createSession();

    expect(() => store?.addRoutingDecision({
      sessionId,
      provider: "shadow",
      model: "shadow-v1",
      route: "coding",
      modelTier: "cheap",
      durationMs: 20,
    })).not.toThrow();
  });

  it("aggregates agent and routing stats", () => {
    store = new MemoryStore(":memory:");
    const sessionId = store.createSession();

    store.addAgentRun({
      sessionId,
      agent: "Dr Watson",
      durationMs: 100,
      success: true,
      requests: 1,
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    store.addRoutingDecision({
      sessionId,
      provider: "baseline",
      model: "rules-v1",
      route: "coding",
      modelTier: "standard",
      durationMs: 0,
    });

    const stats = store.getStats();
    expect(stats.runs).toBe(1);
    expect(stats.totalTokens).toBe(100);
    expect(stats.providerModels).toEqual([
      {
        model: "unknown",
        runs: 1,
        successfulRuns: 1,
        requests: 1,
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        averageDurationMs: 100,
      },
    ]);
    expect(stats.routes).toEqual([
      { provider: "baseline", route: "coding", count: 1 },
    ]);
  });

  it("records agent run usage", () => {
    store = new MemoryStore(":memory:");
    const sessionId = store.createSession();

    expect(() => store?.addAgentRun({
      sessionId,
      agent: "Dr Watson",
      model: "test-model",
      durationMs: 125,
      success: true,
      requests: 2,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    })).not.toThrow();
  });

  it("limits context to recent messages", () => {
    store = new MemoryStore(":memory:");
    const sessionId = store.createSession();

    store.addMessage(sessionId, "user", "one");
    store.addMessage(sessionId, "assistant", "two");
    store.addMessage(sessionId, "user", "three");

    expect(store.getRecentMessages(sessionId, 2)).toEqual([
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
  });
});
