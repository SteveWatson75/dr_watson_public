import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("records a planned routing decision", () => {
    store = new MemoryStore(":memory:");
    const sessionId = store.createSession();

    expect(() => store?.addRoutingDecision({
      sessionId,
      provider: "opencode",
      model: "mimo-v2.6-flash",
      route: "planned",
      modelTier: "cheap",
      durationMs: 0,
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
      provider: "opencode",
      model: "mimo-v2.6-pro",
      route: "planned",
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
      { provider: "opencode", route: "planned", count: 1 },
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

  it("records per-invocation model usage and attributes tokens to the serving model", () => {
    store = new MemoryStore(":memory:");
    const sessionId = store.createSession();

    const runId = store.addAgentRun({
      sessionId,
      agent: "Dr Watson",
      model: "opencode:mimo-v2.6-pro+opencode:mimo-v2.6-flash",
      durationMs: 300,
      success: true,
      requests: 3,
      inputTokens: 80,
      outputTokens: 15,
      totalTokens: 95,
    });
    expect(runId).toBeGreaterThan(0);
    store.addModelUsage({ agentRunId: runId, sessionId, provider: "opencode", model: "mimo-v2.6-pro", outcome: "used", durationMs: 100, inputTokens: 10, outputTokens: 2 });
    store.addModelUsage({ agentRunId: runId, sessionId, provider: "opencode", model: "mimo-v2.6-pro", outcome: "failed", durationMs: 5 });
    store.addModelUsage({ agentRunId: runId, sessionId, provider: "opencode", model: "mimo-v2.6-flash", outcome: "used", durationMs: 200, inputTokens: 70, outputTokens: 13 });

    const stats = store.getStats();
    expect(stats.providerModels).toEqual([
      {
        model: "opencode:mimo-v2.6-pro",
        runs: 2,
        successfulRuns: 1,
        requests: 2,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        averageDurationMs: 53,
      },
      {
        model: "opencode:mimo-v2.6-flash",
        runs: 1,
        successfulRuns: 1,
        requests: 1,
        inputTokens: 70,
        outputTokens: 13,
        totalTokens: 83,
        averageDurationMs: 200,
      },
    ]);
  });

  it("merges legacy run attribution with recorded invocation rows per model", () => {
    store = new MemoryStore(":memory:");
    const sessionId = store.createSession();

    // Legacy row: recorded before model_usage existed, no invocation rows.
    store.addAgentRun({
      sessionId,
      agent: "Dr Watson",
      model: "opencode:mimo-v2.6-flash",
      durationMs: 100,
      success: true,
      requests: 1,
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    const runId = store.addAgentRun({
      sessionId,
      agent: "Dr Watson",
      model: "opencode:mimo-v2.6-flash",
      durationMs: 150,
      success: true,
      requests: 1,
      inputTokens: 50,
      outputTokens: 15,
      totalTokens: 65,
    });
    store.addModelUsage({ agentRunId: runId, sessionId, provider: "opencode", model: "mimo-v2.6-flash", outcome: "used", durationMs: 50, inputTokens: 40, outputTokens: 10 });

    expect(store.getStats().providerModels).toEqual([
      {
        model: "opencode:mimo-v2.6-flash",
        runs: 2,
        successfulRuns: 2,
        requests: 2,
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        averageDurationMs: 75,
      },
    ]);
  });

  it("preserves legacy shadow rows, routing schema and indexes alongside new planned rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "dr-watson-legacy-"));
    const path = join(dir, "dr-watson.db");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE routing_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT,
          route TEXT NOT NULL,
          model_tier TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE agent_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          agent TEXT NOT NULL,
          model TEXT,
          duration_ms INTEGER NOT NULL,
          success INTEGER NOT NULL,
          requests INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO sessions (project) VALUES ('legacy');
        INSERT INTO routing_decisions (session_id, provider, model, route, model_tier, duration_ms)
          VALUES (1, 'opencode', 'mimo-v2.6-pro', 'active', 'standard', 0),
            (1, 'baseline', 'rules-v1', 'coding', 'standard', 2);
        CREATE INDEX legacy_routing_session ON routing_decisions(session_id);
        INSERT INTO agent_runs (session_id, agent, model, duration_ms, success, requests, input_tokens, output_tokens, total_tokens)
          VALUES (1, 'Dr Watson', 'opencode:mimo-v2.6-pro', 250, 1, 1, 90, 10, 100);
      `);
      const schema = legacy.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'routing_decisions' ORDER BY name").all();
      const historicalRows = legacy.prepare("SELECT * FROM routing_decisions ORDER BY id").all();
      legacy.close();

      store = new MemoryStore(path);
      const stats = store.getStats();
      expect(stats.runs).toBe(1);
      expect(stats.providerModels).toEqual([
        {
          model: "opencode:mimo-v2.6-pro",
          runs: 1,
          successfulRuns: 1,
          requests: 1,
          inputTokens: 90,
          outputTokens: 10,
          totalTokens: 100,
          averageDurationMs: 250,
        },
      ]);
      expect(stats.routes).toEqual([
        { provider: "baseline", route: "coding", count: 1 },
        { provider: "opencode", route: "active", count: 1 },
      ]);
      store.addRoutingDecision({
        sessionId: store.createSession(), provider: "opencode", model: "mimo-v2.6-flash",
        route: "planned", modelTier: "cheap", durationMs: 0,
      });
      expect(store.getStats().routes).toEqual([
        { provider: "baseline", route: "coding", count: 1 },
        { provider: "opencode", route: "active", count: 1 },
        { provider: "opencode", route: "planned", count: 1 },
      ]);
      const reopened = new DatabaseSync(path);
      try {
        expect(reopened.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'routing_decisions' ORDER BY name").all()).toEqual(schema);
        expect(reopened.prepare("SELECT * FROM routing_decisions WHERE id <= 2 ORDER BY id").all()).toEqual(historicalRows);
        expect(reopened.prepare("SELECT route FROM routing_decisions WHERE id > 2").all()).toEqual([{ route: "planned" }]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
