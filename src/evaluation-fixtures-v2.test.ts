import { describe, expect, it } from "vitest";
import { evaluationFixtures } from "./evaluation-fixtures.js";
import { evaluationFixtureSetVersion, evaluationFixturesV2 } from "./evaluation-fixtures-v2.js";
import { scoreResult, summarizeV2 } from "./model-evaluation.js";
import { candidateCatalogue } from "./model-policy.js";

const candidate = candidateCatalogue.candidates[0]!;
const sorted = (values: string[]) => values.slice().sort((a, b) => a.localeCompare(b, "en"));

describe("version 2 fixture set", () => {
  it("is versioned, bounded and disjoint from version 1", () => {
    expect(evaluationFixtureSetVersion).toBe(2);
    expect(evaluationFixturesV2.length).toBeGreaterThanOrEqual(9);
    expect(evaluationFixturesV2.length).toBeLessThanOrEqual(15);
    const ids = new Set(evaluationFixturesV2.map((fixture) => fixture.id));
    expect(ids.size).toBe(evaluationFixturesV2.length);
    for (const fixture of evaluationFixturesV2) expect(evaluationFixtures.some((old) => old.id === fixture.id)).toBe(false);
  });

  it("covers each tier with explicit tool evidence and no exact code-string checks", () => {
    for (const tier of ["cheap", "standard", "hard"] as const) {
      const fixtures = evaluationFixturesV2.filter((fixture) => fixture.tier === tier);
      expect(fixtures.length).toBeGreaterThanOrEqual(3);
      expect(fixtures.some((fixture) => fixture.tool)).toBe(true);
      for (const fixture of fixtures) expect(fixture.code).toBeUndefined();
    }
  });

  it("uses sorted answer vocabularies so exact array order is unambiguous", () => {
    for (const fixture of evaluationFixturesV2) {
      for (const value of Object.values(fixture.expected)) {
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) expect(value).toEqual(sorted(value));
      }
      expect(fixture.prompt).not.toContain("```");
    }
  });

  it("disambiguates missing authentication from missing authorization", () => {
    const auth = evaluationFixturesV2.find((fixture) => fixture.id === "deleted-auth-diff")!;
    expect(auth.prompt).toContain("missing-authentication means");
    expect(auth.prompt).toContain("missing-authorization means");
    expect(auth.expected).toEqual({ findings: ["missing-authentication", "missing-authorization"] });
    const security = evaluationFixturesV2.find((fixture) => fixture.id === "security-review-deletion")!;
    expect(security.prompt).toContain("missing-authorization is out of scope");
    expect((security.expected as { defects: string[] }).defects).not.toContain("missing-authorization");
  });

  it("scores its own expected answers without review flags", () => {
    for (const fixture of evaluationFixturesV2) {
      const tool = Boolean(fixture.tool);
      const result = {
        model: candidate.id, fixture: fixture.id, repetition: 0, latencyMs: 500,
        inputTokens: 100, outputTokens: 50,
        content: tool ? "" : JSON.stringify(fixture.expected),
        toolCalls: tool ? [{ name: "record_result", arguments: JSON.stringify(fixture.expected) }] : [],
        finishReason: tool ? "tool_calls" : "stop",
      };
      expect(scoreResult(fixture, result)).toMatchObject({ correctness: 1, adherence: 1, tool: tool ? 1 : null, review: false });
      const summary = summarizeV2(candidate, [fixture], [result], 1);
      expect(summary.complete).toBe(true);
      expect(summary.quality.sampleSize).toBe(1);
      expect(summary.outcomes).toMatchObject({ planned: 1, usable: 1, invalid: 0, timeouts: 0, providerErrors: 0, missing: 0 });
    }
  });
});
