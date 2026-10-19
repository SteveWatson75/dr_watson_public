import type { Stats } from "./memory.js";

function percent(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)}%` : "n/a";
}

function distribution(
  rows: Array<{ provider: string; count: number } & Record<string, unknown>>,
  key: string,
): string[] {
  if (!rows.length) return ["  No data yet."];
  return rows.map(
    (row) => `  ${row.provider}: ${String(row[key])} = ${row.count}`,
  );
}

export function formatStats(stats: Stats): string {
  return [
    "Dr Watson stats",
    "",
    "Agent usage",
    `  Runs: ${stats.runs} (${stats.successfulRuns} successful)`,
    `  Requests: ${stats.requests}`,
    `  Tokens: ${stats.totalTokens.toLocaleString()} total (${stats.inputTokens.toLocaleString()} in / ${stats.outputTokens.toLocaleString()} out)`,
    `  Average latency: ${stats.averageDurationMs} ms`,
    "",
    "Provider/model performance",
    ...(stats.providerModels.length
      ? stats.providerModels.flatMap((item) => [
          `  ${item.model}`,
          `    Runs: ${item.runs}; success ${percent(item.successfulRuns, item.runs)}; failed ${item.runs - item.successfulRuns}`,
          `    Requests: ${item.requests}; avg latency ${item.averageDurationMs} ms`,
          `    Tokens: ${item.totalTokens.toLocaleString()} total (${item.inputTokens.toLocaleString()} in / ${item.outputTokens.toLocaleString()} out)`,
        ])
      : ["  No data yet."]),
    "",
    "Route decisions",
    ...distribution(stats.routes, "route"),
    "",
    "Model tiers",
    ...distribution(stats.tiers, "modelTier"),
  ].join("\n");
}
