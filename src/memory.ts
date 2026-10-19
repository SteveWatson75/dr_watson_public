import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface Memory {
  id: number;
  project?: string;
  content: string;
}

export interface Stats {
  runs: number;
  successfulRuns: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  averageDurationMs: number;
  providerModels: Array<{
    model: string;
    runs: number;
    successfulRuns: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    averageDurationMs: number;
  }>;
  routes: Array<{ provider: string; route: string; count: number }>;
  tiers: Array<{ provider: string; modelTier: string; count: number }>;
}

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(path = "data/dr-watson.db") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        route TEXT NOT NULL,
        model_tier TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        duration_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
  }

  createSession(project?: string): number {
    const result = this.db
      .prepare("INSERT INTO sessions (project) VALUES (?)")
      .run(project ?? null);
    return Number(result.lastInsertRowid);
  }

  setProject(sessionId: number, project?: string): void {
    this.db
      .prepare("UPDATE sessions SET project = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(project ?? null, sessionId);
  }

  addMessage(sessionId: number, role: Role, content: string): void {
    this.db
      .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
      .run(sessionId, role, content);
    this.db
      .prepare("UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(sessionId);
  }

  getRecentMessages(sessionId: number, limit = 20): Message[] {
    const rows = this.db
      .prepare(`
        SELECT role, content
        FROM messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(sessionId, limit) as Array<{ role: Role; content: string }>;

    return rows.reverse();
  }

  addMemory(content: string, project?: string): number {
    const result = this.db
      .prepare("INSERT INTO memories (project, content) VALUES (?, ?)")
      .run(project ?? null, content);
    return Number(result.lastInsertRowid);
  }

  hasMemory(content: string, project?: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM memories WHERE content = ? AND project IS ? LIMIT 1")
      .get(content, project ?? null);
    return Boolean(row);
  }

  searchMemories(query: string, project?: string, limit = 5): Memory[] {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9åäö]{3,}/g) ?? [])].slice(0, 12);
    if (!terms.length) return [];

    const rows = this.db
      .prepare(`
        SELECT id, project, content
        FROM memories
        WHERE project IS NULL OR project = ?
        ORDER BY id DESC
      `)
      .all(project ?? null) as Array<{ id: number; project: string | null; content: string }>;

    return rows
      .map((row) => ({
        memory: { id: row.id, project: row.project ?? undefined, content: row.content },
        score: terms.reduce((score, term) => score + (row.content.toLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.id - a.memory.id)
      .slice(0, limit)
      .map((item) => item.memory);
  }

  addRoutingDecision(input: {
    sessionId: number;
    provider: string;
    model?: string;
    route: string;
    modelTier: string;
    durationMs: number;
  }): void {
    this.db.prepare(`
      INSERT INTO routing_decisions (
        session_id, provider, model, route, model_tier, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.provider,
      input.model ?? null,
      input.route,
      input.modelTier,
      input.durationMs,
    );
  }

  addAgentRun(input: {
    sessionId: number;
    agent: string;
    model?: string;
    durationMs: number;
    success: boolean;
    requests?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO agent_runs (
        session_id, agent, model, duration_ms, success,
        requests, input_tokens, output_tokens, total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.agent,
      input.model ?? null,
      input.durationMs,
      input.success ? 1 : 0,
      input.requests ?? 0,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.totalTokens ?? 0,
    );
  }

  getStats(): Stats {
    const usage = this.db.prepare(`
      SELECT
        COUNT(*) AS runs,
        COALESCE(SUM(success), 0) AS successfulRuns,
        COALESCE(SUM(requests), 0) AS requests,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        COALESCE(AVG(duration_ms), 0) AS averageDurationMs
      FROM agent_runs
    `).get() as Record<string, number>;

    const providerModels = this.db.prepare(`
      SELECT
        COALESCE(model, 'unknown') AS model,
        COUNT(*) AS runs,
        COALESCE(SUM(success), 0) AS successfulRuns,
        COALESCE(SUM(requests), 0) AS requests,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        COALESCE(AVG(duration_ms), 0) AS averageDurationMs
      FROM agent_runs
      GROUP BY model
      ORDER BY runs DESC, model
    `).all().map((row) => {
      const item = row as Record<string, string | number>;
      return {
        model: String(item.model),
        runs: Number(item.runs),
        successfulRuns: Number(item.successfulRuns),
        requests: Number(item.requests),
        inputTokens: Number(item.inputTokens),
        outputTokens: Number(item.outputTokens),
        totalTokens: Number(item.totalTokens),
        averageDurationMs: Math.round(Number(item.averageDurationMs)),
      };
    });

    const routes = this.db.prepare(`
      SELECT provider, route, COUNT(*) AS count
      FROM routing_decisions
      GROUP BY provider, route
      ORDER BY provider, count DESC, route
    `).all() as Stats["routes"];

    const tiers = this.db.prepare(`
      SELECT provider, model_tier AS modelTier, COUNT(*) AS count
      FROM routing_decisions
      GROUP BY provider, model_tier
      ORDER BY provider, count DESC, model_tier
    `).all() as Stats["tiers"];

    return {
      runs: Number(usage.runs),
      successfulRuns: Number(usage.successfulRuns),
      requests: Number(usage.requests),
      inputTokens: Number(usage.inputTokens),
      outputTokens: Number(usage.outputTokens),
      totalTokens: Number(usage.totalTokens),
      averageDurationMs: Math.round(Number(usage.averageDurationMs)),
      providerModels,
      routes,
      tiers,
    };
  }

  close(): void {
    this.db.close();
  }
}
