import { describe, expect, it } from "vitest";
import { createCoder } from "./agents/coder.js";
import { createManager } from "./manager.js";

describe("plan vs execute safety", () => {
  it("keeps coder in PLAN mode without execution tools", () => {
    const coder = createCoder(undefined, "Stack: Node.js / TypeScript / Drizzle / Postgres");
    const instructions = String(coder.instructions);
    expect(instructions).toContain("MODE: PLAN");
    expect(instructions).toContain("Never say you built, created, changed, ran, tested, deployed or verified code");
    expect(instructions).toContain("FACT, ASSUMPTION, PROPOSAL and UNKNOWN");
  });

  it("requires the manager to reject unsupported execution claims", () => {
    const manager = createManager(undefined, "Status: live");
    const instructions = String(manager.instructions);
    expect(instructions).toContain("If a specialist claims execution without tool evidence");
    expect(instructions).toContain("labelled as examples or proposals");
  });
});
