import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eligibility } from "./model-evaluation.js";
import { candidateCatalogue } from "./model-policy.js";
import { normalizeGoModels, type GoCatalogueRaw } from "./opencode-models.js";
import { evaluationFixturesV2 } from "./evaluation-fixtures-v2.js";

const snapshot = JSON.parse(readFileSync(new URL("../docs/evaluations/catalogue-2026-11-16-r2.json", import.meta.url), "utf8"));
const models = normalizeGoModels(snapshot.raw as GoCatalogueRaw);
const checkedAt = new Date(snapshot.checkedAt);

describe("round 2 coverage against refreshed discovery", () => {
  it("keeps every reviewed non-training candidate discoverable with tool support", () => {
    for (const candidate of candidateCatalogue.candidates.filter((c) => c.training === "not-used" && !c.blocked && c.retentionDays !== null)) {
      expect(eligibility(candidate, models, checkedAt), candidate.id).toEqual([]);
    }
  });

  it("records models documented by Go but absent from discovery as unavailable", () => {
    const ids = new Set(models.map((model) => model.id));
    for (const id of ["mimo-v2.5", "mimo-v2.5-pro"]) expect(ids.has(id)).toBe(false);
  });

  it("keeps every tier plan within the per-invocation request limit", () => {
    for (const tier of ["cheap", "standard", "hard"] as const) {
      const eligible = candidateCatalogue.candidates.filter((candidate) => candidate.tiers.includes(tier) && eligibility(candidate, models, checkedAt).length === 0);
      expect(eligible.length).toBeGreaterThan(0);
      expect(eligible.length * evaluationFixturesV2.filter((fixture) => fixture.tier === tier).length * 2).toBeLessThanOrEqual(100);
    }
  });
});
