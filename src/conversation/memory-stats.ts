import type { DatabaseSync } from "node:sqlite";

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

export function getMemoryStats(db: DatabaseSync): Stats {
  const usage = db
    .prepare(
      `
      SELECT
        COUNT(*) AS runs,
        COALESCE(SUM(success), 0) AS successfulRuns,
        COALESCE(SUM(requests), 0) AS requests,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        COALESCE(AVG(duration_ms), 0) AS averageDurationMs
      FROM agent_runs
    `,
    )
    .get() as Record<string, number>;

  // Provider/model performance comes from per-invocation model_usage rows so
  // tokens and latency follow the model that actually served each call. Runs
  // recorded before model_usage existed have no invocation rows and keep their
  // original agent_runs attribution, so existing databases stay readable.
  const providerModels = db
    .prepare(
      `
      SELECT
        model,
        SUM(runs) AS runs,
        SUM(successfulRuns) AS successfulRuns,
        SUM(requests) AS requests,
        SUM(inputTokens) AS inputTokens,
        SUM(outputTokens) AS outputTokens,
        SUM(totalTokens) AS totalTokens,
        SUM(totalDurationMs) AS totalDurationMs
      FROM (
        SELECT
          provider || ':' || COALESCE(model, 'default') AS model,
          COUNT(*) AS runs,
          SUM(CASE WHEN outcome = 'used' THEN 1 ELSE 0 END) AS successfulRuns,
          COUNT(*) AS requests,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
          COALESCE(SUM(duration_ms), 0) AS totalDurationMs
        FROM model_usage
        GROUP BY provider, model
        UNION ALL
        SELECT
          COALESCE(model, 'unknown') AS model,
          COUNT(*) AS runs,
          COALESCE(SUM(success), 0) AS successfulRuns,
          COALESCE(SUM(requests), 0) AS requests,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COALESCE(SUM(duration_ms), 0) AS totalDurationMs
        FROM agent_runs
        WHERE NOT EXISTS (SELECT 1 FROM model_usage WHERE model_usage.agent_run_id = agent_runs.id)
        GROUP BY model
      )
      GROUP BY model
      ORDER BY runs DESC, model
    `,
    )
    .all()
    .map((row) => ({
      model: String(row.model),
      runs: Number(row.runs),
      successfulRuns: Number(row.successfulRuns),
      requests: Number(row.requests),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      totalTokens: Number(row.totalTokens),
      averageDurationMs: Math.round(Number(row.totalDurationMs) / Number(row.runs)),
    }));

  const routes = db
    .prepare(
      `
      SELECT provider, route, COUNT(*) AS count
      FROM routing_decisions
      GROUP BY provider, route
      ORDER BY provider, count DESC, route
    `,
    )
    .all() as Stats["routes"];

  const tiers = db
    .prepare(
      `
      SELECT provider, model_tier AS modelTier, COUNT(*) AS count
      FROM routing_decisions
      GROUP BY provider, model_tier
      ORDER BY provider, count DESC, model_tier
    `,
    )
    .all() as Stats["tiers"];

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
