import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { run } from "@openai/agents";
import { loadCeoContext } from "./context.js";
import { runConversation } from "./conversation.js";
import { manager } from "./manager.js";
import { MemoryStore } from "./memory.js";
import { createRoutedModel } from "./provider.js";

vi.mock("@openai/agents", async (importOriginal) => ({
  ...await importOriginal<typeof import("@openai/agents")>(),
  run: vi.fn(),
}));
vi.mock("./provider.js", () => ({ createRoutedModel: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

let memory: MemoryStore;
beforeEach(() => {
  vi.clearAllMocks();
  memory = new MemoryStore(":memory:");
  vi.mocked(run).mockResolvedValue({
    finalOutput: "Recommended next action",
    state: { usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  } as never);
});
afterEach(() => memory.close());

async function ask(message: string, options = {}) {
  return runConversation(manager, memory, memory.createSession(), message,
    "Canonical selected project: Acme is live.", "", { provider: "auto", ...options });
}

describe("CEO context injection", () => {
  it.each(["Make a small code edit", "Implement this across the repo"])("does not load the pack for %s", async (message) => {
    await ask(message);
    expect(readFile).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(vi.mocked(run).mock.calls[0]![1]).not.toContain("CEO CONTEXT");
    expect(vi.mocked(run).mock.calls[0]![1]).not.toContain("Parked/future concept");
  });

  it.each([
    ["Review the architecture", {}],
    ["Choose our product strategy", {}],
    ["What should we focus on?", { tier: "hard" }],
    ["What should we focus on?", { ceo: true }],
    ["What should we focus on?", { ceo: true, tier: "cheap" }],
  ])("includes the pack alongside project context for %s (%j)", async (message, options) => {
    const pack = "CEO CONTEXT pack for Acme.";
    vi.mocked(readFile).mockResolvedValueOnce(pack);
    await ask(message, options);
    vi.mocked(readFile).mockResolvedValue("");
    const prompt = vi.mocked(run).mock.calls[0]![1];
    expect(prompt).toContain(pack);
    expect(prompt).toContain("Canonical selected project: Acme is live.");
  });

  it("respects explicit cheap routing even for strategy wording", async () => {
    await ask("Choose our business strategy", { tier: "cheap" });
    expect(vi.mocked(run).mock.calls[0]![1]).not.toContain("CEO CONTEXT");
    expect(createRoutedModel).toHaveBeenCalledWith("cheap", "auto", expect.any(Object));
  });

  it("keeps CEO calls on the existing route with provider/tier overrides", async () => {
    await ask("Recommend the next action", { ceo: true, tier: "cheap", provider: "ollama" });
    expect(createRoutedModel).toHaveBeenCalledWith("cheap", "ollama", expect.any(Object));
    expect(String(vi.mocked(run).mock.calls[0]![0].instructions)).toContain("CEO mode:");
  });

  it("does not persist the injected pack into later routine turns", async () => {
    const session = memory.createSession();
    await runConversation(manager, memory, session, "Review architecture", "project", "", { provider: "auto" });
    await runConversation(manager, memory, session, "Make a small edit", "project", "", { provider: "auto" });
    expect(vi.mocked(run).mock.calls[1]![1]).not.toContain("CEO CONTEXT");
    expect(vi.mocked(run).mock.calls[1]![1]).not.toContain("Parked/future concept");
  });

  it("loads a concise pack when present and degrades when absent", async () => {
    const pack = "CEO CONTEXT pack for Acme. Focus on one small action that resolves a commercial uncertainty.";
    vi.mocked(readFile).mockResolvedValueOnce(pack);
    expect(await loadCeoContext()).toBe(pack);
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT: no such file"));
    expect(await loadCeoContext()).toBe("");
  });
});
