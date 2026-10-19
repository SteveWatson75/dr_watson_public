import { Agent } from "@openai/agents";
import { z } from "zod";


export const MemoryExtraction = z.object({
  memories: z.array(z.object({
    content: z.string().min(1),
    scope: z.enum(["project", "global"]),
  })).max(3),
});

export const memoryExtractor = new Agent({
  name: "Memory Extractor",
  outputType: MemoryExtraction,
  instructions: [
    "Extract only durable information worth remembering for future work.",
    "Good memories: explicit decisions, stable constraints, user working preferences, important discoveries, and reasons an approach was rejected.",
    "Ignore acknowledgements, temporary status, transient errors, speculative ideas, and details already obvious from the current project files.",
    "Do not infer private facts or preferences that were not explicitly demonstrated.",
    "Use project scope when the memory only matters to the active project; use global only for durable cross-project working preferences.",
    "Return at most 3 concise standalone memories. Returning zero memories is preferred when nothing durable happened."
  ].join("\n"),
});
