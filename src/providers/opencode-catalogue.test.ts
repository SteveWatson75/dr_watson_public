import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogueStore } from "./opencode-catalogue.js";

const resources: Array<() => void> = [];
afterEach(() => {
  resources.reverse().forEach((fn) => fn());
  resources.length = 0;
});

function tempDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "watson-catalogue-"));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  resources.push(() => db.close());
  return db;
}

function openStore(path: string): CatalogueStore {
  const store = new CatalogueStore(path);
  resources.push(() => store.close());
  return store;
}

const model = (id: string, created = 1) => ({
  id,
  object: "model",
  created,
  owned_by: "opencode",
});
const catalogue = (...models: ReturnType<typeof model>[]) => ({ object: "list", data: models });
const firstCheck = "2026-10-17T09:00:00.000Z";
const nextCheck = "2026-10-18T09:00:00.000Z";

function snapshots(db: DatabaseSync) {
  return db.prepare("SELECT * FROM model_catalogue_snapshots ORDER BY id").all();
}

describe("OpenCode Go catalogue persistence", () => {
  it("saves and reads initial and subsequent snapshots without creating the legacy table", () => {
    const path = join(tempDirectory(), "catalogue.db");
    const store = openStore(path);
    const db = openDatabase(path);
    expect(store.getPreviousModels()).toBeUndefined();
    const first = catalogue(model("mimo-v2.6-flash"), model("beam-free", 2));
    store.saveSnapshot(first, firstCheck);
    expect(store.getPreviousModels()!.map((m) => m.id)).toEqual(["mimo-v2.6-flash", "beam-free"]);
    expect(store.getPreviousModels()![0]!.created).toBe(1);
    const next = catalogue(model("mimo-v2.6-flash", 3));
    store.saveSnapshot(next, nextCheck);
    // Repeated successful checks remain separate historical observations.
    store.saveSnapshot(next, "2026-10-19T09:00:00.000Z");
    expect(store.getPreviousModels()!.map((m) => m.id)).toEqual(["mimo-v2.6-flash"]);
    expect(snapshots(db).map((row) => JSON.parse(row.raw_json as string))).toEqual([
      first,
      next,
      next,
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'model_catalogue'").all(),
    ).toEqual([]);
  });

  it("opens a legacy database without changing its table, rows, indexes or historical snapshots", () => {
    const path = join(tempDirectory(), "catalogue.db");
    const db = openDatabase(path);
    db.exec(`
      CREATE TABLE model_catalogue (
        provider TEXT NOT NULL, model_id TEXT NOT NULL, name TEXT, metadata TEXT NOT NULL,
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (provider, model_id)
      );
      CREATE TABLE model_catalogue_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, checked_at TEXT NOT NULL,
        provider TEXT NOT NULL, raw_json TEXT NOT NULL
      );
      INSERT INTO model_catalogue VALUES
        ('opencode', 'retired', 'Old model', '{"id":"retired"}', 'first', 'last', 0),
        ('opencode', 'beam-free', 'Beam', '{"id":"beam-free"}', 'first', 'last', 1);
      CREATE TRIGGER reject_legacy_insert BEFORE INSERT ON model_catalogue
        BEGIN SELECT RAISE(ABORT, 'legacy insert'); END;
      CREATE TRIGGER reject_legacy_update BEFORE UPDATE ON model_catalogue
        BEGIN SELECT RAISE(ABORT, 'legacy update'); END;
      CREATE TRIGGER reject_legacy_delete BEFORE DELETE ON model_catalogue
        BEGIN SELECT RAISE(ABORT, 'legacy delete'); END;
    `);
    db.prepare(
      "INSERT INTO model_catalogue_snapshots (checked_at, provider, raw_json) VALUES (?, ?, ?)",
    ).run(firstCheck, "opencode", JSON.stringify(catalogue(model("retired"))));
    const rows = db.prepare("SELECT * FROM model_catalogue ORDER BY model_id").all();
    const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const history = snapshots(db);
    const store = openStore(path);
    expect(store.getPreviousModels()![0]!.id).toBe("retired");
    store.saveSnapshot(catalogue(model("beam-free", 2), model("new")), nextCheck);
    expect(store.getPreviousModels()!.map((m) => m.id)).toEqual(["beam-free", "new"]);
    expect(db.prepare("SELECT * FROM model_catalogue ORDER BY model_id").all()).toEqual(rows);
    expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(snapshots(db).slice(0, 1)).toEqual(history);
    expect(snapshots(db)).toHaveLength(2);
  });

  it("rolls back failed snapshot writes and can save again without losing history", () => {
    const path = join(tempDirectory(), "catalogue.db");
    const store = openStore(path);
    const db = openDatabase(path);
    const raw = catalogue(model("beam-free"));
    store.saveSnapshot(raw, firstCheck);
    const history = snapshots(db);
    db.exec(`
      CREATE TRIGGER reject_snapshot BEFORE INSERT ON model_catalogue_snapshots
        WHEN NEW.checked_at = '${nextCheck}'
        BEGIN SELECT RAISE(ABORT, 'snapshot write rejected'); END;
    `);
    expect(() => store.saveSnapshot(catalogue(model("new")), nextCheck)).toThrow(
      "snapshot write rejected",
    );
    expect(snapshots(db)).toEqual(history);
    expect(store.getPreviousModels()![0]!.id).toBe("beam-free");
    // Serialization failures also roll back and release the transaction.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => store.saveSnapshot(circular, firstCheck)).toThrow();
    expect(snapshots(db)).toEqual(history);
    store.saveSnapshot(raw, "2026-10-19T09:00:00.000Z");
    expect(snapshots(db)).toHaveLength(2);
    expect(store.getPreviousModels()![0]!.id).toBe("beam-free");
  });
});

describe("check-models offline command", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const approvedPath = join(root, "config/models.json");

  function runCheck(cwd: string, raw: unknown, status = 200, json = true) {
    const mockPath = join(cwd, "mock-fetch.mjs");
    writeFileSync(
      mockPath,
      `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(raw))}, { status: ${status} });`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        mockPath,
        "--import",
        join(root, "node_modules/tsx/dist/loader.mjs"),
        join(root, "src/check-models.ts"),
        ...(json ? ["--json"] : []),
      ],
      {
        cwd,
        env: {
          ...process.env,
          OPENCODE_API_KEY: "offline-test-key",
          DOTENV_CONFIG_PATH: join(cwd, ".env"),
        },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    return result;
  }

  it("reports first-run candidates, additions, removals and changes without changing approved routes", () => {
    const dir = tempDirectory();
    const approved = readFileSync(approvedPath, "utf8");
    const first = runCheck(dir, catalogue(model("beam-free"), model("retired")));
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      added: ["beam-free", "retired"],
      removed: [],
      changed: [],
      candidates: ["retired"],
    });
    const next = catalogue(model("beam-free", 2), model("unapproved-new"));
    const result = runCheck(dir, next);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      total: 2,
      added: ["unapproved-new"],
      removed: ["retired"],
      changed: [{ model: "beam-free", field: "created", old: 1, new: 2 }],
      candidates: ["unapproved-new"],
    });
    const repeated = runCheck(dir, next);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      added: [],
      removed: [],
      changed: [],
      candidates: [],
    });
    const text = runCheck(dir, next, 200, false);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("No changes since the last check.");
    expect(readFileSync(approvedPath, "utf8")).toBe(approved);
    const db = openDatabase(join(dir, "data/catalogue.db"));
    expect(snapshots(db)).toHaveLength(4);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'model_catalogue'").all(),
    ).toEqual([]);
  });

  it("leaves the last valid snapshot intact after malformed responses and failed fetches", () => {
    const dir = tempDirectory();
    expect(runCheck(dir, catalogue(model("beam-free"))).status).toBe(0);
    const db = openDatabase(join(dir, "data/catalogue.db"));
    const history = snapshots(db);
    for (const raw of [
      null,
      { object: "wrong", data: [] },
      { object: "list", data: {} },
      { object: "list", data: [null] },
    ]) {
      const result = runCheck(dir, raw);
      expect(result.status).toBe(1);
      expect(snapshots(db)).toEqual(history);
    }
    const failed = runCheck(dir, { error: "unavailable" }, 503);
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).error).toContain("503");
    expect(snapshots(db)).toEqual(history);
    const store = openStore(join(dir, "data/catalogue.db"));
    expect(store.getPreviousModels()![0]!.id).toBe("beam-free");
    expect(runCheck(dir, catalogue(model("beam-free"))).status).toBe(0);
    expect(snapshots(db)).toHaveLength(2);
  });
});
