import { describe, expect, it, vi } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { listProjects, loadProjectContext } from "./context.js";

vi.mock("node:fs/promises");

describe("project context", () => {
  it("lists project directories only", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: "acme", isDirectory: () => true },
      { name: "README.md", isDirectory: () => false },
      { name: "signal", isDirectory: () => true },
    ] as never);

    await expect(listProjects()).resolves.toEqual(["acme", "signal"]);
  });

  it("loads available context files", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce("# Acme" as never)
      .mockResolvedValueOnce("Use the local market first." as never)
      .mockRejectedValueOnce(new Error("missing"));

    await expect(loadProjectContext("acme")).resolves.toContain("Use the local market first.");
  });
});
