import { randomUUID } from "node:crypto";
import {
  OpenAIProvider,
  setDefaultModelProvider,
  setTracingDisabled,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import OpenAI from "openai";
import { config, providerSettings, type LlmProvider, type TaskTier } from "../config.js";
import { budgetLedger, estimatedCost, type BudgetLedger } from "../budget.js";
import { isProviderFailoverError } from "./failover.js";
import { modelRoutes, type ModelRoute } from "../routing/provider-chain.js";
import { estimatedInputTokens, trimHistory, type ExpendableHistory } from "./request-context.js";
import { productionPrivacyEligibility } from "./model-policy.js";

export type ProviderModel = Model;
export type ModelFactory = (route: ModelRoute) => Promise<Model>;

// One record per invocation attempt. A request is only counted once the model
// invocation begins: routes skipped before any provider call (privacy, missing
// key, budget, cooldown) and routes that fail during local provider
// initialization are never attempted, so they are logged as safe fallback
// reasons instead of recorded here. Records never contain prompts, responses,
// credentials or provider error text.
export interface ModelUsageRecord {
  provider: LlmProvider;
  model: string;
  outcome: "used" | "failed";
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}
export type ModelUsageReporter = (record: ModelUsageRecord) => void;

const goSession = `dr-watson-${randomUUID()}`;
const goCooldowns = new Map<string, number>();
const GO_COOLDOWN_MS = 5 * 60 * 60 * 1000;

function goHeaders(provider: LlmProvider) {
  return provider === "opencode"
    ? { "User-Agent": "dr-watson/0.1.0", "x-opencode-session": goSession }
    : undefined;
}

// Anthropic's OpenAI compatibility accepts response_format only as json_schema
// with strict: true, and its structured-output schema subset rejects constraint
// keywords (string length, numeric bounds, array bounds beyond minItems 0/1)
// and unsupported string formats with a terminal HTTP 400. Strip those keywords
// from the wire schema (Anthropic's own SDKs do the same) and force strict.
// Downstream validation is unaffected: the parsed result is still checked
// against the original zod schema by the agent's output type.
const ANTHROPIC_SCHEMA_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);
const ANTHROPIC_SCHEMA_DROP_KEYS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
]);

function anthropicSafeSchema<T>(value: T): T {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) => {
        if (ANTHROPIC_SCHEMA_DROP_KEYS.has(key)) return [];
        if (key === "minItems" && typeof child === "number" && child > 1) return [];
        if (key === "format" && typeof child === "string" && !ANTHROPIC_SCHEMA_FORMATS.has(child))
          return [];
        // These are maps of names to schemas, not schemas themselves. Never
        // remove a user's property named "minimum", "format", etc.
        if (
          ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"].includes(
            key,
          ) &&
          child &&
          typeof child === "object"
        ) {
          return [
            [
              key,
              Object.fromEntries(
                Object.entries(child).map(([name, schema]) => [name, anthropicSafeSchema(schema)]),
              ),
            ],
          ];
        }
        if (["items", "additionalProperties", "not", "if", "then", "else"].includes(key))
          return [[key, anthropicSafeSchema(child)]];
        if (["anyOf", "allOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(child))
          return [[key, child.map((schema) => anthropicSafeSchema(schema))]];
        return [[key, child]];
      }),
    ) as unknown as T;
  }
  return value;
}

function anthropicOutputType(outputType: ModelRequest["outputType"]): ModelRequest["outputType"] {
  if (outputType === "text" || outputType.type !== "json_schema") return outputType;
  return { ...outputType, strict: true, schema: anthropicSafeSchema(outputType.schema) };
}

async function rawModel(route: ModelRoute): Promise<Model> {
  const settings = providerSettings(route.provider, route.model);
  const client = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl,
    maxRetries: 0,
    timeout: 60_000,
    defaultHeaders: goHeaders(route.provider),
  });
  const model = await new OpenAIProvider({
    openAIClient: client,
    useResponses: route.provider === "openai",
  }).getModel(settings.model);
  if (route.provider !== "anthropic" && route.provider !== "gemini") return model;
  return {
    async getResponse(request) {
      const response = await model.getResponse(request);
      // The SDK accepts choices: [] as a successful, empty output. Do not
      // return that as a usable answer (or settle an untrustworthy response).
      if (response.output.length === 0)
        throw new Error(`${route.provider} returned no assistant output.`);
      return response;
    },
    getStreamedResponse: model.getStreamedResponse.bind(model),
  };
}

// Every agent (including nested specialist and extraction calls) uses this wrapper.
export function guardedModel(
  routes: ModelRoute[],
  ledger: BudgetLedger = budgetLedger(),
  factory: ModelFactory = rawModel,
  warn: (message: string) => void = console.warn,
  history?: ExpendableHistory,
  failover: (error: unknown) => boolean = isProviderFailoverError,
  report: ModelUsageReporter | undefined = undefined,
): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      let reason = "Paid providers are unavailable.";
      for (const route of routes) {
        const settings = providerSettings(route.provider, route.model);
        const routeKey = `${route.provider}:${settings.model}`;
        // Check the resolved model, including explicit provider/model overrides.
        // Skip before reserving budget or constructing a prohibited provider.
        const privacyBlocked = () => {
          if (route.provider !== "opencode") return false;
          const privacy = productionPrivacyEligibility(settings.model);
          if (privacy.eligible) return false;
          reason = `${routeKey} ${privacy.reason}.`;
          warn(`${reason} Trying the next configured route.`);
          return true;
        };
        if (privacyBlocked()) continue;
        if (
          route.provider === "opencode" &&
          !productionPrivacyEligibility(settings.model).reviewed
        ) {
          warn(
            `${routeKey} has no reviewed privacy policy; allowing the existing manual-model path, not granting privacy approval.`,
          );
        }
        if (route.provider === "opencode" && (goCooldowns.get(routeKey) ?? 0) > Date.now()) {
          reason = `${routeKey} is cooling down after a Go usage limit.`;
          warn(`${reason} Trying the next configured route.`);
          continue;
        }
        if (!settings.apiKey) {
          reason = `${route.provider} API key is missing.`;
          warn(reason);
          continue;
        }
        // Reasoning-capable coding models can consume much of a 2K completion budget before
        // emitting a tool call. Give OpenCode Go enough room to reason and still act.
        const outputLimit = route.provider === "opencode" ? 8192 : 2048;
        const maxTokens = Math.min(request.modelSettings.maxTokens ?? outputLimit, outputLimit);
        let boundedRequest: ModelRequest = {
          ...request,
          systemInstructions:
            route.provider === "anthropic" && request.outputType !== "text"
              ? `${request.systemInstructions ?? ""}\nReturn only JSON matching this schema: ${JSON.stringify(request.outputType.schema)}`
              : request.systemInstructions,
          outputType:
            route.provider === "anthropic"
              ? anthropicOutputType(request.outputType)
              : request.outputType,
          modelSettings: {
            ...request.modelSettings,
            maxTokens,
            retry: undefined,
            providerData: undefined,
          },
        };
        if (/haiku/i.test(settings.model)) {
          boundedRequest = trimHistory(boundedRequest, history, config.haikuInputLimit);
          if (
            boundedRequest.modelSettings.reasoning?.effort &&
            !["low", "medium"].includes(boundedRequest.modelSettings.reasoning.effort)
          ) {
            boundedRequest = {
              ...boundedRequest,
              modelSettings: {
                ...boundedRequest.modelSettings,
                reasoning: { ...boundedRequest.modelSettings.reasoning, effort: "low" },
              },
            };
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
        const reservedCost = estimatedCost(
          route.provider,
          settings.model,
          inputBound,
          maxTokens,
          pricedAt,
        );
        if (reservedCost === undefined) {
          reason = `No pricing for ${route.provider}:${settings.model}. Set LLM_INPUT_USD_PER_MILLION and LLM_OUTPUT_USD_PER_MILLION locally.`;
          warn(reason);
          continue;
        }
        const id = ledger.reserve(route.provider, settings.model, reservedCost);
        if (id === undefined) {
          reason = "Monthly hard budget limit or remaining request budget reached.";
          warn(`${reason} Trying the next route.`);
          continue;
        }
        const status = ledger.status();
        if (
          route.provider !== "ollama" &&
          status.softLimit > 0 &&
          status.spent >= status.softLimit
        ) {
          warn("Warning: monthly soft budget limit reached.");
        }
        const attemptStartedAt = performance.now();
        let response: ModelResponse;
        let invocationBegan = false;
        try {
          const model = await factory(route);
          // Recheck all privacy restrictions after asynchronous initialization.
          if (privacyBlocked()) continue;
          invocationBegan = true;
          response = await model.getResponse(boundedRequest);
        } catch (error) {
          // Provider construction failures are local initialization problems,
          // not model invocations, so a failed attempt is only reported once the
          // invocation has begun. Fallback behavior and warnings are unchanged.
          if (invocationBegan) {
            report?.({
              provider: route.provider,
              model: settings.model,
              outcome: "failed",
              durationMs: Math.round(performance.now() - attemptStartedAt),
              inputTokens: 0,
              outputTokens: 0,
            });
          }
          const statusCode =
            error && typeof error === "object" && "status" in error
              ? Number(error.status)
              : undefined;
          if (route.provider === "opencode" && statusCode === 429) {
            goCooldowns.set(routeKey, Date.now() + GO_COOLDOWN_MS);
            warn(`${routeKey} hit a Go usage limit; cooling it down for 5 hours.`);
          }
          const providerFailure = failover(error);
          if (route.provider === "ollama") {
            throw new Error(
              `${reason} Local Ollama is unavailable. Run \`ollama pull ${settings.model}\` and \`ollama serve\`, then retry.`,
              { cause: error },
            );
          }
          if (!providerFailure) throw error;
          reason = `${route.provider}:${settings.model} is unavailable.`;
          warn(`${reason} Trying the next configured route.`);
          continue;
        }
        // Accounting and reporting run outside the provider-failure path: their
        // errors are bugs, not upstream provider failures, so they must not be
        // classified as such or trigger a fallback.
        const usage = response.usage;
        if (
          usage &&
          Number.isFinite(usage.inputTokens) &&
          Number.isFinite(usage.outputTokens) &&
          usage.inputTokens >= 0 &&
          usage.outputTokens >= 0 &&
          ((usage.inputTokens > 0 && usage.outputTokens > 0) ||
            route.provider === "ollama" ||
            route.provider === "opencode")
        ) {
          const actual = estimatedCost(
            route.provider,
            settings.model,
            usage.inputTokens,
            usage.outputTokens,
            pricedAt,
          );
          if (actual !== undefined)
            ledger.settle(id, actual, usage.inputTokens, usage.outputTokens);
        }
        const settledStatus = ledger.status();
        if (
          route.provider !== "ollama" &&
          settledStatus.softLimit > 0 &&
          settledStatus.spent >= settledStatus.softLimit
        ) {
          warn("Warning: monthly soft budget limit reached.");
        }
        report?.({
          provider: route.provider,
          model: settings.model,
          outcome: "used",
          durationMs: Math.round(performance.now() - attemptStartedAt),
          inputTokens:
            usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
              ? usage.inputTokens
              : 0,
          outputTokens:
            usage && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0
              ? usage.outputTokens
              : 0,
        });
        return response;
      }
      throw new Error(`${reason} No usable local fallback is configured.`);
    },
    async *getStreamedResponse() {
      throw new Error(
        "Streaming is disabled so each request can be budgeted and recorded before continuing.",
      );
    },
  };
}

export function createRoutedModel(
  tier: TaskTier,
  override: LlmProvider | "auto" = config.provider,
  history?: ExpendableHistory,
  report?: ModelUsageReporter,
): Model {
  return guardedModel(
    modelRoutes(tier, override),
    undefined,
    undefined,
    undefined,
    history,
    undefined,
    report,
  );
}

export function configureModelProvider(): void {
  setTracingDisabled(true);
  setDefaultModelProvider({ getModel: async () => createRoutedModel("cheap") });
}
