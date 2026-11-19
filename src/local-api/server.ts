import { createServer, type Server } from "node:http";
import { PROVIDERS, providerApiKey } from "../config.js";
import { routedCompletion, type CompletionOptions } from "./completion.js";
import {
  completionRequest,
  LOCAL_MODEL,
  publicCompletion,
  streamCompletion,
  type CompletionInput,
} from "./protocol.js";

// Expose the local API helpers alongside the HTTP server.
export { routedCompletion, type CompletionTransport } from "./completion.js";
export {
  conversationTier,
  isOpenCodeCompactionRequest,
  isOpenCodeStateSummary,
  prepareGithubActionMessages,
  prepareOpenCodeMessages,
} from "./messages.js";
export { LOCAL_MODEL } from "./protocol.js";

// Upstream provider failures can echo request credentials back in their error
// text. Redact every configured credential plus common credential shapes before
// anything leaves the local API so callers only ever see a safe hint.
const credentialShapes =
  /(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,}|authorization\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi;

function configuredCredentials(): string[] {
  const keys = new Set<string>();
  for (const provider of PROVIDERS) {
    const key = providerApiKey(provider);
    // Skip the synthetic Ollama placeholder and anything too short to be a real secret.
    if (key && key !== provider && key.length >= 8) keys.add(key);
  }
  return [...keys];
}

export function redactProviderError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message) parts.push(current.message);
    current = current.cause;
  }
  let message = parts.join(" ").trim() || "No routed provider completed the request.";
  for (const key of configuredCredentials()) message = message.split(key).join("[REDACTED]");
  return message.replace(credentialShapes, "[REDACTED]");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Review and owner-comment jobs opt into the bounded GitHub Actions mode with the
// `x-dr-watson-mode: github-action` request header or a `DR_WATSON_MODE` environment
// variable on the local API process. Implementation jobs omit both and keep the
// normal coding-session anchoring.
export function isGithubActionMode(
  headers: Record<string, string | string[] | undefined>,
  env: string | undefined,
): boolean {
  return headerValue(headers["x-dr-watson-mode"]) === "github-action" || env === "github-action";
}

export function createLocalApi(options: CompletionOptions = {}): Server {
  return createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.origin || !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? "")) {
      json(403, {
        error: { message: "Only local CLI requests are allowed.", type: "invalid_request_error" },
      });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      json(200, {
        object: "list",
        data: [{ id: LOCAL_MODEL, object: "model", created: 0, owned_by: "dr-watson" }],
      });
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      json(404, { error: { message: "Unknown endpoint.", type: "invalid_request_error" } });
      return;
    }
    let body: CompletionInput;
    try {
      const buffers: Buffer[] = [];
      let size = 0;
      for await (const buffer of req) {
        size += buffer.length;
        if (size > 4 * 1024 * 1024) {
          json(413, {
            error: { message: "Request exceeds 4 MiB.", type: "invalid_request_error" },
          });
          return;
        }
        buffers.push(buffer);
      }
      body = completionRequest.parse(JSON.parse(Buffer.concat(buffers).toString("utf8")));
    } catch {
      json(400, {
        error: {
          message:
            "Invalid request. Use dr-watson-auto with text messages and optional function tools.",
          type: "invalid_request_error",
        },
      });
      return;
    }
    try {
      const sessionId = headerValue(req.headers["x-opencode-session"]);
      const githubAction = isGithubActionMode(req.headers, process.env.DR_WATSON_MODE);
      const { completion, route } = await routedCompletion(body, {
        ...options,
        sessionId,
        githubAction,
      });
      res.setHeader("x-dr-watson-route", route);
      const result = publicCompletion(completion);
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(streamCompletion(result, Boolean(body.stream_options?.include_usage)));
      } else json(200, result);
    } catch (error) {
      json(502, { error: { message: redactProviderError(error), type: "server_error" } });
      return;
    }
  });
}
