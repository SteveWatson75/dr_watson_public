import { createHash } from "node:crypto";
import { z } from "zod";
import { candidateCatalogueSchema, type Candidate } from "../providers/model-policy.js";
import { EVALUATION_SCORING_VERSION, rankCandidates, resultSchema, summarize, summarizeV2, type EvaluationResult } from "./model-evaluation.js";

const tierSchema = z.enum(["cheap", "standard", "hard"]);
const scoringVersionSchema = z.union([z.literal(1), z.literal(2)]).optional();
const manifestSchema = z.object({
  version: z.literal(1),
  fixtureSet: z.union([z.literal(1), z.literal(2)]).optional(),
  scoringVersion: scoringVersionSchema,
  startedAt: z.iso.datetime(),
  tier: tierSchema,
  repetitions: z.union([z.literal(2), z.literal(3)]),
  endpoint: z.url(),
  system: z.string().min(1),
  settings: z.object({
    maxTokens: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    retries: z.number().int().nonnegative(),
  }).passthrough(),
  fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
  fixtures: z.array(z.object({
    id: z.string().min(1), tier: tierSchema, prompt: z.string().min(1),
    expected: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, "empty expectation"),
    tool: z.boolean().optional(), code: z.boolean().optional(),
  }).strict()).min(1),
  candidateCatalogue: candidateCatalogueSchema,
  plan: z.array(z.object({ model: z.string().min(1), exclusions: z.array(z.string()) }).strict()).min(1),
  results: z.array(resultSchema),
}).passthrough();

// Only the saved manifest supplies candidates, prices and fixtures. In
// particular, today's expiry/eligibility must not rewrite historical scoring.
export function buildEvaluationReport(rawReports: unknown[]) {
  const reports = rawReports.map((raw) => {
    const report = manifestSchema.parse(raw);
    const rawFixtures = (raw as { fixtures: unknown }).fixtures;
    if (report.fixtureHash !== createHash("sha256").update(JSON.stringify(rawFixtures)).digest("hex")) {
      throw new Error("Fixture snapshot hash mismatch");
    }
    return report;
  });
  const first = reports[0];
  if (!first) throw new Error("Missing evaluation report");
  const requestSettings = (report: typeof first) => JSON.stringify([
    report.endpoint, report.system, report.settings.maxTokens, report.settings.timeoutMs, report.settings.retries,
  ]);
  const candidates: Candidate[] = [];
  const results: EvaluationResult[] = [];
  for (const report of reports) {
    if (report.tier !== first.tier || report.repetitions !== first.repetitions
      || report.fixtureSet !== first.fixtureSet || (report.scoringVersion ?? 1) !== (first.scoringVersion ?? 1)
      || report.fixtureHash !== first.fixtureHash || requestSettings(report) !== requestSettings(first)) {
      throw new Error("Incompatible evaluation reports");
    }
    if (report.candidateCatalogue.checkedAt > report.startedAt.slice(0, 10)) throw new Error("Candidate snapshot postdates run");
    const fixtures = new Set(report.fixtures.map((fixture) => fixture.id));
    if (fixtures.size !== report.fixtures.length || report.fixtures.some((fixture) => fixture.tier !== report.tier)) {
      throw new Error("Inconsistent fixture snapshot");
    }
    const planned = new Set<string>();
    for (const entry of report.plan) {
      const candidate = report.candidateCatalogue.candidates.find((candidate) => candidate.id === entry.model);
      if (!candidate || !candidate.tiers.includes(report.tier) || planned.has(entry.model)
        || candidates.some((candidate) => candidate.id === entry.model)) throw new Error("Inconsistent candidate snapshot/plan");
      planned.add(entry.model);
      candidates.push(candidate);
    }
    const observations = new Set<string>();
    for (const result of report.results) {
      const key = JSON.stringify([result.model, result.fixture, result.repetition]);
      if (!planned.has(result.model) || !fixtures.has(result.fixture) || result.repetition >= report.repetitions
        || observations.has(key)) throw new Error("Inconsistent result snapshot");
      observations.add(key);
      results.push(result);
    }
  }
  return {
    tier: first.tier,
    scoringVersion: first.scoringVersion ?? 1,
    status: "provisional; human review required; no routing changes",
    eligibility: "not evaluated; historical snapshots only",
    comparison: rankCandidates(candidates.map((candidate) => (first.scoringVersion === EVALUATION_SCORING_VERSION
      ? summarizeV2(candidate, first.fixtures, results, first.repetitions)
      : summarize(candidate, first.fixtures, results, first.repetitions)))),
  };
}
