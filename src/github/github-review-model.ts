import OpenAI from "openai";
import { candidateCatalogue, productionPrivacyEligibility } from "../providers/model-policy.js";
import { modelCatalogue } from "../providers/model-catalogue.js";
import { config, providerSettings } from "../config.js";
import { routedCompletion, LOCAL_MODEL, type CompletionTransport } from "../local-api.js";
import { isProviderFailoverError } from "../providers/failover.js";
import {
  REVIEW_POLICY,
  CONTEXT_BYTES,
  INPUT_TOKEN_BUDGET,
  OUTPUT_TOKEN_LIMIT,
  inputTokenUpperBound,
  incomplete,
  validateReview,
  type Manifest,
  type ReviewResult,
} from "./github-review.js";

export const REVIEW_MODELS = ["mimo-v2.6-pro", "kimi-k2.7-code"] as const;
export type Attempt = {
  provider: "opencode";
  model: string;
  durationMs: number;
  category: string;
  status?: number;
  inputTokens?: number;
  outputTokens?: number;
};
export function errorCategory(error: unknown): { category: string; status?: number } {
  const status =
    error && typeof error === "object" && "status" in error ? Number(error.status) : undefined;
  if (status && Number.isInteger(status) && status >= 100 && status <= 599)
    return {
      status,
      category:
        status === 429
          ? "rate_limit"
          : status === 408
            ? "timeout"
            : status >= 500 || ([400, 422].includes(status) && isProviderFailoverError(error))
              ? "upstream"
              : "invalid_or_policy",
    };
  return {
    category: error instanceof Error && /timeout|abort/i.test(error.name) ? "timeout" : "transport",
  };
}

export async function invokeReview(
  context: string,
  manifest: Manifest,
  attempts: Attempt[],
  injected?: CompletionTransport,
  signal?: AbortSignal,
): Promise<{ result: ReviewResult; route?: string; modelSuccess: boolean }> {
  if (config.provider !== "auto" || config.model)
    return {
      modelSuccess: false,
      result: incomplete(
        manifest,
        "Manual provider/model overrides are not permitted for reviews.",
      ),
    };
  if (
    Buffer.byteLength(context) > CONTEXT_BYTES ||
    inputTokenUpperBound(Buffer.byteLength(context)) > INPUT_TOKEN_BUDGET
  ) {
    return {
      modelSuccess: false,
      result: incomplete(manifest, "Prepared input exceeds byte/token safety budgets."),
    };
  }
  const routes = REVIEW_MODELS.filter((model) => {
    const policy = candidateCatalogue.candidates.find((c) => c.id === model);
    const privacy = productionPrivacyEligibility(model);
    return (
      privacy.eligible &&
      privacy.reviewed &&
      policy?.training === "not-used" &&
      Object.values(modelCatalogue.tierRoutes)
        .flat()
        .some((r) => r.provider === "opencode" && r.model === model)
    );
  }).map((model) => ({ provider: "opencode" as const, model }));
  const transport: CompletionTransport = async (route, body, session) => {
    const start = Date.now();
    const model = route.model!;
    try {
      // Explicit last-moment strict review privacy check, even with mock transports.
      const policy = candidateCatalogue.candidates.find((c) => c.id === model);
      if (!productionPrivacyEligibility(model).eligible || policy?.training !== "not-used") {
        throw { status: 403 };
      }
      const settings = providerSettings(route.provider, model);
      // Fixed Go endpoint prevents local/manual provider overrides from moving review
      // traffic to a paid or unreviewed endpoint. maxRetries=0, one attempt per model.
      const response = await (injected
        ? injected(route, body, session)
        : new OpenAI({
            apiKey: settings.apiKey,
            baseURL: "https://opencode.ai/inference/go/openai/v1",
            timeout: 60_000,
            maxRetries: 0,
            defaultHeaders: {
              "User-Agent": "dr-watson/0.1.0",
              "x-opencode-session": session ?? "dr-watson-review",
            },
          }).chat.completions.create(
            { ...body, tools: undefined, tool_choice: undefined },
            { signal },
          ));
      attempts.push({
        provider: "opencode",
        model,
        durationMs: Date.now() - start,
        category: "success",
        ...(response.usage
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens,
            }
          : {}),
      });
      return response;
    } catch (error) {
      attempts.push({
        provider: "opencode",
        model,
        durationMs: Date.now() - start,
        ...errorCategory(error),
      });
      throw error;
    }
  };
  try {
    const { completion, route } = await routedCompletion(
      {
        model: LOCAL_MODEL,
        messages: [
          { role: "system", content: REVIEW_POLICY },
          { role: "user", content: context },
        ],
        max_tokens: OUTPUT_TOKEN_LIMIT,
        stream: false,
      },
      {
        reviewRoutes: routes,
        transport,
        log: () => {},
        failover: (error) => {
          if (signal?.aborted) return false;
          const { category } = errorCategory(error);
          return (
            category === "timeout" ||
            category === "transport" ||
            category === "rate_limit" ||
            (category === "upstream" && isProviderFailoverError(error))
          );
        },
      },
    );
    const choice = completion.choices[0];
    if (choice?.finish_reason !== "stop" || choice.message.tool_calls?.length) {
      return {
        modelSuccess: true,
        route,
        result: incomplete(
          manifest,
          "Model output truncated or attempted unauthorized tool execution.",
        ),
      };
    }
    return {
      modelSuccess: true,
      route,
      result: validateReview(choice.message.content ?? "", manifest),
    };
  } catch {
    const last = attempts.at(-1);
    return {
      modelSuccess: false,
      result: incomplete(
        manifest,
        last
          ? `Provider request failed (${last.category}${last.status ? `, HTTP ${last.status}` : ""}); bounded attempts exhausted or fail-closed.`
          : "No eligible, available, privacy-approved model within budget.",
      ),
    };
  }
}
