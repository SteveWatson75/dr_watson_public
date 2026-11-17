import { request as httpRequest, type Server } from "node:http";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "./budget.js";
import {
  createLocalApi,
  LOCAL_MODEL,
  prepareOpenCodeMessages,
  redactProviderError,
  type CompletionTransport,
} from "./local-api.js";

let server: Server;
let base: string;
let ledger: BudgetLedger;
let transport: ReturnType<typeof vi.fn<CompletionTransport>>;
const reply: OpenAI.ChatCompletion = {
  id: "chatcmpl-boundaries",
  object: "chat.completion",
  created: 1,
  model: "upstream",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "Done", refusal: null },
    finish_reason: "stop",
    logprobs: null,
  }],
};
const prompt = {
  model: LOCAL_MODEL,
  messages: [{ role: "user", content: "Hello" }],
};

beforeEach(async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "secret-boundary-key");
  ledger = new BudgetLedger(":memory:", 0, 0);
  transport = vi.fn(async () => reply);
  server = createLocalApi({ ledger, transport, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind.");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  ledger.close();
  vi.unstubAllEnvs();
});

async function post(body: unknown) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("local API trust boundaries", () => {
  it.each([
    { ...prompt, n: 2 },
    { ...prompt, messages: [{ role: "user", content: null }] },
    { ...prompt, messages: [{ role: "assistant", content: null }] },
    { ...prompt, messages: [{ role: "user", content: [{ type: "image_url", image_url: "file:///secret" }] }] },
    { ...prompt, messages: [{ role: "user", content: "Hello", tool_calls: [] }] },
    { ...prompt, tools: [{ type: "function", function: { name: "read" } }] },
  ])("rejects unsupported input without calling a provider (%j)", async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "Invalid request. Use dr-watson-auto with text messages and optional function tools.",
        type: "invalid_request_error",
      },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and oversized bodies before routing", async () => {
    const malformed = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);
    const oversized = await post({
      ...prompt,
      messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) }],
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: { message: "Request exceeds 4 MiB.", type: "invalid_request_error" },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/v1/chat/completions"],
    ["POST", "/v1/models"],
    ["GET", "/v1/models?extra=1"],
  ])("keeps unknown method/path combinations at 404 (%s %s)", async (method, path) => {
    const response = await fetch(`${base}${path}`, { method });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: "Unknown endpoint.", type: "invalid_request_error" },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host before parsing its body", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { host: "localhost" },
      }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end("{");
    });
    expect(status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });

  it("redacts configured keys, credential shapes and cyclic error causes", () => {
    const error = new Error("secret-boundary-key sk-abcdefghijk");
    error.cause = new Error("Bearer abcdefghijkl", { cause: error });
    expect(redactProviderError(error)).toBe("[REDACTED] [REDACTED] [REDACTED]");
    expect(redactProviderError({ message: "untrusted error object" }))
      .toBe("No routed provider completed the request.");
  });

  it("prepares messages without mutating the caller's history", () => {
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "Implement the feature" }] },
      { role: "user" as const, content: "Continue" },
    ];
    const original = structuredClone(messages);
    const prepared = prepareOpenCodeMessages(messages);
    expect(messages).toEqual(original);
    expect(prepared).toEqual([
      { role: "developer", content: expect.stringContaining("Task anchor (original user intent):\nImplement the feature") },
      messages[0],
    ]);
  });
});
