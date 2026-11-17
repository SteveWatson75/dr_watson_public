import { readFile, writeFile, mkdir, mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  prepareReview,
  filesSchema,
  shaSchema,
  manifestSchema,
  resultSchema,
  incomplete,
  validateReview,
  renderReview,
  sanitize,
  CONTEXT_BYTES,
  MODEL_CONTEXT_TOKENS,
  OUTPUT_TOKEN_LIMIT,
  inputTokenUpperBound,
  type Manifest,
} from "./github-review.js";
import { invokeReview, type Attempt } from "./github-review-model.js";

const REPO = "SteveWatson75/dr_watson_public";
const prSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(2000),
  body: z.string().max(100_000).nullable(),
  changed_files: z.number().int().min(0).max(1000),
  user: z.object({ login: z.literal("SteveWatson75") }),
  head: z.object({ sha: shaSchema, repo: z.object({ full_name: z.literal(REPO) }) }),
  base: z.object({
    ref: z.literal("main"),
    sha: shaSchema,
    repo: z.object({ full_name: z.literal(REPO) }),
  }),
});
const attemptSchema = z
  .object({
    provider: z.literal("opencode"),
    model: z.enum(["mimo-v2.6-pro", "kimi-k2.7-code"]),
    durationMs: z.number().nonnegative(),
    category: z.enum([
      "success",
      "timeout",
      "transport",
      "rate_limit",
      "upstream",
      "invalid_or_policy",
    ]),
    status: z.number().int().min(100).max(599).optional(),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
  })
  .strict();
const artifactSchema = z
  .object({
    manifest: manifestSchema,
    result: resultSchema,
    diagnostics: z
      .object({
        modelSuccess: z.boolean(),
        cliSuccess: z.boolean(),
        route: z.string().max(100).optional(),
        requestCount: z.number().int().min(0).max(2),
        fallbackAttempts: z.number().int().min(0).max(1),
        attempts: z.array(attemptSchema).max(2),
      })
      .strict(),
  })
  .strict();

export async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Response size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function github(path: string, method = "GET", body?: unknown): Promise<unknown> {
  // Only deterministic callers construct paths; no model-controlled endpoint/method.
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return JSON.parse(await boundedText(response, 2_000_000));
}

async function readJson(path: string, max = 2_000_000): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length > max) throw new Error("Local input size limit");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
const inputSchema = z
  .object({ manifest: manifestSchema, context: z.string().max(CONTEXT_BYTES) })
  .strict();

async function collect(pr: number, sha: string, base: string, directory: string): Promise<void> {
  const info = prSchema.parse(await github(`pulls/${pr}`));
  if (info.number !== pr || info.head.sha !== sha || info.base.sha !== base)
    throw new Error("Stale PR snapshot");
  const files: z.infer<typeof filesSchema> = [];
  for (let page = 1; page <= 10; page++) {
    const batch = filesSchema.parse(await github(`pulls/${pr}/files?per_page=100&page=${page}`));
    files.push(...batch);
    if (batch.length < 100) break;
  }
  if (
    files.length !== info.changed_files ||
    new Set(files.map((f) => f.filename)).size !== files.length
  ) {
    throw new Error("Incomplete or duplicate file inventory");
  }
  let ci = "CI unavailable";
  try {
    const checks = z
      .object({
        total_count: z.number(),
        check_runs: z
          .array(
            z.object({
              head_sha: shaSchema,
              name: z.string().max(300),
              status: z.string().max(50),
              conclusion: z.string().max(50).nullable(),
            }),
          )
          .max(100),
      })
      .parse(await github(`commits/${sha}/check-runs?per_page=100`));
    ci = JSON.stringify({
      total: checks.total_count,
      sampled: checks.check_runs
        .filter((c) => c.head_sha === sha)
        .map(({ name, status, conclusion }) => ({ name, status, conclusion })),
    });
  } catch {
    /* Optional read-only CI visibility; never execute CI. */
  }
  const after = prSchema.parse(await github(`pulls/${pr}`));
  if (after.head.sha !== sha || after.base.sha !== base)
    throw new Error("PR moved during preparation");
  const prepared = prepareReview({
    pr,
    sha,
    base,
    title: info.title,
    description: info.body ?? "",
    files,
    ci,
    secrets: [process.env.GH_TOKEN ?? ""],
  });
  await writeFile(join(directory, "input.json"), JSON.stringify(prepared), { mode: 0o600 });
}

export function reviewConfig(baseURL: string) {
  return {
    $schema: "https://opencode.ai/config.json",
    model: "dr-watson/dr-watson-auto",
    default_agent: "reviewer",
    snapshots: false,
    compaction: { auto: false },
    instructions: [],
    plugins: [],
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
    policies: [
      { action: "tool.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "dr-watson", effect: "allow" },
    ],
    agents: {
      reviewer: {
        mode: "primary",
        steps: 1,
        system: "Return the prepared PR review from the trusted local API. No tools.",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
    },
    providers: {
      "dr-watson": {
        name: "Dr Watson",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL, apiKey: "local-review", timeout: 130_000 },
        models: {
          "dr-watson-auto": {
            name: "Bounded PR review",
            limit: { context: MODEL_CONTEXT_TOKENS, output: OUTPUT_TOKEN_LIMIT },
          },
        },
      },
    },
  };
}

export async function analyze(directory: string, reviewer = invokeReview): Promise<void> {
  const { manifest, context } = inputSchema.parse(await readJson(join(directory, "input.json")));
  if (Buffer.byteLength(context) > CONTEXT_BYTES) throw new Error("Context size limit");
  const attempts: Attempt[] = [];
  const deadline = new AbortController();
  let invocation: ReturnType<typeof invokeReview> | undefined;
  // The client cannot supply policy, prompts, routes, tools, or extra rounds.
  // Every later request shares the SAME promise, including OpenCode retries/title calls.
  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "")) {
      json(403, {});
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      json(200, {
        object: "list",
        data: [{ id: "dr-watson-auto", object: "model", owned_by: "dr-watson" }],
      });
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      json(404, {});
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64_000) {
        json(413, {});
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let stream = false;
    try {
      stream = JSON.parse(Buffer.concat(chunks).toString("utf8")).stream === true;
    } catch {
      json(400, {});
      return;
    }
    invocation ??= reviewer(
      sanitize(context, [process.env.OPENCODE_API_KEY ?? ""]),
      manifest,
      attempts,
      undefined,
      deadline.signal,
    );
    const reviewed = await invocation;
    const content = JSON.stringify(reviewed.result);
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-review",
          object: "chat.completion.chunk",
          created: 0,
          model: "dr-watson-auto",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`;
      res.end(`${chunk({ role: "assistant", content }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
    } else
      json(200, {
        id: "chatcmpl-review",
        object: "chat.completion",
        created: 0,
        model: "dr-watson-auto",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("API bind failed");
  const isolated = await mkdtemp(join(tmpdir(), "dr-watson-review-"));
  await writeFile(
    join(isolated, "opencode.json"),
    JSON.stringify(reviewConfig(`http://127.0.0.1:${address.port}/v1`)),
  );
  const home = join(isolated, "home");
  await mkdir(home);
  // Whitelist environment: no GH token, provider key, Actions runtime token,
  // inherited OpenCode configuration, or credentials in the client process.
  const child = spawn(
    "opencode",
    [
      "run",
      "--standalone",
      "--agent",
      "reviewer",
      "--model",
      "dr-watson/dr-watson-auto",
      "--format",
      "json",
      "Produce the prepared review now.",
    ],
    {
      cwd: isolated,
      detached: true,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(
          reviewConfig(`http://127.0.0.1:${address.port}/v1`),
        ),
      },
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  }, 150_000);
  const cliSuccess = await new Promise<boolean>((resolve) => {
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // SDK deadlines guarantee at most 120 seconds; do not await a missing invocation.
  const reviewed = invocation ? await invocation : undefined;
  clearTimeout(timer);
  const result = timedOut
    ? incomplete(manifest, "Overall review deadline exceeded (150 seconds).")
    : !cliSuccess
      ? incomplete(manifest, "OpenCode invocation failed; no successful client completion.")
      : (reviewed?.result ??
        incomplete(manifest, "OpenCode did not invoke the bounded review API."));
  const artifact = artifactSchema.parse({
    manifest,
    result,
    diagnostics: {
      modelSuccess: reviewed?.modelSuccess ?? false,
      cliSuccess,
      ...(reviewed?.route ? { route: reviewed.route } : {}),
      requestCount: attempts.length,
      fallbackAttempts: Math.max(0, attempts.length - 1),
      attempts,
    },
  });
  const redact = (s: string) => sanitize(s, [process.env.OPENCODE_API_KEY ?? ""]);
  artifact.result.reason = redact(artifact.result.reason);
  artifact.result.manualQA = artifact.result.manualQA.map(redact);
  artifact.result.findings = artifact.result.findings.map((f) => ({
    ...f,
    defect: redact(f.defect),
    blockingReason: redact(f.blockingReason),
  }));
  await writeFile(join(directory, "result.json"), JSON.stringify(artifact), { mode: 0o600 });
}

export async function publish(pr: number, sha: string, directory: string): Promise<void> {
  let artifact: z.infer<typeof artifactSchema> | undefined;
  try {
    artifact = artifactSchema.parse(await readJson(join(directory, "result.json")));
  } catch {
    /* fail closed below */
  }
  const manifest: Manifest = artifact?.manifest ?? {
    pr,
    sha,
    base: sha,
    included: [],
    excluded: [],
    fullScope: false,
    humanRequired: true,
    contextBytes: 0,
  };
  if (manifest.pr !== pr || manifest.sha !== sha) throw new Error("Artifact identity mismatch");
  let result = artifact
    ? validateReview(JSON.stringify(artifact.result), manifest)
    : incomplete(
        manifest,
        "Preparation, installation, or execution failed; no valid result artifact.",
      );
  if (
    artifact &&
    (artifact.diagnostics.requestCount !== artifact.diagnostics.attempts.length ||
      artifact.diagnostics.fallbackAttempts !==
        Math.max(0, artifact.diagnostics.attempts.length - 1) ||
      (result.outcome !== "Incomplete" &&
        (!artifact.diagnostics.cliSuccess ||
          !artifact.diagnostics.modelSuccess ||
          artifact.diagnostics.attempts.at(-1)?.category !== "success")))
  ) {
    result = incomplete(
      manifest,
      "Invocation did not complete successfully or diagnostics are inconsistent.",
    );
  }
  const current = prSchema.parse(await github(`pulls/${pr}`));
  if (current.number !== pr) throw new Error("PR identity mismatch");
  if (current.head.sha !== sha || (artifact && current.base.sha !== manifest.base)) {
    result = incomplete(
      manifest,
      "PR head or base changed after inspection; stale review, rerun required.",
    );
    manifest.fullScope = false;
  }
  const secrets = [process.env.GH_TOKEN ?? ""];
  let report = renderReview(manifest, result, secrets);
  let comment = report;
  if (Buffer.byteLength(comment) > 60_000) {
    result = incomplete(
      manifest,
      "Publication exceeds comment size budget; full coverage inventory is in the job summary and result artifact.",
    );
    manifest.fullScope = false;
    report = renderReview(manifest, result, secrets);
    comment = renderReview(manifest, result, secrets, 20);
  }
  // No APPROVE/REQUEST_CHANGES, inline commands, arbitrary endpoints or model tools.
  let publicationSuccess = false;
  let publicationStatus: number | undefined;
  try {
    await github(`pulls/${pr}/reviews`, "POST", {
      commit_id: sha,
      event: "COMMENT",
      body: comment,
    });
    publicationSuccess = true;
  } catch (error) {
    const match = error instanceof Error ? /^GitHub HTTP (\d+)$/.exec(error.message) : null;
    publicationStatus = match ? Number(match[1]) : undefined;
    result = incomplete(
      manifest,
      `GitHub publication failed${publicationStatus ? ` (HTTP ${publicationStatus})` : ""}; no confirmed review publication.`,
    );
    report = renderReview(manifest, result, secrets);
  }
  const diagnostics = JSON.stringify({
    pr,
    sha,
    includedFiles: manifest.included.length,
    excludedFiles: new Set(manifest.excluded.map((f) => f.path)).size,
    excludedEntries: manifest.excluded.length,
    contextBytes: manifest.contextBytes,
    inputTokenUpperBound: inputTokenUpperBound(manifest.contextBytes),
    fullScope: manifest.fullScope,
    outcome: result.outcome,
    reviewComplete: result.outcome !== "Incomplete",
    reviewApproved: result.outcome === "Approved",
    publicationSuccess,
    ...(publicationStatus ? { publicationStatus } : {}),
    ...(artifact?.diagnostics ?? {
      modelSuccess: false,
      cliSuccess: false,
      requestCount: null,
      fallbackAttempts: null,
      attempts: [],
    }),
  });
  console.info(diagnostics);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `${report}\n\nDiagnostics:\n\`\`\`json\n${diagnostics}\n\`\`\`\n`,
    );
  }
  if (result.outcome === "Incomplete") process.exitCode = 1;
}

export async function main(): Promise<void> {
  const [command, prText, shaText, baseText] = process.argv.slice(2);
  const directory = join(process.env.RUNNER_TEMP ?? tmpdir(), "dr-watson-review");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pr = z.coerce.number().int().positive().parse(prText);
  const sha = shaSchema.parse(shaText);
  if (command === "collect") await collect(pr, sha, shaSchema.parse(baseText), directory);
  else if (command === "analyze") await analyze(directory);
  else if (command === "publish") await publish(pr, sha, directory);
  else throw new Error("Unknown operation");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      "Review operation failed; sensitive details suppressed. Check phase and diagnostics.",
    );
    process.exitCode = 1;
  });
}
