import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { assertConfig, config, setupMessages, PROVIDERS, type LlmProvider, type TaskTier } from "./config.js";
import { budgetLedger, formatBudget } from "./budget.js";
import { runConversation } from "./conversation.js";
import { listProjects, loadProjectContext } from "./context.js";
import { extractMemories } from "./extract-memory.js";
import { manager } from "./manager.js";
import { MemoryStore } from "./memory.js";
import { configureModelProvider } from "./provider.js";
import { formatStats } from "./stats.js";

assertConfig();
configureModelProvider();

const memory = new MemoryStore();
if (process.argv.includes("--stats")) {
  console.log(`${formatStats(memory.getStats())}\n\n${formatBudget(budgetLedger().status())}`);
  memory.close();
  budgetLedger().close();
  process.exit(0);
}
const terminal = createInterface({ input, output });
let selectedTier: TaskTier | undefined;
let selectedProvider: LlmProvider | "auto" = config.provider;
const mainSessionId = memory.createSession();
let sideSessionId: number | undefined;
let activeProject: string | undefined;
let ceoNext = false;

console.log("Dr Watson");
console.log("Commands: /projects, /use <project>, /side [question], /back, /remember <fact>, /ceo, /tier auto|cheap|standard|hard, /provider auto|anthropic|gemini|ollama|openrouter|groq|openai, /stats, exit.\n");
console.log(setupMessages().join("\n"));
console.log(formatBudget(budgetLedger().status()));

while (true) {
  const prefix = sideSessionId
    ? `[${activeProject ?? "general"}:side] > `
    : activeProject
      ? `[${activeProject}] > `
      : "> ";
  const message = (await terminal.question(prefix)).trim();

  if (!message) continue;
  if (message.toLowerCase() === "exit") break;

  try {
    if (message === "/ceo") {
      ceoNext = !ceoNext;
      console.log(ceoNext ? "CEO mode enabled for the next prompt." : "CEO mode cancelled.");
      continue;
    }
    if (message === "/stats") {
      console.log(`\n${formatStats(memory.getStats())}\n\n${formatBudget(budgetLedger().status())}\n`);
      continue;
    }

    if (message.startsWith("/tier ")) {
      const value = message.slice(6).trim();
      if (!["auto", "cheap", "standard", "hard"].includes(value)) throw new Error("Use /tier auto|cheap|standard|hard.");
      selectedTier = value === "auto" ? undefined : value as TaskTier;
      console.log(`Task tier: ${value}`);
      continue;
    }
    if (message.startsWith("/provider ")) {
      const value = message.slice(10).trim();
      if (value !== "auto" && !PROVIDERS.includes(value as LlmProvider)) throw new Error(`Use /provider auto|${PROVIDERS.join("|")}.`);
      selectedProvider = value as LlmProvider | "auto";
      console.log(`Provider: ${value}`);
      continue;
    }

    if (message === "/projects") {
      const projects = await listProjects();
      console.log(projects.length ? `\n${projects.join("\n")}\n` : "\nNo projects yet.\n");
      continue;
    }

    if (message.startsWith("/use ")) {
      if (sideSessionId) throw new Error("Use /back before changing project.");
      const project = message.slice(5).trim();
      await loadProjectContext(project);
      activeProject = project;
      memory.setProject(mainSessionId, project);
      console.log(`\nUsing ${project}.\n`);
      continue;
    }

    if (message === "/back") {
      if (!sideSessionId) {
        console.log("\nAlready in the main conversation.\n");
      } else {
        sideSessionId = undefined;
        console.log("\nBack to the main conversation.\n");
      }
      continue;
    }

    if (message === "/side") {
      if (sideSessionId) throw new Error("Already in a side conversation.");
      sideSessionId = memory.createSession(activeProject);
      console.log("\nSide conversation opened. Use /back to return.\n");
      continue;
    }

    const oneOffSideQuestion = !sideSessionId && message.startsWith("/side ");
    const actualMessage = oneOffSideQuestion ? message.slice(6).trim() : message;
    if (!actualMessage) throw new Error("Side question is empty.");

    if (actualMessage.startsWith("/remember ")) {
      if (sideSessionId || oneOffSideQuestion) throw new Error("Long-term memory is disabled in side conversations.");
      const fact = actualMessage.slice(10).trim();
      if (!fact) throw new Error("Nothing to remember.");
      memory.addMemory(fact, activeProject);
      console.log(`\nRemembered${activeProject ? ` for ${activeProject}` : ""}.\n`);
      continue;
    }

    const projectContext = activeProject
      ? await loadProjectContext(activeProject)
      : "No project is currently selected.";
    const relevantMemories = memory
      .searchMemories(actualMessage, activeProject)
      .map((item) => `- ${item.content}`)
      .join("\n");

    const sessionId = oneOffSideQuestion
      ? memory.createSession(activeProject)
      : sideSessionId ?? mainSessionId;

    const ceo = ceoNext;
    ceoNext = false;
    const response = await runConversation(
      manager,
      memory,
      sessionId,
      actualMessage,
      projectContext,
      relevantMemories,
      { tier: selectedTier, provider: selectedProvider, ceo },
    );

    console.log(`\n${response}\n`);
    if (!sideSessionId && !oneOffSideQuestion) {
      try {
        await extractMemories(memory, config.autoMemory, actualMessage, response, activeProject, selectedProvider);
      } catch (error) {
        console.warn(`Automatic memory extraction skipped: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? `\n${error.message}\n` : "\nUnknown error\n");
  }
}

memory.close();
budgetLedger().close();
terminal.close();
