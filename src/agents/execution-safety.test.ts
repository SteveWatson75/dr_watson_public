import { describe, expect, it } from "vitest";
import { createCoder } from "./coder.js";
import { createManager } from "./manager.js";
import { createResearcher } from "./researcher.js";

describe("plan vs execute safety", () => {
  it("keeps coder in PLAN mode without execution tools", () => {
    const coder = createCoder(undefined, "Stack: Node.js / TypeScript / Drizzle / Postgres");
    const instructions = String(coder.instructions);
    expect(instructions).toContain("MODE: PLAN");
    expect(instructions).toContain(
      "Never say you built, created, changed, ran, tested, deployed or verified code",
    );
    expect(instructions).toContain("FACT, ASSUMPTION, PROPOSAL and UNKNOWN");
    expect(instructions).toContain(
      "no repository, filesystem, shell or code-editing execution tool",
    );
    expect(instructions).toContain(
      "an actual execution tool/workspace is attached and the task explicitly grants it",
    );
    expect(instructions).toContain(
      "Claims of changes or tests must cite the tool evidence available in that run",
    );
    expect(coder.tools).toEqual([]);
  });

  it("requires the manager to reject unsupported execution claims", () => {
    const manager = createManager(undefined, "Status: live");
    const instructions = String(manager.instructions);
    expect(instructions).toContain("If a specialist claims execution without tool evidence");
    expect(instructions).toContain("reject that claim and restate the result as a proposal");
    expect(instructions).toContain(
      "Specialists are in PLAN mode unless they have real execution tools",
    );
    expect(instructions).toContain(
      "Never report proposed specialist work as built, created, tested, deployed or verified",
    );
    expect(instructions).toContain("labelled as examples or proposals");
  });

  it.each([false, true])("preserves manager boundaries with CEO mode %s", (ceoMode) => {
    const manager = createManager("test-model", "Status: live", ceoMode);
    const instructions = String(manager.instructions);
    expect(instructions).toContain("Own the conversation and final answer");
    expect(instructions).toContain(
      "Inspect and synthesise specialist work rather than blindly repeating it",
    );
    expect(instructions).toContain("Challenge weak assumptions rather than just agreeing");
    expect(instructions).toContain("prefer experiments and evidence over speculation");
    expect(instructions).toContain("Do not invent product audiences");
    expect(instructions).toContain("State unknowns explicitly");
    expect(instructions).toContain(
      "Do not require or request access to Cloud Run, Cloudflare, billing consoles, deployment accounts or other paid infrastructure",
    );
    expect(instructions).toContain(
      "stop and print the exact simple step-by-step commands or actions for the user",
    );
    expect(manager.model).toBe("test-model");
    expect(manager.tools.map((tool) => tool.name)).toEqual(["research", "code_review"]);
    expect(instructions.includes("CEO mode:")).toBe(ceoMode);
  });

  it("keeps coder infrastructure access and replacement subject to user action and task scope", () => {
    const instructions = String(createCoder().instructions);
    expect(instructions).toContain(
      "Never request access to Cloud Run, Cloudflare, billing consoles or deployment accounts",
    );
    expect(instructions).toContain("Stop and provide exact step-by-step actions for the user");
    expect(instructions).toContain("unless the delegated task explicitly asks for replacement");
    expect(instructions).toContain("is a PROPOSAL, not a fact");
  });

  it.each([createCoder, createResearcher])(
    "keeps specialists tool-free with the supplied model",
    (createSpecialist) => {
      const specialist = createSpecialist("test-model");
      expect(specialist.model).toBe("test-model");
      expect(specialist.tools).toEqual([]);
      expect(String(specialist.instructions)).toContain(
        "No project context was supplied. Do not invent project-specific facts.",
      );
    },
  );
});
