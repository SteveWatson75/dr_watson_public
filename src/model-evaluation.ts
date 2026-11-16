import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { candidateCatalogue, privacyApprovalExpired, type Candidate } from "./model-policy.js";
import type { EvaluationFixture } from "./evaluation-fixtures.js";
import type { GoModel } from "./opencode-models.js";

export { candidateCatalogue, candidateCatalogueSchema, type Candidate } from "./model-policy.js";

// Evaluation has a stricter boundary than historical discovery: malformed IDs
// must never become candidates through String(undefined) normalization.
export const evaluationDiscoverySchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({
    id: z.string().min(1), object: z.literal("model"), created: z.number().finite(),
    owned_by: z.string(),
  }).passthrough()).min(1),
}).passthrough().refine((c) => new Set(c.data.map((m) => m.id)).size === c.data.length, "duplicate discovered model");

export function eligibility(candidate: Candidate, models: GoModel[], now = new Date()): string[] {
  const reasons: string[] = [];
  const age = now.getTime() - Date.parse(candidateCatalogue.checkedAt);
  if (age < 0 || age > 30 * 86400_000) reasons.push("privacy evidence needs refresh");
  if (privacyApprovalExpired(candidate, now)) reasons.push("privacy agreement expired");
  if (candidate.training !== "not-used") reasons.push("training prohibited or unknown");
  if (candidate.retentionDays === null) reasons.push("unknown retention");
  if (candidate.blocked) reasons.push(candidate.restrictions);
  const model = models.find((m) => m.id === candidate.id);
  if (!model) reasons.push("absent from current Go catalogue");
  const capabilities = model?.raw.capabilities as { tools?: { supported?: boolean } } | undefined;
  if (capabilities?.tools?.supported !== true) reasons.push("tool support unverified");
  return reasons;
}

export const resultSchema = z.object({
  model: z.string().min(1), fixture: z.string().min(1), repetition: z.number().int().nonnegative(),
  latencyMs: z.number().finite().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  content: z.string(), toolCalls: z.array(z.object({ name: z.string(), arguments: z.string() }).strict()),
  finishReason: z.string(), error: z.string().optional(),
}).strict();
export type EvaluationResult = z.infer<typeof resultSchema>;
const normalizedCode = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, "").replace(/;/g, "").replace(/'/g, '"') : value;

export function scoreResult(fixture: EvaluationFixture, raw: unknown) {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return { correctness: 0, adherence: 0, tool: fixture.tool ? 0 : null, review: true, evidence: "missing/malformed result" };
  const result = parsed.data;
  if (result.error || !["stop", "tool_calls"].includes(result.finishReason)) return { correctness: 0, adherence: 0, tool: fixture.tool ? 0 : null, review: true, evidence: result.error ?? `incomplete: ${result.finishReason}` };
  let answer: unknown;
  try {
    answer = JSON.parse(fixture.tool ? result.toolCalls[0]?.arguments ?? "" : result.content);
  } catch {
    return { correctness: 0, adherence: 0, tool: fixture.tool ? 0 : null, review: true, evidence: "invalid JSON" };
  }
  const object = answer && typeof answer === "object" && !Array.isArray(answer) ? answer as Record<string, unknown> : {};
  const keys = Object.keys(fixture.expected);
  const matches = keys.map((key) => fixture.code
    ? isDeepStrictEqual(normalizedCode(object[key]), normalizedCode(fixture.expected[key]))
    : isDeepStrictEqual(object[key], fixture.expected[key]));
  const shape = isDeepStrictEqual(Object.keys(object).sort(), keys.slice().sort());
  const toolValid = result.toolCalls.length === 1 && result.toolCalls[0]?.name === "record_result" && matches.every(Boolean) && shape && !result.content.trim();
  const adherence = Number(shape && (fixture.tool ? toolValid : result.toolCalls.length === 0));
  return {
    correctness: matches.filter(Boolean).length / keys.length,
    adherence, tool: fixture.tool ? Number(toolValid) : null,
    review: !matches.every(Boolean) || !adherence,
    evidence: { matches: Object.fromEntries(keys.map((key, i) => [key, matches[i]])), shape, toolValid: fixture.tool ? toolValid : null },
  };
}

export const weights = { correctness: 0.35, tool: 0.25, adherence: 0.2, latency: 0.1, efficiency: 0.1 };

export function summarize(candidate: Candidate, fixtures: EvaluationFixture[], results: EvaluationResult[], repetitions: number) {
  const scores = fixtures.flatMap((fixture) => Array.from({ length: repetitions }, (_, repetition) => {
    const rows = results.filter((r) => r.model === candidate.id && r.fixture === fixture.id && r.repetition === repetition);
    const parsed = rows.length === 1 ? resultSchema.safeParse(rows[0]) : undefined;
    const result = parsed?.success ? parsed.data : undefined;
    return { fixture, result, score: scoreResult(fixture, result) };
  }));
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const correctness = mean(scores.map((s) => s.score.correctness));
  const adherence = mean(scores.map((s) => s.score.adherence));
  const tool = mean(scores.flatMap((s) => s.score.tool === null ? [] : [s.score.tool]));
  const latency = mean(scores.map(({ result, score }) => result && score.adherence ? Math.max(0, 1 - result.latencyMs / 60_000) : 0));
  const efficiency = mean(scores.map(({ result, score }) => result && score.adherence && result.inputTokens !== null && result.outputTokens !== null
    ? Math.max(0, 1 - (result.inputTokens + result.outputTokens) / 8192) : 0));
  const allowanceUsd = scores.reduce((sum, { result }) => sum + ((result?.inputTokens ?? 0) * candidate.input + (result?.outputTokens ?? 0) * candidate.output) / 1e6, 0);
  const components = { correctness, tool, adherence, latency, efficiency };
  return { model: candidate.id, components, score: Object.entries(weights).reduce((sum, [key, weight]) => sum + components[key as keyof typeof components] * weight * 100, 0),
    allowanceUsd, complete: scores.every((s) => s.result && !s.result.error && s.result.inputTokens !== null && s.result.outputTokens !== null),
    apiCompatible: scores.every((s) => s.result && !s.result.error && ["stop", "tool_calls"].includes(s.result.finishReason)) && tool === 1,
    review: scores.some((s) => s.score.review), evidence: scores.map(({ fixture, result, score }) => ({ fixture: fixture.id, repetition: result?.repetition ?? null, ...score })) };
}

// Five-point bands are an explicit small-sample indifference policy, not significance.
export function rankCandidates<T extends { model: string; score: number; allowanceUsd: number }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => Math.floor(b.score / 5) - Math.floor(a.score / 5)
    || a.allowanceUsd - b.allowanceUsd || b.score - a.score || a.model.localeCompare(b.model, "en"));
}
