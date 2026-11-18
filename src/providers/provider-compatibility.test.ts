import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, run, tool, withTrace, setTracingDisabled, type ModelRequest } from "@openai/agents";
import { z } from "zod";
import { BudgetLedger, estimatedCost } from "../budget.js";
import { guardedModel, type ModelUsageRecord } from "./provider.js";
import { providerDefaults } from "../config.js";
import { MemoryExtraction } from "../agents/memory-extractor.js";

setTracingDisabled(true);
const request: ModelRequest = {
  input: "Say hello.",
  tools: [],
  handoffs: [],
  modelSettings: {},
  outputType: "text",
  tracing: false,
};
type Provider = "anthropic" | "gemini";
let ledger: BudgetLedger;
let calls: Array<{ url: string; headers: Headers; body: any }>;

beforeEach(() => {
  ledger = new BudgetLedger(":memory:");
  calls = [];
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
  vi.stubEnv("GEMINI_API_KEY", "synthetic-gemini-key");
});
afterEach(() => {
  ledger.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Both compatibility endpoints document OpenAI completion fields, not native
// Messages/GenerateContent envelopes. Anthropic's usage detail objects are
// empty; Gemini can report reasoning tokens within completion_tokens.
function completion(provider: Provider, message: object = { content: "Hello" }) {
  return {
    id: provider === "anthropic" ? "chatcmpl-anthropic" : "chatcmpl-gemini",
    object: "chat.completion",
    created: 0,
    model: providerDefaults[provider].model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", ...message },
        finish_reason: "tool_calls" in message ? "tool_calls" : "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: {},
      completion_tokens_details: provider === "anthropic" ? {} : { reasoning_tokens: 20 },
    },
  };
}

function mockHttp(respond: (body: any, index: number) => Response) {
  const fetch = vi.fn(async (input, init) => {
    const req = new Request(input, init);
    const body = await req.json();
    calls.push({ url: req.url, headers: req.headers, body });
    return respond(body, calls.length - 1);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function model(provider: Provider, fallback = false, reports?: ModelUsageRecord[]) {
  const guarded = guardedModel(
    [{ provider }, ...(fallback ? [{ provider: "ollama" as const }] : [])],
    ledger,
    undefined,
    vi.fn(),
    undefined,
    undefined,
    reports ? (record) => reports.push(record) : undefined,
  );
  return {
    ...guarded,
    getResponse: (request: ModelRequest) =>
      withTrace("Synthetic compatibility test", () => guarded.getResponse(request)),
  };
}

describe.each(["anthropic", "gemini"] as const)("%s OpenAI compatibility", (provider) => {
  it("uses the documented endpoint, bearer auth and text response; settles usage", async () => {
    mockHttp(() => json(completion(provider)));
    const reports: ModelUsageRecord[] = [];
    const result = await model(provider, false, reports).getResponse(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${providerDefaults[provider].baseUrl}chat/completions`);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer synthetic-${provider}-key`);
    expect(calls[0]!.body).toMatchObject({
      model: providerDefaults[provider].model,
      max_tokens: 2048,
      stream: false,
      messages: [{ role: "user", content: "Say hello." }],
    });
    expect(calls[0]!.body).not.toHaveProperty("response_format");
    expect(result.output[0]).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: "Hello" }],
    });
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    expect(reports).toMatchObject([
      { provider, outcome: "used", inputTokens: 100, outputTokens: 50 },
    ]);
    expect(ledger.status().spent).toBeCloseTo(
      estimatedCost(provider, providerDefaults[provider].model, 100, 50)!,
    );
  });

  it("validates tool arguments and sends the assistant/tool-result round trip", async () => {
    const execute = vi.fn(({ city }: { city: string }) => `Weather in ${city}: sunny`);
    mockHttp((_body, index) =>
      json(
        completion(
          provider,
          index === 0
            ? {
                content: null,
                tool_calls: [
                  {
                    id: "call-weather",
                    type: "function",
                    function: { name: "weather", arguments: '{"city":"London"}' },
                    ...(provider === "gemini"
                      ? {
                          extra_content: {
                            google: { thought_signature: "synthetic-thought-signature" },
                          },
                        }
                      : {}),
                  },
                ],
              }
            : { content: "Sunny." },
        ),
      ),
    );
    const agent = new Agent({
      name: "Compatibility test",
      model: model(provider),
      tools: [
        tool({
          name: "weather",
          description: "Look up synthetic weather",
          parameters: z.object({ city: z.string() }),
          execute,
        }),
      ],
    });
    const result = await run(agent, "Weather in London?", { maxTurns: 2 });
    expect(result.finalOutput).toBe("Sunny.");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ city: "London" });
    expect(calls[0]!.body.tools[0].function).toMatchObject({
      name: "weather",
      parameters: { properties: { city: { type: "string" } } },
    });
    expect(calls[1]!.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            expect.objectContaining({
              id: "call-weather",
              function: { name: "weather", arguments: '{"city":"London"}' },
            }),
          ],
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-weather",
          content: "Weather in London: sunny",
        }),
      ]),
    );
    expect(ledger.status().models[0]).toMatchObject({ inputTokens: 200, outputTokens: 100 });
    if (provider === "gemini") {
      const assistant = calls[1]!.body.messages.find((m: any) => m.tool_calls?.length);
      expect(assistant.tool_calls[0].extra_content).toEqual({
        google: { thought_signature: "synthetic-thought-signature" },
      });
    }
  });

  it.each(['{"city":12}', "{broken"])(
    "does not execute a tool with invalid arguments %s",
    async (args) => {
      const execute = vi.fn(() => "must not execute");
      mockHttp(() =>
        json(
          completion(provider, {
            content: null,
            tool_calls: [
              {
                id: "bad-call",
                type: "function",
                function: { name: "weather", arguments: args },
              },
            ],
          }),
        ),
      );
      const agent = new Agent({
        name: "Validation test",
        model: model(provider),
        tools: [
          tool({
            name: "weather",
            description: "Synthetic weather",
            parameters: z.object({ city: z.string() }),
            execute,
            errorFunction: null,
          }),
        ],
      });
      await expect(run(agent, "Weather?", { maxTurns: 1 })).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      // The provider completed a billed request even though tool validation failed.
      expect(ledger.status().models[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    },
  );

  it("requests structured JSON and validates against the original constrained schema", async () => {
    mockHttp(() => json(completion(provider, { content: '{"memories":[]}' })));
    const result = await run(
      new Agent({
        name: "Structured test",
        model: model(provider),
        outputType: MemoryExtraction,
      }),
      "Extract no memories.",
      { maxTurns: 1 },
    );
    expect(result.finalOutput).toEqual({ memories: [] });
    const format = calls[0]!.body.response_format;
    expect(format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    const memories = format.json_schema.schema.properties.memories;
    if (provider === "anthropic") {
      expect(memories).not.toHaveProperty("maxItems");
      expect(memories.items.properties.content).not.toHaveProperty("minLength");
    } else {
      expect(memories.maxItems).toBe(3);
      expect(memories.items.properties.content.minLength).toBe(1);
    }
  });

  it.each([
    "{broken",
    '{"memories":[{"content":"","scope":"global"}]}',
    JSON.stringify({
      memories: Array.from({ length: 4 }, () => ({ content: "x", scope: "global" })),
    }),
  ])("rejects malformed or schema-invalid structured output", async (content) => {
    mockHttp(() => json(completion(provider, { content })));
    await expect(
      run(
        new Agent({
          name: "Invalid structured test",
          model: model(provider),
          outputType: MemoryExtraction,
        }),
        "Extract memories.",
        { maxTurns: 1 },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(ledger.status().models[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });

  it("retains the reservation for absent usage", async () => {
    const body: any = completion(provider);
    delete body.usage;
    mockHttp(() => json(body));
    const settle = vi.spyOn(ledger, "settle");
    await model(provider).getResponse(request);
    expect(settle).not.toHaveBeenCalled();
    expect(ledger.status().spent).toBeGreaterThan(0);
  });

  it.each(["empty choices", "invalid JSON"])(
    "fails safely on %s and keeps its reservation",
    async (kind) => {
      mockHttp(() =>
        kind === "empty choices"
          ? json({ ...completion(provider), choices: [] })
          : new Response("{broken", { headers: { "content-type": "application/json" } }),
      );
      const settle = vi.spyOn(ledger, "settle");
      await expect(model(provider, true).getResponse(request)).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect(settle).not.toHaveBeenCalled();
      expect(ledger.status().spent).toBeGreaterThan(0);
    },
  );

  it.each([400, 401, 403, 429, 503])(
    "handles HTTP %i without retrying the provider",
    async (status) => {
      // Anthropic documents OpenAI error envelopes. Google's compatibility
      // endpoint also emits Google-style code/status errors; use those here.
      const error =
        provider === "anthropic"
          ? {
              error: {
                type: {
                  400: "invalid_request_error",
                  401: "authentication_error",
                  403: "permission_error",
                  429: "rate_limit_error",
                  503: "api_error",
                }[status],
                message: status === 400 ? "Unsupported response_format" : "Request rejected",
              },
            }
          : {
              error: {
                code: status,
                status: {
                  400: "INVALID_ARGUMENT",
                  401: "UNAUTHENTICATED",
                  403: "PERMISSION_DENIED",
                  429: "RESOURCE_EXHAUSTED",
                  503: "UNAVAILABLE",
                }[status],
                message:
                  status === 400 ? "Unknown name: unsupported_parameter" : "Request rejected",
              },
            };
      mockHttp((_body, index) => (index === 0 ? json(error, status) : json(completion(provider))));
      const settle = vi.spyOn(ledger, "settle");
      const reports: ModelUsageRecord[] = [];
      if (status === 400) {
        await expect(model(provider, true, reports).getResponse(request)).rejects.toMatchObject({
          status,
        });
        expect(calls).toHaveLength(1);
        expect(settle).not.toHaveBeenCalled();
      } else {
        await model(provider, true, reports).getResponse(request);
        expect(calls).toHaveLength(2);
        expect(calls[1]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
        expect(settle).toHaveBeenCalledTimes(1);
        expect(reports.map((r) => r.outcome)).toEqual(["failed", "used"]);
      }
      // Rejected/possibly billed attempts never release their reservation.
      expect(ledger.status().models.find((m) => m.provider === provider)?.usd).toBeGreaterThan(0);
    },
  );
});

it("falls back on Gemini's invalid-key 400, not on unsupported-parameter 400s", async () => {
  mockHttp((_body, index) =>
    index === 0
      ? json(
          {
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: "API key not valid. Please pass a valid API key.",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "API_KEY_INVALID",
                  domain: "googleapis.com",
                },
              ],
            },
          },
          400,
        )
      : json(completion("gemini")),
  );
  await model("gemini", true).getResponse(request);
  expect(calls).toHaveLength(2);
});

it("preserves schema property names and does not mutate the caller's schema", async () => {
  mockHttp(() => json(completion("anthropic", { content: '{"minimum":"x"}' })));
  const outputType = {
    type: "json_schema" as const,
    name: "test",
    strict: true,
    schema: {
      type: "object" as const,
      additionalProperties: false as const,
      required: ["minimum"],
      properties: { minimum: { type: "string", minLength: 1, default: "minimum" } },
    },
  };
  const before = JSON.stringify(outputType);
  await model("anthropic").getResponse({ ...request, outputType });
  expect(calls[0]!.body.response_format.json_schema.schema.properties.minimum).toEqual({
    type: "string",
    default: "minimum",
  });
  expect(JSON.stringify(outputType)).toBe(before);
});
