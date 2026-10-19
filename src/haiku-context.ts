import type { ModelRequest } from "@openai/agents";

// Cautious text/code heuristic: three UTF-8 bytes per token plus 4,096 tokens
// for adapter/tool overhead. This is an estimate, not a tokenizer or upper bound.
export function estimatedInputTokens(request: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(request)) / 3) + 4096;
}

// Only the caller knows which history is expendable. Never infer it from role or headings.
export interface ExpendableHistory {
  prompt: string;
  messages: string[];
  render: (messages: string[]) => string;
}

export function trimHistory(request: ModelRequest, history: ExpendableHistory | undefined, limit: number): ModelRequest {
  if (!history || estimatedInputTokens(request) <= limit) return request;
  function replace(value: unknown, prompt: string): unknown {
    if (typeof value === "string") return value === history!.prompt ? prompt : value;
    if (Array.isArray(value)) return value.map((item) => replace(item, prompt));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item, prompt)]));
    return value;
  }
  let trimmed = request;
  for (let count = 1; count <= history.messages.length; count++) {
    trimmed = { ...request, input: replace(request.input, history.render(history.messages.slice(count))) as ModelRequest["input"] };
    if (estimatedInputTokens(trimmed) <= limit) break;
  }
  return trimmed;
}
