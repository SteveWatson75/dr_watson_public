import { describe, expect, it } from "vitest";
import { shouldExtractMemory } from "./memory-policy.js";

describe("shouldExtractMemory", () => {
  it("is disabled by default", () => {
    expect(shouldExtractMemory(false, "A durable decision that should otherwise qualify for memory.", "response")).toBe(false);
  });

  it("ignores acknowledgements", () => {
    expect(shouldExtractMemory(true, "merged", "x".repeat(500))).toBe(false);
  });

  it("allows substantive exchanges", () => {
    expect(shouldExtractMemory(true, "We decided total delivered cost should determine the cheapest basket.", "response")).toBe(true);
  });
});
