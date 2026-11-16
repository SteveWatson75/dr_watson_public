import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeGoModels, type GoCatalogueRaw, type GoModel } from "./opencode-models.js";

const DEFAULT_DB_PATH = "data/catalogue.db";
const PROVIDER = "opencode";

export class CatalogueStore {
  private db: DatabaseSync;
  constructor(path = DEFAULT_DB_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_catalogue_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checked_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
    `);
  }

  // Returns the models from the most recent snapshot, or undefined when this is
  // the first-ever check. Callers diff this against the newly fetched catalogue.
  getPreviousModels(): GoModel[] | undefined {
    const row = this.db.prepare(
      "SELECT raw_json FROM model_catalogue_snapshots WHERE provider = ? ORDER BY checked_at DESC LIMIT 1"
    ).get(PROVIDER) as { raw_json: string } | undefined;
    if (!row) return undefined;
    let raw: GoCatalogueRaw;
    try {
      raw = JSON.parse(row.raw_json) as GoCatalogueRaw;
    } catch {
      return undefined;
    }
    return normalizeGoModels(raw);
  }

  saveSnapshot(raw: unknown, checkedAt: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT INTO model_catalogue_snapshots (checked_at, provider, raw_json) VALUES (?, ?, ?)"
      ).run(checkedAt, PROVIDER, JSON.stringify(raw));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
