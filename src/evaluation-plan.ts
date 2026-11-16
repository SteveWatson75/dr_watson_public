import type { Candidate } from "./model-policy.js";
import type { EvaluationFixture } from "./evaluation-fixtures.js";

// Mirrors the runner's conservative envelope: fixed UTF-8 prompt bytes plus
// room for the JSON instruction/tool schema. It is an upper bound, not usage.
export function tokenBound(systemPrompt: string, prompt: string): number {
  return Buffer.byteLength(systemPrompt + prompt) + 2048;
}

export interface EvaluationPlanSettings {
  repetitions: number;
  maxTokens: number;
  timeoutMs: number;
  systemPrompt: string;
}

export interface EvaluationPlanRow {
  model: string;
  calls: number;
  maxInputTokensPerCall: number;
  maxOutputTokensPerCall: number;
  worstCaseInputTokens: number;
  worstCaseOutputTokens: number;
  worstCaseAllowanceUsd: number;
  worstCaseSeconds: number;
  outputLimitApplied: boolean;
}

export interface EvaluationPlan {
  calls: number;
  fixtures: number;
  repetitions: number;
  maxTokens: number;
  timeoutMs: number;
  rows: EvaluationPlanRow[];
  worstCaseInputTokens: number;
  worstCaseOutputTokens: number;
  worstCaseAllowanceUsd: number;
  worstCaseSeconds: number;
}

// Deterministic worst case only. Requested output is clamped to the model's
// documented discovery limit, so a plan cannot silently exceed a model cap.
export function estimateEvaluationPlan(
  candidates: Candidate[],
  fixtures: EvaluationFixture[],
  settings: EvaluationPlanSettings,
  outputLimit: (model: string) => number | undefined = () => undefined,
): EvaluationPlan {
  const { repetitions, maxTokens, timeoutMs, systemPrompt } = settings;
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("Invalid repetitions");
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("Invalid max tokens");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Invalid timeout");

  const rows = candidates.map((candidate) => {
    const calls = fixtures.length * repetitions;
    const limits = fixtures.map((fixture) => tokenBound(systemPrompt, fixture.prompt));
    const maxInputTokensPerCall = limits.length ? Math.max(...limits) : 0;
    const documentedLimit = outputLimit(candidate.id);
    const maxOutputTokensPerCall = documentedLimit === undefined ? maxTokens : Math.min(maxTokens, documentedLimit);
    const worstCaseInputTokens = limits.reduce((sum, value) => sum + value, 0) * repetitions;
    const worstCaseOutputTokens = maxOutputTokensPerCall * calls;
    return {
      model: candidate.id,
      calls,
      maxInputTokensPerCall,
      maxOutputTokensPerCall,
      worstCaseInputTokens,
      worstCaseOutputTokens,
      worstCaseAllowanceUsd: (worstCaseInputTokens * candidate.input + worstCaseOutputTokens * candidate.output) / 1e6,
      worstCaseSeconds: (calls * timeoutMs) / 1000,
      outputLimitApplied: documentedLimit !== undefined && documentedLimit < maxTokens,
    };
  });

  const sum = (pick: (row: EvaluationPlanRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    calls: sum((row) => row.calls),
    fixtures: fixtures.length,
    repetitions,
    maxTokens,
    timeoutMs,
    rows,
    worstCaseInputTokens: sum((row) => row.worstCaseInputTokens),
    worstCaseOutputTokens: sum((row) => row.worstCaseOutputTokens),
    worstCaseAllowanceUsd: sum((row) => row.worstCaseAllowanceUsd),
    worstCaseSeconds: sum((row) => row.worstCaseSeconds),
  };
}
