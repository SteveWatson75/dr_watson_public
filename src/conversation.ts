import { Agent, run } from "@openai/agents";
import { config, type TaskTier, type LlmProvider } from "./config.js";
import { createManager } from "./manager.js";
import { createRoutedModel } from "./provider.js";
import { taskTier, modelRoutes } from "./provider-chain.js";
import { MemoryStore } from "./memory.js";
import { loadCeoContext } from "./context.js";
import { BaselineShadowRouter } from "./routing/baseline.js";
import type { ShadowRouter } from "./routing/types.js";

const shadowRouters: ShadowRouter[] = [
  new BaselineShadowRouter(),
];

async function recordShadowRoutes(
  memory: MemoryStore,
  sessionId: number,
  message: string,
): Promise<void> {
  const decisions = await Promise.allSettled(
    shadowRouters.map((router) => router.decide(message)),
  );

  for (const result of decisions) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const decision = result.value;
    memory.addRoutingDecision({
      sessionId,
      provider: decision.provider,
      model: decision.model,
      route: decision.route,
      modelTier: decision.modelTier,
      durationMs: decision.durationMs,
    });
  }
}

export async function runConversation(
  _agent: Agent,
  memory: MemoryStore,
  sessionId: number,
  message: string,
  projectContext: string,
  relevantMemories: string,
  options: { tier?: TaskTier; provider?: LlmProvider | "auto"; ceo?: boolean } = {},
): Promise<string> {
  const tier = options.tier ?? (options.ceo ? "hard" : taskTier(message));
  const ceoContext = tier === "hard" || options.ceo ? await loadCeoContext() : "";
  const recentConversation = memory
    .getRecentMessages(sessionId)
    .map((item) => `${item.role.toUpperCase()}: ${item.content}`);

  memory.addMessage(sessionId, "user", message);

  await recordShadowRoutes(memory, sessionId, message);

  const render = (history: string[]) => [
    ...(ceoContext ? ["CEO CONTEXT", ceoContext, ""] : []),
    "PROJECT CONTEXT",
    projectContext,
    "",
    "RELEVANT LONG-TERM MEMORY",
    relevantMemories || "No relevant long-term memories found.",
    "",
    "RECENT CONVERSATION",
    history.join("\n") || "No previous messages in this session.",
    "",
    "USER REQUEST",
    message,
  ].join("\n");
  const prompt = render(recentConversation);

  const routes = modelRoutes(tier, options.provider ?? config.provider);
  const selected = routes[0]!;
  memory.addRoutingDecision({ sessionId, provider: selected.provider, model: selected.model,
    route: "active", modelTier: tier, durationMs: 0 });
  const model = createRoutedModel(tier, options.provider ?? config.provider,
    { prompt, messages: recentConversation, render });
  const attemptAgent = createManager(model, projectContext, Boolean(options.ceo));
  const startedAt = performance.now();
  try {
    const result = await run(attemptAgent, prompt);
    const response = String(result.finalOutput ?? "No response");
    const usage = result.state.usage;
    memory.addAgentRun({
      sessionId, agent: attemptAgent.name, model: `${selected.provider}:${selected.model ?? "default"}`,
      durationMs: Math.round(performance.now() - startedAt), success: true,
      requests: usage.requests, inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
    });
    memory.addMessage(sessionId, "assistant", response);
    return response;
  } catch (error) {
    memory.addAgentRun({ sessionId, agent: attemptAgent.name,
      model: `${selected.provider}:${selected.model ?? "default"}`,
      durationMs: Math.round(performance.now() - startedAt), success: false });
    throw error;
  }
}
