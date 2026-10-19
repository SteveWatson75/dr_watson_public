import { expect, it, vi } from "vitest";
import { createInterface } from "node:readline/promises";
import { runConversation } from "./conversation.js";

vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));
vi.mock("./conversation.js", () => ({ runConversation: vi.fn().mockResolvedValue("Advice") }));
vi.mock("./provider.js", () => ({ configureModelProvider: vi.fn() }));
vi.mock("./budget.js", () => ({
  budgetLedger: () => ({ status: () => ({}), close: vi.fn() }),
  formatBudget: () => "Budget unchanged",
}));
vi.mock("./extract-memory.js", () => ({ extractMemories: vi.fn() }));
vi.mock("./memory.js", async (importOriginal) => {
  const { MemoryStore } = await importOriginal<typeof import("./memory.js")>();
  return { MemoryStore: class extends MemoryStore { constructor() { super(":memory:"); } } };
});

it("arms CEO mode across commands, consumes it once, and supports cancellation", async () => {
  const messages = ["/ceo", "/stats", "/use acme", "Recommend a next action",
    "Summarize the plan", "/ceo", "/ceo", "Make a small edit", "exit"];
  const close = vi.fn();
  vi.mocked(createInterface).mockReturnValue({
    question: vi.fn(async () => messages.shift() ?? "exit"), close,
  } as never);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await import("./index.js");
    expect(runConversation).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(runConversation).mock.calls;
    expect(calls[0]![6]).toMatchObject({ ceo: true });
    expect(calls[0]![4]).toBe("No project is currently selected.");
    expect(calls[1]![6]).toMatchObject({ ceo: false });
    expect(calls[2]![6]).toMatchObject({ ceo: false });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
  }
});
