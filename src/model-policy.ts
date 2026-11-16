import { z } from "zod";
import candidatesJson from "../config/evaluation-candidates.json" with { type: "json" };

// Shared reviewed metadata, not an automatic model-discovery approval.
export const candidateCatalogueSchema = z.object({
  version: z.literal(1),
  checkedAt: z.iso.date(),
  source: z.url(),
  candidates: z.array(z.object({
    id: z.string().min(1), tiers: z.array(z.enum(["cheap", "standard", "hard"])).min(1),
    training: z.enum(["not-used", "yes", "unknown"]),
    retentionDays: z.number().int().nonnegative().nullable(),
    restrictions: z.string().min(1), blocked: z.boolean().optional(),
    privacyValidThrough: z.iso.date().optional(),
    input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
  }).strict()).min(1),
}).strict().refine((c) => new Set(c.candidates.map((m) => m.id)).size === c.candidates.length, "duplicate candidate");

export const candidateCatalogue = candidateCatalogueSchema.parse(candidatesJson);
export type Candidate = typeof candidateCatalogue.candidates[number];

// An approval is valid through the entire named UTC day. No setting is enabled
// or approval renewed here. Unknown models have no dated approval in this table.
export function privacyApprovalExpired(policy: Pick<Candidate, "privacyValidThrough"> | undefined, now = new Date()): boolean {
  if (!policy?.privacyValidThrough) return false;
  return !Number.isFinite(now.getTime()) || now.getTime() >= Date.parse(policy.privacyValidThrough) + 86400_000;
}
