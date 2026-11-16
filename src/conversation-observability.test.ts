import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Usage, run, type Model, type ModelRequest } from "@openai/agents";
import { BudgetLedger } from "./budget.js";
import { runConversation } from "./conversation.js";
import { manager } from "./manager.js";
import { MemoryStore } from "./memory.js";
import { createRoutedModel, guardedModel, type ModelFactory, type ModelUsageReporter } from "./provider.js";
import { modelRoutes, type ModelRoute } from "./provider-chain.js";
import { formatStats } from "./stats.js";

vi.mock("@openai/agents", async (importOriginal) => ({
  ...await importOriginal<typeof import("@openai/agents")>(),
  run: vi.fn(),
}));
vi.mock("./provider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./provider.js")>(),
  createRoutedModel: vi.fn(),
}));
vi.mock("./provider-chain.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./provider-chain.js")>(),
  modelRoutes: vi.fn(),
}));

const modelRequest: ModelRequest = { input: "Synthetic test", modelSettings: {}, tools: [], handoffs: [], outputType: "text", tracing: false };

function fakeModel(inputTokens: number, outputTokens: number): Model {
  return {
    getResponse: vi.fn(async () => ({
      usage: new Usage({ requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }),
      output: [],
    })),
    async *getStreamedResponse() { throw new Error("unused"); },
  };
}

function tableRows(db: DatabaseSync, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
}

let workdir: string;
let memory: MemoryStore;
let raw: DatabaseSync;
let ledger: BudgetLedger;
let routes: ModelRoute[];
let factory: ModelFactory;
let warn: Mock<(message: string) => void>;
let model: Model | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  workdir = mkdtempSync(join(tmpdir(), "dr-watson-observability-"));
  memory = new MemoryStore(join(workdir, "dr-watson.db"));
  raw = new DatabaseSync(join(workdir, "dr-watson.db"));
  ledger = new BudgetLedger(":memory:");
  routes = [{ provider: "opencode", model: "mimo-v2.6-flash" }, { provider: "ollama" }];
  factory = async () => fakeModel(100, 20);
  warn = vi.fn<(message: string) => void>();
  model = undefined;
  for (const provider of ["OPENCODE", "OPENROUTER", "ANTHROPIC", "GEMINI"]) vi.stubEnv(`${provider}_API_KEY`, "test-key-LEAK");
  vi.mocked(modelRoutes).mockImplementation(() => routes);
  vi.mocked(createRoutedModel).mockImplementation(
    (_tier, _override, history, report?: ModelUsageReporter) =>
      (model = guardedModel(routes, ledger, factory, warn, history, undefined, report)),
  );
  vi.mocked(run).mockImplementation((async () => {
    await model!.getResponse(modelRequest);
    return { finalOutput: "Done", state: { usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 } } };
  }) as never);
});

afterEach(() => {
  raw.close();
  memory.close();
  ledger.close();
  rmSync(workdir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function ask(message = "Summarize the findings") {
  const sessionId = memory.createSession();
  const response = await runConversation(manager, memory, sessionId, message,
    "Canonical project: Acme is live.", "", { tier: "standard", provider: "auto" });
  return { sessionId, response };
}

describe("conversation model-usage observability", () => {
  it("attributes a successful run to the primary model that served it", async () => {
    const { sessionId } = await ask();

    const planned = tableRows(raw, "routing_decisions").filter((row) => row.route === "planned");
    expect(planned).toEqual([expect.objectContaining({ session_id: sessionId, provider: "opencode", model: "mimo-v2.6-flash", model_tier: "standard" })]);

    const runs = tableRows(raw, "agent_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ model: "opencode:mimo-v2.6-flash", success: 1, requests: 1, input_tokens: 10, output_tokens: 5, total_tokens: 15 });

    const usage = tableRows(raw, "model_usage");
    expect(usage).toEqual([expect.objectContaining({
      agent_run_id: runs[0]!.id, provider: "opencode", model: "mimo-v2.6-flash", outcome: "used", input_tokens: 100, output_tokens: 20,
    })]);

    expect(memory.getStats().providerModels).toEqual([{
      model: "opencode:mimo-v2.6-flash", runs: 1, successfulRuns: 1, requests: 1,
      inputTokens: 100, outputTokens: 20, totalTokens: 120, averageDurationMs: expect.any(Number),
    }]);
  });

  it("attributes a fallback run to the model that actually served it, not the planned primary", async () => {
    routes = [{ provider: "opencode", model: "mimo-v2.6-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }];
    factory = async (route) => {
      if (route.model === "mimo-v2.6-pro") throw Object.assign(new Error("unavailable"), { status: 503 });
      return fakeModel(300, 50);
    };
    await ask();

    const usage = tableRows(raw, "model_usage");
    expect(usage).toEqual([
      expect.objectContaining({ provider: "opencode", model: "mimo-v2.6-pro", outcome: "failed", input_tokens: 0, output_tokens: 0 }),
      expect.objectContaining({ provider: "opencode", model: "mimo-v2.6-flash", outcome: "used", input_tokens: 300, output_tokens: 50 }),
    ]);
    expect(tableRows(raw, "agent_runs")[0]).toMatchObject({ model: "opencode:mimo-v2.6-flash", success: 1 });

    const providerModels = memory.getStats().providerModels;
    const primary = providerModels.find((item) => item.model === "opencode:mimo-v2.6-pro");
    const fallback = providerModels.find((item) => item.model === "opencode:mimo-v2.6-flash");
    expect(primary).toMatchObject({ runs: 1, successfulRuns: 0, requests: 1, totalTokens: 0 });
    expect(fallback).toMatchObject({ runs: 1, successfulRuns: 1, totalTokens: 350, inputTokens: 300, outputTokens: 50 });
    // The planned route is still recorded, separately from actual usage.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("opencode:mimo-v2.6-pro is unavailable"));
  });

  it("records a privacy-blocked primary as never attempted and keeps the privacy warning", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T00:00:00.000Z"));
    routes = [{ provider: "opencode", model: "deepseek-v4-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }];
    await ask();

    const usage = tableRows(raw, "model_usage");
    expect(usage).toEqual([expect.objectContaining({ model: "mimo-v2.6-flash", outcome: "used" })]);
    expect(tableRows(raw, "agent_runs")[0]).toMatchObject({ model: "opencode:mimo-v2.6-flash", success: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("privacy approval expired after 2026-11-30"));
  });

  it("falls back past routes with missing credentials and attributes the serving model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    routes = [{ provider: "anthropic" }, { provider: "opencode", model: "mimo-v2.6-flash" }];
    await ask();

    const usage = tableRows(raw, "model_usage");
    expect(usage).toEqual([expect.objectContaining({ provider: "opencode", model: "mimo-v2.6-flash", outcome: "used" })]);
    expect(tableRows(raw, "agent_runs")[0]).toMatchObject({ model: "opencode:mimo-v2.6-flash" });
    expect(warn).toHaveBeenCalledWith("anthropic API key is missing.");
  });

  it("records the final failure when no route produces a response", async () => {
    routes = [{ provider: "opencode", model: "mimo-v2.6-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }];
    factory = async () => {
      throw Object.assign(new Error("unavailable"), { status: 503 });
    };
    await expect(ask()).rejects.toThrow("No usable local fallback is configured.");

    const runs = tableRows(raw, "agent_runs");
    expect(runs).toEqual([expect.objectContaining({ model: "none", success: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 })]);
    expect(tableRows(raw, "model_usage")).toEqual([
      expect.objectContaining({ model: "mimo-v2.6-pro", outcome: "failed", input_tokens: 0, output_tokens: 0 }),
      expect.objectContaining({ model: "mimo-v2.6-flash", outcome: "failed", input_tokens: 0, output_tokens: 0 }),
    ]);
  });

  it("splits tokens and latency across multiple models within one agent run", async () => {
    routes = [{ provider: "opencode", model: "mimo-v2.6-pro" }, { provider: "opencode", model: "mimo-v2.6-flash" }];
    let primaryCalls = 0;
    const primary = {
      getResponse: vi.fn(async () => {
        primaryCalls += 1;
        if (primaryCalls > 1) throw Object.assign(new Error("unavailable"), { status: 503 });
        return { usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12 }), output: [] };
      }),
      async *getStreamedResponse() { throw new Error("unused"); },
    } as unknown as Model;
    let fallbackCalls = 0;
    const fallback = {
      getResponse: vi.fn(async () => {
        fallbackCalls += 1;
        const [inputTokens, outputTokens] = fallbackCalls === 1 ? [30, 5] : [40, 8];
        return { usage: new Usage({ requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }), output: [] };
      }),
      async *getStreamedResponse() { throw new Error("unused"); },
    } as unknown as Model;
    factory = async (route) => (route.model === "mimo-v2.6-pro" ? primary : fallback);
    vi.mocked(run).mockImplementation((async () => {
      await model!.getResponse(modelRequest);
      await model!.getResponse(modelRequest);
      await model!.getResponse(modelRequest);
      return { finalOutput: "Done", state: { usage: { requests: 3, inputTokens: 80, outputTokens: 15, totalTokens: 95 } } };
    }) as never);

    await ask();

    const usage = tableRows(raw, "model_usage");
    expect(usage.map((row) => [row.provider, row.model, row.outcome, row.input_tokens, row.output_tokens])).toEqual([
      ["opencode", "mimo-v2.6-pro", "used", 10, 2],
      ["opencode", "mimo-v2.6-pro", "failed", 0, 0],
      ["opencode", "mimo-v2.6-flash", "used", 30, 5],
      ["opencode", "mimo-v2.6-pro", "failed", 0, 0],
      ["opencode", "mimo-v2.6-flash", "used", 40, 8],
    ]);
    expect(usage.every((row) => Number(row.duration_ms) >= 0)).toBe(true);
    expect(tableRows(raw, "agent_runs")[0]).toMatchObject({ model: "opencode:mimo-v2.6-pro+opencode:mimo-v2.6-flash", requests: 3, input_tokens: 80, output_tokens: 15, total_tokens: 95 });

    const providerModels = memory.getStats().providerModels;
    expect(providerModels).toEqual(expect.arrayContaining([
      { model: "opencode:mimo-v2.6-pro", runs: 3, successfulRuns: 1, requests: 3, inputTokens: 10, outputTokens: 2, totalTokens: 12, averageDurationMs: expect.any(Number) },
      { model: "opencode:mimo-v2.6-flash", runs: 2, successfulRuns: 2, requests: 2, inputTokens: 70, outputTokens: 13, totalTokens: 83, averageDurationMs: expect.any(Number) },
    ]));
    // No model is credited with the whole run's tokens or latency.
    for (const item of providerModels) expect(item.totalTokens).not.toBe(95);
  });

  it("never persists prompts or credentials in observability records", async () => {
    await ask("CONFIDENTIAL-MESSAGE-TEXT");

    const dump = JSON.stringify([
      ...tableRows(raw, "routing_decisions"),
      ...tableRows(raw, "agent_runs"),
      ...tableRows(raw, "model_usage"),
    ]);
    expect(dump).not.toContain("CONFIDENTIAL-MESSAGE-TEXT");
    expect(dump).not.toContain("CONFIDENTIAL");
    expect(dump).not.toContain("Acme");
    expect(dump).not.toContain("test-key-LEAK");
    expect(dump).not.toContain("test-key");
  });

  it("keeps existing --stats sections working across legacy and recorded rows", async () => {
    // A run recorded before model_usage existed keeps its legacy attribution.
    memory.addAgentRun({
      sessionId: memory.createSession(), agent: "Dr Watson", model: "gemini:gemini-3.7-flash",
      durationMs: 100, success: true, requests: 1, inputTokens: 80, outputTokens: 20, totalTokens: 100,
    });
    await ask();

    const stats = memory.getStats();
    expect(stats.runs).toBe(2);
    const output = formatStats(stats);
    expect(output).toContain("Agent usage");
    expect(output).toContain("Provider/model performance");
    expect(output).toContain("Route decisions");
    expect(output).toContain("Model tiers");
    expect(output).toContain("gemini:gemini-3.7-flash");
    expect(output).toContain("opencode:mimo-v2.6-flash");
    expect(output).toContain("opencode: planned = 1");
  });
});
