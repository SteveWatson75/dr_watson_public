import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMemoryStats, type Stats } from "./memory-stats.js";

export type { Stats } from "./memory-stats.js";

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

      CREATE TABLE IF NOT EXISTS model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_run_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('used', 'failed')),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
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
      .prepare(
        `
        SELECT role, content
        FROM messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      `,
      )
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
      .prepare(
        `
        SELECT id, project, content
        FROM memories
        WHERE project IS NULL OR project = ?
        ORDER BY id DESC
      `,
      )
      .all(project ?? null) as Array<{ id: number; project: string | null; content: string }>;

    return rows
      .map((row) => ({
        memory: { id: row.id, project: row.project ?? undefined, content: row.content },
        score: terms.reduce(
          (score, term) => score + (row.content.toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
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
    this.db
      .prepare(
        `
      INSERT INTO routing_decisions (
        session_id, provider, model, route, model_tier, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
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
  }): number {
    const result = this.db
      .prepare(
        `
      INSERT INTO agent_runs (
        session_id, agent, model, duration_ms, success,
        requests, input_tokens, output_tokens, total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
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
    return Number(result.lastInsertRowid);
  }

  // One row per model invocation attempt inside an agent run. Only provider and
  // model identifiers, outcome and numeric usage are stored: never prompts,
  // responses, credentials or provider error text.
  addModelUsage(input: {
    agentRunId: number;
    sessionId: number;
    provider: string;
    model?: string;
    outcome: "used" | "failed";
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
  }): void {
    this.db
      .prepare(
        `
      INSERT INTO model_usage (
        agent_run_id, session_id, provider, model, outcome,
        duration_ms, input_tokens, output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        input.agentRunId,
        input.sessionId,
        input.provider,
        input.model ?? null,
        input.outcome,
        input.durationMs,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
      );
  }

  getStats(): Stats {
    return getMemoryStats(this.db);
  }

  close(): void {
    this.db.close();
  }
}
