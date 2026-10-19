import { Agent, run } from "@openai/agents";
import { config, type LlmProvider } from "./config.js";
import { createRoutedModel } from "./provider.js";
import { memoryExtractor } from "./agents/memory-extractor.js";
import { MemoryStore } from "./memory.js";
import { shouldExtractMemory } from "./memory-policy.js";

export async function extractMemories(
  store: MemoryStore,
  enabled: boolean,
  userMessage: string,
  assistantResponse: string,
  project?: string,
  provider: LlmProvider | "auto" = config.provider,
): Promise<void> {
  if (!shouldExtractMemory(enabled, userMessage, assistantResponse)) return;

  const result = await run(
    new Agent({ name: memoryExtractor.name, instructions: memoryExtractor.instructions,
      outputType: memoryExtractor.outputType, model: createRoutedModel("cheap", provider) }),
    ["ACTIVE PROJECT: " + (project ?? "none"), "USER: " + userMessage, "ASSISTANT: " + assistantResponse].join("\n\n"),
  );

  for (const candidate of result.finalOutput?.memories ?? []) {
    const scopeProject = candidate.scope === "project" ? project : undefined;
    if (candidate.scope === "project" && !scopeProject) continue;
    if (!store.hasMemory(candidate.content, scopeProject)) store.addMemory(candidate.content, scopeProject);
  }
}
