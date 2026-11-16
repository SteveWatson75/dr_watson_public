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
      CREATE TABLE IF NOT EXISTS model_catalogue (
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT,
        metadata TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (provider, model_id)
      );
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

  saveSnapshot(models: GoModel[], raw: unknown, checkedAt: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Everything not seen in this check is marked inactive; the upsert below
      // reactivates the models that are still present.
      this.db.prepare("UPDATE model_catalogue SET active = 0 WHERE provider = ?").run(PROVIDER);
      const upsert = this.db.prepare(`
        INSERT INTO model_catalogue (provider, model_id, name, metadata, first_seen, last_seen, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(provider, model_id) DO UPDATE SET
          name = excluded.name,
          metadata = excluded.metadata,
          last_seen = excluded.last_seen,
          active = 1
      `);
      for (const model of models) {
        upsert.run(PROVIDER, model.id, model.id, JSON.stringify(model.raw), checkedAt, checkedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.prepare(
      "INSERT INTO model_catalogue_snapshots (checked_at, provider, raw_json) VALUES (?, ?, ?)"
    ).run(checkedAt, PROVIDER, JSON.stringify(raw));
  }

  close(): void { this.db.close(); }
}
