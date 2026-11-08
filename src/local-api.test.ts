import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import type OpenAI from "openai";
import { BudgetLedger } from "./budget.js";
import { config } from "./config.js";
import { conversationTier, createLocalApi, isGithubActionMode, isOpenCodeCompactionRequest, isOpenCodeStateSummary, prepareOpenCodeMessages, routedCompletion, LOCAL_MODEL, type CompletionTransport } from "./local-api.js";

let ledger: BudgetLedger;
let server: Server;
let base: string;
const originalProvider = config.provider;
const originalLimit = config.haikuInputLimit;
const reply: OpenAI.ChatCompletion = { id: "chatcmpl-test", object: "chat.completion", created: 1, model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: "Done", refusal: null }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
let transport: ReturnType<typeof vi.fn<CompletionTransport>>;
let log: ReturnType<typeof vi.fn<(line: string) => void>>;
async function post(body: unknown, sessionId?: string) {
  return fetch(`${base}/v1/chat/completions`, { method: "POST", headers: {
    "content-type": "application/json", ...(sessionId ? { "x-opencode-session": sessionId } : {}),
  }, body: JSON.stringify(body) });
}
async function sseEvents(response: Response) {
  return (await response.text()).split("\n\n").filter(Boolean).map((event) => event.slice(6))
    .filter((event) => event !== "[DONE]").map((event) => JSON.parse(event));
}
const prompt = { model: LOCAL_MODEL, messages: [{ role: "system", content: "Preserve instructions" }, { role: "user", content: "Hello" }] };
beforeEach(async () => {
  config.provider = "auto";
  config.haikuInputLimit = 80_000;
  ledger = new BudgetLedger(":memory:", 15, 20);
  vi.stubEnv("ANTHROPIC_API_KEY", "secret-anthropic"); vi.stubEnv("GEMINI_API_KEY", "secret-gemini");
  vi.stubEnv("OPENCODE_API_KEY", ""); vi.stubEnv("OPENROUTER_API_KEY", "");
  transport = vi.fn(async () => reply); log = vi.fn();
  server = createLocalApi({ ledger, transport, log });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  ledger.close(); config.provider = originalProvider; config.haikuInputLimit = originalLimit; vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
describe("loopback OpenCode API", () => {
  it("keeps the strongest tier seen in user conversation history", () => {
    expect(conversationTier([
      { role: "user", content: "Implement issue #111 across the repo" },
      { role: "assistant", content: "I will inspect the relevant files" },
      { role: "user", content: "Continue" },
    ])).toBe("standard");
    expect(conversationTier([
      { role: "user", content: "Review the architecture for this difficult debugging race condition" },
      { role: "assistant", content: "Inspecting" },
      { role: "user", content: "Go on" },
    ])).toBe("hard");
  });
  it("anchors the original coding task and removes repeated OpenCode state summaries", () => {
    const summary = "## Objective\nImplement issue #111\n\n## Requirements\n- Keep changes scoped\n\n## Work State\n### Completed\n- Read public-pages.ts\n\n### Active\n- Pinpointing list rendering\n\n## Next Move\n1. Read files again";
    expect(isOpenCodeStateSummary(summary)).toBe(true);
    const prepared = prepareOpenCodeMessages([
      { role: "system", content: "System" },
      { role: "user", content: "Implement issue #111 across the repo" },
      { role: "assistant", content: summary },
      { role: "user", content: "Continue" },
      { role: "assistant", content: summary },
      { role: "user", content: "Implement issue #111 across the repo" },
    ]);
    const text = JSON.stringify(prepared);
    expect(text.match(/Task anchor/g)).toHaveLength(1);
    expect(text.match(/Implement issue #111 across the repo/g)?.length).toBe(2); // anchor reminder + original user message
    expect(text).toContain("Read public-pages.ts");
    expect(text).not.toContain("Pinpointing list rendering");
    expect(text).not.toContain("Read files again");
    expect(text).not.toContain('"content":"Continue"');
  });
  it("recovers a compacted task from a state summary when the original user turn is gone", () => {
    const summary = "## Objective\nImplement issue #111 across the repo\n\n## Requirements\n- Keep direct product routes working\n\n## Work State\n### Completed\n- Read canonical-products.ts\n\n## Next Move\n1. Implement the filter";
    const prepared = prepareOpenCodeMessages([{ role: "assistant", content: summary }]);
    expect(prepared.some((item) => item.role === "user" && String(item.content).includes("Implement issue #111"))).toBe(true);
    expect(conversationTier([{ role: "assistant", content: summary }])).toBe("standard");
  });
  // OpenCode 2.2.6's initial compaction uses this opening and checkpoint headings.
  // Later compactions use the already-supported "Update the existing checkpoint".
  const initialCompaction = "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.\n\n## Objective\n## Requirements\n## Decisions\n## Work State\n## Next Move";
  it.each([
    initialCompaction,
    "Update the existing checkpoint in the conversation above into one consolidated summary.",
    "Write a compaction summary.",
    "Summarize the conversation into a checkpoint.",
  ])("preserves internal compaction instructions before a route is remembered (%s)", async (instruction) => {
    const messages = [
      { role: "system" as const, content: "Do not continue the task or call tools. Return only the structured summary." },
      { role: "user" as const, content: "Summarise this repository." },
      { role: "assistant" as const, content: "Read the README.", reasoning_content: "The README describes routing." },
      { role: "user" as const, content: instruction },
    ];
    expect(isOpenCodeCompactionRequest(messages)).toBe(true);
    expect(prepareOpenCodeMessages(messages)).toEqual(messages);
    const checkpoint = "## Objective\nSummarise the repository\n## Requirements\nRead only\n## Work State\nComplete\n## Next Move\nNone";
    transport.mockResolvedValue({ ...reply, choices: [{ ...reply.choices[0]!, message: { ...reply.choices[0]!.message, content: checkpoint } }] });
    const response = await post({ model: LOCAL_MODEL, messages });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe(checkpoint);
    expect(transport.mock.calls[0]![1].messages).toEqual(messages);
  });
  it.each([false, true])("keeps repository summaries separate from compaction and reasoning (stream=%s)", async (stream) => {
    const messages = [{ role: "user" as const, content: "Summarise this repository in two sentences." }];
    expect(isOpenCodeCompactionRequest(messages)).toBe(false);
    const content = "Dr Watson is a local-first TypeScript assistant. It offers memory, model routing and budget controls.";
    const reasoning_content = "Internal reasoning stays separate from the answer.";
    transport.mockResolvedValue({ ...reply, choices: [{ ...reply.choices[0]!, message: {
      ...reply.choices[0]!.message, content, reasoning_content,
    } as OpenAI.ChatCompletionMessage }] });
    const response = await post({ model: LOCAL_MODEL, messages, stream });
    const result = stream ? (await sseEvents(response))[0].choices[0].delta : (await response.json()).choices[0].message;
    expect(result.content).toBe(content);
    expect(result.reasoning_content).toBe(reasoning_content);
    expect(JSON.stringify(transport.mock.calls[0]![1].messages)).not.toContain("## Objective");
  });
  it("classifies the latest user request, not quoted or historical compaction instructions", () => {
    expect(isOpenCodeCompactionRequest([
      { role: "user", content: `Explain this instruction: ${initialCompaction}` },
    ])).toBe(false);
    expect(isOpenCodeCompactionRequest([
      { role: "user", content: initialCompaction },
      { role: "user", content: "Summarise this repository." },
    ])).toBe(false);
  });
  it("detects the bounded GitHub Actions mode from a header or environment", () => {
    expect(isGithubActionMode({ "x-dr-watson-mode": "github-action" }, undefined)).toBe(true);
    expect(isGithubActionMode({}, "github-action")).toBe(true);
    expect(isGithubActionMode({ "x-dr-watson-mode": ["github-action"] }, undefined)).toBe(true);
    expect(isGithubActionMode({ "x-dr-watson-mode": "coding" }, "coding")).toBe(false);
    expect(isGithubActionMode({}, undefined)).toBe(false);
  });
  it("skips coding-session anchoring when the GitHub Actions mode header is present", async () => {
    const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: {
      "content-type": "application/json", "x-dr-watson-mode": "github-action",
    }, body: JSON.stringify({ model: LOCAL_MODEL, messages: [
      { role: "user", content: "Review the changes in this pull request" },
      { role: "assistant", content: "I read the diff" },
      { role: "user", content: "Continue" },
    ], max_completion_tokens: 64 }) });
    expect(response.status).toBe(200);
    expect(JSON.stringify(transport.mock.calls[0]![1].messages)).not.toContain("Task anchor");
  });
  it("lists the logical model without contacting any provider", async () => {
    const response = await fetch(`${base}/v1/models`);
    expect(await response.json()).toMatchObject({ object: "list", data: [{ id: LOCAL_MODEL }] });
    expect(server.address()).toMatchObject({ address: "127.0.0.1" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("preserves authoritative messages without injecting chat or CEO context, caps output and records spend", async () => {
    const messages = [...prompt.messages, { role: "developer", content: "Use only configured project context" }];
    const response = await post({ ...prompt, messages, max_tokens: 9000 });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dr-watson-route")).toBe("anthropic:claude-haiku-5-5");
    const result = await response.json();
    expect(result).toMatchObject({ model: LOCAL_MODEL, choices: [{ message: { content: "Done" } }], usage: reply.usage });
    expect(JSON.stringify(result)).not.toContain("secret-");
    expect(transport).toHaveBeenCalledExactlyOnceWith({ provider: "anthropic", model: "claude-haiku-5-5" },
      expect.objectContaining({ stream: false, max_tokens: 2048 }), undefined);
    const sent = transport.mock.calls[0]![1].messages;
    expect(sent.some((item) => item.role === "user" && item.content === "Hello")).toBe(true);
    expect(ledger.status().spent).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledWith("Local API tier: cheap; route: anthropic:claude-haiku-5-5");
  });
  it("routes coding to Gemini and honors a smaller max_completion_tokens", async () => {
    await post({ model: LOCAL_MODEL, messages: [{ role: "user", content: "Implement this feature" }], max_completion_tokens: 64 });
    expect(transport).toHaveBeenCalledExactlyOnceWith({ provider: "gemini", model: "gemini-3.8-flash" }, expect.objectContaining({ max_tokens: 64 }), undefined);
    expect(transport.mock.calls[0]![1]).not.toHaveProperty("max_completion_tokens");
  });
  it("does not demote a coding conversation when the latest continuation is cheap", async () => {
    await post({ model: LOCAL_MODEL, messages: [
      { role: "user", content: "Implement issue #111 across the repo" },
      { role: "assistant", content: "I inspected the relevant files" },
      { role: "user", content: "Continue" },
    ], max_completion_tokens: 64 });
    expect(transport).toHaveBeenCalledExactlyOnceWith({ provider: "gemini", model: "gemini-3.8-flash" }, expect.objectContaining({ max_tokens: 64 }), undefined);
    expect(log).toHaveBeenCalledWith("Local API tier: standard; route: gemini:gemini-3.8-flash");
  });
  it("uses the real compatibility SDK with credentials only on the upstream request", async () => {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const request = new Request(input, init); calls.push(request);
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const result = await routedCompletion({ model: LOCAL_MODEL,
      messages: [{ role: "system", content: "Keep this" }, { role: "user", content: "Hello" }], max_tokens: 80 }, { ledger, log });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret-anthropic");
    const body = await calls[0]!.json() as { model: string; stream: boolean; max_tokens: number; messages: Array<{ role: string; content: string }> };
    expect(body).toMatchObject({ model: "claude-haiku-5-5", stream: false, max_tokens: 80 });
    expect(body.messages.some((item) => item.role === "user" && item.content === "Hello")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-anthropic");
    expect(ledger.status().models[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });
  it("keeps Haiku safeguards for large protected instructions", async () => {
    const messages = [{ role: "system", content: "Required project context ".repeat(12_000) }, { role: "user", content: "Hello" }];
    await post({ model: LOCAL_MODEL, messages });
    expect(transport).toHaveBeenCalledExactlyOnceWith({ provider: "gemini", model: "gemini-3.8-flash" }, expect.any(Object), undefined);
    expect(ledger.status().models.map((m) => m.provider)).toEqual(["gemini"]);
  });
  it("uses zero-cost providers at the hard cap before falling back to local", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "test-opencode");
    ledger.reserve("gemini", "gemini-3.8-flash", 20);
    const response = await post(prompt);
    expect(response.headers.get("x-dr-watson-route")).toBe("opencode:mimo-v2.6-flash");
    expect(transport).toHaveBeenCalledExactlyOnceWith({ provider: "opencode", model: "mimo-v2.6-flash" }, expect.objectContaining({ stream: false }), undefined);
    expect(ledger.status().spent).toBe(20);
  });
  it("honors an explicit local provider override", async () => {
    config.provider = "ollama";
    await post({ model: LOCAL_MODEL, messages: [{ role: "user", content: "Review architecture" }] });
    expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "ollama" }), expect.objectContaining({ model: "llama3.2:3b" }), undefined);
  });
  it("preserves tool definitions, calls and results and returns buffered SSE with usage", async () => {
    const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
    const toolCalls = [{ id: "call-1", type: "function" as const, function: { name: "read_file", arguments: '{"path":"README.md"}' } }];
    const messages = [...prompt.messages, { role: "assistant", content: null, tool_calls: toolCalls }, { role: "tool", tool_call_id: "call-1", content: "File contents" }];
    transport.mockResolvedValue({ ...reply, choices: [{ ...reply.choices[0]!, finish_reason: "tool_calls", message: { role: "assistant", content: null, refusal: null, tool_calls: toolCalls } }] });
    const response = await post({ model: LOCAL_MODEL, messages, tools, tool_choice: "auto", stream: true, stream_options: { include_usage: true } });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = (await response.text()).split("\n\n").filter(Boolean).map((event) => event.slice(6));
    expect(events.pop()).toBe("[DONE]");
    const chunks = events.map((event) => JSON.parse(event));
    expect(chunks[0].choices[0].delta.tool_calls).toEqual([{ ...toolCalls[0], index: 0 }]);
    expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
    expect(chunks[2].usage).toEqual(reply.usage);
    expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "gemini", model: "gemini-3.8-flash" }), expect.objectContaining({ tools, tool_choice: "auto", stream: false }), undefined);
  });
  it("routes a complete multi-turn tool cycle and keeps its OpenCode session", async () => {
    const tools = [
      { type: "function" as const, function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
      { type: "function" as const, function: { name: "write_file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } },
    ];
    const readCall = { id: "call-read", type: "function" as const, function: { name: "read_file", arguments: '{"path":"probe.txt"}' } };
    const writeCall = { id: "call-write", type: "function" as const, function: { name: "write_file", arguments: '{"path":"result.txt","content":"FIXTURE_READ_OK"}' } };
    transport
      .mockResolvedValueOnce({ ...reply, choices: [{ ...reply.choices[0]!, finish_reason: "tool_calls", message: { role: "assistant", content: null, refusal: null, tool_calls: [readCall] } }] })
      .mockResolvedValueOnce({ ...reply, choices: [{ ...reply.choices[0]!, finish_reason: "tool_calls", message: { role: "assistant", content: null, refusal: null, tool_calls: [writeCall] } }] })
      .mockResolvedValueOnce(reply);

    const sessionId = "opencode-session-tool-cycle";
    const user = { role: "user" as const, content: "Implement this by reading the fixture and writing its marker." };
    const first = await post({ model: LOCAL_MODEL, messages: [user], tools, max_tokens: 64, stream: true }, sessionId);
    expect(first.status).toBe(200);
    const firstEvents = await sseEvents(first);
    expect(firstEvents[0].choices[0].delta.tool_calls).toEqual([{ ...readCall, index: 0 }]);
    expect(firstEvents[1].choices[0].finish_reason).toBe("tool_calls");

    const secondMessages = [user, { role: "assistant" as const, content: null, tool_calls: [readCall] },
      { role: "tool" as const, tool_call_id: readCall.id, content: "FIXTURE_READ_OK" }];
    const second = await post({ model: LOCAL_MODEL, messages: secondMessages, tools, max_tokens: 64, stream: true }, sessionId);
    expect(second.status).toBe(200);
    const secondEvents = await sseEvents(second);
    expect(secondEvents[0].choices[0].delta.tool_calls).toEqual([{ ...writeCall, index: 0 }]);
    expect(secondEvents[1].choices[0].finish_reason).toBe("tool_calls");

    const thirdMessages = [...secondMessages, { role: "assistant" as const, content: null, tool_calls: [writeCall] },
      { role: "tool" as const, tool_call_id: writeCall.id, content: "Wrote result.txt" }];
    const third = await post({ model: LOCAL_MODEL, messages: thirdMessages, tools, max_tokens: 64, stream: true }, sessionId);
    expect(third.status).toBe(200);
    const thirdEvents = await sseEvents(third);
    expect(thirdEvents[0].choices[0].delta.content).toBe("Done");
    expect(thirdEvents[1].choices[0].finish_reason).toBe("stop");

    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls.map((call) => call[2])).toEqual([sessionId, sessionId, sessionId]);
    expect(transport.mock.calls[1]![1].messages).toEqual(secondMessages);
    expect(transport.mock.calls[2]![1].messages).toEqual(thirdMessages);
    expect(transport.mock.calls.every((call) => call[1].stream === false)).toBe(true);
    expect(transport.mock.calls.every((call) => call[1].tools?.length === 2)).toBe(true);
  });
  it.each([
    { model: "unknown", messages: prompt.messages },
    { ...prompt, max_tokens: -1 },
    { model: LOCAL_MODEL, messages: [{ role: "tool", content: "missing id" }] },
    { model: LOCAL_MODEL, messages: [] },
  ])("rejects invalid requests before any model call (%j)", async (body) => {
    expect((await post(body)).status).toBe(400); expect(transport).not.toHaveBeenCalled();
  });
  it("rejects browser origins and hostile Hosts", async () => {
    expect((await fetch(`${base}/v1/models`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${base}/v1/models`, { headers: { host: "example.com" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    expect(status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it("returns sanitized provider errors, including when fallback is unavailable", async () => {
    transport.mockRejectedValue(new Error("secret-anthropic ECONNREFUSED"));
    const response = await post(prompt);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("secret-anthropic"); expect(text).toContain("ollama serve");
  });
  it("redacts configured credentials from surfaced upstream errors", async () => {
    transport.mockRejectedValue(Object.assign(new Error("Invalid API key secret-anthropic"), { status: 400 }));
    const response = await post(prompt);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("secret-anthropic");
    expect(text).toContain("[REDACTED]");
  });
});
