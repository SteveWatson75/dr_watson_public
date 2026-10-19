import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoCatalogue, normalizeGoModels, diffCatalogues, type GoModel } from "./opencode-models.js";

const resources: Array<() => void> = [];
afterEach(() => {
  resources.reverse().forEach((fn) => fn());
  resources.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const catalogue = {
  object: "list" as const,
  data: [
    { id: "mimo-v2.6-flash", object: "model", created: 1792402142, owned_by: "opencode" },
    { id: "beam-free", object: "model", created: 1792402142, owned_by: "opencode" },
  ],
};

function stubFetch(response: unknown, status = 200): void {
  const body = JSON.stringify(response);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } }))
  );
}

describe("OpenCode Go catalogue discovery", () => {
  it("fetches and validates the catalogue", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "test-key");
    stubFetch(catalogue);
    const raw = await fetchGoCatalogue();
    expect(raw.object).toBe("list");
    expect(raw.data).toHaveLength(2);
    expect(raw.data[0]!.id).toBe("mimo-v2.6-flash");
  });

  it("throws a clear error when the OpenCode API key is missing", async () => {
    const original = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      stubFetch(catalogue);
      await expect(fetchGoCatalogue()).rejects.toThrow("OPENCODE_API_KEY");
    } finally {
      if (original === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = original;
    }
  });

  it("throws on a non-ok upstream response", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "test-key");
    stubFetch({ error: "not found" }, 404);
    await expect(fetchGoCatalogue()).rejects.toThrow("404");
  });

  it("uses a custom fetch function when provided", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "test-key");
    const custom = vi.fn(async () => new Response(JSON.stringify(catalogue), { status: 200 }));
    const raw = await fetchGoCatalogue({ fetchFn: custom });
    expect(custom).toHaveBeenCalledTimes(1);
    expect(raw.data).toHaveLength(2);
  });

  it("normalizes catalogue entries into GoModel records", () => {
    const models = normalizeGoModels(catalogue);
    expect(models).toEqual([
      { id: "mimo-v2.6-flash", created: 1792402142, ownedBy: "opencode", raw: catalogue.data[0] },
      { id: "beam-free", created: 1792402142, ownedBy: "opencode", raw: catalogue.data[1] },
    ]);
  });

  it("detects added, removed and changed models", () => {
    const previous: GoModel[] = [
      { id: "mimo-v2.6-flash", created: 1, ownedBy: "opencode", raw: { id: "mimo-v2.6-flash", created: 1 } },
      { id: "beam-free", created: 1, ownedBy: "opencode", raw: { id: "beam-free", created: 1 } },
    ];
    const current: GoModel[] = [
      { id: "mimo-v2.6-flash", created: 2, ownedBy: "opencode", raw: { id: "mimo-v2.6-flash", created: 2 } },
      { id: "kimi-k3", created: 1, ownedBy: "opencode", raw: { id: "kimi-k3", created: 1 } },
    ];
    const diff = diffCatalogues(previous, current);
    expect(diff.added.map((m) => m.id)).toEqual(["kimi-k3"]);
    expect(diff.removed.map((m) => m.id)).toEqual(["beam-free"]);
    expect(diff.changed).toEqual([
      { model: "mimo-v2.6-flash", field: "created", old: 1, new: 2 },
    ]);
  });

  it("reports no diff when the catalogue is unchanged", () => {
    const models: GoModel[] = [
      { id: "mimo-v2.6-flash", created: 1, ownedBy: "opencode", raw: { id: "mimo-v2.6-flash", created: 1 } },
    ];
    const diff = diffCatalogues(models, models);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("treats every model as added when there is no previous catalogue", () => {
    const current: GoModel[] = [
      { id: "mimo-v2.6-flash", created: 1, ownedBy: "opencode", raw: { id: "mimo-v2.6-flash" } },
    ];
    const diff = diffCatalogues([], current);
    expect(diff.added.map((m) => m.id)).toEqual(["mimo-v2.6-flash"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});
