import "dotenv/config";
import { modelCatalogue, PROVIDERS, type LlmProvider } from "./model-catalogue.js";

export { PROVIDERS, type LlmProvider, type TaskTier } from "./model-catalogue.js";

export const providerDefaults: Record<LlmProvider, { model: string; baseUrl: string }> = Object.fromEntries(
  modelCatalogue.providers.map(({ id, defaultModel, baseUrl }) => [id, { model: defaultModel, baseUrl }]),
) as Record<LlmProvider, { model: string; baseUrl: string }>;

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}
const selected = process.env.LLM_PROVIDER || "auto";
if (selected !== "auto" && !PROVIDERS.includes(selected as LlmProvider)) {
  throw new Error(`LLM_PROVIDER must be auto or ${PROVIDERS.join(", ")}.`);
}
export const config = {
  provider: selected as LlmProvider | "auto",
  model: process.env.LLM_MODEL || undefined,
  autoMemory: process.env.AUTO_MEMORY === "true",
  softLimit: limit("LLM_MONTHLY_SOFT_LIMIT_USD", 15),
  hardLimit: limit("LLM_MONTHLY_HARD_LIMIT_USD", 20),
  haikuInputLimit: limit("LLM_HAIKU_INPUT_LIMIT", 80_000),
};

export function providerApiKey(provider: LlmProvider): string | undefined {
  if (provider === "ollama") return "ollama";
  return process.env[`${provider.toUpperCase()}_API_KEY`];
}

export function providerSettings(provider: LlmProvider, model?: string) {
  const selected = provider === config.provider;
  const baseUrl = selected && process.env.LLM_BASE_URL
    ? process.env.LLM_BASE_URL : providerDefaults[provider].baseUrl;
  if (provider === "ollama" && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname)) {
    throw new Error("Ollama must use a local loopback URL for the zero-cost fallback.");
  }
  return {
    model: selected && config.model ? config.model : model ?? providerDefaults[provider].model,
    baseUrl,
    apiKey: providerApiKey(provider),
  };
}

export function assertConfig(): void {
  if (config.haikuInputLimit <= 0 || config.haikuInputLimit >= 100_000) throw new Error("LLM_HAIKU_INPUT_LIMIT must be above 0 and below 100000.");
  if (config.softLimit > config.hardLimit) throw new Error("Monthly soft limit must not exceed the hard limit.");
  if (config.model && config.provider === "auto") throw new Error("Set LLM_PROVIDER explicitly when using LLM_MODEL.");
  providerSettings("ollama");
}

export function setupMessages(): string[] {
  return [
    !providerApiKey("opencode") && "OpenCode Go is unavailable: copy OPENCODE_API_KEY into local .env.",
    !providerApiKey("openrouter") && "OpenRouter free route is unavailable: copy OPENROUTER_API_KEY into local .env.",
    !providerApiKey("gemini") && "Gemini is unavailable: create/fund a Gemini API account and copy GEMINI_API_KEY into local .env.",
    !providerApiKey("anthropic") && "Anthropic is unavailable: create/fund an Anthropic API account and copy ANTHROPIC_API_KEY into local .env.",
    "Local fallback: run `ollama pull llama3.2:3b`, then `ollama serve` if Ollama is not already running.",
  ].filter((line): line is string => Boolean(line));
}
