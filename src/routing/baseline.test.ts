import { describe, expect, it } from "vitest";
import { BaselineShadowRouter } from "./baseline.js";

describe("BaselineShadowRouter", () => {
  const router = new BaselineShadowRouter();

  it.each([
    ["fix this TypeScript test error", "coding"],
    ["research the latest competitors and sources", "research"],
    ["how should this business make revenue?", "business"],
    ["what do you think?", "general"],
  ] as const)("routes %s to %s", async (message, expected) => {
    expect((await router.decide(message)).route).toBe(expected);
  });

  it("uses cheap for acknowledgements", async () => {
    expect((await router.decide("done")).modelTier).toBe("cheap");
  });

  it("uses strong for complex work", async () => {
    expect(
      (await router.decide("analyse the architecture trade-offs")).modelTier,
    ).toBe("strong");
  });

  it("uses standard by default", async () => {
    expect((await router.decide("explain this idea")).modelTier).toBe("standard");
  });
});
