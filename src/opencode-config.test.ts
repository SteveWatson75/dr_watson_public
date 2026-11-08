import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = JSON.parse(readFileSync(new URL("../opencode.json", import.meta.url), "utf8"));
const compaction = project.compaction ?? {};

describe("OpenCode routed-model context budget", () => {
  it("advertises the smallest Go free window and reserves only the output budget before compaction", () => {
    const { context, output } = project.providers["dr-watson"].models["dr-watson-auto"].limit;
    // Match the smallest OpenCode Go free route (iceman-contributor-free) rather
    // than inflating the window beyond what every route can serve.
    expect(context).toBe(262144);
    expect(output).toBe(8192);
    // An explicit percentage bypasses OpenCode's default 16k buffer floor and
    // still scales safely when another provider/model is selected in this project.
    expect(compaction.buffer).toBe("3.125%");
    const reserved = Math.round(context * Number.parseFloat(compaction.buffer) / 100);
    expect(reserved).toBe(output);
    expect(context - reserved).toBe(253952);
  });

  it("keeps automatic compaction and recent-context retention enabled", () => {
    expect(compaction.auto ?? true).toBe(true);
    expect(compaction.keep?.tokens ?? 15000).toBeGreaterThan(0);
  });
});
