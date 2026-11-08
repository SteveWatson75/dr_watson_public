import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

// USD per million tokens. OpenCode Go is a fixed subscription, so routed Go usage
// is zero incremental cash cost here; Go's own usage limits are enforced upstream.
// This table also prices explicit LLM_MODEL overrides, not only automatic-tier routes.
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "opencode:mimo-v2.6-flash": { input: 0, output: 0 },
  "opencode:glm-5.3-flash": { input: 0, output: 0 },
  "opencode:deepseek-v4.1-flash": { input: 0, output: 0 },
  "opencode:mimo-v2.6-pro": { input: 0, output: 0 },
  "opencode:kimi-k2.7-code": { input: 0, output: 0 },
  "opencode:deepseek-v4-pro": { input: 0, output: 0 },
  "opencode:step-5-preview": { input: 0, output: 0 },
  "opencode:qwen3.8-max": { input: 0, output: 0 },
  "opencode:beam-free": { input: 0, output: 0 },
  "opencode:crouton-alpha-free": { input: 0, output: 0 },
  "opencode:iceman-contributor-free": { input: 0, output: 0 },
  "anthropic:claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "anthropic:claude-sonnet-5-5": { input: 2, output: 10 },
  "gemini:gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "openrouter:openrouter/free": { input: 0, output: 0 },
};

export function estimatedCost(provider: string, model: string, input: number, output: number, date = new Date()): number | undefined {
  if (provider === "ollama") return 0;
  let price = MODEL_PRICING[`${provider}:${model}`];
  if (!price) {
    const inRate = process.env.LLM_INPUT_USD_PER_MILLION;
    const outRate = process.env.LLM_OUTPUT_USD_PER_MILLION;
    if (!inRate?.trim() || !outRate?.trim()) return undefined;
    price = { input: Number(inRate), output: Number(outRate) };
    if (![price.input, price.output].every((v) => Number.isFinite(v) && v >= 0)) return undefined;
  }
  if (model === "claude-haiku-5-5" && input > 100_000) price = { input: 0.5, output: 2.5 };
  if (model === "gemini-3.8-flash" && date >= new Date("2027-01-01T00:00:00Z")) price = { input: 1.5, output: 7.5 };
  return (input * price.input + output * price.output) / 1_000_000;
}

export interface BudgetStatus {
  month: string; spent: number; remaining: number; softLimit: number; hardLimit: number;
  models: Array<{ provider: string; model: string; usd: number; inputTokens: number; outputTokens: number }>;
}

export class BudgetLedger {
  private db: DatabaseSync;
  constructor(path = "data/budget.db", private softLimit = config.softLimit, private hardLimit = config.hardLimit, private now = () => new Date()) {
    if (![softLimit, hardLimit].every((v) => Number.isFinite(v) && v >= 0) || softLimit > hardLimit) throw new Error("Invalid monthly budget limits.");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS costs (
        id INTEGER PRIMARY KEY, month TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        usd REAL NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'reserved'
      );`);
  }
  status(): BudgetStatus {
    const month = this.now().toISOString().slice(0, 7);
    const models = this.db.prepare(`SELECT provider, model, SUM(usd) AS usd,
      SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
      FROM costs WHERE month = ? GROUP BY provider, model`).all(month) as BudgetStatus["models"];
    const spent = models.reduce((sum, item) => sum + item.usd, 0);
    return { month, spent, remaining: Math.max(0, this.hardLimit - spent), softLimit: this.softLimit, hardLimit: this.hardLimit, models };
  }
  reserve(provider: string, model: string, usd: number): number | undefined {
    if (!Number.isFinite(usd) || usd < 0) throw new Error("Invalid request cost.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const status = this.status();
      if (usd > 0 && provider !== "ollama" && (status.spent >= this.hardLimit || usd > status.remaining)) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const result = this.db.prepare("INSERT INTO costs (month, provider, model, usd) VALUES (?, ?, ?, ?)")
        .run(status.month, provider, model, usd);
      this.db.exec("COMMIT");
      return Number(result.lastInsertRowid);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  settle(id: number, usd: number, input: number, output: number): void {
    if (![usd, input, output].every((v) => Number.isFinite(v) && v >= 0)) throw new Error("Invalid token usage; keeping request reservation.");
    this.db.prepare("UPDATE costs SET usd = ?, input_tokens = ?, output_tokens = ?, status = 'complete' WHERE id = ?")
      .run(usd, input, output, id);
  }
  close(): void { this.db.close(); }
}

let ledger: BudgetLedger | undefined;
export function budgetLedger(): BudgetLedger { return ledger ??= new BudgetLedger(); }
export function formatBudget(status: BudgetStatus): string {
  return [
    `Estimated spend (${status.month}, USD): $${status.spent.toFixed(4)}; remaining $${status.remaining.toFixed(4)}`,
    `Soft warning $${status.softLimit.toFixed(2)}; hard limit $${status.hardLimit.toFixed(2)}`,
    ...status.models.map((m) => `  ${m.provider}:${m.model}: $${m.usd.toFixed(4)} (${m.inputTokens} in / ${m.outputTokens} out)`),
    ...(status.spent >= status.hardLimit ? ["Hard budget limit reached: paid calls blocked; free and local routes remain available."]
      : status.spent >= status.softLimit ? ["Warning: monthly soft budget limit reached."] : []),
  ].join("\n");
}
