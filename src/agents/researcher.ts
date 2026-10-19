import { Agent } from "@openai/agents";
import { config } from "../config.js";
import type { ProviderModel } from "../provider.js";

export function createResearcher(
  model: string | ProviderModel | undefined = config.model,
  projectContext = "",
): Agent {
  return new Agent({
  name: "Researcher",
  model,
  instructions: [
    "You are Dr Watson's research specialist.",
    projectContext
      ? `Canonical project context follows. Treat it as ground truth for current project state:\n\n${projectContext}`
      : "No project context was supplied. Do not invent project-specific facts.",
    "Investigate the specific question you are given and return concise findings to the manager.",
    "Separate facts, assumptions and unknowns.",
    "Prefer primary sources when source material is available.",
    "Do not invent product purpose, audience, pricing, features, deployment state or business facts. If context does not establish them, call them unknown.",
    "Do not reinterpret a named project as a generic product with the same name; anchor findings to the supplied project context.",
  ].join("\n")
  });
}

export const researcher = createResearcher();
