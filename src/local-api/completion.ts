import { randomUUID } from "node:crypto";
import { Usage, type ModelRequest } from "@openai/agents";
import OpenAI from "openai";
import { providerSettings, type TaskTier } from "../config.js";
import { budgetLedger, type BudgetLedger } from "../budget.js";
import { guardedModel } from "../providers/provider.js";
import { modelRoutes, type ModelRoute } from "../routing/provider-chain.js";
import {
  conversationTier,
  isOpenCodeCompactionRequest,
  prepareGithubActionMessages,
  prepareOpenCodeMessages,
  TIER_RANK,
} from "./messages.js";
import type { CompletionInput } from "./protocol.js";

export type CompletionTransport = (
  route: ModelRoute,
  body: OpenAI.ChatCompletionCreateParamsNonStreaming,
  sessionId?: string,
) => Promise<OpenAI.ChatCompletion>;

export interface CompletionOptions {
  ledger?: BudgetLedger;
  transport?: CompletionTransport;
  log?: (line: string) => void;
  sessionId?: string;
  githubAction?: boolean;
  // Dedicated trusted review entrypoint supplies policy/context, never caller messages.
  reviewRoutes?: ModelRoute[];
  failover?: (error: unknown) => boolean;
}

const fallbackGoSession = `dr-watson-local-${randomUUID()}`;
const sessionTiers = new Map<string, TaskTier>();
const sessionRoutes = new Map<string, ModelRoute>();

const transport: CompletionTransport = async (route, body, sessionId) => {
  const settings = providerSettings(route.provider, route.model);
  const client = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl,
    maxRetries: 0,
    timeout: 60_000,
    defaultHeaders:
      route.provider === "opencode"
        ? { "User-Agent": "dr-watson/0.1.0", "x-opencode-session": sessionId ?? fallbackGoSession }
        : undefined,
  });
  return client.chat.completions.create(body);
};

function rememberSessionTier(sessionId: string | undefined, tier: TaskTier): void {
  if (!sessionId) return;
  const previous = sessionTiers.get(sessionId);
  if (!previous || TIER_RANK[tier] > TIER_RANK[previous]) sessionTiers.set(sessionId, tier);
  if (sessionTiers.size > 1000) sessionTiers.delete(sessionTiers.keys().next().value!);
}

function routeKey(route: ModelRoute): string {
  return `${route.provider}:${route.model ?? ""}`;
}

function sessionModelRoutes(tier: TaskTier, sessionId: string | undefined): ModelRoute[] {
  const routes = modelRoutes(tier);
  const preferred = sessionId ? sessionRoutes.get(sessionId) : undefined;
  if (!preferred) return routes;
  const preferredKey = routeKey(preferred);
  // Preserve a route only while it belongs to the current tier. Otherwise an
  // earlier cheap route would block a later session-tier upgrade indefinitely.
  if (!routes.some((route) => routeKey(route) === preferredKey)) return routes;
  return [preferred, ...routes.filter((route) => routeKey(route) !== preferredKey)];
}

function rememberSessionRoute(sessionId: string | undefined, route: ModelRoute): void {
  if (!sessionId) return;
  sessionRoutes.set(sessionId, route);
  if (sessionRoutes.size > 1000) sessionRoutes.delete(sessionRoutes.keys().next().value!);
}

export async function routedCompletion(
  input: CompletionInput,
  options: CompletionOptions = {},
): Promise<{ completion: OpenAI.ChatCompletion; route: string }> {
  const compaction = isOpenCodeCompactionRequest(input.messages);
  const rememberedTier = options.sessionId ? sessionTiers.get(options.sessionId) : undefined;
  const rememberedRoute = options.sessionId ? sessionRoutes.get(options.sessionId) : undefined;
  const tier = conversationTier(input.messages, rememberedTier, options.githubAction);
  rememberSessionTier(options.sessionId, tier);
  const preparedMessages =
    options.reviewRoutes || rememberedRoute || compaction
      ? input.messages
      : options.githubAction
        ? prepareGithubActionMessages(input.messages)
        : prepareOpenCodeMessages(input.messages);
  const routes = options.reviewRoutes ?? sessionModelRoutes(tier, options.sessionId);
  let selectedRoute = "";
  const model = guardedModel(
    routes,
    options.ledger ?? budgetLedger(),
    async (route) => ({
      async getResponse(request) {
        const settings = providerSettings(route.provider, route.model);
        const {
          stream_options: _streamOptions,
          max_completion_tokens: _maxCompletion,
          ...body
        } = JSON.parse(String(request.input)) as CompletionInput;
        selectedRoute = `${route.provider}:${settings.model}`;
        (options.log ?? console.info)(`Local API tier: ${tier}; route: ${selectedRoute}`);
        const messages =
          route.provider === "opencode"
            ? body.messages.map((message) =>
                message.role === "developer" ? { ...message, role: "system" as const } : message,
              )
            : body.messages;
        const completion = await (options.transport ?? transport)(
          route,
          {
            ...body,
            messages,
            model: settings.model,
            stream: false,
            max_tokens: request.modelSettings.maxTokens,
          } as OpenAI.ChatCompletionCreateParamsNonStreaming,
          options.sessionId,
        );
        rememberSessionRoute(options.sessionId, route);
        return {
          output: [],
          usage: new Usage({
            requests: 1,
            inputTokens: completion.usage?.prompt_tokens ?? 0,
            outputTokens: completion.usage?.completion_tokens ?? 0,
          }),
          providerData: { completion },
        };
      },
      async *getStreamedResponse() {
        throw new Error("Provider streaming is disabled.");
      },
    }),
    undefined,
    undefined,
    options.failover,
  );
  const preparedInput: CompletionInput = { ...input, messages: preparedMessages };
  const request: ModelRequest = {
    input: JSON.stringify(preparedInput),
    modelSettings: {
      maxTokens: Math.min(input.max_tokens ?? 8192, input.max_completion_tokens ?? 8192, 8192),
    },
    tools: [],
    handoffs: [],
    outputType: "text",
    tracing: false,
  };
  const result = await model.getResponse(request);
  return {
    completion: result.providerData!.completion as OpenAI.ChatCompletion,
    route: selectedRoute,
  };
}
