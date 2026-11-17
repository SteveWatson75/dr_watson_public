import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import { z } from "zod";

export const LOCAL_MODEL = "dr-watson-auto";

const content = z.union([
  z.string(),
  z.array(z.object({ type: z.literal("text"), text: z.string() })),
]);
const toolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const message = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: content.nullable().optional(),
    reasoning_content: z.string().nullable().optional(),
    reasoning: z.string().nullable().optional(),
    tool_calls: z.array(toolCall).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.role === "tool" && !value.tool_call_id)
      ctx.addIssue({ code: "custom", message: "Tool messages require tool_call_id." });
    if (
      value.content == null &&
      !(
        value.role === "assistant" &&
        (value.tool_calls?.length || value.reasoning_content || value.reasoning)
      )
    )
      ctx.addIssue({ code: "custom", message: "Message content is required." });
    if (value.tool_calls && value.role !== "assistant")
      ctx.addIssue({ code: "custom", message: "Only assistant messages may contain tool_calls." });
  });
export const completionRequest = z.object({
  model: z.literal(LOCAL_MODEL),
  messages: z.array(message).min(1),
  stream: z.boolean().optional(),
  n: z.literal(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()),
          strict: z.boolean().nullable().optional(),
        }),
      }),
    )
    .optional(),
  tool_choice: z
    .union([
      z.enum(["auto", "none", "required"]),
      z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
});

export type CompletionInput = z.infer<typeof completionRequest>;
export type ChatMessage = CompletionInput["messages"][number];

export function publicCompletion(completion: OpenAI.ChatCompletion) {
  return {
    id: completion.id || `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: completion.created,
    model: LOCAL_MODEL,
    choices: completion.choices.map((choice) => {
      const upstream = choice.message as OpenAI.ChatCompletionMessage & {
        reasoning_content?: string | null;
        reasoning?: string | null;
      };
      return {
        index: choice.index,
        finish_reason: choice.finish_reason,
        message: {
          role: "assistant",
          content: choice.message.content,
          ...(upstream.reasoning_content != null
            ? { reasoning_content: upstream.reasoning_content }
            : {}),
          ...(upstream.reasoning != null ? { reasoning: upstream.reasoning } : {}),
          ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
        },
      };
    }),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
}

export function streamCompletion(
  completion: ReturnType<typeof publicCompletion>,
  includeUsage: boolean,
): string {
  const chunk = (choices: unknown[], usage?: unknown) =>
    `data: ${JSON.stringify({
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: LOCAL_MODEL,
      choices,
      ...(usage ? { usage } : {}),
    })}\n\n`;
  let result = "";
  for (const choice of completion.choices) {
    result += chunk([
      {
        index: choice.index,
        delta: {
          ...choice.message,
          ...(choice.message.tool_calls
            ? { tool_calls: choice.message.tool_calls.map((tool, index) => ({ ...tool, index })) }
            : {}),
        },
        finish_reason: null,
      },
    ]);
    result += chunk([{ index: choice.index, delta: {}, finish_reason: choice.finish_reason }]);
  }
  if (includeUsage && completion.usage) result += chunk([], completion.usage);
  return `${result}data: [DONE]\n\n`;
}
