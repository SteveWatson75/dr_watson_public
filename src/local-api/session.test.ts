import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { BudgetLedger } from "../budget.js";
import { config } from "../config.js";
import {
  LOCAL_MODEL,
  conversationTier,
  prepareGithubActionMessages,
  routedCompletion,
  type CompletionTransport,
} from "./server.js";

const reply: OpenAI.ChatCompletion = {
  id: "chatcmpl-session-test",
  object: "chat.completion",
  created: 1,
  model: "upstream",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Done", refusal: null },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const originalProvider = config.provider;
let ledger: BudgetLedger;
let transport: ReturnType<typeof vi.fn<CompletionTransport>>;

beforeEach(() => {
  config.provider = "auto";
  ledger = new BudgetLedger(":memory:", 15, 20);
  vi.stubEnv("OPENCODE_API_KEY", "test-opencode");
  transport = vi.fn(async () => reply);
});

afterEach(() => {
  ledger.close();
  config.provider = originalProvider;
  vi.unstubAllEnvs();
});

describe("OpenCode session routing", () => {
  it("keeps remembered sessions' supplied messages unchanged while preserving their tier", async () => {
    const sessionId = "characterization-remembered-hard";
    await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [{ role: "user", content: "Review the architecture" }],
      },
      { ledger, transport, sessionId },
    );
    const messages = [{ role: "user" as const, content: "Continue" }];
    const result = await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages,
      },
      { ledger, transport, sessionId },
    );

    expect(result.route).toBe("opencode:qwen4-max");
    expect(transport.mock.calls[1]![1].messages).toEqual(messages);
  });

  it("prefers a successful fallback on the next request in the same tier", async () => {
    const sessionId = "characterization-sticky-fallback";
    transport.mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status: 503 }));
    const input: Parameters<typeof routedCompletion>[0] = {
      model: LOCAL_MODEL,
      messages: [{ role: "user", content: "Hello" }],
    };
    const first = await routedCompletion(input, { ledger, transport, sessionId });
    const second = await routedCompletion(input, { ledger, transport, sessionId });

    expect(first.route).toBe("opencode:glm-5.3-flash");
    expect(second.route).toBe(first.route);
    expect(transport.mock.calls.map(([route]) => route.model)).toEqual([
      "mimo-v2.6-flash",
      "glm-5.3-flash",
      "glm-5.3-flash",
    ]);
  });

  it("maps developer messages to system for the OpenCode Go chat-completions API", async () => {
    await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [
          { role: "system", content: "System rules" },
          { role: "developer", content: "Developer rules" },
          { role: "user", content: "Summarize this change" },
        ],
        max_tokens: 64,
      },
      { ledger, transport },
    );

    const body = transport.mock.calls[0]![1];
    expect(body.messages.map((message) => message.role)).not.toContain("developer");
    expect(body.messages.filter((message) => message.role === "system")).toHaveLength(3);
    expect(
      body.messages.some(
        (message) => message.role === "system" && message.content === "Developer rules",
      ),
    ).toBe(true);
  });

  it("keeps the selected model for later continuation and compaction requests", async () => {
    const sessionId = `test-session-${Date.now()}-${Math.random()}`;
    const first = await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [{ role: "user", content: "Implement issue #111 across the repo" }],
        max_tokens: 64,
      },
      { ledger, transport, sessionId },
    );

    const second = await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [
          { role: "user", content: "Implement issue #111 across the repo" },
          { role: "assistant", content: "I inspected the relevant files" },
          { role: "user", content: "Update the existing checkpoint with the current work state." },
        ],
        max_tokens: 64,
      },
      { ledger, transport, sessionId },
    );

    expect(first.route).toBe("opencode:mimo-v2.6-pro");
    expect(second.route).toBe(first.route);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]![0]).toEqual({ provider: "opencode", model: "mimo-v2.6-pro" });
  });

  it("drops continuation noise without injecting a coding anchor in GitHub Actions mode", () => {
    const prepared = prepareGithubActionMessages([
      { role: "user", content: "Review the pull request" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "I read the diff" },
      { role: "user", content: "Review the pull request" },
    ]);
    expect(prepared).toEqual([
      { role: "user", content: "Review the pull request" },
      { role: "assistant", content: "I read the diff" },
    ]);
    expect(JSON.stringify(prepared)).not.toContain("Task anchor");
  });

  it("preserves review tool-use instructions without coding-session anchoring in GitHub Actions mode", async () => {
    const task =
      "Review the changes in this pull request. Read .git/review-pr.json, inspect git diff and use git show for relevant files.";
    await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [
          { role: "user", content: task },
          { role: "assistant", content: "I read the changed files" },
          { role: "user", content: "Continue" },
        ],
        max_tokens: 64,
      },
      { ledger, transport, githubAction: true },
    );

    const body = transport.mock.calls[0]![1];
    expect(JSON.stringify(body.messages)).not.toContain("Task anchor");
    expect(body.messages).toEqual([
      { role: "user", content: task },
      { role: "assistant", content: "I read the changed files" },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain("BOUNDED REVIEW MODE");
  });

  it("still anchors coding sessions when GitHub Actions mode is off", async () => {
    await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [
          { role: "user", content: "Implement issue #111 across the repo" },
          { role: "assistant", content: "I inspected the relevant files" },
          { role: "user", content: "Continue" },
        ],
        max_tokens: 64,
      },
      { ledger, transport },
    );

    const body = transport.mock.calls[0]![1];
    expect(JSON.stringify(body.messages)).toContain("Task anchor");
  });

  it("never creates a synthetic user turn in GitHub Actions mode", () => {
    const prepared = prepareGithubActionMessages([
      { role: "user", content: "Review the changes in this pull request" },
      { role: "assistant", content: "I read the diff" },
    ]);
    const userMessages = prepared.filter((item) => item.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content).toBe("Review the changes in this pull request");
    expect(prepared.map((item) => item.role)).toEqual(["user", "assistant"]);
  });

  it("preserves assistant and tool messages without re-anchoring in GitHub Actions mode", () => {
    const prepared = prepareGithubActionMessages([
      { role: "user", content: "Review the pull request" },
      { role: "assistant", content: "I read the changed files" },
      { role: "tool", tool_call_id: "call-1", content: "diff content here" },
      { role: "assistant", content: "I have finished reading the diff" },
      { role: "user", content: "Continue" },
    ]);
    expect(prepared).toEqual([
      { role: "user", content: "Review the pull request" },
      { role: "assistant", content: "I read the changed files" },
      { role: "tool", tool_call_id: "call-1", content: "diff content here" },
      { role: "assistant", content: "I have finished reading the diff" },
    ]);
    expect(JSON.stringify(prepared)).not.toContain("Task anchor");
  });

  it("does not inject a task anchor even when no assistant messages exist in GitHub Actions mode", async () => {
    await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [
          { role: "user", content: "Review the changes in this pull request" },
          { role: "user", content: "Continue" },
        ],
        max_tokens: 64,
      },
      { ledger, transport, githubAction: true },
    );

    const body = transport.mock.calls[0]![1];
    expect(JSON.stringify(body.messages)).not.toContain("Task anchor");
    expect(JSON.stringify(body.messages)).not.toContain("BOUNDED REVIEW MODE");
    expect(body.messages.filter((item) => item.role === "user")).toHaveLength(1);
  });

  it("keeps review requests on the hard tier in GitHub Actions mode", async () => {
    const tier = conversationTier(
      [{ role: "user", content: "Review the changes in this pull request" }],
      undefined,
      true,
    );
    expect(tier).toBe("hard");
  });

  it("does not add BOUNDED REVIEW MODE for non-review GitHub Actions requests", () => {
    const prepared = prepareGithubActionMessages([
      { role: "user", content: "Respond to the owner comment about the CI failure" },
      { role: "assistant", content: "I will look into the CI failure." },
    ]);
    expect(JSON.stringify(prepared)).not.toContain("BOUNDED REVIEW MODE");
    expect(JSON.stringify(prepared)).not.toContain("Task anchor");
  });

  it("preserves supplied review instructions without injecting a tool prohibition", () => {
    const messages: Parameters<typeof prepareGithubActionMessages>[0] = [
      { role: "system", content: "Use only the permitted read-only tools." },
      {
        role: "developer",
        content: "Read PR metadata, inspect git diff and use git show for supporting files.",
      },
      { role: "user", content: "Review the pull request" },
      { role: "assistant", content: "I read the diff" },
    ];
    expect(prepareGithubActionMessages(messages)).toEqual(messages);
  });

  it("upgrades a cheap session to the coding tier when OpenCode starts using tools", async () => {
    const sessionId = `test-session-upgrade-${Date.now()}-${Math.random()}`;
    const first = await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [{ role: "user", content: "Can you look into this?" }],
        max_tokens: 64,
      },
      { ledger, transport, sessionId },
    );

    const toolCall = {
      id: "call-read",
      type: "function" as const,
      function: { name: "read", arguments: '{"path":"src/index.ts"}' },
    };
    const second = await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [
          { role: "user", content: "Can you look into this?" },
          { role: "assistant", content: null, tool_calls: [toolCall] },
          { role: "tool", tool_call_id: toolCall.id, content: "Found the relevant source." },
        ],
        max_tokens: 64,
      },
      { ledger, transport, sessionId },
    );

    expect(first.route).toBe("opencode:mimo-v2.6-flash");
    expect(second.route).toBe("opencode:mimo-v2.6-pro");
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
