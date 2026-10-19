import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { Usage, type ModelRequest } from "@openai/agents";
import { z } from "zod";
import { PROVIDERS, providerApiKey, providerSettings, type TaskTier } from "./config.js";
import { budgetLedger, type BudgetLedger } from "./budget.js";
import { guardedModel } from "./provider.js";
import { modelRoutes, taskTier } from "./provider-chain.js";
import type { ModelRoute } from "./provider-chain.js";

export const LOCAL_MODEL = "dr-watson-auto";
const fallbackGoSession = `dr-watson-local-${randomUUID()}`;
const sessionTiers = new Map<string, TaskTier>();
const sessionRoutes = new Map<string, ModelRoute>();
const content = z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }))]);
const toolCall = z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string() }) });
const message = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: content.nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
  tool_calls: z.array(toolCall).optional(), tool_call_id: z.string().optional(), name: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.role === "tool" && !value.tool_call_id) ctx.addIssue({ code: "custom", message: "Tool messages require tool_call_id." });
  if (value.content == null && !(value.role === "assistant" && (value.tool_calls?.length || value.reasoning_content || value.reasoning))) ctx.addIssue({ code: "custom", message: "Message content is required." });
  if (value.tool_calls && value.role !== "assistant") ctx.addIssue({ code: "custom", message: "Only assistant messages may contain tool_calls." });
});
const completionRequest = z.object({
  model: z.literal(LOCAL_MODEL), messages: z.array(message).min(1), stream: z.boolean().optional(),
  n: z.literal(1).optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({
    name: z.string(), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()), strict: z.boolean().nullable().optional(),
  }) })).optional(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) })]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
});
type CompletionInput = z.infer<typeof completionRequest>;
type ChatMessage = CompletionInput["messages"][number];
export type CompletionTransport = (route: ModelRoute, body: OpenAI.ChatCompletionCreateParamsNonStreaming, sessionId?: string) => Promise<OpenAI.ChatCompletion>;

const transport: CompletionTransport = async (route, body, sessionId) => {
  const settings = providerSettings(route.provider, route.model);
  const client = new OpenAI({
    apiKey: settings.apiKey, baseURL: settings.baseUrl, maxRetries: 0, timeout: 60_000,
    defaultHeaders: route.provider === "opencode"
      ? { "User-Agent": "dr-watson/0.1.0", "x-opencode-session": sessionId ?? fallbackGoSession }
      : undefined,
  });
  return client.chat.completions.create(body);
};

const tierRank: Record<TaskTier, number> = { cheap: 0, standard: 1, hard: 2 };
const continuationOnly = /^(?:continue|go on|proceed|carry on|keep going|do it|go ahead|yes|ok|okay)[.!\s]*$/i;
// Mirrors provider-chain CODE_REVIEW_REQUEST so bounded-mode review requests can be
// detected here without importing the routing module.
const REVIEW_REQUEST = /\b(?:code review|(?:pull request|pr) review|review(?:ing)? (?:of )?(?:(?:this|the|my|these) )?(?:pull request|pr|code|changes|diff))\b/i;
export const BOUNDED_REVIEW_MARKER = /BOUNDED REVIEW MODE/;
const BOUNDED_REVIEW_INSTRUCTION = `BOUNDED REVIEW MODE: Review only the PR description, the linked issue, and the file diff already provided. Do not call tools, fetch additional files or commits, or search. Write the review now and end with **Approved** or **Has blocking changes needed**.`;

function messageText(value: ChatMessage): string {
  return typeof value.content === "string" ? value.content
    : value.content?.map((part) => part.text).join("\n") ?? "";
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function isOpenCodeStateSummary(text: string): boolean {
  const markers = ["objective", "requirements", "work state", "next move"];
  const lower = text.toLowerCase();
  return markers.filter((marker) => new RegExp(`(?:^|\\n)#{0,3}\\s*${marker}\\s*(?:\\n|$)`, "i").test(lower)).length >= 3;
}

export function isOpenCodeCompactionRequest(messages: CompletionInput["messages"]): boolean {
  const lastUser = [...messages].reverse().find((item) => item.role === "user");
  const text = lastUser ? messageText(lastUser) : "";
  return /(?:consolidated summary|update the existing checkpoint|compaction summary|summarize the conversation into)/i.test(text);
}

function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^#{0,3}\\s*${heading}\\s*$`, "i").test(line.trim()));
  if (start < 0) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,3}\s*[A-Za-z]/.test(lines[i]!.trim()) && lines[i]!.trim().length < 80) break;
    body.push(lines[i]!);
  }
  return body.join("\n").trim();
}

function completedContext(text: string): string {
  const completed = section(text, "Completed");
  if (!completed) return "";
  return `OpenCode progress already completed (context only; do not restart it):\n${completed}`;
}

function summaryTask(text: string): string {
  const objective = section(text, "Objective");
  const requirements = section(text, "Requirements");
  return [objective && `Objective:\n${objective}`, requirements && `Requirements:\n${requirements}`].filter(Boolean).join("\n\n");
}

export function prepareOpenCodeMessages(messages: CompletionInput["messages"]): CompletionInput["messages"] {
  if (isOpenCodeCompactionRequest(messages)) return messages;
  const summaries = messages.filter((item) => isOpenCodeStateSummary(messageText(item)));
  const genuineUsers = messages.filter((item) => item.role === "user" && !isOpenCodeStateSummary(messageText(item))
    && !continuationOnly.test(messageText(item).trim()));
  const anchor = genuineUsers.length ? messageText(genuineUsers[0]!) : summaryTask(messageText(summaries.at(-1) ?? messages[0]!));
  const latestProgress = completedContext(messageText(summaries.at(-1) ?? messages[0]!));
  const seenUsers = new Set<string>();
  const result: CompletionInput["messages"] = [];
  let injectedAnchor = false;

  for (const item of messages) {
    const text = messageText(item);
    const stateSummary = isOpenCodeStateSummary(text);
    if (stateSummary && !(item.role === "assistant" && item.tool_calls?.length)) continue;
    if (item.role === "user") {
      if (continuationOnly.test(text.trim())) continue;
      const key = normalized(text);
      if (seenUsers.has(key)) continue;
      seenUsers.add(key);
    }
    if (!injectedAnchor && anchor && item.role !== "system" && item.role !== "developer") {
      result.push({ role: "developer", content: `Task anchor (original user intent):\n${anchor}\n\nStay focused on this task until completion. Do not restart completed reconnaissance unless a concrete tool/test failure requires it.` });
      if (latestProgress) result.push({ role: "developer", content: latestProgress });
      injectedAnchor = true;
    }
    result.push(item);
  }

  if (!injectedAnchor && anchor) {
    result.push({ role: "developer", content: `Task anchor (original user intent):\n${anchor}\n\nStay focused on this task until completion. Do not restart completed reconnaissance unless a concrete tool/test failure requires it.` });
    if (latestProgress) result.push({ role: "developer", content: latestProgress });
    if (!genuineUsers.length) result.push({ role: "user", content: anchor });
  } else if (!genuineUsers.length && anchor && !result.some((item) => item.role === "user")) {
    result.push({ role: "user", content: anchor });
  }
  return result;
}

// GitHub Actions runs are bounded on purpose: review and owner-comment tasks must
// not be re-anchored to a coding task, because that anchoring drives the agent back
// into open-ended reconnaissance. This path keeps the caller's messages (minus
// continuation noise) and never injects a task anchor or a synthetic user turn.
// When a review request is detected, a boundary developer message is injected that
// forbids tool use and requires a single-pass review from the provided context,
// which is what actually breaks the continual research loop.
export function prepareGithubActionMessages(messages: CompletionInput["messages"]): CompletionInput["messages"] {
  const seenUsers = new Set<string>();
  const result: CompletionInput["messages"] = [];
  const alreadyHasBoundary = messages.some((item) => BOUNDED_REVIEW_MARKER.test(messageText(item)));
  let reviewDetected = false;
  let boundaryInjected = alreadyHasBoundary;

  for (const item of messages) {
    const text = messageText(item);

    if (item.role === "user") {
      if (continuationOnly.test(text.trim())) continue;
      const key = normalized(text);
      if (seenUsers.has(key)) continue;
      seenUsers.add(key);
      if (REVIEW_REQUEST.test(text)) reviewDetected = true;
    }

    if (
      reviewDetected &&
      !boundaryInjected &&
      item.role !== "system" &&
      item.role !== "developer"
    ) {
      result.push({ role: "developer", content: BOUNDED_REVIEW_INSTRUCTION });
      boundaryInjected = true;
    }

    result.push(item);
  }

  return result;
}

export function conversationTier(messages: CompletionInput["messages"], fallback?: TaskTier, githubAction = false): TaskTier {
  const prepared = githubAction ? prepareGithubActionMessages(messages) : prepareOpenCodeMessages(messages);
  let selected: TaskTier = fallback ?? "cheap";
  for (const item of prepared) {
    // Once OpenCode starts invoking tools, this is an agentic task rather than a
    // routine chat, even when the original request did not match a routing keyword.
    if (item.role === "tool" || (item.role === "assistant" && item.tool_calls?.length)) {
      if (tierRank.standard > tierRank[selected]) selected = "standard";
      continue;
    }
    if (item.role !== "user" && item.role !== "developer") continue;
    const candidate = taskTier(messageText(item));
    if (tierRank[candidate] > tierRank[selected]) selected = candidate;
  }
  return selected;
}

function rememberSessionTier(sessionId: string | undefined, tier: TaskTier): void {
  if (!sessionId) return;
  const previous = sessionTiers.get(sessionId);
  if (!previous || tierRank[tier] > tierRank[previous]) sessionTiers.set(sessionId, tier);
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

export async function routedCompletion(input: CompletionInput, options: {
  ledger?: BudgetLedger; transport?: CompletionTransport; log?: (line: string) => void; sessionId?: string;
  githubAction?: boolean;
} = {}): Promise<{ completion: OpenAI.ChatCompletion; route: string }> {
  const compaction = isOpenCodeCompactionRequest(input.messages);
  const rememberedTier = options.sessionId ? sessionTiers.get(options.sessionId) : undefined;
  const rememberedRoute = options.sessionId ? sessionRoutes.get(options.sessionId) : undefined;
  const tier = conversationTier(input.messages, rememberedTier, options.githubAction);
  rememberSessionTier(options.sessionId, tier);
  const preparedMessages = rememberedRoute || compaction ? input.messages
    : options.githubAction ? prepareGithubActionMessages(input.messages)
    : prepareOpenCodeMessages(input.messages);
  const routes = sessionModelRoutes(tier, options.sessionId);
  let selectedRoute = "";
  const model = guardedModel(routes, options.ledger ?? budgetLedger(), async (route) => ({
    async getResponse(request) {
      const settings = providerSettings(route.provider, route.model);
      const { stream_options: _streamOptions, max_completion_tokens: _maxCompletion, ...body } = JSON.parse(String(request.input)) as CompletionInput;
      selectedRoute = `${route.provider}:${settings.model}`;
      (options.log ?? console.info)(`Local API tier: ${tier}; route: ${selectedRoute}`);
      const messages = route.provider === "opencode"
        ? body.messages.map((message) => message.role === "developer" ? { ...message, role: "system" as const } : message)
        : body.messages;
      const completion = await (options.transport ?? transport)(route, {
        ...body, messages, model: settings.model, stream: false, max_tokens: request.modelSettings.maxTokens,
      } as OpenAI.ChatCompletionCreateParamsNonStreaming, options.sessionId);
      rememberSessionRoute(options.sessionId, route);
      return { output: [], usage: new Usage({ requests: 1, inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0 }), providerData: { completion } };
    },
    async *getStreamedResponse() { throw new Error("Provider streaming is disabled."); },
  }));
  const preparedInput: CompletionInput = { ...input, messages: preparedMessages };
  const request: ModelRequest = { input: JSON.stringify(preparedInput), modelSettings: {
    maxTokens: Math.min(input.max_tokens ?? 8192, input.max_completion_tokens ?? 8192, 8192),
  }, tools: [], handoffs: [], outputType: "text", tracing: false };
  const result = await model.getResponse(request);
  return { completion: result.providerData!.completion as OpenAI.ChatCompletion, route: selectedRoute };
}

function publicCompletion(completion: OpenAI.ChatCompletion) {
  return { id: completion.id || `chatcmpl-${randomUUID()}`, object: "chat.completion", created: completion.created,
    model: LOCAL_MODEL, choices: completion.choices.map((choice) => {
      const upstream = choice.message as unknown as { reasoning_content?: string | null; reasoning?: string | null };
      return { index: choice.index, finish_reason: choice.finish_reason,
        message: { role: "assistant", content: choice.message.content,
          ...(upstream.reasoning_content != null ? { reasoning_content: upstream.reasoning_content } : {}),
          ...(upstream.reasoning != null ? { reasoning: upstream.reasoning } : {}),
          ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}) } };
    }),
    ...(completion.usage ? { usage: completion.usage } : {}) };
}

function streamCompletion(completion: ReturnType<typeof publicCompletion>, includeUsage: boolean): string {
  const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk",
    created: completion.created, model: LOCAL_MODEL, choices, ...(usage ? { usage } : {}) })}\n\n`;
  let result = "";
  for (const choice of completion.choices) {
    result += chunk([{ index: choice.index, delta: { ...choice.message,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((tool, index) => ({ ...tool, index })) } : {}) }, finish_reason: null }]);
    result += chunk([{ index: choice.index, delta: {}, finish_reason: choice.finish_reason }]);
  }
  if (includeUsage && completion.usage) result += chunk([], completion.usage);
  return `${result}data: [DONE]\n\n`;
}

// Upstream provider failures can echo request credentials back in their error
// text. Redact every configured credential plus common credential shapes before
// anything leaves the local API so callers only ever see a safe hint.
const credentialShapes = /(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,}|authorization\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi;

function configuredCredentials(): string[] {
  const keys = new Set<string>();
  for (const provider of PROVIDERS) {
    const key = providerApiKey(provider);
    // Skip the synthetic Ollama placeholder and anything too short to be a real secret.
    if (key && key !== provider && key.length >= 8) keys.add(key);
  }
  return [...keys];
}

export function redactProviderError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message) parts.push(current.message);
    current = current.cause;
  }
  let message = parts.join(" ").trim() || "No routed provider completed the request.";
  for (const key of configuredCredentials()) message = message.split(key).join("[REDACTED]");
  return message.replace(credentialShapes, "[REDACTED]");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Review and owner-comment jobs opt into the bounded GitHub Actions mode with the
// `x-dr-watson-mode: github-action` request header or a `DR_WATSON_MODE` environment
// variable on the local API process. Implementation jobs omit both and keep the
// normal coding-session anchoring.
export function isGithubActionMode(headers: Record<string, string | string[] | undefined>, env: string | undefined): boolean {
  return headerValue(headers["x-dr-watson-mode"]) === "github-action" || env === "github-action";
}

export function createLocalApi(options: Parameters<typeof routedCompletion>[1] = {}): Server {
  return createServer(async (req, res) => {
    const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.origin || !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? "")) {
      json(403, { error: { message: "Only local CLI requests are allowed.", type: "invalid_request_error" } }); return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      json(200, { object: "list", data: [{ id: LOCAL_MODEL, object: "model", created: 0, owned_by: "dr-watson" }] }); return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      json(404, { error: { message: "Unknown endpoint.", type: "invalid_request_error" } }); return;
    }
    let body: CompletionInput;
    try {
      const buffers: Buffer[] = [];
      let size = 0;
      for await (const buffer of req) {
        size += buffer.length;
        if (size > 4 * 1024 * 1024) { json(413, { error: { message: "Request exceeds 4 MiB.", type: "invalid_request_error" } }); return; }
        buffers.push(buffer);
      }
      body = completionRequest.parse(JSON.parse(Buffer.concat(buffers).toString("utf8")));
    } catch {
      json(400, { error: { message: "Invalid request. Use dr-watson-auto with text messages and optional function tools.", type: "invalid_request_error" } }); return;
    }
    try {
      const sessionId = headerValue(req.headers["x-opencode-session"]);
      const githubAction = isGithubActionMode(req.headers, process.env.DR_WATSON_MODE);
      const { completion, route } = await routedCompletion(body, { ...options, sessionId, githubAction });
      res.setHeader("x-dr-watson-route", route);
      const result = publicCompletion(completion);
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(streamCompletion(result, Boolean(body.stream_options?.include_usage)));
      } else json(200, result);
    } catch (error) {
      json(502, { error: { message: redactProviderError(error), type: "server_error" } }); return;
    }
  });
}
