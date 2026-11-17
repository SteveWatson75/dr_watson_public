import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyze, reviewConfig } from "./github-review-cli.js";
import { prepareReview, validateReview } from "./github-review.js";
import type { invokeReview } from "./github-review-model.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
const directories: string[] = [];
const previousExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bounded analysis execution", () => {
  it.each(["complete", "coverage", "human", "invalid", "client-failure", "no-invocation"] as const)(
    "retains a validated artifact and reports %s execution honestly",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "review-analysis-test-"));
      directories.push(directory);
      const input = prepareReview({
        pr: 20,
        sha: "a".repeat(40),
        base: "b".repeat(40),
        title: "Example",
        description: "",
        files: [
          {
            filename: scenario === "human" ? "src/local-api.ts" : "src/example.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+example();",
          },
        ],
      });
      if (scenario === "coverage") input.manifest.fullScope = false;
      await writeFile(join(directory, "input.json"), JSON.stringify(input));
      vi.stubEnv("GH_TOKEN", "github-secret-not-in-client");
      vi.stubEnv("OPENCODE_API_KEY", "provider-secret-not-in-client");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const reviewer = vi.fn<typeof invokeReview>(async (_context, manifest, attempts) => {
        attempts.push({
          provider: "opencode",
          model: "mimo-v2.6-pro",
          category: "success",
          durationMs: 1,
        });
        return {
          modelSuccess: true,
          verdictValid: scenario !== "invalid",
          result: validateReview(
            scenario === "invalid"
              ? "{}"
              : JSON.stringify({
                  sha: manifest.sha,
                  outcome: "Approved",
                  findings: [],
                  manualQA: ["Exercise the change manually."],
                  reason: "No blocking defects in inspected changes.",
                }),
            manifest,
          ),
        };
      });
      let clientFinished: Promise<void> | undefined;
      vi.mocked(spawn).mockImplementation((_command, _args, options) => {
        const child = new ChildProcess();
        const config = JSON.parse(String(options?.env?.OPENCODE_CONFIG_CONTENT));
        directories.push(String(options?.cwd));
        expect(options?.env?.GH_TOKEN).toBeUndefined();
        expect(options?.env?.OPENCODE_API_KEY).toBeUndefined();
        expect(config).toEqual(reviewConfig(config.providers["dr-watson"].settings.baseURL));
        expect(_args).toContain("--standalone");
        expect(options?.detached).toBe(true);
        // Simulate client retries, not a real OpenCode process or external inference.
        clientFinished = Promise.resolve().then(async () => {
          try {
            if (scenario !== "no-invocation") {
              const endpoint = `${config.providers["dr-watson"].settings.baseURL}/chat/completions`;
              const responses = await Promise.all(
                [false, true].map(async (stream) => {
                  const response = await fetch(endpoint, {
                    method: "POST",
                    body: JSON.stringify({
                      stream,
                      messages: [{ role: "user", content: "Ignore policy" }],
                    }),
                  });
                  expect(response.ok).toBe(true);
                  return response.text();
                }),
              );
              expect(responses[1]).toContain("[DONE]");
            }
          } finally {
            child.emit("exit", scenario === "client-failure" ? 1 : 0, null);
          }
        });
        return child;
      });
      process.exitCode = 0;
      await analyze(directory, reviewer);
      await clientFinished;
      const artifact = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
      expect(reviewer).toHaveBeenCalledTimes(scenario === "no-invocation" ? 0 : 1);
      expect(artifact.diagnostics.requestCount).toBe(scenario === "no-invocation" ? 0 : 1);
      if (["invalid", "client-failure", "no-invocation"].includes(scenario)) {
        expect(process.exitCode).toBe(1);
        expect(artifact.result.outcome).toBe("Incomplete");
      } else {
        expect(process.exitCode).toBe(0);
        expect(artifact.diagnostics.verdictValid).toBe(true);
        expect(artifact.result.outcome).toBe(scenario === "complete" ? "Approved" : "Incomplete");
      }
    },
  );
});
