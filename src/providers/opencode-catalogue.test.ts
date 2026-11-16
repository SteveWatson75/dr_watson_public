import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogueStore } from "./opencode-catalogue.js";
import type { GoModel } from "./opencode-models.js";

const resources: Array<() => void> = [];
afterEach(() => {
  resources.reverse().forEach((fn) => fn());
  resources.length = 0;
});

function storeInTemp(): { store: CatalogueStore; path: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "watson-catalogue-"));
  const path = join(dir, "catalogue.db");
  const store = new CatalogueStore(path);
  const remove = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  resources.push(remove);
  return { store, path, remove };
}

const model = (id: string, created: number): GoModel => ({
  id,
  created,
  ownedBy: "opencode",
  raw: { id, created, owned_by: "opencode" },
});

describe("OpenCode Go catalogue persistence", () => {
  it("returns undefined before any snapshot has been saved", () => {
    const { store } = storeInTemp();
    expect(store.getPreviousModels()).toBeUndefined();
  });

  it("saves a snapshot and returns it as the previous models", () => {
    const { store } = storeInTemp();
    const checkedAt = "2026-10-18T09:00:00.000Z";
    const models = [model("mimo-v2.6-flash", 1), model("beam-free", 2)];
    store.saveSnapshot(models, { object: "list", data: models }, checkedAt);
    const previous = store.getPreviousModels();
    expect(previous).toHaveLength(2);
    expect(previous!.map((m) => m.id)).toEqual(["mimo-v2.6-flash", "beam-free"]);
    expect(previous![0]!.created).toBe(1);
  });

  it("keeps history so the most recent snapshot wins", () => {
    const { store } = storeInTemp();
    const a = model("a", 1);
    const b = model("b", 2);
    store.saveSnapshot([a], { object: "list", data: [a] }, "2026-10-17T09:00:00.000Z");
    store.saveSnapshot([b], { object: "list", data: [b] }, "2026-10-18T09:00:00.000Z");
    const previous = store.getPreviousModels();
    expect(previous!.map((m) => m.id)).toEqual(["b"]);
  });

  it("marks models not seen in the latest check as inactive but keeps history", () => {
    const { store } = storeInTemp();
    const a = model("a", 1);
    const b = model("b", 2);
    store.saveSnapshot([a, b], { object: "list", data: [a, b] }, "2026-10-17T09:00:00.000Z");
    store.saveSnapshot([a], { object: "list", data: [a] }, "2026-10-18T09:00:00.000Z");
    // getPreviousModels returns the most recent snapshot only ("a").
    expect(store.getPreviousModels()!.map((m) => m.id)).toEqual(["a"]);
  });
});
