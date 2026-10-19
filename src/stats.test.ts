import { describe, expect, it } from "vitest";
import { formatStats } from "./stats.js";

describe("formatStats", () => {
  it("formats usage, distributions and agreement", () => {
    const output = formatStats({
      runs: 10,
      successfulRuns: 9,
      requests: 12,
      inputTokens: 1000,
      outputTokens: 250,
      totalTokens: 1250,
      averageDurationMs: 321,
      providerModels: [{ model: "gemini:gemini-3.7-flash", runs: 2, successfulRuns: 1, requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 140, averageDurationMs: 500 }],
      routes: [{ provider: "baseline", route: "coding", count: 4 }],
      tiers: [{ provider: "baseline", modelTier: "standard", count: 4 }],
    });

    expect(output).toContain("1,250 total");
    expect(output).toContain("gemini:gemini-3.7-flash");
    expect(output).toContain("success 50%; failed 1");
    expect(output).toContain("140 total (100 in / 20 out)");
    expect(output).toContain("baseline: coding = 4");
  });

  it("handles an empty database", () => {
    const output = formatStats({
      runs: 0,
      successfulRuns: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      averageDurationMs: 0,
      providerModels: [],
      routes: [],
      tiers: [],
    });

    expect(output).toContain("No data yet.");
  });
});
