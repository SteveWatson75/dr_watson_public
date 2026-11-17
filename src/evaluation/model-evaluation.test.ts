import { describe, expect, it } from "vitest";
import { evaluationFixtures } from "./evaluation-fixtures.js";
import {
  candidateCatalogue,
  candidateCatalogueSchema,
  describeEvaluationError,
  eligibility,
  evaluationDiscoverySchema,
  rankCandidates,
  resultSchema,
  scoreResult,
  summarize,
  weights,
  type EvaluationResult,
} from "./model-evaluation.js";
import { normalizeGoModels } from "../providers/opencode-models.js";
import { modelCatalogue, modelCatalogueSchema } from "../providers/model-catalogue.js";
import { modelRoutes } from "../routing/provider-chain.js";

const now = new Date("2026-11-16T12:00:00Z");
const candidate = candidateCatalogue.candidates[0]!;
const fixture = evaluationFixtures.find((f) => f.id === "structured-json")!;
const tool = evaluationFixtures.find((f) => f.id === "standard-tool")!;
const result: EvaluationResult = {
  model: candidate.id,
  fixture: fixture.id,
  repetition: 0,
  latencyMs: 1000,
  inputTokens: 100,
  outputTokens: 50,
  content: JSON.stringify(fixture.expected),
  toolCalls: [],
  finishReason: "stop",
};
const discovery = {
  object: "list" as const,
  data: [
    {
      id: candidate.id,
      object: "model",
      created: 0,
      owned_by: "opencode",
      capabilities: { tools: { supported: true } },
    },
  ],
};
const models = normalizeGoModels(discovery);

describe("evaluation eligibility and catalogues", () => {
  it("requires privacy evidence, presence and tool support", () => {
    expect(eligibility(candidate, models, now)).toEqual([]);
    expect(eligibility(candidate, [], now)).toContain("absent from current Go catalogue");
    expect(eligibility(candidate, [{ ...models[0]!, raw: {} }], now)).toContain(
      "tool support unverified",
    );
    expect(eligibility({ ...candidate, training: "unknown" }, models, now)).toContain(
      "training prohibited or unknown",
    );
    expect(eligibility({ ...candidate, retentionDays: null }, models, now)).toContain(
      "unknown retention",
    );
  });
  it("excludes every training-required candidate, even if available", () => {
    for (const c of candidateCatalogue.candidates.filter((c) => c.training === "yes")) {
      expect(eligibility(c, [{ ...models[0]!, id: c.id }], now)).toContain(
        "training prohibited or unknown",
      );
    }
  });
  it("never implicitly approves region restrictions and expires policy evidence", () => {
    expect(eligibility({ ...candidate, blocked: true }, models, now)).toContain(
      candidate.restrictions,
    );
    expect(eligibility(candidate, models, new Date("2027-01-01"))).toContain(
      "privacy evidence needs refresh",
    );
  });
  it("honors owner-approved Global access for DeepSeek without extending its ZDR agreement", () => {
    for (const id of ["deepseek-v4.1-flash", "deepseek-v4-pro"]) {
      const c = candidateCatalogue.candidates.find((c) => c.id === id)!;
      const available = [{ ...models[0]!, id }];
      expect(eligibility(c, available, now)).toEqual([]);
      expect(eligibility(c, available, new Date("2026-11-30T23:59:59Z"))).toEqual([]);
      expect(eligibility(c, available, new Date("2026-12-01T00:00:00Z"))).toContain(
        "privacy agreement expired",
      );
      expect(eligibility(c, [], now)).toContain("absent from current Go catalogue");
    }
    const beam = candidateCatalogue.candidates.find((c) => c.id === "beam-free")!;
    expect(beam.retentionDays).toBe(30);
    expect(beam.training).toBe("not-used");
    expect(beam.restrictions).toContain("Global settings do not waive model-specific exclusions");
  });
  it("rejects malformed, duplicate, unversioned or negative-price candidate catalogues", () => {
    for (const bad of [
      { ...candidateCatalogue, version: 2 },
      { ...candidateCatalogue, candidates: [candidate, candidate] },
      { ...candidateCatalogue, candidates: [{ ...candidate, output: -1 }] },
      { ...candidateCatalogue, candidates: [{ ...candidate, training: undefined }] },
      { ...candidateCatalogue, candidates: [{ ...candidate, privacyValidThrough: "not-a-date" }] },
    ])
      expect(candidateCatalogueSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects malformed or duplicate discovery instead of normalizing invalid identities", () => {
    expect(evaluationDiscoverySchema.safeParse(discovery).success).toBe(true);
    for (const bad of [
      {},
      { object: "list", data: [] },
      { ...discovery, data: [{ id: null }] },
      { ...discovery, data: [discovery.data[0], discovery.data[0]] },
    ]) {
      expect(evaluationDiscoverySchema.safeParse(bad).success).toBe(false);
    }
  });
  it("preserves validated production fallback order and final local route for all tiers", () => {
    expect(modelCatalogueSchema.safeParse(modelCatalogue).success).toBe(true);
    for (const tier of ["cheap", "standard", "hard"] as const) {
      expect(modelRoutes(tier, "auto")).toEqual([
        ...modelCatalogue.tierRoutes[tier],
        modelCatalogue.localFallback,
      ]);
    }
  });
});

describe("deterministic scoring", () => {
  it("keeps a bounded, unique fixture suite with tool evidence in every tier", () => {
    expect(evaluationFixtures.length).toBeGreaterThanOrEqual(12);
    expect(evaluationFixtures.length).toBeLessThanOrEqual(20);
    expect(new Set(evaluationFixtures.map((f) => f.id)).size).toBe(evaluationFixtures.length);
    for (const tier of ["cheap", "standard", "hard"]) {
      expect(evaluationFixtures.some((f) => f.tier === tier && f.tool)).toBe(true);
    }
  });
  it("uses the requested weights", () => {
    expect(weights).toEqual({
      correctness: 0.35,
      tool: 0.25,
      adherence: 0.2,
      latency: 0.1,
      efficiency: 0.1,
    });
  });
  it("scores exact structured answers, ignoring object key order", () => {
    expect(scoreResult(fixture, { ...result, content: '{"total":2,"ids":[4,9]}' })).toMatchObject({
      correctness: 1,
      adherence: 1,
      tool: null,
      review: false,
    });
    expect(scoreResult(fixture, { ...result, content: '{"total":2,"ids":[9,4]}' })).toMatchObject({
      correctness: 0.5,
      review: true,
    });
    expect(
      scoreResult(fixture, { ...result, content: '{"total":2,"ids":[4,9],"extra":true}' }),
    ).toMatchObject({ correctness: 1, adherence: 0, review: true });
  });
  it("gives missing, malformed, truncated and failed results no credit", () => {
    for (const bad of [
      undefined,
      {},
      { ...result, latencyMs: -1 },
      { ...result, content: "```json\n{}\n```" },
      { ...result, finishReason: "length" },
      { ...result, error: "HTTP 429" },
    ]) {
      expect(scoreResult(fixture, bad)).toMatchObject({
        correctness: 0,
        adherence: 0,
        review: true,
      });
    }
    expect(resultSchema.safeParse({ ...result, outputTokens: NaN }).success).toBe(false);
  });
  it("requires one named tool, exact arguments, no extra text or extra arguments", () => {
    const good = {
      ...result,
      fixture: tool.id,
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ name: "record_result", arguments: JSON.stringify(tool.expected) }],
    };
    expect(scoreResult(tool, good)).toMatchObject({ correctness: 1, adherence: 1, tool: 1 });
    for (const bad of [
      { ...good, toolCalls: [...good.toolCalls, ...good.toolCalls] },
      { ...good, content: "done" },
      { ...good, toolCalls: [{ name: "wrong", arguments: JSON.stringify(tool.expected) }] },
      {
        ...good,
        toolCalls: [{ name: "record_result", arguments: '{"issue":7,"priority":"P1","extra":1}' }],
      },
    ])
      expect(scoreResult(tool, bad)).toMatchObject({ tool: 0, adherence: 0, review: true });
  });
  it("does not treat JSON containing a tool name as an actual call", () => {
    expect(scoreResult(tool, { ...result, content: JSON.stringify(tool.expected) })).toMatchObject({
      tool: 0,
    });
  });
  it("allows only conservative whitespace/semicolon code normalization", () => {
    const code = evaluationFixtures.find((f) => f.id === "bounded-refactor")!;
    expect(scoreResult(code, { ...result, content: JSON.stringify(code.expected) })).toMatchObject({
      correctness: 1,
    });
    expect(
      scoreResult(code, {
        ...result,
        content: '{"code":"export function twice(n:number):number{return n*2}"}',
      }),
    ).toMatchObject({ correctness: 0, review: true });
  });
  it("counts missing and duplicate observations as zero, never silently drops failures", () => {
    const summary = summarize(candidate, [fixture], [result], 2);
    expect(summary.components.correctness).toBe(0.5);
    expect(summary.complete).toBe(false);
    expect(summary.review).toBe(true);
    expect(summarize(candidate, [fixture], [result, result], 2).components.correctness).toBe(0);
  });
  it("does not award tool credit where no tool test exists", () => {
    expect(summarize(candidate, [fixture], [result], 2).components.tool).toBe(0);
  });
  it("reports availability and reliability separately from accuracy", () => {
    const summary = summarize(candidate, [fixture], [result], 2);
    expect(summary.outcomes).toEqual({
      attempts: 2,
      responses: 1,
      usable: 1,
      errors: 0,
      timeouts: 0,
      missing: 1,
    });
    expect(summary.availability).toBe(0.5);
    expect(summary.reliability).toBe(0.5);
    const failed = summarize(
      candidate,
      [fixture],
      [{ ...result, error: "timeout", inputTokens: null, outputTokens: null }],
      1,
    );
    expect(failed.outcomes).toMatchObject({
      attempts: 1,
      responses: 0,
      usable: 0,
      errors: 1,
      timeouts: 1,
    });
    expect(failed.availability).toBe(0);
    expect(failed.components.correctness).toBe(0);
  });
  it("labels timeouts and HTTP failures without persisting error bodies", () => {
    expect(describeEvaluationError({ name: "APIConnectionTimeoutError" })).toBe("timeout");
    expect(describeEvaluationError({ status: 429 })).toBe("HTTP 429");
    expect(describeEvaluationError(new Error("secret response body"))).toBe("transport failure");
    expect(describeEvaluationError(undefined)).toBe("transport failure");
  });
  it("uses cost in fixed score bands, then score and exact ID as deterministic ties", () => {
    const rows = [
      { model: "b", score: 97, allowanceUsd: 2 },
      { model: "a", score: 96, allowanceUsd: 1 },
      { model: "c", score: 91, allowanceUsd: 0 },
    ];
    expect(rankCandidates(rows).map((r) => r.model)).toEqual(["a", "b", "c"]);
    const tied = ["z", "a"].map((model) => ({ model, score: 95, allowanceUsd: 0 }));
    expect(rankCandidates(tied).map((r) => r.model)).toEqual(["a", "z"]);
    expect(rankCandidates(tied.reverse()).map((r) => r.model)).toEqual(["a", "z"]);
  });
});
