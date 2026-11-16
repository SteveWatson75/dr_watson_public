import { describe, expect, it } from "vitest";
import type { EvaluationFixture } from "./evaluation-fixtures.js";
import { rankCandidates, summarizeV2, type EvaluationResult } from "./model-evaluation.js";
import { candidateCatalogue } from "./model-policy.js";

const candidate = candidateCatalogue.candidates[0]!;
const text: EvaluationFixture = { id: "v2-text", tier: "cheap", prompt: "Return JSON {value} with value 1.", expected: { value: 1 } };
const tool: EvaluationFixture = { id: "v2-tool", tier: "cheap", prompt: "Call record_result once.", expected: { issue: 7, priority: "P1" }, tool: true };

const result = (fixture: EvaluationFixture, repetition: number, overrides: Partial<EvaluationResult> = {}): EvaluationResult => ({
  model: candidate.id, fixture: fixture.id, repetition, latencyMs: 1000,
  inputTokens: 100, outputTokens: 50,
  content: fixture.tool ? "" : JSON.stringify(fixture.expected),
  toolCalls: fixture.tool ? [{ name: "record_result", arguments: JSON.stringify(fixture.expected) }] : [],
  finishReason: fixture.tool ? "tool_calls" : "stop",
  ...overrides,
});
const timeout = (fixture: EvaluationFixture, repetition: number): EvaluationResult => result(fixture, repetition, {
  inputTokens: null, outputTokens: null, content: "", toolCalls: [], finishReason: "error", error: "timeout",
});

describe("conditional version 2 reporting", () => {
  it("keeps quality conditional on usable responses when one planned call times out", () => {
    const summary = summarizeV2(candidate, [text, tool], [result(text, 0), result(tool, 0), timeout(text, 1), result(tool, 1)], 2);
    expect(summary.quality).toEqual({ sampleSize: 3, toolSampleSize: 2 });
    expect(summary.components.correctness).toBe(1);
    expect(summary.components.tool).toBe(1);
    expect(summary.score).not.toBeNull();
    expect(summary.outcomes).toEqual({ planned: 4, usable: 3, invalid: 0, timeouts: 1, providerErrors: 0, missing: 0 });
    expect(summary.availability).toBe(0.75);
    expect(summary.completion).toBe(0.75);
    expect(summary.complete).toBe(false);
    expect(summary.qualifiedForRouting).toBe(false);
    expect(summary.review).toBe(true);
  });

  it("reports a zero sample size and no score when every request times out", () => {
    const results = [text, tool].flatMap((fixture) => [timeout(fixture, 0), timeout(fixture, 1)]);
    const summary = summarizeV2(candidate, [text, tool], results, 2);
    expect(summary.quality).toEqual({ sampleSize: 0, toolSampleSize: 0 });
    expect(summary.components).toEqual({ correctness: null, tool: null, adherence: null, latency: null, efficiency: null });
    expect(summary.score).toBeNull();
    expect(summary.outcomes).toEqual({ planned: 4, usable: 0, invalid: 0, timeouts: 4, providerErrors: 0, missing: 0 });
    expect(summary.availability).toBe(0);
    expect(summary.completion).toBe(0);
    expect(summary.qualifiedForRouting).toBe(false);
  });

  it("counts malformed answers separately instead of treating them as usable quality", () => {
    const summary = summarizeV2(candidate, [text, tool], [
      result(text, 0, { content: "not json" }),
      result(tool, 0, { content: "not json", toolCalls: [], finishReason: "stop" }),
    ], 1);
    expect(summary.quality).toEqual({ sampleSize: 0, toolSampleSize: 0 });
    expect(summary.components.correctness).toBeNull();
    expect(summary.score).toBeNull();
    expect(summary.outcomes).toEqual({ planned: 2, usable: 0, invalid: 2, timeouts: 0, providerErrors: 0, missing: 0 });
    expect(summary.availability).toBe(1);
    expect(summary.completion).toBe(0);
    expect(summary.qualifiedForRouting).toBe(false);
  });

  it("counts missing and provider-failed observations against planned calls", () => {
    const failed = result(text, 1, { inputTokens: null, outputTokens: null, content: "", finishReason: "error", error: "HTTP 503" });
    const summary = summarizeV2(candidate, [text, tool], [result(text, 0), failed], 2);
    expect(summary.quality).toEqual({ sampleSize: 1, toolSampleSize: 0 });
    expect(summary.components.correctness).toBe(1);
    expect(summary.components.tool).toBeNull();
    expect(summary.score).toBeNull();
    expect(summary.outcomes).toEqual({ planned: 4, usable: 1, invalid: 0, timeouts: 0, providerErrors: 1, missing: 2 });
    expect(summary.completion).toBe(0.25);
    expect(summary.qualifiedForRouting).toBe(false);
  });

  it("reports mixed correctness on complete evidence without zero-averaging availability", () => {
    const summary = summarizeV2(candidate, [text, tool], [
      result(text, 0), result(tool, 0),
      result(text, 1, { content: JSON.stringify({ value: 2 }) }), result(tool, 1),
    ], 2);
    expect(summary.quality).toEqual({ sampleSize: 4, toolSampleSize: 2 });
    expect(summary.components.correctness).toBe(0.75);
    expect(summary.components.tool).toBe(1);
    expect(summary.components.adherence).toBe(1);
    expect(summary.score).not.toBeNull();
    expect(summary.complete).toBe(true);
    expect(summary.usageComplete).toBe(true);
    expect(summary.qualifiedForRouting).toBe(true);
    expect(summary.review).toBe(true);
  });

  it("sorts incomplete or unqualified evidence below qualified evidence", () => {
    const rows = [
      { model: "incomplete", score: 99, allowanceUsd: 0, qualifiedForRouting: false },
      { model: "qualified", score: 50, allowanceUsd: 1, qualifiedForRouting: true },
      { model: "no-quality", score: null, allowanceUsd: 0, qualifiedForRouting: false },
    ];
    expect(rankCandidates(rows).map((row) => row.model)).toEqual(["qualified", "incomplete", "no-quality"]);
    expect(rankCandidates([{ model: "b", score: 90, allowanceUsd: 0 }, { model: "a", score: 90, allowanceUsd: 1 }]).map((row) => row.model))
      .toEqual(["b", "a"]);
  });
});
