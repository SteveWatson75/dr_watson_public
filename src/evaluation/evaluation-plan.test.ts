import { describe, expect, it } from "vitest";
import { estimateEvaluationPlan, tokenBound } from "./evaluation-plan.js";
import type { Candidate } from "../providers/model-policy.js";
import type { EvaluationFixture } from "./evaluation-fixtures.js";

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: "test-model",
  tiers: ["cheap"],
  training: "not-used",
  retentionDays: 0,
  restrictions: "synthetic test policy",
  input: 1,
  output: 2,
  ...overrides,
});
const fixture = (id: string, prompt: string): EvaluationFixture => ({
  id,
  tier: "cheap",
  prompt,
  expected: { value: 1 },
});
const settings = { repetitions: 2, maxTokens: 4096, timeoutMs: 60_000, systemPrompt: "system" };

describe("bounded evaluation plans", () => {
  it("computes calls, conservative token bounds and worst-case allowance", () => {
    const plan = estimateEvaluationPlan(
      [candidate()],
      [fixture("a", "aa"), fixture("b", "bbbb")],
      settings,
    );
    expect(tokenBound("system", "aa")).toBe(2056);
    expect(plan.calls).toBe(4);
    expect(plan.rows[0]).toMatchObject({
      calls: 4,
      maxInputTokensPerCall: 2058,
      maxOutputTokensPerCall: 4096,
      worstCaseInputTokens: 8228,
      worstCaseOutputTokens: 16384,
      worstCaseAllowanceUsd: 0.040996,
      worstCaseSeconds: 240,
      outputLimitApplied: false,
    });
    expect(plan.worstCaseAllowanceUsd).toBeCloseTo(0.040996);
  });

  it("clamps requested output to a model-specific discovery limit", () => {
    const [row] = estimateEvaluationPlan(
      [candidate()],
      [fixture("a", "aa")],
      settings,
      () => 1024,
    ).rows;
    expect(row).toMatchObject({ maxOutputTokensPerCall: 1024, outputLimitApplied: true });
    expect(row!.worstCaseAllowanceUsd).toBeCloseTo((2056 * 2 * 1 + 1024 * 2 * 2) / 1e6);
    expect(
      estimateEvaluationPlan([candidate()], [fixture("a", "aa")], settings, () => 8192).rows[0]
        ?.outputLimitApplied,
    ).toBe(false);
  });

  it("is deterministic for the candidate order supplied", () => {
    const a = candidate({ id: "z" });
    const b = candidate({ id: "a" });
    expect(
      estimateEvaluationPlan([a, b], [fixture("f", "p")], settings).rows.map((row) => row.model),
    ).toEqual(["z", "a"]);
    expect(estimateEvaluationPlan([a, b], [fixture("f", "p")], settings)).toEqual(
      estimateEvaluationPlan([a, b], [fixture("f", "p")], settings),
    );
  });

  it("rejects invalid bounds instead of producing a misleading plan", () => {
    expect(() =>
      estimateEvaluationPlan([candidate()], [], { ...settings, repetitions: 0 }),
    ).toThrow("repetitions");
    expect(() => estimateEvaluationPlan([candidate()], [], { ...settings, maxTokens: 0 })).toThrow(
      "max tokens",
    );
    expect(() =>
      estimateEvaluationPlan([candidate()], [], { ...settings, timeoutMs: Number.NaN }),
    ).toThrow("timeout");
  });
});
