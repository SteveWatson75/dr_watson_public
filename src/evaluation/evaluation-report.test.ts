import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEvaluationReport } from "./evaluation-report.js";
import { candidateCatalogue } from "../providers/model-policy.js";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../docs/evaluations/${name}.json`, import.meta.url), "utf8"));
const hashFixtures = (manifest: ReturnType<typeof read>) => {
  manifest.fixtureHash = createHash("sha256").update(JSON.stringify(manifest.fixtures)).digest("hex");
  return manifest;
};
afterEach(() => vi.useRealTimers());

describe("historical offline reports", () => {
  it.each(["cheap", "standard", "hard"])("preserves recorded %s scores, costs and ranking using original manifests", (tier) => {
    const report = buildEvaluationReport([read(tier), read(`${tier}-${tier === "cheap" ? "beam" : "deepseek"}`)]);
    const recorded = read("comparison").tiers.find((row: { tier: string }) => row.tier === tier);
    const select = ({ model, score, allowanceUsd }: { model: string; score: number | null; allowanceUsd: number }) => ({ model, score, allowanceUsd });
    expect(report.comparison.map(select)).toEqual(recorded.comparison.map(select));
    expect(report.scoringVersion).toBe(1);
    expect(report.eligibility).toBe("not evaluated; historical snapshots only");
  });

  it("ignores edits to today's pricing, approval and tier metadata", () => {
    const manifests = [read("cheap"), read("cheap-beam")];
    const before = buildEvaluationReport(manifests);
    const current = candidateCatalogue.candidates.find((candidate) => candidate.id === "beam-free")!;
    const original = structuredClone(current);
    try {
      // Today's catalogue would now make Beam expensive/ineligible. Neither
      // its historical allowance nor cost-aware ranking may change.
      Object.assign(current, { input: 999, output: 999, blocked: true, tiers: ["hard"], privacyValidThrough: "2020-01-01" });
      expect(buildEvaluationReport(manifests)).toEqual(before);
      expect(before.comparison.find((row) => row.model === "beam-free")?.allowanceUsd).toBe(0);
    } finally {
      delete current.privacyValidThrough;
      delete current.blocked;
      Object.assign(current, original);
    }
  });

  it("uses snapshot prices, not saved score fields, to recompute costs", () => {
    const manifest = read("cheap-beam");
    manifest.candidateCatalogue.candidates.find((candidate: { id: string }) => candidate.id === "beam-free").input = 1;
    manifest.comparison = [{ model: "beam-free", score: -1, allowanceUsd: 999 }];
    expect(buildEvaluationReport([manifest]).comparison[0]?.allowanceUsd).toBeCloseTo(1368 / 1e6);
  });

  it("scores saved fixtures independently of today's fixture definitions and current eligibility", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-01"));
    const manifest = read("standard-deepseek");
    const before = buildEvaluationReport([manifest]);
    expect(before.comparison[0]?.complete).toBe(true);
    manifest.fixtures[0].prompt += " Historical fixture wording.";
    hashFixtures(manifest);
    expect(buildEvaluationReport([manifest]).comparison).toEqual(before.comparison);
  });

  it.each([
    ["missing snapshot", (m: ReturnType<typeof read>) => { delete m.candidateCatalogue; }],
    ["malformed price", (m: ReturnType<typeof read>) => { m.candidateCatalogue.candidates[0].input = -1; }],
    ["duplicate snapshot identity", (m: ReturnType<typeof read>) => { m.candidateCatalogue.candidates.push(m.candidateCatalogue.candidates[0]); }],
    ["missing planned identity", (m: ReturnType<typeof read>) => { m.plan[0].model = "not-in-snapshot"; }],
    ["wrong tier", (m: ReturnType<typeof read>) => { m.candidateCatalogue.candidates[0].tiers = ["hard"]; }],
    ["future snapshot", (m: ReturnType<typeof read>) => { m.candidateCatalogue.checkedAt = "2027-01-01"; }],
    ["modified fixture without hash", (m: ReturnType<typeof read>) => { m.fixtures[0].prompt += " changed"; }],
    ["duplicate fixture", (m: ReturnType<typeof read>) => { m.fixtures.push(m.fixtures[0]); hashFixtures(m); }],
    ["unplanned result", (m: ReturnType<typeof read>) => { m.results[0].model = "not-planned"; }],
    ["duplicate result", (m: ReturnType<typeof read>) => { m.results.push(m.results[0]); }],
    ["out-of-range repetition", (m: ReturnType<typeof read>) => { m.results[0].repetition = m.repetitions; }],
  ])("rejects %s rather than falling back to current metadata", (_label, change) => {
    const manifest = read("cheap");
    change(manifest);
    expect(() => buildEvaluationReport([manifest])).toThrow();
  });

  it("rejects incompatible or overlapping combined reports", () => {
    const cheap = read("cheap");
    const beam = read("cheap-beam");
    beam.settings.maxTokens++;
    expect(() => buildEvaluationReport([cheap, beam])).toThrow("Incompatible");
    expect(() => buildEvaluationReport([cheap, cheap])).toThrow("candidate snapshot/plan");
    expect(() => buildEvaluationReport([])).toThrow("Missing evaluation report");
  });

  it("refuses to combine different versioned fixture sets", () => {
    const cheap = read("cheap");
    const beam = read("cheap-beam");
    cheap.fixtureSet = 1;
    beam.fixtureSet = 2;
    expect(() => buildEvaluationReport([cheap, beam])).toThrow("Incompatible");
  });

  it("uses conditional scoring only when a manifest opts into version 2", () => {
    const legacy = buildEvaluationReport([read("cheap")]);
    const manifest = read("cheap");
    manifest.scoringVersion = 2;
    const versioned = buildEvaluationReport([manifest]);
    expect(legacy.scoringVersion).toBe(1);
    expect(versioned.scoringVersion).toBe(2);
    const mimo = versioned.comparison.find((row) => row.model === "mimo-v2.6-flash");
    if (!mimo || !("quality" in mimo)) throw new Error("missing version 2 summary");
    expect(mimo.quality.sampleSize).toBe(10);
    expect(mimo.components.correctness).not.toBeNull();
    expect(mimo.qualifiedForRouting).toBe(true);
    const glm = versioned.comparison.find((row) => row.model === "glm-5.3-flash");
    if (!glm || !("quality" in glm)) throw new Error("missing version 2 summary");
    expect(glm.qualifiedForRouting).toBe(false);
  });

  it("refuses to combine different scoring versions", () => {
    const cheap = read("cheap");
    const beam = read("cheap-beam");
    cheap.scoringVersion = 1;
    beam.scoringVersion = 2;
    expect(() => buildEvaluationReport([cheap, beam])).toThrow("Incompatible");
  });
});
