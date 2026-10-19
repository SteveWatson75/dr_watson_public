import { describe, expect, it } from "vitest";
import { createCoder } from "./agents/coder.js";
import { createResearcher } from "./agents/researcher.js";
import { createManager } from "./manager.js";

const context = "Acme is a live product that tracks hiring signals and is already in production.";

describe("context-safe delegation", () => {
  it("injects canonical project context into coder instructions", () => {
    const coder = createCoder(undefined, context);
    expect(String(coder.instructions)).toContain(context);
    expect(String(coder.instructions)).toContain("Do not invent product purpose");
  });

  it("injects canonical project context into researcher instructions", () => {
    const researcher = createResearcher(undefined, context);
    expect(String(researcher.instructions)).toContain(context);
    expect(String(researcher.instructions)).toContain("Do not reinterpret a named project");
  });

  it("tells the manager to respect existing project state", () => {
    const manager = createManager(undefined, context);
    expect(String(manager.instructions)).toContain("canonical current state");
  });
});
