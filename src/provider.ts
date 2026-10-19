import { randomUUID } from "node:crypto";
import { OpenAIProvider, setDefaultModelProvider, setTracingDisabled, type Model, type ModelRequest, type ModelResponse } from "@openai/agents";
import OpenAI from "openai";
import { config, providerSettings, type LlmProvider, type TaskTier } from "./config.js";
import { budgetLedger, estimatedCost, type BudgetLedger } from "./budget.js";
import { isProviderFailoverError } from "./failover.js";
import { modelRoutes, type ModelRoute } from "./provider-chain.js";
import { estimatedInputTokens, trimHistory, type ExpendableHistory } from "./haiku-context.js";

export type ProviderModel = Model;
export type ModelFactory = (route: ModelRoute) => Promise<Model>;

const goSession = `dr-watson-${randomUUID()}`;
const goCooldowns = new Map<string, number>();
const GO_COOLDOWN_MS = 5 * 60 * 60 * 1000;

function goHeaders(provider: LlmProvider) {
  return provider === "opencode"
    ? { "User-Agent": "dr-watson/0.1.0", "x-opencode-session": goSession }
    : undefined;
}

async function rawModel(route: ModelRoute): Promise<Model> {
  const settings = providerSettings(route.provider, route.model);
  const client = new OpenAI({
    apiKey: settings.apiKey, baseURL: settings.baseUrl,
    maxRetries: 0, timeout: 60_000, defaultHeaders: goHeaders(route.provider),
  });
  return new OpenAIProvider({ openAIClient: client, useResponses: route.provider === "openai" }).getModel(settings.model);
}

// Every agent (including nested specialist and extraction calls) uses this wrapper.
export function guardedModel(
  routes: ModelRoute[],
  ledger: BudgetLedger = budgetLedger(),
  factory: ModelFactory = rawModel,
  warn: (message: string) => void = console.warn,
  history?: ExpendableHistory,
): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      let reason = "Paid providers are unavailable.";
      for (const route of routes) {
        const settings = providerSettings(route.provider, route.model);
        const routeKey = `${route.provider}:${settings.model}`;
        if (route.provider === "opencode" && (goCooldowns.get(routeKey) ?? 0) > Date.now()) {
          reason = `${routeKey} is cooling down after a Go usage limit.`;
          warn(`${reason} Trying the next configured route.`);
          continue;
        }
        if (!settings.apiKey) { reason = `${route.provider} API key is missing.`; warn(reason); continue; }
        // Reasoning-capable coding models can consume much of a 2K completion budget before
        // emitting a tool call. Give OpenCode Go enough room to reason and still act.
        const outputLimit = route.provider === "opencode" ? 8192 : 2048;
        const maxTokens = Math.min(request.modelSettings.maxTokens ?? outputLimit, outputLimit);
        let boundedRequest: ModelRequest = {
          ...request,
          systemInstructions: route.provider === "anthropic" && request.outputType !== "text"
            ? `${request.systemInstructions ?? ""}\nReturn only JSON matching this schema: ${JSON.stringify(request.outputType.schema)}`
            : request.systemInstructions,
          modelSettings: { ...request.modelSettings, maxTokens, retry: undefined, providerData: undefined },
        };
        if (/haiku/i.test(settings.model)) {
          boundedRequest = trimHistory(boundedRequest, history, config.haikuInputLimit);
          if (boundedRequest.modelSettings.reasoning?.effort && !["low", "medium"].includes(boundedRequest.modelSettings.reasoning.effort)) {
            boundedRequest = { ...boundedRequest, modelSettings: { ...boundedRequest.modelSettings,
              reasoning: { ...boundedRequest.modelSettings.reasoning, effort: "low" } } };
          }
          const size = estimatedInputTokens(boundedRequest);
          if (size > config.haikuInputLimit) {
            reason = `Haiku skipped: estimated input ${size} tokens exceeds context threshold ${config.haikuInputLimit}.`;
            warn(`${reason} Trying the next configured route.`);
            continue;
          }
        }
        const inputBound = Buffer.byteLength(JSON.stringify(boundedRequest)) + 4096;
        const pricedAt = new Date();
        const reservedCost = estimatedCost(route.provider, settings.model, inputBound, maxTokens, pricedAt);
        if (reservedCost === undefined) {
          reason = `No pricing for ${route.provider}:${settings.model}. Set LLM_INPUT_USD_PER_MILLION and LLM_OUTPUT_USD_PER_MILLION locally.`;
          warn(reason);
          continue;
        }
        const id = ledger.reserve(route.provider, settings.model, reservedCost);
        if (id === undefined) { reason = "Monthly hard budget limit or remaining request budget reached."; warn(`${reason} Trying the next route.`); continue; }
        const status = ledger.status();
        if (route.provider !== "ollama" && status.softLimit > 0 && status.spent >= status.softLimit) {
          warn("Warning: monthly soft budget limit reached.");
        }
        try {
          const model = await factory(route);
          const response = await model.getResponse(boundedRequest);
          const usage = response.usage;
          if (usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)
            && usage.inputTokens >= 0 && usage.outputTokens >= 0
            && ((usage.inputTokens > 0 && usage.outputTokens > 0) || route.provider === "ollama" || route.provider === "opencode")) {
            const actual = estimatedCost(route.provider, settings.model, usage.inputTokens, usage.outputTokens, pricedAt);
            if (actual !== undefined) ledger.settle(id, actual, usage.inputTokens, usage.outputTokens);
          }
          const settledStatus = ledger.status();
          if (route.provider !== "ollama" && settledStatus.softLimit > 0 && settledStatus.spent >= settledStatus.softLimit) {
            warn("Warning: monthly soft budget limit reached.");
          }
          return response;
        } catch (error) {
          const statusCode = error && typeof error === "object" && "status" in error ? Number(error.status) : undefined;
          if (route.provider === "opencode" && statusCode === 429) {
            goCooldowns.set(routeKey, Date.now() + GO_COOLDOWN_MS);
            warn(`${routeKey} hit a Go usage limit; cooling it down for 5 hours.`);
          }
          const providerFailure = isProviderFailoverError(error);
          if (route.provider === "ollama") {
            throw new Error(`${reason} Local Ollama is unavailable. Run \`ollama pull ${settings.model}\` and \`ollama serve\`, then retry.`, { cause: error });
          }
          if (!providerFailure) throw error;
          reason = `${route.provider}:${settings.model} is unavailable.`;
          warn(`${reason} Trying the next configured route.`);
        }
      }
      throw new Error(`${reason} No usable local fallback is configured.`);
    },
    async *getStreamedResponse() {
      throw new Error("Streaming is disabled so each request can be budgeted and recorded before continuing.");
    },
  };
}

export async function createProviderModel(provider: LlmProvider, model?: string): Promise<ProviderModel> {
  return guardedModel(provider === "ollama" ? [{ provider }] : [{ provider, model }, { provider: "ollama" }]);
}

export function createRoutedModel(tier: TaskTier, override: LlmProvider | "auto" = config.provider, history?: ExpendableHistory): Model {
  return guardedModel(modelRoutes(tier, override), undefined, undefined, undefined, history);
}

export function configureModelProvider(): void {
  setTracingDisabled(true);
  setDefaultModelProvider({ getModel: async () => createRoutedModel("cheap") });
}
